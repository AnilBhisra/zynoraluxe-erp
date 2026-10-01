"use server";

import { revalidatePath } from "next/cache";

import { Prisma } from "@/generated/prisma/client";
import type { CustomerGoldSettlement, GstTreatment, MetalRateBasis } from "@/generated/prisma/enums";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import {
  approveCustomerGoldMix,
  customerGoldTransferFingerprint,
  planCustomerGoldIntake,
  planCustomerGoldTransfer,
  postCustomerGoldTransfer,
  receiveCustomerGold,
  reverseCustomerGoldEntry,
  TRANSFER_KINDS,
  type CustomerGoldTransferInput,
  type CustomerGoldTransferKind,
} from "@/lib/jewellery/customerGold";
import {
  billCustomerJewellery,
  customerGoldPurchaseFingerprint,
  deliverCustomerJewellery,
  planCustomerGoldPurchase,
  planCustomerJewelleryBill,
  purchaseCustomerGold,
  reverseCustomerJewelleryBill,
  reverseCustomerJewelleryDelivery,
  type CustomerGoldPurchaseInput,
  type CustomerJewelleryBillInput,
} from "@/lib/jewellery/customerGoldCommercial";
import { CustomerGoldError, ENTRY_KIND_LABEL } from "@/lib/jewellery/customerGoldLedger";
import { planCustomerGoldReceiptReversal, reverseCustomerGoldJobReceipt, type ReceiptReversalPlan } from "@/lib/jewellery/customerGoldReceiptReversal";
import {
  customerGoldPurchaseReversalBlock,
  exchangeOldGold,
  oldGoldExchangeFingerprint,
  planOldGoldExchange,
  reverseCustomerGoldPurchase,
  type OldGoldExchangeInput,
} from "@/lib/jewellery/oldGoldExchange";
import { PostingError } from "@/lib/jewellery/posting";
import { deleteJewelleryAsset } from "@/lib/storage/jewelleryMedia";
import { CorrectionError } from "@/lib/corrections/types";

/**
 * Customer Gold server actions. Every permission is enforced HERE (and again
 * in the library): intake, movements, reversals, mix approval, purchase and
 * billing are Owner-only; delivery is Owner or Staff. Staff-reachable replies
 * carry codes and weights only.
 */

const TX = { timeout: 30000, maxWait: 15000 } as const;

export type CustomerGoldFormState = { error?: string; success?: boolean; code?: string; id?: string; replayed?: boolean } | undefined;

