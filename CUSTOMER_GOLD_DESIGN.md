# Customer Gold — design, accounting and audit

This document describes how the ERP handled gold before this change (inspected at
`adba980`, the production commit), why Customer-owned gold cannot be put through
the existing Company flows, and the design, accounting and migration that were
added.

## 1. Existing behaviour at adba980

Every gram of metal in the system is Company-owned.

| Flow | What it does |
|---|---|
| Metal purchase / opening stock | Company pools by metal + purity (`metal_stock_movements`), valued at cost. Dr 1300 Metal Inventory. |
| Karigar Metal (custody) | Company gold issued to a Karigar without a job: Dr 1320 Jewellery WIP / Cr 1300. Allocate/release between the Karigar's balance and his jobs moves value inside 1320 (no voucher). |
| Issue Materials | Diamonds, packets, silver/platinum/Company copper, other material. Direct gold issue is refused (1aaee32). |
| Receipt (`receiveFinishedJewellery`) | Reconciles FINE weight against the job's Company metal only (`pendingFineWeightOf`). Relieves WIP cost proportionally; returned metal goes back into Company stock (RETURN_IN, Dr 1300), scrap into the Company scrap pool (SCRAP_RETURN_IN, Dr 1310), consumption is logged (CONSUMED_OUT). Every piece is debited to 1330 Finished Jewellery Inventory, gets status AVAILABLE and a PRODUCED_IN stock movement. Karigar charges, Karigar-added material and Karigar alloy are credited to 2000 Accounts Payable (Karigar). |
| Receipt-time allocation (1aaee32/9e742f3) | Takes only the shortfall of Company custody gold at receipt, one locked transaction, Owner or Staff; Staff never see cost. |
| Finished stock / sale | Only AVAILABLE pieces can be sold or adjusted; sale posts Dr 5200 COGS / Cr 1330 at the piece's carrying cost. |
| Reconciliation | 1300 = usable pools, 1310 = scrap pools, 1320 = custody + open-job WIP + stones, 1330 = AVAILABLE pieces. |

Consequence: there was **no way to hold a Customer's gold**. Recording it as a
metal purchase would make it Company stock with a payable; issuing it through
Karigar Metal would post it into 1320/1330 and COGS; returns and scrap would land
in Company pools. Every one of those claims ownership the Company does not have.

## 2. Design

### 2.1 Two explicit intake choices

* **Customer-owned gold — for manufacturing** → a `CustomerGoldReceipt` and an
  `INTAKE` ledger entry. No voucher, no Company pool, no payable, no cost.
* **Purchase/exchange gold from Customer** → a `CustomerGoldPurchase`, Owner-
  approved, with an agreed rate and date. It posts through the existing
  `createMetalPurchase` (Dr 1300 at the approved value / Cr 2000 to the Customer,
  PURCHASE_IN into the Company pool) and records whether the amount is to be paid
  to the Customer or credited against their jewellery bill. Custody gold is never
  converted silently: converting a custody balance is the same Owner-approved
  purchase, plus a `CONVERT_TO_COMPANY` custody entry.

### 2.2 The Customer Gold ledger

`CustomerGoldEntry` is an append-only ledger, separate from
`metal_stock_movements`. Every entry moves weight between two **locations** of
one **pool** (Customer + metal + purity + fineness snapshot):

```
CUSTOMER → SAFE → KARIGAR(k) → JOB(j) → FINISHED(piece) → DELIVERED
                ↘ RETURNED   ↘ SAFE (Karigar gave it back)   ↘ SCRAP → RETURNED
                             JOB(j) → LOSS (authorised)       SAFE → PURCHASED
```

