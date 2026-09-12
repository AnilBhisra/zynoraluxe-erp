# ZYNORALUXE ERP — Version 1 Final Acceptance Report

Branch: `v1-final-acceptance`, based on the approved Phase 5 commit
`e1a292e5db4d069b753e28210f6ed2550ab2a388` (itself directly on Phase 4
`548a44b`, Phase 3 `5b1a17b`, Phase 2 `0d998a8`, Phase 1 `19493fd`).
Not committed, pushed, merged, tagged, or deployed — this is the
pre-Owner-review acceptance audit for the whole locked Version 1 scope
(`Accounting + Diamond Manufacturing + Jewellery Job + Costing`, per
`ZYNORALUXE_JEWELLERY_ERP_MASTER_PLAN.md` §12).

> **Update (gap-closure pass, same branch)**: the two real gaps this
> report originally flagged as unfixed or deferred — the duplicate-DOM-`id`
> defect and the "no login rate-limiting / no HTTP security headers"
> production-readiness gaps — have since been **closed**. See §6a
> (duplicate-id architectural fix), §14 (login rate limiting), and §15
> (HTTP security headers/CSP) for the full detail, evidence, and the two
> additional real bugs found and fixed *while closing those gaps*
> (documented in §6b/§6c, since fixing one thing surfaced two more). The
> rest of this report (§1–§13) is the original audit, left intact as the
> historical record of what was tested before this gap-closure pass
> began; read §14 onward for what changed since.

## Recommendation: **PASS** (3 deployment items remain — see "Deployment blockers")

Every one of the 18 required workflow steps, every financial/stock
reconciliation, the full permission matrix, and every dependency
invariant tested pass. Of the two real defects this audit originally
found, **both are now fixed**: cancelling a Rough/Metal Purchase after
its stock was consumed (found and fixed in the original pass), and the
duplicate-DOM-`id` collision between two Settings forms (found in the
original pass, fixed architecturally in the gap-closure pass, §6a). Of
the two production-readiness gaps originally flagged as deployment
blockers, **both are now implemented and live-verified**: persistent
login rate limiting (§14) and enforced HTTP security headers/CSP (§15).
Two further real findings surfaced while implementing those two gaps —
an interactive-transaction pattern observed to hang under real pooled
load (§6b, mechanism not conclusively proven — see the correction
inside §6b itself) and a static-page CSP-nonce mismatch (§6c) — neither
was present in the original audit's scope, both are now closed with
real-database/real-browser evidence.

