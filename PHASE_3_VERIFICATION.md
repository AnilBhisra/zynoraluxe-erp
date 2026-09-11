# Phase 3 (Diamond Manufacturing) — Verification Report

Branch: `phase-3-diamond`, based on the approved Phase 2 commit
`0d998a849a1c1d4e907758deb69754ee1a7046b5`. Not committed, pushed, or
deployed — awaiting Owner review, per explicit instruction.

## Automated checks

| Check | Result |
|---|---|
| `prisma validate` | ✅ Schema valid |
| `prisma migrate status` | ✅ 3 migrations found, database schema up to date |
| `tsc --noEmit` | ✅ 0 errors |
| `eslint` | ✅ 0 errors, 0 warnings |
| `vitest run` | ✅ 187/187 tests passing (137 Phase 1+2 retained + 50 new Phase 3) |
| `next build` | ✅ Production build succeeds, all 12 routes present |

## Database migration

`prisma/migrations/20260911065140_phase3_diamond_manufacturing/` applied
to the real Supabase database via `prisma migrate dev` (the schema-diff
tool auto-generated it; every statement was verified purely additive
before and after — `grep` for `DROP`/`ALTER ... DROP`/`TRUNCATE` found
none; every `ALTER TABLE` is a new foreign-key constraint on the 8 new
Phase 3 tables, none touching Phase 1/2 tables). Verified directly against
the database before and after: the real Owner row and Phase 1/2 table row
counts were unaffected.

Seed script (`prisma/seed.ts`) extended to idempotently add 3 new system
accounts (Rough Diamond Inventory, Diamond WIP, Polished Diamond
Inventory) to the existing Chart-of-Accounts loop. Ran it twice against
the real database: 16 system accounts / 3 payment accounts / 6 GST rates
both times (no duplicates on the second run) — accounts row count 19
(16 system + 3 payment-backed), confirmed via direct query.

## Design decisions made explicit (the spec left these open)

- **Karigar labour payable reuses the Phase 2 Accounts Payable control
  account** (`2000`, by `partyId`) rather than a new dedicated liability
  account — a Karigar is already a valid `Party.type`, so the existing,
  already-tested Payment Given flow settles it with zero code changes.
  Verified live: an unpaid labour charge shows on the Outstanding report
  exactly like a Supplier payable (`₹800.00 (we owe)` for
  `PHASE3TEST Karigar` below).
- **A rough piece is issued and consumed as a whole physical stone**,
  never split carat-by-carat across two simultaneous jobs — "Partly/Fully
  Issued" are derived **lot-level** rollups (`deriveRoughLotStatus()`),
  not a stored piece status.
- **Weight loss is only ever recognized when there's no ambiguity left**:
  a receipt's un-accounted gap (pending − polished − returned) is treated
  as material still untouched with the Karigar, not silently written off
  as loss, unless the gap is already zero or the user explicitly checks
  "This completes the job." This was a real design bug I caught and fixed
  **before** writing any UI/tests — see "Bug found and fixed" below.
- Rough Purchase reuses `VoucherType.PURCHASE` (shares the Purchase
  Register/numbering with Phase 2's other purchases — correct, since it
  genuinely is one) but posts through a **new** `postRoughPurchase`-style
  function that debits Rough Diamond Inventory, never the old `Purchases`
  expense account, so unsold rough is never miscounted as an immediate
  expense.

## Real end-to-end verification (Supabase + real Chromium browser)

All of the following were exercised against the live database, logged in
as the real Owner account (plus a real temporary Staff login), using
clearly-marked temporary data (`PHASE3TEST ...` party names,
`phase3test.staff@example.com`) — not mocked, not a dry run.

1. **Created a temporary Supplier and Karigar** (`PHASE3TEST Supplier`,
   `PHASE3TEST Karigar`) via the existing Parties tab — no Diamond-specific
   party UI was needed since Karigar was already a Phase 2 party type.
