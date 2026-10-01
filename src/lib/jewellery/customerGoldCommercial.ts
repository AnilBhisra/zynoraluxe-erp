import "server-only";

import type { CustomerGoldSettlement, GstTreatment, MetalRateBasis } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { splitGstAmount } from "@/lib/accounting/gst";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import { cancelVoucher, createVoucherHeader, insertBalancedJournalLines, type JournalLineInput } from "@/lib/accounting/posting";
import type { Tx } from "@/lib/corrections/types";
import { round3 } from "@/lib/diamond/allocation";
import { opaqueFingerprint } from "@/lib/jewellery/customerGold";
import {
  type Actor,
  CustomerGoldError,
  type PoolKey,
  type WeightPair,
  d3,
  fineOf,
  loadPoolInTx,
  lockCustomerGold,
  placeBalance,
  shareOf,
  writeCustomerGoldEntry,
} from "@/lib/jewellery/customerGoldLedger";
import { nextJewelleryCode } from "@/lib/jewellery/numbering";
import { createMetalPurchase } from "@/lib/jewellery/posting";

/**
 * Customer Gold — the money side (CUSTOMER_GOLD_DESIGN.md §2.1, §2.5, §3):
 *
 *  - Purchase / exchange (Owner-approved): Dr 1300 at the approved value /
 *    Cr 2000 to the Customer, through createMetalPurchase — the only way a
 *    Customer's gold ever becomes Company stock.
 *  - Bill (Owner): Dr 1100 AR / Cr 4000 / Cr GST for making, Company stones,
 *    Company materials and other charges — never the Customer's own gold.
 *    Credit from a purchase/exchange can be applied in the same voucher:
 *    Dr 2000 / Cr 1100 (both the Customer).
 *  - Delivery (Owner or Staff): FINISHED → DELIVERED in the Customer Gold
 *    ledger and Dr 5200 COGS / Cr 1340 for the Company's own cost in the pieces.
 *  - Every one of them is reversed by an audited mirror, never edited.
 */

