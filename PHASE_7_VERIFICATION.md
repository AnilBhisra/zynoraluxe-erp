# Phase 7 Verification Report

Branch `phase-7-polished-metal-process`, based on `b472901`.
Specification: `../ZYNORALUXE_PHASE_7_CLAUDE_MASTER_INSTRUCTIONS.md`.
Audit: `PHASE_7_CURRENT_STATE_AUDIT.md`. Design: `PHASE_7_IMPROVEMENT_PLAN.md`.

## 1. Result

**Phase 7 is NOT accepted yet.** The code for every tier (P0 metal, P1 polished
purchase and packets, P2 Manufacturer / Job Manufacturer, P3 documents) is
written, committed, and passes every automated check that can run without a
database. The checks the instructions require against a **real test database
and a real Chromium browser** (§12) have **not been run**, because there is
still no isolated test database:

> **Blocker:** `TEST_DATABASE_URL` is not present in `.env`. The only configured
> database (`DATABASE_URL`) is production. By Owner decision and the
> instructions' data-safety rules, nothing in this pass connected to it —
> no migration, seed, `prisma migrate status`, reconciliation script,
> browser session or `rateLimit.test.ts` run.

What that leaves unproven until a test database exists: the four migrations
applying to an empty and to a pre-Phase-7 database, the hand-written CHECK
constraints under real data, seed idempotency, the two reconciliation scripts
on real rows, Owner/Staff desktop/mobile browser E2E, real concurrent
double-submits, and temporary-data cleanup proof.

| Acceptance check (§13) | Result |
|---|---|
| `prisma validate` | ✅ valid |
| `prisma migrate status` | ⛔ **Not run** — would query the production database |
| TypeScript (`tsc --noEmit`) | ✅ exit 0 |
| ESLint (`eslint . --max-warnings=0`) | ✅ exit 0 |
| Full Vitest suite | ✅ **53 files / 704 tests passed** (excluding `rateLimit.test.ts`, see §3) |
| Production `next build` (from a clean `.next`) | ✅ exit 0 |
| Client-bundle secret scan | ✅ 38 static files, 9 secret-shaped `.env` values and 5 secret variable names: 0 hits |
| Tracked/changed-file secret scan | ✅ Phase 7 diff: 0 hits for env values and credential patterns. Whole tree: only the two storage **bucket names** (non-secret defaults already in `.env.example` and pre-Phase-7 code) |
| Database schema migration review | ✅ By reading and grep (§4). ⛔ Not applied to any database |
| Real browser E2E | ⛔ **Not run** — blocked |
| Direct database reconciliation | ⛔ **Not run** — scripts written and typechecked, blocked |
| `git diff --check` | ✅ clean for the whole branch |
| Final `git status --short` | ✅ clean after the final commit (§10) |

State of the changes: **committed** on the branch (6 commits, §10).
**Not pushed, not merged, not tagged, not deployed.**

## 2. What Phase 7 changed

| Tier | Commit | Summary |
|---|---|---|
| P0 | `95c05cf` | Metal stock read fixes (`CONSUMED_OUT` informational, separate scrap pool), 24K → 18K/14K/9K outputs, Company Copper/Alloy stock, Karigar-added and included alloy, exact thousandths math, Staff cost redaction on `/diamond` and `/jewellery-jobs`, metal reconciliation script, create-only Phase 7 masters script |
| P1 | `336a08a` | Direct Polished Diamond Purchase with `Party / Supplier` and `Dalal / Broker`, packet stock with an immutable ledger and merge key, packets in Jewellery Jobs (issue, set/returned/damaged, cancellation), guard on generic voucher cancel |
| P2 | `833be66` | Manufacturer process master (`4P / Laser`, `HPHT / Grow`, `Polishing`, `Rough Polish`), process + charge on Diamond Jobs, processed-rough returns, Job Manufacturer packet jobs (size-wise issue, partial/final returns, used in Jewellery Job, damaged/lost, charges, cancellation), packet row lock, Settings process panel |
| P2 | `e3f001c` | CSV exports, Accounting purchase chooser, Phase 7 DTO serializers with Staff-redaction tests, legacy job label, diamond reconciliation script |
| P2 | `6611961` | Owner packet count adjustments posting their own `STOCK_ADJUSTMENT` voucher |
| P3 | final commit | README, both Gujarati guides, in-app Gujarati help, master plan Scope History (append-only), this report, concurrency action tests |

The UI keeps the existing navigation. The Diamond page's sections are now
`Rough Diamond`, `Manufacturer`, `Job Manufacturer` and `Polished Diamond`
(old `?tab=rough|jobs|polished` links still work).