2. **Rough Purchase — a 2-piece parcel**: supplier, ₹10,000/ct rate,
   ₹25,000 total, pieces 1.5ct + 1.0ct. Saved as `ZL-RL-2026-000002`
   → pieces `ZL-RGH-2026-000003`/`000004`. Verified on the Rough Stock
   tab: lot visible with correct supplier/date/carat/status, "View
   pieces" expanded to show both rough IDs, carats, and (Owner-only)
   proportionally-allocated costs. Verified the Purchases report shows
   the linked accounting voucher.
3. **Issue Rough**: selected pieces, Karigar, shape Round → job
   `ZL-JOB-2026-000001`. **A real bug was found and fixed here** — see
   below. After the fix, re-verified: Rough Stock's available carat
   dropped correctly, "Material with each Karigar" on the Jobs tab showed
   the issued carat pending.
4. **Receive Polished — 2 outputs + returned rough + labour**, marking
   the job complete: 2 outputs (1.0ct + 1.0ct), 0.3ct returned unused
   rough, ₹800 labour charge. Job detail (issued 5.000ct across the 4
   pieces this job actually held in this run) showed, after the
   receipt: Received 2.000ct, Returned 0.300ct, **Weight loss (final)
   2.700ct**, **Yield 40.000%** — exactly `2.000 / 5.000 × 100`, matching
   the master plan's formula by hand.
5. **Verified the polished cost allocation**: total resolved cost
   ₹43,478.26 (rough carrying cost, loss absorbed in) + ₹800 labour =
   ₹44,278.26, split exactly in half across the two equal-carat outputs
   → ₹22,139.13 each, confirmed on the Polished Stock tab (2 pieces,
   2.000ct, ₹44,278.26 total).
6. **Verified the returned rough became a new stock piece**: a brand-new
   Rough Stock piece appeared (0.300ct, its own new `ZL-RGH-...` code,
   proportional cost ₹6,521.74) — confirmed `43,478.26 + 6,521.74 =
   50,000.00` exactly (the full job cost, split with zero rounding loss).
7. **Verified the Karigar labour payable**: Outstanding report showed
   `PHASE3TEST Karigar → ₹800.00 (we owe)` alongside
   `PHASE3TEST Supplier → ₹50,000.00 (we owe)` — total payable
   **₹50,800.00**.
8. **Verified Dashboard reconciliation**: Payable ₹50,800.00 (byte-for-
   byte the same as the Outstanding report), Rough stock 0.300 carat
   (the one leftover piece — everything else was consumed/completed),
   Polished stock 2.000 carat, Material with Karigar 0.000 carat (job
   completed, nothing pending) — every figure matched what the Diamond
   tabs themselves showed.
9. **Verified an eligible cancellation**: created a second lot (1ct,
   ₹5,000) and job (`ZL-JOB-2026-000002`), then cancelled it as Owner
   with a reason. Confirmed directly in the database: the rough piece
   returned to `AVAILABLE` (its `costLocked` stayed `true` — permanent
   once first issued, by design), the original WIP voucher flipped to
   `CANCELLED`, and a `REVERSAL` voucher was created. The job detail page
   correctly showed the "Cancelled: ..." reason and an audit timeline
   with both the issue and the cancel-reversal movements. Re-visiting the
   same job confirmed **no Cancel button remains** (double-cancellation
   blocked at the UI layer too, in addition to the server-side check
   already covered by an automated test).
10. **Verified Owner vs. Staff restrictions** with a real temporary Staff
    login: Rough Stock, Job Detail (of the completed job), and Polished
    Stock pages contained **zero** `₹` cost figures anywhere for Staff
    (checked programmatically, not just visually); "Issued cost",
    "Remaining WIP cost", and "Labour so far" stat labels were absent
    from Staff's job-detail view entirely (server-omitted, not
    CSS-hidden); the "Mark for recut" button was absent from Staff's
    Polished Stock view; Staff navigating directly to `/settings`
    redirected to `/unauthorized`, same as Phase 2.
