import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Server Actions create the real Prisma client at import time — mock them out.
const previewMock = vi.fn();
vi.mock("@/app/actions/jewellery", () => ({
  receiveFinishedJewelleryAction: vi.fn(async () => ({ success: true, code: "ZL-JREC-TEST" })),
  previewReceiptCustodyAction: (...args: unknown[]) => previewMock(...args),
  previewCustomerGoldReceiptAction: vi.fn(),
  issueMaterialsAction: vi.fn(),
  uploadJewelleryPhotoAction: vi.fn(),
  deleteJewelleryPhotoAction: vi.fn(),
}));

import { IssueMaterialsForm } from "./IssueMaterialsForm";
import { ReceiveFinishedForm, type CustodySourceOption } from "./ReceiveFinishedForm";

const PURITIES = [
  { id: "p24", metalType: "GOLD", displayName: "24K", finenessPercent: "99.900" },
  { id: "p18", metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" },
];
const SOURCE: CustodySourceOption = {
  purityId: "p24",
  metalType: "GOLD",
  displayName: "24K",
  finenessPercent: "99.900",
  unallocatedGross: "10.010",
  unallocatedFine: "10.000",
};
const PREVIEW = {
  jobCode: "ZL-JJOB-2026-000009",
  karigarName: "Test Karigar",
  sourceLabel: "GOLD 24K",
  sourceFineness: "99.900",
  outputs: [{ netWeight: "4.000", purityDisplayName: "18K", finenessPercent: "75.000", fineWeight: "3.000" }],
  outputFine: "3.000",
  returnedFine: "0.000",
  scrapFine: "0.000",
  explicitLossFine: "0.000",
  neededFine: "3.000",
  jobPendingFine: "0.000",
  allocation: { fineWeight: "3.000", grossWeight: "3.003", costValue: "21391.74" },
  custodyBefore: { gross: "10.010", fine: "10.000", cost: "71305.80" },
  custodyAfter: { gross: "7.007", fine: "7.000", cost: "49914.06" },
  jobPendingAfterReceipt: "0.000",
  completesJob: false,
  fingerprint: "fp-1",
};

function renderForm(isOwner: boolean, custodySources: CustodySourceOption[] = [SOURCE]) {
  return render(
    <ReceiveFinishedForm
      jobId="job-9"
      jobCode="ZL-JJOB-2026-000009"
      jewelleryType="RING"
      pendingFineWeight="0.000"
      purities={PURITIES}
      issuedMetal={[]}
      alloyPendingGrossWeight="0.000"
      unresolvedDiamonds={[]}
      custodySources={custodySources}
      isOwner={isOwner}
    />
  );
}

function enter18KPiece(net: string) {
  fireEvent.change(screen.getByLabelText("Net metal weight"), { target: { value: net } });
  fireEvent.change(screen.getByLabelText("Final Purity"), { target: { value: "p18" } });
}

const hidden = (container: HTMLElement, name: string) => (container.querySelector(`input[name="${name}"]`) as HTMLInputElement | null)?.value;

beforeEach(() => {
  previewMock.mockReset();
  previewMock.mockResolvedValue({ preview: PREVIEW });
});

describe("ReceiveFinishedForm — gold from the Karigar's balance (Owner)", () => {
  it("a job with no gold of its own takes the Karigar's 24K; the finished purity (18K) is chosen separately", () => {
    renderForm(true);
    expect((screen.getByLabelText("Karigar Metal source") as HTMLSelectElement).value).toBe("p24");
    expect(screen.getByText("No metal has been allocated to this job yet.")).toBeTruthy();
    const finalPurity = screen.getByLabelText("Final Purity") as HTMLSelectElement;
    expect([...finalPurity.options].map((o) => o.value)).toEqual(["p24", "p18"]);
  });

  it("save stays blocked until a preview of exactly this receipt; the preview shows units, source, allocation, cost and remaining balance", async () => {
    const { container } = renderForm(true);
    enter18KPiece("4.000");
    const save = screen.getByRole("button", { name: "Receive Finished Jewellery" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(hidden(container, "custodySourcePurityId")).toBe("p24");
    expect(hidden(container, "custodyFingerprint")).toBe("");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview gold allocation" }));
    });
    expect(previewMock).toHaveBeenCalledTimes(1);
    const sent = previewMock.mock.calls[0][1] as FormData;
    expect(sent.get("custodySourcePurityId")).toBe("p24");
    expect(JSON.parse(String(sent.get("outputsJson")))).toEqual([expect.objectContaining({ netMetalWeight: "4.000", purityId: "p18", metalType: "GOLD" })]);
    expect(sent.get("markJobComplete")).toBe("false");

    const box = within(screen.getByTestId("receipt-custody-preview"));
    expect(box.getByText(/4\.000g net metal at 18K \(75\.000%\)/).textContent).toContain("3.000g fine");
    expect(box.getByText("Taken from balance now").nextSibling?.textContent).toContain("3.000g fine = 3.003g gross GOLD 24K");
    expect(box.getByText("Taken from balance now").nextSibling?.textContent).toContain("₹21,391.74");
    expect(box.getByText("Karigar balance").nextSibling?.textContent).toContain("7.000g fine / 7.007g gross remaining");
    expect(box.getByText("Already on this job").nextSibling?.textContent).toBe("0.000g fine");
    expect(save.disabled).toBe(false);
    expect(hidden(container, "custodyFingerprint")).toBe("fp-1");

    // Any change after the preview makes it stale: save blocks again, no fingerprint is sent.
    enter18KPiece("4.100");
    expect(screen.getByText("The receipt changed after the preview. Preview again before saving.")).toBeTruthy();
    expect(save.disabled).toBe(true);
    expect(hidden(container, "custodyFingerprint")).toBe("");
  });

  it("a server refusal (e.g. insufficient balance) is shown and nothing can be saved", async () => {
    previewMock.mockResolvedValue({ error: "Test Karigar has only 10.000 g fine GOLD 24K unallocated." });
    renderForm(true);
    enter18KPiece("4.000");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview gold allocation" }));
    });
    expect(screen.getByText("Test Karigar has only 10.000 g fine GOLD 24K unallocated.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Receive Finished Jewellery" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("completing the job asks for the loss explicitly and never writes off the Karigar's other gold", () => {
    const { container } = renderForm(true);
    enter18KPiece("4.000");
    fireEvent.click(screen.getByLabelText(/This completes the job — the Karigar's other unallocated gold stays in their balance/));
    expect((screen.getByLabelText("Process loss on this job (g fine)") as HTMLInputElement).value).toBe("0.000");
    fireEvent.change(screen.getByLabelText("Process loss on this job (g fine)"), { target: { value: "0.050" } });
    expect(hidden(container, "explicitLossFineWeight")).toBe("0.050");
    expect(hidden(container, "markJobComplete")).toBe("true");
  });
});

// The server sends Staff weights only: every rupee field is null.
const STAFF_PREVIEW = {
  ...PREVIEW,
  outputs: [{ netWeight: "3.520", purityDisplayName: "18K", finenessPercent: "75.000", fineWeight: "2.640" }],
  outputFine: "2.640",
  neededFine: "2.640",
  allocation: { fineWeight: "2.640", grossWeight: "2.643", costValue: null },
  custodyBefore: { gross: "10.010", fine: "10.000", cost: null },
  custodyAfter: { gross: "7.367", fine: "7.360", cost: null },
  fingerprint: "a".repeat(64),
};

describe("ReceiveFinishedForm — Staff", () => {
  it("Staff receive from the job's Karigar balance: source, finished purity, preview in weights, no ₹ anywhere", async () => {
    previewMock.mockResolvedValue({ preview: STAFF_PREVIEW });
    const { container } = renderForm(false);
    expect((screen.getByLabelText("Karigar Metal source") as HTMLSelectElement).value).toBe("p24");
    fireEvent.change(screen.getByLabelText("Net metal weight"), { target: { value: "3.52" } });
    fireEvent.change(screen.getByLabelText("Final Purity"), { target: { value: "p18" } });
    expect([...(screen.getByLabelText("Metal type") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["GOLD"]);
    const save = screen.getByRole("button", { name: "Receive Finished Jewellery" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview gold allocation" }));
    });
    const box = within(screen.getByTestId("receipt-custody-preview"));
    expect(box.getByText("Taken from balance now").nextSibling?.textContent).toBe("2.640g fine = 2.643g gross GOLD 24K");
    expect(box.getByText("Karigar balance").nextSibling?.textContent).toContain("7.360g fine / 7.367g gross remaining");
    expect(save.disabled).toBe(false);
    expect(hidden(container, "custodyFingerprint")).toBe("a".repeat(64));
    // No money figure anywhere (the only ₹ are the existing charge-entry labels
    // Staff type into), and nothing money-related in the preview.
    expect(container.textContent).not.toMatch(/₹\s*[\d,]/);
    expect(screen.getByTestId("receipt-custody-preview").textContent).not.toMatch(/₹|cost|rate|value/i);
  });

  it("a job with no metal and no Karigar balance still lists metals and purities, and says why it cannot be saved", () => {
    renderForm(false, []);
    expect([...(screen.getByLabelText("Metal type") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["GOLD"]);
    fireEvent.change(screen.getByLabelText("Net metal weight"), { target: { value: "3.52" } });
    const purities = [...(screen.getByLabelText("Final Purity") as HTMLSelectElement).options].map((o) => o.value);
    expect(purities).toEqual(expect.arrayContaining(["p24", "p18"]));
    expect(screen.getAllByText(/Ask the Owner to issue the metal to this Karigar in Karigar Metal first/).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Receive Finished Jewellery" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("IssueMaterialsForm — gold comes through Karigar Metal", () => {
  it("offers no gold line and explains where gold comes from; other metals can still be added", () => {
    render(
      <IssueMaterialsForm
        jobId="job-9"
        jobCode="ZL-JJOB-2026-000009"
        purities={[
          { id: "p24", metalType: "GOLD", displayName: "24K" },
          { id: "s925", metalType: "SILVER", displayName: "925" },
        ]}
        availableDiamonds={[]}
        isOwner
      />
    );
    expect(screen.getByTestId("gold-via-karigar-metal").textContent).toContain("Karigar Metal");
    expect(screen.queryByLabelText("Metal type")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "+ Add silver / platinum / copper line" }));
    const types = [...(screen.getByLabelText("Metal type") as HTMLSelectElement).options].map((o) => o.value);
    expect(types).not.toContain("GOLD");
    expect(types).toContain("SILVER");
  });
});
