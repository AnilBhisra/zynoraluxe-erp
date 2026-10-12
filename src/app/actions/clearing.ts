"use server";

import { revalidatePath } from "next/cache";

import { requireOwner } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import {
  allocateSettlement,
  CLEARING_USER_LINE_TYPES,
  ClearingError,
  getClearingBalance,
  planGrossUpWorkflow,
  planReclassify,
  planReserveMove,
  planSettlement,
  postGrossUpWorkflow,
  postReclassify,
  postReserveMove,
  postSettlement,
  reverseAllocation,
  reverseClearingDocument,
  type ClearingPlan,
  type GrossUpWorkflowInput,
  type GrossUpWorkflowPlan,
  type SettlementLineInput,
} from "@/lib/accounting/clearing";
import { parseDateOnly } from "@/lib/accounting/financialYear";
import { PostingError, VOUCHER_TRANSACTION_OPTIONS } from "@/lib/accounting/posting";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import type { ClearingLineDirection, ClearingLineType } from "@/generated/prisma/enums";

/**
 * Clearing settlement actions — Owner only, enforced here on the server for
 * every call (preview included). See CLEARING_SETTLEMENT_DESIGN.md.
 */

export type SerializedPlan = {
  kind: string;
  partyName: string;
  currencyCode: string;
  documentDate: string;
  paymentAccountName: string | null;
  receivedInr: string;
  receivedFc: string;
  payoutRate: string;
  lines: { lineType: string; direction: string; account: string; fc: string; inr: string; description: string | null }[];
  availableFc: string;
  availableInr: string;
  reserveFc: string;
  reserveInr: string;
  fxDifferenceInr: string;
  before: { availableFc: string; availableInr: string; reserveFc: string; reserveInr: string };
  after: { availableFc: string; availableInr: string; reserveFc: string; reserveInr: string };
  journal: { account: string; party: string | null; debit: string; credit: string; description: string }[];
  allocationsSupplied: boolean;
  warnings: string[];
  fingerprint: string;
};

export type ClearingFormState = { error?: string; preview?: SerializedPlan; success?: string; replayed?: boolean } | undefined;

function serialize(p: ClearingPlan): SerializedPlan {
  return {
    kind: p.kind,
    partyName: p.party.name,
    currencyCode: p.currencyCode,
    documentDate: p.documentDate.toISOString().slice(0, 10),
    paymentAccountName: p.paymentAccount?.name ?? null,
    receivedInr: p.receivedInr.toFixed(2),
    receivedFc: p.receivedFc.toFixed(2),
    payoutRate: p.payoutRate.toFixed(4),
    lines: p.lines.map((l) => ({ lineType: l.lineType, direction: l.direction, account: `${l.accountCode} ${l.accountName}`, fc: l.fc.toFixed(2), inr: l.inr.toFixed(2), description: l.description })),
    availableFc: p.availableFc.toFixed(2),
    availableInr: p.availableInr.toFixed(2),
    reserveFc: p.reserveFc.toFixed(2),
    reserveInr: p.reserveInr.toFixed(2),
    fxDifferenceInr: p.fxDifferenceInr.toFixed(2),
    before: { availableFc: p.before.available.fc.toFixed(2), availableInr: p.before.available.inr.toFixed(2), reserveFc: p.before.reserve.fc.toFixed(2), reserveInr: p.before.reserve.inr.toFixed(2) },
    after: { availableFc: p.after.available.fc.toFixed(2), availableInr: p.after.available.inr.toFixed(2), reserveFc: p.after.reserve.fc.toFixed(2), reserveInr: p.after.reserve.inr.toFixed(2) },
    journal: p.journal.map((l) => ({ account: `${l.accountCode} ${l.accountName}`, party: l.party, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2), description: l.description })),
    allocationsSupplied: p.allocationsSupplied,
    warnings: p.warnings,
    fingerprint: p.fingerprint,
  };
}

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
function dateOf(fd: FormData, k: string): Date {
  try {
    return parseDateOnly(str(fd, k));
  } catch {
    throw new ClearingError("Enter a valid date.");
  }
}
function failure(error: unknown, what: string): string {
  if (error instanceof ClearingError || error instanceof PostingError) return error.message;
  console.error(`clearing ${what} failed:`, error);
  return `Could not ${what}. Nothing was saved — please try again.`;
}
function revalidate() {
  for (const p of ["/accounting", "/dashboard"]) revalidatePath(p);
}

