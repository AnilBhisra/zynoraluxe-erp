# ZYNORALUXE ERP — Operations reference (current)

Living document for whoever releases, checks or supports the system. Older
`PHASE_*_VERIFICATION.md` files are historical records.

## 1. What is live and what is waiting

| Area | Commit | State |
|---|---|---|
| Accounting, Diamond, Jewellery Jobs, Costing, Finished Sales (Phases 1–7) | ≤ `6cb6c07` | live |
| Phase 8A corrections, revaluation, adjustment accounting, read-path cost replay | `88921c9`…`9e820da` | live |
| Rough/polished parcel partial issue, stone→parcel, missing receipt charges, job status repair, job-to-job transfer, Complete reconciled job, packet stock summary, photo upload timeout/size | `610d310`…`554f4e7` | live |
| Karigar Metal custody, receipt-time allocation, Staff receipt against Karigar balance | `8f7fbc5`, `1aaee32`, `9e742f3` | live |
| Job manufacturing total, Customer Gold (incl. receipt reversal), receipt-charge persistence | `adba980`, `027a8a2`, `9a2eff7` | live (production = `9a2eff7`, 28 migrations) |
| Phase 8B metal-rate clarity + Metal Stock history | `d013945` | **not deployed** |
| Phase 8C Old Gold Exchange (+ migration 29) | `5761149` | **not deployed** |
| Finished-piece stickers (+ fixes `8b06011`, `7719c9e` found in browser acceptance) | `5593109` | **not deployed** |
| Performance (N+1 / serial reads) | `0989f49` | **not deployed** |
| In-app Help (Gujarati) / documentation | `9e964e6`, this commit | **not deployed** |

## 2. Migrations

29 in `prisma/migrations/`. Production has the first 28. The 29th,
`20261007090000_old_gold_exchange`, is additive only (nullable columns, one
column with default `POSTED`, unique indexes, foreign keys); it rewrites no
row. It was rehearsed on a restored copy of the latest backup and on a copy
holding purchases posted by the live code: every pre-existing table
byte-identical outside the new columns, reconciliation unchanged, a second
deploy a no-op.

Apply migrations **before** the code that reads them: the new code reads
`customer_gold_purchases.status`.

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

## 5. Release order for the next release (not executed)

1. Verify `origin/main` is still `9a2eff7` and the branch is a fast-forward of it.
2. Read-only production checks: identity, 28 migrations, reconciliation (5 lines + CGCR), no unbalanced vouchers.
3. Maintenance on; fresh `pg_dump`; restore-test it on the scratch cluster; fingerprint every table.
4. `prisma migrate deploy` (29th migration) — before the code.
5. Re-fingerprint: every pre-existing table identical outside the new columns; 29 migrations; reconciliation unchanged.
6. Fast-forward push; wait for Vercel Production Ready at the new SHA.
7. Owner and Staff read-only checks (no test postings on real data): Metal Stock history, Karigar Metal, Customer Gold, a job page, a sticker preview; Staff sees no ₹.
8. Reconciliation again; maintenance off.

## 6. Rollback limits

* Never roll the schema back: the migrations are additive and the data written
  after them would be lost.
* Code rollback to `9a2eff7` is safe only **until the new code has posted an
  Old Gold Exchange or reversed a purchase**: the old code does not read the
  purchase `status`, so it would show a reversed purchase as live and mis-state
  the Customer's credit. After that point, fix forward.
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

* Finished Stock lists up to 500 pieces without paging (its summary and CSV use
  the whole list).
* Sticker reprints are not audit-logged (there is no general audit table).
* QR codes on stickers point at the host that printed them.
* 8E's single shared "Correct / Reverse" component for every module is not built.
