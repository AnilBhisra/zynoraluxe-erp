import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  jewelleryJobFindUnique: vi.fn(),
  jewelleryReceiptFindUnique: vi.fn(),
  revalidatePath: vi.fn(),
  getCompanyFySettings: vi.fn(),
  createJewelleryJob: vi.fn(),
  issueMaterialsToJewelleryJob: vi.fn(),
  markJewelleryJobInProgress: vi.fn(),
  setJewelleryJobNeedsCorrection: vi.fn(),
  cancelJewelleryJob: vi.fn(),
  receiveFinishedJewellery: vi.fn(),
  overrideFinishedJewelleryAllocation: vi.fn(),
  isJewelleryStorageConfigured: vi.fn(),
  uploadJewelleryAsset: vi.fn(),
  deleteJewelleryAsset: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireUser: mocks.requireUser,
  requireOwner: mocks.requireOwner,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    jewelleryJob: { findUnique: mocks.jewelleryJobFindUnique },
    jewelleryReceipt: { findUnique: mocks.jewelleryReceiptFindUnique },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/accounting/company", () => ({
  getCompanyFySettings: mocks.getCompanyFySettings,
}));

vi.mock("@/lib/jewellery/posting", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jewellery/posting")>("@/lib/jewellery/posting");
  return {
    ...actual,
    createJewelleryJob: mocks.createJewelleryJob,
    issueMaterialsToJewelleryJob: mocks.issueMaterialsToJewelleryJob,
    markJewelleryJobInProgress: mocks.markJewelleryJobInProgress,
    setJewelleryJobNeedsCorrection: mocks.setJewelleryJobNeedsCorrection,
    cancelJewelleryJob: mocks.cancelJewelleryJob,
    receiveFinishedJewellery: mocks.receiveFinishedJewellery,
    overrideFinishedJewelleryAllocation: mocks.overrideFinishedJewelleryAllocation,
  };
});

vi.mock("@/lib/storage/jewelleryMedia", () => ({
  isJewelleryStorageConfigured: mocks.isJewelleryStorageConfigured,
  uploadJewelleryAsset: mocks.uploadJewelleryAsset,
  deleteJewelleryAsset: mocks.deleteJewelleryAsset,
}));

import {
  cancelJewelleryJobAction,
  createJewelleryJobAction,
  deleteJewelleryPhotoAction,
  issueMaterialsAction,
  overrideFinishedAllocationAction,
  receiveFinishedJewelleryAction,
  uploadJewelleryPhotoAction,
} from "./jewellery";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const OWNER = { id: "u1", role: "OWNER", name: "Owner", email: "o@b.com" };
const STAFF = { id: "u2", role: "STAFF", name: "Staff", email: "s@b.com" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(OWNER);
  mocks.requireOwner.mockResolvedValue(OWNER);
  mocks.getCompanyFySettings.mockResolvedValue({
    fyStartMonth: 4,
    fyStartDay: 1,
    stateCode: null,
    defaultCurrency: "INR",
  });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
  mocks.jewelleryJobFindUnique.mockResolvedValue(null);
  mocks.jewelleryReceiptFindUnique.mockResolvedValue(null);
  mocks.isJewelleryStorageConfigured.mockReturnValue(true);
});

function fileFormData(file: File | null, category = "jewellery-design") {
  const fd = new FormData();
  if (file) fd.set("file", file);
  fd.set("category", category);
  return fd;
}