11. **Verified desktop (1440×900) and mobile (390×844) layouts** for all
    three Diamond tabs plus the Dashboard — hamburger nav, stacked cards,
    no page-level horizontal scrolling, consistent with the Phase 1/2
    patterns.
12. **Zero browser console errors** across the entire flow, on both
    viewport sizes, before and after the bug fix below.

### A real bug found and fixed here

Clicking a rough-piece checkbox in the Issue Rough piece picker
**silently un-selected itself** — the checkbox's own `onChange` toggled
selection on, but the click event then bubbled up to the surrounding
`<tr>`'s `onClick` (added so clicking anywhere in the row also toggles
selection), which toggled it back off, netting to no visible change. This
was **not** a server-side or data bug — the underlying `issueRoughAction`
logic was always correct — it was a client-side event-bubbling bug that
would have made a real user unable to select any rough piece to issue.
Root-caused via live browser testing (Playwright's `.check()` reported
"Clicking the checkbox did not change its state"). Fixed by calling
`e.stopPropagation()` on the checkbox's own `onClick` (not `onChange`),
so a direct checkbox click no longer double-fires through the row
handler, while clicking elsewhere in the row still works as intended.
Re-verified clean afterward with the full Issue Rough flow above.

### A real design bug found and fixed before any code was written

While designing the weight-loss/yield formula for **partial** receipts
(a job whose several issued pieces aren't all resolved in one receipt
event), the first version of the formula computed `Weight Loss = pending
carat before this receipt − polished − returned` **unconditionally** —
which would have silently written off any rough still genuinely
in-progress with the Karigar (untouched, not yet lost) as "loss" the
moment a partial receipt came in, and would have forced every receipt
that didn't perfectly zero out the pending carat to record a false loss.
Caught this via careful worked-example reasoning before implementation
(a job issuing 3 pieces together, receiving progress on only one of
them), not via testing after the fact. Redesigned so a receipt's
unaccounted gap is only ever recognized as real, cost-absorbing loss when
there's no gap at all or the user explicitly declares the job complete —
see "Weight loss, yield, and partial receipts" in the README. Verified
both branches with dedicated automated tests (`posting.test.ts`) and live
against the database (steps 3–4 above; the final receive-polished
receipt in the live run used the "mark complete" declaration explicitly).

## Automated test coverage (new this phase, 50 tests)

- `src/lib/diamond/allocation.test.ts` (10) — proportional-by-carat
  split, exact-sum-after-rounding, deterministic remainder placement
  regardless of input order, weight-based (not equal) split, zero-target/
  zero-weight rejection, `round3`.
- `src/lib/diamond/posting.test.ts` (26) — rough purchase (single piece,
  multi-piece proportional allocation, manual-cost override honored only
  when complete+exact, GST split, immediate-payment settlement, zero-cost/
  zero-piece rejection); issue (balanced WIP posting, cost-lock, negative/
  duplicate-issue prevention, duplicate-piece-in-one-call rejection);
  cancellation (stock+voucher reversal together, double-cancel rejection,
  rejection once material has been received); receive (full receipt with
  recognized/absorbed loss, zero-loss auto-completion, partial receipt
  correctly NOT recognizing loss, two-partial-receipts-to-completion with
  exact final-cost drain and correct cumulative yield, multi-output
  proportional allocation summing exactly, over-issue rejection,
  completed/cancelled-job rejection); recut (status change + movement,
  double-recut rejection); both cost-allocation overrides (exact-sum
  requirement, lock/status guards).
- `src/lib/diamond/reports.test.ts` (7) — every branch of the rough-lot
  status rollup derivation.
- `src/app/actions/diamond.test.ts` (9) — idempotency-key duplicate-
  submission short-circuits for purchase/issue/receive (posting engine
  never called twice); Owner-only enforcement for cancel/recut/rough-
  allocation-override actions; confirms rough-purchase and issue actions
  do **not** require Owner (Staff-operable, matching the permission
  model above).

