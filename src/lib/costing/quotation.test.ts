import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ costSheetFindUnique: vi.fn() }));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { costSheet: { findUnique: mocks.costSheetFindUnique } },
}));

import { getCustomerQuotationView } from "./quotation";

const BASE_SHEET = {
  id: "cs-1",
  costingNumber: "CST/2026-27/0001",
  status: "FINALIZED",
  costingDate: new Date("2026-06-15"),
  quotationValidUntil: new Date("2026-06-30"),
  itemName: "Solitaire ring",
  jewelleryType: "RING",
  referenceNumber: "REF-1",
  quantity: 1,
  sizeOrLength: null,
  designImageAssetId: null,
  notes: null,
  customer: { name: "Asha Customer" },
  pricingMethod: "MARKUP_ON_COST",
  markupPercent: "20",
  targetMarginPercent: "0",
  manualSellingPriceOverride: null,
  discountType: "NONE",
  discountValue: "0",
  gstTreatment: "IGST",
  gstRatePercentSnapshot: "18",
  priceType: "EXCLUSIVE",
  roundingStep: "0",
  sellingExpenseFixed: "0",
  sellingExpensePercent: "0",
  quotationTerms: "Prices valid till the date shown.",
  metalLines: [{ metalType: "GOLD", purityDisplayNameSnapshot: "22K", grossWeight: "10.000", amount: "55000.00" }],
  diamondLines: [{ shape: "ROUND", quantity: 1, totalCarat: "1.000", amount: "40000.00" }],
  otherMaterialLines: [{ amount: "500.00" }],
  chargeLines: [{ isLabour: true, amount: "2000.00" }],
};

describe("getCustomerQuotationView", () => {
  it("returns null for a Draft costing — a quotation only ever exists once Finalized", async () => {
    mocks.costSheetFindUnique.mockResolvedValue({ ...BASE_SHEET, status: "DRAFT" });
    const view = await getCustomerQuotationView("cs-1");
    expect(view).toBeNull();
  });

  it("returns null for a costing that does not exist", async () => {
    mocks.costSheetFindUnique.mockResolvedValue(null);
    const view = await getCustomerQuotationView("missing");
    expect(view).toBeNull();
  });

  it("returns a view for a Finalized costing, and for an Archived one too", async () => {
    mocks.costSheetFindUnique.mockResolvedValue(BASE_SHEET);
    expect(await getCustomerQuotationView("cs-1")).not.toBeNull();
    mocks.costSheetFindUnique.mockResolvedValue({ ...BASE_SHEET, status: "ARCHIVED" });
    expect(await getCustomerQuotationView("cs-1")).not.toBeNull();
  });

  it("NEVER includes any internal cost, profit, margin, markup, or source reference field — only the exact customer-safe field set", async () => {
    mocks.costSheetFindUnique.mockResolvedValue(BASE_SHEET);
    const view = await getCustomerQuotationView("cs-1");
    expect(view).not.toBeNull();

    const forbiddenSubstrings = [
      "cost",
      "profit",
      "margin",
      "markup",
      "wip",
      "labour",
      "charge",
      "material",
      "sourcejob",
      "sourcereceipt",
      "sourcefinished",
      "sourcevoucher",
      "voucher",
    ];
    // "costingNumber"/"costingDate" legitimately contain the substring
    // "cost" (as in the COSTING document itself, e.g. "invoice number") —
    // they name the document, not a cost VALUE, so they are explicitly
    // exempted from the substring scan below.
    const substringScanExemptions = new Set(["costingNumber", "costingDate"]);
    const actualKeys = Object.keys(view!);
    for (const key of actualKeys) {
      if (substringScanExemptions.has(key)) continue;
      const lower = key.toLowerCase();
      for (const forbidden of forbiddenSubstrings) {
        expect(lower.includes(forbidden)).toBe(false);
      }
    }

    // And a precise, exhaustive allow-list — adding a new field to
    // CustomerQuotationView without updating this test will fail it,
    // forcing a deliberate re-check of what a customer can see.
    expect(new Set(actualKeys)).toEqual(
      new Set([
        "costingNumber",
        "costingDate",
        "status",
        "quotationValidUntil",
        "itemName",
        "jewelleryType",
        "referenceNumber",
        "quantity",
        "sizeOrLength",
        "designImageAssetId",
        "notes",
        "customerName",
        "metalSummary",
        "diamondSummary",
        "sellingValueBeforeDiscount",
        "discountAmount",
        "taxableSellingValue",
        "gstTreatment",
        "gstRatePercent",
        "cgst",
        "sgst",
        "igst",
        "customerTotal",
        "quotationTerms",
      ])
    );
  });

  it("the metal/diamond summary lines carry only descriptive fields — no per-line cost", async () => {
    mocks.costSheetFindUnique.mockResolvedValue(BASE_SHEET);
    const view = await getCustomerQuotationView("cs-1");
    expect(Object.keys(view!.metalSummary[0]).sort()).toEqual(["grossWeight", "metalType", "purityDisplayName"].sort());
    expect(Object.keys(view!.diamondSummary[0]).sort()).toEqual(["quantity", "shape", "totalCarat"].sort());
  });

  it("computes a real customer total consistent with the snapshot pricing inputs", async () => {
    mocks.costSheetFindUnique.mockResolvedValue(BASE_SHEET);
    const view = await getCustomerQuotationView("cs-1");
    // production cost 55000+40000+500+2000 = 97500; markup 20% -> 117000;
    // IGST 18% exclusive -> 117000 * 1.18 = 138060.00
    // (Decimal objects here — the page layer converts to strings via
    // .toFixed() before ever reaching a Client Component; see
    // src/app/(app)/costing/page.tsx's SheetsTabContent.)
    expect(view!.taxableSellingValue.toFixed(2)).toBe("117000.00");
    expect(view!.customerTotal.toFixed(2)).toBe("138060.00");
    expect(view!.igst.toFixed(2)).toBe("21060.00");
  });
});