function requireOwner(actor: Actor, what: string) {
  if (actor.role !== "OWNER") throw new CustomerGoldError(`Only the Owner can ${what}.`);
}
function reasonOf(r: string | null | undefined, min = 3) {
  const t = r?.trim() ?? "";
  if (t.length < min) throw new CustomerGoldError(min >= 10 ? `Give the reason (at least ${min} characters).` : "Give a short reason.");
  return t;
}
const money = (v: DecimalInput | null | undefined) => round2(v === null || v === undefined || String(v).trim() === "" ? 0 : v);
/** A purchase rate at the 4 decimals it is stored with (round half-up). */
const rate4 = (v: DecimalInput) => new Decimal(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
function referenceOf(r: string | null | undefined) {
  const t = r?.trim() ?? "";
  if (t.length < 2) throw new CustomerGoldError("Enter the reference (bill, slip or register number) for this purchase/exchange.");
  return t.slice(0, 120);
}

// ---------------------------------------------------------------------------
// Purchase / exchange of a Customer's gold (Owner-approved)
// ---------------------------------------------------------------------------

export type CustomerGoldPurchaseInput = {
  customerId: string;
  purchaseDate: Date;
  purityId: string;
  /** DIRECT: gold handed over now to be bought. CUSTODY: buy (part of) the Customer's gold already in the safe. */
  source: "DIRECT" | "CUSTODY";
  /** DIRECT: the gross weight bought. CUSTODY: one of gross / fine / all out of the safe. */
  grossWeight?: DecimalInput | null;
  fineWeight?: DecimalInput | null;
  all?: boolean;
  /** CUSTODY only: the fineness snapshot of the Customer's pool. */
  finenessPercent?: DecimalInput | null;
  rateBasis: MetalRateBasis;
  /** Per gross gram, per fine gram, or the fixed total (FIXED_TOTAL). */
  rate: DecimalInput;
  settlement: CustomerGoldSettlement;
  reason: string;
  /** Phase 8C: required — the bill / slip / register number the purchase can be traced to. */
  reference?: string | null;
  /** The Owner's explicit approval of the purchase and its value. */
  approved: boolean;
  /**
   * Old Gold Exchange (internal): buy EXACTLY this intake's net gross / fine out
   * of the safe, in the same transaction that recorded it — never a share of
   * whatever else the Customer holds there.
   */
  exactIntake?: { receiptId: string; gross: Decimal; fine: Decimal } | null;
};

export type CustomerGoldPurchasePlan = {
  customerName: string;
  purityDisplayName: string;
  metalType: PoolKey["metalType"];
  finenessPercent: Decimal;
  gross: Decimal;
  fine: Decimal;
  value: Decimal;
  safeBefore: WeightPair | null;
  safeAfter: WeightPair | null;
};

export async function planCustomerGoldPurchase(tx: Tx, input: CustomerGoldPurchaseInput): Promise<CustomerGoldPurchasePlan> {
  reasonOf(input.reason);
  referenceOf(input.reference);
  const customer = await tx.party.findUnique({ where: { id: input.customerId } });
  if (!customer || customer.type !== "CUSTOMER") throw new CustomerGoldError("Choose the Customer the gold is bought from.");
  const purity = await tx.metalPurity.findUnique({ where: { id: input.purityId } });
  if (!purity || !purity.isActive || purity.metalType === "ALLOY") throw new CustomerGoldError("Choose the Company metal purity the gold is bought into.");
  const companyFineness = new Decimal(purity.finenessPercent);
  let gross: Decimal;
  let fine: Decimal;
  let safeBefore: WeightPair | null = null;
  let safeAfter: WeightPair | null = null;
  if (input.source === "DIRECT") {
    gross = d3(input.grossWeight);
    if (!gross.greaterThan(0)) throw new CustomerGoldError("Enter the gross weight bought.");
    fine = fineOf(gross, companyFineness);
  } else {
    const poolFineness = d3(input.finenessPercent);
    // Never silently re-test a Customer's gold: it enters Company stock at the fineness it was held at.
    if (!poolFineness.equals(companyFineness)) {
      throw new CustomerGoldError(
        `The Customer's gold is held at ${poolFineness.toFixed(3)}% but Company ${purity.displayName} stock is ${companyFineness.toFixed(3)}%. Choose the Company purity with the same fineness.`
      );
    }
    const pool = await loadPoolInTx(tx, { customerId: customer.id, metalType: purity.metalType, purityId: purity.id, finenessPercentSnapshot: poolFineness });
    safeBefore = placeBalance(pool, { location: "SAFE", scopeId: null });
    const want = input.all ? { all: true } : input.fineWeight != null && String(input.fineWeight).trim() !== "" ? { fine: d3(input.fineWeight) } : { gross: d3(input.grossWeight) };
    const moved = input.exactIntake ? { gross: input.exactIntake.gross, fine: input.exactIntake.fine } : shareOf(safeBefore, want, poolFineness);
    if (!moved.fine.greaterThan(0)) throw new CustomerGoldError(`${customer.name} has no ${purity.displayName} in the safe to sell.`);
    if (moved.fine.greaterThan(safeBefore.fine) || moved.gross.greaterThan(safeBefore.gross)) {
      throw new CustomerGoldError(`${customer.name} has only ${safeBefore.fine.toFixed(3)} g fine / ${safeBefore.gross.toFixed(3)} g gross of ${purity.displayName} in the safe.`);
    }
    gross = moved.gross;
    fine = moved.fine;
    safeAfter = { gross: round3(safeBefore.gross.minus(gross)), fine: round3(safeBefore.fine.minus(fine)) };
  }
  // The rate is stored to 4 decimals, so it is used at exactly those 4 decimals:
  // the value on the voucher is always reproducible from the stored rate.
  const rate = rate4(input.rate);
  if (!rate.greaterThan(0)) throw new CustomerGoldError("Enter the agreed rate (or fixed total).");
  const value = input.rateBasis === "PER_GROSS_GRAM" ? round2(rate.times(gross)) : input.rateBasis === "PER_FINE_GRAM" ? round2(rate.times(fine)) : round2(rate);
  if (!value.greaterThan(0)) throw new CustomerGoldError("The agreed value must be above zero.");
  return { customerName: customer.name, purityDisplayName: purity.displayName, metalType: purity.metalType, finenessPercent: companyFineness, gross, fine, value, safeBefore, safeAfter };
}

export function customerGoldPurchaseFingerprint(input: CustomerGoldPurchaseInput, plan: CustomerGoldPurchasePlan): string {
  return opaqueFingerprint("customer-gold-purchase", {
    c: input.customerId,
    p: input.purityId,
    s: input.source,
    w: [plan.gross.toFixed(3), plan.fine.toFixed(3)],
    v: plan.value.toFixed(2),
    safe: plan.safeBefore ? [plan.safeBefore.gross.toFixed(3), plan.safeBefore.fine.toFixed(3)] : null,
    st: input.settlement,
  });
}

export async function purchaseCustomerGold(tx: Tx, input: CustomerGoldPurchaseInput & { expectedFingerprint?: string | null; idempotencyKey: string; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  requireOwner(input.actor, "approve buying a Customer's gold");
  if (!input.approved) throw new CustomerGoldError("Tick the approval: the Company is buying this gold from the Customer at the agreed value.");
  if (!input.idempotencyKey?.trim()) throw new CustomerGoldError("Missing submission key — reload the page and try again.");
  const existing = await tx.customerGoldPurchase.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { purchase: existing, replayed: true as const };
  await lockCustomerGold(tx, { purityId: input.purityId, customerId: input.customerId });
  const plan = await planCustomerGoldPurchase(tx, input);
  if (input.expectedFingerprint && input.expectedFingerprint !== customerGoldPurchaseFingerprint(input, plan)) {
    throw new CustomerGoldError("The Customer's gold or the agreed value changed after this preview. Review it and approve again.");
  }
  const purchaseCode = await nextJewelleryCode(tx, "CUSTOMER_GOLD_PURCHASE");
  const reason = reasonOf(input.reason);
  // The existing, reconciled Company purchase posting: Dr 1300 / Cr 2000 (Customer), PURCHASE_IN at the approved value.
  const metalPurchase = await createMetalPurchase(tx, {
    purchaseDate: input.purchaseDate,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    supplierId: input.customerId,
    metalType: plan.metalType,
    purityId: input.purityId,
    grossWeight: plan.gross,
    rateBasis: input.rateBasis,
    rate: rate4(input.rate),
    currencyCode: "INR",
    exchangeRate: 1,
    totalPurchaseCost: plan.value,
    gstTreatment: "NONE",
    referenceNumber: purchaseCode,
    notes: `Purchase/exchange of Customer gold ${purchaseCode} — ${reason}`,
    idempotencyKey: `${input.idempotencyKey}:metal`,
    createdByUserId: input.actor.id,
    // The value was derived from the stored 4-dp rate: let the posting re-derive and prove it.
    totalManuallyEdited: false,
  });
  if (!new Decimal(metalPurchase.fineWeight).equals(plan.fine)) throw new CustomerGoldError("Internal check failed: fine weight mismatch. Nothing was saved.");
  const purchase = await tx.customerGoldPurchase.create({
    data: {
      purchaseCode,
      customerId: input.customerId,
      purchaseDate: input.purchaseDate,
      metalType: plan.metalType,
      purityId: input.purityId,
      finenessPercentSnapshot: plan.finenessPercent.toFixed(3),
      grossWeight: plan.gross.toFixed(3),
      fineWeight: plan.fine.toFixed(3),
      rateBasis: input.rateBasis,
      rate: rate4(input.rate).toFixed(4),
      approvedValue: plan.value.toFixed(2),
      settlement: input.settlement,
      fromCustody: input.source === "CUSTODY",
      metalPurchaseId: metalPurchase.id,
      customerGoldReceiptId: input.exactIntake?.receiptId ?? null,
      reason,
      reference: referenceOf(input.reference),
      approvedByUserId: input.actor.id,
      approvedAt: new Date(),
      idempotencyKey: input.idempotencyKey,
    },
  });
  if (input.source === "CUSTODY") {
    await writeCustomerGoldEntry(tx, {
      kind: "CONVERT_TO_COMPANY",
      pool: { customerId: input.customerId, metalType: plan.metalType, purityId: input.purityId, finenessPercentSnapshot: plan.finenessPercent },
      from: { location: "SAFE", scopeId: null },
      to: { location: "PURCHASED", scopeId: null },
      gross: plan.gross,
      fine: plan.fine,
      entryDate: input.purchaseDate,
      reason,
      reference: purchaseCode,
      purchaseId: purchase.id,
      createdByUserId: input.actor.id,
    });
  }
  return { purchase, replayed: false as const, plan, metalPurchase };
}

/**
 * Credit a Customer can still apply to a bill: approved purchases settled
 * "credit to invoice" less what bills already applied — never more than the
 * Customer's actual payable balance (a payment made through Payment Given
 * reduces it).
 */
export async function availableCustomerCreditInTx(tx: Tx, customerId: string): Promise<Decimal> {
  const [credits, bills, ap] = await Promise.all([
    tx.customerGoldPurchase.aggregate({ where: { customerId, settlement: "CREDIT_TO_INVOICE", status: "POSTED" }, _sum: { approvedValue: true } }),
    tx.customerJewelleryBill.aggregate({ where: { customerId, status: "POSTED" }, _sum: { creditApplied: true } }),
    // Every line counts: a cancelled voucher keeps its lines and gains a
    // mirror REVERSAL voucher, so the two net to zero. Excluding the cancelled
    // original but keeping its mirror would mis-state the payable.
    tx.journalEntry.aggregate({ where: { partyId: customerId, account: { code: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE } }, _sum: { credit: true, debit: true } }),
  ]);
  const purchaseCredit = round2(new Decimal(credits._sum.approvedValue ?? 0).minus(bills._sum.creditApplied ?? 0));
  const payable = round2(new Decimal(ap._sum.credit ?? 0).minus(ap._sum.debit ?? 0));
  const available = Decimal.min(purchaseCredit, payable);
  return available.isNegative() ? ZERO : available;
}

// ---------------------------------------------------------------------------
// Bill (Owner)
// ---------------------------------------------------------------------------

export type CustomerJewelleryBillInput = {
  jobId: string;
  billDate: Date;
  makingCharge?: DecimalInput | null;
  diamondCharge?: DecimalInput | null;
  materialCharge?: DecimalInput | null;
  otherCharge?: DecimalInput | null;
  gstTreatment: GstTreatment;
  gstRatePercent?: DecimalInput | null;
  creditToApply?: DecimalInput | null;
  description?: string | null;
};

export type CustomerJewelleryBillPlan = {
  customerId: string;
  customerName: string;
  jobCode: string;
  taxableValue: Decimal;
  taxAmount: Decimal;
  cgst: Decimal;
  sgst: Decimal;
  igst: Decimal;
  grandTotal: Decimal;
  creditApplied: Decimal;
  amountDue: Decimal;
  creditAvailable: Decimal;
};

export async function planCustomerJewelleryBill(tx: Tx, input: CustomerJewelleryBillInput): Promise<CustomerJewelleryBillPlan> {
  const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, include: { customer: true } });
  if (!job) throw new CustomerGoldError("Job not found.");
  if (!job.customerId || !job.customer) throw new CustomerGoldError(`${job.jobCode} has no Customer to bill.`);
  const customerPieces = await tx.finishedJewellery.count({ where: { jobId: job.id, ownership: "CUSTOMER", status: { not: "RECEIPT_REVERSED" } } });
  if (customerPieces === 0) throw new CustomerGoldError(`${job.jobCode} has no Customer-owned jewellery to bill yet. (Company-owned pieces are sold through Finished Stock.)`);
  const charges = [input.makingCharge, input.diamondCharge, input.materialCharge, input.otherCharge].map(money);
  if (charges.some((c) => c.isNegative())) throw new CustomerGoldError("Charges cannot be negative.");
  const taxableValue = round2(charges.reduce((s, c) => s.plus(c), ZERO));
  if (!taxableValue.greaterThan(0)) throw new CustomerGoldError("Enter at least one charge. (The Customer's own gold is never billed.)");
  const rate = input.gstTreatment === "NONE" ? ZERO : money(input.gstRatePercent);
  if (input.gstTreatment !== "NONE" && !rate.greaterThan(0)) throw new CustomerGoldError("Enter the GST rate.");
  const taxAmount = input.gstTreatment === "NONE" ? ZERO : round2(taxableValue.times(rate).dividedBy(100));
  const { cgst, sgst, igst } = splitGstAmount(taxAmount, input.gstTreatment);
  const grandTotal = round2(taxableValue.plus(taxAmount));
  const creditAvailable = await availableCustomerCreditInTx(tx, job.customerId);
  const creditApplied = money(input.creditToApply);
  if (creditApplied.isNegative()) throw new CustomerGoldError("Credit cannot be negative.");
  if (creditApplied.greaterThan(creditAvailable)) throw new CustomerGoldError(`${job.customer.name} has only ₹${creditAvailable.toFixed(2)} of gold-purchase credit available.`);
  if (creditApplied.greaterThan(grandTotal)) throw new CustomerGoldError("Credit applied cannot exceed the bill total.");
  return {
    customerId: job.customerId,
    customerName: job.customer.name,
    jobCode: job.jobCode,
    taxableValue,
    taxAmount,
    cgst,
    sgst,
    igst,
    grandTotal,
    creditApplied,
    amountDue: round2(grandTotal.minus(creditApplied)),
    creditAvailable,
  };
}

