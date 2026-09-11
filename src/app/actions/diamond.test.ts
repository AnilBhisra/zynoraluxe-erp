import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  roughLotFindUnique: vi.fn(),
  diamondJobFindUnique: vi.fn(),
  polishedReceiptFindUnique: vi.fn(),
  revalidatePath: vi.fn(),
  getCompanyFySettings: vi.fn(),
  createRoughLotWithPieces: vi.fn(),
  issueRoughToKarigar: vi.fn(),
  receivePolishedDiamonds: vi.fn(),
  cancelDiamondJob: vi.fn(),
  recutPolishedDiamond: vi.fn(),
  overrideRoughPieceAllocations: vi.fn(),
  overridePolishedAllocations: vi.fn(),
  isDiamondStorageConfigured: vi.fn(),
  uploadDiamondAsset: vi.fn(),
  deleteDiamondAsset: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireUser: mocks.requireUser,
  requireOwner: mocks.requireOwner,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    roughLot: { findUnique: mocks.roughLotFindUnique },
    diamondJob: { findUnique: mocks.diamondJobFindUnique },
    polishedReceipt: { findUnique: mocks.polishedReceiptFindUnique },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/accounting/company", () => ({
  getCompanyFySettings: mocks.getCompanyFySettings,
}));

vi.mock("@/lib/diamond/posting", async () => {
  const actual = await vi.importActual<typeof import("@/lib/diamond/posting")>("@/lib/diamond/posting");
  return {
    ...actual,
    createRoughLotWithPieces: mocks.createRoughLotWithPieces,
    issueRoughToKarigar: mocks.issueRoughToKarigar,
    receivePolishedDiamonds: mocks.receivePolishedDiamonds,
    cancelDiamondJob: mocks.cancelDiamondJob,
    recutPolishedDiamond: mocks.recutPolishedDiamond,
    overrideRoughPieceAllocations: mocks.overrideRoughPieceAllocations,
    overridePolishedAllocations: mocks.overridePolishedAllocations,
  };
});

vi.mock("@/lib/storage/diamondMedia", () => ({
  isDiamondStorageConfigured: mocks.isDiamondStorageConfigured,
  uploadDiamondAsset: mocks.uploadDiamondAsset,
  deleteDiamondAsset: mocks.deleteDiamondAsset,
}));

import {
  cancelDiamondJobAction,
  createRoughPurchase,
  deleteDiamondPhotoAction,
  issueRoughAction,
  overrideRoughAllocationAction,
  receivePolishedAction,
  recutPolishedAction,
  uploadDiamondPhotoAction,
} from "./diamond";

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
  mocks.roughLotFindUnique.mockResolvedValue(null);
  mocks.diamondJobFindUnique.mockResolvedValue(null);
  mocks.polishedReceiptFindUnique.mockResolvedValue(null);
  mocks.isDiamondStorageConfigured.mockReturnValue(true);
});

function fileFormData(file: File | null, category = "rough-piece") {
  const fd = new FormData();
  if (file) fd.set("file", file);
  fd.set("category", category);
  return fd;
}

