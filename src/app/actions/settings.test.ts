import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireOwner: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  upsert: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireOwner: mocks.requireOwner,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.findUnique, create: mocks.create },
    companySettings: { upsert: mocks.upsert },
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocks.revalidatePath,
}));

import { createStaffAccount, updateCompanySettings } from "./settings";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireOwner.mockResolvedValue({
    id: "owner-1",
    email: "o@b.com",
    name: "Owner",
    role: "OWNER",
  });
});

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("createStaffAccount", () => {
  it("rejects a duplicate email without creating a second account", async () => {
    mocks.findUnique.mockResolvedValue({ id: "existing" });

    const result = await createStaffAccount(
      undefined,
      formData({ name: "New Staff", email: "existing@example.com", password: "atleast8chars" })
    );

    expect(result?.error).toMatch(/already exists/i);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a Staff account with a hashed (not plaintext) password when the email is free", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.create.mockResolvedValue({ id: "new-1" });

    const result = await createStaffAccount(
      undefined,
      formData({ name: "New Staff", email: "new@example.com", password: "atleast8chars" })
    );

    expect(result?.success).toBe(true);
    expect(mocks.create).toHaveBeenCalledTimes(1);
    const createArgs = mocks.create.mock.calls[0][0];
    expect(createArgs.data.role).toBe("STAFF");
    expect(createArgs.data.passwordHash).not.toBe("atleast8chars");
  });

  it("rejects invalid input before touching the database", async () => {
    const result = await createStaffAccount(
      undefined,
      formData({ name: "N", email: "not-an-email", password: "short" })
    );

    expect(result?.error).toBeTruthy();
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});

describe("updateCompanySettings", () => {
  it("rejects an invalid GST number and does not write to the database", async () => {
    const result = await updateCompanySettings(
      undefined,
      formData({
        companyName: "Zynoraluxe",
        defaultCurrency: "INR",
        financialYearStartMonth: "4",
        financialYearStartDay: "1",
        gstNumber: "bad-gst",
      })
    );

    expect(result?.error).toBeTruthy();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("saves valid company settings tagged with the current owner", async () => {
    mocks.upsert.mockResolvedValue({});

    const result = await updateCompanySettings(
      undefined,
      formData({
        companyName: "Zynoraluxe",
        defaultCurrency: "INR",
        financialYearStartMonth: "4",
        financialYearStartDay: "1",
      })
    );

    expect(result?.success).toBe(true);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    const args = mocks.upsert.mock.calls[0][0];
    expect(args.update.updatedByUserId).toBe("owner-1");
  });
});