export async function billCustomerJewellery(tx: Tx, input: CustomerJewelleryBillInput & { idempotencyKey: string; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  requireOwner(input.actor, "bill a Customer");
  if (!input.idempotencyKey?.trim()) throw new CustomerGoldError("Missing submission key — reload the page and try again.");
  const existing = await tx.customerJewelleryBill.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { bill: existing, replayed: true as const };
  const jobRow = await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, select: { customerId: true } });
  if (!jobRow?.customerId) throw new CustomerGoldError("This job has no Customer to bill.");
  await tx.$queryRawUnsafe(`SELECT id FROM "parties" WHERE id = $1 FOR UPDATE`, jobRow.customerId);
  await tx.$queryRawUnsafe(`SELECT id FROM "jewellery_jobs" WHERE id = $1 FOR UPDATE`, input.jobId);
  const plan = await planCustomerJewelleryBill(tx, input);
  const billCode = await nextJewelleryCode(tx, "CUSTOMER_JEWELLERY_BILL");
  const lines: JournalLineInput[] = [
    { accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, partyId: plan.customerId, debit: plan.grandTotal, description: `Bill ${billCode} (${plan.jobCode})` },
    { accountCode: SYSTEM_ACCOUNT_CODES.SALES_INCOME, credit: plan.taxableValue, description: `Making / Company materials ${billCode}` },
    { accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_CGST, credit: plan.cgst, description: "Output CGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_SGST, credit: plan.sgst, description: "Output SGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_IGST, credit: plan.igst, description: "Output IGST" },
  ];
  if (plan.creditApplied.greaterThan(0)) {
    lines.push(
      { accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, partyId: plan.customerId, debit: plan.creditApplied, description: `Gold-purchase credit applied ${billCode}` },
      { accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, partyId: plan.customerId, credit: plan.creditApplied, description: `Gold-purchase credit applied ${billCode}` }
    );
  }
  const voucher = await createVoucherHeader(
    tx,
    {
      date: input.billDate,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
      currencyCode: "INR",
      exchangeRate: 1,
      referenceNumber: billCode,
      note: `Customer jewellery bill ${billCode} for ${plan.jobCode} — Customer's own gold not billed`,
      createdByUserId: input.actor.id,
    },
    "CUSTOMER_JEWELLERY_BILL",
    { amount: plan.grandTotal, partyId: plan.customerId, gstTreatment: input.gstTreatment }
  );
  await insertBalancedJournalLines(tx, voucher.id, lines);
  const bill = await tx.customerJewelleryBill.create({
    data: {
      billCode,
      customerId: plan.customerId,
      jobId: input.jobId,
      billDate: input.billDate,
      makingCharge: money(input.makingCharge).toFixed(2),
      diamondCharge: money(input.diamondCharge).toFixed(2),
      materialCharge: money(input.materialCharge).toFixed(2),
      otherCharge: money(input.otherCharge).toFixed(2),
      taxableValue: plan.taxableValue.toFixed(2),
      gstTreatment: input.gstTreatment,
      gstRatePercent: input.gstTreatment === "NONE" ? null : money(input.gstRatePercent).toFixed(2),
      taxAmount: plan.taxAmount.toFixed(2),
      grandTotal: plan.grandTotal.toFixed(2),
      creditApplied: plan.creditApplied.toFixed(2),
      amountDue: plan.amountDue.toFixed(2),
      description: input.description?.trim() || null,
      voucherId: voucher.id,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.actor.id,
    },
  });
  return { bill, replayed: false as const, plan };
}