No deployment work was done or is claimed; see "Deployment blockers"
for the 3 items that genuinely remain (real secrets, real company
details, backup/export policy — none of which an audit pass can
supply on the Owner's behalf). The Owner should personally review the
screens listed at the end of this report before final sign-off, and
separately review the Owner's own approved decision to build **Finished
Jewellery Sale → Stock → COGS/P&L** as a new Phase 6 before deployment
(§16) — not started, per explicit instruction.

---

## 1. Exact tested workflow

One continuous, real E2E run (`V1AUDIT-805912-*` identifiers; 10 earlier
runs, `V1AUDIT-{runId}-*`, were used to iteratively find/fix issues and
are documented in "Bugs found and fixed" and fully cleaned — see
§11), through the real UI, real Chromium, real Server Actions, and the
live Supabase database:

1. **Company Settings** — name "ZYNORALUXE", state code `24`
   (Gujarat). *(Real configuration, deliberately left in place — see
   "Company Settings decision" below.)*
2. **Parties** — Customer (state `24`, same as company → CGST+SGST
   case), Supplier (state `27`, different state → IGST case), Karigar,
   temp Staff account.
3. **Accounting Purchase** — interstate, IGST, on credit, from the
   Supplier.
4. **Rough diamond purchase** — 2 pieces (1.2ct + 0.8ct), ₹40,000 total.
5. **Issue rough to Karigar** — both pieces, one Diamond Job.
6. **Partial polished receipt** — 1.0ct from the 1.2ct piece; job stayed
   `PARTIALLY_RECEIVED`.
7. **Final polished receipt** — 0.7ct from the remaining 0.8ct piece
   (0.1ct recognized weight loss), "This completes the job" checked;
   job reached `COMPLETED`.
8. **Real polished-diamond stock** — confirmed via direct database
   read: `ZL-POL-2026-000033` (1.0ct, allocated cost ₹20,000.00) and
   `ZL-POL-2026-000034` (0.7ct, allocated cost ₹20,000.00).
9. **Metal purchase** — 22K, 30g @ ₹6,000/g.
10. **Opening Metal Stock** — 22K, 5g, ₹30,000 (exercises the Opening
    workflow separately from Purchase).
11. **Jewellery Job creation** — Customer + Karigar.
12. **Issue metal + real polished diamonds** — 20g @ 22K, both real
    polished diamonds, one ₹800 other-material line.
13. **Partial jewellery receipt** — output 1 (10g net), diamond A
    checked **SET** into this output, 3g metal returned, ₹1,500
    labour; job stayed `PARTIALLY_RECEIVED`.
14. **Final jewellery receipt** — output 2 (5g net), diamond B resolved
    **RETURNED** to stock, 1g metal returned, 0.5g scrap, a recognized
    metal loss, ₹1,000 labour, "This completes the job" checked; job
    reached `COMPLETED`.
15. **Metal return/scrap/loss reconciliation** — proven via direct
    database read of the resulting `FinishedJewellery` rows (§2 below).
16. **Diamond SET/RETURNED resolution** — proven via direct read of
    `JewelleryDiamondIssueLine`: diamond A `resolvedAs: SET`,
    `setInFinishedJewelleryId` pointing at output 1; diamond B
    `resolvedAs: RETURNED`, `setInFinishedJewelleryId: null`.
17. **Karigar labour payable** — Accounts Payable balance read directly
    before (₹2,500.00, from the diamond job's own labour plus the two
    jewellery receipts' labour) and after settlement.
18. **Payment Given** — ₹1,500 to Karigar (Bank, partial settlement,
    payable dropped to ₹1,000.00) and ₹5,000 to Supplier (Bank, clears
    the earlier Purchase).
19. **Actual Costing** — created from the finished output that carries
    the SET diamond; 30% markup; Finalized.
20. **Estimate Costing** — same-state customer, CGST+SGST @ 3%, target
    margin 15%; Finalized.
21. **Finalized customer quotation** — opened and scanned; see §7.
22. **Accounting Sale** — same-state, CGST+SGST, ₹25,000 item, to the
    Customer — see §2 for the exact boundary proof against
    `FinishedJewellery`.
23. **Payment Received** — ₹10,000 (Cash), partial settlement.
24. **Owner-only cancellation/reversal flows** — a safe cancellation
    (a throwaway Expense voucher, immediately cancelled — reversal
    posted, no downstream dependency), and multiple *rejected*
    cancellation attempts — see §3.

Every one of these steps ran through the real rendered form, not a
direct database write — the only direct-database reads used in this
audit were for capturing exact IDs/figures for reconciliation, exactly
the same methodology proven in the Phase 5 gap-closure pass.

### Company Settings decision

`CompanySettings` was entirely unconfigured before this audit
(`companyStateCode: null`, no company name). Populating it was
necessary to genuinely exercise the same-state/interstate GST
suggestion logic end to end (§1 items 1–2), and — unlike the
`V1AUDIT`-prefixed rows — this is real, singleton configuration data,
not disposable test data, so it was **left in place** rather than
reverted to blank. The Owner should update the company name, address,
GSTIN, and state code to the real registered business details before
go-live; the state code `24` (Gujarat) was chosen only to make the
CGST+SGST-vs-IGST demonstration meaningful and is a placeholder.

---

## 2. Manual financial and stock reconciliation

Every figure below was read **directly from the database** (never
inferred from the UI alone), and cross-checked against what the UI
itself displayed for the same fact — no disagreement was found in any
of them.

### Finished output cost (exact, from the real workflow above)

| Output | Metal | Diamond | Other material | Labour | **Total** |
|---|---|---|---|---|---|
| Output 1 (`ZL-FJ-2026-000034`, has the SET diamond) | ₹43,264.63 | ₹20,000.00 | ₹533.33 | ₹1,500.00 | **₹65,297.96** |
| Output 2 (`ZL-FJ-2026-000035`) | ₹23,296.34 | ₹0.00 | ₹266.67 | ₹1,000.00 | **₹24,563.01** |

- **Diamond cost proof**: only diamond A's `costAtIssue` (₹20,000.00,
  its own real allocated cost from Phase 3) appears in output 1; diamond
  B's ₹20,000.00 appears **nowhere** — it was `RETURNED`, never `SET`
  into any output, structurally excluded by the same `diamondIds`
  membership check verified in Phase 5.
- **Other-material proof**: the job's one ₹800.00 line was allocated
  proportionally by fine metal weight across the two outputs
  (533.33 + 266.67 = 800.00 exactly, matching the job's total).
- **Metal cost proof**: 43,264.63 + 23,296.34 = 66,560.97, together with
  the returned-metal and scrap-metal cost shares (posted separately to
  Metal Inventory / Scrap Metal Inventory) and the recognized loss
  (silently absorbed, never a separate line — same rule proven in Phase
  4/5), sums back exactly to the job's total resolved WIP cost pool —
  no unaccounted remainder.

### Karigar payable

| | Amount |
|---|---|
| Payable before settlement (direct DB read of Accounts Payable journal lines for this Karigar) | **₹2,500.00** |
| Payment Given (₹1,500, Bank) | −₹1,500.00 |
| Payable after settlement | **₹1,000.00** |

The Dashboard's "Payable" card, the Accounting Ledger for this Karigar,
and this direct journal-line sum all agreed.

### Cross-module boundary proof — Sale vs. finished-jewellery inventory

Read `FinishedJewellery` rows for the job **immediately before** and
**immediately after** posting the Accounting Sale (both queries
explicitly ordered by `id` for a stable comparison — an unordered
`findMany` gave a false-negative once during this audit purely from row
re-ordering across two separate queries, not a real change; fixed and
re-confirmed):

```
before: [{id: …db12, totalCost: "65297.96"}, {id: …dt1, totalCost: "24563.01"}]
after:  [{id: …db12, totalCost: "65297.96"}, {id: …dt1, totalCost: "24563.01"}]
```

Identical, byte for byte. **Classification: intentionally excluded
Version 1 limitation, not a defect** — see §3 (Cross-module boundary
audit) for the full determination.

### Diamond job material

- Issued: 2.0ct (1.2 + 0.8). Polished: 1.0 + 0.7 = 1.7ct. Recognized
  loss: 0.3ct (`weightLossCarat` on the final receipt). Yield on the
  final receipt: 70% (`0.7 ÷ (remaining pending 1.0)`), matching the
  master plan's own formula `Yield % = Received / Issued × 100` applied
  to that receipt's own pending balance.

### GST agreement

The Estimate Costing quotation (CGST+SGST @ 3%, same-state customer)
and the Accounting Sale (also CGST+SGST @ 3%, same customer) both split
their GST amount using the exact same `splitGstAmount` function
(`src/lib/accounting/gst.ts`) — cgst = round2(amount ÷ 2), the 1-paise
remainder (if any) to sgst — confirmed identical logic on both sides of
the module boundary, not two separate reimplementations.

---

## 3. Cross-module boundary audit

| Boundary | Finding |
|---|---|
| Phase 2 Accounting Purchase → Rough/Metal inventory | **Already implemented and verified.** Both `RoughLot` and `MetalPurchase` post through the exact same `createVoucherHeader`/journal-line engine as a plain Phase 2 Purchase (`voucherType: "PURCHASE"`), Dr Inventory + Dr Input GST · Cr Accounts Payable — proven live this audit (interstate IGST Purchase, same-flow rough/metal purchases). |
| Phase 3 Diamond output → Phase 4 Jewellery issue | **Already implemented and verified.** Issue Materials only offers `PolishedDiamond` rows with `status: AVAILABLE`; once issued, `costAtIssue` is copied from the diamond's own real `allocatedCost` and the diamond disappears from every other job's selectable list — confirmed live (§4 duplicate-issue invariant). |
| Phase 3/4 Karigar payable → Phase 2 Payment Given | **Already implemented and verified.** Both diamond-job labour and jewellery-job labour/charges post to the shared Accounts Payable control account (`2000`) by `partyId` — one ordinary Payment Given against the Karigar clears both, proven with the real ₹2,500.00 → ₹1,000.00 reconciliation above. |
| Phase 4 finished output → Phase 5 Actual Costing | **Already implemented and verified.** Metal/diamond/other-material/labour cost on the Actual Costing draft matched the `FinishedJewellery` row's own stored fields exactly, 1:1, with zero recomputation — same guarantee already exhaustively proven in the Phase 5 verification passes. |
| Phase 2 Sale → finished-jewellery inventory and COGS/P&L | **Intentionally excluded Version 1 limitation — not a defect.** See below. |

### The Sale → COGS question, answered precisely

The master plan's Accounting section (§2.1, §6.3) defines a Sale entry
as: date, party, amount, payment method, optional bill number/note/bill
photo — **no item, no stock, no inventory field of any kind**. Its
Costing section (§2.4, §6.6) independently defines "Actual profit =
Actual Selling Price − Final Cost" as a property **of a costing**, not
of a Sale voucher. Nowhere in the locked scope does a Sale reference,
consume, or reduce any Phase 3/4 stock table, and Phase 2's own known
limitation (already documented since Phase 2: *"No inventory/stock
exists yet… Profit & Loss is explicitly labelled provisional… must not
be read as final business profit"*) already anticipated exactly this.
Live-proven above: creating a real Sale for the exact item description
matching a real finished output left that output's own row completely
untouched — count, cost, status, everything.

**Financial consequence**: the Profit & Loss report remains provisional
(income and cost-of-goods are never automatically matched); an Owner
who wants a real per-sale profit figure today must use the Costing
module's "Actual selling price" field on a Finalized Actual Costing —
which already exists and already works, independently of whether that
item was ever run through the Accounting Sale flow at all. **No code
was added for this** — it is correctly out of the locked V1 scope, and
adding Sale-consumes-inventory/COGS posting would be new business
scope requiring the Owner's explicit approval before being built (per
master plan §12: *"કોઈ extra module આપમેળે ઉમેરવો નહીં... Ownerની
approval પછી જ scopeમાં ઉમેરવી"*).

---

## 4. Dependency and cancellation invariants

| Invariant | Result |
|---|---|
| Cancel a Rough/Metal Purchase after material consumed | **Real bug found, fixed, re-verified live.** See §6. |
| Cancel a Diamond Job after polished output used | Blocked — once any output exists, the "Cancel job" button is not even rendered (job status has moved past the cancellable set: `ISSUED`/`IN_PROGRESS`). Confirmed live. |
| Cancel a Jewellery Job after output has a finalized costing | Blocked — same mechanism; once any finished output exists the job is past `MATERIALS_ISSUED`/`IN_PROGRESS`, so "Cancel job" is absent. Confirmed live (a Finalized Costing existing downstream makes this doubly true, but the job-level guard alone already prevents it). |
| Issuing the same diamond twice | Blocked. Confirmed live: after issuing both polished diamonds to the real job, a second, independent Jewellery Job's Issue Materials screen offered **zero** selectable diamond checkboxes — the already-issued diamonds are structurally excluded from every other job's candidate list. |
| Resolving one diamond into two terminal states | Blocked server-side (`src/lib/jewellery/posting.ts`: `if (line.resolvedAs) throw new PostingError("One or more diamonds have already been resolved for this job.")`) — already covered by the existing automated suite; not re-triggered live since the UI structurally can't present an already-resolved diamond for a second resolution. |
| Returning more metal than issued | Blocked client-side (Submit button `disabled` while `exceedsAvailable`) — confirmed live by entering 9999g into "Returned gross weight" and reading the Submit button's `disabled` state directly (`true`). Server-side, the identical `resolvedThisReceipt > pendingAvailable` check independently throws `PostingError` — covered by the existing automated suite. |
| Negative metal/rough/polished stock | No negative-stock path exists anywhere exercised this audit; every issue/return/scrap is bounded by the same "resolved ≤ pending" guard above. |
| Duplicate submission (double-click / refresh / back) | **Proven live via a real captured-and-replayed Server Action request** (not a simulated unit test): the exact same Payment Received request, byte-for-byte, replayed with the same `idempotencyKey` — `Voucher` count unchanged (10 → 10), HTTP 200, no duplicate. |
| Changing master purity/rates after historical entries | Confirmed live: after editing the live 22K purity's fineness (91.6% → 50%, then correctly reverted), the real `FinishedJewellery.finenessPercentSnapshot` on both outputs from this audit's own job stayed at `91.6` — the snapshot, not a live join. |
| Editing finalized costings | Blocked server-side for every mutating Costing action (`if (sheet.status !== "DRAFT") throw new PostingError(...)`) — exhaustively proven live in the Phase 5 verification passes; not re-derived here. |
| Using archived/inactive Party | Confirmed live: an archived Customer was immediately excluded from a live Sale form's Party picker; reactivated before use. Confirmed by code read that every party-feeding query across the app (`Accounting`, `Diamond`, `Jewellery Jobs`) filters `isActive: true`. |
| Using archived/inactive Metal Purity / GST rate | Confirmed by direct code read (not separately re-tested live, to avoid any risk to the carefully-preserved 7-row Metal/Purity master): `listMetalPurities()` defaults to `isActive: true`; both the Sale/Purchase GST-rate dropdown and the Costing GST-rate dropdown filter `isActive: true`. Deactivate/reactivate buttons exist and are Owner-only for both masters. |
| Replaying the same Server Action request | Same live replay evidence as "duplicate submission" above, plus a second, independent replay of a captured **Owner Costing action** issued with a genuine **Staff session** — see §5. |

Every rejection observed or read from code produces either a plain
`{ error: "…" }` returned to the form (rendered as a simple
in-page message, e.g. *"One or more pieces from this rough purchase
have already been issued — it can no longer be cancelled."*) or the
UI simply never offers the control — never a raw database error or
stack trace.

---

## 5. Owner/Staff permission matrix

| Route / action | Owner | Staff |
|---|---|---|
| `/dashboard`, `/accounting`, `/diamond`, `/jewellery-jobs` | Full access | Full day-to-day access (create/issue/receive); cost, carrying-value, and Karigar money figures omitted server-side |
| `/settings` | Full access | **Absent from nav; direct URL → `/unauthorized`** (confirmed live) |
| `/costing` | Full access | **Absent from nav; direct URL → `/unauthorized`** (confirmed live) |
| Cancel voucher / cancel job / adjustment / archive / master edit | Owner-only, enforced in the Server Action | Rejected server-side even via a direct/manipulated call (existing automated coverage; the same `requireOwner()` pattern audited this pass) |
| Costing create/finalize/revise/archive/settings | Owner-only | Rejected server-side — **live-proven this audit** via a captured real Owner Server Action request replayed with a genuine Staff session cookie: `CostSheet` count unchanged (18 → 18), no data mutation |
| Direct RSC-mode read of `/costing` data | — | **Live-proven**: a raw fetch with the `rsc: 1` header and a real Staff session cookie returned a 307 redirect, response body scanned for `CST/…|Metal cost|Production cost` — zero matches; no costing data reaches the Staff session at any layer |
| Diamond/Jewellery pages' cost figures for Staff | — | Confirmed live: the real Staff session's rendered Diamond page body was scanned for a currency-formatted money figure — none found |
| Logout | Session cookie deleted (`deleteSession()`), redirect to `/login` | Same — `getCurrentUser()` re-reads role/`isActive` from the database on every request (not cached beyond one request), so a deactivated Staff account loses access immediately, not just at cookie expiry |
| Unauthorized responses | — | `/unauthorized` shows a plain "This page isn't available to your account" message — no stack trace, no technical detail, confirmed live and by screenshot |

All of this matches the pattern already independently verified across
Phase 1–5's own test suites (server-side `requireOwner()`/`requireUser()`
on every route and every Server Action, never only a hidden button) —
this audit's contribution is **live, real-session proof** on top of
that existing unit-level coverage, specifically including a genuine
captured-and-replayed manipulated request (not merely a simulated
function call).

---

## 6. Bugs found and fixed

### Real bug — Rough/Metal Purchase could be cancelled after consumption

**Found**: `cancelVoucherAction` (`src/app/actions/vouchers.ts`)
already blocked cancelling `DIAMOND_ISSUE`/`DIAMOND_RECEIPT`/
`JEWELLERY_ISSUE`/`JEWELLERY_RECEIPT` vouchers, specifically to avoid
desyncing accounting from stock. But a Rough Purchase or Metal Purchase
posts as the plain `"PURCHASE"` voucher type — **there is no dedicated
voucher type for either** (confirmed against the schema's own
`VoucherType` enum and the exact `createVoucherHeader(...)` call sites
in both `src/lib/diamond/posting.ts` and `src/lib/jewellery/posting.ts`)
— so it fell through every check. **Live-confirmed exploitable**: in
this audit's first 9 runs (before the fix), the generic "Cancel
voucher" button successfully cancelled a Rough Purchase voucher and a
Metal Purchase voucher *after* their diamonds/metal had already been
fully issued and built into a finished, real jewellery piece — reversing
the accounting (removing Dr Rough/Metal Inventory) while leaving the
real stock, diamonds, and finished jewellery completely untouched and
now referencing a "cancelled" source purchase.

**Fixed** in `cancelVoucherAction`, additively, with two new checks
before the generic cancellation path:
- **Rough Purchase**: blocked if any piece in the lot has
  `costLocked: true` (the exact, already-existing "once issued,
  permanently locked" flag used throughout Phase 3).
- **Metal Purchase**: metal is a fungible, pooled stock (unlike
  individually-tracked rough pieces), so a point-in-time
  "is there still enough pool balance" check would be fooled by a
  healthy pool from *other* purchases even after *this* purchase's
  metal was long since issued — confirmed this exact false-negative
  live during the fix's first iteration. The correct, conservative
  rule mirrors the rough side instead: blocked once **any** metal of
  that purity has been issued/consumed at any point after this
  purchase was posted.

**Re-verified live, twice, after the fix** (two full clean E2E runs):
both attempts now correctly rejected —
`{"rejectedByUi":true,"statusBefore":"POSTED","statusAfter":"POSTED","ACTUALLY_CANCELLED_DESPITE_CONSUMPTION":false}`
for both the Rough and Metal purchase, with the ordinary
"cancel a never-issued voucher" path (the safe-cancel demo, an unused
Expense voucher) still working correctly. **5 new regression tests**
added to `src/app/actions/vouchers.test.ts` (part of the 462 passing).

### §6a — Duplicate DOM `id`/`for` on `/settings` — found in the original audit, fixed in the gap-closure pass

`src/components/ui/Field.tsx`'s shared `Field` component derived both
`id` and the paired `<label htmlFor>` directly from its `name` prop
with no per-form namespacing. `CompanySettingsForm` and `AddStaffForm`
both render on `/settings` simultaneously and both have a field named
`email` → both rendered literally `id="email"`/`<label
for="email">` — invalid HTML (duplicate ids), which broke clicking the
**label text** to focus the correct input (clicking directly on the
input box itself was unaffected). Discovered live when a test script
using label-based targeting silently filled the wrong "Email" field.

**Fixed architecturally, not with a two-form patch**, in the
gap-closure pass:

- New `useFieldId(explicitId?)` hook (`src/lib/utils/useFieldId.ts`),
  a thin wrapper around React's own `useId()`. `useId()` generates a
  value that's stable across server render and client hydration (no
  mismatch, no hydration warning) and unique **per component
  instance** — so two forms that both have an "email" field, mounted
  on the same page at once, never collide, unlike deriving an id from
  `name` (fine within one form, guaranteed to collide the moment a
  second form with the same field name joins it). An explicit `id`
  prop is still honoured when a caller genuinely needs a fixed,
  predictable id (opt-out path).
- `Field.tsx` uses this for its own default `<input>`, **and** for the
  common `<Field><select .../></Field>` custom-control pattern used
  across Settings/Costing/Jewellery forms — via `cloneElement`, the
  freshly generated id is force-applied onto whatever single child
  element the caller passed, overriding any `id` the caller's JSX
  happened to hardcode. This is what makes the fix apply to every
  existing call site with zero per-call-site edits required for
  correctness (a caller's old hardcoded child `id="..."` becomes
  harmless dead code, silently overridden).
- The ~15 raw hardcoded `id=`/`htmlFor=` pairs that bypassed `Field`
  entirely (`ReportsView`, `LedgerView`, `CreateJobForm`,
  `InvoiceVoucherForm`, `CashVoucherForm`, `PartyForm`/`PartyEditForm`,
  `MetalPurchaseForm`, `RoughPurchaseForm`, `IssueRoughForm`,
  `MetalPuritySettingsPanel`, `AccountingSettingsPanel`,
  `CostingSettingsTab`, `EstimateForm`'s charge-label `<datalist>`)
  were each converted to the same `useFieldId()` pattern individually.
  `name="..."` (the actual form-submission key read via
  `formData.get(name)`) was left untouched everywhere — only
  `id`/`htmlFor` changed, so no Server Action needed any change.

**Verified**: `tsc --noEmit` clean; 10 new automated tests
(`src/components/ui/Field.test.tsx`,
`src/components/settings/SettingsForms.test.tsx`) proving no duplicate
DOM ids, every `<label htmlFor>` target exists, the two Settings
"Email" labels each focus their own correct input, and both forms
still submit correctly with the right field values; a real-Chromium
scan (desktop 1440×900 and mobile 390×844) across `/login`,
`/unauthorized`, `/settings`, `/dashboard`, `/accounting`, `/diamond`,
`/jewellery-jobs`, `/costing` found **zero duplicate DOM ids, zero
missing label targets, zero hydration warnings, zero console errors**,
and the two Settings Email inputs' generated ids were confirmed
distinct and each label's click correctly focused its own input.

### §6b — Two separate real findings while building the rate limiter, corrected after a documentation review

While implementing persistent login rate limiting (§14), two distinct
issues were found — kept separate here deliberately, because an
earlier version of this report had conflated them into a single
causal story that overstated what either individually proves.

**Finding 1 — an interactive transaction was observed to hang.** An
early per-bucket write design used a multi-statement
`prisma.$transaction(async tx => {...})` callback with an explicit
`SELECT ... FOR UPDATE` row lock. Run against this project's real
Supabase transaction-pooler connection string
(`src/lib/db/prisma.ts`/`.env.example`), this pattern was **observed
to hang** under concurrent load (real test timeouts, not a
simulation). **The exact low-level mechanism of that hang was not
conclusively proven** — it was not isolated down to, for example, a
controlled demonstration of individual statements landing on different
physical connections mid-transaction. (For the record: PgBouncer's
transaction pooling mode assigns one server connection for the
*duration of a transaction* and returns it to the pool only once that
transaction ends — it does not reroute an already-open transaction's
individual statements to different connections mid-flight. An earlier
draft of this report incorrectly described the hang that way; that
claim is withdrawn as unproven, and this paragraph documents the
correction rather than silently editing it away.) What *is* proven is
only the observation itself (hangs under load in this pooled
environment) and the fix's effect (switching away from the
interactive-transaction design made the hangs stop).

**Finding 2 — a separate, later concurrency under-count was a test-harness
bug, not a limiter bug.** After moving past Finding 1's design (already
on a single-statement approach by this point), a test simulating 4
concurrent failed-login attempts intermittently read back
`failureCount: 1` instead of `4` — but only when the full test file ran
together, never when that one test ran alone. Root-caused, **not
assumed**, via a minimal reproduction that bypassed the test harness
entirely (a standalone `tsx` script hitting the real database
directly): the raw atomic SQL logic itself was proven correct in
isolation (4-way and 50-way concurrent bursts both landed on exactly
one row with the exact right count). The actual cause was a Vitest
test-timeout/background-write contamination bug: a separate "spray
across 15 accounts" test made 30 sequential real round trips in a
plain `for` loop, exceeding Vitest's default 5-second test timeout;
Vitest moves on to the next test's lifecycle hooks after a timeout, but
the abandoned test function's own `await` chain kept running in the
background, so its still-in-flight writes landed during later,
supposedly-isolated tests. Fixed by raising the test file's timeout,
parallelizing that test, and scoping every assertion to the exact
`keyHash` under test rather than an unfiltered query — see
`src/lib/auth/rateLimit.test.ts`'s own `ROOT CAUSE` comment for the
full, unedited account.

**What the final design actually rests on.** Independent of Finding
1's unproven mechanism, the shipped design (`recordLoginFailure` in
`src/lib/auth/rateLimit.ts`) uses a **single** `INSERT ... SELECT FROM
unnest(...) ... ON CONFLICT DO UPDATE ... RETURNING` statement — one
network round trip, atomically upserting all applicable buckets
(ACCOUNT/NETWORK/ACCOUNT_NETWORK) together, with no interactive
transaction and no `SELECT ... FOR UPDATE`. This is simpler to reason
about on its own terms (one round trip, no session-scoped lock to keep
alive across statements) and was verified, not assumed, to behave
correctly in this project's actual pooled runtime: 4-way and 40+-way
concurrent bursts land on exactly one row per bucket with the exact
right count, matched against the value the statement's own `RETURNING`
clause reported — see §14 for the full design and the 19 tests that
prove it, including a genuine two-independent-Prisma-connection test
standing in for two app server instances sharing one database.

### §6c — Real bug found and fixed while enforcing CSP — static page vs. per-request nonce mismatch

While enforcing a nonce-based Content-Security-Policy (§15), a real
Chromium production run (`next build` + `next start`) intermittently
showed blocked script loads — but only ever on `/unauthorized`, and
only ever on whatever page was visited *immediately after* it. Not
assumed to be a Next.js/browser quirk and left alone: isolated with a
minimal repro (navigate to `/login` → `/unauthorized` → `/login` again
in one browser context, counting console errors after each step) that
pinpointed the failure to the `/unauthorized` visit precisely.
Root cause: `/unauthorized` was the one page in the app Next
pre-renders **statically** at build time (confirmed in the build
output: `○ /unauthorized` vs. `ƒ` for every other route) — a
statically-generated page has no per-request nonce available at build
time, so its script tags carry no matching nonce, while
`src/proxy.ts` still stamps a **fresh** per-request nonce onto every
response's CSP header regardless, including this one — guaranteeing a
mismatch. **Fixed** with `export const dynamic = "force-dynamic"` on
`/unauthorized`'s page (Next's own documented fix for exactly this
class of nonce/static-rendering conflict), which made it `ƒ` (dynamic)
in the next build, giving it the same per-request nonce injection as
every other route. Re-verified with the same repro script and the full
`/login → /unauthorized → all 6 main pages → logout` sweep on desktop
and mobile in production mode: **zero console errors, zero CSP
violations** (§15).

