import "server-only";

import type { CustomerGoldInputBasis, CustomerGoldSettlement, MetalRateBasis } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import { cancelVoucher } from "@/lib/accounting/posting";
import type { Tx } from "@/lib/corrections/types";
import { opaqueFingerprint, planCustomerGoldIntake, receiveCustomerGold } from "@/lib/jewellery/customerGold";
import { availableCustomerCreditInTx, purchaseCustomerGold } from "@/lib/jewellery/customerGoldCommercial";
import { type Actor, CustomerGoldError, lockCustomerGold, writeCustomerGoldEntry } from "@/lib/jewellery/customerGoldLedger";

/**
 * Old Gold Exchange (Phase 8C) — built on Customer Gold, never beside it.
 *
 * Two different things, kept apart on every screen and in every posting:
 *  1. Customer-owned gold held for manufacturing — an intake (Customer Gold
 *     receipt) into the SAFE. Rs 0 Company inventory, no voucher.
 *  2. Gold the Company buys / takes in exchange — an Owner-approved
 *     CustomerGoldPurchase that moves the accepted metal into Company stock
 *     exactly once (PURCHASE_IN via createMetalPurchase: Dr 1300 / Cr 2000 to
 *     the Customer) and, when settled as credit, gives the Customer a credit a
 *     bill may use (partly or fully) — never twice.
 *
 * The one-step exchange below is (1) followed by (2) for exactly that intake,
 * in ONE transaction, so the ledger shows what came in (stated vs tested
 * purity, deduction, photo) and what the Company bought — and nothing can be
 * half-saved.
 */

