/**
 * Metal rate arithmetic shared by the Metal Purchase and Opening Metal Stock
 * forms (browser) and their server-side consistency checks.
 *
 * Exact fixed-point integers (BigInt), never floating point, with the same
 * round-half-up rule the server's Decimal posting uses — so the total the
 * user confirms on screen is, to the paisa, the total the server recomputes.
 * Pure and dependency-free so it is safe to import from client components.
 */

export type MetalRateBasisValue = "PER_GROSS_GRAM" | "PER_FINE_GRAM" | "FIXED_TOTAL";

export const RATE_BASIS_LABEL: Record<MetalRateBasisValue, string> = {
  PER_GROSS_GRAM: "Per gross gram",
  PER_FINE_GRAM: "Per fine gram",
  FIXED_TOTAL: "Fixed total",
};

/** Label of the rate input for each basis — never a bare "Rate". */
export const RATE_INPUT_LABEL: Record<MetalRateBasisValue, string> = {
  PER_GROSS_GRAM: "Rate per GROSS gram (₹)",
  PER_FINE_GRAM: "Rate per FINE gram (₹)",
  FIXED_TOTAL: "Fixed total (₹)",
};

/** Parses a non-negative decimal string into an integer scaled by 10^scale, or null. */
function toScaled(value: string | number, scale: number): bigint | null {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  // Round half-up any digits beyond the scale.
  const kept = frac.slice(0, scale).padEnd(scale, "0");
  let scaled = BigInt(whole + kept);
  if (frac.length > scale && Number(frac[scale]) >= 5) scaled += BigInt(1);
  return scaled;
}

/** Divides a non-negative scaled integer by 10^drop, rounding half-up. */
function dropDigits(value: bigint, drop: number): bigint {
  if (drop <= 0) return value;
  const divisor = BigInt(10) ** BigInt(drop);
  const q = value / divisor;
  const r = value % divisor;
  return r * BigInt(2) >= divisor ? q + BigInt(1) : q;
}

function format(value: bigint, scale: number): string {
  const s = value.toString().padStart(scale + 1, "0");
  return scale === 0 ? s : `${s.slice(0, -scale)}.${s.slice(-scale)}`;
}

/** Fine weight (3 dp, half-up) = gross × fineness% / 100 — the server's exact formula. */
export function fineWeightOf(grossWeight: string | number, finenessPercent: string | number): string | null {
  const g = toScaled(grossWeight, 3);
  const f = toScaled(finenessPercent, 3);
  if (g === null || f === null) return null;
  // g·f carries 6 dp; /100 adds 2 more → 8 dp; keep 3.
  return format(dropDigits(g * f, 5), 3);
}

/** Total (2 dp, half-up) implied by a rate on its basis. */
export function totalFromRate(input: {
  basis: MetalRateBasisValue;
  rate: string | number;
  grossWeight: string | number;
  fineWeight: string | number;
}): string | null {
  if (input.basis === "FIXED_TOTAL") {
    const t = toScaled(input.rate, 2);
    return t === null ? null : format(t, 2);
  }
  const rate = toScaled(input.rate, 4);
  const weight = toScaled(input.basis === "PER_GROSS_GRAM" ? input.grossWeight : input.fineWeight, 3);
  if (rate === null || weight === null) return null;
  // 4 dp × 3 dp = 7 dp; keep 2.
  return format(dropDigits(rate * weight, 5), 2);
}

/** ₹ per gram (4 dp, half-up) implied by a total over a weight; null when the weight is zero. */
export function ratePerGram(total: string | number, weight: string | number): string | null {
  const t = toScaled(total, 2);
  const w = toScaled(weight, 3);
  if (t === null || w === null || w === BigInt(0)) return null;
  // (t/100) / (w/1000) to 4 dp = t·10^5 / w, rounded half-up.
  const numerator = t * BigInt(100000) * BigInt(2);
  const doubled = numerator / w;
  return format((doubled + BigInt(1)) / BigInt(2), 4);
}

export type RateSummary = {
  basis: MetalRateBasisValue;
  basisLabel: string;
  grossWeight: string;
  finenessPercent: string;
  fineWeight: string;
  total: string;
  perGrossGram: string | null;
  perFineGram: string | null;
};

/** Everything a rate preview shows, from the same inputs the server will see. */
export function summariseRate(input: {
  basis: MetalRateBasisValue;
  grossWeight: string | number;
  finenessPercent: string | number;
  total: string | number;
}): RateSummary | null {
  const fine = fineWeightOf(input.grossWeight, input.finenessPercent);
  const gross = toScaled(input.grossWeight, 3);
  const total = toScaled(input.total, 2);
  if (fine === null || gross === null || total === null || gross === BigInt(0) || total === BigInt(0)) return null;
  return {
    basis: input.basis,
    basisLabel: RATE_BASIS_LABEL[input.basis],
    grossWeight: format(gross, 3),
    finenessPercent: format(toScaled(input.finenessPercent, 3) ?? BigInt(0), 3),
    fineWeight: fine,
    total: format(total, 2),
    perGrossGram: ratePerGram(format(total, 2), format(gross, 3)),
    perFineGram: ratePerGram(format(total, 2), fine),
  };
}

/** True when two 2-dp money strings are the same amount. */
export function sameMoney(a: string | number, b: string | number): boolean {
  const x = toScaled(a, 2);
  const y = toScaled(b, 2);
  return x !== null && y !== null && x === y;
}
