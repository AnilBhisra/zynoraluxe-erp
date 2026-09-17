# Phase 7 Verification Report

Branch `phase-7-polished-metal-process`, based on `b472901`.
Specification: `../ZYNORALUXE_PHASE_7_CLAUDE_MASTER_INSTRUCTIONS.md`.
Audit: `PHASE_7_CURRENT_STATE_AUDIT.md`. Design: `PHASE_7_IMPROVEMENT_PLAN.md`.

## 1. Result

**PASS. Every required acceptance check in §13 passed.** The checks ran
against the isolated local PostgreSQL 17 database `zynoraluxe_phase7_test`
(role `zynoraluxe_phase7_user`, not a superuser) and a real Google Chrome 152
browser.

Production was never connected to. A wrapper ran every database command. Before
each command it checked that `current_database()` is `zynoraluxe_phase7_test`
and `current_user` is `zynoraluxe_phase7_user`. It also set `DATABASE_URL`,
`DIRECT_URL`, the session secret, the Owner/Staff logins and storage to
test-only values. `DATABASE_URL` in `.env` was never changed.

The real verification found **four real bugs** (§7, items 13–16). All four are
fixed and have regression tests that fail without the fix. Browser E2E parts 2–5
ran on the build with bugs 13–15 fixed. Bug 16
was found after the browser run. Its fix changes only the error-recovery branch
of the server actions. It was proven on the real database (§9.5), and the full
test suite, lint, type check, production build and secret scans were run again
afterwards. Three existing behaviours are reported to the Owner and were not
changed (§8).

| Acceptance check (§13) | Result |
|---|---|
| `prisma validate` | ✅ The schema is valid |
| `prisma migrate status` | ✅ Empty database: 13 migrations found, "Database schema is up to date!" · Pre-Phase-7 database: 5 migrations not yet applied → applied → "up to date" · After cleanup: "up to date" |
| Migration drift | ✅ `migrate diff` against `prisma/schema.prisma`: no difference, on both the empty and the upgraded database |
| TypeScript (`tsc --noEmit`) | ✅ exit 0 |
| ESLint (`eslint . --max-warnings=0`) | ✅ exit 0 |
| Full Vitest suite | ✅ **55 files / 740 tests passed, 0 skipped.** This includes the 19 `rateLimit.test.ts` database tests, run on the test database |
| Production `next build` (clean `.next`) | ✅ exit 0, on the final code |
| Client-bundle secret scan | ✅ 38 static files checked for 10 secret-shaped `.env` values and 5 secret variable names: 0 hits |
| Tracked/changed-file secret scan | ✅ Phase 7 diff: 0 hits. Whole tree: only the two storage bucket names, which are not secret and are already in `.env.example`. `.env` is ignored by git |
| Database schema migration review | ✅ Read, grep-checked, and applied to an empty database and to a pre-Phase-7 database with data (§4) |
| Real browser E2E | ✅ Owner on desktop and mobile, Staff on desktop and mobile: 0 console errors, 0 page errors, 0 failed requests, 0 CSP violations, 0 HTTP 5xx (§9.3) |
| Direct database reconciliation | ✅ Stock matches the ledger for 1220/1210/1300/1310/1320/1330. Payables by party, COGS and every voucher's debit = credit also match (§9.4) |
| Real concurrent double-submit | ✅ On the real database, duplicates collapse to one record and a race cannot over-issue a packet (§9.5) |
| Temporary-data cleanup | ✅ Dry run first, then one checked transaction back to the seeded baseline (§9.6) |
| `git diff --check` | ✅ Clean for the whole branch |
| Final `git status --short` | ✅ Clean after the final commit (§10) |

Changes are **committed** on the branch (§10).
**Not pushed, not merged, not tagged, not deployed.**

## 2. What Phase 7 changed

| Tier | Commit | Summary |
|---|---|---|
| P0 | `95c05cf` | Metal stock read fixes (`CONSUMED_OUT` informational, separate scrap pool), 24K → 18K/14K/9K outputs, Company Copper/Alloy stock, Karigar-added and included alloy, exact thousandths math, Staff cost redaction on `/diamond` and `/jewellery-jobs`, metal reconciliation script, create-only Phase 7 masters script |
| P1 | `336a08a` | Direct Polished Diamond Purchase with `Party / Supplier` and `Dalal / Broker`, packet stock with an immutable ledger and merge key, packets in Jewellery Jobs (issue, set/returned/damaged, cancellation), guard on generic voucher cancel |
| P2 | `833be66` | Manufacturer process master (`4P / Laser`, `HPHT / Grow`, `Polishing`, `Rough Polish`), process + charge on Diamond Jobs, processed-rough returns, Job Manufacturer packet jobs (size-wise issue, partial/final returns, used in Jewellery Job, damaged/lost, charges, cancellation), packet row lock, Settings process panel |
| P2 | `e3f001c` | CSV exports, Accounting purchase chooser, Phase 7 DTO serializers with Staff-redaction tests, legacy job label, diamond reconciliation script |
| P2 | `6611961` | Owner packet count adjustments posting their own `STOCK_ADJUSTMENT` voucher |
| P3 | `fbd5cbf` | README, both Gujarati guides, in-app Gujarati help, master plan Scope History (append-only), this report, concurrency action tests |
| Owner decision | `7271a6e` | Job Manufacturer packet line closure: explicit confirmation, audit fields (`closedAt`, `closedByUserId`, `closingReceiptId`), closed lines refuse receipts |
| Real-verification fixes | `a674556` | Polished landed cost shared by line rate value; packet stones counted in Finished Stock; cancelled packets hidden from stock |
| Real-verification fix | `2da3038` | Idempotency-key conflict recovery works with the Postgres driver adapter (all action files) |
| Acceptance | final commit | This report and README updated with the real-verification results |

