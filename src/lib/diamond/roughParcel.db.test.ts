/**
 * Real-database acceptance for partial rough-parcel issue.
 *
 * Runs against the isolated test database only (this file refuses anything
 * else). Buy ONE parcel of 300 ct, issue 100 ct to a Manufacturer, keep 200 ct
 * in stock — then partial + final receipts, cancellation, duplicate
 * submission, concurrent over-issue, and ledger reconciliation.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import {
  cancelDiamondJob,
  createRoughLotWithPieces,
  issueRoughToKarigar,
  receivePolishedDiamonds,
} from "./posting";
import {
  getDashboardDiamondSummary,
  getDiamondJobDetail,
  getKarigarMaterialBalances,
  getRoughWithPartySummary,
  listDiamondJobs,
  listRoughLots,
} from "./reports";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-25T00:00:00.000Z");
const TX_OPTIONS = { timeout: 20_000, maxWait: 15_000 };

let ownerId: string;
let supplierId: string;
let manufacturerId: string;
let karigarId: string;
// Ledger balances right after cleanup: every reconciliation is measured from here.
let baseline: { rough: string; wip: string; polished: string };

// ---------------------------------------------------------------------------
// Hygiene: the correction suite clears whole tables, and a diamond row would
// block it (vouchers are referenced by lots/jobs), so this file cleans ALL
// diamond data before and after itself. Test database only.
// ---------------------------------------------------------------------------
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
  const all = [...voucherIds, ...reversals.map((r) => r.id)];

  await prisma.stockMovement.deleteMany({ where: { OR: [{ roughPieceId: { not: null } }, { polishedDiamondId: { not: null } }, { diamondJobId: { not: null } }] } });
  await prisma.polishedDiamond.deleteMany();
  await prisma.diamondJobPiece.deleteMany();
  await prisma.roughPiece.deleteMany();
  await prisma.polishedReceipt.deleteMany();
  await prisma.diamondJob.deleteMany();
  await prisma.roughLot.deleteMany();
  if (all.length) {
    await prisma.journalEntry.deleteMany({ where: { voucherId: { in: all } } });
    await prisma.voucher.deleteMany({ where: { id: { in: reversals.map((r) => r.id) } } });
    await prisma.voucher.deleteMany({ where: { id: { in: voucherIds } } });
  }
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>(
    "select current_database() db, current_user usr, inet_server_port() port"
  );
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearDiamondData();
  baseline = await balances();

  const party = async (id: string, name: string, type: "SUPPLIER" | "MANUFACTURER" | "KARIGAR") =>
    (await prisma.party.upsert({ where: { id }, create: { id, name, type, createdByUserId: ownerId }, update: {} })).id;
  supplierId = await party("parcel-test-supplier", "Parcel Test Supplier", "SUPPLIER");
  manufacturerId = await party("parcel-test-manufacturer", "Parcel Test Manufacturer", "MANUFACTURER");
  karigarId = await party("parcel-test-karigar", "Parcel Test Karigar", "KARIGAR");
}, 60_000);

afterAll(async () => {
  await clearDiamondData();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function accountBalance(code: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const totals = await prisma.journalEntry.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } });
  return new Decimal(totals._sum.debit ?? 0).minus(totals._sum.credit ?? 0);
}
const balances = async () => ({
  rough: (await accountBalance("1200")).toFixed(2),
  wip: (await accountBalance("1210")).toFixed(2),
  polished: (await accountBalance("1220")).toFixed(2),
});
async function payable(partyId: string): Promise<string> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code: "2000" } });
  const totals = await prisma.journalEntry.aggregate({ where: { accountId: account.id, partyId }, _sum: { debit: true, credit: true } });
  return new Decimal(totals._sum.credit ?? 0).minus(totals._sum.debit ?? 0).toFixed(2);
}
async function unbalancedVouchers(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`
  );
  return rows[0].n;
}

function buyParcel(opts: { carat: string; cost: string; pieceCount?: number | null; kind?: "STONE" | "PARCEL"; key: string }) {
  return prisma.$transaction(
    (tx) =>
      createRoughLotWithPieces(tx, {
        ...FY,
        purchaseDate: DATE,
        supplierId,
        purchaseRate: 2500,
        rateBasis: "PER_CARAT",
        currencyCode: "INR",
        exchangeRate: 1,
        totalPurchaseCost: opts.cost,
        gstTreatment: "NONE",
        idempotencyKey: opts.key,
        createdByUserId: ownerId,
        pieces: [{ kind: opts.kind ?? "PARCEL", pieceCount: opts.pieceCount ?? null, carat: opts.carat }],
      }),
    TX_OPTIONS
  );
}
const parcelRow = async (lotId: string) => prisma.roughPiece.findFirstOrThrow({ where: { lotId, parentPieceId: null } });
const childRows = async (parentId: string) => prisma.roughPiece.findMany({ where: { parentPieceId: parentId }, orderBy: { createdAt: "asc" } });

function issue(parcelId: string, carat: string, opts: { count?: number | null; key: string; partyId?: string }) {
  return prisma.$transaction(
    (tx) =>
      issueRoughToKarigar(tx, {
        ...FY,
        karigarId: opts.partyId ?? manufacturerId,
        parcelIssues: [{ roughPieceId: parcelId, carat, pieceCount: opts.count }],
        requiredShape: "ROUND",
        issueDate: DATE,
        idempotencyKey: opts.key,
        createdByUserId: ownerId,
      }),
    TX_OPTIONS
  );
}
function cancel(jobId: string) {
  return prisma.$transaction(
    (tx) => cancelDiamondJob(tx, { ...FY, jobId, cancelledByUserId: ownerId, cancellationReason: "Parcel test cancellation" }),
    TX_OPTIONS
  );
}
function receive(jobId: string, opts: { carats: string[]; returned?: number; labour: number; complete: boolean; key: string }) {
  return prisma.$transaction(
    (tx) =>
      receivePolishedDiamonds(tx, {
        ...FY,
        jobId,
        receiveDate: DATE,
        returnedRoughCarat: opts.returned ?? 0,
        labourCharge: opts.labour,
        shape: "ROUND",
        markJobComplete: opts.complete,
        idempotencyKey: opts.key,
        createdByUserId: ownerId,
        outputs: opts.carats.map((carat) => ({ shape: "ROUND" as const, carat })),
      }),
    TX_OPTIONS
  );
}

/** Ledger vs stock: 1200 must equal the cost of every Available rough row,
 * 1210 the WIP left on open jobs — no value created, none lost. */
