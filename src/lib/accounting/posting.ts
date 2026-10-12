import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  GstTreatment,
  InvoiceUnit,
  OpeningBalanceType,
  TaxType,
  VoucherType,
} from "@/generated/prisma/enums";

import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { getFinancialYearLabel, indiaBusinessDate } from "@/lib/accounting/financialYear";
import { computeInvoiceLineTotals, splitGstAmount } from "@/lib/accounting/gst";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import { nextVoucherNumber } from "@/lib/accounting/numbering";
import { clearingAccountIds, mirrorClearingEntries, recordClearingEntry } from "@/lib/accounting/clearingLedger";

export class PostingError extends Error {}

type Tx = Prisma.TransactionClient;

/**
 * Explicit limits for every Accounting voucher transaction. Prisma's default
 * (5 s) is too short over the remote pooled production connection, where a
 * timed-out transaction surfaces as a generic failure. The whole voucher —
 * sequence number, header, journal lines — commits or rolls back together.
 */
export const VOUCHER_TRANSACTION_OPTIONS = { timeout: 30_000, maxWait: 15_000 } as const;

/** The payment account a settlement posts to: it must exist and be in use. */
async function resolvePaymentAccountCode(tx: Tx, paymentAccountId: string): Promise<string> {
  const paymentAccount = await tx.paymentAccount.findUnique({
    where: { id: paymentAccountId },
    select: { isActive: true, account: { select: { code: true } } },
  });
  if (!paymentAccount) throw new PostingError("Payment account not found.");
  if (paymentAccount.isActive === false) throw new PostingError("That payment account is archived. Choose another account.");
  return paymentAccount.account.code;
}

/** The party a payment settles: it must exist and be active. */
async function assertPaymentParty(tx: Tx, partyId: string): Promise<void> {
  const party = await tx.party.findUnique({ where: { id: partyId }, select: { isActive: true } });
  if (!party) throw new PostingError("Party not found.");
  if (party.isActive === false) throw new PostingError("That party is archived. Reactivate it before recording a payment.");
}

export type JournalLineInput = {
  accountCode: string;
  partyId?: string | null;
  debit?: DecimalInput;
  credit?: DecimalInput;
  description?: string | null;
};

async function resolveAccountId(tx: Tx, code: string): Promise<string> {
  const account = await tx.account.findUnique({ where: { code } });
  if (!account) {
    throw new PostingError(
      `System account "${code}" is missing. Run the seed script before posting.`
    );
  }
  return account.id;
}

/** Inserts journal lines for a voucher, after re-verifying total debit ==
 * total credit. This is the last line of defense against a posting-logic
 * bug — every caller in this file (and, via the export below, the Phase 3
 * diamond posting engine) is also individually responsible for building
 * balanced lines. */
export async function insertBalancedJournalLines(
  tx: Tx,
  voucherId: string,
  lines: JournalLineInput[]
): Promise<void> {
  const nonZeroLines = lines.filter((line) => {
    const debit = new Decimal(line.debit ?? 0);
    const credit = new Decimal(line.credit ?? 0);
    return !debit.isZero() || !credit.isZero();
  });

  if (nonZeroLines.length === 0) {
    throw new PostingError("A voucher must post at least one non-zero journal line.");
  }

  let totalDebit = ZERO;
  let totalCredit = ZERO;
  for (const line of nonZeroLines) {
    const debit = new Decimal(line.debit ?? 0);
    const credit = new Decimal(line.credit ?? 0);
    if (debit.greaterThan(0) && credit.greaterThan(0)) {
      throw new PostingError("A single journal line cannot be both a debit and a credit.");
    }
    if (debit.isNegative() || credit.isNegative()) {
      throw new PostingError("Journal lines cannot be negative.");
    }
    totalDebit = totalDebit.plus(debit);
    totalCredit = totalCredit.plus(credit);
  }

  if (!totalDebit.equals(totalCredit)) {
    throw new PostingError(
      `Unbalanced posting: total debit ${totalDebit.toFixed(2)} != total credit ${totalCredit.toFixed(2)}.`
    );
  }

  const accountIds = new Map<string, string>();
  for (const line of nonZeroLines) {
    if (!accountIds.has(line.accountCode)) {
      accountIds.set(line.accountCode, await resolveAccountId(tx, line.accountCode));
    }
  }

  await tx.journalEntry.createMany({
    data: nonZeroLines.map((line) => ({
      voucherId,
      accountId: accountIds.get(line.accountCode)!,
      partyId: line.partyId ?? null,
      debit: new Decimal(line.debit ?? 0).toFixed(2),
      credit: new Decimal(line.credit ?? 0).toFixed(2),
      description: line.description ?? null,
    })),
  });
}

