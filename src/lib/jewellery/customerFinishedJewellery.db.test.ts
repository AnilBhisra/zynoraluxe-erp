/**
 * Customer Account → Finished Jewellery: only that Customer's pieces, the
 * right billing / delivery / location state at every step, summaries that
 * match the rows, no cost in the data. Disposable scratch database only.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { postCustomerGoldTransfer, receiveCustomerGold } from "@/lib/jewellery/customerGold";
import { billCustomerJewellery, deliverCustomerJewellery, planCustomerJewelleryBill, reverseCustomerJewelleryDelivery } from "@/lib/jewellery/customerGoldCommercial";
import { receiveWithCustomerGold } from "@/lib/jewellery/customerGoldJobReceipt";
import { reverseCustomerGoldJobReceipt } from "@/lib/jewellery/customerGoldReceiptReversal";
import { customerFinishedJewellery } from "@/lib/jewellery/customerFinishedJewellery";
import { CUSTOMER_PIECE_FILTERS, matchesPieceFilter } from "@/lib/jewellery/customerFinishedJewelleryRules";
import { postFinishedJewellerySale } from "@/lib/jewellery/finishedSalesPosting";
import { postCustodyOperation } from "@/lib/jewellery/karigarCustody";
import { createJewelleryJob, postOpeningMetalStock } from "@/lib/jewellery/posting";
import { receiveWithCustodyAllocation } from "@/lib/jewellery/receiptCustody";
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
const key = (l: string) => `cfj-${l}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const staff = () => ({ id: staffId, role: "STAFF" as const });
const view = (c: string) => customerFinishedJewellery(prisma, c);
const row = async (c: string, code: string) => (await view(c)).rows.find((r) => r.finishedCode === code)!;

async function customerJob(customerId: string, name: string, n: number) {
  await prisma.$transaction((tx) => receiveCustomerGold(tx, { customerId, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: String(n), deductionWeight: null, reason: "Customer's own gold", declaredValue: null, idempotencyKey: key("in"), actor: owner() }), TX);
  await prisma.$transaction((tx) => postCustomerGoldTransfer(tx, { kind: "ISSUE_TO_KARIGAR", customerId, karigarId: karigar, all: true, purityId: g24, finenessPercent: "99.900", entryDate: DATE, reason: "To Karigar", idempotencyKey: key("mv"), actor: owner() } as Parameters<typeof postCustomerGoldTransfer>[1]), TX);
  const job = await prisma.$transaction((tx) => createJewelleryJob(tx, { customerId, jewelleryType: "RING", designName: name, karigarId: karigar, issueDate: DATE, quantity: n, createdByUserId: ownerId, idempotencyKey: key("job") }), TX);
  const r = await prisma.$transaction(
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
  return { jobId: job.id, receiptId: r.receipt.id, ids: pieces.map((p) => p.id), codes: pieces.map((p) => p.finishedCode) };
}
async function staffBill(jobId: string, ids: string[]) {
  const i = { jobId, finishedJewelleryIds: ids, billDate: DATE, makingCharge: "800.00", gstTreatment: "NONE" as const };
  const p = await prisma.$transaction((tx) => planCustomerJewelleryBill(tx, i), TX);
  return prisma.$transaction((tx) => billCustomerJewellery(tx, { ...i, idempotencyKey: key("b"), expectedFingerprint: p.fingerprint, actor: staff(), ...FY }), TX);
}
const deliver = (jobId: string, ids: string[]) =>
  prisma.$transaction((tx) => deliverCustomerJewellery(tx, { jobId, finishedJewelleryIds: ids, deliveryDate: DATE, receivedByName: "Customer in person", idempotencyKey: key("d"), actor: staff(), ...FY }), TX);

let A: Awaited<ReturnType<typeof customerJob>>;
let B: Awaited<ReturnType<typeof customerJob>>;
let companyPiece = "";

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  process.env.SESSION_SECRET ??= "customer-pieces-test-secret-0123456789abcdef";
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  staffId = (await prisma.user.findFirstOrThrow({ where: { role: "STAFF" } })).id;
  const party = async (name: string, type: "CUSTOMER" | "KARIGAR") => (await prisma.party.create({ data: { name, type, createdByUserId: ownerId } })).id;
  custA = await party("CFJ Customer A", "CUSTOMER");
  custB = await party("CFJ Customer B", "CUSTOMER");
  karigar = await party("CFJ Karigar", "KARIGAR");
  g24 = (await prisma.metalPurity.upsert({ where: { metalType_displayName: { metalType: "GOLD", displayName: "CFJ 24K" } }, create: { metalType: "GOLD", displayName: "CFJ 24K", finenessPercent: "99.900", createdByUserId: ownerId }, update: {} })).id;
  await prisma.$transaction((tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g24, grossWeight: "50.000", costValue: "350000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }), TX);
  A = await customerJob(custA, "A rings", 3);
  B = await customerJob(custB, "B ring", 1);
  // A Company-gold piece made for Customer A.
  await prisma.$transaction((tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: karigar, purityId: g24, fineWeight: "3", entryDate: DATE, reason: "Company gold", idempotencyKey: key("ci"), owner: owner(), ...FY }), TX);
  const cjob = await prisma.$transaction((tx) => createJewelleryJob(tx, { customerId: custA, jewelleryType: "PENDANT", designName: "Company pendant for A", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("cj") }), TX);
  const cr = await prisma.$transaction(
    (tx) =>
      receiveWithCustodyAllocation(tx, {
        ...FY, jobId: cjob.id, receiveDate: DATE,
        outputs: [{ jewelleryType: "PENDANT", quantity: 1, netMetalWeight: "2.002", metalType: "GOLD", purityId: g24, diamondIds: [], qcStatus: "PASSED" }],
        diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
        alloy: { includedGrossWeight: "0" }, labourCharge: 0, makingCharge: "300.00", settingCharge: 0, platingCharge: 0, otherExpense: 0,
        markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("co"), createdByUserId: ownerId,
        sourcePurityId: g24, actor: owner(),
      }),
    TX
  );
  companyPiece = (await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: cr.receipt.id } })).finishedCode;
}, 240_000);

afterAll(async () => {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  await prisma.$disconnect();
});

describe("Customer Account → Finished Jewellery", () => {
  it("only the Customer's own pieces (A never sees B's, and the reverse)", async () => {
    const a = await view(custA);
    const b = await view(custB);
    expect(a.rows.map((r) => r.finishedCode).sort()).toEqual([...A.codes, companyPiece].sort());
    expect(b.rows.map((r) => r.finishedCode)).toEqual(B.codes);
    expect(a.rows.some((r) => B.codes.includes(r.finishedCode))).toBe(false);
    expect(JSON.stringify(b)).not.toContain(A.codes[0]);
  });

  it("starts unbilled and ready; ownership is Customer / Company; no cost anywhere in the data", async () => {
    const r = await row(custA, A.codes[0]);
    expect([r.ownership, r.billing, r.delivery, r.location, r.canCreateBill, r.netWeight, r.fineWeight, r.purity]).toEqual(["CUSTOMER", "UNBILLED", "READY", "FINISHED_STOCK", true, "1.001", "1.000", "CFJ 24K"]);
    const c = await row(custA, companyPiece);
    expect([c.ownership, c.billing, c.location, c.canCreateBill]).toEqual(["COMPANY", "UNBILLED", "FINISHED_STOCK", false]);
    expect(JSON.stringify(await view(custA))).not.toMatch(/cost|cogs|labour|margin|profit|metalCost|diamondCost/i);
  });

  it("a Staff bill makes the row Billed with the bill number at once; delivery makes it Delivered and the counts move", async () => {
    const before = (await view(custA)).summary;
    const b = await staffBill(A.jobId, [A.ids[0]]);
    const billed = await row(custA, A.codes[0]);
    expect([billed.billing, billed.bill?.code, billed.location, billed.canCreateBill]).toEqual(["BILLED", b.bill.billCode, "FINISHED_STOCK", false]);
    const mid = (await view(custA)).summary;
    expect([mid.unbilled, mid.billedUndelivered]).toEqual([before.unbilled - 1, before.billedUndelivered + 1]);
    const d = await deliver(A.jobId, [A.ids[0]]);
    const done = await row(custA, A.codes[0]);
    expect([done.delivery, done.location, done.deliveryRef?.code]).toEqual(["DELIVERED", "DELIVERED", d.delivery.deliveryCode]);
    const after = (await view(custA)).summary;
    expect([after.readyUndelivered, after.delivered, after.billedUndelivered]).toEqual([mid.readyUndelivered - 1, mid.delivered + 1, mid.billedUndelivered - 1]);
  });

  it("a reversed delivery shows 'Delivery reversed' and is ready again", async () => {
    await deliver(A.jobId, [A.ids[1]]);
    const del = await prisma.customerJewelleryDelivery.findFirstOrThrow({ where: { jobId: A.jobId, items: { some: { finishedJewelleryId: A.ids[1] } } }, orderBy: { createdAt: "desc" } });
    await prisma.$transaction((tx) => reverseCustomerJewelleryDelivery(tx, { deliveryId: del.id, reason: "Delivered by mistake", actor: owner(), ...FY }), TX);
    const r = await row(custA, A.codes[1]);
    expect([r.delivery, r.location, r.billing]).toEqual(["DELIVERY_REVERSED", "FINISHED_STOCK", "UNBILLED"]);
  });

  it("a Company piece sold to the Customer shows Billed with the sale code and Sold", async () => {
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { finishedCode: companyPiece } });
    const s = await prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          customerId: custA, saleDate: DATE, date: DATE, gstTreatment: "NONE", ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId, idempotencyKey: key("sale"),
          items: [{ finishedJewelleryId: piece.id, sellingPrice: "30000", gstRatePercent: "0", taxType: "EXCLUSIVE" }],
        }),
      TX
    );
    const r = await row(custA, companyPiece);
    expect([r.billing, r.bill?.code, r.bill?.kind, r.location, r.delivery]).toEqual(["BILLED", s.sale.saleCode, "SALE", "SOLD", "DELIVERED"]);
  });

  it("a reversed receipt shows 'Receipt reversed', never as available stock", async () => {
    await prisma.$transaction((tx) => reverseCustomerGoldJobReceipt(tx, { receiptId: B.receiptId, reason: "Wrong weight entered at receipt", idempotencyKey: key("rr"), actor: owner(), ...FY }), TX);
    const r = await row(custB, B.codes[0]);
    expect([r.location, r.delivery, r.billing, r.canCreateBill]).toEqual(["RECEIPT_REVERSED", "RECEIPT_REVERSED", "NOT_APPLICABLE", false]);
    const v = await view(custB);
    expect(v.summary.readyUndelivered).toBe(0);
  });

  it("every filter returns exactly the rows its rule selects; the summary matches the rows", async () => {
    const all = (await view(custA)).rows;
    for (const f of CUSTOMER_PIECE_FILTERS) {
      const got = (await customerFinishedJewellery(prisma, custA, f)).rows.map((r) => r.id).sort();
      expect([f, got]).toEqual([f, all.filter((r) => matchesPieceFilter(r, f)).map((r) => r.id).sort()]);
    }
    const s = (await view(custA)).summary;
    expect(s.delivered).toBe(all.filter((r) => r.delivery === "DELIVERED").length);
    expect(s.unbilled).toBe(all.filter((r) => r.billing === "UNBILLED" || r.billing === "BILL_REVERSED").length);
  });
});
