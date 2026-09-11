import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  partyCreate: vi.fn(),
  partyFindUnique: vi.fn(),
  partyUpdate: vi.fn(),
  voucherCount: vi.fn(),
  revalidatePath: vi.fn(),
  getCompanyFySettings: vi.fn(),
  postOpeningBalance: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireUser: mocks.requireUser,
  requireOwner: mocks.requireOwner,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    party: {
      create: mocks.partyCreate,
      findUnique: mocks.partyFindUnique,
      update: mocks.partyUpdate,
    },
    voucher: { count: mocks.voucherCount },
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
  return { ...actual, postOpeningBalance: mocks.postOpeningBalance };
});

import { createParty, setPartyActive, updateParty } from "./parties";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const EXISTING_PARTY = {
  id: "party-1",
  name: "Asha Jewellers",
  type: "CUSTOMER" as const,
  phone: "9999999999",
  email: "asha@example.com",
  gstin: null,
  address: "Old address",
  state: null,
  stateCode: null,
  isActive: true,
  openingBalance: "0",
  openingBalanceType: "RECEIVABLE" as const,
};

function editFormData(overrides: Record<string, string> = {}) {
  return formData({
    partyId: EXISTING_PARTY.id,
    name: EXISTING_PARTY.name,
    type: EXISTING_PARTY.type,
    phone: EXISTING_PARTY.phone,
    email: EXISTING_PARTY.email,
    address: EXISTING_PARTY.address,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue({ id: "u1", role: "STAFF", name: "Staff", email: "s@b.com" });
  mocks.requireOwner.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
  mocks.getCompanyFySettings.mockResolvedValue({
    fyStartMonth: 4,
    fyStartDay: 1,
    stateCode: null,
    defaultCurrency: "INR",
  });
  mocks.partyCreate.mockResolvedValue({ id: "party-1" });
  mocks.partyFindUnique.mockResolvedValue({ ...EXISTING_PARTY });
  mocks.partyUpdate.mockResolvedValue({ ...EXISTING_PARTY });
  mocks.voucherCount.mockResolvedValue(0);
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({ party: { create: mocks.partyCreate } })
  );
});

describe("createParty", () => {
  it("allows Staff to create a party (not Owner-only)", async () => {
    const result = await createParty(
      undefined,
      formData({ name: "Asha Jewellers", type: "CUSTOMER", openingBalance: "0" })
    );
    expect(result?.success).toBe(true);
  });

  it("rejects a name that is too short", async () => {
    const result = await createParty(
      undefined,
      formData({ name: "A", type: "CUSTOMER", openingBalance: "0" })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.partyCreate).not.toHaveBeenCalled();
  });

  it("rejects a malformed GSTIN", async () => {
    const result = await createParty(
      undefined,
      formData({
        name: "Asha Jewellers",
        type: "CUSTOMER",
        gstin: "not-a-real-gstin",
        openingBalance: "0",
      })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.partyCreate).not.toHaveBeenCalled();
  });

  it("does not post an opening balance voucher when the opening balance is zero", async () => {
    await createParty(undefined, formData({ name: "Asha Jewellers", type: "CUSTOMER", openingBalance: "0" }));
    expect(mocks.postOpeningBalance).not.toHaveBeenCalled();
  });

  it("posts an opening balance voucher when a non-zero opening balance is given", async () => {
    const result = await createParty(
      undefined,
      formData({
        name: "Asha Jewellers",
        type: "CUSTOMER",
        openingBalance: "1500",
        openingBalanceType: "RECEIVABLE",
      })
    );
    expect(result?.success).toBe(true);
    expect(mocks.postOpeningBalance).toHaveBeenCalledTimes(1);
    const call = mocks.postOpeningBalance.mock.calls[0][1];
    expect(call.amount).toBe(1500);
    expect(call.openingBalanceType).toBe("RECEIVABLE");
  });

  it("rejects a negative opening balance", async () => {
    const result = await createParty(
      undefined,
      formData({ name: "Asha Jewellers", type: "CUSTOMER", openingBalance: "-100" })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.partyCreate).not.toHaveBeenCalled();
  });
});

