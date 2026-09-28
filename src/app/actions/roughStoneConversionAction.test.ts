import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireOwner, transaction, findUnique } = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  findUnique: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ requireOwner, requireUser: vi.fn() }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: transaction, roughPiece: { findUnique } } }));

import { convertRoughStoneToParcelAction, previewRoughStoneToParcelAction } from "@/app/actions/diamond";

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const valid = {
  roughPieceId: "piece-1",
  pieceCount: "",
  reason: "Saved as one stone by mistake; it is a parcel",
  expectedCarat: "224.060",
  expectedCost: "134436.00",
};

beforeEach(() => {
  requireOwner.mockReset();
  transaction.mockReset();
  findUnique.mockReset();
});

describe("rough stone -> parcel actions are Owner-only", () => {
  it("a Staff user (requireOwner redirects) cannot preview or convert, and nothing is read or written", async () => {
    requireOwner.mockRejectedValue(new Error("NEXT_REDIRECT:/unauthorized"));
    await expect(previewRoughStoneToParcelAction("piece-1")).rejects.toThrow(/NEXT_REDIRECT/);
    await expect(convertRoughStoneToParcelAction(undefined, form(valid))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(findUnique).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe("convert requires the preview's values and a reason", () => {
  beforeEach(() => requireOwner.mockResolvedValue({ id: "owner-1", role: "OWNER" }));

  it("refuses a confirm without previewed carat/cost", async () => {
    const result = await convertRoughStoneToParcelAction(undefined, form({ ...valid, expectedCarat: "", expectedCost: "" }));
    expect(result).toEqual({ error: "Preview the conversion first." });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("refuses a short reason and a stone count of 1", async () => {
    expect((await convertRoughStoneToParcelAction(undefined, form({ ...valid, reason: "oops" })))?.error).toMatch(/at least 10 characters/);
    expect((await convertRoughStoneToParcelAction(undefined, form({ ...valid, pieceCount: "1" })))?.error).toMatch(/at least 2 stones/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("a valid confirm runs one transaction with the 20s allowance and a blank count as 'not recorded'", async () => {
    transaction.mockResolvedValue({ roughCode: "ZL-RGH-2026-000001" });
    const result = await convertRoughStoneToParcelAction(undefined, form(valid));
    expect(result).toEqual({ success: true, code: "ZL-RGH-2026-000001" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0][1]).toEqual({ timeout: 20000 });
  });
});