The UI keeps the existing navigation. The Diamond page's sections are now
`Rough Diamond`, `Manufacturer`, `Job Manufacturer` and `Polished Diamond`
(old `?tab=rough|jobs|polished` links still work).

## 3. Tests before and after

| | Test files | Tests passed | Not run |
|---|---|---|---|
| Before Phase 7 (audit baseline, `b472901`) | 44 | 590 | 19 in `rateLimit.test.ts` (it would have used the production database) |
| After Phase 7, on the test database | **55** | **740** | none |

The 740 tests are the 590 old ones, the 19 `rateLimit.test.ts` database tests
now run on the test database, and 131 new tests.

No existing test was deleted or weakened. `git diff --numstat b472901..HEAD`
over every `*.test.ts(x)` file shows only added lines. The one changed line is
an `import` in `reports.test.ts` that now also imports `setStoneTotals`. The 131
new tests are in 11 new files, plus additions to 4 existing files:

| File | Tests | Covers |
|---|---|---|
| `src/lib/jewellery/metalMath.test.ts` | 13 | thousandths parsing and rounding, fine/gross, locked 18K example at 100% and 99.9%, 14K/9K, pool effects |
| `src/lib/jewellery/phase7MetalPosting.test.ts` | 21 | both metal defects inverted into regressions, 24K → 18K/14K/9K across partial and final receipts, snapshots, alloy paths, abnormal loss, idempotency key |
| `src/lib/diamond/polishedPurchase.test.ts` | 17 | credit, paid now, GST, multi-line allocation by rate value (per carat, per piece, fixed), all brokerage methods and treatments, no double posting, broker required, cancellation |
| `src/lib/diamond/packets.test.ts` | 8 | exact ledger balance, merge-key grouping, provenance never mixed |
| `src/lib/jewellery/phase7PacketJob.test.ts` | 14 | packet issue, row-lock status re-check, set/returned/damaged, pending never auto-loss, completion gating, cancellation, COGS chain |
| `src/lib/diamond/processCharge.test.ts` | 5 | per carat, per piece, fixed-on-final, rounding |
| `src/lib/diamond/phase7Manufacturer.test.ts` | 8 | process snapshot, processed rough, partial return, fixed charge, rate mismatch refused, wrong receive path refused, voucher amount |
| `src/lib/diamond/packetProcess.test.ts` | 13 | Job Manufacturer issue, cancel, partial/final returns, child packet on size change, pieces must be accounted for, no close on piece count alone, explicit line closure with audit fields, closed line refuses receipts, damaged + abnormal loss, used in Jewellery Job and its cancellation |
| `src/lib/diamond/phase7Serializers.test.ts` | 3 | no cost/brokerage/WIP/charge value in any Staff DTO |
| `src/lib/diamond/packetAdjustment.test.ts` | 4 | adjustment out/in with accounting, stranded residue refused, cancelled packet refused |
| `src/lib/db/uniqueConflict.test.ts` | 6 | the exact P2002 shape the real database returned, the classic shape, other unique violations not mistaken for duplicates, whole column names only |
| `src/lib/jewellery/reports.test.ts` (+2) | 2 | packet stones counted with individual diamonds in Finished Stock |
| action tests (`diamond` +12, `jewellery` +2, `vouchers` +3) | 17 | Owner/Staff enforcement for every new Owner-only action, Staff damaged/lost and abnormal loss refused, idempotent resubmission, concurrent duplicate recovery (both error shapes), line-closure confirmations passed through, generic voucher cancel guards |

All posting tests run the **real** engine code against in-memory transaction
fixtures and assert exact 2-dp money, exact 3-dp weights, and debit = credit on
every voucher.

### Coverage of the required test list (§11)

