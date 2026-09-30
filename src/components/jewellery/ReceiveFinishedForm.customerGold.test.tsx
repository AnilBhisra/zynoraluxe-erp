import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Server Actions create the real Prisma client at import time — mock them out.
const cgPreviewMock = vi.fn();
vi.mock("@/app/actions/jewellery", () => ({
  receiveFinishedJewelleryAction: vi.fn(async () => ({ success: true, code: "ZL-JREC-TEST" })),
  previewReceiptCustodyAction: vi.fn(),
  previewCustomerGoldReceiptAction: (...args: unknown[]) => cgPreviewMock(...args),
  uploadJewelleryPhotoAction: vi.fn(),
  deleteJewelleryPhotoAction: vi.fn(),
}));

import { ReceiveFinishedForm, type CustodySourceOption, type CustomerGoldSourceOption, type IssuedMetalOption } from "./ReceiveFinishedForm";

const PURITIES = [
  { id: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "99.900" },
  { id: "p18", metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" },
];
const CUSTOMER_24K: CustomerGoldSourceOption = { purityId: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "99.900", onJobFine: "0.000", withKarigarFine: "0.000", safeFine: "10.000" };
const KARIGAR_24K: CustodySourceOption = { purityId: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "99.900", unallocatedGross: "5.005", unallocatedFine: "5.000" };
const PREVIEW = {
  jobCode: "ZL-JJOB-2026-000010",
  customerName: "Asha Patel",
  karigarName: "Test Karigar",
  sourceLabel: "GOLD 24K",
  sourceFineness: "99.900",
  outputs: [{ netWeight: "4.000", purityDisplayName: "18K", finenessPercent: "75.000", fineWeight: "3.000", customerFine: "3.000" }],
  outputFine: "3.000",
  customerFineForOutputs: "3.000",
  companyFineForOutputs: "0.000",
  returned: { gross: "0.000", fine: "0.000" },
  scrap: { gross: "0.000", fine: "0.000" },
  lossFine: "0.000",
  neededFine: "3.000",
  onJobBefore: { gross: "0.000", fine: "0.000" },
  fromKarigar: { gross: "0.000", fine: "0.000" },
  fromSafe: { gross: "3.003", fine: "3.000" },
  karigarAfter: { gross: "0.000", fine: "0.000" },
  safeAfter: { gross: "7.007", fine: "7.000" },
  onJobAfter: { gross: "0.000", fine: "0.000" },
  completesJob: false,
  mixed: false,
  fingerprint: "cg-fp-1",
};

function renderForm(opts: { isOwner: boolean; issuedMetal?: IssuedMetalOption[]; custody?: CustodySourceOption[]; customer?: CustomerGoldSourceOption[] }) {
  return render(
    <ReceiveFinishedForm
      jobId="job-10"
      jobCode="ZL-JJOB-2026-000010"
      jewelleryType="RING"
      pendingFineWeight="0.000"
      purities={PURITIES}
      issuedMetal={opts.issuedMetal ?? []}
      alloyPendingGrossWeight="0.000"
      unresolvedDiamonds={[]}
      custodySources={opts.custody ?? []}
      customerGoldSources={opts.customer ?? [CUSTOMER_24K]}
      customerName="Asha Patel"
      isOwner={opts.isOwner}
    />
  );
}
const hidden = (container: HTMLElement, name: string) => (container.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.value;
function enter18KPiece(net: string) {
  fireEvent.change(screen.getByLabelText("Net metal weight"), { target: { value: net } });
  fireEvent.change(screen.getByLabelText("Final Purity"), { target: { value: "p18" } });
}

beforeEach(() => {
  cgPreviewMock.mockReset();
  cgPreviewMock.mockResolvedValue({ preview: PREVIEW });
});

describe("ReceiveFinishedForm — Customer-owned gold", () => {
  it("a Customer job with no Company metal defaults to the Customer's gold, labelled Customer-owned; no Company return/scrap lines", () => {
    renderForm({ isOwner: true });
    const src = screen.getByLabelText("Customer gold source") as HTMLSelectElement;
    expect(src.value).toBe("p24|99.900");
    expect(src.selectedOptions[0].textContent).toContain("Customer-owned: Asha Patel");
    expect(screen.queryByLabelText("Returned metal purity")).toBeNull();
    expect(screen.queryByLabelText("Karigar Metal source")).toBeNull();
    expect(screen.getByTestId("customer-gold-outcomes")).toBeTruthy();
  });

  it("save is blocked until a fresh preview; the preview shows source, fine used, returns and the remaining balance — never 'loss' for what remains", async () => {
    const { container } = renderForm({ isOwner: true });
    enter18KPiece("4.000");
    const save = screen.getByRole("button", { name: "Receive Finished Jewellery" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(hidden(container, "customerGoldSourcePurityId")).toBe("p24");
    expect(hidden(container, "customerGoldFineness")).toBe("99.900");
    expect(hidden(container, "customerGoldFingerprint")).toBe("");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview Customer gold" }));
    });
    const sent = cgPreviewMock.mock.calls[0][1] as FormData;
    expect(sent.get("customerGoldSourcePurityId")).toBe("p24");
    expect(sent.get("customerFineForOutputs")).toBe("");
    const box = within(screen.getByTestId("receipt-customer-gold-preview"));
    expect(box.getByText("Source").nextSibling?.textContent).toContain("Customer-owned, excluded from Company material cost");
    expect(box.getByText("Taken now").nextSibling?.textContent).toContain("3.000g fine (3.003g gross) from the safe");
    expect(box.getByText("Customer balance after").nextSibling?.textContent).toContain("safe 7.000g");
    expect(box.getByText("Customer balance after").nextSibling?.textContent).toContain("still the Customer's");
    expect(screen.getByTestId("receipt-customer-gold-preview").textContent).not.toMatch(/₹/);
    expect(save.disabled).toBe(false);
    expect(hidden(container, "customerGoldFingerprint")).toBe("cg-fp-1");

    // Stale after any edit.
    enter18KPiece("4.100");
    expect(save.disabled).toBe(true);
    expect(hidden(container, "customerGoldFingerprint")).toBe("");
  });

  it("Staff get returns and scrap but no authorised-loss field", () => {
    renderForm({ isOwner: false });
    expect(screen.getByLabelText("Customer gold returned unused (g gross)")).toBeTruthy();
    expect(screen.getByLabelText("Customer gold scrap (g gross) — stays the Customer's")).toBeTruthy();
    expect(screen.queryByLabelText("Authorised process loss (g fine, Owner)")).toBeNull();
  });

  it("a mixed (Owner-approved) job asks for the Customer's share and keeps the Company return lines", () => {
    renderForm({
      isOwner: true,
      customer: [{ ...CUSTOMER_24K, onJobFine: "2.000" }],
      issuedMetal: [{ purityId: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "99.900", isAlloy: false, grossWeight: "1.001", fineWeight: "1.000" }],
    });
    expect(screen.getByLabelText("Customer's share of the finished pieces' fine gold (g)")).toBeTruthy();
    expect(screen.getByText(/Company gold returned/)).toBeTruthy();
  });

  it("choosing 'Company gold' switches back to the Karigar Metal flow; a Company job never defaults to Customer gold", () => {
    renderForm({ isOwner: true, custody: [KARIGAR_24K] });
    const src = screen.getByLabelText("Customer gold source") as HTMLSelectElement;
    expect(src.value).toBe("");
    expect((screen.getByLabelText("Karigar Metal source") as HTMLSelectElement).value).toBe("p24");
    fireEvent.change(src, { target: { value: "p24|99.900" } });
    expect(screen.queryByLabelText("Karigar Metal source")).toBeNull();
  });
});
