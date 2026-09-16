import { describe, expect, it } from "vitest";

import { createFakeDiamondTx } from "../../../test/fixtures/fakeDiamondTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, ZERO } from "@/lib/accounting/money";
import {
  createRoughLotWithPieces,
  issueRoughToKarigar,
  receivePolishedDiamonds,
  receiveProcessedRough,
} from "./posting";

// Phase 7 P2 — Manufacturer processes on the existing Diamond Job engine:
// process snapshot at issue, rate-based charges, processed-rough returns
// for ROUGH-output processes (4P / Laser, HPHT / Grow, Rough Polish).

type Fixture = ReturnType<typeof createFakeDiamondTx>;
const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-17T00:00:00.000Z");

function voucherLine(f: Fixture, voucherId: string, code: string, side: "debit" | "credit"): string {
  const id = f.state.accounts.get(code)!.id;
  return f.state.journalEntries
    .filter((e) => e.voucherId === voucherId && e.accountId === id)
    .reduce((sum, e) => sum.plus(new Decimal(e[side] as string)), ZERO)
    .toFixed(2);
}

function expectBalanced(f: Fixture) {
  for (const voucherId of f.state.vouchers.keys()) {
    const lines = f.state.journalEntries.filter((e) => e.voucherId === voucherId);
    const debit = lines.reduce((s, e) => s.plus(new Decimal(e.debit as string)), ZERO);
    const credit = lines.reduce((s, e) => s.plus(new Decimal(e.credit as string)), ZERO);
    expect(debit.toFixed(2)).toBe(credit.toFixed(2));
    expect(new Decimal(f.state.vouchers.get(voucherId)!.amount as string).toFixed(2)).toBe(debit.toFixed(2));
  }
}

async function issueWithProcess(
  f: Fixture,
  opts: { outputKind: "ROUGH" | "POLISHED"; name: string; basis?: "FIXED" | "PER_CARAT" | "PER_PIECE"; rate?: number }
) {
  const process = f.seedDiamondProcess({ name: opts.name, outputKind: opts.outputKind });
  const lot = await createRoughLotWithPieces(f.tx as never, {
    ...FY,
    purchaseDate: DATE,
    supplierId: "supplier-1",
    purchaseRate: 5000,
    rateBasis: "PER_CARAT",
    currencyCode: "INR",
    exchangeRate: 1,
    totalPurchaseCost: 50000,
    gstTreatment: "NONE",
    createdByUserId: "user-1",
    pieces: [{ carat: 6 }, { carat: 4 }],
  });
  const pieceIds = [...f.state.roughPieces.values()].filter((p) => p.lotId === lot.id).map((p) => p.id as string);
  const job = await issueRoughToKarigar(f.tx as never, {
    ...FY,
    karigarId: "manufacturer-1",
    roughPieceIds: pieceIds,
    requiredShape: "ROUND",
    issueDate: DATE,
    processId: process.id,
    chargeRateBasis: opts.basis ?? null,
    chargeRate: opts.rate ?? null,
    createdByUserId: "user-1",
  });
  return { job, process };
}