| Required | Where |
|---|---|
| Direct polished purchase: credit, immediate payment, GST, multiple packet lines | `polishedPurchase.test.ts` |
| Supplier and Dalal/Broker linkage; brokerage for all rate bases | `polishedPurchase.test.ts` |
| No duplicate landed-cost/payable posting | `polishedPurchase.test.ts` ("never posts brokerage twice", included treatment) |
| Purchased vs manufactured provenance | `polishedPurchase.test.ts`, `packets.test.ts`, `packetProcess.test.ts` (child packet `RETURNED_FROM_JOB`) |
| Packet issue / partial / final return; size-wise pieces and carat | `packetProcess.test.ts`, `phase7PacketJob.test.ts` |
| Merge-compatible and incompatible returns | `packetProcess.test.ts` (same size → original packet; new size → child packet) |
| Duplicate issue/return prevention; negative polished stock prevention | same packet twice, over-issue, over-return, residue refusal tests |
| Manufacturer process charge and payable; cancellation/reversal | `phase7Manufacturer.test.ts`, `packetProcess.test.ts` |
| 9K fineness; 24K → 18K, → 14K, → 9K; multiple outputs; partial receipts | `metalMath.test.ts`, `phase7MetalPosting.test.ts` |
| Company vs Karigar-added alloy; return, scrap, normal and abnormal loss | `phase7MetalPosting.test.ts` |
| No movement against an unissued lower-karat pool; no negative pool | `phase7MetalPosting.test.ts`; existing `posting.test.ts` negative-stock tests |
| Exact WIP drain and debit = credit | every posting test file |
| Historical fineness snapshot | `phase7MetalPosting.test.ts` |
| Same-purity workflow unchanged; Phase 6 sale/COGS/return/cancel/refund | existing suites, all passing unchanged; COGS chain assertion in `phase7PacketJob.test.ts` |
| Owner/Staff server-side enforcement | action tests, `phase7Serializers.test.ts`, help-content test |
| Idempotent actions and concurrent duplicate submission | action tests and `uniqueConflict.test.ts`, **plus a real concurrent run on PostgreSQL** (§9.5) |

## 4. New migrations

| Migration | Contents |
|---|---|
| `20260915120000_phase7a_metal_alloy_cross_purity` | `MetalType` + `ALLOY`; defaulted alloy/snapshot columns on jobs, issue lines, receipts and finished outputs |
| `20260916090000_phase7b_polished_purchase_packets` | `PartyType` + `BROKER`, `MANUFACTURER`; sequence types; 6 enums; 6 tables (purchases, lines, packets, packet movements, jewellery packet issue lines and resolutions); CHECK constraints on the new tables |
| `20260917090000_phase7c_manufacturer_processes` | 4 enums; `diamond_processes`, `packet_process_jobs`, `…_job_lines`, `…_receipts`, `…_receipt_lines`; nullable process/charge columns on `diamond_jobs`; CHECK constraints |
| `20260918090000_phase7d_stock_adjustment_voucher` | `VoucherType` + `STOCK_ADJUSTMENT` |
| `20260919090000_phase7e_packet_line_closure_audit` | nullable `closedAt`, `closedByUserId`, `closingReceiptId` on `packet_process_job_lines`, with foreign keys and `CHECK (isClosed = (closedAt IS NOT NULL))` |

Review:

- No `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `ALTER COLUMN` or `RENAME`, except
  in foreign-key `ON DELETE / ON UPDATE` clauses.
- All 26 `ADD COLUMN` statements are nullable or have a `DEFAULT`, so the
  upgrade cannot fail on tables that already have rows.
- Every CHECK constraint is on a new table, or on a new nullable column that
  existing rows leave `NULL` (`diamond_jobs_charge_rate_chk`).
- No migration uses an enum value that it adds in the same migration.
- Each SQL file was generated with `prisma migrate diff --from-schema
  <previous schema> --to-schema prisma/schema.prisma --script` and reviewed.
- Postgres cannot remove enum values. This is the only part that cannot be
  undone.

Applied on a real database (§9.1, §9.2):

- **Empty database** (separate schema `phase7_empty`): `migrate deploy`
  applied all 13 migrations. `migrate status`: "Database schema is up to date!"
  `migrate diff`: no drift. All 10 Phase 7 CHECK constraints are present.
- **Pre-Phase-7 database with data**: the code at `b472901` was taken out with
  `git archive`. Its 8 migrations were applied and its own seed was run. That
  old code then recorded real data: 3 parties, 9 vouchers (all balanced),
  8 metal movements, 10 stone movements, 2 finished pieces and 1 sale.
  `migrate status` then listed the 5 Phase 7 migrations as not yet applied, and
  `migrate deploy` applied them. After that, `migrate status` reported "up to
  date" and `migrate diff` found no drift. Row counts and all 13 ledger account
  balances that had postings were exactly the same before and after the upgrade. For
  example, 1300 stayed 103,825.42, 1310 stayed 3,157.89 and 2000 stayed
  −237,000.00. Existing jewellery issue lines received their purity snapshot
  (2 of 2).

## 5. Accounting entries implemented

Every event is one transaction with its stock movements. The tests check every
voucher for exact debit = credit. The database check in §9.4 checked it again.

| # | Event | Voucher | Debit | Credit | Engine |
|---|---|---|---|---|---|
| 1–2 | Polished purchase, credit or paid now | `PURCHASE` | 1220 landed cost + input GST | 2000 supplier (or payment account) | `polishedPurchase.ts` |
| 3 | Brokerage included / capitalised | `PURCHASE` | included: nothing extra · capitalised: inside 1220 | capitalised: 2000 broker | same |
| 4 | Brokerage expensed | `PURCHASE` | 5400 Brokerage & Commission | 2000 broker | same |
| 5 | Packets to Job Manufacturer | `DIAMOND_ISSUE` | 1210 | 1220 | `packetProcess.ts` |
| 6 | Job Manufacturer return | `DIAMOND_RECEIPT` | 1220 returned + 1320 used + 5100 damaged/abnormal/unabsorbable | 1210 resolved + 2000 Manufacturer charge | same |
| 6b | Rough process return | `DIAMOND_RECEIPT` | 1200 resolved + charge | 1210 + 2000 Manufacturer | `diamond/posting.ts` `receiveProcessedRough` |
| 7–8 | Packets issued to / returned from a Jewellery Job | `JEWELLERY_ISSUE` / `JEWELLERY_RECEIPT` | 1320 / 1220 | 1220 / 1320 | `jewellery/posting.ts` |
| 9–10 | 24K and Company alloy issue | `JEWELLERY_ISSUE` | 1320 | 1300 | same |
| 11 | Karigar-added alloy | `JEWELLERY_RECEIPT` | 1330 | 2000 Karigar | same |
| 12 | Lower-karat finished receipt | `JEWELLERY_RECEIPT` | 1330 (gold portion, company alloy, charges, set stones and packets) | 1320 + 2000 Karigar | same |
| 13–14 | Returned 24K / scrap | `JEWELLERY_RECEIPT` | 1300 / 1310 | 1320 | same |
| 15–16 | Normal / abnormal loss | — / `JEWELLERY_RECEIPT` | absorbed in 1330 / 5100 | 1320 | same |
| 17a | Cancel polished purchase | `REVERSAL` | mirror | mirror | `polishedPurchase.ts` |
| 17b | Cancel Job Manufacturer job | `REVERSAL` | 1220 | 1210 | `packetProcess.ts` |
| 17c | Cancel Jewellery Job | `REVERSAL` (+ `JEWELLERY_ISSUE` for Job Manufacturer-sourced stones) | 1300 / 1220 | 1320 | `jewellery/posting.ts` |
| — | Packet count adjustment | `STOCK_ADJUSTMENT` | out: 5100 · in: 1220 | out: 1220 · in: 5100 | `packetAdjustment.ts` |

The locked example from the instructions matches exactly in
`phase7MetalPosting.test.ts`: 10.000 g 24K (100%) → 12.000 g 18K = 9.000 g fine +
3.000 g alloy + 1.000 g Process Loss. With the seeded 24K at 99.9%: 9.990 g fine
issued, 2.991 g alloy, 0.990 g loss.

## 6. Permissions and data security

| Action | Owner | Staff | Enforced by |
|---|---|---|---|
| Polished purchase create; Job Manufacturer issue/return; rough for a process; processed-rough receipt; packet issue/resolve on Jewellery Jobs | ✅ | ✅ | `requireUser()` |
| Cancel polished purchase / Job Manufacturer job; packet count adjustment; process master | ✅ | ❌ | `requireOwner()` |
| Damaged/lost (stones, packets, Job Manufacturer returns), abnormal loss | ✅ | ❌ | role check in the action before the engine runs |
| Generic "Cancel voucher" on polished purchase or `STOCK_ADJUSTMENT` vouchers | ❌ | ❌ | `cancelVoucherAction` guard |

Staff cost data: on `/diamond`, `/jewellery-jobs` and Metal Stock, the server
passes every cost, landed cost, brokerage amount, WIP, charge rate and charge
through `ownerOnly()`. For Staff, those fields are `null` in the page data sent
to the browser (the RSC payload). `phase7Serializers.test.ts` turns every
Phase 7 Staff DTO into JSON and searches it for each cost value. Staff CSV
exports leave out the cost columns. The in-app help test still proves that Staff
help contains no Owner-only terms.

**Real browser proof (§9.3).** While logged in as Staff, every server response
was recorded: HTML documents and RSC payloads. On desktop that was 38 responses
(545,852 bytes); on mobile, 42 responses (508,224 bytes). The responses were
searched for 14 cost figures created earlier in the run, such as packet costs
₹50,500.00 and ₹40,400.00 and finished-piece costs ₹78,776.55, ₹60,613.14 and
₹17,439.41. The Diamond, Jewellery Jobs, Metal Stock and Finished Stock pages
had **0 hits**. Staff saw no Owner-only controls: `Cancel purchase`,
`Adjust count` and the Settings link were all absent. `/settings` and
`/costing` redirected Staff to `/unauthorized`. A polished purchase that Staff
saved showed pieces and carat, but no landed cost and no brokerage.

## 7. Bugs found and fixed

| # | Found | Bug | Fix | Regression test |
|---|---|---|---|---|
| 1 | Audit §4.9 | `CONSUMED_OUT` deducted issued metal a second time, draining pools and under-costing later issues | informational effect in `METAL_POOL_EFFECT` | `phase7MetalPosting.test.ts`, `metalMath.test.ts` |
| 2 | Audit §4.10 | Scrap re-entered issuable stock while its cost stayed in 1310 | separate scrap pool | same |
| 3 | Audit §4.12 | 24K issue → 18K receipt impossible (root cause shared with #1) | output purity as attribute, consumption against the issued source | same |
| 4 | Audit §4.16 | Staff RSC payloads on `/diamond` and `/jewellery-jobs` carried cost figures | server-side `ownerOnly()` DTOs | `phase7Serializers.test.ts`; real Staff payload audit (§9.3) |
| 5 | Audit §4.18 | Issuing materials overwrote the job's create-time idempotency key | key kept | `phase7MetalPosting.test.ts` |
| 6 | P0 | No-output final receipt with abnormal loss produced an unbalanced voucher | cost split to returned/scrap or expensed | same |
| 7 | P0 | A receipt that only returned a diamond posted a zero voucher amount (the database requires > 0) | amount = total debit | same |
| 8 | P2 | Polished receipt voucher amount left out returned rough cost | amount = full debit | `phase7Manufacturer.test.ts` |
| 9 | P2 | The production-safe `db:seed-phase7-masters` did not create the 5400 account that brokerage posts to | shared create-only `prisma/phase7Masters.ts` | seed run twice on a real database (§9.1) |
| 10 | P2 | Packet issues read the ledger without a row lock (concurrent over-issue possible) | `lockPacketInTx` before every ledger read | status re-check test; real race (§9.5) |
| 11 | P2 | Cancelling a Jewellery Job would return Job Manufacturer-sourced stones to stock without reversing their 1320 cost | explicit Dr 1220 / Cr 1320 on cancel | `packetProcess.test.ts` |
| 12 | Docs | README and master plan still said Phase 6 was uncommitted | README corrected; master plan note appended | — |
| 13 | Browser E2E | A multi-line polished purchase shared its landed cost by **carat**, not by each line's rate value. Two lines with different per-carat rates therefore got the wrong packet costs, although the total was right | shared by `lineRateValue` (rate × carat, rate × pieces, or the fixed rate); falls back to carat only when a line has no value; manual per-line costs still take priority | `polishedPurchase.test.ts` (+2) · `a674556` |
| 14 | Browser E2E | Finished Stock, the sale picker and job outputs counted only individually tracked diamonds. Packet stones set into a piece were left out (a piece with 20 packet stones showed 0) | `setStoneTotals` adds packet resolutions | `reports.test.ts` (+2) · `a674556` |
| 15 | Browser E2E | The Owner's polished packet list also showed packets from **cancelled** purchases | list only `ACTIVE`/`EMPTY` packets | — (query filter, no unit test) · `a674556` |
| 16 | Real concurrency run | Every action's `isIdempotencyConflict` looked only at `meta.target`. The `@prisma/adapter-pg` driver reports a unique violation in `meta.driverAdapterError.cause.constraint` instead. When two submissions raced on a real database, the losing one showed "Could not save" although the first had saved. **No data was duplicated.** This existed in all six action files since Phase 2 | one shared `src/lib/db/uniqueConflict.ts` that understands both shapes | `uniqueConflict.test.ts` (6) and action tests (+2, both fail without the fix) · `2da3038` |

Test-infrastructure issue fixed along the way: two fixture layers generated
colliding row ids for seeded packets, which could hide a packet's purchase
movement.

## 8. Known limitations and findings for the Owner

Found during real verification. None of these was changed:

- **Staff can see voucher totals in Accounting › Transactions.** This is the
  documented access from Phase 2. For a polished purchase with capitalised
  brokerage and no GST, the bill total equals the landed cost, so Staff can work
  out that cost there. The Phase 7 module pages do not show it (§6). If this
  should be hidden, the Owner needs to decide on a change to the Accounting
  pages.
- **Jewellery Jobs list "pending" includes recognised process loss.**
  `b472901` uses the same formula, so this is not a Phase 7 regression. The job
  detail page shows the correct reconciliation.
- **Polished Diamond stock shows the raw status `SET_IN_JEWELLERY`** as its
  label. This is cosmetic and also existed before Phase 7.

Design limitations (unchanged from the plan):

- Past postings are reported, not rewritten (Owner decision). The metal
  reconciliation script shows the difference. On the pre-Phase-7 data, the old
  reading showed 22K at 0.916 g fine, while the corrected pools show 13.740 g
  fine and match 1300/1310 exactly.
- The Phase 4 metal adjustment still posts stock only, without a voucher
  (unchanged). Phase 7 packet adjustments post their accounting.
- A Jewellery Job return of packet stones goes back into its original packet.
  Size changes are recorded only on Job Manufacturer returns.
- "Used in Jewellery Job" is refused when that job already holds stones from
  the same packet. Two cost layers are never averaged into one line.
- A Job Manufacturer job can be cancelled only before its first return.
- Job Manufacturer line closure follows the Owner decision of 2026-09-17. A line
  may close once all its pieces are resolved; its carat gap is then recorded as
  loss for that line, while other lines stay open. Closing needs an explicit
  confirmation, or an exact carat match. A closed line refuses further
  receipts. There is no Owner correction/reversal workflow for closed lines yet.
- A loss confirmed on a later receipt than the stones' return is expensed,
  because those stones are already back in stock at their resolved cost.
- Enum additions cannot be rolled back in Postgres.
- P&L was checked in the ledger (4000 Sales, 4100 Sales Returns, 5200 COGS),
  not by opening the P&L report page.

## 9. Real verification performed (instructions §12)

Setup: local PostgreSQL 17 on `localhost:5432`. Only the role
`zynoraluxe_phase7_user` and the database `zynoraluxe_phase7_test` were created.
Only `TEST_DATABASE_URL` was written to the gitignored `.env`. The app ran with
`next build` + `next start` on port 3100 through the same identity-checking
wrapper. The browser was installed Google Chrome 152, driven by `playwright-core`
from a temporary folder outside the repository. All business data used the
`PHASE7TEST` prefix.

### 9.1 Empty database and seeds

- `migrate deploy` / `migrate status` / `migrate diff`: see §4.
- `db:seed` run twice and `db:seed-phase7-masters` run twice gave the same row
  counts after every run: users 1, accounts 27 (including 5400 Brokerage &
  Commission), payment accounts 3, GST rates 6, purities 9 (24K stays 99.900,
  9K 37.500, Copper/Alloy 0.000), processes 4. The first seed printed "Phase 7
  masters ready: 6 created, 1 already present"; every later run printed "0
  created, 7 already present".
- The production path (masters script only) was checked on the empty schema:
  "7 created", then "0 created, 7 already present".

### 9.2 Pre-Phase-7 upgrade

See §4. The metal reconciliation on this old data matched 1300/1310, and so did
the diamond reconciliation.

### 9.3 Browser E2E (Owner and Staff, desktop 1440×900 and mobile 390×844)

Every step watched for console errors, page errors, failed requests, CSP
violations and HTTP 5xx. **Result: 0 of each.** Browser dialogs were accepted.
Business results were then checked directly in the database.

| §12 step | What was done in the browser | Result |
|---|---|---|
| 1–2 Polished purchase with Supplier and Dalal/Broker; accounting, payable, stock | `ZL-PP-2026-000003`, 2 packet lines (150 pcs / 15.000 ct), capitalised brokerage | Landed ₹90,900.00 (brokerage ₹900.00). Packet A `ZL-PKT-2026-000004` ₹50,500.00, packet B `-000005` ₹40,400.00, shared by line rate value (bug 13). AP: supplier ₹90,000, Dalal ₹900 |
| 3 Issue to Job Manufacturer | `ZL-PJ-2026-000001`, both packets, Polishing, per-carat charge | 1220 → 1210 |
| 4 Partial and final returns | `PJR-000001` partial. `PJR-000002` closed line A only after the explicit "Close this line" tick (0.150 ct loss). `PJR-000003` final for line B: 30 pcs / 3.000 ct used in a Jewellery Job, 20 pcs / 1.950 ct back, 0.050 ct loss | Charges ₹100 + ₹285 + ₹495 = ₹880 payable to the Manufacturer. After `PJR-000002` the detail page showed A Closed and B still Open, and the closed line was not offered for further returns. After `PJR-000003` the job is `COMPLETED` |
| 5 Returned stock, merge and provenance | a size change on return | child packet `ZL-PKT-2026-000006` (`RETURNED_FROM_JOB`, 20 pcs / 1.900 ct, ₹10,290.00). Same size → original packet |
| 6–10 Jewellery Job, 24K only → 18K/14K/9K, both alloy paths, returned 24K, scrap, loss | `ZL-JJOB-2026-000004`, receipt `ZL-JREC-2026-000003` | Outputs: `FJ-000003` 18K 12 g (packet stones 20 / 2.000 ct), `FJ-000004` 14K 8 g (30 / 3.000 ct), `FJ-000005` 9K 6 g. Returned 1.998 g fine, scrap 0.999 g fine, loss 1.053 g fine. Alloy 10.054 g = Company 5.000 g + Karigar 5.054 g (charge ₹500). Job `COMPLETED` |
| 11 Job cost and finished inventory value | Finished Stock | ₹78,776.55 / ₹60,613.14 / ₹17,439.41. Diamond counts include packet stones (bug 14) |
| 12 Phase 6 sale, COGS, P&L | `ZL-FJS-2026-000002`, the 18K piece, credit sale, CGST+SGST 3% | COGS ₹78,776.55. The piece shows Sold with its sale reference |
| 13 Cancellation and return paths | sellable return of that sale line; Job Manufacturer job `ZL-PJ-2026-000002` cancelled; purchases `ZL-PP-2026-000001` and `-000002` cancelled; one stray draft Jewellery Job cancelled | The piece is Available again. Stones are back in the child packet. Cancelled packets are not listed (bug 15) |
| 14 Owner and Staff separately | Staff desktop and mobile | see §6; Staff purchase `ZL-PP-2026-000004` shows no cost |
| 15 Desktop and mobile | Owner and Staff on every Phase 7 page, plus the Job Manufacturer and Jewellery Job detail pages and both new forms | horizontal overflow **0 px** on every page at 390 px |
| 16 Console, page errors, failed requests, CSP | every step | 0 / 0 / 0 / 0 |

Bugs 13–15 were found during the browser run. After `a674556`, parts 2–5 ran on
a new build: the purchase cost split, Finished Stock with packet stones, the
sale, the returns, the cancellations and both roles. Part 1 (masters, party
types, alloy purchase) ran before that fix; the fix does not touch those
flows. Bug 16 was found after the browser run (§9.5).

### 9.4 Direct database reconciliation (after the browser run)

`db:phase7-metal-reconciliation` and `db:phase7-diamond-reconciliation` ran on
the test database, together with SQL tie-outs:

| Check | Stock / sub-ledger | General ledger |
|---|---|---|
| Vouchers | 27 checked, 0 unbalanced | — |
| 1220 Polished Diamond Inventory | stones ₹18,164.84 + 7 packets ₹59,128.24 = ₹77,293.08 | ₹77,293.08 |
| 1210 Diamond WIP | open jobs' remaining WIP ₹0.00 | ₹0.00 |
| 1300 Metal Inventory | usable pools ₹330,104.31 | ₹330,104.31 |
| 1310 Scrap Metal Inventory | scrap pools ₹10,547.33 | ₹10,547.33 |
| 1320 Jewellery WIP | 0 open jobs, ₹0.00 | ₹0.00 |
| 1330 Finished Jewellery Inventory | 4 available pieces ₹216,671.21 | ₹216,671.21 |
| 5200 COGS | sales `FJS-000001` ₹42,394.36 + `FJS-000002` ₹78,776.55, the latter reversed by its sellable return | ₹42,394.36 |
| 2000 payables by party | Dalal ₹900 · Karigar ₹10,500 · Manufacturer ₹880 · Polished Supplier ₹92,345.67 · Supplier ₹582,000 | total ₹686,625.67 |
| Job Manufacturer lines | 3 checked, all closed lines have their audit record, 0 awaiting confirmation | — |
| 24K job | metal movements only on 24K and Copper/Alloy; nothing moved against 18K/14K/9K pools | — |

### 9.5 Real concurrent double-submit

A temporary script ran the real posting engine inside real Postgres
transactions. When a submission hit the unique idempotency key, it used the same recovery
as the server actions: find the saved record and return it.

| Scenario | Result |
|---|---|
| The same polished purchase submitted 5 times at once with one idempotency key | 1 purchase, 1 voucher. The other 4 submissions returned the same `ZL-PP-2026-000001` |
| Two different Job Manufacturer issues racing for 8 of the same packet's 10 pieces | one issued (`ZL-PJ-2026-000001`), one refused: "Only 2 piece(s) available." Packet balance 2 pcs / 0.200 ct, never negative |
| The same issue submitted 5 times at once with one idempotency key | 1 job (`ZL-PJ-2026-000002`); the other 4 returned it. Packet balance 1 pc / 0.100 ct |
| Every voucher | 3 checked, 0 unbalanced |

The first attempt of this run found bug 16. The run above is on the fixed code.

### 9.6 Cleanup and baseline proof

`cleanup.js` (temporary, outside the repository) worked like this:

1. It checked the database identity.
2. It proved that every party is named `PHASE7TEST…`, every user is a
   `phase7test.…@example.test` test user, and no row was created by anyone
   else (0 in each case).
3. It worked out the delete order from the foreign keys and printed a dry run.
4. It deleted everything in one transaction, which rolls back unless the
   baseline matches exactly.

After the browser run it deleted rows in 36 tables (for example 27 vouchers,
83 journal entries, 7 packets, 5 finished pieces and 6 parties), the Staff test
user and the `phase7_empty` schema. After the concurrency run it deleted that
run's rows the same way.

Final baseline, checked after the last run: users 1 (the test Owner), accounts
27, payment accounts 3, GST rates 6, purities 9, processes 4, migrations 13.
All 47 other tables are empty, and schema `phase7_empty` is gone.
`migrate status` reports "up to date". Both reconciliation scripts match at
₹0.00 (0 vouchers, 1220/1210/1300/1310 all ₹0.00).

Temporary files were deleted: the pre-Phase-7 code extract, the build folder
used for it, the E2E packages, the test-only secrets file and the temporary
scripts in the repository. No temporary file was committed.

## 10. Changed files and repository state

Base `b472901` → branch `phase-7-polished-metal-process`.

Commits: `95c05cf`, `336a08a`, `833be66`, `e3f001c`, `6611961`, `fbd5cbf`,
`7271a6e`, `a674556`, `2da3038`, and the final acceptance documentation commit
that updates this report and the README.

```text
M  EMPLOYEE_USER_MANUAL_GUJARATI.md
A  PHASE_7_CURRENT_STATE_AUDIT.md
A  PHASE_7_IMPROVEMENT_PLAN.md
A  PHASE_7_VERIFICATION.md
M  README.md
M  USER_REVIEW_GUIDE_GUJARATI.md
M  package.json
A  prisma/migrations/20260915120000_phase7a_metal_alloy_cross_purity/migration.sql
A  prisma/migrations/20260916090000_phase7b_polished_purchase_packets/migration.sql
A  prisma/migrations/20260917090000_phase7c_manufacturer_processes/migration.sql
A  prisma/migrations/20260918090000_phase7d_stock_adjustment_voucher/migration.sql
A  prisma/migrations/20260919090000_phase7e_packet_line_closure_audit/migration.sql
A  prisma/phase7Masters.ts
M  prisma/schema.prisma
M  prisma/seed.ts
A  scripts/phase7DiamondReconciliation.ts
A  scripts/phase7MetalStockReconciliation.ts
A  scripts/seedPhase7Masters.ts
M  src/app/(app)/diamond/page.tsx
M  src/app/(app)/jewellery-jobs/page.tsx
M  src/app/(app)/settings/page.tsx
M  src/app/actions/costing.ts
M  src/app/actions/diamond.test.ts
M  src/app/actions/diamond.ts
M  src/app/actions/finishedSales.ts
M  src/app/actions/jewellery.test.ts
M  src/app/actions/jewellery.ts
M  src/app/actions/metal.ts
M  src/app/actions/vouchers.test.ts
M  src/app/actions/vouchers.ts
M  src/components/accounting/PartyEditForm.tsx
M  src/components/accounting/PartyForm.tsx
M  src/components/accounting/PartySelect.tsx
M  src/components/accounting/TransactionsTab.tsx
M  src/components/accounting/VoucherList.tsx
A  src/components/diamond/AdjustPacketForm.tsx
A  src/components/diamond/CancelPacketProcessJobForm.tsx
A  src/components/diamond/CancelPolishedPurchaseForm.tsx
M  src/components/diamond/IssueRoughForm.tsx
M  src/components/diamond/JobDetailView.tsx
A  src/components/diamond/JobManufacturerTab.tsx
M  src/components/diamond/JobsTab.tsx
M  src/components/diamond/OverrideAllocationForms.tsx
A  src/components/diamond/PacketProcessIssueForm.tsx
A  src/components/diamond/PacketProcessJobDetailView.tsx
A  src/components/diamond/PacketProcessReturnForm.tsx
A  src/components/diamond/PolishedPacketsSection.tsx
A  src/components/diamond/PolishedPurchaseForm.tsx
M  src/components/diamond/PolishedStockTab.tsx
M  src/components/diamond/ReceivePolishedForm.tsx
A  src/components/diamond/ReceiveProcessedRoughForm.tsx
M  src/components/diamond/RoughStockTab.tsx
M  src/components/jewellery/IssueMaterialsForm.tsx
M  src/components/jewellery/JobDetailView.tsx
M  src/components/jewellery/JobsTab.tsx
M  src/components/jewellery/MetalStockTab.tsx
M  src/components/jewellery/OverrideAllocationForm.tsx
M  src/components/jewellery/ReceiveFinishedForm.tsx
A  src/components/settings/DiamondProcessSettingsPanel.tsx
M  src/components/settings/MetalPuritySettingsPanel.tsx
M  src/lib/accounting/accounts.ts
M  src/lib/accounting/numbering.ts
A  src/lib/db/uniqueConflict.test.ts
A  src/lib/db/uniqueConflict.ts
M  src/lib/diamond/numbering.ts
A  src/lib/diamond/packetAdjustment.test.ts
A  src/lib/diamond/packetAdjustment.ts
A  src/lib/diamond/packetProcess.test.ts
A  src/lib/diamond/packetProcess.ts
A  src/lib/diamond/packetReports.ts
A  src/lib/diamond/packets.test.ts
A  src/lib/diamond/packets.ts
A  src/lib/diamond/phase7Manufacturer.test.ts
A  src/lib/diamond/phase7Serializers.test.ts
A  src/lib/diamond/phase7Serializers.ts
A  src/lib/diamond/polishedPurchase.test.ts
A  src/lib/diamond/polishedPurchase.ts
M  src/lib/diamond/posting.ts
A  src/lib/diamond/processCharge.test.ts
A  src/lib/diamond/processCharge.ts
M  src/lib/diamond/reports.ts
M  src/lib/help/sections.tsx
A  src/lib/jewellery/metalMath.test.ts
A  src/lib/jewellery/metalMath.ts
A  src/lib/jewellery/phase7MetalPosting.test.ts
A  src/lib/jewellery/phase7PacketJob.test.ts
M  src/lib/jewellery/posting.ts
M  src/lib/jewellery/reports.test.ts
M  src/lib/jewellery/reports.ts
M  src/lib/jewellery/types.ts
A  src/lib/parties/types.ts
A  src/lib/security/ownerOnly.ts
M  src/lib/validation/diamond.ts
M  src/lib/validation/jewellery.ts
M  src/lib/validation/parties.ts
M  test/fixtures/fakeDiamondTx.ts
M  test/fixtures/fakeJewelleryTx.ts
A  test/fixtures/fakePacketProcessTx.ts
A  test/fixtures/fakePolishedTx.ts
```

Outside the repository: `../ZYNORALUXE_JEWELLERY_ERP_MASTER_PLAN.md`
(Section 13 appended; the original 591 lines are byte-identical).

The test database `zynoraluxe_phase7_test` and its role were kept at the seeded
baseline for future verification. `.env` gained only `TEST_DATABASE_URL`.

Not pushed, not merged, not tagged, not deployed.