export type CommonVoucherInput = {
  date: Date;
  fyStartMonth: number;
  fyStartDay: number;
  currencyCode: string;
  exchangeRate: DecimalInput;
  referenceNumber?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
  createdByUserId: string;
};

/** Exported so the Phase 3 diamond posting engine can allocate a voucher
 * number + header row through the same FY-labeling and numbering logic,
 * for voucher types (DIAMOND_ISSUE, DIAMOND_RECEIPT) this file doesn't
 * itself post lines for. */
export async function createVoucherHeader(
  tx: Tx,
  common: CommonVoucherInput,
  voucherType: VoucherType,
  fields: {
    amount: DecimalInput;
    partyId?: string | null;
    paymentAccountId?: string | null;
    gstTreatment?: GstTreatment;
  }
) {
  const financialYearLabel = getFinancialYearLabel(
    common.date,
    common.fyStartMonth,
    common.fyStartDay
  );
  const voucherNumber = await nextVoucherNumber(tx, voucherType, financialYearLabel);

  return tx.voucher.create({
    data: {
      voucherNumber,
      voucherType,
      date: common.date,
      financialYearLabel,
      partyId: fields.partyId ?? null,
      paymentAccountId: fields.paymentAccountId ?? null,
      amount: new Decimal(fields.amount).toFixed(2),
      currencyCode: common.currencyCode,
      exchangeRate: new Decimal(common.exchangeRate).toFixed(4),
      referenceNumber: common.referenceNumber ?? null,
      note: common.note ?? null,
      gstTreatment: fields.gstTreatment ?? "NONE",
      idempotencyKey: common.idempotencyKey ?? null,
      createdByUserId: common.createdByUserId,
    },
  });
}

// ---------------------------------------------------------------------------
// Opening balance (posted once, when a Party is created with a non-zero
// opening balance)
// ---------------------------------------------------------------------------

export async function postOpeningBalance(
  tx: Tx,
  input: CommonVoucherInput & {
    partyId: string;
    amount: DecimalInput;
    openingBalanceType: OpeningBalanceType;
  }
) {
  const amount = round2(input.amount);
  if (!amount.greaterThan(0)) {
    throw new PostingError("Opening balance amount must be greater than zero.");
  }

  const voucher = await createVoucherHeader(tx, input, "OPENING", {
    amount,
    partyId: input.partyId,
  });

  if (input.openingBalanceType === "RECEIVABLE") {
    await insertBalancedJournalLines(tx, voucher.id, [
      {
        accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
        partyId: input.partyId,
        debit: amount,
        description: "Opening receivable",
      },
      {
        accountCode: SYSTEM_ACCOUNT_CODES.OPENING_BALANCE_EQUITY,
        credit: amount,
        description: "Opening receivable",
      },
    ]);
  } else {
    await insertBalancedJournalLines(tx, voucher.id, [
      {
        accountCode: SYSTEM_ACCOUNT_CODES.OPENING_BALANCE_EQUITY,
        debit: amount,
        description: "Opening payable",
      },
      {
        accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
        partyId: input.partyId,
        credit: amount,
        description: "Opening payable",
      },
    ]);
  }

  return voucher;
}

