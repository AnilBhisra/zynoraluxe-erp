# Clearing settlement (marketplace / provider batch payouts)

Branch `feature/clearing-settlement` from production `366e5ce` (30 migrations).
Adds migration 31 `20261012090000_clearing_settlement` (additive). Provider-neutral:
Etsy, Amazon, eBay, PayPal, Stripe, Razorpay, courier COD, dealers, agents.

## 1. The problem it solves

Until now a sale was either on credit (Dr 1100 Accounts Receivable) or "Paid now"
(Dr Cash/Bank). A marketplace that collects for many sales and later pays a lump
sum after deducting fees fitted neither. In production, `SAL/2026-27/0003` (ETSY,
₹12,599, 2026-10-08) was entered as "Paid now — Bank" and its note says ₹4,991
of Etsy tax and offsite ads was deducted — the piece's selling price was ₹17,590
and the ₹4,991 was entered as a **discount**. So revenue is understated by ₹4,991
and the fees are invisible (profit is the same). The audited **gross-up** below
corrects that without editing the sale.

## 2. Accounting model

| Account | Code | Type | Use |
|---|---|---|---|
| Marketplace Clearing Receivable | 1150 | Asset | what each provider owes us, by party |
| Marketplace Reserve / Held Funds | 1160 | Asset | provider-held money (still ours) |
| TDS / TCS Withheld by Marketplace | 1170 | Asset | tax withheld, claimable |
| Settlement Suspense (To Classify) | 1180 | Asset | "tax remitted" and "other" until the CA classifies |
| Foreign Exchange Gain | 4300 | Income | |
| Marketplace Commission & Platform Fees | 5600 | Expense | commission, and default for none of the below |
| Advertising & Marketing | 5610 | Expense | |
| Payment Processing Fees | 5620 | Expense | |
| Shipping & Courier Charges | 5630 | Expense | |
| Subscription & Listing Fees | 5640 | Expense | |
| Foreign Exchange Loss | 5650 | Expense | |

A party marked **clearing** (Settlements → Settings) changes only how its sales
post:

```
Sale (clearing party):  Dr 1150 (party)  /  Cr Sales + output GST        COGS / stock exactly as before
                        "Paid now" is refused — the money comes by settlement.
```

Every movement is also written to `clearing_entries` with the provider, the
clearing **currency**, the amount in that currency (fc) and in INR, and the
bucket (AVAILABLE ↔ 1150, RESERVE ↔ 1160). Σ inr per party/bucket always equals
that party's 1150 / 1160 ledger (asserted inside every posting transaction and
by `clearingReconciliation()`).

### Settlement (payout)

```
G (clearing relieved, fc) = payout fc + Σ deductions fc + reserve hold fc − reserve release fc − other additions fc
G must be ≤ available fc (no oversettling); release ≤ reserve fc.

INR:  clearing relieved  = carrying value of G   (all of it if the balance empties, else G × INR/fc of the balance)
      deductions          = fc × payout rate (payout INR ÷ payout fc), rounded to the paisa
      reserve hold/release= at the reserve/available carrying rate (a transfer, never FX)
      FX                  = what is left, posted once to 4300 (gain) or 5650 (loss); always 0 for INR

Voucher (CLR/…):  Dr Cash/Bank (payout)  Dr each deduction account  Dr 1160 (hold)
                  Cr 1150 (party, carrying)  Cr 1160 (release)  Cr additions   ± FX
```

No order is marked paid. A settlement is an **unallocated pooled settlement**
unless the Owner later records an **allocation** (statement only: no voucher;
≤ the settlement's G and ≤ the sale's open amount; reversible on its own). No
FIFO is invented; the Receivable & Payable "oldest open" estimate is labelled as
such and never touches accounting.

### Reserve / hold

```
Hold (CLR-RSV/…):     Dr 1160 (party) / Cr 1150 (party)   at carrying value
Release (CLR-RSV/…):  Dr 1150 (party) / Cr 1160 (party)
```
No Bank, revenue or expense line. A payout may also release reserve directly
(line "Released from reserve").

### Reclassify a sale receipt (historical "Paid now" marketplace sale)

