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

**Mixed Customer + Company gold — the supported workflow.** A receipt never
allocates Company gold at receipt time on a Customer-gold job; instead:

1. The Owner approves mixing on the job (reason recorded). Without it, Company
   gold cannot go onto a job holding Customer gold, nor Customer gold onto a job
   holding Company gold.
2. The Company gold is allocated to the job **first**, explicitly, through
   Karigar Metal (same purity and fineness as the Customer's pool). Its cost is
   in the job's WIP from that moment.
3. At receipt the Owner enters the Customer's share of the finished pieces' fine
   gold (never guessed). Receipt-time Customer allocation supplies only that
   declared share (+ Customer returns/scrap/authorised loss).
4. The Owner's preview shows both sources separately: Customer fine (₹0) and the
   Company side — pending before, fine in the pieces, Company returns/scrap,
   process loss at completion, pending after, and the exact WIP cost the
   receipt moves (`plan.company.costMoved`, computed with the posting engine's
   own formula and included in the stale-check fingerprint).
5. Posting: WIP is credited exactly `costMoved` once; the piece carries it in
   1340; the Customer's gold adds nothing. Customer fine + Company fine = the
   pieces' fine; each side reconciles on its own (Customer ledger; Company
   pending = in pieces + returned + scrap + process loss).
6. Staff can never create or alter a mixed decision: a mixed receipt (preview
   or save) by Staff is refused on the server, and the form says so.

Proven in `customerGoldReceiptReversal.db.test.ts` ("mixed Customer + Company
gold …") and in Chromium (`customerGoldAccept2.js`).

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

### 2.6 Reversing or correcting a Customer Gold receipt (Owner)

A posted Customer Gold jewellery receipt is never edited or deleted. The Owner
reverses it (`reverseCustomerGoldJobReceipt`), then records the correct receipt
again — that pair **is** the correction, whatever was wrong (weight, purity,
outputs, charges, stones, returns).

* When the receipt is posted, a reversal record (`reversalSnapshot`) is written
  in the same transaction: the job's counters and status before and after, the
  earlier pieces' shared material cost before and after, the receipt-time
  allocation entries and each resolved diamond's previous status.
* Reversal, in one locked, idempotent transaction (reason ≥ 10 characters,
  actor and time recorded on the receipt):
  - a mirror entry for every Customer Gold entry of the receipt, newest first
    (consumption, returns, scrap, loss, then the receipt-time allocation), the
    pool proven non-negative on the final state;
  - the standard mirror voucher for the receipt's voucher (1340 / 1330 / WIP /
    Karigar payable for charges and Karigar-supplied material / stones);
  - pieces → `RECEIPT_REVERSED` (kept for the audit trail);
  - diamonds back to the job (`JEWELLERY_RECEIPT_REVERSAL_IN` movement), packet
    stones back to the job (returned stones leave their packet again through a
    `JEWELLERY_ISSUE_OUT` packet movement), resolutions marked reversed;
  - the job restored exactly to its state before the receipt; earlier pieces'
    shared material cost restored.
* Newest first and blocked — with the exact dependency named — when: a later
  live receipt exists on the job; a piece was delivered (delivery code), is not
  awaiting delivery, or has finished-stock movements; a bill is posted for the
  job (bill code); a charge correction was added to the receipt; the receipt
  returned Company metal to stock or scrap (a Company pool movement is not
  undone by this reversal — correct the Company side through Corrections); a
  revaluation touched the job/pieces or the Company purity consumed; the job
  changed after the receipt (named documents / fields); a diamond or packet
  moved again; or the Customer's gold that the reversal must take back was used
  later (entry codes).
* A reversed receipt no longer counts anywhere: receipt counts, Karigar-supplied
  cost, charge panels, per-purity pending, the metal replay loaders (job cost and
  opening-stock correction) and billing all skip it.
* Duplicate reversal: the same key replays; any other attempt is refused as
  already reversed. Two concurrent reversals: one wins, the other is refused.

## 3. Exact accounting treatment

| Event | Voucher |
|---|---|
| Customer gold intake, issue/return to Karigar, allocate/release, consumption, return to Customer, scrap, loss | **none** — custody only, no value |
| Receipt of a Customer-gold piece | as today for Company parts, but the finished debit for Customer pieces goes to **1340** (not 1330); Customer gold itself carries ₹0 |
| Purchase/exchange (Owner-approved) | Dr 1300 approved value / Cr 2000 AP (Customer), via `createMetalPurchase`; PURCHASE_IN at the approved value |
| One-step Old Gold Exchange (Phase 8C) | the intake (no voucher) and the purchase above of exactly that intake, in one transaction |
| Purchase/exchange reversal (Owner) | mirror of the purchase voucher (Dr 2000 / Cr 1300); ADJUSTMENT_OUT linked to the PURCHASE_IN by `reversalOfMovementId` at the same weight and value; CONVERT_TO_COMPANY mirrored back to the safe |
| Bill | Dr 1100 AR / Cr 4000 / Cr 700x GST; credit applied: Dr 2000 / Cr 1100 |
| Delivery | Dr 5200 COGS / Cr 1340 (Company cost in the delivered pieces) |
| Reversals (entries, bill, delivery) | mirror vouchers |
| Reversal of a Customer Gold receipt | the standard mirror of the receipt voucher (Cr 1340 / Cr 1330 as posted, Dr WIP, Dr 2000 Karigar payable for charges and Karigar-supplied material, stones back); no Company metal pool movement is ever reversed |

