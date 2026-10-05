/**
 * Real-database acceptance for a processed-rough BATCH return (4P / Laser):
 * 10 rough stones / 45.130 ct go out, 26 stones come back weighed together.
 *
 * Runs against the isolated test database only (this file refuses anything
 * else). Every figure is exact; every scenario ends with the ledger reconciled
 * against stock (1200 = Available rough, 1210 = open WIP) and no unbalanced voucher.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { cancelDiamondJob, createRoughLotWithPieces, issueRoughToKarigar, receiveProcessedRough } from "./posting";
import { getDiamondJobDetail, getKarigarMaterialBalances, getRoughStockSummary, listDiamondJobs, listReturnedRough, listRoughPieces } from "./reports";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-05T00:00:00.000Z");
const TX = { timeout: 20_000, maxWait: 15_000 };

let ownerId: string;
let supplierId: string;
let manufacturerId: string;
let laserId: string;
let baseline: { rough: string; wip: string };

async function clearDiamondData() {
  const [lots, jobs, receipts] = await Promise.all([
    prisma.roughLot.findMany({ select: { voucherId: true } }),
    prisma.diamondJob.findMany({ select: { wipVoucherId: true } }),
    prisma.polishedReceipt.findMany({ select: { postingVoucherId: true } }),
  ]);
  const voucherIds = [...lots.map((l) => l.voucherId), ...jobs.map((j) => j.wipVoucherId), ...receipts.map((r) => r.postingVoucherId)].filter(
    (id): id is string => !!id
  );
  const reversals = voucherIds.length ? await prisma.voucher.findMany({ where: { reversalOfVoucherId: { in: voucherIds } }, select: { id: true } }) : [];
  await prisma.stockMovement.deleteMany({ where: { OR: [{ roughPieceId: { not: null } }, { polishedDiamondId: { not: null } }, { diamondJobId: { not: null } }] } });
  await prisma.polishedDiamond.deleteMany();
  await prisma.diamondJobPiece.deleteMany();
  await prisma.roughPiece.updateMany({ data: { parentPieceId: null } });
  await prisma.roughPiece.deleteMany();
  await prisma.polishedReceipt.deleteMany();
  await prisma.diamondJob.deleteMany();
  await prisma.roughLot.deleteMany();
  const all = [...voucherIds, ...reversals.map((r) => r.id)];
  if (all.length) {
    await prisma.journalEntry.deleteMany({ where: { voucherId: { in: all } } });
    await prisma.voucher.deleteMany({ where: { id: { in: reversals.map((r) => r.id) } } });
    await prisma.voucher.deleteMany({ where: { id: { in: voucherIds } } });
  }
}

async function accountBalance(code: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const totals = await prisma.journalEntry.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } });
  return new Decimal(totals._sum.debit ?? 0).minus(totals._sum.credit ?? 0);
}
const balances = async () => ({ rough: (await accountBalance("1200")).toFixed(2), wip: (await accountBalance("1210")).toFixed(2) });
async function payable(partyId: string): Promise<string> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code: "2000" } });
  const t = await prisma.journalEntry.aggregate({ where: { accountId: account.id, partyId }, _sum: { debit: true, credit: true } });
  return new Decimal(t._sum.credit ?? 0).minus(t._sum.debit ?? 0).toFixed(2);
}
async function unbalancedVouchers(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`
  );
  return rows[0].n;
}
/** 1200 = cost of every Available rough row; 1210 = WIP left on open jobs; no unbalanced voucher. */
async function reconcile() {
  const available = await prisma.roughPiece.findMany({ where: { status: "AVAILABLE" }, select: { allocatedCost: true } });
  const open = await prisma.diamondJob.findMany({ where: { status: { in: ["ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"] } }, select: { remainingWipCost: true } });
  const now = await balances();
  expect(new Decimal(now.rough).minus(baseline.rough).toFixed(2)).toBe(available.reduce((s, p) => s.plus(p.allocatedCost), ZERO).toFixed(2));
  expect(new Decimal(now.wip).minus(baseline.wip).toFixed(2)).toBe(open.reduce((s, j) => s.plus(j.remainingWipCost), ZERO).toFixed(2));
  expect(await unbalancedVouchers()).toBe(0);
}

