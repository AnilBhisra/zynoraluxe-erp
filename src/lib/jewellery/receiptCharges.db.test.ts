/**
 * Real-database acceptance for "Add missing charges" on a jewellery receipt.
 * Disposable scratch database only — the shared guard refuses anything else,
 * because these suites truncate business tables.
 *
 * Proves, from the ledger and the stored rows themselves:
 *  - a balanced correction voucher (Dr 1330 Finished Jewellery Inventory,
 *    Cr 2000 Karigar payable) and the piece cost / job charge total move
 *    together, exactly once;
 *  - the receipt row, its original voucher and every quantity are untouched;
 *  - the five charge categories stay separate on the correction and on every piece;
 *  - allocation across outputs reconciles to the paisa;
 *  - future sale COGS, adjustments and new Actual Costing snapshots see the
 *    added charge exactly once;
 *  - sold / returned / adjusted pieces are refused with a clear message, both
 *    to add and to reverse; duplicate and concurrent submits post once;
 *  - reversal undoes the accounting AND the carrying-cost effect exactly once.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { buildActualSourceSnapshot } from "@/lib/costing/sourcing";
import { CorrectionError } from "@/lib/corrections/types";
import { adjustFinishedJewelleryStock, cancelFinishedJewellerySale, postFinishedJewellerySale } from "@/lib/jewellery/finishedSalesPosting";
import {
  createJewelleryJob,
  issueMaterialsToJewelleryJob,
  overrideFinishedJewelleryAllocation,
  postOpeningMetalStock,
  receiveFinishedJewellery,
} from "@/lib/jewellery/posting";
import { getReceiptChargePanels } from "@/lib/jewellery/receiptChargePanels";
import {
  assessReceiptForCharges,
  chargePlanFingerprint,
  planReceiptCharges,
  postReceiptChargeCorrection,
  reverseReceiptChargeCorrection,
} from "@/lib/jewellery/receiptChargeCorrection";
import { getJewelleryJobDetail } from "@/lib/jewellery/reports";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-27T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let karigarId: string;
let customerId: string;
let purityId: string;
let seq = 0;
const key = (label: string) => `rc-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>(
    "select current_database() db, current_user usr, inet_server_port() port"
  );
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearAll();

  karigarId = (await prisma.party.create({ data: { name: "Charge Test Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
  customerId = (await prisma.party.create({ data: { name: "Charge Test Customer", type: "CUSTOMER", createdByUserId: ownerId } })).id;
  purityId = (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType: "GOLD", displayName: "Charge Test Karat" } },
      create: { metalType: "GOLD", displayName: "Charge Test Karat", finenessPercent: "91.600", createdByUserId: ownerId },
      update: { finenessPercent: "91.600" },
    })
  ).id;
  await prisma.$transaction(
    (tx) =>
      postOpeningMetalStock(tx, {
        metalType: "GOLD",
        purityId,
        grossWeight: "2000.000",
        costValue: "2000000.00",
        idempotencyKey: key("opening"),
        ...FY,
        createdByUserId: ownerId,
      }),
    TX
  );
}, 90_000);

afterAll(async () => {
  await clearAll();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function balance(code: string, partyId?: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const t = await prisma.journalEntry.aggregate({
    where: { accountId: account.id, ...(partyId ? { partyId } : {}) },
    _sum: { debit: true, credit: true },
  });
  return new Decimal(t._sum.debit ?? 0).minus(t._sum.credit ?? 0);
}
const payable = async () => (await balance("2000", karigarId)).negated(); // credit balance
async function unbalancedVouchers(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`
  );
  return rows[0].n;
}
/** 1330 must equal Σ metal + diamond + labour of every AVAILABLE piece — no value created or lost. */
async function reconcile1330() {
  const pieces = await prisma.finishedJewellery.findMany({ where: { status: "AVAILABLE" } });
  const sum = pieces.reduce((s, p) => s.plus(p.metalCost).plus(p.diamondCost).plus(p.labourAllocated), ZERO);
  expect((await balance("1330")).toFixed(2)).toBe(sum.toFixed(2));
  expect(await unbalancedVouchers()).toBe(0);
}

type Made = { jobId: string; jobCode: string; receiptId: string; receiptCode: string; pieceIds: string[]; voucherId: string };

