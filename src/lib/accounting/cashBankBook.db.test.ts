/**
 * Cash & Bank Book and Receivable & Payable — real-database acceptance on the
 * disposable scratch database only (shared guard; this suite truncates
 * business tables). Every figure is checked against the raw ledger.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ role: "OWNER" as "OWNER" | "STAFF" }));
vi.mock("@/lib/auth/dal", () => ({
  requireUser: async () => ({ id: "x", role: auth.role, name: "x", email: "x@test" }),
  requireOwner: async () => {
    if (auth.role !== "OWNER") throw new Error("REDIRECT:/unauthorized");
    return { id: "x", role: "OWNER", name: "x", email: "x@test" };
  },
}));

import { cashBookCsv, getCashBookAccounts, getCashBookPage, getCashBookSummary, listCashBookRows } from "@/lib/accounting/cashBankBook";
import { CASH_BOOK_PAGE_SIZE, defaultCashBookDates, parseCashBookFilters, type CashBookFilters } from "@/lib/accounting/cashBankBookFilters";
import { postVoucherOnce } from "@/lib/accounting/idempotentPosting";
import { Decimal } from "@/lib/accounting/money";
import { cancelVoucher, postCustomerRefund, postPaymentGiven, postPaymentReceived, postPurchase, postSale, VOUCHER_TRANSACTION_OPTIONS } from "@/lib/accounting/posting";
import { getReceivablePayableBook } from "@/lib/accounting/receivablePayable";
import { getReceivablePayableSummary } from "@/lib/accounting/reports";
import { VOUCHER_TYPE_LABELS } from "@/lib/accounting/voucherTypeLabels";
import { prisma } from "@/lib/db/prisma";
import { postCustomerGoldTransfer, receiveCustomerGold } from "@/lib/jewellery/customerGold";
import { billCustomerJewellery } from "@/lib/jewellery/customerGoldCommercial";
import { receiveWithCustomerGold } from "@/lib/jewellery/customerGoldJobReceipt";
import { exchangeOldGold, oldGoldExchangeFingerprint, planOldGoldExchange, type OldGoldExchangeInput } from "@/lib/jewellery/oldGoldExchange";
import { createJewelleryJob, issueMaterialsToJewelleryJob, postOpeningMetalStock, receiveFinishedJewellery } from "@/lib/jewellery/posting";
import { postReceiptChargeCorrection, reverseReceiptChargeCorrection } from "@/lib/jewellery/receiptChargeCorrection";
import { GET as exportCsv } from "@/app/(app)/accounting/cash-bank-book/export/route";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-05T00:00:00.000Z");
const TX = VOUCHER_TRANSACTION_OPTIONS;
const PERIOD = { dateFrom: "2026-04-01", dateTo: "2027-03-31" };

let ownerId: string;
let cash: string;
let bank: string;
let bankB: string;
let g22: string;
let g24: string;
let seq = 0;
const key = (l: string) => `cb-${l}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const at = (d: string) => new Date(`${d}T00:00:00.000Z`);
const f = (over: Partial<CashBookFilters> = {}): CashBookFilters => ({ ...parseCashBookFilters({}, PERIOD), ...over });

// ---- raw ledger probes --------------------------------------------------------------
async function rawAccount(paymentAccountId: string, where = "true"): Promise<string> {
  const [r] = await prisma.$queryRawUnsafe<{ net: string | null }[]>(
    `select sum(j.debit - j.credit)::text net from journal_entries j join payment_accounts pa on pa."accountId" = j."accountId" join vouchers v on v.id = j."voucherId" where pa.id = $1 and ${where}`,
    paymentAccountId
  );
  return new Decimal(r?.net ?? 0).toFixed(2);
}
async function rawSide(partyId: string, code: "1100" | "2000"): Promise<string> {
  const [r] = await prisma.$queryRawUnsafe<{ net: string | null }[]>(
    `select sum(j.debit - j.credit)::text net from journal_entries j join accounts a on a.id = j."accountId" where a.code = $2 and j."partyId" = $1`,
    partyId,
    code
  );
  return new Decimal(r?.net ?? 0).toFixed(2);
}
async function rawCode(code: string): Promise<string> {
  const [r] = await prisma.$queryRawUnsafe<{ net: string | null }[]>(`select sum(j.debit - j.credit)::text net from journal_entries j join accounts a on a.id = j."accountId" where a.code = $1`, code);
  return new Decimal(r?.net ?? 0).toFixed(2);
}
async function position(partyId: string) {
  const book = await getReceivablePayableBook({ partyId });
  return book.parties[0];
}

// ---- builders -----------------------------------------------------------------------
async function party(name: string, type: "CUSTOMER" | "SUPPLIER" | "KARIGAR" | "MANUFACTURER" | "BROKER") {
  return (await prisma.party.create({ data: { name: `${name} ${++seq}`, type, createdByUserId: ownerId } })).id;
}
const common = (date = DATE, idempotencyKey: string | null = null) => ({ date, ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId, idempotencyKey });
const line = (rate: string, gst = { percent: "0", taxType: "EXCLUSIVE" as "EXCLUSIVE" | "INCLUSIVE" }) => [
  { description: "Goods", quantity: 1, unit: "PCS" as const, rate, gstRatePercent: gst.percent, taxType: gst.taxType },
];
const purchase = (partyId: string, rate: string, date = DATE, paymentAccountId: string | null = null) =>
  prisma.$transaction((tx) => postPurchase(tx, { ...common(date), partyId, paymentAccountId, gstTreatment: "NONE", lines: line(rate) }), TX);
const sale = (partyId: string, rate: string, date = DATE, paymentAccountId: string | null = null) =>
  prisma.$transaction((tx) => postSale(tx, { ...common(date), partyId, paymentAccountId, gstTreatment: "NONE", lines: line(rate) }), TX);
const give = (partyId: string, paymentAccountId: string, amount: string, date = DATE) =>
  prisma.$transaction((tx) => postPaymentGiven(tx, { ...common(date), partyId, paymentAccountId, amount }), TX);
const receive = (partyId: string, paymentAccountId: string, amount: string, date = DATE) =>
  prisma.$transaction((tx) => postPaymentReceived(tx, { ...common(date), partyId, paymentAccountId, amount }), TX);
const cancel = (voucherId: string) =>
  prisma.$transaction((tx) => cancelVoucher(tx, { voucherId, cancelledByUserId: ownerId, cancellationReason: "MISHTIC", ...FY }), TX);

async function karigarReceipt(karigar: string, labour: string) {
  const job = await prisma.$transaction(
    (tx) => createJewelleryJob(tx, { jewelleryType: "PENDANT", designName: "CB pendant", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
    TX
  );
  await prisma.$transaction(
    (tx) =>
      issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId: g22, grossWeight: "5" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("iss"), createdByUserId: ownerId }),
    TX
  );
  const received = await prisma.$transaction(
    (tx) =>
      receiveFinishedJewellery(tx, {
        ...FY, jobId: job.id, receiveDate: DATE,
        outputs: [{ jewelleryType: "PENDANT", quantity: 1, netMetalWeight: 5, metalType: "GOLD", purityId: g22, diamondIds: [], qcStatus: "PASSED" as const }],
        diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
        labourCharge: labour, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0,
        markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
      }),
    TX
  );
  return received.receipt.id;
}

/** Counts every database call made through `db` (model methods and raw queries). */
function countingDb() {
  let calls = 0;
  const wrap = (obj: object, depth: number): object =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            calls++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        if (depth === 0 && value && typeof value === "object") return wrap(value as object, 1);
        return value;
      },
    });
  return { db: wrap(prisma, 0) as typeof prisma, calls: () => calls, reset: () => (calls = 0) };
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  cash = (await prisma.paymentAccount.findFirstOrThrow({ where: { method: "CASH", isActive: true } })).id;
  bank = (await prisma.paymentAccount.findFirstOrThrow({ where: { method: "BANK", isActive: true, account: { code: "1002" } } })).id;
  // A second bank account (a test master, reused across runs; its lines are cleared with the business data).
  const acct = await prisma.account.upsert({ where: { code: "1091" }, create: { code: "1091", name: "CB Test Bank B", type: "ASSET" }, update: {} });
  bankB = (await prisma.paymentAccount.upsert({ where: { accountId: acct.id }, create: { name: "CB Test Bank B", method: "BANK", accountId: acct.id }, update: { isActive: true } })).id;
  const purity = async (displayName: string, finenessPercent: string) =>
    (await prisma.metalPurity.upsert({ where: { metalType_displayName: { metalType: "GOLD", displayName } }, create: { metalType: "GOLD", displayName, finenessPercent, createdByUserId: ownerId }, update: { finenessPercent, isActive: true } })).id;
  g22 = await purity("CB 22K", "91.600");
  g24 = await purity("CB 24K", "99.900");
  await prisma.$transaction((tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g22, grossWeight: "500.000", costValue: "3000000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }), TX);
}, 120_000);

