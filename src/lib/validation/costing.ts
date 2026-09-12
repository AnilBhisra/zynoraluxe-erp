import { z } from "zod";

const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");
const optionalString = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

export const JEWELLERY_TYPE_ENUM = z.enum([
  "RING",
  "EARRINGS",
  "PENDANT",
  "NECKLACE",
  "BRACELET",
  "BANGLE",
  "CHAIN",
  "COUPLE_RING",
  "CUSTOM",
]);
export const METAL_TYPE_ENUM = z.enum(["GOLD", "SILVER", "PLATINUM", "OTHER"]);
export const METAL_RATE_BASIS_ENUM = z.enum(["PER_GROSS_GRAM", "PER_FINE_GRAM", "FIXED_TOTAL"]);
export const DIAMOND_SHAPE_ENUM = z.enum([
  "ROUND",
  "OVAL",
  "PEAR",
  "EMERALD",
  "CUSHION",
  "ELONGATED_CUSHION",
  "RADIANT",
  "PRINCESS",
  "MARQUISE",
  "ASSCHER",
  "CUSTOM",
]);
export const OTHER_MATERIAL_CATEGORY_ENUM = z.enum([
  "MOISSANITE",
  "COLOURED_STONE",
  "SMALL_STONE",
  "FINDINGS",
  "ALLOY",
  "ENAMEL",
  "PLATING",
  "PACKAGING",
  "OTHER",
]);
export const CHARGE_METHOD_ENUM = z.enum(["FLAT", "PER_GRAM", "PER_CARAT", "PER_PIECE", "PERCENT_OF_MATERIAL_COST"]);
export const PRICING_METHOD_ENUM = z.enum(["MARKUP_ON_COST", "MARGIN_ON_PRICE"]);
export const DISCOUNT_TYPE_ENUM = z.enum(["NONE", "PERCENT", "FIXED"]);
export const GST_TREATMENT_ENUM = z.enum(["NONE", "CGST_SGST", "IGST"]);
export const TAX_TYPE_ENUM = z.enum(["EXCLUSIVE", "INCLUSIVE"]);

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export const estimateMetalLineSchema = z.object({
  metalType: METAL_TYPE_ENUM,
  purityId: z.string().trim().min(1, "Choose a purity."),
  grossWeight: z.coerce.number().positive("Each metal line's gross weight must be greater than zero."),
  wastagePercent: z.coerce.number().min(0).max(100).optional(),
  wastageWeight: z.coerce.number().min(0).optional(),
  rateBasis: METAL_RATE_BASIS_ENUM,
  rate: z.coerce.number().min(0, "Rate cannot be negative."),
});

export const estimateDiamondLineSchema = z.object({
  diamondType: optionalString(100),
  shape: DIAMOND_SHAPE_ENUM,
  customShapeName: optionalString(100),
  quantity: z.coerce.number().int().min(1).default(1),
  totalCarat: z.coerce.number().positive("Total carat must be greater than zero."),
  ratePerCarat: z.coerce.number().min(0).optional(),
  fixedAmount: z.coerce.number().min(0).optional(),
  certificateCharge: z.coerce.number().min(0).default(0),
  notes: optionalString(300),
});

export const estimateOtherMaterialLineSchema = z.object({
  category: OTHER_MATERIAL_CATEGORY_ENUM,
  description: z.string().trim().min(1, "Enter a description.").max(200),
  quantity: z.coerce.number().min(0).optional(),
  weight: z.coerce.number().min(0).optional(),
  rate: z.coerce.number().min(0).optional(),
  manualAmount: z.coerce.number().min(0).optional(),
});

export const estimateChargeLineSchema = z.object({
  label: z.string().trim().min(1, "Enter a label.").max(100),
  isLabour: z.boolean().default(false),
  method: CHARGE_METHOD_ENUM,
  rate: z.coerce.number().min(0, "Rate cannot be negative."),
});

// ---------------------------------------------------------------------------
// Pricing / GST (shared by Actual + Estimate)
// ---------------------------------------------------------------------------