const reasonOf = (r: string | null | undefined, min = 3) => {
  const t = r?.trim() ?? "";
  if (t.length < min) throw new CustomerGoldError(min >= 10 ? `Give the reason (at least ${min} characters).` : "Give a short reason.");
  return t;
};
const rate4 = (v: DecimalInput) => new Decimal(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

export type OldGoldExchangeInput = {
  customerId: string;
  exchangeDate: Date;
  /** The tested / approved purity — the one the gold is valued and stocked at. */
  purityId: string;
  /** What the Customer said it was (free text). Documentation only. */
  statedPurity?: string | null;
  inputBasis: CustomerGoldInputBasis;
  /** GROSS: as weighed, before deduction. FINE: the accepted fine weight. */
  weight: DecimalInput;
  deductionWeight?: DecimalInput | null;
  rateBasis: MetalRateBasis;
  rate: DecimalInput;
  settlement: CustomerGoldSettlement;
  reason: string;
  reference: string;
  photoAssetId?: string | null;
};

export type OldGoldExchangePlan = {
  customerName: string;
  metalType: string;
  purityDisplayName: string;
  finenessPercent: Decimal;
  statedPurity: string | null;
  grossWeight: Decimal;
  deductionWeight: Decimal;
  netGrossWeight: Decimal;
  fineWeight: Decimal;
  rateBasis: MetalRateBasis;
  rate: Decimal;
  value: Decimal;
  perGrossGram: Decimal;
  perFineGram: Decimal;
  settlement: CustomerGoldSettlement;
  creditBefore: Decimal;
  creditAfter: Decimal;
};

export async function planOldGoldExchange(tx: Tx, input: OldGoldExchangeInput): Promise<OldGoldExchangePlan> {
  reasonOf(input.reason);
  if ((input.reference?.trim() ?? "").length < 2) throw new CustomerGoldError("Enter the reference (bill, slip or register number) for this exchange.");
  if ((input.statedPurity?.trim().length ?? 0) > 60) throw new CustomerGoldError("Keep the stated purity short (60 characters at most).");
  const intake = await planCustomerGoldIntake(tx, {
    customerId: input.customerId,
    intakeDate: input.exchangeDate,
    purityId: input.purityId,
    inputBasis: input.inputBasis,
    weight: input.weight,
    deductionWeight: input.deductionWeight,
    reason: input.reason,
    reference: input.reference,
  });
  const rate = rate4(input.rate);
  if (!rate.greaterThan(0)) throw new CustomerGoldError("Enter the agreed rate (or fixed total).");
  const value =
    input.rateBasis === "PER_GROSS_GRAM" ? round2(rate.times(intake.netGrossWeight)) : input.rateBasis === "PER_FINE_GRAM" ? round2(rate.times(intake.fineWeight)) : round2(rate);
  if (!value.greaterThan(0)) throw new CustomerGoldError("The agreed value must be above zero.");
  const creditBefore = await availableCustomerCreditInTx(tx, input.customerId);
  return {
    customerName: intake.customerName,
    metalType: intake.metalType,
    purityDisplayName: intake.purityDisplayName,
    finenessPercent: intake.finenessPercent,
    statedPurity: input.statedPurity?.trim() || null,
    grossWeight: intake.grossWeight,
    deductionWeight: intake.deductionWeight,
    netGrossWeight: intake.netGrossWeight,
    fineWeight: intake.fineWeight,
    rateBasis: input.rateBasis,
    rate,
    value,
    perGrossGram: value.dividedBy(intake.netGrossWeight).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
    perFineGram: value.dividedBy(intake.fineWeight).toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
    settlement: input.settlement,
    creditBefore,
    creditAfter: input.settlement === "CREDIT_TO_INVOICE" ? round2(creditBefore.plus(value)) : creditBefore,
  };
}

export function oldGoldExchangeFingerprint(input: OldGoldExchangeInput, plan: OldGoldExchangePlan): string {
  return opaqueFingerprint("old-gold-exchange", {
    c: input.customerId,
    p: input.purityId,
    sp: plan.statedPurity,
    w: [plan.grossWeight.toFixed(3), plan.deductionWeight.toFixed(3), plan.netGrossWeight.toFixed(3), plan.fineWeight.toFixed(3), plan.finenessPercent.toFixed(3)],
    r: [plan.rateBasis, plan.rate.toFixed(4)],
    v: plan.value.toFixed(2),
    st: plan.settlement,
    credit: plan.creditBefore.toFixed(2),
  });
}

/** Owner only. Intake + purchase of exactly that intake, atomically; posts once per submission key. */
export async function exchangeOldGold(
  tx: Tx,
  input: OldGoldExchangeInput & { approved: boolean; expectedFingerprint: string | null; idempotencyKey: string; actor: Actor; fyStartMonth: number; fyStartDay: number }
) {
  if (input.actor.role !== "OWNER") throw new CustomerGoldError("Only the Owner can approve an old gold exchange.");
  if (!input.approved) throw new CustomerGoldError("Tick the approval: the Company is buying this gold from the Customer at the agreed value.");
  if (!input.idempotencyKey?.trim()) throw new CustomerGoldError("Missing submission key — reload the page and try again.");
  const existing = await tx.customerGoldPurchase.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { customerGoldReceipt: true } });
  if (existing) return { purchase: existing, receipt: existing.customerGoldReceipt, replayed: true as const };

  await lockCustomerGold(tx, { purityId: input.purityId, customerId: input.customerId });
  // A double-click waits on the lock above; once the first commits, replay it.
  const raced = await tx.customerGoldPurchase.findUnique({ where: { idempotencyKey: input.idempotencyKey }, include: { customerGoldReceipt: true } });
  if (raced) return { purchase: raced, receipt: raced.customerGoldReceipt, replayed: true as const };
  const plan = await planOldGoldExchange(tx, input);
  if (!input.expectedFingerprint || input.expectedFingerprint !== oldGoldExchangeFingerprint(input, plan)) {
    throw new CustomerGoldError("The weights, rate or the Customer's credit changed after this preview. Review it and approve again.");
  }

  const intake = await receiveCustomerGold(tx, {
    customerId: input.customerId,
    intakeDate: input.exchangeDate,
    purityId: input.purityId,
    inputBasis: input.inputBasis,
    weight: input.weight,
    deductionWeight: input.deductionWeight,
    reference: input.reference,
    reason: input.reason,
    photoAssetId: input.photoAssetId ?? null,
    statedPurity: plan.statedPurity,
    declaredValue: null,
    idempotencyKey: `${input.idempotencyKey}:intake`,
    actor: input.actor,
  });
  if (intake.replayed) throw new CustomerGoldError("This exchange's intake already exists without its purchase. Nothing was saved — contact support.");

  const bought = await purchaseCustomerGold(tx, {
    customerId: input.customerId,
    purchaseDate: input.exchangeDate,
    purityId: input.purityId,
    source: "CUSTODY",
    finenessPercent: plan.finenessPercent,
    exactIntake: { receiptId: intake.receipt.id, gross: plan.netGrossWeight, fine: plan.fineWeight },
    rateBasis: input.rateBasis,
    rate: plan.rate,
    settlement: input.settlement,
    reason: input.reason,
    reference: input.reference,
    approved: true,
    expectedFingerprint: null,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
  });
  if (bought.replayed || !bought.plan.value.equals(plan.value) || !bought.plan.fine.equals(plan.fineWeight)) {
    throw new CustomerGoldError("Internal check failed: the exchange did not post exactly as previewed. Nothing was saved.");
  }
  return { purchase: bought.purchase, receipt: intake.receipt, replayed: false as const, plan };
}

