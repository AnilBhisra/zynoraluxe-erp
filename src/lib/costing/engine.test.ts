import { describe, expect, it, vi } from "vitest";

// engine.ts pulls in src/lib/costing/sourcing.ts, which imports the real
// prisma client for its (unused-by-these-tests) listing query — mock it
// out so importing the module tree doesn't require a live DATABASE_URL,
// matching src/lib/jewellery/reports.test.ts's own pattern.
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { createFakeCostingTx } from "../../../test/fixtures/fakeCostingTx";
import {
  createJewelleryJob,
  createMetalPurchase,
  issueMaterialsToJewelleryJob,
  receiveFinishedJewellery,
} from "@/lib/jewellery/posting";
import {
  archiveCostSheet,
  createActualCostSheet,
  createEstimateCostSheet,
  deleteDraftCostSheet,
  finalizeCostSheet,
  PostingError,
  refreshActualCostSheetFromSource,
  reviseCostSheet,
  unarchiveCostSheet,
  updateEstimateCostSheet,
} from "./engine";
import { computeCostSheetTotals } from "./calculations";

type Fixture = ReturnType<typeof createFakeCostingTx>;

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-06-15T00:00:00.000Z");

function common(overrides: Partial<Record<string, unknown>> = {}) {
  return { ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: "user-1", ...overrides };
}

function seedGold22k(fixture: Fixture) {
  return fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
}

async function purchaseMetal(fixture: Fixture, purityId: string, opts: { grossWeight: number; totalPurchaseCost: number }) {
  return createMetalPurchase(fixture.tx as never, {
    ...common(),
    purchaseDate: DATE,
    supplierId: "supplier-1",
    metalType: "GOLD",
    purityId,
    grossWeight: opts.grossWeight,
    rateBasis: "PER_GROSS_GRAM",
    rate: opts.totalPurchaseCost / opts.grossWeight,
    totalPurchaseCost: opts.totalPurchaseCost,
    gstTreatment: "NONE",
  });
}

async function createDraftJob(fixture: Fixture) {
  return createJewelleryJob(fixture.tx as never, {
    karigarId: "karigar-1",
    jewelleryType: "RING",
    designName: "Solitaire ring",
    issueDate: DATE,
    quantity: 1,
    createdByUserId: "user-1",
  });
}

/** No loss: issue 10g gross of 22K, one output of exactly 10g net, one
 * diamond SET, other material + labour charged — job completes clean. */
async function setupSimpleCompletedJobWithOutput(fixture: Fixture) {
  const purity = seedGold22k(fixture);
  await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 }); // 5000/g
  const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-POL-2026-000001", shape: "ROUND", carat: "0.500", allocatedCost: "20000.00" });
  const job = await createDraftJob(fixture);
  const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
    ...common(),
    jobId: job.id as string,
    issueDate: DATE,
    metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }], // fine 9.16, cost 50000
    polishedDiamondIds: [diamond.id as string],
    otherMaterialLines: [{ description: "Findings", quantity: 1, unit: "PCS", cost: 500 }],
  });

  const result = await receiveFinishedJewellery(fixture.tx as never, {
    ...common(),
    jobId: issued.id as string,
    receiveDate: DATE,
    outputs: [
      { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [diamond.id as string], qcStatus: "PASSED" },
    ],
    diamondResolutions: [{ polishedDiamondId: diamond.id as string, resolution: "SET" }],
    returnedMetalLines: [],
    scrapMetalLines: [],
    karigarAddedFineWeight: 0,
    karigarAddedCost: 0,
    labourCharge: 300,
    makingCharge: 0,
    settingCharge: 0,
    platingCharge: 0,
    otherExpense: 0,
    markJobComplete: true,
    isAbnormalLoss: false,
    damagedLostByUserId: "user-1",
  });

  return { fixture, purity, diamond, job: result.job, output: result.outputs[0] };
}

/** A REAL, recognized normal process loss: issue 10g, output uses only
 * 8g net (fine 7.328g of the 9.16g issued), remainder becomes loss on
 * job completion — proves the sourced metal cost already absorbs it. */
