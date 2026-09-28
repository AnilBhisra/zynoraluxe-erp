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

export const CHARGE_RATE_BASIS_ENUM = z.enum(["FIXED", "PER_CARAT", "PER_PIECE"]);

export const roughPieceDraftSchema = z.object({
  // STONE = one individual stone (always issued whole); PARCEL = many stones
  // bought as one row, which can later be issued in part by carat.
  kind: z.enum(["STONE", "PARCEL"]).default("STONE"),
  pieceCount: z.coerce.number().int("The number of stones must be a whole number.").positive("The number of stones must be at least 1.").optional(),
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
    // Whole rows (individual stones, or a parcel issued in full).
    roughPieceIds: z.array(z.string().trim().min(1)).default([]),
    // Parcels issued by carat. The carat stays a string so the server can
    // refuse more than 3 decimals instead of a float silently rounding it.
    parcelIssues: z
      .array(
        z.object({
          roughPieceId: z.string().trim().min(1),
          carat: z.string().trim().min(1, "Enter the carat to issue from each parcel."),
          pieceCount: z.coerce.number().int("The number of stones must be a whole number.").positive("The number of stones must be at least 1.").optional(),
        })
      )
      .default([]),
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
    // Phase 7 — Manufacturer process and agreed charge rate (all optional).
    processId: optionalString(100),
    chargeRateBasis: CHARGE_RATE_BASIS_ENUM.optional(),
    chargeRate: z.coerce.number().min(0, "The charge rate cannot be negative.").optional(),
    idempotencyKey: z.string().trim().max(100).optional(),
  })
  .refine((data) => data.roughPieceIds.length + data.parcelIssues.length > 0, {
    message: "Select at least one rough piece.",
    path: ["roughPieceIds"],
  })
  .refine((data) => data.requiredShape !== "CUSTOM" || !!data.customShapeName, {
    message: "Custom shape name is required when the shape is Custom.",
    path: ["customShapeName"],
  });
export type IssueRoughInput = z.infer<typeof issueRoughSchema>;