// ---------------------------------------------------------------------------
// Purchase / Sale (with invoice lines)
// ---------------------------------------------------------------------------

export type InvoiceLineInput = {
  description: string;
  hsnSac?: string | null;
  quantity: DecimalInput;
  unit: InvoiceUnit;
  rate: DecimalInput;
  discount?: DecimalInput;
  gstRateId?: string | null;
  gstRatePercent: DecimalInput;
  taxType: TaxType;
};

type InvoiceVoucherInput = CommonVoucherInput & {
  partyId: string;
  paymentAccountId?: string | null;
  gstTreatment: GstTreatment;
  lines: InvoiceLineInput[];
};

/** Exported so the Phase 6 Finished Jewellery Sale posting engine can
 * compute the exact same per-line taxable/tax/total breakdown BEFORE
 * calling postSale, to snapshot onto its own FinishedJewellerySaleLine
 * rows — postSale's own return value stays `Voucher` only (unchanged),
 * to avoid touching its existing caller in src/app/actions/vouchers.ts. */
export function computeLineTotalsForAll(lines: InvoiceLineInput[]) {
  const computed = lines.map((line) => ({
    line,
    totals: computeInvoiceLineTotals({
      quantity: line.quantity,
      rate: line.rate,
      discount: line.discount,
      gstRatePercent: line.gstRatePercent,
      taxType: line.taxType,
    }),
  }));

  const totalTaxable = computed.reduce(
    (sum, { totals }) => sum.plus(totals.taxableValue),
    ZERO
  );
  const totalTax = computed.reduce((sum, { totals }) => sum.plus(totals.taxAmount), ZERO);
  const totalAmount = round2(totalTaxable.plus(totalTax));

  return { computed, totalTaxable: round2(totalTaxable), totalTax: round2(totalTax), totalAmount };
}

async function insertInvoiceLines(
  tx: Tx,
  voucherId: string,
  computed: ReturnType<typeof computeLineTotalsForAll>["computed"]
) {
  await tx.invoiceLine.createMany({
    data: computed.map(({ line, totals }, index) => ({
      voucherId,
      description: line.description,
      hsnSac: line.hsnSac ?? null,
      quantity: new Decimal(line.quantity).toFixed(3),
      unit: line.unit,
      rate: new Decimal(line.rate).toFixed(2),
      discount: new Decimal(line.discount ?? 0).toFixed(2),
      gstRateId: line.gstRateId ?? null,
      gstRatePercent: new Decimal(line.gstRatePercent).toFixed(2),
      taxType: line.taxType,
      taxableValue: totals.taxableValue.toFixed(2),
      taxAmount: totals.taxAmount.toFixed(2),
      lineTotal: totals.lineTotal.toFixed(2),
      sortOrder: index,
    })),
  });
}

export async function postPurchase(tx: Tx, input: InvoiceVoucherInput) {
  if (input.lines.length === 0) {
    throw new PostingError("A purchase must have at least one item line.");
  }
  const { computed, totalTaxable, totalTax, totalAmount } = computeLineTotalsForAll(
    input.lines
  );
  if (!totalAmount.greaterThan(0)) {
    throw new PostingError("Purchase total must be greater than zero.");
  }

  const voucher = await createVoucherHeader(tx, input, "PURCHASE", {
    amount: totalAmount,
    partyId: input.partyId,
    paymentAccountId: input.paymentAccountId,
    gstTreatment: input.gstTreatment,
  });

  await insertInvoiceLines(tx, voucher.id, computed);

  const { cgst, sgst, igst } = splitGstAmount(totalTax, input.gstTreatment);

  const lines: JournalLineInput[] = [
    { accountCode: SYSTEM_ACCOUNT_CODES.PURCHASES, debit: totalTaxable, description: "Purchase" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_CGST, debit: cgst, description: "Input CGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_SGST, debit: sgst, description: "Input SGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_IGST, debit: igst, description: "Input IGST" },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: input.partyId,
      credit: totalAmount,
      description: "Purchase",
    },
  ];

  if (input.paymentAccountId) {
    const paymentAccount = await tx.paymentAccount.findUnique({
      where: { id: input.paymentAccountId },
      select: { account: { select: { code: true } } },
    });
    if (!paymentAccount) throw new PostingError("Payment account not found.");
    lines.push(
      {
        accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
        partyId: input.partyId,
        debit: totalAmount,
        description: "Purchase settled immediately",
      },
      {
        accountCode: paymentAccount.account.code,
        credit: totalAmount,
        description: "Purchase settled immediately",
      }
    );
  }

  await insertBalancedJournalLines(tx, voucher.id, lines);
  return voucher;
}

