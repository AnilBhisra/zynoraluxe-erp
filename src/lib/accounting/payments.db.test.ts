/**
 * Payment Given / Payment Received — real-database acceptance on the
 * disposable scratch database only (shared guard; this suite truncates
 * business tables).
 *
 * Every balance is checked three ways that must agree to the paisa:
 *  - the raw ledger (SQL sums of journal_entries by account and party);
 *  - the authoritative readers every screen uses (partyNetBalances,
 *    getPartyBalances, getPartyLedger, getReceivablePayableSummary,
 *    getCashBankSummary, getPaymentAccountBalances);
 *  - the label a person reads (classifyPartyBalance): Payable / Receivable /
 *    Advance paid / Customer credit / Settled.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { indiaBusinessDate } from "@/lib/accounting/financialYear";
import { postVoucherOnce } from "@/lib/accounting/idempotentPosting";
import { Decimal } from "@/lib/accounting/money";
import { classifyPartyBalance } from "@/lib/accounting/partyBalance";
import {
  cancelVoucher,
  PostingError,
  postPaymentGiven,
  postPaymentReceived,
  postPurchase,
  postSale,
  VOUCHER_TRANSACTION_OPTIONS,
} from "@/lib/accounting/posting";
import {
  getCashBankSummary,
  getPartyBalances,
  getPartyLedger,
  getPaymentAccountBalances,
  getReceivablePayableSummary,
  partyNetBalances,
} from "@/lib/accounting/reports";
import { prisma } from "@/lib/db/prisma";
import { postCustomerGoldTransfer, receiveCustomerGold } from "@/lib/jewellery/customerGold";
import { availableCustomerCreditInTx, billCustomerJewellery } from "@/lib/jewellery/customerGoldCommercial";
import { receiveWithCustomerGold } from "@/lib/jewellery/customerGoldJobReceipt";
import { customerGoldStatement } from "@/lib/jewellery/customerGoldReports";
import { exchangeOldGold, oldGoldExchangeFingerprint, planOldGoldExchange, type OldGoldExchangeInput } from "@/lib/jewellery/oldGoldExchange";
import { createJewelleryJob, issueMaterialsToJewelleryJob, postOpeningMetalStock, receiveFinishedJewellery } from "@/lib/jewellery/posting";
import { postReceiptChargeCorrection, reverseReceiptChargeCorrection } from "@/lib/jewellery/receiptChargeCorrection";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-05T00:00:00.000Z");
const TX = VOUCHER_TRANSACTION_OPTIONS;

let ownerId: string;
let cash: string;
let bank: string;
let upi: string;
let g22: string;
let g24: string;
let seq = 0;
const key = (label: string) => `pay-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

// ---------------------------------------------------------------------------
// Ledger probes (raw SQL — independent of the readers under test)
// ---------------------------------------------------------------------------
async function ledgerParty(partyId: string): Promise<string> {
  const [r] = await prisma.$queryRawUnsafe<{ net: string | null }[]>(
    `select sum(j.debit - j.credit)::text net from journal_entries j join accounts a on a.id = j."accountId" where a.code in ('1100','2000') and j."partyId" = $1`,
    partyId
  );
  return new Decimal(r?.net ?? 0).toFixed(2);
}
async function ledgerAccount(paymentAccountId: string): Promise<string> {
  const [r] = await prisma.$queryRawUnsafe<{ net: string | null }[]>(
    `select sum(j.debit - j.credit)::text net from journal_entries j join payment_accounts pa on pa."accountId" = j."accountId" where pa.id = $1`,
    paymentAccountId
  );
  return new Decimal(r?.net ?? 0).toFixed(2);
}
async function ledgerCode(code: string): Promise<string> {
  const [r] = await prisma.$queryRawUnsafe<{ net: string | null }[]>(
    `select sum(j.debit - j.credit)::text net from journal_entries j join accounts a on a.id = j."accountId" where a.code = $1`,
    code
  );
  return new Decimal(r?.net ?? 0).toFixed(2);
}
async function voucherLines(voucherNumber: string) {
  const v = await prisma.voucher.findUniqueOrThrow({ where: { voucherNumber }, include: { journalEntries: { include: { account: true } } } });
  return v.journalEntries.map((j) => ({ code: j.account.code, partyId: j.partyId, debit: new Decimal(j.debit).toFixed(2), credit: new Decimal(j.credit).toFixed(2) })).sort((a, b) => a.code.localeCompare(b.code));
}
async function unbalancedVoucherCount(): Promise<number> {
  const [r] = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select v.id from vouchers v left join journal_entries j on j."voucherId" = v.id group by v.id having coalesce(sum(j.debit),0) <> coalesce(sum(j.credit),0) or count(j.id) = 0) t`
  );
  return r.n;
}
async function sequenceOf(voucherType: "PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "REVERSAL", label = "2026-27"): Promise<number> {
  const s = await prisma.voucherSequence.findUnique({ where: { voucherType_financialYearLabel: { voucherType, financialYearLabel: label } } });
  return s?.lastNumber ?? 0;
}

/** The reader every screen uses must equal the raw ledger, and the label must match. */
async function expectParty(partyId: string, type: "CUSTOMER" | "SUPPLIER" | "KARIGAR", balance: string, kind: string) {
  expect(await ledgerParty(partyId)).toBe(balance);
  expect(((await partyNetBalances([partyId])).get(partyId) ?? new Decimal(0)).toFixed(2)).toBe(balance);
  const ledger = await getPartyLedger(partyId);
  expect((ledger.at(-1)?.runningBalance ?? new Decimal(0)).toFixed(2)).toBe(balance);
  expect(classifyPartyBalance(type, balance).kind).toBe(kind);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
async function party(name: string, type: "CUSTOMER" | "SUPPLIER" | "KARIGAR") {
  return (await prisma.party.create({ data: { name: `${name} ${++seq}`, type, createdByUserId: ownerId } })).id;
}
const common = (over: { date?: Date; idempotencyKey?: string } = {}) => ({
  date: over.date ?? DATE,
  ...FY,
  currencyCode: "INR",
  exchangeRate: 1,
  createdByUserId: ownerId,
  idempotencyKey: over.idempotencyKey ?? null,
});
function purchase(partyId: string, rate: string, gst: { treatment?: "NONE" | "CGST_SGST" | "IGST"; percent?: string; taxType?: "EXCLUSIVE" | "INCLUSIVE" } = {}) {
  return prisma.$transaction(
    (tx) =>
      postPurchase(tx, {
        ...common(),
        partyId,
        gstTreatment: gst.treatment ?? "NONE",
        lines: [{ description: "Goods", quantity: 1, unit: "PCS", rate, gstRatePercent: gst.percent ?? 0, taxType: gst.taxType ?? "EXCLUSIVE" }],
      }),
    TX
  );
}
function sale(partyId: string, rate: string, gst: { treatment?: "NONE" | "CGST_SGST" | "IGST"; percent?: string; taxType?: "EXCLUSIVE" | "INCLUSIVE" } = {}) {
  return prisma.$transaction(
    (tx) =>
      postSale(tx, {
        ...common(),
        partyId,
        gstTreatment: gst.treatment ?? "NONE",
        lines: [{ description: "Ring", quantity: 1, unit: "PCS", rate, gstRatePercent: gst.percent ?? 0, taxType: gst.taxType ?? "EXCLUSIVE" }],
      }),
    TX
  );
}
const give = (partyId: string, paymentAccountId: string, amount: string, date = DATE) =>
  prisma.$transaction((tx) => postPaymentGiven(tx, { ...common({ date }), partyId, paymentAccountId, amount }), TX);
const receive = (partyId: string, paymentAccountId: string, amount: string, date = DATE) =>
  prisma.$transaction((tx) => postPaymentReceived(tx, { ...common({ date }), partyId, paymentAccountId, amount }), TX);
const cancel = (voucherId: string) =>
  prisma.$transaction((tx) => cancelVoucher(tx, { voucherId, cancelledByUserId: ownerId, cancellationReason: "Entered by mistake", ...FY }), TX);

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  cash = (await prisma.paymentAccount.findFirstOrThrow({ where: { method: "CASH", isActive: true } })).id;
  bank = (await prisma.paymentAccount.findFirstOrThrow({ where: { method: "BANK", isActive: true } })).id;
  upi = (await prisma.paymentAccount.findFirstOrThrow({ where: { method: "UPI", isActive: true } })).id;
  const purity = async (displayName: string, finenessPercent: string) =>
    (
      await prisma.metalPurity.upsert({
        where: { metalType_displayName: { metalType: "GOLD", displayName } },
        create: { metalType: "GOLD", displayName, finenessPercent, createdByUserId: ownerId },
        update: { finenessPercent, isActive: true },
      })
    ).id;
  g22 = await purity("PAY 22K", "91.600");
  g24 = await purity("PAY 24K", "99.900");
  await prisma.$transaction(
    (tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g22, grossWeight: "500.000", costValue: "3000000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }),
    TX
  );
}, 120_000);

