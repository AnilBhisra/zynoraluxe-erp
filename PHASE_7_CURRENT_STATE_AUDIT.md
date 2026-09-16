# ZYNORALUXE ERP — Phase 7 Current-State Audit

Audit date: 2026-09-15. Scope: everything Phase 7 touches — purchases,
parties, Rough/Polished Diamond, Jewellery material issue/return, metal
purity and stock semantics, cost allocation and postings, Karigar
relationships, finished-output purity, Phase 6 repository state, and the
known limitations carried by every earlier verification report.

Every claim below was checked against the **current working tree**
(`main` @ `b472901`), not copied from an earlier report. Where an earlier
report and the code disagree, the code wins and the disagreement is called
out.

## 0. Status legend

| Label | Meaning |
|---|---|
| **VERIFIED** | Implemented, and proven in this pass by an automated test run or a direct code trace with a reproducing test |
| **IMPLEMENTED — NOT RE-VERIFIED** | Code exists and matches an earlier report, but this pass could not re-prove it live (no test database — see §2.3) |
| **PARTIAL** | Some of the requirement exists; material parts are missing |
| **MISSING** | Nothing in the code implements it |
| **DOCUMENTED ONLY** | A report/README claims it, but the code does not match |
| **DEFECT** | Implemented, but proven wrong in this pass |
| **BLOCKED — DECISION** | Cannot be built correctly until the Owner decides something |

---

## 1. Repository and Phase 6 state

| Item | Finding | Evidence |
|---|---|---|
| Current branch | `main` | `git branch --show-current` |
| HEAD | `b472901daa83e4414e1a694ed9e6a0e9d24e7ec1` — "feat: allow Owner to reset staff password directly from Settings" | `git rev-parse HEAD` |
| Working tree at start | Clean — no modified, staged or untracked files | `git status --short` (empty) |
| Remote | `origin` = `github.com/AnilBhisra/zynoraluxe-erp`; `main` is 0 ahead / 0 behind `origin/main` | `git rev-list --left-right --count origin/main...HEAD` → `0 0` |
| Tags | None | `git tag -l` (empty) |
| Commit graph | `19493fd` P1 → `0d998a8` P2 → `5b1a17b` P3 → `548a44b` P4 → `e1a292e` P5 → `5912ddb` V1 acceptance → `8d6df2c` **P6** → `2542812` Vercel prep → `b472901` staff password reset | `git log --graph --oneline --all` |
| **Phase 6 committed?** | **Yes.** Committed as `8d6df2c` (branch `phase-6-finished-sales`), merged into `main`, **pushed** to `origin/main`. Not tagged. | branch list + ahead/behind check |
| Phase 6 deployed? | Unknown. Commit `2542812` prepared Vercel deployment; nothing in the repo proves a live deployment exists. The harness treats the configured database as **production** (§2.3). | commit message; permission denial |
| Stale documentation | `PHASE_6_VERIFICATION.md` (header + closing line), `README.md` (intro + "What's deliberately not built yet") and the master plan's §13 Scope History all still say Phase 6 is "not committed / not merged". **That is no longer true.** | those files vs. git |
| Migrations on disk | 8: `init`, `phase2_accounting`, `phase3_diamond_manufacturing`, `phase4_jewellery_jobs`, `phase5_costing`, `phase5_costing_charge_line_is_labour`, `v1_login_rate_limiting`, `phase6_finished_jewellery_sales` | `prisma/migrations/` |
| Migrations applied to a database | **Not verified in this pass.** `prisma migrate status` needs a connection to the only configured database, which is production — see §2.3. | — |
| Destructive SQL in existing migrations | None. Only `CHECK` constraints were hand-added (Phase 2). No `DROP`/`TRUNCATE`/`DELETE`/`ALTER COLUMN`. | `grep` over `prisma/migrations` |

**Conclusion:** the "Phase 6 exists only as uncommitted working-tree
changes" blocker in the Phase 7 instructions (§2) **does not apply**.
Phase 7 can branch from `b472901` (which contains Phase 6 plus two small
follow-up commits).

