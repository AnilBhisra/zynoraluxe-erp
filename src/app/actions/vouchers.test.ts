import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  voucherFindUnique: vi.fn(),
  gstRateFindMany: vi.fn(),
  revalidatePath: vi.fn(),
  getCompanyFySettings: vi.fn(),
  postPaymentGiven: vi.fn(),
  postPurchase: vi.fn(),
  cancelVoucher: vi.fn(),
  roughLotFindUnique: vi.fn(),
  polishedPurchaseFindUnique: vi.fn(),
  metalPurchaseFindUnique: vi.fn(),
  metalStockMovementFindFirst: vi.fn(),
  finishedJewellerySaleFindUnique: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireUser: mocks.requireUser,
  requireOwner: mocks.requireOwner,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    voucher: { findUnique: mocks.voucherFindUnique },
    gstRate: { findMany: mocks.gstRateFindMany },
    roughLot: { findUnique: mocks.roughLotFindUnique },
    polishedPurchase: { findUnique: mocks.polishedPurchaseFindUnique },
    metalPurchase: { findUnique: mocks.metalPurchaseFindUnique },
    metalStockMovement: { findFirst: mocks.metalStockMovementFindFirst },
    finishedJewellerySale: { findUnique: mocks.finishedJewellerySaleFindUnique },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/accounting/company", () => ({
  getCompanyFySettings: mocks.getCompanyFySettings,
}));

vi.mock("@/lib/accounting/posting", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounting/posting")>(
    "@/lib/accounting/posting"
  );
  return {
    ...actual,
    postPaymentGiven: mocks.postPaymentGiven,
    postPurchase: mocks.postPurchase,
    cancelVoucher: mocks.cancelVoucher,
  };
});

import { Prisma } from "@/generated/prisma/client";
import { cancelVoucherAction, createPaymentGiven, createPurchase } from "./vouchers";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "u1", role: "OWNER", name: "Owner", email: "o@b.com" });
  mocks.requireOwner.mockResolvedValue({ id: "u1", role: "OWNER", name: "Owner", email: "o@b.com" });
  mocks.getCompanyFySettings.mockResolvedValue({
    fyStartMonth: 4,
    fyStartDay: 1,
    stateCode: null,
    defaultCurrency: "INR",
  });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
  mocks.polishedPurchaseFindUnique.mockResolvedValue(null);
  mocks.voucherFindUnique.mockResolvedValue(null);
  mocks.roughLotFindUnique.mockResolvedValue(null);
  mocks.metalPurchaseFindUnique.mockResolvedValue(null);
  mocks.metalStockMovementFindFirst.mockResolvedValue(null);
  mocks.finishedJewellerySaleFindUnique.mockResolvedValue(null);
});

describe("createPaymentGiven validation", () => {
  it("rejects a missing party without touching the posting engine", async () => {
    const result = await createPaymentGiven(
      undefined,
      formData({
        date: "2026-06-15",
        partyId: "",
        paymentAccountId: "pa-1",
        amount: "100",
      })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.postPaymentGiven).not.toHaveBeenCalled();
  });

  it("rejects a zero amount at the schema layer", async () => {
    const result = await createPaymentGiven(
      undefined,
      formData({
        date: "2026-06-15",
        partyId: "party-1",
        paymentAccountId: "pa-1",
        amount: "0",
      })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.postPaymentGiven).not.toHaveBeenCalled();
  });

  it("posts successfully with valid input", async () => {
    mocks.postPaymentGiven.mockResolvedValue({ voucherNumber: "PMT-OUT/2026-27/0001" });
    const result = await createPaymentGiven(
      undefined,
      formData({
        date: "2026-06-15",
        partyId: "party-1",
        paymentAccountId: "pa-1",
        amount: "500",
      })
    );
    expect(result?.success).toBe(true);
    expect(result?.voucherNumber).toBe("PMT-OUT/2026-27/0001");
  });
});

