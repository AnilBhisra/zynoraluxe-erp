import { describe, expect, it } from "vitest";

import { createFakeDiamondTx } from "../../../test/fixtures/fakeDiamondTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import {
  cancelDiamondJob,
  createRoughLotWithPieces,
  issueRoughToKarigar,
  PostingError,
  receivePolishedDiamonds,
} from "./posting";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-06-15T00:00:00.000Z");

type Fixture = ReturnType<typeof createFakeDiamondTx>;

function common(overrides: Partial<Record<string, unknown>> = {}) {
  return { date: DATE, ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: "user-1", ...overrides };
}

function codeOf(fixture: Fixture, accountId: unknown) {
  for (const [code, row] of fixture.state.accounts) if (row.id === accountId) return code;
  return undefined;
}
function amountOn(fixture: Fixture, voucherId: string, code: string, side: "debit" | "credit") {
  return fixture.state.journalEntries
    .filter((e) => e.voucherId === voucherId && codeOf(fixture, e.accountId) === code)
    .reduce((sum, e) => sum + Number(e[side]), 0);
}

async function buyParcel(
  fixture: Fixture,
  opts: { carat: string; cost: string; pieceCount?: number | null; kind?: "STONE" | "PARCEL" }
) {
  return createRoughLotWithPieces(fixture.tx as never, {
    ...common(),
    purchaseDate: DATE,
    supplierId: "supplier-1",
    purchaseRate: 2500,
    rateBasis: "PER_CARAT",
    totalPurchaseCost: opts.cost,
    gstTreatment: "NONE",
    pieces: [{ kind: opts.kind ?? "PARCEL", pieceCount: opts.pieceCount ?? null, carat: opts.carat }],
  });
}

function pieceRows(fixture: Fixture, lotId: string) {
  return [...fixture.state.roughPieces.values()].filter((p) => p.lotId === lotId);
}
function parcelOf(fixture: Fixture, lotId: string) {
  return pieceRows(fixture, lotId).find((p) => !p.parentPieceId)!;
}
function issue(
  fixture: Fixture,
  parcelId: string,
  carat: string | number,
  extra: { pieceCount?: number | null; idempotencyKey?: string } = {}
) {
  return issueRoughToKarigar(fixture.tx as never, {
    ...FY,
    karigarId: "karigar-1",
    parcelIssues: [{ roughPieceId: parcelId, carat, pieceCount: extra.pieceCount }],
    requiredShape: "ROUND",
    issueDate: DATE,
    idempotencyKey: extra.idempotencyKey ?? null,
    createdByUserId: "user-1",
  });
}

describe("recording a parcel at purchase", () => {
  it("keeps a parcel and an individual stone apart, and snapshots the parcel as bought", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await createRoughLotWithPieces(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      purchaseRate: 2500,
      rateBasis: "PER_CARAT",
      totalPurchaseCost: "750000.00",
      gstTreatment: "NONE",
      pieces: [{ kind: "PARCEL", pieceCount: 1200, carat: "300.000" }],
    });
    const parcel = parcelOf(fixture, lot.id);
    expect(parcel.kind).toBe("PARCEL");
    expect(parcel.pieceCount).toBe(1200);
    expect(parcel.originalCarat).toBe("300.000");
    expect(parcel.originalPieceCount).toBe(1200);
    expect(parcel.originalCost).toBe("750000.00");
    expect(lot.piecesCount).toBe(1);
    expect(lot.totalRoughCarat).toBe("300.000");
  });

  it("defaults to an individual stone — nothing is silently a parcel", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await createRoughLotWithPieces(fixture.tx as never, {
      ...common(),
      purchaseDate: DATE,
      supplierId: "supplier-1",
      purchaseRate: 1000,
      rateBasis: "PER_CARAT",
      totalPurchaseCost: "5000.00",
      gstTreatment: "NONE",
      pieces: [{ carat: "5.000" }],
    });
    const stone = parcelOf(fixture, lot.id);
    expect(stone.kind).toBe("STONE");
    expect(stone.pieceCount).toBeNull();
    expect(stone.originalCarat).toBeNull();
  });

  it("refuses a stone count on an individual stone and an invalid parcel count", async () => {
    const fixture = createFakeDiamondTx();
    await expect(buyParcel(fixture, { carat: "5", cost: "100", kind: "STONE", pieceCount: 3 })).rejects.toThrow(
      /individual stone cannot have a stone count/
    );
    await expect(buyParcel(fixture, { carat: "5", cost: "100", pieceCount: 0 })).rejects.toThrow(PostingError);
    await expect(buyParcel(fixture, { carat: "5", cost: "100", pieceCount: 2.5 })).rejects.toThrow(PostingError);
  });
});

