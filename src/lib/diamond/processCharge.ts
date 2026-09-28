/**
 * Manufacturer process charge — pure and client-safe, so the receive forms
 * preview exactly what the server posts.
 *
 *   FIXED             the agreed amount, charged once, on the receipt that closes the job
 *   PER_CARAT         rate × carat returned or used on this receipt
 *   PER_PIECE         rate × pieces returned or used on this receipt
 *   PER_ISSUED_CARAT  rate × ISSUED carat this receipt uses up — what came back
 *                     plus, on the closing receipt, the normal weight loss. So a
 *                     job's total is rate × (issued − rough returned unused −
 *                     damaged/lost), e.g. Polishing 10.190 ct issued -> 5.091 ct
 *                     polished charges 10.190 ct.
 *
 * Damaged/lost stones and rough returned unused are never charged for; under
 * the three older bases, weight loss is not charged for either.
 */
export type ChargeRateBasis = "FIXED" | "PER_CARAT" | "PER_PIECE" | "PER_ISSUED_CARAT";

function toCents(value: string | number): bigint {
  const text = typeof value === "number" ? value.toString() : value.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error("Charge figures must be non-negative decimals.");
  const [whole, fraction = ""] = text.split(".");
  // Round half-up at the third decimal.
  const scaled = BigInt(whole) * BigInt(1000) + BigInt((fraction + "000").slice(0, 3));
  return (scaled + BigInt(5)) / BigInt(10);
}

function fromCents(cents: bigint): string {
  const whole = cents / BigInt(100);
  const fraction = (cents % BigInt(100)).toString().padStart(2, "0");
  return `${whole.toString()}.${fraction}`;
}

/** rate (4dp) × quantity (3dp), rounded half-up to 2dp, in exact integer math. */
function multiply(rate: string, quantity: string): string {
  const [rw, rf = ""] = rate.trim().split(".");
  const [qw, qf = ""] = quantity.trim().split(".");
  const r = BigInt(rw || "0") * BigInt(10000) + BigInt((rf + "0000").slice(0, 4) || "0");
  const q = BigInt(qw || "0") * BigInt(1000) + BigInt((qf + "000").slice(0, 3) || "0");
  const product = r * q; // scale 10^7
  const cents = (product + BigInt(50000)) / BigInt(100000);
  return fromCents(cents);
}

export function computeProcessCharge(input: {
  basis: ChargeRateBasis;
  rate: string;
  carat: string;
  pieces: number;
  isFinal: boolean;
  /** Issued carat this receipt uses up (returned/used + closing weight loss). Required for PER_ISSUED_CARAT. */
  issuedCarat?: string;
}): string {
  if (!/^\d+(\.\d+)?$/.test(input.rate.trim())) throw new Error("The charge rate must be a non-negative decimal.");
  switch (input.basis) {
    case "FIXED":
      return input.isFinal ? fromCents(toCents(input.rate)) : "0.00";
    case "PER_CARAT":
      return multiply(input.rate, input.carat);
    case "PER_PIECE":
      return multiply(input.rate, String(input.pieces));
    case "PER_ISSUED_CARAT":
      if (input.issuedCarat == null || !/^\d+(\.\d+)?$/.test(input.issuedCarat.trim())) {
        throw new Error("A per-issued-carat charge needs the issued carat this receipt uses up.");
      }
      return multiply(input.rate, input.issuedCarat);
  }
}

/**
 * A posted polished receipt's labour re-priced per ISSUED carat at the job's
 * agreed per-carat rate: rate × (polished + that receipt's weight loss).
 * Null when the job has no per-carat rate to re-price with.
 */
export function perIssuedCaratLabour(input: {
  basis: string | null;
  rate: string | null;
  polishedCarat: string;
  weightLossCarat: string;
}): string | null {
  if (!input.rate || (input.basis !== "PER_CARAT" && input.basis !== "PER_ISSUED_CARAT")) return null;
  const toMilli = (v: string) => {
    const [w, f = ""] = v.trim().split(".");
    return BigInt(w || "0") * BigInt(1000) + BigInt((f + "000").slice(0, 3) || "0");
  };
  const milli = toMilli(input.polishedCarat) + toMilli(input.weightLossCarat);
  const issued = `${milli / BigInt(1000)}.${(milli % BigInt(1000)).toString().padStart(3, "0")}`;
  return computeProcessCharge({ basis: "PER_ISSUED_CARAT", rate: input.rate, carat: input.polishedCarat, pieces: 0, isFinal: true, issuedCarat: issued });
}

export const CHARGE_RATE_BASIS_LABELS: Record<ChargeRateBasis, string> = {
  FIXED: "Fixed amount",
  PER_CARAT: "Per carat",
  PER_PIECE: "Per piece",
  PER_ISSUED_CARAT: "Per issued carat",
};
