/**
 * The business roots of the isolated test database. `TRUNCATE … CASCADE` from
 * these reaches only business tables — verified by walking the foreign-key
 * graph: users, accounts, purities, processes, GST rates, payment accounts,
 * settings and rate limits are never reached.
 */
export const BUSINESS_ROOT_TABLES = [
  "parties",
  "vouchers",
  "jewellery_jobs",
  "diamond_jobs",
  "rough_lots",
  "polished_packets",
  "polished_purchases",
  "packet_process_jobs",
  "metal_stock_movements",
  "cost_sheets",
  "corrections",
  "correction_batches",
  "finished_jewellery",
  "jewellery_receipts",
  // Other Material: items hang off users only, so they are a root of their own
  // (their purchase lines and movements cascade from here and from vouchers / jobs).
  "other_material_items",
] as const;

export const CLEAR_BUSINESS_DATA_SQL = `TRUNCATE TABLE ${BUSINESS_ROOT_TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`;
