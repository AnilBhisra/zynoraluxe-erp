"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { Decimal } from "@/lib/accounting/money";
import { requireOwner } from "@/lib/auth/dal";
import { CORRECTION_TRANSACTION_OPTIONS, CorrectionError } from "@/lib/corrections/types";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import {
  labourPlanFingerprint,
  planReceiptLabour,
  postReceiptLabourCorrection,
  reverseReceiptLabourCorrection,
} from "@/lib/diamond/receiptLabourCorrection";

/** Prisma's code for "the interactive transaction ran past its timeout". */
const TRANSACTION_TIMEOUT_CODE = "P2028";
const TIMEOUT_MESSAGE =
  "This took longer than the database allows, so it was rolled back and nothing was saved. Check the receipt before trying again.";

export type LabourPreview = {
  receiptCode: string;
  jobCode: string;
  manufacturerName: string;
  processName: string | null;
  previousLabour: string;
  correctedLabour: string;
  added: string;
  suggestion: string | null;
  outputs: { code: string; kind: "STONE" | "PACKET"; carat: string; added: string; costBefore: string; costAfter: string }[];
  ledgerLines: { account: string; debit: string | null; credit: string | null }[];
  fingerprint: string;
};

export type LabourCorrectionFormState =
  | { error?: string; success?: boolean; code?: string; added?: string; replayed?: boolean; preview?: LabourPreview }
  | undefined;

function logFailure(operation: string, error: unknown): string | undefined {
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
  console.error("manufacturer labour correction failed", {
    operation,
    errorName: error instanceof Error ? error.name : typeof error,
    prismaCode: prismaCode ?? null,
    message: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
  return prismaCode;
}

const formSchema = z.object({
  receiptId: z.string().trim().min(1, "Choose the receipt."),
  correctedLabour: z.string().trim().min(1, "Enter the corrected labour."),
  reason: z.string().trim().min(10, "Give the reason for correcting this labour (at least 10 characters).").max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
  previewFingerprint: z.string().max(4000).optional(),
});

function readForm(formData: FormData) {
  return formSchema.safeParse({
    receiptId: formData.get("receiptId"),
    correctedLabour: formData.get("correctedLabour") ?? "",
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
    previewFingerprint: formData.get("previewFingerprint") || undefined,
  });
}

function revalidateAll() {
  revalidatePath("/diamond");
  revalidatePath("/corrections");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
}

/** Shows exactly what would be posted, writing nothing. Owner only. */
export async function previewLabourCorrectionAction(_prev: LabourCorrectionFormState, formData: FormData): Promise<LabourCorrectionFormState> {
  await requireOwner();
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    const built = await planReceiptLabour(prisma, {
      receiptId: parsed.data.receiptId,
      correctedLabour: parsed.data.correctedLabour,
      reason: parsed.data.reason,
    });
    return {
      preview: {
        receiptCode: built.receipt.receiptCode,
        jobCode: built.receipt.jobCode,
        manufacturerName: built.receipt.manufacturerName,
        processName: built.receipt.processName,
        previousLabour: built.previousLabour.toFixed(2),
        correctedLabour: built.correctedLabour.toFixed(2),
        added: built.added.toFixed(2),
        suggestion: built.suggestion,
        outputs: built.lines.map((l) => ({ code: l.code, kind: l.kind, carat: l.carat, added: l.added, costBefore: l.costBefore, costAfter: l.costAfter })),
        ledgerLines: built.plan.ledgerLines.map((l) => ({
          account: l.accountCode === "2000" ? `Manufacturer payable — ${built.receipt.manufacturerName}` : "Polished Diamond Inventory",
          debit: l.debit === undefined ? null : new Decimal(l.debit).toFixed(2),
          credit: l.credit === undefined ? null : new Decimal(l.credit).toFixed(2),
        })),
        fingerprint: labourPlanFingerprint(built.plan),
      },
    };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    logFailure("preview", error);
    return { error: "Could not prepare the preview. Please try again." };
  }
}

/** Posts the correction. Owner only, atomic, duplicate-submit safe. */
export async function postLabourCorrectionAction(_prev: LabourCorrectionFormState, formData: FormData): Promise<LabourCorrectionFormState> {
  const owner = await requireOwner();
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const { idempotencyKey } = parsed.data;
  if (!idempotencyKey) return { error: "Missing submission key — reload the page and try again." };
  if (!parsed.data.previewFingerprint) return { error: "Preview the correction first." };

  const fy = await getCompanyFySettings();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        postReceiptLabourCorrection(tx, {
          receiptId: parsed.data.receiptId,
          correctedLabour: parsed.data.correctedLabour,
          reason: parsed.data.reason,
          idempotencyKey,
          expectedFingerprint: parsed.data.previewFingerprint ?? null,
          owner: { id: owner.id, role: owner.role },
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
        }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    revalidateAll();
    return {
      success: true,
      code: result.correction.correctionCode,
      replayed: result.replayed,
      added: result.replayed ? undefined : result.added.toFixed(2),
    };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.correction.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.correctionCode, replayed: true };
    }
    if (error instanceof CorrectionError) return { error: error.message };
    const code = logFailure("post", error);
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
    return { error: "Could not post this correction. Nothing was saved. Please try again." };
  }
}

const reverseSchema = z.object({
  correctionId: z.string().trim().min(1),
  reason: z.string().trim().min(10, "Give the reason for reversing this correction (at least 10 characters).").max(500),
});

/** Reverses a posted labour correction. Owner only, re-checked inside the transaction. */
export async function reverseLabourCorrectionAction(_prev: LabourCorrectionFormState, formData: FormData): Promise<LabourCorrectionFormState> {
  const owner = await requireOwner();
  const parsed = reverseSchema.safeParse({ correctionId: formData.get("correctionId"), reason: formData.get("reason") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };

  const fy = await getCompanyFySettings();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        reverseReceiptLabourCorrection(tx, {
          correctionId: parsed.data.correctionId,
          reason: parsed.data.reason,
          owner: { id: owner.id, role: owner.role },
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
        }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    revalidateAll();
    return { success: true, code: result.reversal.correctionCode, added: result.added.toFixed(2) };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    const code = logFailure("reverse", error);
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
    return { error: "Could not reverse this correction. Nothing was changed. Please try again." };
  }
}
