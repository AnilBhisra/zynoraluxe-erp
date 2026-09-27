import { Decimal, round2, ZERO, type DecimalInput } from "@/lib/accounting/money";
import { allocateProportionally } from "@/lib/diamond/allocation";

/**
 * The five Karigar charge categories a jewellery receipt records. Kept
 * separately identifiable end to end: on the receipt, on every correction and
 * on every affected piece's share of a correction.
 */
export const CHARGE_CATEGORIES = [
  { key: "labourCharge", label: "Labour" },
  { key: "makingCharge", label: "Making" },
  { key: "settingCharge", label: "Setting" },
  { key: "platingCharge", label: "Plating" },
  { key: "otherExpense", label: "Other expense" },
] as const;

export type ChargeKey = (typeof CHARGE_CATEGORIES)[number]["key"];
export type ChargeAmounts = Record<ChargeKey, Decimal>;
export type ChargeInput = Partial<Record<ChargeKey, DecimalInput | null | undefined>>;

export class ChargeInputError extends Error {}

export function zeroCharges(): ChargeAmounts {
  return { labourCharge: ZERO, makingCharge: ZERO, settingCharge: ZERO, platingCharge: ZERO, otherExpense: ZERO };
}

export function totalOf(charges: ChargeAmounts): Decimal {
  return round2(CHARGE_CATEGORIES.reduce((sum, c) => sum.plus(charges[c.key]), ZERO));
}

/**
 * Validates and normalises entered charges: each is money to 2 decimals, never
 * negative, and at least one must be above zero (a correction that adds
 * nothing is not a correction).
 */
export function normaliseCharges(input: ChargeInput): ChargeAmounts {
  const out = zeroCharges();
  for (const c of CHARGE_CATEGORIES) {
    const raw = input[c.key];
    if (raw === undefined || raw === null || raw === "") continue;
    let value: Decimal;
    try {
      value = new Decimal(raw);
    } catch {
      throw new ChargeInputError(`${c.label} must be a number.`);
    }
    if (!value.isFinite()) throw new ChargeInputError(`${c.label} must be a number.`);
    if (value.isNegative()) throw new ChargeInputError(`${c.label} cannot be negative.`);
    const rounded = round2(value);
    if (!rounded.equals(value)) throw new ChargeInputError(`${c.label} can have at most 2 decimal places.`);
    out[c.key] = rounded;
  }
  if (!totalOf(out).greaterThan(0)) {
    throw new ChargeInputError("Enter at least one charge above zero.");
  }
  return out;
}

export type PieceForAllocation = { id: string; finishedCode: string; fineMetalWeight: DecimalInput };

export type PieceChargeShare = {
  finishedJewelleryId: string;
  finishedCode: string;
  charges: ChargeAmounts;
  total: Decimal;
};

/**
 * Splits the added charges across the receipt's finished pieces the same way
 * the receipt itself split its charges: proportional to each piece's fine
 * metal weight, half-up to 2 decimals, with the rounding remainder landing on
 * one fixed piece (allocateProportionally's rule) so nothing is created or
 * lost. Each category is allocated on its own, so every category reconciles
 * to the paisa AND every piece's total is the sum of its own categories.
 *
 * Pieces are keyed by their position in receipt order (finished code), the
 * same key the receipt used, so equal-weight ties break the same way.
 */
export function allocateChargesToPieces(charges: ChargeAmounts, pieces: PieceForAllocation[]): PieceChargeShare[] {
  if (pieces.length === 0) {
    throw new ChargeInputError("This receipt produced no finished piece to carry the charges.");
  }
  const ordered = [...pieces].sort((a, b) => (a.finishedCode < b.finishedCode ? -1 : a.finishedCode > b.finishedCode ? 1 : 0));
  const totalWeight = ordered.reduce((sum, p) => sum.plus(new Decimal(p.fineMetalWeight)), ZERO);
  if (!totalWeight.greaterThan(0)) {
    throw new ChargeInputError(
      "These pieces have no fine metal weight to divide the charges by, so the charges cannot be shared between them."
    );
  }
  const targets = ordered.map((p, i) => ({ key: String(i), weight: p.fineMetalWeight }));
  const shares = ordered.map<PieceChargeShare>((p) => ({
    finishedJewelleryId: p.id,
    finishedCode: p.finishedCode,
    charges: zeroCharges(),
    total: ZERO,
  }));
  for (const c of CHARGE_CATEGORIES) {
    if (!charges[c.key].greaterThan(0)) continue;
    const allocation = allocateProportionally(charges[c.key], targets);
    allocation.forEach((a, i) => {
      shares[i].charges[c.key] = round2(a.amount);
    });
  }
  for (const s of shares) s.total = totalOf(s.charges);

  // Belt and braces: the allocation must reconcile exactly, per category and overall.
  for (const c of CHARGE_CATEGORIES) {
    const sum = shares.reduce((acc, s) => acc.plus(s.charges[c.key]), ZERO);
    if (!round2(sum).equals(charges[c.key])) {
      throw new ChargeInputError(`Internal check failed: ${c.label} allocation does not add up.`);
    }
  }
  return shares;
}
