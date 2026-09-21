/**
 * Phase 8 — metal value replay.
 *
 * Given the complete immutable metal ledger for ONE metal + purity, and a new
 * value for one movement in it, this computes what every downstream value
 * would have been had the corrected value been there from the start.
 *
 * It is deliberately pure: no Prisma, no I/O. The caller loads the ledger and
 * writes the compensating records; this file only does the arithmetic, using
 * exactly the rules the posting engine uses:
 *
 *   - the usable pool is weighted-average **per gross gram** (posting.ts:539)
 *   - a receipt drains the job's metal WIP pool **by fine weight**, and the
 *     final receipt takes the whole remaining pool (posting.ts:1482-1489)
 *   - returned and scrap metal carve their share out of the resolved cost
 *     before the finished portion (posting.ts:1500-1510)
 *   - a receipt's finished portion is split across its outputs by fine
 *     weight (posting.ts:1631-1632)
 *
 * Weights are never changed by a replay. Only value moves.
 */
import { allocateProportionally } from "@/lib/diamond/allocation";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";

export type ReplayMovementType =
  | "OPENING_IN"
  | "PURCHASE_IN"
  | "ADJUSTMENT_IN"
  | "ADJUSTMENT_OUT"
  | "ISSUE_OUT"
  | "RETURN_IN"
  | "SCRAP_RETURN_IN"
  | "CONSUMED_OUT"
  | "ISSUE_CANCEL_IN";

export type ReplayMovement = {
  id: string;
  type: ReplayMovementType;
  createdAt: Date;
  grossWeight: DecimalInput;
  fineWeight: DecimalInput;
  costValue: DecimalInput;
  /** Receipt or job code — how receipt-side movements are grouped. */
  sourceDocument: string;
  jewelleryJobId: string | null;
};

/** One finished piece produced by a receipt, for splitting its metal cost. */
export type ReplayOutput = {
  id: string;
  label: string;
  fineMetalWeight: DecimalInput;
  metalCost: DecimalInput;
};

export type ReplayReceipt = {
  id: string;
  code: string;
  jobId: string;
  /** True when this receipt closed the job's metal (it takes the whole pool). */
  isFinalMetal: boolean;
  outputs: ReplayOutput[];
};

export type ReplayInput = {
  movements: ReplayMovement[];
  receipts: ReplayReceipt[];
  /** The movement being revalued, and its corrected value. */
  targetMovementId: string;
  targetNewCostValue: DecimalInput;
};

export type ReplayValueChange = {
  oldValue: Decimal;
  newValue: Decimal;
  delta: Decimal;
};

export type ReplayResult = {
  /** Usable pool as it stands after the last movement. */
  usablePool: ReplayValueChange & { grossWeight: Decimal };
  scrapPool: ReplayValueChange & { grossWeight: Decimal };
  /** Metal value still with a Karigar, by job id. */
  jobWip: Map<string, ReplayValueChange & { fineWeight: Decimal }>;
  /** Metal cost of each finished piece, by finished jewellery id. */
  finishedPieces: Map<string, ReplayValueChange & { label: string; fineWeight: Decimal }>;
  /** Per-movement restated value, for evidence (originals are never edited). */
  movements: Map<string, ReplayValueChange>;
};

export class ReplayError extends Error {}

type Pool = { gross: Decimal; value: Decimal };
type JobState = { issuedFine: Decimal; pendingFine: Decimal; wipValue: Decimal; oldWipValue: Decimal };

const d = (v: DecimalInput) => new Decimal(v);

/**
 * Replays the ledger. Refuses rather than guesses: any movement shape it
 * cannot reproduce exactly (a cancelled issue, a Karigar-added cost, a
 * receipt whose outputs it cannot see) raises `ReplayError`, so a correction
 * is never posted on an assumption.
 */
