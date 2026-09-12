import "server-only";

import { prisma } from "@/lib/db/prisma";
import { Decimal, round2 } from "@/lib/accounting/money";
import { round3 } from "@/lib/diamond/allocation";
import { computeCostSheetTotals } from "@/lib/costing/calculations";

/**
 * The ONE place that decides what a customer is allowed to see from a
 * finalized costing. Deliberately a separate, small, easy-to-audit file:
 * anyone reviewing "can a customer ever see our cost or profit?" only
 * needs to read this one function, not trace it through the full Owner
 * detail view. This type is exhaustive — it has NO field for material
 * cost, labour cost, markup, margin, profit, or any Phase 3/4 source
 * reference. Never add one.
 */
export type CustomerQuotationView = {
  costingNumber: string;
  costingDate: Date;
  status: "FINALIZED" | "ARCHIVED";
  quotationValidUntil: Date | null;
  itemName: string;
  jewelleryType: string;
  referenceNumber: string | null;
  quantity: number;
  sizeOrLength: string | null;
  designImageAssetId: string | null;
  notes: string | null;
  customerName: string | null;
  metalSummary: { metalType: string; purityDisplayName: string; grossWeight: Decimal }[];
  diamondSummary: { shape: string; quantity: number; totalCarat: Decimal }[];
  sellingValueBeforeDiscount: Decimal;
  discountAmount: Decimal;
  taxableSellingValue: Decimal;
  gstTreatment: "NONE" | "CGST_SGST" | "IGST";
  gstRatePercent: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  customerTotal: Decimal;
  quotationTerms: string | null;
};

export async function getCustomerQuotationView(costSheetId: string): Promise<CustomerQuotationView | null> {
  const sheet = await prisma.costSheet.findUnique({
    where: { id: costSheetId },
    include: { customer: true, metalLines: true, diamondLines: true, otherMaterialLines: true, chargeLines: true },
  });
  if (!sheet) return null;
  if (sheet.status !== "FINALIZED" && sheet.status !== "ARCHIVED") return null;

  const totals = computeCostSheetTotals({
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
  });

  return {
    costingNumber: sheet.costingNumber,
    costingDate: sheet.costingDate,
    status: sheet.status as "FINALIZED" | "ARCHIVED",
    quotationValidUntil: sheet.quotationValidUntil,
    itemName: sheet.itemName,
    jewelleryType: sheet.jewelleryType,
    referenceNumber: sheet.referenceNumber,
    quantity: sheet.quantity,
    sizeOrLength: sheet.sizeOrLength,
    designImageAssetId: sheet.designImageAssetId,
    notes: sheet.notes,
    customerName: sheet.customer?.name ?? null,
    metalSummary: sheet.metalLines.map((l) => ({
      metalType: l.metalType,
      purityDisplayName: l.purityDisplayNameSnapshot,
      grossWeight: round3(l.grossWeight),
    })),
    diamondSummary: sheet.diamondLines.map((l) => ({
      shape: l.shape,
      quantity: l.quantity,
      totalCarat: round3(l.totalCarat),
    })),
    sellingValueBeforeDiscount: totals.sellingValueBeforeDiscount,
    discountAmount: totals.discountAmount,
    taxableSellingValue: totals.taxableSellingValue,
    gstTreatment: sheet.gstTreatment,
    gstRatePercent: new Decimal(sheet.gstRatePercentSnapshot),
    cgst: totals.cgst,
    sgst: totals.sgst,
    igst: totals.igst,
    customerTotal: round2(totals.customerTotal),
    quotationTerms: sheet.quotationTerms,
  };
}
