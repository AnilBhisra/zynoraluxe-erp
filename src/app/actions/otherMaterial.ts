"use server";

import { revalidatePath } from "next/cache";

import type { GstTreatment, OtherMaterialCategory } from "@/generated/prisma/enums";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { checkVoucherDateAllowed, parseDateOnly } from "@/lib/accounting/financialYear";
import { PostingError, VOUCHER_TRANSACTION_OPTIONS } from "@/lib/accounting/posting";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import {
  cancelOtherMaterialPurchase,
  createOtherMaterialItem,
  issueOtherMaterialToJob,
  OtherMaterialError,
  planOtherMaterialPurchase,
  postOtherMaterialPurchase,
  returnOtherMaterialFromJob,
  reverseOtherMaterialJobDocument,
  type JobMaterialLineInput,
  type OtherMaterialPurchaseInput,
} from "@/lib/jewellery/otherMaterial";
import type { UnitCode } from "@/lib/jewellery/otherMaterialAmounts";

/**
 * Other Material actions (JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §12).
 * Owner or Staff: create an item, purchase (the current Purchase policy —
 * Staff may record purchases), issue to a job, return unused material.
 * Owner only: cancel a purchase, reverse an issue / return. Replies carry
 * codes only (plus the purchase preview of the figures the user typed) —
 * never a stock carrying cost.
 */

