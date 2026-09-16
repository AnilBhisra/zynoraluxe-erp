"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { parseDateOnly } from "@/lib/accounting/financialYear";
import * as jewelleryPosting from "@/lib/jewellery/posting";
import {
  deleteJewelleryAsset,
  isJewelleryStorageConfigured,
  uploadJewelleryAsset,
  type JewelleryAssetCategory,
} from "@/lib/storage/jewelleryMedia";
import {
  cancelJewelleryJobSchema,
  createJewelleryJobSchema,
  issueMaterialsSchema,
  markJobInProgressSchema,
  needsCorrectionSchema,
  overrideFinishedAllocationSchema,
  receiveFinishedJewellerySchema,
} from "@/lib/validation/jewellery";

export type JewelleryFormState = { error?: string; success?: boolean; code?: string } | undefined;

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

function revalidateJewellery() {
  revalidatePath("/jewellery-jobs");
  revalidatePath("/diamond");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
}

// ---------------------------------------------------------------------------
// Media upload/delete (optional — only usable when storage is configured)
// ---------------------------------------------------------------------------

export type UploadFormState = { error?: string; success?: boolean; assetId?: string } | undefined;

export async function uploadJewelleryPhotoAction(
  _prevState: UploadFormState,
  formData: FormData
): Promise<UploadFormState> {
  await requireUser();

  if (!isJewelleryStorageConfigured()) {
    return { error: "Photo upload is not available yet — storage is not configured for this deployment." };
  }

  const file = formData.get("file");
  const category = formData.get("category");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a file to upload." };
  }
  if (typeof category !== "string") {
    return { error: "Missing upload category." };
  }

  try {
    const { assetId } = await uploadJewelleryAsset(category as JewelleryAssetCategory, file);
    return { success: true, assetId };
  } catch (error) {
    console.error("uploadJewelleryPhotoAction failed:", error);
    return { error: error instanceof Error ? error.message : "Upload failed. Please try again." };
  }
}

export async function deleteJewelleryPhotoAction(formData: FormData): Promise<void> {
  await requireUser();
  const assetId = formData.get("assetId");
  if (typeof assetId !== "string" || !assetId) return;
  await deleteJewelleryAsset(assetId).catch(() => false);
}

// ---------------------------------------------------------------------------
// Create Jewellery Job (Draft)
// ---------------------------------------------------------------------------

