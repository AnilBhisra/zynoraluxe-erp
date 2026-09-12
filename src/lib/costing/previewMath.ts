/**
 * Plain-number arithmetic for CLIENT-SIDE PREVIEW ONLY (the live
 * calculation summary shown while filling in a costing form). No Prisma/
 * Decimal import here on purpose — this file gets bundled into the
 * browser. The server always re-computes the authoritative figures with
 * Decimal (see src/lib/costing/calculations.ts) before anything is
 * saved, so float imprecision here can never affect what actually gets
 * stored — matching src/lib/accounting/previewMath.ts's own convention.
 * Keep this in exact step-by-step sync with computeCostSheetTotals.
 */

export type PricingMethod = "MARKUP_ON_COST" | "MARGIN_ON_PRICE";
export type DiscountType = "NONE" | "PERCENT" | "FIXED";
export type GstTreatment = "NONE" | "CGST_SGST" | "IGST";
export type TaxType = "EXCLUSIVE" | "INCLUSIVE";

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export type PreviewTotals = {
  productionCost: number;
  sellingValueBeforeDiscount: number;
  discountAmount: number;
  taxableSellingValue: number;
  gstAmount: number;
  customerTotalBeforeRounding: number;
  roundingAdjustment: number;
  customerTotal: number;
  sellingExpenseAmount: number;
  netRealization: number;
  estimatedProfit: number;
  profitMarginPercent: number;
};

export function previewCostSheetTotals(input: {
  metalCost: number;
  diamondCost: number;
  otherMaterialCost: number;
  labourCost: number;
  additionalChargesCost: number;
  pricingMethod: PricingMethod;
  markupPercent: number;
  targetMarginPercent: number;
  manualSellingPriceOverride?: number | null;
  discountType: DiscountType;
  discountValue: number;
  gstTreatment: GstTreatment;
  gstRatePercent: number;
  priceType: TaxType;
  roundingStep?: number;
  sellingExpenseFixed?: number;
  sellingExpensePercent?: number;
}): PreviewTotals {
  const productionCost = round2(
    input.metalCost + input.diamondCost + input.otherMaterialCost + input.labourCost + input.additionalChargesCost
  );

  let sellingValueBeforeDiscount: number;
  if (input.manualSellingPriceOverride != null) {
    sellingValueBeforeDiscount = round2(input.manualSellingPriceOverride);
  } else if (input.pricingMethod === "MARKUP_ON_COST") {
    sellingValueBeforeDiscount = round2(productionCost * (1 + input.markupPercent / 100));
  } else {
    const denom = 1 - Math.min(input.targetMarginPercent, 99.999) / 100;
    sellingValueBeforeDiscount = round2(productionCost / denom);
  }

  let discountAmount = 0;
  if (input.discountType === "PERCENT") {
    discountAmount = round2((sellingValueBeforeDiscount * input.discountValue) / 100);
  } else if (input.discountType === "FIXED") {
    discountAmount = round2(input.discountValue);
  }
  if (discountAmount > sellingValueBeforeDiscount) discountAmount = sellingValueBeforeDiscount;

  const sellingValueAfterDiscount = round2(sellingValueBeforeDiscount - discountAmount);

  let taxableSellingValue: number;
  let gstAmount: number;
  let customerTotalBeforeRounding: number;
  if (input.gstTreatment === "NONE") {
    taxableSellingValue = sellingValueAfterDiscount;
    gstAmount = 0;
    customerTotalBeforeRounding = sellingValueAfterDiscount;
  } else if (input.priceType === "INCLUSIVE") {
    customerTotalBeforeRounding = sellingValueAfterDiscount;
    taxableSellingValue = round2(customerTotalBeforeRounding / (1 + input.gstRatePercent / 100));
    gstAmount = round2(customerTotalBeforeRounding - taxableSellingValue);
  } else {
    taxableSellingValue = sellingValueAfterDiscount;
    gstAmount = round2((taxableSellingValue * input.gstRatePercent) / 100);
    customerTotalBeforeRounding = round2(taxableSellingValue + gstAmount);
  }

  const roundingStep = input.roundingStep ?? 0;
  let customerTotal = customerTotalBeforeRounding;
  let roundingAdjustment = 0;
  if (roundingStep > 0) {
    customerTotal = round2(Math.round(customerTotalBeforeRounding / roundingStep) * roundingStep);
    roundingAdjustment = round2(customerTotal - customerTotalBeforeRounding);
  }

  const sellingExpenseAmount = round2(
    (input.sellingExpenseFixed ?? 0) + (customerTotal * (input.sellingExpensePercent ?? 0)) / 100
  );

  const netRealization = round2(customerTotal - gstAmount - sellingExpenseAmount);
  const estimatedProfit = round2(netRealization - productionCost);
  const profitMarginPercent = taxableSellingValue > 0 ? round2((estimatedProfit / taxableSellingValue) * 100) : 0;

  return {
    productionCost,
    sellingValueBeforeDiscount,
    discountAmount,
    taxableSellingValue,
    gstAmount,
    customerTotalBeforeRounding,
    roundingAdjustment,
    customerTotal,
    sellingExpenseAmount,
    netRealization,
    estimatedProfit,
    profitMarginPercent,
  };
}
