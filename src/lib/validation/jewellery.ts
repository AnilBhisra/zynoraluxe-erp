import { z } from "zod";

const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");
const optionalString = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
/** Checkboxes in this codebase are sent as an explicit "true"/"false"
 * hidden-input string — see PartyEditForm's isActive field / Phase 3's
 * markJobComplete. z.coerce.boolean() is deliberately NOT used: it would
 * coerce the literal string "false" to `true`. */
const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

export const METAL_TYPE_ENUM = z.enum(["GOLD", "SILVER", "PLATINUM", "OTHER", "ALLOY"]);
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

// ---------------------------------------------------------------------------
// Metal / Purity master (Owner-only)
// ---------------------------------------------------------------------------

export const metalPuritySchema = z
  .object({
    metalType: METAL_TYPE_ENUM,
    displayName: z.string().trim().min(1, "Enter a display name, e.g. 18K.").max(50),
    finenessPercent: z.coerce.number().min(0, "Fineness cannot be negative.").max(100, "Fineness cannot exceed 100%."),
  })
  .superRefine((data, ctx) => {
    // Copper/Alloy carries no precious metal, so it must never add fine
    // weight to a job; every other metal's purity must have some.
    if (data.metalType === "ALLOY" && data.finenessPercent !== 0) {
      ctx.addIssue({ code: "custom", path: ["finenessPercent"], message: "Copper/Alloy has no precious-metal fineness — enter 0." });
    }
    if (data.metalType !== "ALLOY" && data.finenessPercent <= 0) {
      ctx.addIssue({ code: "custom", path: ["finenessPercent"], message: "Fineness must be greater than zero." });
    }
  });
export type MetalPurityInput = z.infer<typeof metalPuritySchema>;

// ---------------------------------------------------------------------------
// Metal Purchase / Opening Stock / Adjustment
// ---------------------------------------------------------------------------

export const metalPurchaseSchema = z.object({
  purchaseDate: DATE_ONLY,
  supplierId: z.string().trim().min(1, "Choose a supplier."),
  metalType: METAL_TYPE_ENUM,
  purityId: z.string().trim().min(1, "Choose a purity."),
  grossWeight: z.coerce.number().positive("Gross weight must be greater than zero."),
  rateBasis: z.enum(["PER_GROSS_GRAM", "PER_FINE_GRAM", "FIXED_TOTAL"]),
  rate: z.coerce.number().nonnegative("Rate cannot be negative."),
  currencyCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code, e.g. INR.")
    .default("INR"),
  exchangeRate: z.coerce.number().positive("Exchange rate must be greater than zero.").default(1),
  totalPurchaseCost: z.coerce.number().positive("Total purchase cost must be greater than zero."),
  gstTreatment: z.enum(["NONE", "CGST_SGST", "IGST"]).default("NONE"),
  gstRateId: optionalString(100),
  gstRatePercent: z.coerce.number().min(0).max(100).optional(),
  paymentAccountId: optionalString(100),
  referenceNumber: optionalString(200),
  notes: optionalString(1000),
  idempotencyKey: z.string().trim().max(100).optional(),
});
export type MetalPurchaseInput = z.infer<typeof metalPurchaseSchema>;

export const openingMetalStockSchema = z.object({
  metalType: METAL_TYPE_ENUM,
  purityId: z.string().trim().min(1, "Choose a purity."),
  grossWeight: z.coerce.number().positive("Gross weight must be greater than zero."),
  costValue: z.coerce.number().min(0, "Cost cannot be negative."),
  note: optionalString(300),
});
export type OpeningMetalStockInput = z.infer<typeof openingMetalStockSchema>;

export const metalStockAdjustmentSchema = z.object({
  metalType: METAL_TYPE_ENUM,
  purityId: z.string().trim().min(1, "Choose a purity."),
  direction: z.enum(["IN", "OUT"]),
  grossWeight: z.coerce.number().positive("Adjustment weight must be greater than zero."),
  costValue: z.coerce.number().min(0, "Cost cannot be negative.").default(0),
  reason: z.string().trim().min(3, "Give a short reason.").max(300),
});
export type MetalStockAdjustmentInput = z.infer<typeof metalStockAdjustmentSchema>;

