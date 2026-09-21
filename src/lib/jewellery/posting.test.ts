import { describe, expect, it } from "vitest";

import { createFakeJewelleryTx } from "../../../test/fixtures/fakeJewelleryTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import {
  adjustMetalStock,
  cancelJewelleryJob,
  createJewelleryJob,
  createMetalPurchase,
  getMetalStockBalanceInTx,
  issueMaterialsToJewelleryJob,
  markJewelleryJobInProgress,
  overrideFinishedJewelleryAllocation,
  postOpeningMetalStock,
  PostingError,
  receiveFinishedJewellery,
  setJewelleryJobNeedsCorrection,
} from "./posting";

type Fixture = ReturnType<typeof createFakeJewelleryTx>;

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-06-15T00:00:00.000Z");

function common(overrides: Partial<Record<string, unknown>> = {}) {
  return { ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: "user-1", ...overrides };
}

function linesFor(fixture: Fixture, voucherId: string) {
  return fixture.state.journalEntries.filter((e) => e.voucherId === voucherId);
}
function sumBy<K extends string>(lines: Record<string, unknown>[], key: K) {
  return lines.reduce((sum, l) => sum + Number(l[key]), 0);
}
function codeOf(fixture: Fixture, accountId: unknown) {
  for (const [code, row] of fixture.state.accounts) {
    if (row.id === accountId) return code;
  }
  return undefined;
}
function lineFor(fixture: Fixture, voucherId: string, code: string) {
  return linesFor(fixture, voucherId).find((l) => codeOf(fixture, l.accountId) === code);
}

function seedGold22k(fixture: Fixture) {
  return fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" });
}
function seedGold18k(fixture: Fixture) {
  return fixture.seedMetalPurity({ metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" });
}

async function purchaseMetal(
  fixture: Fixture,
  purityId: string,
  opts: { grossWeight: number; totalPurchaseCost: number; supplierId?: string; paymentAccountId?: string }
) {
  return createMetalPurchase(fixture.tx as never, {
    ...common(),
    purchaseDate: DATE,
    supplierId: opts.supplierId ?? "supplier-1",
    metalType: "GOLD",
    purityId,
    grossWeight: opts.grossWeight,
    rateBasis: "PER_GROSS_GRAM",
    rate: opts.totalPurchaseCost / opts.grossWeight,
    totalPurchaseCost: opts.totalPurchaseCost,
    gstTreatment: "NONE",
    paymentAccountId: opts.paymentAccountId,
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

describe("createMetalPurchase", () => {
  it("computes fine weight from the purity's fineness percentage and posts a balanced purchase voucher", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);

    const purchase = await purchaseMetal(fixture, purity.id as string, { grossWeight: 100, totalPurchaseCost: 500000 });

    expect(purchase.grossWeight.toString()).toBe("100.000");
    expect(purchase.fineWeight.toString()).toBe("91.600");

    const lines = linesFor(fixture, purchase.voucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(Number(lineFor(fixture, purchase.voucherId as string, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY)?.debit)).toBe(500000);
    expect(Number(lineFor(fixture, purchase.voucherId as string, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE)?.credit)).toBe(500000);

    const movement = [...fixture.state.metalStockMovements.values()].find((m) => m.type === "PURCHASE_IN");
    expect(Number(movement?.grossWeight)).toBe(100);
    expect(Number(movement?.fineWeight)).toBe(91.6);
  });

  it("supports PER_FINE_GRAM and FIXED_TOTAL rate bases as stored reference fields (totalPurchaseCost is always authoritative)", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);

    const perFine = await createMetalPurchase(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      metalType: "GOLD",
      purityId: purity.id as string,
      grossWeight: 10,
      rateBasis: "PER_FINE_GRAM",
      rate: 6000,
      totalPurchaseCost: 54960, // 9.16 fine grams * 6000
      gstTreatment: "NONE",
    });
    expect(perFine.rateBasis).toBe("PER_FINE_GRAM");
    expect(Number(perFine.totalPurchaseCost)).toBe(54960);

    const fixedTotal = await createMetalPurchase(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      metalType: "GOLD",
      purityId: purity.id as string,
      grossWeight: 5,
      rateBasis: "FIXED_TOTAL",
      rate: 25000,
      totalPurchaseCost: 25000,
      gstTreatment: "NONE",
    });
    expect(fixedTotal.rateBasis).toBe("FIXED_TOTAL");
    expect(Number(fixedTotal.totalPurchaseCost)).toBe(25000);
  });

  it("posts CGST+SGST input tax and a payable that includes tax", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);

    const purchase = await createMetalPurchase(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      metalType: "GOLD",
      purityId: purity.id as string,
      grossWeight: 10,
      rateBasis: "PER_GROSS_GRAM",
      rate: 5000,
      totalPurchaseCost: 50000,
      gstTreatment: "CGST_SGST",
      gstRatePercent: 3,
    });

    const lines = linesFor(fixture, purchase.voucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(Number(lineFor(fixture, purchase.voucherId as string, SYSTEM_ACCOUNT_CODES.INPUT_CGST)?.debit)).toBe(750);
    expect(Number(lineFor(fixture, purchase.voucherId as string, SYSTEM_ACCOUNT_CODES.INPUT_SGST)?.debit)).toBe(750);
    expect(Number(lineFor(fixture, purchase.voucherId as string, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE)?.credit)).toBe(51500);
  });

  it("settles immediately via a payment account, netting Accounts Payable to zero", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;

    const purchase = await purchaseMetal(fixture, purity.id as string, {
      grossWeight: 10,
      totalPurchaseCost: 50000,
      paymentAccountId: cashId,
    });

    const lines = linesFor(fixture, purchase.voucherId as string);
    const apLines = lines.filter((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE);
    expect(sumBy(apLines, "debit") - sumBy(apLines, "credit")).toBe(0);
    expect(Number(lineFor(fixture, purchase.voucherId as string, "1001")?.credit)).toBe(50000);
  });

  it("rejects a zero gross weight", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await expect(purchaseMetal(fixture, purity.id as string, { grossWeight: 0, totalPurchaseCost: 1000 })).rejects.toThrow(
      PostingError
    );
  });

  it("rejects a zero total purchase cost", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await expect(purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 0 })).rejects.toThrow(
      PostingError
    );
  });
});

describe("getMetalStockBalanceInTx / metal stock ledger", () => {
  it("derives the balance purely from immutable movements — never a manually editable figure", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 100, totalPurchaseCost: 500000 });

    const balance = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", purity.id as string);
    expect(balance.grossWeight.toFixed(3)).toBe("100.000");
    expect(balance.fineWeight.toFixed(3)).toBe("91.600");
    expect(Number(balance.costValue)).toBe(500000);
  });
});

