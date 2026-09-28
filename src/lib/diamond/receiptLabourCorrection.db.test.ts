/**
 * Real-database acceptance for the audited Manufacturer receipt labour
 * correction. Isolated test database only (refuses anything else).
 *
 * Reproduces production's ZL-REC-2026-000003: Polishing 10.190 ct issued at
 * ₹850 "per carat" -> 6 stones / 5.091 ct parcel, labour posted ₹4,327.35,
 * packet cost ₹20,627.10 — then corrects it per issued carat to ₹8,661.50.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal, ZERO } from "@/lib/accounting/money";
import { CorrectionError } from "@/lib/corrections/types";
import { prisma } from "@/lib/db/prisma";
import { createRoughLotWithPieces, issueRoughToKarigar, receivePolishedDiamonds } from "./posting";
import { labourPlanFingerprint, planReceiptLabour, postReceiptLabourCorrection, reverseReceiptLabourCorrection } from "./receiptLabourCorrection";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-28T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };
const REASON = "Polishing is charged per issued carat, not per received carat";

let ownerId: string;
let owner: { id: string; role: "OWNER" };
let supplierId: string;
let manufacturerId: string;
let polishingId: string;

async function clearData() {
  const [lots, jobs, receipts, corrections] = await Promise.all([
    prisma.roughLot.findMany({ select: { voucherId: true } }),
    prisma.diamondJob.findMany({ select: { wipVoucherId: true } }),
    prisma.polishedReceipt.findMany({ select: { postingVoucherId: true } }),
    prisma.correction.findMany({ where: { entityType: "DIAMOND_RECEIPT" }, select: { id: true, correctionVoucherId: true } }),
  ]);
  const voucherIds = [
    ...lots.map((l) => l.voucherId),
    ...jobs.map((j) => j.wipVoucherId),
    ...receipts.map((r) => r.postingVoucherId),
    ...corrections.map((c) => c.correctionVoucherId),
  ].filter((id): id is string => !!id);
  const reversals = voucherIds.length ? await prisma.voucher.findMany({ where: { reversalOfVoucherId: { in: voucherIds } }, select: { id: true } }) : [];
  await prisma.diamondReceiptLabourCorrection.deleteMany();
  await prisma.correction.updateMany({ where: { entityType: "DIAMOND_RECEIPT" }, data: { reversedByCorrectionId: null } });
  await prisma.correctionImpact.deleteMany({ where: { correction: { entityType: "DIAMOND_RECEIPT" } } });
  await prisma.correction.deleteMany({ where: { entityType: "DIAMOND_RECEIPT" } });
  await prisma.polishedPacketMovement.deleteMany({ where: { packet: { sourceDiamondJobId: { not: null } } } });
  await prisma.polishedPacket.deleteMany({ where: { sourceDiamondJobId: { not: null } } });
  await prisma.stockMovement.deleteMany({ where: { OR: [{ roughPieceId: { not: null } }, { polishedDiamondId: { not: null } }, { diamondJobId: { not: null } }] } });
  await prisma.polishedDiamond.deleteMany();
  await prisma.diamondJobPiece.deleteMany();
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

async function balance(code: string, partyId?: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const t = await prisma.journalEntry.aggregate({ where: { accountId: account.id, ...(partyId ? { partyId } : {}) }, _sum: { debit: true, credit: true } });
  return new Decimal(t._sum.debit ?? 0).minus(t._sum.credit ?? 0);
}
const payable = async (partyId: string) => (await balance("2000", partyId)).negated().toFixed(2);
async function unbalanced(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`
  );
  return rows[0].n;
}
/** Polished stock value: every Available stone + every packet's balance. */
async function polishedStock(): Promise<Decimal> {
  const stones = await prisma.polishedDiamond.findMany({ where: { status: "AVAILABLE" }, select: { allocatedCost: true } });
  const moves = await prisma.polishedPacketMovement.findMany({ select: { type: true, costValue: true } });
  const packetValue = moves.reduce((s, m) => (m.type.endsWith("_OUT") ? s.minus(m.costValue) : s.plus(m.costValue)), ZERO);
  return stones.reduce((s, x) => s.plus(x.allocatedCost), ZERO).plus(packetValue);
}
type Snap = { ledger: Decimal; stock: Decimal };
const snapshot = async (): Promise<Snap> => ({ ledger: await balance("1220"), stock: await polishedStock() });
/** Since the snapshot, 1220 moved by exactly what polished stock moved by. */
async function polishedLedgerTiesToStock(since: Snap) {
  const now = await snapshot();
  expect(now.ledger.minus(since.ledger).toFixed(2)).toBe(now.stock.minus(since.stock).toFixed(2));
  expect(await unbalanced()).toBe(0);
}

