# ZYNORALUXE ERP — Operations reference (current)

Living document for whoever releases, checks or supports the system. Older
`PHASE_*_VERIFICATION.md` files are historical records.

## 1. What is live and what is waiting

| Area | Commit | State |
|---|---|---|
| Accounting, Diamond, Jewellery Jobs, Costing, Finished Sales (Phases 1–7) | ≤ `6cb6c07` | live |
| Phase 8A corrections, revaluation, adjustment accounting, read-path cost replay | `88921c9`…`9e820da` | live |
| Parcel partial issue, stone→parcel, missing receipt charges, job status repair, job-to-job transfer, packet stock summary, photo upload fixes | `610d310`…`554f4e7` | live |
| Karigar Metal custody, receipt-time allocation, Staff receipt against Karigar balance | `8f7fbc5`, `1aaee32`, `9e742f3` | live |
| Job manufacturing total, Customer Gold, receipt-charge persistence | `adba980`, `027a8a2`, `9a2eff7` | live |
| Phase 8B / 8C (Old Gold Exchange, migration 29), stickers, performance, Help | ≤ `1a10aec` | live (2026-10-02) |
| Processed-rough batch return (4P / Laser) | `dd477b5` | live (2026-10-05) |
| Owner "Correct entry" framework (+ migration 30) — see `CORRECTIONS_MATRIX.md` | `1ea7c27`…`4b71cab` | live (2026-10-06) — **production = `4b71cab`, 30 migrations** |
| Payment balances: a second payment in an open form, refresh loop, advance labels, IST dates — see `PAYMENT_BALANCE_AUDIT.md` | `f3f9238`, `d7b1a75` | live (2026-10-11) — **production = `d7b1a75`, 30 migrations** |
| Cash & Bank Book, Receivable & Payable (લેવાનું / આપવાનું), party summary, voucher page — see `CASH_BANK_BOOK.md` | `b4aca43`, `366e5ce` | live (2026-10-11) — **production = `366e5ce`, 30 migrations** |
| Clearing settlement (marketplace / provider payouts, reserve, FX, reclassification, audited sale gross-up) — see `CLEARING_SETTLEMENT_DESIGN.md` | `5522fb1` | live (2026-10-12) — **production = `5522fb1`, 31 migrations**; nothing posted by the release (ETSY not marked clearing, `SAL/2026-27/0003` not yet grossed up) |
| Job list filters + labels, Staff piece-wise Customer billing, Customer Account finished jewellery, Other Material stock, Diamond-only Sale — see `JOB_LIST_BILLING_MATERIAL_DIAMOND_SALE.md` | `dfd5196`…`02ca557` (branch `feature/job-list-billing-materials-diamond-sale`) | **not deployed** — needs migrations 32–34 |

## 2. Migrations

34 in `prisma/migrations/` on the job-list branch; production has 31. The three new ones
are additive and must be applied **before** the code, in order:

| # | Migration | sha256 (LF) | What it adds |
|---|---|---|---|
| 32 | `20261015090000_customer_bill_pieces` | `9b5014348e8c7ff98b01d8e5cc59d399dbea862e4ef7f558cf7b9e201ba4ba9e` | table `customer_jewellery_bill_pieces` (UNIQUE `activeFinishedJewelleryId` + CHECK: one live bill per piece) |
| 33 | `20261015090100_other_material_stock` | `8165b93dcc62e90b5a971076bcd78f74e87d304bc126e600970ae612646a8922` | 6 Other Material tables, `jewellery_jobs."stockMaterialWipCost"` and `finished_jewellery."materialCost"` (default 0), 3 sequence values, guarded account **1230** Other Material Inventory |
| 34 | `20261015090200_diamond_sale` | `890c6b82c1f97954ede92625e7824107963460c135ee70b1c77616ea2e174946` | `diamond_sales`, `diamond_sale_lines` (CHECK: exactly one stone or packet), `diamond_sale_returns`; enum values (stone SOLD, sale / cancel / return movements, sequences); guarded account **5210** Polished Diamond Cost of Sales |

