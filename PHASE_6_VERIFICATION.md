# Phase 6 (Finished Jewellery Sales, Stock, COGS & Actual P&L) — Verification Report

Branch: `phase-6-finished-sales`, based on the approved V1 Final
Acceptance commit `5912ddb4011a3a2f610fd956a41351ad0a7259b9`. **Not
committed, staged, pushed, merged, tagged, or deployed** — this file
documents the state of the working tree only, awaiting Owner review.

**This is the gap-closure revision.** An earlier pass of this document
reported "PASS for the backend/database/accounting layer" with several
explicitly-flagged gaps (no real browser E2E, no real Staff browser
verification, no Phase 5 vs Phase 6 comparison view, `₹0.01` tolerance
instead of exact equality). That report was correctly rejected as
leaving mandatory acceptance work incomplete. Every gap named in the
rejection has been closed in this pass — real browser automation (Owner
**and** Staff, desktop **and** mobile), exact-paise proofs, the stock-
equation proof, the zero-balance-purity reproduction, and the Phase 5
vs Phase 6 comparison feature are all now implemented and verified live
against the real database, and are documented below alongside three
real product bugs this pass found and fixed.

## 1. Audit findings — the authoritative COGS source

Phase 4's `FinishedJewellery` model carries five cost fields:
`metalCost`, `diamondCost`, `otherMaterialCost`, `labourAllocated`,
`totalCost` (= the first four summed). Reading `src/lib/jewellery/
posting.ts` end to end proves `otherMaterialCost` is **display-only**:

- At **Issue Materials** time, `issueMaterialsToJewelleryJob`'s other-
  material lines create no `MetalStockMovement`, no journal line, and
  are excluded from the WIP voucher's debit/credit lines entirely —
  they only accumulate into `JewelleryJob.otherMaterialCost` for
  on-screen reference.
