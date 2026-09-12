import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  ChargeMethod,
  DiscountType,
  GstTreatment,
  JewelleryType,
  MetalRateBasis,
  MetalType,
  OtherMaterialCategory,
  PricingMethod,
  TaxType,
  DiamondShape,
} from "@/generated/prisma/enums";

import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import { round3 } from "@/lib/diamond/allocation";
import { PostingError } from "@/lib/accounting/posting";
import {
  computeChargeLineAmount,
  computeDiamondLineAmount,
  computeMetalLineAmount,
  computeOtherMaterialLineAmount,
} from "@/lib/costing/calculations";
import { nextCostingNumber } from "@/lib/costing/numbering";
import { buildActualSourceSnapshot } from "@/lib/costing/sourcing";

// Deliberately NOT named "posting.ts" like every other module's write
// engine in this codebase — nothing here ever creates a Voucher,
// JournalEntry, StockMovement, or MetalStockMovement, or mutates any
// Phase 1-4 row. A CostSheet and its lines are purely informational.

export { PostingError };

type Tx = Prisma.TransactionClient;
type FyInput = { fyStartMonth: number; fyStartDay: number };

// ---------------------------------------------------------------------------
// Shared: audit trail
// ---------------------------------------------------------------------------

async function recordAuditEvent(
  tx: Tx,
  input: { costSheetId: string; eventType: Prisma.CostSheetAuditEventCreateInput["eventType"]; note?: string | null; userId: string }
) {
  await tx.costSheetAuditEvent.create({
    data: {
      costSheetId: input.costSheetId,
      eventType: input.eventType,
      note: input.note ?? null,
      userId: input.userId,
    },
  });
}

// ---------------------------------------------------------------------------
// Line resolution (ESTIMATE mode — server-side, Decimal-safe; a client-
// submitted `amount` is never trusted directly)
// ---------------------------------------------------------------------------

export type EstimateMetalLineInput = {
  metalType: MetalType;
  purityId: string;
  grossWeight: DecimalInput;
  wastagePercent?: DecimalInput;
  wastageWeight?: DecimalInput;
  rateBasis: MetalRateBasis;
  rate: DecimalInput;
};

export type EstimateDiamondLineInput = {
  diamondType?: string | null;
  shape: DiamondShape;
  customShapeName?: string | null;
  quantity: number;
  totalCarat: DecimalInput;
  ratePerCarat?: DecimalInput | null;
  fixedAmount?: DecimalInput | null;
  certificateCharge?: DecimalInput;
  notes?: string | null;
};

export type EstimateOtherMaterialLineInput = {
  category: OtherMaterialCategory;
  description: string;
  quantity?: DecimalInput | null;
  weight?: DecimalInput | null;
  rate?: DecimalInput | null;
  manualAmount?: DecimalInput | null;
};

export type EstimateChargeLineInput = {
  label: string;
  isLabour: boolean;
  method: ChargeMethod;
  rate: DecimalInput;
};

async function resolveMetalLines(tx: Tx, lines: EstimateMetalLineInput[]) {
  const resolved = [];
  for (const line of lines) {
    const grossWeight = round3(line.grossWeight);
    if (!grossWeight.greaterThan(0)) throw new PostingError("Each metal line's gross weight must be greater than zero.");
    const purity = await tx.metalPurity.findUnique({ where: { id: line.purityId } });
    if (!purity) throw new PostingError("Selected metal purity was not found.");
    if (purity.metalType !== line.metalType) throw new PostingError("One of the metal lines' metal type does not match its purity.");
    const computed = computeMetalLineAmount({
      grossWeight,
      finenessPercent: purity.finenessPercent,
      wastagePercent: line.wastagePercent,
      wastageWeight: line.wastageWeight,
      rateBasis: line.rateBasis,
      rate: line.rate,
    });
    resolved.push({
      metalType: line.metalType,
      purityId: line.purityId,
      purityDisplayNameSnapshot: purity.displayName,
      finenessPercentSnapshot: new Decimal(purity.finenessPercent),
      grossWeight,
      wastagePercent: new Decimal(line.wastagePercent ?? 0),
      wastageWeight: computed.wastageWeight,
      fineWeight: computed.fineWeight,
      rateBasis: line.rateBasis,
      rate: new Decimal(line.rate),
      amount: computed.amount,
      billedGrossWeight: computed.billedGrossWeight,
    });
  }
  return resolved;
}

