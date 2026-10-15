/** Customer Account → Finished Jewellery: row shape, filters and labels (no server imports — safe in Client Components). */

export type CustomerPieceRow = {
  id: string;
  finishedCode: string;
  jobId: string;
  jobCode: string;
  receiptId: string;
  receiptCode: string;
  description: string;
  grossWeight: string | null;
  netWeight: string;
  fineWeight: string;
  customerGoldFine: string;
  purity: string;
  ownership: "CUSTOMER" | "COMPANY" | "MIXED";
  billing: "UNBILLED" | "BILLED" | "BILL_REVERSED" | "NOT_APPLICABLE";
  bill: { code: string; date: string; kind: "BILL" | "SALE" } | null;
  delivery: "READY" | "DELIVERED" | "DELIVERY_REVERSED" | "RECEIPT_REVERSED" | "NOT_APPLICABLE";
  deliveryRef: { code: string; date: string } | null;
  location: "FINISHED_STOCK" | "DELIVERED" | "SOLD" | "RETURNED_DAMAGED" | "RECEIPT_REVERSED";
  canCreateBill: boolean;
};

export type CustomerPieceSummary = { readyUndelivered: number; unbilled: number; billedUndelivered: number; delivered: number };

export const CUSTOMER_PIECE_FILTERS = ["ALL", "READY_FOR_BILLING", "UNBILLED", "BILLED", "READY_FOR_DELIVERY", "DELIVERED", "RECEIPT_REVERSED"] as const;
export type CustomerPieceFilter = (typeof CUSTOMER_PIECE_FILTERS)[number];

export const CUSTOMER_PIECE_FILTER_LABELS: Record<CustomerPieceFilter, string> = {
  ALL: "All",
  READY_FOR_BILLING: "Ready for billing",
  UNBILLED: "Unbilled",
  BILLED: "Billed",
  READY_FOR_DELIVERY: "Ready for delivery",
  DELIVERED: "Delivered",
  RECEIPT_REVERSED: "Receipt reversed",
};

export function isCustomerPieceFilter(v: string | null | undefined): v is CustomerPieceFilter {
  return !!v && (CUSTOMER_PIECE_FILTERS as readonly string[]).includes(v);
}

export function matchesPieceFilter(r: CustomerPieceRow, f: CustomerPieceFilter): boolean {
  switch (f) {
    case "ALL":
      return true;
    case "READY_FOR_BILLING":
      return r.canCreateBill && r.location === "FINISHED_STOCK";
    case "UNBILLED":
      return r.billing === "UNBILLED" || r.billing === "BILL_REVERSED";
    case "BILLED":
      return r.billing === "BILLED";
    case "READY_FOR_DELIVERY":
      return r.delivery === "READY" || r.delivery === "DELIVERY_REVERSED";
    case "DELIVERED":
      return r.delivery === "DELIVERED";
    case "RECEIPT_REVERSED":
      return r.location === "RECEIPT_REVERSED";
  }
}

export const OWNERSHIP_LABELS: Record<CustomerPieceRow["ownership"], string> = { CUSTOMER: "Customer-owned Gold", COMPANY: "Company Gold", MIXED: "Mixed" };
export const BILLING_LABELS: Record<CustomerPieceRow["billing"], string> = { UNBILLED: "Unbilled", BILLED: "Billed", BILL_REVERSED: "Bill reversed", NOT_APPLICABLE: "—" };
export const DELIVERY_LABELS: Record<CustomerPieceRow["delivery"], string> = {
  READY: "Ready for delivery",
  DELIVERED: "Delivered",
  DELIVERY_REVERSED: "Delivery reversed — ready again",
  RECEIPT_REVERSED: "Receipt reversed",
  NOT_APPLICABLE: "—",
};
export const LOCATION_LABELS: Record<CustomerPieceRow["location"], string> = {
  FINISHED_STOCK: "Finished stock",
  DELIVERED: "Delivered",
  SOLD: "Sold",
  RETURNED_DAMAGED: "Returned (damaged)",
  RECEIPT_REVERSED: "Receipt reversed",
};
