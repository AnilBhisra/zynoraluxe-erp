import type { Prisma } from "@/generated/prisma/client";
import type { UserRole, VoucherType } from "@/generated/prisma/enums";

/**
 * Which vouchers a Staff user may see in Accounting.
 *
 * Staff record and settle ordinary transactions, so they see those. Vouchers
 * posted automatically by stock and job workflows (diamond and jewellery job
 * issues and receipts, packet stock adjustments) carry internal carrying cost
 * — WIP, packet and finished-piece cost — and stay Owner-only, as do reversals
 * of them. This is an allowlist: a voucher type added later is hidden from
 * Staff until it is deliberately listed here.
 */
export const STAFF_VISIBLE_VOUCHER_TYPES = [
  "PURCHASE",
  "SALE",
  "PAYMENT_GIVEN",
  "PAYMENT_RECEIVED",
  "EXPENSE",
  "OPENING",
  "SALE_RETURN",
  "CUSTOMER_REFUND",
] as const satisfies readonly VoucherType[];

const STAFF_VISIBLE = new Set<VoucherType>(STAFF_VISIBLE_VOUCHER_TYPES);

/** True for vouchers that only the Owner may see (internal costing entries). */
export function isInternalCostingVoucherType(type: VoucherType): boolean {
  return type !== "REVERSAL" && !STAFF_VISIBLE.has(type);
}

/** A REVERSAL is visible exactly when the voucher it reverses is. */
export function canViewVoucher(
  role: UserRole,
  voucher: { voucherType: VoucherType; reversalOfVoucherType?: VoucherType | null }
): boolean {
  if (role === "OWNER") return true;
  if (voucher.voucherType === "REVERSAL") {
    return voucher.reversalOfVoucherType != null && STAFF_VISIBLE.has(voucher.reversalOfVoucherType);
  }
  return STAFF_VISIBLE.has(voucher.voucherType);
}

/**
 * The same rule as a database filter, so hidden vouchers are never loaded for
 * Staff and never reach a page payload. Owner: no restriction.
 */
export function voucherVisibilityWhere(role: UserRole): Prisma.VoucherWhereInput {
  if (role === "OWNER") return {};
  return {
    OR: [
      { voucherType: { in: [...STAFF_VISIBLE_VOUCHER_TYPES] } },
      { voucherType: "REVERSAL", reversalOfVoucher: { is: { voucherType: { in: [...STAFF_VISIBLE_VOUCHER_TYPES] } } } },
    ],
  };
}
