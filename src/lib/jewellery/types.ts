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

export const METAL_TYPES: { value: "GOLD" | "SILVER" | "PLATINUM" | "OTHER"; label: string }[] = [
  { value: "GOLD", label: "Gold" },
  { value: "SILVER", label: "Silver" },
  { value: "PLATINUM", label: "Platinum" },
  { value: "OTHER", label: "Other" },
];
