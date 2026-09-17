import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The entry forms import Server Actions, whose modules create the real Prisma
// client at import time (no DATABASE_URL under Vitest) — mock them out.
vi.mock("@/app/actions/vouchers", () => ({
  createExpense: vi.fn(),
  createPaymentGiven: vi.fn(),
  createPaymentReceived: vi.fn(),
  createPurchase: vi.fn(),
  createSale: vi.fn(),
  cancelVoucherAction: vi.fn(),
}));
vi.mock("@/app/actions/finishedSales", () => ({
  createFinishedJewellerySaleAction: vi.fn(),
  getSuggestedSalePriceAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { TransactionsTab } from "./TransactionsTab";
import type { SerializedVoucherRow } from "./VoucherList";
import { canViewVoucher } from "@/lib/accounting/voucherVisibility";
import type { VoucherType } from "@/generated/prisma/enums";

const D = new Date("2026-09-17T00:00:00.000Z");

function voucher(n: number, voucherType: VoucherType, amount: string, reversalOf: VoucherType | null = null) {
  return {
    row: {
      id: `v${n}`,
      voucherNumber: `V-${String(n).padStart(4, "0")}`,
      voucherType,
      date: D,
      partyName: "PHASE7TEST Party",
      amount,
      status: "POSTED",
      paymentAccountName: null,
      referenceNumber: null,
    } satisfies SerializedVoucherRow,
    reversalOf,
  };
}

// Amounts from the real acceptance run; the internal ones leaked to Staff before.
const ALL = [
  voucher(1, "PURCHASE", "350000.00"),
  voucher(2, "DIAMOND_ISSUE", "90900.00"),
  voucher(3, "DIAMOND_RECEIPT", "5150.00"),
  voucher(4, "DIAMOND_RECEIPT", "2707.89"),
  voucher(5, "JEWELLERY_ISSUE", "150600.00"),
  voucher(6, "JEWELLERY_RECEIPT", "156829.10"),
  voucher(7, "STOCK_ADJUSTMENT", "400.00"),
  voucher(8, "REVERSAL", "3000.00", "PURCHASE"),
  voucher(9, "REVERSAL", "5000.00", "DIAMOND_ISSUE"),
  voucher(10, "SALE", "257500.00"),
  voucher(11, "PAYMENT_GIVEN", "1000.00"),
  voucher(12, "PAYMENT_RECEIVED", "2000.00"),
  voucher(13, "EXPENSE", "750.00"),
];

/** What the Accounting page hands the tab: the server-side rule applied per viewer. */
function vouchersFor(role: "OWNER" | "STAFF") {
  return ALL.filter((v) => canViewVoucher(role, { voucherType: v.row.voucherType, reversalOfVoucherType: v.reversalOf })).map((v) => v.row);
}

function renderTab(role: "OWNER" | "STAFF") {
  return render(
    <TransactionsTab
      parties={[]}
      paymentAccounts={[]}
      gstRates={[]}
      companyStateCode={null}
      vouchers={vouchersFor(role)}
      canCancel={role === "OWNER"}
      showsInternalVouchers={role === "OWNER"}
      availableFinishedItems={[]}
    />
  );
}

describe("Accounting → Transactions", () => {
  it("shows Staff ordinary purchases, sales, payments, expenses and their reversals — with no internal costing voucher or amount", () => {
    const { container } = renderTab("STAFF");
    const list = within(container.querySelector("ul")!);

    for (const label of ["Purchase", "Sale", "Payment Given", "Payment Received", "Expense"]) {
      expect(list.getAllByText(label, { exact: true }).length).toBeGreaterThan(0);
    }
    expect(list.getByText("Reversal", { exact: true })).toBeTruthy();
    expect(container.textContent).toContain("₹3,50,000.00");
    expect(container.textContent).toContain("₹2,57,500.00");

    for (const label of ["Diamond Issue", "Diamond Receipt", "Jewellery Issue", "Jewellery Receipt", "Stock Adjustment"]) {
      expect(list.queryByText(label, { exact: true })).toBeNull();
    }
    for (const amount of ["90,900.00", "5,150.00", "2,707.89", "1,50,600.00", "1,56,829.10", "400.00", "5,000.00"]) {
      expect(container.textContent).not.toContain(amount);
    }
    expect(screen.getByText(/visible to the Owner only/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Cancel/ })).toBeNull();
  });

  it("shows the Owner every voucher, including internal costing entries, without the Staff note", () => {
    const { container } = renderTab("OWNER");
    const list = within(container.querySelector("ul")!);

    expect(list.getAllByRole("listitem")).toHaveLength(ALL.length);
    for (const label of ["Diamond Issue", "Jewellery Issue", "Jewellery Receipt", "Stock Adjustment"]) {
      expect(list.getByText(label, { exact: true })).toBeTruthy();
    }
    expect(list.getAllByText("Diamond Receipt", { exact: true })).toHaveLength(2);
    expect(container.textContent).toContain("₹2,707.89");
    expect(screen.queryByText(/visible to the Owner only/)).toBeNull();
  });
});
