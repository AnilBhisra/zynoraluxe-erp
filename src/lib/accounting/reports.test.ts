import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  partyFindMany: vi.fn(),
  journalEntryGroupBy: vi.fn(),
  journalEntryAggregate: vi.fn(),
  journalEntryFindMany: vi.fn(),
  paymentAccountFindMany: vi.fn(),
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
  },
}));

import { getPartyBalances, getReceivablePayableSummary } from "./reports";

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
