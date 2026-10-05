import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  user: { id: "staff-1", role: "STAFF" as "STAFF" | "OWNER", name: "Staff", email: "s@example.test" },
  transaction: vi.fn(),
}));
vi.mock("@/lib/auth/dal", () => ({ requireUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db/prisma", () => ({ prisma: { $transaction: h.transaction, correction: { findUnique: vi.fn() } } }));
vi.mock("@/lib/accounting/company", () => ({ getCompanyFySettings: vi.fn(async () => ({ fyStartMonth: 4, fyStartDay: 1 })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
  entryCorrectionOptionsAction,
  postEntryCorrectionAction,
  previewEntryCorrectionAction,
  reverseEntryCorrectionAction,
} from "./entryCorrections";

const target = { entityType: "DIAMOND_RECEIPT" as const, entityId: "rec-10" };

beforeEach(() => {
  h.transaction.mockReset();
  h.user.role = "STAFF";
});

describe("Correct entry server actions refuse Staff before touching the database", () => {
  it("options, preview, post and reverse each return only a refusal, with no data and no database call", async () => {
    const results = [
      await entryCorrectionOptionsAction(target),
      await previewEntryCorrectionAction({ target, kind: "RETURNED_PIECES", values: { returnedPieces: "20" }, reason: "Manufacturer returned 20 stones" }),
      await postEntryCorrectionAction({ target, kind: "RETURNED_PIECES", values: { returnedPieces: "20" }, reason: "Manufacturer returned 20 stones", idempotencyKey: "key-12345678", fingerprint: "fp" }),
      await reverseEntryCorrectionAction({ correctionId: "c1", reason: "Entered against the wrong receipt" }),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(Object.keys(r).sort()).toEqual(["error", "ok"]);
      expect(JSON.stringify(r)).not.toMatch(/₹|\d{3,}\.\d{2}/);
    }
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it("the Owner reaches the service (inside a transaction with the correction timeout)", async () => {
    h.user.role = "OWNER";
    h.transaction.mockResolvedValue([]);
    const r = await entryCorrectionOptionsAction(target);
    expect(r).toEqual({ ok: true, data: [] });
    expect(h.transaction).toHaveBeenCalledTimes(1);
    expect(h.transaction.mock.calls[0][1]).toMatchObject({ timeout: 30_000 });
  });

  it("rejects an unknown record type even for the Owner", async () => {
    h.user.role = "OWNER";
    const r = await entryCorrectionOptionsAction({ entityType: "VOUCHER" as never, entityId: "x" });
    expect(r).toEqual({ ok: false, error: "Unknown record." });
  });
});