1300/1310/1320/1330 reconciliation is unchanged by Customer gold. A new line
reconciles 1340 to the Company cost of pieces awaiting delivery, and (Phase 8C)
a sixth line `CGCR` reconciles the Customer credit path: Accounts Payable on
every purchase/exchange voucher and its reversal, and on every bill's
"Gold-purchase credit applied" lines and their reversals, against the records
(approved value of live purchases − credit applied by live bills).

## 4. Migrations (additive only; apply in this order, before the code)

1. `20261005090000_customer_gold` — **starts with a guard**: if account code 1340
   already exists and is not exactly this system account (same id, or same name
   and type), or the id `sysacct_1340_customer_jewellery` exists under another
   code, it raises an exception before changing anything. Then: new enums, new
   values on `JewellerySequenceType` and `FinishedJewelleryStockStatus`, six new
   tables, nullable/defaulted columns on `finished_jewellery`, `jewellery_jobs`
   and `jewellery_receipts`, and the insert of account 1340.
2. `20261005090100_customer_gold_voucher_types` — two `VoucherType` values.
3. `20261006090000_customer_gold_receipt_reversal` — `RECEIPT_REVERSED`,
   `JEWELLERY_RECEIPT_REVERSAL_IN`, nullable reversal columns on
   `jewellery_receipts` and `jewellery_packet_resolutions`, two unique indexes,
   two foreign keys.
4. `20261007090000_old_gold_exchange` (Phase 8C) — nullable
   `customer_gold_receipts.statedPurity`; on `customer_gold_purchases`: nullable
   unique `customerGoldReceiptId`, `status` (default `POSTED`) and nullable
   reversal columns, three unique indexes, three foreign keys.

No existing row, column type or constraint changes; no backfill. With all four
the database has 29 migrations.

## 5. Limitations (this version)

* Mixed jobs: Company gold is allocated to the job in advance (§2.3); a
  receipt never allocates Company gold at receipt time on a Customer-gold job.
  This is the defined workflow, not a gap.
* Only Customer Gold receipts posted by this version are reversible (they carry
  the reversal record); Company receipts and older receipts are not (as before).
  A Customer Gold receipt that returned Company metal to stock/scrap is not
  reversible either — its Company side is corrected through Corrections.
* A purchase/exchange can be reversed by the Owner (Phase 8C) only while
  nothing depends on it: no later Company movement or posted revaluation of
  that metal and purity, its credit not applied to a bill, the Customer not
  paid against it. Otherwise the dependent entry is reversed first; a
  corrected value is a reversal followed by a new exchange.
* Old Gold intake stays Owner-only; Staff record no intake and see weights only.
* The one-step exchange buys the whole intake; buying part of the Customer's
  safe balance remains the separate "Buy from safe balance" purchase.
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
* Printable pages: `/customer-gold/receipt/[id]` (acknowledgment; shows the
  stated purity and, for an exchange, the purchase), `/customer-gold/statement/[customerId]`
  and (Owner only) `/customer-gold/purchase/[id]` (purchase/exchange
  acknowledgment with rate, value, settlement, approval and any reversal).
* Phase 8C: "Purchase/exchange gold from Customer" opens the one-step Old Gold
  Exchange form; the purchase list shows status, reference and the intake, with
  the Owner's acknowledgment link and reversal check/confirm; an Owner-only
  credit card shows credit given, applied and still available.
* Job page: gold source panel (Customer / Company via Karigar Metal /
  historical direct / combination), Owner mix approval, Customer pieces, bill
  (Owner) and delivery (Owner or Staff) with reversals (Owner).
* Receive Finished Jewellery: "Gold source" selector with a Customer-owned
  mode — Customer returns/scrap (and Owner-only authorised loss), Customer
  share on mixed jobs, a mandatory stale-checked preview.
* Every money figure is read from the database only for the Owner.

## 7. Release plan (historical — executed for 027a8a2; see `OPERATIONS.md` for the current release)

1. Preflight: branch ancestry on origin/main, clean tree, current production
   commit and public IP re-checked, read-only production checks.
2. Maintenance ON (established firewall rule), fresh `pg_dump` backup,
   restore-test, fingerprint.
3. `prisma migrate deploy` of the three additive migrations **before** the code
   (`20261005090000_customer_gold`, `20261005090100_customer_gold_voucher_types`,
   `20261006090000_customer_gold_receipt_reversal`). Verify 28 migrations, account 1340 present, `scripts/metalLedgerReconcile.sql`
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
