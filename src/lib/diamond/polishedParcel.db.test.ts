/**
 * Real-database acceptance for polished PARCELS: a manufacturing receipt can
 * record many stones as a parcel (a packet), a Jewellery Job can take part of
 * it, and an Owner can convert an existing single-stone record that really is
 * a parcel — all audited, exact to the paisa, without duplicate or concurrent
 * over-issue. Isolated test database only (this file refuses anything else).
 *
 * Headline figure: ₹90,000 across 35 ct -> issue 10 ct = ₹25,714.29 and the
 * remaining 25 ct = ₹64,285.71.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { sumPacketMovements } from "@/lib/diamond/packets";
import {
  createRoughLotWithPieces,
  issueRoughToKarigar,
  overridePolishedAllocations,
  receivePolishedDiamonds,
  type PolishedOutputDraft,
} from "@/lib/diamond/posting";
import { convertPolishedDiamondToParcel } from "@/lib/diamond/polishedParcelConversion";
import { listPolishedPackets } from "@/lib/diamond/packetReports";
import { listPolishedDiamonds } from "@/lib/diamond/reports";
import {
  cancelJewelleryJob,
  createJewelleryJob,
  issueMaterialsToJewelleryJob,
  postOpeningMetalStock,
  receiveFinishedJewellery,
} from "@/lib/jewellery/posting";
import { CLEAR_BUSINESS_DATA_SQL } from "../../../test/setup/businessTables";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-25T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let supplierId: string;
let manufacturerId: string;
let karigarId: string;
let purityId: string;
let baseline1220: string;
let seq = 0;
const key = (label: string) => `pp-${label}-${Date.now()}-${++seq}`;

async function clearAll() {
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}

beforeAll(async () => {
  const [{ db, usr }] = await prisma.$queryRawUnsafe<{ db: string; usr: string }[]>("select current_database() db, current_user usr");
  if (db !== "zynoraluxe_phase7_test" || usr !== "zynoraluxe_phase7_user") {
    throw new Error(`refusing to run against ${db}/${usr}; the isolated test database is required`);
  }
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearAll();

  const party = async (id: string, name: string, type: "SUPPLIER" | "MANUFACTURER" | "KARIGAR") =>
    (await prisma.party.upsert({ where: { id }, create: { id, name, type, createdByUserId: ownerId }, update: {} })).id;
  supplierId = await party("pp-supplier", "Polished Parcel Supplier", "SUPPLIER");
  manufacturerId = await party("pp-manufacturer", "Polished Parcel Manufacturer", "MANUFACTURER");
  karigarId = await party("pp-karigar", "Polished Parcel Karigar", "KARIGAR");

  purityId = (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType: "GOLD", displayName: "Polished Parcel Karat" } },
      create: { metalType: "GOLD", displayName: "Polished Parcel Karat", finenessPercent: "91.600", createdByUserId: ownerId },
      update: { finenessPercent: "91.600" },
    })
  ).id;
  await prisma.$transaction(
    (tx) =>
      postOpeningMetalStock(tx, {
        metalType: "GOLD",
        purityId,
        grossWeight: "500.000",
        costValue: "500000.00",
        idempotencyKey: key("opening-metal"),
        ...FY,
        createdByUserId: ownerId,
      }),
    TX
  );
  baseline1220 = (await accountBalance("1220")).toFixed(2);
}, 90_000);

afterAll(async () => {
  await clearAll();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function accountBalance(code: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const totals = await prisma.journalEntry.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } });
  return new Decimal(totals._sum.debit ?? 0).minus(totals._sum.credit ?? 0);
}
async function unbalancedVouchers(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`
  );
  return rows[0].n;
}
async function packetBalance(packetId: string) {
  const movements = await prisma.polishedPacketMovement.findMany({ where: { packetId } });
  return sumPacketMovements(movements.map((m) => ({ type: m.type, pieces: m.pieces, carat: m.carat.toFixed(3), costValue: m.costValue.toFixed(2) })));
}

/** 1220 must equal Available single stones + every packet's live balance — no value created or lost. */
async function reconcile1220() {
  const stones = await prisma.polishedDiamond.findMany({ where: { status: "AVAILABLE" }, select: { allocatedCost: true } });
  const stoneValue = stones.reduce((s, d) => s.plus(d.allocatedCost), ZERO);
  const packets = await prisma.polishedPacket.findMany({ select: { id: true } });
  let packetValue = ZERO;
  for (const p of packets) packetValue = packetValue.plus((await packetBalance(p.id)).costValue);
  const now = await accountBalance("1220");
  expect(now.minus(baseline1220).toFixed(2)).toBe(stoneValue.plus(packetValue).toFixed(2));
  expect(await unbalancedVouchers()).toBe(0);
}

