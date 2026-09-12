import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireOwner: vi.fn(),
  transaction: vi.fn(),
  gstRateFindMany: vi.fn(),
  finishedJewellerySaleFindUnique: vi.fn(),
  finishedJewelleryReturnFindUnique: vi.fn(),
  voucherFindUnique: vi.fn(),
  accountFindMany: vi.fn(),
  journalEntryAggregate: vi.fn(),
  revalidatePath: vi.fn(),
  getCompanyFySettings: vi.fn(),
  postFinishedJewellerySale: vi.fn(),
  cancelFinishedJewellerySale: vi.fn(),
  returnFinishedJewelleryItems: vi.fn(),
  adjustFinishedJewelleryStock: vi.fn(),
  postCustomerRefund: vi.fn(),
  getSuggestedSalePrice: vi.fn(),
  getPhase5VsPhase6Comparison: vi.fn(),
}));

vi.mock("@/lib/auth/dal", () => ({
  requireUser: mocks.requireUser,
  requireOwner: mocks.requireOwner,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    gstRate: { findMany: mocks.gstRateFindMany },
    finishedJewellerySale: { findUnique: mocks.finishedJewellerySaleFindUnique },
    finishedJewelleryReturn: { findUnique: mocks.finishedJewelleryReturnFindUnique },
    voucher: { findUnique: mocks.voucherFindUnique },
    account: { findMany: mocks.accountFindMany },
    journalEntry: { aggregate: mocks.journalEntryAggregate },
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));

vi.mock("@/lib/accounting/company", () => ({
  getCompanyFySettings: mocks.getCompanyFySettings,
}));

vi.mock("@/lib/jewellery/finishedSalesPosting", () => ({
  postFinishedJewellerySale: mocks.postFinishedJewellerySale,
  cancelFinishedJewellerySale: mocks.cancelFinishedJewellerySale,
  returnFinishedJewelleryItems: mocks.returnFinishedJewelleryItems,
  adjustFinishedJewelleryStock: mocks.adjustFinishedJewelleryStock,
}));

vi.mock("@/lib/accounting/posting", async () => {
  const actual = await vi.importActual<typeof import("@/lib/accounting/posting")>("@/lib/accounting/posting");
  return { ...actual, postCustomerRefund: mocks.postCustomerRefund };
});

vi.mock("@/lib/costing/sourcing", () => ({
  getSuggestedSalePrice: mocks.getSuggestedSalePrice,
  getPhase5VsPhase6Comparison: mocks.getPhase5VsPhase6Comparison,
}));

import {
  adjustFinishedJewelleryStockAction,
  cancelFinishedJewellerySaleAction,
  createCustomerRefundAction,
  createFinishedJewellerySaleAction,
  getPhase5VsPhase6ComparisonAction,
  returnFinishedJewelleryItemsAction,
} from "./finishedSales";

const OWNER = { id: "owner-1", email: "owner@zl.test", name: "Owner", role: "OWNER" as const };
const STAFF = { id: "staff-1", email: "staff@zl.test", name: "Staff", role: "STAFF" as const };

function todayDateOnly() {
  return new Date().toISOString().slice(0, 10);
}

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function saleFormData(overrides: Record<string, string> = {}) {
  return formData({
    customerId: "customer-1",
    saleDate: todayDateOnly(),
    gstTreatment: "CGST_SGST",
    items: JSON.stringify([]),
    itemsJson: JSON.stringify([
      { finishedJewelleryId: "fj-1", sellingPrice: "100000", gstRatePercent: "3", taxType: "EXCLUSIVE" },
    ]),
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(STAFF);
  mocks.requireOwner.mockResolvedValue(OWNER);
  mocks.getCompanyFySettings.mockResolvedValue({
    fyStartMonth: 1,
    fyStartDay: 1,
    stateCode: null,
    defaultCurrency: "INR",
  });
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn({}));
  mocks.gstRateFindMany.mockResolvedValue([]);
  mocks.finishedJewellerySaleFindUnique.mockResolvedValue(null);
  mocks.finishedJewelleryReturnFindUnique.mockResolvedValue(null);
  mocks.voucherFindUnique.mockResolvedValue(null);
  mocks.accountFindMany.mockResolvedValue([
    { id: "acct-ar", code: "1100" },
    { id: "acct-ap", code: "2100" },
  ]);
  mocks.journalEntryAggregate.mockResolvedValue({ _sum: { debit: 0, credit: 0 } });
  mocks.postFinishedJewellerySale.mockResolvedValue({ sale: { saleCode: "ZL-FJS-2026-000001" } });
  mocks.cancelFinishedJewellerySale.mockResolvedValue({});
  mocks.returnFinishedJewelleryItems.mockResolvedValue({ return: { returnCode: "ZL-FJR-2026-000001" } });
  mocks.adjustFinishedJewelleryStock.mockResolvedValue({});
  mocks.postCustomerRefund.mockResolvedValue({ voucherNumber: "REFUND/2026-27/0001" });
  mocks.getSuggestedSalePrice.mockResolvedValue(null);
  mocks.getPhase5VsPhase6Comparison.mockResolvedValue(null);
});

describe("createFinishedJewellerySaleAction", () => {
  it("is available to Staff (matches the existing Sale permission) — requireUser, not requireOwner", async () => {
    const result = await createFinishedJewellerySaleAction(undefined, saleFormData());
    expect(mocks.requireUser).toHaveBeenCalled();
    expect(mocks.requireOwner).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true, code: "ZL-FJS-2026-000001" });
    expect(mocks.postFinishedJewellerySale).toHaveBeenCalled();
  });

  it("rejects an empty item selection at the schema layer, without posting", async () => {
    const result = await createFinishedJewellerySaleAction(undefined, saleFormData({ itemsJson: "[]" }));
    expect(result?.error).toBeTruthy();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects a submitted GST rate id that no longer exists, without posting", async () => {
    mocks.gstRateFindMany.mockResolvedValue([]); // none found
    const result = await createFinishedJewellerySaleAction(
      undefined,
      saleFormData({
        itemsJson: JSON.stringify([
          { finishedJewelleryId: "fj-1", sellingPrice: "100000", gstRateId: "gst-missing", gstRatePercent: "3", taxType: "EXCLUSIVE" },
        ]),
      })
    );
    expect(result?.error).toMatch(/GST rate/i);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("short-circuits on a repeat idempotencyKey without touching the posting engine", async () => {
    mocks.finishedJewellerySaleFindUnique.mockResolvedValue({ id: "fjs-existing", saleCode: "ZL-FJS-2026-000099" });
    const result = await createFinishedJewellerySaleAction(undefined, saleFormData({ idempotencyKey: "same-key" }));
    expect(result).toEqual({ success: true, code: "ZL-FJS-2026-000099" });
    expect(mocks.postFinishedJewellerySale).not.toHaveBeenCalled();
  });

  it("surfaces a PostingError from the engine as a plain form error, not a thrown exception", async () => {
    const { PostingError } = await vi.importActual<typeof import("@/lib/accounting/posting")>(
      "@/lib/accounting/posting"
    );
    mocks.transaction.mockRejectedValue(new PostingError("One or more selected pieces are no longer available."));
    const result = await createFinishedJewellerySaleAction(undefined, saleFormData());
    expect(result).toEqual({ error: "One or more selected pieces are no longer available." });
  });

  it("never leaks a raw database error message to the caller", async () => {
    mocks.transaction.mockRejectedValue(new Error("connection terminated unexpectedly at 10.0.0.5:5432"));
    const result = await createFinishedJewellerySaleAction(undefined, saleFormData());
    expect(result?.error).toBe("Could not save this sale. Please try again.");
    expect(result?.error).not.toMatch(/10\.0\.0\.5|5432|connection/i);
  });
});

describe("Owner-only Phase 6 actions reject Staff before reaching the posting engine", () => {
  it("cancelFinishedJewellerySaleAction", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("REDIRECT:/unauthorized");
    });
    await expect(
      cancelFinishedJewellerySaleAction(undefined, formData({ saleId: "fjs-1", cancellationReason: "Customer changed mind" }))
    ).rejects.toThrow("REDIRECT:/unauthorized");
    expect(mocks.cancelFinishedJewellerySale).not.toHaveBeenCalled();
  });

  it("returnFinishedJewelleryItemsAction", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("REDIRECT:/unauthorized");
    });
    await expect(
      returnFinishedJewelleryItemsAction(
        undefined,
        formData({
          saleId: "fjs-1",
          returnDate: todayDateOnly(),
          reason: "Wrong size",
          itemsJson: JSON.stringify([{ saleLineId: "line-1", disposition: "SELLABLE" }]),
        })
      )
    ).rejects.toThrow("REDIRECT:/unauthorized");
    expect(mocks.returnFinishedJewelleryItems).not.toHaveBeenCalled();
  });

  it("createCustomerRefundAction", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("REDIRECT:/unauthorized");
    });
    await expect(
      createCustomerRefundAction(
        undefined,
        formData({ partyId: "customer-1", paymentAccountId: "pay-1", amount: "500", date: todayDateOnly() })
      )
    ).rejects.toThrow("REDIRECT:/unauthorized");
    expect(mocks.postCustomerRefund).not.toHaveBeenCalled();
  });

  it("adjustFinishedJewelleryStockAction", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("REDIRECT:/unauthorized");
    });
    await expect(
      adjustFinishedJewelleryStockAction(
        undefined,
        formData({ finishedJewelleryId: "fj-1", direction: "OUT", reason: "Damaged beyond repair" })
      )
    ).rejects.toThrow("REDIRECT:/unauthorized");
    expect(mocks.adjustFinishedJewelleryStock).not.toHaveBeenCalled();
  });
});