async function polishingReceipt(opts: { carat: string; cost: string; rate: number; outputs: { carat: string; pieceCount?: number }[]; key: string }) {
  const lot = await prisma.$transaction(
    (tx) =>
      createRoughLotWithPieces(tx, {
        ...FY, purchaseDate: DATE, supplierId, purchaseRate: 1, rateBasis: "FIXED_TOTAL", currencyCode: "INR", exchangeRate: 1,
        totalPurchaseCost: opts.cost, gstTreatment: "NONE", idempotencyKey: `${opts.key}-buy`, createdByUserId: ownerId, pieces: [{ carat: opts.carat }],
      }),
    TX
  );
  const piece = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
  const job = await prisma.$transaction(
    (tx) =>
      issueRoughToKarigar(tx, {
        ...FY, karigarId: manufacturerId, roughPieceIds: [piece.id], requiredShape: "ELONGATED_CUSHION", issueDate: DATE,
        processId: polishingId, chargeRateBasis: "PER_CARAT", chargeRate: opts.rate, idempotencyKey: `${opts.key}-issue`, createdByUserId: ownerId,
      }),
    TX
  );
  const { receipt } = await prisma.$transaction(
    (tx) =>
      receivePolishedDiamonds(tx, {
        ...FY, jobId: job.id, receiveDate: DATE, returnedRoughCarat: 0, labourCharge: 0, shape: "ELONGATED_CUSHION", markJobComplete: true,
        idempotencyKey: `${opts.key}-rec`, createdByUserId: ownerId,
        outputs: opts.outputs.map((o) =>
          o.pieceCount ? { kind: "PARCEL" as const, pieceCount: o.pieceCount, shape: "ELONGATED_CUSHION" as const, carat: o.carat } : { shape: "ELONGATED_CUSHION" as const, carat: o.carat }
        ),
      }),
    TX
  );
  return { job, receipt };
}

function post(receiptId: string, correctedLabour: string, key: string, expectedFingerprint?: string) {
  return prisma.$transaction(
    (tx) => postReceiptLabourCorrection(tx, { receiptId, correctedLabour, reason: REASON, idempotencyKey: key, expectedFingerprint, owner, ...FY }),
    TX
  );
}
function reverse(correctionId: string) {
  return prisma.$transaction((tx) => reverseReceiptLabourCorrection(tx, { correctionId, reason: "Entered the wrong corrected amount", owner, ...FY }), TX);
}
const packetOf = (receiptId: string) =>
  prisma.polishedPacket.findFirstOrThrow({ where: { sourceReceiptId: receiptId }, include: { movements: true } });

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  owner = { id: ownerId, role: "OWNER" };
  await clearData();
  const party = async (id: string, name: string, type: "SUPPLIER" | "MANUFACTURER") =>
    (await prisma.party.upsert({ where: { id }, create: { id, name, type, createdByUserId: ownerId }, update: {} })).id;
  supplierId = await party("lc-supplier", "Labour-Correction Supplier", "SUPPLIER");
  manufacturerId = await party("lc-manufacturer", "Dungarbhai Karkhanu (test)", "MANUFACTURER");
  polishingId = (await prisma.diamondProcess.findFirstOrThrow({ where: { outputKind: "POLISHED", isActive: true } })).id;
}, 60_000);

afterAll(async () => {
  await clearData();
});