describe("updateParty — successful Owner edit", () => {
  it("lets Owner change every editable field", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });

    const result = await updateParty(
      undefined,
      editFormData({
        name: "Asha Jewellers Pvt Ltd",
        phone: "8888888888",
        email: "new@example.com",
        address: "New address",
        gstin: "24AAAAA0000A1Z5",
        state: "Gujarat",
        stateCode: "24",
        isActive: "true",
      })
    );

    expect(result?.success).toBe(true);
    expect(mocks.partyUpdate).toHaveBeenCalledTimes(1);
    const args = mocks.partyUpdate.mock.calls[0][0];
    expect(args.where.id).toBe("party-1");
    expect(args.data.name).toBe("Asha Jewellers Pvt Ltd");
    expect(args.data.gstin).toBe("24AAAAA0000A1Z5");
    expect(args.data.stateCode).toBe("24");
    expect(args.data.updatedByUserId).toBe("o1");
  });

  it("sets updatedByUserId without touching createdByUserId/createdAt", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    await updateParty(undefined, editFormData({ name: "Renamed" }));
    const args = mocks.partyUpdate.mock.calls[0][0];
    expect(args.data.updatedByUserId).toBe("o1");
    expect(args.data).not.toHaveProperty("createdByUserId");
    expect(args.data).not.toHaveProperty("createdAt");
  });
});

describe("updateParty — validation", () => {
  it("rejects a malformed GSTIN and does not call update", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    const result = await updateParty(undefined, editFormData({ gstin: "not-a-gstin" }));
    expect(result?.error).toBeTruthy();
    expect(mocks.partyUpdate).not.toHaveBeenCalled();
  });

  it("returns an error when the party does not exist", async () => {
    mocks.partyFindUnique.mockResolvedValue(null);
    const result = await updateParty(undefined, editFormData());
    expect(result?.error).toBeTruthy();
    expect(mocks.partyUpdate).not.toHaveBeenCalled();
  });
});

describe("updateParty — Staff authorization", () => {
  it("lets Staff change phone, email and address", async () => {
    const result = await updateParty(
      undefined,
      editFormData({ phone: "7777777777", email: "staffchanged@example.com", address: "Updated by staff" })
    );
    expect(result?.success).toBe(true);
    const args = mocks.partyUpdate.mock.calls[0][0];
    expect(args.data.phone).toBe("7777777777");
    expect(args.data.address).toBe("Updated by staff");
  });

  it("rejects a Staff attempt to change the party name", async () => {
    const result = await updateParty(undefined, editFormData({ name: "Renamed By Staff" }));
    expect(result?.error).toMatch(/only the owner/i);
    expect(mocks.partyUpdate).not.toHaveBeenCalled();
  });

  it("rejects a Staff attempt to change party type", async () => {
    const result = await updateParty(undefined, editFormData({ type: "SUPPLIER" }));
    expect(result?.error).toMatch(/only the owner/i);
    expect(mocks.partyUpdate).not.toHaveBeenCalled();
  });

  it("rejects a Staff attempt to change GSTIN/state/stateCode", async () => {
    const result = await updateParty(undefined, editFormData({ gstin: "24AAAAA0000A1Z5" }));
    expect(result?.error).toMatch(/only the owner/i);
    expect(mocks.partyUpdate).not.toHaveBeenCalled();
  });

  it("ignores an isActive value submitted by Staff (Owner-only field)", async () => {
    // Staff's form never renders this field, but even if a raw request
    // included it, the server must not honor it.
    const result = await updateParty(undefined, editFormData({ isActive: "false" }));
    expect(result?.success).toBe(true);
    const args = mocks.partyUpdate.mock.calls[0][0];
    expect(args.data.isActive).toBe(true); // unchanged from EXISTING_PARTY
  });
});

