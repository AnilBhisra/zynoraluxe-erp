"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { checkVoucherDateAllowed, parseDateOnly } from "@/lib/accounting/financialYear";
import * as posting from "@/lib/accounting/posting";
import {
  cancelVoucherSchema,
  expenseSchema,
  paymentGivenSchema,
  paymentReceivedSchema,
  purchaseSchema,
  saleSchema,
} from "@/lib/validation/accounting";

export type VoucherFormState =
  | { error?: string; success?: boolean; voucherNumber?: string }
  | undefined;

function isIdempotencyConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    (error.meta.target as string[]).includes("idempotencyKey")
  );
}

async function findExistingByIdempotencyKey(idempotencyKey: string | undefined) {
  if (!idempotencyKey) return null;
  return prisma.voucher.findUnique({ where: { idempotencyKey } });
}

async function withVoucherPosting(
  idempotencyKey: string | undefined,
  post: () => Promise<{ voucherNumber: string }>
): Promise<VoucherFormState> {
  try {
    const existing = await findExistingByIdempotencyKey(idempotencyKey);
    if (existing) return { success: true, voucherNumber: existing.voucherNumber };

    const voucher = await post();
    return { success: true, voucherNumber: voucher.voucherNumber };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await findExistingByIdempotencyKey(idempotencyKey);
      if (existing) return { success: true, voucherNumber: existing.voucherNumber };
    }
    if (error instanceof posting.PostingError) {
      return { error: error.message };
    }
    console.error("Voucher posting failed:", error);
    return { error: "Could not save this entry. Please try again." };
  }
}

function safeParseDateOnly(value: string): Date | null {
  try {
    return parseDateOnly(value);
  } catch {
    return null;
  }
}

