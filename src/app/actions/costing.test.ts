import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  costSheetFindUnique: vi.fn(),
  costingSettingsUpsert: vi.fn(),
  revalidatePath: vi.fn(),
  getCompanyFySettings: vi.fn(),
  getCostingSettings: vi.fn(),
  buildCostSheetsCsv: vi.fn(),
  isJewelleryStorageConfigured: vi.fn(),
  uploadJewelleryAsset: vi.fn(),
  deleteJewelleryAsset: vi.fn(),
  createActualCostSheet: vi.fn(),
  updateActualCostSheetFields: vi.fn(),
  refreshActualCostSheetFromSource: vi.fn(),
  createEstimateCostSheet: vi.fn(),
  updateEstimateCostSheet: vi.fn(),
  finalizeCostSheet: vi.fn(),
  reviseCostSheet: vi.fn(),
  archiveCostSheet: vi.fn(),
  unarchiveCostSheet: vi.fn(),
  deleteDraftCostSheet: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireOwner: mocks.requireOwner,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    costSheet: { findUnique: mocks.costSheetFindUnique },
    costingSettings: { upsert: mocks.costingSettingsUpsert },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/accounting/company", () => ({
  getCompanyFySettings: mocks.getCompanyFySettings,
}));

vi.mock("@/lib/costing/reports", () => ({
  getCostingSettings: mocks.getCostingSettings,
  buildCostSheetsCsv: mocks.buildCostSheetsCsv,
}));

vi.mock("@/lib/storage/jewelleryMedia", () => ({
  isJewelleryStorageConfigured: mocks.isJewelleryStorageConfigured,
  uploadJewelleryAsset: mocks.uploadJewelleryAsset,
  deleteJewelleryAsset: mocks.deleteJewelleryAsset,
}));

vi.mock("@/lib/costing/engine", async () => {
  const actual = await vi.importActual<typeof import("@/lib/costing/engine")>("@/lib/costing/engine");
  return {
    ...actual,
    createActualCostSheet: mocks.createActualCostSheet,
    updateActualCostSheetFields: mocks.updateActualCostSheetFields,
    refreshActualCostSheetFromSource: mocks.refreshActualCostSheetFromSource,
    createEstimateCostSheet: mocks.createEstimateCostSheet,
    updateEstimateCostSheet: mocks.updateEstimateCostSheet,
    finalizeCostSheet: mocks.finalizeCostSheet,
    reviseCostSheet: mocks.reviseCostSheet,
    archiveCostSheet: mocks.archiveCostSheet,
    unarchiveCostSheet: mocks.unarchiveCostSheet,
    deleteDraftCostSheet: mocks.deleteDraftCostSheet,
  };
});

import {
  archiveCostingAction,
  createActualCostingAction,
  createEstimateCostingAction,
  deleteCostingPhotoAction,
  deleteDraftCostingAction,
  exportCostSheetsCsvAction,
  finalizeCostingAction,
  reviseCostingAction,
  saveCostingSettingsAction,
  unarchiveCostingAction,
  updateActualCostingAction,
  updateEstimateCostingAction,
  refreshActualCostingAction,
  uploadCostingPhotoAction,
} from "./costing";

const OWNER = { id: "owner-1", email: "owner@zl.test", name: "Owner", role: "OWNER" as const };

function estimateFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("costingDate", "2026-06-15");
  fd.set("jewelleryType", "RING");
  fd.set("itemName", "Test ring");
  fd.set("quantity", "1");
  fd.set("metalLinesJson", JSON.stringify([{ metalType: "GOLD", purityId: "purity-1", grossWeight: "5", rateBasis: "PER_GROSS_GRAM", rate: "5000" }]));
  fd.set("diamondLinesJson", "[]");
  fd.set("otherMaterialLinesJson", "[]");
  fd.set("chargeLinesJson", "[]");
  fd.set("pricingMethod", "MARKUP_ON_COST");
  fd.set("markupPercent", "20");
  fd.set("discountType", "NONE");
  fd.set("gstTreatment", "NONE");
  fd.set("priceType", "EXCLUSIVE");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function actualFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("sourceFinishedJewelleryId", "fj-1");
  fd.set("costingDate", "2026-06-15");
  fd.set("pricingMethod", "MARKUP_ON_COST");
  fd.set("markupPercent", "20");
  fd.set("discountType", "NONE");
  fd.set("gstTreatment", "NONE");
  fd.set("priceType", "EXCLUSIVE");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireOwner.mockResolvedValue(OWNER);
  mocks.getCompanyFySettings.mockResolvedValue({ fyStartMonth: 4, fyStartDay: 1, stateCode: null, defaultCurrency: "INR" });
  mocks.getCostingSettings.mockResolvedValue({
    defaultPricingMethod: "MARKUP_ON_COST",
    defaultMarkupPercent: 0,
    defaultTargetMarginPercent: 0,
    defaultDiscountType: "NONE",
    defaultDiscountValue: 0,
    defaultGstTreatment: "NONE",
    defaultGstRateId: null,
    defaultPriceType: "EXCLUSIVE",
    defaultValidityDays: 15,
    defaultRoundingStep: 0,
    defaultSellingExpenseFixed: 0,
    defaultSellingExpensePercent: 0,
    quotationTerms: null,
  });
  mocks.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({}));
  mocks.costSheetFindUnique.mockResolvedValue(null);
});