function linesFrom(fd: FormData): SettlementLineInput[] {
  let raw: unknown;
  try {
    raw = JSON.parse(str(fd, "linesJson") || "[]");
  } catch {
    throw new ClearingError("The deduction lines could not be read. Reload the page.");
  }
  if (!Array.isArray(raw)) throw new ClearingError("The deduction lines could not be read.");
  return raw
    .filter((l) => l && typeof l === "object" && String((l as Record<string, unknown>).amount ?? "").trim() !== "")
    .map((l) => {
      const r = l as Record<string, unknown>;
      const lineType = String(r.lineType) as ClearingLineType;
      if (!(CLEARING_USER_LINE_TYPES as readonly string[]).includes(lineType)) throw new ClearingError("Choose what each deduction is.");
      return { lineType, amount: String(r.amount).trim(), direction: (r.direction === "ADDITION" ? "ADDITION" : "DEDUCTION") as ClearingLineDirection, description: r.description ? String(r.description) : null };
    });
}

function settlementInput(fd: FormData) {
  const lines = linesFrom(fd);
  return {
    partyId: str(fd, "partyId"),
    currencyCode: str(fd, "currencyCode") || "INR",
    documentDate: dateOf(fd, "documentDate"),
    paymentAccountId: str(fd, "paymentAccountId") || null,
    reference: str(fd, "reference") || null,
    notes: str(fd, "notes") || null,
    receivedInr: str(fd, "receivedInr") || "0",
    receivedFc: str(fd, "receivedFc") || null,
    payoutRate: str(fd, "payoutRate") || null,
    grossFc: str(fd, "grossFc") || null,
    lines,
  };
}

export async function previewSettlementAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  await requireOwner();
  try {
    return { preview: serialize(await prisma.$transaction((tx) => planSettlement(tx, settlementInput(fd)), VOUCHER_TRANSACTION_OPTIONS)) };
  } catch (e) {
    return { error: failure(e, "preview this settlement") };
  }
}

export async function postSettlementAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  const user = await requireOwner();
  const fy = await getCompanyFySettings();
  const idempotencyKey = str(fd, "idempotencyKey");
  try {
    const r = await prisma.$transaction(
      (tx) => postSettlement(tx, { ...settlementInput(fd), idempotencyKey, expectedFingerprint: str(fd, "fingerprint"), actor: { id: user.id, role: user.role }, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: await voucherNumberOf(r.document.voucherId), replayed: r.replayed };
  } catch (e) {
    if (isIdempotencyConflict(e)) {
      const existing = await prisma.clearingDocument.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: await voucherNumberOf(existing.voucherId), replayed: true };
    }
    return { error: failure(e, "save this settlement") };
  }
}

async function voucherNumberOf(voucherId: string) {
  return (await prisma.voucher.findUnique({ where: { id: voucherId }, select: { voucherNumber: true } }))?.voucherNumber ?? "";
}

function reserveInput(fd: FormData) {
  const availableOn = str(fd, "availableOn");
  return {
    partyId: str(fd, "partyId"),
    currencyCode: str(fd, "currencyCode") || "INR",
    direction: (str(fd, "direction") === "RELEASE" ? "RELEASE" : "HOLD") as "HOLD" | "RELEASE",
    amountFc: str(fd, "amountFc"),
    documentDate: dateOf(fd, "documentDate"),
    availableOn: availableOn ? dateOf(fd, "availableOn") : null,
    reference: str(fd, "reference") || null,
    notes: str(fd, "notes") || null,
  };
}