describe("production's ZL-REC-2026-000003 corrected per issued carat", () => {
  let receiptId: string;
  let jobId: string;
  let base1220: Snap;
  let correctionId: string;

  it("reproduces the posted receipt: labour ₹4,327.35, parcel ₹20,627.10", async () => {
    base1220 = await snapshot();
    const { job, receipt } = await polishingReceipt({ carat: "10.190", cost: "16299.75", rate: 850, outputs: [{ carat: "5.091", pieceCount: 6 }], key: "lc-prod" });
    receiptId = receipt.id;
    jobId = job.id;
    expect(new Decimal(receipt.labourCharge).toFixed(2)).toBe("4327.35");
    expect(new Decimal((await packetOf(receiptId)).movements[0].costValue).toFixed(2)).toBe("20627.10");
    await polishedLedgerTiesToStock(base1220);
  });

  it("preview suggests ₹8,661.50 and shows +₹4,334.15 onto the parcel, writing nothing", async () => {
    const before = await prisma.correction.count();
    const built = await planReceiptLabour(prisma, { receiptId, correctedLabour: "8661.50", reason: REASON });
    expect(built.suggestion).toBe("8661.50");
    expect(built.previousLabour.toFixed(2)).toBe("4327.35");
    expect(built.added.toFixed(2)).toBe("4334.15");
    expect(built.lines).toEqual([expect.objectContaining({ kind: "PACKET", carat: "5.091", added: "4334.15", costBefore: "20627.10", costAfter: "24961.25" })]);
    expect(await prisma.correction.count()).toBe(before);
  });

  it("posts: CORRECTION voucher Dr 1220 / Cr Manufacturer ₹4,334.15; parcel ₹24,961.25; job labour ₹8,661.50; receipt row unchanged", async () => {
    const payableBefore = await payable(manufacturerId);
    const fp = labourPlanFingerprint((await planReceiptLabour(prisma, { receiptId, correctedLabour: "8661.50", reason: REASON })).plan);
    const result = await post(receiptId, "8661.50", "lc-prod-post-1", fp);
    expect(result.replayed).toBe(false);
    correctionId = result.correction.id;
    const correction = await prisma.correction.findUniqueOrThrow({ where: { id: correctionId }, include: { correctionVoucher: { include: { journalEntries: { include: { account: true } } } } } });
    expect(correction.mode).toBe("ADD_MANUFACTURER_LABOUR");
    expect(correction.state).toBe("POSTED");
    expect(correction.correctionVoucher!.voucherType).toBe("CORRECTION");
    const lines = correction.correctionVoucher!.journalEntries.map((e) => `${e.account.code}|${new Decimal(e.debit).toFixed(2)}|${new Decimal(e.credit).toFixed(2)}|${e.partyId ?? ""}`).sort();
    expect(lines).toEqual(["1220|4334.15|0.00|", `2000|0.00|4334.15|${manufacturerId}`].sort());
    expect(new Decimal((await packetOf(receiptId)).movements[0].costValue).toFixed(2)).toBe("24961.25");
    expect(new Decimal((await prisma.diamondJob.findUniqueOrThrow({ where: { id: jobId } })).totalLabourCharge).toFixed(2)).toBe("8661.50");
    expect(new Decimal((await prisma.polishedReceipt.findUniqueOrThrow({ where: { id: receiptId } })).labourCharge).toFixed(2)).toBe("4327.35");
    expect(new Decimal(await payable(manufacturerId)).minus(payableBefore).toFixed(2)).toBe("4334.15");
    await polishedLedgerTiesToStock(base1220);
  });

  it("a duplicate click replays the same correction; a second correction is refused", async () => {
    const vouchers = await prisma.voucher.count();
    const replay = await post(receiptId, "8661.50", "lc-prod-post-1");
    expect(replay.replayed).toBe(true);
    expect(await prisma.voucher.count()).toBe(vouchers);
    await expect(post(receiptId, "9000.00", "lc-prod-post-2")).rejects.toThrow(/already corrected/);
  });

  it("reverses exactly (parcel, job labour, payable back), once only; then it can be corrected again", async () => {
    const payableBefore = await payable(manufacturerId);
    await reverse(correctionId);
    expect(new Decimal((await packetOf(receiptId)).movements[0].costValue).toFixed(2)).toBe("20627.10");
    expect(new Decimal((await prisma.diamondJob.findUniqueOrThrow({ where: { id: jobId } })).totalLabourCharge).toFixed(2)).toBe("4327.35");
    expect(new Decimal(payableBefore).minus(await payable(manufacturerId)).toFixed(2)).toBe("4334.15");
    expect((await prisma.correction.findUniqueOrThrow({ where: { id: correctionId } })).state).toBe("REVERSED");
    await expect(reverse(correctionId)).rejects.toThrow(/already been reversed/);
    await polishedLedgerTiesToStock(base1220);
    const again = await post(receiptId, "8661.50", "lc-prod-post-3");
    expect(again.replayed).toBe(false);
    expect(new Decimal((await packetOf(receiptId)).movements[0].costValue).toFixed(2)).toBe("24961.25");
    await polishedLedgerTiesToStock(base1220);
  });
});