/** A completed job with ONE receipt: `weights` grams -> one piece each, charges as entered at receipt. */
async function makeReceipt(name: string, weights: number[], charges: { labour?: string; making?: string } = {}): Promise<Made> {
  const issued = weights.reduce((s, w) => s + w, 0);
  const job = await prisma.$transaction(
    (tx) =>
      createJewelleryJob(tx, {
        jewelleryType: "PENDANT",
        designName: name,
        karigarId,
        issueDate: DATE,
        quantity: weights.length,
        createdByUserId: ownerId,
        idempotencyKey: key("job"),
      }),
    TX
  );
  await prisma.$transaction(
    (tx) =>
      issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true,
        ...FY,
        jobId: job.id,
        issueDate: DATE,
        metalLines: [{ metalType: "GOLD", purityId, grossWeight: String(issued) }],
        polishedDiamondIds: [],
        otherMaterialLines: [],
        idempotencyKey: key("issue"),
        createdByUserId: ownerId,
      }),
    TX
  );
  const received = await prisma.$transaction(
    (tx) =>
      receiveFinishedJewellery(tx, {
        ...FY,
        jobId: job.id,
        receiveDate: DATE,
        outputs: weights.map((w) => ({ jewelleryType: "PENDANT", quantity: 1, netMetalWeight: w, metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" as const })),
        diamondResolutions: [],
        returnedMetalLines: [],
        scrapMetalLines: [],
        karigarAddedFineWeight: 0,
        karigarAddedCost: 0,
        labourCharge: charges.labour ?? 0,
        makingCharge: charges.making ?? 0,
        settingCharge: 0,
        platingCharge: 0,
        otherExpense: 0,
        markJobComplete: true,
        isAbnormalLoss: false,
        damagedLostByUserId: ownerId,
        idempotencyKey: key("receipt"),
        createdByUserId: ownerId,
      }),
    TX
  );
  const pieces = await prisma.finishedJewellery.findMany({ where: { receiptId: received.receipt.id }, orderBy: { finishedCode: "asc" } });
  return {
    jobId: job.id,
    jobCode: job.jobCode,
    receiptId: received.receipt.id,
    receiptCode: received.receipt.receiptCode,
    pieceIds: pieces.map((p) => p.id),
    voucherId: received.receipt.postingVoucherId!,
  };
}

const addCharges = (
  receiptId: string,
  charges: Record<string, string>,
  opts: { reason?: string; k?: string; fingerprint?: string | null; role?: "OWNER" | "STAFF" } = {}
) =>
  prisma.$transaction(
    (tx) =>
      postReceiptChargeCorrection(tx, {
        receiptId,
        charges,
        reason: opts.reason ?? "Labour and setting were not entered when the pendant was received",
        idempotencyKey: opts.k ?? key("add"),
        expectedFingerprint: opts.fingerprint ?? null,
        owner: { id: ownerId, role: opts.role ?? "OWNER" },
        ...FY,
      }),
    TX
  );

const reverse = (correctionId: string, reason = "Entered against the wrong receipt by mistake") =>
  prisma.$transaction((tx) => reverseReceiptChargeCorrection(tx, { correctionId, reason, owner: owner(), ...FY }), TX);

const snapshotOf = async (m: Made) => {
  const [receipt, pieces, job, voucher, movements] = await Promise.all([
    prisma.jewelleryReceipt.findUniqueOrThrow({ where: { id: m.receiptId } }),
    prisma.finishedJewellery.findMany({ where: { receiptId: m.receiptId }, orderBy: { finishedCode: "asc" } }),
    prisma.jewelleryJob.findUniqueOrThrow({ where: { id: m.jobId } }),
    prisma.voucher.findUniqueOrThrow({ where: { id: m.voucherId }, include: { journalEntries: true } }),
    prisma.finishedJewelleryStockMovement.findMany({ where: { finishedJewelleryId: { in: m.pieceIds } } }),
  ]);
  return { receipt, pieces, job, voucher, movements };
};

// ---------------------------------------------------------------------------
// 1. Posting
// ---------------------------------------------------------------------------
describe("Add missing charges — posting", () => {
  it("adds ₹1,500 (labour 1,000 + setting 500) to one piece: balanced voucher, piece cost, job total, payable — and NOTHING else changes", async () => {
    const m = await makeReceipt("Pendant single", [10]);
    const before = await snapshotOf(m);
    expect(new Decimal(before.pieces[0].labourAllocated).toFixed(2)).toBe("0.00");
    expect(new Decimal(before.job.totalLabourCharge).toFixed(2)).toBe("0.00");
    const inv0 = await balance("1330");
    const pay0 = await payable();

    const result = await addCharges(m.receiptId, { labourCharge: "1000.00", settingCharge: "500.00" });
    expect(result.replayed).toBe(false);

    // --- the correction voucher: Dr 1330 / Cr 2000 (Karigar), balanced
    const correction = await prisma.correction.findUniqueOrThrow({
      where: { id: result.correction.id },
      include: { correctionVoucher: { include: { journalEntries: { include: { account: true } } } }, impacts: true, receiptChargeCorrection: { include: { lines: true } } },
    });
    expect(correction.mode).toBe("ADD_CHARGES");
    expect(correction.entityType).toBe("JEWELLERY_RECEIPT");
    expect(correction.entityId).toBe(m.receiptId);
    expect(correction.state).toBe("POSTED");
    expect(correction.approvedByUserId).toBe(ownerId);
    const v = correction.correctionVoucher!;
    expect(v.voucherType).toBe("CORRECTION");
    expect(v.amount.toFixed(2)).toBe("1500.00");
    const byCode = Object.fromEntries(v.journalEntries.map((e) => [e.account.code, e]));
    expect(byCode["1330"].debit.toFixed(2)).toBe("1500.00");
    expect(byCode["2000"].credit.toFixed(2)).toBe("1500.00");
    expect(byCode["2000"].partyId).toBe(karigarId);
    expect(v.journalEntries).toHaveLength(2);

    // --- the piece and the job moved together, by exactly the addition
    const after = await snapshotOf(m);
    expect(new Decimal(after.pieces[0].labourAllocated).toFixed(2)).toBe("1500.00");
    expect(new Decimal(after.pieces[0].totalCost).minus(before.pieces[0].totalCost).toFixed(2)).toBe("1500.00");
    expect(new Decimal(after.job.totalLabourCharge).toFixed(2)).toBe("1500.00");
    expect((await balance("1330")).minus(inv0).toFixed(2)).toBe("1500.00");
    expect((await payable()).minus(pay0).toFixed(2)).toBe("1500.00");

    // --- categories separate on the correction and on the piece's share
    const link = correction.receiptChargeCorrection!;
    expect(link.labourCharge.toFixed(2)).toBe("1000.00");
    expect(link.settingCharge.toFixed(2)).toBe("500.00");
    expect(link.makingCharge.toFixed(2)).toBe("0.00");
    expect(link.totalCharge.toFixed(2)).toBe("1500.00");
    expect(link.lines).toHaveLength(1);
    expect(link.lines[0].labourCharge.toFixed(2)).toBe("1000.00");
    expect(link.lines[0].settingCharge.toFixed(2)).toBe("500.00");
    expect(link.lines[0].oldLabourAllocated.toFixed(2)).toBe("0.00");
    expect(link.lines[0].newLabourAllocated.toFixed(2)).toBe("1500.00");
    // audit impacts written from the approved plan
    expect(correction.impacts.map((i) => `${i.kind}:${i.field}:${i.oldValue}->${i.newValue}`)).toEqual(
      expect.arrayContaining(["FINISHED:labourAllocated:0.00->1500.00", "WIP:totalLabourCharge:0.00->1500.00"])
    );

    // --- originals preserved: receipt row, its voucher and every quantity untouched
    expect(after.receipt).toEqual(before.receipt);
    expect(after.voucher.journalEntries).toEqual(before.voucher.journalEntries);
    expect(after.voucher.amount.toFixed(2)).toBe(before.voucher.amount.toFixed(2));
    for (const f of ["netMetalWeight", "fineMetalWeight", "grossWeight", "metalCost", "diamondCost", "otherMaterialCost", "quantity", "status"] as const) {
      expect(String(after.pieces[0][f])).toBe(String(before.pieces[0][f]));
    }
    expect(after.movements).toEqual(before.movements); // no availability movement was added
    expect(after.job.status).toBe(before.job.status);
    expect(new Decimal(after.job.remainingWipCost).toFixed(2)).toBe(new Decimal(before.job.remainingWipCost).toFixed(2));
    await reconcile1330();
  });

  it("splits charges across a receipt's outputs by fine weight; each category and the total reconcile to the paisa", async () => {
    const m = await makeReceipt("Pendant trio", [7, 10, 13]);
    const result = await addCharges(m.receiptId, { labourCharge: "100.01", makingCharge: "33.33", otherExpense: "0.07" });
    const lines = await prisma.jewelleryReceiptChargeCorrectionLine.findMany({
      where: { chargeCorrection: { correctionId: result.correction.id } },
      include: { finishedJewellery: true },
    });
    expect(lines).toHaveLength(3);
    const sum = (f: "labourCharge" | "makingCharge" | "otherExpense" | "totalCharge") => lines.reduce((s, l) => s.plus(l[f]), ZERO).toFixed(2);
    expect(sum("labourCharge")).toBe("100.01");
    expect(sum("makingCharge")).toBe("33.33");
    expect(sum("otherExpense")).toBe("0.07");
    expect(sum("totalCharge")).toBe("133.41");
    // heavier piece carries more; each piece total is the sum of its own categories
    const byWeight = [...lines].sort((a, b) => new Decimal(a.finishedJewellery.fineMetalWeight).comparedTo(b.finishedJewellery.fineMetalWeight));
    expect(new Decimal(byWeight[2].totalCharge).greaterThan(byWeight[0].totalCharge)).toBe(true);
    for (const l of lines) {
      expect(l.totalCharge.toFixed(2)).toBe(l.labourCharge.plus(l.makingCharge).plus(l.settingCharge).plus(l.platingCharge).plus(l.otherExpense).toFixed(2));
      // and each piece's stored cost moved by exactly its own share
      expect(l.newLabourAllocated.minus(l.oldLabourAllocated).toFixed(2)).toBe(l.totalCharge.toFixed(2));
      expect(new Decimal(l.finishedJewellery.labourAllocated).toFixed(2)).toBe(l.newLabourAllocated.toFixed(2));
    }
    const job = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: m.jobId } });
    expect(job.totalLabourCharge.toFixed(2)).toBe("133.41");
    await reconcile1330();
  });

  it("charges entered at receipt time and added later stay separate: receipt fields keep the original, job total is the sum", async () => {
    const m = await makeReceipt("Pendant partial-entry", [10], { labour: "200.00" });
    await addCharges(m.receiptId, { makingCharge: "300.00" });
    const s = await snapshotOf(m);
    expect(s.receipt.labourCharge.toFixed(2)).toBe("200.00"); // original untouched
    expect(s.receipt.makingCharge.toFixed(2)).toBe("0.00");
    expect(s.pieces[0].labourAllocated.toFixed(2)).toBe("500.00");
    expect(s.job.totalLabourCharge.toFixed(2)).toBe("500.00");
    const [panel] = await getReceiptChargePanels(m.jobId);
    expect(panel.originalTotal).toBe("200.00");
    expect(panel.addedLaterTotal).toBe("300.00");
    expect(panel.corrections).toHaveLength(1);
    expect(panel.corrections[0].amounts.makingCharge).toBe("300.00");
    expect(panel.addBlockedReason).toBeNull();
    await reconcile1330();
  });

  it("refuses: not the Owner, no amount, negative, 3 decimals, short reason, unknown receipt — and saves nothing", async () => {
    const m = await makeReceipt("Pendant validation", [10]);
    const vouchersBefore = await prisma.voucher.count();
    const corrBefore = await prisma.correction.count();
    await expect(addCharges(m.receiptId, { labourCharge: "10" }, { role: "STAFF" })).rejects.toThrow(/Only the Owner/);
    await expect(addCharges(m.receiptId, {})).rejects.toThrow(/at least one charge/);
    await expect(addCharges(m.receiptId, { labourCharge: "-1" })).rejects.toThrow(/cannot be negative/);
    await expect(addCharges(m.receiptId, { labourCharge: "1.005" })).rejects.toThrow(/at most 2 decimal/);
    await expect(addCharges(m.receiptId, { labourCharge: "10" }, { reason: "short" })).rejects.toThrow(/at least 10 characters/);
    await expect(addCharges("does-not-exist", { labourCharge: "10" })).rejects.toThrow(/Receipt not found/);
    expect(await prisma.voucher.count()).toBe(vouchersBefore);
    expect(await prisma.correction.count()).toBe(corrBefore);
    expect((await snapshotOf(m)).pieces[0].labourAllocated.toFixed(2)).toBe("0.00");
  });

  it("a stale preview is refused: if the pieces moved after the Owner saw the preview, nothing posts", async () => {
    const m = await makeReceipt("Pendant stale", [10]);
    const built = await prisma.$transaction((tx) => planReceiptCharges(tx, { receiptId: m.receiptId, charges: { labourCharge: "100" }, reason: "Preview then a second correction lands" }), TX);
    const fp = chargePlanFingerprint(built.plan);
    await addCharges(m.receiptId, { makingCharge: "50" }); // changes the piece's cost after the preview
    await expect(addCharges(m.receiptId, { labourCharge: "100" }, { fingerprint: fp })).rejects.toThrow(/changed after this preview/);
    expect((await snapshotOf(m)).pieces[0].labourAllocated.toFixed(2)).toBe("50.00");
    // with the fresh preview it posts
    const fresh = await prisma.$transaction((tx) => planReceiptCharges(tx, { receiptId: m.receiptId, charges: { labourCharge: "100" }, reason: "Preview then a second correction lands" }), TX);
    await addCharges(m.receiptId, { labourCharge: "100" }, { fingerprint: chargePlanFingerprint(fresh.plan) });
    expect((await snapshotOf(m)).pieces[0].labourAllocated.toFixed(2)).toBe("150.00");
    await reconcile1330();
  });
});