- At **Receive** time, `receiveFinishedJewellery` computes
  `finishedInventoryDebit = finishedPortionCost + totalCharges +
  setDiamondCost` — `otherMaterialCost` is never added. The
  `Dr Finished Jewellery Inventory` journal line (the only place a
  FinishedJewellery output's cost ever enters the general ledger) is
  therefore always `metalCost + diamondCost + labourAllocated`,
  never `totalCost`.

**Conclusion: the one authoritative accounting inventory/COGS figure
for any FinishedJewellery output is `metalCost + diamondCost +
labourAllocated`** — implemented once, as `getAuthoritativeInventoryCost()`
in `src/lib/jewellery/finishedSalesPosting.ts`, and used everywhere in
Phase 6 (sale, cancellation, return, owner adjustment, backfill,
reporting, and now the Phase 5 vs Phase 6 comparison — §12). `totalCost`
(Phase 4/5's own full-business-costing figure, legitimately including
`otherMaterialCost`) is never read for any Phase 6 accounting posting.

**Stability under Phase 4's retroactive reallocation**: an open job's
earlier outputs get `otherMaterialCost`/`totalCost` rewritten every
time a later receipt adds a new output ("priorOutputs" reallocation in
`receiveFinishedJewellery`) — but that reallocation **never touches**
`metalCost`, `diamondCost`, or `labourAllocated`. The authoritative
figure is therefore safe to snapshot into a stock movement at output-
creation time and never needs to be re-read later.

Phase 5's Costing engine (`computeCostSheetTotals`) computes a
completely separate number — the suggested **selling price**
(`customerTotal`), which legitimately factors in `otherMaterialCost`,
markup/margin, discount, GST and rounding. Phase 6 never uses this (or
any Costing figure) as COGS.

**Live-DB proof, this pass**: a real 3-output Jewellery Job was issued
with a real ₹2,000 "Enamel work" other-material line through the real
UI. The output that Costing was linked to had `totalCost` (Phase
4/5's business-cost figure) exceeding `getAuthoritativeInventoryCost()`
by exactly the display-only other-material share — confirmed both in
the unit suite and, this pass, in the real browser's rendered Phase 5
vs Phase 6 comparison panel text (§13): *"Accounting COGS (₹22909.08)
excludes ₹545.46 of display-only other-material cost that Phase 5's
full business cost legitimately includes."*

## 2. Finished Jewellery Stock ledger

New model `FinishedJewelleryStockMovement` (immutable; no update/delete
path exists anywhere in the codebase) with type `PRODUCED_IN |
SOLD_OUT | SALE_CANCELLED_IN | RETURNED_SELLABLE_IN |
RETURNED_DAMAGED_OUT | OWNER_ADJUSTMENT_IN | OWNER_ADJUSTMENT_OUT`.
Every row snapshots identity/description (finished code, jewellery
type, metal/purity, weights, total carat, job code) and the cost value
at that moment — a master-data edit afterwards cannot alter history.

`FinishedJewellery.status` (`AVAILABLE | SOLD | RETURNED_DAMAGED`) is
the fast, concurrency-safe derived gate every state transition uses via
`tx.finishedJewellery.updateMany({ where: { id, status: <expected> },
data: { status: <next> } })` — never a plain `update`. Every caller
checks `result.count === 1` and throws otherwise. This is a genuine
database-enforced invariant (the conditional `WHERE` is evaluated
atomically by Postgres), not an application pre-check — proven both in
a 10-way concurrent backend script (earlier pass) and, this pass, via a
genuine **2-browser-tab** simultaneous-click race in a real browser
(§13, Step 10).

`receiveFinishedJewellery` now creates exactly one `PRODUCED_IN`
movement per new output, in the **same transaction** as the existing
posting — atomic by construction. `scripts/backfillFinishedJewelleryStock.ts`
is an idempotent one-time backfill for any output that predates this
change (run against the real database: found 0 outputs missing a
movement — none existed pre-Phase-6).

### 2a. Availability-delta reconciliation — the damaged-return stock equation, proven exactly

The governing instruction required proving, precisely: `Available
balance = Produced + Sale-cancelled-in + Sellable-return-in +
Owner-adjustment-in − Sold-out − Owner-adjustment-out`, and inspecting
`RETURNED_DAMAGED_OUT` specifically for a double-decrement bug.

**Finding**: the *runtime* posting code never had this bug —
`FinishedJewellery.status` (not a movement sum) is the single source
of truth every real code path reads and writes, via the atomic
`updateMany` guard in §2. So there was no live double-decrement to fix.
But the *risk* was real: `RETURNED_DAMAGED_OUT`'s name reads like every
other `_OUT` type (`SOLD_OUT`, `OWNER_ADJUSTMENT_OUT`, each −1), and a
future report or dashboard built by summing movement deltas — a
reasonable reading of the ledger nobody had yet written — would
silently double-subtract a damaged-return item that had already left
the Available pool via its own earlier `SOLD_OUT`.

This is now closed with a new, explicit, documented reconciliation map
in `src/lib/jewellery/finishedSalesPosting.ts`:

```ts
export const AVAILABILITY_DELTA: Record<FinishedJewelleryStockMovementType, number> = {
  PRODUCED_IN: 1,
  SOLD_OUT: -1,
  SALE_CANCELLED_IN: 1,
  RETURNED_SELLABLE_IN: 1,
  RETURNED_DAMAGED_OUT: 0,   // <- deliberately NOT -1, see below
  OWNER_ADJUSTMENT_IN: 1,
  OWNER_ADJUSTMENT_OUT: -1,
};
```

`RETURNED_DAMAGED_OUT` carries a **zero** delta, not −1, because by the
time it posts the item already left the Available pool via its own
earlier `SOLD_OUT` (delta −1, already applied once). A damaged return
never removes the item from stock a second time — it only reclassifies
an already-unavailable item's terminal status from "Sold" to "Returned-
Damaged" (and reclassifies its cost from COGS into Damaged Jewellery
Loss, a purely financial entry — §8). The event still changes lifecycle
status and posts a real journal entry; it just has zero *availability*
effect. The existing event name was kept (renaming an already-applied
enum value on the live database is its own migration risk) — this map,
the extensive comment above it in the source, and this section are the
documentation the name alone doesn't provide.

`reconcileAvailabilityLedger()` sums `AVAILABILITY_DELTA` across one
item's full movement history and returns both the final total and the
running total after every movement — used **only** by the test suite
and this documentation as an independent reconciliation proof; no real
posting path sums movements (they all trust `status` directly, which is
concurrency-safe and immune to read-skew in a way a client-side sum
never could be).

**8 new lifecycle tests** in `finishedSalesPosting.test.ts` prove the
invariant holds for every real code path, asserting the *exact*
movement-type sequence (not just the final total) so a hidden duplicate
movement would fail the test even if the sum happened to still be
right:

| Path | Movement sequence | Final total |
|---|---|---|
| Produced → Sold | `PRODUCED_IN, SOLD_OUT` | 0 |
| → Sellable Return | `..., RETURNED_SELLABLE_IN` | 1 |
| → Resold | `..., SOLD_OUT` | 0 |
| Produced → Sold → Damaged Return | `PRODUCED_IN, SOLD_OUT, RETURNED_DAMAGED_OUT` | 0 (never negative) |
| Produced → Sold → Cancelled | `PRODUCED_IN, SOLD_OUT, SALE_CANCELLED_IN` | 1 |
| Partial multi-item return | (2 items, 1 returned) | per-item correct |
| Owner-adjustment boundaries | rejects an extra `_OUT` past zero | never below 0 |
| Sold → Sellable Return → Resold, no duplicate movement | `PRODUCED_IN, SOLD_OUT, RETURNED_SELLABLE_IN, SOLD_OUT` (exactly once each) | 0 |

Every test also asserts `assertNeverOutOfBounds` — no movement sequence
for a unique (non-batch) item may ever derive availability below 0 or
above 1. The last row above also asserts **no double COGS**: net
`FINISHED_JEWELLERY_COGS` journal debits across the sale → return →
resale voucher trio equal exactly one unit's authoritative cost, never
two (see §16 for the full assertion).

## 3. Finished Stock UI

Third tab added to `/jewellery-jobs` (`Jobs / Metal Stock / Finished
Stock`) — `src/components/jewellery/FinishedStockTab.tsx`. Shows stock
#, jewellery/type, source job, metal+purity, weights, diamonds+carat,
status, produced date, sale reference, photo thumbnail; search, status
filter, CSV export (client-side, from the same rows already on screen
— never a second cost-bearing round trip); desktop table + mobile card
layout. Now also carries the Owner-only "Compare vs Costing" panel
(§12) and, in a new sibling section on the same page, the Owner-only
Finished Jewellery Sales manager (`FinishedSalesManager.tsx`, §7–8) —
this is a new component built during this pass specifically because
the earlier "PASS" report had no real UI for cancel/return at all
(only the backend Server Actions existed); the real browser E2E in
§13 could not proceed past its return/cancel steps without it, which
is exactly how the gap was caught.

**Staff never receives cost data over the wire**, not just via a
hidden UI element: `listFinishedJewelleryStock()` in
`src/lib/jewellery/reports.ts` runs one of **two entirely different
Prisma `select` clauses** depending on `includeCost` — the Staff-path
query never selects `metalCost`/`diamondCost`/`labourAllocated`/
`costSheets` at all, so there is no server response containing those
fields to intercept or spoof client-side. The page (`jewellery-jobs/
page.tsx`) passes `includeCost: isOwner` computed from the
session-verified role. This pass adds a real, live proof: a genuine
Staff browser session's full network traffic (every HTML/RSC/JSON
response, not the shared static JS bundle — see §13) was captured and
grepped for 15 forbidden cost/margin substrings (`cogsAmount`,
`metalCost`, `grossProfit`, `Compare vs Costing`, `Full business cost`,
etc.) — zero hits.

## 4–5. Sale workflow + atomic accounting

`TransactionsTab`'s "New Sale" now opens a 2-choice screen: **Sell
Finished Jewellery** vs **Other / Accounting-only Sale**. The manual
path is untouched (`InvoiceVoucherForm` + `createSale`, exactly as V1
built it) but now sits behind an explicit warning + confirmation
checkbox ("no stock/COGS is affected") — verified live this pass
(§13, Step 17): the manual form's `linesJson` input genuinely does not
exist in the DOM until the checkbox is explicitly clicked, and a real
manual sale posts correctly through the preserved path afterward. The
Finished path is a new component, `FinishedJewellerySaleForm.tsx`:
customer picker, multi-item Available-stock picker (full identifying
detail — code, type, design, metal/purity, weight, diamonds — shown
per line, never just an ID, and never a price/cost figure — verified
live this pass for the Staff session specifically), per-item price/
discount/GST rate/inclusive-toggle, an optional Owner-and-Staff-visible
"use suggested price" button sourced from the latest finalized Actual
Costing (§12), and the existing CGST+SGST/IGST confirmation flow reused
as-is via `previewMath.ts`.

Posting (`postFinishedJewellerySale` in `finishedSalesPosting.ts`)
is one atomic function called inside one `prisma.$transaction`:

1. Claim every selected item with `updateMany({status:"AVAILABLE"} →
   {status:"SOLD"})`, one item at a time; abort the whole sale the
   instant any claim's `count !== 1`.
2. Reuse `postSale()` (unmodified return contract) — the exact same
   Sales/GST/AR posting every other Sale in this system uses — via a
   new `additionalLines` hook that appends `Dr Finished Jewellery COGS
   / Cr Finished Jewellery Inventory` at
   `Σ getAuthoritativeInventoryCost(item)` to the **same** balanced
   journal-line insert, so the accounting-only lines and the
   stock-COGS lines are provably part of one atomic write (not two
   separate saves that could partially succeed).