export async function previewReserveAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  await requireOwner();
  try {
    return { preview: serialize(await prisma.$transaction((tx) => planReserveMove(tx, reserveInput(fd)), VOUCHER_TRANSACTION_OPTIONS)) };
  } catch (e) {
    return { error: failure(e, "preview this reserve move") };
  }
}

export async function postReserveAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  const user = await requireOwner();
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction(
      (tx) => postReserveMove(tx, { ...reserveInput(fd), idempotencyKey: str(fd, "idempotencyKey"), expectedFingerprint: str(fd, "fingerprint"), actor: { id: user.id, role: user.role }, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: await voucherNumberOf(r.document.voucherId), replayed: r.replayed };
  } catch (e) {
    return { error: failure(e, "save this reserve move") };
  }
}

function reclassifyInput(fd: FormData) {
  return {
    saleVoucherId: str(fd, "saleVoucherId"),
    documentDate: dateOf(fd, "documentDate"),
    currencyCode: str(fd, "currencyCode") || "INR",
    amountFc: str(fd, "amountFc") || null,
    notes: str(fd, "notes") || null,
  };
}

export async function previewReclassifyAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  await requireOwner();
  try {
    return { preview: serialize(await prisma.$transaction((tx) => planReclassify(tx, reclassifyInput(fd)), VOUCHER_TRANSACTION_OPTIONS)) };
  } catch (e) {
    return { error: failure(e, "preview this reclassification") };
  }
}

export async function postReclassifyAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  const user = await requireOwner();
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction(
      (tx) => postReclassify(tx, { ...reclassifyInput(fd), idempotencyKey: str(fd, "idempotencyKey"), expectedFingerprint: str(fd, "fingerprint"), actor: { id: user.id, role: user.role }, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: await voucherNumberOf(r.document.voucherId), replayed: r.replayed };
  } catch (e) {
    return { error: failure(e, "save this reclassification") };
  }
}

export type SerializedGrossUp = {
  saleVoucherNumber: string;
  recordedInr: string;
  recordedRevenueInr: string;
  grossSaleInr: string;
  taxConfirmation: string;
  reclass: SerializedPlan | null;
  grossUp: SerializedPlan;
  settlement: SerializedPlan | null;
  effect: {
    byAccount: { account: string; type: string; net: string }[];
    cashBankNet: string;
    clearingAfterInr: string;
    revenueAdded: string;
    taxAdded: string;
    expenseAdded: string;
    profitChange: string;
  };
  fingerprint: string;
};

export type GrossUpFormState = { error?: string; preview?: SerializedGrossUp; success?: string; replayed?: boolean } | undefined;

function serializeGrossUp(w: GrossUpWorkflowPlan): SerializedGrossUp {
  return {
    saleVoucherNumber: w.sale.voucherNumber,
    recordedInr: w.sale.recordedInr.toFixed(2),
    recordedRevenueInr: w.sale.recordedRevenueInr.toFixed(2),
    grossSaleInr: (w.grossUp.grossSaleInr ?? w.sale.recordedInr).toFixed(2),
    taxConfirmation: w.grossUp.taxConfirmation ?? "",
    reclass: w.reclass ? serialize(w.reclass) : null,
    grossUp: serialize(w.grossUp),
    settlement: w.settlement ? serialize(w.settlement) : null,
    effect: {
      byAccount: w.effect.byAccount.map((r) => ({ account: `${r.accountCode} ${r.accountName}`, type: r.accountType, net: r.net.toFixed(2) })),
      cashBankNet: w.effect.cashBankNet.toFixed(2),
      clearingAfterInr: w.effect.clearingAfterInr.toFixed(2),
      revenueAdded: w.effect.revenueAdded.toFixed(2),
      taxAdded: w.effect.taxAdded.toFixed(2),
      expenseAdded: w.effect.expenseAdded.toFixed(2),
      profitChange: w.effect.profitChange.toFixed(2),
    },
    fingerprint: w.fingerprint,
  };
}

