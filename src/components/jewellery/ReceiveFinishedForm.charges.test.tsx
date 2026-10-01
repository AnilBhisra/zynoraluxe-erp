import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Receipt-charge persistence (production defect on ZL-JJOB-2026-000003): a
 * charge typed into "Labour, making, setting, plating charges & notes" must be
 * saved whether that section is open or collapsed, must be shown in the
 * Preview and the final confirmation, and any edit after Preview blocks Save.
 */
const saved: FormData[] = [];
const cgPreviewMock = vi.fn();
const custodyPreviewMock = vi.fn();
vi.mock("@/app/actions/jewellery", () => ({
  receiveFinishedJewelleryAction: vi.fn(async (_prev: unknown, fd: FormData) => {
    saved.push(fd);
    return { success: true, code: "ZL-JREC-TEST" };
  }),
  previewCustomerGoldReceiptAction: (...args: unknown[]) => cgPreviewMock(...args),
  previewReceiptCustodyAction: (...args: unknown[]) => custodyPreviewMock(...args),
  uploadJewelleryPhotoAction: vi.fn(),
  deleteJewelleryPhotoAction: vi.fn(),
}));

import { ReceiveFinishedForm, type CustodySourceOption, type CustomerGoldSourceOption, type IssuedMetalOption } from "./ReceiveFinishedForm";

const PURITIES = [
  { id: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "100.000" },
  { id: "p14", metalType: "GOLD", displayName: "14K", finenessPercent: "60.000" },
];
const CUSTOMER_24K: CustomerGoldSourceOption = { purityId: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "100.000", onJobFine: "0.000", withKarigarFine: "26.455", safeFine: "3.545" };
const KARIGAR_24K: CustodySourceOption = { purityId: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "100.000", unallocatedGross: "30.000", unallocatedFine: "30.000" };
const COMPANY_24K: IssuedMetalOption = { purityId: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "100.000", isAlloy: false, grossWeight: "50.000", fineWeight: "50.000" };
const ZERO_CHARGES = { labour: "0.00", making: "0.00", setting: "0.00", plating: "0.00", other: "0.00", total: "0.00" };
const EXACT_POSTING = {
  materials: "60807.78",
  charges: "41886.00",
  customerGoldCost: "0.00",
  customerGoldFine: "26.455",
  totalCompanyCost: "102693.78",
  lines: [
    { accountCode: "1340", accountName: "Customer Jewellery Work Awaiting Delivery", debit: "102693.78", credit: "0.00", party: null },
    { accountCode: "1320", accountName: "Jewellery WIP", debit: "0.00", credit: "60807.78", party: null },
    { accountCode: "2000", accountName: "Accounts Payable", debit: "0.00", credit: "41886.00", party: "AMULAY JAWE" },
  ],
  balanced: true,
};
function cgPreview(charges = ZERO_CHARGES, posting: typeof EXACT_POSTING | null = null) {
  return {
    preview: {
      jobCode: "ZL-JJOB-2026-000003", customerName: "YOGESHBHAI SAHYOG", karigarName: "AMULAY JAWE", sourceLabel: "GOLD 24K", sourceFineness: "100.000",
      outputs: [{ netWeight: "44.091", purityDisplayName: "14K", finenessPercent: "60.000", fineWeight: "26.455", customerFine: "26.455" }],
      outputFine: "26.455", customerFineForOutputs: "26.455", companyFineForOutputs: "0.000",
      returned: { gross: "0.000", fine: "0.000" }, scrap: { gross: "0.000", fine: "0.000" }, lossFine: "0.000", neededFine: "26.455",
      onJobBefore: { gross: "0.000", fine: "0.000" }, fromKarigar: { gross: "26.455", fine: "26.455" }, fromSafe: { gross: "0.000", fine: "0.000" },
      karigarAfter: { gross: "0.000", fine: "0.000" }, safeAfter: { gross: "3.545", fine: "3.545" }, onJobAfter: { gross: "0.000", fine: "0.000" },
      completesJob: true, mixed: false,
      company: { pendingBefore: "0.000", finishedFine: "0.000", returnedFine: "0.000", scrapFine: "0.000", processLossFine: "0.000", pendingAfter: "0.000", costMoved: null },
      charges, posting, fingerprint: "cg-fp-exact",
    },
  };
}