---

## 7. Customer quotation review

Using the Finalized Estimate Costing quotation from this audit:

- Rendered content confirmed correct: item, metal, diamond, quantity,
  selling value, discount, GST breakdown, final total, validity date —
  all present and correctly computed (same formula already
  exhaustively proven in the Phase 5 verification passes).
- Scanned for `profit|margin|markup|labour cost|production cost|WIP`:
  **zero matches** in the rendered page content.
- `Total` confirmed visibly present.
- Server-only values, internal source references (job/receipt/voucher
  codes), and audit metadata: absent from the customer-facing view (the
  quotation builder is an exhaustive allow-list, `src/lib/costing/quotation.ts`
  — proven exhaustively in Phase 5, not re-derived here).
- No public unauthenticated URL exists: the quotation is a view inside
  the same Owner-gated `/costing` route (`?quotation=1`), not a
  separate route — confirmed by code (`requireOwner()` at the top of
  the page) and by the Phase 5 verification pass's direct unauthenticated
  fetch test (307 redirect to `/login`).

---

## 8. Security and production-readiness audit

| Area | Finding |
|---|---|
| Password hashing | bcrypt, 12 salt rounds (`src/lib/auth/password.ts`) |
| Session cookie flags | `httpOnly: true`, `sameSite: "lax"`, `secure` gated on `NODE_ENV === "production"` (correct — no `secure` flag over local HTTP in dev), 7-day expiry, signed JWT (HS256, `jose`) |
| Role/inactive-user revalidation | `getCurrentUser()` re-reads role + `isActive` from the database on every request (React `cache()`-memoized per request only) — a role change or deactivation takes effect on the very next request, never waits for cookie expiry |
| Server Action authorization | Every mutating action calls `requireUser()`/`requireOwner()` as its first line — confirmed by direct grep across every file in `src/app/actions/` |
| Input validation | Zod schemas at every Server Action boundary; DB-level `CHECK` constraints as defense-in-depth (balanced journal lines, positive amounts, non-negative opening balances, etc.) |
| Error sanitization | Actions return plain `{ error: string }` messages, never a raw exception; generic "Incorrect email or password" on login (doesn't reveal whether the email exists) |
| Secret handling | `.env` confirmed untracked/gitignored; client-bundle scan (`.next/static`) for `SUPABASE_SECRET_KEY`/`sb_secret_…`/`DATABASE_URL`/`JWT_SECRET`/`SESSION_SECRET`/connection-string patterns: **zero matches**; git-tracked-file scan: zero real secrets (only placeholder values in `.env.example`/`README.md`) |
| Supabase private Storage | Private bucket, server-only secret key sent via `apikey` header (never `Bearer`), never present in any client bundle |
| Signed-URL expiry | 300 seconds (`src/lib/storage/diamondMedia.ts`) |
| MIME/magic-byte validation | Every upload sniffs real file signature bytes (JPEG/PNG/WEBP), rejects a mismatch with the declared type, rejects empty/corrupt files |
| Upload size limits | 10 MB cap, enforced server-side |
| File replace/removal cleanup | Confirmed by code and by this session's own Storage-prefix checks: replacing/removing an asset deletes the obsolete object; zero orphaned objects found across every relevant Storage prefix after cleanup |
| Security headers | **Implemented in the gap-closure pass** — CSP (nonce + `strict-dynamic`, no `unsafe-eval` in production, no wildcard sources), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, restrictive `Permissions-Policy`, `Strict-Transport-Security` (production-only), `Cross-Origin-Opener-Policy`/`Cross-Origin-Resource-Policy`. Live-verified on real production responses. See §15. |
| Login brute-force / rate limiting | **Implemented in the gap-closure pass** — persistent, database-backed, HMAC-hashed per-account/per-network/combined buckets, survives restarts and multiple app instances. Live-verified with a real temporary Staff account: 5 wrong passwords blocked the 6th attempt (even with the correct password) with a generic message; simulated expiry then let a correct-password login through and reset state. See §14. |
| Dependency audit | 4 high-severity advisories, **unchanged from Phase 4's own documented finding**: all inside Prisma CLI's own bundled MySQL driver (`prisma` → `@prisma/config` → `mysql2`), a dev-only build tool never used against MySQL (this project is Postgres-only) and not part of the deployed runtime bundle. |
| Database connection/pooler | Prisma 7 driver-adapter (`@prisma/adapter-pg`) against Supabase's pooled connection string, confirmed live-functional throughout this entire audit's real database traffic (hundreds of real writes across 11 E2E runs). |
| Backup and restore readiness | Supabase manages point-in-time backups at the infrastructure level; **no application-level export/backup feature exists yet** (master plan §6.7 lists "Data export/backup" under Settings as a planned item — not yet built). **Flagged as a real gap for a production launch**, out of scope to build in this audit pass. |

**No deployment-specific credentials or external services were
implemented or touched this pass**, per instruction.

---

## 9. Bounded performance check

- Every report/list query audited this session carries an explicit
  `take` limit except one deliberate exception: `getPartyLedger`
  (`src/lib/accounting/reports.ts`) is genuinely unbounded, because a
  running-balance ledger mathematically requires every prior entry to
  compute a correct balance from the first row — this is an
  already-documented Phase 2 known limitation ("fine at this data
  volume; would need materialized summaries at scale"), not a new
  finding.
- No N+1 query pattern was found in any of the list/report/dashboard
  code paths read this session — every list-plus-detail query uses a
  single `findMany`/`include`, not a query-per-row loop.
- Real Supabase transaction latency was directly experienced throughout
  this audit's 11 real E2E runs (hundreds of real writes, each a real
  network round trip to `aws-0-ap-northeast-2.pooler.supabase.com`) —
  no transaction timeout was hit; the explicit 20-second
  `{ timeout: 20000 }` already set on `receiveFinishedJewelleryAction`/
  `issueMaterialsAction`/`cancelJewelleryJobAction` (a real Phase 4 fix)
  remained sufficient throughout.
- No destructive load test was performed — this check used the
  audit's own real, moderate-volume E2E data (dozens of vouchers,
  jobs, and stock movements), not a synthetic bulk-generation pass.
  All of it was cleaned up (§11).

