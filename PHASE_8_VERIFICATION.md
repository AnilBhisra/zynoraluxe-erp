# ZYNORALUXE ERP — Phase 8 Verification

Branch `phase-8-corrections-and-custody`, built on `main` @ `6cb6c07`.
Every test ran against the isolated database `zynoraluxe_phase7_test` as
`zynoraluxe_phase7_user`. **Production was never used for tests, and neither
R1 nor R2 has been posted to production.**

---

## Tier 8A — Correction framework core: COMPLETE

### What shipped

| Area | Files |
|---|---|
| Schema | `Correction`, `CorrectionImpact`, `MetalRevaluation`, `CorrectionBatch` + 7 enums; `MetalStockMovement.voucherId` and `.idempotencyKey`; `Correction.reversedByCorrectionId`; `VoucherType.OPENING_STOCK` and `.CORRECTION`; `CorrectionState.REVERSED`; `MetalStockMovementType.SCRAP_ADJUSTMENT_IN/OUT` |
| Migrations | `20260921090000_phase8_correction_framework`, `20260921120000_phase8_correction_batch`, `20260921150000_phase8_adjustments_and_reversal`, `20260922090000_phase8_transfer_pair` |
| Correction UI | `src/components/corrections/CorrectionWorkbench.tsx` (impact preview, post, approve, reject), adjustment history with reversal in `MetalStockTab.tsx`, `src/lib/jewellery/adjustmentHistory.ts` |
| Operations | `scripts/reverseCorrectionBatch.ts` (Owner batch rollback, dry run by default) |
| Adjustments | `src/lib/jewellery/posting.ts` (`adjustMetalStock`, `reverseMetalStockAdjustment`), `src/app/actions/metal.ts`, `MetalStockTab.tsx`, `validation/jewellery.ts`, `prisma/phase8Masters.ts`, `scripts/seedPhase8Masters.ts` |
| Replay engine | `src/lib/corrections/metalReplay.ts` (pure; no I/O) |
| Correction engine | `src/lib/corrections/engine.ts`, `types.ts`, `verify.ts` |
| Opening-stock corrections | `src/lib/corrections/openingStockCorrection.ts` (R1 + R2 + re-plan) |
| Audit history | `src/lib/corrections/history.ts`, `src/components/corrections/CorrectionHistoryView.tsx`, `src/app/(app)/corrections/page.tsx` |
| Actions | `src/app/actions/corrections.ts` (preview / draft / post / approve / reject) |
| Opening-stock ledger fix | `src/lib/jewellery/posting.ts`, `src/app/actions/metal.ts`, `MetalStockTab.tsx`, `validation/jewellery.ts` |

### Defect D-2 fixed forward

`postOpeningMetalStock` now posts **Dr 1300 Metal Inventory / Cr 3000 Opening
Balance Equity** for the saved value, in the same transaction as the stock
movement, numbered `OPEN-STK/<FY>/NNNN`. The movement carries the unique
`idempotencyKey`, so a retry or double submit can create neither a second
movement nor a second voucher — proven on the real database, not by mocks.

A zero-valued opening entry still records stock and posts no voucher, because
there is nothing to debit.

### R1 and R2 are cumulative, not a replacement chain

`Correction.supersedesCorrectionId` means **replacement**: `approveCorrectionDraft`
sets the superseded correction's state to `REJECTED`, so it stops being live.
That is the wrong relationship for R1 and R2, which are both required and must
both stay posted.

They are linked instead through **`CorrectionBatch`** — a named batch with a
`requiredSteps` count, where each correction holds `batchId` and a 1-based
`batchStep`:

- The batch is `OPEN` until every required step is posted, then `COMPLETE`.
- Every step keeps `state = POSTED`; none is closed, rejected or superseded.
- `postCorrection` refuses to combine `batch` with `supersedesCorrectionId`,
  refuses a step number outside the batch, and refuses a step already posted
  (also enforced by a `@@unique([batchId, batchStep])` index).