describe("returnFinishedJewelleryItemsAction idempotency", () => {
  it("short-circuits on a repeat idempotencyKey without touching the posting engine", async () => {
    mocks.finishedJewelleryReturnFindUnique.mockResolvedValue({ id: "ret-existing", returnCode: "ZL-FJR-2026-000099" });
    const result = await returnFinishedJewelleryItemsAction(
      undefined,
      formData({
        saleId: "fjs-1",
        returnDate: todayDateOnly(),
        reason: "Wrong size",
        itemsJson: JSON.stringify([{ saleLineId: "line-1", disposition: "SELLABLE" }]),
        idempotencyKey: "same-key",
      })
    );
    expect(result).toEqual({ success: true, code: "ZL-FJR-2026-000099" });
    expect(mocks.returnFinishedJewelleryItems).not.toHaveBeenCalled();
  });
});

describe("createCustomerRefundAction credit-limit enforcement", () => {
  it("rejects a refund when the customer has no credit balance (AR is zero or positive)", async () => {
    mocks.journalEntryAggregate.mockResolvedValue({ _sum: { debit: 5000, credit: 1000 } }); // net +4000 = they owe US
    const result = await createCustomerRefundAction(
      undefined,
      formData({ partyId: "customer-1", paymentAccountId: "pay-1", amount: "500", date: todayDateOnly() })
    );
    expect(result?.error).toMatch(/no credit balance/i);
    expect(mocks.postCustomerRefund).not.toHaveBeenCalled();
  });

  it("rejects a refund amount greater than the available customer credit", async () => {
    mocks.journalEntryAggregate.mockResolvedValue({ _sum: { debit: 1000, credit: 6000 } }); // net -5000 = 5000 credit
    const result = await createCustomerRefundAction(
      undefined,
      formData({ partyId: "customer-1", paymentAccountId: "pay-1", amount: "6000", date: todayDateOnly() })
    );
    expect(result?.error).toMatch(/cannot exceed/i);
    expect(result?.error).toMatch(/5000/);
    expect(mocks.postCustomerRefund).not.toHaveBeenCalled();
  });

  it("allows a refund within the available customer credit", async () => {
    mocks.journalEntryAggregate.mockResolvedValue({ _sum: { debit: 1000, credit: 6000 } }); // 5000 credit
    const result = await createCustomerRefundAction(
      undefined,
      formData({ partyId: "customer-1", paymentAccountId: "pay-1", amount: "5000", date: todayDateOnly() })
    );
    expect(result).toEqual({ success: true, code: "REFUND/2026-27/0001" });
    expect(mocks.postCustomerRefund).toHaveBeenCalled();
  });
});

