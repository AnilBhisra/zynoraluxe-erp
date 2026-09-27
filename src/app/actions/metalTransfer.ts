"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { requireOwner } from "@/lib/auth/dal";
import { CORRECTION_TRANSACTION_OPTIONS, CorrectionError } from "@/lib/corrections/types";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import {
  planJobMetalTransfer,
  postJobMetalTransfer,
  reverseJobMetalTransfer,
  transferPlanFingerprint,
} from "@/lib/jewellery/metalTransfer";

const TRANSACTION_TIMEOUT_CODE = "P2028";
const TIMEOUT_MESSAGE =
  "This took longer than the database allows, so it was rolled back and nothing was saved. Check both jobs before trying again.";

export type TransferPreview = {
  sourceJobCode: string;
  destinationJobCode: string;
  karigarName: string;
  purityDisplayName: string;
  fineWeight: string;
  grossWeightEquivalent: string;
  costValue: string;
  sourcePendingBefore: string;
  sourcePendingAfter: string;
  sourceWipBefore: string;
  sourceWipAfter: string;
  destinationCreatesFirstMetalLine: boolean;
  fingerprint: string;
};

export type MetalTransferFormState =
  | { error?: string; success?: boolean; code?: string; replayed?: boolean; preview?: TransferPreview }
  | undefined;

function logFailure(operation: string, error: unknown): string | undefined {
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
  console.error("metal transfer failed", {
    operation,
    errorName: error instanceof Error ? error.name : typeof error,
    prismaCode: prismaCode ?? null,
    message: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
  return prismaCode;
}

const formSchema = z.object({
  sourceJobId: z.string().trim().min(1, "Choose the source job."),
  destinationJobId: z.string().trim().min(1, "Choose the destination job."),
  fineWeight: z.string().trim().min(1, "Enter the fine weight to transfer."),
  reason: z.string().trim().min(10, "Give the reason for this transfer (at least 10 characters).").max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
  previewFingerprint: z.string().max(4000).optional(),
});

function readForm(formData: FormData) {
  return formSchema.safeParse({
    sourceJobId: formData.get("sourceJobId"),
    destinationJobId: formData.get("destinationJobId"),
    fineWeight: formData.get("fineWeight"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
    previewFingerprint: formData.get("previewFingerprint") || undefined,
  });
}

function revalidateAll() {
  revalidatePath("/jewellery-jobs");
  revalidatePath("/corrections");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
}

/** Shows exactly what would move, writing nothing. Owner only. */
export async function previewMetalTransferAction(
  _prev: MetalTransferFormState,
  formData: FormData
): Promise<MetalTransferFormState> {
  await requireOwner();
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    const built = await planJobMetalTransfer(prisma, {
      sourceJobId: parsed.data.sourceJobId,
      destinationJobId: parsed.data.destinationJobId,
      fineWeight: parsed.data.fineWeight,
      reason: parsed.data.reason,
    });
    const preview: TransferPreview = {
      sourceJobCode: built.sourceJobCode,
      destinationJobCode: built.destinationJobCode,
      karigarName: built.karigarName,
      purityDisplayName: built.purityDisplayName,
      fineWeight: built.fineWeight.toFixed(3),
      grossWeightEquivalent: built.grossWeightEquivalent.toFixed(3),
      costValue: built.costValue.toFixed(2),
      sourcePendingBefore: built.sourcePendingBefore.toFixed(3),
      sourcePendingAfter: built.sourcePendingAfter.toFixed(3),
      sourceWipBefore: built.sourceWipBefore.toFixed(2),
      sourceWipAfter: built.sourceWipAfter.toFixed(2),
      destinationCreatesFirstMetalLine: built.destinationCreatesFirstMetalLine,
      fingerprint: transferPlanFingerprint(built.plan),
    };
    return { preview };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    logFailure("preview", error);
    return { error: "Could not prepare the preview. Please try again." };
  }
}

/** Posts the transfer. Owner only, atomic, duplicate-submit safe. */
export async function postMetalTransferAction(
  _prev: MetalTransferFormState,
  formData: FormData
): Promise<MetalTransferFormState> {
  const owner = await requireOwner();
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const { idempotencyKey } = parsed.data;
  if (!idempotencyKey) return { error: "Missing submission key — reload the page and try again." };

  const fy = await getCompanyFySettings();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        postJobMetalTransfer(tx, {
          sourceJobId: parsed.data.sourceJobId,
          destinationJobId: parsed.data.destinationJobId,
          fineWeight: parsed.data.fineWeight,
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
    return { success: true, code: result.correction.correctionCode, replayed: result.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.correction.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.correctionCode, replayed: true };
    }
    if (error instanceof CorrectionError) return { error: error.message };
    const code = logFailure("post", error);
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
    return { error: "Could not post this transfer. Nothing was saved. Please try again." };
  }
}

const reverseSchema = z.object({
  correctionId: z.string().trim().min(1),
  reason: z.string().trim().min(10, "Give the reason for reversing this transfer (at least 10 characters).").max(500),
});

/** Reverses a posted metal transfer. Owner only, re-checked inside the transaction. */
export async function reverseMetalTransferAction(
  _prev: MetalTransferFormState,
  formData: FormData
): Promise<MetalTransferFormState> {
  const owner = await requireOwner();
  const parsed = reverseSchema.safeParse({ correctionId: formData.get("correctionId"), reason: formData.get("reason") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };

  const fy = await getCompanyFySettings();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        reverseJobMetalTransfer(tx, {
          correctionId: parsed.data.correctionId,
          reason: parsed.data.reason,
          owner: { id: owner.id, role: owner.role },
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
        }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    revalidateAll();
    return { success: true, code: result.reversal.correctionCode };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    const code = logFailure("reverse", error);
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
    return { error: "Could not reverse this transfer. Nothing was changed. Please try again." };
  }
}