- `verifyCorrectionBatch` treats the batch as one correction made of several
  required operations: all steps present, all still POSTED and active, none
  superseding or superseded by another step, batch state consistent, every
  step's voucher balanced, and the cumulative total reported.
- `planCorrectionBatchRollback` lists the steps newest-first with each
  voucher's status, and reports whether the whole batch is still reversible.

### Rules proven by tests

| Rule | Where |
|---|---|
| Original movement, value and fineness snapshot are never edited | `correctionFlow.db.test.ts` — re-read after R1, R2 and after rollback |
| Correction posting is atomic and idempotent | duplicate key leaves 1 movement / 1 voucher |
| Only an Owner may approve or post | `postCorrection` refuses `approverRole: "STAFF"`; `corrections.test.ts` proves `requireOwner` guards the action |
| Staff may prepare a draft that posts nothing | `saveCorrectionDraft` → `AWAITING_APPROVAL`, no voucher written |
| A stale preview can never post | `approveCorrectionDraft` re-plans and compares fingerprints |
| **R1 and R2 both stay POSTED and active** | batch suite: both `POSTED`, both `supersedesCorrectionId` null, nothing supersedes either, `rejectionReason` null |
| **The effect is cumulative, not one-or-the-other** | ledger equals R1 + R2, and explicitly equals neither alone |
| **History shows both as required steps of one batch** | `listCorrections` returns both with batch code, step and `COMPLETE` state |
| **Rollback treats them as one batch** | cancelling both vouchers newest-first returns 1300/1320/1330/3000 to zero, every voucher still balances, and both Correction rows survive |
| Weighted average is kept, not the newest purchase rate | `metalReplay.test.ts` — job 69 restates to ₹31,836.87, not ₹31,050 |
| Debit = credit for every voucher after a correction | `reconcileVoucherBalances` |
| 1300/1310 equal the metal stock value | `reconcileMetalInventory` |
| A sold piece is refused, not silently revalued | `openingStockCorrection.ts` guard (Owner decision D7) |
| Corrections stay Owner-only in the UI | `voucherVisibility.test.ts`, `nav.test.ts` |

The replay refuses rather than guesses whenever it meets a shape it cannot
reproduce exactly: a cancelled issue, a receipt whose finished pieces it cannot
load, or outputs whose fine weight does not match the consumed fine weight.

### Results

| Gate | Result |
|---|---|
| Vitest | **843 passed / 843**, 63 files (was 762 at `6cb6c07`) |
| New tests | 81 — 16 replay, 33 real-database flow, batch and rollback, 16 action/permission, 6 history view, 10 adjustment/reversal |
| Prisma | schema valid; all four migrations applied to the test database; status clean at 17 |
| TypeScript | `tsc --noEmit` clean |
| ESLint | clean, 0 errors 0 warnings |
| Production build | succeeds; `/corrections` routed |
| Reconciliation | 1300 vs stock value, 1310 vs scrap value, every voucher balanced — all OK |

Both database test suites live in one file because they assert on shared
account balances; Vitest runs files in parallel but tests within a file in
order.

Migrations are written with `prisma migrate diff --from-config-datasource` and
applied with `migrate deploy`, because the test role may not create the shadow
database `migrate dev` requires. Both are additive: new enums, new tables, new
nullable columns, no data change.

---

## Authorized Metal Stock Adjustment — IMPLEMENTED

`adjustMetalStock` used to change Metal Stock and post **no journal entry** —
the same defect class as D-2. It now writes its stock movement(s) and a
balanced `STOCK_ADJUSTMENT` voucher in one transaction, keyed by a unique
idempotency key.

### Accounts

Two new system accounts, created only if missing by `npm run db:seed-phase8-masters`
(and included in `db:seed`). **Opening Balance Equity is never used**: an
adjustment is this period's gain or loss, not opening capital.

| Code | Name | Type |
|---|---|---|
| 4200 | Inventory Adjustment Gain | INCOME |
| 5500 | Inventory Adjustment Loss | EXPENSE |