export async function postSale(
  tx: Tx,
  input: InvoiceVoucherInput & {
    /** Phase 6: lets a Finished Jewellery Sale append its Dr COGS / Cr
     * Finished Jewellery Inventory lines to this SAME voucher's SAME
     * balanced-lines call, so the whole sale — revenue, GST, and
     * inventory/COGS — is one atomic posting, not two. Every other
     * caller (plain accounting-only Sale) omits this and behaves exactly
     * as before. */
    additionalLines?: JournalLineInput[];
    /**
     * Clearing sale (to a marketplace / provider party): the currency the
     * marketplace shows the sale in and the amount in it. Optional for INR
     * (the INR total is used); required for any other currency. Ignored for
     * ordinary parties — whose sales stay exactly as before.
     */
    clearing?: { currencyCode: string; foreignAmount?: DecimalInput | null } | null;
  }
) {
  if (input.lines.length === 0) {
    throw new PostingError("A sale must have at least one item line.");
  }
  const { computed, totalTaxable, totalTax, totalAmount } = computeLineTotalsForAll(
    input.lines
  );
  if (!totalAmount.greaterThan(0)) {
    throw new PostingError("Sale total must be greater than zero.");
  }

  // A clearing-enabled party (Etsy, Amazon, PayPal, COD courier …) collects
  // for us and pays out in batches: its sale debits 1150 Marketplace Clearing,
  // never Cash/Bank and never Accounts Receivable. See CLEARING_SETTLEMENT_DESIGN.md.
  const party = await tx.party.findUnique({ where: { id: input.partyId }, select: { clearingEnabled: true, name: true } });
  const isClearing = party?.clearingEnabled === true;
  let clearingCurrency = "INR";
  let clearingFc = totalAmount;
  if (isClearing) {
    if (input.paymentAccountId) {
      throw new PostingError(
        `${party?.name ?? "This party"} is a marketplace / clearing party: its sales are paid through a settlement (Accounting → Settlements), not "Paid now".`
      );
    }
    clearingCurrency = (input.clearing?.currencyCode || "INR").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(clearingCurrency)) throw new PostingError("Choose a 3-letter currency code for the marketplace amount.");
    const fcRaw = input.clearing?.foreignAmount;
    if (clearingCurrency === "INR") {
      if (fcRaw !== null && fcRaw !== undefined && String(fcRaw).trim() !== "" && !new Decimal(String(fcRaw)).equals(totalAmount)) {
        throw new PostingError("For an INR marketplace sale the marketplace amount is the sale total.");
      }
    } else {
      if (fcRaw === null || fcRaw === undefined || String(fcRaw).trim() === "" || !new Decimal(String(fcRaw)).greaterThan(0)) {
        throw new PostingError(`Enter the sale amount in ${clearingCurrency} as the marketplace shows it.`);
      }
      clearingFc = new Decimal(String(fcRaw)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    }
  } else if (input.clearing && (input.clearing.currencyCode || "INR").toUpperCase() !== "INR") {
    throw new PostingError("Only a marketplace / clearing party's sale records a foreign-currency amount.");
  }
  const receivableCode = isClearing ? SYSTEM_ACCOUNT_CODES.MARKETPLACE_CLEARING : SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE;
  const header =
    isClearing && clearingCurrency !== "INR"
      ? { ...input, currencyCode: clearingCurrency, exchangeRate: totalAmount.dividedBy(clearingFc).toDecimalPlaces(4, Decimal.ROUND_HALF_UP) }
      : input;

  const voucher = await createVoucherHeader(tx, header, "SALE", {
    amount: totalAmount,
    partyId: input.partyId,
    paymentAccountId: input.paymentAccountId,
    gstTreatment: input.gstTreatment,
  });

  await insertInvoiceLines(tx, voucher.id, computed);

  const { cgst, sgst, igst } = splitGstAmount(totalTax, input.gstTreatment);

  const lines: JournalLineInput[] = [
    {
      accountCode: receivableCode,
      partyId: input.partyId,
      debit: totalAmount,
      description: isClearing ? `Sale (marketplace clearing, ${clearingCurrency} ${clearingFc.toFixed(2)})` : "Sale",
    },
    { accountCode: SYSTEM_ACCOUNT_CODES.SALES_INCOME, credit: totalTaxable, description: "Sale" },
    { accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_CGST, credit: cgst, description: "Output CGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_SGST, credit: sgst, description: "Output SGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_IGST, credit: igst, description: "Output IGST" },
  ];

  if (input.paymentAccountId) {
    const paymentAccount = await tx.paymentAccount.findUnique({
      where: { id: input.paymentAccountId },
      select: { account: { select: { code: true } } },
    });
    if (!paymentAccount) throw new PostingError("Payment account not found.");
    lines.push(
      {
        accountCode: paymentAccount.account.code,
        debit: totalAmount,
        description: "Sale settled immediately",
      },
      {
        accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
        partyId: input.partyId,
        credit: totalAmount,
        description: "Sale settled immediately",
      }
    );
  }

  if (input.additionalLines) {
    lines.push(...input.additionalLines);
  }

  await insertBalancedJournalLines(tx, voucher.id, lines);
  if (isClearing) {
    await recordClearingEntry(tx, { partyId: input.partyId, currencyCode: clearingCurrency, kind: "SALE", fc: clearingFc, inr: totalAmount, voucherId: voucher.id });
  }
  return voucher;
}

