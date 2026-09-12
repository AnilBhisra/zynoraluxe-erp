import { describe, expect, it } from "vitest";

import {
  CalculationError,
  computeChargeLineAmount,
  computeCostSheetTotals,
  computeDiamondLineAmount,
  computeMetalLineAmount,
  computeOtherMaterialLineAmount,
} from "./calculations";

describe("computeMetalLineAmount", () => {
  it("computes fine weight and amount for PER_GROSS_GRAM with no wastage", () => {
    const result = computeMetalLineAmount({
      grossWeight: 10,
      finenessPercent: 91.6,
      rateBasis: "PER_GROSS_GRAM",
      rate: 5000,
    });
    expect(result.fineWeight.toFixed(3)).toBe("9.160");
    expect(result.wastageWeight.toFixed(3)).toBe("0.000");
    expect(result.billedGrossWeight.toFixed(3)).toBe("10.000");
    expect(result.amount.toFixed(2)).toBe("50000.00");
  });

  it("applies a wastage percentage as extra billed gross weight", () => {
    const result = computeMetalLineAmount({
      grossWeight: 10,
      finenessPercent: 91.6,
      wastagePercent: 5,
      rateBasis: "PER_GROSS_GRAM",
      rate: 5000,
    });
    expect(result.wastageWeight.toFixed(3)).toBe("0.500");
    expect(result.billedGrossWeight.toFixed(3)).toBe("10.500");
    expect(result.amount.toFixed(2)).toBe("52500.00");
  });

  it("prices PER_FINE_GRAM against the billed (wastage-inclusive) fine weight", () => {
    const result = computeMetalLineAmount({
      grossWeight: 10,
      finenessPercent: 75,
      wastagePercent: 10,
      rateBasis: "PER_FINE_GRAM",
      rate: 6000,
    });
    // billed gross = 11.000, billed fine = 8.250
    expect(result.billedGrossWeight.toFixed(3)).toBe("11.000");
    expect(result.amount.toFixed(2)).toBe("49500.00");
  });

  it("FIXED_TOTAL ignores weight entirely", () => {
    const result = computeMetalLineAmount({
      grossWeight: 10,
      finenessPercent: 91.6,
      rateBasis: "FIXED_TOTAL",
      rate: 12345.67,
    });
    expect(result.amount.toFixed(2)).toBe("12345.67");
  });

  it("zero gross weight is a safe edge case, not a crash", () => {
    const result = computeMetalLineAmount({
      grossWeight: 0,
      finenessPercent: 91.6,
      rateBasis: "PER_GROSS_GRAM",
      rate: 5000,
    });
    expect(result.fineWeight.toFixed(3)).toBe("0.000");
    expect(result.amount.toFixed(2)).toBe("0.00");
  });

  it("an explicit wastageWeight is used when no wastagePercent is given", () => {
    const result = computeMetalLineAmount({
      grossWeight: 10,
      finenessPercent: 91.6,
      wastageWeight: 0.25,
      rateBasis: "PER_GROSS_GRAM",
      rate: 5000,
    });
    expect(result.billedGrossWeight.toFixed(3)).toBe("10.250");
  });
});

describe("computeDiamondLineAmount", () => {
  it("computes rate x carat plus certificate charge", () => {
    const amount = computeDiamondLineAmount({ totalCarat: 1.5, ratePerCarat: 40000, certificateCharge: 500 });
    expect(amount.toFixed(2)).toBe("60500.00");
  });

  it("a fixed amount wins over rate x carat when both are given", () => {
    const amount = computeDiamondLineAmount({
      totalCarat: 1.5,
      ratePerCarat: 40000,
      fixedAmount: 55000,
      certificateCharge: 500,
    });
    expect(amount.toFixed(2)).toBe("55500.00");
  });

  it("zero carat with no rate is a safe zero, not a crash", () => {
    const amount = computeDiamondLineAmount({ totalCarat: 0 });
    expect(amount.toFixed(2)).toBe("0.00");
  });
});

