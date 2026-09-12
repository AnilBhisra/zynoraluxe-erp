# Phase 5 (Jewellery Costing & Selling-Price Calculation) — Verification Report

Branch: `phase-5-costing`, based on the approved Phase 4 commit
`548a44badafe3e76f21f508090752f3663898243`. Not committed, pushed,
merged, or deployed — awaiting Owner review, per explicit instruction.

**This report covers two passes.** The sections below through "Known
Phase 5 limitations" are the first pass. Jump to **"Gap-closure
verification pass"** near the end for a second, more demanding pass
requested after review: a real diamond-integrated Actual costing (two
real polished diamonds, one `SET` one `RETURNED`, real recognized metal
process loss), a full GST + discount + selling-expense + rounding
Estimate reconciled step by step, deep quotation verification (DOM +
raw server HTML + print media + unauthenticated fetch), an explicit
before/after database snapshot around every single Costing action
proving zero accounting/stock mutation, and a real manipulated-request
replay of a captured Server Action using a Staff session. That pass also
uncovered and fixed **two real data-integrity bugs** in the temporary
cleanup tooling from the first pass (not the product code) that had
left orphaned rows behind — see that section for full detail. The
"Cleanup and baseline proof" section right below is superseded by the
gap-closure pass's own "Final cleanup and baseline proof" subsection.

Costing is **informational only**: it never creates a Voucher,
JournalEntry, StockMovement, or MetalStockMovement, and never mutates
any Phase 1–4 table. This is enforced by construction (the write engine
lives in `src/lib/costing/engine.ts` — deliberately not named
`posting.ts`, since it never posts anything to the ledger) and proven
by a structural test (see "Non-mutation proof" below), not merely
documented.

## Automated checks

| Check | Result |
|---|---|
| `prisma validate` | ✅ Schema valid |
| `prisma migrate status` | ✅ 6 migrations found, database schema up to date |
| `tsc --noEmit` | ✅ 0 errors |
| `eslint` | ✅ 0 errors, 0 warnings |
| `vitest run` | ✅ 457/457 tests passing (363 Phase 1–4 retained + 94 new Phase 5) |
| `next build` | ✅ Production build succeeds; `/costing` present alongside every Phase 1–4 route |
| Client-bundle secret scan | ✅ `grep -r "SUPABASE_SECRET_KEY\|sb_secret\|DATABASE_URL\|JWT_SECRET\|SESSION_SECRET" .next/static` — zero matches |
| Storage orphan check | ✅ `storage/v1/object/list` under the `costing-estimate/` prefix returns `[]` — no test images were uploaded, none left behind |

All checks were re-run **after** the two real UI bug fixes described
below (nested `<form>`, missing Estimate Finalize button), not only
before them.

## Database migration

Two additive migrations, both applied to the live Supabase database,
neither touching an existing table's existing columns:

1. `20260911170009_phase5_costing` — adds `CostingSequence`,
   `CostingSettings`, `CostSheet`, `CostSheetMetalLine`,
   `CostSheetDiamondLine`, `CostSheetOtherMaterialLine`,
   `CostSheetChargeLine`, `CostSheetAuditEvent`, plus the reverse
   relations Prisma requires on `User`/`Party`/`GstRate`/
   `PolishedDiamond`/`MetalPurity`/`FinishedJewellery`.
2. `20260911170402_phase5_costing_charge_line_is_labour` — adds one
   column, `CostSheetChargeLine.isLabour BOOLEAN NOT NULL DEFAULT
   false`, discovered necessary mid-design (see "Design decisions"
   below).

Verified via `git diff`/`grep` that neither migration file contains a
`DROP`, `ALTER ... ALTER COLUMN`, or any statement other than `CREATE
TABLE`/`ALTER TABLE ... ADD COLUMN`/`ADD CONSTRAINT`/`CREATE INDEX`.

## Design decisions made explicit (the spec left these open)

- **Actual-costing eligibility = `job.status === "COMPLETED"`.** This
  single rule cleanly subsumes "reject cancelled/incomplete/
  unresolved/Needs-Correction" and is provably safe against Phase 4's
  own retroactive other-material reallocation (`receiveFinishedJewellery`
  rewrites an *open* job's earlier outputs' `otherMaterialCost`/
  `totalCost` every time a new output is added — confirmed by reading
  `src/lib/jewellery/posting.ts`). Once a job is `COMPLETED` no further
  receipt can ever be posted against it, so its outputs' cost fields are
  permanently settled and safe to copy.
- **Never recompute a sourced figure — always copy it.** `metalCost`
  already has normal process loss silently absorbed
  (`finishedPortionCost = resolvedCost - returnedCost - scrapCost -
  lossCost`, where `lossCost` is only non-zero for an *abnormal* loss);
  `diamondCost` is already the exact sum of `costAtIssue` for diamonds
  whose `resolvedAs === "SET"` **and** `setInFinishedJewelleryId`
  matches this exact output (structurally impossible for a
  RETURNED/DAMAGED_LOST diamond to leak in); `otherMaterialCost`/
  `labourAllocated` are already fully resolved proportional shares.
  Phase 5 copies all four 1:1 in `src/lib/costing/sourcing.ts`'s
  `buildActualSourceSnapshot()` — it never re-runs Phase 4's allocation
  math. This is the single most important anti-double-counting rule in
  the phase, and it's verified with a dedicated test
  (`setupLossyCompletedJobWithOutput` in `engine.test.ts`) that forces a
  real abnormal-loss scenario and asserts the sourced metal cost matches
  the job's own already-net figure exactly.
