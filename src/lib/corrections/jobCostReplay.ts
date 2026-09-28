import "server-only";

import type { MetalType } from "@/generated/prisma/enums";
import { replayMetalValues, type ReplayMovement, type ReplayMovementType, type ReplayReceipt, type ReplayResult } from "./metalReplay";
import type { Tx } from "./types";

/**
 * Live carrying-cost replay for the Owner-facing job/finished-stock read
 * paths (Phase 8B display-defect fix). A posted revaluation restates a
 * pool/job/finished-piece TOTAL, but never the individual ISSUE_OUT movement
 * that produced it — so a job's own "metal cost issued" figure (which sums
 * issue-line values, some of which may since have been partly returned) can
 * only be reconstructed by replaying the same corrected ledger the
 * correction itself was planned against. This never writes anything and
 * never reposts a correction — purely a read.
 *
 * Fail-closed by design: if a purity has an active revaluation but its
 * ledger cannot be replayed cleanly, the caller must show nothing rather
 * than a guessed number. See PHASE_8_PLAN.md's "Universal Edit and
 * Correction Requirement" and the Owner's explicit instruction that a
 * failed replay must never fall back to an approximate figure.
 */
export type PurityReplay = ReplayResult & { ok: true };
export type PurityReplayOutcome = PurityReplay | { ok: false; reason: string };

/**
 * Replays one (metalType, purityId) pool's entire ledger at its CURRENT
 * effective values. Returns `{ ok: true }` with every movement/job/finished-
 * piece value the replay computed when this purity has exactly one actively
 * revalued (POSTED) movement; `{ ok: false }` — never throws — when nothing
 * is revalued is impossible to reach here (callers only call this for
 * purities known to have a revaluation), when the ledger has a shape the
 * replay engine refuses, or when more than one movement in this pool has
 * independently been revalued (the replay engine supports only one target
 * at a time, and combining two would be a guess).
 */
export async function replayPurityAtCurrentValues(
  tx: Tx,
  metalType: MetalType,
  purityId: string
): Promise<PurityReplayOutcome> {
  const revaluedRows = await tx.metalRevaluation.findMany({
    where: { correction: { state: "POSTED" }, target: "USABLE_POOL", metalType, purityId },
    select: { sourceMovementId: true },
  });
  const distinctMovementIds = [
    ...new Set(revaluedRows.map((r) => r.sourceMovementId).filter((id): id is string => id !== null)),
  ];
  if (distinctMovementIds.length === 0) {
    return { ok: false, reason: "No revalued movement found for this purity." };
  }
  if (distinctMovementIds.length > 1) {
    return {
      ok: false,
      reason: `${distinctMovementIds.length} independently revalued movements share one pool — replay supports only one target at a time.`,
    };
  }
  const targetMovementId = distinctMovementIds[0];

  const targetCorrection = await tx.correction.findFirst({
    where: { entityId: targetMovementId, entityType: "METAL_OPENING_STOCK", mode: "REVALUE", state: "POSTED" },
    orderBy: { postedAt: "desc" },
    select: { correctedSnapshot: true },
  });
  const snapshot = targetCorrection?.correctedSnapshot as { costValue?: string } | undefined;
  if (!snapshot?.costValue) {
    return { ok: false, reason: "The posted correction's snapshot carries no costValue to replay from." };
  }

  const ledger = await tx.metalStockMovement.findMany({
    where: { metalType, purityId },
    orderBy: { createdAt: "asc" },
  });
  const jobIds = [...new Set(ledger.map((m) => m.jewelleryJobId).filter((id): id is string => id !== null))];
  const receipts = jobIds.length
    ? await tx.jewelleryReceipt.findMany({
        where: { jobId: { in: jobIds } },
        orderBy: { createdAt: "asc" },
        include: { job: { select: { id: true, status: true } }, outputs: true },
      })
    : [];
  const lastReceiptIdByJob = new Map<string, string>();
  for (const r of receipts) lastReceiptIdByJob.set(r.jobId, r.id);

  const replayReceipts: ReplayReceipt[] = receipts.map((r) => ({
    id: r.id,
    code: r.receiptCode,
    jobId: r.jobId,
    isFinalMetal: lastReceiptIdByJob.get(r.jobId) === r.id && r.job.status === "COMPLETED",
    outputs: r.outputs.map((o) => ({
      id: o.id,
      label: o.finishedCode,
      fineMetalWeight: o.fineMetalWeight.toString(),
      metalCost: o.metalCost.toString(),
    })),
  }));
  const replayMovements: ReplayMovement[] = ledger.map((m) => ({
    id: m.id,
    type: m.type as ReplayMovementType,
    createdAt: m.createdAt,
    grossWeight: m.grossWeight.toString(),
    fineWeight: m.fineWeight.toString(),
    costValue: m.costValue.toString(),
    sourceDocument: m.sourceDocument,
    jewelleryJobId: m.jewelleryJobId,
    karigarId: m.karigarId,
    reversalOfMovementId: m.reversalOfMovementId,
  }));

  try {
    const result = replayMetalValues({
      movements: replayMovements,
      receipts: replayReceipts,
      targetMovementId,
      targetNewCostValue: snapshot.costValue,
    });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "replay failed" };
  }
}

/**
 * Every (metalType, purityId) that currently has an active POSTED
 * revaluation — the cheap existence check that decides, per purity, whether
 * the fast stored-value path is enough or a replay is required.
 */
export async function purityIdsWithActiveRevaluation(tx: Tx): Promise<Set<string>> {
  const rows = await tx.metalRevaluation.findMany({
    where: { correction: { state: "POSTED" }, target: "USABLE_POOL" },
    select: { metalType: true, purityId: true },
    distinct: ["metalType", "purityId"],
  });
  return new Set(rows.map((r) => `${r.metalType}:${r.purityId}`));
}

/**
 * Replays every distinct (metalType, purityId) in `keys` exactly once —
 * never once per job/piece — and returns the outcome keyed the same way, so
 * a job list or finished-stock list of any size costs one replay per
 * AFFECTED purity, not one per row.
 */
export async function replayPuritiesOnce(
  tx: Tx,
  keys: { metalType: MetalType; purityId: string }[]
): Promise<Map<string, PurityReplayOutcome>> {
  const unique = new Map(keys.map((k) => [`${k.metalType}:${k.purityId}`, k]));
  const entries = await Promise.all(
    [...unique.entries()].map(async ([key, k]) => [key, await replayPurityAtCurrentValues(tx, k.metalType, k.purityId)] as const)
  );
  return new Map(entries);
}

/** Sanitized diagnostic — never logs weights/values, only identifiers and the refusal reason. */
export function logReplayFailure(context: { metalType: string; purityId: string; jobId?: string; finishedJewelleryId?: string; reason: string }) {
  console.error("carrying-cost replay failed, failing closed", context);
}
