import type { JewelleryType } from "@/generated/prisma/enums";

export const JEWELLERY_TYPES: { value: JewelleryType; label: string }[] = [
  { value: "RING", label: "Ring" },
  { value: "EARRINGS", label: "Earrings" },
  { value: "PENDANT", label: "Pendant" },
  { value: "NECKLACE", label: "Necklace" },
  { value: "BRACELET", label: "Bracelet" },
  { value: "BANGLE", label: "Bangle" },
  { value: "CHAIN", label: "Chain" },
  { value: "COUPLE_RING", label: "Couple Ring" },
  { value: "CUSTOM", label: "Custom Jewellery" },
];

const LABEL_BY_TYPE = new Map(JEWELLERY_TYPES.map((t) => [t.value, t.label]));

export function jewelleryTypeLabel(type: JewelleryType | string): string {
  return LABEL_BY_TYPE.get(type as JewelleryType) ?? type;
}

export const METAL_TYPES: { value: "GOLD" | "SILVER" | "PLATINUM" | "OTHER" | "ALLOY"; label: string }[] = [
  { value: "GOLD", label: "Gold" },
  { value: "SILVER", label: "Silver" },
  { value: "PLATINUM", label: "Platinum" },
  { value: "OTHER", label: "Other" },
  // Phase 7 — Company-owned copper/alloy stock (0% precious-metal fineness).
  { value: "ALLOY", label: "Copper/Alloy" },
];

const LABEL_BY_METAL_TYPE = new Map<string, string>(METAL_TYPES.map((m) => [m.value, m.label]));

export function metalTypeLabel(metalType: string): string {
  return LABEL_BY_METAL_TYPE.get(metalType) ?? metalType;
}
