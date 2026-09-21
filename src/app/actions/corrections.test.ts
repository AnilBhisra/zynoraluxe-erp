import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  correctionFindUnique: vi.fn(),
  revalidatePath: vi.fn(),
  getCompanyFySettings: vi.fn(),
  planOpeningStockRevaluation: vi.fn(),
  planOpeningStockLedgerBackfill: vi.fn(),
  replanCorrection: vi.fn(),
  postCorrection: vi.fn(),
  saveCorrectionDraft: vi.fn(),
  approveCorrectionDraft: vi.fn(),
  rejectCorrectionDraft: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireUser: mocks.requireUser,
  requireOwner: mocks.requireOwner,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    correction: { findUnique: mocks.correctionFindUnique },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/accounting/company", () => ({ getCompanyFySettings: mocks.getCompanyFySettings }));

vi.mock("@/lib/corrections/openingStockCorrection", () => ({
  planOpeningStockRevaluation: mocks.planOpeningStockRevaluation,
  planOpeningStockLedgerBackfill: mocks.planOpeningStockLedgerBackfill,
  replanCorrection: mocks.replanCorrection,
}));

vi.mock("@/lib/corrections/engine", () => ({
  postCorrection: mocks.postCorrection,
  saveCorrectionDraft: mocks.saveCorrectionDraft,
  approveCorrectionDraft: mocks.approveCorrectionDraft,
  rejectCorrectionDraft: mocks.rejectCorrectionDraft,
}));

import { CorrectionError } from "@/lib/corrections/types";
import {
  approveCorrection,
  postOpeningStockCorrection,
  previewOpeningStockCorrection,
  rejectCorrection,
  saveOpeningStockCorrectionDraft,
} from "./corrections";

const OWNER = { id: "owner-1", role: "OWNER" as const };
const STAFF = { id: "staff-1", role: "STAFF" as const };

const samplePlan = {
  entityType: "METAL_OPENING_STOCK",
  entityId: "mv-1",
  entityLabel: "Opening stock 24K 22.001g",
  mode: "REVALUE",
  reason: "Opening gold was valued at half the actual rate.",
  originalSnapshot: { costValue: "160000.00" },
  correctedSnapshot: { costValue: "351664.00" },
  downstream: [
    { kind: "FINISHED", tableName: "finished_jewellery", recordId: "fj-1", recordLabel: "ZL-FJ-1", description: "carries 4.162g" },
  ],
  impacts: [
    { kind: "STOCK", tableName: "metal_stock_movements", recordId: "pool", recordLabel: "24K usable stock", field: "costValue", oldValue: "102657.40", newValue: "193361.21" },
  ],
  ledgerLines: [
    { accountCode: "1300", debit: "90703.81", description: "Revaluation" },
    { accountCode: "3000", credit: "191664.00", description: "Revaluation" },
  ],
  amount: "191664.00",
  voucherNote: "Opening metal stock revaluation",
  revaluations: [],
};

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(OWNER);
  mocks.requireOwner.mockResolvedValue(OWNER);
  mocks.getCompanyFySettings.mockResolvedValue({ fyStartMonth: 4, fyStartDay: 1 });
  mocks.planOpeningStockRevaluation.mockResolvedValue(samplePlan);
  mocks.planOpeningStockLedgerBackfill.mockResolvedValue({ ...samplePlan, mode: "REVERSE_REPOST" });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    typeof fn === "function" ? fn({}) : fn
  );
});

describe("previewOpeningStockCorrection", () => {
  it("returns the impact preview without writing anything", async () => {
    const result = await previewOpeningStockCorrection(undefined,
      form({ movementId: "mv-1", newCostValue: "351664", reason: "Valued at half the rate." })
    );

    expect(result?.preview?.amount).toBe("191664.00");
    expect(result?.preview?.impacts[0].recordLabel).toBe("24K usable stock");
    expect(result?.preview?.downstream).toHaveLength(1);
    expect(result?.preview?.ledgerLines).toEqual([
      { accountCode: "1300", debit: "90703.81", credit: null },
      { accountCode: "3000", debit: null, credit: "191664.00" },
    ]);
    expect(mocks.postCorrection).not.toHaveBeenCalled();
    expect(mocks.saveCorrectionDraft).not.toHaveBeenCalled();
  });

  it("is available to Staff — looking is not deciding", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    const result = await previewOpeningStockCorrection(undefined,
      form({ movementId: "mv-1", newCostValue: "351664", reason: "check" })
    );
    expect(result?.preview).toBeDefined();
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });

  it("reports a refusal from the planner in plain words", async () => {
    mocks.planOpeningStockRevaluation.mockRejectedValue(
      new CorrectionError("ZL-FJ-2026-000087 has already been sold.")
    );
    const result = await previewOpeningStockCorrection(undefined,
      form({ movementId: "mv-1", newCostValue: "351664", reason: "check" })
    );
    expect(result?.error).toBe("ZL-FJ-2026-000087 has already been sold.");
  });
});

