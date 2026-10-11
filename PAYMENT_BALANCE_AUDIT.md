# Payment Given / Payment Received — balance audit and fix

Branch `fix/payment-balance-refresh`, from production `4b71cab` (origin/main =
Vercel Production, 30 migrations). Code-only: **no migration**.

## 1. What was wrong

| Class | Finding | Effect |
|---|---|---|
| **Posting (idempotency)** | The payment and invoice forms create one submission key per *mount* and stay open after a save. A second payment typed into the still-open form re-sent the same key, and the server answered any known key with "saved as <the first voucher>" without checking the request. | **The reported defect.** The second payment was never posted; the user saw "saved"; the payable/receivable did not move. Reproduced in Chromium on a `4b71cab` production build: ₹40,000 then ₹60,000 to the same supplier → one voucher, payable stuck at −₹60,000. |
| **Stale UI / load** | Each form's "saved" effect depended on `onDone`, a new function on every render of the Transactions tab. Every `router.refresh()` re-rendered, re-ran the effect, and refreshed again. | **2,630 page-refresh requests in 8 s** after one save on the old build (each a full server render + DB queries), for as long as the success message stays on screen. Fixed build: one refresh. |
| **Report / sign** | Party balances were correct, but an overpaid Supplier/Karigar showed "Owes us", an overpaid Customer "We owe", the Ledger "(we owe)", the Karigar view a negative "Payable". | Advances looked like errors. Now labelled **Advance paid** / **Customer credit**; totals unchanged. |
| **Report** | The Customer Gold bill line "due ₹X" is the amount due *on the bill date* (payments are not allocated to bills). | After Payment Received the bill still read "due". Now "billed after credit ₹X" plus the Customer's live account balance. |
| **Report** | Outstanding excluded archived parties; Cash/Bank excluded archived payment accounts; Outstanding totals summed JavaScript numbers. | Could disagree with the Dashboard / ledger once anything is archived. Now one grouped Decimal reader for every screen. |
| **Report** | `getPartyLedger` with a `dateFrom` started at ₹0 (no balance brought forward). | Not reachable from the UI today; fixed. |
| **Dates (IST)** | Form defaults, report defaults, the financial-year check and reversal vouchers used the UTC date (reversals stored a full timestamp). | 00:00–05:30 IST picked yesterday (on 1 April, the previous financial year). Now the Indian business date. Existing reversals untouched. |
| **Concurrency** | Customer refund checked available credit outside its transaction; voucher cancel claimed the voucher only after writing the reversal. | Now: refund re-checks under a party row lock; cancel claims `POSTED → CANCELLED` first, so simultaneous cancels reverse once. |
| **Integrity** | The generic voucher Cancel could reverse a Customer Jewellery Bill / Delivery, Sale Return, Opening Stock, any audited correction, or a Customer gold purchase, leaving its own document live. | Now refused with the page to use. (None happened in production.) |

Posting itself was correct: Payment Given = Dr 2000 (party) / Cr chosen Cash/Bank;
Payment Received = Dr Cash/Bank / Cr 1100 (party); one balanced voucher; no
expense, inventory, sales or income line.

## 2. Production (read-only, 2026-10-11 08:46–09:32 IST, `BEGIN READ ONLY` … `ROLLBACK`)

* Payments: `PMT-OUT/2026-27/0001` ₹20,500.00 BHAVESHBHAI, Cash (settles
  `PUR/2026-27/0002`, polished purchase ZL-PP-2026-000001) and
  `PMT-IN/2026-27/0001` ₹8,150.00 SUDHIRBHAI, Bank (settles `SAL/2026-27/0002`).
  Both correctly shaped; both parties ₹0.00.
* 84 vouchers / 199 lines, no unbalanced voucher, trial balance 0.00, every
  reversal an exact mirror, no AR/AP line without a party, sequences = counts.
* No document/voucher status mismatch (bills, deliveries, finished sales, metal
  and Customer gold purchases).
* Dashboard today and after the fix: Receivable ₹3,67,722.00, Payable
  ₹4,14,190.07, no advances, no archived party with a balance.
* **No historical entry needs correction.** Cash shows −₹20,500.00 because no
  opening cash was ever recorded — the Owner may record it (Opening / capital);
  the fix does not change it.

## 3. One rule for every balance

`src/lib/accounting/reports.ts` `partyNetBalances()` (journal lines on 1100 +
2000 per party, one grouped query) feeds the Parties tab, Outstanding, Ledger,
Dashboard, Karigar account, Customer Gold statement, refund check and payment
forms. `src/lib/accounting/partyBalance.ts` `classifyPartyBalance()` labels it.
Dashboard totals stay sign-based (a party's type never changes a total);
advances are shown as "incl. ₹X advance paid / customer credit".

## 4. Verification

* DB (scratch cluster only): `src/lib/accounting/payments.db.test.ts` (22),
  `src/app/actions/paymentActions.db.test.ts` (4 — the reproduction fails on
  `4b71cab`, passes here). Full DB project 23 files / 354 tests, twice.
* Unit/component 91 files / 1,020 tests; `tsc`, ESLint, `prisma validate`,
  migrate status (30, up to date), `git diff --check`, `next build`, secret scan.
* Chromium on a production build + disposable DB: 41/41 (Owner/Staff, desktop
  and mobile; partial, exact, overpayment; Cash and Bank; immediate refresh;
  cancel; double-click; labels; no sideways scroll; no per-account balances or
  cost data in Staff HTML, page data or Server Action responses; Staff replay of
  the Owner's cancel action changes nothing).

## 5. Release order (not executed)

1. Confirm `origin/main` and Vercel Production are still `4b71cab` and the
   branch fast-forwards it.
2. Read-only production checks (identity, 30 migrations, no unbalanced voucher,
   section 3 of `OPERATIONS.md`).
3. No migration and no data step. Fast-forward push; wait for Vercel Production
   Ready at the new SHA.
4. Read-only smoke: Owner Dashboard Receivable ₹3,67,722.00 / Payable
   ₹4,14,190.07 unchanged; Parties shows BHAVESHBHAI and SUDHIRBHAI "Settled".
   Do not post a payment as part of the release.
5. Rollback: redeploy `4b71cab` at any time (no schema change; reversals the new
   code writes are ordinary date-only vouchers the old code reads).
