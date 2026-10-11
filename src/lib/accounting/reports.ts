import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { voucherVisibilityWhere } from "@/lib/accounting/voucherVisibility";
import type { PartyType, PaymentMethod, UserRole, VoucherStatus, VoucherType } from "@/generated/prisma/enums";

type Db = Prisma.TransactionClient;

async function accountIdsByCode(codes: string[], db: Db = prisma): Promise<Map<string, string>> {
  const accounts = await db.account.findMany({ where: { code: { in: codes } } });
  return new Map(accounts.map((a) => [a.code, a.id]));
}

/**
 * THE party balance: Debit − Credit of the party's journal lines on Accounts
 * Receivable and Accounts Payable together (positive = they owe us, negative =
 * we owe them). Every screen that shows what a party owes reads it through
 * here; classifyPartyBalance() then labels it (receivable, payable, advance
 * paid, customer credit). One grouped query, whatever the number of parties.
 * `partyIds` omitted = every party that has a line.
 */
export async function partyNetBalances(partyIds?: string[], db: Db = prisma): Promise<Map<string, Decimal>> {
  if (partyIds && partyIds.length === 0) return new Map();
  const ids = await accountIdsByCode([SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE], db);
  const accountIds = [...ids.values()];
  if (accountIds.length === 0) return new Map();
  const grouped = await db.journalEntry.groupBy({
    by: ["partyId"],
    where: { accountId: { in: accountIds }, partyId: partyIds ? { in: partyIds } : { not: null } },
    _sum: { debit: true, credit: true },
  });
  return new Map(
    grouped.map((row) => [row.partyId as string, round2(new Decimal(row._sum.debit ?? 0).minus(row._sum.credit ?? 0))])
  );
}

export async function getPartyNetBalance(partyId: string, db: Db = prisma): Promise<Decimal> {
  return (await partyNetBalances([partyId], db)).get(partyId) ?? ZERO;
}

export type PaymentAccountBalanceRow = {
  id: string;
  name: string;
  method: PaymentMethod;
  isActive: boolean;
  /** Debit − Credit of the payment account's own ledger account. */
  balance: Decimal;
};

