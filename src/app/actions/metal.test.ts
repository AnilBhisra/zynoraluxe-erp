import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  metalPurityCreate: vi.fn(),
  metalPurityUpdate: vi.fn(),
  metalPurchaseFindUnique: vi.fn(),
  revalidatePath: vi.fn(),
  getCompanyFySettings: vi.fn(),
  checkVoucherDateAllowed: vi.fn(),
  createMetalPurchase: vi.fn(),
  postOpeningMetalStock: vi.fn(),
  adjustMetalStock: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireUser: mocks.requireUser,
  requireOwner: mocks.requireOwner,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    metalPurity: { create: mocks.metalPurityCreate, update: mocks.metalPurityUpdate },
    metalPurchase: { findUnique: mocks.metalPurchaseFindUnique },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/accounting/company", () => ({
  getCompanyFySettings: mocks.getCompanyFySettings,
}));

vi.mock("@/lib/accounting/financialYear", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounting/financialYear")>("@/lib/accounting/financialYear");
  return { ...actual, checkVoucherDateAllowed: mocks.checkVoucherDateAllowed };
});

vi.mock("@/lib/jewellery/posting", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jewellery/posting")>("@/lib/jewellery/posting");
  return {
    ...actual,
    createMetalPurchase: mocks.createMetalPurchase,
    postOpeningMetalStock: mocks.postOpeningMetalStock,
    adjustMetalStock: mocks.adjustMetalStock,
  };
});

import { Prisma } from "@/generated/prisma/client";
import {
  adjustMetalStockAction,
  createMetalPurchase,
  createMetalPurity,
  createOpeningMetalStock,
  updateMetalPurity,
} from "./metal";

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
  mocks.checkVoucherDateAllowed.mockReturnValue({ ok: true });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
  mocks.metalPurchaseFindUnique.mockResolvedValue(null);
});

describe("Metal/Purity master — Owner-only", () => {
  it("createMetalPurity requires Owner", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
    await expect(
      createMetalPurity(undefined, formData({ metalType: "GOLD", displayName: "18K", finenessPercent: "75" }))
    ).rejects.toThrow();
    expect(mocks.metalPurityCreate).not.toHaveBeenCalled();
  });

  it("createMetalPurity rejects a fineness percentage over 100", async () => {
    const result = await createMetalPurity(
      undefined,
      formData({ metalType: "GOLD", displayName: "Bad", finenessPercent: "150" })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.metalPurityCreate).not.toHaveBeenCalled();
  });

  it("createMetalPurity surfaces a clear message on a duplicate metal+display-name combination", async () => {
    mocks.metalPurityCreate.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" })
    );
    const result = await createMetalPurity(
      undefined,
      formData({ metalType: "GOLD", displayName: "18K", finenessPercent: "75" })
    );
    expect(result?.error).toMatch(/already exists/i);
  });

  it("updateMetalPurity requires Owner", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
    await expect(
      updateMetalPurity(
        undefined,
        formData({ purityId: "p1", metalType: "GOLD", displayName: "18K", finenessPercent: "75" })
      )
    ).rejects.toThrow();
    expect(mocks.metalPurityUpdate).not.toHaveBeenCalled();
  });
});

describe("createMetalPurchase — any authenticated user, idempotent", () => {
  it("does NOT require Owner (Staff may record purchases)", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.createMetalPurchase.mockResolvedValue({ purchaseCode: "ZL-MP-2026-000001" });

    const result = await createMetalPurchase(
      undefined,
      formData({
        purchaseDate: "2026-06-15",
        supplierId: "supplier-1",
        metalType: "GOLD",
        purityId: "purity-1",
        grossWeight: "10",
        rateBasis: "PER_GROSS_GRAM",
        rate: "5000",
        totalPurchaseCost: "50000",
        gstTreatment: "NONE",
      })
    );

    expect(result?.success).toBe(true);
    expect(mocks.requireOwner).not.toHaveBeenCalled();
  });

  it("rejects a zero gross weight at the schema layer, without touching the posting engine", async () => {
    const result = await createMetalPurchase(
      undefined,
      formData({
        purchaseDate: "2026-06-15",
        supplierId: "supplier-1",
        metalType: "GOLD",
        purityId: "purity-1",
        grossWeight: "0",
        rateBasis: "PER_GROSS_GRAM",
        rate: "5000",
        totalPurchaseCost: "0",
        gstTreatment: "NONE",
      })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.createMetalPurchase).not.toHaveBeenCalled();
  });

  it("returns the existing purchase instead of posting again when the idempotency key already exists", async () => {
    mocks.metalPurchaseFindUnique.mockResolvedValue({ purchaseCode: "ZL-MP-2026-000002" });

    const result = await createMetalPurchase(
      undefined,
      formData({
        purchaseDate: "2026-06-15",
        supplierId: "supplier-1",
        metalType: "GOLD",
        purityId: "purity-1",
        grossWeight: "10",
        rateBasis: "PER_GROSS_GRAM",
        rate: "5000",
        totalPurchaseCost: "50000",
        gstTreatment: "NONE",
        idempotencyKey: "same-key",
      })
    );

    expect(result).toEqual({ success: true, code: "ZL-MP-2026-000002" });
    expect(mocks.createMetalPurchase).not.toHaveBeenCalled();
  });

  it("rejects a purchase date outside the current financial year for Staff without confirmation", async () => {
    mocks.requireUser.mockResolvedValue(STAFF);
    mocks.checkVoucherDateAllowed.mockReturnValue({ ok: false, message: "Date is outside the current financial year." });

    const result = await createMetalPurchase(
      undefined,
      formData({
        purchaseDate: "2020-01-01",
        supplierId: "supplier-1",
        metalType: "GOLD",
        purityId: "purity-1",
        grossWeight: "10",
        rateBasis: "PER_GROSS_GRAM",
        rate: "5000",
        totalPurchaseCost: "50000",
        gstTreatment: "NONE",
      })
    );

    expect(result?.error).toBeTruthy();
    expect(mocks.createMetalPurchase).not.toHaveBeenCalled();
  });
});

describe("Owner-only stock operations", () => {
  it("createOpeningMetalStock requires Owner", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
    await expect(
      createOpeningMetalStock(
        undefined,
        formData({ metalType: "GOLD", purityId: "purity-1", grossWeight: "10", costValue: "50000" })
      )
    ).rejects.toThrow();
    expect(mocks.postOpeningMetalStock).not.toHaveBeenCalled();
  });

  it("adjustMetalStockAction requires Owner", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("redirect to /unauthorized");
    });
    await expect(
      adjustMetalStockAction(
        undefined,
        formData({
          metalType: "GOLD",
          purityId: "purity-1",
          direction: "IN",
          grossWeight: "5",
          costValue: "0",
          reason: "Physical count correction",
        })
      )
    ).rejects.toThrow();
    expect(mocks.adjustMetalStock).not.toHaveBeenCalled();
  });

  it("adjustMetalStockAction rejects a reason under 3 characters at the schema layer", async () => {
    const result = await adjustMetalStockAction(
      undefined,
      formData({ metalType: "GOLD", purityId: "purity-1", direction: "IN", grossWeight: "5", costValue: "0", reason: "x" })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.adjustMetalStock).not.toHaveBeenCalled();
  });
});
