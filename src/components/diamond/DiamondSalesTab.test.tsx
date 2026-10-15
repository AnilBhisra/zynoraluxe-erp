import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/diamondSale", () => ({
  previewDiamondSaleAction: vi.fn(),
  postDiamondSaleAction: vi.fn(),
  cancelDiamondSaleAction: vi.fn(),
  returnDiamondSaleAction: vi.fn(),
}));

import { DiamondSalesTab, type DiamondSaleRow } from "@/components/diamond/DiamondSalesTab";

const customers = [
  { id: "c1", name: "Walk-in Customer", type: "CUSTOMER" as const, stateCode: "24", clearingEnabled: false },
  { id: "c2", name: "Etsy", type: "CUSTOMER" as const, stateCode: null, clearingEnabled: true },
];
const stones = [{ id: "s1", code: "ZL-POL-2026-0001", label: "Round VS", carat: "2.500" }];
const packets = [{ id: "p1", code: "ZL-PKT-2026-0001", label: "Round 1.5 mm", pieces: 10, carat: "5.000" }];
const sale = (cost: string | null): DiamondSaleRow => ({
  id: "d1",
  saleCode: "ZL-DS-2026-0001",
  voucherId: "v1",
  voucherNumber: "SAL/2026-27/0009",
  date: "2026-10-14",
  customerName: "Walk-in Customer",
  status: "POSTED",
  createdBy: "Staff",
  taxableTotal: "50000.00",
  taxTotal: "0.00",
  grandTotal: "50000.00",
  cogsTotal: cost,
  grossProfit: cost === null ? null : "10000.00",
  lines: [{ id: "l1", description: "ZL-POL-2026-0001 — Round 2.500 ct", pieces: 1, carat: "2.500", lineTotal: "50000.00", cogsAmount: cost, returnCode: null }],
  returns: [],
});
const renderTab = (isOwner: boolean) =>
  render(<DiamondSalesTab isOwner={isOwner} customers={customers} paymentAccounts={[{ id: "pa1", name: "Cash" }]} stones={stones} packets={packets} sales={[sale(isOwner ? "40000.00" : null)]} />);

describe("Diamond Sales tab", () => {
  it("shows the live base amount for a stone sold per carat: 2.500 CT × ₹20,000.00/CT = ₹50,000.00", () => {
    renderTab(false);
    fireEvent.change(screen.getByTestId("ds-source"), { target: { value: "s1" } });
    fireEvent.change(screen.getByTestId("ds-rate"), { target: { value: "20000" } });
    expect(screen.getByTestId("ds-line-amount").textContent).toContain("2.500 CT × ₹20,000.00/CT = ₹50,000.00");
    expect(screen.getByTestId("ds-totals").textContent).toContain("grand total ₹50,000.00");
  });

  it("a packet line asks for pieces and carat and prices per piece", () => {
    renderTab(false);
    fireEvent.change(screen.getByLabelText("Stone or packet"), { target: { value: "PACKET" } });
    fireEvent.change(screen.getByTestId("ds-source"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("Pieces sold"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Carat sold"), { target: { value: "2.000" } });
    fireEvent.change(screen.getByTestId("ds-pricing"), { target: { value: "PER_PIECE" } });
    fireEvent.change(screen.getByTestId("ds-rate"), { target: { value: "5000" } });
    expect(screen.getByTestId("ds-line-amount").textContent).toContain("₹20,000.00");
  });

  it("a marketplace Customer disables Paid now and asks for the clearing currency", () => {
    renderTab(false);
    fireEvent.change(screen.getByTestId("ds-customer"), { target: { value: "c2" } });
    expect((screen.getByTestId("ds-payment") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByTestId("clearing-sale-fields")).toBeTruthy();
  });

  it("Staff see the sale but never its cost or gross profit, and get no cancel / return", () => {
    renderTab(false);
    const row = within(screen.getByTestId("diamond-sales-list")).getByTestId("ds-row");
    expect(row.textContent).toContain("₹50000.00");
    expect(row.textContent).not.toMatch(/cost|profit|40000/i);
    expect(within(row).queryByText("Cancel sale")).toBeNull();
    expect(within(row).queryByText("Customer return")).toBeNull();
  });

  it("the Owner sees cost and gross profit and can cancel or record a return", () => {
    renderTab(true);
    const row = within(screen.getByTestId("diamond-sales-list")).getByTestId("ds-row");
    expect(row.textContent).toContain("cost ₹40000.00 · gross profit ₹10000.00");
    expect(within(row).getByText("Cancel sale")).toBeTruthy();
    expect(within(row).getByText("Customer return")).toBeTruthy();
  });
});
