import "server-only";

import { prisma } from "@/lib/db/prisma";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import type { PartyType, VoucherStatus, VoucherType } from "@/generated/prisma/enums";

async function accountIdsByCode(codes: string[]): Promise<Map<string, string>> {
  const accounts = await prisma.account.findMany({ where: { code: { in: codes } } });
  return new Map(accounts.map((a) => [a.code, a.id]));
}

/**
 * Every balance below is derived by summing JournalEntry rows — never a
 * manually-edited column. A cancelled voucher needs no special-case
 * filtering here: its reversal posted equal-and-opposite entries, so the
 * sum already nets back to zero on its own.
 */
async function sumDebitCredit(where: Parameters<typeof prisma.journalEntry.aggregate>[0]["where"]) {
  const agg = await prisma.journalEntry.aggregate({ where, _sum: { debit: true, credit: true } });
  const debit = new Decimal(agg._sum.debit ?? 0);
  const credit = new Decimal(agg._sum.credit ?? 0);
  return { debit, credit, net: debit.minus(credit) };
}

export async function getAccountBalance(accountCode: string): Promise<Decimal> {
  const ids = await accountIdsByCode([accountCode]);
  const accountId = ids.get(accountCode);
  if (!accountId) return ZERO;
  const { net } = await sumDebitCredit({ accountId });
  return round2(net);
}

export type CashBankSummary = { cash: Decimal; bank: Decimal };

/** "Bank balance" on the Dashboard folds BANK + UPI + OTHER payment
 * accounts together — the master plan's Dashboard only has two cards
 * (Cash, Bank), and UPI settles into a bank account in real life. */
export async function getCashBankSummary(): Promise<CashBankSummary> {
  const paymentAccounts = await prisma.paymentAccount.findMany({
    where: { isActive: true },
    include: { account: true },
  });

  let cash = ZERO;
  let bank = ZERO;
  for (const pa of paymentAccounts) {
    const { net } = await sumDebitCredit({ accountId: pa.accountId });
    if (pa.method === "CASH") cash = cash.plus(net);
    else bank = bank.plus(net);
  }
  return { cash: round2(cash), bank: round2(bank) };
}

export type ReceivablePayableSummary = { receivable: Decimal; payable: Decimal };

export async function getReceivablePayableSummary(): Promise<ReceivablePayableSummary> {
  const ids = await accountIdsByCode([
    SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
    SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
  ]);
  const accountIds = [...ids.values()];
  if (accountIds.length === 0) return { receivable: ZERO, payable: ZERO };

  const grouped = await prisma.journalEntry.groupBy({
    by: ["partyId"],
    where: { accountId: { in: accountIds }, partyId: { not: null } },
    _sum: { debit: true, credit: true },
  });

  let receivable = ZERO;
  let payable = ZERO;
  for (const row of grouped) {
    const net = new Decimal(row._sum.debit ?? 0).minus(row._sum.credit ?? 0);
    if (net.greaterThan(0)) receivable = receivable.plus(net);
    else if (net.lessThan(0)) payable = payable.plus(net.abs());
  }
  return { receivable: round2(receivable), payable: round2(payable) };
}

export type PartyBalanceRow = {
  partyId: string;
  name: string;
  type: PartyType;
  isActive: boolean;
  /** Positive = party owes us (receivable). Negative = we owe party (payable). */
  balance: Decimal;
};

/** One row per active-or-not party with its net AR/AP balance — used by the
 * Parties tab and the Receivable/Payable reports. */
