/**
 * Phase 8 — the Owner correction engine.
 *
 * Rules this file enforces, and that `engine.test.ts` proves:
 *
 *  - A correction NEVER updates or deletes the record it corrects. It writes
 *    only a Correction, its CorrectionImpact rows, its MetalRevaluation rows
 *    and one balanced CORRECTION voucher.
 *  - Staff may prepare a draft; only an Owner may approve or post one.
 *  - Posting is atomic (one transaction) and idempotent (unique key).
 *  - The plan is recomputed at approval time and compared with the preview the
 *    Owner approved. If the underlying records moved in between, posting is
 *    refused rather than silently posting different numbers.
 */
import type { Prisma } from "@/generated/prisma/client";
import type { CorrectionState, UserRole } from "@/generated/prisma/enums";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { cancelVoucher, createVoucherHeader, insertBalancedJournalLines } from "@/lib/accounting/posting";
import {
  CorrectionError,
  fingerprintPlan,
  type CorrectionPlan,
  type Tx,
} from "./types";

export type PostCorrectionInput = {
  plan: CorrectionPlan;
  preparedByUserId: string;
  /** Required to post. A Staff id here is a programming error, not a state. */
  approvedByUserId: string;
  approverRole: UserRole;
  date?: Date;
  fyStartMonth: number;
  fyStartDay: number;
  idempotencyKey?: string | null;
  /**
   * REPLACEMENT link: the named correction is closed by this one. Never use
   * it for cumulative steps — pass `batch` instead.
   */
  supersedesCorrectionId?: string | null;
  /** CUMULATIVE link: this correction is one required step of a batch. */
  batch?: { batchId: string; step: number } | null;
};

function assertBalanced(plan: CorrectionPlan): Decimal {
  let debit = ZERO;
  let credit = ZERO;
  for (const line of plan.ledgerLines) {
    debit = debit.plus(new Decimal(line.debit ?? 0));
    credit = credit.plus(new Decimal(line.credit ?? 0));
  }
  if (!debit.equals(credit)) {
    throw new CorrectionError(
      `Correction is unbalanced: debit ${debit.toFixed(2)} != credit ${credit.toFixed(2)}.`
    );
  }
  if (plan.ledgerLines.length > 0 && !debit.equals(new Decimal(plan.amount))) {
    throw new CorrectionError(
      `Correction amount ${plan.amount} does not match its entries (${debit.toFixed(2)}).`
    );
  }
  return round2(debit);
}

/**
 * Every revaluation share must appear in the compensating entry. The shares
 * are signed and the entry is not, so they are tied to the value that moved
 * across the inventory/WIP accounts rather than to the voucher amount.
 */
function assertRevaluationsTieToLedger(plan: CorrectionPlan): void {
  if (plan.revaluations.length === 0) return;
  const shares = plan.revaluations.reduce((sum, r) => sum.plus(new Decimal(r.deltaCostValue)), ZERO);
  const assetSide = plan.ledgerLines
    .filter((l) => l.accountCode !== SYSTEM_ACCOUNT_CODES.OPENING_BALANCE_EQUITY)
    .reduce((sum, l) => sum.plus(new Decimal(l.debit ?? 0)).minus(new Decimal(l.credit ?? 0)), ZERO);
  if (!round2(shares).equals(round2(assetSide))) {
    throw new CorrectionError(
      `Revaluation shares (${round2(shares).toFixed(2)}) do not tie to the posted entries (${round2(assetSide).toFixed(2)}).`
    );
  }
}

