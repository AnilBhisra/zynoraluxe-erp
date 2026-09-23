import "server-only";

import { prisma } from "@/lib/db/prisma";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import {
  logReplayFailure,
  purityIdsWithActiveRevaluation,
  replayPuritiesOnce,
  type PurityReplayOutcome,
} from "@/lib/corrections/jobCostReplay";
import { CARRYING_COST_UNAVAILABLE_MESSAGE } from "@/lib/jewellery/carryingCostMessage";
import type { MetalType } from "@/generated/prisma/enums";

/**
 * Owner-only "fail closed" sentinel: a posted revaluation touches this
 * record but its ledger could not be replayed, so no number is shown — never
 * an approximation, never the stale original presented as current. Staff
 * never sees this either way; `ownerOnly()` already nulls every cost field
 * for a Staff request before it reaches the RSC payload.
 */
export const CARRYING_COST_UNAVAILABLE = "UNAVAILABLE" as const;
export type CarryingAmount = Decimal | typeof CARRYING_COST_UNAVAILABLE;

export function isUnavailable(value: CarryingAmount): value is typeof CARRYING_COST_UNAVAILABLE {
  return value === CARRYING_COST_UNAVAILABLE;
}

export { CARRYING_COST_UNAVAILABLE_MESSAGE };

/** Formats a carrying amount for the page: a plain money string, or the
 * fail-closed message. Callers still pass the result through ownerOnly() so
 * Staff never receives either. */
export function formatCarryingAmount(value: CarryingAmount): string {
  return isUnavailable(value) ? CARRYING_COST_UNAVAILABLE_MESSAGE : value.toFixed(2);
}

type JobIssueRow = { id: string; jewelleryJobId: string | null; metalType: MetalType; purityId: string; costValue: Decimal };

/**
 * Every purity a batch of jobs issued metal from, and (for each job) whether
 * ALL of it is actively revalued, NONE of it is, or it is mixed — plus one
 * replay per distinct revalued purity, run exactly once regardless of how
 * many jobs or finished pieces need it.
 *
 * A finished piece's own `purityId` column is its OUTPUT purity, which can
 * differ from the SOURCE purity its cost actually replays from (e.g. 24K
 * issued, 18K received) — so both job- and piece-level lookups key off the
 * JOB's own ISSUE_OUT movements, never a piece's own purity column.
 */
async function replayForJobs(jobIds: string[]) {
  const issueMovements: JobIssueRow[] = jobIds.length
    ? await prisma.metalStockMovement.findMany({
        where: { type: "ISSUE_OUT", jewelleryJobId: { in: jobIds } },
        select: { id: true, jewelleryJobId: true, metalType: true, purityId: true, costValue: true },
      })
    : [];
  const activePurities = await purityIdsWithActiveRevaluation(prisma);
  const replayByPurity = await replayPuritiesOnce(
    prisma,
    issueMovements
      .filter((m) => activePurities.has(`${m.metalType}:${m.purityId}`))
      .map((m) => ({ metalType: m.metalType, purityId: m.purityId }))
  );

  const movementsByJob = new Map<string, JobIssueRow[]>();
  for (const m of issueMovements) {
    if (!m.jewelleryJobId) continue;
    const list = movementsByJob.get(m.jewelleryJobId) ?? [];
    list.push(m);
    movementsByJob.set(m.jewelleryJobId, list);
  }

  return { activePurities, replayByPurity, movementsByJob };
}

/** For one job: every ISSUE_OUT it made, and the outcome of each one's
 * purity — or `null` when the job is mixed (some revalued, some not) and
 * must fail closed rather than be decomposed from a single stored column. */
function jobOutcomes(
  jobMovements: JobIssueRow[],
  activePurities: Set<string>,
  replayByPurity: Map<string, PurityReplayOutcome>
): { movement: JobIssueRow; outcome: PurityReplayOutcome }[] | null {
  const revalued = jobMovements.filter((m) => activePurities.has(`${m.metalType}:${m.purityId}`));
  if (revalued.length === 0) return [];
  if (revalued.length !== jobMovements.length) return null;
  return revalued.map((m) => ({ movement: m, outcome: replayByPurity.get(`${m.metalType}:${m.purityId}`)! }));
}

export type JobCarryingCost = { issuedMetalCost: CarryingAmount; remainingWipCost: CarryingAmount };

/**
 * Current carrying "metal cost issued" and "remaining WIP" for a batch of
 * jobs, replaying each AFFECTED (metalType, purityId) exactly once — never
 * once per job — and never falling back to a stored/delta approximation
 * when a purity that touches the job could not be replayed cleanly: that
 * job's figures fail closed instead (see CARRYING_COST_UNAVAILABLE).
 *
 * A job that draws on more than one purity, only some of which are
 * revalued, cannot be safely decomposed from the single stored
 * remainingWipCost column — it fails closed too, rather than silently
 * omitting the unrevalued purity's share.
 */