describe("uploadJewelleryPhotoAction", () => {
  it("rejects an unauthenticated request before ever touching storage", async () => {
    mocks.requireUser.mockRejectedValue(new Error("redirect to /login"));
    const goodFile = new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" });
    await expect(uploadJewelleryPhotoAction(undefined, fileFormData(goodFile))).rejects.toThrow();
    expect(mocks.uploadJewelleryAsset).not.toHaveBeenCalled();
  });

  it("does not require Owner — Staff can upload", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.uploadJewelleryAsset.mockResolvedValue({ assetId: "jewellery-design/abc.jpg" });
    const goodFile = new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" });
    const result = await uploadJewelleryPhotoAction(undefined, fileFormData(goodFile));
    expect(result).toEqual({ success: true, assetId: "jewellery-design/abc.jpg" });
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });

  it("returns a plain 'not available yet' message when storage isn't configured", async () => {
    mocks.isJewelleryStorageConfigured.mockReturnValue(false);
    const goodFile = new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" });
    const result = await uploadJewelleryPhotoAction(undefined, fileFormData(goodFile));
    expect(result?.error).toMatch(/not available/i);
    expect(mocks.uploadJewelleryAsset).not.toHaveBeenCalled();
  });

  it("rejects an empty file without calling the storage layer", async () => {
    const emptyFile = new File([], "empty.jpg", { type: "image/jpeg" });
    const result = await uploadJewelleryPhotoAction(undefined, fileFormData(emptyFile));
    expect(result?.error).toBeTruthy();
    expect(mocks.uploadJewelleryAsset).not.toHaveBeenCalled();
  });
});

describe("deleteJewelleryPhotoAction", () => {
  it("does nothing when no assetId is provided", async () => {
    const fd = new FormData();
    await deleteJewelleryPhotoAction(fd);
    expect(mocks.deleteJewelleryAsset).not.toHaveBeenCalled();
  });

  it("never throws even if the underlying delete fails", async () => {
    mocks.deleteJewelleryAsset.mockRejectedValue(new Error("network error"));
    const fd = new FormData();
    fd.set("assetId", "jewellery-design/abc.jpg");
    await expect(deleteJewelleryPhotoAction(fd)).resolves.toBeUndefined();
  });
});

describe("createJewelleryJobAction validation and idempotency", () => {
  it("rejects a missing Karigar at the schema layer, without touching the posting engine", async () => {
    const result = await createJewelleryJobAction(
      undefined,
      formData({
        jewelleryType: "RING",
        designName: "Solitaire ring",
        karigarId: "",
        issueDate: "2026-06-15",
        quantity: "1",
      })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.createJewelleryJob).not.toHaveBeenCalled();
  });

  it("returns the existing job instead of creating again when the idempotency key already exists", async () => {
    mocks.jewelleryJobFindUnique.mockResolvedValue({ jobCode: "ZL-JJOB-2026-000001" });

    const result = await createJewelleryJobAction(
      undefined,
      formData({
        jewelleryType: "RING",
        designName: "Solitaire ring",
        karigarId: "karigar-1",
        issueDate: "2026-06-15",
        quantity: "1",
        idempotencyKey: "same-key",
      })
    );

    expect(result).toEqual({ success: true, code: "ZL-JJOB-2026-000001" });
    expect(mocks.createJewelleryJob).not.toHaveBeenCalled();
  });

  it("does NOT require Owner — Staff may create jobs", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.createJewelleryJob.mockResolvedValue({ jobCode: "ZL-JJOB-2026-000002" });

    const result = await createJewelleryJobAction(
      undefined,
      formData({
        jewelleryType: "RING",
        designName: "Solitaire ring",
        karigarId: "karigar-1",
        issueDate: "2026-06-15",
        quantity: "1",
      })
    );

    expect(result?.success).toBe(true);
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });
});

describe("issueMaterialsAction validation", () => {
  it("rejects issuing nothing at the schema layer... actually passes empty arrays through (posting engine itself enforces 'at least one')", async () => {
    mocks.issueMaterialsToJewelleryJob.mockRejectedValue(
      Object.assign(new Error("Issue at least one metal line, diamond, or other material."), { name: "PostingError" })
    );
    const result = await issueMaterialsAction(
      undefined,
      formData({
        jobId: "job-1",
        issueDate: "2026-06-15",
        metalLinesJson: "[]",
        polishedDiamondIdsJson: "[]",
        otherMaterialLinesJson: "[]",
      })
    );
    expect(result?.error).toBeTruthy();
  });
});