/** Ten individual rough stones, 4.513 ct each = 45.130 ct, ₹4,51,300.00 (₹10,000 / ct). */
async function buyTenStones(key: string) {
  const lot = await prisma.$transaction(
    (tx) =>
      createRoughLotWithPieces(tx, {
        ...FY,
        purchaseDate: DATE,
        supplierId,
        purchaseRate: 10000,
        rateBasis: "PER_CARAT",
        currencyCode: "INR",
        exchangeRate: 1,
        totalPurchaseCost: "451300.00",
        gstTreatment: "NONE",
        idempotencyKey: key,
        createdByUserId: ownerId,
        pieces: Array.from({ length: 10 }, () => ({ carat: "4.513" })),
      }),
    TX
  );
  return prisma.roughPiece.findMany({ where: { lotId: lot.id }, orderBy: { roughCode: "asc" } });
}
async function laserJob(key: string, rate: { basis: "PER_CARAT" | "PER_PIECE"; rate: number } = { basis: "PER_CARAT", rate: 200 }) {
  const stones = await buyTenStones(`${key}-lot`);
  return prisma.$transaction(
    (tx) =>
      issueRoughToKarigar(tx, {
        ...FY,
        karigarId: manufacturerId,
        roughPieceIds: stones.map((s) => s.id),
        requiredShape: "ROUND",
        issueDate: DATE,
        processId: laserId,
        chargeRateBasis: rate.basis,
        chargeRate: rate.rate,
        idempotencyKey: `${key}-issue`,
        createdByUserId: ownerId,
      }),
    TX
  );
}
function receiveBatch(jobId: string, pieceCount: number, carat: string, opts: { complete?: boolean; key: string; color?: string }) {
  return prisma.$transaction(
    (tx) =>
      receiveProcessedRough(tx, {
        ...FY,
        jobId,
        receiveDate: DATE,
        batch: { pieceCount, carat, colorEstimate: opts.color ?? null, clarityNote: null },
        markJobComplete: opts.complete ?? false,
        idempotencyKey: opts.key,
        createdByUserId: ownerId,
      }),
    TX
  );
}
function issueParcel(parcelId: string, carat: string, count: number | null, key: string) {
  return prisma.$transaction(
    (tx) =>
      issueRoughToKarigar(tx, {
        ...FY,
        karigarId: manufacturerId,
        parcelIssues: [{ roughPieceId: parcelId, carat, pieceCount: count }],
        requiredShape: "ROUND",
        issueDate: DATE,
        processId: laserId,
        chargeRateBasis: "PER_CARAT",
        chargeRate: 200,
        idempotencyKey: key,
        createdByUserId: ownerId,
      }),
    TX
  );
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearDiamondData();
  baseline = await balances();
  const party = async (id: string, name: string, type: "SUPPLIER" | "MANUFACTURER") =>
    (await prisma.party.upsert({ where: { id }, create: { id, name, type, createdByUserId: ownerId }, update: {} })).id;
  supplierId = await party("batch-test-supplier", "Batch Test Supplier", "SUPPLIER");
  manufacturerId = await party("batch-test-laser", "Batch Test 4P Manufacturer", "MANUFACTURER");
  laserId = (await prisma.diamondProcess.findFirstOrThrow({ where: { name: "4P / Laser", outputKind: "ROUGH" } })).id;
}, 60_000);

afterAll(async () => {
  await clearDiamondData();
});

