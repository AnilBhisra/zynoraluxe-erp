import { describe, expect, it, vi } from "vitest";

// reports.ts (for pendingFineWeightOf) creates the Prisma client at module
// scope — same mock as src/lib/jewellery/reports.test.ts.
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { createFakeJewelleryTx } from "../../../test/fixtures/fakeJewelleryTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, ZERO } from "@/lib/accounting/money";
import {
  createJewelleryJob,
  createMetalPurchase,
  getMetalStockBalanceInTx,
  getScrapMetalBalanceInTx,
  issueMaterialsToJewelleryJob,
  PostingError,
  receiveFinishedJewellery,
  type FinishedOutputInput,
} from "./posting";
import { pendingFineWeightOf } from "./reports";

// Phase 7 P0 regression suite — metal stock semantics, 24K → 18K/14K/9K
// cross-purity outputs, Company / Karigar / Included alloy, and the
// receipt edge cases fixed alongside them. Every money figure is checked
// as an exact 2-decimal string and every weight as an exact 3-decimal
// string; debit = credit is checked exactly on every voucher.

type Fixture = ReturnType<typeof createFakeJewelleryTx>;
type ReceiveInput = Parameters<typeof receiveFinishedJewellery>[1];
type MetalTypeName = "GOLD" | "SILVER" | "PLATINUM" | "OTHER" | "ALLOY";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-15T00:00:00.000Z");

async function purchase(fixture: Fixture, purityId: string, grossWeight: number, totalPurchaseCost: number, metalType: MetalTypeName = "GOLD") {
  return createMetalPurchase(fixture.tx as never, {
    ...FY,
    currencyCode: "INR",
    exchangeRate: 1,
    createdByUserId: "user-1",
    purchaseDate: DATE,
    supplierId: "supplier-1",
    metalType,
    purityId,
    grossWeight,
    rateBasis: "PER_GROSS_GRAM",
    rate: totalPurchaseCost / grossWeight,
    totalPurchaseCost,
    gstTreatment: "NONE",
  });
}

async function issue(
  fixture: Fixture,
  metalLines: { purityId: string; grossWeight: number; metalType?: MetalTypeName }[],
  options: { polishedDiamondIds?: string[]; jobIdempotencyKey?: string; issueIdempotencyKey?: string } = {}
) {
  const job = await createJewelleryJob(fixture.tx as never, {
    karigarId: "karigar-1",
    jewelleryType: "RING",
    designName: "Phase 7 ring",
    issueDate: DATE,
    quantity: 1,
    idempotencyKey: options.jobIdempotencyKey,
    createdByUserId: "user-1",
  });
  return issueMaterialsToJewelleryJob(fixture.tx as never, {
    ...FY,
    jobId: job.id as string,
    issueDate: DATE,
    metalLines: metalLines.map((l) => ({ metalType: l.metalType ?? "GOLD", purityId: l.purityId, grossWeight: l.grossWeight })),
    polishedDiamondIds: options.polishedDiamondIds ?? [],
    otherMaterialLines: [],
    idempotencyKey: options.issueIdempotencyKey,
    createdByUserId: "user-1",
  });
}

function output(purityId: string, netMetalWeight: number, diamondIds: string[] = [], metalType: MetalTypeName = "GOLD"): FinishedOutputInput {
  return { jewelleryType: "RING", quantity: 1, netMetalWeight, metalType, purityId, diamondIds, qcStatus: "PASSED" };
}

function receiveArgs(jobId: string, overrides: Partial<ReceiveInput> = {}): ReceiveInput {
  return {
    ...FY,
    jobId,
    receiveDate: DATE,
    outputs: [],
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
    createdByUserId: "user-1",
    ...overrides,
  };
}

function receive(fixture: Fixture, jobId: string, overrides: Partial<ReceiveInput> = {}) {
  return receiveFinishedJewellery(fixture.tx as never, receiveArgs(jobId, overrides));
}

function accountId(fixture: Fixture, code: string) {
  return fixture.state.accounts.get(code)!.id;
}

/** Exact ledger balance (debit − credit) of one account, optionally for one party. */
function ledger(fixture: Fixture, code: string, partyId?: string): string {
  const id = accountId(fixture, code);
  return fixture.state.journalEntries
    .filter((e) => e.accountId === id && (partyId === undefined || e.partyId === partyId))
    .reduce((sum, e) => sum.plus(new Decimal(e.debit as string)).minus(new Decimal(e.credit as string)), ZERO)
    .toFixed(2);
}

