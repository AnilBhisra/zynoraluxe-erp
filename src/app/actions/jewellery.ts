"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
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
import { friendlyUploadError, logUploadAttempt, readUploadRef } from "@/lib/storage/uploadDiagnostics";
import {
  cancelJewelleryJobSchema,
  completeReconciledJobSchema,
  createJewelleryJobSchema,
  issueMaterialsSchema,
  markJobInProgressSchema,
  needsCorrectionSchema,
  overrideFinishedAllocationSchema,
  receiveFinishedJewellerySchema,
  recomputeJobStatusSchema,
  type ReceiveFinishedJewelleryInput,
} from "@/lib/validation/jewellery";
import { CustodyError } from "@/lib/jewellery/karigarCustody";
import { CustomerGoldError } from "@/lib/jewellery/customerGoldLedger";
import {
  customerGoldJobReceiptFingerprint,
  planCustomerGoldJobReceipt,
  receiveWithCustomerGold,
  type CustomerGoldJobReceiptPart,
} from "@/lib/jewellery/customerGoldJobReceipt";
import {
  planReceiptCustody,
  receiveWithCustodyAllocation,
  staffSafeMessage,
  toReceiptCustodyPreview,
  type ReceiptCustodyPreview,
} from "@/lib/jewellery/receiptCustody";

