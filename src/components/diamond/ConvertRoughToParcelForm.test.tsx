import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { previewAction, convertAction } = vi.hoisted(() => ({ previewAction: vi.fn(), convertAction: vi.fn() }));
vi.mock("@/app/actions/diamond", () => ({
  previewRoughStoneToParcelAction: previewAction,
  convertRoughStoneToParcelAction: convertAction,
}));

import { ConvertRoughToParcelForm } from "@/components/diamond/ConvertRoughToParcelForm";

const eligible = {
  roughPieceId: "piece-1",
  roughCode: "ZL-RGH-2026-000001",
  lotCode: "ZL-RL-2026-000001",
  supplierName: "Test Supplier",
  purchaseDate: "2026-09-20T00:00:00.000Z",
  purchaseVoucherNumber: "PUR-2026-0001",
  kind: "STONE",
  status: "AVAILABLE",
  carat: "224.060",
  allocatedCost: "134436.00",
  issueHistory: [],
  purchaseMovements: 1,
  refusal: null,
};

function open(onDone?: (code: string) => void) {
  render(<ConvertRoughToParcelForm roughPieceId="piece-1" roughCode="ZL-RGH-2026-000001" onDone={onDone} />);
  fireEvent.click(screen.getByRole("button", { name: "Convert to parcel" }));
}

beforeEach(() => {
  previewAction.mockReset();
  convertAction.mockReset();
});

describe("ConvertRoughToParcelForm", () => {
  it("offers no Confirm until a preview is loaded, and needs a 10+ character reason first", () => {
    open();
    expect(screen.queryByRole("button", { name: "Confirm conversion" })).toBeNull();
    const previewButton = screen.getByRole("button", { name: "Preview conversion" });
    expect(previewButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "short" } });
    expect(previewButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Saved as one stone by mistake" } });
    expect(previewButton).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/Number of stones/), { target: { value: "1" } });
    expect(screen.getByText(/at least 2 stones/)).toBeInTheDocument();
    expect(previewButton).toBeDisabled();
  });

  it("shows the real record and what stays unchanged, then submits the PREVIEWED carat and cost", async () => {
    previewAction.mockResolvedValue({ preview: eligible });
    convertAction.mockResolvedValue({ success: true, code: "ZL-RGH-2026-000001" });
    const onDone = vi.fn();
    open(onDone);
    fireEvent.change(screen.getByLabelText(/Number of stones/), { target: { value: "400" } });
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Saved as one stone by mistake" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview conversion" }));
    });
    const panel = await screen.findByTestId("rough-conversion-preview");
    expect(previewAction).toHaveBeenCalledWith("piece-1");
    expect(panel).toHaveTextContent("ZL-RL-2026-000001");
    expect(panel).toHaveTextContent("PUR-2026-0001 (unchanged)");
    expect(panel).toHaveTextContent("224.060ct (unchanged)");
    expect(panel).toHaveTextContent("Parcel of 400 stones");
    expect(panel).toHaveTextContent("Never issued");
    expect(panel).toHaveTextContent(/No new purchase, voucher, journal entry, supplier payable or stock movement/);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm conversion" }));
    });
    await waitFor(() => expect(convertAction).toHaveBeenCalledTimes(1));
    const sent = convertAction.mock.calls[0][1] as FormData;
    expect(Object.fromEntries(sent.entries())).toEqual({
      roughPieceId: "piece-1",
      pieceCount: "400",
      reason: "Saved as one stone by mistake",
      expectedCarat: "224.060",
      expectedCost: "134436.00",
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("ZL-RGH-2026-000001"));
  });

  it("a refused record shows why and offers no Confirm", async () => {
    previewAction.mockResolvedValue({
      preview: { ...eligible, status: "WITH_KARIGAR", refusal: "ZL-RGH-2026-000001 is with a Manufacturer / Karigar." },
    });
    open();
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Saved as one stone by mistake" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Preview conversion" }));
    });
    expect(await screen.findByText(/is with a Manufacturer/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirm conversion" })).toBeNull();
  });
});