// ---------------------------------------------------------------------------
// Jewellery Job creation
// ---------------------------------------------------------------------------

export const createJewelleryJobSchema = z.object({
  customerId: optionalString(100),
  customerReference: optionalString(200),
  jewelleryType: JEWELLERY_TYPE_ENUM,
  designName: z.string().trim().min(1, "Enter a design name/title.").max(200),
  designImageAssetId: optionalString(300),
  karigarId: z.string().trim().min(1, "Choose a Karigar."),
  issueDate: DATE_ONLY,
  expectedDeliveryDate: DATE_ONLY.optional().or(z.literal("")),
  notes: optionalString(1000),
  jewellerySize: optionalString(50),
  quantity: z.coerce.number().int().min(1, "Quantity must be at least 1.").default(1),
  targetMetalType: METAL_TYPE_ENUM.optional(),
  targetPurityId: optionalString(100),
  targetFinishedWeight: z.coerce.number().positive().optional(),
  specialInstructions: optionalString(1000),
  idempotencyKey: z.string().trim().max(100).optional(),
});
export type CreateJewelleryJobInput = z.infer<typeof createJewelleryJobSchema>;

// ---------------------------------------------------------------------------
// Issue Materials
// ---------------------------------------------------------------------------

export const metalIssueLineSchema = z.object({
  metalType: METAL_TYPE_ENUM,
  purityId: z.string().trim().min(1, "Choose a purity."),
  grossWeight: z.coerce.number().positive("Each metal line's gross weight must be greater than zero."),
});

export const otherMaterialLineSchema = z.object({
  description: z.string().trim().min(1, "Enter a description.").max(200),
  quantity: z.coerce.number().positive("Quantity must be greater than zero.").default(1),
  unit: z.enum(["PCS", "CT", "GRAM", "OTHER"]).default("PCS"),
  weight: z.coerce.number().nonnegative().optional(),
  cost: z.coerce.number().min(0, "Cost cannot be negative."),
  note: optionalString(300),
});

/** Phase 7 — bulk polished stones taken from a packet, by pieces AND carat. */
export const packetIssueLineSchema = z.object({
  packetId: z.string().trim().min(1),
  pieces: z.coerce.number().int().min(1, "Each packet line needs at least one piece."),
  carat: z.coerce.number().positive("Each packet line's carat must be greater than zero."),
});

export const issueMaterialsSchema = z.object({
  jobId: z.string().trim().min(1),
  issueDate: DATE_ONLY,
  metalLines: z.array(metalIssueLineSchema).default([]),
  polishedDiamondIds: z.array(z.string().trim().min(1)).default([]),
  packetLines: z.array(packetIssueLineSchema).default([]),
  otherMaterialLines: z.array(otherMaterialLineSchema).default([]),
  idempotencyKey: z.string().trim().max(100).optional(),
});
export type IssueMaterialsInput = z.infer<typeof issueMaterialsSchema>;

// ---------------------------------------------------------------------------
// Receive Finished Jewellery
// ---------------------------------------------------------------------------

export const finishedOutputSchema = z.object({
  jewelleryType: JEWELLERY_TYPE_ENUM,
  description: optionalString(200),
  quantity: z.coerce.number().int().min(1).default(1),
  grossWeight: z.coerce.number().nonnegative().optional(),
  netMetalWeight: z.coerce.number().positive("Each output's net metal weight must be greater than zero."),
  metalType: METAL_TYPE_ENUM,
  purityId: z.string().trim().min(1, "Choose a purity for each output."),
  diamondIds: z.array(z.string().trim().min(1)).default([]),
  photoAssetId: optionalString(300),
  qcStatus: z.enum(["PASSED", "NEEDS_CORRECTION", "REJECTED"]).default("PASSED"),
  notes: optionalString(500),
});