/**
 * Rough -> Manufacturer -> polished receipt, through the real engines.
 * ₹80,000 of rough + `labour` charges, one final receipt: every rupee ends up
 * on the outputs (loss is absorbed, never booked separately).
 */
async function manufacture(opts: { outputs: PolishedOutputDraft[]; labour: number; roughCarat?: string; roughCost?: string }) {
  const lot = await prisma.$transaction(
    (tx) =>
      createRoughLotWithPieces(tx, {
        ...FY,
        purchaseDate: DATE,
        supplierId,
        purchaseRate: 800,
        rateBasis: "PER_CARAT",
        currencyCode: "INR",
        exchangeRate: 1,
        totalPurchaseCost: opts.roughCost ?? "80000.00",
        gstTreatment: "NONE",
        idempotencyKey: key("rough"),
        createdByUserId: ownerId,
        pieces: [{ carat: opts.roughCarat ?? "100.000" }],
      }),
    TX
  );
  const piece = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
  const job = await prisma.$transaction(
    (tx) =>
      issueRoughToKarigar(tx, {
        ...FY,
        karigarId: manufacturerId,
        roughPieceIds: [piece.id],
        requiredShape: "ROUND",
        issueDate: DATE,
        idempotencyKey: key("rough-issue"),
        createdByUserId: ownerId,
      }),
    TX
  );
  const received = await prisma.$transaction(
    (tx) =>
      receivePolishedDiamonds(tx, {
        ...FY,
        jobId: job.id,
        receiveDate: DATE,
        returnedRoughCarat: 0,
        labourCharge: opts.labour,
        shape: "ROUND",
        markJobComplete: true,
        idempotencyKey: key("polished-receipt"),
        createdByUserId: ownerId,
        outputs: opts.outputs,
      }),
    TX
  );
  return { lot, job, receipt: received.receipt, stones: received.outputs, parcels: received.parcels };
}

/** A parcel of 140 stones, 35 ct, costing exactly ₹90,000 (₹80,000 rough + ₹10,000 labour). */
const parcelOutput: PolishedOutputDraft = { kind: "PARCEL", pieceCount: 140, sizeLabel: "1.5 mm", shape: "ROUND", carat: "35.000", color: "F", clarity: "VS" };

async function draftJewelleryJob(name: string) {
  return prisma.$transaction(
    (tx) =>
      createJewelleryJob(tx, {
        jewelleryType: "RING",
        designName: name,
        karigarId,
        issueDate: DATE,
        quantity: 1,
        createdByUserId: ownerId,
        idempotencyKey: key("jjob"),
      }),
    TX
  );
}
function issueToJob(jobId: string, packetLines: { packetId: string; pieces: number; carat: string }[], k = key("jissue")) {
  return prisma.$transaction(
    (tx) =>
      issueMaterialsToJewelleryJob(tx, {
        ...FY,
        jobId,
        issueDate: DATE,
        metalLines: [{ metalType: "GOLD", purityId, grossWeight: "10.000" }],
        polishedDiamondIds: [],
        packetLines,
        otherMaterialLines: [],
        idempotencyKey: k,
        createdByUserId: ownerId,
      }),
    TX
  );
}