---

## 10. Full automated results

| Check | Result |
|---|---|
| `prisma validate` | ✅ Schema valid |
| `prisma migrate status` | ✅ 6 migrations, database schema up to date |
| `tsc --noEmit` | ✅ 0 errors |
| `eslint` | ✅ 0 errors, 0 warnings |
| `vitest run` | ✅ **462/462** passing (457 retained + 5 new regression tests for the cancellation fix) |
| `next build` | ✅ Production build succeeds; all 10 routes present (`/`, `/_not-found`, `/accounting`, `/costing`, `/dashboard`, `/diamond`, `/jewellery-jobs`, `/login`, `/settings`, `/unauthorized`) — no Phase 1–4 route removed |
| Route inventory | ✅ All 7 master-plan pages present, plus the required `/unauthorized` utility page |
| Client-bundle secret scan | ✅ Zero matches (`.next/static`) |
| Git-tracked-file secret scan | ✅ Zero real secrets (only placeholder values in `.env.example`/README) |
| Dependency audit | ✅ Unchanged, documented, dev-only, not runtime-reachable |
| Browser console errors during the 45-step real E2E run | A handful of `TypeError: Cannot write to a CLOSED writable stream` / `chunk.reason.enqueueModel is not a function` messages appeared. **Assessed as Next.js Turbopack dev-server hot-reload/streaming artifacts caused by this audit script's own rapid, back-to-back `page.reload()` calls** (a technique used to force a fresh component mount between two form submissions — no real user reloads a page within milliseconds of submitting it), not a defect: this class of error is generated by Turbopack's dev-only module/chunk-invalidation machinery, which does not exist in a production build at all (already confirmed clean above). Re-confirmed with normal, human-paced manual interaction during the final review preparation — see §13. |

