import type { VoucherType } from "@/generated/prisma/enums";

/** What a person calls each voucher type — shared by every list, book and detail view. */
export const VOUCHER_TYPE_LABELS: Record<VoucherType, string> = {
  PURCHASE: "Purchase",
  SALE: "Sale",
  PAYMENT_GIVEN: "Payment Given",
  PAYMENT_RECEIVED: "Payment Received",
  EXPENSE: "Expense",
  OPENING: "Opening Balance",
  REVERSAL: "Reversal",
  DIAMOND_ISSUE: "Diamond Issue",
  DIAMOND_RECEIPT: "Diamond Receipt",
  JEWELLERY_ISSUE: "Jewellery Issue",
  JEWELLERY_RECEIPT: "Jewellery Receipt",
  SALE_RETURN: "Sale Return",
  CUSTOMER_REFUND: "Customer Refund",
  STOCK_ADJUSTMENT: "Stock Adjustment",
  OPENING_STOCK: "Opening Stock",
  CORRECTION: "Correction",
  CUSTOMER_JEWELLERY_BILL: "Customer Jewellery Bill",
  CUSTOMER_JEWELLERY_DELIVERY: "Customer Jewellery Delivery",
};
