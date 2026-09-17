import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Decimal } from "decimal.js";

// ReportsView.tsx also exports views that render CustomerRefundForm, which
// imports Server Actions from "@/app/actions/finishedSales" — that module
// creates the real Prisma client at import time, which throws under Vitest
// (no DATABASE_URL). Mock it so importing ReportsView.tsx stays side-effect
// free, matching the pattern used for other "use client" component tests
// that share a file with Server-Action-wired forms (see SettingsForms.test.tsx).
vi.mock("@/app/actions/finishedSales", () => ({
  createCustomerRefundAction: vi.fn(),
}));

import { FinishedSalesReportView, ProfitAndLossView } from "./ReportsView";
import type { FinishedJewellerySaleLineReportRow } from "@/lib/jewellery/reports";

function line(overrides: Partial<FinishedJewellerySaleLineReportRow>): FinishedJewellerySaleLineReportRow {
  return {
    saleId: "s1",
    saleCode: "ZL-FJS-2026-000001",
    saleStatus: "POSTED",
    saleDate: new Date("2026-09-01"),
    customerName: "Test Customer",
    finishedCode: "ZL-FJ-2026-000001",
    itemDescription: "Ring",
    taxableValue: new Decimal(100000),
    cogsAmount: new Decimal(60000),
    grossProfit: new Decimal(40000),
    returnStatus: "NONE",
    ...overrides,
  };
}

/** A cancelled sale reverses BOTH its revenue and its COGS in full (see
 * cancelFinishedJewellerySale); a returned line (sellable or damaged)
 * likewise reverses the original sale's revenue, with its cost either
 * returned to inventory or reclassified as Damaged Jewellery Loss — never
 * left standing as this sale's COGS. Neither kind of row still contributes
 * real, realized profit, so the report must not sum their frozen historical
 * figures into its headline totals, or display a numeric "Gross profit" for
 * them as if it were still realized (the exact defect a live Phase 6 E2E
 * run against real data surfaced: a cancelled IGST sale's stale COGS
 * snapshot, ₹3,20,545.46, was being added straight into the report's
 * top-line Gross profit figure). */
describe("FinishedSalesReportView — cancelled/returned lines must not read as realized profit", () => {
  it("excludes a CANCELLED sale's line from the headline Sales/COGS/Gross profit totals", () => {
    const active = line({ saleId: "active", saleCode: "ZL-FJS-2026-000001" });
    const cancelled = line({
      saleId: "cancelled",
      saleCode: "ZL-FJS-2026-000002",
      saleStatus: "CANCELLED",
      taxableValue: new Decimal(42345.67),
      cogsAmount: new Decimal(320545.46),
      grossProfit: new Decimal(-278199.79),
    });
    const { container } = render(<FinishedSalesReportView lines={[active, cancelled]} manualSales={[]} />);
    const summary = container.querySelector("p")!.textContent!;

    // Only the active line's ₹100,000 / ₹60,000 / ₹40,000 is summed — the
    // cancelled line's inflated, reversed figures must not leak into the total.
    expect(summary).toContain("₹1,00,000.00");
    expect(summary).toContain("₹60,000.00");
    expect(summary).toContain("₹40,000.00");
    expect(summary).not.toContain("3,20,545");
    expect(container.textContent).not.toMatch(/[-−]2,78,199/);
  });

  it("excludes RETURNED (sellable and damaged) lines from the headline totals", () => {
    const active = line({ saleId: "active", saleCode: "ZL-FJS-2026-000001" });
    const returnedSellable = line({
      saleId: "returned-sellable",
      saleCode: "ZL-FJS-2026-000003",
      returnStatus: "RETURNED_SELLABLE",
      taxableValue: new Decimal(135000),
      cogsAmount: new Decimal(22909.08),
      grossProfit: new Decimal(112090.92),
    });
    const returnedDamaged = line({
      saleId: "returned-damaged",
      saleCode: "ZL-FJS-2026-000004",
      returnStatus: "RETURNED_DAMAGED",
      taxableValue: new Decimal(50000),
      cogsAmount: new Decimal(30545.46),
      grossProfit: new Decimal(19454.54),
    });
    const { container } = render(
      <FinishedSalesReportView lines={[active, returnedSellable, returnedDamaged]} manualSales={[]} />
    );
    const summary = container.querySelector("p")!.textContent!;

    expect(summary).toContain("₹1,00,000.00");
    expect(summary).toContain("₹60,000.00");
    expect(summary).toContain("₹40,000.00");
    expect(screen.getByText(/2 cancelled\/returned lines excluded/)).toBeTruthy();
  });

  it("renders a dash instead of a numeric Gross profit figure for a cancelled row, while still showing its historical taxable/COGS values for audit purposes", () => {
    const cancelled = line({
      saleId: "cancelled",
      saleCode: "ZL-FJS-2026-000002",
      saleStatus: "CANCELLED",
      taxableValue: new Decimal(42345.67),
      cogsAmount: new Decimal(320545.46),
      grossProfit: new Decimal(-278199.79),
    });
    const { container } = render(<FinishedSalesReportView lines={[cancelled]} manualSales={[]} />);

    // The row's own historical taxable/COGS values remain visible...
    expect(screen.getByText(/42,345\.67/)).toBeTruthy();
    expect(screen.getByText(/3,20,545\.46/)).toBeTruthy();
    // ...but the per-row Gross profit cell is a dash, not the stale figure.
    expect(container.textContent).not.toMatch(/[-−]2,78,199/);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("(cancelled)")).toBeTruthy();
  });

  it("sums every line and shows no exclusion note when nothing is cancelled or returned", () => {
    const a = line({ saleId: "a", saleCode: "ZL-FJS-2026-000001" });
    const b = line({ saleId: "b", saleCode: "ZL-FJS-2026-000002" });
    const { container } = render(<FinishedSalesReportView lines={[a, b]} manualSales={[]} />);
    const summary = container.querySelector("p")!.textContent!;

    expect(summary).toContain("₹2,00,000.00");
    expect(summary).toContain("₹1,20,000.00");
    expect(summary).toContain("₹80,000.00");
    expect(screen.queryByText(/excluded/)).toBeNull();
  });
});

describe("ProfitAndLossView — expense accounts without their own line", () => {
  const d = (v: string) => new Decimal(v);
  const pnl = {
    salesIncome: d("250000"),
    purchases: d("0"),
    businessExpenses: d("400"),
    otherExpenses: [{ code: "5400", name: "Brokerage & Commission", amount: d("500") }],
    otherExpensesTotal: d("500"),
    provisionalProfit: d("249100"),
    grossSales: d("250000"),
    salesReturns: d("0"),
    netSales: d("250000"),
    finishedJewelleryCogs: d("78776.55"),
    grossProfit: d("171223.45"),
    grossMarginPercent: d("68.49"),
    damagedJewelleryLoss: d("0"),
    netProfit: d("170323.45"),
    manualSalesAmount: d("0"),
    manualSalesCount: 0,
  };

  it("lists Brokerage & Commission once as an expense line and shows the Net profit that includes it", () => {
    render(<ProfitAndLossView pnl={pnl as never} />);
    const brokerage = screen.getAllByText("Brokerage & Commission");
    expect(brokerage).toHaveLength(1);
    expect(brokerage[0].nextSibling?.textContent).toBe("− ₹500.00");
    expect(screen.getByText("Business expenses").nextSibling?.textContent).toBe("− ₹400.00");
    expect(screen.getByText("Net profit").nextSibling?.textContent).toBe("₹1,70,323.45");
  });
});