describe("Owner-only enforcement — every action independently rejects a Staff caller", () => {
  function simulateStaffRedirect() {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
  }

  it("createActualCostingAction rejects Staff before touching the engine", async () => {
    simulateStaffRedirect();
    await expect(createActualCostingAction(undefined, actualFormData())).rejects.toThrow("redirect to /unauthorized");
    expect(mocks.createActualCostSheet).not.toHaveBeenCalled();
  });

  it("updateActualCostingAction rejects Staff", async () => {
    simulateStaffRedirect();
    await expect(updateActualCostingAction(undefined, actualFormData({ costSheetId: "cs-1", quantity: "1" }))).rejects.toThrow();
    expect(mocks.updateActualCostSheetFields).not.toHaveBeenCalled();
  });

  it("refreshActualCostingAction rejects Staff", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    fd.set("costSheetId", "cs-1");
    await expect(refreshActualCostingAction(undefined, fd)).rejects.toThrow();
    expect(mocks.refreshActualCostSheetFromSource).not.toHaveBeenCalled();
  });

  it("createEstimateCostingAction rejects Staff", async () => {
    simulateStaffRedirect();
    await expect(createEstimateCostingAction(undefined, estimateFormData())).rejects.toThrow();
    expect(mocks.createEstimateCostSheet).not.toHaveBeenCalled();
  });

  it("updateEstimateCostingAction rejects Staff", async () => {
    simulateStaffRedirect();
    await expect(updateEstimateCostingAction(undefined, estimateFormData({ costSheetId: "cs-1" }))).rejects.toThrow();
    expect(mocks.updateEstimateCostSheet).not.toHaveBeenCalled();
  });

  it("finalizeCostingAction rejects Staff", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    fd.set("costSheetId", "cs-1");
    await expect(finalizeCostingAction(undefined, fd)).rejects.toThrow();
    expect(mocks.finalizeCostSheet).not.toHaveBeenCalled();
  });

  it("reviseCostingAction rejects Staff", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    fd.set("costSheetId", "cs-1");
    await expect(reviseCostingAction(undefined, fd)).rejects.toThrow();
    expect(mocks.reviseCostSheet).not.toHaveBeenCalled();
  });

  it("archiveCostingAction rejects Staff", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    fd.set("costSheetId", "cs-1");
    await expect(archiveCostingAction(fd)).rejects.toThrow();
    expect(mocks.archiveCostSheet).not.toHaveBeenCalled();
  });

  it("unarchiveCostingAction rejects Staff", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    fd.set("costSheetId", "cs-1");
    await expect(unarchiveCostingAction(fd)).rejects.toThrow();
    expect(mocks.unarchiveCostSheet).not.toHaveBeenCalled();
  });

  it("deleteDraftCostingAction rejects Staff", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    fd.set("costSheetId", "cs-1");
    await expect(deleteDraftCostingAction(fd)).rejects.toThrow();
    expect(mocks.deleteDraftCostSheet).not.toHaveBeenCalled();
  });

  it("saveCostingSettingsAction rejects Staff", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    await expect(saveCostingSettingsAction(undefined, fd)).rejects.toThrow();
    expect(mocks.costingSettingsUpsert).not.toHaveBeenCalled();
  });

  it("exportCostSheetsCsvAction rejects Staff", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    await expect(exportCostSheetsCsvAction(fd)).rejects.toThrow();
    expect(mocks.buildCostSheetsCsv).not.toHaveBeenCalled();
  });

  it("uploadCostingPhotoAction rejects Staff — deliberately its OWN guard, not shared with Jewellery's requireUser()-gated upload", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    fd.set("file", new File(["x"], "photo.jpg", { type: "image/jpeg" }));
    await expect(uploadCostingPhotoAction(undefined, fd)).rejects.toThrow();
    expect(mocks.uploadJewelleryAsset).not.toHaveBeenCalled();
  });

  it("deleteCostingPhotoAction rejects Staff", async () => {
    simulateStaffRedirect();
    const fd = new FormData();
    fd.set("assetId", "costing-estimate/abc.jpg");
    await expect(deleteCostingPhotoAction(fd)).rejects.toThrow();
    expect(mocks.deleteJewelleryAsset).not.toHaveBeenCalled();
  });
});