afterAll(async () => {
  await prisma.paymentAccount.update({ where: { id: bankB }, data: { isActive: true } });
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  await prisma.$disconnect();
});

// =====================================================================================
describe("Cash & Bank Book — who paid in, who was paid out", () => {
  it("1–2. a customer sale paid into Bank and another into Cash appear as Received with the customer as party", async () => {
    const c1 = await party("CB Customer Bank", "CUSTOMER");
    const c2 = await party("CB Customer Cash", "CUSTOMER");
    await sale(c1, "8150");
    await sale(c2, "3000");
    const pb = await receive(c1, bank, "8150");
    const pc = await receive(c2, cash, "3000");
    const bankRows = await listCashBookRows(f({ account: bank }), { limit: null });
    const r = bankRows.find((x) => x.voucherId === pb.id)!;
    expect([r.voucherType, r.partyId, r.partyType, r.received.toFixed(2), r.paid.toFixed(2), r.paymentAccountName]).toEqual(["PAYMENT_RECEIVED", c1, "CUSTOMER", "8150.00", "0.00", "Bank"]);
    expect(bankRows.some((x) => x.voucherId === pc.id)).toBe(false); // the Cash receipt is not in the Bank book
    const cashRows = await listCashBookRows(f({ account: cash }), { limit: null });
    expect(cashRows.find((x) => x.voucherId === pc.id)?.received.toFixed(2)).toBe("3000.00");
    // Sales and purchases on credit never appear: they did not move Cash/Bank.
    expect((await listCashBookRows(f(), { limit: null })).some((x) => x.voucherType === "SALE")).toBe(false);
  });

  it("3. a supplier purchase paid from Bank appears as Paid with the supplier; a purchase settled immediately appears once as Paid", async () => {
    const s = await party("CB Supplier", "SUPPLIER");
    await purchase(s, "100000");
    const p = await give(s, bank, "100000");
    const direct = await purchase(s, "2500", DATE, bank);
    const rows = await listCashBookRows(f({ account: bank, partyId: s }), { limit: null });
    expect(rows.map((r) => [r.voucherNumber, r.voucherType, r.paid.toFixed(2)])).toEqual([
      [p.voucherNumber, "PAYMENT_GIVEN", "100000.00"],
      [direct.voucherNumber, "PURCHASE", "2500.00"],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    const pos = await position(s);
    expect([pos.charged.toFixed(2), pos.given.toFixed(2), pos.payableSide.toFixed(2)]).toEqual(["102500.00", "102500.00", "0.00"]);
  });

  it("10–11. two bank accounts stay separate; an archived one still shows its history and balance", async () => {
    const c = await party("CB Customer two banks", "CUSTOMER");
    await sale(c, "9000");
    await receive(c, bank, "4000");
    const b = await receive(c, bankB, "5000");
    const onlyB = await listCashBookRows(f({ account: bankB }), { limit: null });
    expect(onlyB.map((r) => r.voucherId)).toEqual([b.id]);
    expect((await getCashBookSummary(f({ account: bankB }))).live.toFixed(2)).toBe(await rawAccount(bankB));
    await prisma.paymentAccount.update({ where: { id: bankB }, data: { isActive: false } });
    const accounts = await getCashBookAccounts();
    expect(accounts.find((a) => a.id === bankB)?.isActive).toBe(false);
    expect((await listCashBookRows(f({ account: bankB }), { limit: null })).map((r) => r.voucherId)).toEqual([b.id]);
    expect((await getCashBookSummary(f({ account: bankB }))).live.toFixed(2)).toBe("5000.00");
    await prisma.paymentAccount.update({ where: { id: bankB }, data: { isActive: true } });
  });
});

describe("Receivable / Payable groups", () => {
  it("4. Karigar receipt charges then payment: payable reduced exactly once", async () => {
    const k = await party("CB Karigar", "KARIGAR");
    await karigarReceipt(k, "6000");
    expect((await position(k)).payableSide.toFixed(2)).toBe("6000.00");
    await give(k, cash, "6000");
    const p = await position(k);
    expect([p.charged.toFixed(2), p.given.toFixed(2), p.payableSide.toFixed(2), p.net.toFixed(2)]).toEqual(["6000.00", "6000.00", "0.00", "0.00"]);
  });

  it("5–8. partial, exact, overpayment (advance paid) and customer credit land in the right group", async () => {
    const s = await party("CB Partial", "SUPPLIER");
    await purchase(s, "30000");
    await give(s, cash, "10000");
    const partial = await position(s);
    expect([partial.payableSide.toFixed(2), partial.oldestPayableDate]).toEqual(["20000.00", "2026-10-05"]);
    await give(s, bank, "20000");
    expect((await position(s)).payableSide.toFixed(2)).toBe("0.00");
    await give(s, cash, "500");
    const over = await position(s);
    expect(over.payableSide.toFixed(2)).toBe("-500.00");

    const c = await party("CB Credit", "CUSTOMER");
    await sale(c, "8150");
    await receive(c, bank, "9000");
    const credit = await position(c);
    expect(credit.receivableSide.toFixed(2)).toBe("-850.00");

    const book = await getReceivablePayableBook();
    expect(book.advancePaid.find((p) => p.partyId === s)?.payableSide.toFixed(2)).toBe("-500.00");
    expect(book.customerCredit.find((p) => p.partyId === c)?.receivableSide.toFixed(2)).toBe("-850.00");
    expect(book.payable.some((p) => p.partyId === s)).toBe(false);
    expect(book.receivable.some((p) => p.partyId === c)).toBe(false);
  });

  it("9. a party with both receivable and payable keeps both obligations visible, with the net apart", async () => {
    const both = await party("CB Both", "SUPPLIER");
    await sale(both, "10000");
    await purchase(both, "4000");
    const p = await position(both);
    expect([p.receivableSide.toFixed(2), p.payableSide.toFixed(2), p.net.toFixed(2)]).toEqual(["10000.00", "4000.00", "6000.00"]);
    const book = await getReceivablePayableBook();
    expect(book.receivable.some((x) => x.partyId === both)).toBe(true);
    expect(book.payable.some((x) => x.partyId === both)).toBe(true);
  });

  it("every party's columns add up to its net and both sides match the raw control accounts", async () => {
    const book = await getReceivablePayableBook();
    for (const p of book.parties) {
      expect(p.billed.minus(p.charged).minus(p.received).plus(p.given).plus(p.adjustments).toFixed(2)).toBe(p.net.toFixed(2));
      expect(p.receivableSide.toFixed(2)).toBe(await rawSide(p.partyId, "1100"));
      expect(p.payableSide.negated().toFixed(2)).toBe(await rawSide(p.partyId, "2000"));
    }
  });
});

describe("Opening balance, dates, ordering", () => {
  it("12. a filtered statement starts from everything posted before From, never ₹0", async () => {
    const c = await party("CB Opening", "CUSTOMER");
    await sale(c, "5000", at("2026-06-01"));
    await receive(c, bankB, "2000", at("2026-06-10"));
    await receive(c, bankB, "1000", at("2026-11-02"));
    const s = await getCashBookSummary(f({ account: bankB, dateFrom: "2026-11-01", dateTo: "2026-11-30" }));
    expect(s.opening.toFixed(2)).toBe(await rawAccount(bankB, `v.date < '2026-11-01'`));
    expect(s.opening.greaterThan(0)).toBe(true);
    expect(s.closing.toFixed(2)).toBe(s.opening.plus(1000).toFixed(2));
    const rows = await listCashBookRows(f({ account: bankB, dateFrom: "2026-11-01", dateTo: "2026-11-30" }), { limit: null });
    expect(rows[0].runningBalance.toFixed(2)).toBe(s.opening.plus(1000).toFixed(2));
  });

  it("16. same-day entries have a stable, deterministic running balance", async () => {
    const c = await party("CB Same day", "CUSTOMER");
    await sale(c, "600", at("2026-12-01"));
    for (const amt of ["100", "200", "300"]) await receive(c, cash, amt, at("2026-12-01"));
    const filters = f({ account: cash, dateFrom: "2026-12-01", dateTo: "2026-12-01" });
    const a = await listCashBookRows(filters, { limit: null });
    const b = await listCashBookRows(filters, { limit: null });
    expect(a.map((r) => r.lineId)).toEqual(b.map((r) => r.lineId));
    const s = await getCashBookSummary(filters);
    let running = s.opening;
    for (const r of a) {
      running = running.plus(r.received).minus(r.paid);
      expect(r.runningBalance.toFixed(2)).toBe(running.toFixed(2));
    }
  });

  it("17. financial-year and India-midnight boundaries", async () => {
    const c = await party("CB FY", "CUSTOMER");
    await sale(c, "3000", at("2027-03-01"));
    const march = await receive(c, bankB, "1000", at("2027-03-31"));
    // An entry posted at 01:30 IST on 1 April (19:00 UTC on 31 March) belongs to 1 April.
    const lateNight = await receive(c, bankB, "500", new Date("2027-03-31T20:00:00.000Z"));
    const fy2627 = await listCashBookRows(f({ account: bankB, dateFrom: "2026-04-01", dateTo: "2027-03-31" }), { limit: null });
    const fy2728 = await listCashBookRows(f({ account: bankB, dateFrom: "2027-04-01", dateTo: "2028-03-31" }), { limit: null });
    expect(fy2627.some((r) => r.voucherId === march.id)).toBe(true);
    expect(fy2627.some((r) => r.voucherId === lateNight.id)).toBe(false);
    expect(fy2728.find((r) => r.voucherId === lateNight.id)?.businessDate).toBe("2027-04-01");
    expect(defaultCashBookDates(FY, new Date("2027-03-31T19:00:00.000Z"))).toEqual({ dateFrom: "2027-04-01", dateTo: "2027-04-01" });
  });
});

describe("Cancellation, reversal, duplicates", () => {
  it("13–14. the SUDHIRBHAI shape: Bank receipt cancelled and re-entered into Cash — Bank nets to ₹0, the pair is linked", async () => {
    const c = await party("CB Sudhir", "CUSTOMER");
    await sale(c, "8150", at("2026-10-03"));
    const bank0 = await rawAccount(bank);
    const cash0 = await rawAccount(cash);
    const first = await receive(c, bank, "8150", at("2026-10-10"));
    expect(new Decimal(await rawAccount(bank)).minus(bank0).toFixed(2)).toBe("8150.00");
    const rev = await cancel(first.id);
    const again = await receive(c, cash, "8150");
    expect(await rawAccount(bank)).toBe(bank0); // net Bank effect zero
    expect(new Decimal(await rawAccount(cash)).minus(cash0).toFixed(2)).toBe("8150.00");
    const rows = await listCashBookRows(f({ account: bank, partyId: c }), { limit: null });
    const orig = rows.find((r) => r.voucherId === first.id)!;
    const back = rows.find((r) => r.voucherId === rev.id)!;
    expect([orig.status, orig.reversedByNumber, back.voucherType, back.reversesNumber, back.reversesType, back.paid.toFixed(2), back.partyId]).toEqual([
      "CANCELLED", rev.voucherNumber, "REVERSAL", first.voucherNumber, "PAYMENT_RECEIVED", "8150.00", c,
    ]);
    // Hiding reversals hides BOTH halves — never one of them.
    const hidden = await listCashBookRows(f({ account: bank, partyId: c, includeReversals: false }), { limit: null });
    expect(hidden).toHaveLength(0);
    const p = await position(c);
    expect([p.receivableSide.toFixed(2), p.received.toFixed(2), p.adjustments.toFixed(2)]).toEqual(["0.00", "16300.00", "8150.00"]);
    expect(p.lastReceived?.voucherNumber).toBe(again.voucherNumber); // the cancelled receipt is not a "last payment"
  });

  it("15. a duplicate / double submit appears once in the book", async () => {
    const c = await party("CB Double", "CUSTOMER");
    await sale(c, "700");
    const k = key("dup");
    const req = { voucherType: "PAYMENT_RECEIVED" as const, partyId: c, paymentAccountId: cash, amount: "700", date: DATE, createdByUserId: ownerId };
    const post = () => postVoucherOnce(k, req, (tx) => postPaymentReceived(tx, { ...common(DATE, k), partyId: c, paymentAccountId: cash, amount: "700" }));
    await Promise.all([post(), post(), post()]);
    expect(await listCashBookRows(f({ partyId: c }), { limit: null })).toHaveLength(1);
  });

  it("a customer refund paid out of Cash is a Paid row and reduces the customer credit", async () => {
    const c = await party("CB Refund", "CUSTOMER");
    await sale(c, "1000");
    await receive(c, cash, "1300");
    const r = await prisma.$transaction((tx) => postCustomerRefund(tx, { ...common(), partyId: c, paymentAccountId: cash, amount: "300" }), TX);
    const row = (await listCashBookRows(f({ partyId: c }), { limit: null })).find((x) => x.voucherId === r.id)!;
    expect([row.voucherType, row.paid.toFixed(2)]).toEqual(["CUSTOMER_REFUND", "300.00"]);
    expect((await position(c)).receivableSide.toFixed(2)).toBe("0.00");
  });
});

describe("Customer Gold, Old Gold and corrections", () => {
  const exchange = async (customerId: string, settlement: "CREDIT_TO_INVOICE" | "PAY_CUSTOMER", reference: string) => {
    const input: OldGoldExchangeInput = { customerId, exchangeDate: DATE, purityId: g22, inputBasis: "FINE", weight: "5", rateBasis: "PER_FINE_GRAM", rate: "6000", settlement, reason: "Old chain bought from the Customer", reference };
    const plan = await prisma.$transaction((tx) => planOldGoldExchange(tx, input), TX);
    return prisma.$transaction((tx) => exchangeOldGold(tx, { ...input, approved: true, expectedFingerprint: oldGoldExchangeFingerprint(input, plan), idempotencyKey: key("og"), actor: owner(), ...FY }), TX);
  };

  it("19. an Old Gold purchase paid to the Customer: Payable until Payment Given from Cash, which appears as Paid", async () => {
    const c = await party("CB Old gold", "CUSTOMER");
    await exchange(c, "PAY_CUSTOMER", "CB-OG-1");
    const before = await position(c);
    expect(before.payableSide.greaterThan(0)).toBe(true);
    const pay = await give(c, cash, before.payableSide.toFixed(2));
    expect((await position(c)).payableSide.toFixed(2)).toBe("0.00");
    expect((await listCashBookRows(f({ partyId: c }), { limit: null })).map((r) => [r.voucherId, r.paid.toFixed(2)])).toEqual([[pay.id, before.payableSide.toFixed(2)]]);
  });

  it("18. a Customer Gold bill with gold-purchase credit applied: the credit is an adjustment, the rest is received into Bank", async () => {
    const c = await party("CB Gold customer", "CUSTOMER");
    const karigar = await party("CB Gold karigar", "KARIGAR");
    await exchange(c, "CREDIT_TO_INVOICE", "CB-OG-2");
    const credit = (await position(c)).payableSide.toFixed(2);
    await prisma.$transaction((tx) => receiveCustomerGold(tx, { customerId: c, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: "3", reason: "Gold for the ring", idempotencyKey: key("in"), actor: owner() }), TX);
    await prisma.$transaction((tx) => postCustomerGoldTransfer(tx, { kind: "ISSUE_TO_KARIGAR", customerId: c, purityId: g24, finenessPercent: "99.900", karigarId: karigar, fineWeight: "2", entryDate: DATE, reason: "For the ring", idempotencyKey: key("iss"), actor: owner() }), TX);
    const job = await prisma.$transaction((tx) => createJewelleryJob(tx, { customerId: c, jewelleryType: "RING", designName: "CB ring", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }), TX);
    await prisma.$transaction(
      (tx) =>
        receiveWithCustomerGold(tx, {
          ...FY, jobId: job.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "2.002", metalType: "GOLD", purityId: g24, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: "1000.00", settingCharge: 0, platingCharge: 0, otherExpense: 0,
          markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
          customerGoldSource: { purityId: g24, finenessPercent: "99.900" }, actor: owner(),
        }),
      TX
    );
    const bill = await prisma.$transaction(
      (tx) => billCustomerJewellery(tx, { jobId: job.id, billDate: DATE, makingCharge: "40000.00", gstTreatment: "CGST_SGST", gstRatePercent: "3", creditToApply: credit, idempotencyKey: key("bill"), actor: owner(), ...FY }),
      TX
    );
    const due = new Decimal(bill.bill.amountDue).toFixed(2);
    const p1 = await position(c);
    expect([p1.receivableSide.toFixed(2), p1.payableSide.toFixed(2), p1.adjustments.toFixed(2)]).toEqual([due, "0.00", "0.00"]); // credit applied: +Dr AP −Cr AR nets to 0 in adjustments
    expect(p1.billed.toFixed(2)).toBe("41200.00");
    await receive(c, bank, due);
    const p2 = await position(c);
    expect([p2.receivableSide.toFixed(2), p2.received.toFixed(2)]).toEqual(["0.00", due]);
    expect((await listCashBookRows(f({ partyId: c, account: bank }), { limit: null }))[0]?.received.toFixed(2)).toBe(due);
  });

  it("20. a receipt-charge correction moves the Karigar payable (not Cash/Bank); its reversal is an adjustment", async () => {
    const k = await party("CB Corr karigar", "KARIGAR");
    const receiptId = await karigarReceipt(k, "0");
    const cashBefore = await getCashBookSummary(f());
    const c = await prisma.$transaction(
      (tx) => postReceiptChargeCorrection(tx, { receiptId, charges: { settingCharge: "1500" }, reason: "Setting charge was not entered at receipt", idempotencyKey: key("rc"), expectedFingerprint: null, owner: owner(), ...FY }),
      TX
    );
    expect((await position(k)).payableSide.toFixed(2)).toBe("1500.00");
    expect((await getCashBookSummary(f())).live.toFixed(2)).toBe(cashBefore.live.toFixed(2));
    await give(k, bank, "1500");
    await prisma.$transaction((tx) => reverseReceiptChargeCorrection(tx, { correctionId: c.correction.id, reason: "Setting was included in labour after all", owner: owner(), ...FY }), TX);
    const p = await position(k);
    expect([p.charged.toFixed(2), p.given.toFixed(2), p.payableSide.toFixed(2)]).toEqual(["1500.00", "1500.00", "-1500.00"]);
    expect(p.adjustments.toFixed(2)).toBe("1500.00");
  });
});

describe("Totals, CSV, performance, privacy", () => {
  it("21 & 23. every total agrees with the GL to the paisa; no unbalanced voucher", async () => {
    const book = await getReceivablePayableBook();
    const dash = await getReceivablePayableSummary();
    for (const k of ["receivable", "payable", "advancesPaid", "customerCredit"] as const) expect(book.totals[k].toFixed(2)).toBe(dash[k].toFixed(2));
    expect(book.totals.receivable.minus(book.totals.customerCredit).toFixed(2)).toBe(await rawCode("1100"));
    expect(book.totals.advancesPaid.minus(book.totals.payable).toFixed(2)).toBe(await rawCode("2000"));
    expect(book.totals.net.toFixed(2)).toBe(new Decimal(await rawCode("1100")).plus(await rawCode("2000")).toFixed(2));
    for (const a of await getCashBookAccounts()) {
      const s = await getCashBookSummary(f({ account: a.id, dateFrom: "2000-01-01", dateTo: "2099-12-31" }));
      expect(s.live.toFixed(2)).toBe(await rawAccount(a.id));
      expect(s.closing.toFixed(2)).toBe(s.live.toFixed(2));
    }
    const all = await getCashBookSummary(f({ dateFrom: "2026-04-01", dateTo: "2026-12-31" }));
    expect(all.closing.toFixed(2)).toBe(all.opening.plus(all.periodReceived).minus(all.periodPaid).toFixed(2));
    const [u] = await prisma.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int n from (select v.id from vouchers v left join journal_entries j on j."voucherId" = v.id group by v.id having coalesce(sum(j.debit),0) <> coalesce(sum(j.credit),0) or count(j.id) = 0) t`);
    expect(u.n).toBe(0);
  });

  it("22. the CSV holds exactly the filtered rows of every page, in order, with the same figures", async () => {
    const filters = f({ direction: "RECEIVED" });
    const all = await listCashBookRows(filters, { limit: null });
    const paged = [];
    const pageCount = Math.ceil(all.length / CASH_BOOK_PAGE_SIZE) || 1;
    for (let p = 1; p <= pageCount; p++) paged.push(...(await getCashBookPage({ ...filters, page: p })).rows);
    expect(paged.map((r) => r.lineId)).toEqual(all.map((r) => r.lineId));
    const csv = cashBookCsv(all, (t) => VOUCHER_TYPE_LABELS[t]).trim().split("\r\n");
    expect(csv).toHaveLength(all.length + 1);
    expect(csv.slice(1).every((l) => l.includes(",Received,"))).toBe(true);
    // The route returns the same CSV for the same query (Owner).
    auth.role = "OWNER";
    const res = await exportCsv(new Request("http://x/accounting/cash-bank-book/export?direction=RECEIVED&dateFrom=2026-04-01&dateTo=2027-03-31"));
    const body = (await res.text()).replace(/^﻿/, "").trim().split("\r\n");
    expect(body).toEqual(csv);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
  });

  it("24. query count stays constant however many parties and payments there are (no N+1)", async () => {
    const counter = countingDb();
    const before = { book: 0, rp: 0 };
    await getCashBookPage(f(), counter.db);
    before.book = counter.calls();
    counter.reset();
    await getReceivablePayableBook({}, counter.db);
    before.rp = counter.calls();
    // 40 more parties, each with a sale and a receipt.
    for (let i = 0; i < 40; i++) {
      const c = await party("CB Bulk", "CUSTOMER");
      await sale(c, "100");
      await receive(c, i % 2 ? cash : bank, "60");
    }
    counter.reset();
    await getCashBookPage(f(), counter.db);
    const afterBook = counter.calls();
    counter.reset();
    await getReceivablePayableBook({}, counter.db);
    const afterRp = counter.calls();
    expect({ book: before.book, rp: before.rp }).toEqual({ book: 3, rp: 3 });
    expect({ book: afterBook, rp: afterRp }).toEqual({ book: 3, rp: 3 });
  });

  it("25. the CSV export is refused to Staff on the server", async () => {
    auth.role = "STAFF";
    await expect(exportCsv(new Request("http://x/accounting/cash-bank-book/export"))).rejects.toThrow(/unauthorized/);
    auth.role = "OWNER";
  });
});
