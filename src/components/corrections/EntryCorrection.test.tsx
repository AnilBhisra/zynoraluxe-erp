import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({
  options: vi.fn(),
  preview: vi.fn(),
  post: vi.fn(),
  reverse: vi.fn(),
}));
vi.mock("@/app/actions/entryCorrections", () => ({
  entryCorrectionOptionsAction: actions.options,
  previewEntryCorrectionAction: actions.preview,
  postEntryCorrectionAction: actions.post,
  reverseEntryCorrectionAction: actions.reverse,
}));

import { EntryCorrectionHistory, EntryCorrectionPanel } from "@/components/corrections/EntryCorrection";
import type { EntryHistoryItem } from "@/lib/corrections/entry/service";
import type { EntryOption, EntryPreview } from "@/lib/corrections/entry/types";

const TARGET = { entityType: "DIAMOND_RECEIPT" as const, entityId: "rec-10" };
const PIECES: EntryOption = {
  kind: "RETURNED_PIECES",
  label: "Returned pieces",
  entryClass: "QUANTITY",
  fields: [{ field: "returnedPieces", label: "Returned pieces", type: "integer", current: "1" }],
  blockers: [],
  note: "Only the stone count changes.",
  reversible: true,
};
const REVERSAL: EntryOption = { kind: "RECEIPT_REVERSAL", label: "Reverse this receipt", entryClass: "STOCK_ACCOUNTING", fields: [], blockers: [{ code: "ZL-JOB-2026-000011", message: "ZL-RGH-2026-000013 was issued to ZL-JOB-2026-000011 (completed)." }], note: null, reversible: false };
const PREVIEW: EntryPreview = {
  kind: "RETURNED_PIECES",
  target: TARGET,
  entityLabel: "ZL-REC-2026-000010 (ZL-JOB-2026-000010)",
  entryClass: "QUANTITY",
  changes: [{ field: "returnedPieces", label: "Returned pieces", before: "1 pc / 21.642 ct", after: "20 pcs / 21.642 ct" }],
  stock: [{ label: "ZL-RGH-2026-000013 (becomes a counted parcel)", pieces: 19, carat: "0.000", cost: "0.00" }],
  ledger: [],
  affected: ["ZL-RGH-2026-000013"],
  blockers: [],
  fingerprint: "fp-1",
};
const REASON = "Manufacturer returned 20 stones, saved as one row";

async function openPanel() {
  render(<EntryCorrectionPanel target={TARGET} recordLabel="ZL-REC-2026-000010" />);
  await act(async () => {
    fireEvent.click(screen.getByTestId("correct-entry-ZL-REC-2026-000010"));
  });
}

beforeEach(() => {
  for (const f of Object.values(actions)) f.mockReset();
  actions.options.mockResolvedValue({ ok: true, data: [PIECES, REVERSAL] });
  actions.preview.mockResolvedValue({ ok: true, data: PREVIEW });
  actions.post.mockResolvedValue({ ok: true, data: { code: "ZL-COR-2026-000001", replayed: false } });
});