### Rules as built

| Case | Valuation | Entry |
|---|---|---|
| **IN, explicit value** | the Owner's value, but only after confirming it | Dr 1300 / Cr 4200 |
| **IN, quantity only** | the pool's carrying weighted average per gross gram, so the average is unchanged | Dr 1300 / Cr 4200 |
| **IN, quantity only, empty pool** | refused — there is no rate to use, so an explicit positive cost is required | — |
| **OUT** | **always** the pool's carrying weighted average; a user-entered OUT value is refused outright | Dr 5500 / Cr 1300 |
| **USABLE_TO_SCRAP** | the usable pool's carrying cost | Dr 1310 / Cr 1300 |
| **SCRAP_TO_USABLE** | the scrap pool's carrying cost | Dr 1300 / Cr 1310 |
| **Reversal** | the original movement's **exact** weight and value | mirror entries via `cancelVoucher`, plus an opposite movement linked by `reversalOfMovementId` |

Confirmation is not a checkbox in isolation: the engine refuses an IN carrying
its own value unless `confirmedValue` is set, and the message it refuses with
states the quantity, the total and the implied per-gross-gram rate. The form
shows the same three figures live before the Owner submits.

A transfer posts two movements — one leaving a pool, one entering the other —
so value moves between pools and is never created or destroyed. The new
`SCRAP_ADJUSTMENT_IN` / `SCRAP_ADJUSTMENT_OUT` types exist because scrap could
previously only ever go in.

A posted adjustment cannot be edited or deleted. `reverseMetalStockAdjustment`
is the only way back, it refuses to run twice, and it refuses anything that is
not an authorized adjustment (an opening entry must go through the correction
framework instead).

Value-only revaluation is deliberately **not** in this form. It goes through the
correction framework, where it gets an impact preview, an Owner approval, an
audit row and stale-preview protection.

Staff cannot post an adjustment at all: `requireOwner` guards the action.

### Proven by tests

`posting.test.ts` covers each valuation rule, the empty-pool refusal, the
confirmation message, the refusal of a user-entered OUT value, both transfer
directions, reversal netting to exactly zero, double-reversal refusal, and the
refusal to reverse a non-adjustment. `metal.test.ts` covers the action layer:
Owner-only, schema refusal of an unknown mode, and the mode and confirmation
flag reaching the engine. `metalReplay.test.ts` proves a revalued pool carries
correctly through both transfer directions.

---

## Rolling back a correction batch

Rollback is an audited operation, not a deletion.

`reverseCorrection` mirrors a correction's entries into a `REVERSAL` voucher
through the same `cancelVoucher` flow the rest of the app uses, records a
reversing `Correction` of its own with its reason and approver, and marks the
original **`REVERSED`** with `reversedByCorrectionId` pointing at it.
`reverseCorrectionBatch` does this for every posted step, newest first, and the
batch drops back to `OPEN`.

Because current values count only **POSTED** revaluations, marking the original
REVERSED is what restores the derived figures — there is no second set of
counter-entries to keep in step.

The rollback test runs against a fixture that reproduces production exactly:
both jobs, both receipts, both finished pieces, the seven 24K movements and the
five vouchers that produced production's trial balance (1300 at −₹57,342.60).
After R1 and R2 it asserts the approved figures, and after rollback it asserts
the **exact** pre-correction values:

| Value | Before | After R1+R2 | After rollback |
|---|---:|---:|---:|
| Usable 24K pool | ₹1,02,657.40 | ₹1,93,361.21 | **₹1,02,657.40** |
| Job 68 WIP | ₹42,425.96 | ₹93,248.01 | **₹42,425.96** |
| ZL-FJ-2026-000086 metal | ₹30,298.01 | ₹66,592.00 | **₹30,298.01** |
| ZL-FJ-2026-000087 metal | ₹15,668.63 | ₹29,512.78 | **₹15,668.63** |
| 1300 / 1320 / 1330 | −57,342.60 / 42,425.96 / 86,594.68 | 193,361.21 / 93,248.01 / 136,732.82 | **back to before** |

