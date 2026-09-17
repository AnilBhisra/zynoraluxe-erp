import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  partyFindMany: vi.fn(),
  journalEntryGroupBy: vi.fn(),
  journalEntryAggregate: vi.fn(),
  journalEntryFindMany: vi.fn(),
  paymentAccountFindMany: vi.fn(),
  finishedJewellerySaleAggregate: vi.fn(),
  voucherCount: vi.fn(),
  voucherFindMany: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    account: { findMany: mocks.accountFindMany },
    party: { findMany: mocks.partyFindMany },
    journalEntry: {
      groupBy: mocks.journalEntryGroupBy,
      aggregate: mocks.journalEntryAggregate,
      findMany: mocks.journalEntryFindMany,
    },
    paymentAccount: { findMany: mocks.paymentAccountFindMany },
    finishedJewellerySale: { aggregate: mocks.finishedJewellerySaleAggregate },
    voucher: { count: mocks.voucherCount, findMany: mocks.voucherFindMany },
  },
}));

import { createFakePolishedTx } from "../../../test/fixtures/fakePolishedTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, ZERO } from "@/lib/accounting/money";
import { createPolishedPurchase } from "@/lib/diamond/polishedPurchase";
import { getPartyBalances, getProfitAndLoss, getReceivablePayableSummary, listVouchers } from "./reports";
import { voucherVisibilityWhere } from "./voucherVisibility";

const AR_ACCOUNT_ID = "acct-ar";
const AP_ACCOUNT_ID = "acct-ap";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accountFindMany.mockResolvedValue([
    { code: "1100", id: AR_ACCOUNT_ID },
    { code: "2000", id: AP_ACCOUNT_ID },
  ]);
});

/**
 * Regression coverage for a real live-verified invariant: changing a
 * Party's `type` (Customer/Supplier/Karigar) must never change any
 * financial figure — receivable/payable classification comes exclusively
 * from JournalEntry debit/credit sums, never from the Party row's `type`
 * column. This was confirmed live against Supabase (create a party with a
 * balance, change its type via the confirmed Owner-only flow, re-check
 * Dashboard/Ledger/Outstanding/GST/P&L — only the cosmetic "type" label in
 * the Outstanding report changed; every total stayed byte-identical).
 */
describe("party type change never affects financial totals", () => {
  it("getPartyBalances reports the same balance regardless of the party's type", async () => {
    const journalRows = [{ partyId: "party-1", _sum: { debit: "5000.00", credit: "0.00" } }];

    mocks.journalEntryGroupBy.mockResolvedValue(journalRows);
    mocks.partyFindMany.mockResolvedValue([
      { id: "party-1", name: "Test Party", type: "CUSTOMER", isActive: true },
    ]);
    const asCustomer = await getPartyBalances();

    mocks.journalEntryGroupBy.mockResolvedValue(journalRows); // identical ledger data
    mocks.partyFindMany.mockResolvedValue([
      { id: "party-1", name: "Test Party", type: "SUPPLIER", isActive: true }, // only this changed
    ]);
    const asSupplier = await getPartyBalances();

    // The balance figure is untouched by the type change...
    expect(asCustomer[0].balance.toNumber()).toBe(5000);
    expect(asSupplier[0].balance.toNumber()).toBe(5000);
    expect(asCustomer[0].balance.toNumber()).toBe(asSupplier[0].balance.toNumber());

    // ...only the display label reflects the party's current type.
    expect(asCustomer[0].type).toBe("CUSTOMER");
    expect(asSupplier[0].type).toBe("SUPPLIER");
  });

  it("getReceivablePayableSummary never queries Party at all — it cannot depend on `type`", async () => {
    mocks.journalEntryGroupBy.mockResolvedValue([
      { partyId: "party-1", _sum: { debit: "5000.00", credit: "0.00" } },
    ]);

    const result = await getReceivablePayableSummary();

    expect(result.receivable.toNumber()).toBe(5000);
    expect(result.payable.toNumber()).toBe(0);
    expect(mocks.partyFindMany).not.toHaveBeenCalled();
  });

  it("keeps receivable/payable totals identical across a simulated type change", async () => {
    const sameJournalData = [{ partyId: "party-1", _sum: { debit: "5000.00", credit: "0.00" } }];

    mocks.journalEntryGroupBy.mockResolvedValue(sameJournalData);
    const before = await getReceivablePayableSummary();

    // Simulate the type-change save: nothing about the journal data
    // changes, only (hypothetically) the Party row's `type` column would.
    mocks.journalEntryGroupBy.mockResolvedValue(sameJournalData);
    const after = await getReceivablePayableSummary();

    expect(before.receivable.toNumber()).toBe(after.receivable.toNumber());
    expect(before.payable.toNumber()).toBe(after.payable.toNumber());
  });
});