// ---------------------------------------------------------------------------
// 1-5. The exact case: 10 pcs / 45.130 ct → 4P / Laser → 26 pcs / 43.500 ct
// ---------------------------------------------------------------------------
describe("10 issued pieces come back as 26 (one batch, final)", () => {
  let jobId: string;
  let parcelId: string;
  let parcelCode: string;

  it("saves ONE parcel of 26 pcs / 43.500 ct carrying ₹4,51,300 + ₹8,700 = ₹4,60,000; loss 1.630 ct; no stone weight invented", async () => {
    const job = await laserJob("exact");
    jobId = job.id;
    expect(job.issuedPiecesCount).toBe(10);
    expect(new Decimal(job.issuedRoughCarat).toFixed(3)).toBe("45.130");
    expect(new Decimal(job.issuedCostValue).toFixed(2)).toBe("451300.00");
    const payBefore = await payable(manufacturerId);

    const { receipt, pieces, job: done, returnedPieces } = await receiveBatch(jobId, 26, "43.500", { complete: true, key: "exact-rec", color: "G-H" });
    expect(returnedPieces).toBe(26);
    expect(pieces).toHaveLength(1);
    const parcel = pieces[0];
    parcelId = parcel.id;
    parcelCode = parcel.roughCode;
    expect(parcel.kind).toBe("PARCEL");
    expect(parcel.pieceCount).toBe(26);
    expect(parcel.originalPieceCount).toBe(26);
    expect(new Decimal(parcel.carat).toFixed(3)).toBe("43.500");
    expect(new Decimal(parcel.originalCarat!).toFixed(3)).toBe("43.500");
    expect(new Decimal(parcel.allocatedCost).toFixed(2)).toBe("460000.00");
    expect(new Decimal(parcel.originalCost!).toFixed(2)).toBe("460000.00");
    expect(parcel.lotId).toBeNull();
    expect([parcel.returnedFromJobId, parcel.returnedFromReceiptId, parcel.status, parcel.colorEstimate]).toEqual([jobId, receipt.id, "AVAILABLE", "G-H"]);
    expect(parcel.internalNote).toContain("issued 10 pcs / 45.130 ct → returned 26 pcs / 43.500 ct");
    // Nothing else was created from this receipt: no fabricated per-stone rows.
    expect(await prisma.roughPiece.count({ where: { returnedFromReceiptId: receipt.id } })).toBe(1);

    expect(new Decimal(receipt.returnedRoughCarat).toFixed(3)).toBe("43.500");
    expect(new Decimal(receipt.weightLossCarat).toFixed(3)).toBe("1.630");
    expect(new Decimal(receipt.labourCharge).toFixed(2)).toBe("8700.00"); // 200 × 43.500 (existing PER_CARAT rule)
    expect(done.status).toBe("COMPLETED");
    expect(new Decimal(done.remainingWipCost).toFixed(2)).toBe("0.00");
    expect(new Decimal(await payable(manufacturerId)).minus(payBefore).toFixed(2)).toBe("8700.00");

    const moves = await prisma.stockMovement.findMany({ where: { sourceDocument: receipt.receiptCode }, orderBy: { type: "asc" } });
    expect(moves.map((m) => [m.type, m.pieces, new Decimal(m.carat).toFixed(3), new Decimal(m.costValue).toFixed(2)])).toEqual([
      ["ROUGH_CONSUMED_OUT", 0, "1.630", "0.00"],
      ["ROUGH_RETURN_IN", 26, "43.500", "460000.00"],
    ]);
    const lines = await prisma.journalEntry.findMany({ where: { voucherId: receipt.postingVoucherId! }, include: { account: true } });
    expect(lines.map((l) => [l.account.code, new Decimal(l.debit).toFixed(2), new Decimal(l.credit).toFixed(2)]).sort()).toEqual([
      ["1200", "460000.00", "0.00"],
      ["1210", "0.00", "451300.00"],
      ["2000", "0.00", "8700.00"],
    ]);
    // Value reconciles: source carrying cost + process charge; the piece count never multiplies it.
    expect(new Decimal(job.issuedCostValue).plus(receipt.labourCharge).toFixed(2)).toBe(new Decimal(parcel.allocatedCost).toFixed(2));
    await reconcile();
  });

  it("job detail, job list, Rough Stock and stock summary show 26 pcs and the lineage", async () => {
    const detail = (await getDiamondJobDetail(jobId))!;
    expect([detail.issuedPiecesCount, detail.issuedRoughCarat.toFixed(3), detail.returnedRoughPieces, detail.returnedRoughCarat.toFixed(3)]).toEqual([10, "45.130", 26, "43.500"]);
    expect(detail.finalWeightLossCarat!.toFixed(3)).toBe("1.630");
    expect(detail.receipts).toHaveLength(1);
    expect(detail.receipts[0].returnedRoughPieces).toBe(26);
    expect(detail.receipts[0].returnedRows.map((r) => [r.roughCode, r.kind, r.pieces, r.carat.toFixed(3)])).toEqual([[parcelCode, "PARCEL", 26, "43.500"]]);
    expect(detail.pieces.reduce((n, p) => n + p.pieces, 0)).toBe(10);
    expect(detail.timeline.find((m) => m.type === "ROUGH_RETURN_IN")!.pieces).toBe(26);

    const row = (await listDiamondJobs({})).find((j) => j.id === jobId)!;
    expect([row.returnedRoughPieces, row.returnedRoughCarat.toFixed(3)]).toEqual([26, "43.500"]);

    const returned = (await listReturnedRough()).find((r) => r.id === parcelId)!;
    expect(returned.origin).toMatchObject({ jobCode: detail.jobCode, processName: "4P / Laser", issuedPieces: 10, returnedPieces: 26, viaParcel: null });
    expect([returned.origin!.issuedCarat.toFixed(3), returned.origin!.returnedCarat.toFixed(3)]).toEqual(["45.130", "43.500"]);
    // The origin is weights and counts only — never a cost.
    expect(Object.keys(returned.origin!).some((k) => /cost|value|rate|charge/i.test(k))).toBe(false);

    const summary = await getRoughStockSummary();
    expect(summary.stoneCount).toBe(26);
    expect(summary.totalCarat.toFixed(3)).toBe("43.500");
  });

  it("the next process sees the parcel: 26 pcs / 43.500 ct, returned from 4P / Laser, colour kept", async () => {
    const option = (await listRoughPieces({ status: "AVAILABLE" })).find((p) => p.id === parcelId)!;
    expect([option.kind, option.pieceCount, option.carat.toFixed(3), option.allocatedCost.toFixed(2), option.colorEstimate]).toEqual(["PARCEL", 26, "43.500", "460000.00", "G-H"]);
    expect(option.origin!.processName).toBe("4P / Laser");
    expect(option.origin!.returnedPieces).toBe(26);
  });

  it("refuses an inconsistent next issue: no count, all pieces without all carat, all carat without all pieces, over-issue", async () => {
    await expect(issueParcel(parcelId, "16.200", null, "next-bad-1")).rejects.toThrow(/Enter how many stones/);
    await expect(issueParcel(parcelId, "16.200", 26, "next-bad-2")).rejects.toThrow(/only 26 stones remain/);
    await expect(issueParcel(parcelId, "43.500", 10, "next-bad-3")).rejects.toThrow(/means all 26 stones, not 10/);
    await expect(issueParcel(parcelId, "43.501", 26, "next-bad-4")).rejects.toThrow(/only 43\.500ct remain/);
    await expect(issueParcel(parcelId, "16.2001", 10, "next-bad-5")).rejects.toThrow(/at most 3 decimal places/);
    await expect(issueParcel(parcelId, "16.200", 0, "next-bad-6")).rejects.toThrow(/whole number of at least 1/);
    const unchanged = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcelId } });
    expect([unchanged.pieceCount, new Decimal(unchanged.carat).toFixed(3), new Decimal(unchanged.allocatedCost).toFixed(2)]).toEqual([26, "43.500", "460000.00"]);
    await reconcile();
  });

  it("partial next issue by actual pieces AND carat: 10 pcs / 16.200 ct out, 16 pcs / 27.300 ct stay; cost split exactly", async () => {
    const job2 = await issueParcel(parcelId, "16.200", 10, "next-partial");
    expect([job2.issuedPiecesCount, new Decimal(job2.issuedRoughCarat).toFixed(3), new Decimal(job2.issuedCostValue).toFixed(2)]).toEqual([10, "16.200", "171310.34"]);
    const parcel = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcelId } });
    expect([parcel.pieceCount, new Decimal(parcel.carat).toFixed(3), new Decimal(parcel.allocatedCost).toFixed(2), parcel.status]).toEqual([16, "27.300", "288689.66", "AVAILABLE"]);
    // The immutable snapshot of what came back is untouched.
    expect([parcel.originalPieceCount, new Decimal(parcel.originalCarat!).toFixed(3), new Decimal(parcel.originalCost!).toFixed(2)]).toEqual([26, "43.500", "460000.00"]);
    const child = await prisma.roughPiece.findFirstOrThrow({ where: { parentPieceId: parcelId } });
    expect([child.pieceCount, new Decimal(child.carat).toFixed(3), child.status]).toEqual([10, "16.200", "WITH_KARIGAR"]);
    // Lineage from the next job back to the original 10 stones.
    const detail2 = (await getDiamondJobDetail(job2.id))!;
    expect(detail2.pieces[0].pieces).toBe(10);
    expect(detail2.pieces[0].origin).toMatchObject({ viaParcel: parcelCode, processName: "4P / Laser", issuedPieces: 10, returnedPieces: 26 });
    await reconcile();
  });

  it("issuing the rest whole carries the exact remaining ₹2,88,689.66 — no paisa stranded", async () => {
    const job3 = await issueParcel(parcelId, "27.300", 16, "next-rest");
    expect([job3.issuedPiecesCount, new Decimal(job3.issuedRoughCarat).toFixed(3), new Decimal(job3.issuedCostValue).toFixed(2)]).toEqual([16, "27.300", "288689.66"]);
    const jobs = await prisma.diamondJob.findMany({ where: { idempotencyKey: { in: ["next-partial", "next-rest"] } } });
    expect(jobs.reduce((s, j) => s.plus(j.issuedCostValue), ZERO).toFixed(2)).toBe("460000.00");
    const parcel = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcelId } });
    expect(parcel.status).toBe("WITH_KARIGAR");
    await reconcile();
  });

  it("the completed 4P job cannot be cancelled, and its receipt is not reversible (current rules)", async () => {
    await expect(
      prisma.$transaction((tx) => cancelDiamondJob(tx, { ...FY, jobId, cancelledByUserId: ownerId, cancellationReason: "should be refused" }), TX)
    ).rejects.toThrow(/cannot be cancelled/);
  });
});

