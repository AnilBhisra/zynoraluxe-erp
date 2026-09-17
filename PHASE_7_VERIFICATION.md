# Phase 7 Verification Report

Branch `phase-7-polished-metal-process`, based on `b472901`.
Specification: `../ZYNORALUXE_PHASE_7_CLAUDE_MASTER_INSTRUCTIONS.md`.
Audit: `PHASE_7_CURRENT_STATE_AUDIT.md`. Design: `PHASE_7_IMPROVEMENT_PLAN.md`.

## 1. Result

**PASS on the final code (`5f7ed1d`).** Every required acceptance check passed
after the fixes below. The checks ran against the isolated local PostgreSQL 17
database `zynoraluxe_phase7_test` (role `zynoraluxe_phase7_user`, not a
superuser) and real Google Chrome 152.

**How it got here:**

1. **First acceptance (`7ee879b`).** All checks passed.
2. **Conditional PASS.** The Owner downgraded the result because the
   duplicate-submit fix (`2da3038`) came after the browser run.
3. **Complete rerun on `7ee879b`.** It found two failed checks and one
   confidentiality defect:
   - The Profit and Loss page left out expensed brokerage (5400).
   - The Jewellery Job detail page did not show packet stones or their cost.
   - Staff could see automatic stock-movement voucher amounts in
     Accounting › Transactions.
4. **Fixes (`5f7ed1d`).** All three were fixed with regression tests that fail
   without the fix.
5. **Final run.** Everything was re-verified, starting again from the test
   database with no business data (§9).

**Test database safety.** Production was never connected to. A wrapper ran
every database command. Before each command it checked that
`current_database()` is `zynoraluxe_phase7_test` and `current_user` is
`zynoraluxe_phase7_user`. It also set `DATABASE_URL`, `DIRECT_URL`, the session
secret, the Owner/Staff logins and storage to test-only values. `DATABASE_URL`
in `.env` was never changed.

| Acceptance check (§13) | Result on the final code |
|---|---|
| `prisma validate` | ✅ The schema is valid |
| `prisma migrate status` | ✅ The test database is "up to date" (13 migrations), before the run and after cleanup. A new empty schema also reports "up to date" after `migrate deploy` of all 13 migrations |
| Migration drift | ✅ `migrate diff --exit-code` against `prisma/schema.prisma`: "No difference detected." on the test database and on the new empty schema |
| TypeScript (`tsc --noEmit`) | ✅ exit 0 |
| ESLint (`eslint . --max-warnings=0`) | ✅ exit 0 |
| Full Vitest suite | ✅ **59 files / 762 tests passed, 0 skipped.** This includes the 19 `rateLimit.test.ts` database tests, run on the test database |
| Production `next build` (clean `.next`) | ✅ exit 0. The browser run used this build |
| Client-bundle secret scan | ✅ 38 static files checked for 10 secret-shaped `.env` values and 5 secret variable names: 0 hits |
| Tracked/changed-file secret scan | ✅ `b472901..HEAD` (including `5f7ed1d`): 0 hits. Whole tree: only the two storage bucket names, which are not secret. `.env` is ignored by git |
| Database schema migration review | ✅ No new migration since `7ee879b`. Earlier proofs still apply: empty database and pre-Phase-7 upgrade (§4) |
| Real browser E2E | ✅ 68 steps over Owner desktop, Staff desktop, Staff mobile and Owner mobile: 0 console errors, 0 page errors, 0 failed requests, 0 CSP violations, 0 HTTP 5xx (§9.3) |
| Profit and Loss page vs ledger | ✅ Every displayed line and Net profit match the ledger, including 5400 Brokerage & Commission (§9.4) |
| Jewellery Job packet quantities and Owner-only cost | ✅ Packet code, pieces and carat are shown to both roles. Exact packet costs and totals are shown to the Owner and are absent from Staff pages and payloads (§9.3) |
| Staff cost-leak checks | ✅ 0 leaks in 122 Staff responses (1,784,526 bytes), searching 33 internal cost figures and internal voucher amounts. The pages covered: Transactions, three party ledgers, the Purchases, Outstanding and P&L reports, and every Phase 7 page (§9.3) |
| Direct database reconciliation | ✅ Stock matches the ledger for 1210/1220/1300/1310/1320/1330. Payables by party and every voucher's debit = credit also match. Both reconciliation scripts exit 0 (§9.4) |
| Duplicate submit | ✅ A browser double-submit (two submits of one form at once) saves one purchase and one voucher, on Staff desktop and on Owner mobile. The real-Postgres race proof is in §9.5 |
| Temporary-data cleanup | ✅ Dry run first, then one checked transaction back to the seeded baseline (§9.6) |
| `git diff --check` | ✅ Clean |
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
| Acceptance docs | `7ee879b` | First acceptance evidence |
| Rerun fixes | `5f7ed1d` | P&L counts every expense account once (5400 included); Jewellery Job detail shows packet lines and packet-inclusive cost; Staff Transactions exclude internal costing vouchers |
| Acceptance | final commit | This report and README updated with the final-run evidence |

