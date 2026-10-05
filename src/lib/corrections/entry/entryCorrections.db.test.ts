/**
 * Real-database acceptance for the Owner "Correct entry" framework.
 *
 * Disposable scratch database only (the guard refuses anything else; this suite
 * truncates business tables). The central fixture reproduces production's
 * ZL-JOB-2026-000010 exactly: a 20-stone parcel of 47.458 ct (Rs 28,474.80) issued
 * whole to 4P / Laser at Rs 50 per ISSUED carat, received back as ONE 21.642 ct row
 * with the job completed -> charge Rs 2,372.90, loss 25.816 ct, stone cost Rs 30,847.70.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { CORRECTION_TRANSACTION_OPTIONS, CorrectionError } from "@/lib/corrections/types";
import { cancelDiamondJob, createRoughLotWithPieces, issueRoughToKarigar, receivePolishedDiamonds, receiveProcessedRough } from "@/lib/diamond/posting";
import { getDiamondJobDetail, getRoughStockSummary, listRoughPieces } from "@/lib/diamond/reports";
import { createJewelleryJob, issueMaterialsToJewelleryJob, postOpeningMetalStock, receiveFinishedJewellery } from "@/lib/jewellery/posting";

import { assertDisposableTestDb } from "../../../../test/setup/dbGuard";
import { entryCorrectionOptions, entryReverseBlockers, listEntryCorrections, postEntryCorrection, previewEntryCorrection, reverseEntryCorrection } from "./service";
import type { EntryKind, EntryTarget } from "./types";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-05T00:00:00.000Z");
const TX = CORRECTION_TRANSACTION_OPTIONS;
const REASON = "Manufacturer returned 20 stones; one row was saved by mistake";

let ownerId: string;
let staffId: string;
let supplierId: string;
let laserHouseId: string;
let laserId: string;
let hphtId: string;
let seq = 0;
const key = (label: string) => `entry-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}
async function accountBalance(code: string) {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const t = await prisma.journalEntry.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } });
  return new Decimal(t._sum.debit ?? 0).minus(t._sum.credit ?? 0);
}
async function payable(partyId: string) {
  const lines = await prisma.journalEntry.findMany({ where: { partyId, account: { code: "2000" } } });
  return lines.reduce((s, l) => s.plus(l.credit).minus(l.debit), ZERO).toFixed(2);
}
/** 1200 = every Available rough row's cost; 1210 = open jobs' WIP; every voucher balanced. */
async function reconcile() {
  const available = await prisma.roughPiece.findMany({ where: { status: "AVAILABLE" }, select: { allocatedCost: true } });
  const open = await prisma.diamondJob.findMany({ where: { status: { in: ["ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"] } }, select: { remainingWipCost: true } });
  expect((await accountBalance("1200")).toFixed(2)).toBe(available.reduce((s, p) => s.plus(p.allocatedCost), ZERO).toFixed(2));
  expect((await accountBalance("1210")).toFixed(2)).toBe(open.reduce((s, j) => s.plus(j.remainingWipCost), ZERO).toFixed(2));
  const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int n from (select "voucherId" from journal_entries group by 1 having sum(debit) <> sum(credit)) t`);
  expect(n).toBe(0);
}
/** The ledger and value picture that a pieces-only correction must leave byte-identical. */
async function valuePicture() {
  const [vouchers, lines, rough, jobs, moves] = await Promise.all([
    prisma.voucher.findMany({ orderBy: { id: "asc" }, select: { id: true, amount: true, status: true } }),
    prisma.journalEntry.findMany({ orderBy: { id: "asc" }, select: { id: true, debit: true, credit: true, accountId: true } }),
    prisma.roughPiece.findMany({ orderBy: { id: "asc" }, select: { id: true, carat: true, allocatedCost: true, originalCarat: true, originalCost: true, status: true } }),
    prisma.diamondJob.findMany({ orderBy: { id: "asc" }, select: { id: true, issuedRoughCarat: true, returnedRoughCarat: true, issuedCostValue: true, remainingWipCost: true, totalLabourCharge: true, status: true } }),
    prisma.stockMovement.findMany({ where: { type: { notIn: ["ROUGH_COUNT_CORRECTION_IN", "ROUGH_COUNT_CORRECTION_OUT"] } }, orderBy: { id: "asc" }, select: { id: true, carat: true, costValue: true, pieces: true } }),
  ]);
  return JSON.stringify({ vouchers, lines, rough, jobs, moves });
}

/** Production's ZL-JOB-2026-000010, rebuilt: returns { job, receipt, row }. */
async function exactCase(label: string, opts: { complete?: boolean; returned?: string; batchPieces?: number } = {}) {
  const lot = await prisma.$transaction(
    (tx) =>
      createRoughLotWithPieces(tx, {
        ...FY,
        purchaseDate: DATE,
        supplierId,
        purchaseRate: 600,
        rateBasis: "PER_CARAT",
        currencyCode: "INR",
        exchangeRate: 1,
        totalPurchaseCost: "28474.80",
        gstTreatment: "NONE",
        idempotencyKey: key(`${label}-lot`),
        createdByUserId: ownerId,
        pieces: [{ kind: "PARCEL", pieceCount: 20, carat: "47.458" }],
      }),
    TX
  );
  const parcel = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
  const job = await prisma.$transaction(
    (tx) =>
      issueRoughToKarigar(tx, {
        ...FY,
        karigarId: laserHouseId,
        roughPieceIds: [parcel.id],
        requiredShape: "ROUND",
        issueDate: DATE,
        processId: laserId,
        chargeRateBasis: "PER_ISSUED_CARAT",
        chargeRate: 50,
        idempotencyKey: key(`${label}-issue`),
        createdByUserId: ownerId,
      }),
    TX
  );
  const res = await prisma.$transaction(
    (tx) =>
      receiveProcessedRough(tx, {
        ...FY,
        jobId: job.id,
        receiveDate: DATE,
        ...(opts.batchPieces ? { batch: { pieceCount: opts.batchPieces, carat: opts.returned ?? "21.642" } } : { pieces: [{ carat: opts.returned ?? "21.642" }] }),
        markJobComplete: opts.complete ?? true,
        idempotencyKey: key(`${label}-receive`),
        createdByUserId: ownerId,
      }),
    TX
  );
  return { job: res.job, receipt: res.receipt, row: res.pieces[0] };
}

const rcpt = (id: string): EntryTarget => ({ entityType: "DIAMOND_RECEIPT", entityId: id });
async function preview(target: EntryTarget, kind: EntryKind, values: Record<string, string>, reason = REASON) {
  return prisma.$transaction((tx) => previewEntryCorrection(tx, { target, kind, values, reason }), TX);
}
async function post(target: EntryTarget, kind: EntryKind, values: Record<string, string>, opts: { fingerprint?: string; key?: string; reason?: string; actor?: { id: string; role: "OWNER" | "STAFF" } } = {}) {
  const fp = opts.fingerprint ?? (await preview(target, kind, values)).fingerprint;
  return prisma.$transaction(
    (tx) =>
      postEntryCorrection(tx, {
        target,
        kind,
        values,
        reason: opts.reason ?? REASON,
        idempotencyKey: opts.key ?? key("post"),
        expectedFingerprint: fp,
        owner: opts.actor ?? owner(),
        ...FY,
      }),
    TX
  );
}
async function reverse(correctionId: string, actor: { id: string; role: "OWNER" | "STAFF" } = owner()) {
  return prisma.$transaction((tx) => reverseEntryCorrection(tx, { correctionId, reason: "Correction entered against the wrong receipt", owner: actor, ...FY }), TX);
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  staffId = (await prisma.user.findFirst({ where: { role: "STAFF" } }))?.id ?? (await prisma.user.create({ data: { email: "entry.staff@example.test", name: "Entry Staff", role: "STAFF", passwordHash: "x" } })).id;
  await clearAll();
  supplierId = (await prisma.party.create({ data: { name: "Entry Rough Supplier", type: "SUPPLIER", createdByUserId: ownerId } })).id;
  laserHouseId = (await prisma.party.create({ data: { name: "Krishna diamond (test)", type: "MANUFACTURER", createdByUserId: ownerId } })).id;
  laserId = (await prisma.diamondProcess.findFirstOrThrow({ where: { name: "4P / Laser" } })).id;
  hphtId = (await prisma.diamondProcess.findFirstOrThrow({ where: { name: "HPHT / Grow" } })).id;
}, 90_000);

afterAll(async () => {
  await clearAll();
});

// ---------------------------------------------------------------------------
// 1-3, 19. The exact production case: 1 pc -> 20 pcs, nothing else moves
// ---------------------------------------------------------------------------
describe("ZL-JOB-2026-000010 replica: returned pieces 1 -> 20", () => {
  let fx: Awaited<ReturnType<typeof exactCase>>;
  let correctionId: string;

  it("the fixture matches production: Rs 2,372.90 charge, 25.816 ct loss, ONE 21.642 ct stone at Rs 30,847.70", async () => {
    fx = await exactCase("exact");
    expect([fx.job.status, new Decimal(fx.job.totalLabourCharge).toFixed(2), new Decimal(fx.job.issuedCostValue).toFixed(2), new Decimal(fx.job.remainingWipCost).toFixed(2)]).toEqual(["COMPLETED", "2372.90", "28474.80", "0.00"]);
    expect(new Decimal(fx.receipt.weightLossCarat).toFixed(3)).toBe("25.816");
    expect([fx.row.kind, fx.row.pieceCount, new Decimal(fx.row.carat).toFixed(3), new Decimal(fx.row.allocatedCost).toFixed(2)]).toEqual(["STONE", null, "21.642", "30847.70"]);
    await reconcile();
  });

  it("offers the correction with no blocker, and previews only the count: +19 pcs, 0 ct, Rs 0, no journal line", async () => {
    const options = await prisma.$transaction((tx) => entryCorrectionOptions(tx, rcpt(fx.receipt.id)), TX);
    const pieces = options.find((o) => o.kind === "RETURNED_PIECES")!;
    expect([pieces.entryClass, pieces.fields[0].current, pieces.blockers]).toEqual(["QUANTITY", "1", []]);
    const p = await preview(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" });
    expect(p.changes).toEqual([{ field: "returnedPieces", label: "Returned pieces", before: "1 pc / 21.642 ct", after: "20 pcs / 21.642 ct" }]);
    expect(p.stock).toEqual([{ label: `${fx.row.roughCode} (becomes a counted parcel)`, pieces: 19, carat: "0.000", cost: "0.00" }]);
    expect([p.ledger, p.blockers]).toEqual([[], []]);
  });

  it("posts with NO voucher or journal entry; carat, cost, loss, charge, WIP byte-identical; parcel, receipt, job and picker show 20 pcs / 21.642 ct", async () => {
    const before = await valuePicture();
    const vouchersBefore = await prisma.voucher.count();
    const res = await post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" });
    correctionId = res.correction.id;
    expect(res.correction.correctionCode).toMatch(/^ZL-COR-\d{4}-\d{6}$/);
    expect(res.correction.correctionVoucherId).toBeNull();
    expect(await prisma.voucher.count()).toBe(vouchersBefore);
    expect(await valuePicture()).toBe(before);

    const row = await prisma.roughPiece.findUniqueOrThrow({ where: { id: fx.row.id } });
    expect([row.kind, row.pieceCount, row.originalPieceCount, new Decimal(row.carat).toFixed(3), new Decimal(row.allocatedCost).toFixed(2), row.status]).toEqual(["PARCEL", 20, 20, "21.642", "30847.70", "AVAILABLE"]);
    const move = await prisma.stockMovement.findFirstOrThrow({ where: { sourceDocument: res.correction.correctionCode } });
    expect([move.type, move.pieces, new Decimal(move.carat).toFixed(3), new Decimal(move.costValue).toFixed(2)]).toEqual(["ROUGH_COUNT_CORRECTION_IN", 19, "0.000", "0.00"]);

    const detail = (await getDiamondJobDetail(fx.job.id))!;
    expect([detail.returnedRoughPieces, detail.returnedRoughCarat.toFixed(3), detail.finalWeightLossCarat!.toFixed(3), detail.totalLabourCharge.toFixed(2)]).toEqual([20, "21.642", "25.816", "2372.90"]);
    expect(detail.receipts[0].returnedRoughPieces).toBe(20);
    expect(detail.receipts[0].returnedRows).toEqual([{ roughCode: fx.row.roughCode, kind: "PARCEL", pieces: 20, carat: new Decimal("21.642") }]);
    const picker = (await listRoughPieces({ status: "AVAILABLE" })).find((p) => p.id === fx.row.id)!;
    expect([picker.kind, picker.pieceCount, picker.carat.toFixed(3), picker.origin!.returnedPieces]).toEqual(["PARCEL", 20, "21.642", 20]);
    expect((await getRoughStockSummary()).stoneCount).toBeGreaterThanOrEqual(20);
    await reconcile();
  });

  it("history keeps the original 1 pc, who, when, why and the code; Staff see the same counts and no money", async () => {
    const ownerView = await prisma.$transaction((tx) => listEntryCorrections(tx, [fx.receipt.id], { includeMoney: true }), TX);
    expect(ownerView).toHaveLength(1);
    const h = ownerView[0];
    expect([h.kind, h.state, h.reason, h.canReverse]).toEqual(["RETURNED_PIECES", "ACTIVE", REASON, true]);
    expect(h.changes).toContainEqual({ field: "returnedPieces", record: fx.receipt.receiptCode, before: "1", after: "20" });
    expect(h.changes).toContainEqual({ field: "kind", record: fx.row.roughCode, before: "STONE", after: "PARCEL" });
    const staffView = await prisma.$transaction((tx) => listEntryCorrections(tx, [fx.receipt.id], { includeMoney: false }), TX);
    expect([staffView[0].voucher, staffView[0].amount, staffView[0].canReverse]).toEqual([null, null, false]);
    expect(JSON.stringify(staffView)).not.toMatch(/30847|2372|28474/);
  });

  it("reverses 20 -> 1 while the parcel is unused: STONE again, 1 pc, a mirror count movement, still no voucher", async () => {
    const before = await valuePicture();
    const { reversal } = await reverse(correctionId);
    expect(reversal.correctionCode).toMatch(/^ZL-COR-/);
    expect(await valuePicture()).toBe(before);
    const row = await prisma.roughPiece.findUniqueOrThrow({ where: { id: fx.row.id } });
    expect([row.kind, row.pieceCount, row.originalPieceCount]).toEqual(["STONE", null, null]);
    const back = await prisma.stockMovement.findFirstOrThrow({ where: { sourceDocument: reversal.correctionCode } });
    expect([back.type, back.pieces]).toEqual(["ROUGH_COUNT_CORRECTION_OUT", 19]);
    expect((await getDiamondJobDetail(fx.job.id))!.returnedRoughPieces).toBe(1);
    const h = (await prisma.$transaction((tx) => listEntryCorrections(tx, [fx.receipt.id], { includeMoney: true }), TX))[0];
    expect([h.state, h.reversal?.code]).toEqual(["REVERSED", reversal.correctionCode]);
    await expect(reverse(correctionId)).rejects.toThrow(/already been reversed/);
    await reconcile();
  });
});

// ---------------------------------------------------------------------------
// 4-6. Partial / final, batch / individual, and a later process
// ---------------------------------------------------------------------------
describe("which processed-rough receipts can be re-counted", () => {
  it("a PARTIAL batch receipt (no loss yet) can be re-counted; pending carat and WIP do not move", async () => {
    const fx = await exactCase("partial", { complete: false, returned: "20.000", batchPieces: 12 });
    expect(fx.job.status).toBe("PARTIALLY_RECEIVED");
    const before = await valuePicture();
    await post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "14" });
    expect(await valuePicture()).toBe(before);
    const row = await prisma.roughPiece.findUniqueOrThrow({ where: { id: fx.row.id } });
    expect([row.kind, row.pieceCount]).toEqual(["PARCEL", 14]);
    expect((await getDiamondJobDetail(fx.job.id))!.pendingCarat.toFixed(3)).toBe("27.458");
    await reconcile();
  });

  it("an INDIVIDUAL receipt of several weighed stones is refused with the receipt code (no invented weights)", async () => {
    const fx = await exactCase("multi");
    // a second, separately weighed stone on another job's receipt
    const lot = await prisma.$transaction((tx) => createRoughLotWithPieces(tx, { ...FY, purchaseDate: DATE, supplierId, purchaseRate: 600, rateBasis: "PER_CARAT", currencyCode: "INR", exchangeRate: 1, totalPurchaseCost: "6000.00", gstTreatment: "NONE", idempotencyKey: key("multi-lot2"), createdByUserId: ownerId, pieces: [{ carat: "10.000" }] }), TX);
    const stone = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
    const job2 = await prisma.$transaction((tx) => issueRoughToKarigar(tx, { ...FY, karigarId: laserHouseId, roughPieceIds: [stone.id], requiredShape: "ROUND", issueDate: DATE, processId: laserId, idempotencyKey: key("multi-issue2"), createdByUserId: ownerId }), TX);
    const r2 = await prisma.$transaction((tx) => receiveProcessedRough(tx, { ...FY, jobId: job2.id, receiveDate: DATE, pieces: [{ carat: "4.000" }, { carat: "5.000" }], markJobComplete: true, idempotencyKey: key("multi-rec2"), createdByUserId: ownerId }), TX);
    const p = await preview(rcpt(r2.receipt.id), "RETURNED_PIECES", { returnedPieces: "5" });
    expect(p.blockers.map((b) => b.code)).toEqual([r2.receipt.receiptCode]);
    await expect(post(rcpt(r2.receipt.id), "RETURNED_PIECES", { returnedPieces: "5" }, { fingerprint: p.fingerprint })).rejects.toThrow(new RegExp(`${r2.receipt.receiptCode} — .*separately weighed`));
    expect(fx).toBeTruthy();
  });

  it("issued into a later process (HPHT): refused naming that job; the later receipt's own row CAN be re-counted once its cancelled issue came back", async () => {
    const fx = await exactCase("chain");
    // Production's chain: the 4P stone went to HPHT (completed), which returned one stone;
    // that stone was issued to a third job that was cancelled.
    const hpht = await prisma.$transaction((tx) => issueRoughToKarigar(tx, { ...FY, karigarId: laserHouseId, roughPieceIds: [fx.row.id], requiredShape: "ROUND", issueDate: DATE, processId: hphtId, chargeRateBasis: "PER_ISSUED_CARAT", chargeRate: 325, idempotencyKey: key("chain-hpht"), createdByUserId: ownerId }), TX);
    const back = await prisma.$transaction((tx) => receiveProcessedRough(tx, { ...FY, jobId: hpht.id, receiveDate: DATE, pieces: [{ carat: "21.642" }], markJobComplete: true, idempotencyKey: key("chain-hpht-rec"), createdByUserId: ownerId }), TX);
    const third = await prisma.$transaction((tx) => issueRoughToKarigar(tx, { ...FY, karigarId: laserHouseId, roughPieceIds: [back.pieces[0].id], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key("chain-third"), createdByUserId: ownerId }), TX);
    await prisma.$transaction((tx) => cancelDiamondJob(tx, { ...FY, jobId: third.id, cancelledByUserId: ownerId, cancellationReason: "Issued by mistake" }), TX);

    const first = await preview(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" });
    expect(first.blockers.map((b) => b.code)).toEqual([hpht.jobCode]);
    await expect(post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" }, { fingerprint: first.fingerprint })).rejects.toThrow(new RegExp(`${hpht.jobCode} — .*issued to ${hpht.jobCode}`));

    const second = await preview(rcpt(back.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" });
    expect(second.blockers).toEqual([]);
    const before = await valuePicture();
    await post(rcpt(back.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" }, { fingerprint: second.fingerprint });
    expect(await valuePicture()).toBe(before);
    const row = await prisma.roughPiece.findUniqueOrThrow({ where: { id: back.pieces[0].id } });
    expect([row.kind, row.pieceCount, new Decimal(row.carat).toFixed(3), new Decimal(row.allocatedCost).toFixed(2)]).toEqual(["PARCEL", 20, "21.642", "37881.35"]);
    await reconcile();
  });

  it("a per-piece charge makes the count financial: refused naming the job", async () => {
    const lot = await prisma.$transaction((tx) => createRoughLotWithPieces(tx, { ...FY, purchaseDate: DATE, supplierId, purchaseRate: 600, rateBasis: "PER_CARAT", currencyCode: "INR", exchangeRate: 1, totalPurchaseCost: "6000.00", gstTreatment: "NONE", idempotencyKey: key("pp-lot"), createdByUserId: ownerId, pieces: [{ carat: "10.000" }] }), TX);
    const stone = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
    const job = await prisma.$transaction((tx) => issueRoughToKarigar(tx, { ...FY, karigarId: laserHouseId, roughPieceIds: [stone.id], requiredShape: "ROUND", issueDate: DATE, processId: laserId, chargeRateBasis: "PER_PIECE", chargeRate: 100, idempotencyKey: key("pp-issue"), createdByUserId: ownerId }), TX);
    const r = await prisma.$transaction((tx) => receiveProcessedRough(tx, { ...FY, jobId: job.id, receiveDate: DATE, batch: { pieceCount: 4, carat: "9.000" }, markJobComplete: true, idempotencyKey: key("pp-rec"), createdByUserId: ownerId }), TX);
    expect((await preview(rcpt(r.receipt.id), "RETURNED_PIECES", { returnedPieces: "5" })).blockers.map((b) => b.code)).toEqual([job.jobCode]);
  });
});

// ---------------------------------------------------------------------------
// Stock and accounting: receipt reversal, then re-entry
// ---------------------------------------------------------------------------
describe("processed-rough receipt reversal (carat / charge / loss corrections)", () => {
  it("posts the exact mirror (Dr 1210 28,474.80, Dr payable 2,372.90 / Cr 1200 30,847.70), reopens the job exactly, then the receipt is entered again as 20 pcs", async () => {
    const fx = await exactCase("rev");
    const payBefore = await payable(laserHouseId);
    const p = await preview(rcpt(fx.receipt.id), "RECEIPT_REVERSAL", {});
    expect(p.blockers).toEqual([]);
    expect(p.ledger.map((l) => [l.accountCode, l.debit, l.credit]).sort()).toEqual([["1200", "0.00", "30847.70"], ["1210", "28474.80", "0.00"], ["2000", "2372.90", "0.00"]]);
    const res = await post(rcpt(fx.receipt.id), "RECEIPT_REVERSAL", {}, { fingerprint: p.fingerprint });
    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: res.correction.correctionVoucherId! } });
    expect([voucher.voucherType, voucher.status, new Decimal(voucher.amount).toFixed(2)]).toEqual(["CORRECTION", "POSTED", "30847.70"]);
    // The receipt's own voucher is untouched.
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: fx.receipt.postingVoucherId! } })).status).toBe("POSTED");

    const job = await prisma.diamondJob.findUniqueOrThrow({ where: { id: fx.job.id } });
    expect([job.status, new Decimal(job.returnedRoughCarat).toFixed(3), new Decimal(job.totalLabourCharge).toFixed(2), new Decimal(job.remainingWipCost).toFixed(2)]).toEqual(["IN_PROGRESS", "0.000", "0.00", "28474.80"]);
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: fx.row.id } })).status).toBe("CANCELLED");
    const issued = await prisma.diamondJobPiece.findFirstOrThrow({ where: { jobId: fx.job.id }, include: { roughPiece: true } });
    expect(issued.roughPiece.status).toBe("WITH_KARIGAR");
    const mirrors = await prisma.stockMovement.findMany({ where: { sourceDocument: res.correction.correctionCode }, orderBy: { type: "asc" } });
    expect(mirrors.map((m) => [m.type, m.pieces, new Decimal(m.carat).toFixed(3), new Decimal(m.costValue).toFixed(2), !!m.reversalOfMovementId]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
      ["ROUGH_CONSUMED_REVERSAL_IN", 0, "25.816", "0.00", true],
      ["ROUGH_RETURN_REVERSAL_OUT", 1, "21.642", "30847.70", true],
    ]);
    expect(await payable(laserHouseId)).toBe(new Decimal(payBefore).minus("2372.90").toFixed(2));
    expect((await getDiamondJobDetail(fx.job.id))!.receipts[0].reversedBy).toBe(res.correction.correctionCode);
    await reconcile();

    // A reversal is not itself reversed — the remedy is a new receipt.
    expect((await prisma.$transaction((tx) => entryReverseBlockers(tx, res.correction.id), TX))[0].message).toMatch(/receive the rough again/);

    const again = await prisma.$transaction((tx) => receiveProcessedRough(tx, { ...FY, jobId: fx.job.id, receiveDate: DATE, batch: { pieceCount: 20, carat: "21.642" }, markJobComplete: true, idempotencyKey: key("rev-again"), createdByUserId: ownerId }), TX);
    expect([new Decimal(again.receipt.labourCharge).toFixed(2), new Decimal(again.receipt.weightLossCarat).toFixed(3), new Decimal(again.pieces[0].allocatedCost).toFixed(2), again.pieces[0].pieceCount]).toEqual(["2372.90", "25.816", "30847.70", 20]);
    const d = (await getDiamondJobDetail(fx.job.id))!;
    expect([d.status, d.returnedRoughPieces, d.returnedRoughCarat.toFixed(3), d.totalLabourCharge.toFixed(2)]).toEqual(["COMPLETED", 20, "21.642", "2372.90"]);
    expect(await payable(laserHouseId)).toBe(payBefore);
    await reconcile();
  });

  it("newest first: an active count correction blocks the reversal until it is reversed; a later receipt blocks the earlier one", async () => {
    const fx = await exactCase("order", { complete: false, returned: "10.000", batchPieces: 8 });
    const count = await post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "9" });
    expect((await preview(rcpt(fx.receipt.id), "RECEIPT_REVERSAL", {})).blockers.map((b) => b.code)).toEqual([count.correction.correctionCode]);
    await reverse(count.correction.id);
    const second = await prisma.$transaction((tx) => receiveProcessedRough(tx, { ...FY, jobId: fx.job.id, receiveDate: DATE, batch: { pieceCount: 5, carat: "5.000" }, markJobComplete: false, idempotencyKey: key("order-2"), createdByUserId: ownerId }), TX);
    expect((await preview(rcpt(fx.receipt.id), "RECEIPT_REVERSAL", {})).blockers.map((b) => b.code)).toEqual([second.receipt.receiptCode]);
    // Reverse the newer one, then the older one: the job ends exactly as issued.
    await post(rcpt(second.receipt.id), "RECEIPT_REVERSAL", {});
    await post(rcpt(fx.receipt.id), "RECEIPT_REVERSAL", {});
    const job = await prisma.diamondJob.findUniqueOrThrow({ where: { id: fx.job.id } });
    expect([job.status, new Decimal(job.returnedRoughCarat).toFixed(3), new Decimal(job.remainingWipCost).toFixed(2)]).toEqual(["IN_PROGRESS", "0.000", "28474.80"]);
    expect((await getDiamondJobDetail(fx.job.id))!.returnedRoughPieces).toBe(0);
    await reconcile();
  });

  it("a returned row already issued onward blocks the reversal with that job's code", async () => {
    const fx = await exactCase("used");
    const next = await prisma.$transaction((tx) => issueRoughToKarigar(tx, { ...FY, karigarId: laserHouseId, roughPieceIds: [fx.row.id], requiredShape: "ROUND", issueDate: DATE, processId: hphtId, idempotencyKey: key("used-next"), createdByUserId: ownerId }), TX);
    expect((await preview(rcpt(fx.receipt.id), "RECEIPT_REVERSAL", {})).blockers.map((b) => b.code)).toEqual([next.jobCode]);
  });
});

// ---------------------------------------------------------------------------
// Metadata on diamond and jewellery jobs and receipts
// ---------------------------------------------------------------------------
describe("metadata corrections (details only)", () => {
  it("diamond job notes and due date: before -> after kept, reversal restores, no stock or voucher", async () => {
    const fx = await exactCase("meta");
    const target: EntryTarget = { entityType: "DIAMOND_JOB", entityId: fx.job.id };
    const before = await valuePicture();
    const res = await post(target, "METADATA", { notes: "Laser plan: 4P on all 20", dueDate: "2026-10-20" });
    expect(await valuePicture()).toBe(before);
    const job = await prisma.diamondJob.findUniqueOrThrow({ where: { id: fx.job.id } });
    expect([job.notes, job.dueDate?.toISOString().slice(0, 10)]).toEqual(["Laser plan: 4P on all 20", "2026-10-20"]);
    const later = await post(target, "METADATA", { notes: "Laser plan: 4P on 19, 1 kept" });
    // Newest first: the earlier one cannot be reversed while the later one stands.
    expect((await prisma.$transaction((tx) => entryReverseBlockers(tx, res.correction.id), TX)).map((b) => b.code)).toEqual([later.correction.correctionCode]);
    await reverse(later.correction.id);
    await reverse(res.correction.id);
    const restored = await prisma.diamondJob.findUniqueOrThrow({ where: { id: fx.job.id } });
    expect([restored.notes, restored.dueDate]).toEqual([null, null]);
    await expect(post(target, "METADATA", { notes: "" })).rejects.toThrow(/Nothing has changed/);
    await expect(post(target, "METADATA", { issuedRoughCarat: "1" } as Record<string, string>)).rejects.toThrow(/cannot be corrected on this record/);
  });

  it("diamond receipt notes — processed-rough and polished receipts: notes only, no stock or voucher, reversible", async () => {
    const fx = await exactCase("rnotes");
    const polishingId = (await prisma.diamondProcess.findFirstOrThrow({ where: { outputKind: "POLISHED", isActive: true } })).id;
    const lot = await prisma.$transaction((tx) => createRoughLotWithPieces(tx, { ...FY, purchaseDate: DATE, supplierId, purchaseRate: 600, rateBasis: "PER_CARAT", currencyCode: "INR", exchangeRate: 1, totalPurchaseCost: "3000.00", gstTreatment: "NONE", idempotencyKey: key("pol-lot"), createdByUserId: ownerId, pieces: [{ carat: "5.000" }] }), TX);
    const stone = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
    const job = await prisma.$transaction((tx) => issueRoughToKarigar(tx, { ...FY, karigarId: laserHouseId, roughPieceIds: [stone.id], requiredShape: "ROUND", issueDate: DATE, processId: polishingId, idempotencyKey: key("pol-issue"), createdByUserId: ownerId }), TX);
    const polished = await prisma.$transaction(
      (tx) => receivePolishedDiamonds(tx, { ...FY, jobId: job.id, receiveDate: DATE, returnedRoughCarat: 0, labourCharge: 0, shape: "ROUND", markJobComplete: true, idempotencyKey: key("pol-rec"), createdByUserId: ownerId, outputs: [{ shape: "ROUND", carat: "2.000" }] }),
      TX
    );
    for (const receiptId of [fx.receipt.id, polished.receipt.id]) {
      const target: EntryTarget = { entityType: "DIAMOND_RECEIPT", entityId: receiptId };
      const options = await prisma.$transaction((tx) => entryCorrectionOptions(tx, target), TX);
      expect(options.find((o) => o.kind === "METADATA")?.fields.map((f) => f.field)).toEqual(["notes"]);
      const before = await valuePicture();
      const vouchers = await prisma.voucher.count();
      const res = await post(target, "METADATA", { notes: "Weighed again at the counter" });
      expect((await prisma.polishedReceipt.findUniqueOrThrow({ where: { id: receiptId } })).notes).toBe("Weighed again at the counter");
      expect([await valuePicture(), await prisma.voucher.count()]).toEqual([before, vouchers]);
      await reverse(res.correction.id);
      expect((await prisma.polishedReceipt.findUniqueOrThrow({ where: { id: receiptId } })).notes).toBeNull();
    }
    await expect(post({ entityType: "DIAMOND_RECEIPT", entityId: polished.receipt.id }, "METADATA", { labourCharge: "1" } as Record<string, string>)).rejects.toThrow(/cannot be corrected on this record/);
    await reconcile();
  });

  it("jewellery job and jewellery receipt details", async () => {
    const karigarId = (await prisma.party.create({ data: { name: "Entry Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
    const gold = (await prisma.metalPurity.upsert({ where: { metalType_displayName: { metalType: "GOLD", displayName: "ENTRY 22K" } }, create: { metalType: "GOLD", displayName: "ENTRY 22K", finenessPercent: "91.600", createdByUserId: ownerId }, update: {} })).id;
    await prisma.$transaction((tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: gold, grossWeight: "50.000", costValue: "300000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }), TX);
    const job = await prisma.$transaction((tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "Entry ring", karigarId, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("jjob") }), TX);
    await prisma.$transaction((tx) => issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId: gold, grossWeight: "5" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("jiss"), createdByUserId: ownerId }), TX);
    const r = await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY,
          jobId: job.id,
          receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "4.900", metalType: "GOLD", purityId: gold, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [],
          returnedMetalLines: [],
          scrapMetalLines: [],
          karigarAddedFineWeight: "0",
          karigarAddedCost: "0",
          labourCharge: "500.00",
          makingCharge: 0,
          settingCharge: 0,
          platingCharge: 0,
          otherExpense: 0,
          markJobComplete: true,
          isAbnormalLoss: false,
          damagedLostByUserId: ownerId,
          idempotencyKey: key("jrcv"),
          createdByUserId: ownerId,
        }),
      TX
    );
    const jt: EntryTarget = { entityType: "JEWELLERY_JOB", entityId: job.id };
    await post(jt, "METADATA", { specialInstructions: "Rhodium finish", expectedDeliveryDate: "2026-10-30", customerReference: "PO-17" });
    const j = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job.id } });
    expect([j.specialInstructions, j.expectedDeliveryDate?.toISOString().slice(0, 10), j.customerReference]).toEqual(["Rhodium finish", "2026-10-30", "PO-17"]);
    const receiptId = (r as { receipt: { id: string } }).receipt.id;
    const rt: EntryTarget = { entityType: "JEWELLERY_RECEIPT", entityId: receiptId };
    const vouchers = await prisma.voucher.count();
    await post(rt, "METADATA", { notes: "Weighed at counter 2" });
    expect((await prisma.jewelleryReceipt.findUniqueOrThrow({ where: { id: receiptId } })).notes).toBe("Weighed at counter 2");
    expect(await prisma.voucher.count()).toBe(vouchers);
  });
});

// ---------------------------------------------------------------------------
// 9, 14-18. Idempotency, races, rollback, stale preview, Staff
// ---------------------------------------------------------------------------
describe("safety", () => {
  it("a double click (same key) posts once; two tabs (different keys, same preview) -> exactly one success", async () => {
    const fx = await exactCase("dup");
    const p = await preview(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" });
    const k = key("same");
    const [a, b] = await Promise.all([
      post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" }, { fingerprint: p.fingerprint, key: k }),
      post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" }, { fingerprint: p.fingerprint, key: k }),
    ]);
    expect(a.correction.id).toBe(b.correction.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await prisma.correction.count({ where: { entityId: fx.receipt.id } })).toBe(1);

    const fx2 = await exactCase("tabs");
    const p2 = await preview(rcpt(fx2.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" });
    const results = await Promise.allSettled([
      post(rcpt(fx2.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" }, { fingerprint: p2.fingerprint }),
      post(rcpt(fx2.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" }, { fingerprint: p2.fingerprint }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.correction.count({ where: { entityId: fx2.receipt.id } })).toBe(1);
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: fx2.row.id } })).pieceCount).toBe(20);
    await reconcile();
  }, 60_000);

  it("a correction racing a next-process issue of the same row: one consistent order, never a 1-piece issue of a 20-piece parcel", async () => {
    const fx = await exactCase("race");
    const p = await preview(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" });
    const [corr, issue] = await Promise.allSettled([
      post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" }, { fingerprint: p.fingerprint }),
      prisma.$transaction((tx) => issueRoughToKarigar(tx, { ...FY, karigarId: laserHouseId, roughPieceIds: [fx.row.id], requiredShape: "ROUND", issueDate: DATE, processId: hphtId, idempotencyKey: key("race-issue"), createdByUserId: ownerId }), TX),
    ]);
    expect(issue.status).toBe("fulfilled");
    const next = (issue as PromiseFulfilledResult<{ issuedPiecesCount: number; jobCode: string }>).value;
    if (corr.status === "fulfilled") {
      expect(next.issuedPiecesCount).toBe(20); // the correction committed first; the issue saw 20 pcs
    } else {
      expect(String(corr.reason.message)).toContain(next.jobCode); // the issue won; the correction names it
      expect(next.issuedPiecesCount).toBe(1);
    }
    await reconcile();
  }, 60_000);

  it("a failure after posting rolls back the correction, its impacts, the count, the movement and the code sequence together", async () => {
    const fx = await exactCase("rollback");
    const snap = async () =>
      JSON.stringify({
        corrections: await prisma.correction.count(),
        impacts: await prisma.correctionImpact.count(),
        moves: await prisma.stockMovement.count(),
        row: await prisma.roughPiece.findUniqueOrThrow({ where: { id: fx.row.id } }),
        seq: await prisma.jewellerySequence.findMany({ where: { sequenceType: "ENTRY_CORRECTION" } }),
      });
    const before = await snap();
    const p = await preview(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" });
    await expect(
      prisma.$transaction(async (tx) => {
        await postEntryCorrection(tx, { target: rcpt(fx.receipt.id), kind: "RETURNED_PIECES", values: { returnedPieces: "20" }, reason: REASON, idempotencyKey: key("rb"), expectedFingerprint: p.fingerprint, owner: owner(), ...FY });
        throw new Error("simulated failure after the correction");
      }, TX)
    ).rejects.toThrow(/simulated failure/);
    expect(await snap()).toBe(before);
  });

  it("a stale preview is refused; a short reason is refused; Staff cannot post or reverse", async () => {
    const fx = await exactCase("stale");
    const p = await preview(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" });
    await post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "20" }, { fingerprint: p.fingerprint });
    const old = await preview(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "21" });
    await post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "21" }, { fingerprint: old.fingerprint });
    // `old` was taken when the row held 20; it now holds 21 — a preview for 20 -> 22 is stale.
    const stale = await preview(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "22" });
    await post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "23" }, { fingerprint: stale.fingerprint }).then(
      () => { throw new Error("a stale preview must not post"); },
      (e) => expect(String(e.message)).toMatch(/changed after this preview/)
    );
    await expect(post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "24" }, { reason: "too short" })).rejects.toThrow(/at least 10 characters/);
    await expect(post(rcpt(fx.receipt.id), "RETURNED_PIECES", { returnedPieces: "24" }, { actor: { id: staffId, role: "STAFF" } })).rejects.toThrow(CorrectionError);
    const latest = await prisma.correction.findFirstOrThrow({ where: { entityId: fx.receipt.id, state: "POSTED" }, orderBy: { createdAt: "desc" } });
    await expect(reverse(latest.id, { id: staffId, role: "STAFF" })).rejects.toThrow(/Only the Owner/);
  });
});
