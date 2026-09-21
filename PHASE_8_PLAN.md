# ZYNORALUXE ERP — Phase 8 Plan

**Corrections, audited revaluation, and customer-owned metal.**

Additive upgrade on top of `main` @ `6cb6c07` (Phase 7 accepted). Nothing in
Phases 1–7 is rebuilt or rewritten. Branch: `phase-8-corrections-and-custody`.

Companion documents: `PHASE_8_REVALUATION_PREVIEW.md` (the production figures,
awaiting approval) and `PHASE_8_VERIFICATION.md` (written as tiers land).

---

## 0. Decisions required

**BLOCKING** items stop dependent work. Everything else has a default the Owner
can override.

| ID | Decision | Default | Blocks |
|---|---|---|---|
| **D1 — BLOCKING** | Approve the revaluation preview figures (₹1,91,664 allocated 90,703.81 / 50,822.05 / 50,138.14). | None — not applied | Any production correction |
| **D2 — BLOCKING** | Opening stock posts no journal entry at all (defect D-2). Fix forward for all future entries **and** post R1 for the existing one? | Fix forward; R1 only on approval | 8A ledger fix |
| D3 | Vouchers R1 and R2 separate, or one combined ₹3,51,664 voucher? | Separate — the two defects stay independently auditable | Preview posting |
| D4 | Customer custody balance may go negative when the piece consumes more fine gold than deposited (the 43.640 g case). | Allowed, shown as **customer owes**, blocks nothing | 8D |
| D5 | Account code for Customer Exchange Credit (old gold) | New system liability **2100 Customer Exchange Credit** | 8C |
| D6 | May Staff prepare correction drafts in every module, or only accounting? | Every module; Staff may never approve or post | 8A |
| D7 | Revaluing a finished piece that has already been **sold** (none today) | Blocked in 8A; needs an explicit COGS-correction path (8E, deferred) | — |
| D8 | 24K master is 100.000% while the opening snapshot is 99.900% | Keep both; snapshots are never retro-applied | 8B |

## 1. Defects this phase fixes

| ID | Defect | Found |
|---|---|---|
| D-1 | Opening gold valued ₹1,60,000 instead of ₹3,51,664 | Owner, 2026-09-21 |
| D-2 | `createOpeningMetalStock` posts **no journal entry**, leaving 1300 Metal Inventory negative | This audit |
| D-3 | No correction path for posted records outside vouchers/jobs — weights, rates, purity and party cannot be corrected at all | This audit |
| D-4 | No way to hold customer-owned metal separately from company stock | Owner requirement |

## 2. Tiers

### 8A — Correction framework core *(foundation; everything else depends on it)*

New models:

- `Correction` — `entityType`, `entityId`, `mode` (`EDIT_DRAFT` / `REVERSE_REPOST` /
  `REVALUE`), `state` (`DRAFT` / `AWAITING_APPROVAL` / `POSTED` / `REJECTED`),
  `reason`, `originalSnapshot` Json, `correctedSnapshot` Json, `impactPreview` Json,
  `preparedByUserId`, `approvedByUserId`, `postedAt`, `correctionVoucherId`,
  `idempotencyKey` unique, `supersedesCorrectionId`.
- `CorrectionImpact` — one immutable row per affected record:
  `correctionId`, `table`, `recordId`, `field`, `oldValue`, `newValue`, `kind`
  (`STOCK` / `WIP` / `FINISHED` / `PARTY` / `LEDGER` / `CUSTODY`).
- `MetalRevaluation` — links a revaluation to the exact movement/issue-line/
  finished-piece it uplifts, so originals stay untouched.

Engine (`src/lib/corrections/`):

- `dependencyProbe(entityType, entityId)` → every downstream record, per module.
- `planCorrection()` → the impact preview (stock, WIP, finished goods, party
  balances, exact Dr/Cr), computed without writing.
- `postCorrection()` → atomic, idempotent, Owner-only; writes compensating
  records only.
- `verifyAfterCorrection()` → stock quantities, fine weights, custody balances,
  party balances, and debit = credit for every touched voucher.

Also in 8A: **D-2 fix** — opening metal stock posts `Dr 1300 / Cr 3000` inside the
same transaction, with a migration-safe path for databases that already have
unposted opening movements.

### 8B — Metal entry forms and history

Opening Metal Stock and Metal Purchase forms show gross weight, purity and
fineness snapshot, fine weight, rate basis, rate per gram, and the calculated
total with both effective rates, behind an explicit confirmation step.
Searchable Opening Stock and Adjustment History with correction links.
Purity master edits affect future transactions only (already true in the engine;
8B adds the UI warning and a regression test).

### 8C — Old Gold Exchange (ownership transfers to the business)

`OldGoldExchange` + lines: party, receipt number, date, description, photos,
gross weight, non-metal deduction, net metal weight, tested purity and fineness
snapshot, fine weight, rate basis, accepted rate and value, notes,
acknowledgement. Posts `Dr 1300 Metal Inventory / Cr 2100 Customer Exchange
Credit`; the metal joins the company weighted-average pool. Credit is applied
partially or fully against a Jewellery Sale receivable; unused credit is shown
separately on the party ledger.