The UI keeps the existing navigation. The Diamond page's sections are now
`Rough Diamond`, `Manufacturer`, `Job Manufacturer` and `Polished Diamond`
(old `?tab=rough|jobs|polished` links still work).

## 3. Tests before and after

| | Test files | Tests passed | Not run |
|---|---|---|---|
| Before Phase 7 (audit baseline, `b472901`) | 44 | 590 | 19 in `rateLimit.test.ts` (it would have used the production database) |
| First acceptance (`7ee879b`) | 55 | 740 | none |
| **Final (`5f7ed1d`), on the test database** | **59** | **762** | none |

The 762 tests are the 590 old ones, the 19 `rateLimit.test.ts` database tests
now run on the test database, and 153 new tests.

No existing test was deleted or weakened. `git diff --numstat b472901..HEAD`
over every `*.test.ts(x)` file shows only added lines, apart from three
changed `import` lines that now import more names.

| File | Tests | Covers |
|---|---|---|
| `src/lib/jewellery/metalMath.test.ts` | 13 | thousandths parsing and rounding, fine/gross, locked 18K example at 100% and 99.9%, 14K/9K, pool effects |
| `src/lib/jewellery/phase7MetalPosting.test.ts` | 21 | both metal defects inverted into regressions, 24K → 18K/14K/9K across partial and final receipts, snapshots, alloy paths, abnormal loss, idempotency key |
| `src/lib/diamond/polishedPurchase.test.ts` | 17 | credit, paid now, GST, multi-line allocation by rate value, all brokerage methods and treatments, no double posting, broker required, cancellation |
| `src/lib/diamond/packets.test.ts` | 8 | exact ledger balance, merge-key grouping, provenance never mixed |
| `src/lib/jewellery/phase7PacketJob.test.ts` | 14 | packet issue, row-lock status re-check, set/returned/damaged, pending never auto-loss, completion gating, cancellation, COGS chain |
| `src/lib/diamond/processCharge.test.ts` | 5 | per carat, per piece, fixed-on-final, rounding |
| `src/lib/diamond/phase7Manufacturer.test.ts` | 8 | process snapshot, processed rough, partial return, fixed charge, rate mismatch refused, wrong receive path refused, voucher amount |
| `src/lib/diamond/packetProcess.test.ts` | 13 | Job Manufacturer issue, cancel, partial/final returns, child packet on size change, explicit line closure with audit fields, closed line refuses receipts, damaged + abnormal loss, used in Jewellery Job and its cancellation |
| `src/lib/diamond/phase7Serializers.test.ts` | 3 | no cost/brokerage/WIP/charge value in any Staff DTO |
| `src/lib/diamond/packetAdjustment.test.ts` | 4 | adjustment out/in with accounting, stranded residue refused, cancelled packet refused |
| `src/lib/db/uniqueConflict.test.ts` | 6 | the exact P2002 shape the real database returned, the classic shape, other unique violations not mistaken for duplicates |
| `src/lib/jewellery/jobDetailSerializers.test.ts` | 6 | packet-inclusive diamond and total cost issued (exact ₹ figures from the run), packet lines loaded with code/description/pieces/carat/cost, Staff DTO carries no cost, Owner keeps exact costs |
| `src/lib/accounting/voucherVisibility.test.ts` | 5 | an explicit Staff visibility decision for every voucher type, reversals follow the reversed voucher, Owner sees all, the database filter matches the rule for every type and reversal |
| `src/components/jewellery/JobDetailView.test.tsx` | 2 | Staff sees packet code/pieces/carat and no ₹ anywhere; Owner sees packet costs and packet-inclusive totals |
| `src/components/accounting/TransactionsTab.test.tsx` | 2 | Staff list has ordinary vouchers and reversals only, no internal voucher label or amount, Owner-only note; Owner sees every voucher |
| `src/lib/accounting/reports.test.ts` (+6) | 6 | P&L: expensed brokerage reduces Net profit exactly once and equals the ledger (real purchase engine), capitalised brokerage never reaches P&L, only non-dedicated non-zero expense accounts listed; `listVouchers` never loads internal vouchers for Staff, Owner unrestricted, search does not replace the restriction |
| `src/components/accounting/ReportsView.test.tsx` (+1) | 1 | Brokerage & Commission shown once and Net profit includes it |
| `src/lib/jewellery/reports.test.ts` (+2) | 2 | packet stones counted with individual diamonds in Finished Stock |
| action tests (`diamond` +12, `jewellery` +2, `vouchers` +3) | 17 | Owner/Staff enforcement for every new Owner-only action, Staff damaged/lost and abnormal loss refused, idempotent resubmission, concurrent duplicate recovery (both error shapes), line-closure confirmations, generic voucher cancel guards |