const str = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === "string" ? v.trim() : "";
};
const opt = (fd: FormData, name: string) => str(fd, name) || null;
const date = (fd: FormData, name: string) => {
  const v = str(fd, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new CustomerGoldError("Enter the date.");
  return new Date(`${v}T00:00:00.000Z`);
};
function failure(operation: string, error: unknown): string {
  if (error instanceof CustomerGoldError || error instanceof PostingError || error instanceof CorrectionError) return error.message;
  console.error("customer gold failed", {
    operation,
    errorName: error instanceof Error ? error.name : typeof error,
    prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null,
    message: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
  return "Could not save this. Nothing was saved — please try again.";
}
function revalidateAll() {
  revalidatePath("/jewellery-jobs");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
}

// ---------------------------------------------------------------------------
// Intake — "Customer-owned gold — for manufacturing" (Owner)
// ---------------------------------------------------------------------------

export type CustomerGoldIntakePreview = {
  customerName: string;
  purityDisplayName: string;
  finenessPercent: string;
  grossWeight: string;
  deductionWeight: string;
  netGrossWeight: string;
  fineWeight: string;
};

function intakeInput(fd: FormData) {
  const basis = str(fd, "inputBasis");
  if (basis !== "GROSS" && basis !== "FINE") throw new CustomerGoldError("Choose whether the weight is gross or fine.");
  return {
    customerId: str(fd, "customerId"),
    intakeDate: date(fd, "intakeDate"),
    purityId: str(fd, "purityId"),
    inputBasis: basis as "GROSS" | "FINE",
    weight: str(fd, "weight"),
    deductionWeight: opt(fd, "deductionWeight"),
    reference: opt(fd, "reference"),
    reason: str(fd, "reason"),
    declaredValue: opt(fd, "declaredValue"),
    photoAssetId: opt(fd, "photoAssetId"),
  };
}

export async function previewCustomerGoldIntakeAction(_prev: { error?: string; preview?: CustomerGoldIntakePreview } | undefined, fd: FormData) {
  await requireOwner();
  try {
    const plan = await planCustomerGoldIntake(prisma, intakeInput(fd));
    return {
      preview: {
        customerName: plan.customerName,
        purityDisplayName: plan.purityDisplayName,
        finenessPercent: plan.finenessPercent.toFixed(3),
        grossWeight: plan.grossWeight.toFixed(3),
        deductionWeight: plan.deductionWeight.toFixed(3),
        netGrossWeight: plan.netGrossWeight.toFixed(3),
        fineWeight: plan.fineWeight.toFixed(3),
      },
    };
  } catch (error) {
    return { error: failure("intake preview", error) };
  }
}

export async function receiveCustomerGoldAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  const idempotencyKey = str(fd, "idempotencyKey");
  try {
    const r = await prisma.$transaction((tx) => receiveCustomerGold(tx, { ...intakeInput(fd), idempotencyKey, actor: { id: user.id, role: user.role } }), TX);
    revalidateAll();
    return { success: true, code: r.receipt.receiptCode, id: r.receipt.id, replayed: r.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.customerGoldReceipt.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.receiptCode, id: existing.id, replayed: true };
    }
    return { error: failure("intake", error) };
  }
}

// ---------------------------------------------------------------------------
// Movements (Owner): issue/return Karigar, allocate/release job, return to Customer
// ---------------------------------------------------------------------------

export type CustomerGoldTransferPreview = {
  kindLabel: string;
  customerName: string;
  purityDisplayName: string;
  finenessPercent: string;
  fromLabel: string;
  toLabel: string;
  movedGross: string;
  movedFine: string;
  fromBefore: { gross: string; fine: string };
  fromAfter: { gross: string; fine: string };
  toBefore: { gross: string; fine: string };
  toAfter: { gross: string; fine: string };
  fingerprint: string;
};

function transferInput(fd: FormData): CustomerGoldTransferInput {
  const kind = str(fd, "kind") as CustomerGoldTransferKind;
  if (!(TRANSFER_KINDS as readonly string[]).includes(kind)) throw new CustomerGoldError("Choose what to do.");
  const all = str(fd, "all") === "1";
  const basis = str(fd, "weightBasis") === "FINE" ? "FINE" : "GROSS";
  return {
    kind,
    customerId: str(fd, "customerId"),
    purityId: str(fd, "purityId"),
    finenessPercent: str(fd, "finenessPercent"),
    karigarId: opt(fd, "karigarId"),
    jobId: opt(fd, "jobId"),
    all,
    grossWeight: !all && basis === "GROSS" ? opt(fd, "weight") : null,
    fineWeight: !all && basis === "FINE" ? opt(fd, "weight") : null,
    entryDate: date(fd, "entryDate"),
    reason: str(fd, "reason"),
    reference: opt(fd, "reference"),
  };
}

export async function previewCustomerGoldTransferAction(_prev: { error?: string; preview?: CustomerGoldTransferPreview } | undefined, fd: FormData) {
  await requireOwner();
  try {
    const plan = await planCustomerGoldTransfer(prisma, transferInput(fd));
    const w = (p: { gross: { toFixed: (n: number) => string }; fine: { toFixed: (n: number) => string } }) => ({ gross: p.gross.toFixed(3), fine: p.fine.toFixed(3) });
    return {
      preview: {
        kindLabel: ENTRY_KIND_LABEL[plan.kind],
        customerName: plan.customerName,
        purityDisplayName: plan.purityDisplayName,
        finenessPercent: plan.pool.finenessPercentSnapshot.toFixed(3),
        fromLabel: plan.fromLabel,
        toLabel: plan.toLabel,
        movedGross: plan.moved.gross.toFixed(3),
        movedFine: plan.moved.fine.toFixed(3),
        fromBefore: w(plan.fromBefore),
        fromAfter: w(plan.fromAfter),
        toBefore: w(plan.toBefore),
        toAfter: w(plan.toAfter),
        fingerprint: customerGoldTransferFingerprint(plan),
      },
    };
  } catch (error) {
    return { error: failure("transfer preview", error) };
  }
}

export async function postCustomerGoldTransferAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  const idempotencyKey = str(fd, "idempotencyKey");
  const fingerprint = str(fd, "previewFingerprint");
  if (!fingerprint) return { error: "Preview first, then confirm." };
  try {
    const r = await prisma.$transaction(
      (tx) => postCustomerGoldTransfer(tx, { ...transferInput(fd), expectedFingerprint: fingerprint, idempotencyKey, actor: { id: user.id, role: user.role } }),
      TX
    );
    revalidateAll();
    return { success: true, code: r.entry.entryCode, replayed: r.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.customerGoldEntry.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.entryCode, replayed: true };
    }
    return { error: failure("transfer", error) };
  }
}

export async function reverseCustomerGoldEntryAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  try {
    const r = await prisma.$transaction(
      (tx) => reverseCustomerGoldEntry(tx, { entryId: str(fd, "entryId"), reason: str(fd, "reason"), idempotencyKey: opt(fd, "idempotencyKey"), actor: { id: user.id, role: user.role } }),
      TX
    );
    revalidateAll();
    return { success: true, code: r.reversal.entryCode, replayed: r.replayed };
  } catch (error) {
    return { error: failure("reversal", error) };
  }
}

export async function approveCustomerGoldMixAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  try {
    await prisma.$transaction((tx) => approveCustomerGoldMix(tx, { jobId: str(fd, "jobId"), reason: str(fd, "reason"), actor: { id: user.id, role: user.role } }), TX);
    revalidateAll();
    return { success: true };
  } catch (error) {
    return { error: failure("mix approval", error) };
  }
}

// ---------------------------------------------------------------------------
// Purchase / exchange (Owner-approved)
// ---------------------------------------------------------------------------

export type CustomerGoldPurchasePreview = {
  customerName: string;
  purityDisplayName: string;
  finenessPercent: string;
  grossWeight: string;
  fineWeight: string;
  value: string;
  safeBefore: { gross: string; fine: string } | null;
  safeAfter: { gross: string; fine: string } | null;
  fingerprint: string;
};

function purchaseInput(fd: FormData): CustomerGoldPurchaseInput {
  const source = str(fd, "source") === "CUSTODY" ? "CUSTODY" : "DIRECT";
  const basis = str(fd, "weightBasis") === "FINE" ? "FINE" : "GROSS";
  const all = str(fd, "all") === "1";
  const rateBasis = str(fd, "rateBasis") as MetalRateBasis;
  if (!["PER_GROSS_GRAM", "PER_FINE_GRAM", "FIXED_TOTAL"].includes(rateBasis)) throw new CustomerGoldError("Choose how the rate is given.");
  const settlement = str(fd, "settlement") as CustomerGoldSettlement;
  if (settlement !== "PAY_CUSTOMER" && settlement !== "CREDIT_TO_INVOICE") throw new CustomerGoldError("Choose how the Customer is settled.");
  return {
    customerId: str(fd, "customerId"),
    purchaseDate: date(fd, "purchaseDate"),
    purityId: str(fd, "purityId"),
    source,
    grossWeight: !all && (source === "DIRECT" || basis === "GROSS") ? opt(fd, "weight") : null,
    fineWeight: !all && source === "CUSTODY" && basis === "FINE" ? opt(fd, "weight") : null,
    all: source === "CUSTODY" && all,
    finenessPercent: opt(fd, "finenessPercent"),
    rateBasis,
    rate: str(fd, "rate"),
    settlement,
    reason: str(fd, "reason"),
    reference: opt(fd, "reference"),
    approved: str(fd, "approved") === "1",
  };
}

export async function previewCustomerGoldPurchaseAction(_prev: { error?: string; preview?: CustomerGoldPurchasePreview } | undefined, fd: FormData) {
  await requireOwner();
  try {
    const input = purchaseInput(fd);
    const plan = await planCustomerGoldPurchase(prisma, input);
    const w = (p: { gross: { toFixed: (n: number) => string }; fine: { toFixed: (n: number) => string } } | null) => (p ? { gross: p.gross.toFixed(3), fine: p.fine.toFixed(3) } : null);
    return {
      preview: {
        customerName: plan.customerName,
        purityDisplayName: plan.purityDisplayName,
        finenessPercent: plan.finenessPercent.toFixed(3),
        grossWeight: plan.gross.toFixed(3),
        fineWeight: plan.fine.toFixed(3),
        value: plan.value.toFixed(2),
        safeBefore: w(plan.safeBefore),
        safeAfter: w(plan.safeAfter),
        fingerprint: customerGoldPurchaseFingerprint(input, plan),
      },
    };
  } catch (error) {
    return { error: failure("purchase preview", error) };
  }
}