// ---------------------------------------------------------------------------
// 2. Duplicate and concurrent submits
// ---------------------------------------------------------------------------
describe("Add missing charges — duplicate and concurrent submits", () => {
  it("the same submission key posts ONCE (double click / re-sent request): one voucher, one increase", async () => {
    const m = await makeReceipt("Pendant dup", [10]);
    const k = key("dup");
    const first = await addCharges(m.receiptId, { labourCharge: "700" }, { k });
    const second = await addCharges(m.receiptId, { labourCharge: "700" }, { k });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.correction.id).toBe(first.correction.id);
    expect(await prisma.correction.count({ where: { entityId: m.receiptId, mode: "ADD_CHARGES" } })).toBe(1);
    expect(await prisma.jewelleryReceiptChargeCorrection.count({ where: { receiptId: m.receiptId } })).toBe(1);
    expect((await snapshotOf(m)).pieces[0].labourAllocated.toFixed(2)).toBe("700.00");
    await reconcile1330();
  });

  it("two simultaneous submits with the same key: exactly one correction, one voucher, one increase", async () => {
    const m = await makeReceipt("Pendant dup concurrent", [10]);
    const k = key("dup-conc");
    const results = await Promise.allSettled([addCharges(m.receiptId, { labourCharge: "450" }, { k }), addCharges(m.receiptId, { labourCharge: "450" }, { k })]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const flags = results.map((r) => (r as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed).sort();
    expect(flags).toEqual([false, true]);
    expect(await prisma.correction.count({ where: { entityId: m.receiptId, mode: "ADD_CHARGES" } })).toBe(1);
    expect((await snapshotOf(m)).pieces[0].labourAllocated.toFixed(2)).toBe("450.00");
    expect((await snapshotOf(m)).job.totalLabourCharge.toFixed(2)).toBe("450.00");
    await reconcile1330();
  }, 60_000);

  it("a key already used for a different receipt is refused", async () => {
    const a = await makeReceipt("Pendant key A", [10]);
    const b = await makeReceipt("Pendant key B", [10]);
    const k = key("cross");
    await addCharges(a.receiptId, { labourCharge: "10" }, { k });
    await expect(addCharges(b.receiptId, { labourCharge: "10" }, { k })).rejects.toThrow(/already used for a different correction/);
    expect((await snapshotOf(b)).pieces[0].labourAllocated.toFixed(2)).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// 3. Downstream: sales, adjustments, costing — each sees the charge exactly once
// ---------------------------------------------------------------------------
describe("Add missing charges — everything downstream includes it exactly once", () => {
  it("future sale COGS = metal + diamond + labour INCLUDING the added charge, and the ledger still reconciles", async () => {
    const m = await makeReceipt("Pendant sale after", [10], { labour: "100.00" });
    const before = await snapshotOf(m);
    await addCharges(m.receiptId, { labourCharge: "400.00" });
    const piece = (await snapshotOf(m)).pieces[0];
    const expectedCogs = new Decimal(piece.metalCost).plus(piece.diamondCost).plus(piece.labourAllocated);
    expect(new Decimal(piece.labourAllocated).toFixed(2)).toBe("500.00");
    expect(expectedCogs.minus(new Decimal(before.pieces[0].metalCost).plus(before.pieces[0].diamondCost).plus(before.pieces[0].labourAllocated)).toFixed(2)).toBe("400.00");

    const { sale } = await prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          date: DATE,
          saleDate: DATE,
          ...FY,
          currencyCode: "INR",
          exchangeRate: 1,
          createdByUserId: ownerId,
          customerId,
          gstTreatment: "NONE",
          idempotencyKey: key("sale"),
          items: [{ finishedJewelleryId: piece.id, sellingPrice: "50000.00", gstRatePercent: 0, taxType: "EXCLUSIVE" }],
        }),
      TX
    );
    expect(sale.cogsTotal.toFixed(2)).toBe(expectedCogs.toFixed(2));
    const line = await prisma.finishedJewellerySaleLine.findFirstOrThrow({ where: { finishedJewelleryId: piece.id } });
    expect(line.cogsAmount.toFixed(2)).toBe(expectedCogs.toFixed(2));
    await reconcile1330();
  });

  it("the shared overrides / adjustments work on the CURRENT total (which includes the addition)", async () => {
    const m = await makeReceipt("Pendant override", [10]);
    await addCharges(m.receiptId, { labourCharge: "250.00" });
    const piece = (await snapshotOf(m)).pieces[0];
    const current = new Decimal(piece.totalCost);
    // the old (pre-correction) total no longer matches the receipt's total
    await expect(
      prisma.$transaction((tx) => overrideFinishedJewelleryAllocation(tx, { receiptId: m.receiptId, adjustments: [{ finishedJewelleryId: piece.id, newTotalCost: current.minus(250) }], reason: "wrong total" }), TX)
    ).rejects.toThrow(/must exactly equal/);
    // the current total is accepted and changes nothing about labour
    await prisma.$transaction((tx) => overrideFinishedJewelleryAllocation(tx, { receiptId: m.receiptId, adjustments: [{ finishedJewelleryId: piece.id, newTotalCost: current }], reason: "no-op check" }), TX);
    expect(new Decimal((await snapshotOf(m)).pieces[0].labourAllocated).toFixed(2)).toBe("250.00");
  });

  it("an Owner stock adjustment values the piece at its CURRENT cost including the addition — once", async () => {
    const m = await makeReceipt("Pendant adjust cost", [10]);
    await addCharges(m.receiptId, { labourCharge: "320.00" });
    const piece = (await snapshotOf(m)).pieces[0];
    await prisma.$transaction(
      (tx) => adjustFinishedJewelleryStock(tx, { finishedJewelleryId: piece.id, direction: "OUT", reason: "Owner adjustment for cost check", createdByUserId: ownerId }),
      TX
    );
    const mv = await prisma.finishedJewelleryStockMovement.findFirstOrThrow({ where: { finishedJewelleryId: piece.id, type: "OWNER_ADJUSTMENT_OUT" } });
    expect(mv.costValue.toFixed(2)).toBe(new Decimal(piece.metalCost).plus(piece.diamondCost).plus(piece.labourAllocated).toFixed(2));
    expect(new Decimal(piece.labourAllocated).toFixed(2)).toBe("320.00");
    // An Owner adjustment posts no voucher, so put the piece back to keep the shared ledger check exact.
    await prisma.$transaction(
      (tx) => adjustFinishedJewelleryStock(tx, { finishedJewelleryId: piece.id, direction: "IN", reason: "Owner put it back after the cost check", createdByUserId: ownerId }),
      TX
    );
    const back = await prisma.finishedJewelleryStockMovement.findFirstOrThrow({ where: { finishedJewelleryId: piece.id, type: "OWNER_ADJUSTMENT_IN" } });
    expect(back.costValue.toFixed(2)).toBe(mv.costValue.toFixed(2)); // valued identically, once
  });

  it("a NEW Actual Costing snapshot carries the labour including the addition — exactly once", async () => {
    const m = await makeReceipt("Pendant costing", [10], { labour: "100.00" });
    await addCharges(m.receiptId, { settingCharge: "150.00", platingCharge: "25.50" });
    const snap = await prisma.$transaction((tx) => buildActualSourceSnapshot(tx, m.pieceIds[0]), TX);
    expect(snap.labourLine?.amount.toFixed(2)).toBe("275.50"); // 100.00 at receipt + 175.50 added
  });

  it("the job detail shows the increased 'labour/making/setting so far' and the piece's current cost", async () => {
    const m = await makeReceipt("Pendant job detail", [10]);
    const before = await getJewelleryJobDetail(m.jobId);
    await addCharges(m.receiptId, { labourCharge: "1000.00" });
    const after = await getJewelleryJobDetail(m.jobId);
    expect(after!.totalLabourCharge.minus(before!.totalLabourCharge).toFixed(2)).toBe("1000.00");
    expect(new Decimal(after!.finishedOutputs[0].totalCost).minus(before!.finishedOutputs[0].totalCost).toFixed(2)).toBe("1000.00");
    // the receipt row itself still reports its ORIGINAL charges
    expect(after!.receipts[0].labourCharge.toFixed(2)).toBe("0.00");
  });

  it("a later receipt on the same open job neither loses nor double-counts an earlier correction, and does not carry it", async () => {
    const job = await prisma.$transaction(
      (tx) =>
        createJewelleryJob(tx, { jewelleryType: "PENDANT", designName: "Two receipts", karigarId, issueDate: DATE, quantity: 2, createdByUserId: ownerId, idempotencyKey: key("job2") }),
      TX
    );
    await prisma.$transaction(
      (tx) =>
        issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true,
          ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId, grossWeight: "20" }], polishedDiamondIds: [], otherMaterialLines: [],
          idempotencyKey: key("issue2"), createdByUserId: ownerId,
        }),
      TX
    );
    const receive = (w: number, complete: boolean, labour: string) =>
      prisma.$transaction(
        (tx) =>
          receiveFinishedJewellery(tx, {
            ...FY, jobId: job.id, receiveDate: DATE,
            outputs: [{ jewelleryType: "PENDANT", quantity: 1, netMetalWeight: w, metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
            diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
            labourCharge: labour, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0, markJobComplete: complete, isAbnormalLoss: false,
            damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
          }),
        TX
      );
    const r1 = await receive(10, false, "0");
    await addCharges(r1.receipt.id, { labourCharge: "600.00" });
    const r2 = await receive(10, true, "50.00");
    const p1 = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r1.receipt.id } });
    const p2 = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r2.receipt.id } });
    expect(p1.labourAllocated.toFixed(2)).toBe("600.00"); // kept
    expect(p2.labourAllocated.toFixed(2)).toBe("50.00"); // only its own receipt's charge
    const j = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(j.totalLabourCharge.toFixed(2)).toBe("650.00"); // 600 correction + 50 receipt, once each
    await reconcile1330();
  });
});