describe("computeOtherMaterialLineAmount", () => {
  it("computes quantity x rate", () => {
    const amount = computeOtherMaterialLineAmount({ quantity: 2, rate: 50 });
    expect(amount.toFixed(2)).toBe("100.00");
  });

  it("computes weight x rate when quantity is absent", () => {
    const amount = computeOtherMaterialLineAmount({ weight: 1.5, rate: 200 });
    expect(amount.toFixed(2)).toBe("300.00");
  });

  it("falls back to the manually-typed amount when no rate is given", () => {
    const amount = computeOtherMaterialLineAmount({ manualAmount: 150 });
    expect(amount.toFixed(2)).toBe("150.00");
  });
});

describe("computeChargeLineAmount", () => {
  const base = {
    totalMetalBilledGrossWeight: 10,
    totalDiamondCarat: 2,
    sheetQuantity: 3,
    materialCostSubtotal: 100000,
  };

  it("FLAT ignores every basis", () => {
    expect(computeChargeLineAmount({ ...base, method: "FLAT", rate: 500 }).toFixed(2)).toBe("500.00");
  });

  it("PER_GRAM multiplies by total metal billed gross weight", () => {
    expect(computeChargeLineAmount({ ...base, method: "PER_GRAM", rate: 50 }).toFixed(2)).toBe("500.00");
  });

  it("PER_CARAT multiplies by total diamond carat", () => {
    expect(computeChargeLineAmount({ ...base, method: "PER_CARAT", rate: 1000 }).toFixed(2)).toBe("2000.00");
  });

  it("PER_PIECE multiplies by the sheet's own quantity", () => {
    expect(computeChargeLineAmount({ ...base, method: "PER_PIECE", rate: 200 }).toFixed(2)).toBe("600.00");
  });

  it("PERCENT_OF_MATERIAL_COST is based on materialCostSubtotal only", () => {
    expect(computeChargeLineAmount({ ...base, method: "PERCENT_OF_MATERIAL_COST", rate: 10 }).toFixed(2)).toBe(
      "10000.00"
    );
  });
});

