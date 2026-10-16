# Job list filters, Staff billing, Customer finished jewellery, Other Material stock, Diamond-only Sale

Design and verification record for the brief `JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md`
(2026-10-15). Five commits on branch `feature/job-list-billing-materials-diamond-sale` (worktree
`zynoraluxe-erp-jobs`), on top of production `5522fb1`. Three additive migrations
(32–34). For the release steps, see `OPERATIONS.md` section 5.

| Part | Commit | Migration |
|---|---|---|
| 1. Job list: Customer / Karigar / Gold-source filters and labelled rows | `dfd5196` | — |
| 2. Staff Customer billing, piece by piece, one live bill per piece | `27424d2` | 32 `20261015090000_customer_bill_pieces` |
| 3. Customer Account → Finished Jewellery section | `e0206e2` | — |
| 4. Other Material: purchased stock before any job can use it | `421c09f` | 33 `20261015090100_other_material_stock` |
| 5. Diamond-only Sale (loose stones and packets) | `02ca557` | 34 `20261015090200_diamond_sale` |

## 1. Job list filters and labels

**Root cause:** the list showed only the job code, status and item. It had no Customer or
Karigar name, no gold source and no filters, so jobs for different Customers looked the
same.

* Each row shows: Customer (or "No customer selected"), Karigar and Gold source. The Owner
  also sees the job total.
* Filters are Customer, Karigar (typed name picked from a list), Gold source and Search.
  Search covers the job code, design name, receipt code, finished code and item type.
  All filters live in the URL (`jobCustomer`, `jobKarigar`, `goldSource`, `jobSearch`),
  so a reload or a shared link keeps them, and the job detail's Back link returns to the
  same filtered list. The list shows up to 300 jobs, with the count shown; "Clear
  filters" resets it.
* **Gold source is derived only from movement records** (`jobGoldSource.ts`, one SQL for
  the whole page), never from the job's Customer field or from notes:
  * The Customer contribution is Customer-gold entries into the job, finished pieces,
    scrap or loss, minus entries released back. Reversed entries and reversal entries
    are ignored.
  * The Company contribution is the job's GOLD issue lines minus active Karigar Metal
    releases.
  * Labels: Customer, Company, Mixed, No Gold, Review required. "Review required" means
    the records cannot tell: a Customer-owned piece with no Customer gold recorded, or a
    live receipt with no metal recorded at all. Silver and platinum jobs are "No Gold". A
    cancelled job is "No Gold".
* Checked on a restore of the production backup: 18 jobs → 4 Customer, 2 Company,
  12 No Gold (3 completed silver jobs, plus drafts / jobs with no metal yet), 0 Review.

## 2. Staff Customer billing

**Root cause:** "Bill the Customer" was Owner-only and billed the whole job at once, so a
Staff user could not bill, and a job could not be billed piece by piece.

* Owner or Staff can preview and post a bill. Only the Owner can reverse one.
* The bill lists the job's Customer-owned pieces as checkboxes; a piece already on a live
  bill shows its bill code and is disabled.
* **One live bill per piece is enforced in the database:**
  * Each bill line is a row in `customer_jewellery_bill_pieces`.
  * `activeFinishedJewelleryId` is UNIQUE, and a CHECK constraint makes it either null or
    the line's own piece.
  * Reversing a bill clears it, which frees the piece for a corrected bill.
* A bill posted before this release (no piece lines) still covers the whole job.
  Piece-wise billing of that job is refused until that bill is reversed.
* Safe re-submit: the preview fingerprint and an idempotency key (salted with the last
  saved bill code) mean a double-click posts once and a second bill from the same form is
  never mistaken for a repeat.
* Staff never receive the Company cost in the panel data.

## 3. Customer Account → Finished Jewellery

**Root cause:** the Customer Account showed only the money ledger; the Customer's pieces
were visible only job by job.

* Accounting → Ledger → a Customer shows every finished piece of **that Customer's** jobs.
  Each row has the code, job, receipt, purity, weights, ownership, billing status (bill
  code or "Create bill"), delivery status and location.