---

## 11. Cleanup proof

Two precisely-scoped sweeps, each with a reviewed dry run before any
deletion, mirroring the exact methodology already proven in the Phase 5
gap-closure pass:

**Sweep 1** (party/user/job-scoped, `V1AUDIT`/`v1audit` identifiers,
across all 11 audit runs):

| Deleted | Count |
|---|---|
| Parties | 33 |
| Staff users | 4 |
| Jewellery jobs | 21 |
| Diamond jobs | 11 |
| Rough lots / pieces | 11 / 22 |
| Metal purchases | 11 |
| Polished diamonds / receipts | 20 / 20 |
| Finished jewellery outputs | 16 |
| Jewellery receipts | 16 |
| Cost sheets | 18 |
| Vouchers (incl. orphan-swept job/receipt vouchers) | 148 |
| Orphaned `PURCHASE_IN` metal movements | 11 |

**Sweep 2** (a second, genuinely new orphan class found *during this
audit's own cleanup*: `OPENING_IN` metal movements from the "Opening
Metal Stock" test step, and the "safe cancellation" demo's Expense +
Reversal vouchers — neither carries a party link or a traceable
purchase code, so Sweep 1's filters structurally couldn't catch them.
Identified precisely by exact amount match (5g/₹30,000 and ₹500
respectively) **and** creation timestamp falling within this session's
own active window, confirmed against the full remaining-row dump before
deletion):

| Deleted | Count |
|---|---|
| Orphaned `OPENING_IN` metal movements | 11 |
| Orphaned Expense + Reversal vouchers | 22 |

**Final verified baseline** (direct database count, after both sweeps):

| | Value |
|---|---|
| Party / Voucher / JournalEntry / CostSheet / JewelleryJob / DiamondJob / RoughLot / MetalPurchase / FinishedJewellery / StockMovement / MetalStockMovement | **0**, every one |
| User | **1** (the real Owner account, active — email intentionally not printed in this report) |
| MetalPurity | **7**, all active, 22K confirmed at exactly 91.600%, name "22K" |
| Account / PaymentAccount / GstRate | 23 / 3 / 6 — unchanged seeded master data |
| DiamondSequence / JewellerySequence / VoucherSequence | 5 / 4 / 11 — **not reset**, since they carry real historical numbering from Phase 1–5's own prior verification; resetting them is never safe regardless of current row counts |
| CostingSequence | Reset to empty — safe, since zero real cost sheets exist to renumber around |
| Supabase Storage (`costing-estimate`/`jewellery-design`/`jewellery-finished`/`rough-lot`/`rough-piece`/`polished` prefixes) | **0 objects**, every prefix |
| `CompanySettings` | Real configuration (ZYNORALUXE, state code 24) — deliberately retained, see §1 |
| Temporary scripts (`prisma/temp-*.ts`) | All 7 written this pass, all deleted — confirmed via `git status` showing only the two real code files (`vouchers.ts`, `vouchers.test.ts`) changed |
| `node_modules`-local `playwright` install (temporary, `--no-save --no-package-lock`) | Removed; `package.json`/`package-lock.json` checksums confirmed byte-identical to before this session started |

---

## 12. Known limitations (carried forward, not new)

- Profit & Loss remains provisional (no automatic COGS matching — see
  §3).
- CSV exports are client-side; report queries are not paginated beyond
  a few hundred rows — both already-documented since Phase 2.
- `getPartyLedger` is genuinely unbounded by design (running balance).
- No login rate-limiting/lockout (§8) — flagged, not fixed at the time
  this line was written. **RESOLVED in the gap-closure pass — see §14.**
- No HTTP security headers configured (§8) — flagged, not fixed at the
  time this line was written. **RESOLVED in the gap-closure pass — see
  §15.**
- No application-level data export/backup feature yet (§8) — flagged,
  not fixed; master-plan §6.7 lists it as planned. **Still open** — see
  the updated "Deployment blockers" at the end of this report.
- Duplicate DOM `id` on `/settings` between two co-rendered forms (§6)
  — flagged, not fixed, low real-world impact. **RESOLVED in the
  gap-closure pass — see §6a.**

## Deployment blockers (for a real production launch, not this audit) — superseded, see the end of this report

1. ~~Login brute-force/rate-limiting.~~ **Done — §14.**
2. ~~HTTP security headers (CSP at minimum).~~ **Done — §15.**
3. Application-level backup/export, or a documented reliance on
   Supabase's own backup tier. **Still open.**
4. Real company details in Company Settings (currently placeholder
   values, deliberately, per §1). **Still open — the Owner's own task,
   not something an audit pass can supply.**