---

## 2. Verification baseline

### 2.1 Automated checks (run in this pass)

| Check | Result |
|---|---|
| `prisma validate` | ✅ Schema valid |
| `tsc --noEmit` | ✅ 0 errors |
| `eslint` | ✅ 0 errors, 0 warnings |
| `vitest run` (excluding `src/lib/auth/rateLimit.test.ts`) | ✅ **43 files / 590 tests** pre-existing, all passing (run showed 44/592 including this audit's own 2-then-3-test evidence file) |
| `src/lib/auth/rateLimit.test.ts` | ⚠️ **Not run** — 19 tests that connect to `DATABASE_URL` and wipe the `login_rate_limits` table before/after each test. Running them against the production database would delete real rate-limit state. |
| Pre-existing total test count | **609** (590 run + 19 not run), 44 files |
| `next build` | ✅ Succeeds; 11 routes (`/`, `/_not-found`, `/accounting`, `/costing`, `/dashboard`, `/diamond`, `/help`, `/jewellery-jobs`, `/login`, `/settings`, `/unauthorized`) + Proxy |
| `prisma migrate status` | ⚠️ Not run — production connection (§2.3) |

### 2.2 Audit evidence tests added in this pass

`src/lib/jewellery/phase7AuditBaseline.test.ts` — three tests against the
real `posting.ts` code via the existing in-memory fake transaction client.
They assert **current** behaviour (they pass because the defects exist):

1. `CONSUMED_OUT subtracts fine weight and cost a SECOND time …` (§4.9)
2. `SCRAP_RETURN_IN re-enters the issuable purity pool …` (§4.10)
3. `rejects an 18K finished output from a 24K-only issue …` (§4.12)

These will be inverted into regression tests when the defects are fixed.

### 2.3 Database availability — a genuine blocker for live verification

- `.env` configures exactly one database: a Supabase pooled URL
  (`aws-0-ap-northeast-2.pooler.supabase.com:6543`) plus its direct URL.
  Every earlier phase verified against this same database.
- A read-only row-count query against it was **refused by the execution
  harness as a production read**. It must therefore be treated as
  production with potentially real business data.
- A local PostgreSQL 17 service is running on `localhost:5432`, but it
  requires a password that is not available in this session.
- Consequences until the Owner decides (see Improvement Plan §0):
  no `migrate deploy`/`migrate status`, no seed run, no real-database or
  real-browser E2E, and `rateLimit.test.ts` cannot run.

---

## 3. Seed and master-data findings

| Finding | Evidence | Risk |
|---|---|---|
| Starter purities: Gold 10K 41.7%, **14K 58.5%**, 18K 75.0%, 22K 91.6%, **24K 99.9%**, Silver 925 92.5%, Platinum 950 95.0% | `prisma/seed.ts:84-92` | — |
| **No 9K purity** exists | same | Phase 7 requirement unmet |
| **24K is seeded at 99.9%, not 100%.** The locked Phase 7 example ("10.000 g of 24K = 10.000 g fine") only holds at 100%. At 99.9% the same issue is 9.990 g fine. | `seed.ts:89` vs Phase 7 instructions §6.8 | **BLOCKED — DECISION** (§8) |
| Re-running the seed **overwrites** `finenessPercent` on every starter purity (`upsert … update: { finenessPercent }`) — an Owner edit to 24K would be silently reverted | `seed.ts:155-165` | High on a live DB |
| Re-running the seed **overwrites the Owner's `passwordHash`, `name`, `role` and `isActive`** from `.env` | `seed.ts:193-197` | High on a live DB — resets the real Owner password to whatever `.env` holds |
| Re-running the seed overwrites starter GST `ratePercent` | `seed.ts:137-149` | Medium |
| `MetalType` enum is `GOLD/SILVER/PLATINUM/OTHER` — no Copper/Alloy type | `schema.prisma:919-924` | Phase 7 alloy stock needs a type |

The existing seed is idempotent in **row count** but not safe to re-run
against a database whose masters have been edited. Phase 7 master additions
must not rely on re-running the whole seed there.

---

## 4. Evidence table

| # | Requirement | Current implementation | File / model / action evidence | Verified by | Gap | Risk | Status |
|---|---|---|---|---|---|---|---|
| 4.1 | Purchase architecture | Three posting paths share `VoucherType.PURCHASE`: plain Accounting Purchase (Dr 5000 Purchases), Rough Purchase (Dr 1200), Metal Purchase (Dr 1300). Input GST on authoritative landed cost; optional immediate payment in the same voucher; per-model `idempotencyKey`. | `accounting/posting.ts:285-343`; `diamond/posting.ts:50-235`; `jewellery/posting.ts:111-263` | Existing suites pass (§2.1) | No Polished Diamond purchase. No Dalal/Broker. No Copper/Alloy purchase. | High — core Phase 7 scope | PARTIAL |
| 4.2 | Purchase cancellation safety | Generic cancel blocks a Rough Purchase once any piece is `costLocked`, and a Metal Purchase once any later outflow of that purity exists. | `actions/vouchers.ts:496-535` | `vouchers.test.ts` (passing) | New purchase types need equivalent guards | Medium | VERIFIED |
| 4.3 | Party types | `CUSTOMER`, `SUPPLIER`, `KARIGAR` only. AP/AR sub-ledger is `JournalEntry.partyId` on 2000/1100 — no balance column. | `schema.prisma:134-138`; `validation/parties.ts:10` | `parties.test.ts` | No Dalal/Broker, no Manufacturer type. Diamond and Jewellery jobs both pick parties of type `KARIGAR`. | High | PARTIAL |
| 4.4 | Rough Diamond models and jobs | `RoughLot` → `RoughPiece` (issued whole, never split). `DiamondJob` = one "Cutting-Polishing" issue to a Karigar, partial receipts, gap-based loss recognition, WIP drains to exactly 0. | `schema.prisma:561-776`; `diamond/posting.ts:241-753` | `diamond/posting.test.ts` (26 tests) | No process concept (4P/Laser, HPHT/Grow, Polishing, Rough Polish). No "Manufacturer" / "Job Manufacturer" sections. No size breakdown. Labour is a flat receipt amount — no rate basis. Receipts cannot be reversed. | High | PARTIAL |
| 4.5 | Returned-rough provenance | Leftover rough is created with `returnedFromJobId` and `returnedFromReceiptId` set (`lotId` null by design). | `diamond/posting.ts:695-721` | Code trace | **`PHASE_6_VERIFICATION.md` §21 and README "Known Phase 6 limitations" say these fields are missing — the code contradicts that.** Separate real gap: Rough Stock lists by lot, so lot-less leftover pieces never appear there (`listRoughLots` also hard-codes `returnedFromJobCode: null`), though they do appear in the Issue Rough picker and the dashboard total. | Low (visibility) | DOCUMENTED ONLY (claim) / PARTIAL (UI) |
| 4.6 | Polished Diamond creation and stock | Created **only** by `receivePolishedDiamonds`. One row = one stone. `receiptId` and `jobId` are **NOT NULL**. No pieces count, no provenance column, no packet/batch identity, no size-range field, no quality/lab split beyond `color/clarity/cutGrade/certLab`. | `schema.prisma:778-838`; `diamond/posting.ts:627-674` | `diamond/posting.test.ts` | A purchased stone cannot be stored without inventing a fake receipt/job (forbidden). Bulk melee packets (hundreds of pieces, size-wise) cannot be represented. `listPolishedDiamonds` dereferences `o.job.jobCode`; Costing sourcing reads `polishedDiamond.polishedCode/shape`. | High — model change unavoidable | PARTIAL |
| 4.7 | Jewellery material issue / return | One-time issue per job: metal lines at weighted-average cost per purity, individually-costed polished diamonds (`costAtIssue`), display-only "other material". Return/scrap lines must name an issued purity; per-purity pending comes from the movement ledger. Diamonds end in exactly one of `SET` / `RETURNED` / `DAMAGED_LOST`. | `jewellery/posting.ts:427-670, 852-1010` | `jewellery/posting.test.ts` (69 tests) | Only individual stones can be issued — no packet issue. | Medium | VERIFIED |
| 4.8 | Metal purity / fineness logic | `fine = gross × fineness ÷ 100`, 3dp half-up. Fineness snapshotted on purchase, issue line and finished output. Output fine weight uses the job's issue-time snapshot. | `jewellery/posting.ts:147-148, 488-489, 940-948` | `posting.test.ts:2194` "keeps a metal issue line's fineness snapshot…" | 9K missing; 24K at 99.9% (§3). | Medium | VERIFIED (+ BLOCKED — DECISION for 24K) |
| 4.9 | **Metal stock movement semantics — `CONSUMED_OUT`** | `ISSUE_OUT` already removes issued metal (gross, fine, cost) from the purity pool. On receipt, `CONSUMED_OUT` rows (gross `0.000`, fine > 0, cost > 0) are written and **both balance readers count them as outflows again**. | `jewellery/posting.ts:43` and `jewellery/reports.ts:31` (`OUT_TYPES` include `CONSUMED_OUT`); rows written at `posting.ts:1448-1497` | **`phase7AuditBaseline.test.ts` test 1:** purchase 20 g 22K / ₹1,00,000 → issue 10 g → receive 10 g (complete). Pool shows **gross 10.000 g, fine 0.000 g, cost ₹0.00** while ledger 1300 still carries ₹50,000; the next 10 g issue is **rejected** ("stock-tracked material…"). | Stock cost and fine weight diverge from the ledger after every receipt. Later issues are under-costed (partial drain) or rejected (full drain); after replenishment the weighted average is diluted by zero-cost phantom grams. The existing zero-balance test (`posting.test.ts:407`) never records a receipt, so it could not catch this. The one-time failure in `PHASE_6_VERIFICATION.md` §15 had the same error text — a plausible, **unproven** cause. | **Critical** — metal cost integrity | **DEFECT** |
| 4.10 | **Scrap stock separation** | `SCRAP_RETURN_IN` is written to the **same** metal+purity pool as purchased metal, so scrap gross becomes ordinary issuable stock. The receipt debits **1310** Scrap Metal Inventory, but every later issue credits only **1300** Metal Inventory. | `posting.ts:1423-1439` (movement), `1170-1176` (Dr 1310), `560-577` (issue credits 1300 only) | **`phase7AuditBaseline.test.ts` test 2:** 1 g scrap → 1310 = ₹5,555.56; pool gross becomes 11.000 g; issuing all 11 g credits only 1300; **1310 still shows ₹5,555.56 with no physical scrap left anywhere.** | 1310 never relieved; 1300 over-credited. Stock ledger and GL cannot reconcile once scrap is reissued. | **Critical** | **DEFECT** |
| 4.11 | Cost allocation and journal postings | Every posting is one `prisma.$transaction`; `insertBalancedJournalLines` requires exact Decimal debit = credit. Receipt drains the metal WIP pool by fine-weight ratio (final receipt takes the full remainder); normal loss absorbed; abnormal loss → 5100; returned metal Dr 1300; scrap Dr 1310; diamonds at exact `costAtIssue`; charges + Karigar-added cost → AP 2000 (Karigar). | `accounting/posting.ts:45-98`; `jewellery/posting.ts:1038-1209`; `diamond/posting.ts:532-605` | Existing suites (§2.1) | Correct at voucher level; the stock-side defects in 4.9/4.10 break stock-vs-GL reconciliation. No brokerage or process-charge postings exist. | High | VERIFIED (voucher balance) / DEFECT (stock tie-out) |
| 4.12 | Finished output purity validation | Output purity **must be one of the job's issued purities**; otherwise `PostingError`. Added after an unrestricted version drove an unrelated 10K pool negative (Phase 4 report). | `jewellery/posting.ts:931-947` | `posting.test.ts:1800`; **`phase7AuditBaseline.test.ts` test 3** (24K issue → 18K output rejected; zero 18K movements) | The locked flow "issue 24K, receive 18K/14K/9K" is **impossible**. The restriction exists only because `CONSUMED_OUT` is posted against the output's purity — the root cause is the same modelling error as 4.9. | **Critical** for Phase 7 | VERIFIED (blocks requirement) |
| 4.13 | Alloy / Karigar-added material | Receipt accepts `karigarAddedFineWeight` (grams of **fine** metal) and `karigarAddedCost`: fine adds to pending; cost is Dr WIP / Cr AP (Karigar), once per receipt. UI label: "Karigar-added fine metal (g)". | `jewellery/posting.ts:1012-1016, 1148-1154, 1199-1207`; `ReceiveFinishedForm.tsx:653-654` | `posting.test.ts` (charges tests) | Copper/alloy has 0% gold fineness, so this fine-weight field cannot represent alloy. No Company-owned alloy stock. "Alloy" is only a display-only other-material example. No alloy-source choice. | High | PARTIAL |
| 4.14 | "Other material" | Display-only job-costing figure; never a movement or journal line; re-allocated across all outputs by fine weight on each new receipt. Authoritative inventory/COGS = `metalCost + diamondCost + labourAllocated`. | `jewellery/posting.ts:522-529, 1073-1105`; `schema.prisma:1333-1352` | `posting.test.ts:1412, 2120`; Phase 6 suites | Must stay distinct from any new real alloy stock. | Medium | VERIFIED |
| 4.15 | Existing Manufacturer / Karigar relationships | Both Diamond and Jewellery jobs use `Party.type = KARIGAR`. Material balance comes from job/movement state; money balance is AP 2000 by party. | `diamond/reports.ts:345-380`; `jewellery/reports.ts:463-487` | `diamond/reports.test.ts`, `jewellery/reports.test.ts` | No Manufacturer/Job Manufacturer role, no process, no process payable basis. | Medium | PARTIAL |
| 4.16 | Owner-only cost visibility (server side) | Phase 6 Finished Stock uses a different Prisma `select` for Staff (correct). **But `diamond/page.tsx` and `jewellery-jobs/page.tsx` serialize cost fields into client-component props for every role** and hide them only inside the client component (`isOwner ? … : null`). | `diamond/page.tsx:119, 184-186, 209, 245, 253, 304-305`; `jewellery-jobs/page.tsx:147, 171-175, 182, 193, 201, 236, 245`; client-side gating e.g. `PolishedStockTab.tsx:112`, `IssueMaterialsForm.tsx:229` | Code trace (props always carry `allocatedCost`, `costPerCarat`, `issuedCostValue`, `remainingWipCost`, `costAtIssue`, `totalCost`, timeline `costValue`) | Staff RSC/HTML payloads for Diamond and Jewellery Job pages contain cost data. **`PHASE_3_VERIFICATION.md` ("omitted server-side … not just hidden with CSS") and the Phase 4 report are contradicted by the code.** Not live-verified here (no test DB). | **High — security** | **DEFECT** (contradicts reports) |
| 4.17 | Server Action permissions | Every action calls `requireUser()`/`requireOwner()` first. Receipt action rejects Staff abnormal-loss and damaged/lost flags server-side. | `actions/*.ts`; `actions/jewellery.ts:352-357` | Action test suites (passing) | New Phase 7 actions need the same pattern. | Low | VERIFIED |
| 4.18 | Idempotency / duplicate protection | Unique nullable `idempotencyKey` per posting model; pre-check + P2002 recovery in actions. | `actions/diamond.ts`, `actions/jewellery.ts`, `actions/metal.ts` | Action tests | `issueMaterialsToJewelleryJob` overwrites `JewelleryJob.idempotencyKey` with the issue key (`posting.ts:667`), losing the create-job key — a very late duplicate create could re-insert. | Low | VERIFIED (minor gap) |
| 4.19 | Negative-stock prevention | Rough/polished: status gates. Metal: issue and adjustment-out check **gross** balance only. | `jewellery/posting.ts:478-483, 330-337` | `posting.test.ts:389, 262` | Fine/cost can already go negative through 4.9; gross-only checks cannot see it. | High | PARTIAL |
| 4.20 | Reversal-based cancellation | Unused Diamond/Jewellery jobs cancel via `cancelVoucher()` mirror reversal + compensating movements. Generic cancel refuses job/receipt vouchers and linked sales. | `diamond/posting.ts:380-434`; `jewellery/posting.ts:687-769`; `actions/vouchers.ts:454-495` | Suites passing | Diamond and Jewellery **receipts** remain irreversible. | Medium | VERIFIED |
| 4.21 | Phase 6 sales / COGS / returns / refunds | Implemented as documented; COGS = authoritative inventory cost; atomic conditional status claim. | `finishedSalesPosting.ts`; `actions/finishedSales.ts` | 32 + 19 + 10 + 4 Phase 6 tests pass; live claims in `PHASE_6_VERIFICATION.md` **not re-run** (§2.3) | Depends on `metalCost` from receipts that are affected by 4.9/4.10 upstream. | Medium | IMPLEMENTED — NOT RE-VERIFIED (live) / VERIFIED (unit) |
| 4.22 | Decimal-safe money / weight | Prisma `Decimal` everywhere; `round2`/`round3` half-up; deterministic remainder allocation. | `accounting/money.ts`; `diamond/allocation.ts` | `money.test.ts`, `allocation.test.ts` | Client previews use JS `number` (display only; server recomputes). | Low | VERIFIED |
| 4.23 | Private media, secrets, CSP, rate limiting | As documented in V1 acceptance. | `storage/*Media.ts`, `proxy.ts`, `auth/rateLimit.ts` | Media/proxy tests pass; rate-limit DB tests not run | — | Low | VERIFIED (unit) / NOT RE-VERIFIED (rate-limit DB) |
| 4.24 | Seven-page navigation | Nav shows Dashboard, Accounting, Diamond, Jewellery Job, Costing (Owner), Settings (Owner), plus **Help / મદદ** (added after V1). | `src/lib/nav.ts:7-15` | `nav.test.ts` | Phase 7 must add no top-level routes. | Low | VERIFIED |

---

## 5. Is "Manufacturer" vs "Job Manufacturer" a different lifecycle?

Reading the Phase 7 requirement against the existing Diamond engine:

- **Manufacturer** (rough side): ZYNORALUXE's own rough is sent out for a
  process and comes back changed (rough → polished, or rough → processed
  rough after 4P/Laser or HPHT/Grow). This is the **existing Diamond Job
  lifecycle** — issue whole rough pieces, partial/final receipts, gap-based
  loss, WIP drain, labour payable — with a **process label** and a process
  charge basis added. Duplicating the engine is not justified.
- **Job Manufacturer**: already-**polished** packets (carat, pieces,
  size-wise) sent out for work and returned as polished — no rough
  consumed, no rough→polished yield. Inputs, outputs and reconciliation
  units (pieces **and** carat by size) differ from the rough engine, which
  consumes whole `RoughPiece` rows and creates new `PolishedDiamond` rows.
  This is a **genuinely different lifecycle** that needs its own packet
  issue/return posting, while reusing the shared voucher, numbering,
  allocation and idempotency plumbing.

Whether "Manufacturer" also covers polished-in/polished-out work is an
open business question (§8).

---

## 6. Known limitations carried from earlier reports

| Source | Limitation | Still true in current tree? |
|---|---|---|
| Phase 2 | Balances re-aggregated live; CSV client-side; lists capped (`take`) | Yes |
| Phase 2 | P&L provisional (no COGS) | **Superseded** by Phase 6 actual P&L |
| Phase 2 | Payment-account / GST-rate editing limited to create + activate | Yes |
| Phase 2 | Same-page stateful form links must use `<a>`, not `next/link` | Yes (convention) |
| Phase 3 | Recut has no reverse flow | Yes |
| Phase 3 | Polished receipts irreversible | Yes |
| Phase 3 | Rough piece issued whole | Yes |
| Phase 3 | `Sold`/`Issued to Jewellery` polished statuses missing | **Partly superseded** — Phase 4 added `ISSUED_TO_JEWELLERY`/`SET_IN_JEWELLERY`/`DAMAGED_LOST`; `PolishedStockTab` still labels only `AVAILABLE`/`RECUT` |
| Phase 4 | Other material display-only; provisional re-allocation | Yes |
| Phase 4 | Output purity must be an issued purity | Yes — conflicts with Phase 7 (4.12) |
| Phase 4 | Weighted-average metal pool, no FIFO | Yes |
| Phase 4 | Staff sees zero cost figures | **Contradicted** at payload level (4.16) |
| Phase 5 | Client CSV, no pagination, linked-only variance, no market prices, settings affect new drafts only | Yes |
| Phase 6 | Real-network eventual-consistency lag; pool exhaustion under 10-way load | Not re-tested (no test DB) |
| Phase 6 | Returned-rough provenance fields missing | **Contradicted** by code (4.5) |
| Phase 6 | Zero-balance purity failure "not reproducible" | **Plausibly explained** by 4.9 (unproven for that incident) |
| V1 | No application backup/export; placeholder company details; production `SESSION_SECRET`; unbounded `getPartyLedger`; dev-only npm audit advisories | Not re-checked in the live environment; code unchanged |

---

## 7. Summary by status

- **VERIFIED:** purchase-cancel guards, issue/return mechanics, fineness
  snapshots, voucher-level balancing, other-material separation, permissions
  in actions, reversal cancellation, Decimal safety, navigation.
- **DEFECT (new in this audit):** `CONSUMED_OUT` double-deduction (4.9),
  scrap/pool mixing (4.10), Staff cost fields in page payloads (4.16).
- **PARTIAL:** purchase architecture, party types, rough jobs, polished
  stock model, alloy handling, negative-stock (fine/cost), Manufacturer
  relationships.
- **MISSING:** Polished Diamond Purchase, Dalal/Broker, process master and
  process jobs, Job Manufacturer packet workflow, packet stock and merge,
  9K purity, cross-purity output posting model, Copper/Alloy stock.
- **DOCUMENTED ONLY:** returned-rough provenance gap claim (4.5); Staff
  cost omission claims for Diamond/Jewellery pages (4.16); "Phase 6 not
  committed" statements (§1).
- **IMPLEMENTED — NOT RE-VERIFIED:** all live-database/browser claims from
  Phases 2–6; migration applied state; rate-limit integration tests.
- **BLOCKED — DECISION / ENVIRONMENT:** test database (§2.3); 24K fineness
  and the other decisions in §8.

## 8. Decisions this audit cannot make

1. **Test database.** Which isolated PostgreSQL may be used for migrations,
   seed and real-browser E2E (the local PostgreSQL 17 needs credentials)?
   Production must not be used.
2. **24K fineness.** Keep 99.9% (then the locked example yields 9.990 g
   fine, not 10.000 g) or change to 100.000%? Changing a live master affects
   only future snapshots.
3. **14K fineness.** Confirm 58.5% as the business value.
4. **Existing-data correction for 4.9/4.10.** Fixing the stock-balance
   read-side needs no data rewrite, but issues already posted at
   under-stated average cost cannot be silently restated. Report-only, or
   an Owner-approved adjustment voucher?
5. **Manufacturer scope.** Does the rough-side "Manufacturer" section ever
   return rough (e.g. after 4P/Laser or HPHT/Grow) rather than polished?
6. **Dalal/Broker brokerage GST** and who bears brokerage.
7. **Alloy source default** and whether Company alloy is tracked from day
   one.
8. **Packet merge key and cost layering** (weighted average within a
   packet vs. preserved layers).