describe("postOpeningMetalStock", () => {
  it("records opening stock as an OPENING_IN movement with fine weight computed from the purity", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);

    await postOpeningMetalStock(fixture.tx as never, {
      metalType: "GOLD",
      purityId: purity.id as string,
      grossWeight: 50,
      costValue: 250000,
      fyStartMonth: 4,
      fyStartDay: 1,
      createdByUserId: "owner-1",
    });

    const balance = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", purity.id as string);
    expect(balance.grossWeight.toFixed(3)).toBe("50.000");
    expect(balance.fineWeight.toFixed(3)).toBe("45.800");
  });

  it("rejects a zero opening gross weight", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await expect(
      postOpeningMetalStock(fixture.tx as never, {
        metalType: "GOLD",
        purityId: purity.id as string,
        grossWeight: 0,
        costValue: 0,
        fyStartMonth: 4,
        fyStartDay: 1,
        createdByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("adjustMetalStock", () => {
  it("posts an authorized ADJUSTMENT_IN freely", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);

    await adjustMetalStock(fixture.tx as never, {
      metalType: "GOLD",
      purityId: purity.id as string,
      direction: "IN",
      grossWeight: 10,
      costValue: 50000,
      reason: "Physical count found extra stock",
      createdByUserId: "owner-1",
    });

    const balance = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", purity.id as string);
    expect(balance.grossWeight.toFixed(3)).toBe("10.000");
  });

  it("prevents an ADJUSTMENT_OUT that would drive stock negative", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);

    await expect(
      adjustMetalStock(fixture.tx as never, {
        metalType: "GOLD",
        purityId: purity.id as string,
        direction: "OUT",
        grossWeight: 5,
        costValue: 0,
        reason: "Correcting a count error",
        createdByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });

  it("requires a reason", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await expect(
      adjustMetalStock(fixture.tx as never, {
        metalType: "GOLD",
        purityId: purity.id as string,
        direction: "IN",
        grossWeight: 5,
        costValue: 0,
        reason: "",
        createdByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("createJewelleryJob", () => {
  it("creates a Draft job with a unique, human-readable ZL-JJOB- code and no accounting/stock impact", async () => {
    const fixture = createFakeJewelleryTx();
    const job = await createDraftJob(fixture);

    expect(job.status).toBe("DRAFT");
    expect(job.jobCode).toMatch(/^ZL-JJOB-\d{4}-\d{6}$/);
    expect(fixture.state.journalEntries).toHaveLength(0);
  });

  it("allocates sequential, distinct job codes for successive jobs (concurrency-safe numbering)", async () => {
    const fixture = createFakeJewelleryTx();
    const first = await createDraftJob(fixture);
    const second = await createDraftJob(fixture);
    expect(first.jobCode).not.toBe(second.jobCode);
    const firstNum = Number((first.jobCode as string).split("-").pop());
    const secondNum = Number((second.jobCode as string).split("-").pop());
    expect(secondNum).toBe(firstNum + 1);
  });

  it("rejects a quantity below 1", async () => {
    const fixture = createFakeJewelleryTx();
    await expect(
      createJewelleryJob(fixture.tx as never, {
        karigarId: "karigar-1",
        jewelleryType: "RING",
        designName: "Bad job",
        issueDate: DATE,
        quantity: 0,
        createdByUserId: "user-1",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("issueMaterialsToJewelleryJob", () => {
  it("issues a single metal line, computing fine weight and posting a balanced WIP transfer", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 100, totalPurchaseCost: 500000 });
    const job = await createDraftJob(fixture);

    const updated = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });

    expect(updated.status).toBe("MATERIALS_ISSUED");
    expect(Number(updated.issuedMetalFineWeight)).toBeCloseTo(9.16, 3);
    expect(Number(updated.issuedMetalCost)).toBeCloseTo(50000, 2);
    expect(Number(updated.remainingWipCost)).toBeCloseTo(50000, 2);

    const lines = linesFor(fixture, updated.wipVoucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(Number(lineFor(fixture, updated.wipVoucherId as string, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP)?.debit)).toBeCloseTo(50000, 2);
    expect(Number(lineFor(fixture, updated.wipVoucherId as string, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY)?.credit)).toBeCloseTo(
      50000,
      2
    );

    const balanceAfter = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", purity.id as string);
    expect(balanceAfter.grossWeight.toFixed(3)).toBe("90.000");
  });

  it("issues multiple metal lines across different purities, summing fine weight/cost correctly (mixed-purity issue)", async () => {
    const fixture = createFakeJewelleryTx();
    const gold22 = seedGold22k(fixture);
    const gold18 = seedGold18k(fixture);
    await purchaseMetal(fixture, gold22.id as string, { grossWeight: 50, totalPurchaseCost: 250000 });
    await purchaseMetal(fixture, gold18.id as string, { grossWeight: 50, totalPurchaseCost: 200000 });
    const job = await createDraftJob(fixture);

    const updated = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [
        { metalType: "GOLD", purityId: gold22.id as string, grossWeight: 10 }, // 9.16 fine
        { metalType: "GOLD", purityId: gold18.id as string, grossWeight: 10 }, // 7.50 fine
      ],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });

    expect(Number(updated.issuedMetalFineWeight)).toBeCloseTo(16.66, 3);
    const metalLines = [...fixture.state.jewelleryMetalIssueLines.values()].filter((l) => l.jobId === job.id);
    expect(metalLines).toHaveLength(2);
  });

  it("prevents issuing more metal than is currently in stock (negative-stock prevention)", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 5, totalPurchaseCost: 25000 });
    const job = await createDraftJob(fixture);

    await expect(
      issueMaterialsToJewelleryJob(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        issueDate: DATE,
        metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
        polishedDiamondIds: [],
        otherMaterialLines: [],
      })
    ).rejects.toThrow(PostingError);
  });

  it("zero-balance purity edge case: after draining a purity to exactly zero, issuing without replenishment is rejected, and a real replenishment makes it fully usable again", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
    const job1 = await createDraftJob(fixture);

    // Drain the purity to EXACTLY zero.
    await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job1.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 20 }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });
    const drained = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", purity.id as string);
    expect(drained.grossWeight.toFixed(3)).toBe("0.000");
    expect(drained.costValue.toFixed(2)).toBe("0.00");

    // Attempting to issue from a zero balance, with NO replenishment, must
    // be rejected — this is correct guard behaviour, not a bug.
    const job2 = await createDraftJob(fixture);
    await expect(
      issueMaterialsToJewelleryJob(fixture.tx as never, {
        ...common(),
        jobId: job2.id as string,
        issueDate: DATE,
        metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 5 }],
        polishedDiamondIds: [],
        otherMaterialLines: [],
      })
    ).rejects.toThrow(PostingError);

    // A REAL replenishment of the SAME purity must make it fully usable
    // again — this is the specific case that must NOT be rejected.
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 55000 });
    const replenished = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", purity.id as string);
    expect(replenished.grossWeight.toFixed(3)).toBe("10.000");
    expect(replenished.costValue.toFixed(2)).toBe("55000.00");

    const job3 = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job3.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });
    expect(issued.status).toBe("MATERIALS_ISSUED");
    expect(Number(issued.issuedMetalCost)).toBeCloseTo(55000, 2);
  });

  it("issues a Phase 3 AVAILABLE polished diamond using its own allocatedCost, marking it Issued to Jewellery", async () => {
    const fixture = createFakeJewelleryTx();
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-P-000001", shape: "ROUND", carat: "0.5", allocatedCost: "8000" });
    const job = await createDraftJob(fixture);

    const updated = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [],
      polishedDiamondIds: [diamond.id as string],
      otherMaterialLines: [],
    });

    expect(Number(updated.issuedDiamondCost)).toBe(8000);
    expect(fixture.state.polishedDiamonds.get(diamond.id as string)!.status).toBe("ISSUED_TO_JEWELLERY");
    const issueLine = [...fixture.state.jewelleryDiamondIssueLines.values()].find((l) => l.jobId === job.id);
    expect(Number(issueLine!.costAtIssue)).toBe(8000);

    expect(Number(lineFor(fixture, updated.wipVoucherId as string, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)?.credit)).toBe(
      8000
    );
  });

  it("rejects issuing a polished diamond that is not Available (double-issue prevention)", async () => {
    const fixture = createFakeJewelleryTx();
    const diamond = fixture.seedPolishedDiamond({
      polishedCode: "ZL-P-000002",
      shape: "ROUND",
      carat: "0.5",
      allocatedCost: "8000",
      status: "ISSUED_TO_JEWELLERY",
    });
    const job = await createDraftJob(fixture);

    await expect(
      issueMaterialsToJewelleryJob(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        issueDate: DATE,
        metalLines: [],
        polishedDiamondIds: [diamond.id as string],
        otherMaterialLines: [],
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects selecting the same polished diamond twice in one issue", async () => {
    const fixture = createFakeJewelleryTx();
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-P-000003", shape: "ROUND", carat: "0.5", allocatedCost: "8000" });
    const job = await createDraftJob(fixture);

    await expect(
      issueMaterialsToJewelleryJob(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        issueDate: DATE,
        metalLines: [],
        polishedDiamondIds: [diamond.id as string, diamond.id as string],
        otherMaterialLines: [],
      })
    ).rejects.toThrow(PostingError);
  });

  it("records other-material lines for job-cost display without any accounting or stock impact", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 50000 });
    const job = await createDraftJob(fixture);

    const updated = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 5 }],
      polishedDiamondIds: [],
      otherMaterialLines: [{ description: "Alloy", quantity: 2, unit: "GRAM", cost: 100 }],
    });

    expect(Number(updated.otherMaterialCost)).toBe(100);
    const lines = linesFor(fixture, updated.wipVoucherId as string);
    // Only metal touches the ledger — other material never gets its own Dr/Cr line.
    expect(sumBy(lines, "debit")).toBeCloseTo(25000, 2);
  });

  it("rejects issuing materials twice for the same job (one-time issuance)", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 50000 });
    const job = await createDraftJob(fixture);

    await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 5 }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });

    await expect(
      issueMaterialsToJewelleryJob(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        issueDate: DATE,
        metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 1 }],
        polishedDiamondIds: [],
        otherMaterialLines: [],
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects issuing nothing at all", async () => {
    const fixture = createFakeJewelleryTx();
    const job = await createDraftJob(fixture);
    await expect(
      issueMaterialsToJewelleryJob(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        issueDate: DATE,
        metalLines: [],
        polishedDiamondIds: [],
        otherMaterialLines: [],
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("markJewelleryJobInProgress / setJewelleryJobNeedsCorrection", () => {
  async function issuedJob(fixture: Fixture) {
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 50000 });
    const job = await createDraftJob(fixture);
    return issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 5 }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });
  }

  it("moves Materials Issued -> In Progress", async () => {
    const fixture = createFakeJewelleryTx();
    const job = await issuedJob(fixture);
    await markJewelleryJobInProgress(fixture.tx as never, job.id as string);
    expect(fixture.state.jewelleryJobs.get(job.id as string)!.status).toBe("IN_PROGRESS");
  });

  it("toggles Needs Correction on and back off", async () => {
    const fixture = createFakeJewelleryTx();
    const job = await issuedJob(fixture);
    await markJewelleryJobInProgress(fixture.tx as never, job.id as string);

    await setJewelleryJobNeedsCorrection(fixture.tx as never, job.id as string, true);
    expect(fixture.state.jewelleryJobs.get(job.id as string)!.status).toBe("NEEDS_CORRECTION");

    await setJewelleryJobNeedsCorrection(fixture.tx as never, job.id as string, false);
    expect(fixture.state.jewelleryJobs.get(job.id as string)!.status).toBe("IN_PROGRESS");
  });

  it("rejects marking a Draft job Needs Correction", async () => {
    const fixture = createFakeJewelleryTx();
    const job = await createDraftJob(fixture);
    await expect(setJewelleryJobNeedsCorrection(fixture.tx as never, job.id as string, true)).rejects.toThrow(PostingError);
  });

  it("rejects clearing Needs Correction when the job isn't currently flagged", async () => {
    const fixture = createFakeJewelleryTx();
    const job = await issuedJob(fixture);
    await expect(setJewelleryJobNeedsCorrection(fixture.tx as never, job.id as string, false)).rejects.toThrow(PostingError);
  });
});