describe("idempotent duplicate submission", () => {
  it("returns the existing voucher instead of erroring when the idempotency key already exists", async () => {
    mocks.transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["idempotencyKey"] },
      })
    );
    mocks.voucherFindUnique.mockResolvedValue({
      id: "existing-1",
      voucherNumber: "PMT-OUT/2026-27/0001",
    });

    const result = await createPaymentGiven(
      undefined,
      formData({
        date: "2026-06-15",
        partyId: "party-1",
        paymentAccountId: "pa-1",
        amount: "500",
        idempotencyKey: "same-key-resubmitted",
      })
    );

    expect(result?.success).toBe(true);
    expect(result?.voucherNumber).toBe("PMT-OUT/2026-27/0001");
  });

  it("also recovers when the conflict carries the Postgres driver adapter's constraint name instead of meta.target", async () => {
    mocks.transaction.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: {
          driverAdapterError: {
            name: "DriverAdapterError",
            cause: { originalCode: "23505", kind: "UniqueConstraintViolation", constraint: { index: "vouchers_idempotencyKey_key" }, table: "vouchers" },
          },
          modelName: "Voucher",
        },
      })
    );
    // Pre-check misses (the winner has not committed yet); recovery lookup finds it.
    mocks.voucherFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "existing-1", voucherNumber: "PMT-OUT/2026-27/0001" });

    const result = await createPaymentGiven(
      undefined,
      formData({
        date: "2026-06-15",
        partyId: "party-1",
        paymentAccountId: "pa-1",
        amount: "500",
        idempotencyKey: "same-key-resubmitted",
      })
    );

    expect(result?.success).toBe(true);
    expect(result?.voucherNumber).toBe("PMT-OUT/2026-27/0001");
  });

  it("short-circuits before posting at all when the key was already used on a prior successful call", async () => {
    mocks.voucherFindUnique.mockResolvedValue({
      id: "existing-1",
      voucherNumber: "PMT-OUT/2026-27/0001",
    });

    const result = await createPaymentGiven(
      undefined,
      formData({
        date: "2026-06-15",
        partyId: "party-1",
        paymentAccountId: "pa-1",
        amount: "500",
        idempotencyKey: "already-posted-key",
      })
    );

    expect(result?.success).toBe(true);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("createPurchase GST rate resolution", () => {
  it("rejects when a submitted GST rate id no longer exists, without posting", async () => {
    mocks.gstRateFindMany.mockResolvedValue([]); // none found

    const result = await createPurchase(
      undefined,
      formData({
        date: "2026-06-15",
        partyId: "supplier-1",
        gstTreatment: "NONE",
        linesJson: JSON.stringify([
          {
            description: "Gold",
            quantity: "1",
            unit: "GRAM",
            rate: "1000",
            gstRateId: "deleted-rate",
            taxType: "EXCLUSIVE",
          },
        ]),
      })
    );

    expect(result?.error).toMatch(/GST rate/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("cancelVoucherAction permissions", () => {
  it("is Owner-only (Staff is rejected before reaching the posting engine)", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("REDIRECT:/unauthorized");
    });

    await expect(
      cancelVoucherAction(
        undefined,
        formData({ voucherId: "v1", cancellationReason: "Entered twice by mistake" })
      )
    ).rejects.toThrow("REDIRECT:/unauthorized");

    expect(mocks.cancelVoucher).not.toHaveBeenCalled();
  });

  it("rejects a cancellation reason that is too short", async () => {
    const result = await cancelVoucherAction(undefined, formData({ voucherId: "v1", cancellationReason: "x" }));
    expect(result?.error).toBeTruthy();
    expect(mocks.cancelVoucher).not.toHaveBeenCalled();
  });

  it("redirects a JEWELLERY_ISSUE voucher to the Jewellery Jobs page instead of cancelling it generically", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "JEWELLERY_ISSUE" });
    const result = await cancelVoucherAction(
      undefined,
      formData({ voucherId: "v1", cancellationReason: "Wrong Karigar entirely" })
    );
    expect(result?.error).toMatch(/Jewellery Jobs page/i);
    expect(mocks.cancelVoucher).not.toHaveBeenCalled();
  });

  it("rejects cancelling a JEWELLERY_RECEIPT voucher outright — not reversible in Phase 4", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "JEWELLERY_RECEIPT" });
    const result = await cancelVoucherAction(
      undefined,
      formData({ voucherId: "v1", cancellationReason: "Made a mistake" })
    );
    expect(result?.error).toMatch(/cannot be cancelled/i);
    expect(mocks.cancelVoucher).not.toHaveBeenCalled();
  });

  // Real bug found during the V1 final acceptance audit (live E2E,
  // confirmed against the real database): a Rough Purchase / Metal
  // Purchase voucher posts as the plain "PURCHASE" type (there is no
  // dedicated voucher type for either), so it fell through all four
  // checks above and could be cancelled through this generic action even
  // after its stock was fully issued/consumed — reversing the accounting
  // while silently leaving the real Rough/Metal stock (and anything built
  // from it downstream) completely out of sync.

  it("rejects cancelling a Rough Purchase voucher once any of its pieces has been issued (costLocked)", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "PURCHASE" });
    mocks.roughLotFindUnique.mockResolvedValue({
      pieces: [{ costLocked: false }, { costLocked: true }],
    });
    const result = await cancelVoucherAction(
      undefined,
      formData({ voucherId: "v1", cancellationReason: "Trying to cancel after issue" })
    );
    expect(result?.error).toMatch(/already been issued/i);
    expect(mocks.cancelVoucher).not.toHaveBeenCalled();
  });

  it("allows cancelling a Rough Purchase voucher while every piece is still unissued", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "PURCHASE" });
    mocks.roughLotFindUnique.mockResolvedValue({
      pieces: [{ costLocked: false }, { costLocked: false }],
    });
    await cancelVoucherAction(undefined, formData({ voucherId: "v1", cancellationReason: "Entered by mistake" }));
    expect(mocks.cancelVoucher).toHaveBeenCalled();
  });

  it("rejects cancelling a Metal Purchase voucher once any metal of that purity has been issued since this purchase — even if the pool still holds plenty from other purchases", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "PURCHASE" });
    mocks.metalPurchaseFindUnique.mockResolvedValue({
      metalType: "GOLD",
      purityId: "p22k",
      purchaseCode: "ZL-MP-2026-000010",
      grossWeight: "30.000",
      totalPurchaseCost: "180000.00",
    });
    // First call resolves this purchase's own PURCHASE_IN movement (to
    // anchor "since this purchase"); second call finds a later ISSUE_OUT —
    // a real pool can easily still hold far more than 30g from OTHER
    // purchases, which is exactly why a point-in-time balance check would
    // wrongly allow this.
    mocks.metalStockMovementFindFirst
      .mockResolvedValueOnce({ createdAt: new Date("2026-01-01T00:00:00Z") })
      .mockResolvedValueOnce({ createdAt: new Date("2026-01-02T00:00:00Z") });
    const result = await cancelVoucherAction(
      undefined,
      formData({ voucherId: "v1", cancellationReason: "Trying to cancel after issue" })
    );
    expect(result?.error).toMatch(/already been issued/i);
    expect(mocks.cancelVoucher).not.toHaveBeenCalled();
  });

  it("allows cancelling a Metal Purchase voucher while no metal of that purity has been issued since this purchase", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "PURCHASE" });
    mocks.metalPurchaseFindUnique.mockResolvedValue({
      metalType: "GOLD",
      purityId: "p22k",
      purchaseCode: "ZL-MP-2026-000010",
      grossWeight: "30.000",
      totalPurchaseCost: "180000.00",
    });
    mocks.metalStockMovementFindFirst
      .mockResolvedValueOnce({ createdAt: new Date("2026-01-01T00:00:00Z") }) // this purchase's own movement
      .mockResolvedValueOnce(null); // no later outflow
    await cancelVoucherAction(undefined, formData({ voucherId: "v1", cancellationReason: "Entered by mistake" }));
    expect(mocks.cancelVoucher).toHaveBeenCalled();
  });

  // Phase 7: a direct Polished Diamond Purchase is also a plain "PURCHASE"
  // voucher; generic cancellation would reverse accounting but leave every
  // packet's PURCHASE_IN movement standing.
  it("rejects cancelling a packet stock adjustment voucher through the generic action", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "STOCK_ADJUSTMENT" });
    const result = await cancelVoucherAction(undefined, formData({ voucherId: "v1", cancellationReason: "Wrong count" }));
    expect(result?.error).toMatch(/opposite adjustment/);
    expect(mocks.cancelVoucher).not.toHaveBeenCalled();
  });

  it("rejects cancelling a Polished Diamond Purchase voucher through the generic action", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "PURCHASE" });
    mocks.polishedPurchaseFindUnique.mockResolvedValue({ id: "pp1" });
    const result = await cancelVoucherAction(
      undefined,
      formData({ voucherId: "v1", cancellationReason: "Entered by mistake" })
    );
    expect(result?.error).toMatch(/Polished Diamond Purchase/);
    expect(mocks.cancelVoucher).not.toHaveBeenCalled();
  });

  it("allows cancelling an ordinary PURCHASE voucher that isn't linked to any Rough Lot or Metal Purchase", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "PURCHASE" });
    // roughLot/metalPurchase mocks already resolve to null in beforeEach —
    // this is a plain Phase 2 accounting purchase (e.g. office supplies).
    await cancelVoucherAction(undefined, formData({ voucherId: "v1", cancellationReason: "Entered by mistake" }));
    expect(mocks.cancelVoucher).toHaveBeenCalled();
  });

  // Phase 6: a Finished Jewellery Sale posts as a plain "SALE" voucher
  // (same reuse pattern as Rough/Metal Purchase reusing "PURCHASE" above)
  // — without this guard, generic cancellation would reverse the
  // accounting while leaving the FinishedJewellery item's status stuck at
  // SOLD and creating no stock movement, desyncing stock from accounting.
  it("blocks cancelling a SALE voucher linked to a Finished Jewellery Sale, directing the Owner to the Finished Stock page instead", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "SALE" });
    mocks.finishedJewellerySaleFindUnique.mockResolvedValue({ id: "fjs-1" });
    const result = await cancelVoucherAction(
      undefined,
      formData({ voucherId: "v1", cancellationReason: "Trying to cancel generically" })
    );
    expect(result?.error).toMatch(/Finished Stock page/i);
    expect(mocks.cancelVoucher).not.toHaveBeenCalled();
  });

  it("allows cancelling an ordinary SALE voucher that isn't linked to any Finished Jewellery Sale", async () => {
    mocks.voucherFindUnique.mockResolvedValue({ voucherType: "SALE" });
    // finishedJewellerySale mock already resolves to null in beforeEach —
    // this is a plain "Other / Accounting-only" Sale.
    await cancelVoucherAction(undefined, formData({ voucherId: "v1", cancellationReason: "Entered by mistake" }));
    expect(mocks.cancelVoucher).toHaveBeenCalled();
  });
});