// ---------------------------------------------------------------------------
// Profit and Loss — every expense account reduces Net profit exactly once
// ---------------------------------------------------------------------------

// Account types exactly as prisma/seed.ts creates them. The fake transaction
// fixture seeds every system account as ASSET, so the P&L mock below uses
// this map for classification.
const ACCOUNT_TYPES: Record<string, { name: string; type: string }> = {
  [SYSTEM_ACCOUNT_CODES.SALES_INCOME]: { name: "Sales Income", type: "INCOME" },
  [SYSTEM_ACCOUNT_CODES.SALES_RETURNS]: { name: "Sales Returns", type: "INCOME" },
  [SYSTEM_ACCOUNT_CODES.PURCHASES]: { name: "Purchases", type: "EXPENSE" },
  [SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES]: { name: "Business Expenses", type: "EXPENSE" },
  [SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS]: { name: "Finished Jewellery COGS", type: "EXPENSE" },
  [SYSTEM_ACCOUNT_CODES.DAMAGED_JEWELLERY_LOSS]: { name: "Damaged Jewellery Loss", type: "EXPENSE" },
  [SYSTEM_ACCOUNT_CODES.BROKERAGE_EXPENSE]: { name: "Brokerage & Commission", type: "EXPENSE" },
  [SYSTEM_ACCOUNT_CODES.ROUND_OFF]: { name: "Round Off", type: "EXPENSE" },
};

type LedgerRow = { accountId: string; debit: string; credit: string };

/** Points the mocked Prisma client at a ledger: accounts by code/type, sums by account. */
function useLedger(accounts: { id: string; code: string }[], entries: LedgerRow[]) {
  const rows = accounts.map((a) => ({ ...a, name: ACCOUNT_TYPES[a.code]?.name ?? a.code, type: ACCOUNT_TYPES[a.code]?.type ?? "ASSET" }));
  mocks.accountFindMany.mockImplementation(async (args: { where: { code?: { in: string[] }; type?: string } }) => {
    if (args.where.type) return rows.filter((r) => r.type === args.where.type);
    return rows.filter((r) => args.where.code?.in.includes(r.code));
  });
  mocks.journalEntryAggregate.mockImplementation(async (args: { where: { accountId: string } }) => {
    const mine = entries.filter((e) => e.accountId === args.where.accountId);
    return {
      _sum: {
        debit: mine.reduce((s, e) => s.plus(e.debit), ZERO),
        credit: mine.reduce((s, e) => s.plus(e.credit), ZERO),
      },
    };
  });
  mocks.finishedJewellerySaleAggregate.mockResolvedValue({ _sum: { taxableTotal: null } });
  mocks.voucherCount.mockResolvedValue(0);
}

/** Net profit straight from the ledger: -(income nets) - (every expense net). */
function ledgerNetProfit(accounts: { id: string; code: string }[], entries: LedgerRow[]) {
  let profit = ZERO;
  for (const a of accounts) {
    const kind = ACCOUNT_TYPES[a.code]?.type;
    if (kind !== "INCOME" && kind !== "EXPENSE") continue;
    const net = entries.filter((e) => e.accountId === a.id).reduce((s, e) => s.plus(e.debit).minus(e.credit), ZERO);
    profit = profit.minus(net);
  }
  return profit.toFixed(2);
}

async function purchaseWithBrokerage(treatment: "EXPENSED_PAYABLE_TO_BROKER" | "CAPITALISED_PAYABLE_TO_BROKER") {
  const fixture = createFakePolishedTx();
  const supplier = fixture.seedParty({ name: "PHASE7 Supplier", type: "SUPPLIER" });
  const broker = fixture.seedParty({ name: "PHASE7 Dalal", type: "BROKER" });
  await createPolishedPurchase(fixture.tx as never, {
    fyStartMonth: 4,
    fyStartDay: 1,
    purchaseDate: new Date("2026-09-17T00:00:00.000Z"),
    supplierId: supplier.id as string,
    currencyCode: "INR",
    exchangeRate: 1,
    supplierAmount: 4000,
    gstTreatment: "NONE",
    brokerPartyId: broker.id as string,
    brokerageMethod: "FIXED",
    brokerageRate: 500,
    brokerageTreatment: treatment,
    lines: [{ shape: "ROUND", sizeLabel: "2.50MM", pieces: 10, carat: 1, rateBasis: "PER_CARAT", rate: 4000 }],
    createdByUserId: "user-1",
  });
  const accounts = [...fixture.state.accounts.values()].map((a) => ({ id: a.id as string, code: a.code as string }));
  const idOf = (code: string) => accounts.find((a) => a.code === code)!.id;
  // The rest of the verified E2E period: a finished sale at ₹2,50,000 with
  // COGS ₹78,776.55 and a ₹400 packet adjustment expensed to 5100.
  const entries: LedgerRow[] = [
    ...fixture.state.journalEntries.map((e) => ({ accountId: e.accountId as string, debit: String(e.debit), credit: String(e.credit) })),
    { accountId: idOf(SYSTEM_ACCOUNT_CODES.SALES_INCOME), debit: "0", credit: "250000.00" },
    { accountId: idOf(SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS), debit: "78776.55", credit: "0" },
    { accountId: idOf(SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES), debit: "400.00", credit: "0" },
  ];
  return { accounts, entries };
}