describe("saveOpeningStockCorrectionDraft", () => {
  it("lets Staff prepare a draft and never posts it", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.saveCorrectionDraft.mockResolvedValue({ correctionCode: "CORR-DRAFT-abc", state: "AWAITING_APPROVAL" });

    const result = await saveOpeningStockCorrectionDraft(undefined,
      form({ movementId: "mv-1", newCostValue: "351664", reason: "Prepared for Owner review." })
    );

    expect(result).toEqual({ success: true, code: "CORR-DRAFT-abc" });
    expect(mocks.saveCorrectionDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preparedByUserId: "staff-1", submitForApproval: true })
    );
    expect(mocks.postCorrection).not.toHaveBeenCalled();
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });

  it("rejects a reason that is too short to explain anything", async () => {
    const result = await saveOpeningStockCorrectionDraft(undefined,
      form({ movementId: "mv-1", newCostValue: "351664", reason: "oops" })
    );
    expect(result?.error).toContain("reason");
    expect(mocks.saveCorrectionDraft).not.toHaveBeenCalled();
  });
});

describe("postOpeningStockCorrection", () => {
  it("posts as the Owner and returns the correction code", async () => {
    mocks.correctionFindUnique.mockResolvedValue(null);
    mocks.postCorrection.mockResolvedValue({ correctionCode: "CORR/2026-27/0001" });

    const result = await postOpeningStockCorrection(undefined,
      form({ movementId: "mv-1", newCostValue: "351664", reason: "Approved revaluation.", idempotencyKey: "k1" })
    );

    expect(result).toEqual({ success: true, code: "CORR/2026-27/0001" });
    expect(mocks.requireOwner).toHaveBeenCalled();
    expect(mocks.postCorrection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approverRole: "OWNER", approvedByUserId: "owner-1", idempotencyKey: "k1" })
    );
  });

  it("refuses Staff outright — requireOwner is what guards it", async () => {
    mocks.requireOwner.mockRejectedValue(new Error("redirect to /dashboard"));
    await expect(
      postOpeningStockCorrection(undefined, form({ movementId: "mv-1", newCostValue: "351664", reason: "Trying as Staff." }))
    ).rejects.toThrow();
    expect(mocks.postCorrection).not.toHaveBeenCalled();
  });

  it("returns the existing correction for a retried submission instead of posting twice", async () => {
    mocks.correctionFindUnique.mockResolvedValue({ correctionCode: "CORR/2026-27/0001" });

    const result = await postOpeningStockCorrection(undefined,
      form({ movementId: "mv-1", newCostValue: "351664", reason: "Approved revaluation.", idempotencyKey: "k1" })
    );

    expect(result).toEqual({ success: true, code: "CORR/2026-27/0001" });
    expect(mocks.postCorrection).not.toHaveBeenCalled();
  });

  it("posts with no corrected value for the ledger backfill", async () => {
    mocks.correctionFindUnique.mockResolvedValue(null);
    mocks.postCorrection.mockResolvedValue({ correctionCode: "CORR/2026-27/0002" });

    await postOpeningStockCorrection(undefined,
      form({ movementId: "mv-1", reason: "Opening stock was never posted to the ledger." })
    );

    expect(mocks.planOpeningStockLedgerBackfill).toHaveBeenCalled();
    expect(mocks.planOpeningStockRevaluation).not.toHaveBeenCalled();
  });
});

describe("approveCorrection and rejectCorrection", () => {
  it("recomputes the plan before approving", async () => {
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ correction: { findUnique: vi.fn().mockResolvedValue({ id: "c-1", entityType: "METAL_OPENING_STOCK" }) } })
    );
    mocks.replanCorrection.mockResolvedValue(samplePlan);
    mocks.approveCorrectionDraft.mockResolvedValue({ correctionCode: "CORR/2026-27/0003" });

    const result = await approveCorrection(undefined, form({ correctionId: "c-1" }));

    expect(mocks.replanCorrection).toHaveBeenCalled();
    expect(mocks.approveCorrectionDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approverRole: "OWNER", freshPlan: samplePlan })
    );
    expect(result).toEqual({ success: true, code: "CORR/2026-27/0003" });
  });

  it("surfaces a stale preview refusal to the Owner", async () => {
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({ correction: { findUnique: vi.fn().mockResolvedValue({ id: "c-1", entityType: "METAL_OPENING_STOCK" }) } })
    );
    mocks.replanCorrection.mockResolvedValue(samplePlan);
    mocks.approveCorrectionDraft.mockRejectedValue(
      new CorrectionError("These records changed after this correction was prepared.")
    );

    const result = await approveCorrection(undefined, form({ correctionId: "c-1" }));
    expect(result?.error).toContain("changed after this correction was prepared");
  });

  it("requires a reason to reject", async () => {
    const result = await rejectCorrection(undefined, form({ correctionId: "c-1", rejectionReason: "no" }));
    expect(result?.error).toContain("reason");
    expect(mocks.rejectCorrectionDraft).not.toHaveBeenCalled();
  });

  it("rejects with the Owner's reason recorded", async () => {
    mocks.rejectCorrectionDraft.mockResolvedValue({ id: "c-1" });
    const result = await rejectCorrection(undefined,
      form({ correctionId: "c-1", rejectionReason: "Wrong rate; prepare it again." })
    );
    expect(result).toEqual({ success: true });
    expect(mocks.rejectCorrectionDraft).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ approverRole: "OWNER", reason: "Wrong rate; prepare it again." })
    );
  });
});