export async function purchaseCustomerGoldAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  const idempotencyKey = str(fd, "idempotencyKey");
  const fingerprint = str(fd, "previewFingerprint");
  if (!fingerprint) return { error: "Preview first, then approve." };
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction(
      (tx) => purchaseCustomerGold(tx, { ...purchaseInput(fd), expectedFingerprint: fingerprint, idempotencyKey, actor: { id: user.id, role: user.role }, ...fy }),
      TX
    );
    revalidateAll();
    return { success: true, code: r.purchase.purchaseCode, replayed: r.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.customerGoldPurchase.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.purchaseCode, replayed: true };
    }
    return { error: failure("purchase", error) };
  }
}

// ---------------------------------------------------------------------------
// Old Gold Exchange (Owner): intake + approved purchase of exactly that intake
// ---------------------------------------------------------------------------

export type OldGoldExchangePreview = {
  customerName: string;
  purityDisplayName: string;
  finenessPercent: string;
  statedPurity: string | null;
  grossWeight: string;
  deductionWeight: string;
  netGrossWeight: string;
  fineWeight: string;
  rateBasis: string;
  rate: string;
  value: string;
  perGrossGram: string;
  perFineGram: string;
  settlement: string;
  creditBefore: string;
  creditAfter: string;
  fingerprint: string;
};

function exchangeInput(fd: FormData): OldGoldExchangeInput {
  const basis = str(fd, "inputBasis");
  if (basis !== "GROSS" && basis !== "FINE") throw new CustomerGoldError("Choose whether the weight is gross or fine.");
  const rateBasis = str(fd, "rateBasis") as MetalRateBasis;
  if (!["PER_GROSS_GRAM", "PER_FINE_GRAM", "FIXED_TOTAL"].includes(rateBasis)) throw new CustomerGoldError("Choose how the rate is given.");
  const settlement = str(fd, "settlement") as CustomerGoldSettlement;
  if (settlement !== "PAY_CUSTOMER" && settlement !== "CREDIT_TO_INVOICE") throw new CustomerGoldError("Choose how the Customer is settled.");
  return {
    customerId: str(fd, "customerId"),
    exchangeDate: date(fd, "exchangeDate"),
    purityId: str(fd, "purityId"),
    statedPurity: opt(fd, "statedPurity"),
    inputBasis: basis,
    weight: str(fd, "weight"),
    deductionWeight: opt(fd, "deductionWeight"),
    rateBasis,
    rate: str(fd, "rate"),
    settlement,
    reason: str(fd, "reason"),
    reference: str(fd, "reference"),
    photoAssetId: opt(fd, "photoAssetId"),
  };
}

export async function previewOldGoldExchangeAction(_prev: { error?: string; preview?: OldGoldExchangePreview } | undefined, fd: FormData) {
  await requireOwner();
  try {
    const input = exchangeInput(fd);
    const plan = await planOldGoldExchange(prisma, input);
    return {
      preview: {
        customerName: plan.customerName,
        purityDisplayName: plan.purityDisplayName,
        finenessPercent: plan.finenessPercent.toFixed(3),
        statedPurity: plan.statedPurity,
        grossWeight: plan.grossWeight.toFixed(3),
        deductionWeight: plan.deductionWeight.toFixed(3),
        netGrossWeight: plan.netGrossWeight.toFixed(3),
        fineWeight: plan.fineWeight.toFixed(3),
        rateBasis: plan.rateBasis,
        rate: plan.rate.toFixed(4),
        value: plan.value.toFixed(2),
        perGrossGram: plan.perGrossGram.toFixed(4),
        perFineGram: plan.perFineGram.toFixed(4),
        settlement: plan.settlement,
        creditBefore: plan.creditBefore.toFixed(2),
        creditAfter: plan.creditAfter.toFixed(2),
        fingerprint: oldGoldExchangeFingerprint(input, plan),
      },
    };
  } catch (error) {
    return { error: failure("old gold exchange preview", error) };
  }
}

export async function exchangeOldGoldAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  const idempotencyKey = str(fd, "idempotencyKey");
  const fingerprint = str(fd, "previewFingerprint");
  if (!fingerprint) return { error: "Preview first, then approve." };
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction(
      (tx) =>
        exchangeOldGold(tx, {
          ...exchangeInput(fd),
          approved: str(fd, "approved") === "1",
          expectedFingerprint: fingerprint,
          idempotencyKey,
          actor: { id: user.id, role: user.role },
          ...fy,
        }),
      TX
    );
    revalidateAll();
    return { success: true, code: r.purchase.purchaseCode, id: r.purchase.id, replayed: r.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.customerGoldPurchase.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.purchaseCode, id: existing.id, replayed: true };
    }
    return { error: failure("old gold exchange", error) };
  }
}

