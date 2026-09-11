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
  // Phase 4 — Jewellery Jobs. Karigar labour AND added-material payable
  // again deliberately reuse ACCOUNTS_PAYABLE above (by partyId) rather
  // than a dedicated account, for the same reason as Phase 3.
  METAL_INVENTORY: "1300",
  SCRAP_METAL_INVENTORY: "1310",
  JEWELLERY_WIP: "1320",
  FINISHED_JEWELLERY_INVENTORY: "1330",
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
