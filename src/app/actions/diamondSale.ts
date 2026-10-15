"use server";

import { revalidatePath } from "next/cache";

import type { DiamondSalePricing, GstTreatment } from "@/generated/prisma/enums";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { checkVoucherDateAllowed, parseDateOnly } from "@/lib/accounting/financialYear";
import { PostingError, VOUCHER_TRANSACTION_OPTIONS } from "@/lib/accounting/posting";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import { cancelDiamondSale, DiamondSaleError, planDiamondSale, postDiamondSale, returnDiamondSaleLines, type DiamondSaleInput } from "@/lib/diamond/diamondSale";

/**
 * Diamond-only Sale actions (JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §13).
 * Create / post: Owner or Staff (the existing Sale policy). Cancel and return:
 * Owner only. A Staff reply never carries stock cost, COGS or margin.
 */

export type DiamondSaleFormState = { error?: string; success?: boolean; code?: string; replayed?: boolean } | undefined;
export type DiamondSalePreview = {
  customerName: string;
  lines: { description: string; formula: string; discount: string; taxableValue: string; taxAmount: string; lineTotal: string; cogsAmount: string | null }[];
  subtotal: string;
  discountTotal: string;
  taxableTotal: string;
  taxTotal: string;
  grandTotal: string;
  /** Owner only. */
  cogsTotal: string | null;
  grossProfit: string | null;
  paymentMode: string;
  fingerprint: string;
};

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
function date(fd: FormData, k: string): Date {
  try {
    return parseDateOnly(str(fd, k));
  } catch {
    throw new DiamondSaleError("Enter a valid date.");
  }
}
function failure(error: unknown, what: string) {
  if (error instanceof PostingError) return error.message;
  console.error(`diamond sale ${what} failed:`, error);
  return `Could not ${what}. Nothing was saved — please try again.`;
}
function revalidate() {
  for (const p of ["/diamond", "/accounting", "/dashboard"]) revalidatePath(p);
}

function saleInput(fd: FormData): DiamondSaleInput {
  let raw: unknown;
  try {
    raw = JSON.parse(str(fd, "linesJson") || "[]");
  } catch {
    throw new DiamondSaleError("The sale lines could not be read. Reload the page.");
  }
  if (!Array.isArray(raw)) throw new DiamondSaleError("The sale lines could not be read.");
  const clearingCurrency = str(fd, "clearingCurrency");
  return {
    customerId: str(fd, "customerId"),
    saleDate: date(fd, "saleDate"),
    gstTreatment: (str(fd, "gstTreatment") || "NONE") as GstTreatment,
    paymentAccountId: str(fd, "paymentAccountId") || null,
    clearing: clearingCurrency ? { currencyCode: clearingCurrency, foreignAmount: str(fd, "clearingAmount") || null } : null,
    reference: str(fd, "reference") || null,
    notes: str(fd, "notes") || null,
    lines: raw
      .filter((l) => l && typeof l === "object")
      .map((l) => {
        const r = l as Record<string, unknown>;
        return {
          kind: r.kind === "PACKET" ? "PACKET" : "STONE",
          polishedDiamondId: r.polishedDiamondId ? String(r.polishedDiamondId) : null,
          packetId: r.packetId ? String(r.packetId) : null,
          pieces: r.pieces === undefined || r.pieces === null || r.pieces === "" ? null : String(r.pieces),
          carat: r.carat ? String(r.carat) : null,
          pricing: String(r.pricing ?? "") as DiamondSalePricing,
          rate: String(r.rate ?? ""),
          discount: r.discount ? String(r.discount) : null,
          gstRatePercent: r.gstRatePercent ? String(r.gstRatePercent) : null,
          taxType: r.taxType === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE",
        };
      }),
  };
}

