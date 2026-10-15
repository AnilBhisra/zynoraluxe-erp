/**
 * Customer bill — Staff billing, piece-wise bills, one live bill per piece,
 * stale previews, double / concurrent submits, credit races and Owner-only
 * reversal. Disposable scratch database only (shared guard; truncates
 * business tables).
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "", role: "OWNER" as "OWNER" | "STAFF", name: "Owner", email: "owner@test" } }));
vi.mock("@/lib/auth/dal", () => ({
  requireUser: async () => auth.user,
  requireOwner: async () => {
    if (auth.user.role !== "OWNER") throw new Error("REDIRECT:/unauthorized");
    return auth.user;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { billCustomerJewelleryAction, previewCustomerJewelleryBillAction, reverseCustomerJewelleryBillAction } from "@/app/actions/customerGold";
import { postCustomerGoldTransfer, receiveCustomerGold } from "@/lib/jewellery/customerGold";
import {
  billablePiecesInTx,
  billCustomerJewellery,
  planCustomerJewelleryBill,
  purchaseCustomerGold,
  reverseCustomerJewelleryBill,
  type CustomerJewelleryBillInput,
} from "@/lib/jewellery/customerGoldCommercial";
import { receiveWithCustomerGold } from "@/lib/jewellery/customerGoldJobReceipt";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { createJewelleryJob, postOpeningMetalStock } from "@/lib/jewellery/posting";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-12T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };
let ownerId: string;
let staffId: string;
let custA: string;
let custB: string;
let karigar: string;
let g24: string;
let seq = 0;
const key = (l: string) => `cbp-${l}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const staff = () => ({ id: staffId, role: "STAFF" as const });

async function balanced() {
  const [r] = await prisma.$queryRawUnsafe<{ tb: string; unbalanced: number }[]>(
    `select (select coalesce(sum(debit - credit), 0)::numeric(14,2)::text from journal_entries) tb,
            (select count(*)::int from (select v.id from vouchers v left join journal_entries j on j."voucherId" = v.id group by v.id having coalesce(sum(j.debit),0) <> coalesce(sum(j.credit),0) or count(j.id) = 0) t) unbalanced`
  );
  expect(r).toEqual({ tb: "0.00", unbalanced: 0 });
  for (const l of (await reconcileMetalLedger(prisma)).lines) expect([l.accountCode, l.difference.toFixed(2)]).toEqual([l.accountCode, "0.00"]);
}

/** A completed Customer-gold job with `n` Customer-owned pieces. */
async function customerJob(customerId: string, name: string, n: number) {
  await prisma.$transaction((tx) => receiveCustomerGold(tx, { customerId, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: String(n), deductionWeight: null, reason: "Customer's own gold", declaredValue: null, idempotencyKey: key("in"), actor: owner() }), TX);
  await prisma.$transaction((tx) => postCustomerGoldTransfer(tx, { kind: "ISSUE_TO_KARIGAR", customerId, karigarId: karigar, all: true, purityId: g24, finenessPercent: "99.900", entryDate: DATE, reason: "To Karigar", idempotencyKey: key("mv"), actor: owner() } as Parameters<typeof postCustomerGoldTransfer>[1]), TX);
  const job = await prisma.$transaction((tx) => createJewelleryJob(tx, { customerId, jewelleryType: "RING", designName: name, karigarId: karigar, issueDate: DATE, quantity: n, createdByUserId: ownerId, idempotencyKey: key("job") }), TX);
  await prisma.$transaction(
    (tx) =>
      receiveWithCustomerGold(tx, {
        ...FY, jobId: job.id, receiveDate: DATE,
        outputs: Array.from({ length: n }, () => ({ jewelleryType: "RING" as const, quantity: 1, netMetalWeight: "1.001", metalType: "GOLD" as const, purityId: g24, diamondIds: [], qcStatus: "PASSED" as const })),
        diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
        alloy: { includedGrossWeight: "0" }, labourCharge: 0, makingCharge: "500.00", settingCharge: 0, platingCharge: 0, otherExpense: 0,
        markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
        customerGoldSource: { purityId: g24, finenessPercent: "99.900" }, actor: owner(),
      }),
    TX
  );
  const pieces = await prisma.finishedJewellery.findMany({ where: { jobId: job.id }, orderBy: { finishedCode: "asc" } });
  return { jobId: job.id, pieces: pieces.map((p) => p.id), codes: pieces.map((p) => p.finishedCode) };
}