async function reconcileAgainstStock() {
  const available = await prisma.roughPiece.findMany({ where: { status: "AVAILABLE" }, select: { allocatedCost: true } });
  const availableValue = available.reduce((s, p) => s.plus(p.allocatedCost), ZERO);
  const openJobs = await prisma.diamondJob.findMany({ where: { status: { in: ["ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"] } }, select: { remainingWipCost: true } });
  const wipValue = openJobs.reduce((s, j) => s.plus(j.remainingWipCost), ZERO);
  const polished = await prisma.polishedDiamond.findMany({ where: { status: "AVAILABLE" }, select: { allocatedCost: true } });
  const polishedValue = polished.reduce((s, p) => s.plus(p.allocatedCost), ZERO);
  const now = await balances();
  expect(new Decimal(now.rough).minus(baseline.rough).toFixed(2)).toBe(availableValue.toFixed(2));
  expect(new Decimal(now.wip).minus(baseline.wip).toFixed(2)).toBe(wipValue.toFixed(2));
  expect(new Decimal(now.polished).minus(baseline.polished).toFixed(2)).toBe(polishedValue.toFixed(2));
  expect(await unbalancedVouchers()).toBe(0);
}

// ---------------------------------------------------------------------------
// 1-4. The requirement: 300 ct parcel, 100 ct issued, 200 ct retained
// ---------------------------------------------------------------------------
describe("300 ct parcel: 100 ct issued, 200 ct retained", () => {
  let lotId: string;
  let parcelId: string;
  let jobId: string;
  let base: Awaited<ReturnType<typeof balances>>;

  it("records ONE parcel of 300 ct as a single row and posts the purchase once", async () => {
    base = await balances();
    const lot = await buyParcel({ carat: "300.000", cost: "750000.00", pieceCount: 1200, key: "parcel-main-purchase" });
    lotId = lot.id;
    const parcel = await parcelRow(lotId);
    parcelId = parcel.id;

    expect(parcel.kind).toBe("PARCEL");
    expect(parcel.pieceCount).toBe(1200);
    expect(parcel.carat.toFixed(3)).toBe("300.000");
    expect(parcel.allocatedCost.toFixed(2)).toBe("750000.00");
    expect(await prisma.roughPiece.count({ where: { lotId } })).toBe(1);

    const now = await balances();
    expect(new Decimal(now.rough).minus(base.rough).toFixed(2)).toBe("750000.00");
    expect(await payable(supplierId)).toBe("750000.00");
    await reconcileAgainstStock();
  });

  it("issues 100 ct: ₹2,50,000 leaves stock for WIP, ₹5,00,000 stays; original purchase and link preserved", async () => {
    const job = await issue(parcelId, "100.000", { count: 400, key: "parcel-main-issue" });
    jobId = job.id;

    const parcel = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcelId } });
    expect(parcel.status).toBe("AVAILABLE");
    expect(parcel.carat.toFixed(3)).toBe("200.000");
    expect(parcel.allocatedCost.toFixed(2)).toBe("500000.00");
    expect(parcel.pieceCount).toBe(800);
    // Original purchase preserved on the parcel and on the lot.
    expect(parcel.originalCarat?.toFixed(3)).toBe("300.000");
    expect(parcel.originalCost?.toFixed(2)).toBe("750000.00");
    expect(parcel.originalPieceCount).toBe(1200);
    const lot = await prisma.roughLot.findUniqueOrThrow({ where: { id: lotId } });
    expect(lot.totalRoughCarat.toFixed(3)).toBe("300.000");
    expect(lot.totalPurchaseCost.toFixed(2)).toBe("750000.00");

    // Auditable link: parcel -> issued portion -> job.
    const [child] = await childRows(parcelId);
    expect(child.parentPieceId).toBe(parcelId);
    expect(child.lotId).toBe(lotId);
    expect(child.carat.toFixed(3)).toBe("100.000");
    expect(child.allocatedCost.toFixed(2)).toBe("250000.00");
    expect(child.pieceCount).toBe(400);
    expect(child.status).toBe("WITH_KARIGAR");
    const link = await prisma.diamondJobPiece.findFirstOrThrow({ where: { jobId } });
    expect(link.roughPieceId).toBe(child.id);
    expect(link.caratAtIssue.toFixed(3)).toBe("100.000");
    expect(link.costAtIssue.toFixed(2)).toBe("250000.00");

    expect(job.issuedRoughCarat.toFixed(3)).toBe("100.000");
    expect(job.issuedCostValue.toFixed(2)).toBe("250000.00");
    expect(job.issuedPiecesCount).toBe(400);

    const now = await balances();
    expect(new Decimal(now.rough).minus(base.rough).toFixed(2)).toBe("500000.00");
    expect(new Decimal(now.wip).minus(base.wip).toFixed(2)).toBe("250000.00");
    // No duplicated value: retained + issued == purchase.
    expect(new Decimal(now.rough).minus(base.rough).plus(new Decimal(now.wip).minus(base.wip)).toFixed(2)).toBe("750000.00");
    await reconcileAgainstStock();

    const types = (await prisma.stockMovement.findMany({ where: { diamondJobId: jobId } })).map((m) => m.type).sort();
    expect(types).toEqual(["ROUGH_ISSUE_OUT", "ROUGH_PARCEL_SPLIT_IN", "ROUGH_PARCEL_SPLIT_OUT"]);
  });

  it("shows 200 ct available and 100 ct separately with the Manufacturer — including a Manufacturer-type party", async () => {
    const lots = await listRoughLots({ search: "" });
    const lot = lots.find((l) => l.id === lotId)!;
    expect(lot.status).toBe("PARTLY_ISSUED");
    expect(lot.availableCarat.toFixed(3)).toBe("200.000");
    expect(lot.totalRoughCarat.toFixed(3)).toBe("300.000");
    expect(lot.piecesCount).toBe(1); // one purchase row, not two

    const balancesByParty = await getKarigarMaterialBalances();
    const mine = balancesByParty.find((b) => b.karigarId === manufacturerId);
    expect(mine, "a Manufacturer party must appear in material-with-party").toBeDefined();
    expect(mine!.pendingCarat.toFixed(3)).toBe("100.000");
    expect(mine!.openJobsCount).toBe(1);

    const withParty = await getRoughWithPartySummary();
    expect(withParty.pendingCarat.toFixed(3)).toBe("100.000");
    expect(withParty.wipCost.toFixed(2)).toBe("250000.00");
  });

  it("the issued 100 ct cannot be issued again, and the parcel cannot be over-issued", async () => {
    const [child] = await childRows(parcelId);
    await expect(
      prisma.$transaction((tx) => issueRoughToKarigar(tx, { ...FY, karigarId: manufacturerId, roughPieceIds: [child.id], requiredShape: "ROUND", issueDate: DATE, createdByUserId: ownerId }))
    ).rejects.toThrow(/not available to issue/);
    await expect(issue(parcelId, "200.001", { count: 100, key: "parcel-main-over" })).rejects.toThrow(/only 200\.000ct remain/);
    await expect(issue(parcelId, "0", { count: 1, key: "parcel-main-zero" })).rejects.toThrow(/greater than zero/);
    await expect(issue(parcelId, "-1", { count: 1, key: "parcel-main-neg" })).rejects.toThrow(/greater than zero/);
    await expect(issue(parcelId, "1.2345", { count: 1, key: "parcel-main-dec" })).rejects.toThrow(/at most 3 decimal places/);
    await expect(issue(parcelId, "10", { key: "parcel-main-nocount" })).rejects.toThrow(/Enter how many stones/);
    const parcel = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcelId } });
    expect(parcel.carat.toFixed(3)).toBe("200.000"); // nothing moved on any refusal
    expect(await prisma.diamondJob.count({ where: { idempotencyKey: { startsWith: "parcel-main-" } } })).toBe(1);
  });

  it("a duplicate submission returns the same job and issues nothing more", async () => {
    const again = await issue(parcelId, "100.000", { count: 400, key: "parcel-main-issue" });
    expect(again.id).toBe(jobId);
    const parcel = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcelId } });
    expect(parcel.carat.toFixed(3)).toBe("200.000");
    expect(await childRows(parcelId)).toHaveLength(1);
    expect(await prisma.voucher.count({ where: { idempotencyKey: "parcel-main-issue" } })).toBe(1);
    await reconcileAgainstStock();
  });

  it("partial receipt: 30 ct polished + ₹6,000 charge — the other 70 ct stays PENDING, no loss", async () => {
    const result = await receive(jobId, { carats: ["30.000"], labour: 6000, complete: false, key: "parcel-main-r1" });
    expect(result.job.status).toBe("PARTIALLY_RECEIVED");
    expect(result.receipt.weightLossCarat.toFixed(3)).toBe("0.000");
    expect(result.job.remainingWipCost.toFixed(2)).toBe("175000.00");

    const detail = (await getDiamondJobDetail(jobId))!;
    expect(detail.pendingCarat.toFixed(3)).toBe("70.000");
    expect(detail.remainingWipCost.toFixed(2)).toBe("175000.00");
    expect(detail.receivedPolishedCarat.toFixed(3)).toBe("30.000");

    // Accurate remaining quantity everywhere it is shown.
    const lots = await listRoughLots({ search: "" });
    const issued = lots.find((l) => l.id === lotId)!.pieces.find((p) => p.parentRoughCode)!;
    expect(issued.withParty?.pendingCarat.toFixed(3)).toBe("70.000");
    expect(issued.withParty?.issuedCarat.toFixed(3)).toBe("100.000");
    const mine = (await getKarigarMaterialBalances()).find((b) => b.karigarId === manufacturerId)!;
    expect(mine.pendingCarat.toFixed(3)).toBe("70.000");
    expect((await getRoughWithPartySummary()).pendingCarat.toFixed(3)).toBe("70.000");

    expect(await payable(manufacturerId)).toBe("6000.00");
    await reconcileAgainstStock();
  });

  it("cannot be cancelled once a receipt exists, and nothing changes", async () => {
    const before = await balances();
    await expect(cancel(jobId)).rejects.toThrow(/cannot be cancelled once/);
    expect(await balances()).toEqual(before);
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcelId } })).carat.toFixed(3)).toBe("200.000");
  });

  it("final receipt: 45 ct polished, 5 ct rough back, ₹4,500 — the remaining 20 ct becomes loss ONLY now", async () => {
    const result = await receive(jobId, { carats: ["25.000", "20.000"], returned: 5, labour: 4500, complete: true, key: "parcel-main-r2" });
    expect(result.job.status).toBe("COMPLETED");
    expect(result.receipt.weightLossCarat.toFixed(3)).toBe("20.000");
    expect(result.job.remainingWipCost.toFixed(2)).toBe("0.00");

    const detail = (await getDiamondJobDetail(jobId))!;
    expect(detail.pendingCarat.toFixed(3)).toBe("0.000"); // nothing pending on a completed job
    expect(detail.finalWeightLossCarat?.toFixed(3)).toBe("20.000");
    expect((await getKarigarMaterialBalances()).find((b) => b.karigarId === manufacturerId)!.pendingCarat.toFixed(3)).toBe("0.000");

    // Retained parcel untouched; value fully accounted for: 750000 purchase + 10500 charges.
    const parcel = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcelId } });
    expect(parcel.carat.toFixed(3)).toBe("200.000");
    expect(parcel.allocatedCost.toFixed(2)).toBe("500000.00");
    const now = await balances();
    const total = new Decimal(now.rough).minus(base.rough).plus(new Decimal(now.wip).minus(base.wip)).plus(new Decimal(now.polished).minus(base.polished));
    expect(total.toFixed(2)).toBe("760500.00");
    expect(await payable(manufacturerId)).toBe("10500.00");
    await reconcileAgainstStock();
  });
});