```
CLR-RCL/…:  Dr 1150 (party)  /  Cr the original payment account   (= the sale's Cash/Bank debit)
```
Refused unless: the party is clearing; the sale is POSTED, not reclassified
before, has a Cash/Bank receipt line, has no sale return / returned line, no
correction, no cancellation. The sale voucher, GST, revenue, COGS, piece status
and stock are never touched. While it stands, the sale cannot be cancelled on its
own (that would credit Bank twice) — reverse the reclassification first.

### Gross-up a sale recorded net of the marketplace's fees

```
CLR-GRS/…:  Dr 1150 (party)  /  Cr 4000 Sales  [/ Cr 7001+7002 or 7003 output GST]
```
For a sale whose amount is what reached the Bank (fees/ads taken as a discount). The
Owner states the marketplace's **gross** amount; the missing part (gross − recorded)
is added to revenue and to the provider's clearing; the settlement then takes the fees
off clearing as expenses, so **profit is unchanged** and revenue and fees are both
shown gross. GST on the gross-up is **never defaulted**: the Owner must choose none /
included / added, CGST+SGST or IGST and the rate, and type the CA's confirmation
(≥ 10 characters, stored on the document with the gross amount). Only the gross-up
amount is taxed; the original sale's GST is not changed.

One preview, one transaction, all or nothing, each step planned on the balance the
previous step leaves:
1. receipt reclassification (only if the receipt is still in Cash/Bank);
2. the gross-up;
3. optionally the settlement (payout to Bank + each fee line).

The preview shows each voucher and the overall effect (Cash/Bank net, clearing after,
revenue, GST, expense, profit change, the order's revenue before → after). Each step
keeps its own fingerprint and idempotency key (`key:r`, `key:g`, `key:s`).

Refused unless: the party is clearing; the sale is POSTED, INR, fully in the receipt /
clearing (not part on credit), has no live gross-up, no sale return or returned line,
no correction. The sale voucher, the finished-sale record (its discount stays), COGS,
the piece's status and stock are never touched. While a gross-up stands, the sale
cannot be cancelled (reverse the gross-up first). The P&L counts gross-up revenue of
a finished sale as linked revenue, not as a "manual sale". Reversal is the ordinary
newest-first reversal of each document (settlement → gross-up → reclassification).

### Reversal

Owner only, reason ≥ 10 characters, idempotency key, party row locked, **newest
first per provider and currency** (a later posted document blocks it), refused if
it would leave a negative available or reserve balance. Posts the generic mirror
voucher (`REV/…`); the sub-ledger entries are mirrored by the same call
(`cancelVoucher` → `mirrorClearingEntries`); active allocations are reversed.
The generic voucher Cancel refuses CLR / CLR-RSV / CLR-RCL / CLR-GRS vouchers.
"Newest" is the document's posting `sequence` (a gross-up workflow posts up to three
documents in one transaction, with the same timestamp).

### Sale return / cancellation of a clearing sale

The Sale Return credits 1150 (not 1100) and reduces the clearing currency in
proportion; cancelling the sale mirrors its clearing entry. A settlement
"Refund" line is only for a refund **not** recorded as a Sale Return.

## 3. Worked vouchers (to the paisa)