// ---------------------------------------------------------------------------
// 1. Manufacturing receipt: single stone vs parcel, with lineage
// ---------------------------------------------------------------------------
describe("manufacturing receipt: a parcel is recorded as a parcel, a single stone stays a single stone", () => {
  it("a 35 ct / 140-stone parcel becomes ONE packet worth ₹90,000 — no ZL-POL row — with job, receipt and rough-lot lineage", async () => {
    const before = (await accountBalance("1220")).toFixed(2);
    const made = await manufacture({ outputs: [parcelOutput], labour: 10000 });

    expect(made.stones).toHaveLength(0);
    expect(made.parcels).toHaveLength(1);
    const packet = await prisma.polishedPacket.findUniqueOrThrow({ where: { id: made.parcels[0].id } });
    expect(packet.provenance).toBe("MANUFACTURED_FROM_ROUGH");
    expect(packet.sourceDiamondJobId).toBe(made.job.id);
    expect(packet.sourceReceiptId).toBe(made.receipt.id);
    expect(packet.convertedFromPolishedDiamondId).toBeNull();
    expect(packet.sizeLabel).toBe("1.5 mm");

    const balance = await packetBalance(packet.id);
    expect(balance).toEqual({ pieces: 140, carat: "35.000", costValue: "90000.00" });
    expect(await prisma.polishedDiamond.count({ where: { jobId: made.job.id } })).toBe(0);
    expect(made.receipt.polishedCount).toBe(140); // stones, not rows

    // The accounting is the ordinary receipt voucher: Dr 1220 for the whole ₹90,000.
    expect((await accountBalance("1220")).minus(before).toFixed(2)).toBe("90000.00");
    const [movement] = await prisma.polishedPacketMovement.findMany({ where: { packetId: packet.id } });
    expect(movement.type).toBe("MANUFACTURE_IN");
    expect(movement.sourceDocument).toBe(made.receipt.receiptCode);

    // Lineage all the way back to the purchase, as the Owner sees it.
    const [row] = (await listPolishedPackets()).filter((p) => p.id === packet.id);
    expect(row.sourceJobCode).toBe(made.job.jobCode);
    expect(row.sourceReceiptCode).toBe(made.receipt.receiptCode);
    expect(row.sourceLotCodes).toEqual([made.lot.lotCode]);
    expect(row.pieces).toBe(140);
    expect(row.carat).toBe("35.000");
    expect(row.costValue).toBe("90000.00");

    // The Manufacturer job's own stock timeline still records the receipt.
    const timeline = await prisma.stockMovement.findMany({ where: { diamondJobId: made.job.id, type: "POLISHED_RECEIVE_IN" } });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].pieces).toBe(140);
    expect(timeline[0].costValue.toFixed(2)).toBe("90000.00");
    await reconcile1220();
  });

  it("a single stone in the same receipt stays a ZL-POL row, and only the parcel becomes a packet", async () => {
    const made = await manufacture({
      outputs: [{ kind: "STONE", shape: "ROUND", carat: "5.000" }, { ...parcelOutput, carat: "30.000", pieceCount: 90 }],
      labour: 10000,
    });
    expect(made.stones).toHaveLength(1);
    expect(made.parcels).toHaveLength(1);
    expect(made.stones[0].polishedCode).toMatch(/^ZL-POL-/);
    // Costs split by carat across BOTH outputs: 90,000 * 5/35 and * 30/35.
    expect(made.stones[0].allocatedCost.toFixed(2)).toBe("12857.14");
    expect((await packetBalance(made.parcels[0].id)).costValue).toBe("77142.86");
    expect(new Decimal(made.stones[0].allocatedCost).plus("77142.86").toFixed(2)).toBe("90000.00");
    expect(made.receipt.polishedCount).toBe(91); // 1 stone + 90 in the parcel
    await reconcile1220();
  });

  it("refuses a parcel without a stone count, a stone with a count, a 1-stone parcel, and a certified parcel — nothing is saved", async () => {
    const before = await prisma.polishedReceipt.count();
    const attempt = (output: PolishedOutputDraft) => manufacture({ outputs: [output], labour: 0 });
    await expect(attempt({ kind: "PARCEL", shape: "ROUND", carat: "35.000" })).rejects.toThrow(/enter how many stones/);
    await expect(attempt({ kind: "PARCEL", pieceCount: 1, shape: "ROUND", carat: "35.000" })).rejects.toThrow(/at least 2/);
    await expect(attempt({ kind: "STONE", pieceCount: 10, shape: "ROUND", carat: "35.000" })).rejects.toThrow(/single stone/);
    await expect(
      attempt({ kind: "PARCEL", pieceCount: 10, shape: "ROUND", carat: "35.000", certificateStatus: "CERTIFIED", certNumber: "C1" })
    ).rejects.toThrow(/cannot carry a certificate/);
    expect(await prisma.polishedReceipt.count()).toBe(before);
    expect(await prisma.polishedPacket.count({ where: { sizeLabel: "Unsized", provenance: "MANUFACTURED_FROM_ROUGH" } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. THE requirement: 10 ct from a 35 ct / ₹90,000 parcel
// ---------------------------------------------------------------------------
describe("issue 10 ct of a 35 ct / ₹90,000 parcel to a Jewellery Job", () => {
  let packetId: string;
  let jobAId: string;

  it("10 ct carries ₹25,714.29 and the remaining 25 ct carries ₹64,285.71 (sums to ₹90,000.00)", async () => {
    const made = await manufacture({ outputs: [parcelOutput], labour: 10000 });
    packetId = made.parcels[0].id;
    const before1220 = await accountBalance("1220");

    const job = await draftJewelleryJob("Parcel ring A");
    jobAId = job.id;
    await issueToJob(job.id, [{ packetId, pieces: 40, carat: "10.000" }]);

    const line = await prisma.jewelleryPacketIssueLine.findFirstOrThrow({ where: { jobId: job.id, packetId } });
    expect(line.piecesAtIssue).toBe(40);
    expect(line.caratAtIssue.toFixed(3)).toBe("10.000");
    expect(line.costAtIssue.toFixed(2)).toBe("25714.29");

    const balance = await packetBalance(packetId);
    expect(balance).toEqual({ pieces: 100, carat: "25.000", costValue: "64285.71" });
    expect(new Decimal(line.costAtIssue).plus(balance.costValue).toFixed(2)).toBe("90000.00");

    // 1220 gave up exactly the issued ₹25,714.29; the WIP voucher balances.
    expect(before1220.minus(await accountBalance("1220")).toFixed(2)).toBe("25714.29");
    await reconcile1220();
  });

  it("refuses over-issue, zero, and any issue that would strand carat without stones (or stones without carat)", async () => {
    const job = await draftJewelleryJob("Parcel ring refusals");
    const before = await packetBalance(packetId);
    const attempt = (pieces: number, carat: string) => issueToJob(job.id, [{ packetId, pieces, carat }]);
    await expect(attempt(10, "25.001")).rejects.toThrow(/more than this packet still holds/);
    await expect(attempt(101, "5.000")).rejects.toThrow(/Only 100 piece/);
    await expect(attempt(0, "0.000")).rejects.toThrow();
    await expect(attempt(100, "5.000")).rejects.toThrow(/Taking every piece must also take every carat/);
    await expect(attempt(5, "25.000")).rejects.toThrow(/Taking every carat must also take every piece/);
    expect(await packetBalance(packetId)).toEqual(before);
    await prisma.$transaction((tx) => cancelJewelleryJob(tx, { ...FY, jobId: job.id, cancelledByUserId: ownerId, cancellationReason: "test cleanup" }), TX);
  });

  it("receipt: 6 ct is SET into the finished piece, 4 ct unused is RETURNED — quantities and costs land exactly", async () => {
    const before1220 = await accountBalance("1220");
    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY,
          jobId: jobAId,
          receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [],
          packetResolutions: [
            { packetId, resolution: "SET", pieces: 24, carat: "6.000", setInOutputIndex: 0 },
            { packetId, resolution: "RETURNED", pieces: 16, carat: "4.000" },
          ],
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
          damagedLostByUserId: ownerId,
          idempotencyKey: key("jreceipt"),
          createdByUserId: ownerId,
        }),
      TX
    );

    const line = await prisma.jewelleryPacketIssueLine.findFirstOrThrow({ where: { jobId: jobAId, packetId } });
    // SET 6/10 of ₹25,714.29 = ₹15,428.57; RETURNED drains the line: the exact remainder ₹10,285.72.
    expect(line.setPieces).toBe(24);
    expect(line.setCarat.toFixed(3)).toBe("6.000");
    expect(line.setCost.toFixed(2)).toBe("15428.57");
    expect(line.returnedPieces).toBe(16);
    expect(line.returnedCarat.toFixed(3)).toBe("4.000");
    expect(line.returnedCost.toFixed(2)).toBe("10285.72");
    expect(new Decimal(line.setCost).plus(line.returnedCost).toFixed(2)).toBe("25714.29"); // nothing lost, nothing duplicated

    // The unused 4 ct come back to the SAME packet at their exact cost.
    expect(await packetBalance(packetId)).toEqual({ pieces: 116, carat: "29.000", costValue: "74571.43" });
    expect((await accountBalance("1220")).minus(before1220).toFixed(2)).toBe("10285.72");

    // The finished piece carries the SET stones' cost.
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: jobAId } });
    expect(piece.diamondCost.toFixed(2)).toBe("15428.57");
    await reconcile1220();
  });

  it("cancelling a job before its receipt restores exactly the issued quantity and cost, once", async () => {
    const before = await packetBalance(packetId);
    const before1220 = await accountBalance("1220");
    const job = await draftJewelleryJob("Parcel ring cancel");
    await issueToJob(job.id, [{ packetId, pieces: 40, carat: "10.000" }]);
    // At the packet's CURRENT balance (116 pcs / 29 ct / ₹74,571.43): 10/29 -> ₹25,714.29.
    const line = await prisma.jewelleryPacketIssueLine.findFirstOrThrow({ where: { jobId: job.id, packetId } });
    expect(line.costAtIssue.toFixed(2)).toBe("25714.29");
    expect(await packetBalance(packetId)).toEqual({ pieces: 76, carat: "19.000", costValue: "48857.14" });

    await prisma.$transaction((tx) => cancelJewelleryJob(tx, { ...FY, jobId: job.id, cancelledByUserId: ownerId, cancellationReason: "cancelled before receipt" }), TX);
    expect(await packetBalance(packetId)).toEqual(before);
    expect((await accountBalance("1220")).toFixed(2)).toBe(before1220.toFixed(2));

    // A second cancel restores nothing more.
    await expect(
      prisma.$transaction((tx) => cancelJewelleryJob(tx, { ...FY, jobId: job.id, cancelledByUserId: ownerId, cancellationReason: "again" }), TX)
    ).rejects.toThrow(/already been cancelled/);
    expect(await packetBalance(packetId)).toEqual(before);
    await reconcile1220();
  });
});