describe("updateParty — archived party behaviour", () => {
  it("blocks Staff from editing an archived party at all", async () => {
    mocks.partyFindUnique.mockResolvedValue({ ...EXISTING_PARTY, isActive: false });
    const result = await updateParty(undefined, editFormData({ phone: "1231231234" }));
    expect(result?.error).toMatch(/archived/i);
    expect(mocks.partyUpdate).not.toHaveBeenCalled();
  });

  it("still lets Owner edit an archived party", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    mocks.partyFindUnique.mockResolvedValue({ ...EXISTING_PARTY, isActive: false });
    const result = await updateParty(undefined, editFormData({ phone: "1231231234" }));
    expect(result?.success).toBe(true);
  });

  it("lets Owner reactivate a party via the edit form", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    mocks.partyFindUnique.mockResolvedValue({ ...EXISTING_PARTY, isActive: false });
    const result = await updateParty(undefined, editFormData({ isActive: "true" }));
    expect(result?.success).toBe(true);
    expect(mocks.partyUpdate.mock.calls[0][0].data.isActive).toBe(true);
  });
});

describe("updateParty — party type change guard", () => {
  it("allows an Owner type change with no confirmation when no vouchers exist", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    mocks.voucherCount.mockResolvedValue(0);
    const result = await updateParty(undefined, editFormData({ type: "SUPPLIER" }));
    expect(result?.success).toBe(true);
  });

  it("rejects an Owner type change when vouchers exist and it isn't confirmed", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    mocks.voucherCount.mockResolvedValue(3);
    const result = await updateParty(undefined, editFormData({ type: "SUPPLIER" }));
    expect(result?.error).toMatch(/3 existing transaction/i);
    expect(mocks.partyUpdate).not.toHaveBeenCalled();
  });

  it("allows the type change once explicitly confirmed", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    mocks.voucherCount.mockResolvedValue(3);
    const result = await updateParty(
      undefined,
      editFormData({ type: "SUPPLIER", confirmTypeChange: "true" })
    );
    expect(result?.success).toBe(true);
    expect(mocks.partyUpdate.mock.calls[0][0].data.type).toBe("SUPPLIER");
  });
});

describe("updateParty — opening balance protection", () => {
  it("never accepts openingBalance/openingBalanceType through the edit form", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    const result = await updateParty(
      undefined,
      editFormData({ openingBalance: "999999", openingBalanceType: "PAYABLE" })
    );
    expect(result?.success).toBe(true);
    const args = mocks.partyUpdate.mock.calls[0][0];
    expect(args.data).not.toHaveProperty("openingBalance");
    expect(args.data).not.toHaveProperty("openingBalanceType");
  });
});

describe("updateParty — historical accounting is never touched", () => {
  it("never calls anything that would mutate a voucher, journal entry or invoice line", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    mocks.voucherCount.mockResolvedValue(5); // a party with real transaction history
    const result = await updateParty(undefined, editFormData({ address: "Corrected address only" }));

    expect(result?.success).toBe(true);
    // The only voucher-table call in updateParty is the read-only count
    // used by the type-change guard — and type didn't change here.
    expect(mocks.voucherCount).not.toHaveBeenCalled();
    // party.update is the one and only write updateParty performs.
    expect(mocks.partyUpdate).toHaveBeenCalledTimes(1);
  });

  it("leaves existing ledger totals unaffected because no journal/voucher write ever happens", async () => {
    mocks.requireUser.mockResolvedValue({ id: "o1", role: "OWNER", name: "Owner", email: "o@b.com" });
    mocks.voucherCount.mockResolvedValue(5);
    await updateParty(undefined, editFormData({ stateCode: "27", state: "Maharashtra" }));
    // Nothing here can change a balance: the mocked prisma client exposes
    // no journalEntry/invoiceLine methods at all, so if updateParty tried
    // to touch either, this test would throw instead of resolving cleanly.
    expect(mocks.partyUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("setPartyActive", () => {
  it("is Owner-only", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("REDIRECT:/unauthorized");
    });
    await expect(
      setPartyActive(formData({ partyId: "party-1", nextActive: "false" }))
    ).rejects.toThrow("REDIRECT:/unauthorized");
    expect(mocks.partyUpdate).not.toHaveBeenCalled();
  });

  it("archives a party when called by Owner", async () => {
    await setPartyActive(formData({ partyId: "party-1", nextActive: "false" }));
    expect(mocks.partyUpdate).toHaveBeenCalledWith({
      where: { id: "party-1" },
      data: { isActive: false, updatedByUserId: "o1" },
    });
  });
});
