import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import { round3 } from "@/lib/diamond/allocation";
import { splitGstAmount, type GstTreatment } from "@/lib/accounting/gst";

/**
 * Phase 5 costing calculations — pure, synchronous, Decimal-safe. Nothing
 * here touches the database or accounting ledger; every function is a
 * plain function of its own inputs, which is exactly what makes a
 * FINALIZED CostSheet's displayed numbers immutable: once its line
 * amounts and pricing inputs are frozen (see src/lib/costing/engine.ts),
 * re-running these functions on those same frozen inputs can only ever
 * produce the same result, forever — there is no separate cached total
 * that could ever drift out of sync with them.
 */

export type MetalRateBasis = "PER_GROSS_GRAM" | "PER_FINE_GRAM" | "FIXED_TOTAL";
export type ChargeMethod = "FLAT" | "PER_GRAM" | "PER_CARAT" | "PER_PIECE" | "PERCENT_OF_MATERIAL_COST";
export type PricingMethod = "MARKUP_ON_COST" | "MARGIN_ON_PRICE";
export type DiscountType = "NONE" | "PERCENT" | "FIXED";
export type TaxType = "EXCLUSIVE" | "INCLUSIVE";

export class CalculationError extends Error {}

// ---------------------------------------------------------------------------
// Line-level amounts (ESTIMATE mode — ACTUAL mode copies its amounts
// straight from the Phase 4 source instead of computing them; see
// src/lib/costing/sourcing.ts)
// ---------------------------------------------------------------------------

/**
 * A metal line's wastage is a plain, clearly-labelled ESTIMATE ALLOWANCE
 * (extra gross weight the Owner expects to lose in manufacturing) — never
 * to be confused with Phase 4's real, already-resolved
 * processLossFineWeight. wastagePercent (of gross weight) and
 * wastageWeight are alternatives: if a positive wastagePercent is given it
 * wins and wastageWeight is derived from it; otherwise the explicit
 * wastageWeight (default 0) is used as-is.
 */
export function computeMetalLineAmount(input: {
  grossWeight: DecimalInput;
  finenessPercent: DecimalInput;
  wastagePercent?: DecimalInput;
  wastageWeight?: DecimalInput;
  rateBasis: MetalRateBasis;
  rate: DecimalInput;
}): { fineWeight: Decimal; wastageWeight: Decimal; billedGrossWeight: Decimal; amount: Decimal } {
  const grossWeight = round3(input.grossWeight);
  const fineness = new Decimal(input.finenessPercent);
  const fineWeight = round3(grossWeight.times(fineness).dividedBy(100));

  const wastagePercent = new Decimal(input.wastagePercent ?? 0);
  const wastageWeight = wastagePercent.greaterThan(0)
    ? round3(grossWeight.times(wastagePercent).dividedBy(100))
    : round3(input.wastageWeight ?? 0);

  const billedGrossWeight = round3(grossWeight.plus(wastageWeight));

  let amount: Decimal;
  if (input.rateBasis === "FIXED_TOTAL") {
    amount = round2(input.rate);
  } else if (input.rateBasis === "PER_FINE_GRAM") {
    const billedFineWeight = round3(billedGrossWeight.times(fineness).dividedBy(100));
    amount = round2(billedFineWeight.times(input.rate));
  } else {
    amount = round2(billedGrossWeight.times(input.rate));
  }

  return { fineWeight, wastageWeight, billedGrossWeight, amount };
}

/** If `fixedAmount` is given (non-null), it wins over rate x carat — the two
 * are alternative ways to price the same line, never added together. */