const input = (jobId: string, over: Partial<CustomerJewelleryBillInput> = {}): CustomerJewelleryBillInput => ({
  jobId, billDate: DATE, makingCharge: "1000.00", gstTreatment: "CGST_SGST", gstRatePercent: "3", ...over,
});
const plan = (i: CustomerJewelleryBillInput) => prisma.$transaction((tx) => planCustomerJewelleryBill(tx, i), TX);
async function bill(i: CustomerJewelleryBillInput, actor: { id: string; role: "OWNER" | "STAFF" } = staff(), k = key("bill")) {
  const p = await plan(i);
  return prisma.$transaction((tx) => billCustomerJewellery(tx, { ...i, idempotencyKey: k, expectedFingerprint: p.fingerprint, actor, ...FY }), TX);
}
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  process.env.SESSION_SECRET ??= "customer-bill-test-secret-0123456789abcdef";
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  staffId = (await prisma.user.findFirstOrThrow({ where: { role: "STAFF" } })).id;
  const party = async (name: string, type: "CUSTOMER" | "KARIGAR") => (await prisma.party.create({ data: { name, type, createdByUserId: ownerId } })).id;
  custA = await party("CBP Customer A", "CUSTOMER");
  custB = await party("CBP Customer B", "CUSTOMER");
  karigar = await party("CBP Karigar", "KARIGAR");
  g24 = (await prisma.metalPurity.upsert({ where: { metalType_displayName: { metalType: "GOLD", displayName: "CBP 24K" } }, create: { metalType: "GOLD", displayName: "CBP 24K", finenessPercent: "99.900", createdByUserId: ownerId }, update: {} })).id;
  await prisma.$transaction((tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g24, grossWeight: "50.000", costValue: "350000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }), TX);
}, 120_000);

afterAll(async () => {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  await prisma.$disconnect();
});

