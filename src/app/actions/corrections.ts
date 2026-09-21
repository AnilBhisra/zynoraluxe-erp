"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireOwner, requireUser } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import {
  approveCorrectionDraft,
  postCorrection,
  rejectCorrectionDraft,
  saveCorrectionDraft,
} from "@/lib/corrections/engine";
import {
  planOpeningStockLedgerBackfill,
  planOpeningStockRevaluation,
  replanCorrection,
} from "@/lib/corrections/openingStockCorrection";
import { CorrectionError, type CorrectionPlan, type Tx } from "@/lib/corrections/types";

export type CorrectionFormState =
  | { error?: string; success?: boolean; code?: string; preview?: SerializedPreview }
  | undefined;

/** The impact preview, flattened for a Client Component. */
export type SerializedPreview = {
  mode: string;
  entityLabel: string;
  amount: string;
  downstream: { recordLabel: string; description: string }[];
  impacts: { kind: string; recordLabel: string; field: string; oldValue: string; newValue: string }[];
  ledgerLines: { accountCode: string; debit: string | null; credit: string | null }[];
};

function serializePreview(plan: CorrectionPlan): SerializedPreview {
  return {
    mode: plan.mode,
    entityLabel: plan.entityLabel,
    amount: plan.amount,
    downstream: plan.downstream.map((d) => ({ recordLabel: d.recordLabel, description: d.description })),
    impacts: plan.impacts.map((i) => ({
      kind: i.kind,
      recordLabel: i.recordLabel,
      field: i.field,
      oldValue: i.oldValue,
      newValue: i.newValue,
    })),
    ledgerLines: plan.ledgerLines.map((l) => ({
      accountCode: l.accountCode,
      debit: l.debit === undefined ? null : String(l.debit),
      credit: l.credit === undefined ? null : String(l.credit),
    })),
  };
}

function revalidateCorrections() {
  revalidatePath("/corrections");
  revalidatePath("/jewellery-jobs");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
}

const openingStockCorrectionSchema = z.object({
  movementId: z.string().trim().min(1, "Choose the opening entry to correct."),
  /** Absent for the ledger backfill, which posts the value already saved. */
  newCostValue: z.coerce.number().min(0, "A corrected value cannot be negative.").optional(),
  reason: z.string().trim().min(5, "Give the reason for this correction.").max(500),
  idempotencyKey: z.string().trim().max(100).optional(),
  /** Links this correction to the one it continues, e.g. R2 after R1. */
  supersedesCorrectionId: z.string().trim().max(50).optional(),
});

async function buildPlan(
  tx: Tx,
  input: { movementId: string; newCostValue?: number; reason: string }
): Promise<CorrectionPlan> {
  return input.newCostValue === undefined
    ? planOpeningStockLedgerBackfill(tx, { movementId: input.movementId, reason: input.reason })
    : planOpeningStockRevaluation(tx, {
        movementId: input.movementId,
        newCostValue: input.newCostValue,
        reason: input.reason,
      });
}

/**
 * Builds the impact preview without writing anything. Staff may look: the
 * preview shows which records would move, never a decision to move them.
 */
