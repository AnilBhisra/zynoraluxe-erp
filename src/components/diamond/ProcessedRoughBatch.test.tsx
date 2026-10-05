import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/entryCorrections", () => ({
  entryCorrectionOptionsAction: vi.fn(),
  previewEntryCorrectionAction: vi.fn(),
  postEntryCorrectionAction: vi.fn(),
  reverseEntryCorrectionAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/diamond", () => {
  const names = [
    "uploadDiamondPhotoAction", "deleteDiamondPhotoAction", "createRoughPurchase", "issueRoughAction", "receivePolishedAction",
    "markJobInProgressAction", "cancelDiamondJobAction", "convertPolishedToParcelAction", "previewRoughStoneToParcelAction",
    "convertRoughStoneToParcelAction", "recutPolishedAction", "overrideRoughAllocationAction", "overridePolishedAllocationAction",
    "createPolishedPurchaseAction", "cancelPolishedPurchaseAction", "saveDiamondProcessAction", "receiveProcessedRoughAction",
    "createPacketProcessJobAction", "receivePacketProcessReturnAction", "cancelPacketProcessJobAction", "adjustPacketStockAction",
  ];
  return Object.fromEntries(names.map((n) => [n, vi.fn(async () => undefined)]));
});
vi.mock("@/app/actions/diamondLabourCorrection", () => ({
  previewLabourCorrectionAction: vi.fn(async () => undefined),
  postLabourCorrectionAction: vi.fn(async () => undefined),
  reverseLabourCorrectionAction: vi.fn(async () => undefined),
}));

import { ReceiveProcessedRoughForm } from "@/components/diamond/ReceiveProcessedRoughForm";
import { IssueRoughForm, parcelIssueCheck, type AvailablePieceOption } from "@/components/diamond/IssueRoughForm";
import { RoughStockTab, type SerializedRoughPiece } from "@/components/diamond/RoughStockTab";
import { JobDetailView, type SerializedJobDetail } from "@/components/diamond/JobDetailView";
import { originText, type SerializedRoughOrigin } from "@/components/diamond/roughOrigin";

const ORIGIN: SerializedRoughOrigin = {
  jobCode: "ZL-DJOB-2026-000007",
  processName: "4P / Laser",
  receiptCode: "ZL-PREC-2026-000009",
  issuedPieces: 10,
  issuedCarat: "45.130",
  returnedPieces: 26,
  returnedCarat: "43.500",
  viaParcel: null,
};

const hidden = (container: HTMLElement, name: string) => (container.querySelector(`input[type="hidden"][name="${name}"]`) as HTMLInputElement | null)?.value;
const summary = (id: string) => screen.getByTestId(`summary-${id}`).textContent;

function renderForm(previous = { pieces: 0, carat: "0.000" }, pending = "45.130") {
  return render(
    <ReceiveProcessedRoughForm
      jobId="job-1"
      jobCode="ZL-DJOB-2026-000007"
      processName="4P / Laser"
      pendingCarat={pending}
      issuedPieces={10}
      issuedCarat="45.130"
      returnedPieces={previous.pieces}
      returnedCarat={previous.carat}
      chargeFromAgreedRate
    />
  );
}

let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => confirmSpy.mockRestore());