describe("issuing part of a parcel", () => {
  it("300 ct at ₹7,50,000: issues 100 ct at ₹2,50,000 and retains 200 ct at ₹5,00,000", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "300.000", cost: "750000.00", pieceCount: 1200 });
    const parcel = parcelOf(fixture, lot.id);

    const job = await issue(fixture, parcel.id as string, "100.000", { pieceCount: 400 });

    // The parcel keeps the retained balance...
    expect(parcel.carat).toBe("200.000");
    expect(parcel.allocatedCost).toBe("500000.00");
    expect(parcel.pieceCount).toBe(800);
    expect(parcel.status).toBe("AVAILABLE");
    // ...and the issued portion is its own linked row.
    const child = pieceRows(fixture, lot.id).find((p) => p.parentPieceId === parcel.id)!;
    expect(child.carat).toBe("100.000");
    expect(child.allocatedCost).toBe("250000.00");
    expect(child.pieceCount).toBe(400);
    expect(child.status).toBe("WITH_KARIGAR");
    expect(child.kind).toBe("PARCEL");
    // The original purchase is untouched.
    expect(parcel.originalCarat).toBe("300.000");
    expect(parcel.originalCost).toBe("750000.00");
    expect(lot.totalRoughCarat).toBe("300.000");
    expect(lot.totalPurchaseCost).toBe("750000.00");

    expect(job.issuedRoughCarat).toBe("100.000");
    expect(job.issuedCostValue).toBe("250000.00");
    expect(job.remainingWipCost).toBe("250000.00");
    expect(job.issuedPiecesCount).toBe(400);

    // WIP voucher moves exactly the issued value, no more.
    expect(amountOn(fixture, job.wipVoucherId as string, SYSTEM_ACCOUNT_CODES.DIAMOND_WIP, "debit")).toBe(250000);
    expect(amountOn(fixture, job.wipVoucherId as string, SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY, "credit")).toBe(250000);

    // Audit: split pair + normal issue movement, all pointing at the job.
    const types = [...fixture.state.stockMovements.values()]
      .filter((m) => m.diamondJobId === job.id)
      .map((m) => m.type)
      .sort();
    expect(types).toEqual(["ROUGH_ISSUE_OUT", "ROUGH_PARCEL_SPLIT_IN", "ROUGH_PARCEL_SPLIT_OUT"]);
  });

  it("splits cost exactly: the issued share is rounded once and the remainder is what is left", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "3.000", cost: "100.00" });
    const parcel = parcelOf(fixture, lot.id);
    await issue(fixture, parcel.id as string, "1.000");
    const child = pieceRows(fixture, lot.id).find((p) => p.parentPieceId === parcel.id)!;
    expect(child.allocatedCost).toBe("33.33");
    expect(parcel.allocatedCost).toBe("66.67");
    expect(Number(child.allocatedCost) + Number(parcel.allocatedCost)).toBeCloseTo(100, 10);
  });

  it("never drifts by a paisa across many awkward splits", async () => {
    // Property check: whatever the carat and cost, issued + retained == the parcel.
    const cases: [string, string, string][] = [
      ["7.777", "12345.67", "2.345"],
      ["0.999", "0.07", "0.333"],
      ["1234.567", "9999999.99", "617.283"],
      ["10.000", "0.05", "3.333"],
      ["55.555", "1.03", "55.554"],
    ];
    for (const [carat, cost, issued] of cases) {
      const fixture = createFakeDiamondTx();
      const lot = await buyParcel(fixture, { carat, cost });
      const parcel = parcelOf(fixture, lot.id);
      await issue(fixture, parcel.id as string, issued);
      const child = pieceRows(fixture, lot.id).find((p) => p.parentPieceId === parcel.id)!;
      const totalCents = Math.round(Number(child.allocatedCost) * 100) + Math.round(Number(parcel.allocatedCost) * 100);
      expect(totalCents).toBe(Math.round(Number(cost) * 100));
      expect(Number(child.carat) + Number(parcel.carat)).toBeCloseTo(Number(carat), 10);
    }
  });

  it("refuses a portion so small its share of the cost rounds to nothing", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "10.000", cost: "0.01" });
    const parcel = parcelOf(fixture, lot.id);
    await expect(issue(fixture, parcel.id as string, "3.333")).rejects.toThrow(/less than ₹0.01/);
    expect(parcel.carat).toBe("10.000");
  });

  it("issuing the whole remaining parcel issues the row itself — no split, no child", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "300.000", cost: "750000.00", pieceCount: 10 });
    const parcel = parcelOf(fixture, lot.id);
    const job = await issue(fixture, parcel.id as string, "300.000", { pieceCount: 10 });
    expect(pieceRows(fixture, lot.id)).toHaveLength(1);
    expect(parcel.status).toBe("WITH_KARIGAR");
    expect(job.issuedCostValue).toBe("750000.00");
  });

  it("refuses to over-issue, and every invalid quantity", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "300.000", cost: "750000.00", pieceCount: 1200 });
    const parcel = parcelOf(fixture, lot.id);
    const id = parcel.id as string;

    await expect(issue(fixture, id, "300.001", { pieceCount: 1 })).rejects.toThrow(/only 300\.000ct remain/);
    await expect(issue(fixture, id, "0", { pieceCount: 1 })).rejects.toThrow(/greater than zero/);
    await expect(issue(fixture, id, "-5", { pieceCount: 1 })).rejects.toThrow(/greater than zero/);
    await expect(issue(fixture, id, "10.1234", { pieceCount: 1 })).rejects.toThrow(/at most 3 decimal places/);
    await expect(issue(fixture, id, "abc", { pieceCount: 1 })).rejects.toThrow(/not a valid number/);
    await expect(issue(fixture, id, Number.NaN, { pieceCount: 1 })).rejects.toThrow(/not a valid number/);
    // Nothing moved on any refusal.
    expect(parcel.carat).toBe("300.000");
    expect(parcel.allocatedCost).toBe("750000.00");
    expect(fixture.state.diamondJobs.size).toBe(0);
    expect(fixture.state.vouchers.size).toBe(1); // just the purchase voucher
  });

  it("enforces the recorded stone count rules", async () => {
    const fixture = createFakeDiamondTx();
    const counted = await buyParcel(fixture, { carat: "300.000", cost: "750000.00", pieceCount: 1200 });
    const uncounted = await buyParcel(fixture, { carat: "50.000", cost: "10000.00" });
    const countedId = parcelOf(fixture, counted.id).id as string;
    const uncountedId = parcelOf(fixture, uncounted.id).id as string;

    await expect(issue(fixture, countedId, "100")).rejects.toThrow(/Enter how many stones/);
    await expect(issue(fixture, countedId, "100", { pieceCount: 1200 })).rejects.toThrow(/at least one must stay/);
    await expect(issue(fixture, countedId, "100", { pieceCount: 1500 })).rejects.toThrow(/at least one must stay/);
    await expect(issue(fixture, countedId, "100", { pieceCount: 0 })).rejects.toThrow(/whole number of at least 1/);
    await expect(issue(fixture, countedId, "300", { pieceCount: 5 })).rejects.toThrow(/all 1200 stones/);
    await expect(issue(fixture, uncountedId, "10", { pieceCount: 5 })).rejects.toThrow(/no recorded stone count/);
    // Where no count is recorded, a carat-only issue works.
    await expect(issue(fixture, uncountedId, "10")).resolves.toBeTruthy();
  });

  it("only a parcel can be issued by carat — an individual stone is never reinterpreted", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "5.000", cost: "5000.00", kind: "STONE" });
    const stone = parcelOf(fixture, lot.id);
    await expect(issue(fixture, stone.id as string, "2")).rejects.toThrow(/individual stone/);
    expect(stone.carat).toBe("5.000");
  });

  it("refuses a row selected twice, or already out with a Manufacturer", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "300.000", cost: "750000.00" });
    const id = parcelOf(fixture, lot.id).id as string;
    await expect(
      issueRoughToKarigar(fixture.tx as never, {
        ...FY,
        karigarId: "karigar-1",
        roughPieceIds: [id],
        parcelIssues: [{ roughPieceId: id, carat: "10" }],
        requiredShape: "ROUND",
        issueDate: DATE,
        createdByUserId: "user-1",
      })
    ).rejects.toThrow(/more than once/);

    // Issue the whole thing, then try again.
    await issue(fixture, id, "300.000");
    await expect(issue(fixture, id, "1")).rejects.toThrow(/not available to issue/);
  });

  it("a duplicate submission (same idempotency key) returns the same job and issues once", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "300.000", cost: "750000.00" });
    const parcel = parcelOf(fixture, lot.id);
    const first = await issue(fixture, parcel.id as string, "100.000", { idempotencyKey: "key-1" });
    const second = await issue(fixture, parcel.id as string, "100.000", { idempotencyKey: "key-1" });
    expect(second.id).toBe(first.id);
    expect(fixture.state.diamondJobs.size).toBe(1);
    expect(parcel.carat).toBe("200.000");
    expect(pieceRows(fixture, lot.id)).toHaveLength(2);
  });
});