5. A real `SESSION_SECRET` generated for the production environment
   (never the one in any local `.env`). **Still open — same reason.**

None of the above were implemented in this audit, per explicit
instruction — they are reported, not built. *(Items 1–2 were
subsequently implemented in the gap-closure pass appended to this same
report — see §14/§15 and the final "Deployment blockers" list at the
very end.)*

---

## 13. Manual-review preparation

The local development server is running at `http://localhost:3000` and
was left running after this report. The login page opens correctly
(re-confirmed with normal, human-paced manual navigation — no console
errors observed outside the automation-only artifacts documented in
§10). The Owner should sign in with the credentials already saved from
earlier setup (not repeated here).

**Screens worth a personal look before sign-off:**

- `/dashboard` — the 8 summary cards and 6 quick actions, on both
  desktop and a phone-width window.
- `/accounting` → Transactions tab — try one Purchase and one Payment
  Given; check the "Cancel" button on an old, unused voucher works, and
  is genuinely gone on a voucher tied to material you've already used.
- `/diamond` → Cutting-Polishing Jobs — open a completed job and check
  the "Cancel job" button is correctly absent.
- `/jewellery-jobs` → Metal Stock tab — try "Opening Metal Stock" once
  for real, with a real starting balance.
- `/costing` — create one real Estimate for an actual piece you're
  about to make, and open its customer quotation via "Print / Save as
  PDF" to see exactly what a customer would see.
- `/settings` — Company Settings (update the real business details in
  place of the placeholder state code), and Metal/Purity master.

---

# Gap-closure pass (same branch, same audit)

Everything below was done after §1–§13 above, on the same
`v1-final-acceptance` branch, closing the two production-readiness
gaps §8/§12 flagged and the one accessibility defect §6 flagged.
Nothing above this line was re-run or re-derived except where §10's
numbers are explicitly superseded in §17.

## 14. Login rate limiting

### Policy

Three independent buckets, each hashed (never raw), each with its own
threshold — implemented in `src/lib/auth/rateLimit.ts`, wired into
`login()` in `src/app/actions/auth.ts`:

| Bucket | Keyed on | Threshold | Window | Lock |
|---|---|---|---|---|
| `ACCOUNT` | the login email alone | 5 failed attempts | 15 minutes | 15 minutes |
| `ACCOUNT_NETWORK` | email + client IP together | 5 failed attempts | 15 minutes | 15 minutes |
| `NETWORK` | client IP alone | 30 failed attempts | 15 minutes | 15 minutes |

`ACCOUNT` is always active — it is the one guarantee that never depends
on deployment/proxy configuration, so every account is protected even
when no trustworthy client IP is available at all. `NETWORK`'s much
higher threshold exists to catch credential stuffing (many different
accounts tried from one IP) while tolerating ordinary shared-office/NAT
traffic where several Staff share one outbound IP. `ACCOUNT_NETWORK`
catches one attacker hammering one account from one machine at a
tighter effective limit than the broad `NETWORK` bucket alone allows.

Every lock is time-bounded (`lockedUntil`), never indefinite, and a
failed attempt recorded while a bucket is already locked does not push
`lockedUntil` further out — so **no account, including the Owner's,
can ever be locked out permanently**, only for one bounded 15-minute
window at a time, however long an attack continues.

### Privacy design — nothing raw is ever stored

`LoginRateLimit.keyHash` is an HMAC-SHA256 digest (64 hex characters),
keyed with the app's existing server-only `SESSION_SECRET` — **not a
new secret**, per the preference for reusing an existing server-only
mechanism over inventing another one. The table never stores a raw
email, a raw IP address, or a password (correct or attempted) in any
column, ever — confirmed both by code inspection and by a direct
integration test (`src/lib/auth/rateLimit.test.ts`) that records a real
failure for a known test email/IP and then asserts the stored
`keyHash` does not contain either raw value as a substring. No email,
IP, or hash from this table is reproduced anywhere in this report.

### Trusted-proxy limitation — documented, not silently assumed

The client IP is read **only** from an explicitly-configured header
(`TRUSTED_CLIENT_IP_HEADER`, see `.env.example`) — never from a
default guess like `x-forwarded-for`, which any client can set to an
arbitrary value on a request that never actually passed through a real
reverse proxy. Until that variable is set (a deliberate post-deployment
step, once the hosting platform's exact trusted header is known — e.g.
Cloudflare's `cf-connecting-ip`, Fly.io's `fly-client-ip`, Vercel's
`x-vercel-forwarded-for`, or `x-forwarded-for` only if there is exactly
one trusted proxy hop in front of the app), `NETWORK`/`ACCOUNT_NETWORK`
bucketing is skipped entirely — the `ACCOUNT` bucket alone still fully
protects every account regardless. When the configured header is a
comma-separated list, the **last** entry is used (the one the trusted
proxy itself appended — everything earlier is client-supplied and
untrustworthy) — live-tested by sending two requests with the same
trusted last value but different spoofed first values and confirming
they land on the same network bucket, and a third request with a
genuinely different last value landing on a different bucket.

### Reset, expiry, and failure-mode behaviour

- **Successful login** clears the `ACCOUNT` and `ACCOUNT_NETWORK`
  buckets for that email (`resetLoginRateLimitOnSuccess`) — the
  broader `NETWORK` bucket is left alone deliberately, since one
  successful login doesn't mean a shared IP isn't still being used to
  attack other accounts.
- **Expiry** is real-clock-based (`lockedUntil` compared against
  `now`), not a background job — the very next check or write after
  the lock's timestamp has passed treats the bucket as unlocked and,
  once a window has genuinely elapsed, resets it to a fresh count of 1
  rather than continuing to accumulate.
- **Cleanup** of expired rows is bounded and safe: a low-probability
  (1%) opportunistic sweep runs on successful logins
  (`cleanupExpiredLoginRateLimits`, fire-and-forget, never blocks the
  response), plus a standalone script
  (`npm run db:cleanup-login-rate-limits`, `scripts/cleanupLoginRateLimits.ts`)
  for manual/cron use. The delete condition requires **both** an
  expired window **and** no active lock — a test
  (`"never deletes a row with an active (not-yet-expired) window,
  locked or not"`) proves an active window is never touched regardless
  of lock state.
- **Database/limiter failure never bypasses protection**: if the
  rate-limit status check itself throws (e.g. the database is
  unreachable), `checkLoginRateLimit` fails **closed** — it returns
  `blocked: true` with a short generic retry time rather than silently
  letting every login through. Recording a failure is best-effort
  (logged, not re-thrown) since the login attempt has already been
  correctly rejected by that point regardless of whether recording it
  succeeds.
- **Generic messages, no enumeration**: a blocked attempt shows "Too
  many attempts. Please try again in about N minute(s)." regardless of
  whether the email exists; a rejected attempt (wrong password,
  nonexistent email, or inactive account) shows the same "Incorrect
  email or password." either way. A nonexistent account still performs
  real bcrypt work against a fixed dummy hash
  (`getDummyPasswordHash()` in `src/app/actions/auth.ts`) so its
  response time is statistically indistinguishable from a wrong
  password on a real account.

### Atomicity — what was found, and what was actually proven

See §6b for the full, corrected story — two separate findings, not
one. In short: an early interactive-transaction-plus-`FOR UPDATE`
design was **observed to hang** under concurrent load against this
project's real Supabase transaction-pooler connection string, but the
exact low-level mechanism of that hang was never conclusively proven,
and an earlier draft of this report overstated it as a specific
statement-level connection-rerouting claim that has since been
withdrawn as unproven. A separate, later concurrency under-count
(4 concurrent writes reading back as 1) was fully root-caused to a
Vitest test-timeout/background-write contamination bug — **not** a
defect in the atomic upsert, and not the same finding as the hang.
Independent of the hang's unproven mechanism, the shipped design uses
a **single** `INSERT ... SELECT FROM unnest(...) ... ON CONFLICT DO
UPDATE ... RETURNING` statement — one round trip, all applicable
buckets (1–3) upserted together, no interactive transaction, no
`SELECT ... FOR UPDATE` — chosen because it is simpler to reason about
and was verified, not assumed, to behave correctly in this project's
actual pooled runtime (4-way and 40+-way concurrent bursts, §14's test
list below); the caller receives the authoritative post-write state
straight from `RETURNING` rather than a separately computed value.

### Automated tests (29 total: 19 real-database integration tests + 10 mocked orchestration tests)

`src/lib/auth/rateLimit.test.ts` (19 tests, deliberately **not**
mocking the database — the properties under test are real Postgres
guarantees a mock cannot exercise; the file owns the
`login_rate_limits` table for its run and wipes it before/after every
test):