/** Owner: can this purchase / exchange be reversed now, and if not, exactly why. */
export type PurchaseReversalCheck = { purchaseId: string; error?: string; block?: string | null };

export async function previewCustomerGoldPurchaseReversalAction(_prev: PurchaseReversalCheck | undefined, fd: FormData): Promise<PurchaseReversalCheck> {
  await requireOwner();
  const purchaseId = str(fd, "purchaseId");
  try {
    return { purchaseId, block: await prisma.$transaction((tx) => customerGoldPurchaseReversalBlock(tx, purchaseId), TX) };
  } catch (error) {
    return { purchaseId, error: failure("purchase reversal preview", error) };
  }
}

export async function reverseCustomerGoldPurchaseAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  const idempotencyKey = str(fd, "idempotencyKey");
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction(
      (tx) => reverseCustomerGoldPurchase(tx, { purchaseId: str(fd, "purchaseId"), reason: str(fd, "reason"), idempotencyKey, actor: { id: user.id, role: user.role }, ...fy }),
      TX
    );
    revalidateAll();
    return { success: true, code: r.purchase.purchaseCode, replayed: r.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.customerGoldPurchase.findUnique({ where: { reversalIdempotencyKey: idempotencyKey } });
      if (existing) return { success: true, code: existing.purchaseCode, replayed: true };
    }
    return { error: failure("purchase reversal", error) };
  }
}

// ---------------------------------------------------------------------------
// Bill (Owner) and delivery (Owner or Staff)
// ---------------------------------------------------------------------------

export type CustomerJewelleryBillPreview = {
  customerName: string;
  jobCode: string;
  taxableValue: string;
  taxAmount: string;
  grandTotal: string;
  creditApplied: string;
  amountDue: string;
  creditAvailable: string;
};

function billInput(fd: FormData): CustomerJewelleryBillInput {
  const gst = str(fd, "gstTreatment") as GstTreatment;
  if (!["NONE", "CGST_SGST", "IGST"].includes(gst)) throw new CustomerGoldError("Choose the GST treatment.");
  return {
    jobId: str(fd, "jobId"),
    billDate: date(fd, "billDate"),
    makingCharge: opt(fd, "makingCharge"),
    diamondCharge: opt(fd, "diamondCharge"),
    materialCharge: opt(fd, "materialCharge"),
    otherCharge: opt(fd, "otherCharge"),
    gstTreatment: gst,
    gstRatePercent: opt(fd, "gstRatePercent"),
    creditToApply: opt(fd, "creditToApply"),
    description: opt(fd, "description"),
  };
}

export async function previewCustomerJewelleryBillAction(_prev: { error?: string; preview?: CustomerJewelleryBillPreview } | undefined, fd: FormData) {
  await requireOwner();
  try {
    const p = await planCustomerJewelleryBill(prisma, billInput(fd));
    return {
      preview: {
        customerName: p.customerName,
        jobCode: p.jobCode,
        taxableValue: p.taxableValue.toFixed(2),
        taxAmount: p.taxAmount.toFixed(2),
        grandTotal: p.grandTotal.toFixed(2),
        creditApplied: p.creditApplied.toFixed(2),
        amountDue: p.amountDue.toFixed(2),
        creditAvailable: p.creditAvailable.toFixed(2),
      },
    };
  } catch (error) {
    return { error: failure("bill preview", error) };
  }
}

export async function billCustomerJewelleryAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  const idempotencyKey = str(fd, "idempotencyKey");
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction((tx) => billCustomerJewellery(tx, { ...billInput(fd), idempotencyKey, actor: { id: user.id, role: user.role }, ...fy }), TX);
    revalidateAll();
    return { success: true, code: r.bill.billCode, replayed: r.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.customerJewelleryBill.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.billCode, replayed: true };
    }
    return { error: failure("bill", error) };
  }
}

export async function reverseCustomerJewelleryBillAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction((tx) => reverseCustomerJewelleryBill(tx, { billId: str(fd, "billId"), reason: str(fd, "reason"), actor: { id: user.id, role: user.role }, ...fy }), TX);
    revalidateAll();
    return { success: true, code: r.billCode };
  } catch (error) {
    return { error: failure("bill reversal", error) };
  }
}