function resolveDiamondLines(lines: EstimateDiamondLineInput[]) {
  return lines.map((line) => {
    if (line.quantity < 1) throw new PostingError("Each diamond line's quantity must be at least 1.");
    const totalCarat = round3(line.totalCarat);
    if (!totalCarat.greaterThan(0)) throw new PostingError("Each diamond line's total carat must be greater than zero.");
    const amount = computeDiamondLineAmount({
      totalCarat,
      ratePerCarat: line.ratePerCarat,
      fixedAmount: line.fixedAmount,
      certificateCharge: line.certificateCharge,
    });
    return {
      sourcePolishedDiamondId: null as string | null,
      polishedCodeSnapshot: null as string | null,
      diamondType: line.diamondType || null,
      shape: line.shape,
      customShapeName: line.customShapeName || null,
      quantity: line.quantity,
      totalCarat,
      ratePerCarat: line.ratePerCarat != null ? new Decimal(line.ratePerCarat) : null,
      fixedAmount: line.fixedAmount != null ? new Decimal(line.fixedAmount) : null,
      certificateCharge: round2(line.certificateCharge ?? 0),
      amount,
      notes: line.notes || null,
    };
  });
}

function resolveOtherMaterialLines(lines: EstimateOtherMaterialLineInput[]) {
  return lines.map((line) => {
    if (!line.description || !line.description.trim()) throw new PostingError("Each other-material line needs a description.");
    const amount = computeOtherMaterialLineAmount({
      quantity: line.quantity,
      weight: line.weight,
      rate: line.rate,
      manualAmount: line.manualAmount,
    });
    if (amount.isNegative()) throw new PostingError("Other-material line amounts cannot be negative.");
    return {
      category: line.category,
      description: line.description.trim(),
      quantity: line.quantity != null ? round3(line.quantity) : null,
      weight: line.weight != null ? round3(line.weight) : null,
      rate: line.rate != null ? round2(line.rate) : null,
      amount,
    };
  });
}

function resolveChargeLines(
  lines: EstimateChargeLineInput[],
  context: { totalMetalBilledGrossWeight: Decimal; totalDiamondCarat: Decimal; sheetQuantity: number; materialCostSubtotal: Decimal }
) {
  return lines.map((line) => {
    if (!line.label || !line.label.trim()) throw new PostingError("Each charge line needs a label.");
    const rate = new Decimal(line.rate);
    if (rate.isNegative()) throw new PostingError("Charge line rates cannot be negative.");
    const amount = computeChargeLineAmount({
      method: line.method,
      rate,
      totalMetalBilledGrossWeight: context.totalMetalBilledGrossWeight,
      totalDiamondCarat: context.totalDiamondCarat,
      sheetQuantity: context.sheetQuantity,
      materialCostSubtotal: context.materialCostSubtotal,
    });
    return { label: line.label.trim(), isLabour: line.isLabour, method: line.method, rate, amount };
  });
}

// ---------------------------------------------------------------------------
// Shared pricing/GST field validation (both modes)
// ---------------------------------------------------------------------------

export type PricingInput = {
  pricingMethod: PricingMethod;
  markupPercent?: DecimalInput;
  targetMarginPercent?: DecimalInput;
  manualSellingPriceOverride?: DecimalInput | null;
  discountType: DiscountType;
  discountValue?: DecimalInput;
  gstTreatment: GstTreatment;
  gstRateId?: string | null;
  priceType: TaxType;
  roundingStep?: DecimalInput;
  sellingExpenseFixed?: DecimalInput;
  sellingExpensePercent?: DecimalInput;
  quotationTerms?: string | null;
};

