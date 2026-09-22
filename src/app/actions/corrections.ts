"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireOwner, requireUser } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import {
  approveCorrectionDraft,
  ensureCorrectionBatch,
  postCorrection,
  rejectCorrectionDraft,
  saveCorrectionDraft,
} from "@/lib/corrections/engine";
import {
  planOpeningStockLedgerBackfill,
  planOpeningStockRevaluation,
  replanCorrection,
} from "@/lib/corrections/openingStockCorrection";
import {
  CORRECTION_TRANSACTION_OPTIONS,
  CorrectionError,
  type CorrectionPlan,
  type Tx,
} from "@/lib/corrections/types";
import { Prisma } from "@/generated/prisma/client";

/** Prisma's code for "the interactive transaction ran past its timeout". */
const TRANSACTION_TIMEOUT_CODE = "P2028";

/**
 * A rolled-back transaction saves nothing, and the Owner needs to be told that
 * plainly rather than left wondering whether half of it landed.
 */
const TIMEOUT_MESSAGE =
  "This correction took longer than the database allows, so it was rolled back and nothing was saved. Check Correction History before trying again.";

/**
 * Logs what is needed to diagnose a failure and nothing more: never a
 * connection string, credential, cookie or request body.
 */
function reportCorrectionFailure(
  error: unknown,
  context: { operation: string; entityType?: string; batchCode?: string | null; batchStep?: number | null }
): string | undefined {
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
  console.error("correction action failed", {
    operation: context.operation,
    entityType: context.entityType ?? "METAL_OPENING_STOCK",
    batchCode: context.batchCode ?? null,
    batchStep: context.batchStep ?? null,
    errorName: error instanceof Error ? error.name : typeof error,
    prismaCode: prismaCode ?? null,
    message: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
  return prismaCode;
}

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
  /**
   * Cumulative batch membership: R1 and R2 of one opening entry are two
   * required steps of one batch, and both stay posted and active. This is
   * deliberately NOT a supersede link, which would close the earlier one.
   */
  batchCode: z.string().trim().max(60).optional(),
  batchPurpose: z.string().trim().max(300).optional(),
  batchStep: z.coerce.number().int().min(1).max(20).optional(),
  batchRequiredSteps: z.coerce.number().int().min(1).max(20).optional(),
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
    reportCorrectionFailure(error, { operation: "previewOpeningStockCorrection" });
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
    }, CORRECTION_TRANSACTION_OPTIONS);
    revalidateCorrections();
    return { success: true, code: draft.correctionCode };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    const code = reportCorrectionFailure(error, { operation: "saveOpeningStockCorrectionDraft" });
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
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
    batchCode: formData.get("batchCode") || undefined,
    batchPurpose: formData.get("batchPurpose") || undefined,
    batchStep: formData.get("batchStep") || undefined,
    batchRequiredSteps: formData.get("batchRequiredSteps") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const { idempotencyKey } = parsed.data;

  if (idempotencyKey) {
    const existing = await prisma.correction.findUnique({ where: { idempotencyKey } });
    if (existing) return { success: true, code: existing.correctionCode };
  }

  const { batchCode, batchStep, batchRequiredSteps } = parsed.data;
  if ((batchCode || batchStep) && !(batchCode && batchStep && batchRequiredSteps)) {
    return { error: "A batch step needs the batch code, the step number and the number of required steps." };
  }

  const fy = await getCompanyFySettings();
  try {
    const correction = await prisma.$transaction(async (tx) => {
      const plan = await buildPlan(tx, parsed.data);
      const batch = batchCode
        ? await ensureCorrectionBatch(tx, {
            batchCode,
            purpose: parsed.data.batchPurpose ?? plan.entityLabel,
            requiredSteps: batchRequiredSteps!,
            createdByUserId: owner.id,
          })
        : null;
      return postCorrection(tx, {
        plan,
        preparedByUserId: owner.id,
        approvedByUserId: owner.id,
        approverRole: owner.role,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        idempotencyKey: idempotencyKey || null,
        batch: batch ? { batchId: batch.id, step: batchStep! } : null,
      });
    }, CORRECTION_TRANSACTION_OPTIONS);
    revalidateCorrections();
    return { success: true, code: correction.correctionCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && idempotencyKey) {
      const existing = await prisma.correction.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.correctionCode };
    }
    if (error instanceof CorrectionError) return { error: error.message };
    const code = reportCorrectionFailure(error, {
      operation: "postOpeningStockCorrection",
      batchCode: parsed.data.batchCode ?? null,
      batchStep: parsed.data.batchStep ?? null,
    });
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
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
    }, CORRECTION_TRANSACTION_OPTIONS);
    revalidateCorrections();
    return { success: true, code: posted.correctionCode };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    const code = reportCorrectionFailure(error, { operation: "approveCorrection" });
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
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
      }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    revalidateCorrections();
    return { success: true };
  } catch (error) {
    if (error instanceof CorrectionError) return { error: error.message };
    const code = reportCorrectionFailure(error, { operation: "rejectCorrection" });
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
    return { error: "Could not reject this correction. Please try again." };
  }
}