let confirms: string[] = [];
beforeEach(() => {
  saved.length = 0;
  confirms = [];
  cgPreviewMock.mockReset();
  custodyPreviewMock.mockReset();
  vi.spyOn(window, "confirm").mockImplementation((msg?: string) => {
    confirms.push(String(msg));
    return true;
  });
  vi.spyOn(window, "alert").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function renderForm(opts: { isOwner?: boolean; customer?: CustomerGoldSourceOption[]; custody?: CustodySourceOption[]; issuedMetal?: IssuedMetalOption[] } = {}) {
  return render(
    <ReceiveFinishedForm
      jobId="job-3"
      jobCode="ZL-JJOB-2026-000003"
      jewelleryType="BRACELET"
      pendingFineWeight={opts.issuedMetal ? "50.000" : "0.000"}
      purities={PURITIES}
      issuedMetal={opts.issuedMetal ?? []}
      alloyPendingGrossWeight="0.000"
      unresolvedDiamonds={[]}
      custodySources={opts.custody ?? []}
      customerGoldSources={opts.customer ?? [CUSTOMER_24K]}
      customerName="YOGESHBHAI SAHYOG"
      isOwner={opts.isOwner ?? true}
    />
  );
}
const toggle = () => screen.getByRole("button", { name: /Labour, making, setting, plating charges|Hide charges & notes/ });
const hidden = (c: HTMLElement, name: string) => (c.querySelector(`input[type="hidden"][name="${name}"]`) as HTMLInputElement | null)?.value;
function enterPiece(net = "44.091", purity = "p14") {
  fireEvent.change(screen.getByLabelText("Net metal weight"), { target: { value: net } });
  fireEvent.change(screen.getByLabelText("Final Purity"), { target: { value: purity } });
}
async function previewCustomerGold() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Preview (again|Customer gold)/ }));
  });
}
async function save() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Receive Finished Jewellery" }));
  });
}