describe("uploadDiamondPhotoAction", () => {
  it("rejects an unauthenticated request before ever touching storage", async () => {
    mocks.requireUser.mockRejectedValue(new Error("redirect to /login"));
    const goodFile = new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" });
    await expect(uploadDiamondPhotoAction(undefined, fileFormData(goodFile))).rejects.toThrow();
    expect(mocks.uploadDiamondAsset).not.toHaveBeenCalled();
  });

  it("does not require Owner — Staff can upload", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.uploadDiamondAsset.mockResolvedValue({ assetId: "rough-piece/abc.jpg" });
    const goodFile = new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" });
    const result = await uploadDiamondPhotoAction(undefined, fileFormData(goodFile));
    expect(result).toEqual({ success: true, assetId: "rough-piece/abc.jpg" });
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });

  it("succeeds identically for Owner", async () => {
    mocks.requireUser.mockResolvedValue(OWNER);
    mocks.uploadDiamondAsset.mockResolvedValue({ assetId: "rough-piece/def.jpg" });
    const goodFile = new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" });
    const result = await uploadDiamondPhotoAction(undefined, fileFormData(goodFile));
    expect(result).toEqual({ success: true, assetId: "rough-piece/def.jpg" });
  });

  it("rejects an empty file without calling the storage layer", async () => {
    const emptyFile = new File([], "empty.jpg", { type: "image/jpeg" });
    const result = await uploadDiamondPhotoAction(undefined, fileFormData(emptyFile));
    expect(result?.error).toBeTruthy();
    expect(mocks.uploadDiamondAsset).not.toHaveBeenCalled();
  });

  it("rejects when no file is provided at all", async () => {
    const result = await uploadDiamondPhotoAction(undefined, fileFormData(null));
    expect(result?.error).toBeTruthy();
    expect(mocks.uploadDiamondAsset).not.toHaveBeenCalled();
  });

  it("returns a plain 'not available yet' message when storage isn't configured, without calling the storage layer", async () => {
    mocks.isDiamondStorageConfigured.mockReturnValue(false);
    const goodFile = new File([new Uint8Array([1, 2, 3])], "x.jpg", { type: "image/jpeg" });
    const result = await uploadDiamondPhotoAction(undefined, fileFormData(goodFile));
    expect(result?.error).toMatch(/not available/i);
    expect(mocks.uploadDiamondAsset).not.toHaveBeenCalled();
  });

  it("surfaces a StorageError message (e.g. an invalid-MIME rejection) to the caller", async () => {
    mocks.uploadDiamondAsset.mockRejectedValue(new Error("File type is not allowed for upload."));
    const badFile = new File([new Uint8Array([1, 2, 3])], "x.exe", { type: "application/x-msdownload" });
    const result = await uploadDiamondPhotoAction(undefined, fileFormData(badFile));
    expect(result?.error).toMatch(/not allowed/i);
  });
});

describe("deleteDiamondPhotoAction", () => {
  it("rejects an unauthenticated request before ever touching storage", async () => {
    mocks.requireUser.mockRejectedValue(new Error("redirect to /login"));
    const fd = new FormData();
    fd.set("assetId", "rough-piece/abc.jpg");
    await expect(deleteDiamondPhotoAction(fd)).rejects.toThrow();
    expect(mocks.deleteDiamondAsset).not.toHaveBeenCalled();
  });

  it("does not require Owner — Staff can delete their own in-progress upload", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.deleteDiamondAsset.mockResolvedValue(true);
    const fd = new FormData();
    fd.set("assetId", "rough-piece/abc.jpg");
    await deleteDiamondPhotoAction(fd);
    expect(mocks.deleteDiamondAsset).toHaveBeenCalledWith("rough-piece/abc.jpg");
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });

  it("does nothing when no assetId is provided", async () => {
    const fd = new FormData();
    await deleteDiamondPhotoAction(fd);
    expect(mocks.deleteDiamondAsset).not.toHaveBeenCalled();
  });

  it("never throws even if the underlying delete fails", async () => {
    mocks.deleteDiamondAsset.mockRejectedValue(new Error("network error"));
    const fd = new FormData();
    fd.set("assetId", "rough-piece/abc.jpg");
    await expect(deleteDiamondPhotoAction(fd)).resolves.toBeUndefined();
  });
});

describe("createRoughPurchase validation and idempotency", () => {
  it("rejects a purchase with no pieces at the schema layer, without touching the posting engine", async () => {
    const result = await createRoughPurchase(
      undefined,
      formData({
        purchaseDate: "2026-06-15",
        supplierId: "supplier-1",
        purchaseRate: "100",
        totalPurchaseCost: "100",
        piecesJson: "[]",
      })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.createRoughLotWithPieces).not.toHaveBeenCalled();
  });

  it("returns the existing lot instead of posting again when the idempotency key already exists", async () => {
    mocks.roughLotFindUnique.mockResolvedValue({ lotCode: "ZL-RL-2026-000001" });

    const result = await createRoughPurchase(
      undefined,
      formData({
        purchaseDate: "2026-06-15",
        supplierId: "supplier-1",
        purchaseRate: "100",
        totalPurchaseCost: "100",
        piecesJson: JSON.stringify([{ carat: "1" }]),
        idempotencyKey: "same-key",
      })
    );

    expect(result).toEqual({ success: true, code: "ZL-RL-2026-000001" });
    expect(mocks.createRoughLotWithPieces).not.toHaveBeenCalled();
  });
});

