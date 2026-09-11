/**
 * Plain-number arithmetic for CLIENT-SIDE PREVIEW ONLY (live totals shown
 * while filling in a form). No Prisma/Decimal import here on purpose —
 * this file gets bundled into the browser, and Prisma's client cannot run
 * there. The server always re-computes the authoritative figures with
 * Decimal (see src/lib/accounting/gst.ts) before anything is saved, so
 * float imprecision here can never affect what actually gets posted.
 */

export type TaxType = "EXCLUSIVE" | "INCLUSIVE";
export type GstTreatment = "NONE" | "CGST_SGST" | "IGST";

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function previewLineTotals(input: {
  quantity: number;
  rate: number;
  discount?: number;
  gstRatePercent: number;
  taxType: TaxType;
}): { taxableValue: number; taxAmount: number; lineTotal: number } {
  const gross = round2(input.quantity * input.rate - (input.discount ?? 0));
  const rateFraction = input.gstRatePercent / 100;

  if (input.taxType === "INCLUSIVE") {
    const lineTotal = gross;
    const taxableValue = round2(lineTotal / (1 + rateFraction));
    const taxAmount = round2(lineTotal - taxableValue);
    return { taxableValue, taxAmount, lineTotal };
  }

  const taxableValue = gross;
  const taxAmount = round2(taxableValue * rateFraction);
  const lineTotal = round2(taxableValue + taxAmount);
  return { taxableValue, taxAmount, lineTotal };
}

/** Suggests CGST+SGST vs IGST from state codes — a suggestion only, shown
 * before saving, never applied silently. Kept dependency-free so both
 * client and server code can import it safely. */
export function suggestGstTreatment(
  companyStateCode: string | null | undefined,
  partyStateCode: string | null | undefined
): GstTreatment | null {
  if (!companyStateCode || !partyStateCode) return null;
  return companyStateCode.trim() === partyStateCode.trim() ? "CGST_SGST" : "IGST";
}