describe("EntryCorrectionPanel", () => {
  it("shows each option's class, the saved value, and the exact blocking code of a blocked option", async () => {
    await openPanel();
    expect(screen.getByText("Count only — no value, no voucher")).toBeTruthy();
    expect(screen.getByText("Saved now: 1")).toBeTruthy();
    expect(screen.getByTestId("entry-blockers-RECEIPT_REVERSAL").textContent).toContain("ZL-JOB-2026-000011");
  });

  it("previews before -> after, the +19 pcs / 0 ct stock line and 'no voucher', then confirms with the preview's fingerprint", async () => {
    const done = vi.fn();
    render(<EntryCorrectionPanel target={TARGET} recordLabel="ZL-REC-2026-000010" onDone={done} />);
    await act(async () => fireEvent.click(screen.getByTestId("correct-entry-ZL-REC-2026-000010")));
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Reason for the correction"), { target: { value: REASON } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview" })));
    expect(actions.preview).toHaveBeenCalledWith({ target: TARGET, kind: "RETURNED_PIECES", values: { returnedPieces: "20" }, reason: REASON });
    expect(screen.getByTestId("entry-preview-changes").textContent).toContain("Returned pieces: 1 pc / 21.642 ct → 20 pcs / 21.642 ct");
    expect(screen.getByTestId("entry-preview-stock").textContent).toContain("+19 pcs · 0.000 ct");
    expect(screen.getByTestId("entry-preview-ledger").textContent).toContain("No voucher and no journal entry");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm correction" })));
    expect(actions.post).toHaveBeenCalledTimes(1);
    expect(actions.post.mock.calls[0][0]).toMatchObject({ target: TARGET, kind: "RETURNED_PIECES", values: { returnedPieces: "20" }, fingerprint: "fp-1" });
    expect(done).toHaveBeenCalledWith("Correction posted — ZL-COR-2026-000001.");
  });

  it("changing a value after Preview discards the preview: Confirm disappears until a fresh Preview", async () => {
    await openPanel();
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Reason for the correction"), { target: { value: REASON } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview" })));
    expect(screen.getByRole("button", { name: "Confirm correction" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "21" } });
    expect(screen.queryByRole("button", { name: "Confirm correction" })).toBeNull();
    expect(screen.queryByTestId("entry-correction-preview")).toBeNull();
  });

  it("a short reason keeps Preview disabled; a refused post shows the server's reason and drops the preview", async () => {
    actions.post.mockResolvedValueOnce({ ok: false, error: "The record changed after this preview was shown." });
    await openPanel();
    fireEvent.change(screen.getByLabelText("Returned pieces"), { target: { value: "20" } });
    fireEvent.change(screen.getByLabelText("Reason for the correction"), { target: { value: "too short" } });
    expect((screen.getByRole("button", { name: "Preview" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for the correction"), { target: { value: REASON } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Preview" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm correction" })));
    expect(screen.getByText("The record changed after this preview was shown.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm correction" })).toBeNull();
  });
});

const ITEM: EntryHistoryItem = {
  id: "c1",
  code: "ZL-COR-2026-000001",
  kind: "RETURNED_PIECES",
  entityId: "rec-10",
  entityLabel: "ZL-REC-2026-000010 (ZL-JOB-2026-000010)",
  state: "ACTIVE",
  reason: REASON,
  by: "Owner",
  at: "2026-10-05T10:00:00.000Z",
  changes: [{ field: "returnedPieces", record: "ZL-REC-2026-000010", before: "1", after: "20" }],
  voucher: null,
  amount: null,
  reversal: null,
  canReverse: true,
  reverseBlockers: [],
};

describe("EntryCorrectionHistory", () => {
  it("shows the active badge, who and why, and the original 1 next to the corrected 20; the Owner may reverse", async () => {
    actions.reverse.mockResolvedValue({ ok: true, data: { code: "ZL-COR-2026-000002" } });
    const done = vi.fn();
    render(<EntryCorrectionHistory items={[ITEM]} isOwner onDone={done} />);
    const card = screen.getByTestId("entry-history-ZL-COR-2026-000001");
    expect(card.textContent).toContain("Active correction");
    expect(card.textContent).toContain("Returned pieces: 1 → 20");
    expect(card.textContent).toContain(REASON);
    fireEvent.click(screen.getByText("Reverse this correction"));
    fireEvent.change(screen.getByLabelText("Reason for reversing ZL-COR-2026-000001"), { target: { value: "Entered against the wrong receipt" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm reversal" })));
    expect(actions.reverse).toHaveBeenCalledWith({ correctionId: "c1", reason: "Entered against the wrong receipt" });
    expect(done).toHaveBeenCalledWith("ZL-COR-2026-000001 reversed by ZL-COR-2026-000002.");
  });

  it("Staff see the history but no reverse action, and a reversed item names its reversal", () => {
    render(
      <EntryCorrectionHistory
        items={[{ ...ITEM, canReverse: false, state: "REVERSED", reversal: { code: "ZL-COR-2026-000002", at: "2026-10-05T11:00:00.000Z", by: "Owner", reason: "Entered against the wrong receipt" } }]}
        isOwner={false}
      />
    );
    expect(screen.queryByText("Reverse this correction")).toBeNull();
    expect(screen.getByTestId("entry-history-reversal").textContent).toContain("Reversed by ZL-COR-2026-000002");
    expect(screen.getByTestId("entry-history-state").textContent).toBe("Reversed");
  });
});