// ---------------------------------------------------------------------------
// Payment Given / Payment Received / Expense
// ---------------------------------------------------------------------------

export async function postPaymentGiven(
  tx: Tx,
  input: CommonVoucherInput & {
    partyId: string;
    paymentAccountId: string;
    amount: DecimalInput;
  }
) {
  const amount = round2(input.amount);
  if (!amount.greaterThan(0)) throw new PostingError("Amount must be greater than zero.");

  await assertPaymentParty(tx, input.partyId);
  const paymentAccountCode = await resolvePaymentAccountCode(tx, input.paymentAccountId);

  const voucher = await createVoucherHeader(tx, input, "PAYMENT_GIVEN", {
    amount,
    partyId: input.partyId,
    paymentAccountId: input.paymentAccountId,
  });

  // Dr the party's payable (Supplier/Karigar/Manufacturer/Broker payable all
  // live on Accounts Payable by partyId) / Cr the chosen Cash/Bank account.
  // Never an expense or inventory line: that was posted by the bill itself.
  await insertBalancedJournalLines(tx, voucher.id, [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: input.partyId,
      debit: amount,
      description: "Payment given",
    },
    { accountCode: paymentAccountCode, credit: amount, description: "Payment given" },
  ]);

  return voucher;
}

export async function postPaymentReceived(
  tx: Tx,
  input: CommonVoucherInput & {
    partyId: string;
    paymentAccountId: string;
    amount: DecimalInput;
  }
) {
  const amount = round2(input.amount);
  if (!amount.greaterThan(0)) throw new PostingError("Amount must be greater than zero.");

  await assertPaymentParty(tx, input.partyId);
  const paymentAccountCode = await resolvePaymentAccountCode(tx, input.paymentAccountId);

  const voucher = await createVoucherHeader(tx, input, "PAYMENT_RECEIVED", {
    amount,
    partyId: input.partyId,
    paymentAccountId: input.paymentAccountId,
  });

  // Dr the chosen Cash/Bank account / Cr the party's receivable. Never a
  // sales or income line: the sale or bill already recognised the revenue.
  await insertBalancedJournalLines(tx, voucher.id, [
    { accountCode: paymentAccountCode, debit: amount, description: "Payment received" },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
      partyId: input.partyId,
      credit: amount,
      description: "Payment received",
    },
  ]);

  return voucher;
}