describe("receiveFinishedJewellery", () => {
  async function setupJob(fixture: Fixture, grossWeight: number, totalPurchaseCost: number, purity = seedGold22k(fixture)) {
    await purchaseMetal(fixture, purity.id as string, { grossWeight: grossWeight * 2, totalPurchaseCost: totalPurchaseCost * 2 });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });
    return { job: issued, purity };
  }

  it("completes a job on a single full receipt with recognized process loss absorbed into finished cost", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 10, 50000); // 9.16g fine issued, 50000 cost

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        {
          jewelleryType: "RING",
          quantity: 1,
          netMetalWeight: 9, // 8.244g fine — less than the 9.16g issued -> loss
          metalType: "GOLD",
          purityId: purity.id as string,
          diamondIds: [],
          qcStatus: "PASSED",
        },
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

    const finalJob = fixture.state.jewelleryJobs.get(job.id as string)!;
    expect(finalJob.status).toBe("COMPLETED");
    expect(Number(finalJob.remainingWipCost)).toBe(0);
    expect(Number(result.receipt.processLossFineWeight)).toBeCloseTo(0.916, 3); // 9.16 issued fine - 9*0.916 finished fine

    const lines = linesFor(fixture, result.receipt.postingVoucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(
      Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY)?.debit)
    ).toBeCloseTo(50000, 2); // full cost absorbed — loss not carved out (not abnormal)
    expect(Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP)?.credit)).toBeCloseTo(
      50000,
      2
    );
  });

  it("auto-completes with zero loss when finished fine weight exactly matches pending", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 10, 50000);

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        {
          jewelleryType: "RING",
          quantity: 1,
          netMetalWeight: 10, // exactly matches 9.16g fine
          metalType: "GOLD",
          purityId: purity.id as string,
          diamondIds: [],
          qcStatus: "PASSED",
        },
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

    expect(Number(result.receipt.processLossFineWeight)).toBe(0);
    expect(fixture.state.jewelleryJobs.get(job.id as string)!.status).toBe("COMPLETED");
  });

  it("does NOT recognize loss on a partial receipt without markJobComplete — remaining metal stays with Karigar", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 30, 150000); // 27.48g fine issued

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        {
          jewelleryType: "RING",
          quantity: 1,
          netMetalWeight: 10, // 9.16g fine — well under 27.48g pending
          metalType: "GOLD",
          purityId: purity.id as string,
          diamondIds: [],
          qcStatus: "PASSED",
        },
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

    expect(Number(result.receipt.processLossFineWeight)).toBe(0);
    const partialJob = fixture.state.jewelleryJobs.get(job.id as string)!;
    expect(partialJob.status).toBe("PARTIALLY_RECEIVED");
    expect(Number(partialJob.remainingWipCost)).toBeGreaterThan(0);
  });

  it("resolves correctly across two partial receipts, closing the job with the exact remaining WIP cost", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 30, 150000); // 27.48g fine, 150000 cost

    await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    const second = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 20, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    const finalJob = fixture.state.jewelleryJobs.get(job.id as string)!;
    expect(finalJob.status).toBe("COMPLETED");
    expect(Number(finalJob.remainingWipCost)).toBe(0);
    // Second output (20g -> 18.32g fine) plus first output (9.16g fine) = 27.48g == issued exactly, so the
    // second receipt takes exactly whatever WIP cost remains.
    expect(Number(second.outputs[0].totalCost)).toBeGreaterThan(0);
  });

  it("handles mixed-purity issue by fine weight, not gross weight, for reconciliation", async () => {
    const fixture = createFakeJewelleryTx();
    const gold22 = seedGold22k(fixture);
    const gold18 = seedGold18k(fixture);
    await purchaseMetal(fixture, gold22.id as string, { grossWeight: 50, totalPurchaseCost: 250000 });
    await purchaseMetal(fixture, gold18.id as string, { grossWeight: 50, totalPurchaseCost: 200000 });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [
        { metalType: "GOLD", purityId: gold22.id as string, grossWeight: 10 }, // 9.16 fine
        { metalType: "GOLD", purityId: gold18.id as string, grossWeight: 10 }, // 7.50 fine
      ],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });
    // Total issued fine weight: 16.66g

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [
        {
          jewelleryType: "RING",
          quantity: 1,
          netMetalWeight: 20, // finished at 18K -> 15.00g fine, less than 16.66g issued fine
          metalType: "GOLD",
          purityId: gold18.id as string,
          diamondIds: [],
          qcStatus: "PASSED",
        },
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

    // 16.66 issued fine - 15.00 finished fine = 1.66g recognized loss.
    expect(Number(result.receipt.processLossFineWeight)).toBeCloseTo(1.66, 3);
  });

  it("returns unused metal and recoverable scrap, draining the cost pool proportionally", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 30, 150000); // 27.48g fine, 150000 cost

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
      ],
      diamondResolutions: [],
      returnedMetalLines: [{ purityId: purity.id as string, grossWeight: 10 }], // 9.16g fine returned
      scrapMetalLines: [{ purityId: purity.id as string, grossWeight: 5 }], // 4.58g fine scrap
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

    expect(Number(result.receipt.returnedMetalFineWeight)).toBeCloseTo(9.16, 3);
    expect(Number(result.receipt.scrapFineWeight)).toBeCloseTo(4.58, 3);

    const lines = linesFor(fixture, result.receipt.postingVoucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY)?.debit)).toBeGreaterThan(0);
    expect(Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.SCRAP_METAL_INVENTORY)?.debit)).toBeGreaterThan(
      0
    );

    const returnMovement = [...fixture.state.metalStockMovements.values()].find((m) => m.type === "RETURN_IN");
    expect(Number(returnMovement?.grossWeight)).toBe(10);
    const scrapMovement = [...fixture.state.metalStockMovements.values()].find((m) => m.type === "SCRAP_RETURN_IN");
    expect(Number(scrapMovement?.grossWeight)).toBe(5);
  });

  it("resolves an issued diamond as SET into an output using its exact issue cost", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-P-000010", shape: "ROUND", carat: "0.3", allocatedCost: "6000" });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [diamond.id as string],
      otherMaterialLines: [],
    });

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [
        {
          jewelleryType: "RING",
          quantity: 1,
          netMetalWeight: 10,
          metalType: "GOLD",
          purityId: purity.id as string,
          diamondIds: [diamond.id as string],
          qcStatus: "PASSED",
        },
      ],
      diamondResolutions: [{ polishedDiamondId: diamond.id as string, resolution: "SET" }],
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

    expect(fixture.state.polishedDiamonds.get(diamond.id as string)!.status).toBe("SET_IN_JEWELLERY");
    expect(Number(result.outputs[0].diamondCost)).toBe(6000);
    const lines = linesFor(fixture, result.receipt.postingVoucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
  });

  it("resolves an issued diamond as RETURNED, restoring Available status and crediting WIP by its exact issue cost", async () => {
    const fixture = createFakeJewelleryTx();
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-P-000011", shape: "ROUND", carat: "0.3", allocatedCost: "6000" });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [],
      polishedDiamondIds: [diamond.id as string],
      otherMaterialLines: [],
    });

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [],
      diamondResolutions: [{ polishedDiamondId: diamond.id as string, resolution: "RETURNED" }],
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

    expect(fixture.state.polishedDiamonds.get(diamond.id as string)!.status).toBe("AVAILABLE");
    expect(Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)?.debit)).toBe(
      6000
    );
    expect(Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP)?.credit)).toBe(6000);
  });

  it("resolves an issued diamond as DAMAGED_LOST with a reason, posting its cost to Business Expenses", async () => {
    const fixture = createFakeJewelleryTx();
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-P-000012", shape: "ROUND", carat: "0.3", allocatedCost: "6000" });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [],
      polishedDiamondIds: [diamond.id as string],
      otherMaterialLines: [],
    });

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [],
      diamondResolutions: [{ polishedDiamondId: diamond.id as string, resolution: "DAMAGED_LOST", damagedLostReason: "Chipped during setting" }],
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
      damagedLostByUserId: "owner-1",
    });

    expect(fixture.state.polishedDiamonds.get(diamond.id as string)!.status).toBe("DAMAGED_LOST");
    expect(Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES)?.debit)).toBe(
      6000
    );
  });

  it("rejects marking a diamond damaged/lost without a reason", async () => {
    const fixture = createFakeJewelleryTx();
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-P-000013", shape: "ROUND", carat: "0.3", allocatedCost: "6000" });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [],
      polishedDiamondIds: [diamond.id as string],
      otherMaterialLines: [],
    });

    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: issued.id as string,
        receiveDate: DATE,
        outputs: [],
        diamondResolutions: [{ polishedDiamondId: diamond.id as string, resolution: "DAMAGED_LOST" }],
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
        damagedLostByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });

  it("prevents setting the same diamond into two outputs", async () => {
    const fixture = createFakeJewelleryTx();
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-P-000014", shape: "ROUND", carat: "0.3", allocatedCost: "6000" });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [],
      polishedDiamondIds: [diamond.id as string],
      otherMaterialLines: [],
    });

    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: issued.id as string,
        receiveDate: DATE,
        outputs: [
          { jewelleryType: "RING", quantity: 1, netMetalWeight: 1, metalType: "GOLD", purityId: seedGold22k(fixture).id as string, diamondIds: [diamond.id as string], qcStatus: "PASSED" },
          { jewelleryType: "RING", quantity: 1, netMetalWeight: 1, metalType: "GOLD", purityId: seedGold22k(fixture).id as string, diamondIds: [diamond.id as string], qcStatus: "PASSED" },
        ],
        diamondResolutions: [{ polishedDiamondId: diamond.id as string, resolution: "SET" }],
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
      })
    ).rejects.toThrow(PostingError);
  });

  it("prevents completion while an issued diamond remains unresolved, even when all metal is resolved", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 20, totalPurchaseCost: 100000 });
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-P-000015", shape: "ROUND", carat: "0.3", allocatedCost: "6000" });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [diamond.id as string],
      otherMaterialLines: [],
    });

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
      ],
      diamondResolutions: [], // diamond left unresolved
      returnedMetalLines: [],
      scrapMetalLines: [],
      karigarAddedFineWeight: 0,
      karigarAddedCost: 0,
      labourCharge: 0,
      makingCharge: 0,
      settingCharge: 0,
      platingCharge: 0,
      otherExpense: 0,
      markJobComplete: true, // metal side fully resolves (gap=0) AND markJobComplete is set...
      isAbnormalLoss: false,
      damagedLostByUserId: "user-1",
    });

    // ...but the job must NOT complete because the diamond is still unresolved.
    expect(result.job.status).toBe("PARTIALLY_RECEIVED");
  });

  it("allocates a receipt's cost across multiple outputs proportionally by fine weight, summing exactly", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 30, 90000);

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 20, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    const total = result.outputs.reduce((sum, o) => sum + Number(o.totalCost), 0);
    expect(total.toFixed(2)).toBe("90000.00");
    // 10g weighs half of 20g -> costs should be roughly 1:2.
    const costs = result.outputs.map((o) => Number(o.totalCost)).sort((a, b) => a - b);
    expect(costs[1]).toBeCloseTo(costs[0] * 2, 0);
  });

  it("posts labour/making/setting/plating/other charges to the Karigar's payable and adds them to finished cost", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 10, 50000);

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
      ],
      diamondResolutions: [],
      returnedMetalLines: [],
      scrapMetalLines: [],
      karigarAddedFineWeight: 0,
      karigarAddedCost: 0,
      labourCharge: 200,
      makingCharge: 300,
      settingCharge: 100,
      platingCharge: 50,
      otherExpense: 25,
      markJobComplete: true,
      isAbnormalLoss: false,
      damagedLostByUserId: "user-1",
    });

    const lines = linesFor(fixture, result.receipt.postingVoucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    const payableLine = linesFor(fixture, result.receipt.postingVoucherId as string).find(
      (l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE && l.partyId === "karigar-1"
    );
    expect(Number(payableLine?.credit)).toBe(675);
    expect(Number(result.outputs[0].labourAllocated)).toBe(675);
  });

  it("prevents finished plus returned plus scrap fine weight from exceeding what's pending", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 5, 25000);

    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        receiveDate: DATE,
        outputs: [
          { jewelleryType: "RING", quantity: 1, netMetalWeight: 4, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
        ],
        diamondResolutions: [],
        returnedMetalLines: [{ purityId: purity.id as string, grossWeight: 2 }], // 4g finished fine + 1.832g returned fine > 4.58g pending fine
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
      })
    ).rejects.toThrow(PostingError);
  });

  it("classifies an abnormal loss to Business Expenses instead of absorbing it into finished cost", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 10, 50000);

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 5, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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
      isAbnormalLoss: true,
      abnormalLossReason: "Karigar reported a casting defect that consumed extra metal",
      damagedLostByUserId: "owner-1",
    });

    expect(result.receipt.isAbnormalLoss).toBe(true);
    const lines = linesFor(fixture, result.receipt.postingVoucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES)?.debit)).toBeGreaterThan(
      0
    );
  });

  it("rejects an abnormal-loss classification without a reason", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 10, 50000);

    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        receiveDate: DATE,
        outputs: [
          { jewelleryType: "RING", quantity: 1, netMetalWeight: 5, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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
        isAbnormalLoss: true,
        damagedLostByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects receiving against a Draft job (materials not yet issued)", async () => {
    const fixture = createFakeJewelleryTx();
    const job = await createDraftJob(fixture);
    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
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
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects receiving against an already-completed job", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJob(fixture, 5, 25000);
    await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 5, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
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
      })
    ).rejects.toThrow(PostingError);
  });

  it("keeps other-material cost as a display-only job-costing figure, never posted as its own accounting line", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 50000 });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [],
      otherMaterialLines: [{ description: "Alloy", quantity: 1, unit: "GRAM", cost: 500 }],
    });

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    // Job costing shows the other-material cost on the output...
    expect(Number(result.outputs[0].otherMaterialCost)).toBe(500);
    // ...but the voucher's total debit only reflects metal cost — no distinct line was created for it,
    // and Finished Jewellery Inventory only carries the metal-resolved portion.
    const lines = linesFor(fixture, result.receipt.postingVoucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(
      Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY)?.debit)
    ).toBeCloseTo(50000, 2);
  });
});