| Kind | From → To |
|---|---|
| INTAKE | CUSTOMER → SAFE |
| ISSUE_TO_KARIGAR / RETURN_FROM_KARIGAR | SAFE ↔ KARIGAR(k) |
| ALLOCATE_TO_JOB | KARIGAR(k) or SAFE → JOB(j) (job's own Karigar) |
| RELEASE_FROM_JOB | JOB(j) → KARIGAR(k) |
| CONSUME_TO_FINISHED | JOB(j) → FINISHED(piece) (at receipt) |
| JOB_RETURN / JOB_SCRAP / JOB_LOSS | JOB(j) → SAFE / SCRAP / LOSS (at receipt, explicit weight + reason) |
| RETURN_TO_CUSTOMER / SCRAP_RETURN_TO_CUSTOMER | SAFE / SCRAP → RETURNED |
| DELIVER | FINISHED(piece) → DELIVERED |
| CONVERT_TO_COMPANY | SAFE → PURCHASED (with an Owner-approved purchase) |

A reversal is a new entry with `reversalOfEntryId` and the opposite sign;
nothing is ever edited or deleted. Balance per location = Σ in − Σ out, so

> received = SAFE + Σ KARIGAR + Σ JOB + Σ FINISHED + DELIVERED + RETURNED + LOSS + SCRAP + PURCHASED

holds by construction and is checked (never assumed) by the reconciliation
report. Every post checks that no location of the pool goes negative.

Pools never mix: one Customer's gold can only be allocated to a job whose
`customerId` is that Customer, and only from that Customer's pool.

**Scrap rule:** scrap from Customer gold remains the Customer's property. It is
held in the Customer's SCRAP location and can only be returned to the Customer
(or bought through an Owner-approved purchase of a SAFE balance after the Owner
records its return to SAFE — never silently).

### 2.3 Jobs and receipts

A job's gold source is derived, never guessed: Customer gold (ledger entries on
the job), Company gold through Karigar Metal (issue lines created by custody
allocation), historical direct Company issue (other issue lines). Holding both
Customer and Company gold on one job needs an explicit Owner approval recorded
on the job (`customerGoldMixApprovedAt/ByUserId/Reason`) and is allowed only
when both are the same purity and fineness.

`receiveWithCustomerGold` (Owner or Staff) mirrors receipt-time Company
allocation: it computes the Customer fine gold the finished pieces need from
their actual net weight and final purity, uses Customer gold already on the job
first, takes only the shortfall from the same Customer's balance with the job's
Karigar and then from the Customer's SAFE balance, and posts allocation, receipt
and consumption in **one locked, idempotent transaction** after re-checking an
opaque preview fingerprint. Completing a job never writes anything off: every
gram left on it must be returned, scrapped or recorded as authorised loss.

`receiveFinishedJewellery` gains an internal `customerGold` option: Customer
fine weight is excluded from the Company metal reconciliation, WIP relief,
Company consumption records, returns and scrap. Company diamonds, packets,
alloy, Karigar-added material and charges are handled exactly as before. A
receipt on a job holding Customer gold without that option is refused.

### 2.4 Customer-owned finished jewellery

A piece containing Customer gold is `ownership = CUSTOMER`, status
`CUSTOMER_AWAITING_DELIVERY`, gets **no** PRODUCED_IN movement and never enters
Company Finished Stock, sales or stock adjustment. The Company's own cost in it
(diamonds, stones, alloy, charges, Karigar-added material, any approved Company
gold) is debited to a new asset account **1340 Customer Jewellery Work Awaiting
Delivery** instead of 1330.

### 2.5 Billing and delivery

* **Bill** (Owner): making/labour, diamonds, Company materials, other charges and
  GST. Dr 1100 AR (Customer) / Cr 4000 Sales Income / Cr Output GST. Credit from an
  approved purchase/exchange can be applied in the same voucher: Dr 2000 AP
  (Customer) / Cr 1100 AR (Customer). Customer gold is never a bill line.
* **Deliver** (Owner or Staff): refused unless the job is reconciled (no Customer
  gold, diamonds or packet stones left pending, job completed). Records who
  delivered, who received, date and reference; moves each piece FINISHED →
  DELIVERED; posts Dr 5200 COGS / Cr 1340 for the Company's cost in the pieces.
* Delivery and bill each have an audited Owner reversal (mirror vouchers,
  reversal ledger entries), refused when something later depends on them.

## 3. Exact accounting treatment

| Event | Voucher |
|---|---|
| Customer gold intake, issue/return to Karigar, allocate/release, consumption, return to Customer, scrap, loss | **none** — custody only, no value |
| Receipt of a Customer-gold piece | as today for Company parts, but the finished debit for Customer pieces goes to **1340** (not 1330); Customer gold itself carries ₹0 |
| Purchase/exchange (Owner-approved) | Dr 1300 approved value / Cr 2000 AP (Customer), via `createMetalPurchase`; PURCHASE_IN at the approved value |
| Bill | Dr 1100 AR / Cr 4000 / Cr 700x GST; credit applied: Dr 2000 / Cr 1100 |
| Delivery | Dr 5200 COGS / Cr 1340 (Company cost in the delivered pieces) |
| Reversals | mirror vouchers |

