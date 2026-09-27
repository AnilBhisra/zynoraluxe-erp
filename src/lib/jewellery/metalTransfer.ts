import "server-only";

import type { MetalType, UserRole } from "@/generated/prisma/enums";
import { round3 } from "@/lib/diamond/allocation";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { postCorrection, reverseCorrection } from "@/lib/corrections/engine";
import { CorrectionError, fingerprintPlan, type CorrectionPlan, type DownstreamUse, type PlannedImpact, type Tx } from "@/lib/corrections/types";
import { nextJewelleryCode } from "@/lib/jewellery/numbering";
import { pendingFineWeightOf } from "@/lib/jewellery/posting";

/**
 * Audited job-to-job reallocation of unresolved fine-bearing metal between two
 * Jewellery Jobs of the SAME Karigar — see the JewelleryMetalTransfer model's
 * own doc comment for the accounting rationale (no voucher; the Jewellery WIP
 * account already holds the value for both jobs).
 *
 * Deliberately scoped to a job whose issued metal is all ONE (metalType,
 * purityId): a job that draws on more than one purity already cannot be
 * safely decomposed for display (see carryingCost.ts's own "mixed job" fail-
 * closed rule) — extending a transfer into that territory would invent an
 * attribution the rest of the app cannot represent, so it is refused instead.
 */

export type MetalTransferEligibility = { ok: true } | { ok: false; reason: string };

const OPEN_STATUSES = ["MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"] as const;
const DESTINATION_STATUSES = ["DRAFT", "MATERIALS_ISSUED", "IN_PROGRESS"] as const;

type JobPurityRow = {
  metalType: MetalType;
  purityId: string;
  purityDisplayName: string;
  finenessPercentSnapshot: Decimal;
};

/** Every distinct (metalType, purityId) a job has ever been issued or transferred, in ONE fixed order (by first-issued). */
async function jobPurities(tx: Tx, jobId: string): Promise<JobPurityRow[]> {
  const lines = await tx.jewelleryMetalIssueLine.findMany({
    where: { jobId },
    orderBy: { createdAt: "asc" },
    include: { purity: { select: { displayName: true } } },
  });
  const seen = new Map<string, JobPurityRow>();
  for (const l of lines) {
    const key = `${l.metalType}:${l.purityId}`;
    if (!seen.has(key)) {
      seen.set(key, {
        metalType: l.metalType,
        purityId: l.purityId,
        purityDisplayName: l.purity.displayName,
        finenessPercentSnapshot: new Decimal(l.finenessPercentSnapshot),
      });
    }
  }
  return [...seen.values()];
}

export type SourcePurityOption = {
  metalType: MetalType;
  purityId: string;
  purityDisplayName: string;
  pendingFineWeight: string;
  remainingWipCost: string;
};

/**
 * The purities a job can transfer FROM right now, each with its own pending
 * fine weight and WIP cost. Empty (never an error) for a job that draws on
 * more than one purity — a mixed job cannot be decomposed per-purity from its
 * single stored `remainingWipCost` column, so no purity of it is offered.
 */
export async function listSourcePurityOptions(tx: Tx, jobId: string): Promise<SourcePurityOption[]> {
  const job = await tx.jewelleryJob.findUnique({ where: { id: jobId } });
  if (!job || !OPEN_STATUSES.includes(job.status as (typeof OPEN_STATUSES)[number])) return [];
  const purities = await jobPurities(tx, jobId);
  if (purities.length !== 1) return [];
  const pending = pendingFineWeightOf(job);
  if (!pending.greaterThan(0)) return [];
  return [
    {
      metalType: purities[0].metalType,
      purityId: purities[0].purityId,
      purityDisplayName: purities[0].purityDisplayName,
      pendingFineWeight: pending.toFixed(3),
      remainingWipCost: new Decimal(job.remainingWipCost).toFixed(2),
    },
  ];
}

