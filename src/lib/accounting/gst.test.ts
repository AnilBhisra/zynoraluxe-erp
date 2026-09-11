import { describe, expect, it } from "vitest";

import { computeInvoiceLineTotals, splitGstAmount, suggestGstTreatment } from "./gst";

describe("computeInvoiceLineTotals", () => {
  it("computes GST-exclusive totals", () => {
    const result = computeInvoiceLineTotals({
      quantity: 2,
      rate: 5000,
      gstRatePercent: 3,
      taxType: "EXCLUSIVE",
    });
    expect(result.taxableValue.toNumber()).toBe(10000);
    expect(result.taxAmount.toNumber()).toBe(300);
    expect(result.lineTotal.toNumber()).toBe(10300);
  });

  it("computes GST-inclusive totals (back-calculates the taxable value)", () => {
    const result = computeInvoiceLineTotals({
      quantity: 1,
      rate: 10300,
      gstRatePercent: 3,
      taxType: "INCLUSIVE",
    });
    expect(result.lineTotal.toNumber()).toBe(10300);
    expect(result.taxableValue.toNumber()).toBe(10000);
    expect(result.taxAmount.toNumber()).toBe(300);
  });

  it("applies a flat discount before computing tax", () => {
    const result = computeInvoiceLineTotals({
      quantity: 1,
      rate: 1000,
      discount: 100,
      gstRatePercent: 0,
      taxType: "EXCLUSIVE",
    });
    expect(result.taxableValue.toNumber()).toBe(900);
    expect(result.lineTotal.toNumber()).toBe(900);
  });

  it("handles 0% GST cleanly", () => {
    const result = computeInvoiceLineTotals({
      quantity: 3,
      rate: 100,
      gstRatePercent: 0,
      taxType: "EXCLUSIVE",
    });
    expect(result.taxAmount.toNumber()).toBe(0);
    expect(result.lineTotal.toNumber()).toBe(300);
  });

  it("rounds to 2 decimal places", () => {
    const result = computeInvoiceLineTotals({
      quantity: 1,
      rate: 33.335,
      gstRatePercent: 0,
      taxType: "EXCLUSIVE",
    });
    // decimal.js round-half-up: 33.335 -> 33.34 (2dp)
    expect(result.taxableValue.toNumber()).toBe(33.34);
  });
});

describe("splitGstAmount", () => {
  it("splits evenly between CGST and SGST", () => {
    const { cgst, sgst, igst } = splitGstAmount(300, "CGST_SGST");
    expect(cgst.toNumber()).toBe(150);
    expect(sgst.toNumber()).toBe(150);
    expect(igst.toNumber()).toBe(0);
  });

  it("puts a 1-paise rounding remainder on SGST so the split reconciles exactly", () => {
    const { cgst, sgst } = splitGstAmount(0.03, "CGST_SGST");
    expect(cgst.plus(sgst).toNumber()).toBe(0.03);
  });

  it("puts the full amount on IGST", () => {
    const { cgst, sgst, igst } = splitGstAmount(300, "IGST");
    expect(igst.toNumber()).toBe(300);
    expect(cgst.toNumber()).toBe(0);
    expect(sgst.toNumber()).toBe(0);
  });

  it("returns all zeros for NONE", () => {
    const { cgst, sgst, igst } = splitGstAmount(300, "NONE");
    expect(cgst.toNumber()).toBe(0);
    expect(sgst.toNumber()).toBe(0);
    expect(igst.toNumber()).toBe(0);
  });
});

describe("suggestGstTreatment", () => {
  it("suggests CGST+SGST for matching state codes", () => {
    expect(suggestGstTreatment("24", "24")).toBe("CGST_SGST");
  });

  it("suggests IGST for different state codes", () => {
    expect(suggestGstTreatment("24", "27")).toBe("IGST");
  });

  it("returns null when either state code is missing (never guesses)", () => {
    expect(suggestGstTreatment(null, "27")).toBeNull();
    expect(suggestGstTreatment("24", undefined)).toBeNull();
  });
});
