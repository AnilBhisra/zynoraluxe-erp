/**
 * Real-database acceptance for the audited rough stone -> parcel conversion.
 *
 * Runs against the isolated test database only (refuses anything else).
 * Reproduces the reported record — 224.060 ct / ₹1,34,436 bought as ONE
 * stone — converts it, proves nothing but the classification changed (no
 * voucher, journal, payable, lot or movement change), then issues 100 ct of
 * it in part. Also every refusal, a stale preview, and a concurrent double
 * conversion.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { cancelDiamondJob, createRoughLotWithPieces, issueRoughToKarigar, overrideRoughPieceAllocations } from "./posting";
import { listRoughLots } from "./reports";
import { convertRoughStoneToParcel, previewRoughStoneToParcel } from "./roughParcelConversion";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-26T00:00:00.000Z");
const TX_OPTIONS = { timeout: 20_000, maxWait: 15_000 };
const REASON = "Saved as one stone by mistake; it is a parcel of many rough stones";

let ownerId: string;
let supplierId: string;
let manufacturerId: string;
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

async function accountBalance(code: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const totals = await prisma.journalEntry.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } });
  return new Decimal(totals._sum.debit ?? 0).minus(totals._sum.credit ?? 0);
}
const balances = async () => ({ rough: (await accountBalance("1200")).toFixed(2), wip: (await accountBalance("1210")).toFixed(2) });
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
/** Ledger vs stock: 1200 = cost of every Available rough row; 1210 = open-job WIP. */
async function reconcileAgainstStock() {
  const available = await prisma.roughPiece.findMany({ where: { status: "AVAILABLE" }, select: { allocatedCost: true } });
  const availableValue = available.reduce((s, p) => s.plus(p.allocatedCost), ZERO);
  const openJobs = await prisma.diamondJob.findMany({ where: { status: { in: ["ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"] } }, select: { remainingWipCost: true } });
  const wipValue = openJobs.reduce((s, j) => s.plus(j.remainingWipCost), ZERO);
  const now = await balances();
  expect(new Decimal(now.rough).minus(baseline.rough).toFixed(2)).toBe(availableValue.toFixed(2));
  expect(new Decimal(now.wip).minus(baseline.wip).toFixed(2)).toBe(wipValue.toFixed(2));
  expect(await unbalancedVouchers()).toBe(0);
}

function buy(pieces: { carat: string; kind?: "STONE" | "PARCEL"; pieceCount?: number | null }[], cost: string, key: string) {
  return prisma.$transaction(
    (tx) =>
      createRoughLotWithPieces(tx, {
        ...FY,
        purchaseDate: DATE,
        supplierId,
        purchaseRate: 600,
        rateBasis: "PER_CARAT",
        currencyCode: "INR",
        exchangeRate: 1,
        totalPurchaseCost: cost,
        gstTreatment: "NONE",
        idempotencyKey: key,
        createdByUserId: ownerId,
        pieces: pieces.map((p) => ({ kind: p.kind ?? "STONE", pieceCount: p.pieceCount ?? null, carat: p.carat })),
      }),
    TX_OPTIONS
  );
}
const piecesOf = (lotId: string) => prisma.roughPiece.findMany({ where: { lotId, parentPieceId: null }, orderBy: { roughCode: "asc" } });

