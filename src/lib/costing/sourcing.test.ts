import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  finishedJewelleryFindUnique: vi.fn(),
  costSheetFindFirst: vi.fn(),
  finishedJewellerySaleLineFindFirst: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    finishedJewellery: { findUnique: mocks.finishedJewelleryFindUnique },
    costSheet: { findFirst: mocks.costSheetFindFirst },
    finishedJewellerySaleLine: { findFirst: mocks.finishedJewellerySaleLineFindFirst },
  },
}));

import { getPhase5VsPhase6Comparison } from "./sourcing";

const ITEM = {
  id: "fj-1",
  finishedCode: "ZL-FJ-2026-000001",
  metalCost: "50000.00",
  diamondCost: "20000.00",
  labourAllocated: "8000.00",
  otherMaterialCost: "5000.00", // display-only — the difference this comparison must explain
};

const SHEET = {
  id: "cs-1",
  costingNumber: "CST/2026-27/0001",
  finalizedAt: new Date("2026-06-20"),
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
  metalLines: [{ amount: "50000.00" }],
  diamondLines: [{ amount: "20000.00" }],
  otherMaterialLines: [{ amount: "5000.00" }],
  chargeLines: [{ amount: "8000.00", isLabour: true }],
};

describe("getPhase5VsPhase6Comparison — no genuinely linked Costing", () => {
  it("returns null when there is no finalized Actual Costing linked to this exact output", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(ITEM);
    mocks.costSheetFindFirst.mockResolvedValue(null);
    const result = await getPhase5VsPhase6Comparison("fj-1");
    expect(result).toBeNull();
  });

  it("returns null when the item itself doesn't exist", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(null);
    const result = await getPhase5VsPhase6Comparison("missing");
    expect(result).toBeNull();
    expect(mocks.costSheetFindFirst).not.toHaveBeenCalled();
  });
});

describe("getPhase5VsPhase6Comparison — Phase 5 expected figures (never mutates the sheet)", () => {
  it("computes expected selling value/cost/profit/margin from the sheet's own frozen lines", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(ITEM);
    mocks.costSheetFindFirst.mockResolvedValue(SHEET);
    mocks.finishedJewellerySaleLineFindFirst.mockResolvedValue(null);

    const result = await getPhase5VsPhase6Comparison("fj-1");
    expect(result).not.toBeNull();
    expect(result!.expectedFullBusinessCost.toFixed(2)).toBe("83000.00"); // 50000+20000+5000+8000
    expect(result!.expectedSellingValue.toFixed(2)).toBe("99600.00"); // 83000 x 1.20
    expect(result!.expectedProfit.toFixed(2)).toBe("16600.00");
    expect(result!.expectedMarginPercent.toFixed(2)).toBe("16.67");
  });

  it("never queries or writes anything that could mutate the Cost Sheet — read-only findFirst only", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(ITEM);
    mocks.costSheetFindFirst.mockResolvedValue(SHEET);
    mocks.finishedJewellerySaleLineFindFirst.mockResolvedValue(null);
    await getPhase5VsPhase6Comparison("fj-1");
    expect(mocks.costSheetFindFirst).toHaveBeenCalledTimes(1);
    const call = mocks.costSheetFindFirst.mock.calls[0][0];
    expect(call.where.sourceFinishedJewelleryId).toBe("fj-1");
    expect(call.where.mode).toBe("ACTUAL");
    expect(call.where.status).toBe("FINALIZED");
  });
});

describe("getPhase5VsPhase6Comparison — the otherMaterialCost explanation", () => {
  it("authoritativeAccountingCost EXCLUDES otherMaterialCost while expectedFullBusinessCost INCLUDES it — the gap equals otherMaterialCostExcluded", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(ITEM);
    mocks.costSheetFindFirst.mockResolvedValue(SHEET);
    mocks.finishedJewellerySaleLineFindFirst.mockResolvedValue(null);

    const result = await getPhase5VsPhase6Comparison("fj-1");
    expect(result!.authoritativeAccountingCost.toFixed(2)).toBe("78000.00"); // 50000+20000+8000
    expect(result!.otherMaterialCostExcluded.toFixed(2)).toBe("5000.00");
    expect(result!.expectedFullBusinessCost.minus(result!.authoritativeAccountingCost).toFixed(2)).toBe("5000.00");
  });
});