function grossUpInput(fd: FormData): GrossUpWorkflowInput {
  const taxMode = str(fd, "taxMode");
  const gstTreatment = str(fd, "gstTreatment");
  const withSettlement = str(fd, "includeSettlement") === "true";
  return {
    saleVoucherId: str(fd, "saleVoucherId"),
    documentDate: dateOf(fd, "documentDate"),
    grossSaleInr: str(fd, "grossSaleInr"),
    taxMode: taxMode === "NONE" || taxMode === "INCLUSIVE" || taxMode === "EXCLUSIVE" ? taxMode : null,
    gstTreatment: gstTreatment === "CGST_SGST" || gstTreatment === "IGST" ? gstTreatment : null,
    gstRatePercent: str(fd, "gstRatePercent") || null,
    taxConfirmation: str(fd, "taxConfirmation"),
    reference: str(fd, "reference") || null,
    notes: str(fd, "notes") || null,
    settlement: withSettlement
      ? {
          paymentAccountId: str(fd, "paymentAccountId") || null,
          receivedInr: str(fd, "receivedInr") || "0",
          lines: linesFrom(fd),
          documentDate: str(fd, "settlementDate") ? dateOf(fd, "settlementDate") : null,
          reference: str(fd, "settlementReference") || null,
        }
      : null,
  };
}

export async function previewGrossUpAction(_p: GrossUpFormState, fd: FormData): Promise<GrossUpFormState> {
  await requireOwner();
  try {
    return { preview: serializeGrossUp(await prisma.$transaction((tx) => planGrossUpWorkflow(tx, grossUpInput(fd)), VOUCHER_TRANSACTION_OPTIONS)) };
  } catch (e) {
    return { error: failure(e, "preview this gross-up") };
  }
}

export async function postGrossUpAction(_p: GrossUpFormState, fd: FormData): Promise<GrossUpFormState> {
  const user = await requireOwner();
  const fy = await getCompanyFySettings();
  const idempotencyKey = str(fd, "idempotencyKey");
  try {
    const r = await prisma.$transaction(
      (tx) => postGrossUpWorkflow(tx, { ...grossUpInput(fd), idempotencyKey, expectedFingerprint: str(fd, "fingerprint"), actor: { id: user.id, role: user.role }, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: r.replayed ? "Already posted" : r.voucherNumbers.join(", "), replayed: r.replayed };
  } catch (e) {
    if (isIdempotencyConflict(e)) return { success: "Already posted", replayed: true };
    return { error: failure(e, "save this gross-up") };
  }
}

export async function reverseClearingAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  const user = await requireOwner();
  const fy = await getCompanyFySettings();
  try {
    const r = await prisma.$transaction(
      (tx) => reverseClearingDocument(tx, { documentId: str(fd, "documentId"), reason: str(fd, "reason"), idempotencyKey: str(fd, "idempotencyKey"), actor: { id: user.id, role: user.role }, ...fy }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: r.replayed ? "Already reversed" : `Reversed by ${r.reversalVoucherNumber}`, replayed: r.replayed };
  } catch (e) {
    return { error: failure(e, "reverse this entry") };
  }
}

export async function allocateAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  const user = await requireOwner();
  try {
    await prisma.$transaction(
      (tx) => allocateSettlement(tx, { documentId: str(fd, "documentId"), saleVoucherId: str(fd, "saleVoucherId"), amountFc: str(fd, "amountFc"), reason: str(fd, "reason"), idempotencyKey: str(fd, "idempotencyKey"), actor: { id: user.id, role: user.role } }),
      VOUCHER_TRANSACTION_OPTIONS
    );
    revalidate();
    return { success: "Allocation recorded (no money moved)." };
  } catch (e) {
    return { error: failure(e, "record this allocation") };
  }
}

export async function reverseAllocationAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  const user = await requireOwner();
  try {
    await prisma.$transaction((tx) => reverseAllocation(tx, { allocationId: str(fd, "allocationId"), reason: str(fd, "reason"), actor: { id: user.id, role: user.role } }), VOUCHER_TRANSACTION_OPTIONS);
    revalidate();
    return { success: "Allocation reversed." };
  } catch (e) {
    return { error: failure(e, "reverse this allocation") };
  }
}