function convert(roughPieceId: string, opts: { reason?: string; pieceCount?: number | null; expectedCarat: string; expectedCost: string }) {
  return prisma.$transaction(
    (tx) =>
      convertRoughStoneToParcel(tx, {
        roughPieceId,
        pieceCount: opts.pieceCount ?? null,
        reason: opts.reason ?? REASON,
        expectedCarat: opts.expectedCarat,
        expectedCost: opts.expectedCost,
        convertedByUserId: ownerId,
      }),
    TX_OPTIONS
  );
}
function issueWhole(pieceId: string, key: string) {
  return prisma.$transaction(
    (tx) => issueRoughToKarigar(tx, { ...FY, karigarId: manufacturerId, roughPieceIds: [pieceId], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key, createdByUserId: ownerId }),
    TX_OPTIONS
  );
}
function issuePart(pieceId: string, carat: string, key: string) {
  return prisma.$transaction(
    (tx) =>
      issueRoughToKarigar(tx, {
        ...FY,
        karigarId: manufacturerId,
        parcelIssues: [{ roughPieceId: pieceId, carat }],
        requiredShape: "ROUND",
        issueDate: DATE,
        idempotencyKey: key,
        createdByUserId: ownerId,
      }),
    TX_OPTIONS
  );
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>(
    "select current_database() db, current_user usr, inet_server_port() port"
  );
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearDiamondData();
  baseline = await balances();
  const party = async (id: string, name: string, type: "SUPPLIER" | "MANUFACTURER") =>
    (await prisma.party.upsert({ where: { id }, create: { id, name, type, createdByUserId: ownerId }, update: {} })).id;
  supplierId = await party("conv-test-supplier", "Conversion Test Supplier", "SUPPLIER");
  manufacturerId = await party("conv-test-manufacturer", "Conversion Test Manufacturer", "MANUFACTURER");
}, 60_000);

afterAll(async () => {
  await clearDiamondData();
});