afterAll(async () => {
  // Leave nothing behind for the next suite (some clear only part of the tables).
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
describe("Payment Given — Supplier", () => {
  it("1. purchase ₹1,00,000 → Payment Given ₹1,00,000 → payable ₹0; Dr 2000 party / Cr Cash only", async () => {
    const s = await party("Supplier exact", "SUPPLIER");
    await purchase(s, "100000");
    await expectParty(s, "SUPPLIER", "-100000.00", "PAYABLE");
    const purchasesBefore = await ledgerCode("5000");
    const cashBefore = await ledgerAccount(cash);
    const v = await give(s, cash, "100000");
    await expectParty(s, "SUPPLIER", "0.00", "SETTLED");
    expect(await voucherLines(v.voucherNumber)).toEqual([
      { code: "1001", partyId: null, debit: "0.00", credit: "100000.00" },
      { code: "2000", partyId: s, debit: "100000.00", credit: "0.00" },
    ]);
    // Never touches expense/purchases or inventory again.
    expect(await ledgerCode("5000")).toBe(purchasesBefore);
    expect(new Decimal(await ledgerAccount(cash)).minus(cashBefore).toFixed(2)).toBe("-100000.00");
  });

  it("2. partial payment leaves exactly the remaining payable", async () => {
    const s = await party("Supplier partial", "SUPPLIER");
    await purchase(s, "100000");
    await give(s, bank, "40000");
    await expectParty(s, "SUPPLIER", "-60000.00", "PAYABLE");
    expect(classifyPartyBalance("SUPPLIER", "-60000.00").label).toBe("We owe ₹60,000.00");
  });

  it("3. overpayment is shown as an Advance paid — not hidden, not a negative payable", async () => {
    const s = await party("Supplier over", "SUPPLIER");
    await purchase(s, "100000");
    await give(s, bank, "100500");
    await expectParty(s, "SUPPLIER", "500.00", "ADVANCE_PAID");
    expect(classifyPartyBalance("SUPPLIER", "500.00").label).toBe("Advance paid ₹500.00");
    expect(new Decimal((await getReceivablePayableSummary()).advancesPaid).greaterThanOrEqualTo(500)).toBe(true);
  });
});

describe("Payment Given — Karigar receipt charges", () => {
  let receiptId = "";
  let karigar = "";

  async function receiptWithLabour(labour: string) {
    karigar = await party("Karigar", "KARIGAR");
    const job = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { jewelleryType: "PENDANT", designName: "Pay pendant", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    await prisma.$transaction(
      (tx) =>
        issueMaterialsToJewelleryJob(tx, {
          legacyDirectGoldIssue: true,
          ...FY,
          jobId: job.id,
          issueDate: DATE,
          metalLines: [{ metalType: "GOLD", purityId: g22, grossWeight: "5" }],
          polishedDiamondIds: [],
          otherMaterialLines: [],
          idempotencyKey: key("iss"),
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
          outputs: [{ jewelleryType: "PENDANT", quantity: 1, netMetalWeight: 5, metalType: "GOLD", purityId: g22, diamondIds: [], qcStatus: "PASSED" as const }],
          diamondResolutions: [],
          returnedMetalLines: [],
          scrapMetalLines: [],
          karigarAddedFineWeight: 0,
          karigarAddedCost: 0,
          labourCharge: labour,
          makingCharge: 0,
          settingCharge: 0,
          platingCharge: 0,
          otherExpense: 0,
          markJobComplete: true,
          isAbnormalLoss: false,
          damagedLostByUserId: ownerId,
          idempotencyKey: key("rcv"),
          createdByUserId: ownerId,
        }),
      TX
    );
    receiptId = received.receipt.id;
  }

  it("4. receipt labour ₹2,500 → Payment Given ₹2,500 → payable reduced exactly once; 1330 untouched by the payment", async () => {
    await receiptWithLabour("2500");
    await expectParty(karigar, "KARIGAR", "-2500.00", "PAYABLE");
    const inventory = await ledgerCode("1330");
    await give(karigar, cash, "2500");
    await expectParty(karigar, "KARIGAR", "0.00", "SETTLED");
    expect(await ledgerCode("1330")).toBe(inventory);
  });

  it("17. a receipt-charge correction adds to the payable; paying it settles; reversing the correction leaves an Advance paid", async () => {
    const correction = await prisma.$transaction(
      (tx) =>
        postReceiptChargeCorrection(tx, {
          receiptId,
          charges: { settingCharge: "1500" },
          reason: "Setting charge was not entered at receipt",
          idempotencyKey: key("rc"),
          expectedFingerprint: null,
          owner: owner(),
          ...FY,
        }),
      TX
    );
    await expectParty(karigar, "KARIGAR", "-1500.00", "PAYABLE");
    await give(karigar, bank, "1500");
    await expectParty(karigar, "KARIGAR", "0.00", "SETTLED");
    await prisma.$transaction(
      (tx) => reverseReceiptChargeCorrection(tx, { correctionId: correction.correction.id, reason: "Setting was included in labour after all", owner: owner(), ...FY }),
      TX
    );
    // The payment stays (history is never rewritten); the Karigar now holds ₹1,500 of ours.
    await expectParty(karigar, "KARIGAR", "1500.00", "ADVANCE_PAID");
    expect(await prisma.voucher.count({ where: { partyId: karigar, voucherType: "PAYMENT_GIVEN", status: "POSTED" } })).toBe(2);
  });
});

describe("Payment Received — Customer", () => {
  it("5. sale ₹8,150 → Payment Received ₹8,150 → receivable ₹0; Dr Bank / Cr 1100 party, no income line", async () => {
    const c = await party("Customer exact", "CUSTOMER");
    await sale(c, "8150");
    await expectParty(c, "CUSTOMER", "8150.00", "RECEIVABLE");
    const income = await ledgerCode("4000");
    const v = await receive(c, bank, "8150");
    await expectParty(c, "CUSTOMER", "0.00", "SETTLED");
    expect(await voucherLines(v.voucherNumber)).toEqual([
      { code: "1002", partyId: null, debit: "8150.00", credit: "0.00" },
      { code: "1100", partyId: c, debit: "0.00", credit: "8150.00" },
    ]);
    expect(await ledgerCode("4000")).toBe(income);
  });

  it("6. partial receipt leaves the receivable; an overpayment becomes Customer credit", async () => {
    const c = await party("Customer partial", "CUSTOMER");
    await sale(c, "8150");
    await receive(c, cash, "5000");
    await expectParty(c, "CUSTOMER", "3150.00", "RECEIVABLE");
    await receive(c, cash, "4000");
    await expectParty(c, "CUSTOMER", "-850.00", "CUSTOMER_CREDIT");
    expect(classifyPartyBalance("CUSTOMER", "-850.00").label).toBe("Customer credit ₹850.00");
  });

  it("7. a party with both payable and receivable activity nets in one balance and one ledger", async () => {
    const both = await party("Both ways", "SUPPLIER");
    await sale(both, "10000"); // they owe us 10,000 (AR)
    await purchase(both, "4000"); // we owe them 4,000 (AP)
    await expectParty(both, "SUPPLIER", "6000.00", "ADVANCE_PAID");
    await receive(both, bank, "6000");
    await expectParty(both, "SUPPLIER", "0.00", "SETTLED");
    const ledger = await getPartyLedger(both);
    expect(ledger.map((r) => r.voucherType)).toEqual(["SALE", "PURCHASE", "PAYMENT_RECEIVED"]);
  });
});

describe("Cash and Bank", () => {
  it("8–10. a Cash payment moves only Cash, a Bank receipt moves only Bank, UPI is untouched; readers equal the ledger", async () => {
    const s = await party("Cash supplier", "SUPPLIER");
    const c = await party("Bank customer", "CUSTOMER");
    await purchase(s, "3000");
    await sale(c, "7000");
    const [cash0, bank0, upi0] = [await ledgerAccount(cash), await ledgerAccount(bank), await ledgerAccount(upi)];
    await give(s, cash, "3000");
    expect(new Decimal(await ledgerAccount(cash)).minus(cash0).toFixed(2)).toBe("-3000.00");
    expect(await ledgerAccount(bank)).toBe(bank0);
    await receive(c, bank, "7000");
    expect(new Decimal(await ledgerAccount(bank)).minus(bank0).toFixed(2)).toBe("7000.00");
    expect(new Decimal(await ledgerAccount(cash)).minus(cash0).toFixed(2)).toBe("-3000.00");
    expect(await ledgerAccount(upi)).toBe(upi0);

    const accounts = await getPaymentAccountBalances();
    for (const a of accounts) expect(a.balance.toFixed(2)).toBe(await ledgerAccount(a.id));
    const summary = await getCashBankSummary();
    expect(summary.cash.toFixed(2)).toBe(await ledgerAccount(cash));
    expect(summary.bank.toFixed(2)).toBe(new Decimal(await ledgerAccount(bank)).plus(await ledgerAccount(upi)).toFixed(2));
  });

  it("an archived payment account cannot be paid from, and its money still counts in Cash/Bank", async () => {
    const s = await party("Archived acct supplier", "SUPPLIER");
    await purchase(s, "100");
    // The seeded UPI account, archived for this test only (masters are never created or left changed).
    await receive(await party("UPI customer", "CUSTOMER"), upi, "250");
    await prisma.paymentAccount.update({ where: { id: upi }, data: { isActive: false } });
    try {
      const seqBefore = await sequenceOf("PAYMENT_GIVEN");
      await expect(give(s, upi, "100")).rejects.toThrow(/archived/);
      expect(await sequenceOf("PAYMENT_GIVEN")).toBe(seqBefore);
      const summary = await getCashBankSummary();
      expect(new Decimal(await ledgerAccount(upi)).greaterThan(0)).toBe(true);
      expect(summary.bank.toFixed(2)).toBe(new Decimal(await ledgerAccount(bank)).plus(await ledgerAccount(upi)).toFixed(2));
    } finally {
      await prisma.paymentAccount.update({ where: { id: upi }, data: { isActive: true } });
    }
  });
});

describe("Cancellation / reversal", () => {
  it("11. cancelling a payment restores the party AND the payment account, once, dated with the Indian business date", async () => {
    const s = await party("Cancel supplier", "SUPPLIER");
    await purchase(s, "9000");
    const cash0 = await ledgerAccount(cash);
    const v = await give(s, cash, "9000");
    await expectParty(s, "SUPPLIER", "0.00", "SETTLED");
    const reversal = await cancel(v.id);
    await expectParty(s, "SUPPLIER", "-9000.00", "PAYABLE");
    expect(await ledgerAccount(cash)).toBe(cash0);
    expect(reversal.date.toISOString()).toBe(indiaBusinessDate().toISOString());
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("CANCELLED");
    await expect(cancel(v.id)).rejects.toThrow(/already been cancelled/);
    expect(await prisma.voucher.count({ where: { reversalOfVoucherId: v.id } })).toBe(1);
  });

  it("two simultaneous cancels of one payment reverse it exactly once", async () => {
    const c = await party("Race cancel customer", "CUSTOMER");
    await sale(c, "4400");
    const v = await receive(c, bank, "4400");
    const revSeq = await sequenceOf("REVERSAL");
    const results = await Promise.allSettled([cancel(v.id), cancel(v.id), cancel(v.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toMatch(/already been cancelled|Unique constraint/);
    expect(await prisma.voucher.count({ where: { reversalOfVoucherId: v.id } })).toBe(1);
    expect(await sequenceOf("REVERSAL")).toBe(revSeq + 1);
    await expectParty(c, "CUSTOMER", "4400.00", "RECEIVABLE");
  });
});

describe("Idempotency, concurrency, rollback", () => {
  const request = (partyId: string, amount: string) => ({
    voucherType: "PAYMENT_GIVEN" as const,
    partyId,
    paymentAccountId: cash,
    amount,
    date: DATE,
    createdByUserId: ownerId,
  });
  const post = (partyId: string, amount: string, idempotencyKey: string) =>
    postVoucherOnce(idempotencyKey, request(partyId, amount), (tx) => postPaymentGiven(tx, { ...common({ idempotencyKey }), partyId, paymentAccountId: cash, amount }));

  it("12a. a duplicate submit posts once and is answered as a replay", async () => {
    const s = await party("Dup supplier", "SUPPLIER");
    await purchase(s, "1000");
    const k = key("dup");
    expect((await post(s, "1000", k)).status).toBe("POSTED");
    expect((await post(s, "1000", k)).status).toBe("REPLAYED");
    expect(await prisma.voucher.count({ where: { partyId: s, voucherType: "PAYMENT_GIVEN" } })).toBe(1);
    await expectParty(s, "SUPPLIER", "0.00", "SETTLED");
  });

  it("12b. five simultaneous submits with one key post once, with no gap in the numbering", async () => {
    const s = await party("Race supplier", "SUPPLIER");
    await purchase(s, "2500");
    const before = await sequenceOf("PAYMENT_GIVEN");
    const k = key("race");
    const results = await Promise.all(Array.from({ length: 5 }, () => post(s, "2500", k)));
    expect(results.filter((r) => r.status === "POSTED")).toHaveLength(1);
    expect(new Set(results.map((r) => r.voucherNumber)).size).toBe(1);
    expect(await prisma.voucher.count({ where: { partyId: s, voucherType: "PAYMENT_GIVEN" } })).toBe(1);
    expect(await sequenceOf("PAYMENT_GIVEN")).toBe(before + 1);
    await expectParty(s, "SUPPLIER", "0.00", "SETTLED");
  });

  it("12c. a key that already saved a DIFFERENT payment is refused, and nothing is posted", async () => {
    const s = await party("Reuse supplier", "SUPPLIER");
    await purchase(s, "1000");
    const k = key("reuse");
    await post(s, "400", k);
    const before = await sequenceOf("PAYMENT_GIVEN");
    const again = await post(s, "600", k);
    expect(again.status).toBe("KEY_REUSED");
    expect(await sequenceOf("PAYMENT_GIVEN")).toBe(before);
    await expectParty(s, "SUPPLIER", "-600.00", "PAYABLE");
  });

  it("13. a failure inside posting leaves no payment, voucher, journal line or sequence increment", async () => {
    const s = await party("Fail supplier", "SUPPLIER");
    await purchase(s, "1000");
    const [vouchers, lines, seqBefore] = [await prisma.voucher.count(), await prisma.journalEntry.count(), await sequenceOf("PAYMENT_GIVEN")];
    await expect(
      postVoucherOnce(key("fail"), request(s, "1000"), async (tx) => {
        await postPaymentGiven(tx, { ...common(), partyId: s, paymentAccountId: cash, amount: "1000" });
        throw new Error("simulated failure after the lines were written");
      })
    ).rejects.toThrow(/simulated failure/);
    expect(await prisma.voucher.count()).toBe(vouchers);
    expect(await prisma.journalEntry.count()).toBe(lines);
    expect(await sequenceOf("PAYMENT_GIVEN")).toBe(seqBefore);
    await expect(give(s, cash, "0")).rejects.toThrow(PostingError);
    await expect(give("no-such-party", cash, "10")).rejects.toThrow(/Party not found/);
    expect(await sequenceOf("PAYMENT_GIVEN")).toBe(seqBefore);
    await expectParty(s, "SUPPLIER", "-1000.00", "PAYABLE");
  });
});

describe("GST", () => {
  it("14. exclusive and inclusive GST bills are settled by exactly their totals; GST accounts untouched by the payments", async () => {
    const s = await party("GST supplier", "SUPPLIER");
    const c = await party("GST customer", "CUSTOMER");
    const p = await purchase(s, "10000", { treatment: "CGST_SGST", percent: "3", taxType: "EXCLUSIVE" }); // 10,300.00
    const q = await sale(c, "10300", { treatment: "IGST", percent: "3", taxType: "INCLUSIVE" }); // 10,300.00 incl.
    expect(new Decimal(p.amount).toFixed(2)).toBe("10300.00");
    expect(new Decimal(q.amount).toFixed(2)).toBe("10300.00");
    const gst = [await ledgerCode("6001"), await ledgerCode("6002"), await ledgerCode("7003")];
    await give(s, bank, "10300");
    await receive(c, bank, "10300");
    await expectParty(s, "SUPPLIER", "0.00", "SETTLED");
    await expectParty(c, "CUSTOMER", "0.00", "SETTLED");
    expect([await ledgerCode("6001"), await ledgerCode("6002"), await ledgerCode("7003")]).toEqual(gst);
  });
});

describe("Customer Gold and Old Gold credits", () => {
  const exchange = async (customerId: string, settlement: "CREDIT_TO_INVOICE" | "PAY_CUSTOMER", reference: string) => {
    const input: OldGoldExchangeInput = {
      customerId,
      exchangeDate: DATE,
      purityId: g22,
      inputBasis: "FINE",
      weight: "5",
      rateBasis: "PER_FINE_GRAM",
      rate: "6000",
      settlement,
      reason: "Old chain bought from the Customer",
      reference,
    };
    const plan = await prisma.$transaction((tx) => planOldGoldExchange(tx, input), TX);
    return prisma.$transaction(
      (tx) => exchangeOldGold(tx, { ...input, approved: true, expectedFingerprint: oldGoldExchangeFingerprint(input, plan), idempotencyKey: key("og"), actor: owner(), ...FY }),
      TX
    );
  };
  const credit = (c: string) => prisma.$transaction((tx) => availableCustomerCreditInTx(tx, c), TX);

  it("16. an Old Gold purchase paid to the Customer is a Customer credit until Payment Given settles it", async () => {
    const c = await party("Old gold seller", "CUSTOMER");
    await exchange(c, "PAY_CUSTOMER", "OG-PAY-1");
    const value = new Decimal(await ledgerParty(c)).abs().toFixed(2);
    expect(Number(value)).toBeGreaterThan(0);
    await expectParty(c, "CUSTOMER", `-${value}`, "CUSTOMER_CREDIT");
    await give(c, cash, value);
    await expectParty(c, "CUSTOMER", "0.00", "SETTLED");
  });

  it("15. a Customer Gold bill with gold-purchase credit applied: Payment Received settles the rest; the bill's stored due stays, the account balance is live", async () => {
    const c = await party("Gold customer", "CUSTOMER");
    const karigar = await party("Gold karigar", "KARIGAR");
    await exchange(c, "CREDIT_TO_INVOICE", "OG-CR-1");
    const creditValue = new Decimal(await credit(c)).toFixed(2);
    await prisma.$transaction(
      (tx) => receiveCustomerGold(tx, { customerId: c, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: "3", reason: "Gold for the ring", idempotencyKey: key("in"), actor: owner() }),
      TX
    );
    await prisma.$transaction(
      (tx) => postCustomerGoldTransfer(tx, { kind: "ISSUE_TO_KARIGAR", customerId: c, purityId: g24, finenessPercent: "99.900", karigarId: karigar, fineWeight: "2", entryDate: DATE, reason: "For the ring", idempotencyKey: key("iss"), actor: owner() }),
      TX
    );
    const job = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { customerId: c, jewelleryType: "RING", designName: "Pay ring", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    await prisma.$transaction(
      (tx) =>
        receiveWithCustomerGold(tx, {
          ...FY,
          jobId: job.id,
          receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "2.002", metalType: "GOLD", purityId: g24, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [],
          returnedMetalLines: [],
          scrapMetalLines: [],
          karigarAddedFineWeight: 0,
          karigarAddedCost: 0,
          labourCharge: 0,
          makingCharge: "1000.00",
          settingCharge: 0,
          platingCharge: 0,
          otherExpense: 0,
          markJobComplete: true,
          isAbnormalLoss: false,
          damagedLostByUserId: ownerId,
          idempotencyKey: key("rcv"),
          createdByUserId: ownerId,
          customerGoldSource: { purityId: g24, finenessPercent: "99.900" },
          actor: owner(),
        }),
      TX
    );
    const bill = await prisma.$transaction(
      (tx) => billCustomerJewellery(tx, { jobId: job.id, billDate: DATE, makingCharge: "40000.00", gstTreatment: "CGST_SGST", gstRatePercent: "3", creditToApply: creditValue, idempotencyKey: key("bill"), actor: owner(), ...FY }),
      TX
    );
    const due = new Decimal(bill.bill.amountDue).toFixed(2); // 41,200.00 − credit
    expect(new Decimal(bill.bill.grandTotal).toFixed(2)).toBe("41200.00");
    await expectParty(c, "CUSTOMER", due, "RECEIVABLE");
    expect((await credit(c)).toFixed(2)).toBe("0.00");

    await receive(c, bank, due);
    await expectParty(c, "CUSTOMER", "0.00", "SETTLED");
    expect((await credit(c)).toFixed(2)).toBe("0.00"); // a payment never creates or uses gold credit
    const statement = await prisma.$transaction((tx) => customerGoldStatement(tx, c, { includeValues: true }), TX);
    expect(statement?.bills?.[0].amountDue).toBe(due); // what was due ON the bill — history, unchanged
    expect(statement?.accountBalance).toBe("0.00"); // what is owed now
    const staffView = await prisma.$transaction((tx) => customerGoldStatement(tx, c, { includeValues: false }), TX);
    expect(staffView?.accountBalance).toBeNull();
    expect(staffView?.bills).toBeNull();
  });
});

describe("Dates and financial years", () => {
  it("18. payments either side of 1 April number in their own financial year; a dated ledger carries the opening balance forward", async () => {
    const s = await party("FY supplier", "SUPPLIER");
    await purchase(s, "5000");
    const march = await give(s, cash, "1000", new Date("2027-03-31T00:00:00.000Z"));
    const april = await give(s, cash, "1500", new Date("2027-04-01T00:00:00.000Z"));
    expect(march.financialYearLabel).toBe("2026-27");
    expect(april.financialYearLabel).toBe("2027-28");
    // Each financial year has its own series (sequence rows persist across runs, so only the series is fixed).
    expect(march.voucherNumber).toMatch(/^PMT-OUT\/2026-27\/\d{4}$/);
    expect(april.voucherNumber).toMatch(/^PMT-OUT\/2027-28\/\d{4}$/);
    await expectParty(s, "SUPPLIER", "-2500.00", "PAYABLE");

    const fromApril = await getPartyLedger(s, { dateFrom: new Date("2027-04-01T00:00:00.000Z") });
    expect(fromApril.map((r) => r.voucherNumber)).toEqual([april.voucherNumber]);
    expect(fromApril[0].runningBalance.toFixed(2)).toBe("-2500.00"); // −4,000 brought forward + 1,500
    const toMarch = await getPartyLedger(s, { dateTo: new Date("2027-03-31T23:59:59.999Z") });
    expect(toMarch.at(-1)?.runningBalance.toFixed(2)).toBe("-4000.00");
  });
});

describe("Everything agrees", () => {
  it("19. every voucher balances to the paisa and the trial balance is zero", async () => {
    expect(await unbalancedVoucherCount()).toBe(0);
    const [tb] = await prisma.$queryRawUnsafe<{ diff: string }[]>(`select (coalesce(sum(debit),0) - coalesce(sum(credit),0))::text diff from journal_entries`);
    expect(new Decimal(tb.diff).toFixed(2)).toBe("0.00");
  });

  it("20. Dashboard, Outstanding, Party Ledger and the account ledger agree for every party", async () => {
    const parties = await getPartyBalances({ includeInactive: true });
    let receivable = new Decimal(0);
    let payable = new Decimal(0);
    for (const p of parties) {
      const raw = await ledgerParty(p.partyId);
      expect(p.balance.toFixed(2)).toBe(raw); // Outstanding / Parties tab
      const ledger = await getPartyLedger(p.partyId);
      expect((ledger.at(-1)?.runningBalance ?? new Decimal(0)).toFixed(2)).toBe(raw); // Ledger tab
      if (p.balance.greaterThan(0)) receivable = receivable.plus(p.balance);
      if (p.balance.lessThan(0)) payable = payable.plus(p.balance.abs());
    }
    // AR 1100 + AP 2000 together equal the net of every party balance (no party-less control lines).
    expect(new Decimal(await ledgerCode("1100")).plus(await ledgerCode("2000")).toFixed(2)).toBe(receivable.minus(payable).toFixed(2));
    // Dashboard: the two control accounts kept apart — each side reconciles to its own control account.
    const dashboard = await getReceivablePayableSummary();
    expect(dashboard.receivable.minus(dashboard.customerCredit).toFixed(2)).toBe(await ledgerCode("1100"));
    expect(dashboard.advancesPaid.minus(dashboard.payable).toFixed(2)).toBe(await ledgerCode("2000"));
  });
});