* Filters (`fj`): All, Ready for billing, Unbilled, Billed, Ready for delivery, Delivered,
  Receipt reversed. The summary also shows the Customer's gold pools.
* Customer A's page never lists Customer B's pieces (DB test and browser checked).

## 4. Other Material: purchase before issue

**Root cause:** a job could take "other material" as free text with a typed amount: no
stock, no Supplier payable, no check against what was bought, and the same material could
be paid for twice.

* **New masters:** an Other Material item has a code `ZL-OMI-…`, a name, a unit
  (PCS / CT / GRAM) and a category.
* **Purchase** (Owner or Staff), `ZL-OMP-…`:
  * Lines are quantity × rate per unit, computed with **exact BigInt arithmetic, shared by
    the browser and the server**. The server never trusts a typed amount. Example: 200 CT
    × ₹50 = ₹10,000.00.
  * Discount and GST work as on other purchases.
  * Posting: Dr 1230 Other Material Inventory (+ input GST) / Cr the Supplier (2000).
    Paying the Supplier is an ordinary Payment Given.
* **Issue to job and return** (Owner or Staff), `ZL-OMJ-…`:
  * Material comes from stock at its carrying cost; issuing more than is in stock is
    refused.
  * Posting: Dr 1320 / Cr 1230 (a return reverses it).
  * The job holds `stockMaterialWipCost`.
  * Issue Materials uses the same stock picker; free-text material lines are refused.
* **At receipt:** the job's material cost drains into the pieces by fine weight
  (`FinishedJewellery.materialCost`). It is part of the authoritative piece cost
  (metal + diamonds + labour + material) everywhere: carrying cost, sales COGS, reports,
  custody reports, Customer delivery and the reconciliation.
* **Karigar-supplied material:** recorded on the receipt as description, quantity and
  charge. It is not Company stock, and its charge is part of the receipt's other expense,
  payable to the Karigar exactly once.
* **Owner-only actions:**
  * Cancel a purchase. This is refused while any of it is still issued.
  * Reverse an issue or return, newest first.
  * A job cannot be cancelled while it holds material.
  * The generic voucher cancel refuses Other Material purchases.
* **Legacy lines:** old free-text lines stay as they were and are listed read-only as
  "Legacy manual entries" (production has 1).
* **Reconciliation:** `scripts/metalLedgerReconcile.sql` and the Karigar custody report
  gain line **1230 = Σ stock movements at cost**. 1320 includes the material held by open
  jobs.

## 5. Diamond-only Sale

**Root cause:** a loose polished stone or packet could be sold only through a Jewellery
Job, or as a manual sale that left the stone "Available" and its cost in 1220.

* Diamond → **Diamond Sales** tab (Owner or Staff). Each line is an AVAILABLE stone, a
  whole packet, or part of a packet (pieces and carat). Taking every piece of a packet
  must also take every carat, and vice versa.
* Pricing per carat, per piece or fixed total; discount; GST extra or included; on credit,
  paid now, or marketplace clearing (1150 with foreign amount).
* The formula is shown live and in the preview, with the same text on both:
  `2.500 CT × ₹20,000.00/CT = ₹50,000.00`.
* **Posting** (one SALE voucher, `ZL-DS-…`):

  ```
  Dr 1100 AR / Cash / Bank / 1150      grand total
     Cr 4000 Sales                     taxable value
     Cr 700x Output GST                GST
  Dr 5210 Polished Diamond Cost of Sales   carrying cost
     Cr 1220 Polished Diamond Inventory    carrying cost
  ```

  A stone's cost is its `allocatedCost`. A packet line's cost is its carat share; the line
  that empties the packet takes the exact remainder, so nothing is left behind.
* **No double sale:**
  * A stone moves AVAILABLE → SOLD by one conditional update.
  * Packets are row-locked in a fixed order before their balance is read.
  * The preview fingerprint and the idempotency key make a re-submit safe.
  * Concurrent sales of the same stone or packet: exactly one succeeds (DB tests).