/**
 * Phase 6: refunds a customer CASH/BANK for a credit they're owed (e.g.
 * after a sales return) — the mirror-image of postPaymentReceived, not a
 * reuse of postPaymentGiven (which targets ACCOUNTS_PAYABLE and is for
 * paying a Supplier/Karigar, a completely different relationship). A
 * customer's own credit balance already displays as a negative net across
 * the same AR/AP grouping getPartyBalances uses (positive = they owe us,
 * negative = we owe them) — crediting Accounts Receivable on a return is
 * what makes that happen; this function is the corresponding cash-out
 * leg: Dr Accounts Receivable (bringing the party's balance back toward
 * zero from negative) / Cr the payment account (cash/bank leaving).
 *
 * The caller is responsible for checking the refund amount does not
 * exceed the party's actual available credit — see
 * getPartyBalances/getPartyLedger — since "how much credit is available"
 * depends on the party's FULL AR/AP history, not anything this narrow
 * posting function alone can safely determine.
 */
export async function postCustomerRefund(
  tx: Tx,
  input: CommonVoucherInput & {
    partyId: string;
    paymentAccountId: string;
    amount: DecimalInput;
  }
) {
  const amount = round2(input.amount);
  if (!amount.greaterThan(0)) throw new PostingError("Amount must be greater than zero.");

  const paymentAccountCode = await resolvePaymentAccountCode(tx, input.paymentAccountId);

  const voucher = await createVoucherHeader(tx, input, "CUSTOMER_REFUND", {
    amount,
    partyId: input.partyId,
    paymentAccountId: input.paymentAccountId,
  });

  await insertBalancedJournalLines(tx, voucher.id, [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
      partyId: input.partyId,
      debit: amount,
      description: "Customer refund",
    },
    { accountCode: paymentAccountCode, credit: amount, description: "Customer refund" },
  ]);

  return voucher;
}

export async function postExpense(
  tx: Tx,
  input: CommonVoucherInput & {
    partyId?: string | null;
    paymentAccountId: string;
    amount: DecimalInput;
  }
) {
  const amount = round2(input.amount);
  if (!amount.greaterThan(0)) throw new PostingError("Amount must be greater than zero.");

  const paymentAccount = await tx.paymentAccount.findUnique({
    where: { id: input.paymentAccountId },
    select: { account: { select: { code: true } } },
  });
  if (!paymentAccount) throw new PostingError("Payment account not found.");

  const voucher = await createVoucherHeader(tx, input, "EXPENSE", {
    amount,
    partyId: input.partyId ?? null,
    paymentAccountId: input.paymentAccountId,
  });

  await insertBalancedJournalLines(tx, voucher.id, [
    { accountCode: SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, debit: amount, description: "Expense" },
    { accountCode: paymentAccount.account.code, credit: amount, description: "Expense" },
  ]);

  return voucher;
}

// ---------------------------------------------------------------------------
// Cancellation / reversal
// ---------------------------------------------------------------------------

