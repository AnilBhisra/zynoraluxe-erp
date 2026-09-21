"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import { Prisma } from "@/generated/prisma/client";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { checkVoucherDateAllowed, parseDateOnly } from "@/lib/accounting/financialYear";
import * as jewelleryPosting from "@/lib/jewellery/posting";
import {
  metalPuritySchema,
  metalPurchaseSchema,
  metalStockAdjustmentSchema,
  openingMetalStockSchema,
} from "@/lib/validation/jewellery";

export type MetalFormState = { error?: string; success?: boolean; code?: string } | undefined;

function safeParseDateOnly(value: string): Date | null {
  try {
    return parseDateOnly(value);
  } catch {
    return null;
  }
}

function revalidateJewellery() {
  revalidatePath("/jewellery-jobs");
  revalidatePath("/settings");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
}

// ---------------------------------------------------------------------------
// Metal / Purity master (Owner-only) — Settings page
// ---------------------------------------------------------------------------

export type MasterFormState = { error?: string; success?: boolean } | undefined;

export async function createMetalPurity(
  _prevState: MasterFormState,
  formData: FormData
): Promise<MasterFormState> {
  const owner = await requireOwner();

  const parsed = metalPuritySchema.safeParse({
    metalType: formData.get("metalType"),
    displayName: formData.get("displayName"),
    finenessPercent: formData.get("finenessPercent"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  try {
    await prisma.metalPurity.create({
      data: {
        metalType: parsed.data.metalType,
        displayName: parsed.data.displayName,
        finenessPercent: parsed.data.finenessPercent.toFixed(3),
        createdByUserId: owner.id,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "This metal + display name combination already exists." };
    }
    console.error("createMetalPurity failed:", error);
    return { error: "Could not save this purity. Please try again." };
  }

  revalidateJewellery();
  return { success: true };
}

export async function updateMetalPurity(
  _prevState: MasterFormState,
  formData: FormData
): Promise<MasterFormState> {
  const owner = await requireOwner();

  const purityId = formData.get("purityId");
  if (typeof purityId !== "string" || !purityId) return { error: "Purity not found." };

  const parsed = metalPuritySchema.safeParse({
    metalType: formData.get("metalType"),
    displayName: formData.get("displayName"),
    finenessPercent: formData.get("finenessPercent"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  try {
    await prisma.metalPurity.update({
      where: { id: purityId },
      data: {
        metalType: parsed.data.metalType,
        displayName: parsed.data.displayName,
        finenessPercent: parsed.data.finenessPercent.toFixed(3),
        updatedByUserId: owner.id,
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "This metal + display name combination already exists." };
    }
    console.error("updateMetalPurity failed:", error);
    return { error: "Could not update this purity. Please try again." };
  }

  revalidateJewellery();
  return { success: true };
}

export async function setMetalPurityActive(formData: FormData): Promise<void> {
  const owner = await requireOwner();
  const purityId = formData.get("purityId");
  const nextActive = formData.get("nextActive") === "true";
  if (typeof purityId !== "string" || !purityId) return;

  await prisma.metalPurity.update({
    where: { id: purityId },
    data: { isActive: nextActive, updatedByUserId: owner.id },
  });
  revalidateJewellery();
}

// ---------------------------------------------------------------------------
// Metal Purchase
// ---------------------------------------------------------------------------

export async function createMetalPurchase(
  _prevState: MetalFormState,
  formData: FormData
): Promise<MetalFormState> {
  const user = await requireUser();

  const parsed = metalPurchaseSchema.safeParse({
    purchaseDate: formData.get("purchaseDate"),
    supplierId: formData.get("supplierId"),
    metalType: formData.get("metalType"),
    purityId: formData.get("purityId"),
    grossWeight: formData.get("grossWeight"),
    rateBasis: formData.get("rateBasis") || "PER_GROSS_GRAM",
    rate: formData.get("rate"),
    currencyCode: formData.get("currencyCode") || "INR",
    exchangeRate: formData.get("exchangeRate") || "1",
    totalPurchaseCost: formData.get("totalPurchaseCost"),
    gstTreatment: formData.get("gstTreatment") || "NONE",
    gstRateId: formData.get("gstRateId") || "",
    gstRatePercent: formData.get("gstRatePercent") || undefined,
    paymentAccountId: formData.get("paymentAccountId") || "",
    referenceNumber: formData.get("referenceNumber") || "",
    notes: formData.get("notes") || "",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const purchaseDate = safeParseDateOnly(data.purchaseDate);
  if (!purchaseDate) return { error: "Enter a valid purchase date." };

  const fy = await getCompanyFySettings();
  const dateCheck = checkVoucherDateAllowed(
    purchaseDate,
    user.role,
    formData.get("confirmOutsideFy") === "true",
    fy.fyStartMonth,
    fy.fyStartDay
  );
  if (!dateCheck.ok) return { error: dateCheck.message };

  if (data.idempotencyKey) {
    const existing = await prisma.metalPurchase.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, code: existing.purchaseCode };
  }

  try {
    const purchase = await prisma.$transaction((tx) =>
      jewelleryPosting.createMetalPurchase(tx, {
        purchaseDate,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        supplierId: data.supplierId,
        metalType: data.metalType,
        purityId: data.purityId,
        grossWeight: data.grossWeight,
        rateBasis: data.rateBasis,
        rate: data.rate,
        currencyCode: data.currencyCode,
        exchangeRate: data.exchangeRate,
        totalPurchaseCost: data.totalPurchaseCost,
        gstTreatment: data.gstTreatment,
        gstRateId: data.gstRateId || null,
        gstRatePercent: data.gstRatePercent,
        paymentAccountId: data.paymentAccountId || null,
        referenceNumber: data.referenceNumber || null,
        notes: data.notes || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
      })
    );
    revalidateJewellery();
    return { success: true, code: purchase.purchaseCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.metalPurchase.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return { success: true, code: existing.purchaseCode };
    }
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("createMetalPurchase failed:", error);
    return { error: "Could not save this metal purchase. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Opening Metal Stock (Owner-only)
// ---------------------------------------------------------------------------

export async function createOpeningMetalStock(
  _prevState: MetalFormState,
  formData: FormData
): Promise<MetalFormState> {
  const owner = await requireOwner();

  const parsed = openingMetalStockSchema.safeParse({
    metalType: formData.get("metalType"),
    purityId: formData.get("purityId"),
    grossWeight: formData.get("grossWeight"),
    costValue: formData.get("costValue"),
    note: formData.get("note") || "",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const { idempotencyKey } = parsed.data;

  // Phase 8: the entry now posts a voucher too, so a retry must not be able
  // to create a second movement or a second voucher.
  if (idempotencyKey) {
    const existing = await prisma.metalStockMovement.findUnique({ where: { idempotencyKey } });
    if (existing) return { success: true };
  }

  const fy = await getCompanyFySettings();

  try {
    await prisma.$transaction((tx) =>
      jewelleryPosting.postOpeningMetalStock(tx, {
        metalType: parsed.data.metalType,
        purityId: parsed.data.purityId,
        grossWeight: parsed.data.grossWeight,
        costValue: parsed.data.costValue,
        note: parsed.data.note || null,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        idempotencyKey: idempotencyKey || null,
        createdByUserId: owner.id,
      })
    );
  } catch (error) {
    if (isIdempotencyConflict(error) && idempotencyKey) {
      const existing = await prisma.metalStockMovement.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true };
    }
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("createOpeningMetalStock failed:", error);
    return { error: "Could not save opening stock. Please try again." };
  }

  revalidateJewellery();
  return { success: true };
}

// ---------------------------------------------------------------------------
// Authorized Metal Stock Adjustment (Owner-only)
// ---------------------------------------------------------------------------

export async function adjustMetalStockAction(
  _prevState: MetalFormState,
  formData: FormData
): Promise<MetalFormState> {
  const owner = await requireOwner();

  const parsed = metalStockAdjustmentSchema.safeParse({
    metalType: formData.get("metalType"),
    purityId: formData.get("purityId"),
    direction: formData.get("direction"),
    grossWeight: formData.get("grossWeight"),
    costValue: formData.get("costValue") || "0",
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  try {
    await prisma.$transaction((tx) =>
      jewelleryPosting.adjustMetalStock(tx, {
        metalType: parsed.data.metalType,
        purityId: parsed.data.purityId,
        direction: parsed.data.direction,
        grossWeight: parsed.data.grossWeight,
        costValue: parsed.data.costValue,
        reason: parsed.data.reason,
        createdByUserId: owner.id,
      })
    );
  } catch (error) {
    if (error instanceof jewelleryPosting.PostingError) return { error: error.message };
    console.error("adjustMetalStockAction failed:", error);
    return { error: "Could not save this adjustment. Please try again." };
  }

  revalidateJewellery();
  return { success: true };
}