export function computeDiamondLineAmount(input: {
  totalCarat: DecimalInput;
  ratePerCarat?: DecimalInput | null;
  fixedAmount?: DecimalInput | null;
  certificateCharge?: DecimalInput;
}): Decimal {
  const certificateCharge = round2(input.certificateCharge ?? 0);
  if (input.fixedAmount != null) {
    return round2(new Decimal(input.fixedAmount).plus(certificateCharge));
  }
  const totalCarat = round3(input.totalCarat);
  const ratePerCarat = new Decimal(input.ratePerCarat ?? 0);
  return round2(totalCarat.times(ratePerCarat).plus(certificateCharge));
}

/** If both a rate and a quantity/weight basis are given, amount = basis x
 * rate; otherwise the manually-typed amount is used directly — covers both
 * "2 pcs findings @ Rs 50" and "packaging, flat Rs 150" in one function. */
export function computeOtherMaterialLineAmount(input: {
  quantity?: DecimalInput | null;
  weight?: DecimalInput | null;
  rate?: DecimalInput | null;
  manualAmount?: DecimalInput | null;
}): Decimal {
  const basis = input.quantity ?? input.weight ?? null;
  if (basis != null && input.rate != null) {
    return round2(new Decimal(basis).times(input.rate));
  }
  return round2(input.manualAmount ?? 0);
}

/**
 * PERCENT_OF_MATERIAL_COST is deliberately based on `materialCostSubtotal`
 * (metal + diamond + other-material cost) ONLY, never on other charge
 * lines — so any number of percentage-based charge lines on the same
 * sheet compute independently and simultaneously, with no order-
 * dependency or circularity between them.
 */
export function computeChargeLineAmount(input: {
  method: ChargeMethod;
  rate: DecimalInput;
  totalMetalBilledGrossWeight: DecimalInput;
  totalDiamondCarat: DecimalInput;
  sheetQuantity: number;
  materialCostSubtotal: DecimalInput;
}): Decimal {
  const rate = new Decimal(input.rate);
  switch (input.method) {
    case "FLAT":
      return round2(rate);
    case "PER_GRAM":
      return round2(rate.times(input.totalMetalBilledGrossWeight));
    case "PER_CARAT":
      return round2(rate.times(input.totalDiamondCarat));
    case "PER_PIECE":
      return round2(rate.times(input.sheetQuantity));
    case "PERCENT_OF_MATERIAL_COST":
      return round2(new Decimal(input.materialCostSubtotal).times(rate).dividedBy(100));
  }
}

// ---------------------------------------------------------------------------
// Full calculation summary — the exact order documented in
// PHASE_5_VERIFICATION.md, reproduced here so the code and the docs can
// never silently drift apart.
//
//  1. Metal cost                    (sum of metal line amounts)
//  2. Diamond cost                  (sum of diamond line amounts)
//  3. Other-material cost           (sum of other-material line amounts)
//  4. Labour cost                   (sum of charge lines with isLabour=true)
//  5. Additional manufacturing charges (sum of charge lines with isLabour=false)
//  6. Total production cost         (1+2+3+4+5)
//  7. Suggested selling value before discount
//       markup:  productionCost x (1 + markup% / 100)
//       margin:  productionCost / (1 - targetMargin% / 100)   [target% < 100]
//       (a manual override, if set, REPLACES this computed value)
//  8. Discount        (percent of 7, or a fixed amount)
//  9. Taxable selling value          (7 - 8)
// 10. GST               — EXCLUSIVE: 9 x rate%
//                       — INCLUSIVE: 9 is treated as the tax-INCLUSIVE
//                         value; taxable value and GST are backed out of
//                         it instead (see below)
// 11. Customer total                (9 + 10, always — see note below for
//                                     how 9 itself is derived when INCLUSIVE)
// 12. Estimated selling expenses     fixed + (percent x customer total) —
//                                     computed on the GST-inclusive total,
//                                     matching how a real payment
//                                     gateway/marketplace commission is
//                                     actually charged on the full amount
//                                     collected
// 13. Net realization                customer total - GST - selling
//                                     expenses (GST is a collected-and-
//                                     remitted tax, never real revenue,
//                                     so it is excluded from both net
//                                     realization and profit)
// 14. Estimated profit               net realization - production cost
// 15. Profit margin                  profit / taxable selling value x 100
//
// Rounding: every money amount is rounded to paise (2dp, round-half-up)
// as it is produced. An optional final ROUNDING STEP (e.g. to the nearest
// Rs 10) may be applied to the customer total; the difference this
// creates is its own explicit `roundingAdjustment` line, and if it is
// applied, `13`-`15` above use the ROUNDED customer total, not the
// unrounded one, so no side of the summary is left silently exact while
// another is fudged by the rounding.
// ---------------------------------------------------------------------------