export const pricingSchema = z.object({
  pricingMethod: PRICING_METHOD_ENUM.default("MARKUP_ON_COST"),
  markupPercent: z.coerce.number().min(0).default(0),
  targetMarginPercent: z.coerce.number().min(0).max(99.999, "Target margin must be less than 100%.").default(0),
  manualSellingPriceOverride: z.coerce.number().min(0).optional(),
  discountType: DISCOUNT_TYPE_ENUM.default("NONE"),
  discountValue: z.coerce.number().min(0).default(0),
  gstTreatment: GST_TREATMENT_ENUM.default("NONE"),
  gstRateId: optionalString(100),
  priceType: TAX_TYPE_ENUM.default("EXCLUSIVE"),
  roundingStep: z.coerce.number().min(0).default(0),
  sellingExpenseFixed: z.coerce.number().min(0).default(0),
  sellingExpensePercent: z.coerce.number().min(0).max(100).default(0),
  quotationTerms: optionalString(2000),
});

// ---------------------------------------------------------------------------
// Actual costing
// ---------------------------------------------------------------------------

export const createActualCostingSchema = pricingSchema.extend({
  sourceFinishedJewelleryId: z.string().trim().min(1, "Choose a finished jewellery output."),
  costingDate: DATE_ONLY,
  quantity: z.coerce.number().int().min(1).optional(),
  sizeOrLength: optionalString(50),
  customerId: optionalString(100),
  notes: optionalString(1000),
  idempotencyKey: z.string().trim().max(100).optional(),
});
export type CreateActualCostingInput = z.infer<typeof createActualCostingSchema>;

export const updateActualCostingSchema = pricingSchema.extend({
  costSheetId: z.string().trim().min(1),
  costingDate: DATE_ONLY,
  quantity: z.coerce.number().int().min(1),
  sizeOrLength: optionalString(50),
  customerId: optionalString(100),
  notes: optionalString(1000),
  linkedEstimateId: optionalString(100),
});

export const refreshActualCostingSchema = z.object({ costSheetId: z.string().trim().min(1) });

// ---------------------------------------------------------------------------
// Estimate costing
// ---------------------------------------------------------------------------

export const estimateSheetSchema = pricingSchema.extend({
  costingDate: DATE_ONLY,
  jewelleryType: JEWELLERY_TYPE_ENUM,
  itemName: z.string().trim().min(1, "Enter an item name.").max(200),
  referenceNumber: optionalString(200),
  quantity: z.coerce.number().int().min(1).default(1),
  sizeOrLength: optionalString(50),
  designImageAssetId: optionalString(300),
  customerId: optionalString(100),
  notes: optionalString(1000),
  linkedEstimateId: optionalString(100),
  metalLines: z.array(estimateMetalLineSchema).default([]),
  diamondLines: z.array(estimateDiamondLineSchema).default([]),
  otherMaterialLines: z.array(estimateOtherMaterialLineSchema).default([]),
  chargeLines: z.array(estimateChargeLineSchema).default([]),
  idempotencyKey: z.string().trim().max(100).optional(),
});
export type EstimateSheetInput = z.infer<typeof estimateSheetSchema>;

export const updateEstimateSheetSchema = estimateSheetSchema.extend({
  costSheetId: z.string().trim().min(1),
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const costSheetIdSchema = z.object({ costSheetId: z.string().trim().min(1) });

// ---------------------------------------------------------------------------
// Costing Settings (Owner-only)
// ---------------------------------------------------------------------------

export const costingSettingsSchema = z.object({
  defaultPricingMethod: PRICING_METHOD_ENUM.default("MARKUP_ON_COST"),
  defaultMarkupPercent: z.coerce.number().min(0).default(0),
  defaultTargetMarginPercent: z.coerce.number().min(0).max(99.999).default(0),
  defaultDiscountType: DISCOUNT_TYPE_ENUM.default("NONE"),
  defaultDiscountValue: z.coerce.number().min(0).default(0),
  defaultGstTreatment: GST_TREATMENT_ENUM.default("NONE"),
  defaultGstRateId: optionalString(100),
  defaultPriceType: TAX_TYPE_ENUM.default("EXCLUSIVE"),
  defaultValidityDays: z.coerce.number().int().min(0).max(365).default(15),
  defaultRoundingStep: z.coerce.number().min(0).default(0),
  defaultSellingExpenseFixed: z.coerce.number().min(0).default(0),
  defaultSellingExpensePercent: z.coerce.number().min(0).max(100).default(0),
  quotationTerms: optionalString(2000),
});
export type CostingSettingsInput = z.infer<typeof costingSettingsSchema>;

export { booleanFlag };
