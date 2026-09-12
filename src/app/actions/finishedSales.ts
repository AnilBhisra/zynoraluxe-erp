"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { checkVoucherDateAllowed, parseDateOnly } from "@/lib/accounting/financialYear";
import { Decimal } from "@/lib/accounting/money";
import * as posting from "@/lib/accounting/posting";
import * as finishedSalesPosting from "@/lib/jewellery/finishedSalesPosting";
import { getPhase5VsPhase6Comparison, getSuggestedSalePrice } from "@/lib/costing/sourcing";
import {
  adjustFinishedJewelleryStockSchema,
  cancelFinishedJewellerySaleSchema,
  createFinishedJewellerySaleSchema,
  customerRefundSchema,
  returnFinishedJewelleryItemsSchema,
} from "@/lib/validation/finishedSales";

export type FinishedSaleFormState = { error?: string; success?: boolean; code?: string } | undefined;

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

function revalidateFinishedSales() {
  revalidatePath("/jewellery-jobs");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
}

// ---------------------------------------------------------------------------
// Suggested price from a finalized Costing (if any) — available to Staff
// too, same as the rest of the Sale form: the SELLING PRICE a customer
// would pay is not itself cost/COGS/margin data. Never returns any cost
// breakdown, and this figure is NEVER used as COGS anywhere in Phase 6 —
// see getSuggestedSalePrice's own comment in src/lib/costing/sourcing.ts.
// ---------------------------------------------------------------------------

export async function getSuggestedSalePriceAction(
  finishedJewelleryId: string
): Promise<{ suggestedPrice: string; costingNumber: string } | null> {
  await requireUser();
  if (!finishedJewelleryId) return null;
  const suggestion = await getSuggestedSalePrice(finishedJewelleryId);
  if (!suggestion) return null;
  return { suggestedPrice: suggestion.suggestedPrice.toFixed(2), costingNumber: suggestion.costingNumber };
}

// ---------------------------------------------------------------------------
// Phase 5 vs Phase 6 comparison — Owner-only. Every field here is cost/
// margin/profit data; requireOwner() is the server-side enforcement point,
// not just a hidden button. Staff must never be able to call this action
// and get real data back — see finishedSales.test.ts.
// ---------------------------------------------------------------------------

export type SerializedPhase5VsPhase6Comparison = {
  finishedCode: string;
  costingNumber: string;
  costSheetFinalizedAt: string | null;
  expectedSellingValue: string;
  expectedFullBusinessCost: string;
  expectedProfit: string;
  expectedMarginPercent: string;
  authoritativeAccountingCost: string;
  otherMaterialCostExcluded: string;
  realizedStatus: string;
  saleCode: string | null;
  realizedNetSellingValue: string | null;
  realizedCogs: string | null;
  realizedGrossProfit: string | null;
  realizedMarginPercent: string | null;
  profitDifference: string | null;
  note: string;
};

export async function getPhase5VsPhase6ComparisonAction(
  finishedJewelleryId: string
): Promise<SerializedPhase5VsPhase6Comparison | null> {
  await requireOwner();
  if (!finishedJewelleryId) return null;
  const comparison = await getPhase5VsPhase6Comparison(finishedJewelleryId);
  if (!comparison) return null;
  return {
    finishedCode: comparison.finishedCode,
    costingNumber: comparison.costingNumber,
    costSheetFinalizedAt: comparison.costSheetFinalizedAt ? comparison.costSheetFinalizedAt.toISOString() : null,
    expectedSellingValue: comparison.expectedSellingValue.toFixed(2),
    expectedFullBusinessCost: comparison.expectedFullBusinessCost.toFixed(2),
    expectedProfit: comparison.expectedProfit.toFixed(2),
    expectedMarginPercent: comparison.expectedMarginPercent.toFixed(2),
    authoritativeAccountingCost: comparison.authoritativeAccountingCost.toFixed(2),
    otherMaterialCostExcluded: comparison.otherMaterialCostExcluded.toFixed(2),
    realizedStatus: comparison.realizedStatus,
    saleCode: comparison.saleCode,
    realizedNetSellingValue: comparison.realizedNetSellingValue ? comparison.realizedNetSellingValue.toFixed(2) : null,
    realizedCogs: comparison.realizedCogs ? comparison.realizedCogs.toFixed(2) : null,
    realizedGrossProfit: comparison.realizedGrossProfit ? comparison.realizedGrossProfit.toFixed(2) : null,
    realizedMarginPercent: comparison.realizedMarginPercent ? comparison.realizedMarginPercent.toFixed(2) : null,
    profitDifference: comparison.profitDifference ? comparison.profitDifference.toFixed(2) : null,
    note: comparison.note,
  };
}

// ---------------------------------------------------------------------------
// Create a Finished Jewellery Sale
// ---------------------------------------------------------------------------