All posting tests run the **real** engine code against in-memory transaction
fixtures and assert exact 2-dp money, exact 3-dp weights, and debit = credit on
every voucher.

### Coverage of the required test list (§11)

| Required | Where |
|---|---|
| Direct polished purchase: credit, immediate payment, GST, multiple packet lines | `polishedPurchase.test.ts` |
| Supplier and Dalal/Broker linkage; brokerage for all rate bases | `polishedPurchase.test.ts` |
| No duplicate landed-cost/payable posting | `polishedPurchase.test.ts`; P&L exactly-once tests in `reports.test.ts` |
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
| Owner/Staff server-side enforcement | action tests, `phase7Serializers.test.ts`, `jobDetailSerializers.test.ts`, `voucherVisibility.test.ts`, `listVouchers` authorization tests, help-content test |
| Idempotent actions and concurrent duplicate submission | action tests and `uniqueConflict.test.ts`, plus real-Postgres and real-browser proofs (§9.3, §9.5) |

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

| Action or data | Owner | Staff | Enforced by |
|---|---|---|---|
| Polished purchase create; Job Manufacturer issue/return; rough for a process; processed-rough receipt; packet issue/resolve on Jewellery Jobs | ✅ | ✅ | `requireUser()` |
| Cancel polished purchase / Job Manufacturer job; packet count adjustment; process master | ✅ | ❌ | `requireOwner()` |
| Damaged/lost (stones, packets, Job Manufacturer returns), abnormal loss | ✅ | ❌ | role check in the action before the engine runs |
| Generic "Cancel voucher" on polished purchase or `STOCK_ADJUSTMENT` vouchers | ❌ | ❌ | `cancelVoucherAction` guard |
| Jewellery Job packet lines: code, description, pieces, carat, set/returned/damaged | ✅ | ✅ | `serializeJobPacketLines()` |
| Jewellery Job packet cost, diamond cost issued, total manufacturing cost issued | ✅ | ❌ | `ownerOnly()` in `jobDetailSerializers.ts` |
| Accounting › Transactions and voucher reports: purchase, sale, payment given/received, expense, opening balance, sale return, customer refund, and reversals of these | ✅ | ✅ | `voucherVisibilityWhere()` inside the `listVouchers` query |
| Accounting › Transactions: diamond issue/receipt, jewellery issue/receipt, stock adjustment, and their reversals | ✅ | ❌ | same filter, applied in the database, so the rows never reach a Staff payload |
| Profit and Loss, GST and Finished Sales reports | ✅ | ❌ | existing Owner-only report guard |