describe("Staff bills selected pieces; one live bill per piece", () => {
  it("Staff bills piece 1, then piece 2; a piece already billed is refused; the actor is the Staff user; vouchers balance", async () => {
    const j = await customerJob(custA, "Two rings", 2);
    expect((await plan(input(j.jobId))).pieces.map((p) => p.finishedCode)).toEqual(j.codes); // default: every unbilled piece
    const b1 = await bill(input(j.jobId, { finishedJewelleryIds: [j.pieces[0]] }));
    expect(b1.bill.createdByUserId).toBe(staffId);
    expect((await prisma.customerJewelleryBillPiece.findMany({ where: { billId: b1.bill.id } })).map((l) => [l.finishedJewelleryId, l.activeFinishedJewelleryId])).toEqual([[j.pieces[0], j.pieces[0]]]);
    expect([new Decimal(b1.bill.taxableValue).toFixed(2), new Decimal(b1.bill.taxAmount).toFixed(2), new Decimal(b1.bill.grandTotal).toFixed(2)]).toEqual(["1000.00", "30.00", "1030.00"]);
    await expect(plan(input(j.jobId, { finishedJewelleryIds: [j.pieces[0]] }))).rejects.toThrow(new RegExp(`${j.codes[0]} is already billed \\(${b1.bill.billCode}\\)`));
    expect((await plan(input(j.jobId))).pieces.map((p) => p.finishedCode)).toEqual([j.codes[1]]); // the default now skips the billed piece
    const b2 = await bill(input(j.jobId, { finishedJewelleryIds: [j.pieces[1]] }));
    await expect(plan(input(j.jobId))).rejects.toThrow(/Every Customer-owned piece .* is already on a live bill/);
    const billable = await prisma.$transaction((tx) => billablePiecesInTx(tx, j.jobId), TX);
    expect(billable.pieces.map((p) => p.billCode)).toEqual([b1.bill.billCode, b2.bill.billCode]);
    // The DB refuses a second live line for the same piece even if the app check were bypassed.
    await expect(prisma.customerJewelleryBillPiece.create({ data: { billId: b2.bill.id, finishedJewelleryId: j.pieces[0], activeFinishedJewelleryId: j.pieces[0] } })).rejects.toThrow();
    await expect(prisma.customerJewelleryBillPiece.create({ data: { billId: b2.bill.id, finishedJewelleryId: j.pieces[0], activeFinishedJewelleryId: j.pieces[1] } })).rejects.toThrow(); // active must be its own piece
    await balanced();
  });

  it("double-click (same key) posts once; two simultaneous bills for the same piece: exactly one wins", async () => {
    const j = await customerJob(custA, "Race ring", 1);
    const i = input(j.jobId);
    const p = await plan(i);
    const k = key("dbl");
    const twice = await Promise.allSettled([1, 2].map(() => prisma.$transaction((tx) => billCustomerJewellery(tx, { ...i, idempotencyKey: k, expectedFingerprint: p.fingerprint, actor: staff(), ...FY }), TX)));
    expect(await prisma.customerJewelleryBill.count({ where: { jobId: j.jobId } })).toBe(1);
    expect(twice.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);

    const j2 = await customerJob(custA, "Race ring 2", 1);
    const i2 = input(j2.jobId);
    const p2 = await plan(i2);
    const race = await Promise.allSettled(["r1", "r2"].map((l) => prisma.$transaction((tx) => billCustomerJewellery(tx, { ...i2, idempotencyKey: key(l), expectedFingerprint: p2.fingerprint, actor: staff(), ...FY }), TX)));
    expect(race.filter((r) => r.status === "fulfilled").length).toBe(1);
    expect(await prisma.customerJewelleryBill.count({ where: { jobId: j2.jobId, status: "POSTED" } })).toBe(1);
    await balanced();
  });

  it("a stale preview (amounts or pieces changed) is refused; nothing saved", async () => {
    const j = await customerJob(custA, "Stale ring", 2);
    const p = await plan(input(j.jobId, { finishedJewelleryIds: [j.pieces[0]] }));
    await expect(
      prisma.$transaction((tx) => billCustomerJewellery(tx, { ...input(j.jobId, { finishedJewelleryIds: [j.pieces[0]], makingCharge: "999.00" }), idempotencyKey: key("st"), expectedFingerprint: p.fingerprint, actor: staff(), ...FY }), TX)
    ).rejects.toThrow(/changed after this preview/);
    await expect(
      prisma.$transaction((tx) => billCustomerJewellery(tx, { ...input(j.jobId), idempotencyKey: key("st2"), expectedFingerprint: p.fingerprint, actor: staff(), ...FY }), TX)
    ).rejects.toThrow(/changed after this preview/);
    expect(await prisma.customerJewelleryBill.count({ where: { jobId: j.jobId } })).toBe(0);
  });

  it("Owner reverses (Staff cannot); the piece is free again and can be billed correctly", async () => {
    const j = await customerJob(custA, "Reverse ring", 1);
    const b = await bill(input(j.jobId));
    await expect(prisma.$transaction((tx) => reverseCustomerJewelleryBill(tx, { billId: b.bill.id, reason: "Wrong making charge entered", actor: staff(), ...FY }), TX)).rejects.toThrow(/Only the Owner/);
    await prisma.$transaction((tx) => reverseCustomerJewelleryBill(tx, { billId: b.bill.id, reason: "Wrong making charge entered", actor: owner(), ...FY }), TX);
    expect((await prisma.customerJewelleryBillPiece.findFirstOrThrow({ where: { billId: b.bill.id } })).activeFinishedJewelleryId).toBeNull();
    const again = await bill(input(j.jobId, { makingCharge: "1200.00" }));
    expect(new Decimal(again.bill.taxableValue).toFixed(2)).toBe("1200.00");
    await balanced();
  });

  it("an older whole-job bill (no piece lines) still covers the job: piece-wise billing is refused until it is reversed", async () => {
    const j = await customerJob(custA, "Legacy ring", 1);
    const b = await bill(input(j.jobId), owner());
    await prisma.customerJewelleryBillPiece.deleteMany({ where: { billId: b.bill.id } }); // simulate a bill posted before piece lines (scratch DB only)
    await expect(plan(input(j.jobId))).rejects.toThrow(new RegExp(`already billed as a whole by ${b.bill.billCode}`));
    await prisma.$transaction((tx) => reverseCustomerJewelleryBill(tx, { billId: b.bill.id, reason: "Rebill piece by piece", actor: owner(), ...FY }), TX);
    expect((await bill(input(j.jobId))).bill.status).toBe("POSTED");
  });

  it("a job needing correction, another job's piece and a reversed-receipt piece cannot be billed", async () => {
    const j = await customerJob(custB, "Blocked ring", 1);
    const other = await customerJob(custB, "Other ring", 1);
    await expect(plan(input(j.jobId, { finishedJewelleryIds: other.pieces }))).rejects.toThrow(/not a Customer-owned piece of this job/);
    await prisma.jewelleryJob.update({ where: { id: j.jobId }, data: { status: "NEEDS_CORRECTION" } });
    await expect(plan(input(j.jobId))).rejects.toThrow(/needs a correction first/);
    await prisma.jewelleryJob.update({ where: { id: j.jobId }, data: { status: "COMPLETED" } });
  });
});