export async function carryingJobCosts(
  jobs: { id: string; issuedMetalCost: Decimal; remainingWipCost: Decimal }[]
): Promise<Map<string, JobCarryingCost>> {
  const result = new Map<string, JobCarryingCost>();
  if (jobs.length === 0) return result;
  const { activePurities, replayByPurity, movementsByJob } = await replayForJobs(jobs.map((j) => j.id));

  for (const job of jobs) {
    const entries = jobOutcomes(movementsByJob.get(job.id) ?? [], activePurities, replayByPurity);

    if (entries === null) {
      logReplayFailure({
        metalType: "MIXED",
        purityId: "MIXED",
        jobId: job.id,
        reason: "job draws on both a revalued and an unrevalued purity; cannot be decomposed for display",
      });
      result.set(job.id, { issuedMetalCost: CARRYING_COST_UNAVAILABLE, remainingWipCost: CARRYING_COST_UNAVAILABLE });
      continue;
    }
    if (entries.length === 0) {
      result.set(job.id, { issuedMetalCost: job.issuedMetalCost, remainingWipCost: job.remainingWipCost });
      continue;
    }

    let issuedTotal = ZERO;
    let wipTotal = ZERO;
    let failed = false;
    for (const { movement: m, outcome } of entries) {
      if (!outcome.ok) {
        failed = true;
        logReplayFailure({ metalType: m.metalType, purityId: m.purityId, jobId: job.id, reason: outcome.reason });
        continue;
      }
      const restated = outcome.movements.get(m.id);
      if (!restated) {
        failed = true;
        logReplayFailure({ metalType: m.metalType, purityId: m.purityId, jobId: job.id, reason: "issue movement missing from replay result" });
        continue;
      }
      issuedTotal = issuedTotal.plus(restated.newValue);
      wipTotal = wipTotal.plus(outcome.jobWip.get(job.id)?.newValue ?? ZERO);
    }

    result.set(
      job.id,
      failed
        ? { issuedMetalCost: CARRYING_COST_UNAVAILABLE, remainingWipCost: CARRYING_COST_UNAVAILABLE }
        : { issuedMetalCost: round2(issuedTotal), remainingWipCost: round2(wipTotal) }
    );
  }

  return result;
}

export type FinishedPieceCarryingCost = { metalCost: CarryingAmount; totalCost: CarryingAmount };

/**
 * Current carrying metal/total cost for a batch of finished pieces,
 * replaying each affected purity once — keyed off each piece's OWN JOB's
 * ISSUE_OUT movements (see replayForJobs), never the piece's own `purityId`
 * column, which is its output purity and can differ from the source. A
 * piece whose job never touched a revalued purity keeps its stored figures
 * unchanged (the common, fast path).
 */
export async function carryingFinishedPieceCosts(
  pieces: { id: string; jobId: string; diamondCost: Decimal; labourAllocated: Decimal; totalCost: Decimal; metalCost: Decimal }[]
): Promise<Map<string, FinishedPieceCarryingCost>> {
  const result = new Map<string, FinishedPieceCarryingCost>();
  if (pieces.length === 0) return result;
  const jobIds = [...new Set(pieces.map((p) => p.jobId))];
  const { activePurities, replayByPurity, movementsByJob } = await replayForJobs(jobIds);

  for (const p of pieces) {
    const entries = jobOutcomes(movementsByJob.get(p.jobId) ?? [], activePurities, replayByPurity);

    if (entries === null) {
      logReplayFailure({
        metalType: "MIXED",
        purityId: "MIXED",
        jobId: p.jobId,
        finishedJewelleryId: p.id,
        reason: "job draws on both a revalued and an unrevalued purity; cannot be decomposed for display",
      });
      result.set(p.id, { metalCost: CARRYING_COST_UNAVAILABLE, totalCost: CARRYING_COST_UNAVAILABLE });
      continue;
    }
    if (entries.length === 0) {
      result.set(p.id, { metalCost: p.metalCost, totalCost: p.totalCost });
      continue;
    }

    // The piece is discovered in whichever revalued purity's replay actually
    // produced it — normally exactly one of the job's purities.
    let found: Decimal | null = null;
    let failed = false;
    for (const { movement: m, outcome } of entries) {
      if (!outcome.ok) {
        failed = true;
        logReplayFailure({ metalType: m.metalType, purityId: m.purityId, finishedJewelleryId: p.id, reason: outcome.reason });
        continue;
      }
      const restated = outcome.finishedPieces.get(p.id);
      if (restated) found = restated.newValue;
    }

    if (failed) {
      result.set(p.id, { metalCost: CARRYING_COST_UNAVAILABLE, totalCost: CARRYING_COST_UNAVAILABLE });
      continue;
    }
    if (found === null) {
      // None of the job's revalued purities produced this piece — its own
      // metal cost is untouched (e.g. an alloy-only or otherwise unaffected
      // output on an otherwise-revalued job).
      result.set(p.id, { metalCost: p.metalCost, totalCost: p.totalCost });
      continue;
    }
    const metalCost = round2(found);
    const totalCost = round2(metalCost.plus(p.diamondCost).plus(p.labourAllocated));
    result.set(p.id, { metalCost, totalCost });
  }

  return result;
}