export const polishedOutputDraftSchema = z.object({
  // A single stone (always issued whole) or a parcel of many stones (issued
  // in part through the packet ledger). The server enforces the rules that
  // tie the two together: a stone count only on a parcel, at least 2, and no
  // certificate on a parcel.
  kind: z.enum(["STONE", "PARCEL"]).default("STONE"),
  pieceCount: z.coerce.number().int("The number of stones must be a whole number.").positive("The number of stones must be at least 1.").optional(),
  sizeLabel: optionalString(100),
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

export const convertPolishedToParcelSchema = z.object({
  polishedDiamondId: z.string().trim().min(1),
  pieceCount: z.coerce.number().int("The number of stones must be a whole number.").min(2, "A parcel holds at least 2 stones."),
  sizeLabel: optionalString(100),
  reason: z.string().trim().min(10, "Say why this record is a parcel (at least 10 characters) — it is kept in the audit trail.").max(500),
});

export const convertRoughStoneToParcelSchema = z.object({
  roughPieceId: z.string().trim().min(1),
  // Optional, like a parcel purchase: blank = stones not counted.
  pieceCount: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().int("The number of stones must be a whole number.").min(2, "A parcel holds at least 2 stones — leave it blank if they were not counted.").optional()
  ),
  reason: z.string().trim().min(10, "Say why this stone is really a parcel (at least 10 characters) — it is kept in the audit trail.").max(500),
  expectedCarat: z.string().trim().min(1, "Preview the conversion first."),
  expectedCost: z.string().trim().min(1, "Preview the conversion first."),
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

// ---------------------------------------------------------------------------
// Phase 7 — direct Polished Diamond Purchase (Party / Supplier + Dalal / Broker)
// ---------------------------------------------------------------------------

export const polishedPurchaseLineSchema = z.object({
  shape: SHAPE_ENUM,
  customShapeName: optionalString(100),
  sizeLabel: z.string().trim().min(1, "Enter the size (e.g. 1.00-1.20 MM or +2).").max(100),
  measurements: optionalString(100),
  pieces: z.coerce.number().int().min(1, "Each packet line needs at least one piece."),
  carat: z.coerce.number().positive("Each line's carat must be greater than zero."),
  quality: optionalString(100),
  colour: optionalString(100),
  lab: optionalString(100),
  certificateStatus: z.enum(["NOT_CERTIFIED", "INTERNAL_GRADE", "CERTIFIED"]).default("NOT_CERTIFIED"),
  certNumber: optionalString(100),
  certFileAssetId: optionalString(300),
  photoAssetId: optionalString(300),
  rateBasis: z.enum(["PER_CARAT", "PER_PIECE", "FIXED_TOTAL"]),
  rate: z.coerce.number().min(0, "Rate cannot be negative."),
  manualLandedCost: z.coerce.number().min(0).optional(),
  notes: optionalString(500),
});
export type PolishedPurchaseLineDraft = z.infer<typeof polishedPurchaseLineSchema>;

export const polishedPurchaseSchema = z
  .object({
    purchaseDate: DATE_ONLY,
    supplierId: z.string().trim().min(1, "Choose a Party / Supplier."),
    currencyCode: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code, e.g. INR.")
      .default("INR"),
    exchangeRate: z.coerce.number().positive("Exchange rate must be greater than zero.").default(1),
    supplierAmount: z.coerce.number().positive("The supplier's amount must be greater than zero."),
    gstTreatment: z.enum(["NONE", "CGST_SGST", "IGST"]).default("NONE"),
    gstRateId: optionalString(100),
    gstRatePercent: z.coerce.number().min(0).max(100).optional(),
    brokerPartyId: optionalString(100),
    brokerageMethod: z.enum(["PER_CARAT", "PERCENT", "FIXED"]).optional(),
    brokerageRate: z.coerce.number().min(0).optional(),
    brokerageTreatment: z
      .enum(["NONE", "INCLUDED_IN_SUPPLIER_COST", "CAPITALISED_PAYABLE_TO_BROKER", "EXPENSED_PAYABLE_TO_BROKER"])
      .default("NONE"),
    paymentAccountId: optionalString(100),
    referenceNumber: optionalString(200),
    notes: optionalString(1000),
    idempotencyKey: z.string().trim().max(100).optional(),
    lines: z.array(polishedPurchaseLineSchema).min(1, "Add at least one packet line."),
  })
  .superRefine((value, ctx) => {
    if (value.brokerageTreatment !== "NONE") {
      if (!value.brokerPartyId) {
        ctx.addIssue({ code: "custom", path: ["brokerPartyId"], message: "Choose the Dalal / Broker." });
      }
      if (!value.brokerageMethod) {
        ctx.addIssue({ code: "custom", path: ["brokerageMethod"], message: "Choose how the brokerage is calculated." });
      }
      if (value.brokerageRate === undefined) {
        ctx.addIssue({ code: "custom", path: ["brokerageRate"], message: "Enter the brokerage rate or amount." });
      }
    }
  });
export type PolishedPurchaseFormInput = z.infer<typeof polishedPurchaseSchema>;

export const cancelPolishedPurchaseSchema = z.object({
  purchaseId: z.string().trim().min(1),
  cancellationReason: z.string().trim().min(3, "Give a short reason for cancelling.").max(300),
});

// ---------------------------------------------------------------------------
// Phase 7 — Manufacturer processes and Job Manufacturer
// ---------------------------------------------------------------------------

export const diamondProcessSchema = z.object({
  processId: optionalString(100),
  name: z.string().trim().min(2, "Give the process a name.").max(60),
  outputKind: z.enum(["ROUGH", "POLISHED"]),
  defaultRateBasis: CHARGE_RATE_BASIS_ENUM.default("PER_CARAT"),
  isActive: booleanFlag,
});

export const processedRoughPieceSchema = z.object({
  carat: z.coerce.number().positive("Each processed piece's carat must be greater than zero."),
  colorEstimate: optionalString(100),
  clarityNote: optionalString(200),
  internalNote: optionalString(500),
});

export const receiveProcessedRoughSchema = z.object({
  jobId: z.string().trim().min(1),
  receiveDate: DATE_ONLY,
  manualCharge: z.coerce.number().min(0, "The charge cannot be negative.").default(0),
  notes: optionalString(1000),
  markJobComplete: booleanFlag,
  idempotencyKey: z.string().trim().max(100).optional(),
  pieces: z.array(processedRoughPieceSchema).min(1, "Add at least one processed rough piece."),
});

export const packetProcessIssueSchema = z.object({
  manufacturerId: z.string().trim().min(1, "Choose the Manufacturer."),
  processId: z.string().trim().min(1, "Choose the process."),
  issueDate: DATE_ONLY,
  dueDate: DATE_ONLY.optional().or(z.literal("")),
  chargeRateBasis: CHARGE_RATE_BASIS_ENUM,
  chargeRate: z.coerce.number().min(0, "The charge rate cannot be negative.").default(0),
  notes: optionalString(1000),
  idempotencyKey: z.string().trim().max(100).optional(),
  lines: z
    .array(
      z.object({
        packetId: z.string().trim().min(1),
        pieces: z.coerce.number().int().min(1, "Each packet line needs at least one piece."),
        carat: z.coerce.number().positive("Each packet line's carat must be greater than zero."),
      })
    )
    .min(1, "Issue at least one packet."),
});

export const packetProcessReturnSchema = z.object({
  jobId: z.string().trim().min(1),
  receiveDate: DATE_ONLY,
  markJobComplete: booleanFlag,
  /** Lines whose closure (with any carat gap as line-level loss) is explicitly confirmed. */
  closeLineIds: z.array(z.string().trim().min(1)).default([]),
  isAbnormalLoss: booleanFlag,
  abnormalLossReason: optionalString(300),
  notes: optionalString(1000),
  idempotencyKey: z.string().trim().max(100).optional(),
  rows: z
    .array(
      z.object({
        jobLineId: z.string().trim().min(1),
        disposition: z.enum(["RETURNED_TO_STOCK", "USED_IN_JEWELLERY_JOB", "DAMAGED_LOST"]),
        pieces: z.coerce.number().int().min(1, "Each return line needs at least one piece."),
        carat: z.coerce.number().positive("Each return line's carat must be greater than zero."),
        sizeLabel: optionalString(100),
        jewelleryJobId: optionalString(100),
        damagedLostReason: optionalString(300),
      })
    )
    .default([]),
});

export const cancelPacketProcessJobSchema = cancelJobSchema;

export const adjustPacketSchema = z.object({
  packetId: z.string().trim().min(1),
  direction: z.enum(["IN", "OUT"]),
  adjustmentDate: DATE_ONLY,
  pieces: z.coerce.number().int().min(0, "Pieces cannot be negative."),
  carat: z.coerce.number().min(0, "Carat cannot be negative."),
  costValue: z.coerce.number().min(0, "Cost cannot be negative.").optional(),
  reason: z.string().trim().min(3, "Give a short reason for this adjustment.").max(300),
});