// ---------------------------------------------------------------------------
// 4. Sold / returned / adjusted pieces are refused
// ---------------------------------------------------------------------------
describe("Add missing charges — only while every piece is Available and unsold", () => {
  async function sell(pieceId: string) {
    return prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          date: DATE, saleDate: DATE, ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId, customerId, gstTreatment: "NONE",
          idempotencyKey: key("sale"), items: [{ finishedJewelleryId: pieceId, sellingPrice: "90000.00", gstRatePercent: 0, taxType: "EXCLUSIVE" }],
        }),
      TX
    );
  }

  it("refuses a sold piece with a clear message and changes nothing", async () => {
    const m = await makeReceipt("Pendant sold", [10]);
    await sell(m.pieceIds[0]);
    const before = await snapshotOf(m);
    const inv = await balance("1330");
    const assessed = await assessReceiptForCharges(prisma, m.receiptId);
    expect(assessed.ok).toBe(false);
    await expect(addCharges(m.receiptId, { labourCharge: "500" })).rejects.toThrow(/is sold\. Charges can only be added while every piece from this receipt is still Available and unsold/);
    const after = await snapshotOf(m);
    expect(after.pieces).toEqual(before.pieces);
    expect(after.job.totalLabourCharge.toFixed(2)).toBe(before.job.totalLabourCharge.toFixed(2));
    expect((await balance("1330")).toFixed(2)).toBe(inv.toFixed(2));
    const [panel] = await getReceiptChargePanels(m.jobId);
    expect(panel.addBlockedReason).toMatch(/is sold/);
  });

  it("refuses a piece whose sale was cancelled (it has sale history), and one adjusted out by the Owner", async () => {
    const m = await makeReceipt("Pendant sale cancelled", [10]);
    const { sale } = await sell(m.pieceIds[0]);
    await prisma.$transaction((tx) => cancelFinishedJewellerySale(tx, { saleId: sale.id, cancelledByUserId: ownerId, cancellationReason: "Customer cancelled", ...FY }), TX);
    expect((await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: m.pieceIds[0] } })).status).toBe("AVAILABLE");
    await expect(addCharges(m.receiptId, { labourCharge: "500" })).rejects.toThrow(/has stock history|has a sale on record/);

    const adj = await makeReceipt("Pendant adjusted", [10]);
    await prisma.$transaction(
      (tx) => adjustFinishedJewelleryStock(tx, { finishedJewelleryId: adj.pieceIds[0], direction: "OUT", reason: "Owner adjusted it out for the test", createdByUserId: ownerId }),
      TX
    );
    await expect(addCharges(adj.receiptId, { labourCharge: "500" })).rejects.toThrow(/adjusted out of stock by the Owner/);
    // ...and a piece the Owner adjusted back IN still has adjustment history, so it stays refused
    await prisma.$transaction(
      (tx) => adjustFinishedJewelleryStock(tx, { finishedJewelleryId: adj.pieceIds[0], direction: "IN", reason: "Owner put it back for the test", createdByUserId: ownerId }),
      TX
    );
    await expect(addCharges(adj.receiptId, { labourCharge: "500" })).rejects.toThrow(/has stock history/);
  });

  it("with a multi-piece receipt, ONE sold piece blocks the whole receipt", async () => {
    const m = await makeReceipt("Pendant pair", [10, 12]);
    await sell(m.pieceIds[0]);
    await expect(addCharges(m.receiptId, { labourCharge: "500" })).rejects.toThrow(/is sold/);
    for (const id of m.pieceIds) {
      expect((await prisma.finishedJewellery.findUniqueOrThrow({ where: { id } })).labourAllocated.toFixed(2)).toBe("0.00");
    }
  });

  it("a sale and an addition racing on the same piece: one wins, and the books stay consistent either way", async () => {
    const m = await makeReceipt("Pendant race", [10]);
    const results = await Promise.allSettled([addCharges(m.receiptId, { labourCharge: "800" }), sell(m.pieceIds[0])]);
    const piece = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: m.pieceIds[0] } });
    const added = results[0].status === "fulfilled";
    const sold = results[1].status === "fulfilled";
    expect(sold).toBe(true); // a sale is never blocked by a charge
    expect(piece.status).toBe("SOLD");
    // If the addition won the race, the sale's COGS must include it; if the sale won, the addition was refused.
    const line = await prisma.finishedJewellerySaleLine.findFirstOrThrow({ where: { finishedJewelleryId: piece.id } });
    expect(line.cogsAmount.toFixed(2)).toBe(new Decimal(piece.metalCost).plus(piece.diamondCost).plus(piece.labourAllocated).toFixed(2));
    expect(piece.labourAllocated.toFixed(2)).toBe(added ? "800.00" : "0.00");
    if (!added) expect(String((results[0] as PromiseRejectedResult).reason.message)).toMatch(/is sold|no longer/);
    await reconcile1330();
    expect(await unbalancedVouchers()).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Reversal