Staff cost data: on `/diamond`, `/jewellery-jobs` and Metal Stock, the server
passes every cost, landed cost, brokerage amount, WIP, charge rate and charge
through `ownerOnly()`. For Staff, those fields are `null` in the page data sent
to the browser (the RSC payload). `listVouchers` now requires the viewer's role
and filters with an allowlist, so a voucher type added later stays hidden from
Staff until someone deliberately allows it.

**Real browser proof (§9.3).** While logged in as Staff, every HTML and RSC
response was recorded: 64 on desktop, 58 on mobile. The responses were searched
for 33 figures read from the database: packet, finished-piece, job, metal-pool
and landed costs, plus every internal costing voucher amount. Matches only
count at number boundaries.

- **Leaks: 0.**
- **Allowed matches:** ₹2,000.00, ₹3,000.00, ₹3,50,000.00 and ₹90,900.00. These
  are the bill totals of ordinary purchase vouchers, shown on Accounting pages
  (§8).

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
| 9 | P2 | The production-safe `db:seed-phase7-masters` did not create the 5400 account that brokerage posts to | shared create-only `prisma/phase7Masters.ts` | seeds run twice on a real database (§9.1) |
| 10 | P2 | Packet issues read the ledger without a row lock (concurrent over-issue possible) | `lockPacketInTx` before every ledger read | status re-check test; real race (§9.5) |
| 11 | P2 | Cancelling a Jewellery Job would return Job Manufacturer-sourced stones to stock without reversing their 1320 cost | explicit Dr 1220 / Cr 1320 on cancel | `packetProcess.test.ts` |
| 12 | Docs | README and master plan still said Phase 6 was uncommitted | README corrected; master plan note appended | — |
| 13 | Browser E2E | A multi-line polished purchase shared its landed cost by carat, not by each line's rate value | shared by `lineRateValue` | `polishedPurchase.test.ts` (+2) · `a674556` |
| 14 | Browser E2E | Finished Stock, the sale picker and job outputs did not count packet stones set into a piece | `setStoneTotals` adds packet resolutions | `reports.test.ts` (+2) · `a674556` |
| 15 | Browser E2E | The Owner's packet list also showed packets from cancelled purchases | list only `ACTIVE`/`EMPTY` packets | browser check (§9.3) · `a674556` |
| 16 | Real concurrency run | `isIdempotencyConflict` looked only at `meta.target`, but `@prisma/adapter-pg` reports the constraint in `meta.driverAdapterError.cause.constraint`. A lost double-submit race showed "Could not save" although the first submission had saved (no data duplicated). This existed in all six action files since Phase 2 | shared `src/lib/db/uniqueConflict.ts` | `uniqueConflict.test.ts` (6), action tests (+2) · `2da3038` |
| 17 | Rerun: P&L vs ledger | The Profit and Loss page read a fixed list of accounts, so expensed Dalal / Broker brokerage (5400) never reduced Net profit. The page showed ₹-400.00; the ledger gave ₹-900.00 | every EXPENSE-type account without its own line is listed by name and deducted once (accounts created at runtime are ASSET payment accounts) | `reports.test.ts` (+3), `ReportsView.test.tsx` (+1) · `5f7ed1d` |
| 18 | Rerun: job detail | The Jewellery Job detail page never loaded packet issue lines or `issuedPacketDiamondCost`. Packet stones were missing, "Diamond cost issued" showed ₹0.00, and "Total manufacturing cost issued" showed ₹1,40,500.00 instead of ₹1,50,712.58 | packet lines loaded and shown; `jobIssuedCosts()` used by the detail and the jobs list; costs redacted for Staff in tested serializers | `jobDetailSerializers.test.ts` (6), `JobDetailView.test.tsx` (2) · `5f7ed1d` |
| 19 | Rerun: Staff payload audit | Accounting › Transactions sent Staff every voucher, including automatic diamond, jewellery-job and stock-adjustment vouchers whose amounts are internal carrying cost (for example ₹2,707.89 and ₹5,150.00) | allowlist filter inside the database query for Staff; a note tells Staff these entries are Owner-only | `voucherVisibility.test.ts` (5), `reports.test.ts` (+3), `TransactionsTab.test.tsx` (2) · `5f7ed1d` |

