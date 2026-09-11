import { describe, expect, it } from "vitest";

import { createFakeAccountingTx } from "../../../test/fixtures/fakeAccountingTx";
import {
  cancelVoucher,
  postExpense,
  postOpeningBalance,
  postPaymentGiven,
  postPaymentReceived,
  postPurchase,
  postSale,
  PostingError,
} from "./posting";
import { SYSTEM_ACCOUNT_CODES } from "./accounts";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-06-15T00:00:00.000Z");

function common(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    date: DATE,
    ...FY,
    currencyCode: "INR",
    exchangeRate: 1,
    createdByUserId: "user-1",
    ...overrides,
  };
}

function linesFor(fixture: ReturnType<typeof createFakeAccountingTx>, voucherId: string) {
  return fixture.state.journalEntries.filter((e) => e.voucherId === voucherId);
}

function sumBy<K extends string>(lines: Record<string, unknown>[], key: K) {
  return lines.reduce((sum, l) => sum + Number(l[key]), 0);
}

function codeOf(fixture: ReturnType<typeof createFakeAccountingTx>, accountId: unknown) {
  for (const [code, row] of fixture.state.accounts) {
    if (row.id === accountId) return code;
  }
  return undefined;
}

describe("postOpeningBalance", () => {
  it("posts a balanced receivable opening entry", async () => {
    const fixture = createFakeAccountingTx();
    const voucher = await postOpeningBalance(fixture.tx as never, {
      ...common(),
      partyId: "party-1",
      amount: 5000,
      openingBalanceType: "RECEIVABLE",
    });

    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);

    const ar = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE);
    expect(Number(ar?.debit)).toBe(5000);
    expect(ar?.partyId).toBe("party-1");
  });

  it("posts a balanced payable opening entry", async () => {
    const fixture = createFakeAccountingTx();
    const voucher = await postOpeningBalance(fixture.tx as never, {
      ...common(),
      partyId: "party-2",
      amount: 3000,
      openingBalanceType: "PAYABLE",
    });

    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);

    const ap = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE);
    expect(Number(ap?.credit)).toBe(3000);
  });

  it("rejects a zero opening balance", async () => {
    const fixture = createFakeAccountingTx();
    await expect(
      postOpeningBalance(fixture.tx as never, {
        ...common(),
        partyId: "party-1",
        amount: 0,
        openingBalanceType: "RECEIVABLE",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("postPurchase", () => {
  it("posts a balanced credit purchase (no GST)", async () => {
    const fixture = createFakeAccountingTx();
    const voucher = await postPurchase(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      gstTreatment: "NONE",
      lines: [
        {
          description: "Gold chain",
          quantity: 2,
          unit: "GRAM",
          rate: 5000,
          gstRatePercent: 0,
          taxType: "EXCLUSIVE",
        },
      ],
    });

    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    expect(Number(voucher.amount)).toBe(10000);

    const ap = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE);
    expect(Number(ap?.credit)).toBe(10000); // unpaid — full amount sits in AP
    expect(ap?.partyId).toBe("supplier-1");
  });

  it("nets Accounts Payable to zero for a cash purchase settled immediately", async () => {
    const fixture = createFakeAccountingTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;

    const voucher = await postPurchase(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      paymentAccountId: cashId,
      gstTreatment: "NONE",
      lines: [
        { description: "Findings", quantity: 1, unit: "PCS", rate: 1200, gstRatePercent: 0, taxType: "EXCLUSIVE" },
      ],
    });

    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);

    const apLines = lines.filter((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE);
    const apNet = sumBy(apLines, "debit") - sumBy(apLines, "credit");
    expect(apNet).toBeCloseTo(0, 5);

    const cashLine = lines.find((l) => codeOf(fixture, l.accountId) === "1001");
    expect(Number(cashLine?.credit)).toBe(1200); // cash paid out
  });

  it("splits GST into CGST+SGST for an intra-state credit purchase", async () => {
    const fixture = createFakeAccountingTx();
    const voucher = await postPurchase(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      gstTreatment: "CGST_SGST",
      lines: [
        { description: "Gold", quantity: 1, unit: "GRAM", rate: 10000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
      ],
    });

    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);

    const cgst = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.INPUT_CGST);
    const sgst = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.INPUT_SGST);
    expect(Number(cgst?.debit)).toBe(150); // 1.5% of 10000
    expect(Number(sgst?.debit)).toBe(150);
    expect(Number(voucher.amount)).toBe(10300);
  });

  it("posts IGST for an inter-state credit purchase", async () => {
    const fixture = createFakeAccountingTx();
    const voucher = await postPurchase(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      gstTreatment: "IGST",
      lines: [
        { description: "Gold", quantity: 1, unit: "GRAM", rate: 10000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
      ],
    });

    const lines = linesFor(fixture, voucher.id as string);
    const igst = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.INPUT_IGST);
    expect(Number(igst?.debit)).toBe(300);
    expect(lines.some((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.INPUT_CGST)).toBe(false);
  });

  it("rejects a purchase with no lines", async () => {
    const fixture = createFakeAccountingTx();
    await expect(
      postPurchase(fixture.tx as never, {
        ...common(),
        partyId: "supplier-1",
        gstTreatment: "NONE",
        lines: [],
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("postSale", () => {
  it("posts a balanced credit sale", async () => {
    const fixture = createFakeAccountingTx();
    const voucher = await postSale(fixture.tx as never, {
      ...common(),
      partyId: "customer-1",
      gstTreatment: "CGST_SGST",
      lines: [
        { description: "Ring", quantity: 1, unit: "PCS", rate: 20000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
      ],
    });

    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);

    const ar = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE);
    expect(Number(ar?.debit)).toBe(20600);
    const sales = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.SALES_INCOME);
    expect(Number(sales?.credit)).toBe(20000);
  });

  it("nets Accounts Receivable to zero for a cash sale settled immediately", async () => {
    const fixture = createFakeAccountingTx();
    const bankId = fixture.paymentAccountIdByMethod.get("BANK")!;

    const voucher = await postSale(fixture.tx as never, {
      ...common(),
      partyId: "customer-1",
      paymentAccountId: bankId,
      gstTreatment: "NONE",
      lines: [
        { description: "Earrings", quantity: 1, unit: "PCS", rate: 8000, gstRatePercent: 0, taxType: "EXCLUSIVE" },
      ],
    });

    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);

    const arLines = lines.filter((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE);
    const arNet = sumBy(arLines, "debit") - sumBy(arLines, "credit");
    expect(arNet).toBeCloseTo(0, 5);

    const bankLine = lines.find((l) => codeOf(fixture, l.accountId) === "1002");
    expect(Number(bankLine?.debit)).toBe(8000);
  });

  it("computes GST-inclusive pricing correctly", async () => {
    const fixture = createFakeAccountingTx();
    // 10300 inclusive of 3% GST => taxable 10000, tax 300
    const voucher = await postSale(fixture.tx as never, {
      ...common(),
      partyId: "customer-1",
      gstTreatment: "IGST",
      lines: [
        { description: "Bangle", quantity: 1, unit: "PCS", rate: 10300, gstRatePercent: 3, taxType: "INCLUSIVE" },
      ],
    });

    expect(Number(voucher.amount)).toBe(10300);
    const lines = linesFor(fixture, voucher.id as string);
    const sales = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.SALES_INCOME);
    const igst = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.OUTPUT_IGST);
    expect(Number(sales?.credit)).toBe(10000);
    expect(Number(igst?.credit)).toBe(300);
  });
});

describe("postPaymentGiven / postPaymentReceived / postExpense", () => {
  it("posts a balanced payment given, reducing payable", async () => {
    const fixture = createFakeAccountingTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;
    const voucher = await postPaymentGiven(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      paymentAccountId: cashId,
      amount: 2500,
    });
    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    const ap = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE);
    expect(Number(ap?.debit)).toBe(2500);
  });

  it("posts a balanced payment received, reducing receivable", async () => {
    const fixture = createFakeAccountingTx();
    const bankId = fixture.paymentAccountIdByMethod.get("BANK")!;
    const voucher = await postPaymentReceived(fixture.tx as never, {
      ...common(),
      partyId: "customer-1",
      paymentAccountId: bankId,
      amount: 4000,
    });
    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    const ar = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE);
    expect(Number(ar?.credit)).toBe(4000);
  });

  it("posts a balanced expense", async () => {
    const fixture = createFakeAccountingTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;
    const voucher = await postExpense(fixture.tx as never, {
      ...common(),
      paymentAccountId: cashId,
      amount: 300,
    });
    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);
    const expense = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES);
    expect(Number(expense?.debit)).toBe(300);
  });

  it("rejects a zero-amount payment", async () => {
    const fixture = createFakeAccountingTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;
    await expect(
      postPaymentGiven(fixture.tx as never, {
        ...common(),
        partyId: "supplier-1",
        paymentAccountId: cashId,
        amount: 0,
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("cancelVoucher", () => {
  it("reverses a posted voucher's journal entries exactly and marks it cancelled", async () => {
    const fixture = createFakeAccountingTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;
    const original = await postPaymentGiven(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      paymentAccountId: cashId,
      amount: 1000,
    });

    const reversal = await cancelVoucher(fixture.tx as never, {
      voucherId: original.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "Entered by mistake",
      ...FY,
    });

    const originalLines = linesFor(fixture, original.id as string);
    const reversalLines = linesFor(fixture, reversal.id as string);
    expect(reversalLines).toHaveLength(originalLines.length);

    // Combined effect of original + reversal must net to exactly zero on
    // every account touched.
    const allLines = [...originalLines, ...reversalLines];
    const byAccount = new Map<string, number>();
    for (const line of allLines) {
      const key = line.accountId as string;
      byAccount.set(key, (byAccount.get(key) ?? 0) + Number(line.debit) - Number(line.credit));
    }
    for (const net of byAccount.values()) {
      expect(net).toBeCloseTo(0, 5);
    }

    const updatedOriginal = fixture.state.vouchers.get(original.id as string);
    expect(updatedOriginal?.status).toBe("CANCELLED");
    expect(updatedOriginal?.cancellationReason).toBe("Entered by mistake");
  });

  it("refuses to cancel an already-cancelled voucher", async () => {
    const fixture = createFakeAccountingTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;
    const original = await postPaymentGiven(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      paymentAccountId: cashId,
      amount: 1000,
    });

    await cancelVoucher(fixture.tx as never, {
      voucherId: original.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "First cancellation",
      ...FY,
    });

    await expect(
      cancelVoucher(fixture.tx as never, {
        voucherId: original.id as string,
        cancelledByUserId: "owner-1",
        cancellationReason: "Second attempt",
        ...FY,
      })
    ).rejects.toThrow(PostingError);
  });

  it("refuses to cancel a reversal voucher itself", async () => {
    const fixture = createFakeAccountingTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;
    const original = await postPaymentGiven(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      paymentAccountId: cashId,
      amount: 1000,
    });
    const reversal = await cancelVoucher(fixture.tx as never, {
      voucherId: original.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "Mistake",
      ...FY,
    });

    await expect(
      cancelVoucher(fixture.tx as never, {
        voucherId: reversal.id as string,
        cancelledByUserId: "owner-1",
        cancellationReason: "Trying to cancel the reversal",
        ...FY,
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("voucher numbering", () => {
  it("increments sequentially within the same financial year and type", async () => {
    const fixture = createFakeAccountingTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;
    const v1 = await postPaymentGiven(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      paymentAccountId: cashId,
      amount: 100,
    });
    const v2 = await postPaymentGiven(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      paymentAccountId: cashId,
      amount: 200,
    });

    expect(v1.voucherNumber).toBe("PMT-OUT/2026-27/0001");
    expect(v2.voucherNumber).toBe("PMT-OUT/2026-27/0002");
  });

  it("uses independent sequences per voucher type", async () => {
    const fixture = createFakeAccountingTx();
    const cashId = fixture.paymentAccountIdByMethod.get("CASH")!;
    const given = await postPaymentGiven(fixture.tx as never, {
      ...common(),
      partyId: "supplier-1",
      paymentAccountId: cashId,
      amount: 100,
    });
    const received = await postPaymentReceived(fixture.tx as never, {
      ...common(),
      partyId: "customer-1",
      paymentAccountId: cashId,
      amount: 100,
    });

    expect(given.voucherNumber).toBe("PMT-OUT/2026-27/0001");
    expect(received.voucherNumber).toBe("PMT-IN/2026-27/0001");
  });
});