1300/1310/1320/1330 reconciliation is unchanged by Customer gold. A new line
reconciles 1340 to the Company cost of pieces awaiting delivery.

## 4. Migration (additive only)

New enums, new values on `JewellerySequenceType` and
`FinishedJewelleryStockStatus`, new tables (`customer_gold_receipts`,
`customer_gold_entries`, `customer_gold_purchases`,
`customer_jewellery_bills`, `customer_jewellery_deliveries`,
`customer_jewellery_delivery_items`), nullable/defaulted columns on
`finished_jewellery`, `jewellery_jobs` and `jewellery_receipts`, and one
idempotent `INSERT … ON CONFLICT DO NOTHING` of account 1340. No existing row,
column type or constraint changes; no backfill.

## 5. Limitations (this version)

* A receipt cannot combine Customer gold with receipt-time **Company** custody
  allocation; on a mixed job, allocate the Company gold in advance.
* Jewellery receipts are not reversible (true before this change too); their
  Customer-gold entries are part of the receipt.
* A purchase/exchange is corrected by an Owner correction, not reversed.
* "Add missing charges" and cost override are refused on Customer-owned pieces.
* The receipt form's Customer-gold mode skips the browser-side reconciliation
  check and relies on the server preview (which is mandatory before saving).
* Mixed jobs need the Customer's share of the finished fine gold entered by
  hand; it is never guessed.
* An intake photo uses the existing jewellery storage ("jewellery-finished"
  category); with storage unconfigured the photo is simply unavailable.
* Voucher types CUSTOMER_JEWELLERY_BILL / CUSTOMER_JEWELLERY_DELIVERY are
  Owner-only in the voucher list.

## 6. User interface

* Jewellery Jobs → **Customer Gold** tab: Customer picker; intake with the two
  required choices; movements (issue/return/allocate/release/return to
  Customer/scrap return) with preview + confirm; purchase from the safe
  balance; balances per pool; statement with newest-first reversal (Owner);
  pieces, purchases, bills, deliveries; all-Customer reconciliation,
  Karigar-wise, job-wise, awaiting delivery and exceptions.
* Printable pages: `/customer-gold/receipt/[id]` (acknowledgment) and
  `/customer-gold/statement/[customerId]`.
* Job page: gold source panel (Customer / Company via Karigar Metal /
  historical direct / combination), Owner mix approval, Customer pieces, bill
  (Owner) and delivery (Owner or Staff) with reversals (Owner).
* Receive Finished Jewellery: "Gold source" selector with a Customer-owned
  mode — Customer returns/scrap (and Owner-only authorised loss), Customer
  share on mixed jobs, a mandatory stale-checked preview.
* Every money figure is read from the database only for the Owner.

## 7. Release plan (data-preserving; not executed)

1. Preflight: branch ancestry on origin/main, clean tree, current production
   commit and public IP re-checked, read-only production checks.
2. Maintenance ON (established firewall rule), fresh `pg_dump` backup,
   restore-test, fingerprint.
3. `prisma migrate deploy` of the two additive migrations **before** the code
   (`20261005090000_customer_gold`, `20261005090100_customer_gold_voucher_types`).
   Verify 27 migrations, account 1340 present, `scripts/metalLedgerReconcile.sql`
   returns **five** lines (1300, 1310, 1320, 1330, 1340) all ₹0.00, and the
   pre-existing tables' fingerprint (ignoring only the new columns / 1340 row /
   new tables) is identical.
4. Fast-forward push; wait for Vercel Production Ready at the SHA.
5. Owner/Staff read-only checks (Customer Gold tab opens empty, jobs 000001 /
   000002 unchanged, Staff sees no money); no test postings on real data.
6. Fingerprint diff + reconciliation; maintenance OFF; confirm public access.
7. Rollback: the migrations are additive and unused by the old code, so a code
   rollback needs no schema rollback; restore the backup only if data was
   damaged.