async function resolvePricing(tx: Tx, input: PricingInput) {
  const targetMarginPercent = new Decimal(input.targetMarginPercent ?? 0);
  if (input.pricingMethod === "MARGIN_ON_PRICE" && targetMarginPercent.greaterThanOrEqualTo(100)) {
    throw new PostingError("Target margin must be less than 100%.");
  }
  if (input.manualSellingPriceOverride != null && new Decimal(input.manualSellingPriceOverride).isNegative()) {
    throw new PostingError("Manual selling price override cannot be negative.");
  }
  const discountValue = new Decimal(input.discountValue ?? 0);
  if (discountValue.isNegative()) throw new PostingError("Discount cannot be negative.");
  if (input.discountType === "PERCENT" && discountValue.greaterThan(100)) {
    throw new PostingError("A percentage discount cannot exceed 100%.");
  }

  let gstRatePercentSnapshot = ZERO;
  if (input.gstTreatment !== "NONE") {
    if (!input.gstRateId) throw new PostingError("Choose a GST rate for this treatment.");
    const gstRate = await tx.gstRate.findUnique({ where: { id: input.gstRateId } });
    if (!gstRate) throw new PostingError("Selected GST rate was not found.");
    gstRatePercentSnapshot = new Decimal(gstRate.ratePercent);
  }

  const sellingExpensePercent = new Decimal(input.sellingExpensePercent ?? 0);
  if (sellingExpensePercent.isNegative() || sellingExpensePercent.greaterThan(100)) {
    throw new PostingError("Selling expense percentage must be between 0 and 100.");
  }
  const sellingExpenseFixed = round2(input.sellingExpenseFixed ?? 0);
  if (sellingExpenseFixed.isNegative()) throw new PostingError("Selling expense amount cannot be negative.");

  return {
    pricingMethod: input.pricingMethod,
    markupPercent: new Decimal(input.markupPercent ?? 0),
    targetMarginPercent,
    manualSellingPriceOverride: input.manualSellingPriceOverride != null ? round2(input.manualSellingPriceOverride) : null,
    isManualOverride: input.manualSellingPriceOverride != null,
    discountType: input.discountType,
    discountValue,
    gstTreatment: input.gstTreatment,
    gstRateId: input.gstTreatment === "NONE" ? null : input.gstRateId ?? null,
    gstRatePercentSnapshot,
    priceType: input.priceType,
    roundingStep: round2(input.roundingStep ?? 0),
    sellingExpenseFixed,
    sellingExpensePercent,
    quotationTerms: input.quotationTerms ?? null,
  };
}

function computeQuotationValidUntil(costingDate: Date, validityDays: number): Date {
  const result = new Date(costingDate);
  result.setUTCDate(result.getUTCDate() + validityDays);
  return result;
}

// ---------------------------------------------------------------------------
// Create — Actual (sources from a real, COMPLETED Phase 4 output)
// ---------------------------------------------------------------------------