export const diamondResolutionSchema = z.object({
  polishedDiamondId: z.string().trim().min(1),
  resolution: z.enum(["SET", "RETURNED", "DAMAGED_LOST"]),
  damagedLostReason: optionalString(300),
});

export const packetResolutionSchema = z.object({
  packetId: z.string().trim().min(1),
  resolution: z.enum(["SET", "RETURNED", "DAMAGED_LOST"]),
  pieces: z.coerce.number().int().min(0, "Pieces cannot be negative."),
  carat: z.coerce.number().min(0, "Carat cannot be negative."),
  setInOutputIndex: z.coerce.number().int().min(0).optional(),
  damagedLostReason: optionalString(300),
});

export const metalReturnScrapLineSchema = z.object({
  purityId: z.string().trim().min(1, "Choose a purity for each return/scrap line."),
  grossWeight: z.coerce.number().positive("Each return/scrap line's weight must be greater than zero."),
});

export const receiveFinishedJewellerySchema = z.object({
  jobId: z.string().trim().min(1),
  receiveDate: DATE_ONLY,
  outputs: z.array(finishedOutputSchema).default([]),
  diamondResolutions: z.array(diamondResolutionSchema).default([]),
  packetResolutions: z.array(packetResolutionSchema).default([]),
  returnedMetalLines: z.array(metalReturnScrapLineSchema).default([]),
  scrapMetalLines: z.array(metalReturnScrapLineSchema).default([]),
  karigarAddedFineWeight: z.coerce.number().min(0).default(0),
  karigarAddedCost: z.coerce.number().min(0).default(0),
  // Phase 7 — how the outputs' Alloy Added was sourced (must total the
  // computed alloy exactly; the server recomputes and enforces it).
  companyAlloyGrossWeight: z.coerce.number().min(0, "Alloy weight cannot be negative.").default(0),
  karigarAlloyGrossWeight: z.coerce.number().min(0, "Alloy weight cannot be negative.").default(0),
  karigarAlloyCost: z.coerce.number().min(0, "Alloy charge cannot be negative.").default(0),
  includedAlloyGrossWeight: z.coerce.number().min(0, "Alloy weight cannot be negative.").default(0),
  labourCharge: z.coerce.number().min(0).default(0),
  makingCharge: z.coerce.number().min(0).default(0),
  settingCharge: z.coerce.number().min(0).default(0),
  platingCharge: z.coerce.number().min(0).default(0),
  otherExpense: z.coerce.number().min(0).default(0),
  markJobComplete: booleanFlag,
  isAbnormalLoss: booleanFlag,
  abnormalLossReason: optionalString(300),
  notes: optionalString(1000),
  idempotencyKey: z.string().trim().max(100).optional(),
});
export type ReceiveFinishedJewelleryInput = z.infer<typeof receiveFinishedJewellerySchema>;

// ---------------------------------------------------------------------------
// Job status / cancellation
// ---------------------------------------------------------------------------

export const cancelJewelleryJobSchema = z.object({
  jobId: z.string().trim().min(1),
  cancellationReason: z.string().trim().min(3, "Give a short reason for cancelling.").max(300),
});

export const markJobInProgressSchema = z.object({
  jobId: z.string().trim().min(1),
});

export const needsCorrectionSchema = z.object({
  jobId: z.string().trim().min(1),
  flag: booleanFlag,
});

// ---------------------------------------------------------------------------
// Owner-authorized cost allocation override
// ---------------------------------------------------------------------------

export const overrideFinishedAllocationSchema = z.object({
  receiptId: z.string().trim().min(1),
  reason: z.string().trim().min(3, "Give a short reason.").max(300),
  adjustments: z
    .array(z.object({ finishedJewelleryId: z.string().trim().min(1), newTotalCost: z.coerce.number().min(0) }))
    .min(1),
});