- **Immutability via full snapshot columns, never live joins.** Every
  field a Finalized `CostSheet` displays — purity display name,
  fineness, GST rate percent, source job/receipt/output codes, source
  voucher number — is its own column, copied at creation/finalize time.
  A Finalized sheet's read-only view never re-queries `MetalPurity` or
  `GstRate` live. This is what makes the "edit the master after
  Finalize, figures stay byte-for-byte identical" real-browser test
  below actually meaningful rather than a lucky cache hit.
- **The 15-line calculation summary is never a stored column.** It is
  always derived at read time by `computeCostSheetTotals()` from the
  row's own (frozen-once-finalized) inputs — matching the codebase's
  existing "derive from immutable facts" convention. This guarantees
  immutability automatically: there is no cached total that could ever
  drift from its inputs.
- **GST is always excluded from profit and net realization**, regardless
  of Inclusive/Exclusive treatment — it is a collected-and-remitted
  liability, never real revenue. Proven by a dedicated test that forces
  the same customer total via EXCLUSIVE and via INCLUSIVE and asserts
  identical profit both ways.
- **Selling-expense percentage is computed on the GST-inclusive customer
  total** (matching how a real payment-gateway/marketplace commission is
  actually charged), while net realization still excludes GST:
  `netRealization = customerTotal - gstAmount - sellingExpenseAmount`.
- **A rounding adjustment flows into profit**, deliberately not backed
  out — it is real money the business actually collects or forgoes at
  the rounded price.
- **`PERCENT_OF_MATERIAL_COST` charge basis is `metalCost + diamondCost +
  otherMaterialCost` only**, never other charge lines — so any number of
  percentage-based charge lines compute independently, with no
  order-dependency.
- **Markup-on-cost and target-margin-on-price are never confused.**
  `pricingMethod` picks exactly one formula in `calculations.ts`;
  switching a Draft between them recomputes the selling value from the
  *same* production cost under the newly selected formula, it never
  keeps a stale number from the other mode.

## Real end-to-end verification (Supabase + real Chromium browser)

Run through the real UI against the live Supabase database — real
login, real forms, real Server Actions, real database rows — not a
mocked test. 10 full runs were executed while iterating on two real
bugs found this way (below); the final clean run (`run10`,
`TEMP-P5-375754-*`) is quoted here as the authoritative record: **all
30 steps passed**, zero console errors.

**Full Actual-costing workflow, start to finish:**

1. Created a temp Supplier/Customer/Karigar, ran a complete real Phase
   3 flow (rough purchase → issue to Karigar → receive 1 polished
   diamond, diamond job `COMPLETED`) and a complete real Phase 4 flow
   (metal purchase 22K/20g → Jewellery Job → issue 10g metal + 1
   diamond + 1 other-material line → Mark In Progress → receive 2
   outputs, 6g + 4g, with labour charged → job `COMPLETED`).
