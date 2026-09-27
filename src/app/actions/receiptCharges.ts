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
  chargePlanFingerprint,
  planReceiptCharges,
  postReceiptChargeCorrection,
  reverseReceiptChargeCorrection,
} from "@/lib/jewellery/receiptChargeCorrection";
import { CHARGE_CATEGORIES } from "@/lib/jewellery/receiptChargeAllocation";

/** Prisma's code for "the interactive transaction ran past its timeout". */
const TRANSACTION_TIMEOUT_CODE = "P2028";
const TIMEOUT_MESSAGE =
  "This took longer than the database allows, so it was rolled back and nothing was saved. Check the receipt before trying again.";

export type ChargePreview = {
  receiptCode: string;
  jobCode: string;
  karigarName: string;
  total: string;
  charges: { key: string; label: string; amount: string }[];
  pieces: { code: string; added: string; labourBefore: string; labourAfter: string; totalBefore: string; totalAfter: string }[];
  ledgerLines: { account: string; debit: string | null; credit: string | null }[];
  downstream: string[];
  fingerprint: string;
};

export type ReceiptChargeFormState =
  | { error?: string; success?: boolean; code?: string; total?: string; replayed?: boolean; preview?: ChargePreview }
  | undefined;

function logFailure(operation: string, error: unknown): string | undefined {
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
  console.error("receipt charge correction failed", {
    operation,
    errorName: error instanceof Error ? error.name : typeof error,
    prismaCode: prismaCode ?? null,
    message: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
  return prismaCode;
}

const money = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => (v === undefined || v === null || String(v).trim() === "" ? undefined : String(v).trim()));

const chargeFormSchema = z.object({
  receiptId: z.string().trim().min(1, "Choose the receipt."),
  labourCharge: money,
  makingCharge: money,
  settingCharge: money,
  platingCharge: money,
  otherExpense: money,
  reason: z.string().trim().min(10, "Give the reason for adding these charges (at least 10 characters).").max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
  previewFingerprint: z.string().max(4000).optional(),
});

function readForm(formData: FormData) {
  const raw: Record<string, unknown> = { receiptId: formData.get("receiptId"), reason: formData.get("reason") };
  for (const c of CHARGE_CATEGORIES) raw[c.key] = formData.get(c.key) ?? undefined;
  raw.idempotencyKey = formData.get("idempotencyKey") || undefined;
  raw.previewFingerprint = formData.get("previewFingerprint") || undefined;
  return chargeFormSchema.safeParse(raw);
}

function chargesOf(data: z.infer<typeof chargeFormSchema>) {
  return {
    labourCharge: data.labourCharge,
    makingCharge: data.makingCharge,
    settingCharge: data.settingCharge,
    platingCharge: data.platingCharge,
    otherExpense: data.otherExpense,
  };
}

function revalidateAll() {
  revalidatePath("/jewellery-jobs");
  revalidatePath("/corrections");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
  revalidatePath("/costing");
}

/** Shows exactly what would be posted, writing nothing. Owner only. */
export async function previewReceiptChargesAction(
  _prev: ReceiptChargeFormState,
  formData: FormData
): Promise<ReceiptChargeFormState> {
  await requireOwner();
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    const built = await planReceiptCharges(prisma, {
      receiptId: parsed.data.receiptId,
      charges: chargesOf(parsed.data),
      reason: parsed.data.reason,
    });
    const pieceById = new Map(built.pieces.map((p) => [p.id, p]));
    const preview: ChargePreview = {
      receiptCode: built.receipt.receiptCode,
      jobCode: built.receipt.jobCode,
      karigarName: built.receipt.karigarName,
      total: built.total.toFixed(2),
      charges: CHARGE_CATEGORIES.filter((c) => built.charges[c.key].greaterThan(0)).map((c) => ({
        key: c.key,
        label: c.label,
        amount: built.charges[c.key].toFixed(2),
      })),
      pieces: built.shares.map((s) => {
        const p = pieceById.get(s.finishedJewelleryId)!;
        return {
          code: p.finishedCode,
          added: s.total.toFixed(2),
          labourBefore: p.labourAllocated.toFixed(2),
          labourAfter: p.labourAllocated.plus(s.total).toFixed(2),
          totalBefore: p.totalCost.toFixed(2),
          totalAfter: p.totalCost.plus(s.total).toFixed(2),
        };
      }),
      ledgerLines: built.plan.ledgerLines.map((l) => ({
        account: l.accountCode === "2000" ? `Karigar payable — ${built.receipt.karigarName}` : "Finished Jewellery Inventory",
        debit: l.debit === undefined ? null : new Decimal(l.debit).toFixed(2),
        credit: l.credit === undefined ? null : new Decimal(l.credit).toFixed(2),
      })),
      downstream: built.plan.downstream.map((d) => d.description),
      fingerprint: chargePlanFingerprint(built.plan),
    };
    return { preview };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    logFailure("preview", error);
    return { error: "Could not prepare the preview. Please try again." };
  }
}

/** Posts the correction. Owner only, atomic, duplicate-submit safe. */
export async function postReceiptChargesAction(
  _prev: ReceiptChargeFormState,
  formData: FormData
): Promise<ReceiptChargeFormState> {
  const owner = await requireOwner();
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const { idempotencyKey } = parsed.data;
  if (!idempotencyKey) return { error: "Missing submission key — reload the page and try again." };

  const fy = await getCompanyFySettings();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        postReceiptChargeCorrection(tx, {
          receiptId: parsed.data.receiptId,
          charges: chargesOf(parsed.data),
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
    return { error: "Could not post this correction. Nothing was saved. Please try again." };
  }
}

const reverseSchema = z.object({
  correctionId: z.string().trim().min(1),
  reason: z.string().trim().min(10, "Give the reason for reversing this correction (at least 10 characters).").max(500),
});

/** Reverses a posted missing-charges correction. Owner only, re-checked inside the transaction. */
export async function reverseReceiptChargesAction(
  _prev: ReceiptChargeFormState,
  formData: FormData
): Promise<ReceiptChargeFormState> {
  const owner = await requireOwner();
  const parsed = reverseSchema.safeParse({ correctionId: formData.get("correctionId"), reason: formData.get("reason") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };

  const fy = await getCompanyFySettings();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        reverseReceiptChargeCorrection(tx, {
          correctionId: parsed.data.correctionId,
          reason: parsed.data.reason,
          owner: { id: owner.id, role: owner.role },
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
        }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    revalidateAll();
    return { success: true, code: result.reversal.correctionCode, total: result.total.toFixed(2) };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    const code = logFailure("reverse", error);
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
    return { error: "Could not reverse this correction. Nothing was changed. Please try again." };
  }
}
