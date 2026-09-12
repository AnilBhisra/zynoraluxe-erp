"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { requireOwner } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { parseDateOnly } from "@/lib/accounting/financialYear";
import * as costingEngine from "@/lib/costing/engine";
import { getCostingSettings } from "@/lib/costing/reports";
import { deleteJewelleryAsset, isJewelleryStorageConfigured, uploadJewelleryAsset } from "@/lib/storage/jewelleryMedia";
import {
  createActualCostingSchema,
  costSheetIdSchema,
  costingSettingsSchema,
  estimateSheetSchema,
  updateActualCostingSchema,
  updateEstimateSheetSchema,
} from "@/lib/validation/costing";

// Every single action in this file independently calls requireOwner() —
// Costing figures (cost, profit, margin, markup, internal quotation data)
// are Owner-only per the phase requirement, and this must never depend
// only on which controls the client happened to render. A Staff request
// that reaches any of these functions directly (a hand-crafted request,
// a stale cached page, dev tools) is rejected here, server-side, before
// any Phase 3/4/5 row is ever read or written.

export type CostingFormState = { error?: string; success?: boolean; id?: string; costingNumber?: string } | undefined;

function isIdempotencyConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    (error.meta.target as string[]).includes("idempotencyKey")
  );
}

function safeParseDateOnly(value: string): Date | null {
  try {
    return parseDateOnly(value);
  } catch {
    return null;
  }
}

