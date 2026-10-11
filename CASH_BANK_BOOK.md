# Cash & Bank Book and Receivable / Payable

Branch `feature/cash-bank-book` from production `d7b1a75`. **Code-only, no
migration** (30 migrations, unchanged). Read/report feature: it posts nothing
and reads only posted journal lines.

## 1. Cash & Bank Book (Accounting → Cash & Bank Book, Owner only)

Every journal line on a payment account's own ledger account (Cash, Bank, UPI,
archived accounts too).

| Item | Rule |
|---|---|
| Money received / પૈસા આવ્યા | debit on the payment account |
| Money paid / પૈસા ગયા | credit on the payment account |
| Party | the voucher's party (a reversal carries its original's); never narration |
| Date | India business date = `(voucher.date + 05:30)::date` |
| Order | business date, created at, voucher number, line id |
| Running balance | the selected account(s)' balance after the line over the **whole history** (SQL window) |
| Opening | Σ(Dr − Cr) of every line before From — never ₹0 by filtering |
| Closing | opening + received − paid for From..To; equals live balance when To is today |
| Cards | the whole account for the period, whatever the row filters; filtered row totals are shown separately |
| Cancelled + reversal | both shown and linked ("reversed by" / "reverses"); "hide reversals" hides both halves, never one |

Filters: account (All, each account, archived labelled), From/To, direction,
party name, party type (Customer, Supplier, Karigar, Manufacturer, Other =
Dalal/Broker or no party), transaction type, voucher/reference/note, reversals.
Pagination 50 rows. CSV (`/accounting/cash-bank-book/export`) and print
(`/accounting/cash-bank-book/print`) use the same query string, parsed by one
function, and hold every filtered row. Each row links to the voucher
(`/accounting/voucher/[id]`: header, lines, reversal links, the business record
behind it) and to the party ledger.

## 2. Receivable & Payable (Accounting → લેવાનું / આપવાનું)

A **party-level live balance**: payments are not allocated to individual bills.
The two control accounts are kept apart, so a party with both sides shows both:

```
receivable side = Σ(Dr − Cr) of the party's lines on 1100
payable side    = Σ(Cr − Dr) of the party's lines on 2000
net             = receivable side − payable side   (+ = owed to us)

A Receivable / લેવાનું   receivable side > 0      D Customer credit  receivable side < 0
B Payable / આપવાનું      payable side > 0         C Advance paid     payable side < 0

Total receivable − total customer credit = 1100 balance
Total advance paid − total payable       = 2000 balance (Dr − Cr)
```

Columns per party (every 1100/2000 line in exactly one, so
billed − charged − received + given + adjustments = net):

| Column | Lines |
|---|---|
| Credit / reversal adjustments | REVERSAL vouchers; gold-purchase credit applied inside a Customer Jewellery Bill |
| Payments received | a credit on a voucher that brought money into Cash/Bank |
| Payments given | a debit on a voucher that paid money out of Cash/Bank (incl. refunds) |
| Billed / sold | any other debit |
| Purchases / charges | any other credit (purchases, Karigar/Manufacturer charges, gold bought from a Customer, corrections) |

"Oldest open" is first-in-first-out per side (an estimate: no allocation
records exist). Last payment received/paid = newest POSTED, non-reversal voucher
that moved Cash/Bank for the party.

The **Dashboard** Receivable / Payable cards now use the same side rule
(advance paid and customer credit shown as separate lines). On production the
figures are unchanged (no party has both sides; no advances or credits).
Reports → "Receivable & Payable" shows this view; Staff keep it (they already
had the Outstanding report and the party ledger) without voucher or Cash & Bank
links.

The Ledger tab shows the party summary: receivable, payable, advance paid,
customer credit, net, last payment received/given, and links (ledger, Cash &
Bank entries — Owner, Customer Gold / Karigar account, related vouchers with the
same Staff visibility as the Transactions list).

## 3. Permissions

Cash & Bank Book, its CSV, print view and the voucher page call `requireOwner()`
on the server. Staff get "Owner only" (no rows in HTML), a redirect to
`/unauthorized` for CSV, print and voucher pages.

## 4. Performance

Constant queries regardless of data size (measured with a counting proxy in
`cashBankBook.db.test.ts`): Cash & Bank page 3 (accounts, summary, rows);
Receivable & Payable 3 (grouped aggregates, ordered lines for FIFO, last
payments).

## 5. Production (read-only, 2026-10-11)

* `PMT-IN/2026-27/0001` ₹8,150 SUDHIRBHAI into **Bank** (2026-10-10) was
  cancelled at 10:52 IST by **`REV/2026-27/0006`** (reason "MISHTIC") and
  re-entered at 10:56 IST as **`PMT-IN/2026-27/0002`** into **Cash**.
  SUDHIRBHAI receivable ₹0.00 (sale `SAL/2026-27/0002`, ZL-FJS-2026-000002).
* Bank: ₹20,749.00 before the reversal (ETSY `SAL/2026-27/0003` ₹12,599 +
  SUDHIRBHAI ₹8,150) → ₹12,599.00 after. Cash: −₹20,500.00 → −₹12,350.00.
* 86 vouchers, no unbalanced voucher, trial balance 0.00, reconciliation 0.00.

## 6. Release (not executed)

Fast-forward push only after approval; no migration or data step. Read-only
checks before and after (identity, 30 migrations, unbalanced vouchers,
`scripts/metalLedgerReconcile.sql`). Smoke: Dashboard Receivable ₹3,67,722.00 /
Payable ₹4,14,190.07; Cash & Bank Book, Bank: live ₹12,599.00 with the
`PMT-IN/2026-27/0001` ↔ `REV/2026-27/0006` pair linked. Rollback: redeploy
`d7b1a75` any time.