## 3. Tests before and after

| | Files | Tests run | Not run |
|---|---|---|---|
| Before Phase 7 (audit baseline) | 43 (+1 not run) | 590 | 19 in `src/lib/auth/rateLimit.test.ts` |
| After Phase 7 | 53 (+1 not run) | **704** | the same 19 |

`rateLimit.test.ts` connects to `DATABASE_URL` and wipes `login_rate_limits`
around each test, so it cannot run against the production database. It is
unchanged by Phase 7.

No existing test was deleted or weakened: `git diff --numstat b472901..HEAD`
over every `*.test.ts(x)` file shows additions only. The 114 new tests are in
10 new files plus additions to 4 existing action/help test files:

| File | Tests | Covers |
|---|---|---|
| `src/lib/jewellery/metalMath.test.ts` | 13 | thousandths parsing and rounding, fine/gross, locked 18K example at 100% and 99.9%, 14K/9K, pool effects |
| `src/lib/jewellery/phase7MetalPosting.test.ts` | 21 | both metal defects inverted into regressions, 24K → 18K/14K/9K across partial and final receipts, snapshots, alloy paths, abnormal loss, idempotency key |
| `src/lib/diamond/polishedPurchase.test.ts` | 15 | credit, paid now, GST, multi-line allocation, all brokerage methods and treatments, no double posting, broker required, cancellation |
| `src/lib/diamond/packets.test.ts` | 8 | exact ledger balance, merge-key grouping, provenance never mixed |
| `src/lib/jewellery/phase7PacketJob.test.ts` | 14 | packet issue, row-lock status re-check, set/returned/damaged, pending never auto-loss, completion gating, cancellation, COGS chain |
| `src/lib/diamond/processCharge.test.ts` | 5 | per carat, per piece, fixed-on-final, rounding |
| `src/lib/diamond/phase7Manufacturer.test.ts` | 8 | process snapshot, processed rough, partial return, fixed charge, rate mismatch refused, wrong receive path refused, voucher amount |
| `src/lib/diamond/packetProcess.test.ts` | 9 | Job Manufacturer issue, cancel, partial/final returns, child packet on size change, pieces must be accounted for, per-line close, damaged + abnormal loss, used in Jewellery Job and its cancellation |
| `src/lib/diamond/phase7Serializers.test.ts` | 3 | no cost/brokerage/WIP/charge value in any Staff DTO |
| `src/lib/diamond/packetAdjustment.test.ts` | 4 | adjustment out/in with accounting, stranded residue refused, cancelled packet refused |
| action tests (`diamond`, `jewellery`, `vouchers`) | 14 | Owner/Staff enforcement for every new Owner-only action, Staff damaged/lost and abnormal loss refused, idempotent resubmission, concurrent duplicate (unique-key conflict) recovery, generic voucher cancel guards |

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
| Idempotent actions and concurrent duplicate submission | action tests (pre-check and unique-key conflict recovery). **Real concurrent requests against Postgres are not yet proven** (blocked) |

## 4. New migrations

| Migration | Contents |
|---|---|
| `20260915120000_phase7a_metal_alloy_cross_purity` | `MetalType` + `ALLOY`; defaulted alloy/snapshot columns on jobs, issue lines, receipts and finished outputs |
| `20260916090000_phase7b_polished_purchase_packets` | `PartyType` + `BROKER`, `MANUFACTURER`; sequence types; 6 enums; 6 tables (purchases, lines, packets, packet movements, jewellery packet issue lines and resolutions); CHECK constraints on the new tables |
| `20260917090000_phase7c_manufacturer_processes` | 4 enums; `diamond_processes`, `packet_process_jobs`, `…_job_lines`, `…_receipts`, `…_receipt_lines`; nullable process/charge columns on `diamond_jobs`; CHECK constraints |
| `20260918090000_phase7d_stock_adjustment_voucher` | `VoucherType` + `STOCK_ADJUSTMENT` |

Review evidence (read and grep, not a database apply):

- No `DROP`, `TRUNCATE`, `DELETE`, `UPDATE`, `ALTER COLUMN` or `RENAME` outside
  foreign-key `ON DELETE / ON UPDATE` clauses.
- All 26 `ADD COLUMN` statements are nullable or have a `DEFAULT`, so the
  upgrade cannot fail on tables that already hold rows.
- Every CHECK constraint is on a new table, or (`diamond_jobs_charge_rate_chk`)
  on a new nullable column that existing rows leave `NULL`.