describe("Profit and Loss includes every expense account exactly once", () => {
  it("an expensed Dalal / Broker brokerage (5400) reduces Net profit by exactly its amount", async () => {
    const { accounts, entries } = await purchaseWithBrokerage("EXPENSED_PAYABLE_TO_BROKER");
    useLedger(accounts, entries);

    const pnl = await getProfitAndLoss();

    expect(pnl.grossSales.toFixed(2)).toBe("250000.00");
    expect(pnl.finishedJewelleryCogs.toFixed(2)).toBe("78776.55");
    expect(pnl.grossProfit.toFixed(2)).toBe("171223.45");
    expect(pnl.businessExpenses.toFixed(2)).toBe("400.00"); // brokerage is not folded into 5100 as well
    expect(pnl.otherExpenses.map((e) => [e.code, e.name, e.amount.toFixed(2)])).toEqual([["5400", "Brokerage & Commission", "500.00"]]);
    expect(pnl.otherExpensesTotal.toFixed(2)).toBe("500.00");
    expect(pnl.netProfit.toFixed(2)).toBe("170323.45");
    expect(pnl.netProfit.toFixed(2)).toBe(ledgerNetProfit(accounts, entries));
  });

  it("capitalised brokerage never reaches P&L, so Net profit is exactly ₹500 higher than when expensed", async () => {
    const expensed = await purchaseWithBrokerage("EXPENSED_PAYABLE_TO_BROKER");
    useLedger(expensed.accounts, expensed.entries);
    const withExpense = await getProfitAndLoss();

    const capitalised = await purchaseWithBrokerage("CAPITALISED_PAYABLE_TO_BROKER");
    useLedger(capitalised.accounts, capitalised.entries);
    const withoutExpense = await getProfitAndLoss();

    expect(withoutExpense.otherExpenses).toEqual([]);
    expect(withoutExpense.netProfit.toFixed(2)).toBe("170823.45");
    expect(withoutExpense.netProfit.toFixed(2)).toBe(ledgerNetProfit(capitalised.accounts, capitalised.entries));
    expect(withoutExpense.netProfit.minus(withExpense.netProfit).toFixed(2)).toBe("500.00");
  });

  it("lists only non-zero accounts without their own line and keeps provisional profit consistent", async () => {
    const { accounts, entries } = await purchaseWithBrokerage("EXPENSED_PAYABLE_TO_BROKER");
    useLedger(accounts, entries);

    const pnl = await getProfitAndLoss();

    expect(pnl.otherExpenses.some((e) => e.code === SYSTEM_ACCOUNT_CODES.ROUND_OFF)).toBe(false);
    for (const dedicated of ["5000", "5100", "5200", "5300"]) {
      expect(pnl.otherExpenses.some((e) => e.code === dedicated)).toBe(false);
    }
    expect(pnl.provisionalProfit.toFixed(2)).toBe(
      new Decimal(pnl.salesIncome).minus(pnl.purchases).minus(pnl.businessExpenses).minus(pnl.otherExpensesTotal).toFixed(2)
    );
  });
});

// ---------------------------------------------------------------------------
// Accounting → Transactions: internal costing vouchers are never loaded for Staff
// ---------------------------------------------------------------------------