// ---------------------------------------------------------------------------
// Owner reversal of an approved purchase / exchange
// ---------------------------------------------------------------------------

async function purchaseFacts(tx: Tx, purchaseId: string) {
  const purchase = await tx.customerGoldPurchase.findUnique({
    where: { id: purchaseId },
    include: { metalPurchase: true, customer: { select: { name: true } }, entries: { where: { kind: "CONVERT_TO_COMPANY" }, include: { reversedBy: { select: { id: true } } } } },
  });
  if (!purchase) throw new CustomerGoldError("Purchase not found.");
  const movement = await tx.metalStockMovement.findFirst({
    where: { type: "PURCHASE_IN", sourceDocument: purchase.metalPurchase.purchaseCode, purityId: purchase.purityId },
    include: { reversedByMovement: { select: { id: true } } },
  });
  if (!movement) throw new CustomerGoldError(`The stock entry of ${purchase.purchaseCode} was not found. Nothing was changed.`);
  return { purchase, movement };
}

/**
 * Why this purchase cannot be reversed right now, or null. Reversal must be
 * exact and must never undo something a later transaction already relied on:
 *  - any later Company movement of the same metal and purity (the metal may
 *    have been issued, or the weighted average re-priced what was issued);
 *  - a posted revaluation of that purity after the purchase;
 *  - credit already used by a bill, or the Customer already paid.
 */
export async function customerGoldPurchaseReversalBlock(tx: Tx, purchaseId: string): Promise<string | null> {
  const { purchase, movement } = await purchaseFacts(tx, purchaseId);
  if (purchase.status !== "POSTED") return `${purchase.purchaseCode} is already reversed.`;
  if (movement.reversedByMovement) return `${purchase.purchaseCode}'s stock entry was already reversed.`;
  const later = await tx.metalStockMovement.findMany({
    where: { metalType: movement.metalType, purityId: movement.purityId, createdAt: { gte: movement.createdAt }, id: { not: movement.id } },
    orderBy: { createdAt: "asc" },
    take: 3,
    select: { sourceDocument: true },
  });
  if (later.length > 0) {
    return `Company ${purchase.metalType} stock of this purity has moved since (${later.map((m) => m.sourceDocument).join(", ")}). Reverse those first, or correct the value through Corrections.`;
  }
  const revalued = await tx.metalRevaluation.count({ where: { purityId: movement.purityId, createdAt: { gte: movement.createdAt }, correction: { state: "POSTED" } } });
  if (revalued > 0) return "This purity was revalued by an Owner correction after the purchase. Reverse that correction first.";
  const value = new Decimal(purchase.approvedValue);
  if (purchase.settlement === "CREDIT_TO_INVOICE") {
    const available = await availableCustomerCreditInTx(tx, purchase.customerId);
    if (available.lessThan(value)) {
      return `Part of this credit was already applied to a bill or paid out (credit still unused ₹${available.toFixed(2)}, purchase ₹${value.toFixed(2)}). Reverse that bill or payment first.`;
    }
  }
  // Every line counts (a cancelled voucher and its REVERSAL mirror net to zero).
  const ap = await tx.journalEntry.aggregate({
    where: { partyId: purchase.customerId, account: { code: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE } },
    _sum: { credit: true, debit: true },
  });
  const payable = round2(new Decimal(ap._sum.credit ?? 0).minus(ap._sum.debit ?? 0));
  if (payable.lessThan(value)) {
    return `${purchase.customer.name} has already been paid against it (payable now ₹${payable.toFixed(2)}, purchase ₹${value.toFixed(2)}). Reverse that payment first.`;
  }
  return null;
}

/**
 * Owner only. Undoes an approved purchase / exchange as audited mirrors — the
 * purchase, its voucher and its stock entry are never edited or deleted:
 *  - the purchase voucher is cancelled (REVERSAL voucher: Dr 2000 / Cr 1300);
 *  - an equal-and-opposite ADJUSTMENT_OUT stock entry linked to the original
 *    PURCHASE_IN by reversalOfMovementId (the same convention as an
 *    adjustment reversal), at exactly the original weight and value;
 *  - when the gold came from the Customer's safe, the CONVERT_TO_COMPANY
 *    entry is mirrored: the gold is the Customer's again, back in the safe.
 * An exchange's intake stays recorded; the Owner returns the gold (or reverses
 * the intake) separately.
 */
