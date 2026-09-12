import "server-only";

import { prisma } from "@/lib/db/prisma";
import { Decimal, round2 } from "@/lib/accounting/money";
import { round3 } from "@/lib/diamond/allocation";
import { computeCostSheetTotals, type CostSheetTotals } from "@/lib/costing/calculations";
import type { CostSheetMode, CostSheetStatus } from "@/generated/prisma/enums";

const DEFAULT_SETTINGS = {
  defaultPricingMethod: "MARKUP_ON_COST" as const,
  defaultMarkupPercent: new Decimal(0),
  defaultTargetMarginPercent: new Decimal(0),
  defaultDiscountType: "NONE" as const,
  defaultDiscountValue: new Decimal(0),
  defaultGstTreatment: "NONE" as const,
  defaultGstRateId: null as string | null,
  defaultPriceType: "EXCLUSIVE" as const,
  defaultValidityDays: 15,
  defaultRoundingStep: new Decimal(0),
  defaultSellingExpenseFixed: new Decimal(0),
  defaultSellingExpensePercent: new Decimal(0),
  quotationTerms: null as string | null,
};

/** Owner-only defaults. No seed-time row exists (same pattern as
 * CompanySettings) — falls back to safe zero/NONE defaults when absent. */
export async function getCostingSettings() {
  const row = await prisma.costingSettings.findUnique({ where: { id: "default" } });
  if (!row) return DEFAULT_SETTINGS;
  return {
    defaultPricingMethod: row.defaultPricingMethod,
    defaultMarkupPercent: new Decimal(row.defaultMarkupPercent),
    defaultTargetMarginPercent: new Decimal(row.defaultTargetMarginPercent),
    defaultDiscountType: row.defaultDiscountType,
    defaultDiscountValue: new Decimal(row.defaultDiscountValue),
    defaultGstTreatment: row.defaultGstTreatment,
    defaultGstRateId: row.defaultGstRateId,
    defaultPriceType: row.defaultPriceType,
    defaultValidityDays: row.defaultValidityDays,
    defaultRoundingStep: new Decimal(row.defaultRoundingStep),
    defaultSellingExpenseFixed: new Decimal(row.defaultSellingExpenseFixed),
    defaultSellingExpensePercent: new Decimal(row.defaultSellingExpensePercent),
    quotationTerms: row.quotationTerms,
  };
}

export async function getDraftCostingsCount(): Promise<number> {
  return prisma.costSheet.count({ where: { status: "DRAFT" } });
}

// ---------------------------------------------------------------------------
// List (Cost Sheets tab)
// ---------------------------------------------------------------------------

export type CostSheetListRow = {
  id: string;
  costingNumber: string;
  mode: CostSheetMode;
  status: CostSheetStatus;
  costingDate: Date;
  itemName: string;
  customerName: string | null;
  referenceNumber: string | null;
  revisionNumber: number;
  productionCost: Decimal;
  customerTotal: Decimal;
  estimatedProfit: Decimal;
};

function toTotalsInput(sheet: {
  metalLines: { amount: Decimal | string }[];
  diamondLines: { amount: Decimal | string }[];
  otherMaterialLines: { amount: Decimal | string }[];
  chargeLines: { amount: Decimal | string; isLabour: boolean }[];
  pricingMethod: "MARKUP_ON_COST" | "MARGIN_ON_PRICE";
  markupPercent: Decimal | string;
  targetMarginPercent: Decimal | string;
  manualSellingPriceOverride: Decimal | string | null;
  discountType: "NONE" | "PERCENT" | "FIXED";
  discountValue: Decimal | string;
  gstTreatment: "NONE" | "CGST_SGST" | "IGST";
  gstRatePercentSnapshot: Decimal | string;
  priceType: "EXCLUSIVE" | "INCLUSIVE";
  roundingStep: Decimal | string;
  sellingExpenseFixed: Decimal | string;
  sellingExpensePercent: Decimal | string;
}) {
  return {
    metalLineAmounts: sheet.metalLines.map((l) => l.amount),
    diamondLineAmounts: sheet.diamondLines.map((l) => l.amount),
    otherMaterialLineAmounts: sheet.otherMaterialLines.map((l) => l.amount),
    labourLineAmounts: sheet.chargeLines.filter((l) => l.isLabour).map((l) => l.amount),
    additionalChargeLineAmounts: sheet.chargeLines.filter((l) => !l.isLabour).map((l) => l.amount),
    pricingMethod: sheet.pricingMethod,
    markupPercent: sheet.markupPercent,
    targetMarginPercent: sheet.targetMarginPercent,
    manualSellingPriceOverride: sheet.manualSellingPriceOverride,
    discountType: sheet.discountType,
    discountValue: sheet.discountValue,
    gstTreatment: sheet.gstTreatment,
    gstRatePercent: sheet.gstRatePercentSnapshot,
    priceType: sheet.priceType,
    roundingStep: sheet.roundingStep,
    sellingExpenseFixed: sheet.sellingExpenseFixed,
    sellingExpensePercent: sheet.sellingExpensePercent,
  };
}