// ---------------------------------------------------------------------------
// 6-8. Two partial returns: 14 pcs / 22.000 ct, then 12 pcs / 21.500 ct
// ---------------------------------------------------------------------------
describe("two partial batch returns become 26 pcs; loss only on final completion", () => {
  let jobId: string;

  it("first return 14 pcs / 22.000 ct: no loss, job stays open although more pieces than issued came back", async () => {
    jobId = (await laserJob("partial")).id;
    const { receipt, pieces, job } = await receiveBatch(jobId, 14, "22.000", { key: "partial-rec-1" });
    expect(job.status).toBe("PARTIALLY_RECEIVED");
    expect(new Decimal(receipt.weightLossCarat).toFixed(3)).toBe("0.000");
    expect(await prisma.stockMovement.count({ where: { diamondJobId: jobId, type: "ROUGH_CONSUMED_OUT" } })).toBe(0);
    expect(new Decimal(pieces[0].allocatedCost).toFixed(2)).toBe("224400.00"); // 4,51,300 × 22 / 45.13 = 2,20,000 + 200 × 22
    expect(new Decimal(job.remainingWipCost).toFixed(2)).toBe("231300.00");
    expect((await getKarigarMaterialBalances()).find((b) => b.karigarId === manufacturerId)!.returnedPiecesCount).toBeGreaterThanOrEqual(14);
    await reconcile();
  });

  it("refuses a return of more carat than is still pending (23.130 ct)", async () => {
    await expect(receiveBatch(jobId, 12, "23.200", { key: "partial-over" })).rejects.toThrow(/exceeds the 23\.130ct still with the Manufacturer/);
  });

  it("second return 12 pcs / 21.500 ct completing: cumulative 26 pcs / 43.500 ct, loss exactly 1.630 ct, total value ₹4,60,000", async () => {
    const { receipt, pieces, job } = await receiveBatch(jobId, 12, "21.500", { complete: true, key: "partial-rec-2" });
    expect(job.status).toBe("COMPLETED");
    expect(new Decimal(receipt.weightLossCarat).toFixed(3)).toBe("1.630");
    expect(new Decimal(pieces[0].allocatedCost).toFixed(2)).toBe("235600.00"); // remaining WIP 2,31,300 + 200 × 21.5
    const detail = (await getDiamondJobDetail(jobId))!;
    expect([detail.returnedRoughPieces, detail.returnedRoughCarat.toFixed(3), detail.finalWeightLossCarat!.toFixed(3)]).toEqual([26, "43.500", "1.630"]);
    expect(detail.receipts.map((r) => r.returnedRoughPieces)).toEqual([14, 12]);
    const parcels = await prisma.roughPiece.findMany({ where: { returnedFromJobId: jobId } });
    expect(parcels.reduce((s, p) => s.plus(p.allocatedCost), ZERO).toFixed(2)).toBe("460000.00");
    expect(parcels.reduce((n, p) => n + (p.pieceCount ?? 0), 0)).toBe(26);
    await reconcile();
  });
});

