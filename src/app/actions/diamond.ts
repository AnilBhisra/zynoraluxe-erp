"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { parseDateOnly } from "@/lib/accounting/financialYear";
import * as diamondPosting from "@/lib/diamond/posting";
import {
  deleteDiamondAsset,
  isDiamondStorageConfigured,
  uploadDiamondAsset,
  type DiamondAssetCategory,
} from "@/lib/storage/diamondMedia";
import {
  cancelJobSchema,
  issueRoughSchema,
  markJobInProgressSchema,
  overridePolishedAllocationSchema,
  overrideRoughAllocationSchema,
  receivePolishedSchema,
  recutPolishedSchema,
  roughPurchaseSchema,
} from "@/lib/validation/diamond";

export type DiamondFormState = { error?: string; success?: boolean; code?: string } | undefined;

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

function revalidateDiamond() {
  revalidatePath("/diamond");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
}

// ---------------------------------------------------------------------------
// Media upload (optional — only usable when storage is configured)
// ---------------------------------------------------------------------------

export type UploadFormState = { error?: string; success?: boolean; assetId?: string } | undefined;

export async function uploadDiamondPhotoAction(
  _prevState: UploadFormState,
  formData: FormData
): Promise<UploadFormState> {
  await requireUser();

  if (!isDiamondStorageConfigured()) {
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
    const { assetId } = await uploadDiamondAsset(category as DiamondAssetCategory, file);
    return { success: true, assetId };
  } catch (error) {
    console.error("uploadDiamondPhotoAction failed:", error);
    return { error: error instanceof Error ? error.message : "Upload failed. Please try again." };
  }
}

/**
 * Deletes an uploaded-but-not-yet-submitted asset — used by the "Remove"
 * control in PhotoUploadField so clicking it doesn't just drop the
 * reference and orphan the file in storage. Never blocks on failure: an
 * already-orphaned or already-deleted object is not the caller's problem.
 */
export async function deleteDiamondPhotoAction(formData: FormData): Promise<void> {
  await requireUser();
  const assetId = formData.get("assetId");
  if (typeof assetId !== "string" || !assetId) return;
  await deleteDiamondAsset(assetId).catch(() => false);
}

// ---------------------------------------------------------------------------
// Rough purchase
// ---------------------------------------------------------------------------

