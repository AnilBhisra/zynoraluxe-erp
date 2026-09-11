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
import { getFinancialYearLabel } from "@/lib/accounting/financialYear";
import { computeInvoiceLineTotals, splitGstAmount } from "@/lib/accounting/gst";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import { nextVoucherNumber } from "@/lib/accounting/numbering";

export class PostingError extends Error {}

type Tx = Prisma.TransactionClient;

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

function computeLineTotalsForAll(lines: InvoiceLineInput[]) {
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

export async function postSale(tx: Tx, input: InvoiceVoucherInput) {
  if (input.lines.length === 0) {
    throw new PostingError("A sale must have at least one item line.");
  }
  const { computed, totalTaxable, totalTax, totalAmount } = computeLineTotalsForAll(
    input.lines
  );
  if (!totalAmount.greaterThan(0)) {
    throw new PostingError("Sale total must be greater than zero.");
  }

  const voucher = await createVoucherHeader(tx, input, "SALE", {
    amount: totalAmount,
    partyId: input.partyId,
    paymentAccountId: input.paymentAccountId,
    gstTreatment: input.gstTreatment,
  });

  await insertInvoiceLines(tx, voucher.id, computed);

  const { cgst, sgst, igst } = splitGstAmount(totalTax, input.gstTreatment);

  const lines: JournalLineInput[] = [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
      partyId: input.partyId,
      debit: totalAmount,
      description: "Sale",
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

  await insertBalancedJournalLines(tx, voucher.id, lines);
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

  const paymentAccount = await tx.paymentAccount.findUnique({
    where: { id: input.paymentAccountId },
    select: { account: { select: { code: true } } },
  });
  if (!paymentAccount) throw new PostingError("Payment account not found.");

  const voucher = await createVoucherHeader(tx, input, "PAYMENT_GIVEN", {
    amount,
    partyId: input.partyId,
    paymentAccountId: input.paymentAccountId,
  });

  await insertBalancedJournalLines(tx, voucher.id, [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: input.partyId,
      debit: amount,
      description: "Payment given",
    },
    { accountCode: paymentAccount.account.code, credit: amount, description: "Payment given" },
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

  const paymentAccount = await tx.paymentAccount.findUnique({
    where: { id: input.paymentAccountId },
    select: { account: { select: { code: true } } },
  });
  if (!paymentAccount) throw new PostingError("Payment account not found.");

  const voucher = await createVoucherHeader(tx, input, "PAYMENT_RECEIVED", {
    amount,
    partyId: input.partyId,
    paymentAccountId: input.paymentAccountId,
  });

  await insertBalancedJournalLines(tx, voucher.id, [
    { accountCode: paymentAccount.account.code, debit: amount, description: "Payment received" },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
      partyId: input.partyId,
      credit: amount,
      description: "Payment received",
    },
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

  const now = new Date();
  const financialYearLabel = getFinancialYearLabel(now, input.fyStartMonth, input.fyStartDay);
  const voucherNumber = await nextVoucherNumber(tx, "REVERSAL", financialYearLabel);

  const reversal = await tx.voucher.create({
    data: {
      voucherNumber,
      voucherType: "REVERSAL",
      date: now,
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

  if (original.journalEntries.length === 0) {
    throw new PostingError("Original voucher has no journal entries to reverse.");
  }

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

  await tx.voucher.update({
    where: { id: original.id },
    data: {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledByUserId: input.cancelledByUserId,
      cancellationReason: input.cancellationReason,
    },
  });

  return reversal;
}
