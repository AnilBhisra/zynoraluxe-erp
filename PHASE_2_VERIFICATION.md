# Phase 2 (Accounting) — Verification Report

Branch: `phase-2-accounting`, based on the approved Phase 1 commit
`19493fdac5a444bbbfc43a78becd5a9c9282b487`. Not committed, pushed, or
deployed — awaiting Owner review.

## Automated checks

| Check | Result |
|---|---|
| `prisma validate` | ✅ Schema valid |
| `prisma migrate status` | ✅ 2 migrations found, database schema up to date |
| `tsc --noEmit` | ✅ 0 errors |
| `eslint` | ✅ 0 errors, 0 warnings |
| `vitest run` | ✅ 134/134 tests passing (46 Phase 1 + 88 Phase 2, incl. 26 for Edit Party) |
| `next build` | ✅ Production build succeeds, all 7 routes present |

Re-run after adding the Edit Party feature (this section covers the base
Accounting build; see "Edit Party" section below for that feature's own
verification, including a real bug found and fixed).

## Database migration

`prisma/migrations/20260911000000_phase2_accounting/` applied to the real
Supabase database with `prisma migrate deploy` (forward-only, no reset).
Purely additive: 9 new tables/enums plus one nullable column added to
`company_settings` (`companyStateCode`). Verified before and after that
the real Owner account and row counts for `users` were unaffected.

Seed script (`prisma/seed.ts`) extended to idempotently create the Chart
of Accounts (13 system accounts), 3 default payment accounts (Cash/Bank/
UPI), and 6 starter GST rates. Ran it twice against the real database and
confirmed row counts did not change on the second run (16 accounts / 3
payment accounts / 6 GST rates both times).

## Real end-to-end verification (Supabase + real Chromium browser)

All of the following were exercised against the live database, logged in
as the real Owner account, using clearly-marked temporary data
(`PHASE2TEST ...` party names, a `phase2test.staff@example.com` Staff
account) — not mocked, not a dry run.

1. **Created a Customer, a Supplier, and a Karigar** via the Parties tab.
2. **Posted a Purchase** — Supplier, 10g gold wire @ ₹5,000, CGST+SGST 3%,
   on credit → `PUR/2026-27/0001`, ₹51,500.
3. **Posted a Sale** — Customer, 1 gold ring @ ₹20,000, IGST 3%, on credit
   → `SAL/2026-27/0001`, ₹20,600.
4. **Posted a Payment Given** — ₹5,000 to the Supplier via Bank →
   `PMT-OUT/2026-27/0001`.
5. **Posted a Payment Received** — ₹8,000 from the Customer via Cash →
   `PMT-IN/2026-27/0001`.
6. **Posted an Expense** — ₹500 via Bank → `EXP/2026-27/0001`.
7. **Verified Party ledgers**: Customer showed Dr 20,600 / Cr 8,000 →
   running balance 12,600 (receivable). Supplier showed Cr 51,500 / Dr
   5,000 → running balance −46,500 (payable). Both exactly as hand-computed.
8. **Verified Cash/Bank report**: Cash ₹8,000.00, Bank −₹5,500.00 — matches
   (only the Payment Received touched Cash; Payment Given + Expense touched
   Bank).
9. **Verified Receivable/Payable report**: Receivable ₹12,600.00, Payable
   ₹46,500.00 — matches the ledger totals exactly.