describe("cancelling a partial parcel issue", () => {
  it("restores exactly the issued quantity and value into the parcel, once", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "300.000", cost: "750000.00", pieceCount: 1200 });
    const parcel = parcelOf(fixture, lot.id);
    const job = await issue(fixture, parcel.id as string, "100.000", { pieceCount: 400 });

    const cancelled = await cancelDiamondJob(fixture.tx as never, {
      ...FY,
      jobId: job.id as string,
      cancelledByUserId: "user-1",
      cancellationReason: "issued by mistake",
    });

    expect(parcel.carat).toBe("300.000");
    expect(parcel.allocatedCost).toBe("750000.00");
    expect(parcel.pieceCount).toBe(1200);
    expect(parcel.status).toBe("AVAILABLE");
    const child = pieceRows(fixture, lot.id).find((p) => p.parentPieceId === parcel.id)!;
    expect(child.status).toBe("CANCELLED");
    // History kept; only what is currently in WIP is zeroed.
    expect(cancelled.issuedRoughCarat).toBe("100.000");
    expect(cancelled.issuedCostValue).toBe("250000.00");
    expect(cancelled.remainingWipCost).toBe("0.00");
    expect(cancelled.status).toBe("CANCELLED");

    // A second cancel restores nothing more.
    await expect(
      cancelDiamondJob(fixture.tx as never, { ...FY, jobId: job.id as string, cancelledByUserId: "user-1", cancellationReason: "again" })
    ).rejects.toThrow(/already been cancelled/);
    expect(parcel.carat).toBe("300.000");
    expect(parcel.allocatedCost).toBe("750000.00");
  });

  it("when the parcel itself has since gone out, the portion comes back as its own Available row", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "300.000", cost: "750000.00" });
    const parcel = parcelOf(fixture, lot.id);
    const job1 = await issue(fixture, parcel.id as string, "100.000");
    await issue(fixture, parcel.id as string, "200.000"); // the remaining 200 goes out whole
    expect(parcel.status).toBe("WITH_KARIGAR");

    await cancelDiamondJob(fixture.tx as never, { ...FY, jobId: job1.id as string, cancelledByUserId: "user-1", cancellationReason: "x" });
    const child = pieceRows(fixture, lot.id).find((p) => p.parentPieceId === parcel.id)!;
    expect(child.status).toBe("AVAILABLE");
    expect(child.carat).toBe("100.000");
    expect(parcel.status).toBe("WITH_KARIGAR"); // untouched — it is in the other job
    expect(parcel.carat).toBe("200.000");
  });

  it("cannot be cancelled once a receipt exists", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "300.000", cost: "750000.00" });
    const parcel = parcelOf(fixture, lot.id);
    const job = await issue(fixture, parcel.id as string, "100.000");
    await receivePolishedDiamonds(fixture.tx as never, {
      ...FY,
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 0,
      shape: "ROUND",
      markJobComplete: false,
      outputs: [{ shape: "ROUND", carat: "30.000" }],
      createdByUserId: "user-1",
    });
    await expect(
      cancelDiamondJob(fixture.tx as never, { ...FY, jobId: job.id as string, cancelledByUserId: "user-1", cancellationReason: "late" })
    ).rejects.toThrow(/cannot be cancelled once/);
    expect(parcel.carat).toBe("200.000");
  });
});