It also asserts that nothing is deleted and nothing looks active when it is not:
both originals read `REVERSED` with a link to a `POSTED` reversing correction,
two `REVERSAL` vouchers exist, the two `CORRECTION` vouchers are `CANCELLED`
rather than removed, the opening movement is untouched, every voucher still
balances, `verifyCorrectionBatch` now reports the batch as no longer intact, and
a second reversal of the same correction is refused. Staff cannot reverse a
batch.

---

## Final acceptance on `zynoraluxe_phase7_test`

### 1. Migration audit — additive only

Every statement in the four Phase 8 migrations, counted:

| Statement | Count |
|---|---:|
| `CREATE TYPE` | 6 |
| `CREATE TABLE` | 4 |
| `CREATE INDEX` / `CREATE UNIQUE INDEX` | 16 |
| `ALTER TYPE … ADD VALUE` | 6 |
| `ALTER TABLE … ADD COLUMN` (all nullable) | 4 |
| `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` | 13 |
| **`DROP` / `DELETE` / `TRUNCATE` / `UPDATE` / `RENAME` / `SET NOT NULL`** | **0** |

There is **no DML at all**, so no Phase 1–7 row can be read, changed or removed
by these migrations. Exactly one pre-existing table is touched,
`metal_stock_movements`, and only to gain three nullable columns
(`voucherId`, `idempotencyKey`, `transferPairId`). Every `NOT NULL` in the SQL
is inside a `CREATE TABLE` for a new table.

### 2. Browser acceptance — Chromium, Owner and Staff, desktop and mobile

Installed Chrome driven against the app running on the isolated test database.
**32 steps, all passing, with 0 console errors, 0 page errors, 0 failed
requests, 0 CSP violations, 0 HTTP 5xx and no sideways scrolling on a 390px
screen.**

Owner (20 steps): the corrections page and workbench render; the R1 preview
shows Dr 1300 / Cr 3000 at ₹1,60,000 **and writes nothing**; R1 posts as batch
step 1 leaving the batch `OPEN`; a **double submit** of R2 saves one correction
and one voucher; the batch completes with 1300 at ₹3,51,664 and 3000 at
−₹3,51,664; history shows both steps with their batch and step numbers; a
**stale preview is refused** at approval after the pool moves, with the draft
untouched; a **quantity-only IN** takes the carrying average (₹15,984.00 for
1.000g); an **IN with its own value** shows the implied ₹20,000.0000 per gross
gram and is **refused until the Owner confirms**, then posts at ₹40,000; an
**IN against an empty pool** is refused and demands an explicit cost; an **OUT**
offers no value field at all and posts at the carrying average; **usable→scrap
and scrap→usable** each post equal value on both legs; an **adjustment reverses**
at the original's exact weight and value with the original kept; reversing a
transfer whose scrap has since moved on is **refused**; every voucher balances
and 1300 equals the stock carrying value.

Staff (12 steps): no Corrections link in the navigation; `/corrections`
redirects to `/unauthorized` with **no correction data anywhere in the
payload**; no Opening Stock, Adjustment, preview or post control is offered;
metal weights are visible but **no ₹ figure appears at all**; ordinary
accounting work still reachable; the same restrictions hold on mobile.

Rollback (in the same run): `scripts/reverseCorrectionBatch.ts` reverses both
steps, the ledger gives back exactly ₹3,51,664 on 1300 and 3000, the Owner sees
**both corrections marked Reversed** each linked to its audited reversing
correction, both remain in history, and all 10 vouchers still balance.

### 3. Three defects found by this acceptance run, and fixed

