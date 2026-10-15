/** Gold-source values and labels (no server imports — safe in Client Components). See jobGoldSource.ts. */
export const GOLD_SOURCES = ["CUSTOMER", "COMPANY", "MIXED", "NONE", "REVIEW"] as const;
export type GoldSource = (typeof GOLD_SOURCES)[number];

export const GOLD_SOURCE_LABELS: Record<GoldSource, string> = {
  CUSTOMER: "Customer Gold",
  COMPANY: "Company Gold",
  MIXED: "Mixed Gold",
  NONE: "No Gold / Not allocated yet",
  REVIEW: "Review required",
};

export function isGoldSource(value: string | null | undefined): value is GoldSource {
  return !!value && (GOLD_SOURCES as readonly string[]).includes(value);
}