export async function reverseCustomerJewelleryBill(tx: Tx, input: { billId: string; reason: string; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  requireOwner(input.actor, "reverse a Customer bill");
  const reason = reasonOf(input.reason, 10);
  const bill = await tx.customerJewelleryBill.findUnique({ where: { id: input.billId } });
  if (!bill) throw new CustomerGoldError("Bill not found.");
  await tx.$queryRawUnsafe(`SELECT id FROM "parties" WHERE id = $1 FOR UPDATE`, bill.customerId);
  const fresh = await tx.customerJewelleryBill.findUniqueOrThrow({ where: { id: bill.id } });
  if (fresh.status !== "POSTED") throw new CustomerGoldError(`${bill.billCode} is already reversed.`);
  const reversal = await cancelVoucher(tx, { voucherId: bill.voucherId, cancelledByUserId: input.actor.id, cancellationReason: reason, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay });
  return tx.customerJewelleryBill.update({
    where: { id: bill.id },
    data: { status: "REVERSED", reversedAt: new Date(), reversedByUserId: input.actor.id, reversalReason: reason, reversalVoucherId: reversal.id },
  });
}

// ---------------------------------------------------------------------------
// Delivery (Owner or Staff)
// ---------------------------------------------------------------------------

export type CustomerJewelleryDeliveryInput = {
  jobId: string;
  /** Default: every Customer-owned piece of the job still awaiting delivery. */
  finishedJewelleryIds?: string[] | null;
  deliveryDate: Date;
  receivedByName: string;
  reference?: string | null;
  notes?: string | null;
};

/** Why this job's Customer jewellery cannot be delivered yet, or null. Weights only (safe for Staff). */
export async function customerDeliveryBlock(tx: Tx, jobId: string): Promise<string | null> {
  const job = await tx.jewelleryJob.findUnique({ where: { id: jobId } });
  if (!job) return "Job not found.";
  if (!job.customerId) return `${job.jobCode} has no Customer.`;
  if (job.status !== "COMPLETED") {
    return `${job.jobCode} is not completed — every gram of gold, every diamond and every packet stone must be received, returned, scrapped or recorded as loss before the Customer's jewellery is delivered.`;
  }
  return null;
}

export async function deliverCustomerJewellery(tx: Tx, input: CustomerJewelleryDeliveryInput & { idempotencyKey: string; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  if (input.actor.role !== "OWNER" && input.actor.role !== "STAFF") throw new CustomerGoldError("You are not allowed to deliver jewellery.");
  const receivedBy = input.receivedByName?.trim() ?? "";
  if (receivedBy.length < 2) throw new CustomerGoldError("Enter who received the jewellery.");
  if (!input.idempotencyKey?.trim()) throw new CustomerGoldError("Missing submission key — reload the page and try again.");
  const existing = await tx.customerJewelleryDelivery.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { delivery: existing, replayed: true as const };

  const jobRow = await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, select: { customerId: true } });
  if (!jobRow?.customerId) throw new CustomerGoldError("This job has no Customer.");
  const pieces = await tx.finishedJewellery.findMany({
    where: {
      jobId: input.jobId,
      ownership: "CUSTOMER",
      status: "CUSTOMER_AWAITING_DELIVERY",
      ...(input.finishedJewelleryIds?.length ? { id: { in: input.finishedJewelleryIds } } : {}),
    },
    orderBy: { finishedCode: "asc" },
  });
  if (input.finishedJewelleryIds?.length && pieces.length !== input.finishedJewelleryIds.length) {
    throw new CustomerGoldError("One or more pieces are not this job's Customer jewellery awaiting delivery.");
  }
  if (pieces.length === 0) throw new CustomerGoldError("Nothing is awaiting delivery on this job.");
  // Locks: every pool involved (purity → Customer), then the job.
  const purityIds = [...new Set((await tx.customerGoldEntry.findMany({ where: { finishedJewelleryId: { in: pieces.map((p) => p.id) } }, select: { purityId: true } })).map((e) => e.purityId))].sort();
  for (const purityId of purityIds) await lockCustomerGold(tx, { purityId, customerId: jobRow.customerId, jobId: input.jobId });
  if (purityIds.length === 0) await tx.$queryRawUnsafe(`SELECT id FROM "jewellery_jobs" WHERE id = $1 FOR UPDATE`, input.jobId);
  const block = await customerDeliveryBlock(tx, input.jobId);
  if (block) throw new CustomerGoldError(block);
  // Re-read under the locks: a concurrent delivery of the same piece fails here.
  const locked = await tx.finishedJewellery.findMany({ where: { id: { in: pieces.map((p) => p.id) }, status: "CUSTOMER_AWAITING_DELIVERY" } });
  if (locked.length !== pieces.length) throw new CustomerGoldError("One or more pieces were just delivered by someone else. Refresh and try again.");

  const deliveryCode = await nextJewelleryCode(tx, "CUSTOMER_JEWELLERY_DELIVERY");
  const companyCost = round2(pieces.reduce((s, p) => s.plus(p.metalCost).plus(p.diamondCost).plus(p.labourAllocated), ZERO));
  const goldFine = round3(pieces.reduce((s, p) => s.plus(p.customerGoldFineWeight), ZERO));
  let cogsVoucherId: string | null = null;
  if (companyCost.greaterThan(0)) {
    const voucher = await createVoucherHeader(
      tx,
      {
        date: input.deliveryDate,
        fyStartMonth: input.fyStartMonth,
        fyStartDay: input.fyStartDay,
        currencyCode: "INR",
        exchangeRate: 1,
        referenceNumber: deliveryCode,
        note: `Customer jewellery delivered ${deliveryCode} — Company cost to COGS`,
        createdByUserId: input.actor.id,
      },
      "CUSTOMER_JEWELLERY_DELIVERY",
      { amount: companyCost, partyId: jobRow.customerId }
    );
    await insertBalancedJournalLines(tx, voucher.id, [
      { accountCode: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS, debit: companyCost, description: `Company cost in delivered Customer jewellery ${deliveryCode}` },
      { accountCode: SYSTEM_ACCOUNT_CODES.CUSTOMER_JEWELLERY_WIP, credit: companyCost, description: `Delivered ${deliveryCode}` },
    ]);
    cogsVoucherId = voucher.id;
  }
  const delivery = await tx.customerJewelleryDelivery.create({
    data: {
      deliveryCode,
      customerId: jobRow.customerId,
      jobId: input.jobId,
      deliveryDate: input.deliveryDate,
      deliveredByUserId: input.actor.id,
      receivedByName: receivedBy,
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
      companyCostTotal: companyCost.toFixed(2),
      customerGoldFineTotal: goldFine.toFixed(3),
      cogsVoucherId,
      idempotencyKey: input.idempotencyKey,
      items: {
        create: pieces.map((p) => ({
          finishedJewelleryId: p.id,
          companyCost: round2(new Decimal(p.metalCost).plus(p.diamondCost).plus(p.labourAllocated)).toFixed(2),
          customerGoldFineWeight: new Decimal(p.customerGoldFineWeight).toFixed(3),
        })),
      },
    },
  });
  for (const p of pieces) {
    // The piece's Customer gold moves FINISHED → DELIVERED, exactly what is at FINISHED for it.
    const consumed = await tx.customerGoldEntry.findMany({ where: { finishedJewelleryId: p.id } });
    const pools = new Map(consumed.map((e) => [`${e.purityId}|${new Decimal(e.finenessPercentSnapshot).toFixed(3)}`, e]));
    for (const e of pools.values()) {
      const pool: PoolKey = { customerId: e.customerId, metalType: e.metalType, purityId: e.purityId, finenessPercentSnapshot: new Decimal(e.finenessPercentSnapshot) };
      const at = placeBalance(await loadPoolInTx(tx, pool), { location: "FINISHED", scopeId: p.id });
      if (!at.fine.greaterThan(0)) continue;
      await writeCustomerGoldEntry(tx, {
        kind: "DELIVER",
        pool,
        from: { location: "FINISHED", scopeId: p.id },
        to: { location: "DELIVERED", scopeId: null },
        gross: at.gross,
        fine: at.fine,
        entryDate: input.deliveryDate,
        reason: `Delivered to ${receivedBy}`,
        reference: deliveryCode,
        jobId: input.jobId,
        finishedJewelleryId: p.id,
        deliveryId: delivery.id,
        createdByUserId: input.actor.id,
      });
    }
    await tx.finishedJewellery.update({ where: { id: p.id }, data: { status: "DELIVERED_TO_CUSTOMER" } });
  }
  return { delivery, replayed: false as const, pieces: pieces.map((p) => p.finishedCode) };
}

