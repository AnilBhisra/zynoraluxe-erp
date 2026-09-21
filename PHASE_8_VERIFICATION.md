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
| Schema | `Correction`, `CorrectionImpact`, `MetalRevaluation`, `CorrectionBatch` + 6 enums; `MetalStockMovement.voucherId` and `.idempotencyKey`; `VoucherType.OPENING_STOCK` and `.CORRECTION` |
| Migrations | `20260921090000_phase8_correction_framework`, `20260921120000_phase8_correction_batch` |
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
| Vitest | **825 passed / 825**, 63 files (was 762 at `6cb6c07`) |
| New tests | 63 — 14 replay, 29 real-database flow and batch, 14 action/permission, 6 history view |
| Prisma | schema valid; both migrations applied to the test database; status clean at 15 |
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

## Authorized Metal Stock Adjustment — blocked, and the proposed fix

### Blocked now

`adjustMetalStock` changes Metal Stock and posts **no journal entry** — the same
defect class as D-2. Until its accounting is implemented it refuses to write
anything (`PostingError`, with the reason shown in the form), so production can
no longer create a stock movement without a balanced voucher. Existing stock
and history are untouched. The refusal is proven by `posting.test.ts`.

### Current input fields

| Field | Rules today |
|---|---|
| `metalType` | GOLD / SILVER / PLATINUM / ALLOY |
| `purityId` | must exist; fineness snapshot taken from it |
| `direction` | `IN` or `OUT` |
| `grossWeight` | required, > 0 (so a value-only change is impossible) |
| `costValue` | optional, defaults to **0** — this is how unvalued stock got created |
| `reason` | 3–300 characters |

Not captured today: date, a scrap-pool option, a value-only mode, any link to
the adjustment being reversed, and an idempotency key.

### Proposed accounts

Two new system accounts, because **Opening Balance Equity must not carry
operational adjustments** — an adjustment is this period's gain or loss, not
opening capital:

| Code | Name | Type | Free? |
|---|---|---|---|
| **4200** | Inventory Adjustment Gain | INCOME | yes — 4000 and 4100 are the only 4xxx in use |
| **5500** | Inventory Adjustment Loss | EXPENSE | yes — 5000–5400 are in use, 5500 is free |

Both seeded `isSystem: true`, like every other posting account.

### Proposed debit/credit rules

Every case posts one balanced voucher of type `STOCK_ADJUSTMENT` (`ADJ/<FY>/NNNN`,
already Owner-only), in the same transaction as its stock movement.

| # | Case | Movement | Entry |
|---|---|---|---|
| 1 | **Positive quantity/value** (stock found) | `ADJUSTMENT_IN`, weight > 0, value V | **Dr 1300** V / **Cr 4200** V |
| 2 | **Negative quantity/value** (stock missing) | `ADJUSTMENT_OUT`, weight > 0 | **Dr 5500** V / **Cr 1300** V |
| 3 | **Quantity-only correction** (no value entered) | as 1 or 2 | V = weight × the pool's current average per gross gram, so the average is unchanged. Then as 1 or 2. An IN against an empty pool is refused — there is no rate to use |
| 4 | **Value-only revaluation** (no weight change) | **no stock movement**; a `MetalRevaluation` row | increase: **Dr 1300** / **Cr 4200**; decrease: **Dr 5500** / **Cr 1300**. Routed through the Phase 8 correction framework as a `METAL_ADJUSTMENT` / `REVALUE` correction, so it gets an impact preview, a reason, a downstream check and an audit row |
| 5 | **Scrap adjustment** | `ADJUSTMENT_IN` / `ADJUSTMENT_OUT` against the scrap pool | found: **Dr 1310** / **Cr 4200**; written off: **Dr 5500** / **Cr 1310**. Reclassifying scrap into usable metal is not a gain or loss: **Dr 1300 / Cr 1310** at the scrap pool's own average, as one transaction with one voucher |
| 6 | **Reversal of an adjustment** | new opposite movement linked by `reversalOfMovementId` (column already exists); the original is never edited or deleted | the existing `cancelVoucher` flow mirrors the original's lines into a `REVERSAL` voucher. The reversal uses the **original's** value, not today's average, so stock and ledger both net to exactly zero |

Additional rules proposed with the fix: Owner-only (unchanged), a required
reason (unchanged), a new required idempotency key, no GST on adjustments
(consistent with labour and job-work charges today), and OUT never allowed to
drive a pool negative (unchanged).

**This needs your approval before I implement it** — particularly rule 3
(valuing an unvalued quantity correction at the pool average) and rule 4
(sending value-only changes through the correction framework instead of the
adjustment form).

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

### Step 2 — deploy the additive migration and the tested commit

Push the accepted commit to `main`; Vercel builds Production. Apply both Phase 8
migrations with `prisma migrate deploy` (never `migrate dev`, never
`migrate reset`).

### Step 3 — verify the live commit and migration status

Confirm the Vercel Production deployment is the accepted commit and that
`migrate status` reports 15 migrations applied with none failed or rolled back.

### Step 4 — preview R1 and R2 again against unchanged preconditions

Re-run both planners read-only and confirm, before posting anything:

- 1300 still reads **−₹57,342.60**
- the opening movement still reads 22.001 g / 21.979 g / ₹1,60,000 with no voucher
- R1 plans Dr 1300 ₹1,60,000 / Cr 3000 ₹1,60,000
- R2 plans Dr 1300 ₹90,703.81, Dr 1320 ₹50,822.05, Dr 1330 ₹50,138.14 / Cr 3000 ₹1,91,664.00

Any difference stops the run.

### Step 5 — post R1 and R2 once each

| Step | Idempotency key | Batch |
|---|---|---|
| R1 (`newCostValue` omitted) | `prod-opening-r1-2026-09-21` | `PROD-OPENING-2026-09-21` step 1 of 2 |
| R2 (`newCostValue = 351664`) | `prod-opening-r2-2026-09-21` | same batch, step 2 of 2 |

Each is one transaction. Re-running either with its key returns the existing
correction instead of posting again.

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
- **Both posted and the Owner wants them undone:** cancel the two `CORRECTION`
  vouchers newest-first through the existing `cancelVoucher` flow. This is
  exercised as a test, not just described: it returns 1300, 1320, 1330 and 3000
  to their prior balances, leaves every voucher balanced, and preserves both
  Correction rows and the original movement. Re-running afterwards needs fresh
  idempotency keys.
- **No `migrate reset`, no deletes, no edits to any original record**, ever.

---

## Remaining decisions and risks

| Item | Status |
|---|---|
| Adjustment accounting (the six rules above) | **Awaiting Owner approval**; the adjustment is blocked until then |
| Tiers 8B–8E | Not started; 8A is the foundation they call |
| Correction coverage | Only `METAL_OPENING_STOCK` has a planner. Other entity types are defined and refused with a clear message until their tier lands |
| Staff-facing correction UI | Staff can prepare drafts through the action layer; the history page is Owner-only, so 8E adds the per-module Staff surface |
| Browser E2E for corrections | Deferred to 8E, when there is a form to drive; 8A is covered by real-database tests instead |