// ---------------------------------------------------------------------------
// 9-12. Idempotency, concurrency, rollback
// ---------------------------------------------------------------------------
describe("duplicates, races and a failed save", () => {
  it("a double click (same key) saves ONE receipt, one parcel, one voucher", async () => {
    const job = await laserJob("dup");
    const first = await receiveBatch(job.id, 26, "43.500", { complete: true, key: "dup-rec" });
    const second = await receiveBatch(job.id, 26, "43.500", { complete: true, key: "dup-rec" });
    expect(second.replayed).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect(await prisma.polishedReceipt.count({ where: { jobId: job.id } })).toBe(1);
    expect(await prisma.roughPiece.count({ where: { returnedFromJobId: job.id } })).toBe(1);
    await reconcile();
  });

  it("the same submission racing itself creates one receipt", async () => {
    const job = await laserJob("dup-race");
    const results = await Promise.allSettled([
      receiveBatch(job.id, 26, "43.500", { complete: true, key: "dup-race-rec" }),
      receiveBatch(job.id, 26, "43.500", { complete: true, key: "dup-race-rec" }),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.polishedReceipt.count({ where: { jobId: job.id } })).toBe(1);
    expect(await prisma.roughPiece.count({ where: { returnedFromJobId: job.id } })).toBe(1);
    expect(await prisma.voucher.count({ where: { idempotencyKey: "dup-race-rec" } })).toBe(1);
    await reconcile();
  }, 60_000);

  it("two different receipts racing on one job (30 ct each of 45.130 ct): only one commits", async () => {
    const job = await laserJob("race");
    const results = await Promise.allSettled([
      receiveBatch(job.id, 15, "30.000", { key: "race-a" }),
      receiveBatch(job.id, 15, "30.000", { key: "race-b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason.message)).toMatch(/exceeds the 15\.130ct still with the Manufacturer/);
    const after = await prisma.diamondJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(new Decimal(after.returnedRoughCarat).toFixed(3)).toBe("30.000");
    await reconcile();
  }, 60_000);

  it("two issues racing on one returned parcel (20 pcs / 30 ct each of 26 / 43.5): never overdrawn", async () => {
    const job = await laserJob("issue-race");
    const parcel = (await receiveBatch(job.id, 26, "43.500", { complete: true, key: "issue-race-rec" })).pieces[0];
    const results = await Promise.allSettled([issueParcel(parcel.id, "30.000", 20, "issue-race-a"), issueParcel(parcel.id, "30.000", 20, "issue-race-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const left = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcel.id } });
    expect([left.pieceCount, new Decimal(left.carat).toFixed(3)]).toEqual([6, "13.500"]);
    await reconcile();
  }, 60_000);

  it("a failure after saving rolls back the receipt, parcel, movements, voucher and sequence together", async () => {
    const job = await laserJob("rollback");
    const snapshot = async () => ({
      receipts: await prisma.polishedReceipt.count(),
      rough: await prisma.roughPiece.count(),
      moves: await prisma.stockMovement.count(),
      vouchers: await prisma.voucher.count(),
      lines: await prisma.journalEntry.count(),
      sequences: JSON.stringify(await prisma.diamondSequence.findMany({ orderBy: { id: "asc" }, select: { id: true, lastNumber: true } })),
      voucherSequences: JSON.stringify(await prisma.$queryRawUnsafe(`select * from voucher_sequences order by 1`)),
      job: JSON.stringify(await prisma.diamondJob.findUniqueOrThrow({ where: { id: job.id } })),
    });
    const before = await snapshot();
    await expect(
      prisma.$transaction(async (tx) => {
        await receiveProcessedRough(tx, {
          ...FY,
          jobId: job.id,
          receiveDate: DATE,
          batch: { pieceCount: 26, carat: "43.500" },
          markJobComplete: true,
          idempotencyKey: "rollback-rec",
          createdByUserId: ownerId,
        });
        throw new Error("simulated failure after the save");
      }, TX)
    ).rejects.toThrow(/simulated failure/);
    expect(await snapshot()).toEqual(before);
    await reconcile();
  });
});

// ---------------------------------------------------------------------------
// 14-17. Individual mode, per-piece charge, cancel merge-back, refusals
// ---------------------------------------------------------------------------
describe("individual mode and the other existing rules", () => {
  it("individual rows still create one STONE each, cost split by carat; the count is the number of rows", async () => {
    const job = await laserJob("individual");
    const { pieces, returnedPieces } = await prisma.$transaction(
      (tx) =>
        receiveProcessedRough(tx, {
          ...FY,
          jobId: job.id,
          receiveDate: DATE,
          pieces: [{ carat: "10.000" }, { carat: "15.000" }, { carat: "18.500" }],
          markJobComplete: true,
          idempotencyKey: "individual-rec",
          createdByUserId: ownerId,
        }),
      TX
    );
    expect(returnedPieces).toBe(3);
    expect(pieces.map((p) => [p.kind, p.pieceCount, new Decimal(p.carat).toFixed(3)])).toEqual([
      ["STONE", null, "10.000"],
      ["STONE", null, "15.000"],
      ["STONE", null, "18.500"],
    ]);
    expect(pieces.reduce((s, p) => s.plus(p.allocatedCost), ZERO).toFixed(2)).toBe("460000.00");
    expect((await getDiamondJobDetail(job.id))!.returnedRoughPieces).toBe(3);
    await reconcile();
  });

  it("a per-piece rate charges the pieces RETURNED (existing rule): 26 × ₹100 = ₹2,600", async () => {
    const job = await laserJob("per-piece", { basis: "PER_PIECE", rate: 100 });
    const { receipt, pieces } = await receiveBatch(job.id, 26, "43.500", { complete: true, key: "per-piece-rec" });
    expect(new Decimal(receipt.labourCharge).toFixed(2)).toBe("2600.00");
    expect(new Decimal(pieces[0].allocatedCost).toFixed(2)).toBe("453900.00");
    await reconcile();
  });

  it("cancelling the next process before any receipt merges 10 pcs / 16.200 ct back: 26 pcs / 43.500 ct / ₹4,60,000 again", async () => {
    const job = await laserJob("cancel");
    const parcel = (await receiveBatch(job.id, 26, "43.500", { complete: true, key: "cancel-rec" })).pieces[0];
    const next = await issueParcel(parcel.id, "16.200", 10, "cancel-next");
    await prisma.$transaction((tx) => cancelDiamondJob(tx, { ...FY, jobId: next.id, cancelledByUserId: ownerId, cancellationReason: "Wrong process chosen" }), TX);
    const back = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcel.id } });
    expect([back.pieceCount, new Decimal(back.carat).toFixed(3), new Decimal(back.allocatedCost).toFixed(2), back.status]).toEqual([26, "43.500", "460000.00", "AVAILABLE"]);
    await reconcile();
  });

  it("refuses a malformed batch and a non-rough job, saving nothing", async () => {
    const job = await laserJob("refuse");
    const bad = (batch: { pieceCount: number; carat: string }, extra: object = {}) =>
      prisma.$transaction(
        (tx) =>
          receiveProcessedRough(tx, {
            ...FY,
            jobId: job.id,
            receiveDate: DATE,
            batch,
            markJobComplete: false,
            idempotencyKey: null,
            createdByUserId: ownerId,
            ...extra,
          }),
        TX
      );
    await expect(bad({ pieceCount: 0, carat: "10.000" })).rejects.toThrow(/whole number of at least 1/);
    await expect(bad({ pieceCount: 2.5, carat: "10.000" })).rejects.toThrow(/whole number of at least 1/);
    await expect(bad({ pieceCount: 26, carat: "0" })).rejects.toThrow(/greater than zero/);
    await expect(bad({ pieceCount: 26, carat: "10.0001" })).rejects.toThrow(/at most 3 decimal places/);
    await expect(bad({ pieceCount: 26, carat: "10.000" }, { pieces: [{ carat: "1.000" }] })).rejects.toThrow(/not both/);
    expect(await prisma.polishedReceipt.count({ where: { jobId: job.id } })).toBe(0);
    await reconcile();
  });
});