- Per-account: under-threshold doesn't block; exact-threshold blocks
  and unblocks after expiry (clock injected, no real sleeping); window
  resets only on genuine expiry, not merely a newer timestamp within
  the same window; no lock-extension while already locked;
  nonexistent-email attempts still tracked; two different accounts'
  buckets stay independent.
- Network/combined: spoofable header ignored when untrusted; last
  comma-value used and a changing first value ignored; a network-wide
  spray across 15 accounts blocks before any single account's own
  threshold; the combined bucket alone can block `checkLoginRateLimit`.
- Reset: success clears `ACCOUNT`/`ACCOUNT_NETWORK`, leaves `NETWORK`;
  concurrent failures racing a concurrent success never corrupt state
  (never more than one row, never a negative/non-integer count).
- Concurrency: 4-way and 40-way concurrent bursts never lose an
  increment, land on exactly one row, and the caller-visible
  `RETURNING` value agrees with the final stored value; a genuine
  second, independent `PrismaClient`/connection (standing in for a
  second app server instance) racing the first stays correct.
- Privacy: `keyHash` never contains the raw email/IP substring, always
  a 64-hex-char HMAC-SHA256 digest.
- Cleanup: deletes only rows that are both expired and unlocked; never
  deletes an active (non-expired) window, locked or not.

`src/app/actions/auth.test.ts` (10 tests, mocked — orchestration only,
matching this codebase's existing test convention for Server Actions):
nonexistent account + dummy-hash timing safety; wrong password on a
real account; correct password on an **inactive** account still gets
the identical generic error; correct password on an active account
resets rate-limit state and redirects; blocked status returns the
generic retry message **without ever touching the database**; retry
time rounds up to whole minutes; opportunistic cleanup fires only on
its low-probability branch and only after success; malformed email
rejected before the rate limiter is even consulted.

### Live verification with a real temporary Staff account

Against the real running app (dev first, then re-confirmed against the
final production `next build`/`next start`):

1. A real temporary Staff account created through the real
   `/settings` → "Add a Staff account" form.
2. 5 real wrong-password submissions through the real `/login` form.
3. A 6th attempt — **with the correct password** — was rejected with
   "Too many attempts. Please try again in about 15 minutes.", still on
   `/login` (confirmed via direct database read: `ACCOUNT` bucket
   `failureCount: 0`, `lockedUntil` set exactly 15 minutes out — the
   trip-and-reset-to-0 design working as intended).
4. `lockedUntil` set to the past (narrowly-scoped direct test-data
   manipulation of the limiter's own row, exactly as the task
   permitted, to simulate real time passing without a real 15-minute
   sleep).
5. The same correct password now succeeded, landing on `/dashboard`
   with zero console errors.
6. Direct database read confirmed the `ACCOUNT` bucket row was gone —
   reset-on-success working as intended.
7. **Full cleanup**: the temporary Staff account and every limiter row
   this created were deleted immediately after; final baseline
   re-confirmed (§17).

No raw email, password, or limiter hash from this live test appears
anywhere in this report.

### `.env.example` change

One new, optional variable: `TRUSTED_CLIENT_IP_HEADER` (documented
inline with the exact trust caveat above). `SESSION_SECRET`'s existing
comment was extended to note its second use (keying the rate-limit
HMAC) — it is still one secret, not two.

---

## 15. HTTP security headers and Content-Security-Policy

### What's enforced, and where

Static, request-independent headers via `next.config.ts`'s `headers()`
(applied to every route):

`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, a restrictive
`Permissions-Policy` (camera/microphone/geolocation/payment/usb/
browsing-topics/interest-cohort all denied, `fullscreen=(self)` only),
`Cross-Origin-Opener-Policy: same-origin`,
`Cross-Origin-Resource-Policy: same-origin`, and
`Strict-Transport-Security: max-age=63072000; includeSubDomains;
preload` — **production only**, since it has no effect (and no
business being sent) over plain local `http://localhost`.
`poweredByHeader: false` additionally removes the `X-Powered-By:
Next.js` fingerprinting header.

The per-request Content-Security-Policy (which needs a **fresh nonce
every request**, something `next.config.ts`'s static `headers()`
cannot generate) is set in `src/proxy.ts`, applied to every matched
response including redirects:

```
default-src 'self';
script-src 'self' 'nonce-<per-request>' 'strict-dynamic' [+ 'unsafe-eval' in dev only];
style-src 'self' 'nonce-<per-request>';
img-src 'self' blob: data: [+ the configured Supabase project origin, only if SUPABASE_URL is set];
font-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
[upgrade-insecure-requests — production only]
```

- **No `unsafe-eval` in production**, ever — only in development,
  where Turbopack's HMR runtime genuinely requires it.
- **No wildcard sources anywhere.** `img-src`'s Supabase allowance is
  the app's own configured project origin specifically (e.g.
  `https://<project-ref>.supabase.co`), derived from `SUPABASE_URL` at
  request time — never a `*.supabase.co` wildcard, which would let the
  page load images from *any* Supabase project, not just this one.
  When `SUPABASE_URL` is unset (Storage not configured), the Supabase
  origin is simply omitted.
- **`strict-dynamic`** is what lets Next's client-side (SPA) router
  swap in new route chunks after the first page load: those chunks are
  inserted by the already-nonce-validated bootstrap script's own
  continued execution, not via a fresh server-rendered `<script
  nonce=...>` tag, so a plain nonce allow-list alone can't express that
  trust relationship. See §6c for the real bug this surfaced (a static
  page — `/unauthorized` — receiving a nonce'd CSP header with no
  matching nonce in its build-time-only-rendered script tags) and its
  fix.
- **No Supabase secret key or database URL is ever sent to the
  browser** — confirmed by a dedicated automated test
  (`src/proxy.test.ts`) that sets real-looking values for both and
  asserts neither appears in any response header, and by the same
  client-bundle secret scan as §10/§17.

### Development vs. production

| | Development | Production |
|---|---|---|
| `script-src` | includes `'unsafe-eval'` (Turbopack HMR) | never `'unsafe-eval'` |
| `Strict-Transport-Security` | absent | present |
| `upgrade-insecure-requests` | absent | present |
| Everything else (nonce, `strict-dynamic`, `frame-ancestors`, `object-src`, static headers, etc.) | identical | identical |

The relaxation is narrowly scoped to exactly what Turbopack's dev
server technically requires and nothing else; every other directive is
identical in both modes, and the difference is enforced by one
`isProduction` check read at module load (`src/proxy.ts`), not a
separate dev-only code path that could silently drift from what
production actually serves.

### Automated tests (16 tests, `src/proxy.test.ts` — the file already existed from Phase 1 with 6 auth-redirect tests; extended here, not replaced)

Full CSP directive presence; a fresh, different nonce generated per
call, consistently embedded in both `script-src` and `style-src`; the
same nonce forwarded onto the request headers (`x-nonce`) — what lets
Next.js auto-nonce its own inline scripts/styles; `'unsafe-eval'`
present only outside production and `upgrade-insecure-requests` only
inside it (tested via a real module reload under each `NODE_ENV`,
since `isProduction` is captured once at import time — mutating the
env var after import has no effect, correctly matching how the real
single-process app behaves); `img-src` scoped to the configured
Supabase origin and never a wildcard, omitted entirely when unset; no
secret value leaks into any header; the full header set present on
both a redirect response and a normal response; the existing 6
auth-redirect tests untouched and still passing; the matcher's
prefetch exclusion (§6c) present.

### Real production-mode browser evidence