- No migration uses an enum value it adds (safe inside Prisma's per-migration
  transaction on PostgreSQL 12+).
- Each SQL file was generated with `prisma migrate diff --from-schema
  <previous schema> --to-schema prisma/schema.prisma --script` and reviewed;
  for `phase7d` the generated diff is byte-identical to the committed file.
- Postgres cannot remove enum values — the one irreversible part.

**Not yet proven:** `migrate deploy` from empty and on top of the eight
pre-Phase-7 migrations with data; `migrate status`.

## 5. Accounting entries implemented

Every event is one transaction with its stock movements, and every voucher is
checked for exact debit = credit in the tests.

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

The instructions' locked example reconciles exactly in
`phase7MetalPosting.test.ts`: 10.000 g 24K (100%) → 12.000 g 18K = 9.000 g fine +
3.000 g alloy + 1.000 g Process Loss; with the seeded 99.9% 24K: 9.990 g fine
issued, 2.991 g alloy, 0.990 g loss.

## 6. Permissions and data security

| Action | Owner | Staff | Enforced by |
|---|---|---|---|
| Polished purchase create; Job Manufacturer issue/return; rough for a process; processed-rough receipt; packet issue/resolve on Jewellery Jobs | ✅ | ✅ | `requireUser()` |
| Cancel polished purchase / Job Manufacturer job; packet count adjustment; process master | ✅ | ❌ | `requireOwner()` |
| Damaged/lost (stones, packets, Job Manufacturer returns), abnormal loss | ✅ | ❌ | role check in the action before the engine runs |
| Generic "Cancel voucher" on polished purchase or `STOCK_ADJUSTMENT` vouchers | ❌ | ❌ | `cancelVoucherAction` guard |

Staff cost data: every cost, landed cost, brokerage amount, WIP, charge rate
and charge on `/diamond`, `/jewellery-jobs` and Metal Stock is passed through
`ownerOnly()` on the server, so the Staff RSC payload carries `null`.
`phase7Serializers.test.ts` serialises every Phase 7 Staff DTO and searches the
JSON for each secret value. Staff CSV exports omit cost columns. The in-app help
test still proves Staff help contains no Owner-only terms.
**Not yet proven:** a real Staff browser network-payload audit (blocked).

## 7. Bugs found and fixed