export async function getPartyBalances(options?: {
  type?: PartyType;
  search?: string;
  includeInactive?: boolean;
}): Promise<PartyBalanceRow[]> {
  const ids = await accountIdsByCode([
    SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
    SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
  ]);
  const accountIds = [...ids.values()];

  const parties = await prisma.party.findMany({
    where: {
      type: options?.type,
      isActive: options?.includeInactive ? undefined : true,
      name: options?.search
        ? { contains: options.search, mode: "insensitive" }
        : undefined,
    },
    orderBy: { name: "asc" },
  });

  const grouped =
    accountIds.length > 0
      ? await prisma.journalEntry.groupBy({
          by: ["partyId"],
          where: { accountId: { in: accountIds }, partyId: { in: parties.map((p) => p.id) } },
          _sum: { debit: true, credit: true },
        })
      : [];
  const balanceByParty = new Map(
    grouped.map((row) => [
      row.partyId as string,
      round2(new Decimal(row._sum.debit ?? 0).minus(row._sum.credit ?? 0)),
    ])
  );

  return parties.map((party) => ({
    partyId: party.id,
    name: party.name,
    type: party.type,
    isActive: party.isActive,
    balance: balanceByParty.get(party.id) ?? ZERO,
  }));
}

export type PartyLedgerRow = {
  id: string;
  date: Date;
  voucherId: string;
  voucherNumber: string;
  voucherType: VoucherType;
  description: string;
  debit: Decimal;
  credit: Decimal;
  runningBalance: Decimal;
};

export async function getPartyLedger(
  partyId: string,
  filters?: { dateFrom?: Date; dateTo?: Date }
): Promise<PartyLedgerRow[]> {
  const ids = await accountIdsByCode([
    SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
    SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
  ]);
  const accountIds = [...ids.values()];

  const entries = await prisma.journalEntry.findMany({
    where: {
      partyId,
      accountId: { in: accountIds },
      voucher: {
        date: {
          gte: filters?.dateFrom,
          lte: filters?.dateTo,
        },
      },
    },
    include: { voucher: true },
    orderBy: [{ voucher: { date: "asc" } }, { createdAt: "asc" }],
  });

  let running = ZERO;
  return entries.map((entry) => {
    const debit = new Decimal(entry.debit);
    const credit = new Decimal(entry.credit);
    running = running.plus(debit).minus(credit);
    return {
      id: entry.id,
      date: entry.voucher.date,
      voucherId: entry.voucher.id,
      voucherNumber: entry.voucher.voucherNumber,
      voucherType: entry.voucher.voucherType,
      description: entry.description ?? entry.voucher.voucherType,
      debit: round2(debit),
      credit: round2(credit),
      runningBalance: round2(running),
    };
  });
}

export type VoucherListRow = {
  id: string;
  voucherNumber: string;
  voucherType: VoucherType;
  date: Date;
  partyName: string | null;
  amount: Decimal;
  status: VoucherStatus;
  paymentAccountName: string | null;
  referenceNumber: string | null;
};

export async function listVouchers(filters: {
  types?: VoucherType[];
  status?: VoucherStatus;
  partyId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
  take?: number;
}): Promise<VoucherListRow[]> {
  const vouchers = await prisma.voucher.findMany({
    where: {
      voucherType: filters.types ? { in: filters.types } : undefined,
      status: filters.status,
      partyId: filters.partyId,
      date: { gte: filters.dateFrom, lte: filters.dateTo },
      OR: filters.search
        ? [
            { voucherNumber: { contains: filters.search, mode: "insensitive" } },
            { referenceNumber: { contains: filters.search, mode: "insensitive" } },
            { party: { name: { contains: filters.search, mode: "insensitive" } } },
          ]
        : undefined,
    },
    include: { party: true, paymentAccount: true },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: filters.take ?? 200,
  });

  return vouchers.map((v) => ({
    id: v.id,
    voucherNumber: v.voucherNumber,
    voucherType: v.voucherType,
    date: v.date,
    partyName: v.party?.name ?? null,
    amount: round2(new Decimal(v.amount)),
    status: v.status,
    paymentAccountName: v.paymentAccount?.name ?? null,
    referenceNumber: v.referenceNumber,
  }));
}