describe("cancelJewelleryJob", () => {
  it("cancels a Draft job with no stock/accounting impact", async () => {
    const fixture = createFakeJewelleryTx();
    const job = await createDraftJob(fixture);

    await cancelJewelleryJob(fixture.tx as never, {
      ...FY,
      jobId: job.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "Customer changed their mind",
    });

    expect(fixture.state.jewelleryJobs.get(job.id as string)!.status).toBe("CANCELLED");
    expect(fixture.state.journalEntries).toHaveLength(0);
  });

  it("cancels a Materials-Issued job: returns metal to stock, returns diamonds to Available, and reverses the WIP voucher", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 50000 });
    const diamond = fixture.seedPolishedDiamond({ polishedCode: "ZL-P-000020", shape: "ROUND", carat: "0.3", allocatedCost: "6000" });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [diamond.id as string],
      otherMaterialLines: [],
    });

    await cancelJewelleryJob(fixture.tx as never, {
      ...FY,
      jobId: issued.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "Wrong Karigar",
    });

    expect(fixture.state.jewelleryJobs.get(issued.id as string)!.status).toBe("CANCELLED");
    expect(fixture.state.polishedDiamonds.get(diamond.id as string)!.status).toBe("AVAILABLE");

    const balance = await getMetalStockBalanceInTx(fixture.tx as never, "GOLD", purity.id as string);
    expect(balance.grossWeight.toFixed(3)).toBe("10.000"); // fully back to stock

    const original = fixture.state.vouchers.get(issued.wipVoucherId as string)!;
    expect(original.status).toBe("CANCELLED");
    const reversal = [...fixture.state.vouchers.values()].find((v) => v.reversalOfVoucherId === issued.wipVoucherId);
    expect(reversal).toBeTruthy();
    const reversalLines = linesFor(fixture, reversal!.id as string);
    expect(sumBy(reversalLines, "debit")).toBeCloseTo(sumBy(reversalLines, "credit"), 5);
  });

  it("rejects cancelling an already-cancelled job", async () => {
    const fixture = createFakeJewelleryTx();
    const job = await createDraftJob(fixture);
    await cancelJewelleryJob(fixture.tx as never, {
      ...FY,
      jobId: job.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "first",
    });

    await expect(
      cancelJewelleryJob(fixture.tx as never, {
        ...FY,
        jobId: job.id as string,
        cancelledByUserId: "owner-1",
        cancellationReason: "second",
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects cancelling a job that already has received material", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 50000 });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });
    await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    await expect(
      cancelJewelleryJob(fixture.tx as never, {
        ...FY,
        jobId: issued.id as string,
        cancelledByUserId: "owner-1",
        cancellationReason: "too late",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("overrideFinishedJewelleryAllocation", () => {
  async function receiptWithTwoOutputs(fixture: Fixture) {
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 30, totalPurchaseCost: 90000 });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 30 }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });
    return receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: issued.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 20, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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
  }

  it("reallocates cost across a receipt's outputs with an exact-sum-required reason", async () => {
    const fixture = createFakeJewelleryTx();
    const result = await receiptWithTwoOutputs(fixture);
    const currentTotal = result.outputs.reduce((sum, o) => sum + Number(o.totalCost), 0);

    await overrideFinishedJewelleryAllocation(fixture.tx as never, {
      receiptId: result.receipt.id as string,
      reason: "Owner correction",
      adjustments: [
        { finishedJewelleryId: result.outputs[0].id as string, newTotalCost: currentTotal - 10000 },
        { finishedJewelleryId: result.outputs[1].id as string, newTotalCost: 10000 },
      ],
    });

    expect(Number(fixture.state.finishedJewelleryRows.get(result.outputs[0].id as string)!.totalCost)).toBe(currentTotal - 10000);
    expect(Number(fixture.state.finishedJewelleryRows.get(result.outputs[1].id as string)!.totalCost)).toBe(10000);
  });

  it("rejects a new total that doesn't match the receipt's locked total", async () => {
    const fixture = createFakeJewelleryTx();
    const result = await receiptWithTwoOutputs(fixture);

    await expect(
      overrideFinishedJewelleryAllocation(fixture.tx as never, {
        receiptId: result.receipt.id as string,
        reason: "mismatch",
        adjustments: [
          { finishedJewelleryId: result.outputs[0].id as string, newTotalCost: 999999 },
          { finishedJewelleryId: result.outputs[1].id as string, newTotalCost: 1 },
        ],
      })
    ).rejects.toThrow(PostingError);
  });

  it("requires a reason", async () => {
    const fixture = createFakeJewelleryTx();
    const result = await receiptWithTwoOutputs(fixture);
    const currentTotal = result.outputs.reduce((sum, o) => sum + Number(o.totalCost), 0);

    await expect(
      overrideFinishedJewelleryAllocation(fixture.tx as never, {
        receiptId: result.receipt.id as string,
        reason: "",
        adjustments: [
          { finishedJewelleryId: result.outputs[0].id as string, newTotalCost: currentTotal },
          { finishedJewelleryId: result.outputs[1].id as string, newTotalCost: 0 },
        ],
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("mixed-purity return and scrap handling", () => {
  async function setupTwoPurityJob(fixture: Fixture) {
    const gold22 = seedGold22k(fixture);
    const gold18 = seedGold18k(fixture);
    await purchaseMetal(fixture, gold22.id as string, { grossWeight: 20, totalPurchaseCost: 100000 }); // 5000/g
    await purchaseMetal(fixture, gold18.id as string, { grossWeight: 20, totalPurchaseCost: 60000 }); // 3000/g
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [
        { metalType: "GOLD", purityId: gold22.id as string, grossWeight: 10 }, // 9.16g fine, cost 50000
        { metalType: "GOLD", purityId: gold18.id as string, grossWeight: 10 }, // 7.50g fine, cost 30000
      ],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });
    return { job: issued, gold22, gold18 };
  }

  it("reconciles a job with two issued purities across a partial and a final receipt — every return/scrap line posts to its OWN purity, never a default", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, gold22, gold18 } = await setupTwoPurityJob(fixture);
    // Total issued: 16.66g fine (9.16 @ 22K + 7.50 @ 18K), cost 80000.

    const first = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [],
      diamondResolutions: [],
      returnedMetalLines: [{ purityId: gold22.id as string, grossWeight: 5 }], // 4.58g fine @ 22K
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

    expect(Number(first.receipt.returnedMetalFineWeight)).toBeCloseTo(4.58, 3);
    const firstMovements = [...fixture.state.metalStockMovements.values()].filter((m) => m.sourceDocument === first.receipt.receiptCode);
    const returnMovement = firstMovements.find((m) => m.type === "RETURN_IN");
    expect(returnMovement?.purityId).toBe(gold22.id);
    expect(Number(returnMovement?.grossWeight)).toBe(5);
    // No 18K movement was created for a return that only ever named 22K.
    expect(firstMovements.some((m) => m.purityId === gold18.id)).toBe(false);

    const firstLines = linesFor(fixture, first.receipt.postingVoucherId as string);
    expect(sumBy(firstLines, "debit")).toBeCloseTo(sumBy(firstLines, "credit"), 5);

    const second = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 4, metalType: "GOLD", purityId: gold18.id as string, diamondIds: [], qcStatus: "PASSED" },
      ],
      diamondResolutions: [],
      returnedMetalLines: [],
      scrapMetalLines: [{ purityId: gold18.id as string, grossWeight: 2 }], // 1.5g fine @ 18K
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

    const finalJob = fixture.state.jewelleryJobs.get(job.id as string)!;
    expect(finalJob.status).toBe("COMPLETED");
    expect(Number(finalJob.remainingWipCost)).toBe(0);
    // Fine-weight reconciliation across BOTH receipts, aggregated: issued
    // 16.66g = returned 4.58g + scrap 1.5g + finished (4*0.75=3.00g) + loss.
    const totalResolved = Number(first.receipt.returnedMetalFineWeight) + Number(second.receipt.scrapFineWeight) + 3.0;
    const expectedLoss = 16.66 - totalResolved;
    expect(Number(second.receipt.processLossFineWeight)).toBeCloseTo(expectedLoss, 2);

    const scrapMovement = [...fixture.state.metalStockMovements.values()].find(
      (m) => m.sourceDocument === second.receipt.receiptCode && m.type === "SCRAP_RETURN_IN"
    );
    expect(scrapMovement?.purityId).toBe(gold18.id);

    // The finished output's own CONSUMED_OUT movement is attributed to
    // ITS real purity (18K), never a "first issued line" default (22K).
    const consumedForOutput = [...fixture.state.metalStockMovements.values()].find(
      (m) => m.sourceDocument === second.receipt.receiptCode && m.type === "CONSUMED_OUT" && Number(m.fineWeight) === 3
    );
    expect(consumedForOutput?.purityId).toBe(gold18.id);

    const secondLines = linesFor(fixture, second.receipt.postingVoucherId as string);
    expect(sumBy(secondLines, "debit")).toBeCloseTo(sumBy(secondLines, "credit"), 5);
  });

  it("rejects a return/scrap purity that was never issued to this job", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, gold22 } = await setupTwoPurityJob(fixture);
    const platinum = fixture.seedMetalPurity({ metalType: "PLATINUM", displayName: "950 Platinum", finenessPercent: "95.000" });

    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        receiveDate: DATE,
        outputs: [],
        diamondResolutions: [],
        returnedMetalLines: [{ purityId: platinum.id as string, grossWeight: 1 }],
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
      })
    ).rejects.toThrow(PostingError);
    expect(gold22).toBeTruthy(); // sanity: the job DID issue a real purity, just not this one
  });

  it("rejects a finished output recorded in a purity that was never issued to this job", async () => {
    // Regression: the finished-output purity used to be validated only
    // against the Metal/Purity master at large (any real purity, any
    // metal type match), not against what this job actually issued. That
    // let an output be recorded in a purity the job never received metal
    // in — and since the CONSUMED_OUT stock movement for the finished
    // portion is posted against exactly that output's purityId, an
    // unrelated real purity's Metal Stock balance could be silently
    // drained for metal it never actually gave out. Outputs must be
    // restricted to the job's own issued purities, exactly like return/
    // scrap lines.
    const fixture = createFakeJewelleryTx();
    const { job } = await setupTwoPurityJob(fixture);
    const platinum = fixture.seedMetalPurity({ metalType: "PLATINUM", displayName: "950 Platinum", finenessPercent: "95.000" });

    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        receiveDate: DATE,
        outputs: [
          { jewelleryType: "RING", quantity: 1, netMetalWeight: 5, metalType: "PLATINUM", purityId: platinum.id as string, diamondIds: [], qcStatus: "PASSED" },
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
      })
    ).rejects.toThrow(PostingError);

    // And the platinum purity's real Metal Stock balance must be
    // completely untouched — no movement of any kind was created for it.
    const platinumMovements = [...fixture.state.metalStockMovements.values()].filter((m) => m.purityId === platinum.id);
    expect(platinumMovements).toHaveLength(0);
  });

  it("rejects returning more of ONE purity than this job ever issued of it, even though the job's AGGREGATE pending would allow it", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, gold22 } = await setupTwoPurityJob(fixture);
    // Job issued only 9.16g fine of 22K (from 10g gross) — asking for 18g
    // gross (16.47g fine) of 22K alone is impossible, even though the
    // job's combined 22K+18K pending (16.66g) would numerically cover it.
    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        receiveDate: DATE,
        outputs: [],
        diamondResolutions: [],
        returnedMetalLines: [{ purityId: gold22.id as string, grossWeight: 18 }],
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
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects a return/scrap line with a non-positive weight", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, gold22 } = await setupTwoPurityJob(fixture);
    await expect(
      receiveFinishedJewellery(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        receiveDate: DATE,
        outputs: [],
        diamondResolutions: [],
        returnedMetalLines: [{ purityId: gold22.id as string, grossWeight: 0 }],
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
      })
    ).rejects.toThrow(PostingError);
  });

  it("keeps a single-purity job's return form simple — one line, no purity ambiguity", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 50000 });
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
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 5, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
      ],
      diamondResolutions: [],
      returnedMetalLines: [{ purityId: purity.id as string, grossWeight: 5 }],
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

    expect(fixture.state.jewelleryJobs.get(issued.id as string)!.status).toBe("COMPLETED");
    expect(Number(result.receipt.returnedMetalFineWeight)).toBeCloseTo(4.58, 3);
  });
});

