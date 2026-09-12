import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ costSheetFindMany: vi.fn(), costingSettingsFindUnique: vi.fn() }));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    costSheet: { findMany: mocks.costSheetFindMany },
    costingSettings: { findUnique: mocks.costingSettingsFindUnique },
  },
}));

import { buildCostSheetsCsv, getCostingSettings, listCostSheets } from "./reports";

const SAMPLE_SHEET = {
  id: "cs-1",
  costingNumber: "CST/2026-27/0001",
  mode: "ESTIMATE",
  status: "DRAFT",
  costingDate: new Date("2026-06-15"),
  itemName: 'Ring "Classic", 22K',
  referenceNumber: null,
  revisionNumber: 1,
  customer: { name: "Asha, Customer" },
  pricingMethod: "MARKUP_ON_COST",
  markupPercent: "20",
  targetMarginPercent: "0",
  manualSellingPriceOverride: null,
  discountType: "NONE",
  discountValue: "0",
  gstTreatment: "NONE",
  gstRatePercentSnapshot: "0",
  priceType: "EXCLUSIVE",
  roundingStep: "0",
  sellingExpenseFixed: "0",
  sellingExpensePercent: "0",
  metalLines: [{ amount: "55000.00" }],
  diamondLines: [],
  otherMaterialLines: [],
  chargeLines: [],
};

describe("listCostSheets", () => {
  it("computes each row's totals from its own lines and pricing snapshot", async () => {
    mocks.costSheetFindMany.mockResolvedValue([SAMPLE_SHEET]);
    const rows = await listCostSheets();
    expect(rows).toHaveLength(1);
    expect(rows[0].productionCost.toFixed(2)).toBe("55000.00");
    expect(rows[0].customerTotal.toFixed(2)).toBe("66000.00"); // 55000 x 1.20
    expect(rows[0].customerName).toBe("Asha, Customer");
  });
});

describe("buildCostSheetsCsv", () => {
  it("quotes and escapes fields containing commas, quotes, or newlines", async () => {
    mocks.costSheetFindMany.mockResolvedValue([SAMPLE_SHEET]);
    const csv = await buildCostSheetsCsv();
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe(
      "Costing Number,Mode,Status,Date,Item,Customer,Reference,Revision,Production Cost,Customer Total,Estimated Profit"
    );
    // The item name contains a double quote and the customer name
    // contains a comma — both must come back correctly quoted/escaped,
    // not silently corrupting the CSV's column count.
    expect(lines[1]).toContain('"Ring ""Classic"", 22K"');
    expect(lines[1]).toContain('"Asha, Customer"');
  });

  it("produces a header-only CSV (still valid) when there are no cost sheets at all", async () => {
    mocks.costSheetFindMany.mockResolvedValue([]);
    const csv = await buildCostSheetsCsv();
    expect(csv.split("\r\n")).toHaveLength(1);
  });
});

describe("getCostingSettings", () => {
  it("falls back to safe zero/NONE defaults when no settings row exists yet", async () => {
    mocks.costingSettingsFindUnique.mockResolvedValue(null);
    const settings = await getCostingSettings();
    expect(settings.defaultPricingMethod).toBe("MARKUP_ON_COST");
    expect(settings.defaultMarkupPercent.toFixed(2)).toBe("0.00");
    expect(settings.defaultGstTreatment).toBe("NONE");
    expect(settings.defaultValidityDays).toBe(15);
  });

  it("reads real saved settings when a row exists", async () => {
    mocks.costingSettingsFindUnique.mockResolvedValue({
      defaultPricingMethod: "MARGIN_ON_PRICE",
      defaultMarkupPercent: "0",
      defaultTargetMarginPercent: "25",
      defaultDiscountType: "PERCENT",
      defaultDiscountValue: "5",
      defaultGstTreatment: "IGST",
      defaultGstRateId: "gst-1",
      defaultPriceType: "INCLUSIVE",
      defaultValidityDays: 30,
      defaultRoundingStep: "10",
      defaultSellingExpenseFixed: "0",
      defaultSellingExpensePercent: "2",
      quotationTerms: "Terms apply.",
    });
    const settings = await getCostingSettings();
    expect(settings.defaultPricingMethod).toBe("MARGIN_ON_PRICE");
    expect(settings.defaultTargetMarginPercent.toFixed(2)).toBe("25.00");
    expect(settings.defaultValidityDays).toBe(30);
    expect(settings.quotationTerms).toBe("Terms apply.");
  });
});