/** Exact debit/credit line amount for one account inside one voucher. */
function voucherLine(fixture: Fixture, voucherId: string, code: string, side: "debit" | "credit"): string {
  const id = accountId(fixture, code);
  return fixture.state.journalEntries
    .filter((e) => e.voucherId === voucherId && e.accountId === id)
    .reduce((sum, e) => sum.plus(new Decimal(e[side] as string)), ZERO)
    .toFixed(2);
}

function expectEveryVoucherBalanced(fixture: Fixture) {
  for (const voucherId of fixture.state.vouchers.keys()) {
    const lines = fixture.state.journalEntries.filter((e) => e.voucherId === voucherId);
    const debit = lines.reduce((sum, e) => sum.plus(new Decimal(e.debit as string)), ZERO);
    const credit = lines.reduce((sum, e) => sum.plus(new Decimal(e.credit as string)), ZERO);
    expect(debit.toFixed(2)).toBe(credit.toFixed(2));
  }
}

function movements(fixture: Fixture) {
  return [...fixture.state.metalStockMovements.values()];
}

describe("metal stock semantics (audit §4.9 / §4.10)", () => {
  it("a receipt no longer drains the usable pool a second time — the next issue is costed at the real average", async () => {
    const fixture = createFakeJewelleryTx();
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    await purchase(fixture, k22.id, 20, 100000);
    const job = await issue(fixture, [{ purityId: k22.id, grossWeight: 10 }]);
    await receive(fixture, job.id as string, { outputs: [output(k22.id, 10)], markJobComplete: true });

    const pool = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", k22.id);
    expect(pool.grossWeight.toFixed(3)).toBe("10.000");
    expect(pool.fineWeight.toFixed(3)).toBe("9.160");
    expect(pool.costValue.toFixed(2)).toBe("50000.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY)).toBe("50000.00");

    const job2 = await issue(fixture, [{ purityId: k22.id, grossWeight: 10 }]);
    expect(new Decimal(job2.issuedMetalCost).toFixed(2)).toBe("50000.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY)).toBe("0.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("scrap lands in its own pool, ties to 1310, and can never be issued as ordinary stock", async () => {
    const fixture = createFakeJewelleryTx();
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    await purchase(fixture, k22.id, 20, 100000);
    const job = await issue(fixture, [{ purityId: k22.id, grossWeight: 10 }]);
    await receive(fixture, job.id as string, {
      outputs: [output(k22.id, 8)],
      scrapMetalLines: [{ purityId: k22.id, grossWeight: 1 }],
      markJobComplete: true,
    });

    const usable = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", k22.id);
    const scrap = await getScrapMetalBalanceInTx(fixture.tx as never, "GOLD", k22.id);
    expect(usable.grossWeight.toFixed(3)).toBe("10.000");
    expect(usable.costValue.toFixed(2)).toBe(ledger(fixture, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY));
    expect(scrap.grossWeight.toFixed(3)).toBe("1.000");
    expect(scrap.fineWeight.toFixed(3)).toBe("0.916");
    expect(scrap.costValue.toFixed(2)).toBe("5555.56");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.SCRAP_METAL_INVENTORY)).toBe("5555.56");

    await expect(issue(fixture, [{ purityId: k22.id, grossWeight: 11 }])).rejects.toThrow(/Not enough 22K stock/);
  });
});

describe("24K issue → lower-karat finished output (locked Phase 7 flow)", () => {
  async function setup24k(fineness: string, issueGrams: number, purchaseGrams: number, purchaseCost: number) {
    const fixture = createFakeJewelleryTx();
    const k24 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "24K", finenessPercent: fineness });
    const k18 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" });
    const k14 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "14K", finenessPercent: "58.500" });
    const k9 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "9K", finenessPercent: "37.500" });
    await purchase(fixture, k24.id, purchaseGrams, purchaseCost);
    const job = await issue(fixture, [{ purityId: k24.id, grossWeight: issueGrams }]);
    return { fixture, k24, k18, k14, k9, job };
  }

  it("locked example (24K at 100%): 10.000 g issued → 12.000 g of 18K = 9.000 g fine + 3.000 g alloy + 1.000 g loss", async () => {
    const { fixture, k24, k18, job } = await setup24k("100.000", 10, 20, 140000);
    expect(new Decimal(job.issuedMetalFineWeight).toFixed(3)).toBe("10.000");

    const result = await receive(fixture, job.id as string, {
      outputs: [output(k18.id, 12)],
      alloy: { includedGrossWeight: 3 },
      markJobComplete: true,
    });

    const finished = result.outputs[0];
    expect(finished.finenessPercentSnapshot).toBe("75.000");
    expect(finished.fineMetalWeight).toBe("9.000");
    expect(finished.alloyAddedWeight).toBe("3.000");
    expect(finished.sourcePurityDisplayNameSnapshot).toBe("24K");
    expect(finished.sourceFinenessPercentSnapshot).toBe("100.000");
    expect(finished.metalCost).toBe("70000.00");
    expect(result.receipt.processLossFineWeight).toBe("1.000");
    expect(result.receipt.includedAlloyGrossWeight).toBe("3.000");

    // Issued 24K fine + added fine = finished + returned + scrap + loss, exactly.
    const finalJob = fixture.state.jewelleryJobs.get(job.id as string)!;
    expect(finalJob.status).toBe("COMPLETED");
    expect(finalJob.remainingWipCost).toBe("0.00");
    expect(finalJob.receivedFineWeight).toBe("9.000");
    expect(pendingFineWeightOf(finalJob as never).toFixed(3)).toBe("1.000");

    const voucherId = result.receipt.postingVoucherId as string;
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "debit")).toBe("70000.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, "credit")).toBe("70000.00");
    expect(new Decimal(fixture.state.vouchers.get(voucherId)!.amount as string).toFixed(2)).toBe("70000.00");

    // Never a movement against the unissued 18K pool; consumption is posted against 24K.
    expect(movements(fixture).filter((m) => m.purityId === k18.id)).toHaveLength(0);
    const consumed = movements(fixture).filter((m) => m.type === "CONSUMED_OUT");
    expect(consumed.every((m) => m.purityId === k24.id)).toBe(true);
    expect(consumed.map((m) => m.fineWeight).sort()).toEqual(["1.000", "9.000"]);

    // The 24K pool still holds exactly the unissued 10 g — the receipt never touches it.
    const pool = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", k24.id);
    expect(pool.grossWeight.toFixed(3)).toBe("10.000");
    expect(pool.costValue.toFixed(2)).toBe("70000.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY)).toBe("70000.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("the same example with the seeded 99.9% 24K: 9.990 g fine issued, 2.991 g alloy, 0.990 g loss", async () => {
    const { fixture, k18, job } = await setup24k("99.900", 10, 20, 140000);
    expect(new Decimal(job.issuedMetalFineWeight).toFixed(3)).toBe("9.990");

    await expect(
      receive(fixture, job.id as string, { outputs: [output(k18.id, 12)], alloy: { includedGrossWeight: 3 }, markJobComplete: true })
    ).rejects.toThrow(/2\.991g of Alloy Added/);

    const result = await receive(fixture, job.id as string, {
      outputs: [output(k18.id, 12)],
      alloy: { includedGrossWeight: 2.991 },
      markJobComplete: true,
    });
    expect(result.outputs[0].fineMetalWeight).toBe("9.000");
    expect(result.outputs[0].alloyAddedWeight).toBe("2.991");
    expect(result.receipt.processLossFineWeight).toBe("0.990");
    expectEveryVoucherBalanced(fixture);
  });

  it("18K, 14K and 9K outputs from one 24K issue, across a partial and a final receipt, reconcile to the gram and the paisa", async () => {
    const { fixture, k24, k18, k14, k9, job } = await setup24k("100.000", 20, 30, 210000);
    const jobId = job.id as string;

    const first = await receive(fixture, jobId, {
      outputs: [output(k18.id, 6), output(k14.id, 4), output(k9.id, 4)],
      alloy: { includedGrossWeight: 5.66 },
    });
    expect(first.outputs.map((o) => o.fineMetalWeight)).toEqual(["4.500", "2.340", "1.500"]);
    expect(first.outputs.map((o) => o.alloyAddedWeight)).toEqual(["1.500", "1.660", "2.500"]);
    expect(first.outputs.map((o) => o.finenessPercentSnapshot)).toEqual(["75.000", "58.500", "37.500"]);
    const firstMetal = first.outputs.reduce((sum, o) => sum.plus(new Decimal(o.metalCost)), ZERO);
    expect(firstMetal.toFixed(2)).toBe("58380.00");
    expect(fixture.state.jewelleryJobs.get(jobId)!.status).toBe("PARTIALLY_RECEIVED");
    expect(fixture.state.jewelleryJobs.get(jobId)!.remainingWipCost).toBe("81620.00");
    expect(first.receipt.processLossFineWeight).toBe("0.000");

    const second = await receive(fixture, jobId, {
      outputs: [output(k18.id, 10)],
      alloy: { includedGrossWeight: 2.5 },
      returnedMetalLines: [{ purityId: k24.id, grossWeight: 3 }],
      markJobComplete: true,
    });
    const voucherId = second.receipt.postingVoucherId as string;
    expect(second.receipt.processLossFineWeight).toBe("1.160");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "debit")).toBe("58300.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY, "debit")).toBe("23320.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, "credit")).toBe("81620.00");

    const finalJob = fixture.state.jewelleryJobs.get(jobId)!;
    expect(finalJob.status).toBe("COMPLETED");
    expect(finalJob.remainingWipCost).toBe("0.00");
    // 20.000 issued = 15.840 finished + 3.000 returned + 0 scrap + 1.160 loss
    expect(finalJob.receivedFineWeight).toBe("15.840");
    expect(finalJob.returnedMetalFineWeight).toBe("3.000");
    expect(pendingFineWeightOf(finalJob as never).toFixed(3)).toBe("1.160");

    for (const lowerKarat of [k18, k14, k9]) {
      expect(movements(fixture).filter((m) => m.purityId === lowerKarat.id)).toHaveLength(0);
    }
    const pool = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", k24.id);
    expect(pool.grossWeight.toFixed(3)).toBe("13.000");
    expect(pool.costValue.toFixed(2)).toBe("93320.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY)).toBe("93320.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("keeps the output's fineness snapshot when the purity master is edited afterwards", async () => {
    const { fixture, k18, job } = await setup24k("100.000", 10, 20, 140000);
    const result = await receive(fixture, job.id as string, {
      outputs: [output(k18.id, 12)],
      alloy: { includedGrossWeight: 3 },
      markJobComplete: true,
    });
    fixture.state.metalPurities.get(k18.id)!.finenessPercent = "70.000";
    const stored = fixture.state.finishedJewelleryRows.get(result.outputs[0].id as string)!;
    expect(stored.finenessPercentSnapshot).toBe("75.000");
    expect(stored.fineMetalWeight).toBe("9.000");
  });

  it("rejects a final purity finer than the issued metal", async () => {
    const fixture = createFakeJewelleryTx();
    const k18 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" });
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    await purchase(fixture, k18.id, 20, 60000);
    const job = await issue(fixture, [{ purityId: k18.id, grossWeight: 10 }]);
    await expect(receive(fixture, job.id as string, { outputs: [output(k22.id, 5)] })).rejects.toThrow(/finer than the issued metal/);
    expect(movements(fixture).filter((m) => m.purityId === k22.id)).toHaveLength(0);
  });

  it("keeps the Phase 4 restriction for a job that issued two gold purities", async () => {
    const fixture = createFakeJewelleryTx();
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    const k18 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" });
    const k14 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "14K", finenessPercent: "58.500" });
    await purchase(fixture, k22.id, 20, 100000);
    await purchase(fixture, k18.id, 20, 60000);
    const job = await issue(fixture, [
      { purityId: k22.id, grossWeight: 10 },
      { purityId: k18.id, grossWeight: 10 },
    ]);
    await expect(receive(fixture, job.id as string, { outputs: [output(k14.id, 5)] })).rejects.toThrow(
      /must be one of the purities issued/
    );
  });

  it("rejects an inactive final purity and an output recorded as Copper/Alloy", async () => {
    const { fixture, job } = await setup24k("100.000", 10, 20, 140000);
    const retired = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "20K", finenessPercent: "83.300", isActive: false });
    await expect(receive(fixture, job.id as string, { outputs: [output(retired.id, 5)] })).rejects.toThrow(/inactive/);
    const copper = fixture.seedMetalPurity({ metalType: "ALLOY", displayName: "Copper/Alloy", finenessPercent: "0.000" });
    await expect(receive(fixture, job.id as string, { outputs: [output(copper.id, 5, [], "ALLOY")] })).rejects.toThrow(
      /cannot be recorded as Copper\/Alloy/
    );
  });

  it("the existing same-purity flow is unchanged: no alloy, no split required", async () => {
    const fixture = createFakeJewelleryTx();
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    await purchase(fixture, k22.id, 20, 100000);
    const job = await issue(fixture, [{ purityId: k22.id, grossWeight: 10 }]);
    const result = await receive(fixture, job.id as string, { outputs: [output(k22.id, 9)], markJobComplete: true });
    expect(result.outputs[0].alloyAddedWeight).toBe("0.000");
    expect(result.outputs[0].fineMetalWeight).toBe("8.244");
    expect(result.outputs[0].sourcePurityDisplayNameSnapshot).toBe("22K");
    expect(result.outputs[0].metalCost).toBe("50000.00");
  });
});