export async function cancelVoucher(
  tx: Tx,
  input: {
    voucherId: string;
    cancelledByUserId: string;
    cancellationReason: string;
    fyStartMonth: number;
    fyStartDay: number;
  }
) {
  const original = await tx.voucher.findUnique({
    where: { id: input.voucherId },
    include: { journalEntries: true },
  });
  if (!original) throw new PostingError("Voucher not found.");
  if (original.status === "CANCELLED") {
    throw new PostingError("This voucher has already been cancelled.");
  }
  if (original.voucherType === "REVERSAL") {
    throw new PostingError("A reversal voucher cannot itself be cancelled.");
  }
  if (original.journalEntries.length === 0) {
    throw new PostingError("Original voucher has no journal entries to reverse.");
  }
  const clearing = await clearingAccountIds(tx);
  // A sale with a live reclassification (its Cash/Bank receipt moved to
  // clearing) or gross-up (revenue added on top of it) cannot be reversed on
  // its own: that would take the receipt out of Cash/Bank twice, or leave the
  // gross-up revenue without its sale.
  if (original.voucherType === "SALE" && clearing.available) {
    const linked = await tx.clearingDocument.findFirst({
      where: { sourceVoucherId: original.id, status: "POSTED" },
      orderBy: { sequence: "desc" },
      include: { voucher: { select: { voucherNumber: true } } },
    });
    if (linked) {
      const what = linked.kind === "GROSS_UP" ? "gross-up" : "reclassification";
      throw new PostingError(`Reverse the ${what} ${linked.voucher.voucherNumber} (Accounting → Settlements) before cancelling this sale.`);
    }
  }

  const now = new Date();
  // Claim the cancellation first, only while the voucher is still POSTED. A
  // second, simultaneous cancel blocks on this row and then finds nothing to
  // claim, so a voucher is reversed exactly once (the unique
  // reversalOfVoucherId below is the backstop).
  try {
    await tx.voucher.update({
      where: { id: original.id, status: "POSTED" },
      data: {
        status: "CANCELLED",
        cancelledAt: now,
        cancelledByUserId: input.cancelledByUserId,
        cancellationReason: input.cancellationReason,
      },
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "P2025") {
      throw new PostingError("This voucher has already been cancelled.");
    }
    throw error;
  }

  // A reversal is dated with the Indian calendar date it was posted on (a pure
  // date, like every other voucher), never before the voucher it reverses.
  const today = indiaBusinessDate(now);
  const reversalDate = original.date && new Date(original.date).getTime() > today.getTime() ? new Date(original.date) : today;
  const financialYearLabel = getFinancialYearLabel(reversalDate, input.fyStartMonth, input.fyStartDay);
  const voucherNumber = await nextVoucherNumber(tx, "REVERSAL", financialYearLabel);

  const reversal = await tx.voucher.create({
    data: {
      voucherNumber,
      voucherType: "REVERSAL",
      date: reversalDate,
      financialYearLabel,
      partyId: original.partyId,
      paymentAccountId: original.paymentAccountId,
      amount: original.amount,
      currencyCode: original.currencyCode,
      exchangeRate: original.exchangeRate,
      note: `Reversal of ${original.voucherNumber}`,
      reversalOfVoucherId: original.id,
      createdByUserId: input.cancelledByUserId,
    },
  });

  await tx.journalEntry.createMany({
    data: original.journalEntries.map((entry) => ({
      voucherId: reversal.id,
      accountId: entry.accountId,
      partyId: entry.partyId,
      debit: entry.credit,
      credit: entry.debit,
      description: `Reversal: ${entry.description ?? ""}`.trim(),
    })),
  });

  // A voucher that moved marketplace clearing (1150 / 1160) also moved the
  // clearing sub-ledger: mirror those entries too, once, so it stays equal to
  // the ledger.
  if (original.journalEntries.some((e) => e.accountId === clearing.available || e.accountId === clearing.reserve)) {
    await mirrorClearingEntries(tx, original.id, reversal.id);
  }

  return reversal;
}