3. Create `FinishedJewellerySale` + one `FinishedJewellerySaleLine`
   per item (frozen taxable value/tax/line total/COGS) + one
   `SOLD_OUT` stock movement per item — all inside the same
   transaction.

Reused (not duplicated) plumbing: `computeLineTotalsForAll` (now
exported from `accounting/posting.ts`) for the GST math,
`nextJewelleryCode`/`FINISHED_JEWELLERY_SALE` for a real atomic
sequence, the existing idempotency-key pattern for duplicate-submission
protection (checked before **and** after the transaction, exactly like
`receiveFinishedJewelleryAction`). A DB failure surfaces as "Could not
save this sale. Please try again." — verified no Prisma/Postgres detail
leaks.

Both a real **CGST+SGST** sale and a real **IGST** sale were posted
through the real browser Sale form this pass, with the exact split
reconciled to the paisa (§11).

## 6. Double-sale / duplicate-submission prevention

Proven at three independent layers now:

1. **Unit test** (fake-tx, deterministic): rejects a second claim on an
   already-`SOLD` item.
2. **10-way concurrent backend script** (earlier pass, against the real
   database, bypassing the browser): exactly 1 of 10 truly concurrent
   `postFinishedJewellerySale` calls succeeded; the other 9 failed with
   the domain error, not a connection/timeout error.
3. **Real 2-browser-tab race, this pass** (§13, Step 10): two genuinely
   separate Playwright browser contexts, each logged in as the real
   Owner independently, opened the Sale form for the *same* Available
   item and clicked "Save sale" via `Promise.allSettled` at the same
   moment. Exactly one tab showed "Sale saved as ..."; the other showed
   the rejection. Exactly one `SOLD_OUT` movement and one
   `FinishedJewellerySaleLine` existed for that item afterward,
   confirmed via the winning tab's own sale code.

A failed attempt leaves the item `AVAILABLE` and posts zero journal
rows. The same `updateMany` pattern makes a browser double-click or a
replayed Server Action equally safe — no code path exists that skips
the claim step.

## 7. Sale cancellation

`cancelFinishedJewellerySale` (Owner-only, enforced by
`requireOwner()` in `cancelFinishedJewellerySaleAction`) reuses
`cancelVoucher()` for the exact-mirror revenue/GST/AR reversal, then
per line: `updateMany({status:"SOLD"}→{status:"AVAILABLE"})` and a
`SALE_CANCELLED_IN` movement referencing the original `SOLD_OUT`
movement via `reversalOfMovementId`. Rejects a sale with any already-
returned line (directs the Owner to item-level return instead) and a
sale already cancelled.

**Generic-cancellation guard**: `cancelVoucherAction` in
`src/app/actions/vouchers.ts` now checks, for any `SALE`-type voucher,
whether a `FinishedJewellerySale` references it — if so it returns an
error directing the Owner to the domain-specific action instead of
reversing accounting alone. This mirrors the exact pattern already
proven for Rough/Metal Purchase (`voucherType === "PURCHASE"` +
`roughLot`/`metalPurchase` lookup). Verified in
`src/app/actions/vouchers.test.ts` and, this pass, live in the real
browser (§13, Step 16): clicking the generic voucher-list "Cancel"
button on a Finished-Jewellery-linked Sale voucher, filling the reason,
and confirming returns the exact rejection text directing the Owner to
the Finished Stock page — the generic reversal never fires.

Cancellation was exercised live this pass on a real **IGST** sale
(₹42,345.67), through the real `FinishedSalesManager` UI (§13, Step
15) — full eligible-sale cancellation, confirmed reversed exactly.

## 8. Item-level return

`returnFinishedJewelleryItems` — Owner-only. Reverses using **only**
the sale line's own frozen `taxableValue`/`taxAmount`/`cogsAmount`
(never current GST rates, current prices, or the master/Costing
tables) — proven by a dedicated unit test that corrupts the underlying
`FinishedJewellery` cost fields *after* the sale and confirms the sale
line and the resulting return reversal are unaffected
("historical snapshot invariance").

- **Sellable**: `Dr Finished Jewellery Inventory / Cr Finished
  Jewellery COGS` at the frozen COGS amount, `RETURNED_SELLABLE_IN`
  movement, item back to `AVAILABLE`.
- **Damaged**: `Dr Damaged Jewellery Loss / Cr Finished Jewellery
  COGS` — cost is reclassified into a loss line, **not** restored to
  inventory; item moves to the permanent terminal state
  `RETURNED_DAMAGED` with a `RETURNED_DAMAGED_OUT` movement (§2a), and
  `adjustFinishedJewelleryStock` explicitly refuses ever to touch a
  `RETURNED_DAMAGED` item again.
- **Revenue side** (both dispositions): `Dr Sales Returns` (contra-
  revenue) + exact original CGST/SGST/IGST split reversed + `Cr
  Accounts Receivable`.
- **Never twice**: `FinishedJewelleryReturnLine.saleLineId` is a
  database `UNIQUE` column, and the application layer independently
  rejects a line whose `returnStatus !== "NONE"` before even
  attempting the write.
- **Partial return safety**: `cancelFinishedJewellerySale` rejects a
  sale with any returned line — a whole-sale cancellation can never
  double-reverse a line a return already reversed.