| # | Found by | Defect | Fix |
|---|---|---|---|
| 1 | Browser: a quantity-only IN came out at the **old** rate | `getMetalStockBalanceInTx` valued a pool from movements alone, ignoring posted revaluations — so a correction moved the ledger and the reports but **not the rate the next issue or adjustment would use**, recreating the very defect the phase exists to fix | pool value is now movements **plus** posted revaluations, in the posting engine and in the stock report; a database test asserts the next adjustment uses ₹15,918.4334 |
| 2 | Reconciliation: 1310 disagreed with scrap stock | reversing a pool transfer undid only its **usable** leg, leaving the scrap pool holding value the usable pool had already taken back | both legs now share a `transferPairId`, are created together and are **reversed together**, cancelling their shared voucher once |
| 3 | Reconciliation: a negative scrap pool | a reversal could drive a pool negative when the metal had since been moved on | a reversal that would leave either pool below zero is refused, naming the weight it would go to |

### 4. Re-run gates

| Gate | Result |
|---|---|
| Vitest | 843 passed / 843, 63 files |
| Prisma validate | schema valid |
| Migration status | 17 applied, none failed or rolled back |
| TypeScript | `tsc --noEmit` clean |
| ESLint | clean, 0 errors 0 warnings |
| Production build | compiles; `/corrections` routed |
| Reconciliation | 7/7 — every voucher debit = credit, the whole ledger nets to zero, 1300 and 1310 equal their stock carrying values, no negative pool, every reversed correction links to what reversed it, **no corrected original was edited** |
| Secret scans | 0 matches in tracked source, 0 in `.next/static`, no `.env` change, no test credential or database name in shipped code |

The reconciliation names the ₹1,60,000 of opening stock still off the ledger
rather than hiding it: that is the pre-Phase-8 defect itself, and closing it is
exactly what R1 does.

### 5. A deliberate limitation

The corrections UI is **Owner-only**. The only entity a correction planner
exists for today is Opening Metal Stock, whose whole subject is a cost figure,
and Phase 7 established that Staff never see cost. Staff can therefore prepare
a draft through the action layer (proven by test) but have no screen to do it
from. The per-module Staff surface for non-cost entities belongs to 8E.

---

## Production execution plan for R1 and R2 — NOT YET RUN

Figures are exactly those approved in `PHASE_8_REVALUATION_PREVIEW.md`. R1 and
R2 are steps 1 and 2 of batch **`PROD-OPENING-2026-09-21`** (`requiredSteps: 2`).

### Step 1 — capture the before-state

Read-only, saved to a timestamped evidence folder outside the repo:

- row counts for `metal_stock_movements`, `vouchers`, `journal_entries`,
  `corrections`, `correction_batches`, `finished_jewellery`, `jewellery_jobs`
- md5 fingerprints of the opening movement row, both finished pieces and job 68
- balances of 1300, 1310, 1320, 1330, 3000 and the full trial balance
- `metalStockValue()` and `reconcileVoucherBalances()` output
- the migration list and the deployed commit

### Step 2 — deploy the additive migrations, the tested commit and the masters

Push the accepted commit to `main`; Vercel builds Production. Apply all four
Phase 8 migrations with `prisma migrate deploy` (never `migrate dev`, never
`migrate reset`), then run `npm run db:seed-phase8-masters` to create accounts
4200 and 5500. That seed creates only those two accounts and never touches the
Owner password — unlike `db:seed`, which must not be run on production.

### Step 3 — verify the live commit and migration status

Confirm the Vercel Production deployment is the accepted commit and that
`migrate status` reports **17 migrations** applied with none failed or rolled
back, and that accounts 4200 and 5500 exist.

### Step 4 — preview R1 and R2 again against unchanged preconditions

Re-run both planners read-only and confirm, before posting anything:

- 1300 still reads **−₹57,342.60**
- the opening movement still reads 22.001 g / 21.979 g / ₹1,60,000 with no voucher
- R1 plans Dr 1300 ₹1,60,000 / Cr 3000 ₹1,60,000
- R2 plans Dr 1300 ₹90,703.81, Dr 1320 ₹50,822.05, Dr 1330 ₹50,138.14 / Cr 3000 ₹1,91,664.00

