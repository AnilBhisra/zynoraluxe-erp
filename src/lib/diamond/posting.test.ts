import { describe, expect, it } from "vitest";

import { createFakeDiamondTx } from "../../../test/fixtures/fakeDiamondTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import {
  cancelDiamondJob,
  createRoughLotWithPieces,
  issueRoughToKarigar,
  overridePolishedAllocations,
  overrideRoughPieceAllocations,
  PostingError,
  receivePolishedDiamonds,
  recutPolishedDiamond,
} from "./posting";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-06-15T00:00:00.000Z");

function common(overrides: Partial<Record<string, unknown>> = {}) {
  return { date: DATE, ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: "user-1", ...overrides };
}

function linesFor(fixture: ReturnType<typeof createFakeDiamondTx>, voucherId: string) {
  return fixture.state.journalEntries.filter((e) => e.voucherId === voucherId);
}
function sumBy<K extends string>(lines: Record<string, unknown>[], key: K) {
  return lines.reduce((sum, l) => sum + Number(l[key]), 0);
}
function codeOf(fixture: ReturnType<typeof createFakeDiamondTx>, accountId: unknown) {
  for (const [code, row] of fixture.state.accounts) {
    if (row.id === accountId) return code;
  }
  return undefined;
}
function lineFor(fixture: ReturnType<typeof createFakeDiamondTx>, voucherId: string, code: string) {
  return linesFor(fixture, voucherId).find((l) => codeOf(fixture, l.accountId) === code);
}

async function purchaseSinglePiece(
  fixture: ReturnType<typeof createFakeDiamondTx>,
  opts: { carat: number; cost: number; supplierId?: string }
) {
  return createRoughLotWithPieces(fixture.tx as never, {
    ...common(),
    purchaseDate: DATE,
    supplierId: opts.supplierId ?? "supplier-1",
    purchaseRate: opts.cost / opts.carat,
    rateBasis: "PER_CARAT",
    totalPurchaseCost: opts.cost,
    gstTreatment: "NONE",
    pieces: [{ carat: opts.carat }],
  });
}