export function replayMetalValues(input: ReplayInput): ReplayResult {
  const movements = [...input.movements].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1)
  );
  if (!movements.some((m) => m.id === input.targetMovementId)) {
    throw new ReplayError("The movement being corrected is not in this metal ledger.");
  }

  const receiptsByCode = new Map(input.receipts.map((r) => [r.code, r]));
  const pool: Pool = { gross: ZERO, value: ZERO };
  const oldPool: Pool = { gross: ZERO, value: ZERO };
  const scrap: Pool = { gross: ZERO, value: ZERO };
  const oldScrap: Pool = { gross: ZERO, value: ZERO };
  const jobs = new Map<string, JobState>();
  const finished = new Map<string, ReplayValueChange & { label: string; fineWeight: Decimal }>();
  const movementChanges = new Map<string, ReplayValueChange>();

  const jobState = (jobId: string): JobState => {
    const existing = jobs.get(jobId);
    if (existing) return existing;
    const fresh: JobState = { issuedFine: ZERO, pendingFine: ZERO, wipValue: ZERO, oldWipValue: ZERO };
    jobs.set(jobId, fresh);
    return fresh;
  };

  const record = (id: string, oldValue: DecimalInput, newValue: Decimal) => {
    const previous = d(oldValue);
    movementChanges.set(id, { oldValue: previous, newValue, delta: round2(newValue.minus(previous)) });
  };

  // Receipt-side movements (return / scrap / consumed) are driven by their
  // receipt, not individually — one receipt resolves a slice of the job's
  // pool and splits it. Group them by source document, keyed to the earliest.
  const receiptGroups = new Map<string, ReplayMovement[]>();
  for (const m of movements) {
    if (m.type === "RETURN_IN" || m.type === "SCRAP_RETURN_IN" || m.type === "CONSUMED_OUT") {
      const group = receiptGroups.get(m.sourceDocument) ?? [];
      group.push(m);
      receiptGroups.set(m.sourceDocument, group);
    }
  }
  const receiptHandledAt = new Set<string>();

  for (const m of movements) {
    const isTarget = m.id === input.targetMovementId;
    const gross = d(m.grossWeight);
    const fine = d(m.fineWeight);

    switch (m.type) {
      case "OPENING_IN":
      case "PURCHASE_IN":
      case "ADJUSTMENT_IN": {
        const newValue = isTarget ? round2(input.targetNewCostValue) : d(m.costValue);
        pool.gross = pool.gross.plus(gross);
        pool.value = round2(pool.value.plus(newValue));
        oldPool.gross = oldPool.gross.plus(gross);
        oldPool.value = round2(oldPool.value.plus(d(m.costValue)));
        record(m.id, m.costValue, newValue);
        break;
      }

      case "ADJUSTMENT_OUT": {
        // Value leaves at the pool average, same as an issue.
        const newValue = poolShare(pool, gross);
        pool.gross = pool.gross.minus(gross);
        pool.value = round2(pool.value.minus(newValue));
        oldPool.gross = oldPool.gross.minus(gross);
        oldPool.value = round2(oldPool.value.minus(d(m.costValue)));
        record(m.id, m.costValue, newValue);
        break;
      }

      case "ISSUE_OUT": {
        if (!m.jewelleryJobId) throw new ReplayError("An issue movement has no job — cannot replay it.");
        const newValue = poolShare(pool, gross);
        pool.gross = pool.gross.minus(gross);
        pool.value = round2(pool.value.minus(newValue));
        oldPool.gross = oldPool.gross.minus(gross);
        oldPool.value = round2(oldPool.value.minus(d(m.costValue)));
        const job = jobState(m.jewelleryJobId);
        job.issuedFine = job.issuedFine.plus(fine);
        job.pendingFine = job.pendingFine.plus(fine);
        job.wipValue = round2(job.wipValue.plus(newValue));
        job.oldWipValue = round2(job.oldWipValue.plus(d(m.costValue)));
        record(m.id, m.costValue, newValue);
        break;
      }

      case "RETURN_IN":
      case "SCRAP_RETURN_IN":
      case "CONSUMED_OUT": {
        if (receiptHandledAt.has(m.sourceDocument)) break;
        receiptHandledAt.add(m.sourceDocument);
        applyReceipt({
          group: receiptGroups.get(m.sourceDocument) ?? [],
          receipt: receiptsByCode.get(m.sourceDocument),
          pool,
          oldPool,
          scrap,
          oldScrap,
          jobState,
          finished,
          record,
        });
        break;
      }

      case "ISSUE_CANCEL_IN":
        throw new ReplayError(
          "This metal was issued and then cancelled. A cancelled issue cannot be revalued automatically — correct the job first."
        );

      default: {
        const exhaustive: never = m.type;
        throw new ReplayError(`Unsupported metal movement type: ${String(exhaustive)}`);
      }
    }
  }

  const jobWip = new Map<string, ReplayValueChange & { fineWeight: Decimal }>();
  for (const [jobId, state] of jobs) {
    if (state.pendingFine.isZero() && state.wipValue.isZero() && state.oldWipValue.isZero()) continue;
    jobWip.set(jobId, {
      fineWeight: state.pendingFine,
      oldValue: state.oldWipValue,
      newValue: state.wipValue,
      delta: round2(state.wipValue.minus(state.oldWipValue)),
    });
  }

  return {
    usablePool: {
      grossWeight: pool.gross,
      oldValue: oldPool.value,
      newValue: pool.value,
      delta: round2(pool.value.minus(oldPool.value)),
    },
    scrapPool: {
      grossWeight: scrap.gross,
      oldValue: oldScrap.value,
      newValue: scrap.value,
      delta: round2(scrap.value.minus(oldScrap.value)),
    },
    jobWip,
    finishedPieces: finished,
    movements: movementChanges,
  };
}