| Case | Lines |
|---|---|
| A. 25 sales ₹500, payout ₹150 | Dr 1002 Bank 150.00 · Cr 1150 150.00 → ₹350.00 left |
| B. ₹200 settled = Bank ₹150 + fee ₹50 | Dr 1002 150.00 · Dr 5600 50.00 · Cr 1150 200.00 → ₹300.00 left |
| C. 5 × $100 booked at ₹83; payout $100 at ₹84 | Dr 1002 8,400.00 · Cr 1150 8,300.00 · Cr 4300 100.00 |
| C′. $90 + $10 fee at ₹84 | Dr 1002 7,560.00 · Dr 5600 840.00 · Cr 1150 8,300.00 · Cr 4300 100.00 |
| Loss: $90 + $10 fee at ₹82 | Dr 1002 7,380.00 · Dr 5600 820.00 · Dr 5650 100.00 · Cr 1150 8,300.00 |
| Deductions | Dr 1002 8,500 · Dr 5600 600 · Dr 5610 400 · Dr 5620 300 · Dr 5640 100 · Dr 1170 100 · Cr 1150 10,000 |
| Hold ₹300 | Dr 1160 300.00 · Cr 1150 300.00 |
| Payout ₹1,000 incl. release ₹300 | Dr 1002 1,000.00 · Cr 1150 700.00 · Cr 1160 300.00 |
| Reclassify ETSY ₹12,599 | Dr 1150 12,599.00 · Cr 1002 12,599.00 |
| Gross-up ETSY to ₹17,590 (no GST) | Dr 1150 4,991.00 · Cr 4000 4,991.00 |
| Then settle ₹17,590 | Dr 1002 12,599.00 · Dr 5600/5610 4,991.00 · Cr 1150 17,590.00 → clearing 0, Bank net 0, profit 0 |
| Gross-up ₹500 + IGST 18% added | Dr 1150 590.00 · Cr 4000 500.00 · Cr 7003 90.00 |
| Gross-up ₹590 incl. CGST+SGST 18% | Dr 1150 590.00 · Cr 4000 500.00 · Cr 7001 45.00 · Cr 7002 45.00 |

## 4. Where it shows

* Accounting → **Settlements** (Owner): provider balances (available, reserve,
  total, unallocated, next availability), new settlement with preview, reserve
  move, settlement list (reverse newest, optional allocation), reclassification
  of historical "Paid now" marketplace sales, settings (clearing parties, line →
  account mapping), **Clearing Settlements report** (per provider and currency:
  opening, gross sales, returns, reclassified, payouts, fees, marketing, refunds,
  taxes, reserve, FX, other, unallocated, closing; settlement rows) with CSV and
  print using one filter parser.
* Cash & Bank Book: only the amount that reached the payment account.
* Receivable & Payable / Dashboard receivable: 1100/2000 only — clearing is never
  inside them. Dashboard (Owner): a separate "Marketplace clearing" card.
* P&L: FX gain (and any other income account) is now listed as other income.
* Voucher page: every CLR voucher with its lines and reversal link.

## 5. Safety

Owner-only on the server (every action, CSV, print; Staff get "Owner only" and
no figures in HTML / RSC / action responses). One transaction per posting; party
row lock first; balances re-read under the lock; a fingerprint of the previewed
balances and voucher must match (stale preview refused); idempotency key
(double-click / two tabs post once); Decimal only; paisa rounding with the FX
line taking the remainder; sub-ledger = ledger asserted before commit.

## 6. Decisions for the CA (configurable — Settings → Account mapping)

* TDS (194-O) / GST TCS withheld → 1170 (asset, claimable). Confirm.
* Tax collected / remitted by the marketplace → 1180 suspense until classified
  (it may be pass-through, an output-tax adjustment, or a cost).
* "Other adjustment" → 1180 suspense.
* Refund not recorded as a Sale Return → 4100 Sales Returns (contra revenue).
* Shipping deductions → 5630 expense (or reduce shipping income if charged).
* FX gain/loss → 4300 / 5650.
* `SAL/2026-27/0003`: whether to gross it up to ₹17,590 with ₹4,991 of fees, how to
  split the ₹4,991 (the note says "Etsy tax and offsite ads" — tax the marketplace
  collects is not an expense: use the "Tax collected / remitted" line, 1180 suspense,
  until classified), and the GST on the gross-up (none / included / added, rate). The
  app takes all three from the Owner and records the CA's confirmation; it guesses
  none of them.

## 7. Limitations

* Single legal entity (the app has one company). Balances are per party and
  currency; the payout account is recorded per settlement, not a separate balance.
* Foreign currency exists only for clearing sales; other vouchers stay INR.
  Partial sale returns split the clearing currency in proportion (4 decimals).
* Allocation is a statement only; it does not change balances or the sale.

## 8. Rollback

Code rollback to `366e5ce` is safe **until the first clearing posting** (party
flag, settlement, reserve move, reclassification or gross-up). After that, old code would
treat 1150/1160 lines as unknown and allow the generic Cancel on CLR vouchers —
fix forward. Never roll the migration back (enum values and tables are additive).