export async function reverseCustomerJewelleryDelivery(tx: Tx, input: { deliveryId: string; reason: string; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  requireOwner(input.actor, "reverse a delivery");
  const reason = reasonOf(input.reason, 10);
  const delivery = await tx.customerJewelleryDelivery.findUnique({ where: { id: input.deliveryId }, include: { items: true, entries: true } });
  if (!delivery) throw new CustomerGoldError("Delivery not found.");
  const purityIds = [...new Set(delivery.entries.map((e) => e.purityId))].sort();
  for (const purityId of purityIds) await lockCustomerGold(tx, { purityId, customerId: delivery.customerId, jobId: delivery.jobId });
  const fresh = await tx.customerJewelleryDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
  if (fresh.status !== "POSTED") throw new CustomerGoldError(`${delivery.deliveryCode} is already reversed.`);
  // Newest first: nothing may have happened to these pieces' gold after the delivery.
  const later = await tx.customerGoldEntry.findFirst({
    where: { finishedJewelleryId: { in: delivery.items.map((i) => i.finishedJewelleryId) }, createdAt: { gt: delivery.createdAt }, deliveryId: { not: delivery.id } },
  });
  if (later) throw new CustomerGoldError(`Cannot reverse ${delivery.deliveryCode}: a later entry (${later.entryCode}) depends on it.`);
  for (const e of delivery.entries) {
    await writeCustomerGoldEntry(tx, {
      kind: "DELIVER",
      pool: { customerId: e.customerId, metalType: e.metalType, purityId: e.purityId, finenessPercentSnapshot: new Decimal(e.finenessPercentSnapshot) },
      from: { location: "FINISHED", scopeId: e.finishedJewelleryId },
      to: { location: "DELIVERED", scopeId: null },
      gross: new Decimal(e.grossWeight),
      fine: new Decimal(e.fineWeight),
      entryDate: new Date(),
      reason,
      reference: delivery.deliveryCode,
      jobId: e.jobId,
      finishedJewelleryId: e.finishedJewelleryId,
      deliveryId: delivery.id,
      reversalOfEntryId: e.id,
      createdByUserId: input.actor.id,
    });
  }
  for (const item of delivery.items) {
    await tx.finishedJewellery.update({ where: { id: item.finishedJewelleryId }, data: { status: "CUSTOMER_AWAITING_DELIVERY" } });
  }
  const reversalVoucher = delivery.cogsVoucherId
    ? await cancelVoucher(tx, { voucherId: delivery.cogsVoucherId, cancelledByUserId: input.actor.id, cancellationReason: reason, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay })
    : null;
  return tx.customerJewelleryDelivery.update({
    where: { id: delivery.id },
    data: { status: "REVERSED", reversedAt: new Date(), reversedByUserId: input.actor.id, reversalReason: reason, reversalVoucherId: reversalVoucher?.id ?? null },
  });
}
