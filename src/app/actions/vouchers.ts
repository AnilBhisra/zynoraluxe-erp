"use server";

import { revalidatePath } from "next/cache";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { checkVoucherDateAllowed, parseDateOnly } from "@/lib/accounting/financialYear";
import { postVoucherOnce, type VoucherRequestFingerprint } from "@/lib/accounting/idempotentPosting";
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
  | {
      error?: string;
      success?: boolean;
      voucherNumber?: string;
      /** True when this submission had already been saved (double-click, retry): nothing new was posted. */
      replayed?: boolean;
    }
  | undefined;

/**
 * Every page that shows a balance moved by an Accounting voucher: party
 * payable/receivable, Cash/Bank, Karigar payable (Jewellery Jobs), Customer
 * Gold bills and credit, Manufacturer payable (Diamond).
 */
function revalidateAccountingViews() {
  for (const path of ["/accounting", "/dashboard", "/jewellery-jobs", "/customer-gold", "/diamond"]) {
    revalidatePath(path);
  }
}

async function withVoucherPosting(
  idempotencyKey: string | undefined,
  request: VoucherRequestFingerprint,
  post: (tx: Prisma.TransactionClient) => Promise<{ voucherNumber: string }>
): Promise<VoucherFormState> {
  try {
    const result = await postVoucherOnce(idempotencyKey, request, post);
    if (result.status === "KEY_REUSED") {
      return {
        error: `Nothing was saved: this form had already saved ${result.voucherNumber}. Close the form and open it again to enter another one.`,
      };
    }
    return { success: true, voucherNumber: result.voucherNumber, replayed: result.status === "REPLAYED" };
  } catch (error) {
    if (error instanceof posting.PostingError) {
      return { error: error.message };
    }
    console.error("Voucher posting failed:", error);
    return { error: "Could not save this entry. Nothing was saved — please try again." };
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

  const lines = data.lines.map((l) => ({
    description: l.description,
    hsnSac: l.hsnSac || null,
    quantity: l.quantity,
    unit: l.unit,
    rate: l.rate,
    discount: l.discount,
    gstRateId: l.gstRateId,
    gstRatePercent: gstRateMap.get(l.gstRateId)!.ratePercent.toString(),
    taxType: l.taxType,
  }));

  const result = await withVoucherPosting(
    data.idempotencyKey,
    {
      voucherType: "PURCHASE",
      partyId: data.partyId,
      paymentAccountId: data.paymentAccountId || null,
      amount: posting.computeLineTotalsForAll(lines).totalAmount,
      date,
      createdByUserId: user.id,
    },
    (tx) =>
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
        lines,
      })
  );

  revalidateAccountingViews();
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

  const lines = data.lines.map((l) => ({
    description: l.description,
    hsnSac: l.hsnSac || null,
    quantity: l.quantity,
    unit: l.unit,
    rate: l.rate,
    discount: l.discount,
    gstRateId: l.gstRateId,
    gstRatePercent: gstRateMap.get(l.gstRateId)!.ratePercent.toString(),
    taxType: l.taxType,
  }));

  const result = await withVoucherPosting(
    data.idempotencyKey,
    {
      voucherType: "SALE",
      partyId: data.partyId,
      paymentAccountId: data.paymentAccountId || null,
      amount: posting.computeLineTotalsForAll(lines).totalAmount,
      date,
      createdByUserId: user.id,
    },
    (tx) =>
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
        lines,
        clearing: (() => {
          const currencyCode = String(formData.get("clearingCurrency") ?? "").trim();
          return currencyCode ? { currencyCode, foreignAmount: String(formData.get("clearingAmount") ?? "").trim() || null } : null;
        })(),
      })
  );

  revalidateAccountingViews();
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

  const result = await withVoucherPosting(
    data.idempotencyKey,
    {
      voucherType: "PAYMENT_GIVEN",
      partyId: data.partyId,
      paymentAccountId: data.paymentAccountId,
      amount: data.amount,
      date,
      createdByUserId: user.id,
    },
    (tx) =>
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
  );

  revalidateAccountingViews();
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

  const result = await withVoucherPosting(
    data.idempotencyKey,
    {
      voucherType: "PAYMENT_RECEIVED",
      partyId: data.partyId,
      paymentAccountId: data.paymentAccountId,
      amount: data.amount,
      date,
      createdByUserId: user.id,
    },
    (tx) =>
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
  );

  revalidateAccountingViews();
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

  const result = await withVoucherPosting(
    data.idempotencyKey,
    {
      voucherType: "EXPENSE",
      partyId: data.partyId || null,
      paymentAccountId: data.paymentAccountId,
      amount: data.amount,
      date,
      createdByUserId: user.id,
    },
    (tx) =>
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
  );

  revalidateAccountingViews();
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

  // Diamond-module vouchers (Rough Issue -> WIP, Polished Receipt) must
  // never be cancelled through this generic action: reversing the
  // accounting alone here would leave RoughPiece/DiamondJob status out of
  // sync with the ledger. Rough issues have their own cancellation path
  // (Diamond module "Cancel job", which reverses both together);
  // polished receipts are not reversible in Phase 3 at all.
  const target = await prisma.voucher.findUnique({
    where: { id: parsed.data.voucherId },
    select: { voucherType: true },
  });
  if (target?.voucherType === "STOCK_ADJUSTMENT") {
    return { error: "A stock adjustment is corrected with an opposite adjustment on the Polished Diamond page, so packet stock stays in sync." };
  }
  if (target?.voucherType === "DIAMOND_ISSUE") {
    return { error: "Cancel this from the Diamond module's job detail view instead, so stock stays in sync." };
  }
  if (target?.voucherType === "DIAMOND_RECEIPT") {
    return { error: "Polished receipts cannot be cancelled in Phase 3." };
  }
  // Same integrity risk, same fix, for Phase 4 Jewellery Job vouchers.
  if (target?.voucherType === "JEWELLERY_ISSUE") {
    return { error: "Cancel this from the Jewellery Jobs page's job detail view instead, so stock stays in sync." };
  }
  if (target?.voucherType === "JEWELLERY_RECEIPT") {
    return { error: "Jewellery receipts cannot be cancelled in Phase 4." };
  }
  // A missing-charges correction also moved the finished piece's cost and the
  // job's charge total; cancelling only its voucher here would leave those out
  // of step with the ledger. It is undone from the receipt, which reverses all
  // of it together (and only while the pieces are still Available and unsold).
  if (target?.voucherType === "CORRECTION") {
    const chargeCorrection = await prisma.correction.findFirst({
      where: { correctionVoucherId: parsed.data.voucherId, mode: "ADD_CHARGES" },
      select: { id: true },
    });
    if (chargeCorrection) {
      return {
        error: "This voucher belongs to a missing-charges correction — reverse it from the receipt on the Jewellery Job page instead, so the piece cost and Karigar payable stay in sync.",
      };
    }
    // Same for a Manufacturer labour correction: it also moved the polished
    // outputs' cost and the job's labour total.
    const labourCorrection = await prisma.correction.findFirst({
      where: { correctionVoucherId: parsed.data.voucherId, mode: "ADD_MANUFACTURER_LABOUR" },
      select: { id: true },
    });
    if (labourCorrection) {
      return {
        error: "This voucher belongs to a Manufacturer labour correction — reverse it from the receipt on the Diamond Manufacturer job page instead, so the polished stock cost and Manufacturer payable stay in sync.",
      };
    }
    // Every other correction (metal adjustment, entry corrections, ...) is
    // undone through its own audited reversal, which also restores the stock
    // or document it changed.
    const anyCorrection = await prisma.correction.findFirst({
      where: { correctionVoucherId: parsed.data.voucherId },
      select: { id: true },
    });
    if (anyCorrection) {
      return { error: "This voucher belongs to an audited correction — reverse it from the Corrections page instead, so what it corrected stays in sync." };
    }
  }
  // Customer Gold bills and deliveries, finished-jewellery sale returns and
  // opening stock each own a document (bill status and gold-purchase credit,
  // delivered pieces, returned stock, opening metal) that this generic
  // reversal would leave behind. They are reversed from their own page, which
  // reverses the voucher and the document together.
  if (target?.voucherType === "CLEARING_SETTLEMENT" || target?.voucherType === "CLEARING_RESERVE" || target?.voucherType === "CLEARING_RECLASS") {
    return { error: "This is a clearing settlement entry — reverse it from Accounting → Settlements, so the provider's clearing balance, reserve and allocations stay in sync." };
  }
  if (target?.voucherType === "CUSTOMER_JEWELLERY_BILL") {
    return { error: "Reverse this bill from the Customer Gold bill on the Jewellery Jobs page instead, so the bill and the Customer's gold-purchase credit stay in sync." };
  }
  if (target?.voucherType === "CUSTOMER_JEWELLERY_DELIVERY") {
    return { error: "Reverse this delivery from the Customer Gold tab on the Jewellery Jobs page instead, so the delivered pieces stay in sync." };
  }
  if (target?.voucherType === "SALE_RETURN") {
    return { error: "A sale return is linked to returned Finished Jewellery stock and cannot be cancelled here." };
  }
  if (target?.voucherType === "OPENING_STOCK") {
    return { error: "Opening stock is corrected with an Owner stock adjustment on the Jewellery Jobs Metal Stock tab, so metal stock stays in sync." };
  }
  // A Rough Purchase or Metal Purchase also posts as a plain "PURCHASE"
  // voucher (there is no dedicated voucher type for either) — without this
  // check, cancelling it here would reverse the accounting while leaving
  // the real Rough/Metal stock (already issued/consumed, possibly into a
  // finished, sold piece) completely untouched, corrupting the same
  // accounting/stock sync the four checks above exist to protect.
  // Phase 6: a Finished Jewellery Sale also posts as a plain "SALE"
  // voucher (same reuse pattern as Rough/Metal Purchase reusing
  // "PURCHASE" above) — without this check, cancelling it here would
  // reverse the accounting (including the Dr COGS / Cr Finished Jewellery
  // Inventory lines, since the generic reversal mirrors every original
  // journal line) while leaving the FinishedJewellery item's own `status`
  // stuck at SOLD and creating no stock movement — desyncing stock from
  // accounting exactly like the checks above exist to prevent. Cancelling
  // a linked sale MUST go through the domain-specific
  // cancelFinishedJewellerySaleAction, which reuses this same
  // posting.cancelVoucher() call and additionally reverses stock,
  // atomically, in one transaction.
  if (target?.voucherType === "SALE") {
    const linkedSale = await prisma.finishedJewellerySale.findUnique({
      where: { voucherId: parsed.data.voucherId },
      select: { id: true },
    });
    if (linkedSale) {
      return {
        error: "This sale is linked to Finished Jewellery stock — cancel it from the Finished Stock page instead, so stock stays in sync.",
      };
    }
  }
  if (target?.voucherType === "PURCHASE") {
    // Phase 7: a direct Polished Diamond Purchase also posts as a plain
    // "PURCHASE" voucher, and its cancellation must also reverse every
    // packet's PURCHASE_IN movement (and refuse once any stone has left a
    // packet) — only cancelPolishedPurchaseAction does that atomically.
    const polishedPurchase = await prisma.polishedPurchase.findUnique({
      where: { voucherId: parsed.data.voucherId },
      select: { id: true },
    });
    if (polishedPurchase) {
      return {
        error: "This is a Polished Diamond Purchase — cancel it from the Diamond page's Polished Diamond tab instead, so packet stock stays in sync.",
      };
    }
    const roughLot = await prisma.roughLot.findUnique({
      where: { voucherId: parsed.data.voucherId },
      include: { pieces: { select: { costLocked: true } } },
    });
    if (roughLot && roughLot.pieces.some((p) => p.costLocked)) {
      return { error: "One or more pieces from this rough purchase have already been issued — it can no longer be cancelled." };
    }
    // Metal is a fungible, pooled stock (unlike individually-tracked rough
    // pieces), so there is no way to say THIS purchase's specific grams
    // were the ones issued. The safe, conservative rule mirrors the rough
    // side's own "once touched, locked" principle instead of a
    // point-in-time pool-balance check (which a large, healthy pool could
    // satisfy even after this exact purchase's metal was long since
    // issued): once ANY metal of this purity has been issued/consumed at
    // any point after this purchase was posted, the purchase can no
    // longer be safely reversed.
    const metalPurchase = await prisma.metalPurchase.findUnique({
      where: { voucherId: parsed.data.voucherId },
      include: { customerGoldPurchase: { select: { purchaseCode: true } } },
    });
    // Gold bought from a Customer (Customer Gold purchase / Old Gold exchange)
    // also carries the Customer's credit and gold ledger; only its own audited
    // reversal undoes all of that together.
    if (metalPurchase?.customerGoldPurchase) {
      return {
        error: `This is Customer gold purchase ${metalPurchase.customerGoldPurchase.purchaseCode} — reverse it from the Customer Gold tab instead, so the Customer's credit and gold ledger stay in sync.`,
      };
    }
    if (metalPurchase) {
      const purchaseMovement = await prisma.metalStockMovement.findFirst({
        where: {
          metalType: metalPurchase.metalType,
          purityId: metalPurchase.purityId,
          type: "PURCHASE_IN",
          sourceDocument: metalPurchase.purchaseCode,
        },
      });
      const laterOutflow = await prisma.metalStockMovement.findFirst({
        where: {
          metalType: metalPurchase.metalType,
          purityId: metalPurchase.purityId,
          type: { in: ["ISSUE_OUT", "CONSUMED_OUT", "ADJUSTMENT_OUT"] },
          createdAt: purchaseMovement ? { gt: purchaseMovement.createdAt } : undefined,
        },
      });
      if (laterOutflow) {
        return { error: "Metal of this purity has already been issued since this purchase was made — it can no longer be cancelled." };
      }
    }
  }

  try {
    await prisma.$transaction(
      (tx) =>
        posting.cancelVoucher(tx, {
          voucherId: parsed.data.voucherId,
          cancelledByUserId: user.id,
          cancellationReason: parsed.data.cancellationReason,
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
        }),
      posting.VOUCHER_TRANSACTION_OPTIONS
    );
  } catch (error) {
    if (error instanceof posting.PostingError) {
      return { error: error.message };
    }
    console.error("cancelVoucherAction failed:", error);
    return { error: "Could not cancel this voucher. Nothing was changed — please try again." };
  }

  revalidateAccountingViews();
  return { success: true };
}