describe("receipt charges persist whether the section is open or collapsed", () => {
  it("₹41,886 entered, section collapsed, Preview and Save → the server receives ₹41,886 both times", async () => {
    cgPreviewMock.mockResolvedValue(cgPreview({ ...ZERO_CHARGES, making: "41886.00", total: "41886.00" }, EXACT_POSTING));
    const { container } = renderForm();
    enterPiece();
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText("Making charge (₹)"), { target: { value: "41886" } });
    fireEvent.click(toggle()); // collapse — the reported sequence
    expect(screen.getByTestId("receipt-charges-section").hasAttribute("hidden")).toBe(true);
    expect(hidden(container, "makingCharge")).toBe("41886");
    expect(screen.getByTestId("collapsed-charges-summary").textContent).toContain("Making ₹41886.00 · Total charges ₹41886.00");
    await previewCustomerGold();
    expect((cgPreviewMock.mock.calls[0][1] as FormData).get("makingCharge")).toBe("41886");
    await save();
    expect(saved).toHaveLength(1);
    expect(saved[0].get("makingCharge")).toBe("41886");
    expect(saved[0].get("labourCharge")).toBe("0");
    expect(saved[0].getAll("makingCharge")).toEqual(["41886"]); // exactly one value, from state
  });

  it("all five charges and the notes survive collapsing and reopening several times, and are all saved", async () => {
    cgPreviewMock.mockResolvedValue(cgPreview());
    renderForm();
    enterPiece();
    fireEvent.click(toggle());
    const values: [string, string][] = [
      ["Labour charge (₹)", "1100"],
      ["Making charge (₹)", "41886"],
      ["Setting charge (₹)", "2200"],
      ["Plating charge (₹)", "330"],
      ["Other job expense (₹)", "44"],
      ["Notes (optional)", "Customer bracelet ZL-BRC-005"],
    ];
    for (const [label, v] of values) fireEvent.change(screen.getByLabelText(label), { target: { value: v } });
    for (let i = 0; i < 3; i++) {
      fireEvent.click(toggle()); // collapse
      fireEvent.click(toggle()); // reopen
      for (const [label, v] of values) expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(v);
    }
    fireEvent.click(toggle()); // leave it collapsed for Save
    await previewCustomerGold();
    await save();
    const fd = saved[0];
    expect([fd.get("labourCharge"), fd.get("makingCharge"), fd.get("settingCharge"), fd.get("platingCharge"), fd.get("otherExpense"), fd.get("notes")]).toEqual([
      "1100", "41886", "2200", "330", "44", "Customer bracelet ZL-BRC-005",
    ]);
  });

  it("the Owner's Preview shows each charge, the charge total, materials, Customer gold ₹0, the expected total and the entry", async () => {
    cgPreviewMock.mockResolvedValue(cgPreview({ ...ZERO_CHARGES, making: "41886.00", total: "41886.00" }, EXACT_POSTING));
    renderForm();
    enterPiece();
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText("Making charge (₹)"), { target: { value: "41886" } });
    fireEvent.click(toggle());
    await previewCustomerGold();
    const box = within(screen.getByTestId("receipt-charges-posting"));
    const text = box.getByText(/Charges:/).closest("div")!.textContent ?? "";
    expect(text).toContain("Making ₹41886.00 · Total charges ₹41886.00");
    expect(text).toContain("Materials ₹60807.78 · Customer-owned Gold ₹0.00 (26.455 g fine)");
    expect(text).toContain("Expected total Company cost ₹102693.78");
    expect(text).toContain("Dr 1340 Customer Jewellery Work Awaiting Delivery ₹102693.78 / Cr 1320 Jewellery WIP ₹60807.78 / Cr 2000 Accounts Payable (AMULAY JAWE) ₹41886.00 — balanced");
    await save();
    expect(confirms[0]).toContain("Charges: Making ₹41886.00 · Total charges ₹41886.00");
    expect(confirms[0]).toContain("Expected total Company cost ₹102693.78");
  });

  it("changing any charge after Preview makes it stale and blocks Save until Preview is run again", async () => {
    cgPreviewMock.mockResolvedValue(cgPreview({ ...ZERO_CHARGES, making: "41886.00", total: "41886.00" }, EXACT_POSTING));
    const { container } = renderForm();
    enterPiece();
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText("Making charge (₹)"), { target: { value: "41886" } });
    await previewCustomerGold();
    const saveButton = screen.getByRole("button", { name: "Receive Finished Jewellery" }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(false);
    for (const label of ["Labour charge (₹)", "Making charge (₹)", "Setting charge (₹)", "Plating charge (₹)", "Other job expense (₹)", "Karigar-added material cost (₹)"]) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      const was = input.value;
      fireEvent.change(input, { target: { value: String(Number(was || 0) + 1) } });
      expect(saveButton.disabled).toBe(true);
      expect(hidden(container, "customerGoldFingerprint")).toBe("");
      fireEvent.change(input, { target: { value: was } });
    }
    expect(saveButton.disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Making charge (₹)"), { target: { value: "41887" } });
    await save();
    expect(saved).toHaveLength(0);
  });

  it("a genuinely blank, collapsed section still saves ₹0 for every charge", async () => {
    cgPreviewMock.mockResolvedValue(cgPreview());
    renderForm();
    enterPiece();
    await previewCustomerGold();
    await save();
    const fd = saved[0];
    expect([fd.get("labourCharge"), fd.get("makingCharge"), fd.get("settingCharge"), fd.get("platingCharge"), fd.get("otherExpense")]).toEqual(["0", "0", "0", "0", "0"]);
    expect(screen.queryByTestId("collapsed-charges-summary")).toBeNull();
  });

  it("Staff: their own collapsed charge is saved and shown, but no server cost (materials, total, entry) ever appears", async () => {
    cgPreviewMock.mockResolvedValue(cgPreview({ ...ZERO_CHARGES, making: "500.00", total: "500.00" }, null));
    renderForm({ isOwner: false });
    enterPiece("1.000", "p24");
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText("Making charge (₹)"), { target: { value: "500" } });
    fireEvent.click(toggle());
    await previewCustomerGold();
    const box = screen.getByTestId("receipt-charges-posting").textContent ?? "";
    expect(box).toContain("Making ₹500.00 · Total charges ₹500.00");
    expect(box).not.toContain("Materials");
    expect(box).not.toContain("Expected total Company cost");
    expect(box).not.toContain("Dr ");
    await save();
    expect(saved[0].get("makingCharge")).toBe("500");
  });

  it("Karigar Metal (Company) receipts: a collapsed charge reaches the Preview and the Save too", async () => {
    custodyPreviewMock.mockResolvedValue({
      preview: {
        jobCode: "ZL-JJOB-2026-000009", karigarName: "AMULAY JAWE", sourceLabel: "GOLD 24K", sourceFineness: "100.000",
        outputs: [{ netWeight: "2.000", purityDisplayName: "24K", finenessPercent: "100.000", fineWeight: "2.000" }],
        outputFine: "2.000", returnedFine: "0.000", scrapFine: "0.000", explicitLossFine: "0.000", neededFine: "2.000", jobPendingFine: "0.000",
        allocation: { fineWeight: "2.000", grossWeight: "2.000", costValue: null }, custodyBefore: { gross: "30.000", fine: "30.000", cost: null },
        custodyAfter: { gross: "28.000", fine: "28.000", cost: null }, jobPendingAfterReceipt: "0.000", completesJob: false, fingerprint: "fp-c",
        charges: { ...ZERO_CHARGES, labour: "700.00", total: "700.00" }, posting: null,
      },
    });
    renderForm({ customer: [], custody: [KARIGAR_24K] });
    enterPiece("2.000", "p24");
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText("Labour charge (₹)"), { target: { value: "700" } });
    fireEvent.click(toggle());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview gold allocation" }));
    });
    expect((custodyPreviewMock.mock.calls[0][1] as FormData).get("labourCharge")).toBe("700");
    expect(screen.getByTestId("receipt-charges-posting").textContent).toContain("Labour ₹700.00 · Total charges ₹700.00");
    await save();
    expect(saved[0].get("labourCharge")).toBe("700");
  });

  it("an ordinary Company receipt (no preview step): a collapsed charge is saved and listed in the confirmation", async () => {
    renderForm({ customer: [], issuedMetal: [COMPANY_24K] });
    enterPiece("50.000", "p24");
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText("Setting charge (₹)"), { target: { value: "1250.50" } });
    fireEvent.click(toggle());
    await save();
    expect(saved[0].get("settingCharge")).toBe("1250.50");
    expect(confirms[0]).toContain("Charges: Setting ₹1250.50 · Total charges ₹1250.50");
  });
});