Rehearsed on a restore of `zynoraluxe-prod-20261012T083905-release-5522fb1-pre-migration.dump`
with migrations 31–34 (production's real path):

* **Unchanged:** all 69 pre-existing tables are byte-identical. The comparison leaves out
  only the three new defaulted columns.
* **Changed:**
  * `accounts` +13 (11 from migration 31, plus 1230 and 5210);
  * `_prisma_migrations` +4;
  * 15 new empty tables.
* **Checks:**
  * no drift;
  * a second deploy is a no-op;
  * every reconciliation line (section 3) is 0.00;
  * the recorded checksums equal the table above.

The 31st,
`20261012090000_clearing_settlement` (checksum
`784fffad7debf8d7a4b89608d8db9b6ddf4337db3dcf273fbb27490698adf46e`, LF), is additive:
a guard that refuses any conflicting account code, 7 new enums, 4 VoucherType values
(`ADD VALUE IF NOT EXISTS`: CLEARING_SETTLEMENT, CLEARING_RESERVE, CLEARING_RECLASS,
CLEARING_GROSSUP), `parties."clearingEnabled"` (default false), 5 new tables
(`clearing_documents` carries a posting `sequence`, the corrected sale, the gross amount
and the CA's tax confirmation), 11 system accounts (1150, 1160, 1170, 1180, 4300,
5600–5650) and 13 default line mappings. Rehearsed on a restore of the 2026-10-11
production backup: 67 of 69 tables byte-identical, `accounts` +11 rows,
`_prisma_migrations` +1, 0 of 22 parties flagged, no drift, second deploy a no-op.
Apply it **before** the code.

The 30th, `20261008090000_entry_corrections`, only adds 8 enum values
(`StockMovementType`: ROUGH_COUNT_CORRECTION_IN / _OUT, ROUGH_RETURN_REVERSAL_OUT,
ROUGH_CONSUMED_REVERSAL_IN; `JewellerySequenceType`: ENTRY_CORRECTION;
`CorrectionMode`: ENTRY_METADATA, ENTRY_QUANTITY; `CorrectionImpactKind`: RECORD).
No table, column, index or row changes. Checksum
`85582344a32c098b0199282ef85ee70222e419de4b1691d29e73a2468c03337d` (the file is kept
LF by `.gitattributes`, so a Windows checkout records the same checksum).

Rehearsed on a restore of `zynoraluxe-prod-20261005T123341-release-dd477b5-pre-deploy.dump`
on the scratch cluster: all 68 tables byte-identical (every column), exactly the 8
values added and none removed, metal reconciliation output identical, no schema
drift, second deploy a no-op.

Apply the migration **before** the code: the new code writes the new values.

## 3. Reconciliation (run read-only, expect every difference 0.00)

`scripts/metalLedgerReconcile.sql` runs inside `begin transaction read only` and
prints `code|ledger|records|difference`:

| Line | Ledger | Records |
|---|---|---|
| 1300 Metal Inventory | account balance | usable stock of every metal + purity (+ posted revaluations) |
| 1310 Scrap Metal | account balance | scrap stock |
| 1320 Jewellery WIP | account balance | open jobs' metal/alloy WIP + unresolved stones + unallocated Karigar custody |
| 1330 Finished Jewellery | account balance | AVAILABLE Company pieces at authoritative cost |
| 1340 Customer Jewellery | account balance | Company cost in Customer-owned pieces awaiting delivery |
| 1230 Other Material (after migration 33) | account balance | Σ Other Material stock movements at cost (purchased − issued + returned − cancelled) |
| CGCR Customer gold credit | AP on purchase/exchange vouchers (+ reversals) and bills' credit-applied lines (+ reversals) | approved value of live purchases − credit applied by live bills |

Also check: no voucher with Σdebit ≠ Σcredit; Customer Gold tab "Difference"
0.000 g.

## 4. How the business flows work now

* **Company gold to jobs**: the Owner issues metal to a Karigar (Karigar Metal);
  the receipt takes what the job needs from that Karigar's balance (receipt-time
  allocation, previewed). Gold is no longer issued straight to a job (code path
  kept only for historical data and tests). Silver, platinum, Copper/Alloy,
  diamonds and packets are still issued with Issue Materials.
* **Rates**: Metal Purchase and Opening Metal Stock state the rate basis
  (per gross gram / per fine gram / fixed total); the server re-derives a
  rate-based total and refuses a mismatch unless the total is marked manual.
  Opening stock records the basis in the entry description and the ₹ rate on
  the Owner-only voucher.
