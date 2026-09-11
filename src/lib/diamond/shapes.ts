import type { DiamondShape } from "@/generated/prisma/enums";

/** Standard shape choices from the master plan. CUSTOM requires the extra
 * custom-shape fields (name, optional reference photo/measurements/
 * instruction) — enforced in src/lib/validation/diamond.ts. */
export const STANDARD_SHAPES: { value: DiamondShape; label: string }[] = [
  { value: "ROUND", label: "Round" },
  { value: "OVAL", label: "Oval" },
  { value: "PEAR", label: "Pear" },
  { value: "EMERALD", label: "Emerald" },
  { value: "CUSHION", label: "Cushion" },
  { value: "ELONGATED_CUSHION", label: "Elongated Cushion" },
  { value: "RADIANT", label: "Radiant" },
  { value: "PRINCESS", label: "Princess" },
  { value: "MARQUISE", label: "Marquise" },
  { value: "ASSCHER", label: "Asscher" },
  { value: "CUSTOM", label: "Custom Shape" },
];

const LABEL_BY_SHAPE = new Map(STANDARD_SHAPES.map((s) => [s.value, s.label]));

export function shapeLabel(shape: DiamondShape): string {
  return LABEL_BY_SHAPE.get(shape) ?? shape;
}
