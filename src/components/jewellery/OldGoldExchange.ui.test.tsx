/**
 * Phase 8C UI — the one-step Old Gold Exchange form and the purchase list's
 * acknowledgment / reversal controls. Server actions are mocked; what is
 * proven here is what the screen sends and shows (and never shows Staff).
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  previewExchange: vi.fn(),
  exchange: vi.fn(),
  checkReversal: vi.fn(),
  reverse: vi.fn(),
}));
vi.mock("@/app/actions/customerGold", () => ({
  discardCustomerGoldPhotoAction: vi.fn(async () => ({ discarded: true })),
  exchangeOldGoldAction: (...a: unknown[]) => m.exchange(...a),
  postCustomerGoldTransferAction: vi.fn(),
  previewCustomerGoldIntakeAction: vi.fn(),
  previewCustomerGoldPurchaseAction: vi.fn(),
  previewCustomerGoldPurchaseReversalAction: (...a: unknown[]) => m.checkReversal(...a),
  previewCustomerGoldTransferAction: vi.fn(),
  previewOldGoldExchangeAction: (...a: unknown[]) => m.previewExchange(...a),
  purchaseCustomerGoldAction: vi.fn(),
  receiveCustomerGoldAction: vi.fn(),
  reverseCustomerGoldEntryAction: vi.fn(),
  reverseCustomerGoldPurchaseAction: (...a: unknown[]) => m.reverse(...a),
}));
vi.mock("@/app/actions/jewellery", () => ({ uploadJewelleryPhotoAction: vi.fn(), deleteJewelleryPhotoAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { CustomerGoldTab, type CustomerGoldTabData } from "./CustomerGoldTab";

const PREVIEW = {
  customerName: "Asha Patel",
  purityDisplayName: "22K",
  finenessPercent: "91.600",
  statedPurity: "22K hallmark",
  grossWeight: "10.255",
  deductionWeight: "0.250",
  netGrossWeight: "10.005",
  fineWeight: "9.165",
  rateBasis: "PER_FINE_GRAM",
  rate: "6543.2199",
  value: "59968.61",
  perGrossGram: "5993.8641",
  perFineGram: "6543.2199",
  settlement: "CREDIT_TO_INVOICE",
  creditBefore: "0.00",
  creditAfter: "59968.61",
  fingerprint: "fp-1",
};
const PURCHASE = {
  id: "pur1",
  purchaseCode: "ZL-CGP-2026-000001",
  date: "2026-10-01T00:00:00.000Z",
  purityDisplayName: "22K",
  gross: "10.005",
  fine: "9.165",
  settlement: "CREDIT_TO_INVOICE",
  fromCustody: true,
  intakeReceiptCode: "ZL-CGR-2026-000001",
  reference: "OG-SLIP-0001",
  status: "POSTED",
  reversedAt: null,
  rateBasis: "PER_FINE_GRAM",
  rate: "6543.2199",
  approvedValue: "59968.61",
};

function data(isOwner: boolean): CustomerGoldTabData {
  return {
    isOwner,
    customers: [{ id: "c1", name: "Asha Patel" }],
    selectedCustomerId: "c1",
    statement: {
      customer: { id: "c1", name: "Asha Patel", phone: null, address: null },
      pools: [],
      intakeReceipts: [],
      entries: [],
      purchases: [isOwner ? PURCHASE : { ...PURCHASE, rateBasis: null, rate: null, approvedValue: null }],
      pieces: [],
      bills: isOwner ? [] : null,
      deliveries: [],
      credit: isOwner ? { granted: "59968.61", applied: "10000.00", available: "49968.61" } : null,
    },
    purities: [{ id: "p22", metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" }],
    karigars: [],
    customerJobs: [],
    reports: { karigarWise: [], jobWise: [], awaiting: [], exceptions: [], totals: {} },
  };
}

function openExchange() {
  fireEvent.click(screen.getByRole("button", { name: "Receive gold from Asha Patel" }));
  fireEvent.click(screen.getByLabelText(/Purchase\/exchange gold from Customer/));
}
function fillExchange() {
  fireEvent.change(screen.getByLabelText(/Stated purity/), { target: { value: "22K hallmark" } });
  fireEvent.change(screen.getByLabelText(/Gross weight \(g, as weighed\)/), { target: { value: "10.255" } });
  fireEvent.change(screen.getByLabelText(/Allowed deduction/), { target: { value: "0.250" } });
  fireEvent.change(screen.getByLabelText(/Rate per FINE gram/), { target: { value: "6543.21987" } });
  fireEvent.change(screen.getByLabelText(/Reference \(required/), { target: { value: "OG-SLIP-0001" } });
  fireEvent.change(screen.getByLabelText(/Reason \/ notes/), { target: { value: "Old bangles exchanged" } });
}

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
});

describe("Old Gold Exchange form (Owner)", () => {
  it("needs a reference; previews stated vs tested purity, value, rates and credit; posts only after approval with the preview fingerprint", async () => {
    m.previewExchange.mockResolvedValue({ preview: PREVIEW });
    m.exchange.mockResolvedValue({ success: true, code: "ZL-CGP-2026-000001", id: "pur1" });
    render(<CustomerGoldTab {...data(true)} />);
    openExchange();
    fillExchange();
    fireEvent.change(screen.getByLabelText(/Reference \(required/), { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Preview exchange" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reference \(required/), { target: { value: "OG-SLIP-0001" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview exchange" }));
    });
    const sent = m.previewExchange.mock.calls[0][1] as FormData;
    expect([sent.get("statedPurity"), sent.get("weight"), sent.get("deductionWeight"), sent.get("rateBasis"), sent.get("rate"), sent.get("reference"), sent.get("inputBasis")]).toEqual([
      "22K hallmark",
      "10.255",
      "0.250",
      "PER_FINE_GRAM",
      "6543.21987",
      "OG-SLIP-0001",
      "GROSS",
    ]);
    const p = screen.getByTestId("cg-exchange-preview").textContent ?? "";
    expect(p).toContain("stated 22K hallmark, tested 22K (91.600%)");
    expect(p).toContain("net 10.005 g = 9.165 g fine");
    expect(screen.getByTestId("cg-exchange-value").textContent).toContain("Rate saved: ₹6543.2199 per fine gram → value ₹59968.61 (= ₹5993.8641 per gross gram / ₹6543.2199 per fine gram)");
    expect(screen.getByTestId("cg-exchange-credit").textContent).toContain("₹0.00 → ₹59968.61");
    const post = screen.getByRole("button", { name: "Approve and post exchange" });
    expect(post).toBeDisabled();
    fireEvent.click(screen.getByLabelText("I approve this exchange"));
    await act(async () => {
      fireEvent.click(post);
    });
    const posted = m.exchange.mock.calls[0][1] as FormData;
    expect([posted.get("previewFingerprint"), posted.get("approved")]).toEqual(["fp-1", "1"]);
    expect(posted.get("idempotencyKey")).toBeTruthy();
    expect(screen.getByTestId("cg-exchange-done").textContent).toContain("ZL-CGP-2026-000001");
    expect(screen.getByRole("link", { name: "Print the exchange acknowledgment" })).toHaveAttribute("href", "/customer-gold/purchase/pur1");
  });

  it("changing anything after the preview hides it — a stale preview can never be approved", async () => {
    m.previewExchange.mockResolvedValue({ preview: PREVIEW });
    render(<CustomerGoldTab {...data(true)} />);
    openExchange();
    fillExchange();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview exchange" }));
    });
    expect(screen.getByTestId("cg-exchange-preview")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Allowed deduction/), { target: { value: "0.300" } });
    expect(screen.queryByTestId("cg-exchange-preview")).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve and post exchange" })).toBeNull();
  });
});

describe("Approved purchases list — acknowledgment, credit and reversal", () => {
  it("Owner: shows credit given / applied / available; a blocked reversal shows exactly why and offers no confirm", async () => {
    m.checkReversal.mockResolvedValue({ purchaseId: "pur1", block: "Part of this credit was already applied to a bill" });
    render(<CustomerGoldTab {...data(true)} />);
    expect(screen.getByTestId("cg-credit-available").textContent).toBe("₹49968.61");
    expect(screen.getByRole("link", { name: "Acknowledgment" })).toHaveAttribute("href", "/customer-gold/purchase/pur1");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reverse ZL-CGP-2026-000001" }));
    });
    expect(screen.getByTestId("cg-purchase-block-ZL-CGP-2026-000001").textContent).toContain("already applied to a bill");
    expect(screen.queryByRole("button", { name: /Confirm reversal/ })).toBeNull();
  });

  it("Owner: a clear reversal needs a 10-character reason and sends one idempotency key", async () => {
    m.checkReversal.mockResolvedValue({ purchaseId: "pur1", block: null });
    m.reverse.mockResolvedValue({ success: true, code: "ZL-CGP-2026-000001" });
    render(<CustomerGoldTab {...data(true)} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reverse ZL-CGP-2026-000001" }));
    });
    const confirm = screen.getByRole("button", { name: "Confirm reversal of ZL-CGP-2026-000001" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason for reversing/), { target: { value: "Rate agreed wrongly" } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    const fd = m.reverse.mock.calls[0][1] as FormData;
    expect([fd.get("purchaseId"), fd.get("reason")]).toEqual(["pur1", "Rate agreed wrongly"]);
    expect(fd.get("idempotencyKey")).toBeTruthy();
  });

  it("Staff: weights and codes only — no ₹, no rate, no credit card, no reversal, no acknowledgment link", () => {
    const { container } = render(<CustomerGoldTab {...data(false)} />);
    expect(screen.getByTestId("cg-purchase-ZL-CGP-2026-000001").textContent).toContain("9.165 g fine");
    expect(container.textContent).not.toMatch(/₹/);
    expect(screen.queryByTestId("cg-credit")).toBeNull();
    expect(screen.queryByRole("button", { name: /Reverse ZL-CGP/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Acknowledgment" })).toBeNull();
  });
});
