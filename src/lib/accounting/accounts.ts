/**
 * Fixed Chart-of-Accounts codes the posting engine depends on. Seeded
 * idempotently in prisma/seed.ts. These accounts are `isSystem: true` and
 * are never exposed for deletion — see src/app/actions/accounting.ts.
 */
export const SYSTEM_ACCOUNT_CODES = {
  ACCOUNTS_RECEIVABLE: "1100",
  ACCOUNTS_PAYABLE: "2000",
  OPENING_BALANCE_EQUITY: "3000",
  SALES_INCOME: "4000",
  PURCHASES: "5000",
  BUSINESS_EXPENSES: "5100",
  INPUT_CGST: "6001",
  INPUT_SGST: "6002",
  INPUT_IGST: "6003",
  OUTPUT_CGST: "7001",
  OUTPUT_SGST: "7002",
  OUTPUT_IGST: "7003",
  ROUND_OFF: "8000",
  // Phase 3 — Diamond Manufacturing. Karigar labour payable deliberately
  // reuses ACCOUNTS_PAYABLE above (by partyId) rather than a dedicated
  // account, so the existing Payment Given flow already settles it.
  ROUGH_DIAMOND_INVENTORY: "1200",
  DIAMOND_WIP: "1210",
  POLISHED_DIAMOND_INVENTORY: "1220",
  // Purchased Other Material (moissanite, findings, enamel …) in stock — JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §12.
  OTHER_MATERIAL_INVENTORY: "1230",
  // Phase 4 — Jewellery Jobs. Karigar labour AND added-material payable
  // again deliberately reuse ACCOUNTS_PAYABLE above (by partyId) rather
  // than a dedicated account, for the same reason as Phase 3.
  METAL_INVENTORY: "1300",
  SCRAP_METAL_INVENTORY: "1310",
  JEWELLERY_WIP: "1320",
  FINISHED_JEWELLERY_INVENTORY: "1330",
  // Customer Gold — the Company's OWN cost (diamonds, charges, Company
  // materials) in Customer-owned pieces awaiting delivery. Customer-owned gold
  // itself never has Company value. Moved to COGS when the piece is delivered.
  CUSTOMER_JEWELLERY_WIP: "1340",
  // Phase 6 — Finished Jewellery Sales, Stock, COGS and Actual P&L.
  // SALES_RETURNS is a contra-revenue account (INCOME type, but always
  // presented in P&L as a deduction from Gross Sales — see
  // getFinishedJewelleryProfitAndLoss). FINISHED_JEWELLERY_COGS is the
  // authoritative accounting cost of goods sold, moved from
  // FINISHED_JEWELLERY_INVENTORY at sale time. DAMAGED_JEWELLERY_LOSS
  // exists so a damaged/not-for-resale return's cost is reclassified OUT
  // of COGS (the item never really "sold" in the end) into its own
  // clearly-labelled loss line, so Gross Profit isn't misleadingly
  // depressed by a damage write-off that isn't really cost-of-GOODS-SOLD.
  // Phase 7 — brokerage owed to a Dalal/Broker that is NOT part of the
  // stones landed cost. When brokerage IS capitalised it goes into
  // POLISHED_DIAMOND_INVENTORY instead, never both (no double posting).
  BROKERAGE_EXPENSE: "5400",
  SALES_RETURNS: "4100",
  FINISHED_JEWELLERY_COGS: "5200",
  // Diamond-only Sale: carrying cost of polished stones / packet stones sold loose.
  POLISHED_DIAMOND_COGS: "5210",
  DAMAGED_JEWELLERY_LOSS: "5300",
  // Phase 8 — an Owner-authorized stock adjustment is this period's gain or
  // loss, never opening capital, so it must NOT post to OPENING_BALANCE_EQUITY
  // (which stays reserved for opening balances and opening-stock corrections).
  INVENTORY_ADJUSTMENT_GAIN: "4200",
  INVENTORY_ADJUSTMENT_LOSS: "5500",
  // Clearing settlement (CLEARING_SETTLEMENT_DESIGN.md). A marketplace /
  // provider sale debits 1150 instead of 1100; its reserve sits in 1160. The
  // others are the default accounts for settlement lines (Owner-editable
  // mapping, clearing_account_mappings) — CA to confirm.
  MARKETPLACE_CLEARING: "1150",
  MARKETPLACE_RESERVE: "1160",
  TAX_WITHHELD_RECEIVABLE: "1170",
  SETTLEMENT_SUSPENSE: "1180",
  FX_GAIN: "4300",
  MARKETPLACE_FEES: "5600",
  ADVERTISING: "5610",
  PROCESSING_FEES: "5620",
  SHIPPING_CHARGES: "5630",
  SUBSCRIPTION_FEES: "5640",
  FX_LOSS: "5650",
} as const;

/**
 * Default payment accounts seeded so the app is usable immediately after
 * setup. Owner can add more Bank/UPI accounts from Accounting settings.
 */
export const DEFAULT_PAYMENT_ACCOUNTS = [
  { code: "1001", name: "Cash", method: "CASH" as const },
  { code: "1002", name: "Bank", method: "BANK" as const },
  { code: "1003", name: "UPI", method: "UPI" as const },
] as const;
