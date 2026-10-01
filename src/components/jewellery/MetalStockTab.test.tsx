/**
 * Phase 8 Tier 8B — the reworked Opening Metal Stock form is the direct fix
 * for D-1 (an opening entry was saved without anyone seeing the implied
 * per-fine-gram rate). These tests hold that fix in place: both effective
 * rates are always shown with the basis that will be saved, and posting is
 * blocked until the Owner confirms the exact numbers — a confirmation that
 * un-confirms itself the moment any of those numbers change. The Metal Stock
 * history is visible to both roles; Staff rows carry no ₹.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { createOpeningMetalStock } = vi.hoisted(() => ({ createOpeningMetalStock: vi.fn(async () => undefined) }));
vi.mock("@/app/actions/metal", () => ({
  createOpeningMetalStock,
  createMetalPurchase: vi.fn(async () => undefined),
  adjustMetalStockAction: vi.fn(async () => undefined),
  reverseMetalStockAdjustmentAction: vi.fn(async () => undefined),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import type { MetalHistoryPage, MetalHistoryRow } from "@/lib/jewellery/adjustmentHistory";
import { MetalStockTab } from "./MetalStockTab";

const purities = [{ id: "p-91_7", metalType: "GOLD", displayName: "22K (test)", finenessPercent: "91.700" }];
const FILTERS = { category: "ALL" as const, search: "", purityId: "" };

function row(over: Partial<MetalHistoryRow>): MetalHistoryRow {
  return {
    id: "m1",
    kind: "MOVEMENT",
    type: "ADJUSTMENT_IN",
    label: "Added to stock (adjustment)",
    createdAt: "2026-10-01T06:00:00.000Z",
    actorName: "Owner",
    metalType: "GOLD",
    purityDisplayName: "22K (test)",
    grossWeight: "2.000",
    fineWeight: "1.834",
    usableEffect: 1,
    scrapEffect: 0,
    costValue: "12000.00",
    ratePerGrossGram: "6000.0000",
    ratePerFineGram: "6543.0752",
    sourceDocument: "Count difference",
    voucherNumber: "ADJ/2026-27/0001",
    karigarName: null,
    jobCode: null,
    reversalOf: null,
    reversedBy: null,
    transferPairId: null,
    corrections: [],
    revaluedMovementId: null,
    canReverse: true,
    ...over,
  };
}

function renderTab(isOwner = true, history: MetalHistoryPage | null = null) {
  render(
    <MetalStockTab
      buckets={[]}
      purchases={[]}
      suppliers={[]}
      purities={purities}
      paymentAccounts={[]}
      gstRates={[]}
      isOwner={isOwner}
      search=""
      history={history}
      historyFilters={FILTERS}
    />
  );
}

function openOpeningStockForm() {
  fireEvent.click(screen.getByRole("button", { name: "Opening Metal Stock" }));
}

describe("Opening Metal Stock form", () => {
  it("shows fine weight, the basis to be saved and both effective rates live, and blocks submit until confirmed", () => {
    createOpeningMetalStock.mockClear();
    renderTab(true);
    openOpeningStockForm();

    fireEvent.change(screen.getByLabelText(/Gross weight \(g\)/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Rate per GROSS gram (₹)"), { target: { value: "5000" } });

    // Fine weight = 10.000 * 91.700 / 100 = 9.170g.
    expect(screen.getByTestId("opening-fine-weight")).toHaveTextContent("9.170g");
    const costField = screen.getByLabelText(/Cost value \(₹\)/) as HTMLInputElement;
    expect(costField.value).toBe("50000.00");
    expect(screen.getByTestId("effective-rates-basis")).toHaveTextContent("Per gross gram");
    expect(screen.getByTestId("effective-rates-gross")).toHaveTextContent("₹5,000.0000");
    expect(screen.getByTestId("effective-rates-fine")).toHaveTextContent("₹5,452.5627");

    // The Save button is disabled, and a forced submit posts nothing, until the tick.
    const save = screen.getByRole("button", { name: "Save opening stock" });
    expect(save).toBeDisabled();
    fireEvent.submit(save.closest("form")!);
    expect(createOpeningMetalStock).not.toHaveBeenCalled();

    expect(screen.getByTestId("opening-confirm-text")).toHaveTextContent("Rate basis saved: Per gross gram at ₹5000");
    fireEvent.click(screen.getByTestId("confirm-opening-stock"));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(createOpeningMetalStock).toHaveBeenCalledTimes(1);
    const fd = (createOpeningMetalStock.mock.calls[0] as unknown[])[1] as FormData;
    expect([fd.get("rateBasis"), fd.get("rate"), fd.get("costValue"), fd.get("costManuallyEdited")]).toEqual(["PER_GROSS_GRAM", "5000", "50000.00", "false"]);
  });

  it("a FINE-gram rate is multiplied by the fine weight, not the gross weight", () => {
    renderTab(true);
    openOpeningStockForm();
    fireEvent.change(screen.getByLabelText("Rate basis"), { target: { value: "PER_FINE_GRAM" } });
    fireEvent.change(screen.getByLabelText(/Gross weight \(g\)/), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Rate per FINE gram (₹)"), { target: { value: "6543.21" } });
    expect((screen.getByLabelText(/Cost value \(₹\)/) as HTMLInputElement).value).toBe("600012.36");
    expect(screen.getByTestId("effective-rates-basis")).toHaveTextContent("Per fine gram");
  });

  it("un-confirms itself the moment the weight, basis or cost changes after ticking", () => {
    createOpeningMetalStock.mockClear();
    renderTab(true);
    openOpeningStockForm();

    fireEvent.change(screen.getByLabelText(/Gross weight \(g\)/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("Rate per GROSS gram (₹)"), { target: { value: "5000" } });
    fireEvent.click(screen.getByTestId("confirm-opening-stock"));
    expect(screen.getByTestId("confirm-opening-stock")).toBeChecked();

    fireEvent.change(screen.getByLabelText(/Gross weight \(g\)/), { target: { value: "11" } });
    expect(screen.getByTestId("confirm-opening-stock")).not.toBeChecked();
    fireEvent.click(screen.getByTestId("confirm-opening-stock"));
    fireEvent.change(screen.getByLabelText("Rate basis"), { target: { value: "PER_FINE_GRAM" } });
    expect(screen.getByTestId("confirm-opening-stock")).not.toBeChecked();

    fireEvent.submit(screen.getByRole("button", { name: "Save opening stock" }).closest("form")!);
    expect(createOpeningMetalStock).not.toHaveBeenCalled();
  });

  it("a typed-over total is sent as manual and the confirmation says no rate basis is saved", () => {
    renderTab(true);
    openOpeningStockForm();
    fireEvent.change(screen.getByLabelText(/Gross weight \(g\)/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/Cost value \(₹\)/), { target: { value: "48000" } });
    expect(screen.getByTestId("opening-confirm-text")).toHaveTextContent("Total entered directly (no rate basis)");
    expect((document.querySelector('input[name="costManuallyEdited"]') as HTMLInputElement).value).toBe("true");
    expect((document.querySelector('input[name="rateBasis"]') as HTMLInputElement).value).toBe("");
  });
});

describe("Metal Stock history", () => {
  it("Staff see the history link but no Owner-only posting buttons", () => {
    renderTab(false);
    expect(screen.queryByRole("button", { name: "Opening Metal Stock" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Authorized Adjustment" })).not.toBeInTheDocument();
    expect(screen.getByTestId("toggle-history")).toHaveAttribute("href", "/jewellery-jobs?tab=metal&history=1#metal-history");
  });

  it("Owner: rows show value, effective rates, reversal and correction links, and a Reverse action only where allowed", () => {
    renderTab(true, {
      page: 1,
      pageSize: 25,
      hasNextPage: true,
      rows: [
        row({ id: "rev", label: "Reversal — Removed from stock (adjustment)", canReverse: false, reversalOf: { id: "orig", sourceDocument: "Count difference", createdAt: "2026-10-01T05:00:00.000Z" } }),
        row({ id: "orig", canReverse: false, reversedBy: { id: "rev", sourceDocument: "Reversal of count", createdAt: "2026-10-01T06:00:00.000Z" } }),
        row({ id: "open", type: "OPENING_IN", label: "Opening stock", canReverse: false, corrections: [{ correctionCode: "ZL-COR-2026-000001", state: "POSTED", batchCode: "ZL-CB-1" }] }),
        row({ id: "live" }),
      ],
    });
    expect(screen.getByTestId("metal-history-reversal-of-rev")).toHaveTextContent("Reverses Count difference");
    expect(within(screen.getByTestId("metal-history-reversal-of-rev")).getByRole("link")).toHaveAttribute("href", "#mh-orig");
    expect(screen.getByTestId("metal-history-reversed-orig")).toHaveTextContent("Reversed later by");
    expect(screen.getByTestId("metal-history-correction-open")).toHaveTextContent("Revalued via ZL-COR-2026-000001 (batch ZL-CB-1) — posted");
    expect(screen.getByTestId("metal-history-rates-live")).toHaveTextContent("₹6000.0000 per gross gram / ₹6543.0752 per fine gram");
    expect(screen.queryByTestId("reverse-adjustment-orig")).not.toBeInTheDocument();
    expect(screen.getByTestId("reverse-adjustment-live")).toBeInTheDocument();
    expect(screen.getByTestId("metal-history-next")).toHaveAttribute("href", "/jewellery-jobs?tab=metal&history=1&histPage=2#metal-history");
  });

  it("Staff: the same row renders weights only — no ₹, no voucher, no Reverse", () => {
    renderTab(false, {
      page: 1,
      pageSize: 25,
      hasNextPage: false,
      rows: [row({ id: "s1", costValue: null, ratePerGrossGram: null, ratePerFineGram: null, voucherNumber: null, canReverse: false })],
    });
    const r = screen.getByTestId("metal-history-row-s1");
    expect(r).toHaveTextContent("2.000g gross / 1.834g fine · + stock");
    expect(r.textContent).not.toMatch(/₹/);
    expect(screen.queryByTestId("reverse-adjustment-s1")).not.toBeInTheDocument();
  });
});