describe("the reported record: 224.060 ct / ₹1,34,436 bought as ONE stone", () => {
  let lotId: string;
  let pieceId: string;

  it("is recorded as a Stone that can only be issued whole (the reported mistake)", async () => {
    const lot = await buy([{ carat: "224.060" }], "134436", "conv-reported");
    lotId = lot.id;
    const [piece] = await piecesOf(lotId);
    pieceId = piece.id;
    expect(piece.kind).toBe("STONE");
    expect(new Decimal(piece.carat).toFixed(3)).toBe("224.060");
    expect(new Decimal(piece.allocatedCost).toFixed(2)).toBe("134436.00");
    await expect(issuePart(pieceId, "100.000", "conv-too-early")).rejects.toThrow();
  });

  it("preview shows the real record, eligible, and changes nothing", async () => {
    const before = await prisma.roughPiece.findUniqueOrThrow({ where: { id: pieceId } });
    const lot = await prisma.roughLot.findUniqueOrThrow({ where: { id: lotId }, include: { voucher: true } });
    const p = await previewRoughStoneToParcel(prisma, pieceId);
    expect(p).toMatchObject({
      roughCode: before.roughCode,
      lotCode: lot.lotCode,
      supplierName: "Conversion Test Supplier",
      purchaseVoucherNumber: lot.voucher!.voucherNumber,
      kind: "STONE",
      status: "AVAILABLE",
      carat: "224.060",
      allocatedCost: "134436.00",
      issueHistory: [],
      purchaseMovements: 1,
      refusal: null,
    });
    expect(await prisma.roughPiece.findUniqueOrThrow({ where: { id: pieceId } })).toEqual(before);
  });

  it("converts in place: same row, carat and cost; no voucher, journal, payable, lot or movement change", async () => {
    const lotBefore = await prisma.roughLot.findUniqueOrThrow({ where: { id: lotId } });
    const movementsBefore = await prisma.stockMovement.findMany({ where: { roughPieceId: pieceId } });
    const [vouchersBefore, journalsBefore, payableBefore, ledgerBefore, piecesBefore] = await Promise.all([
      prisma.voucher.count(),
      prisma.journalEntry.count(),
      payable(supplierId),
      balances(),
      prisma.roughPiece.count(),
    ]);

    const converted = await convert(pieceId, { expectedCarat: "224.060", expectedCost: "134436.00" });

    expect(converted.id).toBe(pieceId);
    expect(converted.kind).toBe("PARCEL");
    expect(new Decimal(converted.carat).toFixed(3)).toBe("224.060");
    expect(new Decimal(converted.allocatedCost).toFixed(2)).toBe("134436.00");
    expect(new Decimal(converted.originalCarat!).toFixed(3)).toBe("224.060");
    expect(new Decimal(converted.originalCost!).toFixed(2)).toBe("134436.00");
    expect(converted.pieceCount).toBeNull();
    expect(converted.originalPieceCount).toBeNull();
    expect(converted.status).toBe("AVAILABLE");
    expect(converted.lotId).toBe(lotId);
    expect(converted.convertedToParcelByUserId).toBe(ownerId);
    expect(converted.convertedToParcelReason).toBe(REASON);
    expect(converted.convertedToParcelAt).toBeInstanceOf(Date);

    expect(await prisma.voucher.count()).toBe(vouchersBefore);
    expect(await prisma.journalEntry.count()).toBe(journalsBefore);
    expect(await payable(supplierId)).toBe(payableBefore);
    expect(await balances()).toEqual(ledgerBefore);
    expect(await prisma.roughPiece.count()).toBe(piecesBefore);
    expect(await prisma.roughLot.findUniqueOrThrow({ where: { id: lotId } })).toEqual(lotBefore);
    expect(await prisma.stockMovement.findMany({ where: { roughPieceId: pieceId } })).toEqual(movementsBefore);
    expect(payableBefore).toBe("134436.00");
    await reconcileAgainstStock();
  });

  it("shows on the rough stock list as a Parcel with the audit note", async () => {
    const lot = (await listRoughLots()).find((l) => l.id === lotId)!;
    expect(lot.totalRoughCarat.toFixed(3)).toBe("224.060");
    expect(lot.totalPurchaseCost.toFixed(2)).toBe("134436.00");
    expect(lot.piecesCount).toBe(1);
    const row = lot.pieces.find((p) => p.id === pieceId)!;
    expect(row.kind).toBe("PARCEL");
    expect(row.convertedToParcel).toMatchObject({ reason: REASON });
    expect(row.convertedToParcel!.byName).toBeTruthy();
  });

  it("refuses a second conversion, and the preview says why", async () => {
    await expect(convert(pieceId, { expectedCarat: "224.060", expectedCost: "134436.00" })).rejects.toThrow(/already converted to a parcel/);
    expect((await previewRoughStoneToParcel(prisma, pieceId)).refusal).toMatch(/already converted to a parcel/);
  });

  it("now issues in part: 100 ct out at ₹60,000.00, 124.060 ct / ₹74,436.00 stays in stock", async () => {
    await issuePart(pieceId, "100.000", "conv-partial-100");
    const parcel = await prisma.roughPiece.findUniqueOrThrow({ where: { id: pieceId } });
    expect(new Decimal(parcel.carat).toFixed(3)).toBe("124.060");
    expect(new Decimal(parcel.allocatedCost).toFixed(2)).toBe("74436.00");
    expect(parcel.status).toBe("AVAILABLE");
    const [portion] = await prisma.roughPiece.findMany({ where: { parentPieceId: pieceId } });
    expect(new Decimal(portion.carat).toFixed(3)).toBe("100.000");
    expect(new Decimal(portion.allocatedCost).toFixed(2)).toBe("60000.00");
    expect(portion.status).toBe("WITH_KARIGAR");
    // the as-bought snapshot and the audit trail survive the issue
    expect(new Decimal(parcel.originalCarat!).toFixed(3)).toBe("224.060");
    expect(parcel.convertedToParcelReason).toBe(REASON);
    expect(await payable(supplierId)).toBe("134436.00");
    await reconcileAgainstStock();
  });
});