export async function reverseCustomerGoldPurchase(
  tx: Tx,
  input: { purchaseId: string; reason: string; idempotencyKey: string; actor: Actor; fyStartMonth: number; fyStartDay: number }
) {
  if (input.actor.role !== "OWNER") throw new CustomerGoldError("Only the Owner can reverse a purchase/exchange.");
  const reason = reasonOf(input.reason, 10);
  if (!input.idempotencyKey?.trim()) throw new CustomerGoldError("Missing submission key — reload the page and try again.");
  const replay = await tx.customerGoldPurchase.findUnique({ where: { reversalIdempotencyKey: input.idempotencyKey } });
  if (replay) return { purchase: replay, replayed: true as const };

  const head = await tx.customerGoldPurchase.findUnique({ where: { id: input.purchaseId }, select: { purityId: true, customerId: true } });
  if (!head) throw new CustomerGoldError("Purchase not found.");
  await lockCustomerGold(tx, head);
  const block = await customerGoldPurchaseReversalBlock(tx, input.purchaseId);
  if (block) throw new CustomerGoldError(`Cannot reverse: ${block}`);
  const { purchase, movement } = await purchaseFacts(tx, input.purchaseId);
  if (!purchase.metalPurchase.voucherId) throw new CustomerGoldError(`${purchase.purchaseCode} has no voucher to reverse. Nothing was changed.`);

  const reversalVoucher = await cancelVoucher(tx, {
    voucherId: purchase.metalPurchase.voucherId,
    cancelledByUserId: input.actor.id,
    cancellationReason: `Reversal of ${purchase.purchaseCode}: ${reason}`,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
  });
  await tx.metalStockMovement.create({
    data: {
      type: "ADJUSTMENT_OUT",
      metalType: movement.metalType,
      purityId: movement.purityId,
      grossWeight: new Decimal(movement.grossWeight).toFixed(3),
      fineWeight: new Decimal(movement.fineWeight).toFixed(3),
      costValue: new Decimal(movement.costValue).toFixed(2),
      sourceDocument: `Reversal of ${purchase.purchaseCode} (${purchase.metalPurchase.purchaseCode})`,
      reversalOfMovementId: movement.id,
      createdByUserId: input.actor.id,
    },
  });
  for (const e of purchase.entries.filter((x) => !x.reversalOfEntryId && !x.reversedBy)) {
    const pool = { customerId: e.customerId, metalType: e.metalType, purityId: e.purityId, finenessPercentSnapshot: new Decimal(e.finenessPercentSnapshot) };
    await writeCustomerGoldEntry(tx, {
      kind: e.kind,
      pool,
      from: { location: e.fromLocation, scopeId: null },
      to: { location: e.toLocation, scopeId: null },
      gross: new Decimal(e.grossWeight),
      fine: new Decimal(e.fineWeight),
      entryDate: new Date(),
      reason,
      reference: purchase.purchaseCode,
      purchaseId: purchase.id,
      customerGoldReceiptId: e.customerGoldReceiptId,
      reversalOfEntryId: e.id,
      createdByUserId: input.actor.id,
    });
  }
  const updated = await tx.customerGoldPurchase.update({
    where: { id: purchase.id },
    data: {
      status: "REVERSED",
      reversedAt: new Date(),
      reversedByUserId: input.actor.id,
      reversalReason: reason,
      reversalVoucherId: reversalVoucher.id,
      reversalIdempotencyKey: input.idempotencyKey,
    },
  });
  return { purchase: updated, replayed: false as const };
}

// ---------------------------------------------------------------------------
// Credit (Owner-only figures)
// ---------------------------------------------------------------------------

export type CustomerCreditSummary = { granted: Decimal; applied: Decimal; available: Decimal };

/** Credit from approved, unreversed purchases settled to invoice; applied by posted bills; still usable. */
export async function customerCreditSummaryInTx(tx: Tx, customerId: string): Promise<CustomerCreditSummary> {
  const [granted, applied, available] = await Promise.all([
    tx.customerGoldPurchase.aggregate({ where: { customerId, settlement: "CREDIT_TO_INVOICE", status: "POSTED" }, _sum: { approvedValue: true } }),
    tx.customerJewelleryBill.aggregate({ where: { customerId, status: "POSTED" }, _sum: { creditApplied: true } }),
    availableCustomerCreditInTx(tx, customerId),
  ]);
  return { granted: round2(granted._sum.approvedValue ?? 0), applied: round2(applied._sum.creditApplied ?? 0), available };
}