describe("Receive processed rough — batch / parcel mode", () => {
  it("defaults to Batch / parcel and shows the issued figures", () => {
    renderForm();
    expect((screen.getByLabelText("Batch / parcel — enter total pieces and total weight") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText("Returned pieces")).toBeTruthy();
    expect(screen.getByLabelText("Total returned carat")).toBeTruthy();
    expect(summary("issued")).toBe("10 pcs / 45.130 ct");
    expect(summary("previous")).toBe("0 pcs / 0.000 ct");
  });

  it("26 pcs / 43.500 ct: a higher count is not an error; only the carat gap can become loss", () => {
    const { container } = renderForm();
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "26" } });
    fireEvent.change(screen.getByLabelText("Total returned carat"), { target: { value: "43.500" } });
    expect(summary("this")).toBe("26 pcs / 43.500 ct");
    expect(summary("after")).toBe("26 pcs / 43.500 ct");
    expect(summary("pending")).toBe("1.630 ct");
    expect(summary("loss")).toBe("1.630 ct");
    expect(hidden(container, "mode")).toBe("BATCH");
    expect(hidden(container, "batchPieces")).toBe("26");
    expect(hidden(container, "batchCarat")).toBe("43.500");
    expect(hidden(container, "piecesJson")).toBeUndefined();
    expect((screen.getByRole("button", { name: "Save processed rough" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/must be/)).toBeNull();
  });

  it("a second partial return adds to the first: 14 + 12 = 26 pcs, 22.000 + 21.500 = 43.500 ct", () => {
    renderForm({ pieces: 14, carat: "22.000" }, "23.130");
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Total returned carat"), { target: { value: "21.500" } });
    expect(summary("previous")).toBe("14 pcs / 22.000 ct");
    expect(summary("after")).toBe("26 pcs / 43.500 ct");
    expect(summary("loss")).toBe("1.630 ct");
  });

  it("refuses a fractional piece count, a 4-decimal carat, and more carat than is pending", () => {
    renderForm();
    const save = screen.getByRole("button", { name: "Save processed rough" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Total returned carat"), { target: { value: "10.000" } });
    expect(screen.getByText("Returned pieces must be a whole number of at least 1.")).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "26" } });
    fireEvent.change(screen.getByLabelText("Total returned carat"), { target: { value: "10.0001" } });
    expect(screen.getByText(/at most 3 decimals/)).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Total returned carat"), { target: { value: "45.131" } });
    expect(screen.getByText(/More than the 45.130 ct still pending/)).toBeTruthy();
    expect(save.disabled).toBe(true);
  });
});

describe("Receive processed rough — switching modes never silently loses data", () => {
  it("asks before clearing the batch; cancelling keeps everything", () => {
    confirmSpy.mockReturnValue(false);
    renderForm();
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "26" } });
    fireEvent.click(screen.getByLabelText("Individual pieces — enter each piece separately"));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Batch / parcel — enter total pieces and total weight") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Returned pieces") as HTMLInputElement).value).toBe("26");
  });

  it("switches without asking when nothing was entered; individual rows count as pieces", () => {
    const { container } = renderForm();
    fireEvent.click(screen.getByLabelText("Individual pieces — enter each piece separately"));
    expect(confirmSpy).not.toHaveBeenCalled();
    const individual = screen.getByTestId("individual-fields");
    fireEvent.change(within(individual).getAllByLabelText("Carat")[0], { target: { value: "10.000" } });
    fireEvent.click(screen.getByRole("button", { name: "+ Add another piece" }));
    fireEvent.change(within(individual).getAllByLabelText("Carat")[1], { target: { value: "15.000" } });
    expect(summary("this")).toBe("2 pcs / 25.000 ct");
    expect(hidden(container, "mode")).toBe("INDIVIDUAL");
    expect(JSON.parse(hidden(container, "piecesJson")!)).toHaveLength(2);
    expect(hidden(container, "batchPieces")).toBeUndefined();
  });

  it("confirming the switch back clears the rows and returns to an empty batch", () => {
    renderForm();
    fireEvent.click(screen.getByLabelText("Individual pieces — enter each piece separately"));
    fireEvent.change(screen.getAllByLabelText("Carat")[0], { target: { value: "10.000" } });
    fireEvent.click(screen.getByLabelText("Batch / parcel — enter total pieces and total weight"));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Returned pieces") as HTMLInputElement).value).toBe("");
    expect(summary("this")).toBe("0 pcs / 0.000 ct");
  });
});

describe("a return that completes the job still reports its receipt code", () => {
  it("onDone gets the code from inside the action, although the same refresh hides the form", async () => {
    const calls: string[] = [];
    let closeFromServer: ((open: boolean) => void) | null = null;
    const { receiveProcessedRoughAction } = await import("@/app/actions/diamond");
    vi.mocked(receiveProcessedRoughAction).mockImplementationOnce(async () => {
      closeFromServer?.(false);
      return { success: true, code: "ZL-REC-2026-000001" };
    });
    function Parent() {
      const [open, setOpen] = React.useState(true);
      closeFromServer = setOpen;
      return open ? (
        <ReceiveProcessedRoughForm
          jobId="job-1"
          jobCode="ZL-DJOB-2026-000007"
          processName="4P / Laser"
          pendingCarat="45.130"
          issuedPieces={10}
          issuedCarat="45.130"
          returnedPieces={0}
          returnedCarat="0.000"
          chargeFromAgreedRate
          onDone={(code) => calls.push(code)}
        />
      ) : (
        <p>closed</p>
      );
    }
    render(<Parent />);
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "26" } });
    fireEvent.change(screen.getByLabelText("Total returned carat"), { target: { value: "45.130" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save processed rough" }));
    });
    expect(calls).toEqual(["ZL-REC-2026-000001"]);
    expect(screen.getByText("closed")).toBeTruthy();
  });
});