// ---------------------------------------------------------------------------
// 5. Concurrency: parcels must never be overdrawn
// ---------------------------------------------------------------------------
describe("concurrency", () => {
  it("two concurrent issues of 200 ct from a 300 ct parcel: exactly one wins, nothing is overdrawn", async () => {
    const lot = await buyParcel({ carat: "300.000", cost: "750000.00", pieceCount: 900, key: "parcel-conc-1" });
    const parcel = await parcelRow(lot.id);

    const results = await Promise.allSettled([
      issue(parcel.id, "200.000", { count: 600, key: "parcel-conc-1-a" }),
      issue(parcel.id, "200.000", { count: 600, key: "parcel-conc-1-b" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason.message)).toMatch(/only 100\.000ct remain/);

    const after = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcel.id } });
    expect(after.carat.toFixed(3)).toBe("100.000");
    expect(after.allocatedCost.toFixed(2)).toBe("250000.00");
    expect(after.pieceCount).toBe(300);
    const kids = await childRows(parcel.id);
    expect(kids).toHaveLength(1);
    expect(kids[0].carat.toFixed(3)).toBe("200.000");
    expect(kids[0].allocatedCost.toFixed(2)).toBe("500000.00");
    await reconcileAgainstStock();
  }, 60_000);

  it("five concurrent 100 ct issues from a 300 ct parcel: exactly three succeed, never more than the parcel holds", async () => {
    const lot = await buyParcel({ carat: "300.000", cost: "750000.00", key: "parcel-conc-2" });
    const parcel = await parcelRow(lot.id);

    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((n) => issue(parcel.id, "100.000", { key: `parcel-conc-2-${n}` }))
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);

    const jobs = await prisma.diamondJob.findMany({ where: { idempotencyKey: { startsWith: "parcel-conc-2-" } } });
    expect(jobs).toHaveLength(3);
    const issuedCarat = jobs.reduce((s, j) => s.plus(j.issuedRoughCarat), ZERO);
    const issuedCost = jobs.reduce((s, j) => s.plus(j.issuedCostValue), ZERO);
    expect(issuedCarat.toFixed(3)).toBe("300.000");
    expect(issuedCost.toFixed(2)).toBe("750000.00");
    // No row is left holding a negative or phantom balance.
    const rows = await prisma.roughPiece.findMany({ where: { lotId: lot.id } });
    expect(rows.every((r) => r.carat.greaterThan(0) && r.allocatedCost.greaterThan(0))).toBe(true);
    await reconcileAgainstStock();
  }, 90_000);

  it("a duplicate submission racing itself (same key, concurrent) creates ONE job and ONE voucher", async () => {
    const lot = await buyParcel({ carat: "300.000", cost: "750000.00", key: "parcel-conc-3" });
    const parcel = await parcelRow(lot.id);

    const results = await Promise.allSettled([
      issue(parcel.id, "100.000", { key: "parcel-conc-3-same" }),
      issue(parcel.id, "100.000", { key: "parcel-conc-3-same" }),
      issue(parcel.id, "100.000", { key: "parcel-conc-3-same" }),
    ]);
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof issue>>> => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.value.id)).size).toBe(1);
    expect(await prisma.diamondJob.count({ where: { idempotencyKey: "parcel-conc-3-same" } })).toBe(1);
    expect(await prisma.voucher.count({ where: { idempotencyKey: "parcel-conc-3-same" } })).toBe(1);
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcel.id } })).carat.toFixed(3)).toBe("200.000");
    await reconcileAgainstStock();
  }, 60_000);

  it("two concurrent issues of the same individual stone: exactly one wins", async () => {
    const lot = await buyParcel({ carat: "5.000", cost: "12500.00", kind: "STONE", key: "parcel-conc-4" });
    const stone = await parcelRow(lot.id);
    const attempt = (key: string) =>
      prisma.$transaction(
        (tx) => issueRoughToKarigar(tx, { ...FY, karigarId: manufacturerId, roughPieceIds: [stone.id], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key, createdByUserId: ownerId }),
        TX_OPTIONS
      );
    const results = await Promise.allSettled([attempt("parcel-conc-4-a"), attempt("parcel-conc-4-b")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.diamondJob.count({ where: { idempotencyKey: { startsWith: "parcel-conc-4-" } } })).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 7. Cancellation before any receipt restores exactly the issued quantity, once
// ---------------------------------------------------------------------------
describe("cancellation", () => {
  it("restores exactly the issued 100 ct / ₹2,50,000 into the parcel, keeps the issue history, shows zero pending/WIP", async () => {
    const base = await balances();
    const lot = await buyParcel({ carat: "300.000", cost: "750000.00", pieceCount: 1200, key: "parcel-cancel-1" });
    const parcel = await parcelRow(lot.id);
    const job = await issue(parcel.id, "100.000", { count: 400, key: "parcel-cancel-1-issue" });

    const cancelled = await cancel(job.id);
    expect(cancelled.status).toBe("CANCELLED");

    const restored = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcel.id } });
    expect(restored.carat.toFixed(3)).toBe("300.000");
    expect(restored.allocatedCost.toFixed(2)).toBe("750000.00");
    expect(restored.pieceCount).toBe(1200);
    expect(restored.status).toBe("AVAILABLE");
    const [child] = await childRows(parcel.id);
    expect(child.status).toBe("CANCELLED");

    const now = await balances();
    expect(now).toEqual({ rough: new Decimal(base.rough).plus("750000.00").toFixed(2), wip: base.wip, polished: base.polished });

    // History preserved, current position zero.
    const detail = (await getDiamondJobDetail(job.id))!;
    expect(detail.status).toBe("CANCELLED");
    expect(detail.issuedRoughCarat.toFixed(3)).toBe("100.000");
    expect(detail.issuedCostValue.toFixed(2)).toBe("250000.00");
    expect(detail.pendingCarat.toFixed(3)).toBe("0.000");
    expect(detail.remainingWipCost.toFixed(2)).toBe("0.00");
    expect(detail.pieces).toHaveLength(1);
    expect(detail.pieces[0].carat.toFixed(3)).toBe("100.000");
    const listed = (await listDiamondJobs({ search: job.jobCode })).find((j) => j.id === job.id)!;
    expect(listed.pendingCarat.toFixed(3)).toBe("0.000");
    expect(listed.remainingWipCost.toFixed(2)).toBe("0.00");
    const mine = (await getKarigarMaterialBalances()).find((b) => b.karigarId === manufacturerId)!;
    expect(mine.pendingCarat.toFixed(3)).not.toBe("100.000");
    const types = (await prisma.stockMovement.findMany({ where: { diamondJobId: job.id } })).map((m) => m.type).sort();
    expect(types).toEqual(
      ["ROUGH_ISSUE_CANCEL_IN", "ROUGH_ISSUE_OUT", "ROUGH_PARCEL_MERGE_IN", "ROUGH_PARCEL_MERGE_OUT", "ROUGH_PARCEL_SPLIT_IN", "ROUGH_PARCEL_SPLIT_OUT"].sort()
    );
    await reconcileAgainstStock();
  }, 60_000);

  it("a second cancel — even two racing — restores it only once", async () => {
    const lot = await buyParcel({ carat: "300.000", cost: "750000.00", key: "parcel-cancel-2" });
    const parcel = await parcelRow(lot.id);
    const job = await issue(parcel.id, "100.000", { key: "parcel-cancel-2-issue" });

    const results = await Promise.allSettled([cancel(job.id), cancel(job.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const restored = await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcel.id } });
    expect(restored.carat.toFixed(3)).toBe("300.000"); // not 400
    expect(restored.allocatedCost.toFixed(2)).toBe("750000.00");
    await expect(cancel(job.id)).rejects.toThrow(/already been cancelled/);
  }, 60_000);

  it("a cancel racing a receipt: either the cancel wins with no receipt, or the receipt wins and the cancel is refused", async () => {
    const lot = await buyParcel({ carat: "300.000", cost: "750000.00", key: "parcel-cancel-3" });
    const parcel = await parcelRow(lot.id);
    const job = await issue(parcel.id, "100.000", { key: "parcel-cancel-3-issue" });

    const results = await Promise.allSettled([
      cancel(job.id),
      receive(job.id, { carats: ["30.000"], labour: 1000, complete: false, key: "parcel-cancel-3-rec" }),
    ]);
    const cancelled = results[0].status === "fulfilled";
    const received = results[1].status === "fulfilled";
    expect(cancelled !== received).toBe(true); // exactly one of them
    const finalJob = await prisma.diamondJob.findUniqueOrThrow({ where: { id: job.id } });
    const receipts = await prisma.polishedReceipt.count({ where: { jobId: job.id } });
    if (cancelled) {
      expect(finalJob.status).toBe("CANCELLED");
      expect(receipts).toBe(0);
      expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcel.id } })).carat.toFixed(3)).toBe("300.000");
    } else {
      expect(finalJob.status).toBe("PARTIALLY_RECEIVED");
      expect(receipts).toBe(1);
      expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcel.id } })).carat.toFixed(3)).toBe("200.000");
    }
  }, 60_000);

  it("if the parcel has since gone out whole to another job, the cancelled portion returns as its own Available row", async () => {
    const lot = await buyParcel({ carat: "300.000", cost: "750000.00", key: "parcel-cancel-4" });
    const parcel = await parcelRow(lot.id);
    const job1 = await issue(parcel.id, "100.000", { key: "parcel-cancel-4-a" });
    await issue(parcel.id, "200.000", { key: "parcel-cancel-4-b" }); // remaining 200 goes out as the parcel row itself
    await cancel(job1.id);
    const [child] = await childRows(parcel.id);
    expect(child.status).toBe("AVAILABLE");
    expect(child.carat.toFixed(3)).toBe("100.000");
    expect(child.allocatedCost.toFixed(2)).toBe("250000.00");
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: parcel.id } })).status).toBe("WITH_KARIGAR");
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 1. Existing individual stones are never reinterpreted as parcels
// ---------------------------------------------------------------------------
describe("existing individual stones stay individual", () => {
  it("a row created without a kind is a STONE: it cannot be issued by carat, but issues whole as before", async () => {
    const lot = await prisma.roughLot.create({
      data: {
        lotCode: `ZL-RL-PARCELTEST-${Date.now()}`,
        purchaseDate: DATE,
        supplierId,
        piecesCount: 1,
        totalRoughCarat: "4.000",
        purchaseRate: "1000.0000",
        rateBasis: "PER_CARAT",
        totalPurchaseCost: "4000.00",
        createdByUserId: ownerId,
      },
    });
    const legacy = await prisma.roughPiece.create({
      data: { roughCode: `ZL-RGH-PARCELTEST-${Date.now()}`, lotId: lot.id, carat: "4.000", allocatedCost: "4000.00", createdByUserId: ownerId },
    });
    expect(legacy.kind).toBe("STONE");
    expect(legacy.pieceCount).toBeNull();
    await expect(issue(legacy.id, "1.000", { key: "parcel-legacy-carat" })).rejects.toThrow(/individual stone/);
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: legacy.id } })).carat.toFixed(3)).toBe("4.000");
  });
});