describe("computeCostSheetTotals", () => {
  const gstNoneBase = {
    metalLineAmounts: [50000],
    diamondLineAmounts: [10000],
    otherMaterialLineAmounts: [500],
    labourLineAmounts: [2000],
    additionalChargeLineAmounts: [1000],
    pricingMethod: "MARKUP_ON_COST" as const,
    markupPercent: 20,
    targetMarginPercent: 0,
    discountType: "NONE" as const,
    discountValue: 0,
    gstTreatment: "NONE" as const,
    gstRatePercent: 0,
    priceType: "EXCLUSIVE" as const,
  };

  it("sums every line group into production cost", () => {
    const totals = computeCostSheetTotals(gstNoneBase);
    expect(totals.metalCost.toFixed(2)).toBe("50000.00");
    expect(totals.diamondCost.toFixed(2)).toBe("10000.00");
    expect(totals.otherMaterialCost.toFixed(2)).toBe("500.00");
    expect(totals.labourCost.toFixed(2)).toBe("2000.00");
    expect(totals.additionalChargesCost.toFixed(2)).toBe("1000.00");
    expect(totals.productionCost.toFixed(2)).toBe("63500.00");
  });

  it("markup on cost: selling value = cost x (1 + markup/100)", () => {
    const totals = computeCostSheetTotals(gstNoneBase);
    // production cost 63500 x 1.20 = 76200.00
    expect(totals.sellingValueBeforeDiscount.toFixed(2)).toBe("76200.00");
  });

  it("margin on price: selling value = cost / (1 - margin/100)", () => {
    const totals = computeCostSheetTotals({
      ...gstNoneBase,
      pricingMethod: "MARGIN_ON_PRICE",
      targetMarginPercent: 20,
    });
    // 63500 / 0.80 = 79375.00
    expect(totals.sellingValueBeforeDiscount.toFixed(2)).toBe("79375.00");
    // Margin actually achieved (no discount/GST/expenses here) = (79375-63500)/79375*100 = 20.00
    expect(totals.profitMarginPercent.toFixed(2)).toBe("20.00");
  });

  it("markup and margin on the same cost/price produce genuinely different selling values", () => {
    const markup = computeCostSheetTotals({ ...gstNoneBase, pricingMethod: "MARKUP_ON_COST", markupPercent: 25 });
    const margin = computeCostSheetTotals({
      ...gstNoneBase,
      pricingMethod: "MARGIN_ON_PRICE",
      targetMarginPercent: 25,
    });
    expect(markup.sellingValueBeforeDiscount.toFixed(2)).not.toBe(margin.sellingValueBeforeDiscount.toFixed(2));
    // markup 25% on 63500 = 79375.00; margin 25% -> 63500 / 0.75 = 84666.67
    expect(markup.sellingValueBeforeDiscount.toFixed(2)).toBe("79375.00");
    expect(margin.sellingValueBeforeDiscount.toFixed(2)).toBe("84666.67");
  });

  it("rejects a target margin of exactly 100%", () => {
    expect(() =>
      computeCostSheetTotals({ ...gstNoneBase, pricingMethod: "MARGIN_ON_PRICE", targetMarginPercent: 100 })
    ).toThrow(CalculationError);
  });

  it("rejects a target margin above 100%", () => {
    expect(() =>
      computeCostSheetTotals({ ...gstNoneBase, pricingMethod: "MARGIN_ON_PRICE", targetMarginPercent: 150 })
    ).toThrow(CalculationError);
  });

  it("a manual override replaces the computed selling value entirely", () => {
    const totals = computeCostSheetTotals({ ...gstNoneBase, manualSellingPriceOverride: 100000 });
    expect(totals.sellingValueBeforeDiscount.toFixed(2)).toBe("100000.00");
    expect(totals.isManualOverrideApplied).toBe(true);
  });

  it("percentage discount applies to the selling value before discount", () => {
    const totals = computeCostSheetTotals({ ...gstNoneBase, discountType: "PERCENT", discountValue: 10 });
    // 76200 x 10% = 7620.00 discount -> taxable = 68580.00
    expect(totals.discountAmount.toFixed(2)).toBe("7620.00");
    expect(totals.taxableSellingValue.toFixed(2)).toBe("68580.00");
  });

  it("fixed discount is a plain amount, capped at the selling value", () => {
    const totals = computeCostSheetTotals({ ...gstNoneBase, discountType: "FIXED", discountValue: 5000 });
    expect(totals.discountAmount.toFixed(2)).toBe("5000.00");
    expect(totals.taxableSellingValue.toFixed(2)).toBe("71200.00");
  });

  it("a fixed discount larger than the selling value is capped, never negative", () => {
    const totals = computeCostSheetTotals({ ...gstNoneBase, discountType: "FIXED", discountValue: 999999 });
    expect(totals.discountAmount.toFixed(2)).toBe(totals.sellingValueBeforeDiscount.toFixed(2));
    expect(totals.taxableSellingValue.toFixed(2)).toBe("0.00");
  });

  it("GST NONE leaves the customer total equal to the taxable value", () => {
    const totals = computeCostSheetTotals(gstNoneBase);
    expect(totals.gstAmount.toFixed(2)).toBe("0.00");
    expect(totals.customerTotal.toFixed(2)).toBe(totals.taxableSellingValue.toFixed(2));
  });

  it("CGST+SGST splits the GST amount in half, remainder to SGST", () => {
    const totals = computeCostSheetTotals({
      ...gstNoneBase,
      gstTreatment: "CGST_SGST",
      gstRatePercent: 3,
    });
    // taxable 76200 x 3% = 2286.00 -> half 1143.00 each
    expect(totals.gstAmount.toFixed(2)).toBe("2286.00");
    expect(totals.cgst.toFixed(2)).toBe("1143.00");
    expect(totals.sgst.toFixed(2)).toBe("1143.00");
    expect(totals.igst.toFixed(2)).toBe("0.00");
    expect(totals.customerTotal.toFixed(2)).toBe("78486.00");
    expect(totals.cgst.plus(totals.sgst).toFixed(2)).toBe(totals.gstAmount.toFixed(2));
  });

  it("IGST posts the full amount to igst only", () => {
    const totals = computeCostSheetTotals({ ...gstNoneBase, gstTreatment: "IGST", gstRatePercent: 18 });
    expect(totals.cgst.toFixed(2)).toBe("0.00");
    expect(totals.sgst.toFixed(2)).toBe("0.00");
    expect(totals.igst.toFixed(2)).toBe(totals.gstAmount.toFixed(2));
  });

  it("GST-exclusive: customer total = taxable value + GST", () => {
    const totals = computeCostSheetTotals({
      ...gstNoneBase,
      gstTreatment: "IGST",
      gstRatePercent: 18,
      priceType: "EXCLUSIVE",
    });
    expect(totals.taxableSellingValue.toFixed(2)).toBe("76200.00");
    expect(totals.gstAmount.toFixed(2)).toBe("13716.00");
    expect(totals.customerTotal.toFixed(2)).toBe("89916.00");
  });

  it("GST-inclusive: the selling value itself is treated as tax-inclusive", () => {
    const totals = computeCostSheetTotals({
      ...gstNoneBase,
      gstTreatment: "IGST",
      gstRatePercent: 18,
      priceType: "INCLUSIVE",
    });
    // customer total = 76200.00 (no separate addition); taxable value backed out
    expect(totals.customerTotal.toFixed(2)).toBe("76200.00");
    expect(totals.taxableSellingValue.toFixed(2)).toBe("64576.27");
    expect(totals.gstAmount.toFixed(2)).toBe("11623.73");
    expect(totals.taxableSellingValue.plus(totals.gstAmount).toFixed(2)).toBe(totals.customerTotal.toFixed(2));
  });

  it("exclusive and inclusive pricing at the same headline value produce different taxable values", () => {
    const exclusive = computeCostSheetTotals({
      ...gstNoneBase,
      gstTreatment: "IGST",
      gstRatePercent: 18,
      priceType: "EXCLUSIVE",
    });
    const inclusive = computeCostSheetTotals({
      ...gstNoneBase,
      gstTreatment: "IGST",
      gstRatePercent: 18,
      priceType: "INCLUSIVE",
    });
    expect(exclusive.taxableSellingValue.toFixed(2)).not.toBe(inclusive.taxableSellingValue.toFixed(2));
  });

  it("an optional rounding step rounds the customer total and records the exact adjustment", () => {
    const totals = computeCostSheetTotals({
      ...gstNoneBase,
      gstTreatment: "IGST",
      gstRatePercent: 18,
      roundingStep: 10,
    });
    // customerTotalBeforeRounding = 89916.00 -> nearest 10 = 89920.00
    expect(totals.customerTotalBeforeRounding.toFixed(2)).toBe("89916.00");
    expect(totals.customerTotal.toFixed(2)).toBe("89920.00");
    expect(totals.roundingAdjustment.toFixed(2)).toBe("4.00");
  });

  it("no rounding step leaves the customer total exactly as computed", () => {
    const totals = computeCostSheetTotals({ ...gstNoneBase, gstTreatment: "IGST", gstRatePercent: 18 });
    expect(totals.roundingAdjustment.toFixed(2)).toBe("0.00");
    expect(totals.customerTotal.toFixed(2)).toBe(totals.customerTotalBeforeRounding.toFixed(2));
  });

  it("fixed selling expense is subtracted after GST is excluded", () => {
    const totals = computeCostSheetTotals({ ...gstNoneBase, sellingExpenseFixed: 300 });
    expect(totals.sellingExpenseAmount.toFixed(2)).toBe("300.00");
    expect(totals.netRealization.toFixed(2)).toBe(totals.taxableSellingValue.minus(300).toFixed(2));
  });

  it("percentage selling expense is computed on the GST-inclusive customer total", () => {
    const totals = computeCostSheetTotals({
      ...gstNoneBase,
      gstTreatment: "IGST",
      gstRatePercent: 18,
      sellingExpensePercent: 2,
    });
    // customer total 89916.00 x 2% = 1798.32
    expect(totals.sellingExpenseAmount.toFixed(2)).toBe("1798.32");
  });

  it("fixed and percentage selling expenses combine additively", () => {
    const totals = computeCostSheetTotals({
      ...gstNoneBase,
      gstTreatment: "IGST",
      gstRatePercent: 18,
      sellingExpenseFixed: 100,
      sellingExpensePercent: 2,
    });
    expect(totals.sellingExpenseAmount.toFixed(2)).toBe("1898.32");
  });

  it("net realization and profit never include GST, even GST-inclusive", () => {
    const exclusive = computeCostSheetTotals({ ...gstNoneBase, gstTreatment: "IGST", gstRatePercent: 18 });
    const inclusive = computeCostSheetTotals({
      ...gstNoneBase,
      gstTreatment: "IGST",
      gstRatePercent: 18,
      priceType: "INCLUSIVE",
      manualSellingPriceOverride: exclusive.customerTotal,
    });
    // Forcing the INCLUSIVE customer total to equal the EXCLUSIVE one's
    // final customer total means both scenarios collected the exact same
    // cash from the customer — profit must therefore be identical too,
    // proving GST never leaks into profit either way.
    expect(inclusive.customerTotal.toFixed(2)).toBe(exclusive.customerTotal.toFixed(2));
    expect(inclusive.estimatedProfit.toFixed(2)).toBe(exclusive.estimatedProfit.toFixed(2));
  });

  it("recalculates real profit/margin after discount and selling expenses — never the target percentage", () => {
    const totals = computeCostSheetTotals({
      ...gstNoneBase,
      pricingMethod: "MARGIN_ON_PRICE",
      targetMarginPercent: 30,
      discountType: "PERCENT",
      discountValue: 15,
      sellingExpensePercent: 3,
    });
    // The achieved margin after a real discount and selling expense must
    // be strictly less than the 30% target — never displayed as if the
    // target were achieved.
    expect(totals.profitMarginPercent.lessThan(30)).toBe(true);
  });

  it("zero production cost and zero pricing inputs is a safe, non-crashing zero", () => {
    const totals = computeCostSheetTotals({
      metalLineAmounts: [],
      diamondLineAmounts: [],
      otherMaterialLineAmounts: [],
      labourLineAmounts: [],
      additionalChargeLineAmounts: [],
      pricingMethod: "MARKUP_ON_COST",
      markupPercent: 0,
      targetMarginPercent: 0,
      discountType: "NONE",
      discountValue: 0,
      gstTreatment: "NONE",
      gstRatePercent: 0,
      priceType: "EXCLUSIVE",
    });
    expect(totals.productionCost.toFixed(2)).toBe("0.00");
    expect(totals.customerTotal.toFixed(2)).toBe("0.00");
    expect(totals.profitMarginPercent.toFixed(2)).toBe("0.00");
  });

  it("handles large values without precision loss", () => {
    const totals = computeCostSheetTotals({
      ...gstNoneBase,
      metalLineAmounts: [98765432.1],
      pricingMethod: "MARKUP_ON_COST",
      markupPercent: 12.5,
      gstTreatment: "CGST_SGST",
      gstRatePercent: 3,
    });
    expect(totals.metalCost.toFixed(2)).toBe("98765432.10");
    expect(totals.cgst.plus(totals.sgst).toFixed(2)).toBe(totals.gstAmount.toFixed(2));
    expect(totals.customerTotal.greaterThan(98765432.1)).toBe(true);
  });
});