function readJsonArray(formData: FormData, field: string): unknown[] {
  const raw = formData.get(field);
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function revalidateCosting() {
  revalidatePath("/costing");
  revalidatePath("/dashboard");
}

function pricingFieldsFromFormData(formData: FormData) {
  return {
    pricingMethod: formData.get("pricingMethod") || "MARKUP_ON_COST",
    markupPercent: formData.get("markupPercent") || "0",
    targetMarginPercent: formData.get("targetMarginPercent") || "0",
    manualSellingPriceOverride: formData.get("manualSellingPriceOverride") || undefined,
    discountType: formData.get("discountType") || "NONE",
    discountValue: formData.get("discountValue") || "0",
    gstTreatment: formData.get("gstTreatment") || "NONE",
    gstRateId: formData.get("gstRateId") || "",
    priceType: formData.get("priceType") || "EXCLUSIVE",
    roundingStep: formData.get("roundingStep") || "0",
    sellingExpenseFixed: formData.get("sellingExpenseFixed") || "0",
    sellingExpensePercent: formData.get("sellingExpensePercent") || "0",
    quotationTerms: formData.get("quotationTerms") || "",
  };
}

// ---------------------------------------------------------------------------
// Create — Actual costing (from a real, Completed Phase 4 output)
// ---------------------------------------------------------------------------

export async function createActualCostingAction(
  _prevState: CostingFormState,
  formData: FormData
): Promise<CostingFormState> {
  const user = await requireOwner();

  const parsed = createActualCostingSchema.safeParse({
    ...pricingFieldsFromFormData(formData),
    sourceFinishedJewelleryId: formData.get("sourceFinishedJewelleryId"),
    costingDate: formData.get("costingDate"),
    quantity: formData.get("quantity") || undefined,
    sizeOrLength: formData.get("sizeOrLength") || "",
    customerId: formData.get("customerId") || "",
    notes: formData.get("notes") || "",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;
  const costingDate = safeParseDateOnly(data.costingDate);
  if (!costingDate) return { error: "Enter a valid costing date." };

  if (data.idempotencyKey) {
    const existing = await prisma.costSheet.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, id: existing.id, costingNumber: existing.costingNumber };
  }

  const fy = await getCompanyFySettings();
  const settings = await getCostingSettings();

  try {
    const sheet = await prisma.$transaction((tx) =>
      costingEngine.createActualCostSheet(tx, {
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        sourceFinishedJewelleryId: data.sourceFinishedJewelleryId,
        costingDate,
        quantity: data.quantity,
        sizeOrLength: data.sizeOrLength || null,
        customerId: data.customerId || null,
        notes: data.notes || null,
        pricingMethod: data.pricingMethod,
        markupPercent: data.markupPercent,
        targetMarginPercent: data.targetMarginPercent,
        manualSellingPriceOverride: data.manualSellingPriceOverride,
        discountType: data.discountType,
        discountValue: data.discountValue,
        gstTreatment: data.gstTreatment,
        gstRateId: data.gstRateId || null,
        priceType: data.priceType,
        roundingStep: data.roundingStep,
        sellingExpenseFixed: data.sellingExpenseFixed,
        sellingExpensePercent: data.sellingExpensePercent,
        quotationTerms: data.quotationTerms || settings.quotationTerms,
        validityDays: settings.defaultValidityDays,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
      })
    );
    revalidateCosting();
    return { success: true, id: sheet.id, costingNumber: sheet.costingNumber };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.costSheet.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return { success: true, id: existing.id, costingNumber: existing.costingNumber };
    }
    if (error instanceof costingEngine.PostingError) return { error: error.message };
    console.error("createActualCostingAction failed:", error);
    return { error: "Could not create this costing. Please try again." };
  }
}

export async function updateActualCostingAction(
  _prevState: CostingFormState,
  formData: FormData
): Promise<CostingFormState> {
  await requireOwner();

  const parsed = updateActualCostingSchema.safeParse({
    ...pricingFieldsFromFormData(formData),
    costSheetId: formData.get("costSheetId"),
    costingDate: formData.get("costingDate"),
    quantity: formData.get("quantity") || "1",
    sizeOrLength: formData.get("sizeOrLength") || "",
    customerId: formData.get("customerId") || "",
    notes: formData.get("notes") || "",
    linkedEstimateId: formData.get("linkedEstimateId") || "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const data = parsed.data;
  const costingDate = safeParseDateOnly(data.costingDate);
  if (!costingDate) return { error: "Enter a valid costing date." };

  const fy = await getCompanyFySettings();
  const settings = await getCostingSettings();
  const user = await requireOwner();

  try {
    const sheet = await prisma.$transaction((tx) =>
      costingEngine.updateActualCostSheetFields(tx, {
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        costSheetId: data.costSheetId,
        costingDate,
        quantity: data.quantity,
        sizeOrLength: data.sizeOrLength || null,
        customerId: data.customerId || null,
        notes: data.notes || null,
        linkedEstimateId: data.linkedEstimateId || null,
        pricingMethod: data.pricingMethod,
        markupPercent: data.markupPercent,
        targetMarginPercent: data.targetMarginPercent,
        manualSellingPriceOverride: data.manualSellingPriceOverride,
        discountType: data.discountType,
        discountValue: data.discountValue,
        gstTreatment: data.gstTreatment,
        gstRateId: data.gstRateId || null,
        priceType: data.priceType,
        roundingStep: data.roundingStep,
        sellingExpenseFixed: data.sellingExpenseFixed,
        sellingExpensePercent: data.sellingExpensePercent,
        quotationTerms: data.quotationTerms || null,
        validityDays: settings.defaultValidityDays,
        userId: user.id,
      })
    );
    revalidateCosting();
    return { success: true, id: sheet.id };
  } catch (error) {
    if (error instanceof costingEngine.PostingError) return { error: error.message };
    console.error("updateActualCostingAction failed:", error);
    return { error: "Could not update this costing. Please try again." };
  }
}

export async function refreshActualCostingAction(
  _prevState: CostingFormState,
  formData: FormData
): Promise<CostingFormState> {
  const user = await requireOwner();
  const parsed = costSheetIdSchema.safeParse({ costSheetId: formData.get("costSheetId") });
  if (!parsed.success) return { error: "Missing costing." };

  try {
    await prisma.$transaction((tx) =>
      costingEngine.refreshActualCostSheetFromSource(tx, { costSheetId: parsed.data.costSheetId, userId: user.id })
    );
  } catch (error) {
    if (error instanceof costingEngine.PostingError) return { error: error.message };
    console.error("refreshActualCostingAction failed:", error);
    return { error: "Could not refresh this costing. Please try again." };
  }
  revalidateCosting();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Create / update — Estimate costing
// ---------------------------------------------------------------------------

function estimateFieldsFromFormData(formData: FormData) {
  return {
    ...pricingFieldsFromFormData(formData),
    costingDate: formData.get("costingDate"),
    jewelleryType: formData.get("jewelleryType"),
    itemName: formData.get("itemName"),
    referenceNumber: formData.get("referenceNumber") || "",
    quantity: formData.get("quantity") || "1",
    sizeOrLength: formData.get("sizeOrLength") || "",
    designImageAssetId: formData.get("designImageAssetId") || "",
    customerId: formData.get("customerId") || "",
    notes: formData.get("notes") || "",
    linkedEstimateId: formData.get("linkedEstimateId") || "",
    metalLines: readJsonArray(formData, "metalLinesJson"),
    diamondLines: readJsonArray(formData, "diamondLinesJson"),
    otherMaterialLines: readJsonArray(formData, "otherMaterialLinesJson"),
    chargeLines: readJsonArray(formData, "chargeLinesJson"),
  };
}

export async function createEstimateCostingAction(
  _prevState: CostingFormState,
  formData: FormData
): Promise<CostingFormState> {
  const user = await requireOwner();

  const parsed = estimateSheetSchema.safeParse({
    ...estimateFieldsFromFormData(formData),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const data = parsed.data;
  const costingDate = safeParseDateOnly(data.costingDate);
  if (!costingDate) return { error: "Enter a valid costing date." };

  if (data.idempotencyKey) {
    const existing = await prisma.costSheet.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, id: existing.id, costingNumber: existing.costingNumber };
  }

  const fy = await getCompanyFySettings();
  const settings = await getCostingSettings();

  try {
    const sheet = await prisma.$transaction((tx) =>
      costingEngine.createEstimateCostSheet(tx, {
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        costingDate,
        jewelleryType: data.jewelleryType,
        itemName: data.itemName,
        referenceNumber: data.referenceNumber || null,
        quantity: data.quantity,
        sizeOrLength: data.sizeOrLength || null,
        designImageAssetId: data.designImageAssetId || null,
        customerId: data.customerId || null,
        notes: data.notes || null,
        linkedEstimateId: data.linkedEstimateId || null,
        metalLines: data.metalLines,
        diamondLines: data.diamondLines,
        otherMaterialLines: data.otherMaterialLines,
        chargeLines: data.chargeLines,
        pricingMethod: data.pricingMethod,
        markupPercent: data.markupPercent,
        targetMarginPercent: data.targetMarginPercent,
        manualSellingPriceOverride: data.manualSellingPriceOverride,
        discountType: data.discountType,
        discountValue: data.discountValue,
        gstTreatment: data.gstTreatment,
        gstRateId: data.gstRateId || null,
        priceType: data.priceType,
        roundingStep: data.roundingStep,
        sellingExpenseFixed: data.sellingExpenseFixed,
        sellingExpensePercent: data.sellingExpensePercent,
        quotationTerms: data.quotationTerms || settings.quotationTerms,
        validityDays: settings.defaultValidityDays,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
      })
    );
    revalidateCosting();
    return { success: true, id: sheet.id, costingNumber: sheet.costingNumber };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.costSheet.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return { success: true, id: existing.id, costingNumber: existing.costingNumber };
    }
    if (error instanceof costingEngine.PostingError) return { error: error.message };
    console.error("createEstimateCostingAction failed:", error);
    return { error: "Could not create this costing. Please try again." };
  }
}

export async function updateEstimateCostingAction(
  _prevState: CostingFormState,
  formData: FormData
): Promise<CostingFormState> {
  const user = await requireOwner();

  const parsed = updateEstimateSheetSchema.safeParse({
    ...estimateFieldsFromFormData(formData),
    costSheetId: formData.get("costSheetId"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const data = parsed.data;
  const costingDate = safeParseDateOnly(data.costingDate);
  if (!costingDate) return { error: "Enter a valid costing date." };

  const fy = await getCompanyFySettings();
  const settings = await getCostingSettings();

  try {
    const sheet = await prisma.$transaction((tx) =>
      costingEngine.updateEstimateCostSheet(tx, {
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        costSheetId: data.costSheetId,
        costingDate,
        jewelleryType: data.jewelleryType,
        itemName: data.itemName,
        referenceNumber: data.referenceNumber || null,
        quantity: data.quantity,
        sizeOrLength: data.sizeOrLength || null,
        designImageAssetId: data.designImageAssetId || null,
        customerId: data.customerId || null,
        notes: data.notes || null,
        linkedEstimateId: data.linkedEstimateId || null,
        metalLines: data.metalLines,
        diamondLines: data.diamondLines,
        otherMaterialLines: data.otherMaterialLines,
        chargeLines: data.chargeLines,
        pricingMethod: data.pricingMethod,
        markupPercent: data.markupPercent,
        targetMarginPercent: data.targetMarginPercent,
        manualSellingPriceOverride: data.manualSellingPriceOverride,
        discountType: data.discountType,
        discountValue: data.discountValue,
        gstTreatment: data.gstTreatment,
        gstRateId: data.gstRateId || null,
        priceType: data.priceType,
        roundingStep: data.roundingStep,
        sellingExpenseFixed: data.sellingExpenseFixed,
        sellingExpensePercent: data.sellingExpensePercent,
        quotationTerms: data.quotationTerms || settings.quotationTerms,
        validityDays: settings.defaultValidityDays,
        userId: user.id,
      })
    );
    revalidateCosting();
    return { success: true, id: sheet.id };
  } catch (error) {
    if (error instanceof costingEngine.PostingError) return { error: error.message };
    console.error("updateEstimateCostingAction failed:", error);
    return { error: "Could not update this costing. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function finalizeCostingAction(
  _prevState: CostingFormState,
  formData: FormData
): Promise<CostingFormState> {
  const user = await requireOwner();
  const parsed = costSheetIdSchema.safeParse({ costSheetId: formData.get("costSheetId") });
  if (!parsed.success) return { error: "Missing costing." };

  try {
    await prisma.$transaction((tx) => costingEngine.finalizeCostSheet(tx, { costSheetId: parsed.data.costSheetId, userId: user.id }));
  } catch (error) {
    if (error instanceof costingEngine.PostingError) return { error: error.message };
    console.error("finalizeCostingAction failed:", error);
    return { error: "Could not finalize this costing. Please try again." };
  }
  revalidateCosting();
  return { success: true };
}

export async function reviseCostingAction(
  _prevState: CostingFormState,
  formData: FormData
): Promise<CostingFormState> {
  const user = await requireOwner();
  const parsed = costSheetIdSchema.safeParse({ costSheetId: formData.get("costSheetId") });
  if (!parsed.success) return { error: "Missing costing." };

  try {
    const revision = await prisma.$transaction((tx) =>
      costingEngine.reviseCostSheet(tx, { costSheetId: parsed.data.costSheetId, userId: user.id })
    );
    revalidateCosting();
    return { success: true, id: revision.id, costingNumber: revision.costingNumber };
  } catch (error) {
    if (error instanceof costingEngine.PostingError) return { error: error.message };
    console.error("reviseCostingAction failed:", error);
    return { error: "Could not create a revision. Please try again." };
  }
}

export async function archiveCostingAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const parsed = costSheetIdSchema.safeParse({ costSheetId: formData.get("costSheetId") });
  if (!parsed.success) return;
  try {
    await prisma.$transaction((tx) => costingEngine.archiveCostSheet(tx, { costSheetId: parsed.data.costSheetId, userId: user.id }));
  } catch (error) {
    console.error("archiveCostingAction failed:", error);
  }
  revalidateCosting();
}

export async function unarchiveCostingAction(formData: FormData): Promise<void> {
  const user = await requireOwner();
  const parsed = costSheetIdSchema.safeParse({ costSheetId: formData.get("costSheetId") });
  if (!parsed.success) return;
  try {
    await prisma.$transaction((tx) => costingEngine.unarchiveCostSheet(tx, { costSheetId: parsed.data.costSheetId, userId: user.id }));
  } catch (error) {
    console.error("unarchiveCostingAction failed:", error);
  }
  revalidateCosting();
}

export async function deleteDraftCostingAction(formData: FormData): Promise<void> {
  await requireOwner();
  const parsed = costSheetIdSchema.safeParse({ costSheetId: formData.get("costSheetId") });
  if (!parsed.success) return;
  try {
    await prisma.$transaction((tx) => costingEngine.deleteDraftCostSheet(tx, { costSheetId: parsed.data.costSheetId }));
  } catch (error) {
    console.error("deleteDraftCostingAction failed:", error);
  }
  revalidateCosting();
}

// ---------------------------------------------------------------------------
// Costing Settings (Owner-only)
// ---------------------------------------------------------------------------

export async function saveCostingSettingsAction(
  _prevState: CostingFormState,
  formData: FormData
): Promise<CostingFormState> {
  const user = await requireOwner();

  const parsed = costingSettingsSchema.safeParse({
    defaultPricingMethod: formData.get("defaultPricingMethod") || "MARKUP_ON_COST",
    defaultMarkupPercent: formData.get("defaultMarkupPercent") || "0",
    defaultTargetMarginPercent: formData.get("defaultTargetMarginPercent") || "0",
    defaultDiscountType: formData.get("defaultDiscountType") || "NONE",
    defaultDiscountValue: formData.get("defaultDiscountValue") || "0",
    defaultGstTreatment: formData.get("defaultGstTreatment") || "NONE",
    defaultGstRateId: formData.get("defaultGstRateId") || "",
    defaultPriceType: formData.get("defaultPriceType") || "EXCLUSIVE",
    defaultValidityDays: formData.get("defaultValidityDays") || "15",
    defaultRoundingStep: formData.get("defaultRoundingStep") || "0",
    defaultSellingExpenseFixed: formData.get("defaultSellingExpenseFixed") || "0",
    defaultSellingExpensePercent: formData.get("defaultSellingExpensePercent") || "0",
    quotationTerms: formData.get("quotationTerms") || "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const data = parsed.data;

  try {
    await prisma.costingSettings.upsert({
      where: { id: "default" },
      create: {
        id: "default",
        defaultPricingMethod: data.defaultPricingMethod,
        defaultMarkupPercent: data.defaultMarkupPercent.toFixed(3),
        defaultTargetMarginPercent: data.defaultTargetMarginPercent.toFixed(3),
        defaultDiscountType: data.defaultDiscountType,
        defaultDiscountValue: data.defaultDiscountValue.toFixed(2),
        defaultGstTreatment: data.defaultGstTreatment,
        defaultGstRateId: data.defaultGstTreatment === "NONE" ? null : data.defaultGstRateId || null,
        defaultPriceType: data.defaultPriceType,
        defaultValidityDays: data.defaultValidityDays,
        defaultRoundingStep: data.defaultRoundingStep.toFixed(2),
        defaultSellingExpenseFixed: data.defaultSellingExpenseFixed.toFixed(2),
        defaultSellingExpensePercent: data.defaultSellingExpensePercent.toFixed(3),
        quotationTerms: data.quotationTerms || null,
        updatedByUserId: user.id,
      },
      update: {
        defaultPricingMethod: data.defaultPricingMethod,
        defaultMarkupPercent: data.defaultMarkupPercent.toFixed(3),
        defaultTargetMarginPercent: data.defaultTargetMarginPercent.toFixed(3),
        defaultDiscountType: data.defaultDiscountType,
        defaultDiscountValue: data.defaultDiscountValue.toFixed(2),
        defaultGstTreatment: data.defaultGstTreatment,
        defaultGstRateId: data.defaultGstTreatment === "NONE" ? null : data.defaultGstRateId || null,
        defaultPriceType: data.defaultPriceType,
        defaultValidityDays: data.defaultValidityDays,
        defaultRoundingStep: data.defaultRoundingStep.toFixed(2),
        defaultSellingExpenseFixed: data.defaultSellingExpenseFixed.toFixed(2),
        defaultSellingExpensePercent: data.defaultSellingExpensePercent.toFixed(3),
        quotationTerms: data.quotationTerms || null,
        updatedByUserId: user.id,
      },
    });
  } catch (error) {
    console.error("saveCostingSettingsAction failed:", error);
    return { error: "Could not save Costing Settings. Please try again." };
  }
  revalidateCosting();
  return { success: true };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

export async function exportCostSheetsCsvAction(formData: FormData): Promise<{ csv: string } | { error: string }> {
  await requireOwner();
  const { buildCostSheetsCsv } = await import("@/lib/costing/reports");
  const mode = formData.get("mode");
  const search = formData.get("search");
  try {
    const csv = await buildCostSheetsCsv({
      mode: mode === "ACTUAL" || mode === "ESTIMATE" ? mode : undefined,
      search: typeof search === "string" && search ? search : undefined,
    });
    return { csv };
  } catch (error) {
    console.error("exportCostSheetsCsvAction failed:", error);
    return { error: "Could not export CSV." };
  }
}

// ---------------------------------------------------------------------------
// Design-photo upload/delete (Estimate mode) — Owner-only wrappers around
// the shared src/lib/storage/jewelleryMedia.ts helpers. Deliberately NOT
// the same uploadJewelleryPhotoAction/deleteJewelleryPhotoAction Jewellery
// Jobs use (those call requireUser(), correct there since Staff legitimately
// creates Jewellery Jobs) — every Costing action independently enforces
// Owner-only, including this one.
// ---------------------------------------------------------------------------

export type CostingUploadFormState = { error?: string; success?: boolean; assetId?: string } | undefined;

export async function uploadCostingPhotoAction(
  _prevState: CostingUploadFormState,
  formData: FormData
): Promise<CostingUploadFormState> {
  await requireOwner();

  if (!isJewelleryStorageConfigured()) {
    return { error: "Photo upload is not available yet — storage is not configured for this deployment." };
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload." };
  }

  try {
    const { assetId } = await uploadJewelleryAsset("costing-estimate", file);
    return { success: true, assetId };
  } catch (error) {
    console.error("uploadCostingPhotoAction failed:", error);
    return { error: error instanceof Error ? error.message : "Upload failed. Please try again." };
  }
}

export async function deleteCostingPhotoAction(formData: FormData): Promise<void> {
  await requireOwner();
  const assetId = formData.get("assetId");
  if (typeof assetId !== "string" || !assetId) return;
  await deleteJewelleryAsset(assetId).catch(() => false);
}