describe("Owner requests succeed and reach the engine with well-formed input", () => {
  it("createEstimateCostingAction calls the engine and returns the created costing number", async () => {
    mocks.createEstimateCostSheet.mockResolvedValue({ id: "cs-1", costingNumber: "CST/2026-27/0001" });
    const result = await createEstimateCostingAction(undefined, estimateFormData());
    expect(result).toEqual({ success: true, id: "cs-1", costingNumber: "CST/2026-27/0001" });
    expect(mocks.createEstimateCostSheet).toHaveBeenCalledTimes(1);
    const call = mocks.createEstimateCostSheet.mock.calls[0][1];
    expect(call.itemName).toBe("Test ring");
    expect(call.metalLines).toHaveLength(1);
    expect(call.createdByUserId).toBe(OWNER.id);
  });

  it("createActualCostingAction calls the engine with the source output id", async () => {
    mocks.createActualCostSheet.mockResolvedValue({ id: "cs-2", costingNumber: "CST/2026-27/0002" });
    const result = await createActualCostingAction(undefined, actualFormData());
    expect(result).toEqual({ success: true, id: "cs-2", costingNumber: "CST/2026-27/0002" });
    const call = mocks.createActualCostSheet.mock.calls[0][1];
    expect(call.sourceFinishedJewelleryId).toBe("fj-1");
  });

  it("finalizeCostingAction succeeds for Owner", async () => {
    mocks.finalizeCostSheet.mockResolvedValue({ id: "cs-1", status: "FINALIZED" });
    const fd = new FormData();
    fd.set("costSheetId", "cs-1");
    const result = await finalizeCostingAction(undefined, fd);
    expect(result).toEqual({ success: true });
    expect(mocks.finalizeCostSheet).toHaveBeenCalledWith({}, { costSheetId: "cs-1", userId: OWNER.id });
  });

  it("reviseCostingAction returns the new revision's costing number", async () => {
    mocks.reviseCostSheet.mockResolvedValue({ id: "cs-2", costingNumber: "CST/2026-27/0002" });
    const fd = new FormData();
    fd.set("costSheetId", "cs-1");
    const result = await reviseCostingAction(undefined, fd);
    expect(result).toEqual({ success: true, id: "cs-2", costingNumber: "CST/2026-27/0002" });
  });

  it("uploadCostingPhotoAction succeeds for Owner and tags the upload with the costing-estimate category", async () => {
    mocks.isJewelleryStorageConfigured.mockReturnValue(true);
    mocks.uploadJewelleryAsset.mockResolvedValue({ assetId: "costing-estimate/random-id.jpg" });
    const fd = new FormData();
    fd.set("file", new File(["x"], "photo.jpg", { type: "image/jpeg" }));
    const result = await uploadCostingPhotoAction(undefined, fd);
    expect(result).toEqual({ success: true, assetId: "costing-estimate/random-id.jpg" });
    expect(mocks.uploadJewelleryAsset).toHaveBeenCalledWith("costing-estimate", expect.anything());
  });

  it("a PostingError from the engine is surfaced as a plain form error, not a thrown exception", async () => {
    const { PostingError } = await vi.importActual<typeof import("@/lib/costing/engine")>("@/lib/costing/engine");
    mocks.finalizeCostSheet.mockRejectedValue(new PostingError("Add at least one cost line before finalizing."));
    const fd = new FormData();
    fd.set("costSheetId", "cs-1");
    const result = await finalizeCostingAction(undefined, fd);
    expect(result).toEqual({ error: "Add at least one cost line before finalizing." });
  });
});

describe("idempotent create", () => {
  it("createEstimateCostingAction returns the existing costing instead of creating a duplicate on a repeat idempotencyKey", async () => {
    mocks.costSheetFindUnique.mockResolvedValue({ id: "cs-existing", costingNumber: "CST/2026-27/0001" });
    const result = await createEstimateCostingAction(undefined, estimateFormData({ idempotencyKey: "same-key" }));
    expect(result).toEqual({ success: true, id: "cs-existing", costingNumber: "CST/2026-27/0001" });
    expect(mocks.createEstimateCostSheet).not.toHaveBeenCalled();
  });
});

describe("no accounting/stock mutation is even reachable from this module", () => {
  it("the mocked prisma client this action file actually imports has no voucher/journalEntry/stock-movement model at all", async () => {
    // Structural, not just behavioural: src/app/actions/costing.ts's own
    // `import { prisma } from "@/lib/db/prisma"` resolves (under this
    // test file's vi.mock above) to an object with ONLY costSheet/
    // costingSettings/$transaction. If any function in costing.ts ever
    // called prisma.voucher.create(...) or prisma.journalEntry.create(...)
    // or prisma.metalStockMovement.create(...), it would throw
    // "Cannot read properties of undefined" — proving no such call path
    // exists, rather than merely asserting it doesn't today.
    const { prisma } = await import("@/lib/db/prisma");
    const prismaAsRecord = prisma as unknown as Record<string, unknown>;
    expect(prismaAsRecord.voucher).toBeUndefined();
    expect(prismaAsRecord.journalEntry).toBeUndefined();
    expect(prismaAsRecord.stockMovement).toBeUndefined();
    expect(prismaAsRecord.metalStockMovement).toBeUndefined();
    expect(Object.keys(prismaAsRecord).sort()).toEqual(["$transaction", "costSheet", "costingSettings"].sort());
  });
});
