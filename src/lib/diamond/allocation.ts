import { Decimal, type DecimalInput, ZERO } from "@/lib/accounting/money";

/** Rounds to 3 decimal places using round-half-up — the standard precision
 * for carat weights in this app (finer than money's 2dp). */
export function round3(value: DecimalInput): Decimal {
  return new Decimal(value).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

export type AllocationTarget = {
  /** Caller-supplied key so the result can be matched back to its input
   * row (e.g. a piece id or an output index). */
  key: string;
  weight: DecimalInput;
};

export type AllocationResult = { key: string; amount: Decimal };

/**
 * Splits `total` across `targets` proportionally by `weight` (carat),
 * rounded to 2 decimal places per share, with the rounding remainder
 * assigned entirely to one deterministic target so the shares always sum
 * back to EXACTLY `total` — the same "remainder goes to one item" pattern
 * already used for CGST/SGST splitting (src/lib/accounting/gst.ts).
 *
 * The remainder goes to the LAST target by weight-descending, id-ascending
 * order (deterministic regardless of input order), matching this
 * codebase's existing convention of making rounding adjustments land on a
 * single, predictable, always-computable row rather than "whichever paid
 * last" or similar non-reproducible rules.
 */
export function allocateProportionally(
  total: DecimalInput,
  targets: AllocationTarget[]
): AllocationResult[] {
  const totalAmount = new Decimal(total);
  if (targets.length === 0) {
    if (!totalAmount.isZero()) {
      throw new Error("Cannot allocate a non-zero total across zero targets.");
    }
    return [];
  }

  const totalWeight = targets.reduce(
    (sum, t) => sum.plus(new Decimal(t.weight)),
    ZERO
  );
  if (!totalWeight.greaterThan(0)) {
    throw new Error("Cannot allocate proportionally when total weight is zero.");
  }

  const ordered = [...targets].sort((a, b) => {
    const weightCompare = new Decimal(b.weight).minus(new Decimal(a.weight)).toNumber();
    if (weightCompare !== 0) return weightCompare;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  const remainderKey = ordered[ordered.length - 1].key;

  let runningSum = ZERO;
  const provisional = new Map<string, Decimal>();
  for (const target of ordered) {
    const weight = new Decimal(target.weight);
    const share = totalAmount.times(weight).dividedBy(totalWeight).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    provisional.set(target.key, share);
    runningSum = runningSum.plus(share);
  }

  const remainder = totalAmount.minus(runningSum);
  provisional.set(remainderKey, (provisional.get(remainderKey) ?? ZERO).plus(remainder));

  return targets.map((t) => ({ key: t.key, amount: provisional.get(t.key)! }));
}