describe("Owner-only enforcement", () => {
  it("cancelJewelleryJobAction requires Owner", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
    await expect(
      cancelJewelleryJobAction(undefined, formData({ jobId: "job-1", cancellationReason: "test reason" }))
    ).rejects.toThrow();
    expect(mocks.cancelJewelleryJob).not.toHaveBeenCalled();
  });

  it("overrideFinishedAllocationAction requires Owner", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
    await expect(
      overrideFinishedAllocationAction(
        undefined,
        formData({
          receiptId: "receipt-1",
          reason: "test reason",
          adjustmentsJson: JSON.stringify([{ finishedJewelleryId: "fj-1", newTotalCost: "10" }]),
        })
      )
    ).rejects.toThrow();
    expect(mocks.overrideFinishedJewelleryAllocation).not.toHaveBeenCalled();
  });

  it("issueMaterialsAction does NOT require Owner (Staff may issue materials)", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.issueMaterialsToJewelleryJob.mockResolvedValue({ jobCode: "ZL-JJOB-2026-000003" });

    const result = await issueMaterialsAction(
      undefined,
      formData({
        jobId: "job-1",
        issueDate: "2026-06-15",
        metalLinesJson: JSON.stringify([{ metalType: "GOLD", purityId: "purity-1", grossWeight: "5" }]),
        polishedDiamondIdsJson: "[]",
        otherMaterialLinesJson: "[]",
      })
    );

    expect(result?.success).toBe(true);
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });
});

describe("receiveFinishedJewelleryAction — exceptional-override authorization", () => {
  function baseFields(overrides: Record<string, string> = {}) {
    return formData({
      jobId: "job-1",
      receiveDate: "2026-06-15",
      outputsJson: "[]",
      diamondResolutionsJson: "[]",
      returnedMetalLinesJson: "[]",
      scrapMetalLinesJson: "[]",
      karigarAddedFineWeight: "0",
      karigarAddedCost: "0",
      labourCharge: "0",
      makingCharge: "0",
      settingCharge: "0",
      platingCharge: "0",
      otherExpense: "0",
      markJobComplete: "false",
      ...overrides,
    });
  }

  it("rejects Staff classifying a loss as abnormal, without touching the posting engine", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    const result = await receiveFinishedJewelleryAction(
      undefined,
      baseFields({ isAbnormalLoss: "true", abnormalLossReason: "Extra loss during casting" })
    );
    expect(result?.error).toMatch(/only the owner/i);
    expect(mocks.receiveFinishedJewellery).not.toHaveBeenCalled();
  });

  it("rejects Staff marking a diamond damaged/lost, without touching the posting engine", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    const result = await receiveFinishedJewelleryAction(
      undefined,
      baseFields({
        diamondResolutionsJson: JSON.stringify([
          { polishedDiamondId: "pol-1", resolution: "DAMAGED_LOST", damagedLostReason: "Chipped" },
        ]),
      })
    );
    expect(result?.error).toMatch(/only the owner/i);
    expect(mocks.receiveFinishedJewellery).not.toHaveBeenCalled();
  });

  it("allows the Owner to classify a loss as abnormal", async () => {
    mocks.receiveFinishedJewellery.mockResolvedValue({ receipt: { receiptCode: "ZL-JREC-2026-000001" } });
    const result = await receiveFinishedJewelleryAction(
      undefined,
      baseFields({ isAbnormalLoss: "true", abnormalLossReason: "Extra loss during casting" })
    );
    expect(result?.success).toBe(true);
    expect(mocks.receiveFinishedJewellery).toHaveBeenCalled();
  });

  it("returns the existing receipt instead of posting again when the idempotency key already exists", async () => {
    mocks.jewelleryReceiptFindUnique.mockResolvedValue({ receiptCode: "ZL-JREC-2026-000002" });
    const result = await receiveFinishedJewelleryAction(undefined, baseFields({ idempotencyKey: "same-key" }));
    expect(result).toEqual({ success: true, code: "ZL-JREC-2026-000002" });
    expect(mocks.receiveFinishedJewellery).not.toHaveBeenCalled();
  });

  it("does NOT require Owner for an ordinary receipt with no exceptional overrides", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.receiveFinishedJewellery.mockResolvedValue({ receipt: { receiptCode: "ZL-JREC-2026-000003" } });
    const result = await receiveFinishedJewelleryAction(undefined, baseFields());
    expect(result?.success).toBe(true);
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });
});
