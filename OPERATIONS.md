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
| Payment balances: a second payment in an open form, refresh loop, advance labels, IST dates — see `PAYMENT_BALANCE_AUDIT.md` | branch `fix/payment-balance-refresh` | **not deployed** (code only, no migration) |

## 2. Migrations

30 in `prisma/migrations/`; production has all 30. The payment-balance fix adds
none. The 30th, `20261008090000_entry_corrections`, only adds 8 enum values
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

The payment-balance fix (code only) follows `PAYMENT_BALANCE_AUDIT.md` section 5.
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

* Payments are not allocated to individual bills or invoices: a party has one
  running balance (Debit − Credit of Accounts Receivable + Payable). A bill's
  "billed after credit" is what was due on the bill date; what is owed now is the
  party balance. An overpayment stays as an **Advance paid** (Supplier/Karigar)
  or **Customer credit** — it is never forced to zero.
* Finished Stock lists up to 500 pieces without paging (its summary and CSV use
  the whole list).
* Sticker reprints are not audit-logged (there is no general audit table).
* QR codes on stickers point at the host that printed them.
* "Correct entry" covers details, processed-rough returned pieces and processed-rough
  receipt reversal. Polished receipts and Company jewellery receipts cannot be
  reversed; see `CORRECTIONS_MATRIX.md` for every type.