export async function previewOpeningStockCorrection(
  _prevState: CorrectionFormState,
  formData: FormData
): Promise<CorrectionFormState> {
  await requireUser();
  const parsed = openingStockCorrectionSchema.safeParse({
    movementId: formData.get("movementId"),
    newCostValue: formData.get("newCostValue") || undefined,
    reason: formData.get("reason") || "preview",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };

  try {
    const plan = await buildPlan(prisma, parsed.data);
    return { success: true, preview: serializePreview(plan) };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    console.error("previewOpeningStockCorrection failed:", error);
    return { error: "Could not build the impact preview. Please try again." };
  }
}

/** Staff may prepare a draft; it posts nothing and changes no balance. */
export async function saveOpeningStockCorrectionDraft(
  _prevState: CorrectionFormState,
  formData: FormData
): Promise<CorrectionFormState> {
  const user = await requireUser();
  const parsed = openingStockCorrectionSchema.safeParse({
    movementId: formData.get("movementId"),
    newCostValue: formData.get("newCostValue") || undefined,
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };

  try {
    const draft = await prisma.$transaction(async (tx) => {
      const plan = await buildPlan(tx, parsed.data);
      return saveCorrectionDraft(tx, { plan, preparedByUserId: user.id, submitForApproval: true });
    });
    revalidateCorrections();
    return { success: true, code: draft.correctionCode };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    console.error("saveOpeningStockCorrectionDraft failed:", error);
    return { error: "Could not save this correction draft. Please try again." };
  }
}

/** Posts a correction outright. Owner only. */
export async function postOpeningStockCorrection(
  _prevState: CorrectionFormState,
  formData: FormData
): Promise<CorrectionFormState> {
  const owner = await requireOwner();
  const parsed = openingStockCorrectionSchema.safeParse({
    movementId: formData.get("movementId"),
    newCostValue: formData.get("newCostValue") || undefined,
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
    supersedesCorrectionId: formData.get("supersedesCorrectionId") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const { idempotencyKey } = parsed.data;

  if (idempotencyKey) {
    const existing = await prisma.correction.findUnique({ where: { idempotencyKey } });
    if (existing) return { success: true, code: existing.correctionCode };
  }

  const fy = await getCompanyFySettings();
  try {
    const correction = await prisma.$transaction(async (tx) => {
      const plan = await buildPlan(tx, parsed.data);
      return postCorrection(tx, {
        plan,
        preparedByUserId: owner.id,
        approvedByUserId: owner.id,
        approverRole: owner.role,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        idempotencyKey: idempotencyKey || null,
        supersedesCorrectionId: parsed.data.supersedesCorrectionId || null,
      });
    });
    revalidateCorrections();
    return { success: true, code: correction.correctionCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && idempotencyKey) {
      const existing = await prisma.correction.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.correctionCode };
    }
    if (error instanceof CorrectionError) return { error: error.message };
    console.error("postOpeningStockCorrection failed:", error);
    return { error: "Could not post this correction. Please try again." };
  }
}

const approvalSchema = z.object({
  correctionId: z.string().trim().min(1),
  idempotencyKey: z.string().trim().max(100).optional(),
});

/** Approves a prepared draft. Owner only; the plan is recomputed first. */
export async function approveCorrection(
  _prevState: CorrectionFormState,
  formData: FormData
): Promise<CorrectionFormState> {
  const owner = await requireOwner();
  const parsed = approvalSchema.safeParse({
    correctionId: formData.get("correctionId"),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) return { error: "Correction not found." };

  const fy = await getCompanyFySettings();
  try {
    const posted = await prisma.$transaction(async (tx) => {
      const draft = await tx.correction.findUnique({ where: { id: parsed.data.correctionId } });
      if (!draft) throw new CorrectionError("Correction not found.");
      const freshPlan = await replanCorrection(tx, draft);
      return approveCorrectionDraft(tx, {
        correctionId: draft.id,
        freshPlan,
        approvedByUserId: owner.id,
        approverRole: owner.role,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        idempotencyKey: parsed.data.idempotencyKey || null,
      });
    });
    revalidateCorrections();
    return { success: true, code: posted.correctionCode };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    console.error("approveCorrection failed:", error);
    return { error: "Could not approve this correction. Please try again." };
  }
}

export async function rejectCorrection(
  _prevState: CorrectionFormState,
  formData: FormData
): Promise<CorrectionFormState> {
  const owner = await requireOwner();
  const correctionId = formData.get("correctionId");
  const reason = formData.get("rejectionReason");
  if (typeof correctionId !== "string" || !correctionId) return { error: "Correction not found." };
  if (typeof reason !== "string" || reason.trim().length < 5) {
    return { error: "Give the reason for rejecting this correction." };
  }

  try {
    await prisma.$transaction((tx) =>
      rejectCorrectionDraft(tx, {
        correctionId,
        approverRole: owner.role,
        approvedByUserId: owner.id,
        reason: reason.trim(),
      })
    );
    revalidateCorrections();
    return { success: true };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    console.error("rejectCorrection failed:", error);
    return { error: "Could not reject this correction. Please try again." };
  }
}