export async function createRoughPurchase(
  _prevState: DiamondFormState,
  formData: FormData
): Promise<DiamondFormState> {
  const user = await requireUser();

  const parsed = roughPurchaseSchema.safeParse({
    purchaseDate: formData.get("purchaseDate"),
    supplierId: formData.get("supplierId"),
    purchaseRate: formData.get("purchaseRate"),
    rateBasis: formData.get("rateBasis") || "PER_CARAT",
    currencyCode: formData.get("currencyCode") || "INR",
    exchangeRate: formData.get("exchangeRate") || "1",
    totalPurchaseCost: formData.get("totalPurchaseCost"),
    gstTreatment: formData.get("gstTreatment") || "NONE",
    gstRateId: formData.get("gstRateId") || "",
    gstRatePercent: formData.get("gstRatePercent") || undefined,
    paymentAccountId: formData.get("paymentAccountId") || "",
    supplierInvoiceRef: formData.get("supplierInvoiceRef") || "",
    notes: formData.get("notes") || "",
    photoAssetId: formData.get("photoAssetId") || "",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
    pieces: readJsonArray(formData, "piecesJson"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const purchaseDate = safeParseDateOnly(data.purchaseDate);
  if (!purchaseDate) return { error: "Enter a valid purchase date." };

  const fy = await getCompanyFySettings();

  if (data.idempotencyKey) {
    const existing = await prisma.roughLot.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, code: existing.lotCode };
  }

  try {
    const lot = await prisma.$transaction((tx) =>
      diamondPosting.createRoughLotWithPieces(tx, {
        purchaseDate,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        supplierId: data.supplierId,
        purchaseRate: data.purchaseRate,
        rateBasis: data.rateBasis,
        currencyCode: data.currencyCode,
        exchangeRate: data.exchangeRate,
        totalPurchaseCost: data.totalPurchaseCost,
        gstTreatment: data.gstTreatment,
        gstRateId: data.gstRateId || null,
        gstRatePercent: data.gstRatePercent,
        paymentAccountId: data.paymentAccountId || null,
        supplierInvoiceRef: data.supplierInvoiceRef || null,
        notes: data.notes || null,
        photoAssetId: data.photoAssetId || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
        pieces: data.pieces.map((p) => ({
          carat: p.carat,
          lengthMm: p.lengthMm ?? null,
          widthMm: p.widthMm ?? null,
          heightMm: p.heightMm ?? null,
          colorEstimate: p.colorEstimate || null,
          clarityNote: p.clarityNote || null,
          internalNote: p.internalNote || null,
          manualAllocatedCost: p.manualAllocatedCost ?? null,
          photoAssetId: p.photoAssetId || null,
        })),
      })
    );
    revalidateDiamond();
    return { success: true, code: lot.lotCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.roughLot.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return { success: true, code: existing.lotCode };
    }
    if (error instanceof diamondPosting.PostingError) return { error: error.message };
    console.error("createRoughPurchase failed:", error);
    return { error: "Could not save this rough purchase. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Issue rough to Karigar
// ---------------------------------------------------------------------------

export async function issueRoughAction(
  _prevState: DiamondFormState,
  formData: FormData
): Promise<DiamondFormState> {
  const user = await requireUser();

  const parsed = issueRoughSchema.safeParse({
    karigarId: formData.get("karigarId"),
    roughPieceIds: readJsonArray(formData, "roughPieceIdsJson"),
    requiredShape: formData.get("requiredShape"),
    customShapeName: formData.get("customShapeName") || "",
    customShapeReferencePhotoAssetId: formData.get("customShapeReferencePhotoAssetId") || "",
    customShapeMeasurements: formData.get("customShapeMeasurements") || "",
    customShapeInstruction: formData.get("customShapeInstruction") || "",
    issueDate: formData.get("issueDate"),
    dueDate: formData.get("dueDate") || "",
    targetPolishedCarat: formData.get("targetPolishedCarat") || undefined,
    targetLengthMm: formData.get("targetLengthMm") || undefined,
    targetWidthMm: formData.get("targetWidthMm") || undefined,
    targetHeightMm: formData.get("targetHeightMm") || undefined,
    notes: formData.get("notes") || "",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const issueDate = safeParseDateOnly(data.issueDate);
  if (!issueDate) return { error: "Enter a valid issue date." };
  const dueDate = data.dueDate ? safeParseDateOnly(data.dueDate) : null;

  const fy = await getCompanyFySettings();

  if (data.idempotencyKey) {
    const existing = await prisma.diamondJob.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, code: existing.jobCode };
  }

  try {
    const job = await prisma.$transaction((tx) =>
      diamondPosting.issueRoughToKarigar(tx, {
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        karigarId: data.karigarId,
        roughPieceIds: data.roughPieceIds,
        requiredShape: data.requiredShape,
        customShapeName: data.customShapeName || null,
        customShapeReferencePhotoAssetId: data.customShapeReferencePhotoAssetId || null,
        customShapeMeasurements: data.customShapeMeasurements || null,
        customShapeInstruction: data.customShapeInstruction || null,
        issueDate,
        dueDate,
        targetPolishedCarat: data.targetPolishedCarat ?? null,
        targetLengthMm: data.targetLengthMm ?? null,
        targetWidthMm: data.targetWidthMm ?? null,
        targetHeightMm: data.targetHeightMm ?? null,
        notes: data.notes || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
      })
    );
    revalidateDiamond();
    return { success: true, code: job.jobCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.diamondJob.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return { success: true, code: existing.jobCode };
    }
    if (error instanceof diamondPosting.PostingError) return { error: error.message };
    console.error("issueRoughAction failed:", error);
    return { error: "Could not issue this rough to the Karigar. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Receive polished
// ---------------------------------------------------------------------------

export async function receivePolishedAction(
  _prevState: DiamondFormState,
  formData: FormData
): Promise<DiamondFormState> {
  const user = await requireUser();

  const parsed = receivePolishedSchema.safeParse({
    jobId: formData.get("jobId"),
    receiveDate: formData.get("receiveDate"),
    returnedRoughCarat: formData.get("returnedRoughCarat") || "0",
    labourCharge: formData.get("labourCharge") || "0",
    shape: formData.get("shape"),
    notes: formData.get("notes") || "",
    markJobComplete: formData.get("markJobComplete") || "false",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
    outputs: readJsonArray(formData, "outputsJson"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const receiveDate = safeParseDateOnly(data.receiveDate);
  if (!receiveDate) return { error: "Enter a valid receive date." };

  const fy = await getCompanyFySettings();

  if (data.idempotencyKey) {
    const existing = await prisma.polishedReceipt.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, code: existing.receiptCode };
  }

  try {
    const result = await prisma.$transaction((tx) =>
      diamondPosting.receivePolishedDiamonds(tx, {
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        jobId: data.jobId,
        receiveDate,
        returnedRoughCarat: data.returnedRoughCarat,
        labourCharge: data.labourCharge,
        shape: data.shape,
        notes: data.notes || null,
        markJobComplete: data.markJobComplete,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
        outputs: data.outputs.map((o) => ({
          shape: o.shape,
          carat: o.carat,
          lengthMm: o.lengthMm ?? null,
          widthMm: o.widthMm ?? null,
          heightMm: o.heightMm ?? null,
          color: o.color || null,
          clarity: o.clarity || null,
          cutGrade: o.cutGrade || null,
          polish: o.polish || null,
          symmetry: o.symmetry || null,
          fluorescence: o.fluorescence || null,
          certificateStatus: o.certificateStatus,
          certLab: o.certLab || null,
          certNumber: o.certNumber || null,
          certFileAssetId: o.certFileAssetId || null,
          photoAssetId: o.photoAssetId || null,
        })),
      })
    );
    revalidateDiamond();
    return { success: true, code: result.receipt.receiptCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.polishedReceipt.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return { success: true, code: existing.receiptCode };
    }
    if (error instanceof diamondPosting.PostingError) return { error: error.message };
    console.error("receivePolishedAction failed:", error);
    return { error: "Could not save this receipt. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Job status / cancellation (cancellation Owner-only)
// ---------------------------------------------------------------------------

export async function markJobInProgressAction(formData: FormData): Promise<void> {
  await requireUser();
  const parsed = markJobInProgressSchema.safeParse({ jobId: formData.get("jobId") });
  if (!parsed.success) return;

  await prisma.diamondJob.updateMany({
    where: { id: parsed.data.jobId, status: "ISSUED" },
    data: { status: "IN_PROGRESS" },
  });
  revalidateDiamond();
}

export async function cancelDiamondJobAction(
  _prevState: DiamondFormState,
  formData: FormData
): Promise<DiamondFormState> {
  const user = await requireOwner();

  const parsed = cancelJobSchema.safeParse({
    jobId: formData.get("jobId"),
    cancellationReason: formData.get("cancellationReason"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const fy = await getCompanyFySettings();

  try {
    await prisma.$transaction((tx) =>
      diamondPosting.cancelDiamondJob(tx, {
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        jobId: parsed.data.jobId,
        cancelledByUserId: user.id,
        cancellationReason: parsed.data.cancellationReason,
      })
    );
  } catch (error) {
    if (error instanceof diamondPosting.PostingError) return { error: error.message };
    console.error("cancelDiamondJobAction failed:", error);
    return { error: "Could not cancel this job. Please try again." };
  }

  revalidateDiamond();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Recut (Owner-only)
// ---------------------------------------------------------------------------

export async function recutPolishedAction(
  _prevState: DiamondFormState,
  formData: FormData
): Promise<DiamondFormState> {
  const user = await requireOwner();

  const parsed = recutPolishedSchema.safeParse({
    polishedDiamondId: formData.get("polishedDiamondId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  try {
    await prisma.$transaction((tx) =>
      diamondPosting.recutPolishedDiamond(tx, {
        polishedDiamondId: parsed.data.polishedDiamondId,
        reason: parsed.data.reason,
        recutByUserId: user.id,
      })
    );
  } catch (error) {
    if (error instanceof diamondPosting.PostingError) return { error: error.message };
    console.error("recutPolishedAction failed:", error);
    return { error: "Could not mark this diamond for recut. Please try again." };
  }

  revalidateDiamond();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Owner-authorized cost allocation overrides
// ---------------------------------------------------------------------------

export async function overrideRoughAllocationAction(
  _prevState: DiamondFormState,
  formData: FormData
): Promise<DiamondFormState> {
  await requireOwner();

  const parsed = overrideRoughAllocationSchema.safeParse({
    lotId: formData.get("lotId"),
    reason: formData.get("reason"),
    adjustments: readJsonArray(formData, "adjustmentsJson"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  try {
    await prisma.$transaction((tx) =>
      diamondPosting.overrideRoughPieceAllocations(tx, {
        lotId: parsed.data.lotId,
        reason: parsed.data.reason,
        adjustments: parsed.data.adjustments.map((a) => ({
          pieceId: a.key,
          newAllocatedCost: a.newAllocatedCost,
        })),
      })
    );
  } catch (error) {
    if (error instanceof diamondPosting.PostingError) return { error: error.message };
    console.error("overrideRoughAllocationAction failed:", error);
    return { error: "Could not save this cost override. Please try again." };
  }

  revalidateDiamond();
  return { success: true };
}

export async function overridePolishedAllocationAction(
  _prevState: DiamondFormState,
  formData: FormData
): Promise<DiamondFormState> {
  await requireOwner();

  const parsed = overridePolishedAllocationSchema.safeParse({
    receiptId: formData.get("receiptId"),
    reason: formData.get("reason"),
    adjustments: readJsonArray(formData, "adjustmentsJson"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  try {
    await prisma.$transaction((tx) =>
      diamondPosting.overridePolishedAllocations(tx, {
        receiptId: parsed.data.receiptId,
        reason: parsed.data.reason,
        adjustments: parsed.data.adjustments.map((a) => ({
          polishedDiamondId: a.key,
          newAllocatedCost: a.newAllocatedCost,
        })),
      })
    );
  } catch (error) {
    if (error instanceof diamondPosting.PostingError) return { error: error.message };
    console.error("overridePolishedAllocationAction failed:", error);
    return { error: "Could not save this cost override. Please try again." };
  }

  revalidateDiamond();
  return { success: true };
}