2. Created an **Actual** Cost Sheet from the 4g output — `CST/2026-27/0018`
   — and manually reconciled every sourced component against the real
   Phase 4 job/output data before touching any pricing field:
   - Metal — GOLD 22K · 4g gross / 3.664g fine · **₹13,388.89** (4 ×
     0.916 = 3.664 fine grams, confirming the fineness snapshot was
     copied correctly)
   - Other material — **₹200.00** (this output's allocated share of the
     job's other-material line)
   - Labour — **₹400.00** (this output's allocated share of the
     receipt's labour charge)
   - Diamond — **₹0.00** (correct: no diamond was set into *this*
     specific output; the 1 issued diamond was set into the job's other
     output, proving the per-output `setInFinishedJewelleryId` filter
     works, not just "any diamond on the job")
3. Set pricing to **25% markup on cost**. Calculation summary:
   Total production cost **₹13,988.89** → Suggested/Customer total
   **₹17,486.11** → Estimated profit **₹3,497.22** → Profit margin
   **20.00%** — reconciled by hand: `13388.89 + 200 + 400 = 13988.89`;
   `13988.89 × 1.25 = 17486.1125` → rounds to `17486.11`;
   `17486.11 - 13988.89 = 3497.22`; `3497.22 / 17486.11 = 20.00%` exactly
   (a 25% cost-markup always yields exactly `25/125 = 20%` margin — the
   two pricing methods are mathematically related but never conflated in
   the UI, which always shows the *achieved* number for whichever method
   is active).
4. **Finalized** the costing.
5. **Immutability test**: edited the real Metal/Purity master — 22K
   fineness `91.600% → 50.000%`, display name `22K → 22K-EDITED` — then
   reopened the already-Finalized costing. Every money figure was
   byte-for-byte unchanged, **and** the display still read the
   original `22K`, never the edited `22K-EDITED` name. This is the
   single strongest proof in the whole phase that Finalized data is a
   true frozen snapshot, not a live join that happened to not be
   visited yet.
6. Reverted the 22K master back to its exact real baseline (91.600%,
   `22K`, active) before continuing.
7. Created a **revision** from the Finalized costing. Confirmed the
   *original* (`CST/2026-27/0018`) was still Finalized and unchanged
   afterward — the revision is a new linked row, never an in-place edit.

**Full Estimate workflow, start to finish:**

8. Filled a multi-line Estimate: 10g metal line, 1ct diamond line,
   a "findings" other-material line, a labour charge line. Markup
   summary: Metal **₹55,000.00**, Diamond **₹40,000.00**, Other
   material **₹100.00**, Labour **₹2,000.00** → Total production
   cost **₹97,100.00** → at 0% markup, selling value **₹97,100.00**,
   profit **₹0.00**, margin **0.00%** (the "no markup yet" baseline,
   confirming the formula doesn't silently invent a markup).
9. Switched the same Draft to **target margin 25% on price**. Selling
   value recomputed to **₹1,29,466.67** — hand-checked:
   `97100 / (1 - 0.25) = 129466.666...` → rounds to `129466.67`;
   profit `129466.67 - 97100 = 32366.67`; margin
   `32366.67 / 129466.67 = 25.00%` exactly. Confirms the target-margin
   formula is solved for the *selling price*, not naively applied to
   cost (which would have under-shot the 25% target).
10. Saved as Draft, then **Finalized**.
11. Opened the **customer quotation** view and scanned it for every
    forbidden internal term (`cost`, `profit`, `margin`, `markup`,
    `karigar`, `wip`, voucher/job/receipt codes, etc. — with
    `costingNumber`/`costingDate` explicitly exempted since they
    legitimately contain the substring "cost"): **zero matches**. The
    quotation showed item/metal/diamond/quantity/selling
    value/taxable value/**Total** and nothing else. Also confirmed on
    the 390×844 mobile viewport (`c15-quotation-mobile.png`) — same
    clean layout, print button, no forbidden data.

**Permission/safety workflow:**

12. Created a temp Staff account. Confirmed the Staff sidebar has
    **no** Costing link at all (`c11-staff-dashboard-nav.png`).
    Confirmed navigating **directly** to `/costing` by URL redirects
    to `/unauthorized` (`c12-staff-direct-costing-redirect.png`) — not
    a client-side hide, a real server redirect.
13. Confirmed zero accounting/stock rows were created by any of the
    above: no new Voucher/JournalEntry/StockMovement/
    MetalStockMovement rows exist beyond the ones Phase 3/4's own real
    setup steps created (Phase 5's own create/finalize/revise calls
    never touch those tables — see "Non-mutation proof" below for the
    structural guarantee, independent of this one live run).

**Desktop + mobile, zero console errors:** all of the above was
screenshotted at both a normal desktop width and a 390×844 mobile
viewport (`c13-costsheets-mobile.png` — list/search/filter/CSV export;
`c14-actual-detail-mobile.png` — Finalized detail with full breakdown,
revision history, audit history, immutability notice, all readable with
no horizontal overflow; `c15-quotation-mobile.png`). `consoleErrors: []`
for the entire run.

## Real bugs found and fixed (product code, not test code)

1. **Nested `<form>` elements broke "Save pricing" and "Finalize" on an
   Actual Draft.** `RefreshFromSourceButton` and `FinalizeButton` (each
   its own `<form>`) were rendered *inside* the pricing-editing `<form>`
   in `ActualDraftEditor`. Nested `<form>` elements are invalid HTML —
   browsers silently reparent/corrupt the inner form's controls. Visible
   symptom: clicking "Save pricing" appeared to do nothing (the Markup%
   field visually reverted to 0, status stayed Draft, no error shown).
   **Fixed** by making the two buttons siblings of the pricing form
   rather than children, and consolidating a single `FinalizeButton`
   into the shared top-level header (see next bug — this fix and that
   one landed together). File: `src/components/costing/CostSheetDetailView.tsx`.
2. **No way to Finalize a Draft Estimate at all.** Finalize/Revise/
   Archive/Delete-Draft controls were only rendered for
   FINALIZED/ARCHIVED status, or inside the Actual-only
   `ActualDraftEditor` — never for `status === DRAFT && mode ===
   ESTIMATE`. An Owner filling out a full Estimate had no button to
   ever finalize it. **Fixed** by rendering `FinalizeButton` in the
   shared top-level header for *any* `status === "DRAFT"`, regardless
   of mode. File: `src/components/costing/CostSheetDetailView.tsx`.

Both were caught by real Playwright interaction against the real
browser DOM (a timeout waiting for a button that structurally did not
exist, and a Finalize that visibly failed to change status), then
confirmed by direct screenshot comparison before being called bugs —
never assumed from reading code alone.

## Test-infrastructure bug found and fixed (not shipped code)

**`fakeCostingTx.ts`'s `costingSequence.upsert` returned the same
mutable row object on every call.** Since a JS microtask boundary
exists between the upsert call and the caller reading
`sequence.lastNumber`, a slower simulated caller could observe a
*later* caller's already-incremented value before reading its own —
a race that a real Postgres `UPDATE ... RETURNING` under row-locking
could never produce. **Fixed** by returning a fresh `{...existing}`/
`{...row}` snapshot object per call. Scoped to this one new fixture
file only — `fakeAccountingTx.ts`/`fakeDiamondTx.ts`/`fakeJewelleryTx.ts`
were not touched.

## Non-mutation proof (Costing never touches the accounting ledger)

`src/app/actions/costing.test.ts` includes a structural test that
imports the *mocked* Prisma client used throughout the Costing test
suite and asserts `prisma.voucher`, `prisma.journalEntry`,
`prisma.stockMovement`, and `prisma.metalStockMovement` are all
`undefined` on it — meaning **no code path in any Costing Server
Action can even reference those tables**, not merely that it happens
not to call them today. This is backed by the live-run check above
(step 13) confirming the same thing against the real database, and by
`src/lib/costing/engine.ts` never importing anything from
`src/lib/accounting/`, `src/lib/diamond/posting.ts`, or
`src/lib/jewellery/posting.ts`.

## Automated test coverage (new this phase, 94 tests)

- `calculations.test.ts` (42) — every line-amount formula, both pricing
  methods, discount %/fixed, selling expenses, GST exclusive/inclusive
  and CGST+SGST/IGST, rounding, zero/negative/very-large inputs,
  margin ≥ 100% correctly rejected.
- `engine.test.ts` (17) — Actual sourcing (including the lossy-job
  no-double-counting case), refresh-from-source (Draft only),
  Finalize/Revise/Archive/Unarchive/Delete-Draft lifecycle, Finalized
  immutability against a mutated fixture snapshot.
- `reports.test.ts` (5) — list/filter totals, CSV escaping (commas,
  quotes), Settings fallback defaults vs. saved values.
- `quotation.test.ts` (6) — exhaustive allow-listed field check plus a
  forbidden-substring scan, `null` for a non-Finalized/Archived sheet.
- `costing.test.ts` (server actions, 19) — every single action rejects
  a simulated Staff caller, every action succeeds for Owner, idempotent
  create, `PostingError` surfacing, the non-mutation structural test
  above.
- `jewelleryMedia.test.ts` (+1) — the new `"costing-estimate"` upload
  category goes through the exact same security path as every existing
  category.

## Permissions

- **Owner**: full access — create/edit/refresh/finalize/revise/archive/
  unarchive/delete-Draft, Costing Settings, CSV export, customer
  quotation, cost/profit/margin figures throughout.
- **Staff**: no access at all. `Costing` is absent from the Staff
  navigation (`src/lib/nav.ts`); direct navigation to `/costing`
  redirects to `/unauthorized` (`requireOwner()` at the top of
  `src/app/(app)/costing/page.tsx`); every Server Action in
  `src/app/actions/costing.ts` independently calls `requireOwner()`
  first, so a hand-crafted direct call is rejected the same way a
  Staff click would be — proven both by the 19 server-action tests
  above (simulated Staff caller) and by the live browser run (real
  temp Staff account, direct URL, no nav link).
- Dashboard's "Draft costings" card and "New Costing" quick action are
  fetched only inside the `isOwner` branch of
  `src/app/(app)/dashboard/page.tsx` — a Staff-rendered Dashboard never
  even queries `getDraftCostingsCount()`.

## Cleanup and baseline proof

A one-time script (`prisma/temp-cleanup-full.ts`, written for this
session and deleted immediately after use — never committed) removed
every row created by the 10 E2E runs, scoped strictly to `Party.name`
starting with `TEMP-P5` and `User.email` containing `temp-p5`, and
everything transitively linked to them (jobs, receipts, outputs,
diamonds, purchases, lots, vouchers, stock movements). Dry-run counts
were reviewed before the real deletion ran. Final counts:

| Deleted | Count |
|---|---|
| Cost sheets | 20 |
| Jewellery jobs | 10 |
| Diamond jobs | 9 |
| Finished jewellery outputs | 16 |
| Jewellery receipts | 8 |
| Polished diamonds | 8 |
| Polished receipts | 8 |
| Rough lots / pieces | 10 / 10 |
| Metal purchases | 9 |
| Vouchers (+ cascaded journal entries) | 19 |
| Metal/diamond stock movements | 25 / 51 |
| Parties | 30 |
| Staff users | 10 |

Post-cleanup verification:

- `MetalPurity` count: **7** (unchanged — the real seeded master).
- 22K purity: `finenessPercent: 91.600`, `displayName: "22K"`,
  `isActive: true` — confirmed back at its exact real baseline.
- `Party` rows with a name starting `TEMP-P5`: **0**.
- `User` rows with an email containing `temp-p5`: **0**.
- `CostSheet` count after cleanup: **0**, so `CostingSequence` was
  also safely reset (no real costing exists yet to renumber around).
  `VoucherSequence`/`DiamondSequence`/`JewellerySequence` were **not**
  touched — they already carry real Phase 1–4 verification history
  from before this session, so resetting them would not be safe.
- Supabase Storage, `costing-estimate/` prefix: **0 objects** (no
  images were uploaded during E2E testing, confirmed via a direct
  `storage/v1/object/list` call, not assumed).

## Known Phase 5 limitations

- **CSV export is client-side**, same as every earlier phase's export —
  fine at small-shop row counts, not built for very large exports.
- **Reports/lists are not paginated** beyond a reasonable cap, matching
  the same known limitation already documented for Phase 2–4.
- **Actual-vs-Estimate variance only ever compares a genuinely linked
  pair** (`linkedEstimateId`, set explicitly by the Owner when creating
  an Actual costing, never inferred) — there is no "closest match"
  heuristic that could compare two unrelated records.
- **No automatic internet/market price fetching** for Costing
  Settings' defaults — every default is a plain Owner-entered number,
  by explicit instruction.
- **Costing Settings changes only affect new Drafts created after the
  change** — an existing Draft or Finalized sheet never gets its
  pricing/GST/rounding silently rewritten by a later Settings edit.

## Scope discipline

No deployment, marketplace integration, e-commerce, invoicing redesign,
or unrelated module was touched. No Phase 1–4 file's existing behavior
was changed except the three additive touch-points explicitly required
by this phase's own spec: `src/lib/nav.ts` (Costing became Owner-only),
`src/app/(app)/dashboard/page.tsx` (activated the "New Costing" quick
action and an Owner-only Draft-count card), and
`src/lib/storage/jewelleryMedia.ts` (one additive category string,
`"costing-estimate"`, added to an existing union type). All 363
pre-existing tests still pass unmodified in behavior (two test files —
`nav.test.ts` and `AppShell.test.tsx` — were updated because they had
previously asserted the *old, now-superseded* placeholder behavior that
Costing was visible to Staff; this is expected and required, not a
regression).

---

## Gap-closure verification pass

Requested after review of the first pass, to close specific evidence
gaps: a diamond-integrated Actual costing, a full GST/discount/fee
Estimate reconciled step by step, deeper quotation verification, an
explicit before/after zero-mutation proof, and a real manipulated
Staff Server Action replay. All of it was run through the real UI /
real Server Actions against the live Supabase database (plus targeted
direct read-only Prisma queries used only to capture exact ground-truth
figures for hand reconciliation — never to bypass the app's own write
path). Automated coverage (457 tests) is unchanged from the first pass;
this section is additional live-system evidence, not new unit tests.

### 1. Actual Costing with two real polished diamonds

Full real workflow, one continuous run (`TEMP-P5B-712440-*`):

1. **Phase 3, for real**: a rough lot of 2 pieces (1.000ct each,
   ₹20,000 total, split evenly) → both pieces issued to one Karigar in
   one Diamond Job → received back as 2 polished outputs (1.000ct each,
   0 labour) → diamond job `COMPLETED`. Resulting real polished
   diamonds, read directly from the database: `ZL-POL-2026-000013`
   (id `cmtxt7hlx00r8w0u4cnfe1m9y`, `allocatedCost` **₹10,000.00**) and
   `ZL-POL-2026-000014` (id `cmtxt7hy000rbw0u4pxuj0zgf`, `allocatedCost`
   **₹10,000.00**).
2. **Phase 4, for real**: a fresh 22K metal purchase (20g @ ₹5,000/g
   gross = ₹1,00,000, confirmed against a database read of the real
   22K pool immediately beforehand showing it genuinely empty —
   `{grossWeight: 0, costValue: 0}` — so this purchase is the pool in
   its entirety, no drift from unrelated stock). A Jewellery Job
   (`ZL-JJOB-2026-000014`) issued **18g** of that 22K metal plus
   **both** polished diamonds plus one ₹1,500.00 other-material line.
   `JewelleryJob.remainingWipCost` immediately before the receipt,
   read directly from the database: **₹90,000.00** (= 18g × ₹5,000/g
   exactly).
3. **Receive Finished Jewellery**, one output, one receipt: net metal
   weight **10g**, diamond `ZL-POL-2026-000013` (**A**) checked "set
   into this piece", diamond `ZL-POL-2026-000014` (**B**) left
   unresolved and explicitly resolved via the "Return to stock" radio
   (never set into any output), returned metal **4g**, recoverable
   scrap **1g**, "This completes the job" checked (10+4+1 = 15g
   resolved out of 18g issued → a real, recognized, **normal** —
   not abnormal — 3g process loss), labour charge **₹3,000.00**. Job
   reached `COMPLETED`.
4. **Exact reconciliation**, verified programmatically against
   `FinishedJewellery` row `cmtxt815e00saw0u4kzgymbu9`
   (`ZL-FJ-2026-000019`, job `ZL-JJOB-2026-000014`) and the two
   `JewelleryDiamondIssueLine` rows:

   | Component | Hand-derived expectation | Real DB value |
   |---|---|---|
   | Metal cost | `90000 × (10/(10+4+1)) fine-weight-ratio` = **₹60,000.00** — the lost 3g's cost is silently folded in, not carved out (see formula note below) | **₹60,000.00** ✅ |
   | Diamond cost | Diamond A's `costAtIssue` only = **₹10,000.00** | **₹10,000.00** ✅ |
   | Diamond B's contribution | **₹0.00** — structurally excluded: `resolved.input.diamondIds` for this output never includes B's id | confirmed — B's `costAtIssue` (₹10,000.00) appears nowhere in this output's fields |
   | Other-material cost | 100% of the job's one line (only output) = **₹1,500.00** | **₹1,500.00** ✅ |
   | Labour cost | 100% of the receipt's charge (only output) = **₹3,000.00** | **₹3,000.00** ✅ |
   | Total production cost | 60000+10000+1500+3000 = **₹74,500.00** | **₹74,500.00** ✅ |

   The metal-cost formula, read directly from `src/lib/jewellery/posting.ts`
   and reproduced exactly: since the job completed in this one receipt,
   `resolvedCost` is the *entire* remaining pool (₹90,000, not a
   fraction), and `returnedCost`/`scrapCost` are each a share of that
   *same* full pool sized by their fine-weight fraction of only the
   *resolved* portion (finished+returned+scrap = 15g, never divided by
   the full 18g issued) — `returnedCost = 90000×4/15 = 24000.00`,
   `scrapCost = 90000×1/15 = 6000.00`, `metalCost = 90000-24000-6000 =
   60000.00`. All three sum exactly back to the ₹90,000 pool with
   nothing unaccounted for — the lost 3g's value is *inside* the
   60000, never a separate, forgotten, or double-charged figure.
5. Created an Actual Cost Sheet (`CST/2026-27/0001`,
   id `cmtxt882s00siw0u4fjx343dy`) from this exact output. The Draft's
   own displayed breakdown: *"Metal — GOLD 22K · 10g gross / 9.16g fine
   · ₹60,000.00 … Diamond — ZL-POL-2026-000013 · 1 pc · 1ct ·
   ₹10,000.00 … Other material … ₹1,500.00 … Labour … ₹3,000.00"* —
   copied 1:1 from the reconciled figures above, byte for byte.
6. Set 25% markup, saved, Finalized. Calculation summary: Total
   production cost **₹74,500.00** → Suggested/Customer total
   **₹93,125.00** (74500×1.25) → Estimated profit **₹18,625.00** →
   Profit margin **20.00%** (25% cost-markup always yields exactly
   `25/125=20%` margin when GST/discount are both zero, confirmed
   exactly).
7. Created a revision (`CST/2026-27/0002`, Draft) from the Finalized
   sheet; confirmed the original `CST/2026-27/0001` was unaffected.

Every one of these 15 steps' database reads (2 diamonds, the metal
pool, `remainingWipCost`, the `FinishedJewellery` row, both issue
lines) came from direct Prisma queries against the live database — not
inferred from the UI — and every single figure matched the
hand-derived formula-based expectation with **zero mismatches**.

### 2. Full GST + discount + fee + rounding Estimate — exact reconciliation

One Estimate, all of the requested elements together, built and priced
through the real form (`CST/2026-27/0003`, id `cmtxt8yjn00t4w0u49kv0zajm`):

- **Lines**: metal 20g × ₹2,000/g = ₹40,000.00 (GOLD 10K — the form's
  default purity, confirmed on the printed quotation screenshot;
  fineness-independent for a `PER_GROSS_GRAM` line, so this doesn't
  affect any money figure below); diamond 3ct × ₹10,000/ct =
  ₹30,000.00; other material (manual amount) ₹1,000.00; one labour
  charge line, flat ₹2,000.00.
- **Customer**: `TEMP-P5B-712440-Customer`, given a real State
  ("Maharashtra") and State code ("27") on the Party record — this
  environment's `CompanySettings.companyStateCode` is unset (never
  configured in this dev database), so the CGST+SGST-vs-IGST
  *suggestion* has nothing to compare against; GST treatment was
  therefore picked explicitly, exactly as the spec requires
  ("state-code suggestion never silently forced" — Owner can always
  choose manually).
- **Pricing**: Target margin **20%** on selling price.
- **Intermediate capture** (before any discount/GST/fee was added):
  Total production cost **₹73,000.00** → Suggested selling value
  ₹73000/(1-0.20) = **₹91,250.00** → profit **₹18,250.00** → margin
  **20.00%** exactly (the target *is* achieved when nothing erodes it
  — confirms the formula, not yet the "recalculates after erosion"
  claim).
- **Then added, all together**: 10% percentage discount; GST
  CGST+SGST at 3%, tax-exclusive; rounding to the nearest ₹10; fixed
  selling expense ₹500 + 2% selling-expense percentage.
- **Final calculation summary, hand-reconciled step by step against the
  exact documented formula order in `calculations.ts`:**

  | Step | Formula | Value |
  |---|---|---|
  | Selling value before discount | 73000 ÷ (1−0.20) | ₹91,250.00 |
  | Discount (10%) | 91250 × 0.10 | ₹9,125.00 |
  | Taxable selling value | 91250 − 9125 | ₹82,125.00 |
  | GST (3%, exclusive) | 82125 × 0.03 | ₹2,463.75 |
  | — CGST | round2(2463.75 ÷ 2) | ₹1,231.88 |
  | — SGST | 2463.75 − 1231.88 (remainder) | ₹1,231.87 |
  | Customer total before rounding | 82125 + 2463.75 | ₹84,588.75 |
  | Rounding (nearest ₹10) | round(8458.875)×10 | ₹84,590.00 |
  | Rounding adjustment | 84590.00 − 84588.75 | ₹1.25 |
  | Selling expense | 500 + (84590×0.02) | ₹2,191.80 |
  | Net realization | 84590 − 2463.75 − 2191.80 | ₹79,934.45 |
  | **Estimated profit** | 79934.45 − 73000 | **₹6,934.45** |
  | **Profit margin** | 6934.45 ÷ 82125 × 100 | **8.44%** |

  Every one of these 13 hand-computed values matches the real UI's
  displayed Calculation Summary **exactly**, including the CGST/SGST
  1-paise remainder placement (SGST gets the odd paisa, per
  `splitGstAmount` in `src/lib/accounting/gst.ts`) and the ₹1.25
  rounding adjustment.
- **Target vs. achieved, proven live**: the target margin was **20%**;
  the real, fully-eroded, displayed margin is **8.44%** — a direct,
  concrete demonstration that adding a discount + GST + selling
  expenses recalculates the *real* profit/margin, never continuing to
  display the unachieved target. (This same claim is additionally
  covered by an existing automated test, `calculations.test.ts`:
  *"recalculates real profit/margin after discount and selling
  expenses — never the target percentage"*, and the CGST+SGST split
  and GST-inclusive/exclusive math are separately covered by
  `calculations.test.ts`'s *"CGST+SGST splits the GST amount in half,
  remainder to SGST"* and *"GST-inclusive: the selling value itself is
  treated as tax-inclusive"* tests, the latter asserting exact values
  — `customerTotal 76200.00`, `taxableSellingValue 64576.27`,
  `gstAmount 11623.73` — already part of the 457 passing tests.)
- The CostSheet row was read directly from the database after saving
  to confirm every one of these inputs was snapshotted correctly:
  `pricingMethod: MARGIN_ON_PRICE`, `targetMarginPercent: 20`,
  `discountType: PERCENT`/`discountValue: 10`, `gstTreatment:
  CGST_SGST`/`gstRatePercentSnapshot: 3`, `priceType: EXCLUSIVE`,
  `roundingStep: 10`, `sellingExpenseFixed: 500`/`sellingExpensePercent: 2`.
- Finalized, then Archived (see zero-mutation proof below for both
  transitions).

### 3. Customer quotation — deep verification

Using the Finalized/Archived Estimate above:

- **Rendered DOM** (`.quotation-print-area` only): item, metal (GOLD
  10K · 20.000g), diamond (ROUND · 1 pc · 3.000ct), Selling value
  ₹91,250.00, Discount −₹9,125.00, Taxable value ₹82,125.00, **CGST
  (1.50%) ₹1,231.88**, **SGST (1.50%) ₹1,231.87**, **Total
  ₹84,590.00**, valid-until date. Scanned for
  `profit|margin|markup|labour cost|production cost|WIP|karigar|voucher`
  (case-insensitive): **zero matches**.
- **Raw server-delivered HTML**, fetched directly with Node's `fetch`
  using the real session cookie (bypassing React rendering/hydration
  entirely, scanning the actual HTTP response bytes around the
  `quotation-print-area` markup): **zero forbidden-word matches**,
  HTTP 200.
- **Print-media emulation** (`page.emulateMedia({media:'print'})`):
  screenshotted — same clean single-column layout, no clipped text, no
  hidden totals, "Print / Save as PDF" and "← Back" controls correctly
  excluded from the print rendering by the `.quotation-no-print` CSS
  rule.
- **Mobile** (390×844): identical content, fully readable, no
  horizontal overflow.
- **No public unauthenticated URL**: a plain unauthenticated `fetch`
  (zero cookies) of the exact quotation URL returned **HTTP 307**
  redirecting to `/login?from=%2Fcosting` — the quotation is not a
  separate public route, it's a view inside the same Owner-gated
  `/costing` page, and it enforces the same session check as
  everything else on that page.

### 4. Zero accounting/stock mutation — proven with direct before/after database reads

A `MutationSnapshot` (real counts of `Voucher`, `JournalEntry`,
`MetalStockMovement`, `StockMovement`, plus the temp Karigar's real
Accounts-Payable balance and the temp Customer's real
Accounts-Receivable balance, both computed from `JournalEntry` rows by
`partyId`, exactly like the app's own ledger) was read via Prisma
**immediately before the first Costing action** and **again after every
single subsequent Costing action** in both scenarios above:

| Action | Voucher / JournalEntry / MetalMove / StockMove | Result |
|---|---|---|
| *(baseline, before any Costing action)* | 48 / 127 / 6 / 11 | — |
| Create Draft (Actual) | 48 / 127 / 6 / 11 | ✅ unchanged |
| Refresh from source (Draft) | 48 / 127 / 6 / 11 | ✅ unchanged |
| Save pricing (Actual) | 48 / 127 / 6 / 11 | ✅ unchanged |
| Finalize (Actual) | 48 / 127 / 6 / 11 | ✅ unchanged |
| Create revision | 48 / 127 / 6 / 11 | ✅ unchanged |
| Save Draft (GST-combo Estimate) | 48 / 127 / 6 / 11 | ✅ unchanged |
| Finalize (GST-combo Estimate) | 48 / 127 / 6 / 11 | ✅ unchanged |
| Archive | 48 / 127 / 6 / 11 | ✅ unchanged |
| Open customer quotation | 48 / 127 / 6 / 11 | ✅ unchanged |

The Karigar's Accounts-Payable balance (₹3,000.00, from the real
labour charge posted back in the Phase 4 receipt) and the Customer's
Accounts-Receivable balance (₹0.00) were also read at every one of
these checkpoints and never moved by one paisa. The **only** number
that ever changed across this entire sequence was `CostSheet` count
itself (0→1→…→3, as Costing's own rows were created) — exactly the
expected, and only expected, side effect.

### 5. Direct Staff server-action rejection — a real manipulated-request replay

Beyond the existing 19 unit-level Staff-rejection tests
(`costing.test.ts`), this pass captured a **genuine** Next.js Server
Action network request during the real Owner Finalize call above
(method, URL, the `next-action` header, and the exact raw POST body
Playwright's browser actually sent), then, using a **separate,
freshly-logged-in real Staff browser context** (its own real session
cookie, never the Owner's), replayed that **exact same request** —
byte-for-byte body, same target sheet — via Playwright's
`APIRequestContext.fetch`, i.e. a direct HTTP call bypassing the
rendered form/button entirely, exactly the "manipulated request"
scenario required:

- **Read attempt**: a direct RSC-mode fetch (`rsc: 1` header) of
  `/costing?tab=sheets` with the Staff session cookie: **HTTP 307**
  redirect away, response body scanned for `CST/…|Metal cost|Production
  cost` — **zero matches**. No costing data reached the Staff session
  at any layer, not just "not rendered."
- **Write attempt** (the captured Finalize-class action, replayed with
  Staff's cookie): `CostSheet` row count read from the database
  **immediately before** (3) and **immediately after** (3) the
  replay — **unchanged**. The specific target sheet's `finalizedAt`
  timestamp was also read before/after — **unchanged**. The server
  responded (redirected, not a 500 crash), but produced **zero
  database effect** either way — the authorization guard rejected the
  request before any mutation, exactly as the 19 unit tests already
  predict, now proven against a live network request instead of a
  simulated function call.
- Direct navigation and nav-link checks (unchanged from the first
  pass): Staff's sidebar has no Costing link; a direct `/costing`
  request redirects to `/unauthorized`.

### Two real data-integrity bugs found and fixed (temporary cleanup tooling, not product code)

While reconciling the diamond-integrated Actual costing above, the real
`FinishedJewellery.metalCost` briefly came back as ₹57,092.51 instead
of the hand-derived ₹60,000.00 — investigating *why* uncovered two real
gaps in the **first pass's own cleanup script** (a temporary,
never-committed tool, not part of the Costing feature itself), both of
which had left orphaned rows silently inflating real ledger/stock
figures:

1. **Orphaned `MetalStockMovement` rows.** The first pass's cleanup
   deleted temporary `MetalPurchase` rows but only deleted
   `MetalStockMovement` rows linked via `jewelleryJobId` — a purchase's
   own `PURCHASE_IN` movement carries no such link (only a free-text
   `sourceDocument` code), so it was never matched and never deleted.
   Found **9 orphaned `PURCHASE_IN` movements** (20g/₹1,00,000 each,
   180g/₹9,00,000 total) still silently inflating the real 22K Gold
   Metal Stock pool — exactly what corrupted the diamond-costing
   reconciliation's weighted-average rate above.
2. **Orphaned job/receipt `Voucher` rows.** `DIAMOND_ISSUE`/
   `DIAMOND_RECEIPT`/`JEWELLERY_ISSUE`/`JEWELLERY_RECEIPT` vouchers
   never carry a `partyId` at the header level (only individual journal
   lines do, for the Karigar-payable leg) and are always created by the
   real Owner — so the first pass's party/user-scoped voucher cleanup
   filter could never match them once their parent Diamond/Jewellery
   Job or Receipt row was already deleted. Found **46 orphaned
   vouchers** (with 123 cascaded journal entries) — every single
   `DIAMOND_ISSUE`/`DIAMOND_RECEIPT`/`JEWELLERY_ISSUE`/
   `JEWELLERY_RECEIPT` voucher remaining in the database, confirmed
   orphaned by cross-checking against every currently-surviving
   `DiamondJob`/`PolishedReceipt`/`JewelleryJob`/`JewelleryReceipt`
   row's own `wipVoucherId`/`postingVoucherId` (zero were still
   referenced).

Both were real, silently-accumulating corruption of the live
Supabase database's core accounting/stock figures — **not** a defect
in any Phase 1–5 product code path (Costing itself never touches
either table, and Phase 3/4's own posting code correctly links every
movement/voucher it creates; the gap was purely in the temporary,
never-committed cleanup script's *deletion* coverage). Fixed by writing
a corrected sweep (delete `PURCHASE_IN` movements whose
`sourceDocument` doesn't match any currently-existing
`MetalPurchase.purchaseCode`; delete the 4 job/receipt voucher types
that aren't referenced by any currently-existing parent row's
voucher-id field) and re-running the diamond-costing scenario end to
end against a verified-clean pool, which reproduced the originally
hand-derived clean figures (₹60,000.00 metal cost) exactly — confirming
the Phase 5/Phase 4 calculation code itself was correct throughout; only
the leftover test data was wrong.

### Final cleanup and baseline proof (supersedes the first pass's own section above)

A dry-run was reviewed before every real deletion, every pass. Final
state, verified by direct database count:

| Table | Count |
|---|---|
| Party | **0** |
| User | **1** (the real Owner only) |
| RoughLot / RoughPiece | **0** / **0** |
| DiamondJob / PolishedReceipt / PolishedDiamond | **0** / **0** / **0** |
| MetalPurchase / MetalStockMovement | **0** / **0** |
| JewelleryJob / JewelleryReceipt / FinishedJewellery | **0** / **0** / **0** |
| StockMovement | **0** |
| CostSheet | **0** |
| **Voucher / JournalEntry** | **0** / **0** |

- `MetalPurity`: **7** rows, unchanged; 22K confirmed at its exact real
  baseline (`finenessPercent: 91.600`, `displayName: "22K"`,
  `isActive: true`).
- Master data confirmed untouched: `Account` (23), `PaymentAccount`
  (3), `GstRate` (6) — all exactly the seeded set.
- `InvoiceLine`: 0, `CostingSettings`: 0 (Owner never saved Settings in
  any test run) — both correctly empty, not evidence of deletion.
- `CostingSequence` reset to empty (safe — zero real cost sheets exist
  to renumber around). `DiamondSequence`/`JewellerySequence`/
  `VoucherSequence` were **not** reset — they carry real historical
  numbering from Phase 1–4's own verification and this session's
  testing; resetting them is never safe regardless of what currently
  exists, only ever additive-safe to leave alone.
- Supabase Storage, `costing-estimate/` prefix: **0 objects** — no
  images were uploaded in either pass, reconfirmed via a direct
  `storage/v1/object/list` call after this pass's cleanup too.
- Every temporary script used this pass (a combined Playwright +
  direct-Prisma-read E2E script, the corrected cleanup sweep, and the
  orphan-voucher sweep) was written under `prisma/temp-*.ts`, run, and
  then **deleted** — confirmed via `git status` showing zero trace of
  any of them, and zero change to `package.json`/`package-lock.json`
  (a temporary local-only `npm install --no-save --no-package-lock
  playwright` was used to run the browser automation, then the
  installed packages were removed from `node_modules` afterward —
  `node_modules` is gitignored and untracked either way).

### Final checkpoint (re-run after the gap-closure pass)

| Check | Result |
|---|---|
| `prisma validate` | ✅ Schema valid |
| `prisma migrate status` | ✅ 6 migrations, database schema up to date |
| `tsc --noEmit` | ✅ 0 errors |
| `eslint` | ✅ 0 errors, 0 warnings |
| `vitest run` | ✅ 457/457 tests passing (unchanged — no product code was modified this pass, only verification tooling) |
| `next build` | ✅ Production build succeeds |
| Client-bundle secret scan | ✅ zero matches |
| `git status` / `git diff --stat` | ✅ Exactly the Phase 5 feature files — 10 modified, 8 new paths (migrations, `costing/` code, tests, docs) — no temp scripts, `.env`, screenshots, or logs |

Not committed, pushed, merged, or deployed. Awaiting Owner review.
