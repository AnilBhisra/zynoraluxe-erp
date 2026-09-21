import { describe, expect, it } from "vitest";

import { VoucherType } from "@/generated/prisma/enums";

import { canViewVoucher, isInternalCostingVoucherType, voucherVisibilityWhere } from "./voucherVisibility";

// Every voucher type, decided explicitly. A type added to the enum later makes
// the first test fail until someone decides whether Staff may see it.
const EXPECTED_STAFF_VISIBLE: Record<VoucherType, boolean | "follows reversed voucher"> = {
  PURCHASE: true,
  SALE: true,
  PAYMENT_GIVEN: true,
  PAYMENT_RECEIVED: true,
  EXPENSE: true,
  OPENING: true,
  SALE_RETURN: true,
  CUSTOMER_REFUND: true,
  REVERSAL: "follows reversed voucher",
  DIAMOND_ISSUE: false,
  DIAMOND_RECEIPT: false,
  JEWELLERY_ISSUE: false,
  JEWELLERY_RECEIPT: false,
  STOCK_ADJUSTMENT: false,
  // Phase 8 — both carry cost figures, so both stay Owner-only.
  OPENING_STOCK: false,
  CORRECTION: false,
};

type Where = Record<string, unknown>;
type Row = { voucherType: VoucherType; reversalOfVoucherType: VoucherType | null };

/** Evaluates the exact where shape voucherVisibilityWhere() produces against a row. */
function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "OR") return (value as Where[]).some((w) => matches(row, w));
    if (key === "voucherType") {
      if (typeof value === "string") return row.voucherType === value;
      return ((value as { in: VoucherType[] }).in).includes(row.voucherType);
    }
    if (key === "reversalOfVoucher") {
      const inner = (value as { is: Where }).is;
      return row.reversalOfVoucherType !== null && matches({ voucherType: row.reversalOfVoucherType, reversalOfVoucherType: null }, inner);
    }
    throw new Error(`unexpected where key ${key}`);
  });
}

const ALL_TYPES = Object.values(VoucherType);

describe("Staff voucher visibility", () => {
  it("has an explicit decision for every voucher type", () => {
    expect(Object.keys(EXPECTED_STAFF_VISIBLE).sort()).toEqual([...ALL_TYPES].sort());
  });

  it("hides internal costing vouchers from Staff and shows ordinary transactions", () => {
    for (const type of ALL_TYPES) {
      const expected = EXPECTED_STAFF_VISIBLE[type];
      if (expected === "follows reversed voucher") continue;
      expect([type, canViewVoucher("STAFF", { voucherType: type })]).toEqual([type, expected]);
      expect([type, isInternalCostingVoucherType(type)]).toEqual([type, !expected]);
    }
  });

  it("shows Staff a reversal only when the voucher it reverses is visible", () => {
    expect(canViewVoucher("STAFF", { voucherType: "REVERSAL", reversalOfVoucherType: "PURCHASE" })).toBe(true);
    expect(canViewVoucher("STAFF", { voucherType: "REVERSAL", reversalOfVoucherType: "SALE" })).toBe(true);
    expect(canViewVoucher("STAFF", { voucherType: "REVERSAL", reversalOfVoucherType: "DIAMOND_ISSUE" })).toBe(false);
    expect(canViewVoucher("STAFF", { voucherType: "REVERSAL", reversalOfVoucherType: "JEWELLERY_ISSUE" })).toBe(false);
    expect(canViewVoucher("STAFF", { voucherType: "REVERSAL", reversalOfVoucherType: null })).toBe(false);
  });

  it("lets the Owner see every voucher", () => {
    for (const type of ALL_TYPES) {
      expect(canViewVoucher("OWNER", { voucherType: type, reversalOfVoucherType: "DIAMOND_RECEIPT" })).toBe(true);
    }
    expect(voucherVisibilityWhere("OWNER")).toEqual({});
  });

  it("applies the same rule in the database filter as in canViewVoucher, for every type and reversal", () => {
    const rows: Row[] = [
      ...ALL_TYPES.filter((t) => t !== "REVERSAL").map((t) => ({ voucherType: t, reversalOfVoucherType: null })),
      ...ALL_TYPES.filter((t) => t !== "REVERSAL").map((t) => ({ voucherType: "REVERSAL" as const, reversalOfVoucherType: t })),
    ];
    const where = voucherVisibilityWhere("STAFF");
    for (const row of rows) {
      expect([row, matches(row, where)]).toEqual([row, canViewVoucher("STAFF", row)]);
    }
  });
});