* **Receipt charges**: five charges (labour, making, setting, plating, other)
  are submitted from the form state, so a collapsed section still saves them;
  Preview echoes them and, for the Owner only, shows the exact voucher from a
  rolled-back dry run.
* **Customer Gold**: Customer-owned gold is never Company stock or cost.
  Finished Customer pieces carry the Company's own cost in **1340** until
  delivery (Dr 5200 / Cr 1340 on delivery). Bills never bill the Customer's
  gold; purchase credit can be applied in part.
* **Old Gold Exchange (8C)**: one Owner-approved step records the intake
  (stated vs tested purity, deduction, photo) and buys exactly that gold into
  Company stock (Dr 1300 / Cr 2000 Customer), once. Reversal is audited and
  blocked while anything depends on it.
* **Stickers**: `/stickers` prints saved pieces only, never cost, and writes
  nothing.

## 5. Release order

The job-list / billing / Other Material / Diamond Sale release (migrations 32–34, then code)
needs the Owner's explicit approval first; nothing has been pushed or migrated.

1. **Pre-checks, read-only.** Verify `origin/main` and Vercel Production are still
   `5522fb1` and the branch fast-forwards it. Check identity, 31 migrations, no
   unbalanced voucher, reconciliation (section 3, five lines + CGCR).
2. **Maintenance and backup.** Maintenance on. Take a fresh `pg_dump`, restore-test it on
   the scratch cluster, and fingerprint every table.
3. **Migrate.** Print `DATABASE_URL` / `DIRECT_URL` and confirm the production project.
   Run `prisma migrate deploy` (32, 33, 34) and compare the three checksums with
   section 2.
4. **Re-fingerprint.** Every pre-existing table must be identical (ignoring the two new
   defaulted cost columns), apart from `accounts` +2 (1230, 5210) and
   `_prisma_migrations` +3.
5. **Deploy the code.** Fast-forward push, then wait for Vercel Production Ready at the
   new SHA.
6. **Read-only smoke test — post nothing:**
   * The Jewellery Jobs list shows Customer / Karigar / Gold source on each row, and its
     filters work.
   * Customer Account → Finished Jewellery lists the Customer's pieces.
   * The Other Material tab shows the 1 legacy manual line.
   * The Diamond Sales tab lists the available stones.
   * Staff see no cost.
7. **Close.** Run the reconciliation again; it now includes 1230, which must be 0.00.
   Maintenance off.

Rollback: code to `5522fb1` is safe only until the first piece-wise bill, Other Material
purchase or Diamond Sale is posted (the old code ignores those rows). Never roll the
migrations back.

The clearing-settlement release (migration 31, then code) — executed 2026-10-12:

1. Verify `origin/main` and Vercel Production are still `366e5ce` and the branch
   fast-forwards it. Read-only checks: identity, 30 migrations, no unbalanced voucher,
   reconciliation (section 3).
2. Maintenance on (Vercel Firewall rule `MAINTENANCE`, operator); fresh `pg_dump`;
   restore-test it on the scratch cluster; fingerprint every table.
3. Print `DATABASE_URL` / `DIRECT_URL` (Prisma CLI reads `DIRECT_URL`) and confirm the
   production project; `prisma migrate deploy` (31st only); check its checksum.
4. Re-fingerprint: every pre-existing table identical except `accounts` (+11) and
   `_prisma_migrations` (+1); every party `clearingEnabled = false`.
5. Fast-forward push; wait for Vercel Production Ready at the new SHA.
6. Read-only smoke: Dashboard Receivable / Payable unchanged; Cash & Bank Book Bank
   ₹12,599; Settlements tab shows no provider (nothing is marked clearing). **Post
   nothing** — marking ETSY clearing and the `SAL/2026-27/0003` gross-up (receipt
   reclassification + ₹4,991 gross-up + ₹17,590 settlement, one preview, one
   transaction) are the Owner's decisions afterwards, and the gross-up needs the CA's
   GST decision first (`CLEARING_SETTLEMENT_DESIGN.md`, "Gross-up").
7. Reconciliation again; maintenance off.

The payment-balance fix (code only) followed `PAYMENT_BALANCE_AUDIT.md` section 5.
The Correct-entry release below was executed on 2026-10-06 and is kept for reference.