/** Weighted-average share of the pool for `gross` grams (posting.ts:539-542). */
function poolShare(pool: Pool, gross: Decimal): Decimal {
  if (!pool.gross.greaterThan(0)) return ZERO;
  return round2(gross.times(pool.value.dividedBy(pool.gross)));
}

function applyReceipt(args: {
  group: ReplayMovement[];
  receipt: ReplayReceipt | undefined;
  pool: Pool;
  oldPool: Pool;
  scrap: Pool;
  oldScrap: Pool;
  jobState: (jobId: string) => JobState;
  finished: Map<string, ReplayValueChange & { label: string; fineWeight: Decimal }>;
  record: (id: string, oldValue: DecimalInput, newValue: Decimal) => void;
}) {
  const { group, receipt, pool, oldPool, scrap, oldScrap, jobState, finished, record } = args;
  if (group.length === 0) return;
  const jobId = group[0].jewelleryJobId;
  if (!jobId) throw new ReplayError("A receipt movement has no job — cannot replay it.");
  if (!receipt) {
    throw new ReplayError(
      `Receipt ${group[0].sourceDocument} could not be loaded, so its finished pieces cannot be revalued.`
    );
  }
  const job = jobState(jobId);

  const returns = group.filter((m) => m.type === "RETURN_IN");
  const scraps = group.filter((m) => m.type === "SCRAP_RETURN_IN");
  const consumed = group.filter((m) => m.type === "CONSUMED_OUT");
  const sumFine = (rows: ReplayMovement[]) => rows.reduce((s, r) => s.plus(d(r.fineWeight)), ZERO);
  const returnedFine = sumFine(returns);
  const scrapFine = sumFine(scraps);
  const consumedFine = sumFine(consumed);
  const resolvedFine = returnedFine.plus(scrapFine).plus(consumedFine);

  if (!resolvedFine.greaterThan(0)) return;
  if (!job.pendingFine.greaterThan(0)) {
    throw new ReplayError(`Receipt ${receipt.code} resolves metal this job never issued.`);
  }

  // The final receipt takes the whole remaining pool so it lands exactly on
  // zero; a partial receipt takes its fine-weight share.
  const resolvedValue = receipt.isFinalMetal
    ? job.wipValue
    : round2(job.wipValue.times(resolvedFine).dividedBy(job.pendingFine));
  const oldResolvedValue = receipt.isFinalMetal
    ? job.oldWipValue
    : round2(job.oldWipValue.times(resolvedFine).dividedBy(job.pendingFine));

  const shareOf = (fine: Decimal, total: Decimal, value: Decimal) =>
    total.greaterThan(0) ? round2(value.times(fine).dividedBy(total)) : ZERO;

  const returnedValue = shareOf(returnedFine, resolvedFine, resolvedValue);
  const scrapValue = shareOf(scrapFine, resolvedFine, resolvedValue);
  const finishedValue = round2(resolvedValue.minus(returnedValue).minus(scrapValue));
  // The "old" side of every row comes from the movement's own recorded value,
  // never from re-deriving it, so a historical rounding is reproduced exactly.

  // Returned metal re-enters the usable pool at the job's restated rate.
  if (returns.length > 0) {
    const shares = splitByFine(returnedValue, returns);
    for (const r of returns) {
      const value = shares.get(r.id) ?? ZERO;
      pool.gross = pool.gross.plus(d(r.grossWeight));
      pool.value = round2(pool.value.plus(value));
      oldPool.gross = oldPool.gross.plus(d(r.grossWeight));
      oldPool.value = round2(oldPool.value.plus(d(r.costValue)));
      record(r.id, r.costValue, value);
    }
  }
  if (scraps.length > 0) {
    const shares = splitByFine(scrapValue, scraps);
    for (const s of scraps) {
      const value = shares.get(s.id) ?? ZERO;
      scrap.gross = scrap.gross.plus(d(s.grossWeight));
      scrap.value = round2(scrap.value.plus(value));
      oldScrap.gross = oldScrap.gross.plus(d(s.grossWeight));
      oldScrap.value = round2(oldScrap.value.plus(d(s.costValue)));
      record(s.id, s.costValue, value);
    }
  }

  // The outputs handed in must account for exactly the fine weight this
  // purity's CONSUMED_OUT rows report. If they do not, the receipt mixed
  // source purities (or an output is missing) and guessing an allocation
  // would silently misprice a piece — refuse instead.
  if (receipt.outputs.length > 0) {
    const outputFine = receipt.outputs.reduce((s, o) => s.plus(d(o.fineMetalWeight)), ZERO);
    if (!outputFine.equals(consumedFine)) {
      throw new ReplayError(
        `Receipt ${receipt.code} consumed ${consumedFine.toFixed(3)}g fine of this purity but its finished pieces account for ${outputFine.toFixed(3)}g — cannot revalue it automatically.`
      );
    }
  }

  // The finished portion is split across the receipt's outputs by fine weight
  // — the same allocation the receipt itself performed.
  if (receipt.outputs.length > 0 && finishedValue.greaterThan(0)) {
    const allocation = allocateProportionally(
      finishedValue,
      receipt.outputs.map((o) => ({ key: o.id, weight: d(o.fineMetalWeight) }))
    );
    for (const o of receipt.outputs) {
      const newValue = allocation.find((a) => a.key === o.id)?.amount ?? ZERO;
      const oldValue = d(o.metalCost);
      finished.set(o.id, {
        label: o.label,
        fineWeight: d(o.fineMetalWeight),
        oldValue,
        newValue,
        delta: round2(newValue.minus(oldValue)),
      });
    }
  }
  if (consumed.length > 0) {
    const shares = splitByFine(finishedValue, consumed);
    for (const c of consumed) record(c.id, c.costValue, shares.get(c.id) ?? ZERO);
  }

  job.pendingFine = job.pendingFine.minus(resolvedFine);
  job.wipValue = round2(job.wipValue.minus(resolvedValue));
  job.oldWipValue = round2(job.oldWipValue.minus(oldResolvedValue));
  if (receipt.isFinalMetal) {
    job.pendingFine = ZERO;
    job.wipValue = ZERO;
    job.oldWipValue = ZERO;
  }
}

function splitByFine(total: Decimal, rows: ReplayMovement[]): Map<string, Decimal> {
  if (rows.length === 1) return new Map([[rows[0].id, total]]);
  if (!total.greaterThan(0)) return new Map(rows.map((r) => [r.id, ZERO]));
  const allocation = allocateProportionally(
    total,
    rows.map((r) => ({ key: r.id, weight: d(r.fineWeight) }))
  );
  return new Map(allocation.map((a) => [a.key, a.amount]));
}