/** Every payment account (archived ones too — their money is still real) with its ledger balance, in one grouped query. */
export async function getPaymentAccountBalances(): Promise<PaymentAccountBalanceRow[]> {
  const paymentAccounts = await prisma.paymentAccount.findMany({ orderBy: { name: "asc" } });
  const grouped = paymentAccounts.length
    ? await prisma.journalEntry.groupBy({
        by: ["accountId"],
        where: { accountId: { in: paymentAccounts.map((pa) => pa.accountId) } },
        _sum: { debit: true, credit: true },
      })
    : [];
  const net = new Map(grouped.map((g) => [g.accountId, new Decimal(g._sum.debit ?? 0).minus(g._sum.credit ?? 0)]));
  return paymentAccounts.map((pa) => ({
    id: pa.id,
    name: pa.name,
    method: pa.method,
    isActive: pa.isActive,
    balance: round2(net.get(pa.accountId) ?? ZERO),
  }));
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
 * (Cash, Bank), and UPI settles into a bank account in real life. An
 * archived payment account still counts while it holds money, so the cards
 * always equal the sum of the payment accounts' own ledgers. */
export async function getCashBankSummary(): Promise<CashBankSummary> {
  let cash = ZERO;
  let bank = ZERO;
  for (const pa of await getPaymentAccountBalances()) {
    if (pa.method === "CASH") cash = cash.plus(pa.balance);
    else bank = bank.plus(pa.balance);
  }
  return { cash: round2(cash), bank: round2(bank) };
}

/**
 * Each party's two control-account sides, kept apart (one grouped query, no
 * Party table): receivable = Dr − Cr on 1100, payable = Cr − Dr on 2000.
 */
export async function partySideBalances(db: Db = prisma): Promise<Map<string, { receivable: Decimal; payable: Decimal }>> {
  const ids = await accountIdsByCode([SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE], db);
  const ar = ids.get(SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE);
  const ap = ids.get(SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE);
  const accountIds = [ar, ap].filter((x): x is string => !!x);
  const out = new Map<string, { receivable: Decimal; payable: Decimal }>();
  if (accountIds.length === 0) return out;
  const grouped = await db.journalEntry.groupBy({
    by: ["partyId", "accountId"],
    where: { accountId: { in: accountIds }, partyId: { not: null } },
    _sum: { debit: true, credit: true },
  });
  for (const row of grouped) {
    const partyId = row.partyId as string;
    const sides = out.get(partyId) ?? { receivable: ZERO, payable: ZERO };
    const net = new Decimal(row._sum.debit ?? 0).minus(row._sum.credit ?? 0);
    if (row.accountId === ar) sides.receivable = round2(sides.receivable.plus(net));
    else sides.payable = round2(sides.payable.minus(net));
    out.set(partyId, sides);
  }
  return out;
}

/**
 * Dashboard / Receivable & Payable totals — the two control accounts kept
 * apart per party (see src/lib/accounting/receivablePayable.ts):
 *   receivable     = Σ positive 1100 sides      customerCredit = Σ negative 1100 sides
 *   payable        = Σ positive 2000 sides      advancesPaid   = Σ negative 2000 sides
 * so receivable − customerCredit = the 1100 balance and payable − advancesPaid
 * = −(the 2000 balance), exactly. A party's type never changes any figure.
 */
export type ReceivablePayableSummary = {
  receivable: Decimal;
  payable: Decimal;
  /** Paid to a Supplier/Karigar/other beyond what they billed (Dr balance on 2000). */
  advancesPaid: Decimal;
  /** Received beyond what was billed (Cr balance on 1100). */
  customerCredit: Decimal;
};

export async function getReceivablePayableSummary(db: Db = prisma): Promise<ReceivablePayableSummary> {
  let receivable = ZERO;
  let payable = ZERO;
  let advancesPaid = ZERO;
  let customerCredit = ZERO;
  for (const side of (await partySideBalances(db)).values()) {
    if (side.receivable.greaterThan(0)) receivable = receivable.plus(side.receivable);
    else if (side.receivable.lessThan(0)) customerCredit = customerCredit.plus(side.receivable.abs());
    if (side.payable.greaterThan(0)) payable = payable.plus(side.payable);
    else if (side.payable.lessThan(0)) advancesPaid = advancesPaid.plus(side.payable.abs());
  }
  return { receivable: round2(receivable), payable: round2(payable), advancesPaid: round2(advancesPaid), customerCredit: round2(customerCredit) };
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

  const balanceByParty = await partyNetBalances(parties.map((p) => p.id));

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
    orderBy: [{ voucher: { date: "asc" } }, { voucher: { createdAt: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
  });

  // A ledger that starts at dateFrom carries forward everything posted before
  // it, so its running balance always ends at the party's real balance.
  let running = filters?.dateFrom
    ? (
        await sumDebitCredit({ partyId, accountId: { in: accountIds }, voucher: { date: { lt: filters.dateFrom } } })
      ).net
    : ZERO;
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
  /** Required: Staff never load internal costing vouchers (see voucherVisibility.ts). */
  viewerRole: UserRole;
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
      AND: [
        voucherVisibilityWhere(filters.viewerRole),
        filters.search
          ? {
              OR: [
                { voucherNumber: { contains: filters.search, mode: "insensitive" } },
                { referenceNumber: { contains: filters.search, mode: "insensitive" } },
                { party: { name: { contains: filters.search, mode: "insensitive" } } },
              ],
            }
          : {},
      ],
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

/**
 * "Other / Accounting-only" Sale vouchers — a plain SALE voucher with no
 * linked FinishedJewellerySale, i.e. no stock-matched COGS at all. Owner
 * visibility only, same as the rest of this file's margin-adjacent data.
 */
export async function listManualSalesWithoutLinkedCogs(filters?: {
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<VoucherListRow[]> {
  const vouchers = await prisma.voucher.findMany({
    where: {
      voucherType: "SALE",
      status: "POSTED",
      date: { gte: filters?.dateFrom, lte: filters?.dateTo },
      finishedJewellerySale: { is: null },
    },
    include: { party: true, paymentAccount: true },
    orderBy: [{ date: "desc" }, { createdAt: "desc" }],
    take: 200,
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
  /** Every EXPENSE-type account that has no dedicated line above or below
   * (Purchases, Business Expenses, Finished Jewellery COGS and Damaged
   * Jewellery Loss have their own), by account — e.g. Phase 7's 5400
   * Brokerage & Commission. Only accounts with a non-zero net are listed. */
  otherExpenses: { code: string; name: string; amount: Decimal }[];
  /** Sum of otherExpenses. */
  otherExpensesTotal: Decimal;
  /** salesIncome - purchases - businessExpenses - otherExpensesTotal. Provisional: rough/metal
   * purchases posted through the generic Purchases account (non-inventory
   * misc procurement only — Metal/Rough purchases post to their own
   * inventory asset accounts, never here) have no matched cost-of-goods
   * mechanism, so this line is NOT a final whole-business profit figure. */
  provisionalProfit: Decimal;

  // ---- Phase 6: Finished Jewellery actual Gross Profit — Owner-only,
  // matched revenue-to-cost at the individual sold piece, NOT provisional.
  // See PHASE_6_VERIFICATION.md §10. ----
  grossSales: Decimal;
  salesReturns: Decimal;
  netSales: Decimal;
  finishedJewelleryCogs: Decimal;
  grossProfit: Decimal;
  grossMarginPercent: Decimal;
  damagedJewelleryLoss: Decimal;
  /** grossProfit - damagedJewelleryLoss - purchases - businessExpenses - otherExpensesTotal.
   * Every EXPENSE-type account therefore reduces it exactly once. */
  netProfit: Decimal;
  /** Portion of grossSales that came from Sale vouchers with NO linked
   * FinishedJewellerySale (i.e. "Other / Accounting-only Sale") — these
   * carry no stock-matched COGS at all, so a whole-business gross-margin
   * read is incomplete whenever this is non-zero. */
  manualSalesAmount: Decimal;
  manualSalesCount: number;
};

export async function getProfitAndLoss(filters?: {
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<ProfitAndLoss> {
  const ids = await accountIdsByCode([
    SYSTEM_ACCOUNT_CODES.SALES_INCOME,
    SYSTEM_ACCOUNT_CODES.PURCHASES,
    SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES,
    SYSTEM_ACCOUNT_CODES.SALES_RETURNS,
    SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS,
    SYSTEM_ACCOUNT_CODES.DAMAGED_JEWELLERY_LOSS,
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

  // Classification, not a fixed list: an expense account without its own line
  // (5400 Brokerage & Commission, 8000 Round Off, anything added later) still
  // reduces profit. Accounts created at runtime are payment accounts (ASSET),
  // so this never picks up a non-expense account.
  const DEDICATED_EXPENSE_CODES = new Set<string>([
    SYSTEM_ACCOUNT_CODES.PURCHASES,
    SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES,
    SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS,
    SYSTEM_ACCOUNT_CODES.DAMAGED_JEWELLERY_LOSS,
  ]);
  const expenseAccounts = await prisma.account.findMany({
    where: { type: "EXPENSE" },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  const otherExpenses: ProfitAndLoss["otherExpenses"] = [];
  for (const account of expenseAccounts) {
    if (DEDICATED_EXPENSE_CODES.has(account.code)) continue;
    const { net } = await sumDebitCredit({
      accountId: account.id,
      voucher: { date: { gte: filters?.dateFrom, lte: filters?.dateTo } },
    });
    const amount = round2(net);
    if (!amount.isZero()) otherExpenses.push({ code: account.code, name: account.name, amount });
  }
  const otherExpensesTotal = round2(otherExpenses.reduce((sum, e) => sum.plus(e.amount), ZERO));

  const provisionalProfit = round2(salesIncome.minus(purchases).minus(businessExpenses).minus(otherExpensesTotal));

  // Sales Returns and the two new expense accounts are all debit-normal in
  // how they're actually posted here (Dr on return/loss) — read as-is, no
  // sign flip, same convention purchases/businessExpenses already use.
  const grossSales = salesIncome;
  const salesReturns = round2(await netFor(SYSTEM_ACCOUNT_CODES.SALES_RETURNS));
  const netSales = round2(grossSales.minus(salesReturns));
  const finishedJewelleryCogs = round2(await netFor(SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS));
  const grossProfit = round2(netSales.minus(finishedJewelleryCogs));
  const grossMarginPercent = netSales.greaterThan(0)
    ? grossProfit.dividedBy(netSales).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : ZERO;
  const damagedJewelleryLoss = round2(await netFor(SYSTEM_ACCOUNT_CODES.DAMAGED_JEWELLERY_LOSS));
  const netProfit = round2(
    grossProfit.minus(damagedJewelleryLoss).minus(purchases).minus(businessExpenses).minus(otherExpensesTotal)
  );

  const linkedSaleAgg = await prisma.finishedJewellerySale.aggregate({
    where: {
      status: "POSTED",
      saleDate: { gte: filters?.dateFrom, lte: filters?.dateTo },
    },
    _sum: { taxableTotal: true },
  });
  const linkedSalesAmount = round2(new Decimal(linkedSaleAgg._sum.taxableTotal ?? 0));
  const manualSalesAmount = round2(Decimal.max(grossSales.minus(linkedSalesAmount), ZERO));
  const manualSalesCount = await prisma.voucher.count({
    where: {
      voucherType: "SALE",
      status: "POSTED",
      date: { gte: filters?.dateFrom, lte: filters?.dateTo },
      finishedJewellerySale: { is: null },
    },
  });

  return {
    salesIncome,
    purchases,
    businessExpenses,
    otherExpenses,
    otherExpensesTotal,
    provisionalProfit,
    grossSales,
    salesReturns,
    netSales,
    finishedJewelleryCogs,
    grossProfit,
    grossMarginPercent,
    damagedJewelleryLoss,
    netProfit,
    manualSalesAmount,
    manualSalesCount,
  };
}