const MAPPABLE_TYPES = ["ASSET", "LIABILITY", "INCOME", "EXPENSE"];

export async function updateLineMappingAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  const user = await requireOwner();
  const lineType = str(fd, "lineType") as ClearingLineType;
  try {
    if (lineType === "RESERVE_HOLD" || lineType === "RESERVE_RELEASE") throw new ClearingError("Reserve lines always post to 1160 Marketplace Reserve.");
    if (lineType === "GROSS_UP_REVENUE" || lineType === "GROSS_UP_TAX") throw new ClearingError("A gross-up always posts to 4000 Sales and the output GST accounts.");
    const account = await prisma.account.findUnique({ where: { id: str(fd, "accountId") }, include: { paymentAccount: true } });
    if (!account || !account.isActive || !MAPPABLE_TYPES.includes(account.type)) throw new ClearingError("Choose an active account.");
    if (account.paymentAccount) throw new ClearingError("A Cash/Bank account cannot take a deduction line.");
    if (["1150", "1160", "1100", "2000"].includes(account.code)) throw new ClearingError("Clearing and party control accounts cannot take a deduction line.");
    await prisma.clearingAccountMapping.upsert({
      where: { lineType },
      create: { lineType, accountId: account.id, updatedByUserId: user.id },
      update: { accountId: account.id, updatedByUserId: user.id },
    });
    revalidate();
    return { success: `Future settlements post this line to ${account.code} ${account.name}.` };
  } catch (e) {
    return { error: failure(e, "change this mapping") };
  }
}

export async function setClearingPartyAction(_p: ClearingFormState, fd: FormData): Promise<ClearingFormState> {
  await requireOwner();
  const partyId = str(fd, "partyId");
  const enable = str(fd, "enable") === "true";
  try {
    const party = await prisma.party.findUnique({ where: { id: partyId } });
    if (!party) throw new ClearingError("Party not found.");
    if (!enable) {
      const open = await prisma.clearingEntry.groupBy({ by: ["currencyCode"], where: { partyId }, _sum: { inrAmount: true, fcAmount: true } });
      const left = open.find((o) => !(o._sum.fcAmount ?? 0).toString().match(/^0(\.0+)?$/) || !(o._sum.inrAmount ?? 0).toString().match(/^0(\.0+)?$/));
      if (left) throw new ClearingError(`${party.name} still has a ${left.currencyCode} clearing balance. Settle or reverse it first.`);
    }
    await prisma.party.update({ where: { id: partyId }, data: { clearingEnabled: enable } });
    revalidate();
    return { success: enable ? `${party.name} is now a marketplace / clearing party: its new sales post to clearing.` : `${party.name} is an ordinary party again.` };
  } catch (e) {
    return { error: failure(e, "change this party") };
  }
}

/** Live balance for the settlement form (Owner only). */
export async function clearingBalanceAction(partyId: string, currencyCode: string) {
  await requireOwner();
  const b = await prisma.$transaction((tx) => getClearingBalance(tx, partyId, currencyCode.toUpperCase()), VOUCHER_TRANSACTION_OPTIONS);
  return { availableFc: b.available.fc.toFixed(2), availableInr: b.available.inr.toFixed(2), reserveFc: b.reserve.fc.toFixed(2), reserveInr: b.reserve.inr.toFixed(2) };
}