export async function previewDiamondSaleAction(_p: { error?: string; preview?: DiamondSalePreview } | undefined, fd: FormData) {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";
  try {
    const input = saleInput(fd);
    const plan = await prisma.$transaction((tx) => planDiamondSale(tx, input), VOUCHER_TRANSACTION_OPTIONS);
    const account = input.paymentAccountId ? await prisma.paymentAccount.findUnique({ where: { id: input.paymentAccountId }, select: { name: true } }) : null;
    return {
      preview: {
        customerName: plan.customer.name,
        lines: plan.lines.map((l) => ({
          description: l.description,
          formula: l.formula,
          discount: l.discount.toFixed(2),
          taxableValue: l.taxableValue.toFixed(2),
          taxAmount: l.taxAmount.toFixed(2),
          lineTotal: l.lineTotal.toFixed(2),
          cogsAmount: isOwner ? l.cogsAmount.toFixed(2) : null,
        })),
        subtotal: plan.totals.subtotal.toFixed(2),
        discountTotal: plan.totals.discountTotal.toFixed(2),
        taxableTotal: plan.totals.taxableTotal.toFixed(2),
        taxTotal: plan.totals.taxTotal.toFixed(2),
        grandTotal: plan.totals.grandTotal.toFixed(2),
        cogsTotal: isOwner ? plan.totals.cogsTotal.toFixed(2) : null,
        grossProfit: isOwner ? plan.totals.taxableTotal.minus(plan.totals.cogsTotal).toFixed(2) : null,
        paymentMode: plan.customer.clearingEnabled ? "Marketplace clearing (paid by a later payout)" : account ? `Paid now — ${account.name}` : "On credit (receivable)",
        fingerprint: plan.fingerprint,
      },
    };
  } catch (e) {
    return { error: failure(e, "preview this sale") };
  }
}

export async function postDiamondSaleAction(_p: DiamondSaleFormState, fd: FormData): Promise<DiamondSaleFormState> {
  const user = await requireUser();
  const idempotencyKey = str(fd, "idempotencyKey");
  try {
    const input = saleInput(fd);
    const fy = await getCompanyFySettings();
    const check = checkVoucherDateAllowed(input.saleDate, user.role, fd.get("confirmOutsideFy") === "true", fy.fyStartMonth, fy.fyStartDay);
    if (!check.ok) return { error: check.message };
    const r = await prisma.$transaction(
      (tx) => postDiamondSale(tx, { ...input, idempotencyKey, expectedFingerprint: str(fd, "fingerprint"), actor: { id: user.id, role: user.role }, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: true, code: r.sale.saleCode, replayed: r.replayed };
  } catch (e) {
    if (isIdempotencyConflict(e)) {
      const existing = await prisma.diamondSale.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.saleCode, replayed: true };
    }
    return { error: failure(e, "save this sale") };
  }
}

export async function cancelDiamondSaleAction(_p: DiamondSaleFormState, fd: FormData): Promise<DiamondSaleFormState> {
  const user = await requireOwner();
  try {
    const fy = await getCompanyFySettings();
    const r = await prisma.$transaction((tx) => cancelDiamondSale(tx, { saleId: str(fd, "saleId"), reason: str(fd, "reason"), actor: { id: user.id, role: user.role }, ...fy }), VOUCHER_TRANSACTION_OPTIONS);
    revalidate();
    return { success: true, code: r.saleCode };
  } catch (e) {
    return { error: failure(e, "cancel this sale") };
  }
}

export async function returnDiamondSaleAction(_p: DiamondSaleFormState, fd: FormData): Promise<DiamondSaleFormState> {
  const user = await requireOwner();
  try {
    const fy = await getCompanyFySettings();
    let lineIds: string[] = [];
    try {
      lineIds = (JSON.parse(str(fd, "lineIdsJson") || "[]") as unknown[]).filter((x): x is string => typeof x === "string");
    } catch {
      return { error: "Choose the lines the Customer returned." };
    }
    const r = await prisma.$transaction(
      (tx) => returnDiamondSaleLines(tx, { saleId: str(fd, "saleId"), lineIds, reason: str(fd, "reason"), returnDate: date(fd, "returnDate"), idempotencyKey: str(fd, "idempotencyKey") || null, actor: { id: user.id, role: user.role }, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: true, code: r.saleReturn.returnCode, replayed: r.replayed };
  } catch (e) {
    return { error: failure(e, "record this return") };
  }
}