/** Every OTHER job of the same Karigar that could receive a transfer, regardless of purity match (checked at plan time). */
export async function listEligibleDestinationJobs(
  tx: Tx,
  input: { sourceJobId: string; karigarId: string }
): Promise<{ id: string; jobCode: string; designName: string; status: string }[]> {
  const rows = await tx.jewelleryJob.findMany({
    where: {
      karigarId: input.karigarId,
      id: { not: input.sourceJobId },
      status: { in: [...DESTINATION_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, jobCode: true, designName: true, status: true },
    take: 100,
  });
  return rows;
}

async function assessSource(
  tx: Tx,
  job: { id: string; jobCode: string; status: string; karigarId: string },
  metalType: MetalType,
  purityId: string
): Promise<MetalTransferEligibility> {
  if (job.status === "CANCELLED") return { ok: false, reason: `${job.jobCode} has been cancelled.` };
  if (!OPEN_STATUSES.includes(job.status as (typeof OPEN_STATUSES)[number])) {
    return { ok: false, reason: `${job.jobCode} is ${job.status.replace(/_/g, " ").toLowerCase()} and has no unresolved metal to transfer.` };
  }
  const purities = await jobPurities(tx, job.id);
  if (purities.length === 0) return { ok: false, reason: `${job.jobCode} has no metal issued to it.` };
  if (purities.length > 1 || purities[0].metalType !== metalType || purities[0].purityId !== purityId) {
    return {
      ok: false,
      reason: `${job.jobCode} draws on more than one metal/purity, or not the one requested — a mixed job cannot be split for transfer.`,
    };
  }
  return { ok: true };
}

async function assessDestination(
  tx: Tx,
  job: { id: string; jobCode: string; status: string; karigarId: string },
  sourceKarigarId: string,
  metalType: MetalType,
  purityId: string,
  finenessPercentSnapshot: Decimal
): Promise<MetalTransferEligibility> {
  if (job.karigarId !== sourceKarigarId) {
    return { ok: false, reason: `${job.jobCode} belongs to a different Karigar — a transfer only ever moves metal within the same Karigar's own jobs.` };
  }
  if (!DESTINATION_STATUSES.includes(job.status as (typeof DESTINATION_STATUSES)[number])) {
    return {
      ok: false,
      reason: `${job.jobCode} is ${job.status.replace(/_/g, " ").toLowerCase()} — a destination must still be Draft, Materials Issued or In Progress (nothing received yet).`,
    };
  }
  const receiptCount = await tx.jewelleryReceipt.count({ where: { jobId: job.id } });
  if (receiptCount > 0) {
    return { ok: false, reason: `${job.jobCode} has already received a receipt, so it can no longer take a transfer-in of unresolved metal.` };
  }
  const purities = await jobPurities(tx, job.id);
  if (purities.length > 0) {
    const existing = purities[0];
    if (purities.length > 1 || existing.metalType !== metalType || existing.purityId !== purityId) {
      return {
        ok: false,
        reason: `${job.jobCode} already holds a different metal/purity — a transfer can only add to a job that holds none, or the exact same one.`,
      };
    }
    if (!existing.finenessPercentSnapshot.equals(finenessPercentSnapshot)) {
      return {
        ok: false,
        reason: `${job.jobCode}'s existing metal was recorded at a different fineness — cannot be merged with this transfer without losing that snapshot.`,
      };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type MetalTransferPlan = {
  plan: CorrectionPlan;
  sourceJobId: string;
  sourceJobCode: string;
  destinationJobId: string;
  destinationJobCode: string;
  karigarName: string;
  metalType: MetalType;
  purityId: string;
  purityDisplayName: string;
  finenessPercentSnapshot: Decimal;
  fineWeight: Decimal;
  grossWeightEquivalent: Decimal;
  costValue: Decimal;
  sourcePendingBefore: Decimal;
  sourcePendingAfter: Decimal;
  sourceWipBefore: Decimal;
  sourceWipAfter: Decimal;
  destinationCreatesFirstMetalLine: boolean;
};

export async function planJobMetalTransfer(
  tx: Tx,
  input: { sourceJobId: string; destinationJobId: string; fineWeight: string | number; reason: string }
): Promise<MetalTransferPlan> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10) throw new CorrectionError("Give the reason for this transfer (at least 10 characters).");
  if (input.sourceJobId === input.destinationJobId) {
    throw new CorrectionError("Source and destination must be two different jobs.");
  }
  const fineWeight = round3(input.fineWeight);
  if (!fineWeight.greaterThan(0)) throw new CorrectionError("Enter a fine weight above zero to transfer.");

  const [source, destination] = await Promise.all([
    tx.jewelleryJob.findUnique({ where: { id: input.sourceJobId }, include: { karigar: { select: { name: true } } } }),
    tx.jewelleryJob.findUnique({ where: { id: input.destinationJobId } }),
  ]);
  if (!source) throw new CorrectionError("Source job not found.");
  if (!destination) throw new CorrectionError("Destination job not found.");

  const purities = await jobPurities(tx, source.id);
  if (purities.length !== 1) {
    const sourceCheck = await assessSource(tx, source, purities[0]?.metalType ?? "GOLD", purities[0]?.purityId ?? "");
    throw new CorrectionError(!sourceCheck.ok ? sourceCheck.reason : "Source job has no single metal/purity to transfer.");
  }
  const { metalType, purityId, purityDisplayName, finenessPercentSnapshot } = purities[0];

  const sourceCheck = await assessSource(tx, source, metalType, purityId);
  if (!sourceCheck.ok) throw new CorrectionError(sourceCheck.reason);
  const destinationCheck = await assessDestination(tx, destination, source.karigarId, metalType, purityId, finenessPercentSnapshot);
  if (!destinationCheck.ok) throw new CorrectionError(destinationCheck.reason);

  const sourcePendingBefore = pendingFineWeightOf(source);
  if (fineWeight.greaterThan(sourcePendingBefore)) {
    throw new CorrectionError(
      `${source.jobCode} only has ${sourcePendingBefore.toFixed(3)}g fine still pending — cannot transfer ${fineWeight.toFixed(3)}g.`
    );
  }
  const sourceWipBefore = new Decimal(source.remainingWipCost);
  // Transferring the WHOLE remaining pending amount takes the WHOLE remaining
  // WIP cost exactly — never a computed ratio that could leave a rounding
  // residue on either side.
  const costValue = fineWeight.equals(sourcePendingBefore)
    ? sourceWipBefore
    : round2(sourceWipBefore.times(fineWeight).dividedBy(sourcePendingBefore));
  const grossWeightEquivalent = finenessPercentSnapshot.greaterThan(0)
    ? round3(fineWeight.times(100).dividedBy(finenessPercentSnapshot))
    : ZERO;

  const destinationPurities = await jobPurities(tx, destination.id);
  const destinationCreatesFirstMetalLine = destinationPurities.length === 0;

  const impacts: PlannedImpact[] = [
    {
      kind: "WIP",
      tableName: "jewellery_jobs",
      recordId: source.id,
      recordLabel: source.jobCode,
      field: "remainingWipCost",
      oldValue: sourceWipBefore.toFixed(2),
      newValue: sourceWipBefore.minus(costValue).toFixed(2),
    },
    {
      kind: "WIP",
      tableName: "jewellery_jobs",
      recordId: destination.id,
      recordLabel: destination.jobCode,
      field: "remainingWipCost",
      oldValue: new Decimal(destination.remainingWipCost).toFixed(2),
      newValue: new Decimal(destination.remainingWipCost).plus(costValue).toFixed(2),
    },
  ];
  const downstream: DownstreamUse[] = [
    {
      kind: "WIP",
      tableName: "jewellery_jobs",
      recordId: destination.id,
      recordLabel: destination.jobCode,
      description: destinationCreatesFirstMetalLine
        ? `${destination.jobCode} receives its first metal from this transfer — not a warehouse issue.`
        : `${destination.jobCode} already holds ${purityDisplayName} — this adds to the same pool.`,
    },
  ];

  const plan: CorrectionPlan = {
    entityType: "JEWELLERY_JOB",
    entityId: source.id,
    entityLabel: `${source.jobCode} → ${destination.jobCode} — ${fineWeight.toFixed(3)}g ${purityDisplayName}`,
    mode: "METAL_TRANSFER",
    reason,
    originalSnapshot: {
      sourceJobCode: source.jobCode,
      destinationJobCode: destination.jobCode,
      sourcePending: sourcePendingBefore.toFixed(3),
      sourceWip: sourceWipBefore.toFixed(2),
      destinationWip: new Decimal(destination.remainingWipCost).toFixed(2),
    },
    correctedSnapshot: {
      fineWeight: fineWeight.toFixed(3),
      grossWeightEquivalent: grossWeightEquivalent.toFixed(3),
      costValue: costValue.toFixed(2),
      sourcePendingAfter: sourcePendingBefore.minus(fineWeight).toFixed(3),
      sourceWipAfter: sourceWipBefore.minus(costValue).toFixed(2),
      destinationWipAfter: new Decimal(destination.remainingWipCost).plus(costValue).toFixed(2),
    },
    downstream,
    impacts,
    ledgerLines: [],
    amount: costValue.toFixed(2),
    voucherNote: `Metal transfer ${source.jobCode} → ${destination.jobCode} (${reason})`,
    revaluations: [],
  };

  return {
    plan,
    sourceJobId: source.id,
    sourceJobCode: source.jobCode,
    destinationJobId: destination.id,
    destinationJobCode: destination.jobCode,
    karigarName: source.karigar.name,
    metalType,
    purityId,
    purityDisplayName,
    finenessPercentSnapshot,
    fineWeight,
    grossWeightEquivalent,
    costValue,
    sourcePendingBefore,
    sourcePendingAfter: sourcePendingBefore.minus(fineWeight),
    sourceWipBefore,
    sourceWipAfter: sourceWipBefore.minus(costValue),
    destinationCreatesFirstMetalLine,
  };
}

export function transferPlanFingerprint(plan: CorrectionPlan): string {
  return JSON.stringify(fingerprintPlan(plan));
}

// ---------------------------------------------------------------------------
// Lock (fixed order — never depends on which job the caller calls "source")
// ---------------------------------------------------------------------------

async function lockJobsInOrder(tx: Tx, jobIdA: string, jobIdB: string): Promise<void> {
  const [first, second] = [jobIdA, jobIdB].sort();
  await tx.$queryRawUnsafe(`SELECT id FROM "jewellery_jobs" WHERE id = $1 FOR UPDATE`, first);
  if (second !== first) {
    await tx.$queryRawUnsafe(`SELECT id FROM "jewellery_jobs" WHERE id = $1 FOR UPDATE`, second);
  }
}

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------

export type PostMetalTransferInput = {
  sourceJobId: string;
  destinationJobId: string;
  fineWeight: string | number;
  reason: string;
  idempotencyKey: string;
  expectedFingerprint?: string | null;
  owner: { id: string; role: UserRole };
  fyStartMonth: number;
  fyStartDay: number;
};

export async function postJobMetalTransfer(tx: Tx, input: PostMetalTransferInput) {
  if (input.owner.role !== "OWNER") throw new CorrectionError("Only the Owner can transfer metal between jobs.");
  if (!input.idempotencyKey?.trim()) throw new CorrectionError("Missing submission key — reload the page and try again.");

  await lockJobsInOrder(tx, input.sourceJobId, input.destinationJobId);

  const existing = await tx.correction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.mode !== "METAL_TRANSFER" || existing.entityId !== input.sourceJobId) {
      throw new CorrectionError("This submission key was already used for a different correction.");
    }
    return { correction: existing, replayed: true as const };
  }

  const built = await planJobMetalTransfer(tx, {
    sourceJobId: input.sourceJobId,
    destinationJobId: input.destinationJobId,
    fineWeight: input.fineWeight,
    reason: input.reason,
  });
  if (input.expectedFingerprint && input.expectedFingerprint !== transferPlanFingerprint(built.plan)) {
    throw new CorrectionError("The pending metal or its cost changed after this preview was shown. Review the new preview and confirm again.");
  }

  const transferCode = await nextJewelleryCode(tx, "JEWELLERY_METAL_TRANSFER");
  const correction = await postCorrection(tx, {
    plan: built.plan,
    preparedByUserId: input.owner.id,
    approvedByUserId: input.owner.id,
    approverRole: input.owner.role,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    idempotencyKey: input.idempotencyKey,
    correctionCodeOverride: transferCode,
  });

  // Two movements sharing the transfer code as sourceDocument: the OUT gets
  // a strictly earlier timestamp so replay's chronological sort can never
  // place the IN before it, however their ids happen to compare.
  const inAt = new Date();
  const outAt = new Date(inAt.getTime() - 1);
  await tx.metalStockMovement.create({
    data: {
      type: "JOB_TRANSFER_OUT",
      metalType: built.metalType,
      purityId: built.purityId,
      grossWeight: built.grossWeightEquivalent.toFixed(3),
      fineWeight: built.fineWeight.toFixed(3),
      costValue: built.costValue.toFixed(2),
      sourceDocument: transferCode,
      jewelleryJobId: built.sourceJobId,
      createdByUserId: input.owner.id,
      createdAt: outAt,
    },
  });
  await tx.metalStockMovement.create({
    data: {
      type: "JOB_TRANSFER_IN",
      metalType: built.metalType,
      purityId: built.purityId,
      grossWeight: built.grossWeightEquivalent.toFixed(3),
      fineWeight: built.fineWeight.toFixed(3),
      costValue: built.costValue.toFixed(2),
      sourceDocument: transferCode,
      jewelleryJobId: built.destinationJobId,
      createdByUserId: input.owner.id,
      createdAt: inAt,
    },
  });

  await tx.jewelleryJob.update({
    where: { id: built.sourceJobId },
    data: {
      remainingWipCost: built.sourceWipAfter.toFixed(2),
      transferredOutFineWeight: { increment: built.fineWeight.toFixed(3) },
      transferredOutCost: { increment: built.costValue.toFixed(2) },
    },
  });

  const destinationLine = await tx.jewelleryMetalIssueLine.create({
    data: {
      jobId: built.destinationJobId,
      metalType: built.metalType,
      purityId: built.purityId,
      finenessPercentSnapshot: built.finenessPercentSnapshot.toFixed(3),
      grossWeight: built.grossWeightEquivalent.toFixed(3),
      fineWeight: built.fineWeight.toFixed(3),
      costValue: built.costValue.toFixed(2),
      issueDate: new Date(),
    },
  });

  const destinationJobBefore = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: built.destinationJobId } });
  await tx.jewelleryJob.update({
    where: { id: built.destinationJobId },
    data: {
      status: destinationJobBefore.status === "DRAFT" ? "MATERIALS_ISSUED" : undefined,
      issuedMetalFineWeight: { increment: built.fineWeight.toFixed(3) },
      issuedMetalCost: { increment: built.costValue.toFixed(2) },
      remainingWipCost: { increment: built.costValue.toFixed(2) },
      transferredInFineWeight: { increment: built.fineWeight.toFixed(3) },
      transferredInCost: { increment: built.costValue.toFixed(2) },
    },
  });

  const transfer = await tx.jewelleryMetalTransfer.create({
    data: {
      transferCode,
      correctionId: correction.id,
      sourceJobId: built.sourceJobId,
      destinationJobId: built.destinationJobId,
      metalType: built.metalType,
      purityId: built.purityId,
      finenessPercentSnapshot: built.finenessPercentSnapshot.toFixed(3),
      grossWeight: built.grossWeightEquivalent.toFixed(3),
      fineWeight: built.fineWeight.toFixed(3),
      costValue: built.costValue.toFixed(2),
      reason: built.plan.reason,
      destinationMetalIssueLineId: destinationLine.id,
      createdByUserId: input.owner.id,
    },
  });

  // Conservation, proven inside the same transaction rather than assumed:
  // the source's fall and the destination's rise are exactly equal.
  const [sourceAfter, destinationAfter] = await Promise.all([
    tx.jewelleryJob.findUniqueOrThrow({ where: { id: built.sourceJobId } }),
    tx.jewelleryJob.findUniqueOrThrow({ where: { id: built.destinationJobId } }),
  ]);
  const fell = built.sourceWipBefore.minus(sourceAfter.remainingWipCost);
  const rose = new Decimal(destinationAfter.remainingWipCost).minus(destinationJobBefore.remainingWipCost);
  if (!fell.equals(built.costValue) || !rose.equals(built.costValue)) {
    throw new CorrectionError("Internal check failed; nothing was saved.");
  }

  return { correction, replayed: false as const, transfer, built };
}