export type CreditReconciliationLine = {
  customerId: string;
  customerName: string;
  /** Records: approved value of every live purchase / exchange. */
  purchasedRecords: Decimal;
  /** Ledger: net Cr 2000 to the Customer on those purchases' vouchers (+ their reversals). */
  purchasedLedger: Decimal;
  /** Records: credit applied by every live bill. */
  appliedRecords: Decimal;
  /** Ledger: net Dr 2000 "credit applied" lines on bill vouchers (+ their reversals). */
  appliedLedger: Decimal;
  /** Records: credit granted − applied; never negative. */
  outstandingCredit: Decimal;
  difference: Decimal;
};

/**
 * The Old Gold / Customer credit path, records against ledger, per Customer:
 * every live purchase's value is on Accounts Payable exactly once, every
 * bill's applied credit is taken off it exactly once, a reversal nets both to
 * zero, and no Customer has used more credit than purchases gave them.
 * (The metal side is already in the 1300 reconciliation via PURCHASE_IN.)
 */
export async function reconcileCustomerGoldCredit(tx: Tx): Promise<{ lines: CreditReconciliationLine[]; ok: boolean }> {
  const [purchases, bills, ap] = await Promise.all([
    tx.customerGoldPurchase.findMany({ include: { customer: { select: { name: true } }, metalPurchase: { select: { voucherId: true } } } }),
    tx.customerJewelleryBill.findMany({ select: { customerId: true, status: true, creditApplied: true, voucherId: true, reversalVoucherId: true } }),
    tx.account.findUnique({ where: { code: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE } }),
  ]);
  const byCustomer = new Map<string, CreditReconciliationLine>();
  const line = (customerId: string, customerName: string) => {
    const l =
      byCustomer.get(customerId) ??
      ({ customerId, customerName, purchasedRecords: ZERO, purchasedLedger: ZERO, appliedRecords: ZERO, appliedLedger: ZERO, outstandingCredit: ZERO, difference: ZERO } as CreditReconciliationLine);
    byCustomer.set(customerId, l);
    return l;
  };
  const voucherNet = async (voucherIds: (string | null)[], partyId: string, filter?: string) => {
    const ids = voucherIds.filter((v): v is string => !!v);
    if (!ap || ids.length === 0) return ZERO;
    const t = await tx.journalEntry.aggregate({
      where: { voucherId: { in: ids }, accountId: ap.id, partyId, ...(filter ? { description: { contains: filter } } : {}) },
      _sum: { credit: true, debit: true },
    });
    return round2(new Decimal(t._sum.credit ?? 0).minus(t._sum.debit ?? 0));
  };
  for (const p of purchases) {
    const l = line(p.customerId, p.customer.name);
    if (p.status === "POSTED") l.purchasedRecords = round2(l.purchasedRecords.plus(p.approvedValue));
    l.purchasedLedger = round2(l.purchasedLedger.plus(await voucherNet([p.metalPurchase.voucherId, p.reversalVoucherId], p.customerId)));
    if (p.status === "POSTED" && p.settlement === "CREDIT_TO_INVOICE") l.outstandingCredit = round2(l.outstandingCredit.plus(p.approvedValue));
  }
  for (const b of bills) {
    const l = byCustomer.get(b.customerId) ?? line(b.customerId, "");
    if (b.status === "POSTED") {
      l.appliedRecords = round2(l.appliedRecords.plus(b.creditApplied));
      l.outstandingCredit = round2(l.outstandingCredit.minus(b.creditApplied));
    }
    // Dr 2000 lines are debits: the "credit applied" net is −(credit − debit).
    l.appliedLedger = round2(l.appliedLedger.minus(await voucherNet([b.voucherId, b.reversalVoucherId], b.customerId, "Gold-purchase credit applied")));
  }
  const lines = [...byCustomer.values()].map((l) => ({
    ...l,
    difference: round2(l.purchasedRecords.minus(l.purchasedLedger).abs().plus(l.appliedRecords.minus(l.appliedLedger).abs())),
  }));
  return { lines, ok: lines.every((l) => l.difference.isZero() && !l.outstandingCredit.isNegative()) };
}