describe("other-material cost allocation across outputs", () => {
  async function setupJobWithOtherMaterial(fixture: Fixture, otherMaterialCost: number, grossWeight = 20, totalPurchaseCost = 100000) {
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: grossWeight * 2, totalPurchaseCost: totalPurchaseCost * 2 });
    const job = await createDraftJob(fixture);
    const issued = await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight }],
      polishedDiamondIds: [],
      otherMaterialLines: [{ description: "Alloy + findings", quantity: 1, unit: "GRAM", cost: otherMaterialCost }],
    });
    return { job: issued, purity };
  }

  it("allocates the full other-material cost to a single output", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJobWithOtherMaterial(fixture, 300);

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 20, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    expect(Number(result.outputs[0].otherMaterialCost)).toBe(300);
  });

  it("allocates across multiple unequal-weight outputs in one receipt, summing exactly (rounding remainder included)", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJobWithOtherMaterial(fixture, 100, 30, 150000);

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 7, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 13, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    const total = result.outputs.reduce((sum, o) => sum + Number(o.otherMaterialCost), 0);
    expect(total.toFixed(2)).toBe("100.00");
    // 7g is the smallest share — not zero, and less than the 10g/13g shares.
    const costs = result.outputs.map((o) => Number(o.otherMaterialCost));
    expect(costs[1]).toBeLessThan(costs[0]);
    expect(costs[1]).toBeLessThan(costs[2]);
  });

  it("recalculates provisional allocations when later outputs are received — the first receipt's output's cost is retroactively corrected", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJobWithOtherMaterial(fixture, 90, 30, 150000);

    const first = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    // Provisionally, with only one output so far, it carries the FULL cost.
    expect(Number(first.outputs[0].otherMaterialCost)).toBe(90);

    const second = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 20, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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

    // Now split 10g:20g -> 1:2 across BOTH outputs -> 30 and 60.
    const firstOutputAfter = fixture.state.finishedJewelleryRows.get(first.outputs[0].id as string)!;
    expect(Number(firstOutputAfter.otherMaterialCost)).toBe(30);
    expect(Number(second.outputs[0].otherMaterialCost)).toBe(60);
    // The first output's totalCost was recomputed too, not just its otherMaterialCost.
    const expectedFirstTotal =
      Number(firstOutputAfter.metalCost) + Number(firstOutputAfter.diamondCost) + 30 + Number(firstOutputAfter.labourAllocated);
    expect(Number(firstOutputAfter.totalCost)).toBeCloseTo(expectedFirstTotal, 2);

    // On completion, the sum across every output for the job equals the
    // total issued other-material cost EXACTLY.
    const allOutputs = [...fixture.state.finishedJewelleryRows.values()].filter((o) => o.jobId === job.id);
    const grandTotal = allOutputs.reduce((sum, o) => sum + Number(o.otherMaterialCost), 0);
    expect(grandTotal.toFixed(2)).toBe("90.00");
  });

  it("leaves other-material cost unallocated (an explicit, safe rule) when a job never receives any output at all", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJobWithOtherMaterial(fixture, 50, 10, 50000);

    const result = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [],
      diamondResolutions: [],
      returnedMetalLines: [{ purityId: purity.id as string, grossWeight: 10 }],
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

    expect(result.outputs).toHaveLength(0);
    const anyOutputsForJob = [...fixture.state.finishedJewelleryRows.values()].filter((o) => o.jobId === job.id);
    expect(anyOutputsForJob).toHaveLength(0);
    // No crash, no division-by-zero — the job still completes normally.
    expect(fixture.state.jewelleryJobs.get(job.id as string)!.status).toBe("COMPLETED");
  });

  it("never posts other-material cost as its own accounting journal line, across multiple receipts", async () => {
    const fixture = createFakeJewelleryTx();
    const { job, purity } = await setupJobWithOtherMaterial(fixture, 90, 30, 150000);

    const first = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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
    const firstLines = linesFor(fixture, first.receipt.postingVoucherId as string);
    expect(sumBy(firstLines, "debit")).toBeCloseTo(sumBy(firstLines, "credit"), 5);
    // None of this receipt's journal lines equal the other-material cost —
    // it only ever shows up on FinishedJewellery.otherMaterialCost.
    expect(firstLines.some((l) => Number(l.debit) === 90 || Number(l.credit) === 90)).toBe(false);

    const second = await receiveFinishedJewellery(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      outputs: [
        { jewelleryType: "RING", quantity: 1, netMetalWeight: 20, metalType: "GOLD", purityId: purity.id as string, diamondIds: [], qcStatus: "PASSED" },
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
    const secondLines = linesFor(fixture, second.receipt.postingVoucherId as string);
    expect(sumBy(secondLines, "debit")).toBeCloseTo(sumBy(secondLines, "credit"), 5);
  });

  it("cancels cleanly even when the job carries an unreceived other-material cost — no crash, no dangling allocation", async () => {
    const fixture = createFakeJewelleryTx();
    const { job } = await setupJobWithOtherMaterial(fixture, 75, 10, 50000);

    await cancelJewelleryJob(fixture.tx as never, {
      ...FY,
      jobId: job.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "Customer cancelled the order",
    });

    expect(fixture.state.jewelleryJobs.get(job.id as string)!.status).toBe("CANCELLED");
    const anyOutputsForJob = [...fixture.state.finishedJewelleryRows.values()].filter((o) => o.jobId === job.id);
    expect(anyOutputsForJob).toHaveLength(0);
  });
});

describe("historical snapshot preservation", () => {
  it("keeps a metal issue line's fineness snapshot even if the purity master is edited afterward", async () => {
    const fixture = createFakeJewelleryTx();
    const purity = seedGold22k(fixture);
    await purchaseMetal(fixture, purity.id as string, { grossWeight: 10, totalPurchaseCost: 50000 });
    const job = await createDraftJob(fixture);
    await issueMaterialsToJewelleryJob(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 10 }],
      polishedDiamondIds: [],
      otherMaterialLines: [],
    });

    const issueLine = [...fixture.state.jewelleryMetalIssueLines.values()].find((l) => l.jobId === job.id)!;
    expect(Number(issueLine.finenessPercentSnapshot)).toBe(91.6);

    // Owner edits the purity master afterward...
    purity.finenessPercent = "50.000";

    // ...but the already-created issue line keeps its original snapshot.
    expect(Number(issueLine.finenessPercentSnapshot)).toBe(91.6);
  });
});