describe("listVouchers authorization", () => {
  const D = new Date("2026-09-17T00:00:00.000Z");
  // Vouchers from the real acceptance run, with the internal amounts that leaked before.
  const LEDGER = [
    { id: "v1", voucherNumber: "PUR/2026-27/0001", voucherType: "PURCHASE", amount: "350000.00", reversalOf: null },
    { id: "v2", voucherNumber: "DI/2026-27/0001", voucherType: "DIAMOND_ISSUE", amount: "90900.00", reversalOf: null },
    { id: "v3", voucherNumber: "DR/2026-27/0001", voucherType: "DIAMOND_RECEIPT", amount: "5150.00", reversalOf: null },
    { id: "v4", voucherNumber: "DR/2026-27/0002", voucherType: "DIAMOND_RECEIPT", amount: "2707.89", reversalOf: null },
    { id: "v5", voucherNumber: "JI/2026-27/0001", voucherType: "JEWELLERY_ISSUE", amount: "150600.00", reversalOf: null },
    { id: "v6", voucherNumber: "JR/2026-27/0001", voucherType: "JEWELLERY_RECEIPT", amount: "156829.10", reversalOf: null },
    { id: "v7", voucherNumber: "ADJ/2026-27/0001", voucherType: "STOCK_ADJUSTMENT", amount: "400.00", reversalOf: null },
    { id: "v8", voucherNumber: "REV/2026-27/0001", voucherType: "REVERSAL", amount: "3000.00", reversalOf: "PURCHASE" },
    { id: "v9", voucherNumber: "REV/2026-27/0002", voucherType: "REVERSAL", amount: "5000.00", reversalOf: "DIAMOND_ISSUE" },
    { id: "v10", voucherNumber: "SAL/2026-27/0001", voucherType: "SALE", amount: "257500.00", reversalOf: null },
    { id: "v11", voucherNumber: "PMT-OUT/2026-27/0001", voucherType: "PAYMENT_GIVEN", amount: "1000.00", reversalOf: null },
    { id: "v12", voucherNumber: "PMT-IN/2026-27/0001", voucherType: "PAYMENT_RECEIVED", amount: "2000.00", reversalOf: null },
    { id: "v13", voucherNumber: "SRT/2026-27/0001", voucherType: "SALE_RETURN", amount: "257500.00", reversalOf: null },
  ];

  /** In-memory evaluation of the visibility part of the where clause listVouchers sends. */
  function visible(row: (typeof LEDGER)[number], where: Record<string, unknown>): boolean {
    if (!("OR" in where)) return true;
    return (where.OR as Record<string, unknown>[]).some((w) => {
      const vt = w.voucherType as string | { in: string[] };
      const typeOk = typeof vt === "string" ? row.voucherType === vt : vt.in.includes(row.voucherType);
      if (!typeOk) return false;
      if (!w.reversalOfVoucher) return true;
      const inner = (w.reversalOfVoucher as { is: { voucherType: { in: string[] } } }).is;
      return row.reversalOf !== null && inner.voucherType.in.includes(row.reversalOf);
    });
  }

  beforeEach(() => {
    mocks.voucherFindMany.mockImplementation(async (args: { where: { AND: Record<string, unknown>[] } }) =>
      LEDGER.filter((row) => visible(row, args.where.AND[0])).map((row) => ({
        ...row,
        date: D,
        status: "POSTED",
        party: null,
        paymentAccount: null,
        referenceNumber: null,
      }))
    );
  });

  it("never loads diamond, jewellery job or stock adjustment vouchers (or their reversals) for Staff", async () => {
    const rows = await listVouchers({ take: 50, viewerRole: "STAFF" });

    expect(mocks.voucherFindMany.mock.calls[0][0].where.AND[0]).toEqual(voucherVisibilityWhere("STAFF"));
    expect(rows.map((r) => r.voucherNumber)).toEqual([
      "PUR/2026-27/0001",
      "REV/2026-27/0001",
      "SAL/2026-27/0001",
      "PMT-OUT/2026-27/0001",
      "PMT-IN/2026-27/0001",
      "SRT/2026-27/0001",
    ]);
    const amounts = rows.map((r) => r.amount.toFixed(2));
    for (const internal of ["90900.00", "5150.00", "2707.89", "150600.00", "156829.10", "400.00", "5000.00"]) {
      expect(amounts).not.toContain(internal);
    }
  });

  it("keeps every voucher for the Owner", async () => {
    const rows = await listVouchers({ take: 50, viewerRole: "OWNER" });
    expect(mocks.voucherFindMany.mock.calls[0][0].where.AND[0]).toEqual({});
    expect(rows).toHaveLength(LEDGER.length);
  });

  it("combines the Staff restriction with a search instead of replacing it", async () => {
    await listVouchers({ viewerRole: "STAFF", search: "DR/2026" });
    const where = mocks.voucherFindMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual(voucherVisibilityWhere("STAFF"));
    expect(where.AND[1].OR).toHaveLength(3);
    expect(where.OR).toBeUndefined();
  });
});
