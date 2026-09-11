import { Decimal, type DecimalInput, round2 } from "@/lib/accounting/money";

export { suggestGstTreatment } from "@/lib/accounting/previewMath";

export type TaxType = "EXCLUSIVE" | "INCLUSIVE";
export type GstTreatment = "NONE" | "CGST_SGST" | "IGST";

export type InvoiceLineTotals = {
  taxableValue: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
};

/**
 * Computes one invoice line's taxable value / tax amount / total from its
 * raw inputs. GST rate is always a plain configured percentage — never a
 * hardcoded rate — passed in by the caller from the GstRate the user chose.
 */
export function computeInvoiceLineTotals(input: {
  quantity: DecimalInput;
  rate: DecimalInput;
  discount?: DecimalInput;
  gstRatePercent: DecimalInput;
  taxType: TaxType;
}): InvoiceLineTotals {
  const quantity = new Decimal(input.quantity);
  const rate = new Decimal(input.rate);
  const discount = new Decimal(input.discount ?? 0);
  const gstRatePercent = new Decimal(input.gstRatePercent);

  const gross = round2(quantity.times(rate).minus(discount));
  const rateFraction = gstRatePercent.dividedBy(100);

  if (input.taxType === "INCLUSIVE") {
    const lineTotal = gross;
    const taxableValue = round2(lineTotal.dividedBy(rateFraction.plus(1)));
    const taxAmount = round2(lineTotal.minus(taxableValue));
    return { taxableValue, taxAmount, lineTotal };
  }

  const taxableValue = gross;
  const taxAmount = round2(taxableValue.times(rateFraction));
  const lineTotal = round2(taxableValue.plus(taxAmount));
  return { taxableValue, taxAmount, lineTotal };
}

export type GstSplit = {
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
};

/** Splits a line's total tax amount according to the voucher's GST treatment. */
export function splitGstAmount(taxAmount: DecimalInput, treatment: GstTreatment): GstSplit {
  const amount = new Decimal(taxAmount);
  if (treatment === "CGST_SGST") {
    const half = round2(amount.dividedBy(2));
    // Any 1-paise rounding remainder goes to SGST so cgst+sgst always
    // reconciles exactly to the original tax amount.
    const sgst = round2(amount.minus(half));
    return { cgst: half, sgst, igst: new Decimal(0) };
  }
  if (treatment === "IGST") {
    return { cgst: new Decimal(0), sgst: new Decimal(0), igst: amount };
  }
  return { cgst: new Decimal(0), sgst: new Decimal(0), igst: new Decimal(0) };
}