export type JewelleryFormState = { error?: string; success?: boolean; code?: string } | undefined;

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

  const ref = readUploadRef(formData.get("uploadRef"));
  const started = Date.now();
  try {
    const { assetId } = await uploadJewelleryAsset(category as JewelleryAssetCategory, file);
    logUploadAttempt({ ref, surface: "jewellery", category: category, bytes: file.size, type: file.type, outcome: "ok", ms: Date.now() - started });
    return { success: true, assetId };
  } catch (error) {
    logUploadAttempt({
      ref, surface: "jewellery", category: category, bytes: file.size, type: file.type, outcome: "failed", ms: Date.now() - started,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
    });
    return { error: friendlyUploadError(error, ref) };
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
    packetLines: readJsonArray(formData, "packetLinesJson"),
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
        packetLines: data.packetLines,
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

/**
 * Owner-only repair for a job whose status has visibly drifted out of sync
 * with its own data (in practice: a job the Needs-Correction clear bug reset
 * to an earlier stage than it actually was in). Touches only `status` and
 * appends an audit line to `notes` — no quantity, cost or voucher changes.
 */
export async function recomputeJobStatusAction(
  _prevState: JewelleryFormState,
  formData: FormData
): Promise<JewelleryFormState> {
  const owner = await requireOwner();
  const parsed = recomputeJobStatusSchema.safeParse({
    jobId: formData.get("jobId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    await prisma.$transaction((tx) =>
      jewelleryPosting.recomputeInconsistentJobStatus(tx, { jobId: parsed.data.jobId, reason: parsed.data.reason, userId: owner.id })
    );
    revalidateJewellery();
    return { success: true };
  } catch (error) {
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("recomputeJobStatusAction failed:", error);
    return { error: "Could not fix this job's status. Please try again." };
  }
}

/**
 * Owner-only. Marks a job Completed with no new receipt — for a job whose
 * last unresolved metal left by a job-to-job transfer rather than a receipt,
 * so it never passed through Receive Finished Jewellery's own completion
 * gate. Touches only `status` and a note; every material must already be
 * fully accounted for, re-checked inside the transaction.
 */
export async function completeReconciledJobAction(
  _prevState: JewelleryFormState,
  formData: FormData
): Promise<JewelleryFormState> {
  const owner = await requireOwner();
  const parsed = completeReconciledJobSchema.safeParse({
    jobId: formData.get("jobId"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    await prisma.$transaction((tx) =>
      jewelleryPosting.completeReconciledJob(tx, { jobId: parsed.data.jobId, reason: parsed.data.reason, userId: owner.id })
    );
    revalidateJewellery();
    return { success: true };
  } catch (error) {
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("completeReconciledJobAction failed:", error);
    return { error: "Could not complete this job. Please try again." };
  }
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

function toReceiptInput(
  data: ReceiveFinishedJewelleryInput,
  receiveDate: Date,
  user: { id: string },
  fy: { fyStartMonth: number; fyStartDay: number }
) {
  return {
    fyStartMonth: fy.fyStartMonth,
    fyStartDay: fy.fyStartDay,
    jobId: data.jobId,
    receiveDate,
    outputs: data.outputs,
    diamondResolutions: data.diamondResolutions,
    packetResolutions: data.packetResolutions.map((r) => ({
      ...r,
      setInOutputIndex: r.setInOutputIndex ?? null,
      damagedLostReason: r.damagedLostReason || null,
    })),
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
  };
}

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
    packetResolutions: readJsonArray(formData, "packetResolutionsJson"),
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
  if (
    !isOwner &&
    (data.diamondResolutions.some((r) => r.resolution === "DAMAGED_LOST") ||
      data.packetResolutions.some((r) => r.resolution === "DAMAGED_LOST"))
  ) {
    return { error: "Only the Owner can mark a diamond damaged/lost." };
  }

  const receiveDate = safeParseDateOnly(data.receiveDate);
  if (!receiveDate) return { error: "Enter a valid receive date." };

  const fy = await getCompanyFySettings();

  if (data.idempotencyKey) {
    const existing = await prisma.jewelleryReceipt.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, code: existing.receiptCode };
  }

  // Customer-owned gold (CUSTOMER_GOLD_DESIGN.md): the Customer's gold on the
  // job first, then the same Customer's gold with the job's Karigar, then in
  // the safe — one locked transaction with the receipt, refused if anything
  // changed since the preview. Owner or Staff (authorised loss: Owner only).
  const customerGoldSourcePurityId = String(formData.get("customerGoldSourcePurityId") ?? "").trim();
  if (customerGoldSourcePurityId) {
    if (!data.idempotencyKey) return { error: "Missing submission key — reload the page and try again." };
    const fingerprint = String(formData.get("customerGoldFingerprint") ?? "").trim();
    if (!fingerprint) return { error: "Preview the Customer's gold first, then save." };
    try {
      const result = await prisma.$transaction(
        (tx) =>
          receiveWithCustomerGold(tx, {
            ...toReceiptInput(data, receiveDate, user, fy),
            idempotencyKey: data.idempotencyKey!,
            customerGoldSource: readCustomerGoldPart(formData, customerGoldSourcePurityId),
            expectedFingerprint: fingerprint,
            actor: { id: user.id, role: user.role },
          }),
        { timeout: 30000, maxWait: 15000 }
      );
      revalidateJewellery();
      return { success: true, code: result.receipt.receiptCode };
    } catch (error) {
      if (isIdempotencyConflict(error)) {
        const existing = await prisma.jewelleryReceipt.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
        if (existing) return { success: true, code: existing.receiptCode };
      }
      if (error instanceof CustomerGoldError || error instanceof CustodyError || error instanceof jewelleryPosting.PostingError) return { error: staffSafeMessage(error.message, isOwner) };
      console.error("receiveFinishedJewelleryAction (customer gold) failed:", error);
      return { error: "Could not save this receipt. Nothing was saved — please try again." };
    }
  }

  // Receipt-time allocation from the job's own Karigar's metal balance (Owner
  // or Staff): one locked transaction with the receipt, refused if anything
  // changed since the preview. Staff never receive a cost in any reply.
  const custodySourcePurityId = String(formData.get("custodySourcePurityId") ?? "").trim();
  if (custodySourcePurityId) {
    if (!data.idempotencyKey) return { error: "Missing submission key — reload the page and try again." };
    const fingerprint = String(formData.get("custodyFingerprint") ?? "").trim();
    if (!fingerprint) return { error: "Preview the gold allocation first, then save." };
    try {
      const result = await prisma.$transaction(
        (tx) =>
          receiveWithCustodyAllocation(tx, {
            ...toReceiptInput(data, receiveDate, user, fy),
            idempotencyKey: data.idempotencyKey!,
            sourcePurityId: custodySourcePurityId,
            explicitLossFineWeight: String(formData.get("explicitLossFineWeight") ?? "").trim() || null,
            expectedFingerprint: fingerprint,
            actor: { id: user.id, role: user.role },
          }),
        { timeout: 30000, maxWait: 15000 }
      );
      revalidateJewellery();
      return { success: true, code: result.receipt.receiptCode };
    } catch (error) {
      if (isIdempotencyConflict(error)) {
        const existing = await prisma.jewelleryReceipt.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
        if (existing) return { success: true, code: existing.receiptCode };
      }
      if (error instanceof CustodyError || error instanceof jewelleryPosting.PostingError) return { error: staffSafeMessage(error.message, isOwner) };
      console.error("receiveFinishedJewelleryAction (custody) failed:", error);
      return { error: "Could not save this receipt. Nothing was saved — please try again." };
    }
  }

  try {
    const result = await prisma.$transaction((tx) =>
      jewelleryPosting.receiveFinishedJewellery(tx, toReceiptInput(data, receiveDate, user, fy)),
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

export type { ReceiptCustodyPreview };

function readCustomerGoldPart(formData: FormData, purityId: string): CustomerGoldJobReceiptPart {
  const opt = (name: string) => {
    const v = String(formData.get(name) ?? "").trim();
    return v === "" ? null : v;
  };
  return {
    purityId,
    finenessPercent: String(formData.get("customerGoldFineness") ?? "").trim(),
    customerFineForOutputs: opt("customerFineForOutputs"),
    returnGross: opt("customerReturnGross"),
    scrapGross: opt("customerScrapGross"),
    lossFine: opt("customerLossFine"),
    lossReason: opt("customerLossReason"),
  };
}

/** What a receipt of Customer gold would do. Weights only (no value exists for Customer gold); Owner and Staff. */
export type CustomerGoldReceiptPreview = {
  jobCode: string;
  customerName: string;
  karigarName: string;
  sourceLabel: string;
  sourceFineness: string;
  outputs: { netWeight: string; purityDisplayName: string; finenessPercent: string; fineWeight: string; customerFine: string }[];
  outputFine: string;
  customerFineForOutputs: string;
  companyFineForOutputs: string;
  returned: { gross: string; fine: string };
  scrap: { gross: string; fine: string };
  lossFine: string;
  neededFine: string;
  onJobBefore: { gross: string; fine: string };
  fromKarigar: { gross: string; fine: string };
  fromSafe: { gross: string; fine: string };
  karigarAfter: { gross: string; fine: string };
  safeAfter: { gross: string; fine: string };
  onJobAfter: { gross: string; fine: string };
  completesJob: boolean;
  mixed: boolean;
  fingerprint: string;
};

export async function previewCustomerGoldReceiptAction(
  _prev: { error?: string; preview?: CustomerGoldReceiptPreview } | undefined,
  formData: FormData
): Promise<{ error?: string; preview?: CustomerGoldReceiptPreview }> {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";
  const parsed = receiveFinishedJewellerySchema.safeParse({
    jobId: formData.get("jobId"),
    receiveDate: formData.get("receiveDate"),
    outputs: readJsonArray(formData, "outputsJson"),
    returnedMetalLines: readJsonArray(formData, "returnedMetalLinesJson"),
    scrapMetalLines: readJsonArray(formData, "scrapMetalLinesJson"),
    karigarAddedFineWeight: formData.get("karigarAddedFineWeight") || "0",
    markJobComplete: formData.get("markJobComplete") || "false",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const purityId = String(formData.get("customerGoldSourcePurityId") ?? "").trim();
  if (!purityId) return { error: "Choose the Customer's gold the jewellery was made from." };
  try {
    const plan = await planCustomerGoldJobReceipt(prisma, {
      jobId: parsed.data.jobId,
      outputs: parsed.data.outputs,
      karigarAddedFineWeight: parsed.data.karigarAddedFineWeight,
      markJobComplete: parsed.data.markJobComplete,
      customerGoldSource: readCustomerGoldPart(formData, purityId),
    });
    const w = (p: { gross: { toFixed: (n: number) => string }; fine: { toFixed: (n: number) => string } }) => ({ gross: p.gross.toFixed(3), fine: p.fine.toFixed(3) });
    return {
      preview: {
        jobCode: plan.jobCode,
        customerName: plan.customerName,
        karigarName: plan.karigarName,
        sourceLabel: plan.sourceLabel,
        sourceFineness: plan.pool.finenessPercentSnapshot.toFixed(3),
        outputs: plan.outputs.map((o) => ({
          netWeight: o.netWeight.toFixed(3),
          purityDisplayName: o.purityDisplayName,
          finenessPercent: o.finenessPercent.toFixed(3),
          fineWeight: o.fineWeight.toFixed(3),
          customerFine: o.customerFine.toFixed(3),
        })),
        outputFine: plan.outputFine.toFixed(3),
        customerFineForOutputs: plan.customerFineForOutputs.toFixed(3),
        companyFineForOutputs: plan.companyFineForOutputs.toFixed(3),
        returned: w(plan.returned),
        scrap: w(plan.scrap),
        lossFine: plan.lossFine.toFixed(3),
        neededFine: plan.neededFine.toFixed(3),
        onJobBefore: w(plan.onJobBefore),
        fromKarigar: w(plan.fromKarigar),
        fromSafe: w(plan.fromSafe),
        karigarAfter: w(plan.karigarAfter),
        safeAfter: w(plan.safeAfter),
        onJobAfter: w(plan.onJobAfter),
        completesJob: plan.completesJob,
        mixed: plan.mixed,
        fingerprint: customerGoldJobReceiptFingerprint(plan),
      },
    };
  } catch (error) {
    if (error instanceof CustomerGoldError || error instanceof jewelleryPosting.PostingError) return { error: staffSafeMessage(error.message, isOwner) };
    console.error("previewCustomerGoldReceiptAction failed:", error);
    return { error: "Could not prepare the preview. Please try again." };
  }
}

/**
 * What this receipt would take from the job's Karigar's balance. Writes
 * nothing. Owner and Staff; the Staff reply carries weights only (no cost,
 * rate or value), and its fingerprint is an opaque token.
 */
export async function previewReceiptCustodyAction(
  _prev: { error?: string; preview?: ReceiptCustodyPreview } | undefined,
  formData: FormData
): Promise<{ error?: string; preview?: ReceiptCustodyPreview }> {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";
  const parsed = receiveFinishedJewellerySchema.safeParse({
    jobId: formData.get("jobId"),
    receiveDate: formData.get("receiveDate"),
    outputs: readJsonArray(formData, "outputsJson"),
    returnedMetalLines: readJsonArray(formData, "returnedMetalLinesJson"),
    scrapMetalLines: readJsonArray(formData, "scrapMetalLinesJson"),
    karigarAddedFineWeight: formData.get("karigarAddedFineWeight") || "0",
    markJobComplete: formData.get("markJobComplete") || "false",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const receiveDate = safeParseDateOnly(parsed.data.receiveDate);
  if (!receiveDate) return { error: "Enter a valid receive date." };
  const sourcePurityId = String(formData.get("custodySourcePurityId") ?? "").trim();
  if (!sourcePurityId) return { error: "Choose the Karigar metal the jewellery was made from." };
  try {
    const plan = await planReceiptCustody(prisma, {
      jobId: parsed.data.jobId,
      sourcePurityId,
      receiveDate,
      outputs: parsed.data.outputs,
      returnedMetalLines: parsed.data.returnedMetalLines,
      scrapMetalLines: parsed.data.scrapMetalLines,
      karigarAddedFineWeight: parsed.data.karigarAddedFineWeight,
      explicitLossFineWeight: String(formData.get("explicitLossFineWeight") ?? "").trim() || null,
      markJobComplete: parsed.data.markJobComplete,
    });
    return { preview: toReceiptCustodyPreview(plan, isOwner) };
  } catch (error) {
    if (error instanceof CustodyError || error instanceof jewelleryPosting.PostingError) return { error: staffSafeMessage(error.message, isOwner) };
    console.error("previewReceiptCustodyAction failed:", error);
    return { error: "Could not prepare the preview. Please try again." };
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
