/**
 * Real-database acceptance for the Diamond-only Sale
 * (JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §13): an available polished stone,
 * a whole packet or part of a packet sold straight to a Customer, with exact
 * amounts, exact carrying cost (Dr 5210 / Cr 1220), no double sale even under
 * concurrency, Owner-only cancel / return that put back exactly what left,
 * and no stock cost in anything a Staff user receives.
 * Isolated test database only (this file refuses anything else).
 *
 * Headline figure: 2.500 CT × ₹20,000.00/CT = ₹50,000.00.
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

import { cancelDiamondSaleAction, postDiamondSaleAction, previewDiamondSaleAction } from "@/app/actions/diamondSale";
import { cancelVoucherAction } from "@/app/actions/vouchers";
import { Decimal, ZERO } from "@/lib/accounting/money";
import { getPartyLedger, getProfitAndLoss, listVouchers } from "@/lib/accounting/reports";
import { prisma } from "@/lib/db/prisma";
import { cancelDiamondSale, listDiamondSales, planDiamondSale, postDiamondSale, returnDiamondSaleLines, type DiamondSaleInput, type DiamondSaleLineInput } from "@/lib/diamond/diamondSale";
import { sumPacketMovements } from "@/lib/diamond/packets";
import { createPolishedPurchase } from "@/lib/diamond/polishedPurchase";
import { createRoughLotWithPieces, issueRoughToKarigar, receivePolishedDiamonds } from "@/lib/diamond/posting";
import { CLEAR_BUSINESS_DATA_SQL } from "../../../test/setup/businessTables";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-14T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let staffId: string;
let supplierId: string;
let manufacturerId: string;
let cashId: string;
let bankId: string;
let baseline1220: string;
let seq = 0;
const key = (label: string) => `ds-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const staff = () => ({ id: staffId, role: "STAFF" as const });

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  staffId = (await prisma.user.findFirstOrThrow({ where: { role: "STAFF" } })).id;
  supplierId = (await prisma.party.create({ data: { name: "DS Supplier", type: "SUPPLIER", createdByUserId: ownerId } })).id;
  manufacturerId = (await prisma.party.create({ data: { name: "DS Manufacturer", type: "MANUFACTURER", createdByUserId: ownerId } })).id;
  cashId = (await prisma.paymentAccount.findFirstOrThrow({ where: { method: "CASH", isActive: true } })).id;
  bankId = (await prisma.paymentAccount.findFirstOrThrow({ where: { method: "BANK", isActive: true } })).id;
  baseline1220 = (await accountBalance("1220")).toFixed(2);
}, 90_000);

afterAll(async () => {
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function accountBalance(code: string, voucherId?: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const t = await prisma.journalEntry.aggregate({ where: { accountId: account.id, ...(voucherId ? { voucherId } : {}) }, _sum: { debit: true, credit: true } });
  return new Decimal(t._sum.debit ?? 0).minus(t._sum.credit ?? 0);
}
async function paymentAccountBalance(id: string) {
  const pa = await prisma.paymentAccount.findUniqueOrThrow({ where: { id }, select: { accountId: true } });
  const t = await prisma.journalEntry.aggregate({ where: { accountId: pa.accountId }, _sum: { debit: true, credit: true } });
  return new Decimal(t._sum.debit ?? 0).minus(t._sum.credit ?? 0);
}
async function voucherLines(voucherId: string) {
  const lines = await prisma.journalEntry.findMany({ where: { voucherId }, include: { account: { select: { code: true } } } });
  return lines
    .map((l) => `${l.account.code} ${new Decimal(l.debit).greaterThan(0) ? "Dr" : "Cr"} ${new Decimal(l.debit).plus(l.credit).toFixed(2)}`)
    .sort();
}
async function packetBalance(packetId: string) {
  const movements = await prisma.polishedPacketMovement.findMany({ where: { packetId } });
  return sumPacketMovements(movements.map((m) => ({ type: m.type, pieces: m.pieces, carat: m.carat.toFixed(3), costValue: m.costValue.toFixed(2) })));
}
/** 1220 = AVAILABLE single stones + every packet's live balance; every voucher balanced. */
async function reconcile1220() {
  const stones = await prisma.polishedDiamond.findMany({ where: { status: "AVAILABLE" }, select: { allocatedCost: true } });
  const stoneValue = stones.reduce((s, d) => s.plus(d.allocatedCost), ZERO);
  let packetValue = ZERO;
  for (const p of await prisma.polishedPacket.findMany({ where: { status: { not: "CANCELLED" } }, select: { id: true } })) packetValue = packetValue.plus((await packetBalance(p.id)).costValue);
  expect((await accountBalance("1220")).minus(baseline1220).toFixed(2)).toBe(stoneValue.plus(packetValue).toFixed(2));
  const unbalanced = await prisma.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`);
  expect(unbalanced[0].n).toBe(0);
}

/** Manufactured single stones: ₹80,000 of rough, no labour, cost split by carat across the outputs. */
async function makeStones(carats: string[]) {
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
        totalPurchaseCost: "80000.00",
        gstTreatment: "NONE",
        idempotencyKey: key("rough"),
        createdByUserId: ownerId,
        pieces: [{ carat: "100.000" }],
      }),
    TX
  );
  const piece = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
  const job = await prisma.$transaction(
    (tx) => issueRoughToKarigar(tx, { ...FY, karigarId: manufacturerId, roughPieceIds: [piece.id], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key("issue"), createdByUserId: ownerId }),
    TX
  );
  const received = await prisma.$transaction(
    (tx) =>
      receivePolishedDiamonds(tx, {
        ...FY,
        jobId: job.id,
        receiveDate: DATE,
        returnedRoughCarat: 0,
        labourCharge: 0,
        shape: "ROUND",
        markJobComplete: true,
        idempotencyKey: key("receipt"),
        createdByUserId: ownerId,
        outputs: carats.map((carat) => ({ kind: "STONE" as const, shape: "ROUND" as const, carat })),
      }),
    TX
  );
  return Promise.all(received.outputs.map((o) => prisma.polishedDiamond.findUniqueOrThrow({ where: { id: o.id } })));
}
async function buyPacket(pieces: number, carat: string, rate: string) {
  const bought = await prisma.$transaction(
    (tx) =>
      createPolishedPurchase(tx, {
        ...FY,
        purchaseDate: DATE,
        supplierId,
        currencyCode: "INR",
        exchangeRate: 1,
        supplierAmount: new Decimal(rate).times(carat).toFixed(2),
        gstTreatment: "NONE",
        brokerageTreatment: "NONE",
        idempotencyKey: key("purchase"),
        createdByUserId: ownerId,
        lines: [{ shape: "ROUND", sizeLabel: "1.5 mm", pieces, carat, rateBasis: "PER_CARAT", rate }],
      }),
    TX
  );
  return bought.packets[0];
}
async function customer(name: string, clearingEnabled = false) {
  return (await prisma.party.create({ data: { name: `${name} ${++seq}`, type: "CUSTOMER", clearingEnabled, createdByUserId: ownerId } })).id;
}
const stoneLine = (id: string, rate: string, more: Partial<DiamondSaleLineInput> = {}): DiamondSaleLineInput => ({ kind: "STONE", polishedDiamondId: id, pricing: "PER_CARAT", rate, ...more });
const packetLine = (id: string, pieces: number, carat: string, pricing: DiamondSaleLineInput["pricing"], rate: string, more: Partial<DiamondSaleLineInput> = {}): DiamondSaleLineInput => ({
  kind: "PACKET",
  packetId: id,
  pieces,
  carat,
  pricing,
  rate,
  ...more,
});
const saleInput = (customerId: string, lines: DiamondSaleLineInput[], more: Partial<DiamondSaleInput> = {}): DiamondSaleInput => ({ customerId, saleDate: DATE, gstTreatment: "NONE", lines, ...more });
const sell = (input: DiamondSaleInput, actor = owner(), k = key("sale")) => prisma.$transaction((tx) => postDiamondSale(tx, { ...input, idempotencyKey: k, actor, ...FY }), TX);
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

// ---------------------------------------------------------------------------
describe("Diamond-only Sale", () => {
  it("headline: 2.500 CT × ₹20,000.00/CT = ₹50,000.00 on credit — Dr AR / Cr Sales, Dr 5210 / Cr 1220 at the stone's own cost", async () => {
    const [stone] = await makeStones(["2.500", "2.500"]);
    expect(new Decimal(stone.allocatedCost).toFixed(2)).toBe("40000.00");
    const c = await customer("DS Credit Customer");
    const pnlBefore = await getProfitAndLoss();

    const plan = await prisma.$transaction((tx) => planDiamondSale(tx, saleInput(c, [stoneLine(stone.id, "20000")])), TX);
    expect(plan.lines[0].formula).toBe("2.500 CT × ₹20,000.00/CT = ₹50,000.00");
    expect(plan.totals.grandTotal.toFixed(2)).toBe("50000.00");
    expect(plan.totals.cogsTotal.toFixed(2)).toBe("40000.00");

    const r = await sell(saleInput(c, [stoneLine(stone.id, "20000")]));
    expect(r.replayed).toBe(false);
    expect(r.sale.saleCode).toMatch(/^ZL-DS-/);
    expect(await voucherLines(r.sale.voucherId)).toEqual(["1100 Dr 50000.00", "1220 Cr 40000.00", "4000 Cr 50000.00", "5210 Dr 40000.00"]);
    expect((await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: stone.id } })).status).toBe("SOLD");
    const mv = await prisma.stockMovement.findFirstOrThrow({ where: { polishedDiamondId: stone.id, type: "POLISHED_SALE_OUT" } });
    expect([mv.pieces, new Decimal(mv.carat).toFixed(3), new Decimal(mv.costValue).toFixed(2), mv.sourceDocument]).toEqual([1, "2.500", "40000.00", r.sale.saleCode]);

    // P&L: revenue +50,000, diamond COGS +40,000, gross profit +10,000.
    const pnl = await getProfitAndLoss();
    expect(pnl.grossSales.minus(pnlBefore.grossSales).toFixed(2)).toBe("50000.00");
    expect(pnl.diamondCogs.minus(pnlBefore.diamondCogs).toFixed(2)).toBe("40000.00");
    expect(pnl.grossProfit.minus(pnlBefore.grossProfit).toFixed(2)).toBe("10000.00");
    expect(pnl.netProfit.minus(pnlBefore.netProfit).toFixed(2)).toBe("10000.00");
    expect(pnl.manualSalesCount).toBe(pnlBefore.manualSalesCount); // a diamond sale is matched to its cost, not "manual"

    // Customer ledger: the receivable is the grand total.
    const ledger = await getPartyLedger(c);
    expect(ledger.map((l) => `${l.voucherNumber} Dr ${l.debit.toFixed(2)}`)).toEqual([`${(await prisma.voucher.findUniqueOrThrow({ where: { id: r.sale.voucherId } })).voucherNumber} Dr 50000.00`]);

    // Sales report kind filter.
    const ids = async (saleKind?: "JEWELLERY" | "DIAMOND" | "OTHER") => (await listVouchers({ viewerRole: "OWNER", types: ["SALE"], saleKind })).map((v) => v.id);
    expect(await ids("DIAMOND")).toContain(r.sale.voucherId);
    expect(await ids("JEWELLERY")).not.toContain(r.sale.voucherId);
    expect(await ids("OTHER")).not.toContain(r.sale.voucherId);
    expect(await ids()).toContain(r.sale.voucherId);
    await reconcile1220();
  }, 90_000);

  it("the same stone can never be sold twice: replay returns the saved sale, a second sale and a concurrent pair are refused", async () => {
    const [a, b] = await makeStones(["1.000", "1.500"]);
    const c = await customer("DS Double Customer");
    const k = key("replay");
    const first = await sell(saleInput(c, [stoneLine(a.id, "10000")]), owner(), k);
    const again = await sell(saleInput(c, [stoneLine(a.id, "10000")]), owner(), k);
    expect(again.replayed).toBe(true);
    expect(again.sale.id).toBe(first.sale.id);
    await expect(sell(saleInput(c, [stoneLine(a.id, "10000")]))).rejects.toThrow(/not available \(sold\)/);
    await expect(sell(saleInput(c, [stoneLine(b.id, "1"), stoneLine(b.id, "1")]))).rejects.toThrow(/chosen twice/);

    // Two simultaneous sales of stone b with different submission keys: exactly one posts.
    const results = await Promise.allSettled([sell(saleInput(c, [stoneLine(b.id, "10000")])), sell(saleInput(c, [stoneLine(b.id, "12000")]))]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.diamondSaleLine.count({ where: { polishedDiamondId: b.id } })).toBe(1);
    expect(await prisma.stockMovement.count({ where: { polishedDiamondId: b.id, type: "POLISHED_SALE_OUT" } })).toBe(1);
    await reconcile1220();
  }, 90_000);

  it("partial packet per piece, then the remainder at a fixed total: carat-share cost, the emptying line takes the exact remainder, packet EMPTY; cash and bank", async () => {
    // 3 pcs / 1.000 ct at ₹10,000/ct = ₹10,000.00 of cost.
    const packet = await buyPacket(3, "1.000", "10000");
    const c = await customer("DS Packet Customer");
    const cashBefore = await paymentAccountBalance(cashId);
    const bankBefore = await paymentAccountBalance(bankId);

    const part = await sell(saleInput(c, [packetLine(packet.id, 1, "0.333", "PER_PIECE", "5000")], { paymentAccountId: cashId }));
    const partLine = await prisma.diamondSaleLine.findFirstOrThrow({ where: { saleId: part.sale.id } });
    expect([new Decimal(partLine.baseAmount).toFixed(2), new Decimal(partLine.cogsAmount).toFixed(2)]).toEqual(["5000.00", "3330.00"]);
    expect(await voucherLines(part.sale.voucherId)).toEqual(expect.arrayContaining(["1220 Cr 3330.00", "4000 Cr 5000.00", "5210 Dr 3330.00"]));
    expect((await paymentAccountBalance(cashId)).minus(cashBefore).toFixed(2)).toBe("5000.00");
    expect((await packetBalance(packet.id)).pieces).toBe(2);

    // Over-quantity and "all pieces but not all carat" are refused before anything is written.
    await expect(sell(saleInput(c, [packetLine(packet.id, 3, "0.667", "FIXED", "100")]))).rejects.toThrow(/Only 2 piece/);
    await expect(sell(saleInput(c, [packetLine(packet.id, 2, "0.600", "FIXED", "100")]))).rejects.toThrow(/every piece must also take every carat/);
    await expect(sell(saleInput(c, [packetLine(packet.id, 1, "0.100", "PER_PIECE", "100", { discount: "150" })]))).rejects.toThrow(/discount cannot be more/);

    const rest = await sell(saleInput(c, [packetLine(packet.id, 2, "0.667", "FIXED", "9000")], { paymentAccountId: bankId }));
    const restLine = await prisma.diamondSaleLine.findFirstOrThrow({ where: { saleId: rest.sale.id } });
    expect([new Decimal(restLine.baseAmount).toFixed(2), new Decimal(restLine.cogsAmount).toFixed(2)]).toEqual(["9000.00", "6670.00"]);
    expect((await paymentAccountBalance(bankId)).minus(bankBefore).toFixed(2)).toBe("9000.00");
    const bal = await packetBalance(packet.id);
    expect([bal.pieces, bal.carat, bal.costValue]).toEqual([0, "0.000", "0.00"]);
    expect((await prisma.polishedPacket.findUniqueOrThrow({ where: { id: packet.id } })).status).toBe("EMPTY");
    await expect(sell(saleInput(c, [packetLine(packet.id, 1, "0.100", "FIXED", "100")]))).rejects.toThrow(/no longer available|is empty/);
    await reconcile1220();
  }, 90_000);

  it("two simultaneous partial sales of one packet can never sell more than it holds", async () => {
    const packet = await buyPacket(10, "5.000", "8000");
    const c = await customer("DS Packet Race Customer");
    const results = await Promise.allSettled([
      sell(saleInput(c, [packetLine(packet.id, 6, "3.000", "PER_CARAT", "9000")])),
      sell(saleInput(c, [packetLine(packet.id, 6, "3.000", "PER_CARAT", "9000")])),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const bal = await packetBalance(packet.id);
    expect([bal.pieces, bal.carat, bal.costValue]).toEqual([4, "2.000", "16000.00"]);
    await reconcile1220();
  }, 90_000);

  it("discount and GST (CGST + SGST 3%, extra and included) post exactly; output GST lands on 7001 / 7002", async () => {
    const [s1, s2] = await makeStones(["2.500", "1.000"]);
    const c = await customer("DS GST Customer");
    const r = await sell(
      saleInput(c, [stoneLine(s1.id, "20000", { discount: "1000", gstRatePercent: "3", taxType: "EXCLUSIVE" }), stoneLine(s2.id, "10300", { pricing: "FIXED", gstRatePercent: "3", taxType: "INCLUSIVE" })], { gstTreatment: "CGST_SGST" })
    );
    // Line 1: 50,000 − 1,000 = 49,000 + 3% = 50,470. Line 2: 10,300 incl. 3% = 10,000 + 300.
    expect([r.sale.taxableTotal, r.sale.taxTotal, r.sale.grandTotal].map((x) => new Decimal(x).toFixed(2))).toEqual(["59000.00", "1770.00", "60770.00"]);
    const lines = await voucherLines(r.sale.voucherId);
    expect(lines).toEqual(expect.arrayContaining(["1100 Dr 60770.00", "4000 Cr 59000.00"]));
    const gst = await prisma.journalEntry.findMany({ where: { voucherId: r.sale.voucherId, account: { code: { startsWith: "70" } } } });
    expect(gst.reduce((s, l) => s.plus(l.credit), ZERO).toFixed(2)).toBe("1770.00");
    expect(gst).toHaveLength(2);
    await reconcile1220();
  }, 90_000);

  it("a clearing-enabled marketplace Customer: the sale lands in 1150 Marketplace Clearing with its foreign amount", async () => {
    const [stone] = await makeStones(["1.000"]);
    const etsy = await customer("DS Marketplace", true);
    const r = await sell(saleInput(etsy, [stoneLine(stone.id, "17590", { pricing: "FIXED" })], { clearing: { currencyCode: "USD", foreignAmount: "210" } }));
    expect(await voucherLines(r.sale.voucherId)).toEqual(["1150 Dr 17590.00", "1220 Cr 80000.00", "4000 Cr 17590.00", "5210 Dr 80000.00"]);
    const entry = await prisma.clearingEntry.findFirstOrThrow({ where: { voucherId: r.sale.voucherId } });
    expect([entry.kind, entry.currencyCode, new Decimal(entry.fcAmount).toFixed(2), new Decimal(entry.inrAmount).toFixed(2)]).toEqual(["SALE", "USD", "210.00", "17590.00"]);

    // A whole-line return reverses revenue into Sales Returns and the clearing balance back to zero.
    const line = await prisma.diamondSaleLine.findFirstOrThrow({ where: { saleId: r.sale.id } });
    const ret = await prisma.$transaction((tx) => returnDiamondSaleLines(tx, { saleId: r.sale.id, lineIds: [line.id], reason: "Buyer returned", returnDate: DATE, idempotencyKey: key("ret"), actor: owner(), ...FY }), TX);
    expect(await voucherLines(ret.saleReturn.voucherId)).toEqual(["1150 Cr 17590.00", "1220 Dr 80000.00", "4100 Dr 17590.00", "5210 Cr 80000.00"]);
    const clearing = await prisma.clearingEntry.findMany({ where: { partyId: etsy } });
    expect(clearing.reduce((s, e) => s.plus(e.inrAmount), ZERO).toFixed(2)).toBe("0.00");
    expect(clearing.reduce((s, e) => s.plus(e.fcAmount), ZERO).toFixed(2)).toBe("0.00");
    expect((await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: stone.id } })).status).toBe("AVAILABLE");
    await reconcile1220();
  }, 90_000);

  it("Owner cancel: mirror voucher, every stone and packet stone back exactly; Staff and the generic voucher cancel are refused", async () => {
    const [stone] = await makeStones(["1.500"]);
    const packet = await buyPacket(4, "2.000", "5000");
    const c = await customer("DS Cancel Customer");
    const r = await sell(saleInput(c, [stoneLine(stone.id, "30000", { pricing: "FIXED" }), packetLine(packet.id, 4, "2.000", "PER_CARAT", "6000")]));
    expect((await prisma.polishedPacket.findUniqueOrThrow({ where: { id: packet.id } })).status).toBe("EMPTY");
    const arBefore = await accountBalance("1100");

    await expect(prisma.$transaction((tx) => cancelDiamondSale(tx, { saleId: r.sale.id, reason: "Staff should not cancel", actor: staff(), ...FY }), TX)).rejects.toThrow(/Only the Owner/);
    auth.user = { id: ownerId, role: "OWNER", name: "Owner", email: "owner@test" };
    const generic = await cancelVoucherAction(undefined, fd({ voucherId: r.sale.voucherId, cancellationReason: "Trying the generic path" }));
    expect(generic?.error).toMatch(/Diamond Sale/);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: r.sale.voucherId } })).status).toBe("POSTED");

    const cancelled = await prisma.$transaction((tx) => cancelDiamondSale(tx, { saleId: r.sale.id, reason: "Customer changed their mind", actor: owner(), ...FY }), TX);
    expect(cancelled.status).toBe("CANCELLED");
    await expect(accountBalance("1100").then((b) => b.minus(arBefore).toFixed(2))).resolves.toBe(new Decimal(r.sale.grandTotal).negated().toFixed(2));
    expect((await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: stone.id } })).status).toBe("AVAILABLE");
    expect((await prisma.polishedPacket.findUniqueOrThrow({ where: { id: packet.id } })).status).toBe("ACTIVE");
    const bal = await packetBalance(packet.id);
    expect([bal.pieces, bal.carat, bal.costValue]).toEqual([4, "2.000", "10000.00"]);
    await expect(prisma.$transaction((tx) => cancelDiamondSale(tx, { saleId: r.sale.id, reason: "Cancel it a second time", actor: owner(), ...FY }), TX)).rejects.toThrow(/already cancelled/);
    // The stock is sellable again.
    await sell(saleInput(c, [stoneLine(stone.id, "1000", { pricing: "FIXED" })]));
    await reconcile1220();
  }, 90_000);

  it("Owner return of some lines: Dr Sales Returns / Cr AR, stock back; then a whole-sale cancel and a second return of the same line are refused", async () => {
    const [s1, s2] = await makeStones(["1.000", "1.000"]);
    const c = await customer("DS Return Customer");
    const r = await sell(saleInput(c, [stoneLine(s1.id, "25000"), stoneLine(s2.id, "26000")]));
    const [l1] = await prisma.diamondSaleLine.findMany({ where: { saleId: r.sale.id }, orderBy: { sortOrder: "asc" } });
    const pnlBefore = await getProfitAndLoss();
    await expect(prisma.$transaction((tx) => returnDiamondSaleLines(tx, { saleId: r.sale.id, lineIds: [l1.id], reason: "Staff return", returnDate: DATE, actor: staff(), ...FY }), TX)).rejects.toThrow(/Only the Owner/);
    const k = key("ret");
    const ret = await prisma.$transaction((tx) => returnDiamondSaleLines(tx, { saleId: r.sale.id, lineIds: [l1.id], reason: "Wrong colour", returnDate: DATE, idempotencyKey: k, actor: owner(), ...FY }), TX);
    expect(await voucherLines(ret.saleReturn.voucherId)).toEqual(["1100 Cr 25000.00", "1220 Dr 40000.00", "4100 Dr 25000.00", "5210 Cr 40000.00"]);
    const replay = await prisma.$transaction((tx) => returnDiamondSaleLines(tx, { saleId: r.sale.id, lineIds: [l1.id], reason: "Wrong colour", returnDate: DATE, idempotencyKey: k, actor: owner(), ...FY }), TX);
    expect(replay.replayed).toBe(true);
    expect((await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: s1.id } })).status).toBe("AVAILABLE");
    expect((await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: s2.id } })).status).toBe("SOLD");
    const pnl = await getProfitAndLoss();
    expect(pnl.salesReturns.minus(pnlBefore.salesReturns).toFixed(2)).toBe("25000.00");
    expect(pnl.diamondCogs.minus(pnlBefore.diamondCogs).toFixed(2)).toBe("-40000.00");

    await expect(prisma.$transaction((tx) => returnDiamondSaleLines(tx, { saleId: r.sale.id, lineIds: [l1.id], reason: "Again", returnDate: DATE, actor: owner(), ...FY }), TX)).rejects.toThrow(/already returned/);
    await expect(prisma.$transaction((tx) => cancelDiamondSale(tx, { saleId: r.sale.id, reason: "Cancel after a return", actor: owner(), ...FY }), TX)).rejects.toThrow(/has a return/);
    const [row] = (await listDiamondSales(prisma, { includeCost: true })).filter((s) => s.id === r.sale.id);
    expect(row.lines.map((l) => l.returnCode)).toEqual([ret.saleReturn.returnCode, null]);
    await reconcile1220();
  }, 90_000);

  it("Staff can preview and post a sale, but never receive stock cost, COGS or margin; Staff cannot cancel", async () => {
    const [stone] = await makeStones(["1.250"]);
    const cost = new Decimal(stone.allocatedCost).toFixed(2);
    expect(cost).toBe("80000.00");
    const c = await customer("DS Staff Customer");
    auth.user = { id: staffId, role: "STAFF", name: "Staff", email: "staff@test" };
    const form = {
      customerId: c,
      saleDate: "2026-10-14",
      gstTreatment: "NONE",
      linesJson: JSON.stringify([{ kind: "STONE", polishedDiamondId: stone.id, pricing: "PER_CARAT", rate: "84000" }]),
      idempotencyKey: key("staff"),
    };
    const preview = await previewDiamondSaleAction(undefined, fd(form));
    expect(preview.error).toBeUndefined();
    expect(preview.preview?.grandTotal).toBe("105000.00");
    expect(preview.preview?.cogsTotal).toBeNull();
    expect(preview.preview?.grossProfit).toBeNull();
    expect(preview.preview?.lines[0].cogsAmount).toBeNull();
    const json = JSON.stringify(preview);
    expect(json).not.toContain(cost);
    expect(json).not.toContain("80000");
    expect(json).not.toContain("25000"); // the margin

    const saved = await postDiamondSaleAction(undefined, fd({ ...form, fingerprint: preview.preview!.fingerprint }));
    expect(saved).toEqual({ success: true, code: expect.stringMatching(/^ZL-DS-/), replayed: false });
    expect(JSON.stringify(saved)).not.toContain("80000");
    const sale = await prisma.diamondSale.findFirstOrThrow({ where: { saleCode: saved!.code } });
    expect(sale.createdByUserId).toBe(staffId);
    expect(new Decimal(sale.cogsTotal).toFixed(2)).toBe(cost); // the books carry the cost; Staff just never see it

    const staffList = await listDiamondSales(prisma, { includeCost: false });
    expect(staffList.every((s) => s.cogsTotal === null && s.grossProfit === null && s.lines.every((l) => l.cogsAmount === null))).toBe(true);
    await expect(cancelDiamondSaleAction(undefined, fd({ saleId: sale.id, reason: "Staff trying to cancel" }))).rejects.toThrow(/unauthorized/);

    // A stale preview fingerprint is refused (the stone is now sold).
    auth.user = { id: ownerId, role: "OWNER", name: "Owner", email: "owner@test" };
    const [other] = await makeStones(["1.000"]);
    const otherForm = { ...form, linesJson: JSON.stringify([{ kind: "STONE", polishedDiamondId: other.id, pricing: "PER_CARAT", rate: "84000" }]), idempotencyKey: key("stale") };
    const p2 = await previewDiamondSaleAction(undefined, fd(otherForm));
    const changed = await postDiamondSaleAction(undefined, fd({ ...otherForm, linesJson: JSON.stringify([{ kind: "STONE", polishedDiamondId: other.id, pricing: "PER_CARAT", rate: "85000" }]), fingerprint: p2.preview!.fingerprint }));
    expect(changed?.error).toMatch(/changed after the preview/);
    expect((await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("AVAILABLE");
    await reconcile1220();
  }, 90_000);
});