export async function createJewelleryJobAction(
  _prevState: JewelleryFormState,
  formData: FormData
): Promise<JewelleryFormState> {
  const user = await requireUser();

  const parsed = createJewelleryJobSchema.safeParse({
    customerId: formData.get("customerId") || "",
    customerReference: formData.get("customerReference") || "",
    jewelleryType: formData.get("jewelleryType"),
    designName: formData.get("designName"),
    designImageAssetId: formData.get("designImageAssetId") || "",
    karigarId: formData.get("karigarId"),
    issueDate: formData.get("issueDate"),
    expectedDeliveryDate: formData.get("expectedDeliveryDate") || "",
    notes: formData.get("notes") || "",
    jewellerySize: formData.get("jewellerySize") || "",
    quantity: formData.get("quantity") || "1",
    targetMetalType: formData.get("targetMetalType") || undefined,
    targetPurityId: formData.get("targetPurityId") || "",
    targetFinishedWeight: formData.get("targetFinishedWeight") || undefined,
    specialInstructions: formData.get("specialInstructions") || "",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const issueDate = safeParseDateOnly(data.issueDate);
  if (!issueDate) return { error: "Enter a valid issue date." };
  const expectedDeliveryDate = data.expectedDeliveryDate ? safeParseDateOnly(data.expectedDeliveryDate) : null;

  if (data.idempotencyKey) {
    const existing = await prisma.jewelleryJob.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, code: existing.jobCode };
  }

  try {
    const job = await prisma.$transaction((tx) =>
      jewelleryPosting.createJewelleryJob(tx, {
        customerId: data.customerId || null,
        customerReference: data.customerReference || null,
        jewelleryType: data.jewelleryType,
        designName: data.designName,
        designImageAssetId: data.designImageAssetId || null,
        karigarId: data.karigarId,
        issueDate,
        expectedDeliveryDate,
        notes: data.notes || null,
        jewellerySize: data.jewellerySize || null,
        quantity: data.quantity,
        targetMetalType: data.targetMetalType ?? null,
        targetPurityId: data.targetPurityId || null,
        targetFinishedWeight: data.targetFinishedWeight ?? null,
        specialInstructions: data.specialInstructions || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
      })
    );
    revalidateJewellery();
    return { success: true, code: job.jobCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.jewelleryJob.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return { success: true, code: existing.jobCode };
    }
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("createJewelleryJobAction failed:", error);
    return { error: "Could not create this job. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Issue Materials
// ---------------------------------------------------------------------------

export async function issueMaterialsAction(
  _prevState: JewelleryFormState,
  formData: FormData
): Promise<JewelleryFormState> {
  const user = await requireUser();

  const parsed = issueMaterialsSchema.safeParse({
    jobId: formData.get("jobId"),
    issueDate: formData.get("issueDate"),
    metalLines: readJsonArray(formData, "metalLinesJson"),
    polishedDiamondIds: readJsonArray(formData, "polishedDiamondIdsJson"),
    otherMaterialLines: readJsonArray(formData, "otherMaterialLinesJson"),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const issueDate = safeParseDateOnly(data.issueDate);
  if (!issueDate) return { error: "Enter a valid issue date." };

  const fy = await getCompanyFySettings();

  try {
    const job = await prisma.$transaction((tx) =>
      jewelleryPosting.issueMaterialsToJewelleryJob(tx, {
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        jobId: data.jobId,
        issueDate,
        metalLines: data.metalLines,
        polishedDiamondIds: data.polishedDiamondIds,
        otherMaterialLines: data.otherMaterialLines,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
      }),
      // A job issuing many metal lines and/or many individual diamonds
      // performs one round trip per line/diamond inside this same
      // transaction — comfortably inside Prisma's 5s default for a
      // typical few-line issue, but a job with a large diamond count
      // (e.g. many small stones) can approach it under real network
      // latency. Same headroom as receiveFinishedJewelleryAction.
      { timeout: 20000 }
    );
    revalidateJewellery();
    return { success: true, code: job.jobCode };
  } catch (error) {
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("issueMaterialsAction failed:", error);
    return { error: "Could not issue these materials. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Mark In Progress / Needs Correction (label-only status changes)
// ---------------------------------------------------------------------------

export async function markJewelleryJobInProgressAction(formData: FormData): Promise<void> {
  await requireUser();
  const parsed = markJobInProgressSchema.safeParse({ jobId: formData.get("jobId") });
  if (!parsed.success) return;
  await prisma.$transaction((tx) => jewelleryPosting.markJewelleryJobInProgress(tx, parsed.data.jobId));
  revalidateJewellery();
}

export async function setJewelleryJobNeedsCorrectionAction(formData: FormData): Promise<void> {
  await requireUser();
  const parsed = needsCorrectionSchema.safeParse({
    jobId: formData.get("jobId"),
    flag: formData.get("flag") || "false",
  });
  if (!parsed.success) return;
  try {
    await prisma.$transaction((tx) =>
      jewelleryPosting.setJewelleryJobNeedsCorrection(tx, parsed.data.jobId, parsed.data.flag)
    );
  } catch (error) {
    console.error("setJewelleryJobNeedsCorrectionAction failed:", error);
  }
  revalidateJewellery();
}

// ---------------------------------------------------------------------------
// Cancel Job (Owner-only)
// ---------------------------------------------------------------------------

export async function cancelJewelleryJobAction(
  _prevState: JewelleryFormState,
  formData: FormData
): Promise<JewelleryFormState> {
  const user = await requireOwner();

  const parsed = cancelJewelleryJobSchema.safeParse({
    jobId: formData.get("jobId"),
    cancellationReason: formData.get("cancellationReason"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const fy = await getCompanyFySettings();

  try {
    await prisma.$transaction(
      (tx) =>
        jewelleryPosting.cancelJewelleryJob(tx, {
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
          jobId: parsed.data.jobId,
          cancelledByUserId: user.id,
          cancellationReason: parsed.data.cancellationReason,
        }),
      // Same reasoning as issueMaterialsAction — reversing many metal/
      // diamond lines is one round trip per line inside this transaction.
      { timeout: 20000 }
    );
  } catch (error) {
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("cancelJewelleryJobAction failed:", error);
    return { error: "Could not cancel this job. Please try again." };
  }

  revalidateJewellery();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Receive Finished Jewellery
// ---------------------------------------------------------------------------

export async function receiveFinishedJewelleryAction(
  _prevState: JewelleryFormState,
  formData: FormData
): Promise<JewelleryFormState> {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";

  const parsed = receiveFinishedJewellerySchema.safeParse({
    jobId: formData.get("jobId"),
    receiveDate: formData.get("receiveDate"),
    outputs: readJsonArray(formData, "outputsJson"),
    diamondResolutions: readJsonArray(formData, "diamondResolutionsJson"),
    returnedMetalLines: readJsonArray(formData, "returnedMetalLinesJson"),
    scrapMetalLines: readJsonArray(formData, "scrapMetalLinesJson"),
    karigarAddedFineWeight: formData.get("karigarAddedFineWeight") || "0",
    karigarAddedCost: formData.get("karigarAddedCost") || "0",
    companyAlloyGrossWeight: formData.get("companyAlloyGrossWeight") || "0",
    karigarAlloyGrossWeight: formData.get("karigarAlloyGrossWeight") || "0",
    karigarAlloyCost: formData.get("karigarAlloyCost") || "0",
    includedAlloyGrossWeight: formData.get("includedAlloyGrossWeight") || "0",
    labourCharge: formData.get("labourCharge") || "0",
    makingCharge: formData.get("makingCharge") || "0",
    settingCharge: formData.get("settingCharge") || "0",
    platingCharge: formData.get("platingCharge") || "0",
    otherExpense: formData.get("otherExpense") || "0",
    markJobComplete: formData.get("markJobComplete") || "false",
    isAbnormalLoss: formData.get("isAbnormalLoss") || "false",
    abnormalLossReason: formData.get("abnormalLossReason") || "",
    notes: formData.get("notes") || "",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  // Abnormal-loss classification is Owner-only, and so is marking a
  // diamond damaged/lost (both are exceptional-discrepancy overrides) —
  // enforced here, not just by which controls the UI renders for Staff.
  if (!isOwner && data.isAbnormalLoss) {
    return { error: "Only the Owner can classify a loss as abnormal." };
  }
  if (!isOwner && data.diamondResolutions.some((r) => r.resolution === "DAMAGED_LOST")) {
    return { error: "Only the Owner can mark a diamond damaged/lost." };
  }

  const receiveDate = safeParseDateOnly(data.receiveDate);
  if (!receiveDate) return { error: "Enter a valid receive date." };

  const fy = await getCompanyFySettings();

  if (data.idempotencyKey) {
    const existing = await prisma.jewelleryReceipt.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, code: existing.receiptCode };
  }

  try {
    const result = await prisma.$transaction((tx) =>
      jewelleryPosting.receiveFinishedJewellery(tx, {
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        jobId: data.jobId,
        receiveDate,
        outputs: data.outputs,
        diamondResolutions: data.diamondResolutions,
        returnedMetalLines: data.returnedMetalLines,
        scrapMetalLines: data.scrapMetalLines,
        karigarAddedFineWeight: data.karigarAddedFineWeight,
        karigarAddedCost: data.karigarAddedCost,
        alloy: {
          companyGrossWeight: data.companyAlloyGrossWeight,
          karigarGrossWeight: data.karigarAlloyGrossWeight,
          karigarCost: data.karigarAlloyCost,
          includedGrossWeight: data.includedAlloyGrossWeight,
        },
        labourCharge: data.labourCharge,
        makingCharge: data.makingCharge,
        settingCharge: data.settingCharge,
        platingCharge: data.platingCharge,
        otherExpense: data.otherExpense,
        markJobComplete: data.markJobComplete,
        isAbnormalLoss: data.isAbnormalLoss,
        abnormalLossReason: data.abnormalLossReason || null,
        notes: data.notes || null,
        damagedLostByUserId: user.id,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
      }),
      // This posting function can issue many sequential queries in one
      // transaction (per-purity return/scrap validation and movements,
      // per-output consumed-out movements, other-material reallocation
      // across every prior output) — comfortably inside Prisma's 5s
      // default on a fast connection, but real network latency to a
      // remote Postgres can push a receipt with several return/scrap
      // lines and multiple outputs close to or past it. Give this one
      // transaction more headroom rather than risk an otherwise-valid
      // receipt failing to commit under real-world latency.
      { timeout: 20000 }
    );
    revalidateJewellery();
    return { success: true, code: result.receipt.receiptCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.jewelleryReceipt.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return { success: true, code: existing.receiptCode };
    }
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("receiveFinishedJewelleryAction failed:", error);
    return { error: "Could not save this receipt. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Owner-authorized cost allocation override
// ---------------------------------------------------------------------------

export async function overrideFinishedAllocationAction(
  _prevState: JewelleryFormState,
  formData: FormData
): Promise<JewelleryFormState> {
  await requireOwner();

  const parsed = overrideFinishedAllocationSchema.safeParse({
    receiptId: formData.get("receiptId"),
    reason: formData.get("reason"),
    adjustments: readJsonArray(formData, "adjustmentsJson"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  try {
    await prisma.$transaction((tx) =>
      jewelleryPosting.overrideFinishedJewelleryAllocation(tx, {
        receiptId: parsed.data.receiptId,
        reason: parsed.data.reason,
        adjustments: parsed.data.adjustments,
      })
    );
  } catch (error) {
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("overrideFinishedAllocationAction failed:", error);
    return { error: "Could not save this cost override. Please try again." };
  }

  revalidateJewellery();
  return { success: true };
}