export type OtherMaterialFormState = { error?: string; success?: boolean; code?: string; replayed?: boolean } | undefined;
export type PurchasePreview = {
  supplierName: string;
  lines: { item: string; formula: string; discount: string; taxableValue: string; taxAmount: string; lineTotal: string }[];
  subtotal: string;
  discountTotal: string;
  taxableTotal: string;
  taxTotal: string;
  grandTotal: string;
  fingerprint: string;
};

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
function date(fd: FormData, k: string): Date {
  try {
    return parseDateOnly(str(fd, k));
  } catch {
    throw new OtherMaterialError("Enter a valid date.");
  }
}
function jsonArray(fd: FormData, k: string): Record<string, unknown>[] {
  try {
    const v = JSON.parse(str(fd, k) || "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
  } catch {
    throw new OtherMaterialError("The lines could not be read. Reload the page.");
  }
}
function failure(error: unknown, what: string) {
  if (error instanceof PostingError) return error.message;
  console.error(`other material ${what} failed:`, error);
  return `Could not ${what}. Nothing was saved — please try again.`;
}
function revalidate() {
  for (const p of ["/jewellery-jobs", "/accounting", "/dashboard"]) revalidatePath(p);
}
async function dateAllowed(d: Date, role: "OWNER" | "STAFF", fd: FormData) {
  const fy = await getCompanyFySettings();
  const check = checkVoucherDateAllowed(d, role, fd.get("confirmOutsideFy") === "true", fy.fyStartMonth, fy.fyStartDay);
  if (!check.ok) throw new OtherMaterialError(check.message);
  return fy;
}
const materialLines = (fd: FormData): JobMaterialLineInput[] => jsonArray(fd, "linesJson").map((l) => ({ itemId: String(l.itemId ?? ""), quantity: String(l.quantity ?? "").trim() }));

export async function createOtherMaterialItemAction(_p: OtherMaterialFormState, fd: FormData): Promise<OtherMaterialFormState> {
  const user = await requireUser();
  try {
    const item = await prisma.$transaction(
      (tx) => createOtherMaterialItem(tx, { name: str(fd, "name"), category: (str(fd, "category") || "OTHER") as OtherMaterialCategory, unit: str(fd, "unit") as UnitCode, description: str(fd, "description") || null, actor: { id: user.id, role: user.role } }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: true, code: item.code };
  } catch (e) {
    return { error: failure(e, "add this material") };
  }
}

function purchaseInput(fd: FormData): OtherMaterialPurchaseInput {
  return {
    supplierId: str(fd, "supplierId"),
    purchaseDate: date(fd, "purchaseDate"),
    reference: str(fd, "reference") || null,
    notes: str(fd, "notes") || null,
    gstTreatment: (str(fd, "gstTreatment") || "NONE") as GstTreatment,
    lines: jsonArray(fd, "linesJson").map((l) => ({
      itemId: String(l.itemId ?? ""),
      quantity: String(l.quantity ?? ""),
      rate: String(l.rate ?? ""),
      discount: l.discount ? String(l.discount) : null,
      gstRatePercent: l.gstRatePercent ? String(l.gstRatePercent) : null,
      taxType: l.taxType === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE",
    })),
  };
}

export async function previewOtherMaterialPurchaseAction(_p: { error?: string; preview?: PurchasePreview } | undefined, fd: FormData) {
  await requireUser();
  try {
    const plan = await prisma.$transaction((tx) => planOtherMaterialPurchase(tx, purchaseInput(fd)), VOUCHER_TRANSACTION_OPTIONS);
    return {
      preview: {
        supplierName: plan.supplier.name,
        lines: plan.lines.map((l) => ({ item: `${l.item.code} ${l.item.name}`, formula: l.formula, discount: l.discount.toFixed(2), taxableValue: l.taxableValue.toFixed(2), taxAmount: l.taxAmount.toFixed(2), lineTotal: l.lineTotal.toFixed(2) })),
        subtotal: plan.totals.subtotal.toFixed(2),
        discountTotal: plan.totals.discountTotal.toFixed(2),
        taxableTotal: plan.totals.taxableTotal.toFixed(2),
        taxTotal: plan.totals.taxTotal.toFixed(2),
        grandTotal: plan.totals.grandTotal.toFixed(2),
        fingerprint: plan.fingerprint,
      },
    };
  } catch (e) {
    return { error: failure(e, "preview this purchase") };
  }
}

export async function postOtherMaterialPurchaseAction(_p: OtherMaterialFormState, fd: FormData): Promise<OtherMaterialFormState> {
  const user = await requireUser();
  const idempotencyKey = str(fd, "idempotencyKey");
  try {
    const input = purchaseInput(fd);
    const fy = await dateAllowed(input.purchaseDate, user.role, fd);
    const r = await prisma.$transaction(
      (tx) => postOtherMaterialPurchase(tx, { ...input, idempotencyKey, expectedFingerprint: str(fd, "fingerprint"), actor: { id: user.id, role: user.role }, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: true, code: r.purchase.purchaseCode, replayed: r.replayed };
  } catch (e) {
    if (isIdempotencyConflict(e)) {
      const existing = await prisma.otherMaterialPurchase.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.purchaseCode, replayed: true };
    }
    return { error: failure(e, "save this purchase") };
  }
}

export async function cancelOtherMaterialPurchaseAction(_p: OtherMaterialFormState, fd: FormData): Promise<OtherMaterialFormState> {
  const user = await requireOwner();
  try {
    const fy = await getCompanyFySettings();
    const r = await prisma.$transaction((tx) => cancelOtherMaterialPurchase(tx, { purchaseId: str(fd, "purchaseId"), reason: str(fd, "reason"), actor: { id: user.id, role: user.role }, ...fy }), VOUCHER_TRANSACTION_OPTIONS);
    revalidate();
    return { success: true, code: r.purchaseCode };
  } catch (e) {
    return { error: failure(e, "cancel this purchase") };
  }
}

export async function issueOtherMaterialAction(_p: OtherMaterialFormState, fd: FormData): Promise<OtherMaterialFormState> {
  const user = await requireUser();
  const idempotencyKey = str(fd, "idempotencyKey");
  try {
    const issueDate = date(fd, "date");
    const fy = await dateAllowed(issueDate, user.role, fd);
    const r = await prisma.$transaction(
      (tx) => issueOtherMaterialToJob(tx, { jobId: str(fd, "jobId"), lines: materialLines(fd), issueDate, idempotencyKey: idempotencyKey || null, createdByUserId: user.id, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: true, code: r.document.documentCode, replayed: r.replayed };
  } catch (e) {
    if (isIdempotencyConflict(e) && idempotencyKey) {
      const existing = await prisma.otherMaterialJobDocument.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.documentCode, replayed: true };
    }
    return { error: failure(e, "issue this material") };
  }
}

export async function returnOtherMaterialAction(_p: OtherMaterialFormState, fd: FormData): Promise<OtherMaterialFormState> {
  const user = await requireUser();
  const idempotencyKey = str(fd, "idempotencyKey");
  try {
    const returnDate = date(fd, "date");
    const fy = await dateAllowed(returnDate, user.role, fd);
    const r = await prisma.$transaction(
      (tx) => returnOtherMaterialFromJob(tx, { jobId: str(fd, "jobId"), lines: materialLines(fd), returnDate, reason: str(fd, "reason"), idempotencyKey: idempotencyKey || null, createdByUserId: user.id, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: true, code: r.document.documentCode, replayed: r.replayed };
  } catch (e) {
    if (isIdempotencyConflict(e) && idempotencyKey) {
      const existing = await prisma.otherMaterialJobDocument.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.documentCode, replayed: true };
    }
    return { error: failure(e, "return this material") };
  }
}

export async function reverseOtherMaterialDocumentAction(_p: OtherMaterialFormState, fd: FormData): Promise<OtherMaterialFormState> {
  const user = await requireOwner();
  try {
    const fy = await getCompanyFySettings();
    const r = await prisma.$transaction((tx) => reverseOtherMaterialJobDocument(tx, { documentId: str(fd, "documentId"), reason: str(fd, "reason"), actor: { id: user.id, role: user.role }, ...fy }), VOUCHER_TRANSACTION_OPTIONS);
    revalidate();
    return { success: true, code: r.documentCode };
  } catch (e) {
    return { error: failure(e, "reverse this entry") };
  }
}