describe("Issue Rough — a returned parcel in the next process", () => {
  const parcel: AvailablePieceOption = {
    id: "p1",
    roughCode: "ZL-RGH-2026-000040",
    lotCode: null,
    carat: "43.500",
    kind: "PARCEL",
    pieceCount: 26,
    allocatedCost: "460000.00",
    colorEstimate: "G-H",
    clarityNote: null,
    origin: ORIGIN,
  };

  it("checks pieces AND carat with the server's rules", () => {
    expect(parcelIssueCheck(parcel, "16.200", "10")).toEqual({ error: null, before: "26 pcs / 43.500 ct", issued: "10 pcs / 16.200 ct", remaining: "16 pcs / 27.300 ct" });
    expect(parcelIssueCheck(parcel, "43.500", "26").remaining).toBe("0 pcs / 0.000 ct");
    expect(parcelIssueCheck(parcel, "16.200", "26").error).toMatch(/all 26 pieces means issuing all 43.500 ct/);
    expect(parcelIssueCheck(parcel, "43.500", "10").error).toMatch(/all 43.500 ct means issuing all 26 pieces/);
    expect(parcelIssueCheck(parcel, "43.501", "26").error).toMatch(/Only 43.500 ct remain/);
    expect(parcelIssueCheck(parcel, "16.200", "27").error).toMatch(/Only 26 pieces remain/);
    expect(parcelIssueCheck(parcel, "16.200", "").error).toMatch(/number of pieces/);
    expect(parcelIssueCheck(parcel, "16.200", "1.5").error).toMatch(/number of pieces/);
    expect(parcelIssueCheck(parcel, "16.2001", "10").error).toMatch(/at most 3 decimals/);
  });

  it("shows origin, pcs / ct and the exact before / issued / remaining for Staff without any ₹", () => {
    const { container } = render(<IssueRoughForm karigars={[]} availablePieces={[{ ...parcel, allocatedCost: null }]} isOwner={false} />);
    expect(screen.getByTestId(`issue-origin-${parcel.roughCode}`).textContent).toBe(originText(ORIGIN));
    expect(screen.getByTestId(`issue-available-${parcel.roughCode}`).textContent).toBe("26 pcs / 43.500 ct");
    fireEvent.click(screen.getByText(parcel.roughCode));
    fireEvent.change(screen.getByLabelText(`Carat to issue from ${parcel.roughCode}`), { target: { value: "16.200" } });
    fireEvent.change(screen.getByLabelText(`Stones to issue from ${parcel.roughCode}`), { target: { value: "10" } });
    const preview = screen.getByTestId(`issue-preview-${parcel.roughCode}`).textContent;
    expect(preview).toContain("Before: 26 pcs / 43.500 ct");
    expect(preview).toContain("Issued to the next process: 10 pcs / 16.200 ct");
    expect(preview).toContain("Remaining stock: 16 pcs / 27.300 ct");
    expect(container.textContent).not.toContain("₹");
  });
});