* **Owner only:**
  * **Cancel:** a mirror voucher, and every stone or packet quantity goes back. Refused
    once any line was returned.
  * **Customer return** of whole lines, `ZL-DSR-…`: Dr 4100 Sales Returns + GST / Cr AR or
    1150 (and the clearing entry), Dr 1220 / Cr 5210; the stock comes back.
  * The generic voucher cancel refuses Diamond Sale vouchers and every SALE_RETURN.
* **Reports:** the P&L has a "Polished diamond cost of sales" line, and gross profit
  subtracts it. Diamond sales are matched to their cost, so they are not counted as
  "manual" sales. The Sales report filters by kind: All, Jewellery, Diamond-only, Other.
* **Staff never receive** cost, COGS or gross profit in page data or action replies
  (`listDiamondSales({ includeCost })` and the preview action null them).

## Verification

**Automated tests** (disposable scratch cluster `:54329` only):

* **Full vitest:** 125 files / 1,500 tests. The one failure was a test that pins the
  `listVouchers` filter order; the sale-kind filter now comes last, and that suite passes
  again (10/10).
* **New suites:**
  * jobListFilters DB (12) and JobsTab.filters (10)
  * customerBillPieces DB (8)
  * customerFinishedJewellery DB (7)
  * otherMaterial DB (13) and otherMaterialAmounts (6)
  * diamondSale DB (9) and DiamondSalesTab (5)
* **Static checks:** tsc and eslint clean. `prisma validate` passes; status up to date; no
  drift. `git diff --check` clean. All three migrations are LF.

**Browser acceptance:**

* **Setup:** production build (`next start`) against the disposable DB
  `zynoraluxe_charge_jobsaccept`, seeded only through the app's posting functions.
  Owner and Staff, desktop 1366 px and Pixel 7.
* **Result:** 37 / 37 checks passed, twice from the same seeded dump. They cover:
  * filters and URL state;
  * Staff bills one piece and a double-click posts once;
  * Customer A / B isolation;
  * purchase amount auto-calculation;
  * a Staff material issue and the over-stock refusal;
  * the Staff diamond sale, the Owner packet sale and the Owner return;
  * the Sales-kind report and the P&L line;
  * no Staff cost in 85 captured HTML / RSC / action payloads;
  * no sideways scroll on any page;
  * a business-table fingerprint unchanged by browsing;
  * every voucher balanced.
* **Reconciliation afterwards:** 1220 = stones + packets; 1230, 1300–1340 differences
  0.00.

**Migration rehearsal:**

* **Base:** a restore of production backup
  `zynoraluxe-prod-20261012T083905-release-5522fb1-pre-migration.dump`, then migrations
  31–34 (production's real path).
* **Business tables unchanged:** all 69 pre-existing tables are byte-identical. The
  comparison leaves out only the three new defaulted columns: `clearingEnabled` and
  migration 33's two cost columns.
* **What did change:**
  * `accounts` +13 (11 from migration 31, plus 1230 and 5210);
  * `clearing_account_mappings` 13 (from migration 31);
  * `_prisma_migrations` +4;
  * 15 new empty tables.
* **Checks:**
  * no drift;
  * a second deploy is a no-op;
  * every line of `metalLedgerReconcile.sql` (1230, 1300–1340, CGCR) is 0.00;
  * the recorded checksums equal the files.

## Limitations

* The job list shows the newest 300 matches (the count says so); narrow the filters to
  see more.
* A diamond sale return is whole lines only. A partial-quantity return of a packet line is
  not supported; cancel and re-sell instead.
* An Other Material purchase cannot be edited; the Owner cancels it (while nothing is
  issued) and enters it again.
* The legacy free-text material line on production stays as it is; it is not converted
  into stock.
* Existing whole-job Customer bills keep covering their whole job; to bill such a job
  piece by piece, the Owner reverses the old bill first.