// ---------------------------------------------------------------------------
describe("Add missing charges — audited reversal", () => {
  it("removes the accounting AND the cost effect exactly once, and leaves the originals as they were", async () => {
    const m = await makeReceipt("Pendant reverse", [10], { labour: "100.00" });
    const start = await snapshotOf(m);
    const inv0 = await balance("1330");
    const pay0 = await payable();
    const added = await addCharges(m.receiptId, { labourCharge: "400.00", makingCharge: "50.00" });
    expect((await snapshotOf(m)).pieces[0].labourAllocated.toFixed(2)).toBe("550.00");

    const rev = await reverse(added.correction.id);
    const original = await prisma.correction.findUniqueOrThrow({ where: { id: added.correction.id } });
    expect(original.state).toBe("REVERSED");
    expect(original.reversedByCorrectionId).toBe(rev.reversal.id);
    expect(rev.reversal.mode).toBe("REVERSAL");
    expect(rev.reversal.reason).toMatch(/wrong receipt/);

    const end = await snapshotOf(m);
    expect(end.pieces[0].labourAllocated.toFixed(2)).toBe(start.pieces[0].labourAllocated.toFixed(2));
    expect(end.pieces[0].totalCost.toFixed(2)).toBe(start.pieces[0].totalCost.toFixed(2));
    expect(end.job.totalLabourCharge.toFixed(2)).toBe(start.job.totalLabourCharge.toFixed(2));
    expect(end.receipt).toEqual(start.receipt);
    expect((await balance("1330")).toFixed(2)).toBe(inv0.toFixed(2));
    expect((await payable()).toFixed(2)).toBe(pay0.toFixed(2));
    // nothing deleted: the correction, its link row and lines remain as history
    expect(await prisma.jewelleryReceiptChargeCorrection.count({ where: { correctionId: added.correction.id } })).toBe(1);
    const [panel] = await getReceiptChargePanels(m.jobId);
    expect(panel.addedLaterTotal).toBe("0.00");
    expect(panel.corrections[0].state).toBe("REVERSED");
    await reconcile1330();
  });

  it("a second reversal (sequential or simultaneous) is refused and removes nothing more", async () => {
    const m = await makeReceipt("Pendant reverse twice", [10]);
    const added = await addCharges(m.receiptId, { labourCharge: "300.00" });
    const [a, b] = await Promise.allSettled([reverse(added.correction.id), reverse(added.correction.id)]);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    const loser = (a.status === "rejected" ? a : b) as PromiseRejectedResult;
    expect(String(loser.reason.message)).toMatch(/already been reversed/);
    await expect(reverse(added.correction.id)).rejects.toThrow(/already been reversed/);
    expect((await snapshotOf(m)).pieces[0].labourAllocated.toFixed(2)).toBe("0.00"); // 300 - 300, never 300 - 600
    await reconcile1330();
  }, 60_000);

  it("is refused once a piece has been sold — inside the transaction, with a clear message — and changes nothing", async () => {
    const m = await makeReceipt("Pendant reverse after sale", [10]);
    const added = await addCharges(m.receiptId, { labourCharge: "300.00" });
    await prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          date: DATE, saleDate: DATE, ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId, customerId, gstTreatment: "NONE",
          idempotencyKey: key("sale"), items: [{ finishedJewelleryId: m.pieceIds[0], sellingPrice: "90000.00", gstRatePercent: 0, taxType: "EXCLUSIVE" }],
        }),
      TX
    );
    const before = await snapshotOf(m);
    await expect(reverse(added.correction.id)).rejects.toThrow(/is sold\. This correction can only be reversed while every piece/);
    const after = await snapshotOf(m);
    expect(after.pieces).toEqual(before.pieces);
    expect((await prisma.correction.findUniqueOrThrow({ where: { id: added.correction.id } })).state).toBe("POSTED");
    const [panel] = await getReceiptChargePanels(m.jobId);
    expect(panel.corrections[0].reverseBlockedReason).toMatch(/is sold/);
    await reconcile1330();
  });

  it("a sale and a reversal racing: exactly one wins and the books stay consistent", async () => {
    const m = await makeReceipt("Pendant reverse race", [10]);
    const added = await addCharges(m.receiptId, { labourCharge: "600.00" });
    const sellIt = () =>
      prisma.$transaction(
        (tx) =>
          postFinishedJewellerySale(tx, {
            date: DATE, saleDate: DATE, ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId, customerId, gstTreatment: "NONE",
            idempotencyKey: key("sale"), items: [{ finishedJewelleryId: m.pieceIds[0], sellingPrice: "90000.00", gstRatePercent: 0, taxType: "EXCLUSIVE" }],
          }),
        TX
      );
    const [r, s] = await Promise.allSettled([reverse(added.correction.id), sellIt()]);
    expect(s.status).toBe("fulfilled");
    const piece = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: m.pieceIds[0] } });
    const line = await prisma.finishedJewellerySaleLine.findFirstOrThrow({ where: { finishedJewelleryId: piece.id } });
    expect(line.cogsAmount.toFixed(2)).toBe(new Decimal(piece.metalCost).plus(piece.diamondCost).plus(piece.labourAllocated).toFixed(2));
    expect(piece.labourAllocated.toFixed(2)).toBe(r.status === "fulfilled" ? "0.00" : "600.00");
    await reconcile1330();
  }, 60_000);

  it("refuses non-Owner, a short reason, and a correction that is not a missing-charges one", async () => {
    const m = await makeReceipt("Pendant reverse validation", [10]);
    const added = await addCharges(m.receiptId, { labourCharge: "100.00" });
    await expect(prisma.$transaction((tx) => reverseReceiptChargeCorrection(tx, { correctionId: added.correction.id, reason: "long enough reason", owner: { id: ownerId, role: "STAFF" }, ...FY }), TX)).rejects.toThrow(/Only the Owner/);
    await expect(reverse(added.correction.id, "short")).rejects.toThrow(/at least 10 characters/);
    const other = await prisma.correction.create({
      data: { correctionCode: `X-${Date.now()}`, entityType: "VOUCHER", entityId: "x", entityLabel: "x", mode: "REVALUE", state: "POSTED", reason: "x", originalSnapshot: {}, correctedSnapshot: {}, impactPreview: {}, preparedByUserId: ownerId },
    });
    await expect(reverse(other.id)).rejects.toThrow(/not a missing-charges correction/);
    expect((await snapshotOf(m)).pieces[0].labourAllocated.toFixed(2)).toBe("100.00");
    await reconcile1330();
  });

  it("after a reversal the same amount can be added again (fresh key) and behaves the same", async () => {
    const m = await makeReceipt("Pendant re-add", [10]);
    const first = await addCharges(m.receiptId, { labourCharge: "250.00" });
    await reverse(first.correction.id);
    const again = await addCharges(m.receiptId, { labourCharge: "250.00" });
    expect(again.replayed).toBe(false);
    expect((await snapshotOf(m)).pieces[0].labourAllocated.toFixed(2)).toBe("250.00");
    expect((await snapshotOf(m)).job.totalLabourCharge.toFixed(2)).toBe("250.00");
    await reconcile1330();
  });
});

// ---------------------------------------------------------------------------
// 6. Correction error type, timing
// ---------------------------------------------------------------------------
describe("errors and timing", () => {
  it("refusals are CorrectionErrors (the action shows their text), not generic failures", async () => {
    const m = await makeReceipt("Pendant error type", [10]);
    await expect(addCharges(m.receiptId, {})).rejects.toBeInstanceOf(CorrectionError);
  });

  it("posting and reversing finish far inside the correction transaction timeout", async () => {
    const m = await makeReceipt("Pendant timing", [7, 10, 13]);
    const t0 = Date.now();
    const added = await addCharges(m.receiptId, { labourCharge: "900.00", settingCharge: "90.00" });
    const postMs = Date.now() - t0;
    const t1 = Date.now();
    await reverse(added.correction.id);
    const reverseMs = Date.now() - t1;
    console.log(`Missing-charges timings — post: ${postMs}ms; reverse: ${reverseMs}ms`);
    expect(postMs).toBeLessThan(5_000);
    expect(reverseMs).toBeLessThan(5_000);
  });
});