describe("Owner-approved credit: live, never negative, never used twice", () => {
  it("Staff applies available credit; more than available is refused; two simultaneous bills cannot both use the same credit", async () => {
    await prisma.$transaction(
      (tx) =>
        purchaseCustomerGold(tx, {
          customerId: custB, purchaseDate: DATE, purityId: g24, source: "DIRECT", grossWeight: "1.001", rateBasis: "PER_FINE_GRAM", rate: "7000",
          settlement: "CREDIT_TO_INVOICE", reason: "Old gold exchanged against the new order", reference: "Slip 77", approved: true,
          idempotencyKey: key("buy"), actor: owner(), ...FY,
        }),
      TX
    ); // ₹7,000.00 credit
    const j1 = await customerJob(custB, "Credit ring 1", 1);
    const j2 = await customerJob(custB, "Credit ring 2", 1);
    await expect(plan(input(j1.jobId, { makingCharge: "9000.00", creditToApply: "7000.01" }))).rejects.toThrow(/has only ₹7000\.00 of gold-purchase credit/);
    const i1 = input(j1.jobId, { makingCharge: "9000.00", creditToApply: "7000.00" });
    const i2 = input(j2.jobId, { makingCharge: "9000.00", creditToApply: "7000.00" });
    const [p1, p2] = [await plan(i1), await plan(i2)];
    const race = await Promise.allSettled([
      prisma.$transaction((tx) => billCustomerJewellery(tx, { ...i1, idempotencyKey: key("c1"), expectedFingerprint: p1.fingerprint, actor: staff(), ...FY }), TX),
      prisma.$transaction((tx) => billCustomerJewellery(tx, { ...i2, idempotencyKey: key("c2"), expectedFingerprint: p2.fingerprint, actor: staff(), ...FY }), TX),
    ]);
    expect(race.filter((r) => r.status === "fulfilled").length).toBe(1);
    const applied = await prisma.customerJewelleryBill.aggregate({ where: { customerId: custB, status: "POSTED" }, _sum: { creditApplied: true } });
    expect(new Decimal(applied._sum.creditApplied ?? 0).toFixed(2)).toBe("7000.00");
    await balanced();
  });
});

describe("server actions (Staff)", () => {
  it("Staff preview and post through the actions get Customer-facing figures only; reversal is refused", async () => {
    const j = await customerJob(custA, "Action ring", 1);
    auth.user = { id: staffId, role: "STAFF", name: "Staff", email: "staff@test" };
    try {
      const form = { jobId: j.jobId, pieceIdsJson: JSON.stringify(j.pieces), billDate: "2026-10-12", makingCharge: "1500", gstTreatment: "IGST", gstRatePercent: "3", creditToApply: "", description: "" };
      const pv = await previewCustomerJewelleryBillAction(undefined, fd(form));
      expect(pv.preview).toMatchObject({ pieces: j.codes, taxableValue: "1500.00", taxAmount: "45.00", grandTotal: "1545.00", amountDue: "1545.00" });
      expect(Object.keys(pv.preview!).sort()).toEqual(["amountDue", "creditApplied", "creditAvailable", "customerName", "fingerprint", "grandTotal", "jobCode", "pieces", "taxAmount", "taxableValue"]);
      const noPreview = await billCustomerJewelleryAction(undefined, fd({ ...form, idempotencyKey: key("a0"), fingerprint: "" }));
      expect(noPreview?.error).toMatch(/changed after this preview/);
      const saved = await billCustomerJewelleryAction(undefined, fd({ ...form, idempotencyKey: key("a1"), fingerprint: pv.preview!.fingerprint }));
      expect(saved?.code).toMatch(/^ZL-/);
      expect(JSON.stringify(saved)).not.toMatch(/cost|cogs|1340|5200/i);
      const billRow = await prisma.customerJewelleryBill.findUniqueOrThrow({ where: { billCode: saved!.code! } });
      expect(billRow.createdByUserId).toBe(staffId);
      await expect(reverseCustomerJewelleryBillAction(undefined, fd({ billId: billRow.id, reason: "Staff trying to reverse" }))).rejects.toThrow(/unauthorized/);
    } finally {
      auth.user = { id: ownerId, role: "OWNER", name: "Owner", email: "owner@test" };
    }
  });
});