describe("Phase 7 — Manufacturer process on a Diamond Job", () => {
  it("snapshots the process name, output kind and agreed rate at issue", async () => {
    const f = createFakeDiamondTx();
    const { job } = await issueWithProcess(f, { outputKind: "ROUGH", name: "HPHT / Grow", basis: "PER_CARAT", rate: 750 });
    expect(job.processNameSnapshot).toBe("HPHT / Grow");
    expect(job.processOutputKindSnapshot).toBe("ROUGH");
    expect(job.chargeRateBasis).toBe("PER_CARAT");
    expect(job.chargeRate).toBe("750.0000");
  });

  it("refuses an inactive process", async () => {
    const f = createFakeDiamondTx();
    const process = f.seedDiamondProcess({ name: "4P / Laser", outputKind: "ROUGH", isActive: false });
    const lot = await createRoughLotWithPieces(f.tx as never, {
      ...FY, purchaseDate: DATE, supplierId: "supplier-1", purchaseRate: 1000, rateBasis: "PER_CARAT", currencyCode: "INR",
      exchangeRate: 1, totalPurchaseCost: 1000, gstTreatment: "NONE", createdByUserId: "user-1", pieces: [{ carat: 1 }],
    });
    const pieceIds = [...f.state.roughPieces.values()].filter((p) => p.lotId === lot.id).map((p) => p.id as string);
    await expect(
      issueRoughToKarigar(f.tx as never, {
        ...FY,
        karigarId: "manufacturer-1",
        roughPieceIds: pieceIds,
        requiredShape: "ROUND",
        issueDate: DATE,
        processId: process.id,
        createdByUserId: "user-1",
      })
    ).rejects.toThrow(/inactive/);
  });

  it("returns processed rough as new Available rough pieces carrying resolved cost plus the per-carat charge", async () => {
    const f = createFakeDiamondTx();
    const { job } = await issueWithProcess(f, { outputKind: "ROUGH", name: "4P / Laser", basis: "PER_CARAT", rate: 500 });

    // 10ct issued at 50000.00; 9.5ct comes back processed, job closed:
    // 0.5ct normal loss is absorbed, charge = 9.5 × 500 = 4750.00.
    const result = await receiveProcessedRough(f.tx as never, {
      ...FY,
      jobId: job.id as string,
      receiveDate: DATE,
      pieces: [{ carat: 5.7 }, { carat: 3.8 }],
      markJobComplete: true,
      createdByUserId: "user-1",
    });

    const voucherId = result.receipt.postingVoucherId as string;
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY, "debit")).toBe("54750.00");
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.DIAMOND_WIP, "credit")).toBe("50000.00");
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, "credit")).toBe("4750.00");
    expect(result.pieces.map((p) => p.status)).toEqual(["AVAILABLE", "AVAILABLE"]);
    const pieceCost = result.pieces.reduce((s, p) => s.plus(new Decimal(p.allocatedCost)), ZERO);
    expect(pieceCost.toFixed(2)).toBe("54750.00");
    expect(result.receipt.weightLossCarat).toBe("0.500");
    expect(result.job.status).toBe("COMPLETED");
    expect(result.job.remainingWipCost).toBe("0.00");
    expectBalanced(f);
  });

  it("a partial processed return keeps the rest with the Manufacturer — no loss recognised", async () => {
    const f = createFakeDiamondTx();
    const { job } = await issueWithProcess(f, { outputKind: "ROUGH", name: "HPHT / Grow" });

    const result = await receiveProcessedRough(f.tx as never, {
      ...FY,
      jobId: job.id as string,
      receiveDate: DATE,
      pieces: [{ carat: 4 }],
      manualCharge: 1200,
      markJobComplete: false,
      createdByUserId: "user-1",
    });

    expect(result.receipt.weightLossCarat).toBe("0.000");
    expect(result.job.status).toBe("PARTIALLY_RECEIVED");
    // 4 of 10ct → 20000.00 resolved; 30000.00 stays in WIP.
    expect(result.job.remainingWipCost).toBe("30000.00");
    expect(voucherLine(f, result.receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, "credit")).toBe("1200.00");
    expectBalanced(f);
  });

  it("a fixed charge posts only on the receipt that closes the job", async () => {
    const f = createFakeDiamondTx();
    const { job } = await issueWithProcess(f, { outputKind: "ROUGH", name: "Rough Polish", basis: "FIXED", rate: 3000 });
    const first = await receiveProcessedRough(f.tx as never, {
      ...FY, jobId: job.id as string, receiveDate: DATE, pieces: [{ carat: 5 }], markJobComplete: false, createdByUserId: "user-1",
    });
    expect(first.receipt.labourCharge).toBe("0.00");
    const second = await receiveProcessedRough(f.tx as never, {
      ...FY, jobId: job.id as string, receiveDate: DATE, pieces: [{ carat: 4.9 }], markJobComplete: true, createdByUserId: "user-1",
    });
    expect(second.receipt.labourCharge).toBe("3000.00");
    expect(second.job.totalLabourCharge).toBe("3000.00");
    expectBalanced(f);
  });

  it("refuses a manual charge that disagrees with the agreed rate", async () => {
    const f = createFakeDiamondTx();
    const { job } = await issueWithProcess(f, { outputKind: "ROUGH", name: "4P / Laser", basis: "PER_CARAT", rate: 500 });
    await expect(
      receiveProcessedRough(f.tx as never, {
        ...FY, jobId: job.id as string, receiveDate: DATE, pieces: [{ carat: 2 }], manualCharge: 999, markJobComplete: false, createdByUserId: "user-1",
      })
    ).rejects.toThrow(/agreed rate/);
  });

  it("a rough process job cannot receive polished diamonds, and a polished job cannot receive processed rough", async () => {
    const f = createFakeDiamondTx();
    const rough = await issueWithProcess(f, { outputKind: "ROUGH", name: "4P / Laser" });
    await expect(
      receivePolishedDiamonds(f.tx as never, {
        ...FY, jobId: rough.job.id as string, receiveDate: DATE, returnedRoughCarat: 0, labourCharge: 0, shape: "ROUND",
        outputs: [{ shape: "ROUND", carat: 1 }], markJobComplete: false, createdByUserId: "user-1",
      })
    ).rejects.toThrow(/processed rough/);

    const g = createFakeDiamondTx();
    const polished = await issueWithProcess(g, { outputKind: "POLISHED", name: "Polishing" });
    await expect(
      receiveProcessedRough(g.tx as never, {
        ...FY, jobId: polished.job.id as string, receiveDate: DATE, pieces: [{ carat: 1 }], markJobComplete: false, createdByUserId: "user-1",
      })
    ).rejects.toThrow(/rough process/);
  });

  it("a Polishing job with a per-piece rate computes the labour charge, and the voucher amount includes returned rough", async () => {
    const f = createFakeDiamondTx();
    const { job } = await issueWithProcess(f, { outputKind: "POLISHED", name: "Polishing", basis: "PER_PIECE", rate: 250 });
    const result = await receivePolishedDiamonds(f.tx as never, {
      ...FY, jobId: job.id as string, receiveDate: DATE, returnedRoughCarat: 2, labourCharge: 0, shape: "ROUND",
      outputs: [{ shape: "ROUND", carat: 3 }, { shape: "ROUND", carat: 2.5 }], markJobComplete: true, createdByUserId: "user-1",
    });
    expect(result.receipt.labourCharge).toBe("500.00");
    expectBalanced(f);
  });
});