function readLinesJson(formData: FormData): unknown {
  const raw = formData.get("linesJson");
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Purchase / Sale
// ---------------------------------------------------------------------------

export async function createPurchase(
  _prevState: VoucherFormState,
  formData: FormData
): Promise<VoucherFormState> {
  const user = await requireUser();

  const parsed = purchaseSchema.safeParse({
    date: formData.get("date"),
    partyId: formData.get("partyId"),
    paymentAccountId: formData.get("paymentAccountId") || "",
    gstTreatment: formData.get("gstTreatment") || "NONE",
    referenceNumber: formData.get("referenceNumber") || "",
    note: formData.get("note") || "",
    currencyCode: formData.get("currencyCode") || "INR",
    exchangeRate: formData.get("exchangeRate") || "1",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
    lines: readLinesJson(formData),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const date = safeParseDateOnly(data.date);
  if (!date) return { error: "Enter a valid date." };

  const fy = await getCompanyFySettings();
  const dateCheck = checkVoucherDateAllowed(
    date,
    user.role,
    formData.get("confirmOutsideFy") === "true",
    fy.fyStartMonth,
    fy.fyStartDay
  );
  if (!dateCheck.ok) return { error: dateCheck.message };

  const gstRateIds = [...new Set(data.lines.map((l) => l.gstRateId))];
  const gstRates = await prisma.gstRate.findMany({ where: { id: { in: gstRateIds } } });
  const gstRateMap = new Map(gstRates.map((r) => [r.id, r]));
  for (const line of data.lines) {
    if (!gstRateMap.has(line.gstRateId)) {
      return { error: "One of the selected GST rates no longer exists." };
    }
  }

  const result = await withVoucherPosting(data.idempotencyKey, () =>
    prisma.$transaction((tx) =>
      posting.postPurchase(tx, {
        date,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        currencyCode: data.currencyCode,
        exchangeRate: data.exchangeRate,
        referenceNumber: data.referenceNumber || null,
        note: data.note || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
        partyId: data.partyId,
        paymentAccountId: data.paymentAccountId || null,
        gstTreatment: data.gstTreatment,
        lines: data.lines.map((l) => ({
          description: l.description,
          hsnSac: l.hsnSac || null,
          quantity: l.quantity,
          unit: l.unit,
          rate: l.rate,
          discount: l.discount,
          gstRateId: l.gstRateId,
          gstRatePercent: gstRateMap.get(l.gstRateId)!.ratePercent.toString(),
          taxType: l.taxType,
        })),
      })
    )
  );

  revalidatePath("/accounting");
  revalidatePath("/dashboard");
  return result;
}

export async function createSale(
  _prevState: VoucherFormState,
  formData: FormData
): Promise<VoucherFormState> {
  const user = await requireUser();

  const parsed = saleSchema.safeParse({
    date: formData.get("date"),
    partyId: formData.get("partyId"),
    paymentAccountId: formData.get("paymentAccountId") || "",
    gstTreatment: formData.get("gstTreatment") || "NONE",
    referenceNumber: formData.get("referenceNumber") || "",
    note: formData.get("note") || "",
    currencyCode: formData.get("currencyCode") || "INR",
    exchangeRate: formData.get("exchangeRate") || "1",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
    lines: readLinesJson(formData),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const date = safeParseDateOnly(data.date);
  if (!date) return { error: "Enter a valid date." };

  const fy = await getCompanyFySettings();
  const dateCheck = checkVoucherDateAllowed(
    date,
    user.role,
    formData.get("confirmOutsideFy") === "true",
    fy.fyStartMonth,
    fy.fyStartDay
  );
  if (!dateCheck.ok) return { error: dateCheck.message };

  const gstRateIds = [...new Set(data.lines.map((l) => l.gstRateId))];
  const gstRates = await prisma.gstRate.findMany({ where: { id: { in: gstRateIds } } });
  const gstRateMap = new Map(gstRates.map((r) => [r.id, r]));
  for (const line of data.lines) {
    if (!gstRateMap.has(line.gstRateId)) {
      return { error: "One of the selected GST rates no longer exists." };
    }
  }

  const result = await withVoucherPosting(data.idempotencyKey, () =>
    prisma.$transaction((tx) =>
      posting.postSale(tx, {
        date,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        currencyCode: data.currencyCode,
        exchangeRate: data.exchangeRate,
        referenceNumber: data.referenceNumber || null,
        note: data.note || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
        partyId: data.partyId,
        paymentAccountId: data.paymentAccountId || null,
        gstTreatment: data.gstTreatment,
        lines: data.lines.map((l) => ({
          description: l.description,
          hsnSac: l.hsnSac || null,
          quantity: l.quantity,
          unit: l.unit,
          rate: l.rate,
          discount: l.discount,
          gstRateId: l.gstRateId,
          gstRatePercent: gstRateMap.get(l.gstRateId)!.ratePercent.toString(),
          taxType: l.taxType,
        })),
      })
    )
  );

  revalidatePath("/accounting");
  revalidatePath("/dashboard");
  return result;
}

// ---------------------------------------------------------------------------
// Payment Given / Payment Received / Expense
// ---------------------------------------------------------------------------

export async function createPaymentGiven(
  _prevState: VoucherFormState,
  formData: FormData
): Promise<VoucherFormState> {
  const user = await requireUser();

  const parsed = paymentGivenSchema.safeParse({
    date: formData.get("date"),
    partyId: formData.get("partyId"),
    paymentAccountId: formData.get("paymentAccountId"),
    amount: formData.get("amount"),
    referenceNumber: formData.get("referenceNumber") || "",
    note: formData.get("note") || "",
    currencyCode: formData.get("currencyCode") || "INR",
    exchangeRate: formData.get("exchangeRate") || "1",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const date = safeParseDateOnly(data.date);
  if (!date) return { error: "Enter a valid date." };

  const fy = await getCompanyFySettings();
  const dateCheck = checkVoucherDateAllowed(
    date,
    user.role,
    formData.get("confirmOutsideFy") === "true",
    fy.fyStartMonth,
    fy.fyStartDay
  );
  if (!dateCheck.ok) return { error: dateCheck.message };

  const result = await withVoucherPosting(data.idempotencyKey, () =>
    prisma.$transaction((tx) =>
      posting.postPaymentGiven(tx, {
        date,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        currencyCode: data.currencyCode,
        exchangeRate: data.exchangeRate,
        referenceNumber: data.referenceNumber || null,
        note: data.note || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
        partyId: data.partyId,
        paymentAccountId: data.paymentAccountId,
        amount: data.amount,
      })
    )
  );

  revalidatePath("/accounting");
  revalidatePath("/dashboard");
  return result;
}

export async function createPaymentReceived(
  _prevState: VoucherFormState,
  formData: FormData
): Promise<VoucherFormState> {
  const user = await requireUser();

  const parsed = paymentReceivedSchema.safeParse({
    date: formData.get("date"),
    partyId: formData.get("partyId"),
    paymentAccountId: formData.get("paymentAccountId"),
    amount: formData.get("amount"),
    referenceNumber: formData.get("referenceNumber") || "",
    note: formData.get("note") || "",
    currencyCode: formData.get("currencyCode") || "INR",
    exchangeRate: formData.get("exchangeRate") || "1",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const date = safeParseDateOnly(data.date);
  if (!date) return { error: "Enter a valid date." };

  const fy = await getCompanyFySettings();
  const dateCheck = checkVoucherDateAllowed(
    date,
    user.role,
    formData.get("confirmOutsideFy") === "true",
    fy.fyStartMonth,
    fy.fyStartDay
  );
  if (!dateCheck.ok) return { error: dateCheck.message };

  const result = await withVoucherPosting(data.idempotencyKey, () =>
    prisma.$transaction((tx) =>
      posting.postPaymentReceived(tx, {
        date,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        currencyCode: data.currencyCode,
        exchangeRate: data.exchangeRate,
        referenceNumber: data.referenceNumber || null,
        note: data.note || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
        partyId: data.partyId,
        paymentAccountId: data.paymentAccountId,
        amount: data.amount,
      })
    )
  );

  revalidatePath("/accounting");
  revalidatePath("/dashboard");
  return result;
}

export async function createExpense(
  _prevState: VoucherFormState,
  formData: FormData
): Promise<VoucherFormState> {
  const user = await requireUser();

  const parsed = expenseSchema.safeParse({
    date: formData.get("date"),
    partyId: formData.get("partyId") || "",
    paymentAccountId: formData.get("paymentAccountId"),
    amount: formData.get("amount"),
    referenceNumber: formData.get("referenceNumber") || "",
    note: formData.get("note") || "",
    currencyCode: formData.get("currencyCode") || "INR",
    exchangeRate: formData.get("exchangeRate") || "1",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const date = safeParseDateOnly(data.date);
  if (!date) return { error: "Enter a valid date." };

  const fy = await getCompanyFySettings();
  const dateCheck = checkVoucherDateAllowed(
    date,
    user.role,
    formData.get("confirmOutsideFy") === "true",
    fy.fyStartMonth,
    fy.fyStartDay
  );
  if (!dateCheck.ok) return { error: dateCheck.message };

  const result = await withVoucherPosting(data.idempotencyKey, () =>
    prisma.$transaction((tx) =>
      posting.postExpense(tx, {
        date,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        currencyCode: data.currencyCode,
        exchangeRate: data.exchangeRate,
        referenceNumber: data.referenceNumber || null,
        note: data.note || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
        partyId: data.partyId || null,
        paymentAccountId: data.paymentAccountId,
        amount: data.amount,
      })
    )
  );

  revalidatePath("/accounting");
  revalidatePath("/dashboard");
  return result;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

export async function cancelVoucherAction(
  _prevState: VoucherFormState,
  formData: FormData
): Promise<VoucherFormState> {
  const user = await requireOwner();

  const parsed = cancelVoucherSchema.safeParse({
    voucherId: formData.get("voucherId"),
    cancellationReason: formData.get("cancellationReason"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const fy = await getCompanyFySettings();

  try {
    await prisma.$transaction((tx) =>
      posting.cancelVoucher(tx, {
        voucherId: parsed.data.voucherId,
        cancelledByUserId: user.id,
        cancellationReason: parsed.data.cancellationReason,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
      })
    );
  } catch (error) {
    if (error instanceof posting.PostingError) {
      return { error: error.message };
    }
    console.error("cancelVoucherAction failed:", error);
    return { error: "Could not cancel this voucher. Please try again." };
  }

  revalidatePath("/accounting");
  revalidatePath("/dashboard");
  return { success: true };
}