### 5a. Correct-entry release (executed 2026-10-06)

1. Verify `origin/main` and the live Vercel deployment are still `dd477b5`, and the
   branch is a fast-forward of it.
2. Read-only production checks: identity, 29 migrations, reconciliation (5 lines +
   CGCR), no unbalanced vouchers.
3. Maintenance on; fresh `pg_dump`; restore-test it on the scratch cluster;
   fingerprint every table.
4. `prisma migrate deploy` (30th migration) — before the code. Print and check
   `DIRECT_URL` first (Prisma CLI reads only `DIRECT_URL`).
5. Re-fingerprint: every table identical; 30 migrations; recorded checksum = the
   one in section 2.
6. Fast-forward push; wait for Vercel Production Ready at the new SHA.
7. Read-only checks, **no correction posted by the release itself**: Owner opens
   ZL-JOB-2026-000010 → "Correct entry" on ZL-REC-2026-000010 must show
   *Blocked: ZL-JOB-2026-000011*; Close without confirming. Staff sees no
   "Correct entry" and no ₹.
8. Reconciliation again; maintenance off.
9. Afterwards the Owner decides and posts the real correction (`CORRECTIONS_MATRIX.md`
   names the correctable receipt).

## 6. Rollback limits

* Job-list release: see section 5 — fix forward once the first new-type document is posted.

* Clearing release: code rollback to `366e5ce` is safe only until the first clearing
  posting (party flag, settlement, reserve move, reclassification). Never roll the
  migration back.

* Never roll the schema back: enum values cannot be dropped safely and the
  migrations are additive.
* Code rollback to `dd477b5` is safe only **until the first Correct-entry
  correction is posted**. After that the old code would show a reversed receipt as
  live and does not know the new movement types or correction modes. Fix forward.
* Restore a backup only if data was damaged, and only after a fresh backup of
  the damaged state.

## 7. Runbooks

The release/reset runbooks used for earlier releases are **pinned to old
commits and must not be reused** — they would verify the wrong SHAs and
migration counts, and the reset scripts wipe business data:

| File (untracked, in old worktrees) | Pinned to | Status |
|---|---|---|
| `zynoraluxe-erp-rough-convert/scripts/customerGoldReleaseRunbook.ps1` | `027a8a2`, 28 migrations | used; UNSAFE to reuse |
| `zynoraluxe-erp-rough-convert/scripts/custodyReleaseRunbook.ps1` | `8f7fbc5` | UNSAFE |
| `zynoraluxe-erp-rough-convert/scripts/incrementalReleaseRunbook.ps1` | `554f4e7` / `7d5ef86` | UNSAFE |
| `zynoraluxe-erp-rough-convert/scripts/labourReleaseRunbook.ps1` | `2506d91` | UNSAFE |
| `zynoraluxe-erp-rough-convert/scripts/productionResetRunbook.ps1` + `productionBusinessReset.sql` | `8f7fbc5` | UNSAFE — wipes business data |
| `zynoraluxe-erp-receipt-charges/scripts/productionReleaseRunbook.ps1` + `_reviewOnly_*.sql` | `554f4e7` | UNSAFE — includes a business-data reset |

No new runbook script was written for this release; section 5 is the reviewed
checklist. Any new runbook must never reset, seed or alter production data
unless the Owner explicitly asks.

## 8. Known limitations

* Payments are not allocated to individual bills or invoices: balances are
  party-level, with the receivable (1100) and payable (2000) sides kept apart. A bill's
  "billed after credit" is what was due on the bill date; what is owed now is the
  party balance. An overpayment stays as an **Advance paid** (Supplier/Karigar)
  or **Customer credit** — it is never forced to zero.
* Finished Stock lists up to 500 pieces without paging (its summary and CSV use
  the whole list).
* Sticker reprints are not audit-logged (there is no general audit table).
* QR codes on stickers point at the host that printed them.
* Diamond Sale returns are whole lines only (no partial packet-line return); Other
  Material purchases cannot be edited (Owner cancels while nothing is issued, then
  re-enters); the job list shows the newest 300 matches.
* "Correct entry" covers details, processed-rough returned pieces and processed-rough
  receipt reversal. Polished receipts and Company jewellery receipts cannot be
  reversed; see `CORRECTIONS_MATRIX.md` for every type.