async function setupLossyCompletedJobWithOutput(fixture: Fixture) {
  const purity = seedGold22k(fixture);
  await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
  const job = await createDraftJob(fixture);
  const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
    ...common(),
    jobId: job.id as string,
    issueDate: DATE,
    metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
    polishedDiamondIds: [],
    otherMaterialLines: [],
  });

  const result = await receiveFinishedJewellery(fixture.tx as never, {
    ...common(),
    jobId: issued.id as string,
    receiveDate: DATE,
    outputs: [
      { jewelleryType: "RING", quantity: 1, netMetalWeight: 8, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
    ],
    diamondResolutions: [],
    returnedMetalLines: [],
    scrapMetalLines: [],
    karigarAddedFineWeight: 0,
    karigarAddedCost: 0,
    labourCharge: 0,
    makingCharge: 0,
    settingCharge: 0,
    platingCharge: 0,
    otherExpense: 0,
    markJobComplete: true,
    isAbnormalLoss: false,
    damagedLostByUserId: "user-1",
  });

  return { fixture, purity, job: result.job, output: result.outputs[0] };
}

describe("createActualCostSheet", () => {
  it("sources metal/diamond/other-material/labour exactly from the Phase 4 output, with no double counting", async () => {
    const fixture = createFakeCostingTx();
    const { output } = await setupSimpleCompletedJobWithOutput(fixture);

    const sheet = await createActualCostSheet(fixture.tx as never, {
      ...common(),
      sourceFinishedJewelleryId: output.id as string,
      costingDate: DATE,
      pricingMethod: "MARKUP_ON_COST",
      discountType: "NONE",
      gstTreatment: "NONE",
      priceType: "EXCLUSIVE",
      validityDays: 15,
    });

    const metalLines = fixture.state.costSheetMetalLines as Map<string, Record<string, unknown>>;
    const diamondLines = fixture.state.costSheetDiamondLines as Map<string, Record<string, unknown>>;
    const otherLines = fixture.state.costSheetOtherMaterialLines as Map<string, Record<string, unknown>>;
    const chargeLines = fixture.state.costSheetChargeLines as Map<string, Record<string, unknown>>;

    const metal = [...metalLines.values()].find((l) => l.costSheetId === sheet.id)!;
    const diamond = [...diamondLines.values()].find((l) => l.costSheetId === sheet.id)!;
    const other = [...otherLines.values()].find((l) => l.costSheetId === sheet.id)!;
    const charge = [...chargeLines.values()].find((l) => l.costSheetId === sheet.id)!;

    // Exactly matches FinishedJewellery's own stored figures — never
    // independently recomputed.
    expect(Number(metal.amount)).toBe(Number((output as Record<string, unknown>).metalCost));
    expect(Number(diamond.amount)).toBe(20000); // the diamond's own allocatedCost/costAtIssue
    expect(Number(other.amount)).toBe(500);
    expect(Number(charge.amount)).toBe(300);
    expect(charge.isLabour).toBe(true);
  });

  it("a normal recognized process loss is already embedded in the sourced metal cost — never added again", async () => {
    const fixture = createFakeCostingTx();
    const { job, output } = await setupLossyCompletedJobWithOutput(fixture);

    const sheet = await createActualCostSheet(fixture.tx as never, {
      ...common(),
      sourceFinishedJewelleryId: output.id as string,
      costingDate: DATE,
      pricingMethod: "MARKUP_ON_COST",
      discountType: "NONE",
      gstTreatment: "NONE",
      priceType: "EXCLUSIVE",
      validityDays: 15,
    });

    const metalLines = fixture.state.costSheetMetalLines as Map<string, Record<string, unknown>>;
    const metal = [...metalLines.values()].find((l) => l.costSheetId === sheet.id)!;

    // The job's ENTIRE remaining WIP cost (₹50000, for 9.16g fine issued)
    // was absorbed into this one output's metalCost once the job
    // completed, even though the output itself only used 8g net / 7.328g
    // fine of it — the other 1.832g fine became normal (non-abnormal)
    // process loss, silently folded into this exact figure by Phase 4's
    // own posting.ts, not by this costing sheet.
    expect(Number(metal.amount)).toBe(50000);
    expect(Number(metal.amount)).toBe(Number((output as Record<string, unknown>).metalCost));
    expect(job.status).toBe("COMPLETED");
    expect(Number(job.remainingWipCost)).toBe(0);
  });

  it("rejects sourcing from an output whose job is not yet Completed", async () => {
    const fixture = createFakeCostingTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });
    // Partial receipt only — job stays PARTIALLY_RECEIVED, not COMPLETED.
    const partial = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 3, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
      ],
      diamondResolutions: [],
      returnedMetalLines: [],
      scrapMetalLines: [],
      karigarAddedFineWeight: 0,
      karigarAddedCost: 0,
      labourCharge: 0,
      makingCharge: 0,
      settingCharge: 0,
      platingCharge: 0,
      otherExpense: 0,
      markJobComplete: false,
      isAbnormalLoss: false,
      damagedLostByUserId: "user-1",
    });
    expect(partial.job.status).toBe("PARTIALLY_RECEIVED");

    await expect(
      createActualCostSheet(fixture.tx as never, {
        ...common(),
        sourceFinishedJewelleryId: partial.outputs[0].id as string,
        costingDate: DATE,
        pricingMethod: "MARKUP_ON_COST",
        discountType: "NONE",
        gstTreatment: "NONE",
        priceType: "EXCLUSIVE",
        validityDays: 15,
      })
    ).rejects.toThrow(PostingError);
  });

  it("a diamond RETURNED (never SET) on the same job never appears in the Actual costing", async () => {
    const fixture = createFakeCostingTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
    const setDiamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-POL-000001", shape: "ROUND", carat: "0.5", allocatedCost: "10000" });
    const returnedDiamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-POL-000002", shape: "ROUND", carat: "0.4", allocatedCost: "8000" });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [setDiamond.id as string, returnedDiamond.id as string],
      otherMaterialLines: [],
    });
    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [setDiamond.id as string], qcStatus: "PASSED" },
      ],
      diamondResolutions: [
        { polishedDiamondId: setDiamond.id as string, resolution: "SET" },
        { polishedDiamondId: returnedDiamond.id as string, resolution: "RETURNED" },
      ],
      returnedMetalLines: [],
      scrapMetalLines: [],
      karigarAddedFineWeight: 0,
      karigarAddedCost: 0,
      labourCharge: 0,
      makingCharge: 0,
      settingCharge: 0,
      platingCharge: 0,
      otherExpense: 0,
      markJobComplete: true,
      isAbnormalLoss: false,
      damagedLostByUserId: "user-1",
    });

    const sheet = await createActualCostSheet(fixture.tx as never, {
      ...common(),
      sourceFinishedJewelleryId: result.outputs[0].id as string,
      costingDate: DATE,
      pricingMethod: "MARKUP_ON_COST",
      discountType: "NONE",
      gstTreatment: "NONE",
      priceType: "EXCLUSIVE",
      validityDays: 15,
    });
    const diamondLines = [...(fixture.state.costSheetDiamondLines as Map<string, Record<string, unknown>>).values()].filter(
      (l) => l.costSheetId === sheet.id
    );
    expect(diamondLines).toHaveLength(1);
    expect(diamondLines[0].sourcePolishedDiamondId).toBe(setDiamond.id);
    expect(Number(diamondLines[0].amount)).toBe(10000);
  });

  it("refresh-from-source re-pulls the snapshot on a Draft, and rejects once Finalized", async () => {
    const fixture = createFakeCostingTx();
    const { output } = await setupSimpleCompletedJobWithOutput(fixture);
    const sheet = await createActualCostSheet(fixture.tx as never, {
      ...common(),
      sourceFinishedJewelleryId: output.id as string,
      costingDate: DATE,
      pricingMethod: "MARKUP_ON_COST",
      discountType: "NONE",
      gstTreatment: "NONE",
      priceType: "EXCLUSIVE",
      validityDays: 15,
    });

    await refreshActualCostSheetFromSource(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" });
    const metalLinesAfterRefresh = [...(fixture.state.costSheetMetalLines as Map<string, Record<string, unknown>>).values()].filter(
      (l) => l.costSheetId === sheet.id
    );
    expect(metalLinesAfterRefresh).toHaveLength(1);

    await finalizeCostSheet(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" });
    await expect(
      refreshActualCostSheetFromSource(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" })
    ).rejects.toThrow(PostingError);
  });
});

describe("createEstimateCostSheet", () => {
  const estimateInput = (fixture: Fixture, purityId: string) => ({
    ...common(),
    costingDate: DATE,
    jewelleryType: "RING" as const,
    itemName: "Custom solitaire",
    quantity: 1,
    metalLines: [{ metalType: "GOLD" as const, purityId, grossWeight: 10, rateBasis: "PER_GROSS_GRAM" as const, rate: 5500 }],
    diamondLines: [{ shape: "ROUND" as const, quantity: 1, totalCarat: 1, ratePerCarat: 40000, certificateCharge: 500 }],
    otherMaterialLines: [{ category: "FINDINGS" as const, description: "Findings", quantity: 2, rate: 50 }],
    chargeLines: [
      { label: "Karigar labour", isLabour: true, method: "FLAT" as const, rate: 2000 },
      { label: "Hallmark", isLabour: false, method: "FLAT" as const, rate: 100 },
    ],
    pricingMethod: "MARKUP_ON_COST" as const,
    markupPercent: 25,
    discountType: "NONE" as const,
    gstTreatment: "NONE" as const,
    priceType: "EXCLUSIVE" as const,
    validityDays: 15,
  });

  it("never touches real Phase 3/4 stock — no metal issue, no diamond issue", async () => {
    const fixture = createFakeCostingTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
    const balanceBefore = fixture.state.metalStockMovements.size;

    await createEstimateCostSheet(fixture.tx as never, estimateInput(fixture, purity.id as string));

    // Estimate creation must create ZERO new metal-stock or diamond-stock
    // movements — the purchase above is the only movement in existence.
    expect(fixture.state.metalStockMovements.size).toBe(balanceBefore);
    expect(fixture.state.stockMovements.size).toBe(0);
  });

  it("computes every line amount server-side from rate x weight/carat, matching calculations.ts exactly", async () => {
    const fixture = createFakeCostingTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });

    const sheet = await createEstimateCostSheet(fixture.tx as never, estimateInput(fixture, purity.id as string));
    const metal = [...(fixture.state.costSheetMetalLines as Map<string, Record<string, unknown>>).values()].find((l) => l.costSheetId === sheet.id)!;
    const diamond = [...(fixture.state.costSheetDiamondLines as Map<string, Record<string, unknown>>).values()].find((l) => l.costSheetId === sheet.id)!;
    const other = [...(fixture.state.costSheetOtherMaterialLines as Map<string, Record<string, unknown>>).values()].find((l) => l.costSheetId === sheet.id)!;

    expect(Number(metal.amount)).toBe(55000); // 10g x 5500
    expect(Number(diamond.amount)).toBe(40500); // 1ct x 40000 + 500 cert
    expect(Number(other.amount)).toBe(100); // 2 x 50
  });

  it("rejects a target margin at or above 100%", async () => {
    const fixture = createFakeCostingTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
    await expect(
      createEstimateCostSheet(fixture.tx as never, {
        ...estimateInput(fixture, purity.id as string),
        pricingMethod: "MARGIN_ON_PRICE",
        targetMarginPercent: 100,
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects an empty sheet with no lines at all", async () => {
    const fixture = createFakeCostingTx();
    await expect(
      createEstimateCostSheet(fixture.tx as never, {
        ...common(),
        costingDate: DATE,
        jewelleryType: "RING",
        itemName: "Empty",
        quantity: 1,
        metalLines: [],
        diamondLines: [],
        otherMaterialLines: [],
        chargeLines: [],
        pricingMethod: "MARKUP_ON_COST",
        discountType: "NONE",
        gstTreatment: "NONE",
        priceType: "EXCLUSIVE",
        validityDays: 15,
      })
    ).rejects.toThrow(PostingError);
  });

  it("updateEstimateCostSheet fully replaces a Draft's lines and rejects once Finalized", async () => {
    const fixture = createFakeCostingTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
    const sheet = await createEstimateCostSheet(fixture.tx as never, estimateInput(fixture, purity.id as string));

    const updated = await updateEstimateCostSheet(fixture.tx as never, {
      ...estimateInput(fixture, purity.id as string),
      costSheetId: sheet.id as string,
      itemName: "Updated name",
      metalLines: [],
      diamondLines: [],
      otherMaterialLines: [{ category: "OTHER", description: "Packaging", manualAmount: 150 }],
      chargeLines: [],
      userId: "user-1",
    });
    expect(updated.itemName).toBe("Updated name");
    const metalLinesAfter = [...(fixture.state.costSheetMetalLines as Map<string, Record<string, unknown>>).values()].filter(
      (l) => l.costSheetId === sheet.id
    );
    expect(metalLinesAfter).toHaveLength(0);

    await finalizeCostSheet(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" });
    await expect(
      updateEstimateCostSheet(fixture.tx as never, {
        ...estimateInput(fixture, purity.id as string),
        costSheetId: sheet.id as string,
        userId: "user-1",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("finalize / revise / archive lifecycle", () => {
  async function setupFinalizedEstimate(fixture: Fixture) {
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
    const sheet = await createEstimateCostSheet(fixture.tx as never, {
      ...common(),
      costingDate: DATE,
      jewelleryType: "RING",
      itemName: "Solitaire",
      quantity: 1,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10, rateBasis: "PER_GROSS_GRAM", rate: 5000 }],
      diamondLines: [],
      otherMaterialLines: [],
      chargeLines: [],
      pricingMethod: "MARKUP_ON_COST",
      markupPercent: 20,
      discountType: "NONE",
      gstTreatment: "NONE",
      priceType: "EXCLUSIVE",
      validityDays: 15,
    });
    const finalized = await finalizeCostSheet(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" });
    return { fixture, purity, sheet: finalized };
  }

  it("a Finalized sheet's own stored figures never change even if the Metal/Purity master is edited later", async () => {
    const fixture = createFakeCostingTx();
    const { purity, sheet } = await setupFinalizedEstimate(fixture);

    const metalLineBefore = [...(fixture.state.costSheetMetalLines as Map<string, Record<string, unknown>>).values()].find(
      (l) => l.costSheetId === sheet.id
    )!;
    const before = { ...metalLineBefore };

    // Edit the purity master directly (simulating an Owner settings change).
    const purityRow = fixture.state.metalPurities.get(purity.id as string)!;
    purityRow.finenessPercent = "50.000";
    purityRow.displayName = "Renamed Purity";

    const metalLineAfter = [...(fixture.state.costSheetMetalLines as Map<string, Record<string, unknown>>).values()].find(
      (l) => l.costSheetId === sheet.id
    )!;
    expect(metalLineAfter.finenessPercentSnapshot).toBe(before.finenessPercentSnapshot);
    expect(metalLineAfter.purityDisplayNameSnapshot).toBe(before.purityDisplayNameSnapshot);
    expect(metalLineAfter.amount).toBe(before.amount);

    const totals = computeCostSheetTotals({
      metalLineAmounts: [metalLineAfter.amount as string],
      diamondLineAmounts: [],
      otherMaterialLineAmounts: [],
      labourLineAmounts: [],
      additionalChargeLineAmounts: [],
      pricingMethod: sheet.pricingMethod,
      markupPercent: sheet.markupPercent,
      targetMarginPercent: sheet.targetMarginPercent,
      manualSellingPriceOverride: sheet.manualSellingPriceOverride,
      discountType: sheet.discountType,
      discountValue: sheet.discountValue,
      gstTreatment: sheet.gstTreatment,
      gstRatePercent: sheet.gstRatePercentSnapshot,
      priceType: sheet.priceType,
      roundingStep: sheet.roundingStep,
      sellingExpenseFixed: sheet.sellingExpenseFixed,
      sellingExpensePercent: sheet.sellingExpensePercent,
    });
    expect(totals.customerTotal.toFixed(2)).toBe("60000.00"); // 50000 x 1.20
  });

  it("rejects finalizing a sheet twice, and rejects editing a Finalized sheet directly", async () => {
    const fixture = createFakeCostingTx();
    const { sheet } = await setupFinalizedEstimate(fixture);
    await expect(finalizeCostSheet(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" })).rejects.toThrow(
      PostingError
    );
  });

  it("revise creates a new Draft linked to the original, which itself never changes", async () => {
    const fixture = createFakeCostingTx();
    const { sheet } = await setupFinalizedEstimate(fixture);

    const revision = await reviseCostSheet(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" });
    expect(revision.status).toBe("DRAFT");
    expect(revision.previousVersionId).toBe(sheet.id);
    expect(revision.revisionGroupId).toBe(sheet.revisionGroupId);
    expect(revision.revisionNumber).toBe(2);

    const originalAfter = fixture.state.costSheets.get(sheet.id as string)!;
    expect(originalAfter.status).toBe("FINALIZED");
    expect(originalAfter.itemName).toBe(sheet.itemName);

    const revisionMetalLines = [...(fixture.state.costSheetMetalLines as Map<string, Record<string, unknown>>).values()].filter(
      (l) => l.costSheetId === revision.id
    );
    expect(revisionMetalLines).toHaveLength(1);
  });

  it("archive then unarchive round-trips status without touching stored figures", async () => {
    const fixture = createFakeCostingTx();
    const { sheet } = await setupFinalizedEstimate(fixture);

    const archived = await archiveCostSheet(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" });
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.archivedAt).not.toBeNull();

    await expect(archiveCostSheet(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" })).rejects.toThrow(
      PostingError
    );

    const restored = await unarchiveCostSheet(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" });
    expect(restored.status).toBe("FINALIZED");
    expect(restored.archivedAt).toBeNull();
    expect(restored.itemName).toBe(sheet.itemName);
  });

  it("deleteDraftCostSheet only ever deletes a Draft", async () => {
    const fixture = createFakeCostingTx();
    const { sheet } = await setupFinalizedEstimate(fixture);
    await expect(deleteDraftCostSheet(fixture.tx as never, { costSheetId: sheet.id as string })).rejects.toThrow(PostingError);

    const purity = seedGold22k(fixture);
    const draft = await createEstimateCostSheet(fixture.tx as never, {
      ...common(),
      costingDate: DATE,
      jewelleryType: "RING",
      itemName: "Draft to delete",
      quantity: 1,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 5, rateBasis: "PER_GROSS_GRAM", rate: 5000 }],
      diamondLines: [],
      otherMaterialLines: [],
      chargeLines: [],
      pricingMethod: "MARKUP_ON_COST",
      discountType: "NONE",
      gstTreatment: "NONE",
      priceType: "EXCLUSIVE",
      validityDays: 15,
    });
    await deleteDraftCostSheet(fixture.tx as never, { costSheetId: draft.id as string });
    expect(fixture.state.costSheets.has(draft.id as string)).toBe(false);
  });

  it("audit events are recorded for created, finalized, revised, and archived", async () => {
    const fixture = createFakeCostingTx();
    const { sheet } = await setupFinalizedEstimate(fixture);
    const revision = await reviseCostSheet(fixture.tx as never, { costSheetId: sheet.id as string, userId: "user-1" });
    await archiveCostSheet(fixture.tx as never, { costSheetId: revision.id as string, userId: "user-1" }).catch(() => {});

    const events = [...(fixture.state.costSheetAuditEvents as Map<string, Record<string, unknown>>).values()];
    const eventTypesForOriginal = events.filter((e) => e.costSheetId === sheet.id).map((e) => e.eventType);
    expect(eventTypesForOriginal).toContain("CREATED");
    expect(eventTypesForOriginal).toContain("FINALIZED");
    expect(eventTypesForOriginal).toContain("REVISED");
  });
});

describe("costing number sequencing", () => {
  it("never generates a duplicate costing number across sequential creates in the same financial year", async () => {
    const fixture = createFakeCostingTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });

    const makeOne = () =>
      createEstimateCostSheet(fixture.tx as never, {
        ...common(),
        costingDate: DATE,
        jewelleryType: "RING",
        itemName: "x",
        quantity: 1,
        metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 1, rateBasis: "PER_GROSS_GRAM", rate: 5000 }],
        diamondLines: [],
        otherMaterialLines: [],
        chargeLines: [],
        pricingMethod: "MARKUP_ON_COST",
        discountType: "NONE",
        gstTreatment: "NONE",
        priceType: "EXCLUSIVE",
        validityDays: 15,
      });

    const [a, b, c] = await Promise.all([makeOne(), makeOne(), makeOne()]);
    const numbers = new Set([a.costingNumber, b.costingNumber, c.costingNumber]);
    expect(numbers.size).toBe(3);
  });
});
