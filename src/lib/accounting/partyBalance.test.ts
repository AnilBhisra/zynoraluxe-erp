import { describe, expect, it } from "vitest";

import { indiaBusinessDate, indiaToday } from "./financialYear";
import { classifyPartyBalance, formatRupees, fromPaise, paymentEffect, toPaise } from "./partyBalance";

describe("toPaise / fromPaise / formatRupees", () => {
  it("round-trips money strings exactly, rounding half up at the third decimal", () => {
    expect(toPaise("20500.00")).toBe(2050000);
    expect(toPaise("-1234.5")).toBe(-123450);
    expect(toPaise("0.105")).toBe(11);
    expect(toPaise("0.104")).toBe(10);
    expect(toPaise(".5")).toBe(50);
    expect(fromPaise(-123450)).toBe("-1234.50");
    expect(fromPaise(7)).toBe("0.07");
    expect(() => toPaise("12a")).toThrow();
    expect(() => toPaise("")).toThrow();
  });

  it("formats with Indian digit grouping", () => {
    expect(formatRupees("367722.00")).toBe("₹3,67,722.00");
    expect(formatRupees("100000.00")).toBe("₹1,00,000.00");
    expect(formatRupees("999.5")).toBe("₹999.50");
    expect(formatRupees("-20500.00")).toBe("-₹20,500.00");
  });
});

describe("classifyPartyBalance — advances are labelled, never shown as a negative payable/receivable", () => {
  it("a Supplier/Karigar we owe is Payable; one we overpaid is an Advance paid", () => {
    expect(classifyPartyBalance("SUPPLIER", "-60000.00")).toMatchObject({ kind: "PAYABLE", amount: "60000.00", label: "We owe ₹60,000.00" });
    expect(classifyPartyBalance("KARIGAR", "5000.00")).toMatchObject({ kind: "ADVANCE_PAID", amount: "5000.00", label: "Advance paid ₹5,000.00" });
    expect(classifyPartyBalance("MANUFACTURER", "-1.00").kind).toBe("PAYABLE");
    expect(classifyPartyBalance("BROKER", "1.00").kind).toBe("ADVANCE_PAID");
  });

  it("a Customer who owes us is Receivable; one who paid more is Customer credit", () => {
    expect(classifyPartyBalance("CUSTOMER", "8150.00")).toMatchObject({ kind: "RECEIVABLE", label: "Owes us ₹8,150.00" });
    expect(classifyPartyBalance("CUSTOMER", "-850.00")).toMatchObject({ kind: "CUSTOMER_CREDIT", amount: "850.00", label: "Customer credit ₹850.00" });
  });

  it("zero is Settled for everyone", () => {
    for (const type of ["CUSTOMER", "SUPPLIER", "KARIGAR"] as const) {
      expect(classifyPartyBalance(type, "0.00")).toMatchObject({ kind: "SETTLED", label: "Settled" });
      expect(classifyPartyBalance(type, "-0.00").kind).toBe("SETTLED");
    }
  });
});

describe("paymentEffect — the same arithmetic the posting performs", () => {
  it("Payment Given: exact, partial, overpayment and a pure advance", () => {
    expect(paymentEffect("PAYMENT_GIVEN", "SUPPLIER", "-100000.00", "100000")).toMatchObject({ outcome: "EXACT", after: { kind: "SETTLED" } });
    expect(paymentEffect("PAYMENT_GIVEN", "SUPPLIER", "-100000.00", "40000")).toMatchObject({ outcome: "PARTIAL", after: { kind: "PAYABLE", amount: "60000.00" } });
    const over = paymentEffect("PAYMENT_GIVEN", "SUPPLIER", "-100000.00", "100500");
    expect(over).toMatchObject({ outcome: "OVERPAYMENT", after: { kind: "ADVANCE_PAID", amount: "500.00" } });
    expect(over?.outcomeLabel).toMatch(/₹500\.00 becomes an advance paid/);
    expect(paymentEffect("PAYMENT_GIVEN", "KARIGAR", "0.00", "2000")).toMatchObject({ outcome: "ADVANCE", after: { kind: "ADVANCE_PAID", amount: "2000.00" } });
  });

  it("Payment Received: exact, partial and overpayment (customer credit)", () => {
    expect(paymentEffect("PAYMENT_RECEIVED", "CUSTOMER", "8150.00", "8150")).toMatchObject({ outcome: "EXACT", after: { kind: "SETTLED" } });
    expect(paymentEffect("PAYMENT_RECEIVED", "CUSTOMER", "8150.00", "5000")).toMatchObject({ outcome: "PARTIAL", after: { kind: "RECEIVABLE", amount: "3150.00" } });
    expect(paymentEffect("PAYMENT_RECEIVED", "CUSTOMER", "8150.00", "9000")).toMatchObject({ outcome: "OVERPAYMENT", after: { kind: "CUSTOMER_CREDIT", amount: "850.00" } });
  });

  it("ignores empty, zero or malformed amounts", () => {
    expect(paymentEffect("PAYMENT_GIVEN", "SUPPLIER", "-10.00", "")).toBeNull();
    expect(paymentEffect("PAYMENT_GIVEN", "SUPPLIER", "-10.00", "0")).toBeNull();
    expect(paymentEffect("PAYMENT_GIVEN", "SUPPLIER", "-10.00", "abc")).toBeNull();
  });
});

describe("indiaBusinessDate — the Indian calendar date, not the UTC one", () => {
  it("is still the previous UTC date until 05:30 IST, then the Indian date", () => {
    // 00:30 IST on 1 April 2027 = 19:00 UTC on 31 March 2027.
    expect(indiaToday(new Date("2027-03-31T19:00:00.000Z"))).toBe("2027-04-01");
    expect(indiaBusinessDate(new Date("2027-03-31T19:00:00.000Z")).toISOString()).toBe("2027-04-01T00:00:00.000Z");
    // 23:59 IST on 31 March = 18:29 UTC the same day.
    expect(indiaToday(new Date("2027-03-31T18:29:00.000Z"))).toBe("2027-03-31");
    expect(indiaToday(new Date("2026-10-11T03:00:00.000Z"))).toBe("2026-10-11");
  });
});