describe("refusals", () => {
  it("refuses a decrease, a bad amount and a short reason", async () => {
    const { receipt } = await polishingReceipt({ carat: "2.000", cost: "2000", rate: 100, outputs: [{ carat: "1.000", pieceCount: 3 }], key: "lc-ref" });
    await expect(post(receipt.id, "100.00", "lc-ref-1")).rejects.toThrow(/more than the ₹100.00 already posted/);
    await expect(post(receipt.id, "50", "lc-ref-2")).rejects.toThrow(/only additions/);
    await expect(post(receipt.id, "abc", "lc-ref-3")).rejects.toThrow(/amount in rupees/);
    await expect(
      prisma.$transaction((tx) => postReceiptLabourCorrection(tx, { receiptId: receipt.id, correctedLabour: "200", reason: "short", idempotencyKey: "lc-ref-4", owner, ...FY }), TX)
    ).rejects.toThrow(/at least 10 characters/);
  });

  it("refuses a stale preview", async () => {
    const { receipt } = await polishingReceipt({ carat: "2.000", cost: "2000", rate: 100, outputs: [{ carat: "1.000", pieceCount: 3 }], key: "lc-stale" });
    const fp = labourPlanFingerprint((await planReceiptLabour(prisma, { receiptId: receipt.id, correctedLabour: "200.00", reason: REASON })).plan);
    await expect(post(receipt.id, "250.00", "lc-stale-1", fp)).rejects.toThrow(/changed after this preview/);
  });

  it("refuses once an output has been used (e.g. part of the parcel issued)", async () => {
    const { receipt } = await polishingReceipt({ carat: "2.000", cost: "2000", rate: 100, outputs: [{ carat: "1.000", pieceCount: 3 }], key: "lc-used" });
    const packet = await packetOf(receipt.id);
    await prisma.polishedPacketMovement.create({
      data: { type: "JEWELLERY_ISSUE_OUT", packetId: packet.id, pieces: 1, carat: "0.300", costValue: "630.00", sourceDocument: "TEST", createdByUserId: ownerId },
    });
    await expect(planReceiptLabour(prisma, { receiptId: receipt.id, correctedLabour: "200.00", reason: REASON })).rejects.toBeInstanceOf(CorrectionError);
    await expect(planReceiptLabour(prisma, { receiptId: receipt.id, correctedLabour: "200.00", reason: REASON })).rejects.toThrow(/has been used since the receipt/);
    await prisma.polishedPacketMovement.deleteMany({ where: { packetId: packet.id, type: "JEWELLERY_ISSUE_OUT" } });
  });
});

describe("single-stone outputs", () => {
  it("spreads the addition by carat and updates each stone's cost per carat", async () => {
    const base = await snapshot();
    const { receipt } = await polishingReceipt({ carat: "8.000", cost: "8000", rate: 100, outputs: [{ carat: "1.000" }, { carat: "3.000" }], key: "lc-stones" });
    // received 4.000 @100 = 400 posted; per issued carat 8.000 @100 = 800 -> +400 split 100 / 300
    const built = await planReceiptLabour(prisma, { receiptId: receipt.id, correctedLabour: "800", reason: REASON });
    expect(built.suggestion).toBe("800.00");
    expect(built.lines.map((l) => l.added)).toEqual(["100.00", "300.00"]);
    await post(receipt.id, "800", "lc-stones-1");
    const stones = await prisma.polishedDiamond.findMany({ where: { receiptId: receipt.id }, orderBy: { carat: "asc" } });
    expect(stones.map((s) => new Decimal(s.allocatedCost).toFixed(2))).toEqual(["2200.00", "6600.00"]); // (8000+400)/4 × carat + share
    expect(stones.map((s) => new Decimal(s.costPerCarat).toFixed(2))).toEqual(["2200.00", "2200.00"]);
    await polishedLedgerTiesToStock(base);
  });
});