describe("adjustFinishedJewelleryStockAction", () => {
  it("rejects a reason under 5 characters at the schema layer, without posting", async () => {
    const result = await adjustFinishedJewelleryStockAction(
      undefined,
      formData({ finishedJewelleryId: "fj-1", direction: "OUT", reason: "x" })
    );
    expect(result?.error).toBeTruthy();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});

describe("getPhase5VsPhase6ComparisonAction — Owner-only, Staff receives nothing", () => {
  it("is Owner-only — Staff (requireOwner throws) never reaches the comparison engine", async () => {
    mocks.requireOwner.mockImplementation(() => {
      throw new Error("REDIRECT:/unauthorized");
    });
    await expect(getPhase5VsPhase6ComparisonAction("fj-1")).rejects.toThrow("REDIRECT:/unauthorized");
    expect(mocks.getPhase5VsPhase6Comparison).not.toHaveBeenCalled();
  });

  it("returns null without calling the engine when finishedJewelleryId is empty", async () => {
    const result = await getPhase5VsPhase6ComparisonAction("");
    expect(result).toBeNull();
    expect(mocks.getPhase5VsPhase6Comparison).not.toHaveBeenCalled();
  });

  it("serializes every Decimal field to a plain string for the Owner, and passes through null realized fields untouched", async () => {
    mocks.getPhase5VsPhase6Comparison.mockResolvedValue({
      finishedJewelleryId: "fj-1",
      finishedCode: "ZL-FJ-2026-000001",
      costSheetId: "cs-1",
      costingNumber: "CST/2026-27/0001",
      costSheetFinalizedAt: new Date("2026-06-20T00:00:00.000Z"),
      expectedSellingValue: { toFixed: () => "99600.00" },
      expectedFullBusinessCost: { toFixed: () => "83000.00" },
      expectedProfit: { toFixed: () => "16600.00" },
      expectedMarginPercent: { toFixed: () => "16.67" },
      authoritativeAccountingCost: { toFixed: () => "78000.00" },
      otherMaterialCostExcluded: { toFixed: () => "5000.00" },
      realizedStatus: "NOT_SOLD",
      saleCode: null,
      realizedNetSellingValue: null,
      realizedCogs: null,
      realizedGrossProfit: null,
      realizedMarginPercent: null,
      profitDifference: null,
      note: "This piece has not been sold yet — no realized figures to compare.",
    });
    const result = await getPhase5VsPhase6ComparisonAction("fj-1");
    expect(result).toEqual({
      finishedCode: "ZL-FJ-2026-000001",
      costingNumber: "CST/2026-27/0001",
      costSheetFinalizedAt: "2026-06-20T00:00:00.000Z",
      expectedSellingValue: "99600.00",
      expectedFullBusinessCost: "83000.00",
      expectedProfit: "16600.00",
      expectedMarginPercent: "16.67",
      authoritativeAccountingCost: "78000.00",
      otherMaterialCostExcluded: "5000.00",
      realizedStatus: "NOT_SOLD",
      saleCode: null,
      realizedNetSellingValue: null,
      realizedCogs: null,
      realizedGrossProfit: null,
      realizedMarginPercent: null,
      profitDifference: null,
      note: "This piece has not been sold yet — no realized figures to compare.",
    });
  });

  it("returns null when the engine finds no genuinely linked, finalized Costing", async () => {
    mocks.getPhase5VsPhase6Comparison.mockResolvedValue(null);
    const result = await getPhase5VsPhase6ComparisonAction("fj-1");
    expect(result).toBeNull();
  });
});