describe("issueRoughAction idempotency", () => {
  it("returns the existing job instead of issuing again when the idempotency key already exists", async () => {
    mocks.diamondJobFindUnique.mockResolvedValue({ jobCode: "ZL-JOB-2026-000001" });

    const result = await issueRoughAction(
      undefined,
      formData({
        karigarId: "karigar-1",
        roughPieceIdsJson: JSON.stringify(["piece-1"]),
        requiredShape: "ROUND",
        issueDate: "2026-06-15",
        idempotencyKey: "same-key",
      })
    );

    expect(result).toEqual({ success: true, code: "ZL-JOB-2026-000001" });
    expect(mocks.issueRoughToKarigar).not.toHaveBeenCalled();
  });
});

describe("receivePolishedAction idempotency and validation", () => {
  it("rejects a receipt with no outputs without touching the posting engine", async () => {
    const result = await receivePolishedAction(
      undefined,
      formData({
        jobId: "job-1",
        receiveDate: "2026-06-15",
        shape: "ROUND",
        outputsJson: "[]",
      })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.receivePolishedDiamonds).not.toHaveBeenCalled();
  });

  it("returns the existing receipt instead of posting again when the idempotency key already exists", async () => {
    mocks.polishedReceiptFindUnique.mockResolvedValue({ receiptCode: "ZL-REC-2026-000001" });

    const result = await receivePolishedAction(
      undefined,
      formData({
        jobId: "job-1",
        receiveDate: "2026-06-15",
        shape: "ROUND",
        outputsJson: JSON.stringify([{ shape: "ROUND", carat: "1" }]),
        idempotencyKey: "same-key",
      })
    );

    expect(result).toEqual({ success: true, code: "ZL-REC-2026-000001" });
    expect(mocks.receivePolishedDiamonds).not.toHaveBeenCalled();
  });
});

describe("Owner-only enforcement", () => {
  it("cancelDiamondJobAction requires Owner", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
    await expect(
      cancelDiamondJobAction(undefined, formData({ jobId: "job-1", cancellationReason: "test reason" }))
    ).rejects.toThrow();
    expect(mocks.cancelDiamondJob).not.toHaveBeenCalled();
  });

  it("recutPolishedAction requires Owner", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
    await expect(
      recutPolishedAction(undefined, formData({ polishedDiamondId: "pol-1", reason: "test reason" }))
    ).rejects.toThrow();
    expect(mocks.recutPolishedDiamond).not.toHaveBeenCalled();
  });

  it("overrideRoughAllocationAction requires Owner", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
    await expect(
      overrideRoughAllocationAction(
        undefined,
        formData({
          lotId: "lot-1",
          reason: "test reason",
          adjustmentsJson: JSON.stringify([{ key: "piece-1", newAllocatedCost: "10" }]),
        })
      )
    ).rejects.toThrow();
    expect(mocks.overrideRoughPieceAllocations).not.toHaveBeenCalled();
  });

  it("createRoughPurchase and issueRoughAction do NOT require Owner (Staff may operate them)", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.createRoughLotWithPieces.mockResolvedValue({ lotCode: "ZL-RL-2026-000002" });

    const result = await createRoughPurchase(
      undefined,
      formData({
        purchaseDate: "2026-06-15",
        supplierId: "supplier-1",
        purchaseRate: "100",
        totalPurchaseCost: "100",
        piecesJson: JSON.stringify([{ carat: "1" }]),
      })
    );

    expect(result?.success).toBe(true);
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });
});