export async function createActualCostSheet(
  tx: Tx,
  input: FyInput &
    PricingInput & {
      sourceFinishedJewelleryId: string;
      costingDate: Date;
      quantity?: number;
      sizeOrLength?: string | null;
      customerId?: string | null;
      notes?: string | null;
      validityDays: number;
      idempotencyKey?: string | null;
      createdByUserId: string;
    }
) {
  const snapshot = await buildActualSourceSnapshot(tx, input.sourceFinishedJewelleryId);
  const pricing = await resolvePricing(tx, input);
  const costingNumber = await nextCostingNumber(tx, input.costingDate, input.fyStartMonth, input.fyStartDay);

  const sheet = await tx.costSheet.create({
    data: {
      costingNumber,
      mode: "ACTUAL",
      status: "DRAFT",
      costingDate: input.costingDate,
      jewelleryType: snapshot.jewelleryType as JewelleryType,
      itemName: snapshot.itemName,
      referenceNumber: snapshot.referenceNumber,
      quantity: input.quantity ?? snapshot.quantity,
      sizeOrLength: input.sizeOrLength || null,
      designImageAssetId: snapshot.designImageAssetId,
      notes: input.notes || null,
      customerId: input.customerId || null,
      sourceFinishedJewelleryId: input.sourceFinishedJewelleryId,
      sourceJobCode: snapshot.sourceJobCode,
      sourceReceiptCode: snapshot.sourceReceiptCode,
      sourceFinishedCode: snapshot.sourceFinishedCode,
      sourceVoucherNumber: snapshot.sourceVoucherNumber,
      sourceRefreshedAt: new Date(),
      revisionGroupId: "pending",
      ...pricing,
      quotationValidUntil: computeQuotationValidUntil(input.costingDate, input.validityDays),
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });
  await tx.costSheet.update({ where: { id: sheet.id }, data: { revisionGroupId: sheet.id } });

  await writeActualLines(tx, sheet.id, snapshot);
  await recordAuditEvent(tx, { costSheetId: sheet.id, eventType: "CREATED", userId: input.createdByUserId });

  return tx.costSheet.findUniqueOrThrow({ where: { id: sheet.id } });
}

async function writeActualLines(tx: Tx, costSheetId: string, snapshot: Awaited<ReturnType<typeof buildActualSourceSnapshot>>) {
  await tx.costSheetMetalLine.create({
    data: {
      costSheetId,
      metalType: snapshot.metalLine.metalType as MetalType,
      purityId: snapshot.metalLine.purityId,
      purityDisplayNameSnapshot: snapshot.metalLine.purityDisplayNameSnapshot,
      finenessPercentSnapshot: snapshot.metalLine.finenessPercentSnapshot.toFixed(3),
      grossWeight: snapshot.metalLine.grossWeight.toFixed(3),
      wastagePercent: "0",
      wastageWeight: "0",
      fineWeight: snapshot.metalLine.fineWeight.toFixed(3),
      rateBasis: "FIXED_TOTAL",
      rate: snapshot.metalLine.amount.toFixed(4),
      amount: snapshot.metalLine.amount.toFixed(2),
      sortOrder: 0,
    },
  });
  for (let i = 0; i < snapshot.diamondLines.length; i++) {
    const d = snapshot.diamondLines[i];
    await tx.costSheetDiamondLine.create({
      data: {
        costSheetId,
        sourcePolishedDiamondId: d.sourcePolishedDiamondId,
        polishedCodeSnapshot: d.polishedCodeSnapshot,
        shape: d.shape as DiamondShape,
        quantity: d.quantity,
        totalCarat: d.totalCarat.toFixed(3),
        fixedAmount: d.amount.toFixed(2),
        certificateCharge: "0",
        amount: d.amount.toFixed(2),
        notes: d.notes,
        sortOrder: i,
      },
    });
  }
  if (snapshot.otherMaterialLine) {
    await tx.costSheetOtherMaterialLine.create({
      data: {
        costSheetId,
        category: "OTHER",
        description: snapshot.otherMaterialLine.description,
        amount: snapshot.otherMaterialLine.amount.toFixed(2),
        sortOrder: 0,
      },
    });
  }
  if (snapshot.labourLine) {
    await tx.costSheetChargeLine.create({
      data: {
        costSheetId,
        label: snapshot.labourLine.label,
        isLabour: true,
        method: "FLAT",
        rate: snapshot.labourLine.amount.toFixed(2),
        amount: snapshot.labourLine.amount.toFixed(2),
        sortOrder: 0,
      },
    });
  }
}

/** Draft-only: re-pulls the latest snapshot from the same source output,
 * replacing this sheet's auto-sourced lines. Never automatic — the Owner
 * must explicitly ask for it each time. */
export async function refreshActualCostSheetFromSource(tx: Tx, input: { costSheetId: string; userId: string }) {
  const sheet = await tx.costSheet.findUnique({ where: { id: input.costSheetId } });
  if (!sheet) throw new PostingError("Costing not found.");
  if (sheet.mode !== "ACTUAL" || !sheet.sourceFinishedJewelleryId) {
    throw new PostingError("Only an Actual costing sourced from a finished output can be refreshed.");
  }
  if (sheet.status !== "DRAFT") throw new PostingError("Only a Draft costing can be refreshed from source.");

  const snapshot = await buildActualSourceSnapshot(tx, sheet.sourceFinishedJewelleryId);

  await tx.costSheetMetalLine.deleteMany({ where: { costSheetId: sheet.id } });
  await tx.costSheetDiamondLine.deleteMany({ where: { costSheetId: sheet.id } });
  await tx.costSheetOtherMaterialLine.deleteMany({ where: { costSheetId: sheet.id } });
  await tx.costSheetChargeLine.deleteMany({ where: { costSheetId: sheet.id } });
  await writeActualLines(tx, sheet.id, snapshot);

  const updated = await tx.costSheet.update({
    where: { id: sheet.id },
    data: {
      itemName: snapshot.itemName,
      referenceNumber: snapshot.referenceNumber,
      designImageAssetId: snapshot.designImageAssetId,
      sourceJobCode: snapshot.sourceJobCode,
      sourceReceiptCode: snapshot.sourceReceiptCode,
      sourceFinishedCode: snapshot.sourceFinishedCode,
      sourceVoucherNumber: snapshot.sourceVoucherNumber,
      sourceRefreshedAt: new Date(),
      updatedByUserId: input.userId,
    },
  });
  await recordAuditEvent(tx, { costSheetId: sheet.id, eventType: "REFRESHED", userId: input.userId });
  return updated;
}

// ---------------------------------------------------------------------------
// Create / update — Estimate (fully manual, never touches real stock)
// ---------------------------------------------------------------------------

export type EstimateSheetFields = {
  costingDate: Date;
  jewelleryType: JewelleryType;
  itemName: string;
  referenceNumber?: string | null;
  quantity: number;
  sizeOrLength?: string | null;
  designImageAssetId?: string | null;
  customerId?: string | null;
  notes?: string | null;
  linkedEstimateId?: string | null;
  metalLines: EstimateMetalLineInput[];
  diamondLines: EstimateDiamondLineInput[];
  otherMaterialLines: EstimateOtherMaterialLineInput[];
  chargeLines: EstimateChargeLineInput[];
};

async function resolveEstimateLines(tx: Tx, input: EstimateSheetFields) {
  const metalLines = await resolveMetalLines(tx, input.metalLines);
  const diamondLines = resolveDiamondLines(input.diamondLines);
  const otherMaterialLines = resolveOtherMaterialLines(input.otherMaterialLines);

  const totalMetalBilledGrossWeight = metalLines.reduce((sum, l) => sum.plus(l.billedGrossWeight), ZERO);
  const totalDiamondCarat = diamondLines.reduce((sum, l) => sum.plus(l.totalCarat), ZERO);
  const materialCostSubtotal = round2(
    metalLines.reduce((sum, l) => sum.plus(l.amount), ZERO)
      .plus(diamondLines.reduce((sum, l) => sum.plus(l.amount), ZERO))
      .plus(otherMaterialLines.reduce((sum, l) => sum.plus(l.amount), ZERO))
  );
  const chargeLines = resolveChargeLines(input.chargeLines, {
    totalMetalBilledGrossWeight,
    totalDiamondCarat,
    sheetQuantity: input.quantity,
    materialCostSubtotal,
  });

  if (metalLines.length === 0 && diamondLines.length === 0 && otherMaterialLines.length === 0 && chargeLines.length === 0) {
    throw new PostingError("Add at least one metal, diamond, other-material, or charge line.");
  }

  return { metalLines, diamondLines, otherMaterialLines, chargeLines };
}

async function writeEstimateLines(
  tx: Tx,
  costSheetId: string,
  resolved: Awaited<ReturnType<typeof resolveEstimateLines>>
) {
  for (let i = 0; i < resolved.metalLines.length; i++) {
    const l = resolved.metalLines[i];
    await tx.costSheetMetalLine.create({
      data: {
        costSheetId,
        metalType: l.metalType,
        purityId: l.purityId,
        purityDisplayNameSnapshot: l.purityDisplayNameSnapshot,
        finenessPercentSnapshot: l.finenessPercentSnapshot.toFixed(3),
        grossWeight: l.grossWeight.toFixed(3),
        wastagePercent: l.wastagePercent.toFixed(3),
        wastageWeight: l.wastageWeight.toFixed(3),
        fineWeight: l.fineWeight.toFixed(3),
        rateBasis: l.rateBasis,
        rate: l.rate.toFixed(4),
        amount: l.amount.toFixed(2),
        sortOrder: i,
      },
    });
  }
  for (let i = 0; i < resolved.diamondLines.length; i++) {
    const l = resolved.diamondLines[i];
    await tx.costSheetDiamondLine.create({
      data: {
        costSheetId,
        diamondType: l.diamondType,
        shape: l.shape,
        customShapeName: l.customShapeName,
        quantity: l.quantity,
        totalCarat: l.totalCarat.toFixed(3),
        ratePerCarat: l.ratePerCarat ? l.ratePerCarat.toFixed(2) : null,
        fixedAmount: l.fixedAmount ? l.fixedAmount.toFixed(2) : null,
        certificateCharge: l.certificateCharge.toFixed(2),
        amount: l.amount.toFixed(2),
        notes: l.notes,
        sortOrder: i,
      },
    });
  }
  for (let i = 0; i < resolved.otherMaterialLines.length; i++) {
    const l = resolved.otherMaterialLines[i];
    await tx.costSheetOtherMaterialLine.create({
      data: {
        costSheetId,
        category: l.category,
        description: l.description,
        quantity: l.quantity ? l.quantity.toFixed(3) : null,
        weight: l.weight ? l.weight.toFixed(3) : null,
        rate: l.rate ? l.rate.toFixed(2) : null,
        amount: l.amount.toFixed(2),
        sortOrder: i,
      },
    });
  }
  for (let i = 0; i < resolved.chargeLines.length; i++) {
    const l = resolved.chargeLines[i];
    await tx.costSheetChargeLine.create({
      data: {
        costSheetId,
        label: l.label,
        isLabour: l.isLabour,
        method: l.method,
        rate: l.rate.toFixed(2),
        amount: l.amount.toFixed(2),
        sortOrder: i,
      },
    });
  }
}

export async function createEstimateCostSheet(
  tx: Tx,
  input: FyInput & PricingInput & EstimateSheetFields & { validityDays: number; idempotencyKey?: string | null; createdByUserId: string }
) {
  if (!input.itemName || !input.itemName.trim()) throw new PostingError("Enter an item name.");
  if (input.quantity < 1) throw new PostingError("Quantity must be at least 1.");

  const resolved = await resolveEstimateLines(tx, input);
  const pricing = await resolvePricing(tx, input);
  const costingNumber = await nextCostingNumber(tx, input.costingDate, input.fyStartMonth, input.fyStartDay);

  const sheet = await tx.costSheet.create({
    data: {
      costingNumber,
      mode: "ESTIMATE",
      status: "DRAFT",
      costingDate: input.costingDate,
      jewelleryType: input.jewelleryType,
      itemName: input.itemName.trim(),
      referenceNumber: input.referenceNumber || null,
      quantity: input.quantity,
      sizeOrLength: input.sizeOrLength || null,
      designImageAssetId: input.designImageAssetId || null,
      notes: input.notes || null,
      customerId: input.customerId || null,
      linkedEstimateId: null,
      revisionGroupId: "pending",
      ...pricing,
      quotationValidUntil: computeQuotationValidUntil(input.costingDate, input.validityDays),
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });
  await tx.costSheet.update({ where: { id: sheet.id }, data: { revisionGroupId: sheet.id } });

  await writeEstimateLines(tx, sheet.id, resolved);
  await recordAuditEvent(tx, { costSheetId: sheet.id, eventType: "CREATED", userId: input.createdByUserId });

  return tx.costSheet.findUniqueOrThrow({ where: { id: sheet.id } });
}

/** Full in-place replace of a Draft Estimate's fields/lines/pricing.
 * Rejects outright once the sheet is Finalized/Archived — a correction
 * to those is always a new revision, never an edit in place. Also used
 * to edit an ACTUAL Draft's own overridable fields (customer, notes,
 * quantity, size, pricing/GST) — its sourced lines are only ever changed
 * via refreshActualCostSheetFromSource, never via this function. */
export async function updateEstimateCostSheet(
  tx: Tx,
  input: FyInput & PricingInput & EstimateSheetFields & { costSheetId: string; validityDays: number; userId: string }
) {
  const sheet = await tx.costSheet.findUnique({ where: { id: input.costSheetId } });
  if (!sheet) throw new PostingError("Costing not found.");
  if (sheet.mode !== "ESTIMATE") throw new PostingError("Only an Estimate costing can be edited this way.");
  if (sheet.status !== "DRAFT") throw new PostingError("Only a Draft costing can be edited.");
  if (!input.itemName || !input.itemName.trim()) throw new PostingError("Enter an item name.");
  if (input.quantity < 1) throw new PostingError("Quantity must be at least 1.");

  const resolved = await resolveEstimateLines(tx, input);
  const pricing = await resolvePricing(tx, input);

  await tx.costSheetMetalLine.deleteMany({ where: { costSheetId: sheet.id } });
  await tx.costSheetDiamondLine.deleteMany({ where: { costSheetId: sheet.id } });
  await tx.costSheetOtherMaterialLine.deleteMany({ where: { costSheetId: sheet.id } });
  await tx.costSheetChargeLine.deleteMany({ where: { costSheetId: sheet.id } });
  await writeEstimateLines(tx, sheet.id, resolved);

  const updated = await tx.costSheet.update({
    where: { id: sheet.id },
    data: {
      costingDate: input.costingDate,
      jewelleryType: input.jewelleryType,
      itemName: input.itemName.trim(),
      referenceNumber: input.referenceNumber || null,
      quantity: input.quantity,
      sizeOrLength: input.sizeOrLength || null,
      designImageAssetId: input.designImageAssetId || null,
      notes: input.notes || null,
      customerId: input.customerId || null,
      linkedEstimateId: input.linkedEstimateId || null,
      ...pricing,
      quotationValidUntil: computeQuotationValidUntil(input.costingDate, input.validityDays),
      updatedByUserId: input.userId,
    },
  });
  await recordAuditEvent(tx, { costSheetId: sheet.id, eventType: "UPDATED", userId: input.userId });
  return updated;
}

/** Updates only the overridable header/pricing fields of an ACTUAL Draft
 * (never its sourced lines — use refreshActualCostSheetFromSource for
 * that). Kept separate from updateEstimateCostSheet so an Actual sheet's
 * lines can never accidentally be wiped by the Estimate edit path. */
export async function updateActualCostSheetFields(
  tx: Tx,
  input: FyInput &
    PricingInput & {
      costSheetId: string;
      costingDate: Date;
      quantity: number;
      sizeOrLength?: string | null;
      customerId?: string | null;
      notes?: string | null;
      linkedEstimateId?: string | null;
      validityDays: number;
      userId: string;
    }
) {
  const sheet = await tx.costSheet.findUnique({ where: { id: input.costSheetId } });
  if (!sheet) throw new PostingError("Costing not found.");
  if (sheet.mode !== "ACTUAL") throw new PostingError("This costing is not an Actual costing.");
  if (sheet.status !== "DRAFT") throw new PostingError("Only a Draft costing can be edited.");
  if (input.quantity < 1) throw new PostingError("Quantity must be at least 1.");

  const pricing = await resolvePricing(tx, input);
  const updated = await tx.costSheet.update({
    where: { id: sheet.id },
    data: {
      costingDate: input.costingDate,
      quantity: input.quantity,
      sizeOrLength: input.sizeOrLength || null,
      customerId: input.customerId || null,
      notes: input.notes || null,
      linkedEstimateId: input.linkedEstimateId || null,
      ...pricing,
      quotationValidUntil: computeQuotationValidUntil(input.costingDate, input.validityDays),
      updatedByUserId: input.userId,
    },
  });
  await recordAuditEvent(tx, { costSheetId: sheet.id, eventType: "UPDATED", userId: input.userId });
  return updated;
}

// ---------------------------------------------------------------------------
// Lifecycle: finalize / revise / archive / unarchive / delete draft
// ---------------------------------------------------------------------------

export async function finalizeCostSheet(tx: Tx, input: { costSheetId: string; userId: string }) {
  const sheet = await tx.costSheet.findUnique({ where: { id: input.costSheetId } });
  if (!sheet) throw new PostingError("Costing not found.");
  if (sheet.status !== "DRAFT") throw new PostingError("Only a Draft costing can be finalized.");

  const lineCount =
    (await tx.costSheetMetalLine.count({ where: { costSheetId: sheet.id } })) +
    (await tx.costSheetDiamondLine.count({ where: { costSheetId: sheet.id } })) +
    (await tx.costSheetOtherMaterialLine.count({ where: { costSheetId: sheet.id } })) +
    (await tx.costSheetChargeLine.count({ where: { costSheetId: sheet.id } }));
  if (lineCount === 0) throw new PostingError("Add at least one cost line before finalizing.");

  if (sheet.pricingMethod === "MARGIN_ON_PRICE" && new Decimal(sheet.targetMarginPercent).greaterThanOrEqualTo(100)) {
    throw new PostingError("Target margin must be less than 100% before finalizing.");
  }

  const updated = await tx.costSheet.update({
    where: { id: sheet.id },
    data: { status: "FINALIZED", finalizedAt: new Date(), finalizedByUserId: input.userId },
  });
  await recordAuditEvent(tx, { costSheetId: sheet.id, eventType: "FINALIZED", userId: input.userId });
  return updated;
}

/** Creates a new DRAFT revision copying every field/line from a
 * FINALIZED (or ARCHIVED) sheet, linked back via previousVersionId — the
 * ONLY way to change a finalized sheet's numbers. The original row is
 * never edited or deleted. */
export async function reviseCostSheet(tx: Tx, input: { costSheetId: string; userId: string }) {
  const original = await tx.costSheet.findUnique({
    where: { id: input.costSheetId },
    include: { metalLines: true, diamondLines: true, otherMaterialLines: true, chargeLines: true },
  });
  if (!original) throw new PostingError("Costing not found.");
  if (original.status === "DRAFT") throw new PostingError("A Draft costing does not need a revision — edit it directly.");

  const costingNumber = await nextCostingNumber(tx, new Date(), 4, 1);
  const revision = await tx.costSheet.create({
    data: {
      costingNumber,
      mode: original.mode,
      status: "DRAFT",
      costingDate: original.costingDate,
      jewelleryType: original.jewelleryType,
      itemName: original.itemName,
      referenceNumber: original.referenceNumber,
      quantity: original.quantity,
      sizeOrLength: original.sizeOrLength,
      designImageAssetId: original.designImageAssetId,
      notes: original.notes,
      customerId: original.customerId,
      sourceFinishedJewelleryId: original.sourceFinishedJewelleryId,
      sourceJobCode: original.sourceJobCode,
      sourceReceiptCode: original.sourceReceiptCode,
      sourceFinishedCode: original.sourceFinishedCode,
      sourceVoucherNumber: original.sourceVoucherNumber,
      sourceRefreshedAt: original.sourceRefreshedAt,
      linkedEstimateId: original.linkedEstimateId,
      pricingMethod: original.pricingMethod,
      markupPercent: original.markupPercent,
      targetMarginPercent: original.targetMarginPercent,
      manualSellingPriceOverride: original.manualSellingPriceOverride,
      isManualOverride: original.isManualOverride,
      discountType: original.discountType,
      discountValue: original.discountValue,
      gstTreatment: original.gstTreatment,
      gstRateId: original.gstRateId,
      gstRatePercentSnapshot: original.gstRatePercentSnapshot,
      priceType: original.priceType,
      roundingStep: original.roundingStep,
      sellingExpenseFixed: original.sellingExpenseFixed,
      sellingExpensePercent: original.sellingExpensePercent,
      quotationValidUntil: original.quotationValidUntil,
      quotationTerms: original.quotationTerms,
      revisionGroupId: original.revisionGroupId,
      revisionNumber: original.revisionNumber + 1,
      previousVersionId: original.id,
      createdByUserId: input.userId,
    },
  });

  for (const l of original.metalLines) {
    await tx.costSheetMetalLine.create({
      data: {
        costSheetId: revision.id,
        metalType: l.metalType,
        purityId: l.purityId,
        purityDisplayNameSnapshot: l.purityDisplayNameSnapshot,
        finenessPercentSnapshot: l.finenessPercentSnapshot,
        grossWeight: l.grossWeight,
        wastagePercent: l.wastagePercent,
        wastageWeight: l.wastageWeight,
        fineWeight: l.fineWeight,
        rateBasis: l.rateBasis,
        rate: l.rate,
        amount: l.amount,
        sortOrder: l.sortOrder,
      },
    });
  }
  for (const l of original.diamondLines) {
    await tx.costSheetDiamondLine.create({
      data: {
        costSheetId: revision.id,
        sourcePolishedDiamondId: l.sourcePolishedDiamondId,
        polishedCodeSnapshot: l.polishedCodeSnapshot,
        diamondType: l.diamondType,
        shape: l.shape,
        customShapeName: l.customShapeName,
        quantity: l.quantity,
        totalCarat: l.totalCarat,
        ratePerCarat: l.ratePerCarat,
        fixedAmount: l.fixedAmount,
        certificateCharge: l.certificateCharge,
        amount: l.amount,
        notes: l.notes,
        sortOrder: l.sortOrder,
      },
    });
  }
  for (const l of original.otherMaterialLines) {
    await tx.costSheetOtherMaterialLine.create({
      data: {
        costSheetId: revision.id,
        category: l.category,
        description: l.description,
        quantity: l.quantity,
        weight: l.weight,
        rate: l.rate,
        amount: l.amount,
        sortOrder: l.sortOrder,
      },
    });
  }
  for (const l of original.chargeLines) {
    await tx.costSheetChargeLine.create({
      data: {
        costSheetId: revision.id,
        label: l.label,
        isLabour: l.isLabour,
        method: l.method,
        rate: l.rate,
        amount: l.amount,
        sortOrder: l.sortOrder,
      },
    });
  }

  await recordAuditEvent(tx, { costSheetId: original.id, eventType: "REVISED", userId: input.userId, note: `Revised as ${revision.costingNumber}` });
  await recordAuditEvent(tx, { costSheetId: revision.id, eventType: "CREATED", userId: input.userId, note: `Revision of ${original.costingNumber}` });

  return revision;
}

export async function archiveCostSheet(tx: Tx, input: { costSheetId: string; userId: string }) {
  const sheet = await tx.costSheet.findUnique({ where: { id: input.costSheetId } });
  if (!sheet) throw new PostingError("Costing not found.");
  if (sheet.status !== "FINALIZED") throw new PostingError("Only a Finalized costing can be archived.");
  const updated = await tx.costSheet.update({
    where: { id: sheet.id },
    data: { status: "ARCHIVED", archivedAt: new Date(), archivedByUserId: input.userId },
  });
  await recordAuditEvent(tx, { costSheetId: sheet.id, eventType: "ARCHIVED", userId: input.userId });
  return updated;
}

export async function unarchiveCostSheet(tx: Tx, input: { costSheetId: string; userId: string }) {
  const sheet = await tx.costSheet.findUnique({ where: { id: input.costSheetId } });
  if (!sheet) throw new PostingError("Costing not found.");
  if (sheet.status !== "ARCHIVED") throw new PostingError("Only an Archived costing can be restored.");
  const updated = await tx.costSheet.update({
    where: { id: sheet.id },
    data: { status: "FINALIZED", archivedAt: null, archivedByUserId: null },
  });
  await recordAuditEvent(tx, { costSheetId: sheet.id, eventType: "UNARCHIVED", userId: input.userId });
  return updated;
}

/** Owner-only, enforced by the caller. Only a DRAFT may ever be deleted —
 * a Finalized or Archived sheet is never hard-deleted, matching this
 * codebase's "posted records are never permanently erased" rule even
 * though nothing here is itself an accounting posting. */
export async function deleteDraftCostSheet(tx: Tx, input: { costSheetId: string }) {
  const sheet = await tx.costSheet.findUnique({ where: { id: input.costSheetId } });
  if (!sheet) throw new PostingError("Costing not found.");
  if (sheet.status !== "DRAFT") throw new PostingError("Only a Draft costing can be deleted.");
  await tx.costSheet.delete({ where: { id: sheet.id } });
}