Test-infrastructure issue fixed along the way: two fixture layers generated
colliding row ids for seeded packets, which could hide a packet's purchase
movement.

## 8. Known limitations and findings for the Owner

Found during real verification. None of these was changed:

- **Staff still see bill totals of ordinary purchases** in Accounting ›
  Transactions and the Purchases report. Staff record and pay these purchases.
  For a polished purchase with brokerage added to diamond cost and no GST, the
  bill total equals the landed cost (for example ₹90,900.00), so Staff can work
  out that cost there.
- **A party's ledger shows Staff the payable lines of automatic vouchers.**
  Examples: a Manufacturer's process charge on a Diamond Receipt, and a
  Karigar's labour and alloy charge on a Jewellery Receipt. These are amounts
  owed to that party, which Staff need to record payments. They are not
  internal stock cost, and the audit found none of the internal cost figures
  there. Hiding them would be an Owner decision.
- **Jewellery Jobs list "pending" includes recognised process loss.**
  `b472901` uses the same formula, so this is not a Phase 7 regression. The job
  detail page shows the correct reconciliation.
- **Polished Diamond stock shows the raw status `SET_IN_JEWELLERY`** as its
  label. This is cosmetic and also existed before Phase 7.

Design limitations (unchanged):

- Past postings are reported, not rewritten (Owner decision). The metal
  reconciliation script shows the difference.
- The Phase 4 metal adjustment still posts stock only, without a voucher
  (unchanged). Phase 7 packet adjustments post their accounting.
- A Jewellery Job return of packet stones goes back into its original packet.
  Size changes are recorded only on Job Manufacturer returns.
- "Used in Jewellery Job" is refused when that job already holds stones from
  the same packet.
- A Job Manufacturer job can be cancelled only before its first return.
- Job Manufacturer line closure follows the Owner decision of 2026-09-17: a
  line closes only with explicit confirmation (or an exact carat match), and a
  closed line refuses further receipts. There is no Owner correction/reversal
  workflow for closed lines yet.
- A loss confirmed on a later receipt than the stones' return is expensed.
- Enum additions cannot be rolled back in Postgres.

## 9. Real verification performed (instructions §12)

Setup: local PostgreSQL 17 on `localhost:5432`. Only the role
`zynoraluxe_phase7_user` and the database `zynoraluxe_phase7_test` exist for
this work. Only `TEST_DATABASE_URL` is in the gitignored `.env`. The app ran
with `next build` + `next start` on port 3100 through the identity-checking
wrapper. The browser was installed Google Chrome 152, driven by
`playwright-core` from a temporary folder outside the repository. All business
data used the `PHASE7TEST` prefix.

### 9.1 Migrations and seeds

- **First acceptance.** `migrate deploy` of all 13 migrations into an empty
  schema. Upgrade of a pre-Phase-7 database with data created by `b472901`:
  3 parties, 9 balanced vouchers, metal and stone movements, finished pieces and
  a sale. Row counts and ledger balances were identical after the upgrade, and
  `migrate status` and `migrate diff` were clean.
- **Final run.** `prisma migrate reset` was refused by Prisma's own safety guard
  for AI agents, and was not bypassed. It changed nothing. Instead:
  - A new empty schema `phase7_empty` received `migrate deploy` of all 13
    migrations ("All migrations have been successfully applied."), then
    "Database schema is up to date!" and "No difference detected.".
  - The main test database was already at the seeded baseline with **no
    business data** (0 vouchers, 0 parties, 0 packets). Its `migrate status`
    and drift check were also clean.
  - `db:seed` and `db:seed-phase7-masters` were each run twice with identical
    counts: users 1, accounts 27 (including 5400), payment accounts 3, GST rates
    6, purities 9, processes 4. Each printed "Phase 7 masters ready: 0 created,
    7 already present".