10. **Verified GST summary**: Input CGST ₹750 / SGST ₹750 (from the
    purchase's 3% split), Output IGST ₹600 (from the sale) — net GST
    position −₹900, matching 600 − 1,500 by hand.
11. **Verified Dashboard totals match Accounting reports** exactly — Cash,
    Bank, Receivable, Payable cards on `/dashboard` were byte-for-byte the
    same figures as the Reports tab, because both read the same journal
    entries.
12. **Cancelled the ₹500 Expense as Owner** with a reason. A `REVERSAL`
    voucher (`REV/2026-27/0001`) was posted; the original flipped to
    `CANCELLED` (still visible, not deleted); Bank balance returned exactly
    from −₹5,500.00 to −₹5,000.00; cancelling the same voucher again, or
    cancelling the reversal itself, is rejected (also covered by an
    automated test).
13. **Verified Staff restrictions** with a real temporary Staff login:
    could post an Expense (allowed daily entry); saw **zero** Cancel
    buttons anywhere; visiting the GST summary and P&L reports showed
    "Owner only" instead of the data; direct navigation to `/settings`
    redirected to `/unauthorized`.
14. **Verified mobile layout** at 390×844: Dashboard cards, the Parties tab
    (form + list + balance badges), and the Purchase/Sale form with its
    dynamic item-line rows all render correctly stacked, no page-level
    horizontal scrolling.
15. **Zero browser console errors** across every step above — including
    after two real bugs were found and fixed mid-verification (see below).

### Bugs found and fixed during this verification

- **Decimal values crossing the Server→Client Component boundary.**
  `listVouchers()` returns Prisma `Decimal` instances; passing them
  straight into the client-side `TransactionsTab`/`VoucherList` components
  crashed React with "Only plain objects can be passed to Client
  Components ... Decimal objects are not supported." Fixed by converting
  `amount` to a plain string (`.toFixed(2)`) at the server/client boundary
  in `src/app/(app)/accounting/page.tsx`, with a `SerializedVoucherRow`
  type documenting why. Caught because the Purchase and Sale test
  transactions actually failed to *render* afterward, even though the
  underlying save had succeeded — confirmed by querying the database
  directly.
- **Success message disappearing before it could be read.** The
  create-voucher forms closed themselves the instant the server action
  reported success, which unmounted the "Saved as ..." confirmation in the
  same instant it appeared. Fixed by no longer auto-closing the form on
  success — it now stays open showing the confirmation (and the
  transaction list below refreshes), and the user closes it themselves.

## Cleanup

All temporary test data was deleted directly from the database after
evidence was collected: the 3 `PHASE2TEST` parties, all vouchers/journal
entries/invoice lines created during testing (7 vouchers, 17 journal
entries, 2 invoice lines), and the temporary Staff account. Voucher
numbering sequences were reset to 0 so the first real entry of each type
starts at `0001`. Confirmed afterward: 1 user (the real Owner), 0 parties,
0 vouchers — and the UI correctly shows genuine ₹0.00 balances and "No
parties yet" / "No transactions yet" empty states, not fake data. The real
Owner account and Company Settings were never touched.

## Edit Party — verification (added after the above; same branch)

Real end-to-end, live Supabase + real Chromium browser, with fresh
clearly-marked temporary data (`EDITTEST ...` / `DEBUG ...` party names, a
`phase2edittest.staff@example.com` Staff account).

1. Created two test parties; posted a real credit Sale (₹10,300, IGST 3%)
   against one of them, giving it genuine transaction history.
2. **Owner edit — every field**: changed name, phone, email, address,
   GSTIN, state, and state code in one save. Confirmed via a direct
   database read (bypassing the UI) that every field persisted correctly,
   and `updatedByUserId` was set to the Owner while `createdByUserId`/
   `createdAt` were untouched.
3. **Historical accounting unaffected**: read the Sale voucher's ledger
   row (₹10,300 debit) *before* the edit and again *after* — byte-for-byte
   identical. Confirmed the same after a subsequent party **type** change
   (Customer → Supplier) too.
4. **Type-change guard**: attempting the type change without checking
   "I understand — change the type anyway" was rejected with "This party
   has 1 existing transaction(s). Confirm the type change to continue —
   past transactions will not be altered."; checking the box and
   resubmitting succeeded, and the party's ledger/balance were still
   unchanged afterward.
5. **Staff — contact-only edit**: Staff's edit form showed Name as
   disabled/read-only text, no Party-type select, no Active checkbox, and
   no Archive button anywhere on the page; Staff successfully changed
   phone (an allowed field) and it saved correctly.
6. **Archived Party behaviour**: Owner archived a party, then confirmed
   Owner can still open and use its edit form; Staff got no "Edit" link
   for that same party in the list, and navigating Staff directly to its
   edit URL fell back to the plain "Add a party" view instead of exposing
   any edit form.
7. **Opening balance protection**: never exposed in the edit form at any
   role (enforced by the schema `updateParty` uses, which structurally
   omits those fields).
8. **Mobile (390×844)**: both the full Owner edit form and the reduced
   Staff edit form render correctly stacked, matching desktop behaviour.
9. Zero browser console errors throughout, once the bug below was fixed.

### A real bug found and fixed here

Clicking the "Edit" link from the Parties list (a `next/link` `<Link>`
changing only `searchParams` on the same `/accounting` route) sometimes
rendered the previous view — or reverted a just-made change — within
roughly 500ms–1s of the click, before the real server data arrived. This
was **not** a data-corruption bug (the server-side `updateParty` logic was
always correct, confirmed by hard-navigating straight to the same URL,
which never showed the problem) — it was a client-side rendering race that
could make a user's freshly-typed edit look like it silently reverted.
Root-caused by testing three ways: (1) filling all fields rapidly showed
only the *later*-filled fields survive, meaning something remounted the
form partway through; (2) waiting 3s with zero interaction showed no
drift, ruling out a background timer; (3) a hard `page.goto` to the exact
same URL was reliable every time, isolating the fault to the client-side
`<Link>` transition specifically. Fixed by changing the "Edit" link from
`next/link`'s `<Link>` to a plain `<a href>` (forces a full request),
matching the pattern already used for this page's own tab-switching links.
Re-verified clean afterward with the full flow above, including the
type-change guard which depends on this same navigation.

## Edit Party cleanup

All test parties (2), their journal entries (3) and invoice line (1), the
one test voucher, and the temporary Staff account were deleted directly
from the database. Voucher sequences reset to 0 again. Confirmed
afterward: 1 user (the real Owner), 0 parties, 0 vouchers.

## Scope discipline

No Diamond, Jewellery Jobs, or Costing route files were modified (`git
status` on those three route directories shows no changes). No commit,
push, or deploy was made — this branch is left for Owner review per the
master plan's phase-gate rule.