Any difference stops the run.

### Step 5 — post R1 and R2 once each

Posted from **Corrections → Correct an Opening Stock entry**, as the Owner,
after reading the impact preview on screen:

| Step | Correction | Batch fields | Reason |
|---|---|---|---|
| R1 | "Post to the ledger at the saved value (R1)" | code `PROD-OPENING-2026-09-21`, step 1, steps in batch 2 | "Opening metal stock was never posted to the ledger (Phase 8 defect D-2)." |
| R2 | "Correct the value (R2)", corrected total **351664** | same code, step 2, steps in batch 2 | "Opening gold was valued at ₹7,279.68 per fine gram instead of the actual ₹16,000." |

Each is one transaction, carrying the idempotency key its form generates, so a
double click or a retry saves it once — proven in the browser run. Posting is
refused if the step is already taken.

### Step 6 — verify the accounts against stock values

| Check | Expected |
|---|---|
| 1300 Metal Inventory | ₹1,93,361.21, equal to the 12.147 g pool |
| 1320 Jewellery WIP | ₹93,248.01 |
| 1330 Finished Jewellery | ₹1,36,732.82 |
| 3000 Opening Balance Equity | credit ₹3,51,664.00 |
| `reconcileMetalInventory` | both checks OK |
| `reconcileVoucherBalances` | every voucher debit = credit |
| `verifyCorrectionBatch` | all checks OK, batch `COMPLETE`, both steps POSTED |

### Step 7 — confirm the corrected carrying values

`ZL-FJ-2026-000086` metal ₹66,592.00 (total ₹93,265.04), `ZL-FJ-2026-000087`
metal ₹29,512.78 (total ₹43,467.78), job `ZL-JJOB-2026-000068` WIP ₹93,248.01
over 5.828 g fine — read from the posted `MetalRevaluation` rows and the
Correction History page. Stock quantities must be unchanged everywhere.

### Step 8 — preserve evidence and report rollback readiness

Keep the before-state capture and add the after-state alongside it. Run
`planCorrectionBatchRollback` and report `ready: true` with both voucher
numbers, so the undo path is known-good before the session closes.

### Rollback

- **A step fails mid-way:** its transaction rolls back on its own; nothing is
  written. Re-run after fixing the cause.
- **R1 posted, R2 not:** the books are already better off (1300 is no longer
  negative) and the batch simply stays `OPEN`. Continue or stop; no undo needed.
- **Both posted and the Owner wants them undone:** run
  `npx tsx scripts/reverseCorrectionBatch.ts PROD-OPENING-2026-09-21 "<reason>"`
  to see the plan, then again with `--confirm` to apply it.
  It reverses each step newest-first, posting an audited reversing correction
  and a REVERSAL voucher for each, and marks both originals `REVERSED` with a
  link to what reversed them. This is exercised as a test against a fixture
  that reproduces production exactly, and it restores the usable pool, job 68's
  WIP, both finished pieces' metal costs and 1300/1320/1330/3000 to their exact
  pre-correction values. Nothing is deleted. Re-running the corrections
  afterwards needs fresh idempotency keys.
- **No `migrate reset`, no deletes, no edits to any original record**, ever.

---

## Remaining decisions and risks

| Item | Status |
|---|---|
| Adjustment accounting | Implemented and tested to the approved rules; accounts 4200/5500 must be seeded on production before an adjustment is posted there |
| Tiers 8B–8E | Not started; 8A is the foundation they call |
| Correction coverage | Only `METAL_OPENING_STOCK` has a planner. Other entity types are defined and refused with a clear message until their tier lands |
| Staff-facing correction UI | Staff can prepare drafts through the action layer; the history page is Owner-only, so 8E adds the per-module Staff surface |
| Browser E2E for corrections | Deferred to 8E, when there is a form to drive; 8A is covered by real-database tests instead |