describe("Copper/Alloy sources", () => {
  async function setupWithCompanyAlloy() {
    const fixture = createFakeJewelleryTx();
    const k24 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "24K", finenessPercent: "100.000" });
    const k18 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" });
    const copper = fixture.seedMetalPurity({ metalType: "ALLOY", displayName: "Copper/Alloy", finenessPercent: "0.000" });
    await purchase(fixture, k24.id, 20, 140000);
    await purchase(fixture, copper.id, 50, 50000, "ALLOY");
    const job = await issue(fixture, [
      { purityId: k24.id, grossWeight: 10 },
      { purityId: copper.id, grossWeight: 5, metalType: "ALLOY" },
    ]);
    return { fixture, k24, k18, copper, job };
  }

  it("issues Company alloy into its own pool — never into the fine-weight WIP pool", async () => {
    const { job } = await setupWithCompanyAlloy();
    expect(job.issuedMetalFineWeight).toBe("10.000");
    expect(job.issuedMetalCost).toBe("75000.00");
    expect(job.remainingWipCost).toBe("70000.00");
    expect(job.issuedAlloyGrossWeight).toBe("5.000");
    expect(job.remainingAlloyWipCost).toBe("5000.00");
  });

  it("consumes Company alloy, returns the unused part to stock, absorbs normal alloy loss — and 1300 ties to both pools", async () => {
    const { fixture, k24, k18, copper, job } = await setupWithCompanyAlloy();
    const result = await receive(fixture, job.id as string, {
      outputs: [output(k18.id, 12)],
      alloy: { companyGrossWeight: 3 },
      returnedMetalLines: [{ purityId: copper.id, grossWeight: 1.5 }],
      markJobComplete: true,
    });

    const voucherId = result.receipt.postingVoucherId as string;
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "debit")).toBe("73500.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY, "debit")).toBe("1500.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, "credit")).toBe("75000.00");
    expect(result.outputs[0].metalCost).toBe("73500.00");
    expect(result.outputs[0].alloyCost).toBe("3500.00");
    expect(result.receipt.companyAlloyCost).toBe("3500.00");
    expect(result.receipt.alloyLossGrossWeight).toBe("0.500");

    const alloyMovements = movements(fixture).filter((m) => m.purityId === copper.id && m.sourceDocument === result.receipt.receiptCode);
    expect(alloyMovements.find((m) => m.type === "RETURN_IN")).toMatchObject({ grossWeight: "1.500", fineWeight: "0.000", costValue: "1500.00" });
    expect(alloyMovements.find((m) => m.type === "CONSUMED_OUT")).toMatchObject({ grossWeight: "3.500", costValue: "3500.00" });

    const finalJob = fixture.state.jewelleryJobs.get(job.id as string)!;
    expect(finalJob.status).toBe("COMPLETED");
    expect(finalJob.remainingAlloyWipCost).toBe("0.00");
    expect(finalJob.consumedAlloyGrossWeight).toBe("3.500");
    expect(finalJob.returnedAlloyGrossWeight).toBe("1.500");

    const copperPool = await getMetalStockBalanceInTx(fixture.tx as never, "ALLOY", copper.id);
    const goldPool = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", k24.id);
    expect(copperPool.grossWeight.toFixed(3)).toBe("46.500");
    expect(copperPool.costValue.toFixed(2)).toBe("46500.00");
    expect(copperPool.costValue.plus(goldPool.costValue).toFixed(2)).toBe(ledger(fixture, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY));
    expectEveryVoucherBalanced(fixture);
  });

  it("Owner abnormal loss carves both the gold and the alloy loss out to Business Expenses", async () => {
    const { fixture, k18, job } = await setupWithCompanyAlloy();
    const result = await receive(fixture, job.id as string, {
      outputs: [output(k18.id, 12)],
      alloy: { companyGrossWeight: 3 },
      markJobComplete: true,
      isAbnormalLoss: true,
      abnormalLossReason: "Karigar reported a melt spill",
    });
    const voucherId = result.receipt.postingVoucherId as string;
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, "debit")).toBe("9000.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "debit")).toBe("66000.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, "credit")).toBe("75000.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("posts a Karigar-added alloy charge exactly once, into the finished piece and his payable", async () => {
    const fixture = createFakeJewelleryTx();
    const k24 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "24K", finenessPercent: "100.000" });
    const k18 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" });
    await purchase(fixture, k24.id, 20, 140000);
    const job = await issue(fixture, [{ purityId: k24.id, grossWeight: 10 }]);

    const first = await receive(fixture, job.id as string, {
      outputs: [output(k18.id, 12)],
      alloy: { karigarGrossWeight: 3, karigarCost: 900 },
      labourCharge: 1000,
    });
    const firstVoucher = first.receipt.postingVoucherId as string;
    expect(voucherLine(fixture, firstVoucher, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "debit")).toBe("64900.00");
    expect(voucherLine(fixture, firstVoucher, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, "credit")).toBe("1900.00");
    expect(first.outputs[0].metalCost).toBe("63900.00");
    expect(first.outputs[0].alloyCost).toBe("900.00");
    expect(first.outputs[0].labourAllocated).toBe("1000.00");

    await receive(fixture, job.id as string, {
      returnedMetalLines: [{ purityId: k24.id, grossWeight: 0.5 }],
      markJobComplete: true,
    });
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, "karigar-1")).toBe("-1900.00");
    expect(fixture.state.jewelleryJobs.get(job.id as string)!.status).toBe("COMPLETED");
    expectEveryVoucherBalanced(fixture);
  });

  it("rejects alloy the split does not account for, alloy scrap, Company alloy that was never issued, and over-use", async () => {
    const { fixture, k18, copper, job } = await setupWithCompanyAlloy();
    const jobId = job.id as string;
    await expect(receive(fixture, jobId, { outputs: [output(k18.id, 12)], alloy: { companyGrossWeight: 2 } })).rejects.toThrow(
      /3\.000g of Alloy Added/
    );
    await expect(
      receive(fixture, jobId, { outputs: [output(k18.id, 12)], alloy: { includedGrossWeight: 3 }, scrapMetalLines: [{ purityId: copper.id, grossWeight: 1 }] })
    ).rejects.toThrow(/cannot be returned as scrap/);
    await expect(
      receive(fixture, jobId, {
        outputs: [output(k18.id, 12)],
        alloy: { companyGrossWeight: 3 },
        returnedMetalLines: [{ purityId: copper.id, grossWeight: 2.5 }],
      })
    ).rejects.toThrow(/exceeds the 5\.000g of Company Copper\/Alloy/);
    await expect(
      receive(fixture, jobId, { outputs: [output(k18.id, 12)], alloy: { karigarGrossWeight: 0, includedGrossWeight: 3, karigarCost: 100 } })
    ).rejects.toThrow(/needs a Karigar-added alloy weight/);

    const plain = createFakeJewelleryTx();
    const k24 = plain.seedMetalPurity({ metalType: "GOLD", displayName: "24K", finenessPercent: "100.000" });
    const plain18 = plain.seedMetalPurity({ metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" });
    await purchase(plain, k24.id, 20, 140000);
    const plainJob = await issue(plain, [{ purityId: k24.id, grossWeight: 10 }]);
    await expect(receive(plain, plainJob.id as string, { outputs: [output(plain18.id, 12)], alloy: { companyGrossWeight: 3 } })).rejects.toThrow(
      /No Company Copper\/Alloy was issued/
    );
  });

  it("allows only one Copper/Alloy purity per job", async () => {
    const fixture = createFakeJewelleryTx();
    const copper = fixture.seedMetalPurity({ metalType: "ALLOY", displayName: "Copper/Alloy", finenessPercent: "0.000" });
    const brass = fixture.seedMetalPurity({ metalType: "ALLOY", displayName: "Silver alloy", finenessPercent: "0.000" });
    await purchase(fixture, copper.id, 10, 10000, "ALLOY");
    await purchase(fixture, brass.id, 10, 10000, "ALLOY");
    await expect(
      issue(fixture, [
        { purityId: copper.id, grossWeight: 1, metalType: "ALLOY" },
        { purityId: brass.id, grossWeight: 1, metalType: "ALLOY" },
      ])
    ).rejects.toThrow(/one alloy purity per job/);
  });
});