describe("createRoughLotWithPieces", () => {
  it("creates a lot with one piece carrying the full cost and posts a balanced credit purchase", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 2, cost: 10000 });

    expect(lot.piecesCount).toBe(1);
    const pieces = [...fixture.state.roughPieces.values()].filter((p) => p.lotId === lot.id);
    expect(pieces).toHaveLength(1);
    expect(Number(pieces[0].allocatedCost)).toBe(10000);
    expect(pieces[0].status).toBe("AVAILABLE");

    const lines = linesFor(fixture, lot.voucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(Number(lineFor(fixture, lot.voucherId as string, SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY)?.debit)).toBe(10000);
    expect(Number(lineFor(fixture, lot.voucherId as string, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE)?.credit)).toBe(10000);

    const movement = [...fixture.state.stockMovements.values()].find((m) => m.roughPieceId === pieces[0].id);
    expect(movement?.type).toBe("ROUGH_PURCHASE_IN");
    expect(Number(movement?.carat)).toBe(2);
  });

  it("allocates a parcel's cost proportionally by carat and the pieces sum EXACTLY to the lot total", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await createRoughLotWithPieces(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      purchaseRate: 100,
      rateBasis: "PER_CARAT",
      totalPurchaseCost: 100,
      gstTreatment: "NONE",
      pieces: [{ carat: 1 }, { carat: 1 }, { carat: 1 }],
    });

    const pieces = [...fixture.state.roughPieces.values()].filter((p) => p.lotId === lot.id);
    const total = pieces.reduce((sum, p) => sum + Number(p.allocatedCost), 0);
    expect(total.toFixed(2)).toBe("100.00");
    const costs = pieces.map((p) => Number(p.allocatedCost).toFixed(2)).sort();
    expect(costs.filter((c) => c === "33.33")).toHaveLength(2);
  });

  it("honors manual per-piece costs only when every piece supplies one and they sum exactly", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await createRoughLotWithPieces(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      purchaseRate: 100,
      rateBasis: "PER_CARAT",
      totalPurchaseCost: 100,
      gstTreatment: "NONE",
      pieces: [
        { carat: 1, manualAllocatedCost: 70 },
        { carat: 1, manualAllocatedCost: 30 },
      ],
    });
    const pieces = [...fixture.state.roughPieces.values()].filter((p) => p.lotId === lot.id);
    const costs = pieces.map((p) => Number(p.allocatedCost)).sort((a, b) => a - b);
    expect(costs).toEqual([30, 70]);
  });

  it("rejects manual per-piece costs that do not sum to the lot total", async () => {
    const fixture = createFakeDiamondTx();
    await expect(
      createRoughLotWithPieces(fixture.tx as never, {
        ...common(),
        purchaseDate: DATE,
        supplierId: "supplier-1",
        purchaseRate: 100,
        rateBasis: "PER_CARAT",
        totalPurchaseCost: 100,
        gstTreatment: "NONE",
        pieces: [
          { carat: 1, manualAllocatedCost: 70 },
          { carat: 1, manualAllocatedCost: 20 },
        ],
      })
    ).rejects.toThrow(PostingError);
  });

  it("posts CGST+SGST input tax and a payable that includes tax", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await createRoughLotWithPieces(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      purchaseRate: 100,
      rateBasis: "PER_CARAT",
      totalPurchaseCost: 1000,
      gstTreatment: "CGST_SGST",
      gstRatePercent: 3,
      pieces: [{ carat: 10 }],
    });
    const lines = linesFor(fixture, lot.voucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(Number(lineFor(fixture, lot.voucherId as string, SYSTEM_ACCOUNT_CODES.INPUT_CGST)?.debit)).toBe(15);
    expect(Number(lineFor(fixture, lot.voucherId as string, SYSTEM_ACCOUNT_CODES.INPUT_SGST)?.debit)).toBe(15);
    expect(Number(lineFor(fixture, lot.voucherId as string, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE)?.credit)).toBe(1030);
  });

  it("settles immediately via a payment account, netting Accounts Payable to zero", async () => {
    const fixture = createFakeDiamondTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;
    const lot = await createRoughLotWithPieces(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      purchaseRate: 100,
      rateBasis: "PER_CARAT",
      totalPurchaseCost: 500,
      gstTreatment: "NONE",
      paymentAccountId: cashId,
      pieces: [{ carat: 5 }],
    });
    const lines = linesFor(fixture, lot.voucherId as string);
    const apLines = lines.filter((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE);
    const apNet = sumBy(apLines, "debit") - sumBy(apLines, "credit");
    expect(apNet).toBe(0);
    expect(Number(lineFor(fixture, lot.voucherId as string, "1001")?.credit)).toBe(500);
  });

  it("rejects a zero total purchase cost", async () => {
    const fixture = createFakeDiamondTx();
    await expect(purchaseSinglePiece(fixture, { carat: 1, cost: 0 })).rejects.toThrow(PostingError);
  });

  it("rejects a purchase with no pieces", async () => {
    const fixture = createFakeDiamondTx();
    await expect(
      createRoughLotWithPieces(fixture.tx as never, {
        ...common(),
        purchaseDate: DATE,
        supplierId: "supplier-1",
        purchaseRate: 100,
        rateBasis: "PER_CARAT",
        totalPurchaseCost: 100,
        gstTreatment: "NONE",
        pieces: [],
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("issueRoughToKarigar", () => {
  it("issues a piece, locks its cost, and posts a balanced WIP transfer", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 2, cost: 10000 });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;

    const job = await issueRoughToKarigar(fixture.tx as never, {
      ...common(),
      karigarId: "karigar-1",
      roughPieceIds: [piece.id as string],
      requiredShape: "ROUND",
      issueDate: DATE,
    });

    expect(job.issuedRoughCarat.toString()).toBe("2.000");
    expect(Number(job.issuedCostValue)).toBe(10000);
    expect(Number(job.remainingWipCost)).toBe(10000);

    const updatedPiece = fixture.state.roughPieces.get(piece.id as string)!;
    expect(updatedPiece.status).toBe("WITH_KARIGAR");
    expect(updatedPiece.costLocked).toBe(true);

    const lines = linesFor(fixture, job.wipVoucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(Number(lineFor(fixture, job.wipVoucherId as string, SYSTEM_ACCOUNT_CODES.DIAMOND_WIP)?.debit)).toBe(10000);
    expect(Number(lineFor(fixture, job.wipVoucherId as string, SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY)?.credit)).toBe(10000);
  });

  it("rejects issuing a piece that is not Available (duplicate/over-issue prevention)", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 2, cost: 10000 });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;

    await issueRoughToKarigar(fixture.tx as never, {
      ...common(),
      karigarId: "karigar-1",
      roughPieceIds: [piece.id as string],
      requiredShape: "ROUND",
      issueDate: DATE,
    });

    await expect(
      issueRoughToKarigar(fixture.tx as never, {
        ...common(),
        karigarId: "karigar-2",
        roughPieceIds: [piece.id as string],
        requiredShape: "OVAL",
        issueDate: DATE,
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects selecting the same piece twice in one issue", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 2, cost: 10000 });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;

    await expect(
      issueRoughToKarigar(fixture.tx as never, {
        ...common(),
        karigarId: "karigar-1",
        roughPieceIds: [piece.id as string, piece.id as string],
        requiredShape: "ROUND",
        issueDate: DATE,
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("cancelDiamondJob", () => {
  it("returns the piece to Available and reverses the WIP voucher", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 2, cost: 10000 });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;
    const job = await issueRoughToKarigar(fixture.tx as never, {
      ...common(),
      karigarId: "karigar-1",
      roughPieceIds: [piece.id as string],
      requiredShape: "ROUND",
      issueDate: DATE,
    });

    await cancelDiamondJob(fixture.tx as never, {
      ...FY,
      jobId: job.id as string,
      cancelledByUserId: "user-1",
      cancellationReason: "Wrong Karigar",
    });

    expect(fixture.state.roughPieces.get(piece.id as string)!.status).toBe("AVAILABLE");
    expect(fixture.state.diamondJobs.get(job.id as string)!.status).toBe("CANCELLED");

    const original = fixture.state.vouchers.get(job.wipVoucherId as string)!;
    expect(original.status).toBe("CANCELLED");
    const reversal = [...fixture.state.vouchers.values()].find((v) => v.reversalOfVoucherId === job.wipVoucherId);
    expect(reversal).toBeTruthy();
    const reversalLines = linesFor(fixture, reversal!.id as string);
    expect(sumBy(reversalLines, "debit")).toBeCloseTo(sumBy(reversalLines, "credit"), 5);
    expect(Number(lineFor(fixture, reversal!.id as string, SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY)?.debit)).toBe(10000);
  });

  it("rejects cancelling an already-cancelled job", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 2, cost: 10000 });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;
    const job = await issueRoughToKarigar(fixture.tx as never, {
      ...common(),
      karigarId: "karigar-1",
      roughPieceIds: [piece.id as string],
      requiredShape: "ROUND",
      issueDate: DATE,
    });
    await cancelDiamondJob(fixture.tx as never, {
      ...FY,
      jobId: job.id as string,
      cancelledByUserId: "user-1",
      cancellationReason: "first",
    });

    await expect(
      cancelDiamondJob(fixture.tx as never, {
        ...FY,
        jobId: job.id as string,
        cancelledByUserId: "user-1",
        cancellationReason: "second",
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects cancelling a job that has already received material", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 2, cost: 10000 });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;
    const job = await issueRoughToKarigar(fixture.tx as never, {
      ...common(),
      karigarId: "karigar-1",
      roughPieceIds: [piece.id as string],
      requiredShape: "ROUND",
      issueDate: DATE,
    });
    await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 0,
      shape: "ROUND",
      markJobComplete: true,
      outputs: [{ shape: "ROUND", carat: 1.8 }],
    });

    await expect(
      cancelDiamondJob(fixture.tx as never, {
        ...FY,
        jobId: job.id as string,
        cancelledByUserId: "user-1",
        cancellationReason: "too late",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("receivePolishedDiamonds", () => {
  async function setupJob(fixture: ReturnType<typeof createFakeDiamondTx>, carat: number, cost: number) {
    const lot = await purchaseSinglePiece(fixture, { carat, cost });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;
    return issueRoughToKarigar(fixture.tx as never, {
      ...common(),
      karigarId: "karigar-1",
      roughPieceIds: [piece.id as string],
      requiredShape: "ROUND",
      issueDate: DATE,
    });
  }

  it("completes a job on a single full receipt with recognized weight loss, absorbed into polished cost", async () => {
    const fixture = createFakeDiamondTx();
    const job = await setupJob(fixture, 2, 10000);

    const result = await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 500,
      shape: "ROUND",
      markJobComplete: true,
      outputs: [{ shape: "ROUND", carat: 1.8 }],
    });

    expect(result.receipt.weightLossCarat.toString()).toBe("0.200");
    expect(Number(result.receipt.yieldPercent)).toBe(90);
    expect(Number(result.outputs[0].allocatedCost)).toBe(10500);

    const updatedJob = fixture.state.diamondJobs.get(job.id as string)!;
    expect(updatedJob.status).toBe("COMPLETED");
    expect(Number(updatedJob.remainingWipCost)).toBe(0);

    const lines = linesFor(fixture, result.receipt.postingVoucherId as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(
      Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)?.debit)
    ).toBe(10500);
    expect(Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.DIAMOND_WIP)?.credit)).toBe(10000);
    expect(Number(lineFor(fixture, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE)?.credit)).toBe(500);

    const allPieces = [...fixture.state.roughPieces.values()];
    const originalPiece = allPieces.find((p) => p.lotId != null)!;
    expect(originalPiece.status).toBe("COMPLETED");
  });

  it("auto-completes with zero loss when polished carat exactly matches pending carat", async () => {
    const fixture = createFakeDiamondTx();
    const job = await setupJob(fixture, 2, 10000);

    const result = await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 0,
      shape: "ROUND",
      markJobComplete: false,
      outputs: [{ shape: "ROUND", carat: 2 }],
    });

    expect(result.receipt.weightLossCarat.toString()).toBe("0.000");
    expect(fixture.state.diamondJobs.get(job.id as string)!.status).toBe("COMPLETED");
  });

  it("does NOT recognize loss on a partial receipt without markJobComplete — material stays 'with Karigar'", async () => {
    const fixture = createFakeDiamondTx();
    const job = await setupJob(fixture, 3, 15000);

    const result = await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0.5,
      labourCharge: 0,
      shape: "ROUND",
      markJobComplete: false,
      outputs: [{ shape: "ROUND", carat: 1 }],
    });

    expect(result.receipt.weightLossCarat.toString()).toBe("0.000");
    const updatedJob = fixture.state.diamondJobs.get(job.id as string)!;
    expect(updatedJob.status).toBe("PARTIALLY_RECEIVED");
    // Cost drains only proportionally: (1.0+0.5)/3.0 * 15000 = 7500, leaving 7500.
    expect(Number(updatedJob.remainingWipCost)).toBe(7500);

    const link = [...fixture.state.diamondJobPieces.values()].find((l) => l.jobId === job.id)!;
    expect(fixture.state.roughPieces.get(link.roughPieceId as string)!.status).toBe("WITH_KARIGAR");

    const leftover = [...fixture.state.roughPieces.values()].find((p) => p.returnedFromJobId === job.id);
    expect(leftover).toBeTruthy();
    expect(Number(leftover!.carat)).toBe(0.5);
    expect(Number(leftover!.allocatedCost)).toBe(2500);
    expect(leftover!.status).toBe("AVAILABLE");
  });

  it("resolves correctly across two partial receipts, closing the job with the exact remaining cost and correct cumulative yield", async () => {
    const fixture = createFakeDiamondTx();
    const job = await setupJob(fixture, 3, 15000);

    await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0.5,
      labourCharge: 0,
      shape: "ROUND",
      markJobComplete: false,
      outputs: [{ shape: "ROUND", carat: 1 }],
    });

    const second = await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 200,
      shape: "ROUND",
      markJobComplete: true,
      outputs: [{ shape: "ROUND", carat: 1.3 }],
    });

    const finalJob = fixture.state.diamondJobs.get(job.id as string)!;
    expect(finalJob.status).toBe("COMPLETED");
    expect(Number(finalJob.remainingWipCost)).toBe(0);
    expect(Number(finalJob.receivedPolishedCarat)).toBe(2.3);
    expect(Number(finalJob.returnedRoughCarat)).toBe(0.5);
    // Final receipt takes exactly whatever WIP cost remains: 15000-7500=7500.
    expect(second.receipt.weightLossCarat.toString()).toBe("0.200");
    expect(Number(second.outputs[0].allocatedCost)).toBe(7700); // 7500 remaining cost + 200 labour
  });

  it("allocates a receipt's cost across multiple outputs proportionally by carat, summing exactly", async () => {
    const fixture = createFakeDiamondTx();
    const job = await setupJob(fixture, 3, 9000);

    const result = await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 0,
      shape: "ROUND",
      markJobComplete: true,
      outputs: [
        { shape: "ROUND", carat: 1 },
        { shape: "ROUND", carat: 2 },
      ],
    });

    const total = result.outputs.reduce((sum, o) => sum + Number(o.allocatedCost), 0);
    expect(total.toFixed(2)).toBe("9000.00");
    const costs = result.outputs.map((o) => Number(o.allocatedCost)).sort((a, b) => a - b);
    expect(costs).toEqual([3000, 6000]);
  });

  it("rejects polished plus returned carat exceeding what's pending", async () => {
    const fixture = createFakeDiamondTx();
    const job = await setupJob(fixture, 1, 5000);

    await expect(
      receivePolishedDiamonds(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        receiveDate: DATE,
        returnedRoughCarat: 0.5,
        labourCharge: 0,
        shape: "ROUND",
        markJobComplete: false,
        outputs: [{ shape: "ROUND", carat: 0.8 }],
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects receiving against a completed job", async () => {
    const fixture = createFakeDiamondTx();
    const job = await setupJob(fixture, 1, 5000);
    await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 0,
      shape: "ROUND",
      markJobComplete: true,
      outputs: [{ shape: "ROUND", carat: 1 }],
    });

    await expect(
      receivePolishedDiamonds(fixture.tx as never, {
        ...common(),
        jobId: job.id as string,
        receiveDate: DATE,
        returnedRoughCarat: 0,
        labourCharge: 0,
        shape: "ROUND",
        markJobComplete: false,
        outputs: [{ shape: "ROUND", carat: 0.1 }],
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("recutPolishedDiamond", () => {
  it("marks an Available polished diamond as Recut with a movement", async () => {
    const fixture = createFakeDiamondTx();
    const job = await (async () => {
      const lot = await purchaseSinglePiece(fixture, { carat: 1, cost: 5000 });
      const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;
      return issueRoughToKarigar(fixture.tx as never, {
        ...common(),
        karigarId: "karigar-1",
        roughPieceIds: [piece.id as string],
        requiredShape: "ROUND",
        issueDate: DATE,
      });
    })();
    const result = await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 0,
      shape: "ROUND",
      markJobComplete: true,
      outputs: [{ shape: "ROUND", carat: 0.9 }],
    });
    const polishedId = result.outputs[0].id as string;

    await recutPolishedDiamond(fixture.tx as never, {
      polishedDiamondId: polishedId,
      reason: "Chip found",
      recutByUserId: "user-1",
    });

    expect(fixture.state.polishedDiamonds.get(polishedId)!.status).toBe("RECUT");

    await expect(
      recutPolishedDiamond(fixture.tx as never, {
        polishedDiamondId: polishedId,
        reason: "Again",
        recutByUserId: "user-1",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("overrideRoughPieceAllocations", () => {
  it("allows reallocation before any issue, requiring an exact sum and a reason", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await createRoughLotWithPieces(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      purchaseRate: 100,
      rateBasis: "PER_CARAT",
      totalPurchaseCost: 100,
      gstTreatment: "NONE",
      pieces: [{ carat: 1 }, { carat: 1 }],
    });
    const pieces = [...fixture.state.roughPieces.values()].filter((p) => p.lotId === lot.id);

    await overrideRoughPieceAllocations(fixture.tx as never, {
      lotId: lot.id as string,
      reason: "Owner correction",
      adjustments: [
        { pieceId: pieces[0].id as string, newAllocatedCost: 80 },
        { pieceId: pieces[1].id as string, newAllocatedCost: 20 },
      ],
    });

    expect(Number(fixture.state.roughPieces.get(pieces[0].id as string)!.allocatedCost)).toBe(80);
    expect(Number(fixture.state.roughPieces.get(pieces[1].id as string)!.allocatedCost)).toBe(20);
  });

  it("rejects an override once a piece has been issued", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 1, cost: 100 });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;
    await issueRoughToKarigar(fixture.tx as never, {
      ...common(),
      karigarId: "karigar-1",
      roughPieceIds: [piece.id as string],
      requiredShape: "ROUND",
      issueDate: DATE,
    });

    await expect(
      overrideRoughPieceAllocations(fixture.tx as never, {
        lotId: lot.id as string,
        reason: "too late",
        adjustments: [{ pieceId: piece.id as string, newAllocatedCost: 50 }],
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects a new total that doesn't match the lot's cost", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 1, cost: 100 });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;

    await expect(
      overrideRoughPieceAllocations(fixture.tx as never, {
        lotId: lot.id as string,
        reason: "mismatch",
        adjustments: [{ pieceId: piece.id as string, newAllocatedCost: 999 }],
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("overridePolishedAllocations", () => {
  it("allows reallocation across Available outputs of the same receipt with an exact sum", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await purchaseSinglePiece(fixture, { carat: 3, cost: 9000 });
    const piece = [...fixture.state.roughPieces.values()].find((p) => p.lotId === lot.id)!;
    const job = await issueRoughToKarigar(fixture.tx as never, {
      ...common(),
      karigarId: "karigar-1",
      roughPieceIds: [piece.id as string],
      requiredShape: "ROUND",
      issueDate: DATE,
    });
    const result = await receivePolishedDiamonds(fixture.tx as never, {
      ...common(),
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 0,
      shape: "ROUND",
      markJobComplete: true,
      outputs: [
        { shape: "ROUND", carat: 1 },
        { shape: "ROUND", carat: 2 },
      ],
    });

    await overridePolishedAllocations(fixture.tx as never, {
      receiptId: result.receipt.id as string,
      reason: "Owner correction",
      adjustments: [
        { polishedDiamondId: result.outputs[0].id as string, newAllocatedCost: 4000 },
        { polishedDiamondId: result.outputs[1].id as string, newAllocatedCost: 5000 },
      ],
    });

    expect(Number(fixture.state.polishedDiamonds.get(result.outputs[0].id as string)!.allocatedCost)).toBe(4000);
    expect(Number(fixture.state.polishedDiamonds.get(result.outputs[1].id as string)!.allocatedCost)).toBe(5000);
  });
});
