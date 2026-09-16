/**
 * Manufacturer process charge — pure and client-safe, so the receive forms
 * preview exactly what the server posts.
 *
 *   FIXED      the agreed amount, charged once, on the receipt that closes the job
 *   PER_CARAT  rate × carat returned or used on this receipt
 *   PER_PIECE  rate × pieces returned or used on this receipt
 *
 * Loss and damaged/lost stones are never charged for.
 */
export type ChargeRateBasis = "FIXED" | "PER_CARAT" | "PER_PIECE";

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
}): string {
  if (!/^\d+(\.\d+)?$/.test(input.rate.trim())) throw new Error("The charge rate must be a non-negative decimal.");
  switch (input.basis) {
    case "FIXED":
      return input.isFinal ? fromCents(toCents(input.rate)) : "0.00";
    case "PER_CARAT":
      return multiply(input.rate, input.carat);
    case "PER_PIECE":
      return multiply(input.rate, String(input.pieces));
  }
}

export const CHARGE_RATE_BASIS_LABELS: Record<ChargeRateBasis, string> = {
  FIXED: "Fixed amount",
  PER_CARAT: "Per carat",
  PER_PIECE: "Per piece",
};