describe("receipt edge cases fixed in Phase 7", () => {
  it("a no-output final receipt with an abnormal loss now posts (it used to be unbalanced) and leaves nothing in Finished Inventory", async () => {
    const fixture = createFakeJewelleryTx();
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    await purchase(fixture, k22.id, 20, 100000);
    const job = await issue(fixture, [{ purityId: k22.id, grossWeight: 10 }]);
    await receive(fixture, job.id as string, { outputs: [output(k22.id, 5)] });

    const final = await receive(fixture, job.id as string, {
      returnedMetalLines: [{ purityId: k22.id, grossWeight: 4 }],
      scrapMetalLines: [{ purityId: k22.id, grossWeight: 0.5 }],
      markJobComplete: true,
      isAbnormalLoss: true,
      abnormalLossReason: "Lost during final return",
    });
    const voucherId = final.receipt.postingVoucherId as string;
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "debit")).toBe("0.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY, "debit")).toBe("20000.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.SCRAP_METAL_INVENTORY, "debit")).toBe("2500.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, "debit")).toBe("2500.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, "credit")).toBe("25000.00");
    expect(fixture.state.jewelleryJobs.get(job.id as string)!.remainingWipCost).toBe("0.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("charges on a receipt with no finished output are expensed, not parked in Finished Inventory", async () => {
    const fixture = createFakeJewelleryTx();
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    await purchase(fixture, k22.id, 20, 100000);
    const job = await issue(fixture, [{ purityId: k22.id, grossWeight: 10 }]);
    const result = await receive(fixture, job.id as string, {
      returnedMetalLines: [{ purityId: k22.id, grossWeight: 2 }],
      labourCharge: 500,
    });
    const voucherId = result.receipt.postingVoucherId as string;
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "debit")).toBe("0.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, "debit")).toBe("500.00");
    expect(voucherLine(fixture, voucherId, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, "credit")).toBe("500.00");
    expect(result.receipt.unabsorbedCost).toBe("500.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("a receipt that only returns a diamond gets a positive voucher amount (the DB requires amount > 0)", async () => {
    const fixture = createFakeJewelleryTx();
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    await purchase(fixture, k22.id, 20, 100000);
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-POL-TEST-1", shape: "ROUND", carat: "0.500", allocatedCost: "10000.00" });
    const job = await issue(fixture, [{ purityId: k22.id, grossWeight: 10 }], { polishedDiamondIds: [diamond.id] });
    const result = await receive(fixture, job.id as string, {
      diamondResolutions: [{ polishedDiamondId: diamond.id, resolution: "RETURNED" }],
    });
    expect(new Decimal(fixture.state.vouchers.get(result.receipt.postingVoucherId as string)!.amount as string).toFixed(2)).toBe(
      "10000.00"
    );
    expectEveryVoucherBalanced(fixture);
  });

  it("issuing materials keeps the job's own create-time idempotency key (audit §4.18)", async () => {
    const fixture = createFakeJewelleryTx();
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    await purchase(fixture, k22.id, 20, 100000);
    const job = await issue(fixture, [{ purityId: k22.id, grossWeight: 10 }], {
      jobIdempotencyKey: "create-job-key",
      issueIdempotencyKey: "issue-key",
    });
    expect(job.idempotencyKey).toBe("create-job-key");
  });

  it("rejects receiving against an unissued purity with no PostingError leak into other pools", async () => {
    const fixture = createFakeJewelleryTx();
    const k22 = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
    const platinum = fixture.seedMetalPurity({ metalType: "PLATINUM", displayName: "950 Platinum", finenessPercent: "95.000" });
    await purchase(fixture, k22.id, 20, 100000);
    const job = await issue(fixture, [{ purityId: k22.id, grossWeight: 10 }]);
    await expect(receive(fixture, job.id as string, { outputs: [output(platinum.id, 5, [], "PLATINUM")] })).rejects.toThrow(PostingError);
    expect(movements(fixture).filter((m) => m.purityId === platinum.id)).toHaveLength(0);
  });
});
