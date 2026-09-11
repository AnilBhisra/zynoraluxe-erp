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
  mocks.voucherFindUnique.mockResolvedValue(null);
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
});
