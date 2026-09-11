import { z } from "zod";

const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");
const optionalString = (max: number) => z.string().trim().max(max).optional().or(z.literal(""));
/** Checkboxes in this codebase are sent as an explicit "true"/"false"
 * hidden-input string (never raw HTML checkbox presence/absence) — see
 * PartyEditForm's isActive field. z.coerce.boolean() is deliberately NOT
 * used here: it would coerce the literal string "false" to `true`. */
const booleanFlag = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

export const SHAPE_ENUM = z.enum([
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

export const roughPieceDraftSchema = z.object({
  carat: z.coerce.number().positive("Each piece's carat must be greater than zero."),
  lengthMm: z.coerce.number().nonnegative().optional(),
  widthMm: z.coerce.number().nonnegative().optional(),
  heightMm: z.coerce.number().nonnegative().optional(),
  colorEstimate: optionalString(100),
  clarityNote: optionalString(200),
  internalNote: optionalString(500),
  manualAllocatedCost: z.coerce.number().nonnegative().optional(),
  photoAssetId: optionalString(300),
});
export type RoughPieceDraftInput = z.infer<typeof roughPieceDraftSchema>;

export const roughPurchaseSchema = z.object({
  purchaseDate: DATE_ONLY,
  supplierId: z.string().trim().min(1, "Choose a supplier."),
  purchaseRate: z.coerce.number().nonnegative("Rate cannot be negative."),
  rateBasis: z.enum(["PER_CARAT", "FIXED_TOTAL"]),
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
  supplierInvoiceRef: optionalString(200),
  notes: optionalString(1000),
  photoAssetId: optionalString(300),
  idempotencyKey: z.string().trim().max(100).optional(),
  pieces: z.array(roughPieceDraftSchema).min(1, "Add at least one rough piece."),
});
export type RoughPurchaseInput = z.infer<typeof roughPurchaseSchema>;

export const issueRoughSchema = z
  .object({
    karigarId: z.string().trim().min(1, "Choose a Karigar."),
    roughPieceIds: z.array(z.string().trim().min(1)).min(1, "Select at least one rough piece."),
    requiredShape: SHAPE_ENUM,
    customShapeName: optionalString(200),
    customShapeReferencePhotoAssetId: optionalString(300),
    customShapeMeasurements: optionalString(500),
    customShapeInstruction: optionalString(1000),
    issueDate: DATE_ONLY,
    dueDate: DATE_ONLY.optional().or(z.literal("")),
    targetPolishedCarat: z.coerce.number().positive().optional(),
    targetLengthMm: z.coerce.number().nonnegative().optional(),
    targetWidthMm: z.coerce.number().nonnegative().optional(),
    targetHeightMm: z.coerce.number().nonnegative().optional(),
    notes: optionalString(1000),
    idempotencyKey: z.string().trim().max(100).optional(),
  })
  .refine((data) => data.requiredShape !== "CUSTOM" || !!data.customShapeName, {
    message: "Custom shape name is required when the shape is Custom.",
    path: ["customShapeName"],
  });
export type IssueRoughInput = z.infer<typeof issueRoughSchema>;

export const polishedOutputDraftSchema = z.object({
  shape: SHAPE_ENUM,
  carat: z.coerce.number().positive("Each output's carat must be greater than zero."),
  lengthMm: z.coerce.number().nonnegative().optional(),
  widthMm: z.coerce.number().nonnegative().optional(),
  heightMm: z.coerce.number().nonnegative().optional(),
  color: optionalString(50),
  clarity: optionalString(50),
  cutGrade: optionalString(50),
  polish: optionalString(50),
  symmetry: optionalString(50),
  fluorescence: optionalString(50),
  certificateStatus: z.enum(["NOT_CERTIFIED", "INTERNAL_GRADE", "CERTIFIED"]).default("NOT_CERTIFIED"),
  certLab: optionalString(100),
  certNumber: optionalString(100),
  certFileAssetId: optionalString(300),
  photoAssetId: optionalString(300),
});
export type PolishedOutputDraftInput = z.infer<typeof polishedOutputDraftSchema>;

export const receivePolishedSchema = z.object({
  jobId: z.string().trim().min(1),
  receiveDate: DATE_ONLY,
  returnedRoughCarat: z.coerce.number().min(0, "Returned carat cannot be negative.").default(0),
  labourCharge: z.coerce.number().min(0, "Labour charge cannot be negative.").default(0),
  shape: SHAPE_ENUM,
  notes: optionalString(1000),
  markJobComplete: booleanFlag,
  idempotencyKey: z.string().trim().max(100).optional(),
  outputs: z.array(polishedOutputDraftSchema).min(1, "Add at least one polished diamond."),
});
export type ReceivePolishedInput = z.infer<typeof receivePolishedSchema>;

export const cancelJobSchema = z.object({
  jobId: z.string().trim().min(1),
  cancellationReason: z.string().trim().min(3, "Give a short reason for cancelling.").max(300),
});

export const markJobInProgressSchema = z.object({
  jobId: z.string().trim().min(1),
});

export const recutPolishedSchema = z.object({
  polishedDiamondId: z.string().trim().min(1),
  reason: z.string().trim().min(3, "Give a short reason.").max(300),
});

const allocationAdjustmentSchema = z.object({
  key: z.string().trim().min(1),
  newAllocatedCost: z.coerce.number().min(0),
});

export const overrideRoughAllocationSchema = z.object({
  lotId: z.string().trim().min(1),
  reason: z.string().trim().min(3, "Give a short reason.").max(300),
  adjustments: z.array(allocationAdjustmentSchema).min(1),
});

export const overridePolishedAllocationSchema = z.object({
  receiptId: z.string().trim().min(1),
  reason: z.string().trim().min(3, "Give a short reason.").max(300),
  adjustments: z.array(allocationAdjustmentSchema).min(1),
});