/** Saves a correction for later approval. Anyone with module access may do this. */
export async function saveCorrectionDraft(
  tx: Tx,
  input: {
    plan: CorrectionPlan;
    preparedByUserId: string;
    submitForApproval: boolean;
  }
) {
  assertBalanced(input.plan);
  return tx.correction.create({
    data: {
      correctionCode: draftCode(),
      entityType: input.plan.entityType,
      entityId: input.plan.entityId,
      entityLabel: input.plan.entityLabel,
      mode: input.plan.mode,
      state: input.submitForApproval ? "AWAITING_APPROVAL" : "DRAFT",
      reason: input.plan.reason,
      originalSnapshot: input.plan.originalSnapshot as Prisma.InputJsonValue,
      correctedSnapshot: input.plan.correctedSnapshot as Prisma.InputJsonValue,
      impactPreview: toPreviewJson(input.plan) as Prisma.InputJsonValue,
      preparedByUserId: input.preparedByUserId,
    },
  });
}

/** A draft's placeholder code, replaced with CORR/<FY>/NNNN when it posts. */
function draftCode(): string {
  return `CORR-DRAFT-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toPreviewJson(plan: CorrectionPlan) {
  return {
    mode: plan.mode,
    amount: plan.amount,
    voucherNote: plan.voucherNote,
    downstream: plan.downstream,
    impacts: plan.impacts,
    ledgerLines: plan.ledgerLines.map((l) => ({
      accountCode: l.accountCode,
      debit: l.debit === undefined ? null : String(l.debit),
      credit: l.credit === undefined ? null : String(l.credit),
      description: l.description ?? null,
    })),
    revaluations: plan.revaluations,
    fingerprint: fingerprintPlan(plan),
  };
}

/**
 * Posts a correction. Owner-only, atomic, idempotent.
 *
 * Nothing about the corrected record is touched: the compensating voucher and
 * the revaluation rows carry the whole effect.
 */
export async function postCorrection(tx: Tx, input: PostCorrectionInput) {
  if (input.approverRole !== "OWNER") {
    throw new CorrectionError("Only the Owner can approve and post a correction.");
  }
  const plan = input.plan;
  if (!plan.reason.trim()) {
    throw new CorrectionError("A correction needs a reason.");
  }
  const total = assertBalanced(plan);
  assertRevaluationsTieToLedger(plan);
  if (input.batch && input.supersedesCorrectionId) {
    throw new CorrectionError(
      "A correction cannot both replace another correction and be a cumulative step of a batch."
    );
  }
  if (input.batch) await assertBatchStepAvailable(tx, input.batch);

  const date = input.date ?? new Date();
  let correctionVoucherId: string | null = null;
  let correctionCode = draftCode();

  if (plan.ledgerLines.length > 0) {
    const voucher = await createVoucherHeader(
      tx,
      {
        date,
        fyStartMonth: input.fyStartMonth,
        fyStartDay: input.fyStartDay,
        currencyCode: "INR",
        exchangeRate: 1,
        note: plan.voucherNote,
        idempotencyKey: input.idempotencyKey ?? null,
        createdByUserId: input.approvedByUserId,
      },
      "CORRECTION",
      { amount: total }
    );
    await insertBalancedJournalLines(tx, voucher.id, plan.ledgerLines);
    correctionVoucherId = voucher.id;
    correctionCode = voucher.voucherNumber;
  }

  const correction = await tx.correction.create({
    data: {
      correctionCode,
      entityType: plan.entityType,
      entityId: plan.entityId,
      entityLabel: plan.entityLabel,
      mode: plan.mode,
      state: "POSTED",
      reason: plan.reason,
      originalSnapshot: plan.originalSnapshot as Prisma.InputJsonValue,
      correctedSnapshot: plan.correctedSnapshot as Prisma.InputJsonValue,
      impactPreview: toPreviewJson(plan) as Prisma.InputJsonValue,
      preparedByUserId: input.preparedByUserId,
      approvedByUserId: input.approvedByUserId,
      postedAt: date,
      correctionVoucherId,
      supersedesCorrectionId: input.supersedesCorrectionId ?? null,
      batchId: input.batch?.batchId ?? null,
      batchStep: input.batch?.step ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  });

  if (plan.impacts.length > 0) {
    await tx.correctionImpact.createMany({
      data: plan.impacts.map((i) => ({
        correctionId: correction.id,
        kind: i.kind,
        tableName: i.tableName,
        recordId: i.recordId,
        recordLabel: i.recordLabel,
        field: i.field,
        oldValue: i.oldValue,
        newValue: i.newValue,
      })),
    });
  }

  for (const r of plan.revaluations) {
    await tx.metalRevaluation.create({
      data: {
        correctionId: correction.id,
        target: r.target,
        metalType: r.metalType,
        purityId: r.purityId,
        grossWeight: r.grossWeight,
        fineWeight: r.fineWeight,
        oldCostValue: r.oldCostValue,
        newCostValue: r.newCostValue,
        deltaCostValue: r.deltaCostValue,
        jewelleryJobId: r.jewelleryJobId ?? null,
        finishedJewelleryId: r.finishedJewelleryId ?? null,
        sourceMovementId: r.sourceMovementId ?? null,
      },
    });
  }

  if (input.batch) await refreshBatchState(tx, input.batch.batchId);

  return correction;
}

/**
 * Approves a stored draft, recomputing its plan first. If the world moved
 * since the Owner saw the preview, the correction is refused — a preview that
 * no longer matches reality was never approved.
 */
export async function approveCorrectionDraft(
  tx: Tx,
  input: {
    correctionId: string;
    freshPlan: CorrectionPlan;
    approvedByUserId: string;
    approverRole: UserRole;
    fyStartMonth: number;
    fyStartDay: number;
    date?: Date;
    idempotencyKey?: string | null;
  }
) {
  if (input.approverRole !== "OWNER") {
    throw new CorrectionError("Only the Owner can approve and post a correction.");
  }
  const draft = await tx.correction.findUnique({ where: { id: input.correctionId } });
  if (!draft) throw new CorrectionError("Correction not found.");
  if (draft.state === "POSTED") throw new CorrectionError("This correction has already been posted.");
  if (draft.state === "REJECTED") throw new CorrectionError("This correction was rejected.");

  const approvedPreview = draft.impactPreview as { fingerprint?: unknown } | null;
  const approvedFingerprint = JSON.stringify(approvedPreview?.fingerprint ?? null);
  const freshFingerprint = JSON.stringify(fingerprintPlan(input.freshPlan));
  if (approvedFingerprint !== freshFingerprint) {
    throw new CorrectionError(
      "These records changed after this correction was prepared. Review the new impact preview and prepare it again."
    );
  }

  const posted = await postCorrection(tx, {
    plan: input.freshPlan,
    preparedByUserId: draft.preparedByUserId,
    approvedByUserId: input.approvedByUserId,
    approverRole: input.approverRole,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    date: input.date,
    idempotencyKey: input.idempotencyKey ?? null,
  });

  // The draft is closed by pointing at what it became; it is never deleted.
  await tx.correction.update({
    where: { id: draft.id },
    data: { state: "REJECTED", rejectionReason: `Superseded by posted correction ${posted.correctionCode}` },
  });
  await tx.correction.update({
    where: { id: posted.id },
    data: { supersedesCorrectionId: draft.id },
  });

  return posted;
}

export async function rejectCorrectionDraft(
  tx: Tx,
  input: { correctionId: string; approverRole: UserRole; approvedByUserId: string; reason: string }
) {
  if (input.approverRole !== "OWNER") {
    throw new CorrectionError("Only the Owner can reject a correction.");
  }
  const draft = await tx.correction.findUnique({ where: { id: input.correctionId } });
  if (!draft) throw new CorrectionError("Correction not found.");
  if (draft.state === "POSTED") throw new CorrectionError("A posted correction cannot be rejected.");
  return tx.correction.update({
    where: { id: draft.id },
    data: {
      state: "REJECTED" satisfies CorrectionState,
      rejectionReason: input.reason,
      approvedByUserId: input.approvedByUserId,
    },
  });
}

// ---------------------------------------------------------------------------
// Correction batches — several cumulative, each-required corrections
// ---------------------------------------------------------------------------

/**
 * Opens a batch. Every step in it is required and, once posted, every step
 * stays POSTED and active: a batch is explicitly NOT a supersede chain, where
 * the earlier record would be closed.
 */
export async function createCorrectionBatch(
  tx: Tx,
  input: { batchCode: string; purpose: string; requiredSteps: number; createdByUserId: string }
) {
  if (input.requiredSteps < 1) throw new CorrectionError("A batch needs at least one step.");
  if (!input.batchCode.trim()) throw new CorrectionError("A batch needs a code.");
  return tx.correctionBatch.create({
    data: {
      batchCode: input.batchCode.trim(),
      purpose: input.purpose.trim(),
      requiredSteps: input.requiredSteps,
      createdByUserId: input.createdByUserId,
    },
  });
}

/** Finds an open batch by code, or opens it. Safe to call on a retry. */
export async function ensureCorrectionBatch(
  tx: Tx,
  input: { batchCode: string; purpose: string; requiredSteps: number; createdByUserId: string }
) {
  const existing = await tx.correctionBatch.findUnique({ where: { batchCode: input.batchCode.trim() } });
  if (existing) {
    if (existing.requiredSteps !== input.requiredSteps) {
      throw new CorrectionError(
        `Batch ${existing.batchCode} already exists with ${existing.requiredSteps} required steps, not ${input.requiredSteps}.`
      );
    }
    return existing;
  }
  return createCorrectionBatch(tx, input);
}

async function assertBatchStepAvailable(tx: Tx, batch: { batchId: string; step: number }) {
  const record = await tx.correctionBatch.findUnique({ where: { id: batch.batchId } });
  if (!record) throw new CorrectionError("Correction batch not found.");
  if (batch.step < 1 || batch.step > record.requiredSteps) {
    throw new CorrectionError(
      `Step ${batch.step} is outside batch ${record.batchCode}, which has ${record.requiredSteps} steps.`
    );
  }
  const taken = await tx.correction.findFirst({
    where: { batchId: batch.batchId, batchStep: batch.step },
  });
  if (taken) {
    throw new CorrectionError(
      `Step ${batch.step} of batch ${record.batchCode} was already posted as ${taken.correctionCode}.`
    );
  }
}

/** A batch is COMPLETE once every required step is posted — and stays so. */
async function refreshBatchState(tx: Tx, batchId: string) {
  const batch = await tx.correctionBatch.findUnique({
    where: { id: batchId },
    include: { corrections: { select: { state: true } } },
  });
  if (!batch) return;
  const posted = batch.corrections.filter((c) => c.state === "POSTED").length;
  const complete = posted >= batch.requiredSteps;
  if (complete === (batch.state === "COMPLETE")) return;
  await tx.correctionBatch.update({
    where: { id: batchId },
    data: { state: complete ? "COMPLETE" : "OPEN", completedAt: complete ? new Date() : null },
  });
}

// ---------------------------------------------------------------------------
// Reversing a posted correction
// ---------------------------------------------------------------------------

/**
 * Undoes a posted correction, audited.
 *
 * Nothing is deleted and nothing is edited: the original correction's entries
 * are mirrored into a REVERSAL voucher through the same `cancelVoucher` flow
 * every other module uses, a reversing Correction is recorded with its own
 * reason and approver, and the original is marked `REVERSED` with a link to
 * it — so it can never sit in history looking as though it still applies.
 *
 * The reversing correction carries no revaluation rows of its own. Current
 * values count only POSTED revaluations, so marking the original REVERSED is
 * what returns the pool, a job's WIP and a finished piece's metal cost to
 * exactly their pre-correction figures.
 */
export async function reverseCorrection(
  tx: Tx,
  input: {
    correctionId: string;
    reason: string;
    approverRole: UserRole;
    approvedByUserId: string;
    fyStartMonth: number;
    fyStartDay: number;
  }
) {
  if (input.approverRole !== "OWNER") {
    throw new CorrectionError("Only the Owner can reverse a correction.");
  }
  if (!input.reason.trim()) throw new CorrectionError("Give the reason for reversing this correction.");

  const original = await tx.correction.findUnique({
    where: { id: input.correctionId },
    include: { correctionVoucher: true },
  });
  if (!original) throw new CorrectionError("Correction not found.");
  if (original.state === "REVERSED" || original.reversedByCorrectionId) {
    throw new CorrectionError("This correction has already been reversed.");
  }
  if (original.state !== "POSTED") {
    throw new CorrectionError("Only a posted correction can be reversed.");
  }
  if (!original.correctionVoucherId) {
    throw new CorrectionError("This correction posted no voucher, so there is nothing to reverse.");
  }

  const reversalVoucher = await cancelVoucher(tx, {
    voucherId: original.correctionVoucherId,
    cancelledByUserId: input.approvedByUserId,
    cancellationReason: input.reason.trim(),
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
  });

  const reversal = await tx.correction.create({
    data: {
      correctionCode: reversalVoucher.voucherNumber,
      entityType: original.entityType,
      entityId: original.entityId,
      entityLabel: original.entityLabel,
      mode: "REVERSAL",
      state: "POSTED",
      reason: input.reason.trim(),
      originalSnapshot: {
        reversedCorrectionCode: original.correctionCode,
        reversedVoucher: original.correctionVoucher?.voucherNumber ?? null,
        amount: original.correctionVoucher?.amount.toFixed(2) ?? null,
      } as Prisma.InputJsonValue,
      correctedSnapshot: {
        note: "Mirror entries posted; the original correction is marked REVERSED and no longer counts.",
      } as Prisma.InputJsonValue,
      impactPreview: {
        mode: "REVERSAL",
        reversedCorrectionId: original.id,
        reversedCorrectionCode: original.correctionCode,
      } as Prisma.InputJsonValue,
      preparedByUserId: input.approvedByUserId,
      approvedByUserId: input.approvedByUserId,
      postedAt: new Date(),
      correctionVoucherId: reversalVoucher.id,
    },
  });

  await tx.correction.update({
    where: { id: original.id },
    data: { state: "REVERSED", reversedByCorrectionId: reversal.id },
  });

  // A batch that loses a step is no longer complete.
  if (original.batchId) await refreshBatchState(tx, original.batchId);

  return reversal;
}

/**
 * Reverses every posted step of a batch, newest step first, so each undo lands
 * on the balance the next one expects.
 */
export async function reverseCorrectionBatch(
  tx: Tx,
  input: {
    batchId: string;
    reason: string;
    approverRole: UserRole;
    approvedByUserId: string;
    fyStartMonth: number;
    fyStartDay: number;
  }
) {
  if (input.approverRole !== "OWNER") {
    throw new CorrectionError("Only the Owner can reverse a correction batch.");
  }
  const batch = await tx.correctionBatch.findUnique({
    where: { id: input.batchId },
    include: { corrections: { where: { state: "POSTED" }, orderBy: { batchStep: "desc" } } },
  });
  if (!batch) throw new CorrectionError("Correction batch not found.");
  if (batch.corrections.length === 0) {
    throw new CorrectionError("This batch has no posted step left to reverse.");
  }

  const reversals = [];
  for (const step of batch.corrections) {
    reversals.push(
      await reverseCorrection(tx, {
        correctionId: step.id,
        reason: `${input.reason.trim()} (batch ${batch.batchCode} step ${step.batchStep})`,
        approverRole: input.approverRole,
        approvedByUserId: input.approvedByUserId,
        fyStartMonth: input.fyStartMonth,
        fyStartDay: input.fyStartDay,
      })
    );
  }
  return reversals;
}