describe("Rough Stock and job detail — pcs and ct everywhere; cost only for the Owner", () => {
  const row = (allocatedCost: string | null): SerializedRoughPiece => ({
    id: "p1",
    roughCode: "ZL-RGH-2026-000040",
    kind: "PARCEL",
    pieceCount: 16,
    originalCarat: "43.500",
    originalPieceCount: 26,
    originalCost: allocatedCost ? "460000.00" : null,
    parentRoughCode: null,
    withParty: null,
    carat: "27.300",
    allocatedCost,
    costLocked: false,
    status: "AVAILABLE",
    colorEstimate: "G-H",
    clarityNote: null,
    returnedFromJobCode: ORIGIN.jobCode,
    origin: ORIGIN,
    convertedToParcel: null,
    photoUrl: null,
  });
  const stockProps = { lots: [], suppliers: [], paymentAccounts: [], gstRates: [], search: "" };

  it("Rough Stock lists the returned batch parcel with its remaining and returned pcs / ct", () => {
    render(<RoughStockTab {...stockProps} returnedRough={[row("288689.66")]} isOwner />);
    const card = screen.getByTestId("returned-rough-ZL-RGH-2026-000040");
    expect(within(card).getByTestId("returned-rough-balance").textContent).toContain("16 pcs / 27.300 ct");
    expect(within(card).getByTestId("returned-rough-balance").textContent).toContain("remaining of 26 pcs / 43.500 ct returned");
    expect(within(card).getByTestId("returned-rough-origin").textContent).toBe(
      "4P / Laser · job ZL-DJOB-2026-000007: issued 10 pcs / 45.130 ct → returned 26 pcs / 43.500 ct (receipt ZL-PREC-2026-000009)"
    );
    expect(card.textContent).toContain("₹2,88,689.66");
  });

  it("Staff see the same pcs / ct and no ₹", () => {
    render(<RoughStockTab {...stockProps} returnedRough={[row(null)]} isOwner={false} />);
    const card = screen.getByTestId("returned-rough-ZL-RGH-2026-000040");
    expect(card.textContent).toContain("16 pcs / 27.300 ct");
    expect(card.textContent).not.toContain("₹");
  });

  it("job detail states the lineage: Issued 10 pcs / 45.130 ct → 4P / Laser returned 26 pcs / 43.500 ct", () => {
    const job: SerializedJobDetail = {
      id: "job-1",
      jobCode: "ZL-DJOB-2026-000007",
      karigarName: "Laser House",
      requiredShape: "ROUND",
      customShapeName: null,
      customShapeMeasurements: null,
      customShapeInstruction: null,
      customShapeReferencePhotoUrl: null,
      issueDate: "2026-10-05T00:00:00.000Z",
      dueDate: null,
      issuedPiecesCount: 10,
      issuedRoughCarat: "45.130",
      receivedPolishedCarat: "0.000",
      returnedRoughCarat: "43.500",
      returnedRoughPieces: 26,
      pendingCarat: "0.000",
      status: "COMPLETED",
      issuedCostValue: null,
      remainingWipCost: null,
      totalLabourCharge: null,
      notes: null,
      isCompleted: true,
      finalWeightLossCarat: "1.630",
      finalYieldPercent: "0.000",
      cancellationReason: null,
      processName: "4P / Laser",
      processOutputKind: "ROUGH",
      chargeRateBasis: "PER_CARAT",
      chargeRate: null,
      pieces: [{ roughCode: "ZL-RGH-2026-000001", carat: "4.513", pieces: 1, kind: "STONE", lotCode: "ZL-RL-2026-000001", origin: null }],
      receipts: [
        {
          id: "r1",
          receiptCode: "ZL-PREC-2026-000009",
          receiveDate: "2026-10-05T00:00:00.000Z",
          polishedCount: 0,
          totalPolishedCarat: "0.000",
          returnedRoughCarat: "43.500",
          returnedRoughPieces: 26,
          returnedRows: [{ roughCode: "ZL-RGH-2026-000040", kind: "PARCEL", pieces: 26, carat: "43.500" }],
          weightLossCarat: "1.630",
          yieldPercent: "96.388",
          labourCharge: null,
          labourCorrection: null,
          perIssuedCaratLabour: null,
        },
      ],
      timeline: [{ id: "m1", type: "ROUGH_RETURN_IN", pieces: 26, carat: "43.500", costValue: null, sourceDocument: "ZL-PREC-2026-000009", createdAt: "2026-10-05T00:00:00.000Z" }],
    };
    const { container } = render(<JobDetailView job={job} isOwner={false} />);
    expect(screen.getByTestId("job-lineage").textContent).toContain("Issued: 10 pcs / 45.130 ct → 4P / Laser returned: 26 pcs / 43.500 ct · final weight loss 1.630 ct");
    expect(screen.getByTestId("receipt-returned-rows").textContent).toBe("ZL-RGH-2026-000040 (batch 26 pcs / 43.500 ct)");
    expect(container.textContent).toContain("26 pcs · 43.500 ct");
    expect(container.textContent).not.toContain("₹");
  });
});