export type CostSheetTotals = {
  metalCost: Decimal;
  diamondCost: Decimal;
  otherMaterialCost: Decimal;
  labourCost: Decimal;
  additionalChargesCost: Decimal;
  productionCost: Decimal;
  sellingValueBeforeDiscount: Decimal;
  discountAmount: Decimal;
  taxableSellingValue: Decimal;
  gstAmount: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  customerTotalBeforeRounding: Decimal;
  roundingAdjustment: Decimal;
  customerTotal: Decimal;
  sellingExpenseAmount: Decimal;
  netRealization: Decimal;
  estimatedProfit: Decimal;
  profitMarginPercent: Decimal;
  isManualOverrideApplied: boolean;
};

export function computeCostSheetTotals(input: {
  metalLineAmounts: DecimalInput[];
  diamondLineAmounts: DecimalInput[];
  otherMaterialLineAmounts: DecimalInput[];
  labourLineAmounts: DecimalInput[];
  additionalChargeLineAmounts: DecimalInput[];

  pricingMethod: PricingMethod;
  markupPercent: DecimalInput;
  targetMarginPercent: DecimalInput;
  manualSellingPriceOverride?: DecimalInput | null;

  discountType: DiscountType;
  discountValue: DecimalInput;

  gstTreatment: GstTreatment;
  gstRatePercent: DecimalInput;
  priceType: TaxType;

  roundingStep?: DecimalInput;

  sellingExpenseFixed?: DecimalInput;
  sellingExpensePercent?: DecimalInput;
}): CostSheetTotals {
  const sum = (values: DecimalInput[]) => round2(values.reduce((acc: Decimal, v) => acc.plus(v), ZERO));

  const metalCost = sum(input.metalLineAmounts);
  const diamondCost = sum(input.diamondLineAmounts);
  const otherMaterialCost = sum(input.otherMaterialLineAmounts);
  const labourCost = sum(input.labourLineAmounts);
  const additionalChargesCost = sum(input.additionalChargeLineAmounts);
  const productionCost = round2(
    metalCost.plus(diamondCost).plus(otherMaterialCost).plus(labourCost).plus(additionalChargesCost)
  );

  // ---- Step 7: suggested selling value before discount ----
  const targetMarginPercent = new Decimal(input.targetMarginPercent);
  if (input.pricingMethod === "MARGIN_ON_PRICE" && targetMarginPercent.greaterThanOrEqualTo(100)) {
    throw new CalculationError("Target margin must be less than 100%.");
  }
  let sellingValueBeforeDiscount: Decimal;
  const isManualOverrideApplied = input.manualSellingPriceOverride != null;
  if (isManualOverrideApplied) {
    sellingValueBeforeDiscount = round2(input.manualSellingPriceOverride!);
  } else if (input.pricingMethod === "MARKUP_ON_COST") {
    const markupPercent = new Decimal(input.markupPercent);
    sellingValueBeforeDiscount = round2(productionCost.times(markupPercent.dividedBy(100).plus(1)));
  } else {
    sellingValueBeforeDiscount = round2(
      productionCost.dividedBy(new Decimal(1).minus(targetMarginPercent.dividedBy(100)))
    );
  }

  // ---- Step 8: discount ----
  let discountAmount: Decimal;
  if (input.discountType === "PERCENT") {
    discountAmount = round2(sellingValueBeforeDiscount.times(input.discountValue).dividedBy(100));
  } else if (input.discountType === "FIXED") {
    discountAmount = round2(input.discountValue);
  } else {
    discountAmount = ZERO;
  }
  if (discountAmount.greaterThan(sellingValueBeforeDiscount)) {
    discountAmount = sellingValueBeforeDiscount;
  }

  const sellingValueAfterDiscount = round2(sellingValueBeforeDiscount.minus(discountAmount));

  // ---- Steps 9-11: taxable value, GST, customer total ----
  const gstRatePercent = new Decimal(input.gstRatePercent);
  let taxableSellingValue: Decimal;
  let gstAmount: Decimal;
  let customerTotalBeforeRounding: Decimal;
  if (input.gstTreatment === "NONE") {
    taxableSellingValue = sellingValueAfterDiscount;
    gstAmount = ZERO;
    customerTotalBeforeRounding = sellingValueAfterDiscount;
  } else if (input.priceType === "INCLUSIVE") {
    customerTotalBeforeRounding = sellingValueAfterDiscount;
    taxableSellingValue = round2(customerTotalBeforeRounding.dividedBy(gstRatePercent.dividedBy(100).plus(1)));
    gstAmount = round2(customerTotalBeforeRounding.minus(taxableSellingValue));
  } else {
    taxableSellingValue = sellingValueAfterDiscount;
    gstAmount = round2(taxableSellingValue.times(gstRatePercent).dividedBy(100));
    customerTotalBeforeRounding = round2(taxableSellingValue.plus(gstAmount));
  }
  const { cgst, sgst, igst } = splitGstAmount(gstAmount, input.gstTreatment);

  // ---- Optional rounding of the customer total ----
  const roundingStep = new Decimal(input.roundingStep ?? 0);
  let customerTotal = customerTotalBeforeRounding;
  let roundingAdjustment = ZERO;
  if (roundingStep.greaterThan(0)) {
    const steps = customerTotalBeforeRounding.dividedBy(roundingStep).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
    customerTotal = round2(steps.times(roundingStep));
    roundingAdjustment = round2(customerTotal.minus(customerTotalBeforeRounding));
  }

  // ---- Steps 12-15: selling expenses, net realization, profit, margin ----
  const sellingExpenseFixed = round2(input.sellingExpenseFixed ?? 0);
  const sellingExpensePercent = new Decimal(input.sellingExpensePercent ?? 0);
  const sellingExpenseAmount = round2(
    sellingExpenseFixed.plus(customerTotal.times(sellingExpensePercent).dividedBy(100))
  );

  // GST is a collected-and-remitted liability, never real business
  // revenue — always excluded from both net realization and profit,
  // regardless of gstTreatment or priceType. Any rounding adjustment is
  // real money the business actually collects/forgoes at the rounded
  // customer total, so it is deliberately NOT backed out here — it flows
  // straight into net realization and profit, exactly like a small extra
  // (or reduced) sale price would.
  const netRealization = round2(customerTotal.minus(gstAmount).minus(sellingExpenseAmount));
  const estimatedProfit = round2(netRealization.minus(productionCost));
  const profitMarginPercent = taxableSellingValue.greaterThan(0)
    ? estimatedProfit.dividedBy(taxableSellingValue).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : ZERO;

  return {
    metalCost,
    diamondCost,
    otherMaterialCost,
    labourCost,
    additionalChargesCost,
    productionCost,
    sellingValueBeforeDiscount,
    discountAmount,
    taxableSellingValue,
    gstAmount,
    cgst,
    sgst,
    igst,
    customerTotalBeforeRounding,
    roundingAdjustment,
    customerTotal,
    sellingExpenseAmount,
    netRealization,
    estimatedProfit,
    profitMarginPercent,
    isManualOverrideApplied,
  };
}