/** Owner or Staff. The reply is the delivery code only — never a cost. */
export async function deliverCustomerJewelleryAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireUser();
  const idempotencyKey = str(fd, "idempotencyKey");
  const fy = await getCompanyFySettings();
  let pieceIds: string[] = [];
  try {
    const raw = str(fd, "pieceIdsJson");
    pieceIds = raw ? (JSON.parse(raw) as unknown[]).filter((x): x is string => typeof x === "string") : [];
  } catch {
    return { error: "Choose the pieces to deliver." };
  }
  try {
    const r = await prisma.$transaction(
      (tx) =>
        deliverCustomerJewellery(tx, {
          jobId: str(fd, "jobId"),
          finishedJewelleryIds: pieceIds,
          deliveryDate: date(fd, "deliveryDate"),
          receivedByName: str(fd, "receivedByName"),
          reference: opt(fd, "reference"),
          notes: opt(fd, "notes"),
          idempotencyKey,
          actor: { id: user.id, role: user.role },
          ...fy,
        }),
      TX
    );
    revalidateAll();
    return { success: true, code: r.delivery.deliveryCode, replayed: r.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.customerJewelleryDelivery.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.deliveryCode, replayed: true };
    }
    // Delivery refusals carry weights and codes only. Anything from the
    // accounting layer (which may name an amount) never reaches Staff.
    if (user.role !== "OWNER" && !(error instanceof CustomerGoldError)) {
      failure("delivery", error);
      return { error: "Could not save this delivery. Nothing was saved — please ask the Owner." };
    }
    return { error: failure("delivery", error) };
  }
}

export async function reverseCustomerJewelleryDeliveryAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction(
      (tx) => reverseCustomerJewelleryDelivery(tx, { deliveryId: str(fd, "deliveryId"), reason: str(fd, "reason"), actor: { id: user.id, role: user.role }, ...fy }),
      TX
    );
    revalidateAll();
    return { success: true, code: r.deliveryCode };
  } catch (error) {
    return { error: failure("delivery reversal", error) };
  }
}

// ---------------------------------------------------------------------------
// Customer Gold jewellery receipt reversal (Owner) — CUSTOMER_GOLD_DESIGN.md §2.6
// ---------------------------------------------------------------------------

export async function previewCustomerGoldReceiptReversalAction(_prev: { error?: string; plan?: ReceiptReversalPlan } | undefined, fd: FormData) {
  await requireOwner();
  try {
    return { plan: await planCustomerGoldReceiptReversal(prisma, str(fd, "receiptId")) };
  } catch (error) {
    return { error: failure("receipt reversal preview", error) };
  }
}

export async function reverseCustomerGoldReceiptAction(_prev: CustomerGoldFormState, fd: FormData): Promise<CustomerGoldFormState> {
  const user = await requireOwner();
  const idempotencyKey = str(fd, "idempotencyKey");
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction(
      (tx) => reverseCustomerGoldJobReceipt(tx, { receiptId: str(fd, "receiptId"), reason: str(fd, "reason"), idempotencyKey, actor: { id: user.id, role: user.role }, ...fy }),
      TX
    );
    revalidateAll();
    return { success: true, code: r.receipt.receiptCode, replayed: r.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.jewelleryReceipt.findUnique({ where: { reversalIdempotencyKey: idempotencyKey } });
      if (existing) return { success: true, code: existing.receiptCode, replayed: true };
    }
    return { error: failure("receipt reversal", error) };
  }
}

/**
 * Discards a photo uploaded for a Customer gold intake that was then abandoned
 * or failed (Owner only). Refuses any asset a saved record already points at,
 * so this can never remove a photo that belongs to real data.
 */
export async function discardCustomerGoldPhotoAction(assetId: string): Promise<{ discarded: boolean }> {
  await requireOwner();
  const id = typeof assetId === "string" ? assetId.trim() : "";
  if (!id) return { discarded: false };
  const [cg, pieces, jobs, sheets] = await Promise.all([
    prisma.customerGoldReceipt.count({ where: { photoAssetId: id } }),
    prisma.finishedJewellery.count({ where: { photoAssetId: id } }),
    prisma.jewelleryJob.count({ where: { designImageAssetId: id } }),
    prisma.costSheet.count({ where: { designImageAssetId: id } }),
  ]);
  if (cg + pieces + jobs + sheets > 0) return { discarded: false };
  return { discarded: await deleteJewelleryAsset(id).catch(() => false) };
}