describe("a successful save reports the receipt code even when the form is gone at once", () => {
  it("onDone gets the saved code from inside the action — before the parent unmounts the form in the same render", async () => {
    const calls: (string | undefined)[] = [];
    let closeFromServer: ((open: boolean) => void) | null = null;
    const { receiveFinishedJewelleryAction } = await import("@/app/actions/jewellery");
    // The server refresh that carries the result also completes the job and
    // hides the form — simulated by closing it before the action resolves.
    vi.mocked(receiveFinishedJewelleryAction).mockImplementationOnce(async (_prev: unknown, fd: FormData) => {
      saved.push(fd);
      closeFromServer?.(false);
      return { success: true, code: "ZL-JREC-TEST" };
    });
    function Parent() {
      // A completed job hides its receive form in the very render that carries
      // the action's result, so only a report from inside the action can arrive.
      const [open, setOpen] = React.useState(true);
      closeFromServer = setOpen;
      return open ? (
        <ReceiveFinishedForm
          jobId="job-3"
          jobCode="ZL-JJOB-2026-000003"
          jewelleryType="BRACELET"
          pendingFineWeight="50.000"
          purities={PURITIES}
          issuedMetal={[COMPANY_24K]}
          alloyPendingGrossWeight="0.000"
          unresolvedDiamonds={[]}
          custodySources={[]}
          customerGoldSources={[]}
          customerName={null}
          isOwner
          onDone={(code) => calls.push(code)}
        />
      ) : (
        <p>closed</p>
      );
    }
    render(<Parent />);
    enterPiece("50.000", "p24");
    await save();
    expect(calls).toEqual(["ZL-JREC-TEST"]);
    expect(screen.getByText("closed")).toBeTruthy();
  });
});