describe("refused states — nothing changes", () => {
  it("rejects a short reason and a stone count of 1", async () => {
    const lot = await buy([{ carat: "10.000" }], "6000", "conv-validation");
    const [piece] = await piecesOf(lot.id);
    await expect(convert(piece.id, { reason: "mistake", expectedCarat: "10.000", expectedCost: "6000.00" })).rejects.toThrow(/at least 10 characters/);
    await expect(convert(piece.id, { pieceCount: 1, expectedCarat: "10.000", expectedCost: "6000.00" })).rejects.toThrow(/at least 2/);
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: piece.id } })).kind).toBe("STONE");
    const counted = await convert(piece.id, { pieceCount: 250, expectedCarat: "10.000", expectedCost: "6000.00" });
    expect(counted.pieceCount).toBe(250);
    expect(counted.originalPieceCount).toBe(250);
  });

  it("refuses a parcel that was bought as a parcel", async () => {
    const lot = await buy([{ carat: "50.000", kind: "PARCEL", pieceCount: 90 }], "30000", "conv-real-parcel");
    const [piece] = await piecesOf(lot.id);
    await expect(convert(piece.id, { expectedCarat: "50.000", expectedCost: "30000.00" })).rejects.toThrow(/already a parcel/);
  });

  it("refuses a stone that is with a Manufacturer", async () => {
    const lot = await buy([{ carat: "20.000" }], "12000", "conv-issued");
    const [piece] = await piecesOf(lot.id);
    await issueWhole(piece.id, "conv-issued-job");
    await expect(convert(piece.id, { expectedCarat: "20.000", expectedCost: "12000.00" })).rejects.toThrow(/with a Manufacturer/);
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: piece.id } })).kind).toBe("STONE");
  });

  it("refuses a stone issued once and cancelled back to Available (it has issue history)", async () => {
    const lot = await buy([{ carat: "30.000" }], "18000", "conv-cancelled");
    const [piece] = await piecesOf(lot.id);
    const job = await issueWhole(piece.id, "conv-cancelled-job");
    await prisma.$transaction(
      (tx) => cancelDiamondJob(tx, { ...FY, jobId: job.id, cancelledByUserId: ownerId, cancellationReason: "Conversion test cancellation" }),
      TX_OPTIONS
    );
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: piece.id } })).status).toBe("AVAILABLE");
    await expect(convert(piece.id, { expectedCarat: "30.000", expectedCost: "18000.00" })).rejects.toThrow(/already been issued/);
    expect((await previewRoughStoneToParcel(prisma, piece.id)).refusal).toMatch(new RegExp(job.jobCode));
  });

  it("refuses a stone that was not bought on a purchase lot", async () => {
    const orphan = await prisma.roughPiece.create({
      data: { roughCode: "ZL-RGH-TEST-NOLOT", carat: "5.000", allocatedCost: "1000.00", createdByUserId: ownerId },
    });
    try {
      await expect(convert(orphan.id, { expectedCarat: "5.000", expectedCost: "1000.00" })).rejects.toThrow(/not bought on a rough purchase/);
    } finally {
      await prisma.roughPiece.delete({ where: { id: orphan.id } });
    }
  });

  it("refuses when the stone changed after the preview (stale preview)", async () => {
    const lot = await buy([{ carat: "10.000" }, { carat: "10.000" }], "12000", "conv-stale");
    const [a, b] = await piecesOf(lot.id);
    const preview = await previewRoughStoneToParcel(prisma, a.id);
    expect(preview.allocatedCost).toBe("6000.00");
    await prisma.$transaction((tx) =>
      overrideRoughPieceAllocations(tx, {
        lotId: lot.id,
        reason: "Owner re-split the lot cost",
        adjustments: [
          { pieceId: a.id, newAllocatedCost: "7000" },
          { pieceId: b.id, newAllocatedCost: "5000" },
        ],
      })
    );
    await expect(convert(a.id, { expectedCarat: preview.carat, expectedCost: preview.allocatedCost })).rejects.toThrow(/changed since the preview/);
    expect((await prisma.roughPiece.findUniqueOrThrow({ where: { id: a.id } })).kind).toBe("STONE");
  });

  it("two simultaneous conversions: exactly one succeeds, the other is refused", async () => {
    const lot = await buy([{ carat: "40.000" }], "24000", "conv-race");
    const [piece] = await piecesOf(lot.id);
    const results = await Promise.allSettled([
      convert(piece.id, { expectedCarat: "40.000", expectedCost: "24000.00" }),
      convert(piece.id, { expectedCarat: "40.000", expectedCost: "24000.00" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already converted to a parcel/);
    await reconcileAgainstStock();
  });
});