// ---------------------------------------------------------------------------
// 3. Concurrency and duplicates
// ---------------------------------------------------------------------------
describe("no duplicate or concurrent over-issue", () => {
  it("two Jewellery Jobs issuing 15 ct each from a 25 ct parcel at once: exactly one wins, the parcel is never overdrawn", async () => {
    const made = await manufacture({ outputs: [parcelOutput], labour: 10000 });
    const packetId = made.parcels[0].id;
    // Take 10 ct first so 25 ct / 100 pieces remain.
    const first = await draftJewelleryJob("conc seed");
    await issueToJob(first.id, [{ packetId, pieces: 40, carat: "10.000" }]);

    const a = await draftJewelleryJob("conc A");
    const b = await draftJewelleryJob("conc B");
    const results = await Promise.allSettled([
      issueToJob(a.id, [{ packetId, pieces: 60, carat: "15.000" }]),
      issueToJob(b.id, [{ packetId, pieces: 60, carat: "15.000" }]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(String(rejected[0].reason.message)).toMatch(/more than this packet still holds|Only \d+ piece/);
    const balance = await packetBalance(packetId);
    expect(balance.pieces).toBe(40);
    expect(balance.carat).toBe("10.000");
    expect(new Decimal(balance.costValue).greaterThanOrEqualTo(0)).toBe(true);
    await reconcile1220();
  }, 90_000);

  it("the same Jewellery Job submitted twice at once (double click) issues the parcel ONCE", async () => {
    const made = await manufacture({ outputs: [parcelOutput], labour: 10000 });
    const packetId = made.parcels[0].id;
    const job = await draftJewelleryJob("double click");
    const k = key("dup");
    const results = await Promise.allSettled([
      issueToJob(job.id, [{ packetId, pieces: 40, carat: "10.000" }], k),
      issueToJob(job.id, [{ packetId, pieces: 40, carat: "10.000" }], k),
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const lines = await prisma.jewelleryPacketIssueLine.count({ where: { jobId: job.id } });
    expect(lines).toBe(1);
    expect(await packetBalance(packetId)).toEqual({ pieces: 100, carat: "25.000", costValue: "64285.71" });
    await reconcile1220();
  }, 60_000);

  it("a duplicate manufacturing receipt cannot create the parcel twice", async () => {
    const lot = await prisma.$transaction(
      (tx) =>
        createRoughLotWithPieces(tx, {
          ...FY, purchaseDate: DATE, supplierId, purchaseRate: 800, rateBasis: "PER_CARAT", currencyCode: "INR", exchangeRate: 1,
          totalPurchaseCost: "80000.00", gstTreatment: "NONE", idempotencyKey: key("rough-dup"), createdByUserId: ownerId, pieces: [{ carat: "100.000" }],
        }),
      TX
    );
    const piece = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
    const job = await prisma.$transaction(
      (tx) => issueRoughToKarigar(tx, { ...FY, karigarId: manufacturerId, roughPieceIds: [piece.id], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key("rough-dup-issue"), createdByUserId: ownerId }),
      TX
    );
    const k = key("receipt-dup");
    const receive = () =>
      prisma.$transaction(
        (tx) =>
          receivePolishedDiamonds(tx, {
            ...FY, jobId: job.id, receiveDate: DATE, returnedRoughCarat: 0, labourCharge: 10000, shape: "ROUND", markJobComplete: true,
            idempotencyKey: k, createdByUserId: ownerId, outputs: [parcelOutput],
          }),
        TX
      );
    const results = await Promise.allSettled([receive(), receive()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.polishedPacket.count({ where: { sourceDiamondJobId: job.id } })).toBe(1);
    expect(await prisma.polishedReceipt.count({ where: { jobId: job.id } })).toBe(1);
    await reconcile1220();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4. Existing ZL-POL records: never silently converted; an audited route
// ---------------------------------------------------------------------------
describe("existing single-stone records stay whole unless an Owner converts one, audited", () => {
  it("a normal single-stone receipt creates a ZL-POL row and NO packet; nothing converts by itself", async () => {
    const made = await manufacture({ outputs: [{ kind: "STONE", shape: "ROUND", carat: "35.000" }], labour: 10000 });
    expect(made.parcels).toHaveLength(0);
    const [stone] = made.stones;
    expect(stone.status).toBe("AVAILABLE");
    expect(stone.allocatedCost.toFixed(2)).toBe("90000.00");
    expect(await prisma.polishedPacket.count({ where: { sourceDiamondJobId: made.job.id } })).toBe(0);
    const rows = await listPolishedDiamonds({ search: stone.polishedCode });
    expect(rows[0].convertedToPacketCode).toBeNull();
    await reconcile1220();
  });

  it("converting a 35 ct / ₹90,000 record (with the reason and stone count) creates the parcel at its CURRENT cost, retires the row, and posts no voucher", async () => {
    // Two stones in one receipt at the proportional split, then an Owner cost
    // correction (the real override) so the 35 ct record's CURRENT carrying
    // cost is ₹90,000 rather than the original proportional figure.
    const made = await manufacture({
      outputs: [{ kind: "STONE", shape: "ROUND", carat: "35.000" }, { kind: "STONE", shape: "ROUND", carat: "5.000" }],
      labour: 20000,
    });
    const big = made.stones.find((s) => new Decimal(s.carat).equals(35))!;
    const small = made.stones.find((s) => new Decimal(s.carat).equals(5))!;
    expect(big.allocatedCost.toFixed(2)).toBe("87500.00"); // 100,000 * 35/40 originally
    await prisma.$transaction(
      (tx) =>
        overridePolishedAllocations(tx, {
          receiptId: made.receipt.id,
          adjustments: [
            { polishedDiamondId: big.id, newAllocatedCost: "90000.00" },
            { polishedDiamondId: small.id, newAllocatedCost: "10000.00" },
          ],
          reason: "Owner corrected the cost split across the two outputs",
        }),
      TX
    );

    const before1220 = (await accountBalance("1220")).toFixed(2);
    const converted = await prisma.$transaction(
      (tx) => convertPolishedDiamondToParcel(tx, { polishedDiamondId: big.id, pieceCount: 140, sizeLabel: "1.5 mm", reason: "The receipt recorded the whole 35 ct lot as one stone; it is a parcel of 140 stones", convertedByUserId: ownerId }),
      TX
    );
    expect((await accountBalance("1220")).toFixed(2)).toBe(before1220); // pure reclassification inside 1220

    const packet = converted.packet;
    expect(await packetBalance(packet.id)).toEqual({ pieces: 140, carat: "35.000", costValue: "90000.00" }); // CURRENT cost, not the original 87,500
    expect(packet.sourceDiamondJobId).toBe(made.job.id);
    expect(packet.sourceReceiptId).toBe(made.receipt.id);
    expect(packet.convertedFromPolishedDiamondId).toBe(big.id);
    const [movement] = await prisma.polishedPacketMovement.findMany({ where: { packetId: packet.id } });
    expect(movement.type).toBe("CONVERSION_IN");
    expect(movement.sourceDocument).toBe(big.polishedCode);

    // The record is retired, not deleted, and carries the audit.
    const retired = await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: big.id } });
    expect(retired.status).toBe("CONVERTED_TO_PARCEL");
    expect(retired.convertedByUserId).toBe(ownerId);
    expect(retired.convertedAt).not.toBeNull();
    expect(retired.convertedReason).toMatch(/parcel of 140 stones/);
    const out = await prisma.stockMovement.findFirstOrThrow({ where: { polishedDiamondId: big.id, type: "POLISHED_CONVERTED_OUT" } });
    expect(out.costValue.toFixed(2)).toBe("90000.00");
    // The other stone in the same receipt is untouched.
    expect((await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: small.id } })).status).toBe("AVAILABLE");
    const listed = (await listPolishedDiamonds({ search: big.polishedCode }))[0];
    expect(listed.convertedToPacketCode).toBe(packet.packetCode);
    await reconcile1220();

    // ...and now the headline example works on the converted record.
    const job = await draftJewelleryJob("converted parcel ring");
    await issueToJob(job.id, [{ packetId: packet.id, pieces: 40, carat: "10.000" }]);
    const line = await prisma.jewelleryPacketIssueLine.findFirstOrThrow({ where: { jobId: job.id, packetId: packet.id } });
    expect(line.costAtIssue.toFixed(2)).toBe("25714.29");
    expect((await packetBalance(packet.id)).costValue).toBe("64285.71");
  }, 60_000);

  it("refuses: a second conversion, a short reason, a count under 2, a certified stone, and a stone that is not Available", async () => {
    const made = await manufacture({
      outputs: [
        { kind: "STONE", shape: "ROUND", carat: "20.000" },
        { kind: "STONE", shape: "ROUND", carat: "10.000", certificateStatus: "CERTIFIED", certLab: "GIA", certNumber: "GIA-1" },
        { kind: "STONE", shape: "ROUND", carat: "5.000" },
      ],
      labour: 5000,
    });
    const plain = made.stones.find((s) => new Decimal(s.carat).equals(20))!;
    const certified = made.stones.find((s) => new Decimal(s.carat).equals(10))!;
    const issuedStone = made.stones.find((s) => new Decimal(s.carat).equals(5))!;
    const convert = (id: string, pieceCount: number, reason: string) =>
      prisma.$transaction((tx) => convertPolishedDiamondToParcel(tx, { polishedDiamondId: id, pieceCount, reason, convertedByUserId: ownerId }), TX);
    const good = "This record is really a parcel of many stones";

    await expect(convert(plain.id, 50, "too short")).rejects.toThrow(/at least 10 characters/);
    await expect(convert(plain.id, 1, good)).rejects.toThrow(/at least 2/);
    await expect(convert(certified.id, 50, good)).rejects.toThrow(/certified, so it is a single stone/);

    // Issue the third stone whole to a Jewellery Job, then it is no longer Available.
    const job = await draftJewelleryJob("whole stone ring");
    await prisma.$transaction(
      (tx) => issueMaterialsToJewelleryJob(tx, { ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId, grossWeight: "10.000" }], polishedDiamondIds: [issuedStone.id], otherMaterialLines: [], createdByUserId: ownerId }),
      TX
    );
    await expect(convert(issuedStone.id, 50, good)).rejects.toThrow(/not available/);

    await convert(plain.id, 50, good);
    await expect(convert(plain.id, 50, good)).rejects.toThrow(/already been converted/);
    expect(await prisma.polishedPacket.count({ where: { convertedFromPolishedDiamondId: plain.id } })).toBe(1);
    // An individual stone is still issued WHOLE, exactly as before.
    expect((await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: issuedStone.id } })).status).toBe("ISSUED_TO_JEWELLERY");
    await reconcile1220();
  }, 60_000);

  it("two Owners converting the same record at once: exactly one wins", async () => {
    const made = await manufacture({ outputs: [{ kind: "STONE", shape: "ROUND", carat: "12.000" }], labour: 1000 });
    const stone = made.stones[0];
    const convert = () =>
      prisma.$transaction(
        (tx) => convertPolishedDiamondToParcel(tx, { polishedDiamondId: stone.id, pieceCount: 30, reason: "Concurrent conversion attempt for this parcel", convertedByUserId: ownerId }),
        TX
      );
    const results = await Promise.allSettled([convert(), convert()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.polishedPacket.count({ where: { convertedFromPolishedDiamondId: stone.id } })).toBe(1);
    await reconcile1220();
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Duration
// ---------------------------------------------------------------------------
describe("transaction duration", () => {
  it("a parcel receipt, a partial issue and a conversion each finish far inside the 5s Prisma default", async () => {
    const t0 = Date.now();
    const made = await manufacture({ outputs: [parcelOutput], labour: 10000 });
    const receiptMs = Date.now() - t0;
    const job = await draftJewelleryJob("timing");
    const t1 = Date.now();
    await issueToJob(job.id, [{ packetId: made.parcels[0].id, pieces: 40, carat: "10.000" }]);
    const issueMs = Date.now() - t1;
    const single = await manufacture({ outputs: [{ kind: "STONE", shape: "ROUND", carat: "35.000" }], labour: 10000 });
    const t2 = Date.now();
    await prisma.$transaction(
      (tx) => convertPolishedDiamondToParcel(tx, { polishedDiamondId: single.stones[0].id, pieceCount: 140, reason: "Timing check of an audited conversion", convertedByUserId: ownerId }),
      TX
    );
    const convertMs = Date.now() - t2;
    console.log(`Polished parcel timings — whole manufacture (rough purchase+issue+receipt): ${receiptMs}ms; partial issue to jewellery job: ${issueMs}ms; conversion: ${convertMs}ms`);
    expect(issueMs).toBeLessThan(5_000);
    expect(convertMs).toBeLessThan(5_000);
    expect(receiptMs).toBeLessThan(15_000);
  }, 60_000);
});