// ---------------------------------------------------------------------------
// Both kinds of party appear wherever material-with-party is shown
// ---------------------------------------------------------------------------
describe("material with a party", () => {
  it("lists a Karigar-type and a Manufacturer-type party, each with its own pending carat", async () => {
    // Earlier tests leave open jobs with these parties, so measure the change.
    const pendingOf = async (id: string) => (await getKarigarMaterialBalances()).find((b) => b.karigarId === id)!.pendingCarat;
    const karigarBefore = await pendingOf(karigarId);
    const manufacturerBefore = await pendingOf(manufacturerId);
    const dashboardBefore = (await getDashboardDiamondSummary()).materialWithKarigarCarat;
    const lotA = await buyParcel({ carat: "10.000", cost: "25000.00", key: "parcel-party-a" });
    const lotB = await buyParcel({ carat: "10.000", cost: "25000.00", key: "parcel-party-b" });
    const jobK = await issue((await parcelRow(lotA.id)).id, "4.000", { key: "parcel-party-issue-k", partyId: karigarId });
    const jobM = await issue((await parcelRow(lotB.id)).id, "6.000", { key: "parcel-party-issue-m", partyId: manufacturerId });

    expect((await pendingOf(karigarId)).minus(karigarBefore).toFixed(3)).toBe("4.000");
    expect((await pendingOf(manufacturerId)).minus(manufacturerBefore).toFixed(3)).toBe("6.000");
    // The dashboard total is built from the same balances, so it includes both.
    const dashboardAfter = (await getDashboardDiamondSummary()).materialWithKarigarCarat;
    expect(dashboardAfter.minus(dashboardBefore).toFixed(3)).toBe("10.000");

    await cancel(jobK.id);
    await cancel(jobM.id);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Transaction duration
// ---------------------------------------------------------------------------
describe("transaction duration", () => {
  it("a partial issue and a cancel each complete far inside the 5s Prisma default (and the 20s the actions allow)", async () => {
    const lot = await buyParcel({ carat: "300.000", cost: "750000.00", pieceCount: 100, key: "parcel-timing" });
    const parcel = await parcelRow(lot.id);
    const t0 = Date.now();
    const job = await issue(parcel.id, "100.000", { count: 33, key: "parcel-timing-issue" });
    const issueMs = Date.now() - t0;
    const t1 = Date.now();
    await cancel(job.id);
    const cancelMs = Date.now() - t1;
    console.log(`Parcel issue transaction: ${issueMs}ms; cancel transaction: ${cancelMs}ms (5s default, 20s allowance)`);
    expect(issueMs).toBeLessThan(5_000);
    expect(cancelMs).toBeLessThan(5_000);
  }, 60_000);
});
