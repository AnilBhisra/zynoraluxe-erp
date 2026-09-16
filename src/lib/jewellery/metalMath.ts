/**
 * Exact 3-decimal-place metal weight math, shared by the server posting
 * engine (src/lib/jewellery/posting.ts) and the client-side reconciliation
 * preview (src/components/jewellery/ReceiveFinishedForm.tsx), so both always
 * produce the SAME figure. That is what lets the server demand exact
 * equality — e.g. the alloy split must total exactly the computed "Alloy
 * Added" — without any tolerance.
 *
 * Weights are integer thousandths of a gram and fineness is integer
 * thousandths of a percent (BigInt), rounded half-up (away from zero) —
 * the same rule `round3()` applies with Decimal on the server. BigInt()
 * calls rather than `1000n` literals, because the project's TypeScript
 * target predates BigInt literal syntax.
 *
 * Deliberately free of Prisma / server-only imports so a Client Component
 * can use it.
 */

export type MetalStockMovementKind =
  | "PURCHASE_IN"
  | "OPENING_IN"
  | "ISSUE_OUT"
  | "ISSUE_CANCEL_IN"
  | "RETURN_IN"
  | "SCRAP_RETURN_IN"
  | "CONSUMED_OUT"
  | "ADJUSTMENT_IN"
  | "ADJUSTMENT_OUT";

/**
 * How each immutable MetalStockMovement type affects the two stock pools
 * kept per metal + purity (PHASE_7_CURRENT_STATE_AUDIT.md §4.9 / §4.10):
 *
 * - CONSUMED_OUT is an informational job-ledger row. The metal already left
 *   the usable pool at ISSUE_OUT, so it must never be subtracted again.
 * - SCRAP_RETURN_IN lands in a separate scrap pool (valued in 1310 Scrap
 *   Metal Inventory), never back in issuable stock (valued in 1300).
 */
export const METAL_POOL_EFFECT: Record<MetalStockMovementKind, { usable: -1 | 0 | 1; scrap: -1 | 0 | 1 }> = {
  PURCHASE_IN: { usable: 1, scrap: 0 },
  OPENING_IN: { usable: 1, scrap: 0 },
  ISSUE_OUT: { usable: -1, scrap: 0 },
  ISSUE_CANCEL_IN: { usable: 1, scrap: 0 },
  RETURN_IN: { usable: 1, scrap: 0 },
  SCRAP_RETURN_IN: { usable: 0, scrap: 1 },
  CONSUMED_OUT: { usable: 0, scrap: 0 },
  ADJUSTMENT_IN: { usable: 1, scrap: 0 },
  ADJUSTMENT_OUT: { usable: -1, scrap: 0 },
};

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const THOUSAND = BigInt(1000);
const PERCENT_SCALE = BigInt(100_000); // thousandths-of-a-gram × thousandths-of-a-percent ÷ 100

const DECIMAL_PATTERN = /^(-)?(\d*)(?:\.(\d*))?$/;

/** Parses a decimal string/number into integer thousandths, rounding half-up. */
export function toThousandths(value: string | number): bigint {
  const text = typeof value === "number" ? (Number.isFinite(value) ? value.toFixed(6) : "") : value.trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new Error(`Not a decimal number: "${value}"`);
  }
  const negative = match[1] === "-";
  const fraction = (match[3] ?? "").padEnd(4, "0");
  let magnitude = BigInt(match[2] || "0") * THOUSAND + BigInt(fraction.slice(0, 3));
  if (Number(fraction[3]) >= 5) magnitude += ONE;
  return negative ? -magnitude : magnitude;
}

/** Formats integer thousandths as a fixed 3-decimal string, e.g. 9009 -> "9.009". */
export function formatThousandths(value: bigint): string {
  const negative = value < ZERO;
  const magnitude = negative ? -value : value;
  const fraction = (magnitude % THOUSAND).toString().padStart(3, "0");
  return `${negative ? "-" : ""}${magnitude / THOUSAND}.${fraction}`;
}

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new Error("Denominator must be positive.");
  const negative = numerator < ZERO;
  const magnitude = negative ? -numerator : numerator;
  const quotient = (magnitude * TWO + denominator) / (TWO * denominator);
  return negative ? -quotient : quotient;
}

/** Fine weight (g, 3 dp) = gross × fineness% ÷ 100. Inputs and result in thousandths. */
export function fineWeightThousandths(grossThousandths: bigint, finenessThousandths: bigint): bigint {
  return divideHalfUp(grossThousandths * finenessThousandths, PERCENT_SCALE);
}

/** Gross weight (g, 3 dp) of `fineness`-purity metal containing `fine` grams of fine metal. */
export function grossForFineThousandths(fineThousandths: bigint, finenessThousandths: bigint): bigint {
  return divideHalfUp(fineThousandths * PERCENT_SCALE, finenessThousandths);
}

export type OutputMetalInput = {
  netWeight: string | number;
  outputFinenessPercent: string | number;
  sourceFinenessPercent: string | number;
  /** True when the output is recorded in the same purity that was issued. */
  samePurity: boolean;
};

export type OutputMetalResult = {
  /** Fine metal in the finished output (from its own snapshotted fineness). */
  fine: bigint;
  /** Grams of the ISSUED source purity that this fine metal corresponds to. */
  sourceGrossEquivalent: bigint;
  /** Net weight not explained by consumed source metal — e.g. copper added to 24K to make 18K. */
  alloyAdded: bigint;
};

/**
 * Fine metal and alloy content of one finished output (all in thousandths).
 *
 * Same purity: fine from its own fineness, no alloy added (the alloy was
 * already inside the issued metal). Cross purity (e.g. 24K issued, 18K
 * received): the output's fine metal is traced back to the issued source
 * purity's gross weight, and whatever net weight is left over is Alloy
 * Added — 12.000 g of 18K from 24K at 100% = 9.000 g fine + 3.000 g alloy.
 */
export function computeOutputMetal(input: OutputMetalInput): OutputMetalResult {
  const net = toThousandths(input.netWeight);
  const fine = fineWeightThousandths(net, toThousandths(input.outputFinenessPercent));
  if (input.samePurity) {
    return { fine, sourceGrossEquivalent: net, alloyAdded: ZERO };
  }
  const sourceGrossEquivalent = grossForFineThousandths(fine, toThousandths(input.sourceFinenessPercent));
  return { fine, sourceGrossEquivalent, alloyAdded: net - sourceGrossEquivalent };
}
