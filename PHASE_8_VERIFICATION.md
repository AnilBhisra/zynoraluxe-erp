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
| Schema | `Correction`, `CorrectionImpact`, `MetalRevaluation` + 5 enums; `MetalStockMovement.voucherId` and `.idempotencyKey`; `VoucherType.OPENING_STOCK` and `.CORRECTION` |
| Migration | `prisma/migrations/20260921090000_phase8_correction_framework/` |
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

### Rules proven by tests

| Rule | Where |
|---|---|
| Original movement, value and fineness snapshot are never edited | `correctionFlow.db.test.ts` (R1 and R2 both re-read the row after posting) |
| Correction posting is atomic and idempotent | same file — duplicate key leaves 1 movement / 1 voucher |
| Only an Owner may approve or post | `postCorrection` refuses `approverRole: "STAFF"`; `corrections.test.ts` proves `requireOwner` guards the action |
| Staff may prepare a draft that posts nothing | `saveCorrectionDraft` → `AWAITING_APPROVAL`, no voucher written |
| A stale preview can never post | `approveCorrectionDraft` re-plans and compares fingerprints; refuses after the pool moves |
| Weighted average is kept, not the newest purchase rate | `metalReplay.test.ts` — job 69 restates to ₹31,836.87, not ₹31,050 |
| Every correction stores original, corrected, reason, Owner, timestamp, link | audit-trail test + Correction History page |
| Debit = credit for every voucher after a correction | `reconcileVoucherBalances` |
| 1300/1310 equal the metal stock value | `reconcileMetalInventory` |
| A sold piece is refused, not silently revalued | `openingStockCorrection.ts` guard (Owner decision D7) |
| Corrections stay Owner-only in the UI | `voucherVisibility.test.ts` (both new types false), `nav.test.ts` |

The replay refuses rather than guesses whenever it meets a shape it cannot
reproduce exactly: a cancelled issue, a receipt whose finished pieces it cannot
load, or outputs whose fine weight does not match the consumed fine weight.

### Results

| Gate | Result |
|---|---|
| Vitest | **808 passed / 808**, 63 files (was 762 / 59 at `6cb6c07`) |
| New tests | 46 — 14 replay, 14 real-database flow, 13 action/permission, 5 history view |
| Prisma | schema valid; migration applied to the test database; status clean |
| TypeScript | `tsc --noEmit` clean |
| ESLint | clean, 0 errors 0 warnings |
| Production build | succeeds; `/corrections` routed |
| Reconciliation | 1300 vs stock value, 1310 vs scrap value, every voucher balanced — all OK |

The migration was written with `prisma migrate diff` and applied with
`migrate deploy`, because the test role may not create the shadow database
`migrate dev` requires. The SQL is a normal additive migration: 5 new enum
types, 2 enum values, 3 new tables, 2 new nullable columns.

---

## Production execution plan for R1 and R2 — NOT YET RUN

Figures are exactly those approved in `PHASE_8_REVALUATION_PREVIEW.md`.

### Preconditions

1. Deploy this branch first. R1/R2 rely on the Phase 8 tables, so the migration
   must be applied to production before either is posted.
2. Confirm the target is the production database and the opening movement is
   the one dated 2026-09-17 22:50:05 UTC, 22.001 g of 24K valued ₹1,60,000.
3. Confirm 1300 Metal Inventory still reads **−₹57,342.60**. If it does not,
   stop: something has moved since the preview and the figures must be rebuilt.

### Execution — one Owner session, two steps

| Step | Operation | Idempotency key | Expected |
|---|---|---|---|
| 1 | `postOpeningStockCorrection` with `movementId`, **no** `newCostValue`, reason "Opening metal stock was never posted to the ledger (Phase 8 defect D-2)." | `prod-opening-r1-2026-09-21` | `CORR/2026-27/NNNN`, Dr 1300 ₹1,60,000 / Cr 3000 ₹1,60,000; 1300 becomes **₹1,02,657.40** |
| 2 | `postOpeningStockCorrection` with `newCostValue=351664`, `supersedesCorrectionId=<R1 id>`, reason "Opening gold was valued at ₹7,279.68 per fine gram instead of the actual ₹16,000." | `prod-opening-r2-2026-09-21` | Dr 1300 ₹90,703.81, Dr 1320 ₹50,822.05, Dr 1330 ₹50,138.14 / Cr 3000 ₹1,91,664.00 |

Each step is one transaction. Re-running a step with the same key returns the
existing correction instead of posting again.

### Post-execution checks

| Check | Expected |
|---|---|
| 1300 Metal Inventory | ₹1,93,361.21, equal to the 12.147 g pool |
| 1320 Jewellery WIP | ₹93,248.01, equal to job 68's pending WIP |
| 1330 Finished Jewellery | ₹1,36,732.82, equal to FJ-86 + FJ-87 |
| 3000 Opening Balance Equity | credit ₹3,51,664.00 total |
| `verifyCorrection` on both | all checks OK |
| `reconcileMetalInventory`, `reconcileVoucherBalances` | all OK |
| Original opening movement | 22.001 g / 21.979 g / ₹1,60,000, `voucherId` still null |
| Stock quantities | unchanged everywhere — a revaluation moves value only |

### Rollback

Nothing is destroyed, so rollback is additive and safe at every point.

- **A step fails mid-way:** its transaction rolls back on its own. Nothing is
  written; re-run after fixing the cause.
- **R1 posted, R2 not:** the books are already better off than before (1300 is
  no longer negative). Either continue with R2 or stop; no undo needed.
- **Both posted and the Owner wants them undone:** cancel each `CORRECTION`
  voucher through the existing `cancelVoucher` flow, newest first. That posts a
  mirror `REVERSAL` voucher and marks the correction voucher CANCELLED, which
  returns 1300/1320/1330 to their prior balances. The `Correction` rows stay as
  history; re-running R1/R2 afterwards needs fresh idempotency keys, since the
  originals are consumed.
- **No `migrate reset`, no deletes, no edits to any original record**, in any
  scenario.

---

## Remaining decisions and risks

| Item | Status |
|---|---|
| Tiers 8B–8E (metal forms, Old Gold Exchange, customer custody, universal correct/reverse surface) | Not started; 8A is the foundation they call |
| Correction coverage | Only `METAL_OPENING_STOCK` has a planner. Every other entity type is defined in the enum and refused with a clear message until its tier lands |
| `adjustMetalStock` posts no journal entry either | Same defect class as D-2, outside the approved D2 scope — needs an Owner decision |
| Staff-facing correction UI | Staff can prepare drafts through the action layer; the Correction History page is Owner-only, so 8E adds the per-module Staff surface |
| Browser E2E for corrections | Deferred to 8E, when there is a form to drive; 8A is covered by real-database tests instead |