export type GstSummary = {
  inputCgst: Decimal;
  inputSgst: Decimal;
  inputIgst: Decimal;
  outputCgst: Decimal;
  outputSgst: Decimal;
  outputIgst: Decimal;
  netPayable: Decimal;
};

export async function getGstSummary(filters?: {
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<GstSummary> {
  const codes = [
    SYSTEM_ACCOUNT_CODES.INPUT_CGST,
    SYSTEM_ACCOUNT_CODES.INPUT_SGST,
    SYSTEM_ACCOUNT_CODES.INPUT_IGST,
    SYSTEM_ACCOUNT_CODES.OUTPUT_CGST,
    SYSTEM_ACCOUNT_CODES.OUTPUT_SGST,
    SYSTEM_ACCOUNT_CODES.OUTPUT_IGST,
  ];
  const ids = await accountIdsByCode(codes);

  const balances = new Map<string, Decimal>();
  for (const code of codes) {
    const accountId = ids.get(code);
    if (!accountId) {
      balances.set(code, ZERO);
      continue;
    }
    const { net } = await sumDebitCredit({
      accountId,
      voucher: { date: { gte: filters?.dateFrom, lte: filters?.dateTo } },
    });
    balances.set(code, net);
  }

  const inputCgst = round2(balances.get(SYSTEM_ACCOUNT_CODES.INPUT_CGST) ?? ZERO);
  const inputSgst = round2(balances.get(SYSTEM_ACCOUNT_CODES.INPUT_SGST) ?? ZERO);
  const inputIgst = round2(balances.get(SYSTEM_ACCOUNT_CODES.INPUT_IGST) ?? ZERO);
  // Output tax accounts are liabilities (credit-normal); flip sign so a
  // "normal" period (more sales than purchases) shows a positive payable.
  const outputCgst = round2((balances.get(SYSTEM_ACCOUNT_CODES.OUTPUT_CGST) ?? ZERO).negated());
  const outputSgst = round2((balances.get(SYSTEM_ACCOUNT_CODES.OUTPUT_SGST) ?? ZERO).negated());
  const outputIgst = round2((balances.get(SYSTEM_ACCOUNT_CODES.OUTPUT_IGST) ?? ZERO).negated());

  const netPayable = round2(
    outputCgst.plus(outputSgst).plus(outputIgst).minus(inputCgst).minus(inputSgst).minus(inputIgst)
  );

  return { inputCgst, inputSgst, inputIgst, outputCgst, outputSgst, outputIgst, netPayable };
}

export type ProfitAndLoss = {
  salesIncome: Decimal;
  purchases: Decimal;
  businessExpenses: Decimal;
  /** salesIncome - purchases - businessExpenses. Provisional: no inventory
   * valuation / cost-of-goods-sold exists until stock is wired in a later
   * phase, so this is NOT a final business profit figure. */
  provisionalProfit: Decimal;
};

export async function getProfitAndLoss(filters?: {
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<ProfitAndLoss> {
  const ids = await accountIdsByCode([
    SYSTEM_ACCOUNT_CODES.SALES_INCOME,
    SYSTEM_ACCOUNT_CODES.PURCHASES,
    SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES,
  ]);

  async function netFor(code: string) {
    const accountId = ids.get(code);
    if (!accountId) return ZERO;
    const { net } = await sumDebitCredit({
      accountId,
      voucher: { date: { gte: filters?.dateFrom, lte: filters?.dateTo } },
    });
    return net;
  }

  // Income accounts are credit-normal; flip sign to a positive figure.
  const salesIncome = round2((await netFor(SYSTEM_ACCOUNT_CODES.SALES_INCOME)).negated());
  const purchases = round2(await netFor(SYSTEM_ACCOUNT_CODES.PURCHASES));
  const businessExpenses = round2(await netFor(SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES));

  const provisionalProfit = round2(salesIncome.minus(purchases).minus(businessExpenses));

  return { salesIncome, purchases, businessExpenses, provisionalProfit };
}