describe("getPhase5VsPhase6Comparison — realized status per lifecycle outcome", () => {
  it("NOT_SOLD: no sale line exists at all", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(ITEM);
    mocks.costSheetFindFirst.mockResolvedValue(SHEET);
    mocks.finishedJewellerySaleLineFindFirst.mockResolvedValue(null);

    const result = await getPhase5VsPhase6Comparison("fj-1");
    expect(result!.realizedStatus).toBe("NOT_SOLD");
    expect(result!.realizedGrossProfit).toBeNull();
    expect(result!.profitDifference).toBeNull();
    expect(result!.note).toMatch(/has not been sold/i);
  });

  it("SOLD_ACTIVE: computes realized net selling value, COGS, gross profit, margin and the difference vs Phase 5", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(ITEM);
    mocks.costSheetFindFirst.mockResolvedValue(SHEET);
    mocks.finishedJewellerySaleLineFindFirst.mockResolvedValue({
      taxableValue: "90000.00",
      cogsAmount: "78000.00",
      returnStatus: "NONE",
      sale: { saleCode: "ZL-FJS-2026-000001", status: "POSTED" },
    });

    const result = await getPhase5VsPhase6Comparison("fj-1");
    expect(result!.realizedStatus).toBe("SOLD_ACTIVE");
    expect(result!.saleCode).toBe("ZL-FJS-2026-000001");
    expect(result!.realizedNetSellingValue!.toFixed(2)).toBe("90000.00");
    expect(result!.realizedCogs!.toFixed(2)).toBe("78000.00");
    expect(result!.realizedGrossProfit!.toFixed(2)).toBe("12000.00");
    expect(result!.realizedMarginPercent!.toFixed(2)).toBe("13.33");
    // 12000 (realized) - 16600 (Phase 5 expected) = -4600
    expect(result!.profitDifference!.toFixed(2)).toBe("-4600.00");
  });

  it("SALE_CANCELLED: never shows a realized profit as if the sale were still active", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(ITEM);
    mocks.costSheetFindFirst.mockResolvedValue(SHEET);
    mocks.finishedJewellerySaleLineFindFirst.mockResolvedValue({
      taxableValue: "90000.00",
      cogsAmount: "78000.00",
      returnStatus: "NONE",
      sale: { saleCode: "ZL-FJS-2026-000002", status: "CANCELLED" },
    });

    const result = await getPhase5VsPhase6Comparison("fj-1");
    expect(result!.realizedStatus).toBe("SALE_CANCELLED");
    expect(result!.realizedGrossProfit).toBeNull();
    expect(result!.realizedNetSellingValue).toBeNull();
    expect(result!.profitDifference).toBeNull();
    expect(result!.note).toMatch(/cancelled/i);
  });

  it("RETURNED_SELLABLE: labelled accurately, no realized profit shown", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(ITEM);
    mocks.costSheetFindFirst.mockResolvedValue(SHEET);
    mocks.finishedJewellerySaleLineFindFirst.mockResolvedValue({
      taxableValue: "90000.00",
      cogsAmount: "78000.00",
      returnStatus: "RETURNED_SELLABLE",
      sale: { saleCode: "ZL-FJS-2026-000003", status: "POSTED" },
    });

    const result = await getPhase5VsPhase6Comparison("fj-1");
    expect(result!.realizedStatus).toBe("RETURNED_SELLABLE");
    expect(result!.realizedGrossProfit).toBeNull();
    expect(result!.note).toMatch(/returned sellable/i);
  });

  it("RETURNED_DAMAGED: labelled as a loss, never shown as realized profit", async () => {
    mocks.finishedJewelleryFindUnique.mockResolvedValue(ITEM);
    mocks.costSheetFindFirst.mockResolvedValue(SHEET);
    mocks.finishedJewellerySaleLineFindFirst.mockResolvedValue({
      taxableValue: "90000.00",
      cogsAmount: "78000.00",
      returnStatus: "RETURNED_DAMAGED",
      sale: { saleCode: "ZL-FJS-2026-000004", status: "POSTED" },
    });

    const result = await getPhase5VsPhase6Comparison("fj-1");
    expect(result!.realizedStatus).toBe("RETURNED_DAMAGED");
    expect(result!.realizedGrossProfit).toBeNull();
    expect(result!.note).toMatch(/damaged/i);
    expect(result!.note).toMatch(/loss/i);
  });
});