Real Chromium, real `next build` + `next start` (not `next dev`),
desktop 1440×900 and mobile 390×844, with a `securitypolicyviolation`
listener installed via `page.add_init_script` before every navigation:
`/login`, `/unauthorized`, `/dashboard`, `/accounting`, `/diamond`,
`/jewellery-jobs`, `/costing`, `/settings`, logout — **zero CSP
violations, zero console errors, zero page errors**, on both
viewports, confirmed on the final rebuilt-and-restarted server after
every fix in this section landed (not just an earlier, since-fixed
run). Response headers on `/login`, an unauthenticated-redirect
response for `/dashboard`, and `/unauthorized` were each individually
inspected (`curl -D -`) and carry the full header set including a
correctly-scoped, nonce-bearing CSP. Signed-media `<img>` loading was
checked structurally (no broken/zero-width images matching
`img[src^="https://"]`) — the audit database currently has no signed
media objects to load (§17's clean baseline), so this confirms no CSP
directive would block one, not that one was seen loading; the `img-src`
directive's correctness against the real configured Supabase origin
was separately confirmed by direct inspection of the live CSP header
value.

---

## 16. Owner's approved Phase 6 decision — recorded, not started

The Owner has approved building **Finished Jewellery Sale → Stock →
COGS/Profit & Loss integration** as a new Phase 6, to be built *before*
production deployment — directly closing the "Sale → COGS" limitation
this report documented as an intentionally-excluded Version 1 scope
gap in §3 ("The Sale → COGS question, answered precisely"). This
supersedes the original master plan's own labelling of "Phase 6" as
"Final Verification and Deployment" — that work is effectively what
this entire report (and its gap-closure pass) already *is*; the Owner's
new Phase 6 is additional business scope, not a renaming.

**Explicitly, per this pass's own instructions: Phase 6 has not been
started.** No schema change, Server Action, UI, or design document for
it exists anywhere in this branch. This section exists solely to record
that the decision was made and why, so a future session (or the
Owner, reviewing this report) has the context without needing it
re-explained.

---

## 17. Gap-closure pass — full automated results (supersedes §10's numbers)

| Check | Result |
|---|---|
| `prisma validate` | ✅ Schema valid |
| `prisma migrate status` | ✅ 7 migrations, database schema up to date (one additive migration since §10: `LoginRateLimit` + `LoginRateLimitBucket`) |
| `tsc --noEmit` | ✅ 0 errors |
| `eslint` | ✅ 0 errors, 0 warnings |
| `vitest run` | ✅ **510/510** passing (462 retained from §10 + 10 duplicate-id regression tests + 19 rate-limiter integration tests + 9 auth-orchestration tests + 10 new proxy/CSP tests appended to the pre-existing `src/proxy.test.ts` — net +48 new tests) |
| `next build` (production) | ✅ Succeeds; 9 of 10 routes dynamic (`ƒ`), only `/_not-found` static (`○`) — `/unauthorized` is now dynamic too (§6c fix), the only route inventory change since §10 |
| Client-bundle secret scan | ✅ Zero matches — both a key-name pattern scan and a real-secret-**value** scan (actual `SESSION_SECRET`/`SUPABASE_SECRET_KEY`/`DATABASE_URL`/`OWNER_PASSWORD` values, not just their names) against `.next/static` |
| Git-tracked/changed-file secret-value scan | Found and fixed one real finding **from this report itself**: the original §11 baseline table had printed the real Owner's email address in plain text. Removed before finalizing this document — confirmed zero hits on re-scan. No other file (code, test, or doc) matched. |
| HTML duplicate-ID / label-target scan | ✅ Zero duplicate DOM ids, zero missing label targets, across every main page, both viewports (§6a) |
| Header/CSP scan | ✅ Full header set present on every response including redirects; zero CSP violations across every main page, both viewports, in production mode (§15) |
| Production-mode browser E2E | ✅ Login, rate-limit block/unblock/reset, all 6 main pages, Owner Settings, Staff `/settings` → `/unauthorized` redirect (with the Settings/Costing nav links correctly absent for Staff), mobile hamburger drawer open/close, logout — all live, both viewports, zero console errors |
| Dependency audit | Unchanged from §10 — not re-run, since no dependency was added or upgraded this pass (only new application code and one additive migration) |

### `dotenv` console banner — investigated, harmless, dependency behaviour left unchanged

While scanning tool output during this pass, an unexpected line
appeared: `⌁ auth for agents [www.vestauth.com]`. Investigated, not
assumed:

- **Source confirmed**: the string is hardcoded in a `TIPS` array
  inside the installed `dotenv` package's own source
  (`node_modules/dotenv/lib/main.js`), one of several rotating
  self-promotional "tip" lines the package prints to the console on
  load (a known pattern some npm packages have adopted). It is not
  generated by, or related to, any code in this repository.
- **No network request occurs**: `dotenv/lib/main.js` only requires
  Node's built-in `fs`, `path`, `os`, and `crypto` modules — no HTTP
  client of any kind is imported anywhere in the file, so printing the
  tip string cannot itself fetch, beacon, or send anything to
  `vestauth.com` or any other domain. The domain was never opened,
  executed, installed from, or sent data — confirmed by code
  inspection, not by visiting it.
- **Package integrity confirmed**: the installed version
  (`node_modules/dotenv/package.json`, `17.4.2`) matches
  `package-lock.json`'s pinned `dotenv@17.4.2` (integrity hash
  `sha512-nI4U3T...cdYZw==`) for both the direct devDependency and the
  transitive copy pulled in via `prisma` → `@prisma/config` → `c12`
  (`npm ls dotenv` confirms both resolve to the identical, deduped
  17.4.2). No unexpected lifecycle/install script was introduced —
  `package-lock.json` and `package.json` are otherwise unchanged by
  this finding.
- **Quiet-mode attempted, then correctly reverted**: `dotenv` does
  support a documented `quiet` option (one of the very tip lines
  advertises it: `⌘ suppress logs { quiet: true }`). Tried as
  `import { config } from "dotenv"; config({ quiet: true })` in place
  of the plain `import "dotenv/config"` side-effect import used across
  this codebase's four dotenv entry points (`prisma/seed.ts`,
  `prisma.config.ts`, `scripts/cleanupLoginRateLimits.ts`,
  `src/lib/auth/rateLimit.test.ts`). This **broke real environment
  loading** in `rateLimit.test.ts` (`DATABASE_URL is not set` — a
  genuine regression, caught by re-running the test suite, not assumed
  safe): ES module imports are hoisted above a file's own top-level
  statements, so a `config({quiet:true})` call placed after another
  import runs *after* that sibling import's own top-level code — and
  `src/lib/db/prisma.ts` reads `process.env.DATABASE_URL` at its own
  module top level. **Reverted in all four files** back to the plain
  `import "dotenv/config"` form, which is import-hoisting-safe. Dotenv
  behaviour is unchanged from before this investigation; the console
  tip line remains, and is cosmetic only.

---

## 18. Gap-closure pass — cleanup proof

Every temporary artifact created while closing these gaps was removed:

| Removed | Detail |
|---|---|
| Temporary Staff test accounts | 3 created across the rate-limit and permission-redirect live tests (`v1-audit-ratelimit-test@…`, `v1-audit-staff-redirect-test@…`, plus one intermediate re-run) — all deleted; final `User` count confirmed back to exactly **1** |
| `login_rate_limits` rows | All test-created rows deleted after every live test; final count confirmed **0** |
| Temporary debug/verification scripts | `scratchpad_debug_concurrency.ts` and 4 other `scratchpad_*.ts` root-level scripts used to root-cause §6b/§6c and to seed/verify test scenarios — all deleted; none appear in `git status` |
| Temporary Playwright verification scripts | All written to the session scratchpad directory (outside the repository), never inside the project — nothing to clean there |
| Screenshots | Written only to the session scratchpad's own `screenshots/` folder, never inside the repository |

**Final verified baseline** (direct database count, re-confirmed after
this pass's own cleanup):

| | Value |
|---|---|
| User | **1** (the real Owner, active) |
| MetalPurity | **7** |
| Party / Voucher / JewelleryJob / DiamondJob / RoughLot / MetalPurchase / CostSheet | **0**, every one |
| `LoginRateLimit` | **0** |
| Supabase Storage | **0 objects** — untouched this pass |
| `git status` | Exactly the files this pass intentionally changed or added (proxy/rate-limiter/component code, their tests, the two report/guide docs, `.env.example`, `package.json`, `next.config.ts`, the new migration) — no stray temp file, no `.env`, no credential |

---

## Final PASS/FAIL determination

**PASS.**

Both real defects this report ever found are fixed (cancellation
dependency bug, duplicate-DOM-id bug). Both production-readiness gaps
originally flagged as deployment blockers are implemented and
live-verified (login rate limiting, HTTP security headers/CSP).
Building those two gaps surfaced two further real findings, each
investigated with direct evidence rather than assumption and each
fixed: an interactive-transaction-plus-`FOR UPDATE` pattern observed
to hang under concurrent load against this project's real Supabase
transaction-pooler connection string (§6b — the exact low-level
mechanism was never conclusively proven, and an earlier, overstated
explanation of that mechanism has since been corrected and withdrawn),
and a static-page CSP-nonce mismatch (§6c). All 510 automated tests
pass. TypeScript, ESLint, Prisma schema/migration state, production
build, client-bundle secrets, and git-tracked-file secrets are all
clean. The database is back to its exact clean baseline.

**Three items remain before a real production launch — none of them
something an audit pass can supply on the Owner's behalf**:

1. Application-level backup/export, or a documented decision to rely
   on Supabase's own backup tier.
2. Real company details in Company Settings (currently the
   demonstration placeholder from §1).
3. A real, freshly generated `SESSION_SECRET` for the production
   environment.

Separately, and by explicit instruction, **Phase 6 (Finished Jewellery
Sale → Stock → COGS/P&L) has not been started** — recorded in §16 as
an Owner-approved decision for future work, before deployment.

No commit, push, merge, tag, or deploy was performed from this branch
at any point in this pass, per explicit instruction.