| # | Found | Bug | Fix | Regression test |
|---|---|---|---|---|
| 1 | Audit §4.9 | `CONSUMED_OUT` deducted issued metal a second time, draining pools and under-costing later issues | informational effect in `METAL_POOL_EFFECT` | `phase7MetalPosting.test.ts`, `metalMath.test.ts` |
| 2 | Audit §4.10 | Scrap re-entered issuable stock while its cost stayed in 1310 | separate scrap pool | same |
| 3 | Audit §4.12 | 24K issue → 18K receipt impossible (root cause shared with #1) | output purity as attribute, consumption against the issued source | same |
| 4 | Audit §4.16 | Staff RSC payloads on `/diamond` and `/jewellery-jobs` carried cost figures | server-side `ownerOnly()` DTOs | `phase7Serializers.test.ts` (Phase 7 views) |
| 5 | Audit §4.18 | Issuing materials overwrote the job's create-time idempotency key | key kept | `phase7MetalPosting.test.ts` |
| 6 | P0 | No-output final receipt with abnormal loss produced an unbalanced voucher | cost split to returned/scrap or expensed | same |
| 7 | P0 | A receipt that only returned a diamond posted a zero voucher amount (the database requires > 0) | amount = total debit | same |
| 8 | P2 | Polished receipt voucher amount left out returned rough cost | amount = full debit | `phase7Manufacturer.test.ts` |
| 9 | P2 | The production-safe `db:seed-phase7-masters` did not create the 5400 account that brokerage posts to | shared create-only `prisma/phase7Masters.ts` | — (seed; DB proof blocked) |
| 10 | P2 | Packet issues read the ledger without a row lock (concurrent over-issue possible) | `lockPacketInTx` before every ledger read | status re-check test; real concurrency blocked |
| 11 | P2 | Cancelling a Jewellery Job would return Job Manufacturer-sourced stones to stock without reversing their 1320 cost | explicit Dr 1220 / Cr 1320 on cancel | `packetProcess.test.ts` |
| 12 | Docs | README and master plan still said Phase 6 was uncommitted | README corrected; master plan note appended | — |

Test-infrastructure issue fixed along the way: two fixture layers generated
colliding row ids for seeded packets, which could hide a packet's purchase
movement.

## 8. Known limitations

- Real-database and browser verification pending (§1, §9).
- Past postings are reported, not rewritten (Owner decision); the metal
  reconciliation script shows the difference.
- The Phase 4 metal adjustment still posts stock only, without a voucher
  (unchanged). Phase 7 packet adjustments post their accounting.
- A Jewellery Job return of packet stones re-enters its original packet; size
  changes are recorded only on Job Manufacturer returns.
- "Used in Jewellery Job" is refused when that job already holds stones from
  the same packet (two cost layers are never averaged into one line).
- Job Manufacturer cancellation only before the first return.
- A Job Manufacturer line closes when all its pieces are back, recognising its
  carat gap as loss even while other lines stay pending (pending pieces are
  never loss). Plan §8.4 described loss only at job close; this refinement is
  recorded in the README.
- Enum additions cannot be rolled back in Postgres.

## 9. Real verification still to run (instructions §12)

Prerequisite: an isolated local PostgreSQL 17 database, added by the Owner as
`TEST_DATABASE_URL` in `.env` (never the production `DATABASE_URL`). Every
command below must be pointed at that database only.

1. `migrate deploy` on an empty database → `db:seed` → `db:seed-phase7-masters`
   twice, comparing row counts (idempotency proof).
2. A database holding the eight pre-Phase-7 migrations plus representative
   data → apply the four Phase 7 migrations → `migrate status`.
3. `next build` + `next start`; a real Chromium session using only
   `PHASE7TEST`-prefixed data, Owner and Staff, desktop 1440×900 and mobile
   390×844, capturing console errors, page errors, failed requests and CSP
   violations, and grepping Staff network payloads for cost fields.
4. The §12 business flow: polished purchase with Supplier and Dalal/Broker →
   accounting, payables, Polished Diamond stock → Job Manufacturer issue →
   partial and final returns with size/pieces/carat → returned stock and
   provenance → Jewellery Job with only 24K → 18K, 14K and 9K outputs → Company
   and Karigar-added alloy → returned 24K, scrap, Process Loss → job cost and
   finished inventory value → Phase 6 sale, COGS and P&L → cancellation and
   return paths.
5. `db:phase7-metal-reconciliation` and `db:phase7-diamond-reconciliation`
   (both read-only; the diamond script exits non-zero on any mismatch), plus
   AP by party and 1300/1310/1320/1330 tie-outs.
6. A real concurrent double-submit against one packet and one idempotency key.
7. `rateLimit.test.ts` against the test database.
8. Cleanup of `PHASE7TEST` rows only, in foreign-key order, dry run first,
   with before/after baseline counts; temporary scripts and packages removed.

## 10. Changed files and repository state

Base `b472901` → branch `phase-7-polished-metal-process`.

Commits: `95c05cf`, `336a08a`, `833be66`, `e3f001c`, `6611961`, and the final
documentation commit that adds this report.

```text
M  EMPLOYEE_USER_MANUAL_GUJARATI.md
A  PHASE_7_CURRENT_STATE_AUDIT.md
A  PHASE_7_IMPROVEMENT_PLAN.md
M  README.md
M  USER_REVIEW_GUIDE_GUJARATI.md
M  package.json
A  prisma/migrations/20260915120000_phase7a_metal_alloy_cross_purity/migration.sql
A  prisma/migrations/20260916090000_phase7b_polished_purchase_packets/migration.sql
A  prisma/migrations/20260917090000_phase7c_manufacturer_processes/migration.sql
A  prisma/migrations/20260918090000_phase7d_stock_adjustment_voucher/migration.sql
A  prisma/phase7Masters.ts
M  prisma/schema.prisma
M  prisma/seed.ts
A  scripts/phase7DiamondReconciliation.ts
A  scripts/phase7MetalStockReconciliation.ts
A  scripts/seedPhase7Masters.ts
M  src/app/(app)/diamond/page.tsx
M  src/app/(app)/jewellery-jobs/page.tsx
M  src/app/(app)/settings/page.tsx
M  src/app/actions/diamond.test.ts
M  src/app/actions/diamond.ts
M  src/app/actions/jewellery.test.ts
M  src/app/actions/jewellery.ts
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
A  PHASE_7_VERIFICATION.md
```

Outside the repository: `../ZYNORALUXE_JEWELLERY_ERP_MASTER_PLAN.md`
(Section 13 appended; the original 591 lines are byte-identical).

Temporary data: none was created in any database. Temporary patch scripts
lived only in the session scratchpad; a few written early in the session to the
Git Bash root directory by mistake were deleted there.

Not pushed, not merged, not tagged, not deployed.