### 9.2 Pre-Phase-7 upgrade

Covered in §9.1 and §4. There is no new migration since then.

### 9.3 Browser E2E on the final code

Owner desktop 1440×900, Staff desktop, Staff mobile 390×844 and Owner mobile:
68 steps. 67 passed on the first try. One step failed because the test
script's expected value was wrong: it expected packet A at ₹10,100.00, but
packet A's average cost after its Job Manufacturer returns is ₹10,212.58. The
application figure was correct. After the expectation was corrected, the step
passed on re-run; state tracking prevented any duplicate data. There were
**0 console errors, 0 page errors, 0 failed requests, 0 CSP violations and
0 HTTP 5xx**.

| §12 step | What was done in the browser | Result |
|---|---|---|
| 1–2 Polished purchase with Supplier and Dalal/Broker | `ZL-PP-2026-000001`: 2 lines (150 pcs / 15.000 ct), 1% brokerage added to diamond cost. `ZL-PP-2026-000002`: 10 pcs / 1.000 ct, ₹500 brokerage as a business expense | Landed ₹90,900.00 (brokerage ₹900.00); packet A ₹50,500.00, packet B ₹40,400.00. Expensed purchase: landed ₹4,000.00, brokerage ₹500.00 (Dr 5400) |
| Owner adjustment | 1 pc / 0.100 ct out of the 2.50MM packet | 9 pcs · 0.900 ct · ₹3,600.00; Dr 5100 ₹400.00 |
| 3–4 Job Manufacturer issue, partial and final returns | `ZL-PJ-2026-000001`: 40 pcs of A and 50 pcs of B, Polishing ₹100/ct. `PJR-000001` partial; `PJR-000002` closes A only after the explicit tick (0.150 ct loss); final return of B: 30 pcs / 3 ct used in the Jewellery Job + 20 pcs / 1.95 ct back (0.050 ct loss) | Charges ₹880 payable to the Manufacturer; job `COMPLETED`; closed line not offered again |
| 5 Returned stock, merge, provenance | new size on return; `ZL-PJ-2026-000002` cancelled before any return | child packet `ZL-PKT-2026-000005` (`RETURNED_FROM_JOB`, 20 pcs / 1.900 ct, ₹10,290.00); same size back into packet A; cancelled stones back in the child packet |
| 6–10 Jewellery Job, only 24K → 18K/14K/9K, both alloy paths, returned 24K, scrap, loss | `ZL-JJOB-2026-000001`: issued 24K 20 g, Company alloy 5 g, packet A 20 pcs / 2 ct | Outputs 18K 12 g (20 / 2.000 ct), 14K 8 g (30 / 3.000 ct), 9K 6 g. Returned 1.998 g fine, scrap 0.999 g, loss 1.053 g. Alloy 10.054 g = Company 5.000 + Karigar 5.054 (₹500) |
| **Jewellery Job packet lines and Owner-only cost** | Owner job detail after the direct issue, after the Job Manufacturer stones arrived, and after completion | A: `ZL-PKT-2026-000001 · Round · 1.00-1.20MM · VS · F · 20 pcs / 2.000ct · ₹10212.58`. B: `ZL-PKT-2026-000002 · Round · 1.50MM · VS · F · 30 pcs / 3.000ct · from Job Manufacturer · ₹24784.85`. Diamond cost issued ₹10,212.58 → ₹34,997.43; Total manufacturing cost issued ₹1,50,712.58 → ₹1,75,497.43; both lines Set in full. **Staff** (desktop and mobile) see the same codes, pieces and carat, no ₹ figure anywhere on the page, and neither cost label |
| 11 Job cost and finished inventory value | Finished Stock | ₹78,776.55 / ₹60,613.14 / ₹17,439.41, with packet stones counted |
| 12 Phase 6 sale, COGS, **P&L page** | `ZL-FJS-2026-000001`: the 18K piece, ₹2,50,000 credit, CGST+SGST 3% | COGS ₹78,776.55. P&L page: Gross sales ₹2,50,000.00, COGS − ₹78,776.55, Business expenses − ₹400.00, **Brokerage & Commission − ₹500.00 (listed once)**, Net profit ₹1,70,323.45 |
| 13 Cancellation and return paths | sellable return of that sale; `ZL-PP-2026-000003` cancelled; Owner-mobile purchase `ZL-PP-2026-000005` cancelled on mobile | The piece is Available again. P&L page: Sales returns − ₹2,50,000.00, COGS − ₹0.00, **Net profit ₹-900.00**. Cancelled packets are not listed |
| 14 Owner and Staff separately | Staff desktop and mobile | **Accounting › Transactions** lists only Purchase, Sale, Sale Return and Reversal rows (8, then 9 after Staff's purchase), with the Owner-only note. Owner (mobile) still sees Diamond Issue, Diamond Receipt, Jewellery Issue, Jewellery Receipt and Stock Adjustment. No Owner-only controls for Staff; P&L shows "Owner only."; `/settings` and `/costing` redirect to `/unauthorized` |
| Duplicate submit | the same polished purchase form submitted twice at once as Staff on desktop (`ZL-PP-2026-000004`) and as Owner on mobile (`ZL-PP-2026-000005`) | no error shown; exactly 1 purchase and 1 voucher per idempotency key (checked in the database) |
| **Staff cost-leak audit** | every HTML/RSC response of both Staff sessions: every Phase 7 page, both detail pages, Transactions, the Manufacturer, Karigar and Polished Supplier ledgers, and the Purchases, Outstanding and P&L reports | desktop 64 responses / 943,222 bytes; mobile 58 / 841,304 bytes; 33 figures; **0 leaks**. Allowed matches only on Accounting pages, and only for ordinary purchase bill totals: ₹2,000.00, ₹3,000.00, ₹3,50,000.00, ₹90,900.00 |
| 15 Desktop and mobile | Owner and Staff on every page above, both detail pages, both new forms, the P&L page | horizontal overflow **0 px** on every page at 390 px |
| 16 Console, page errors, failed requests, CSP | every step | 0 / 0 / 0 / 0 |

### 9.4 Direct database reconciliation (after the browser run)

A read-only check script and both reconciliation scripts ran on the test
database (both exit 0).

**Profit and Loss page vs ledger (after the return):**

| P&L line | Page | Ledger |
|---|---|---|
| Gross sales (4000) | ₹2,50,000.00 | 250,000.00 |
| Sales returns (4100) | − ₹2,50,000.00 | 250,000.00 |
| Finished jewellery COGS (5200) | − ₹0.00 | 0.00 |
| Damaged jewellery loss (5300) | − ₹0.00 | 0.00 |
| Other purchases (5000) | − ₹0.00 | 0.00 |
| Business expenses (5100) | − ₹400.00 | 400.00 |
| Brokerage & Commission (5400) | − ₹500.00 | 500.00 |
| Net profit | ₹-900.00 | −900.00 = income − every EXPENSE account |

No expense account with a balance is missing from the page. 8000 Round Off is
₹0.00. After the sale, the page's ₹1,70,323.45 equals
250,000 − 78,776.55 − 400 − 500.

| Check | Stock / sub-ledger | General ledger |
|---|---|---|
| Vouchers | 20 checked, 0 unbalanced | — |
| 1220 Polished Diamond Inventory | 7 packets ₹62,728.24 | ₹62,728.24 |
| 1210 Diamond WIP | remaining WIP ₹0.00 | ₹0.00 |
| 1300 Metal Inventory | usable pools ₹2,26,278.89 | ₹2,26,278.89 |
| 1310 Scrap Metal Inventory | scrap pools ₹7,389.44 | ₹7,389.44 |
| 1320 Jewellery WIP | 0 open jobs | ₹0.00 |
| 1330 Finished Jewellery Inventory | 3 available pieces ₹1,56,829.10 | ₹1,56,829.10 |
| 2000 payables by party | Dalal ₹1,400 (900 + 500) · Karigar ₹3,500 (labour 3,000 + alloy 500) · Manufacturer ₹880 · Polished Supplier ₹96,345.67 · Supplier ₹3,52,000 | total ₹4,54,125.67 |
| Jewellery Job packet lines | A 20 pcs / 2.000 ct ₹10,212.58; B 30 pcs / 3.000 ct ₹24,784.85; all set | page shows the same; diamond ₹34,997.43, total ₹1,75,497.43 |
| Voucher visibility | 9 Owner-only (diamond issue/receipt, a diamond-issue reversal, jewellery issue/receipt, stock adjustment) · 11 Staff-visible (purchase, purchase reversals, sale, sale return) | matches the Staff Transactions list |
| Job Manufacturer lines | 3 checked, all closed lines have their audit record | — |

### 9.5 Real concurrent double-submit (engine on Postgres, first acceptance)

A temporary script ran the real posting engine inside real Postgres
transactions, with the server actions' conflict recovery:

- The same purchase submitted 5 times at once gave 1 purchase and 1 voucher.
- Two issues racing for 8 of the same packet's 10 pieces: one was issued, the
  other refused with "Only 2 piece(s) available.".
- The same issue submitted 5 times at once gave 1 job.

All vouchers balanced. The final run added the browser double-submits in §9.3.

### 9.6 Cleanup and baseline proof

`cleanup.js` (temporary, outside the repository) worked like this:

1. It checked the database identity.
2. It proved 0 non-`PHASE7TEST` parties, 0 non-test users and 0 rows created by
   anyone else.
3. It printed a dry run.
4. It deleted everything in one transaction, which rolls back unless the
   baseline matches exactly.

Final run deletions: rows in 28 tables (including 20 vouchers, 59 journal
entries, 7 packets, 3 finished pieces and 6 parties), the Staff test user and
the `phase7_empty` schema (54 tables).

After cleanup:

- users 1 (the test Owner), accounts 27, payment accounts 3, GST rates 6,
  purities 9, processes 4, migrations 13, and all 47 other tables empty
- `migrate status` "up to date"
- both reconciliation scripts match at ₹0.00

Temporary files were deleted: the test-only secrets file, the E2E packages and
the scratch copies. No temporary file was committed.

## 10. Changed files and repository state

Base `b472901` → branch `phase-7-polished-metal-process`.

Commits: `95c05cf`, `336a08a`, `833be66`, `e3f001c`, `6611961`, `fbd5cbf`,
`7271a6e`, `a674556`, `2da3038`, `7ee879b`, `5f7ed1d`, and the final
acceptance documentation commit that updates this report and the README.

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
M  src/app/(app)/accounting/page.tsx
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
M  src/components/accounting/ReportsView.test.tsx
M  src/components/accounting/ReportsView.tsx
A  src/components/accounting/TransactionsTab.test.tsx
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
A  src/components/jewellery/JobDetailView.test.tsx
M  src/components/jewellery/JobDetailView.tsx
M  src/components/jewellery/JobsTab.tsx
M  src/components/jewellery/MetalStockTab.tsx
M  src/components/jewellery/OverrideAllocationForm.tsx
M  src/components/jewellery/ReceiveFinishedForm.tsx
A  src/components/settings/DiamondProcessSettingsPanel.tsx
M  src/components/settings/MetalPuritySettingsPanel.tsx
M  src/lib/accounting/accounts.ts
M  src/lib/accounting/numbering.ts
M  src/lib/accounting/reports.test.ts
M  src/lib/accounting/reports.ts
A  src/lib/accounting/voucherVisibility.test.ts
A  src/lib/accounting/voucherVisibility.ts
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
A  src/lib/jewellery/jobDetailSerializers.test.ts
A  src/lib/jewellery/jobDetailSerializers.ts
A  src/lib/jewellery/jobIssuedCost.ts
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

The test database `zynoraluxe_phase7_test` and its role are kept at the seeded
baseline for future verification. `.env` gained only `TEST_DATABASE_URL`.

Not pushed, not merged, not tagged, not deployed.