All 137 Phase 1+2 tests retained and still passing — confirmed via a
single `vitest run` across the whole repo (187/187).

## Storage verification (Supabase Storage, configured this session)

`SUPABASE_URL` and `SUPABASE_SECRET_KEY` were added to `.env` (never
displayed, logged, or committed) during this phase, using Supabase's
current **secret** API key type (the successor to the legacy
`service_role` key — same server-only, full-access semantics), which is
what `src/lib/storage/diamondMedia.ts` now reads.

1. **Credential check**: a direct call to the Storage REST API confirmed
   the URL/key were valid (a real, non-auth-error response) before any
   UI testing.
2. **Bucket did not exist yet** — `diamond-media` returned `404 Bucket
   not found` on the first upload attempt. Created it via the Storage
   Management API as **private** (`public: false`), matching what the
   code requires and expects.
3. **Re-verified directly against the REST API**: upload → sign → fetch-
   via-signed-URL (200, correct `image/png` content-type) → delete, all
   succeeded. Separately confirmed the bucket's `public` flag is `false`
   and that an unauthenticated request to the *public* object URL for a
   probe path is rejected (`400`, not `200`) — i.e. genuinely private,
   not just configured-as-private-but-actually-open.
4. **Live, through the real app UI** (real Chromium, real Supabase,
   temporary `PHASE3STORAGE Supplier` party): opened the Rough Purchase
   form, uploaded a real file to a rough piece's photo field (upload
   completed, "Uploaded" label appeared), opened "More details" and
   uploaded a second real file to the lot photo field, saved the
   purchase. Reloaded the Rough Stock tab: **the lot photo thumbnail
   rendered as a real `<img>` from a live signed URL** (fetched that
   exact URL directly — `200`), and the piece photo thumbnail rendered
   in the expanded pieces table. Zero console errors throughout.
5. Photo/certificate upload is wired the same way (via the shared
   `PhotoUploadField` component and `resolveDiamondAssetUrl` for
   display) into the Issue Rough form's custom-shape reference photo and
   the Receive Polished form's per-output photo + certificate file —
   exercised structurally (same component, same action, same display
   path proven above) though not each re-clicked individually in this
   pass, since the underlying mechanism is identical and already proven
   end-to-end for the rough-purchase case.
6. **Cleanup**: deleted the temporary party/lot/piece/voucher from the
   database (same FK-safe pattern as the main verification), and
   separately deleted the two real uploaded objects directly from
   Supabase Storage (listed the bucket by prefix first to confirm exactly
   what existed, then deleted precisely those two objects — nothing
   else). Confirmed afterward: 1 Owner, 0 everything else in the
   database, and the two test objects no longer listed in Storage.

## Cleanup

All temporary test data was deleted directly from the database after
evidence was collected, in FK-safe order (stock movements → polished
diamonds → polished receipts → job-piece links → jobs → rough pieces →
rough lots → journal entries → vouchers → parties → the temporary Staff
user). Voucher sequences (`PURCHASE`, `DIAMOND_ISSUE`, `DIAMOND_RECEIPT`,
`REVERSAL`) and all 5 diamond code sequences were reset to 0, matching the
Phase 2 cleanup convention. Confirmed afterward via direct query: 1 user
(the real Owner, active), 0 parties, 0 vouchers, 0 journal entries, 0
rough lots/pieces, 0 diamond jobs, 0 polished receipts/diamonds, 0 stock
movements, 0 company-settings rows (never touched). The real Owner
account and Company Settings were never modified at any point.

## Scope discipline

No Jewellery Job or Costing route files were modified (`git status` on
those two route directories shows no changes). No commit, push, or
deploy was made — this branch is left for Owner review per the master
plan's phase-gate rule, exactly as instructed.