export async function listCostSheets(filters?: {
  mode?: CostSheetMode;
  status?: CostSheetStatus[];
  search?: string;
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<CostSheetListRow[]> {
  const sheets = await prisma.costSheet.findMany({
    where: {
      mode: filters?.mode,
      status: filters?.status ? { in: filters.status } : undefined,
      costingDate:
        filters?.dateFrom || filters?.dateTo
          ? { gte: filters?.dateFrom, lte: filters?.dateTo }
          : undefined,
      ...(filters?.search
        ? {
            OR: [
              { costingNumber: { contains: filters.search, mode: "insensitive" } },
              { itemName: { contains: filters.search, mode: "insensitive" } },
              { referenceNumber: { contains: filters.search, mode: "insensitive" } },
              { customer: { name: { contains: filters.search, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    include: { customer: true, metalLines: true, diamondLines: true, otherMaterialLines: true, chargeLines: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return sheets.map((sheet) => {
    const totals = computeCostSheetTotals(toTotalsInput(sheet));
    return {
      id: sheet.id,
      costingNumber: sheet.costingNumber,
      mode: sheet.mode,
      status: sheet.status,
      costingDate: sheet.costingDate,
      itemName: sheet.itemName,
      customerName: sheet.customer?.name ?? null,
      referenceNumber: sheet.referenceNumber,
      revisionNumber: sheet.revisionNumber,
      productionCost: totals.productionCost,
      customerTotal: totals.customerTotal,
      estimatedProfit: totals.estimatedProfit,
    };
  });
}

// ---------------------------------------------------------------------------
// Detail (view/edit one Cost Sheet)
// ---------------------------------------------------------------------------

export type CostSheetDetail = {
  id: string;
  costingNumber: string;
  mode: CostSheetMode;
  status: CostSheetStatus;
  costingDate: Date;
  jewelleryType: string;
  itemName: string;
  referenceNumber: string | null;
  quantity: number;
  sizeOrLength: string | null;
  designImageAssetId: string | null;
  notes: string | null;
  customerId: string | null;
  customerName: string | null;
  sourceFinishedJewelleryId: string | null;
  sourceJobCode: string | null;
  sourceReceiptCode: string | null;
  sourceFinishedCode: string | null;
  sourceVoucherNumber: string | null;
  sourceRefreshedAt: Date | null;
  linkedEstimateId: string | null;
  linkedEstimateNumber: string | null;
  pricingMethod: "MARKUP_ON_COST" | "MARGIN_ON_PRICE";
  markupPercent: Decimal;
  targetMarginPercent: Decimal;
  manualSellingPriceOverride: Decimal | null;
  isManualOverride: boolean;
  discountType: "NONE" | "PERCENT" | "FIXED";
  discountValue: Decimal;
  gstTreatment: "NONE" | "CGST_SGST" | "IGST";
  gstRateId: string | null;
  gstRatePercentSnapshot: Decimal;
  priceType: "EXCLUSIVE" | "INCLUSIVE";
  roundingStep: Decimal;
  sellingExpenseFixed: Decimal;
  sellingExpensePercent: Decimal;
  quotationValidUntil: Date | null;
  quotationTerms: string | null;
  revisionGroupId: string;
  revisionNumber: number;
  previousVersionId: string | null;
  nextVersionId: string | null;
  finalizedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  metalLines: {
    id: string;
    metalType: string;
    purityId: string | null;
    purityDisplayNameSnapshot: string;
    finenessPercentSnapshot: Decimal;
    grossWeight: Decimal;
    wastagePercent: Decimal;
    wastageWeight: Decimal;
    fineWeight: Decimal;
    rateBasis: string;
    rate: Decimal;
    amount: Decimal;
  }[];
  diamondLines: {
    id: string;
    sourcePolishedDiamondId: string | null;
    polishedCodeSnapshot: string | null;
    diamondType: string | null;
    shape: string;
    customShapeName: string | null;
    quantity: number;
    totalCarat: Decimal;
    ratePerCarat: Decimal | null;
    fixedAmount: Decimal | null;
    certificateCharge: Decimal;
    amount: Decimal;
    notes: string | null;
  }[];
  otherMaterialLines: {
    id: string;
    category: string;
    description: string;
    quantity: Decimal | null;
    weight: Decimal | null;
    rate: Decimal | null;
    amount: Decimal;
  }[];
  chargeLines: {
    id: string;
    label: string;
    isLabour: boolean;
    method: string;
    rate: Decimal;
    amount: Decimal;
  }[];
  totals: CostSheetTotals;
  linkedEstimateTotals: CostSheetTotals | null;
  auditEvents: { id: string; eventType: string; note: string | null; userName: string; createdAt: Date }[];
  revisions: { id: string; costingNumber: string; revisionNumber: number; status: CostSheetStatus }[];
};

export async function getCostSheetDetail(id: string): Promise<CostSheetDetail | null> {
  const sheet = await prisma.costSheet.findUnique({
    where: { id },
    include: {
      customer: true,
      metalLines: { orderBy: { sortOrder: "asc" } },
      diamondLines: { orderBy: { sortOrder: "asc" } },
      otherMaterialLines: { orderBy: { sortOrder: "asc" } },
      chargeLines: { orderBy: { sortOrder: "asc" } },
      auditEvents: { include: { user: true }, orderBy: { createdAt: "asc" } },
      linkedEstimate: true,
      nextVersion: true,
    },
  });
  if (!sheet) return null;

  const totals = computeCostSheetTotals(toTotalsInput(sheet));

  let linkedEstimateTotals: CostSheetTotals | null = null;
  if (sheet.linkedEstimate) {
    const est = await prisma.costSheet.findUnique({
      where: { id: sheet.linkedEstimate.id },
      include: { metalLines: true, diamondLines: true, otherMaterialLines: true, chargeLines: true },
    });
    if (est) linkedEstimateTotals = computeCostSheetTotals(toTotalsInput(est));
  }

  const revisions = await prisma.costSheet.findMany({
    where: { revisionGroupId: sheet.revisionGroupId },
    orderBy: { revisionNumber: "asc" },
    select: { id: true, costingNumber: true, revisionNumber: true, status: true },
  });

  return {
    id: sheet.id,
    costingNumber: sheet.costingNumber,
    mode: sheet.mode,
    status: sheet.status,
    costingDate: sheet.costingDate,
    jewelleryType: sheet.jewelleryType,
    itemName: sheet.itemName,
    referenceNumber: sheet.referenceNumber,
    quantity: sheet.quantity,
    sizeOrLength: sheet.sizeOrLength,
    designImageAssetId: sheet.designImageAssetId,
    notes: sheet.notes,
    customerId: sheet.customerId,
    customerName: sheet.customer?.name ?? null,
    sourceFinishedJewelleryId: sheet.sourceFinishedJewelleryId,
    sourceJobCode: sheet.sourceJobCode,
    sourceReceiptCode: sheet.sourceReceiptCode,
    sourceFinishedCode: sheet.sourceFinishedCode,
    sourceVoucherNumber: sheet.sourceVoucherNumber,
    sourceRefreshedAt: sheet.sourceRefreshedAt,
    linkedEstimateId: sheet.linkedEstimateId,
    linkedEstimateNumber: sheet.linkedEstimate?.costingNumber ?? null,
    pricingMethod: sheet.pricingMethod,
    markupPercent: new Decimal(sheet.markupPercent),
    targetMarginPercent: new Decimal(sheet.targetMarginPercent),
    manualSellingPriceOverride: sheet.manualSellingPriceOverride ? new Decimal(sheet.manualSellingPriceOverride) : null,
    isManualOverride: sheet.isManualOverride,
    discountType: sheet.discountType,
    discountValue: new Decimal(sheet.discountValue),
    gstTreatment: sheet.gstTreatment,
    gstRateId: sheet.gstRateId,
    gstRatePercentSnapshot: new Decimal(sheet.gstRatePercentSnapshot),
    priceType: sheet.priceType,
    roundingStep: new Decimal(sheet.roundingStep),
    sellingExpenseFixed: new Decimal(sheet.sellingExpenseFixed),
    sellingExpensePercent: new Decimal(sheet.sellingExpensePercent),
    quotationValidUntil: sheet.quotationValidUntil,
    quotationTerms: sheet.quotationTerms,
    revisionGroupId: sheet.revisionGroupId,
    revisionNumber: sheet.revisionNumber,
    previousVersionId: sheet.previousVersionId,
    nextVersionId: sheet.nextVersion?.id ?? null,
    finalizedAt: sheet.finalizedAt,
    archivedAt: sheet.archivedAt,
    createdAt: sheet.createdAt,
    metalLines: sheet.metalLines.map((l) => ({
      id: l.id,
      metalType: l.metalType,
      purityId: l.purityId,
      purityDisplayNameSnapshot: l.purityDisplayNameSnapshot,
      finenessPercentSnapshot: new Decimal(l.finenessPercentSnapshot),
      grossWeight: round3(l.grossWeight),
      wastagePercent: new Decimal(l.wastagePercent),
      wastageWeight: round3(l.wastageWeight),
      fineWeight: round3(l.fineWeight),
      rateBasis: l.rateBasis,
      rate: new Decimal(l.rate),
      amount: round2(l.amount),
    })),
    diamondLines: sheet.diamondLines.map((l) => ({
      id: l.id,
      sourcePolishedDiamondId: l.sourcePolishedDiamondId,
      polishedCodeSnapshot: l.polishedCodeSnapshot,
      diamondType: l.diamondType,
      shape: l.shape,
      customShapeName: l.customShapeName,
      quantity: l.quantity,
      totalCarat: round3(l.totalCarat),
      ratePerCarat: l.ratePerCarat ? new Decimal(l.ratePerCarat) : null,
      fixedAmount: l.fixedAmount ? new Decimal(l.fixedAmount) : null,
      certificateCharge: round2(l.certificateCharge),
      amount: round2(l.amount),
      notes: l.notes,
    })),
    otherMaterialLines: sheet.otherMaterialLines.map((l) => ({
      id: l.id,
      category: l.category,
      description: l.description,
      quantity: l.quantity ? round3(l.quantity) : null,
      weight: l.weight ? round3(l.weight) : null,
      rate: l.rate ? round2(l.rate) : null,
      amount: round2(l.amount),
    })),
    chargeLines: sheet.chargeLines.map((l) => ({
      id: l.id,
      label: l.label,
      isLabour: l.isLabour,
      method: l.method,
      rate: round2(l.rate),
      amount: round2(l.amount),
    })),
    totals,
    linkedEstimateTotals,
    auditEvents: sheet.auditEvents.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      note: e.note,
      userName: e.user.name,
      createdAt: e.createdAt,
    })),
    revisions: revisions.map((r) => ({ id: r.id, costingNumber: r.costingNumber, revisionNumber: r.revisionNumber, status: r.status })),
  };
}

// ---------------------------------------------------------------------------
// CSV export (Owner-only internal summary)
// ---------------------------------------------------------------------------

function csvCell(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export async function buildCostSheetsCsv(filters?: {
  mode?: CostSheetMode;
  status?: CostSheetStatus[];
  search?: string;
}): Promise<string> {
  const rows = await listCostSheets(filters);
  const header = [
    "Costing Number",
    "Mode",
    "Status",
    "Date",
    "Item",
    "Customer",
    "Reference",
    "Revision",
    "Production Cost",
    "Customer Total",
    "Estimated Profit",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.costingNumber,
        r.mode,
        r.status,
        r.costingDate.toISOString().slice(0, 10),
        r.itemName,
        r.customerName ?? "",
        r.referenceNumber ?? "",
        String(r.revisionNumber),
        r.productionCost.toFixed(2),
        r.customerTotal.toFixed(2),
        r.estimatedProfit.toFixed(2),
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n");
}
