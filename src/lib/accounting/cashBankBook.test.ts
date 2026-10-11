import { describe, expect, it } from "vitest";

import type { CashBookRow } from "./cashBankBook";
import { cashBookCsv } from "./cashBankBook";
import { cashBookQuery, defaultCashBookDates, hasRowFilters, parseCashBookFilters } from "./cashBankBookFilters";
import { Decimal } from "./money";
import { daysBetween, oldestOpenCharge, totalsOf } from "./receivablePayable";

const D = { dateFrom: "2026-04-01", dateTo: "2026-10-11" };

describe("parseCashBookFilters / cashBookQuery", () => {
  it("defaults, normalises and ignores junk", () => {
    expect(parseCashBookFilters({}, D)).toMatchObject({ account: "ALL", ...D, direction: "ALL", includeReversals: true, page: 1, partyType: "", voucherType: "" });
    const f = parseCashBookFilters({ direction: "paid", partyType: "karigar", voucherType: "payment_given", dateFrom: "2026-13-01", dateTo: "2026-05-01", page: "-3", reversals: "hide" }, D);
    expect(f).toMatchObject({ direction: "PAID", partyType: "KARIGAR", voucherType: "PAYMENT_GIVEN", dateFrom: "2026-04-01", dateTo: "2026-05-01", page: 1, includeReversals: false });
    expect(parseCashBookFilters({ dateFrom: "2026-09-30", dateTo: "2026-09-01" }, D)).toMatchObject({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
    expect(parseCashBookFilters({ voucherType: "DROP TABLE" }, D).voucherType).toBe("");
  });

  it("round-trips through the query string used by links, print and CSV", () => {
    const f = parseCashBookFilters({ account: "pa1", direction: "RECEIVED", party: "Sudhir", q: "PMT-IN", reversals: "hide", page: "2" }, D);
    expect(parseCashBookFilters(Object.fromEntries(new URLSearchParams(cashBookQuery(f))), D)).toEqual(f);
    expect(hasRowFilters(parseCashBookFilters({}, D))).toBe(false);
    expect(hasRowFilters(f)).toBe(true);
  });

  it("defaults to the current financial year in India dates", () => {
    expect(defaultCashBookDates({ fyStartMonth: 4, fyStartDay: 1 }, new Date("2026-10-11T03:00:00Z"))).toEqual({ dateFrom: "2026-04-01", dateTo: "2026-10-11" });
    expect(defaultCashBookDates({ fyStartMonth: 4, fyStartDay: 1 }, new Date("2027-03-31T18:00:00Z"))).toEqual({ dateFrom: "2026-04-01", dateTo: "2027-03-31" });
  });
});

describe("cashBookCsv", () => {
  const row = (over: Partial<CashBookRow>): CashBookRow => ({
    lineId: "l", voucherId: "v", voucherNumber: "PMT-IN/2026-27/0001", voucherType: "PAYMENT_RECEIVED", status: "POSTED", businessDate: "2026-10-10",
    createdAt: new Date(), paymentAccountId: "b", paymentAccountName: "Bank", partyId: "p", partyName: "SUDHIRBHAI", partyType: "CUSTOMER",
    referenceNumber: null, note: null, received: new Decimal("8150.00"), paid: new Decimal(0), runningBalance: new Decimal("-12350.00"),
    reversesId: null, reversesNumber: null, reversesType: null, reversedById: null, reversedByNumber: null, ...over,
  });
  it("keeps numbers as numbers, quotes commas and neutralises formula text", () => {
    const csv = cashBookCsv([row({ note: '=HYPERLINK("x"), ok', partyName: "A, B" })], () => "Payment Received").split("\r\n");
    expect(csv[1]).toBe('2026-10-10,PMT-IN/2026-27/0001,Payment Received,Received,"A, B",CUSTOMER,Bank,,"\'=HYPERLINK(""x""), ok",8150.00,0.00,-12350.00,POSTED,');
  });
  it("labels a reversal with what it reverses and links both halves", () => {
    const csv = cashBookCsv(
      [row({ voucherType: "REVERSAL", reversesType: "PAYMENT_RECEIVED", reversesNumber: "PMT-IN/2026-27/0001", received: new Decimal(0), paid: new Decimal("8150.00") })],
      (t) => (t === "PAYMENT_RECEIVED" ? "Payment Received" : t)
    ).split("\r\n");
    expect(csv[1]).toContain("Reversal of Payment Received,Paid,");
    expect(csv[1].endsWith("reverses PMT-IN/2026-27/0001")).toBe(true);
  });
});

describe("oldestOpenCharge — first in, first out", () => {
  const l = (date: string, charge: string, settle = "0") => ({ date, charge: new Decimal(charge), settle: new Decimal(settle) });
  it("settles the oldest charge first", () => {
    expect(oldestOpenCharge([l("2026-05-01", "100"), l("2026-06-01", "50"), l("2026-07-01", "0", "120")])).toBe("2026-06-01");
    expect(oldestOpenCharge([l("2026-05-01", "100"), l("2026-07-01", "0", "100")])).toBeNull();
    expect(oldestOpenCharge([l("2026-05-01", "100"), l("2026-07-01", "0", "60")])).toBe("2026-05-01");
  });
  it("an earlier advance absorbs a later charge", () => {
    expect(oldestOpenCharge([l("2026-05-01", "0", "500"), l("2026-06-01", "300")])).toBeNull();
    expect(oldestOpenCharge([l("2026-05-01", "0", "500"), l("2026-06-01", "800")])).toBe("2026-06-01");
  });
  it("days outstanding counts whole India days", () => {
    expect(daysBetween("2026-10-03", "2026-10-11")).toBe(8);
  });
});

describe("totalsOf — groups reconcile to the control accounts", () => {
  it("receivable − customer credit and payable − advance are the two control balances", () => {
    const t = totalsOf([
      { receivableSide: new Decimal("4000"), payableSide: new Decimal("4000") },
      { receivableSide: new Decimal("-850"), payableSide: new Decimal("0") },
      { receivableSide: new Decimal("0"), payableSide: new Decimal("-500") },
    ]);
    expect([t.receivable, t.payable, t.advancesPaid, t.customerCredit, t.net].map((d) => d.toFixed(2))).toEqual(["4000.00", "4000.00", "500.00", "850.00", "-350.00"]);
  });
});