export async function createFinishedJewellerySaleAction(
  _prevState: FinishedSaleFormState,
  formData: FormData
): Promise<FinishedSaleFormState> {
  const user = await requireUser();

  const parsed = createFinishedJewellerySaleSchema.safeParse({
    customerId: formData.get("customerId"),
    saleDate: formData.get("saleDate"),
    gstTreatment: formData.get("gstTreatment") || "NONE",
    paymentAccountId: formData.get("paymentAccountId") || "",
    referenceNumber: formData.get("referenceNumber") || "",
    note: formData.get("note") || "",
    items: readJsonArray(formData, "itemsJson"),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const saleDate = safeParseDateOnly(data.saleDate);
  if (!saleDate) return { error: "Enter a valid sale date." };

  const fy = await getCompanyFySettings();
  const dateCheck = checkVoucherDateAllowed(
    saleDate,
    user.role,
    formData.get("confirmOutsideFy") === "true",
    fy.fyStartMonth,
    fy.fyStartDay
  );
  if (!dateCheck.ok) return { error: dateCheck.message };

  const gstRateIds = [...new Set(data.items.map((i) => i.gstRateId).filter(Boolean))] as string[];
  if (gstRateIds.length > 0) {
    const gstRates = await prisma.gstRate.findMany({ where: { id: { in: gstRateIds } } });
    if (gstRates.length !== gstRateIds.length) {
      return { error: "One of the selected GST rates no longer exists." };
    }
  }

  if (data.idempotencyKey) {
    const existing = await prisma.finishedJewellerySale.findUnique({
      where: { idempotencyKey: data.idempotencyKey },
    });
    if (existing) return { success: true, code: existing.saleCode };
  }

  try {
    const result = await prisma.$transaction(
      (tx) =>
        finishedSalesPosting.postFinishedJewellerySale(tx, {
          date: saleDate,
          saleDate,
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
          currencyCode: "INR",
          exchangeRate: 1,
          referenceNumber: data.referenceNumber || null,
          note: data.note || null,
          idempotencyKey: data.idempotencyKey || null,
          createdByUserId: user.id,
          customerId: data.customerId,
          paymentAccountId: data.paymentAccountId || null,
          gstTreatment: data.gstTreatment,
          items: data.items.map((i) => ({
            finishedJewelleryId: i.finishedJewelleryId,
            sellingPrice: i.sellingPrice,
            discountShare: i.discountShare,
            gstRateId: i.gstRateId || null,
            gstRatePercent: i.gstRatePercent,
            taxType: i.taxType,
          })),
        }),
      // Claims + reads + writes for several items, each touching 2-3
      // tables plus a stock movement — comfortably inside the default on a
      // fast connection, but a multi-item sale over real network latency
      // to a remote pooled Postgres deserves the same headroom
      // receiveFinishedJewelleryAction already gives itself for a
      // comparably shaped multi-step transaction.
      { timeout: 20000 }
    );
    revalidateFinishedSales();
    return { success: true, code: result.sale.saleCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.finishedJewellerySale.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
      });
      if (existing) return { success: true, code: existing.saleCode };
    }
    if (error instanceof posting.PostingError) return { error: error.message };
    console.error("createFinishedJewellerySaleAction failed:", error);
    return { error: "Could not save this sale. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Cancel a Finished Jewellery Sale (Owner-only)
// ---------------------------------------------------------------------------

export async function cancelFinishedJewellerySaleAction(
  _prevState: FinishedSaleFormState,
  formData: FormData
): Promise<FinishedSaleFormState> {
  const user = await requireOwner();

  const parsed = cancelFinishedJewellerySaleSchema.safeParse({
    saleId: formData.get("saleId"),
    cancellationReason: formData.get("cancellationReason"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const fy = await getCompanyFySettings();

  try {
    await prisma.$transaction((tx) =>
      finishedSalesPosting.cancelFinishedJewellerySale(tx, {
        saleId: parsed.data.saleId,
        cancelledByUserId: user.id,
        cancellationReason: parsed.data.cancellationReason,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
      })
    );
    revalidateFinishedSales();
    return { success: true };
  } catch (error) {
    if (error instanceof posting.PostingError) return { error: error.message };
    console.error("cancelFinishedJewellerySaleAction failed:", error);
    return { error: "Could not cancel this sale. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Return items from a Finished Jewellery Sale (Owner-only)
// ---------------------------------------------------------------------------

export async function returnFinishedJewelleryItemsAction(
  _prevState: FinishedSaleFormState,
  formData: FormData
): Promise<FinishedSaleFormState> {
  const user = await requireOwner();

  const parsed = returnFinishedJewelleryItemsSchema.safeParse({
    saleId: formData.get("saleId"),
    returnDate: formData.get("returnDate"),
    reason: formData.get("reason"),
    items: readJsonArray(formData, "itemsJson"),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const returnDate = safeParseDateOnly(data.returnDate);
  if (!returnDate) return { error: "Enter a valid return date." };

  const fy = await getCompanyFySettings();

  if (data.idempotencyKey) {
    const existing = await prisma.finishedJewelleryReturn.findUnique({
      where: { idempotencyKey: data.idempotencyKey },
    });
    if (existing) return { success: true, code: existing.returnCode };
  }

  try {
    const result = await prisma.$transaction((tx) =>
      finishedSalesPosting.returnFinishedJewelleryItems(tx, {
        saleId: data.saleId,
        items: data.items,
        reason: data.reason,
        returnDate,
        createdByUserId: user.id,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        idempotencyKey: data.idempotencyKey || null,
      })
    );
    revalidateFinishedSales();
    return { success: true, code: result.return.returnCode };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.finishedJewelleryReturn.findUnique({
        where: { idempotencyKey: data.idempotencyKey },
      });
      if (existing) return { success: true, code: existing.returnCode };
    }
    if (error instanceof posting.PostingError) return { error: error.message };
    console.error("returnFinishedJewelleryItemsAction failed:", error);
    return { error: "Could not save this return. Please try again." };
  }
}

// ---------------------------------------------------------------------------
// Customer refund (Owner-only)
// ---------------------------------------------------------------------------

export async function createCustomerRefundAction(
  _prevState: FinishedSaleFormState,
  formData: FormData
): Promise<FinishedSaleFormState> {
  const user = await requireOwner();

  const parsed = customerRefundSchema.safeParse({
    partyId: formData.get("partyId"),
    paymentAccountId: formData.get("paymentAccountId"),
    amount: formData.get("amount"),
    date: formData.get("date"),
    note: formData.get("note") || "",
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }
  const data = parsed.data;

  const date = safeParseDateOnly(data.date);
  if (!date) return { error: "Enter a valid date." };

  const fy = await getCompanyFySettings();

  // A refund can never exceed the customer's actual available credit —
  // computed here from the SAME AR/AP grouping getPartyBalances uses
  // (positive = they owe us, negative = we owe them), never trusted
  // purely from a client-submitted figure.
  const balance = await getPartyNetBalance(data.partyId);
  if (balance.greaterThanOrEqualTo(0)) {
    return { error: "This customer has no credit balance to refund." };
  }
  const availableCredit = balance.abs();
  if (data.amount > Number(availableCredit.toFixed(2))) {
    return { error: `Refund cannot exceed the available customer credit of ₹${availableCredit.toFixed(2)}.` };
  }

  if (data.idempotencyKey) {
    const existing = await prisma.voucher.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
    if (existing) return { success: true, code: existing.voucherNumber };
  }

  try {
    const voucher = await prisma.$transaction((tx) =>
      posting.postCustomerRefund(tx, {
        date,
        fyStartMonth: fy.fyStartMonth,
        fyStartDay: fy.fyStartDay,
        currencyCode: "INR",
        exchangeRate: 1,
        note: data.note || null,
        idempotencyKey: data.idempotencyKey || null,
        createdByUserId: user.id,
        partyId: data.partyId,
        paymentAccountId: data.paymentAccountId,
        amount: data.amount,
      })
    );
    revalidateFinishedSales();
    return { success: true, code: voucher.voucherNumber };
  } catch (error) {
    if (isIdempotencyConflict(error) && data.idempotencyKey) {
      const existing = await prisma.voucher.findUnique({ where: { idempotencyKey: data.idempotencyKey } });
      if (existing) return { success: true, code: existing.voucherNumber };
    }
    if (error instanceof posting.PostingError) return { error: error.message };
    console.error("createCustomerRefundAction failed:", error);
    return { error: "Could not save this refund. Please try again." };
  }
}

async function getPartyNetBalance(partyId: string) {
  const accounts = await prisma.account.findMany({
    where: { code: { in: [SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE] } },
  });
  const agg = await prisma.journalEntry.aggregate({
    where: { partyId, accountId: { in: accounts.map((a) => a.id) } },
    _sum: { debit: true, credit: true },
  });
  return new Decimal(agg._sum.debit ?? 0).minus(agg._sum.credit ?? 0);
}

// ---------------------------------------------------------------------------
// Owner-only manual stock adjustment
// ---------------------------------------------------------------------------

export async function adjustFinishedJewelleryStockAction(
  _prevState: FinishedSaleFormState,
  formData: FormData
): Promise<FinishedSaleFormState> {
  const user = await requireOwner();

  const parsed = adjustFinishedJewelleryStockSchema.safeParse({
    finishedJewelleryId: formData.get("finishedJewelleryId"),
    direction: formData.get("direction"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  try {
    await prisma.$transaction((tx) =>
      finishedSalesPosting.adjustFinishedJewelleryStock(tx, {
        finishedJewelleryId: parsed.data.finishedJewelleryId,
        direction: parsed.data.direction,
        reason: parsed.data.reason,
        createdByUserId: user.id,
      })
    );
    revalidateFinishedSales();
    return { success: true };
  } catch (error) {
    if (error instanceof posting.PostingError) return { error: error.message };
    console.error("adjustFinishedJewelleryStockAction failed:", error);
    return { error: "Could not save this adjustment. Please try again." };
  }
}
