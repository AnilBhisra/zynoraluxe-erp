import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  gstRateCreate: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({ requireOwner: mocks.requireOwner }));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    gstRate: { create: mocks.gstRateCreate },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

import { createGstRate, createPaymentAccount } from "./accountingSettings";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireOwner.mockResolvedValue({ id: "owner-1", role: "OWNER", name: "Owner", email: "o@b.com" });
});

describe("createPaymentAccount", () => {
  it("is Owner-only", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("REDIRECT:/unauthorized");
    });
    await expect(
      createPaymentAccount(undefined, formData({ name: "HDFC Bank", method: "BANK" }))
    ).rejects.toThrow("REDIRECT:/unauthorized");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid payment method before touching the database", async () => {
    const result = await createPaymentAccount(
      undefined,
      formData({ name: "HDFC Bank", method: "BITCOIN" })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates a payment account for valid input", async () => {
    mocks.transaction.mockResolvedValue(undefined);
    const result = await createPaymentAccount(
      undefined,
      formData({ name: "HDFC Bank", method: "BANK" })
    );
    expect(result?.success).toBe(true);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});

describe("createGstRate", () => {
  it("is Owner-only", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("REDIRECT:/unauthorized");
    });
    await expect(
      createGstRate(undefined, formData({ label: "12%", ratePercent: "12" }))
    ).rejects.toThrow("REDIRECT:/unauthorized");
    expect(mocks.gstRateCreate).not.toHaveBeenCalled();
  });

  it("rejects a rate above 100%", async () => {
    const result = await createGstRate(undefined, formData({ label: "Too high", ratePercent: "150" }));
    expect(result?.error).toBeTruthy();
    expect(mocks.gstRateCreate).not.toHaveBeenCalled();
  });

  it("rejects a negative rate", async () => {
    const result = await createGstRate(undefined, formData({ label: "Negative", ratePercent: "-5" }));
    expect(result?.error).toBeTruthy();
    expect(mocks.gstRateCreate).not.toHaveBeenCalled();
  });

  it("creates a GST rate for valid input", async () => {
    mocks.gstRateCreate.mockResolvedValue({ id: "gst-1" });
    const result = await createGstRate(undefined, formData({ label: "12%", ratePercent: "12" }));
    expect(result?.success).toBe(true);
  });
});
