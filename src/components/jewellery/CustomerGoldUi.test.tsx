import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/customerGold", () => ({
  approveCustomerGoldMixAction: vi.fn(),
  billCustomerJewelleryAction: vi.fn(),
  deliverCustomerJewelleryAction: vi.fn(),
  previewCustomerJewelleryBillAction: vi.fn(),
  reverseCustomerJewelleryBillAction: vi.fn(),
  reverseCustomerJewelleryDeliveryAction: vi.fn(),
  postCustomerGoldTransferAction: vi.fn(),
  previewCustomerGoldIntakeAction: vi.fn(),
  previewCustomerGoldPurchaseAction: vi.fn(),
  previewCustomerGoldTransferAction: vi.fn(),
  purchaseCustomerGoldAction: vi.fn(),
  receiveCustomerGoldAction: vi.fn(),
  reverseCustomerGoldEntryAction: vi.fn(),
}));
vi.mock("@/app/actions/jewellery", () => ({ uploadJewelleryPhotoAction: vi.fn(), deleteJewelleryPhotoAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { CustomerGoldTab, type CustomerGoldTabData } from "./CustomerGoldTab";
import { JobCustomerGoldPanel, type SerializedJobCustomerGold } from "./JobCustomerGoldPanel";

const POOL = {
  customerId: "c1",
  customerName: "Asha Patel",
  metalType: "GOLD",
  purityId: "p24",
  purityDisplayName: "24K",
  finenessPercent: "99.900",
  received: "10.000",
  safe: "5.000",
  withKarigar: "0.000",
  onJobs: "0.000",
  finishedAwaitingDelivery: "3.000",
  delivered: "2.000",
  returnedToCustomer: "0.000",
  authorisedLoss: "0.000",
  scrapHeld: "0.000",
  boughtByCompany: "0.000",
  remaining: "8.000",
  receivedGross: "10.010",
  remainingGross: "8.008",
  difference: "0.000",
  byKarigar: [],
  byJob: [],
};
const TOTALS = { received: "10.000", safe: "5.000", withKarigar: "0.000", onJobs: "0.000", finishedAwaitingDelivery: "3.000", delivered: "2.000", returnedToCustomer: "0.000", authorisedLoss: "0.000", scrapHeld: "0.000", boughtByCompany: "0.000", difference: "0.000" };

function tabData(isOwner: boolean): CustomerGoldTabData {
  return {
    isOwner,
    customers: [{ id: "c1", name: "Asha Patel" }],
    selectedCustomerId: "c1",
    statement: {
      customer: { id: "c1", name: "Asha Patel", phone: null, address: null },
      pools: [POOL],
      intakeReceipts: [],
      entries: [],
      purchases: [],
      pieces: [],
      bills: isOwner ? [] : null,
      deliveries: [],
    },
    purities: [{ id: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "99.900" }],
    karigars: [{ id: "k1", name: "Test Karigar" }],
    customerJobs: [],
    reports: { karigarWise: [], jobWise: [], awaiting: [], exceptions: [], totals: TOTALS },
  };
}

describe("Customer Gold tab", () => {
  it("shows every balance of the pool and a zero global difference", () => {
    render(<CustomerGoldTab {...tabData(true)} />);
    expect(screen.getByTestId("cg-Unallocated (safe)").textContent).toContain("5.000 g");
    expect(screen.getByTestId("cg-Finished, awaiting delivery").textContent).toContain("3.000 g");
    expect(screen.getByTestId("cg-Remaining (Customer's, with us)").textContent).toContain("8.000 g");
    expect(screen.getByTestId("cg-difference").textContent).toContain("0.000 g");
  });

  it("intake needs an explicit choice between Customer-owned gold and a purchase/exchange (Owner)", () => {
    render(<CustomerGoldTab {...tabData(true)} />);
    fireEvent.click(screen.getByRole("button", { name: "Receive gold from Asha Patel" }));
    expect(screen.queryByTestId("cg-intake-form")).toBeNull();
    expect(screen.queryByTestId("cg-purchase-form")).toBeNull();
    fireEvent.click(screen.getByLabelText(/Customer-owned gold — for manufacturing/));
    expect(screen.getByTestId("cg-intake-form")).toBeTruthy();
    expect(screen.getByText(/Declared value/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Purchase\/exchange gold from Customer/));
    expect(screen.getByTestId("cg-purchase-form")).toBeTruthy();
    expect(screen.queryByTestId("cg-intake-form")).toBeNull();
  });

  it("Staff see weights only: no intake, movement, purchase or reversal controls and no ₹", () => {
    const { container } = render(<CustomerGoldTab {...tabData(false)} />);
    expect(screen.queryByRole("button", { name: /Receive gold/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move Customer gold/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Buy from safe balance/ })).toBeNull();
    expect(container.textContent).not.toMatch(/₹/);
  });
});

const PANEL: SerializedJobCustomerGold = {
  jobId: "j1",
  jobCode: "ZL-JJOB-2026-000010",
  customerId: "c1",
  customerName: "Asha Patel",
  sources: { label: "Customer-owned gold", customerGoldOnJob: [], customerGoldConsumedFine: "3.000", companyViaKarigarMetalFine: "0.000", companyDirectIssueFine: "0.000", mixApproved: false },
  pieces: [{ id: "f1", finishedCode: "ZL-FJ-1", status: "CUSTOMER_AWAITING_DELIVERY", netMetalWeight: "4.000", customerGoldFineWeight: "3.000", companyCost: null }],
  deliveryBlock: null,
  deliveries: [],
  bills: null,
  creditAvailable: null,
};

describe("Job Customer Gold panel", () => {
  it("labels the gold source and the Customer gold as excluded from Company material cost", () => {
    render(<JobCustomerGoldPanel data={PANEL} isOwner={false} onDone={() => {}} />);
    expect(screen.getByTestId("job-gold-source").textContent).toBe("Customer-owned gold");
    expect(screen.getByTestId("job-customer-gold-used").textContent).toContain("Customer-owned — excluded from Company material cost");
  });

  it("Staff can open the delivery form but see no bill and no money", () => {
    const { container } = render(<JobCustomerGoldPanel data={PANEL} isOwner={false} onDone={() => {}} />);
    expect(screen.queryByTestId("job-customer-bill")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Deliver to the Customer" }));
    expect(screen.getByTestId("deliver-form")).toBeTruthy();
    expect(container.textContent).not.toMatch(/₹/);
  });

  it("an unreconciled job shows why delivery is refused instead of the form", () => {
    render(<JobCustomerGoldPanel data={{ ...PANEL, deliveryBlock: "ZL-JJOB-2026-000010 is not completed" }} isOwner={true} onDone={() => {}} />);
    expect(screen.getByTestId("delivery-block").textContent).toContain("not completed");
    expect(screen.queryByRole("button", { name: "Deliver to the Customer" })).toBeNull();
  });

  it("the Owner sees the Company work cost with Customer gold at ₹0, and the bill section", () => {
    render(<JobCustomerGoldPanel data={{ ...PANEL, pieces: [{ ...PANEL.pieces[0], companyCost: "10200.00" }], bills: [], creditAvailable: "14000.00" }} isOwner={true} onDone={() => {}} />);
    expect(screen.getByTestId("job-customer-pieces").textContent).toContain("Company work cost ₹10200.00 (Customer gold ₹0)");
    expect(screen.getByTestId("job-customer-bill")).toBeTruthy();
  });
});