// ---------------------------------------------------------------------------
// Reverse
// ---------------------------------------------------------------------------

export async function reverseJobMetalTransfer(
  tx: Tx,
  input: {
    correctionId: string;
    reason: string;
    owner: { id: string; role: UserRole };
    fyStartMonth: number;
    fyStartDay: number;
  }
) {
  if (input.owner.role !== "OWNER") throw new CorrectionError("Only the Owner can reverse a correction.");
  if (input.reason.trim().length < 10) throw new CorrectionError("Give the reason for reversing this transfer (at least 10 characters).");

  const first = await tx.correction.findUnique({
    where: { id: input.correctionId },
    select: { mode: true, metalTransfer: { select: { sourceJobId: true, destinationJobId: true } } },
  });
  if (!first || first.mode !== "METAL_TRANSFER" || !first.metalTransfer) {
    throw new CorrectionError("This is not a metal-transfer correction.");
  }
  await lockJobsInOrder(tx, first.metalTransfer.sourceJobId, first.metalTransfer.destinationJobId);

  const correction = await tx.correction.findUnique({
    where: { id: input.correctionId },
    include: { metalTransfer: true },
  });
  const transfer = correction?.metalTransfer;
  if (!correction || !transfer) throw new CorrectionError("This is not a metal-transfer correction.");
  if (correction.state === "REVERSED" || correction.reversedByCorrectionId) {
    throw new CorrectionError("This transfer has already been reversed.");
  }
  if (correction.state !== "POSTED") throw new CorrectionError("Only a posted correction can be reversed.");

  const destination = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: transfer.destinationJobId } });
  if (destination.status === "CANCELLED") {
    throw new CorrectionError(`${destination.jobCode} has been cancelled — this transfer can no longer be reversed cleanly.`);
  }
  const receiptCount = await tx.jewelleryReceipt.count({ where: { jobId: destination.id } });
  if (receiptCount > 0) {
    throw new CorrectionError(
      `${destination.jobCode} has already received a receipt since this transfer — the metal has been consumed and this can no longer be reversed.`
    );
  }
  const onwardTransfer = await tx.jewelleryMetalTransfer.findFirst({
    where: { sourceJobId: destination.id, metalType: transfer.metalType, purityId: transfer.purityId, correction: { state: "POSTED" } },
  });
  if (onwardTransfer) {
    throw new CorrectionError(
      `${destination.jobCode} has already transferred this metal onward (${onwardTransfer.transferCode}) — reverse that transfer first.`
    );
  }
  if (new Decimal(destination.remainingWipCost).lessThan(transfer.costValue) || new Decimal(destination.issuedMetalFineWeight).lessThan(transfer.fineWeight)) {
    throw new CorrectionError(`${destination.jobCode}'s metal pool has fallen below the amount this transfer added, so it cannot be removed cleanly.`);
  }

  const source = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: transfer.sourceJobId } });
  const reversalCode = await nextJewelleryCode(tx, "JEWELLERY_METAL_TRANSFER");
  const reversalSourceDocument = `${transfer.transferCode}-REV`;
  const inAt = new Date();
  const outAt = new Date(inAt.getTime() - 1);
  // Mirror pair so a future replay of this purity's ledger correctly nets the
  // original pair back to zero, exactly like the reversal of any other
  // job-ledger movement.
  await tx.metalStockMovement.create({
    data: {
      type: "JOB_TRANSFER_OUT",
      metalType: transfer.metalType,
      purityId: transfer.purityId,
      grossWeight: transfer.grossWeight,
      fineWeight: transfer.fineWeight,
      costValue: transfer.costValue,
      sourceDocument: reversalSourceDocument,
      jewelleryJobId: destination.id,
      createdByUserId: input.owner.id,
      createdAt: outAt,
    },
  });
  await tx.metalStockMovement.create({
    data: {
      type: "JOB_TRANSFER_IN",
      metalType: transfer.metalType,
      purityId: transfer.purityId,
      grossWeight: transfer.grossWeight,
      fineWeight: transfer.fineWeight,
      costValue: transfer.costValue,
      sourceDocument: reversalSourceDocument,
      jewelleryJobId: source.id,
      createdByUserId: input.owner.id,
      createdAt: inAt,
    },
  });

  // Revert to DRAFT only if this transfer was the destination's ONLY metal
  // and it is left with none at all — never guessed, always re-checked.
  const remainingLines = await tx.jewelleryMetalIssueLine.count({
    where: { jobId: destination.id, id: { not: transfer.destinationMetalIssueLineId ?? undefined } },
  });
  const wasOnlyMetal = destination.status === "MATERIALS_ISSUED" && remainingLines === 0 && new Decimal(destination.issuedMetalFineWeight).equals(transfer.fineWeight);
  const hasOtherMaterial =
    (await tx.jewelleryDiamondIssueLine.count({ where: { jobId: destination.id } })) > 0 ||
    (await tx.jewelleryPacketIssueLine.count({ where: { jobId: destination.id } })) > 0 ||
    (await tx.jewelleryOtherMaterialLine.count({ where: { jobId: destination.id } })) > 0;

  await tx.jewelleryJob.update({
    where: { id: destination.id },
    data: {
      status: wasOnlyMetal && !hasOtherMaterial ? "DRAFT" : undefined,
      issuedMetalFineWeight: { decrement: transfer.fineWeight },
      issuedMetalCost: { decrement: transfer.costValue },
      remainingWipCost: { decrement: transfer.costValue },
      transferredInFineWeight: { decrement: transfer.fineWeight },
      transferredInCost: { decrement: transfer.costValue },
    },
  });
  await tx.jewelleryJob.update({
    where: { id: source.id },
    data: {
      remainingWipCost: { increment: transfer.costValue },
      transferredOutFineWeight: { decrement: transfer.fineWeight },
      transferredOutCost: { decrement: transfer.costValue },
    },
  });

  const reversal = await reverseCorrection(tx, {
    correctionId: correction.id,
    reason: input.reason,
    approverRole: input.owner.role,
    approvedByUserId: input.owner.id,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    correctionCodeOverride: reversalCode,
  });

  return { reversal, transfer };
}