describe("partial then final receipt on a parcel job uses the existing workflow", () => {
  it("a partial receipt leaves the rest pending, and only the final one recognises loss", async () => {
    const fixture = createFakeDiamondTx();
    const lot = await buyParcel(fixture, { carat: "300.000", cost: "750000.00" });
    const parcel = parcelOf(fixture, lot.id);
    const job = await issue(fixture, parcel.id as string, "100.000");
    const child = pieceRows(fixture, lot.id).find((p) => p.parentPieceId === parcel.id)!;

    const partial = await receivePolishedDiamonds(fixture.tx as never, {
      ...FY,
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 0,
      labourCharge: 6000,
      shape: "ROUND",
      markJobComplete: false,
      outputs: [{ shape: "ROUND", carat: "30.000" }],
      createdByUserId: "user-1",
    });
    expect(partial.receipt.weightLossCarat).toBe("0.000");
    expect(partial.job.status).toBe("PARTIALLY_RECEIVED");
    expect(partial.job.remainingWipCost).toBe("175000.00");
    expect(child.status).toBe("WITH_KARIGAR");

    const final = await receivePolishedDiamonds(fixture.tx as never, {
      ...FY,
      jobId: job.id as string,
      receiveDate: DATE,
      returnedRoughCarat: 5,
      labourCharge: 4500,
      shape: "ROUND",
      markJobComplete: true,
      outputs: [{ shape: "ROUND", carat: "45.000" }],
      createdByUserId: "user-1",
    });
    expect(final.receipt.weightLossCarat).toBe("20.000");
    expect(final.job.status).toBe("COMPLETED");
    expect(final.job.remainingWipCost).toBe("0.00");
    expect(child.status).toBe("COMPLETED");
    // The retained parcel is untouched by the whole receipt cycle.
    expect(parcel.carat).toBe("200.000");
    expect(parcel.allocatedCost).toBe("500000.00");
    expect(parcel.status).toBe("AVAILABLE");
  });
});