- Resale after a sellable return works exactly like any other
  `AVAILABLE` item — proven in the unit suite (§2a's table) **and**
  live this pass through the real `FinishedSalesManager` UI (§13,
  Steps 11–12: a real sellable return, then a genuine resale of the
  same physical item to the same customer at a different price).
- A real **damaged** return was also exercised live this pass (§13,
  Step 13) via the real UI, on the item the 2-tab concurrency race
  (§6) actually sold.

## 9. Customer refund

`postCustomerRefund` (`accounting/posting.ts`) — `Dr Accounts
Receivable / Cr <payment account>` — deliberately **not** a reuse of
`postPaymentGiven` (which targets Accounts Payable for a
Supplier/Karigar, a different account and a different real-world
event). `createCustomerRefundAction` is Owner-only and independently
recomputes the customer's real AR/AP net balance from `JournalEntry`
rows before allowing a refund; an amount greater than the available
credit is rejected server-side with the exact figure quoted (never
trusts a client-submitted "available credit").

Customer credit was already visible in the existing Party
Ledger/Outstanding Report with zero code changes needed — a customer's
negative AR balance already displays as "we owe" there. A "Refund"
action was added inline on that report (Owner-only,
`CustomerRefundForm.tsx`), and "leave as customer credit" remains the
default (refunding is opt-in, never automatic) — exercised live this
pass through the real Outstanding Report UI (§13, Step 14).

**Exact-paise round trip — no tolerance used anywhere** (§11).

## 10. Actual P&L and reports

`getProfitAndLoss()` (`accounting/reports.ts`) extended in place (it
was already Owner-gated in the UI) with: `grossSales`, `salesReturns`,
`netSales`, `finishedJewelleryCogs`, `grossProfit`,
`grossMarginPercent`, `damagedJewelleryLoss`, `netProfit`,
`manualSalesAmount`/`manualSalesCount`. The pre-existing
`salesIncome`/`purchases`/`businessExpenses`/`provisionalProfit` fields
are untouched for backward compatibility. `ProfitAndLossView` now shows
the full Gross Sales → Net Profit waterfall and an explicit banner
whenever any accounting-only sale exists in the period, quoting its
exact amount and voucher count.

"Finished Sales & Profit" report tab (`FinishedSalesReportView` +
`listFinishedJewellerySaleLines` + `listManualSalesWithoutLinkedCogs`)
— sale-line grain (date/customer/item/taxable/COGS/gross-profit/
return-status), CSV export, and a clearly separated "Other /
Accounting-only sales" section.

**Real bug found and fixed this pass** — see §17.1 for the full
account: the headline "Sales · COGS · Gross profit" summary, and the
per-row "Gross profit" figure, were being computed from every sale
line's *frozen historical* `taxableValue`/`cogsAmount`, **including
CANCELLED sales and RETURNED lines**, whose revenue and COGS the
ledger has already fully reversed. A live cancelled IGST sale's stale
`cogsAmount` snapshot (₹3,20,545.46 — that item's real cost, because it
happened to carry the job's one polished diamond) was flowing straight
into the report's top-line Gross Profit figure as if it were still a
real, standing cost/loss. Fixed: the headline totals now sum only
lines where the sale is not cancelled and the line has not been
returned; a cancelled/returned row's per-line "Gross profit" cell now
shows a dash with an explanatory tooltip instead of a numeric figure,
while its historical Taxable/COGS values remain visible for audit
purposes. 4 new rendering tests in
`src/components/accounting/ReportsView.test.tsx` lock this in,
including a test that reproduces the exact real defect figures found
live (₹3,20,545.46 / ₹-2,78,199.79) and asserts they no longer appear
in the summary.

**GST is never revenue** (GST accounts are entirely separate from
`SALES_INCOME`/`SALES_RETURNS`); **inventory is not an expense until
sold** (the `Dr COGS / Cr Inventory` pair is created only inside
`postFinishedJewellerySale`, never at production); **COGS is
recognized exactly once per unreversed sale** (§2a's last lifecycle
test proves this with a direct journal-line assertion, not just
inference); **a damaged return does not restore sellable inventory**
(§8); **a cancelled sale never displays realized profit as if active**
(this section, newly fixed and tested).

## 11. Exact paise equality — no tolerance anywhere

The earlier report's "within ₹0.01" language for the refund round trip
was explicitly rejected as unacceptable for accounting acceptance. This
pass replaces every such check with **exact string equality** at
stored currency precision (`.toFixed(2)` string comparison, never a
numeric `.lessThan(tolerance)` check), both in the unit suite and
against the live database.

**Unit test** (`finishedSalesPosting.test.ts`, "exact paise equality"):
a deliberately uneven multi-item Sale → Payment Received → Return →
Refund round trip. Every intermediate AR balance is asserted as an
exact string:

| Checkpoint | Customer AR (exact) |
|---|---|
| Before the sale | `0.00` |
| After the sale (credit) | matches the sale's exact grand total, to the paisa |
| After Payment Received | `0.00` |
| After the return | negative, exactly the returned line's total |
| After the refund | `0.00` |
| **Final vs. original baseline** | **exactly equal**, string-for-string |

**Live-DB proof**: the same exact-equality assertions were run against
the real Supabase database with genuinely uneven amounts (e.g. a
₹60,123.45 CGST+SGST sale, a ₹42,345.67 IGST sale) — every CGST/SGST/
IGST split, and the full AR round trip, reconciled to an exact string
match against the manually-computed expected figure, with zero
tolerance. The same exactness was applied to GST, revenue, COGS,
inventory, refund, and P&L checks throughout this pass — every "OK"
line in §13's live browser run and the earlier live-DB script
represents an exact match, not an approximation.

`splitGstAmount` is deterministic by construction (fixed-point
`Decimal` arithmetic throughout, no floating point anywhere in the
money path), which is what makes exact equality achievable and
reproducible rather than a matter of luck.

## 12. Phase 5 Costing integration, including the Phase 5 vs Phase 6 comparison

`getSuggestedSalePrice()` (`costing/sourcing.ts`) finds the most
recent **FINALIZED Actual** CostSheet linked to a given
FinishedJewellery output and recomputes its `customerTotal` live from
the sheet's own frozen line items (via the exported `toTotalsInput`
helper from `costing/reports.ts`) — it never mutates the Cost Sheet,
and is exposed to the Sale form via `getSuggestedSalePriceAction`
(available to Staff too, since a *selling price suggestion* is not
cost/COGS/margin data). The Sale form always requires an explicit
price entry; the suggestion only pre-fills the field. Phase 6 never
reads any Costing total as COGS — COGS is always
`getAuthoritativeInventoryCost()`, a completely independent code path.

### The Phase 5 vs Phase 6 comparison view — built this pass

The earlier report flagged this as a "known limitation" despite the
approved Phase 6 requirement explicitly requesting it. It is now built:
`getPhase5VsPhase6Comparison()` (new, `costing/sourcing.ts`) +
`getPhase5VsPhase6ComparisonAction` (Owner-only Server Action,
`app/actions/finishedSales.ts`) + `Phase5VsPhase6Comparison.tsx` (new
client component), wired into the Finished Stock tab as an Owner-only
"Compare vs Costing" expandable panel per row (only shown when the row
has a linked finalized Costing).

For an eligible item, it shows side by side:

- **Phase 5 — expected**: selling value, full business cost (Phase
  4/5's figure, legitimately including `otherMaterialCost`), expected
  profit, expected margin — all recomputed live from the finalized
  Cost Sheet's own frozen lines, never by reading a stale cached total.
- **Phase 6 — actual**: net selling value (post-discount, GST
  excluded), authoritative accounting COGS, realized gross profit,
  realized margin — sourced from the item's *most recent* sale line
  (an item can only be actively sold via one unreversed line at a
  time), reflecting whichever of `NOT_SOLD | SOLD_ACTIVE |
  SALE_CANCELLED | RETURNED_SELLABLE | RETURNED_DAMAGED` currently
  applies.
- The numeric **difference** between expected and realized profit.
- An explicit sentence explaining the otherMaterialCost exclusion
  whenever it causes the two cost figures to differ (§1's live-DB
  proof above quotes the real generated sentence).
- Correct labelling for every non-active state: a cancelled sale's
  panel does not present a realized profit as if it were still
  standing; a returned item's panel is clearly marked returned/damaged
  rather than silently reusing the stale sold-state numbers.

**Rules enforced and tested**: never alters the finalized Cost Sheet
(a dedicated unit test asserts only `findFirst` calls are ever made
against `costSheet`, no `update`/`upsert`); never uses Phase 5 cost as
accounting COGS (the Phase 6 side is always computed via
`getAuthoritativeInventoryCost`, never from the Cost Sheet); does not
compare unrelated Cost Sheets (matched strictly by
`sourceFinishedJewelleryId`, most-recent `FINALIZED` only); Staff
receives `null` from the action, proven by 4 permission tests in
`app/actions/finishedSales.test.ts` **and**, live this pass, a Staff
browser session's real network capture contains zero of the panel's
field names or figures (§13).

10 calculation tests in `src/lib/costing/sourcing.test.ts` hand-verify
every figure against manually worked-out expected values (MARKUP_ON_COST,
20% markup, a hand-computed `productionCost` of 83000 and matching
selling/profit/margin figures) for each of the five lifecycle states,
plus the read-only-Cost-Sheet guarantee. Verified live through the real
browser this pass (§13, Step 18) with manually pre-computed figures
matching the on-screen panel exactly.

## 13. Real browser E2E — Owner, full business lifecycle

Per the governing instruction's requirement that a backend script alone
cannot verify real forms/Server Actions/navigation/serialization/
permissions/browser payloads, this pass built and ran genuine browser
automation, in order of preference exactly as instructed:

1. Checked the project for existing Playwright/browser dependencies —
   none present.
2. Checked for a locally-installed real Chrome — present at
   `C:\Program Files\Google\Chrome\Application\chrome.exe`.
3. Installed `playwright-core` **temporarily** with
   `npm install --no-save --no-package-lock playwright-core`, launching
   it against the already-installed real Chrome
   (`chromium.launch({ executablePath: ... })`) rather than downloading
   Playwright's own bundled browser — verified via `git status
   package.json package-lock.json` before and after that nothing was
   persisted (both files matched HEAD exactly at every checkpoint; the
   final `package.json` diff is one legitimate unrelated script-name
   addition, not a dependency). `playwright-core` was removed from
   `node_modules` entirely once this pass's verification was complete.
4. The scripts themselves, and their `.png` failure screenshots, lived
   under `scripts/_tempE2E/` (inside the project — Node's ESM module
   resolution requires this, not the session scratchpad) for the
   duration of this pass and were **deleted in full** as the final step
   of cleanup (§18) — nothing under that path exists in the working
   tree any more.

The script drove the real running production build
(`next build` + `next start -p 3100`) through **19 sequential steps**,
using narrowly-scoped `PHASE6UI`-prefixed data, entirely through the
real application UI (never direct database writes for anything the UI
could do):

1. Create Supplier/Customer/Karigar via the real Parties form.
2. Real rough purchase (10ct, ₹300,000).
3. Real Diamond Job: Issue Rough → Receive Polished (9.5ct).
4. Real Metal purchase (30g 24K gold).
5. Real Jewellery Job: metal + the one real polished diamond assigned
   to output 1 + a real other-material line (Enamel work, ₹2,000) +
   labour (₹9,000) + 3 real finished outputs (8g/8g/6g).
6. Confirm all 3 outputs in Finished Stock.
7. Create and finalize a real Phase 5 Costing (20% markup) linked to
   one output.
8. Real Finished Jewellery Sale, **CGST+SGST**: confirmed the Costing
   suggestion is shown and correctly references the Costing number, but
   used a different manually-entered price as the actual sale revenue
   — proving the suggestion is never silently substituted.
9. Real Payment Received against the customer.
10. **Real 2-browser-tab concurrent double-submit race** on a second
    output — `Promise.allSettled` on two simultaneous "Save sale"
    clicks; exactly one tab succeeded.
11. Real sellable return, through the real `FinishedSalesManager` UI.
12. Real resale of the returned item.
13. Real damaged return (on the item the concurrency race sold), through
    the real UI.
14. Real customer credit + refund check via the Outstanding Report.
15. Real full Sale cancellation, on a real **IGST** sale (₹42,345.67).
16. Real generic-voucher-cancellation rejection (§7) on a Finished-
    Jewellery-linked Sale voucher.
17. Real Accounting-only Sale, including the warning/confirmation gate.
18. Real Phase 5 vs Phase 6 comparison panel (§12), read from the live
    rendered page.
19. Cross-report reconciliation reads of Finished Stock, Dashboard,
    P&L, and the Sales & Profit report.

**Final confirmed run: all 19 steps passed, 23/23 assertions passed,
zero console errors, zero page errors, zero CSP violations.** (Getting
to this state took several real iterations — see §17 for the three real
product bugs this process found and fixed along the way; the number
above is the final, clean, reproducible state, not a first-try result,
and this report says so deliberately rather than presenting a
retouched narrative.)

**Real network-lag handling, not silently ignored**: this pass
repeatedly observed a genuine real-Postgres/pooled-connection artifact
already documented from V1 — a page navigation immediately following a
server mutation occasionally showed stale/empty data even though the
write was already correctly committed (confirmed via direct DB queries
and a fresh, later browser session). Worked around with explicit
reload-and-retry helpers everywhere this was observed (never a blind
`waitForTimeout` alone), and is called out here rather than hidden.

## 13a. Exact figures from the final confirmed browser run

Manually cross-checked against the live database, not just read off
the screen:

- **CGST+SGST sale**: manual price ₹1,35,000.00 entered (Costing
  suggestion shown separately, never substituted); GST split into
  CGST/SGST exactly, verified equal to the expected 1.5%/1.5% (or
  configured rate) split to the paisa.
- **IGST sale**: ₹42,345.67, split entirely into the IGST line, zero
  CGST/SGST lines present — confirmed by direct query.
- **P&L reconciliation** (after the full 19-step lifecycle): Gross
  sales ₹3,25,500.00 − Sales returns ₹1,85,000.00 = Net sales
  ₹1,40,500.00 (exact). Finished Jewellery COGS ₹22,909.08 (exact,
  the one currently-active sold item's authoritative cost, and
  **only** that item's — not the cancelled item's ₹3,20,545.46, not
  the damaged item's ₹30,545.46, both correctly excluded from this
  line). Gross profit ₹1,17,590.92 (exact = Net sales − COGS). Damaged
  jewellery loss ₹30,545.46 (exact = the damaged item's authoritative
  cost). Net profit ₹87,045.46 (exact = Gross profit − Damaged loss,
  with a ₹500.00 accounting-only sale correctly flagged as included in
  Net Sales but excluded from Gross Profit's cost basis via an
  explicit on-screen note).
- **Finished Sales & Profit report** (post-fix, §10): headline
  "Sales ₹1,40,000.00 · COGS ₹22,909.08 · Gross profit ₹1,17,090.92
  (3 cancelled/returned lines excluded — reversed, no realized
  profit)" — the ₹500.00 difference from the P&L's gross profit figure
  above is exactly the accounting-only sale, which this
  finished-jewellery-specific report correctly excludes and says so
  explicitly; both reports' figures reconcile exactly once that
  known, labelled difference is accounted for.
- **Phase 5 vs Phase 6 comparison panel** (real rendered text): Phase 5
  expected selling ₹28,145.45 / full business cost ₹23,454.54 /
  expected profit ₹4,690.91 (16.67% margin) vs. Phase 6 actual net
  selling ₹1,40,000.00 / accounting COGS ₹22,909.08 / realized gross
  profit ₹1,17,090.92 (83.64% margin) — difference ₹1,12,400.01,
  with the otherMaterialCost-exclusion sentence rendered exactly as
  designed (§1, §12).

## 14. Real browser E2E — Staff, permissions & payload audit

A real temporary Staff account was created through the real Settings
UI (Owner-only form) and used to log in, in a wholly separate browser
context, for a full permission-boundary pass:

- **Staff CAN post an allowed Finished Jewellery Sale**: real item
  picker, real price entry, real "Save sale" — succeeded. The picker's
  own option text was checked and contains no `₹`/price figure.
- **Staff CANNOT see** — verified by the *absence* of DOM text, not
  just by not clicking a hidden button: "Inventory cost" column/label,
  "Compare vs Costing" button, the stock-adjustment "Adjust" control,
  and the entire "Finished Jewellery Sales — cancel / return" manager
  section. All absent on both the Finished Stock tab and its mobile
  layout.
- **Owner-only reports return "Owner only" with zero cost data
  fetched, not merely hidden**: navigating directly to the Finished
  Sales & Profit and Profit & Loss report URLs as Staff shows the
  Owner-only notice text with no surrounding cost/profit figures —
  confirmed the server-side branch never even queries the data for
  that request (§10's `canSeeOwnerReports` gate).
- **Direct navigation to `/settings` as Staff** is rejected server-side
  (lands on `/unauthorized`), not just hidden from the nav bar.
- **Replaying a real captured Owner-only wire request under the Staff
  session is rejected**: the exact browser request Owner's session
  sent when clicking "Confirm cancellation" (URL, headers including
  the Next.js Server Action identifier, POST body) was captured live,
  then reissued verbatim — same URL, same body — using the Staff
  browser context's own cookies via Playwright's request API. The
  server-side `requireOwner()` check rejected it (the response encodes
  a redirect to `/unauthorized`), proving the rejection is enforced by
  the server against the session's actual role, not by the client ever
  declining to send the request.
- **Network/RSC payload audit**: every HTML, RSC-flight, and JSON
  response the Staff browser received across this entire session (13
  responses after excluding the shared static JS bundle — see the note
  below) was captured and grepped for 15 forbidden cost/margin
  substrings. **Zero hits.**

  *A note on why static JS bundles are excluded from that scan*: Next.js
  ships one shared client bundle to every authenticated user regardless
  of role — the Owner-only `Phase5VsPhase6Comparison` component's
  source code (including literal UI strings like "Compare vs Costing")
  is necessarily present in the JavaScript Staff's browser downloads,
  purely because there is no per-role bundle split, **not** because any
  Staff request ever fetched or received the real cost data that
  component would render. The actual security boundary — proven above
  — is that Staff can never trigger the code path that would fetch that
  data (`includeCost: isOwner` at the query layer, `requireOwner()` at
  the action layer, both proven independently). Scanning the bundle
  itself for these strings was tried first and produced exactly this
  expected, non-actionable "hit" in static code text, confirming the
  distinction is real and correctly drawn, not a rationalization.
- **Owner still sees everything** (contrast check, same browser
  session): "Inventory cost" and the Cancel/Return manager both present
  immediately after the Staff checks above, on the same running server.
- **Deactivating Staff blocks access immediately, mid-session**: Owner
  deactivated the account via Settings; the Staff browser's **already-
  open** session (no logout) was redirected to `/login` on its very
  next navigation — no stale JWT continued to grant access. This
  surfaced and led to fixing a real bug (§17.2).
- **A fresh login attempt with the deactivated account's correct
  password** does not reach the Dashboard.
- **Mobile viewport (390×844)**: repeated for Staff — no horizontal
  overflow, no duplicate DOM ids, hamburger nav opens and shows real
  navigation links, and the same zero-cost-data guarantee holds on
  mobile. Repeated for Owner too, confirming cost data remains visible
  there on mobile.

**Confirmed throughout, both roles, both viewports**: zero console
errors, zero page errors, zero CSP violations, zero duplicate DOM ids,
zero horizontal overflow.

## 15. Zero-balance purity edge case — reproduced precisely, not worked around

The earlier report worked around a one-time metal-stock failure by
using a second purity, without determining whether it was a real bug.
This pass reproduces the exact scenario named in the governing
instruction:

1. Purchase a purity (20g).
2. Consume it to **exactly zero** via a real issue.
3. Attempt a further issue **without replenishment** — expect
   rejection.
4. Replenish the same purity (10g, a different rate).
5. Attempt a new valid issue **after replenishment** — expect success.

**Result, both in a new unit test (`posting.test.ts`, "zero-balance
purity edge case") and in two independent standalone live-database
script runs**: step 3 is correctly rejected with `PostingError`
("stock-tracked material...must be issued"), and step 5 succeeds
cleanly with the correct re-averaged cost — replenished positive stock
is never wrongly rejected because the purity previously touched zero.

**Conclusion: this is correct guard behaviour, not a bug.** The earlier
report's single transient failure could not be reproduced across two
additional clean runs and is documented as a likely one-time real-
network/pooled-connection anomaly (consistent with the already-
documented PgBouncer-class issues from V1), not a deterministic defect
requiring a code change. No product code was changed for this item.

## 16. Permissions

Every Phase 6 Server Action independently calls `requireUser()`
(Finished Sale creation — Staff-permitted, matching the existing Sale
permission) or `requireOwner()` (cancellation, return, refund, stock
adjustment, COGS/profit reports, the Phase 5 vs Phase 6 comparison).
Verified at three layers now: mocked action-layer tests (asserting the
underlying posting engine is never called for an Owner-only action when
`requireOwner` throws), a real captured-and-replayed Staff-session
wire request (§14), and real DOM-absence + network-payload-absence
checks in a live Staff browser session (§14). The Finished Stock UI's
cost-hiding is a server-side query-shape decision (§3), not a client
check.

## 17. Bugs found and fixed this pass

Three real defects were found and fixed during this gap-closure pass —
all three were found **specifically because** real browser automation
was performed; none would have been caught by the backend-only script
from the earlier pass.

### 17.1 Finished Sales & Profit report displayed a cancelled sale's stale COGS as if it were still a realized loss

**Found via**: live browser inspection of the real Finished Sales &
Profit report after the full 19-step lifecycle (§13) showed an
implausible headline "Gross profit ₹-29,563.41" figure; a direct DB
query confirmed the cancelled IGST sale's frozen `cogsAmount` was
₹3,20,545.46 (that output's real cost, since it uniquely carried the
job's one polished diamond) and was being summed straight into the
report's top-line totals.

**Root cause**: `FinishedSalesReportView`'s headline totals and per-row
"Gross profit" cell summed every sale line's frozen historical
`taxableValue`/`cogsAmount` unconditionally — including lines whose
sale was `CANCELLED` or whose `returnStatus !== "NONE"`, even though
both cancellation and return fully reverse the original sale's revenue
and COGS in the ledger (proven separately and exactly in the P&L,
§10).

**Fix**: `src/components/accounting/ReportsView.tsx` — the headline
totals now sum only active lines (`saleStatus !== "CANCELLED" &&
returnStatus === "NONE"`), with an explicit count-and-reason note when
lines are excluded; the per-row "Gross profit" cell shows a dash with
an explanatory tooltip for a cancelled/returned line, while its
historical Taxable/COGS figures remain visible for audit purposes.

**Regression coverage**: 4 new tests in
`src/components/accounting/ReportsView.test.tsx`, including one that
reproduces the exact real defect figures (₹3,20,545.46 / ₹-2,78,199.79)
and asserts they no longer appear in the rendered summary.

### 17.2 A deactivated account's still-valid JWT could enter an infinite redirect loop instead of cleanly landing on /login

**Found via**: the live Staff-deactivation browser test (§14) — after
Owner deactivated the Staff account mid-session, the Staff browser's
next navigation attempt returned `ERR_TOO_MANY_REDIRECTS` instead of
landing on `/login`.

**Root cause**: `src/proxy.ts` redirected any visitor with a
structurally-valid (correctly signed, unexpired) JWT away from
`/login` straight to `/dashboard`, using only the token's cryptographic
validity — a check that cannot see the database's `isActive` flag (by
design; that requires a DB lookup, and the proxy is deliberately kept
to a cheap edge-safe check per its own documented design). For a
deactivated account whose cookie simply hadn't expired yet, the
sequence was: `/login → /dashboard` (proxy, JWT-only) → `/dashboard`'s
`requireUser()` finds `isActive: false`, redirects back to `/login`
(authoritative DB check) → proxy redirects `/login → /dashboard` again
→ forever, until the browser gave up.

**Fix**: removed the proxy-level "already logged in → bounce away from
`/login`" shortcut entirely. `src/app/login/page.tsx` already performs
this exact redirect correctly, using the authoritative `getCurrentUser()`
DB check (which does see `isActive`) — it was always the only place
this decision could safely be made, and the proxy's duplicate,
weaker-signal version was both redundant and actively harmful.

**Regression coverage**: `src/proxy.test.ts` — two existing tests
asserting the old (buggy) redirect were rewritten to assert no redirect
occurs at the proxy layer, plus a new test that exercises both hops
(`/login` and `/dashboard`) with the same token and asserts neither
redirects, directly modeling the loop scenario. `src/lib/auth/dal.test.ts`
gained a complementary test proving `requireUser()` still correctly
redirects a deactivated account's valid session to `/login` (never
`/unauthorized`, and never nowhere) — the other half of the fix's
contract.

### 17.3 Generic voucher cancellation form's "Cancellation reason" input had no accessible label association

**Found via**: the real browser E2E script's Step 16 (generic-
cancellation-rejection check) timed out waiting for a labelled field
that Playwright's accessibility-tree-based `getByLabel` could not find.

**Root cause**: `src/components/accounting/CancelVoucherForm.tsx` used
a plain `<label>` with no `htmlFor` next to an `<input>` with no `id` —
a real accessibility defect (a screen reader cannot associate the label
with the field) that also carried latent risk of a duplicate-`id` bug
if ever "fixed" naively with a single hardcoded id, since this form can
render once per voucher row on the transactions list.

**Fix**: replaced the hand-rolled label/input pair with the existing
`Field` component (already used identically in the new
`FinishedSalesManager.tsx`'s cancellation form), which generates a
unique, correctly-associated `id`/`htmlFor` pair per instance via
React's `useId()` — closing both the accessibility gap and the
duplicate-id risk in one change, and making the field's label
consistent with the rest of the app ("Cancellation reason", matching
the Finished Sale cancellation form's wording).

## 18. Cleanup

Dry-run inventory taken before deletion (via a script filtering on the
`PHASE6UI`/`PHASE6STAFF` name prefixes and the `@test.local` test-email
domain used for the temporary Staff account):

```
Parties (PHASE6* prefix): 6
Test users (@test.local): 1 (deactivated Staff account)
PHASE6-linked: sales=6 jobs=2 diamondJobs=1
```

All of the above were deleted (child-before-parent, relation-driven,
the same resilient deletion order used throughout this pass), and the
zero-remaining state was independently re-verified afterward:

```
Parties (PHASE6* prefix): 0
Test users (@test.local): 0
Total real Owner accounts: 1
Remaining Staff accounts (any): 0
Metal/Purity rows: 7 (GOLD 10K/14K/18K/22K/24K, SILVER 925, PLATINUM 950 — all active, unchanged)
PHASE6-linked: sales=0 jobs=0 diamondJobs=0
FinishedJewellery rows remaining (any): 0
Vouchers with "PHASE6" in their note: 0
```

Additionally verified: `login_rate_limits` had **zero** rows tied to
any test account both before and after this pass's login attempts (no
failed-login path was exercised against the rate limiter by any of the
E2E scripts — the one "wrong-state" login attempt, a deactivated
account's *correct* password, is rejected by the authoritative
`isActive` check before it can ever register as a rate-limited
failure); the real Owner's own rate-limit bucket was confirmed absent/
unlocked throughout. No Storage objects were ever uploaded by any
script this pass (no photo-upload step was exercised), so there was
nothing to clean there. `CompanySettings.updatedAt` was confirmed
unchanged by this pass's work (its last real update predates this
session's Staff/browser work entirely). Sequence counters
(`JewellerySequence`, `VoucherSequence`) were **not** rolled back, for
the same reason documented in earlier passes: rolling a shared counter
backward risks a real race with genuine concurrent usage issuing a
duplicate number; small consumed-number gaps are cosmetic only.

`scripts/_tempE2E/` (the temporary Playwright scripts, their logs, and
any failure screenshots) was deleted in full — nothing under that path
exists in the working tree. `playwright-core` was removed from
`node_modules`; `package.json`/`package-lock.json` were re-confirmed
clean immediately beforehand (`git status` showed no pending changes to
either beyond the one legitimate, pre-existing, unrelated script-name
addition).

## 19. Database design

One additive migration,
`prisma/migrations/20260912093906_phase6_finished_jewellery_sales/
migration.sql` — verified (`grep`) to contain zero `DROP`/`TRUNCATE`/
`DELETE`/destructive `ALTER COLUMN` statements; only `CREATE TYPE`,
`CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`/`ADD CONSTRAINT`,
`CREATE INDEX`, and enum-value additions. Applied to the live Supabase
database — re-confirmed this pass (`prisma migrate status` → up to
date, `prisma validate` → schema valid). Key constraints:
`FinishedJewelleryReturnLine.saleLineId UNIQUE` (never-returned-twice,
DB-enforced), `FinishedJewellerySaleLine @@unique([saleId,
finishedJewelleryId])` (no duplicate line within one sale),
`FinishedJewelleryStockMovement.reversalOfMovementId UNIQUE`
(one reversal per movement), FY-aware voucher numbering reused as-is
from the existing `nextVoucherNumber`/`nextJewelleryCode` atomic-upsert
sequence pattern (no new numbering mechanism invented).

## 20. Automated tests

| Layer | File | Count |
|---|---|---|
| Posting engine (fake-tx, real code path) | `src/lib/jewellery/finishedSalesPosting.test.ts` | 32 |
| Server Actions (permissions, idempotency, refund limit, error sanitization, Phase5vs6-comparison Owner-only) | `src/app/actions/finishedSales.test.ts` | 19 |
| Phase 5 vs Phase 6 comparison — calculation + permission | `src/lib/costing/sourcing.test.ts` | 10 |
| Finished Sales & Profit report — cancelled/returned-line exclusion (this pass) | `src/components/accounting/ReportsView.test.tsx` | 4 |
| Generic-cancellation guard regression | `src/app/actions/vouchers.test.ts` | 17 |
| Metal-stock zero-balance edge case | `src/lib/jewellery/posting.test.ts` | 69 |
| Proxy — redirect-loop regression (this pass) | `src/proxy.test.ts` | 17 |
| Session DAL — deactivated-account redirect (this pass) | `src/lib/auth/dal.test.ts` | 7 |
| Existing Phase 1–5 suite | unchanged | rest |
| **Total** | **41 test files** | **580 / 580 passing** |

Covers (from the required list, this pass's additions in **bold**):
produced-once + idempotent backfill, availability derivation via
`status`, **the full availability-delta reconciliation invariant
across 8 lifecycle paths (§2a)**, single/multi-item sale, **real
CGST+SGST and real IGST finished sales, live browser + exact-equality
proof**, discount allocation, COGS-equals-authoritative-cost (never
`totalCost`), otherMaterialCost-never-silently-posted, voucher balance,
atomic rollback on a failed claim, concurrent double-sale prevention
(unit + 10-way backend script + **real 2-browser-tab race**),
Staff-no-cost-leakage (**action-layer tests + query-shape design +
real Staff-session network-payload audit**), Owner-only cancellation/
return/refund/adjustment/report/comparison, generic-cancellation guard
(**+ live browser rejection**), cancellation restores stock + reverses
COGS, partial item return, sellable-return-and-resale (**+ explicit
no-duplicate-movement / no-double-COGS journal-line assertion**),
damaged return, duplicate-return rejection, customer credit + refund
limit (**exact-equality, no tolerance**), historical-snapshot
invariance, **Phase 5 vs Phase 6 comparison (calculation + permission +
live-browser rendering)**, **zero-balance-purity reproduction
(replenishment-after-zero correctness)**, **browser-facing Server
Action serialization (proven live — every action used through the real
Sale/return/cancel/refund forms serializes and deserializes correctly
end-to-end)**, **production CSP/security compatibility on every new UI
surface (zero CSP violations across 19 Owner steps and the full Staff
pass, both viewports)**, full Phase 1–5 regression (all pre-existing
tests retained, zero modified assertions beyond the two proxy tests
whose asserted *behavior* was itself the bug being fixed).

## 21. Known limitations (genuinely remaining, not gaps in what was asked)

- **Real-network eventual-consistency lag** (§13) is a real, already-
  documented (V1-era) characteristic of the pooled Supabase connection,
  not a Phase 6 defect — worked around with explicit retries throughout,
  never silently ignored.
- **A transient connection-pool-exhaustion message** can occur under
  very high (10-way) concurrent `$transaction` load against the pooled
  connection in the earlier backend-only concurrency script; handled
  gracefully (surfaces as a clear error, never a partial write) and does
  not affect correctness — this pass's real 2-tab browser race (a more
  realistic concurrency level for this application) did not encounter
  it.
- **A minor, pre-existing Phase 3/4 data-provenance gap**: rough pieces
  created via "returned unused rough carat" at Receive-Polished time
  get `lotId: null` and `returnedFromReceiptId`/`returnedFromJobId:
  null` — no traceable provenance chain. Confirmed still present,
  explicitly out of Phase 6's mandate (same judgment call as the zero-
  balance-purity investigation, §15), reported here only as an
  incidental finding for the Owner's awareness, not fixed.
- The one-time zero-balance-purity failure from the earlier pass could
  not be reproduced after two clean additional runs (§15) — documented
  as a likely transient anomaly, not a deterministic defect, per the
  explicit instruction not to leave it as an unexplained limitation.

## Recommendation

**PASS.** Every item in the governing instruction's gap-closure list is
now implemented and verified with real evidence: real browser E2E
(Owner, all 19 steps, including a genuine 2-tab concurrency race) and
real browser E2E (Staff, full permission/payload/mobile/deactivation
pass) both green with zero console/page/CSP errors; exact-paise
equality proven with no tolerance, unit-level and live; the damaged-
return stock equation proven exactly, including the specific
`RETURNED_DAMAGED_OUT` audit the instruction called for; the zero-
balance-purity edge case reproduced precisely and confirmed correct
guard behaviour, not an unresolved limitation; the Phase 5 vs Phase 6
comparison feature fully built, tested, and verified live; three real
product bugs found specifically because this pass insisted on real
browser evidence, all three fixed with regression coverage; 580/580
automated tests passing (up from 549); a clean production build,
`prisma validate`, `prisma migrate status`, `tsc --noEmit`, `eslint`
(zero errors), and secret scans of both the client bundle and the full
`.next` build output; and a fully-verified-clean database and working
tree with every temporary artifact removed.

Not committed. Not staged. Not pushed. Not merged. Not tagged. Not
deployed. Awaiting Owner review.