### 8D — Customer Metal Deposit (ownership stays with the customer)

`CustomerMetalDeposit` and an immutable `CustomerMetalCustodyMovement` ledger
keyed by customer + metal + purity, balances in fine grams with gross weight and
purity snapshots retained. Movements: `DEPOSIT_IN`, `ISSUE_TO_JOB`,
`SET_IN_FINISHED`, `RETURN_OUT`, `SCRAP_OUT`, `LOSS_CONFIRMED`.

Rules enforced in the engine, not only the UI: customer metal never enters
company inventory, assets, COGS or the weighted-average pool; deposit metal may
be issued only to a Jewellery Job for **that same customer**; finished costing
excludes customer gold but includes business diamonds, alloy, labour, making,
setting, plating and other costs. Printable deposit receipt and final
reconciliation statement. The worked example (100.000 g deposited, 189.000 g net
18K at 76% = 143.640 g fine consumed, 43.640 g owed, 45.360 g alloy tracked
separately) becomes a locked regression test.

### 8E — Universal correct/reverse surface and acceptance

`Edit Draft` / `Correct Entry` / `Reverse Entry` / `View Correction History` on
every module listed in the brief, driven by one shared component against the 8A
engine, with Gujarati-friendly validation and confirmation copy. Correction
History page. Full E2E, reconciliation and `PHASE_8_VERIFICATION.md`.

## 3. Module correction matrix

For each: does a draft state exist, what counts as downstream use, and what the
correction mode is once posted.

| Module | Draft? | Downstream use | Posted correction |
|---|---|---|---|
| Voucher (purchase/sale/payment/receipt/expense) | No | Settlement, party balance, linked purchase | Reverse + repost (exists) → wrap in `Correction` |
| Party opening balance | No | Any voucher against the party | Reverse + repost |
| Metal opening stock | No | Any issue drawing on the pool | **Revalue** (never reverse — the pool is fungible) |
| Metal purchase | No | Pool consumed by an issue | Revalue if consumed, else reverse |
| Metal adjustment | No | Same | Revalue |
| Rough/polished diamond purchase | No | Lot issued to a job, packet movement | Reverse if untouched, else revalue |
| Packet / packet movement | No | Issued to a job, merged, processed | Owner reversal workflow first |
| Manufacturer / Job Manufacturer job | Yes (DRAFT) | Receipt posted | Cancel (exists) or revalue |
| Jewellery Job issue | Yes (DRAFT) | Receipt posted | Cancel (exists) or revalue |
| Jewellery receipt | No | Finished piece, sale | Reverse if unsold, else revalue |
| Finished jewellery | No | Sold | Revalue; sold pieces need D7 |
| Customer deposit / exchange | No | Issued to a job, credit applied | Reverse if unused, else revalue |
| Masters (purity, process, GST, accounts) | n/a | Every historical snapshot | Future-only edit; snapshots immutable |

## 4. Invariants (asserted by tests, not only by review)

1. No original ledger movement, voucher, journal entry or snapshot is ever
   updated or deleted by a correction.
2. Every correction stores original value, corrected value, reason, Owner,
   timestamp and a linked reference.
3. Correction posting is atomic — it completes fully or changes nothing.
4. Correction posting is idempotent under duplicate and simultaneous submission.
5. Only an Owner may approve or post; Staff may prepare a draft.
6. After posting: stock quantities, fine weights, custody balances and party
   balances re-verify, and every affected voucher has debit = credit.
7. Customer-owned metal never appears in company stock, assets or COGS.
8. One customer's deposit can never reach another customer's job.
9. The gold ledger carries gold fine weight only — no stone, alloy or other
   material weight enters a gold consumption figure.

## 5. Test plan

Vitest: draft edit; posted reversal and corrected repost; downstream
revaluation; Owner/Staff permission on every new action; exact money and weight
arithmetic; weighted-average costing across revaluation; exchange credit partial
application; deposit partial usage and remaining balance; purity conversion;
multiple deposits; returned metal, scrap and confirmed loss; correction of a
closed job; duplicate and simultaneous submission; cross-customer and
company/customer mixing refusals; balanced vouchers; full stock reconciliation.

Browser E2E on Chromium, desktop and mobile, Owner and Staff, against the
isolated test database only (`zynoraluxe_phase7_test` as
`zynoraluxe_phase7_user`). Production is never used for tests.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A correction framework that touches 12 modules can silently change Phase 1–7 posting | Corrections only ever *add* compensating records; the existing posting functions are not modified except the D-2 opening fix |
| Revaluation arithmetic drifting from the engine's rounding | Revaluation reuses `round2`/`round3` and the same allocation helpers; the preview is a locked regression fixture |
| Customer metal leaking into the company pool | Ownership is a column on the movement, and the pool query filters on it; a test asserts the pool total is unchanged by any custody movement |
| Scope: five subsystems in one phase | Tiers 8A–8E land and are verified independently; 8A must be green before 8B–8E start |
