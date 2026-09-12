# ZYNORALUXE Jewellery ERP

Phase 1: project setup, database foundation, login, Owner/Staff roles,
dashboard, navigation, responsive layout, basic company settings.
Phase 2: a full double-entry Accounting module — Parties, Transactions
(Purchase/Sale/Payment Given/Payment Received/Expense), Ledger, Reports,
GST, and Dashboard integration.
Phase 3: Rough-to-Polished Diamond Manufacturing — Rough purchase/stock,
Issue Rough to Karigar, Cutting-Polishing Jobs, Receive Polished (yield/
loss, multi-output), Polished Stock, all fully integrated into the
Phase 2 accounting engine.
Phase 4: Jewellery Jobs and Manufacturing — Metal/Purity master, Metal
Stock (purchase, opening, issue, return/scrap, authorized adjustment),
Jewellery Job creation, Issue Materials (metal + real Phase 3 polished
diamonds + manual other material), Receive Finished Jewellery (partial
receipts, multi-output, fine-weight/diamond reconciliation),
cancellation/reversal, all fully integrated into the Phase 2 accounting
engine and Phase 3's diamond stock.
Phase 5 (this branch, `phase-5-costing`): Jewellery Costing and
Selling-Price Calculation — cost a real finished Phase 4 output
("Actual" costing, sourced 1:1 from Phase 4's already-resolved figures,
never re-derived) or build a pre-manufacturing quotation ("Estimate"
costing, full multi-line metal/diamond/other-material/labour form),
suggested selling price via markup-on-cost or target-margin-on-price,
GST, discount, selling expenses, an immutable Finalized snapshot with
revisions, and a customer-facing quotation that never reveals cost or
profit. Informational only — never posts a Voucher/JournalEntry/
StockMovement.

Full Phase 1–6 scope is defined in
`../ZYNORALUXE_JEWELLERY_ERP_MASTER_PLAN.md` (the locked source of truth).
This build implements **Phase 1 + Phase 2 + Phase 3 + Phase 4 + Phase 5**.
See `PHASE_2_VERIFICATION.md`, `PHASE_3_VERIFICATION.md`,
`PHASE_4_VERIFICATION.md`, and `PHASE_5_VERIFICATION.md` for the
detailed verification reports.

## Stack

- Next.js 16 (App Router, TypeScript, Turbopack)
- Tailwind CSS v4
- Prisma ORM 7 (PostgreSQL, via the `@prisma/adapter-pg` driver adapter —
  works as-is with a Supabase connection string)
- Session auth: signed JWT in an httpOnly cookie (`jose`), passwords hashed
  with `bcryptjs`. No third-party auth provider — see `src/lib/auth/`.
- Vitest + React Testing Library

## 1. Install dependencies

```bash
npm install
```

## 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in:

- `DATABASE_URL` — a PostgreSQL connection string. A Supabase project's
  connection string works unmodified. For local Postgres:
  `postgresql://user:password@localhost:5432/zynoraluxe?schema=public`
- `SESSION_SECRET` — generate with `openssl rand -base64 32`
- `OWNER_EMAIL`, `OWNER_NAME`, `OWNER_PASSWORD` — used once by the seed
  script below to create the first Owner account. Not read anywhere else.
- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_DIAMOND_BUCKET` —
  **optional.** Only needed to enable Diamond-module photo/certificate
  uploads (Phase 3) — everything else works without them. See "Media
  storage" under Diamond Manufacturing workflow below.
- `SUPABASE_JEWELLERY_BUCKET` — **optional.** Only needed if Jewellery
  Job photo uploads (Phase 4) should use a dedicated bucket instead of
  reusing the Diamond bucket above under jewellery-specific path
  prefixes (the default). See "Media storage" under Jewellery
  Manufacturing workflow below.

## 3. Set up the database

Migrations are already written (`prisma/migrations/`). With `DATABASE_URL`
pointing at a real, empty PostgreSQL database:

```bash
npm run db:migrate:deploy   # applies prisma/migrations/ (production-safe)
# or, during local development:
npm run db:migrate:dev      # applies migrations and can generate new ones

npm run db:generate         # regenerate the Prisma client (also runs automatically after migrate dev)
npm run db:seed             # creates the Owner account + Chart of Accounts, idempotently
```

`db:seed` is safe to re-run any time — it upserts the Owner account, the
system Chart of Accounts, the default Cash/Bank/UPI payment accounts, and
the starter GST rate list, so re-running it never creates duplicates.

After seeding, sign in at `/login` with `OWNER_EMAIL` / `OWNER_PASSWORD`.
Additional Staff accounts are created from the Settings page (Owner only) —
there is no public sign-up.

## 4. Run the app

```bash
npm run dev
```

Visit http://localhost:3000 — it redirects to `/login` when signed out.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Run the production build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test` | Vitest (unit + component tests) |
| `npm run db:generate` | Regenerate the Prisma client |
| `npm run db:migrate:dev` | Apply/create migrations locally |
| `npm run db:migrate:deploy` | Apply existing migrations (CI/production) |
| `npm run db:seed` | Create/update the Owner account from `.env` |

## Database foundation

**Phase 1 tables:** `users` (id, email, name, passwordHash, role
OWNER|STAFF, isActive, timestamps) and `company_settings` (single row, id
`"default"`; company details, GST, `companyStateCode` added in Phase 2 for
CGST/SGST-vs-IGST suggestions, financial year start, `updatedByUserId`).

**Phase 2 tables** (migration `20260911000000_phase2_accounting`), all
money/quantity columns are Prisma `Decimal` (Postgres `NUMERIC`), never
`Float`:

- **`parties`** — Customer/Supplier/Karigar, contact + GST/state fields,
  `openingBalance`/`openingBalanceType` (used once, to post an opening
  voucher — never read as a live balance), `isActive` (archive, never
  hard-deleted), created/updated-by audit fields.
- **`accounts`** — Chart of Accounts (Asset/Liability/Equity/Income/Expense).
  Seeded idempotently by `prisma/seed.ts`: Accounts Receivable, Accounts
  Payable, Opening Balance Equity, Sales Income, Purchases, Business
  Expenses, Input/Output CGST/SGST/IGST (6 accounts), Round Off, plus one
  account per payment account (Cash/Bank/UPI).
- **`payment_accounts`** — Cash/Bank/UPI/Other, each backed by one `accounts`
  row. Owner manages these from Accounting → "Accounting settings".
- **`gst_rates`** — configurable tax-rate choices (seeded with common
  examples, explicitly labelled as examples, not legal advice). Owner can
  add/deactivate; invoice lines snapshot the percent actually used so a
  later rate change never rewrites history.
- **`vouchers`** — one row per posted transaction: type, date,
  `financialYearLabel` (computed from Company Settings' FY start),
  `voucherNumber` (concurrency-safe, see below), party, payment account,
  amount, GST treatment, status (`POSTED`/`CANCELLED`), and — for a
  cancelled voucher — `cancelledAt`/`cancelledByUserId`/`cancellationReason`
  plus a link to the reversal voucher that undid it. `idempotencyKey`
  (unique, nullable) makes duplicate form re-submission a no-op instead of
  a duplicate entry.
- **`journal_entries`** — the actual debit/credit legs. A DB `CHECK`
  constraint (hand-added to the migration; not expressible in
  `schema.prisma`) enforces each line is exactly one side, non-negative.
  `partyId` is set on Accounts-Receivable/Payable legs — this is the party
  sub-ledger; there is no separately-maintained balance column anywhere.
- **`invoice_lines`** — Purchase/Sale itemized lines (description, HSN/SAC,
  quantity/unit, rate, discount, GST rate + snapshot percent, tax
  inclusive/exclusive, computed taxable value/tax/total). Financial detail
  only — no stock movement; Phase 3 connects real stock later.
- **`voucher_sequences`** — one row per (voucher type, financial year);
  numbers are allocated via an atomic `upsert` (`INSERT ... ON CONFLICT DO
  UPDATE`) in the same DB transaction as the voucher insert, so concurrent
  submissions can never collide or skip.

**Phase 3 tables** (migration `20260911065140_phase3_diamond_manufacturing`),
same Decimal-everywhere rule (carat columns use `Decimal(10,3)`, money
`Decimal(14,2)`):

- **`rough_lots`** — one purchase/parcel: supplier, purchase date, rate/rate
  basis, currency+exchange rate, `totalPurchaseCost` (authoritative landed
  cost), optional GST, linked accounting voucher, human-readable `lotCode`
  (`ZL-RL-2026-000001`).
- **`rough_pieces`** — individual stones, always belonging to a lot OR
  (for a leftover returned from a job) `lotId: null` with
  `returnedFromJobId`/`returnedFromReceiptId` set instead — preserves
  traceability without inventing a false "parent piece" when a job issued
  several pieces together. `allocatedCost` is this piece's share of its
  lot's (or source receipt's) cost; `costLocked` flips permanently `true`
  the moment a piece is first issued, blocking further direct cost edits.
  `status`: `AVAILABLE` → `WITH_KARIGAR` → `COMPLETED`, or `CANCELLED`
  (returned-and-available again after an issue cancellation). "Partly/Fully
  Issued" are **derived lot-level rollups**, not a stored column — see
  `deriveRoughLotStatus()` in `src/lib/diamond/reports.ts`.
- **`diamond_job_pieces`** — join table recording every piece a job ever
  held, even across a cancel-and-reissue-elsewhere cycle (a piece's
  `status` alone can't reconstruct that history).
- **`diamond_jobs`** — one Issue-Rough-to-Karigar event through to
  completion: Karigar, required shape (+ custom-shape fields), issue/due
  date, `issuedRoughCarat`/`issuedCostValue` (snapshot at issue),
  `remainingWipCost` (drains to exactly 0 as receipts resolve it),
  cumulative `receivedPolishedCarat`/`returnedRoughCarat`/
  `totalLabourCharge`, status (`ISSUED`→`IN_PROGRESS`→
  `PARTIALLY_RECEIVED`→`COMPLETED`, or `CANCELLED`), linked WIP-transfer
  voucher, `jobCode` (`ZL-JOB-2026-000001`).
- **`polished_receipts`** — one Receive-Polished event (a job may have
  several, for partial receipts): polished/returned carat, this receipt's
  `weightLossCarat`/`yieldPercent`, labour charge, linked accounting
  voucher, `receiptCode` (`ZL-REC-2026-000001`).
- **`polished_diamonds`** — one output per polished stone: shape,
  measurements, grading fields, certificate status, `allocatedCost`/
  `costPerCarat`, status (`AVAILABLE`/`RECUT`), `polishedCode`
  (`ZL-POL-2026-000001`).
- **`stock_movements`** — the immutable audit ledger every stock figure in
  the app derives from. `pieces`/`carat`/`costValue` are always positive
  magnitudes; direction is implied entirely by `type` (`ROUGH_PURCHASE_IN`,
  `ROUGH_ISSUE_OUT`, `ROUGH_ISSUE_CANCEL_IN`, `ROUGH_CONSUMED_OUT`,
  `ROUGH_RETURN_IN`, `POLISHED_RECEIVE_IN`, `POLISHED_RECUT_OUT`) — never
  edited or deleted after insert.
- **`diamond_sequences`** — concurrency-safe numbering for the five
  human-readable code types above (one row per type+calendar-year,
  incremented via the same atomic-upsert pattern as `voucher_sequences`,
  but keyed by calendar year, matching the master plan's own examples).

**Phase 4 tables** (migration `20260911110642_phase4_jewellery_jobs`),
same Decimal-everywhere rule (weight columns `Decimal(10,3)`, fineness
`Decimal(6,3)`, money `Decimal(14,2)`):

- **`metal_purities`** — Metal type + display name (unique together),
  fineness percentage, active flag, audit fields. Every transaction that
  uses a purity snapshots its fineness at that moment — editing here
  never rewrites history.
- **`metal_purchases`** — one purchase: supplier, metal/purity,
  gross/fine weight, `finenessPercentSnapshot`, rate/rate basis (record-
  only — `totalPurchaseCost` is authoritative), currency+exchange rate,
  optional GST, linked accounting voucher, `purchaseCode`
  (`ZL-MP-2026-000001`).
- **`metal_stock_movements`** — the immutable, weight-based audit ledger
  every Metal Stock figure derives from (mirrors `stock_movements`'
  role for Phase 3, but for fungible weight instead of discrete pieces):
  `PURCHASE_IN`, `OPENING_IN`, `ISSUE_OUT`, `ISSUE_CANCEL_IN`,
  `RETURN_IN`, `SCRAP_RETURN_IN`, `CONSUMED_OUT`, `ADJUSTMENT_IN`,
  `ADJUSTMENT_OUT` — never edited or deleted after insert.
- **`jewellery_jobs`** — one job from creation through completion:
  customer (optional)/Karigar, jewellery type, design name/image,
  quantity, optional target metal/purity/weight, cumulative issued/
  received/returned/scrap fine weight and cost, `remainingWipCost`
  (metal-only WIP pool — diamonds resolve separately by their own
  `costAtIssue`, never this shared pool), status (`DRAFT`→
  `MATERIALS_ISSUED`→`IN_PROGRESS`→`PARTIALLY_RECEIVED`→`COMPLETED`, or
  `NEEDS_CORRECTION`/`CANCELLED`), linked WIP-transfer voucher, `jobCode`
  (`ZL-JJOB-2026-000001` — deliberately distinct from Phase 3's
  `ZL-JOB-` prefix, so the two can never collide or look alike).
- **`jewellery_metal_issue_lines`** / **`jewellery_diamond_issue_lines`**
  / **`jewellery_other_material_lines`** — the materials issued to one
  job: metal lines (weight/cost + fineness snapshot), diamond lines (one
  row per real Phase 3 `polished_diamonds` row issued, `costAtIssue`
  copied at issue time, `resolvedAs` set exactly once on
  set/return/damaged-lost), and manual other-material lines
  (non-stock-tracked, cost for display only).
- **`jewellery_receipts`** — one Receive-Finished event (a job may have
  several, for partial receipts): returned/scrap fine weight, this
  receipt's `processLossFineWeight`, abnormal-loss flag+reason, labour/
  making/setting/plating/other charges, linked accounting voucher,
  `receiptCode` (`ZL-JREC-2026-000001`).
- **`finished_jewellery`** — one output per finished piece: type,
  quantity, gross/net/fine metal weight, `finenessPercentSnapshot`,
  allocated metal/diamond/other-material/labour cost and total, QC
  status, `finishedCode` (`ZL-FJ-2026-000001`).
- **`jewellery_sequences`** — concurrency-safe numbering for the four
  human-readable Phase 4 code types (same atomic-upsert pattern as
  `diamond_sequences`, its own table so Phase 3's is never touched).

**Phase 5 tables** (migrations `20260911170009_phase5_costing` +
`20260911170402_phase5_costing_charge_line_is_labour`), same
Decimal-everywhere rule:

- **`costing_sequences`** — financial-year-aware, concurrency-safe
  numbering (`CST/2026-27/0001`), same atomic-upsert pattern as
  `voucher_sequences`, its own table so no other phase's numbering is
  touched.
- **`costing_settings`** — Owner-only singleton (`id: "default"`,
  same pattern as `company_settings`) holding new-Draft defaults
  (pricing method, markup/margin %, discount, GST, validity days,
  rounding step, selling-expense fixed/percent, quotation terms).
  Affects a **new** Draft's initial values only — read once at
  creation time, never re-applied to an existing Draft or Finalized
  sheet.
- **`cost_sheets`** — one costing, either mode:
  - **Actual** — `sourceFinishedJewelleryId` points at a real Phase 4
    `finished_jewellery` row (only eligible while that row's job is
    `COMPLETED`); every displayed source detail (job/receipt/output
    code, source voucher number, purity display name, fineness, GST
    rate percent) is copied into its own snapshot column at creation/
    finalize time — a Finalized sheet never re-queries the live
    master. "Refresh from source" re-copies the four cost fields from
    the source output, but only while the sheet is still `DRAFT`.
  - **Estimate** — no source link; every metal/diamond/other-material/
    charge line is entered directly.
  - Pricing/GST fields (`pricingMethod`, `markupPercent`,
    `targetMarginPercent`, `discountType`/`discountValue`,
    `gstTreatment`/`gstRatePercentSnapshot`, `priceType`,
    `roundingStep`, `sellingExpenseFixed`/`sellingExpensePercent`) are
    frozen forever once `status` becomes `FINALIZED` — a correction is
    always a new revision (`previousVersionId`/`revisionNumber`/
    `revisionGroupId`), never an edit.
  - `linkedEstimateId` is an optional, Owner-picked (never inferred)
    link from an Actual sheet back to the Estimate it started from,
    purely for a variance display — comparing two unrelated records is
    never possible since the link must be explicit.
  - `costingNumber` (`CST/2026-27/0001`) is unique; status is
    `DRAFT`→`FINALIZED`→(optionally)`ARCHIVED` — a Finalized sheet is
    never hard-deleted, only archived; only a Draft can be deleted, and
    only by Owner.
- **`cost_sheet_metal_lines`** / **`cost_sheet_diamond_lines`** /
  **`cost_sheet_other_material_lines`** / **`cost_sheet_charge_lines`**
  — the priced line items. A diamond line may optionally point at a
  real `polished_diamonds` row (Estimate mode) for a specific-stone
  quote. A charge line's `method` is one of `FLAT`/`PER_GRAM`/
  `PER_CARAT`/`PER_PIECE`/`PERCENT_OF_MATERIAL_COST` (the last based on
  metal+diamond+other-material cost only, never other charge lines, so
  several percentage charges never become order-dependent); `isLabour`
  splits the calculation summary's "Labour cost" line from "Additional
  manufacturing charges".
- **`cost_sheet_audit_events`** — immutable audit trail
  (`CREATED`/`UPDATED`/`REFRESHED`/`FINALIZED`/`REVISED`/`ARCHIVED`/
  `UNARCHIVED`/`DRAFT_DELETED`), who/when, same append-only principle as
  every stock-movement ledger elsewhere in this codebase.

The 15-line calculation summary (Metal/Diamond/Other-material/Labour
cost, additional charges, total production cost, suggested selling
value, discount, taxable value, GST, customer total, selling expenses,
net realization, profit, margin) is **never a stored column** — it is
always derived at read time from a sheet's own (frozen-once-Finalized)
inputs by `computeCostSheetTotals()` in `src/lib/costing/calculations.ts`,
guaranteeing immutability automatically.

## Accounting workflow (Phase 2)

The `/accounting` page is one page with four tabs (`?tab=transactions|
parties|ledger|reports`), matching the master plan exactly.

- **Transactions** — five buttons (Purchase, Sale, Payment Given, Payment
  Received, Expense) open the matching form inline. Purchase/Sale support
  multiple item lines ("+ Add another item") with a live total; the GST
  treatment (None/CGST+SGST/IGST) is suggested from Company vs. Party state
  codes but always shown for confirmation before saving, never applied
  silently. Selecting a payment account on a Purchase/Sale means "paid now"
  (posts the settlement in the same transaction); leaving it blank means
  "on credit" (sits in Accounts Receivable/Payable until a Payment Given/
  Received later clears it).
- **Parties** — search, create, edit, and archive/reactivate Customers,
  Suppliers, and Karigars. A party is never hard-deleted. Editing is
  role-aware: Owner can change every field (name, type, phone, email,
  GSTIN, state/state code, active status); Staff can only change phone,
  email and address — the other fields render read-only for Staff, and
  the server rejects any attempt to change them regardless of what's
  submitted. An archived party can still be edited by Owner, but Staff
  cannot open its editor at all. Changing a party's type when it already
  has vouchers requires an explicit "change it anyway" confirmation (shown
  with the transaction count) — the type change itself never touches any
  past voucher, journal entry, or invoice line, only the Party row.
- **Ledger** — pick a party, see every Receivable/Payable-affecting entry in
  date order with a running balance (positive = they owe us, negative = we
  owe them).
- **Reports** — Purchase/Sales/Expense reports, Cash/Bank, Receivable &
  Payable, GST summary, and Profit and Loss, each with a date range and CSV
  export where practical. GST summary and P&L are Owner-only (they reveal
  tax liability and profit).

Dashboard's Cash/Bank/Receivable/Payable cards and the New Purchase/New
Sale quick actions are now real, live-computed data — not placeholders —
and always match the Accounting reports because both read from the same
journal entries.

## Diamond Manufacturing workflow (Phase 3)

The `/diamond` page is one page with exactly three tabs (`?tab=rough|
jobs|polished`), matching the master plan. Business model: ZYNORALUXE
buys lab-grown **rough** diamonds and has a Karigar cut/polish them — it
never grows diamonds (no CVD/HPHT in V1).

- **Rough Stock** — "New Rough Purchase" records a lot (one or many
  pieces in one parcel) — supplier, rate/basis, total landed cost,
  optional GST, optional immediate payment. Each piece's cost is
  allocated **proportionally by carat** by default (decimal-safe,
  rounding remainder assigned to one deterministic piece so shares always
  sum exactly to the lot total — the same pattern already used for
  CGST/SGST splitting); Owner may instead type each piece's cost manually,
  honored only when every piece supplies one and they sum exactly. Owner
  can later adjust a lot's cost split ("Adjust cost split") with a
  mandatory reason — but only while every piece in that lot is still
  unissued (`costLocked: false`); once issued, a piece's cost is locked
  permanently, including after a later cancellation-return.
- **Cutting-Polishing Jobs** — "Issue Rough" picks a Karigar, one or more
  *Available* rough pieces (a piece is always issued whole — never split
  across two jobs), a required shape (10 standard shapes or Custom with
  its own name/reference/measurements/instruction — no CAD/OBJ import or
  auto-inclusion-planning, deliberately out of scope), optional due date
  and target size. A job's detail page shows full material figures, an
  Owner-only cost panel, every rough piece issued, every receipt, and a
  complete audit timeline. "Mark In Progress" is a label-only status
  change. **Receive Polished** records one or more polished outputs (each
  with its own shape/measurements/grading/certificate fields), any
  returned unused rough, and the labour charge — partial receipts are
  fully supported.
- **Polished Stock** — every polished output with its allocated cost/cost-
  per-carat (Owner-only), certificate status, and status (`Available` or
  `Recut` — Owner-only, with a mandatory reason). `Sold`/`Issued to
  Jewellery` are deliberately **not** implemented: the master plan
  requires every status to be backed by a real linked transaction, and
  Sale-of-polished / Jewellery-issue don't exist until later phases.

### Weight loss, yield, and partial receipts

For a *single* full receipt: `Weight Loss = Issued − Polished − Returned`
and `Yield % = Polished ÷ Issued × 100`, exactly per the master plan. The
subtlety is **partial** receipts, where a job's several issued pieces
aren't all resolved in one event: the gap between what's pending and what
a given receipt reports is **not** automatically treated as loss (it may
simply be other pieces still untouched with the Karigar). Loss is only
ever recognized — and cost only ever fully drained from WIP — when there
is no gap at all (nothing ambiguous left) or the user explicitly checks
"This completes the job — no more rough will come back from this
Karigar." Until then, the receipt's own `weightLossCarat` is `0`, its
`yieldPercent` is an interim per-receipt figure, and the job stays
`PARTIALLY_RECEIVED` with the unresolved cost still sitting in WIP. A
job's *final* weight loss/yield (shown on its detail page once
`COMPLETED`) are the true cumulative figures. This is why the receive form
always shows Polished/Returned/Loss-or-Pending and the resulting job
status **before** the confirm dialog.

### Cost allocation

Polished carrying cost = the issued rough's carrying cost that this
receipt resolves, plus this receipt's labour charge, plus every normal
manufacturing loss recognized in this receipt (never carved out
separately — it stays absorbed inside the surviving polished inventory's
cost, per the master plan). When a receipt produces multiple outputs, that
total is split **proportionally by carat** across them (same deterministic
rounding-remainder pattern as the rough-piece split); Owner may adjust an
individual receipt's output costs afterward with a mandatory reason, only
while every output in that receipt is still `Available`. Returned unused
rough becomes a brand-new Rough Stock piece (its own `ZL-RGH-...` code)
carrying its proportional share of cost — not the same piece continuing,
since the original piece's identity ends once any of it is consumed.

### Accounting integration

Three new inventory/WIP asset accounts back this module — `1200` Rough
Diamond Inventory, `1210` Diamond WIP, `1220` Polished Diamond Inventory
(seeded idempotently, alongside the 13 Phase 2 accounts). **Karigar
labour payable deliberately reuses the existing Accounts Payable control
account** (`2000`, by `partyId`) rather than a dedicated one — a Karigar
is already a valid Party type, so Phase 2's unmodified Payment Given flow
already settles it; no new liability account or new payment UI was
needed. See the posting table below for exactly what each event posts.
Every posting happens inside one `prisma.$transaction` alongside its
stock-state changes — never a partial save — and duplicate submission is
blocked the same idempotency-key way as Phase 2 vouchers (`RoughLot`/
`DiamondJob`/`PolishedReceipt` each have their own unique nullable
`idempotencyKey`).

### Karigar balances — two, never mixed

**Material balance** (rough pieces/carat currently held, across open
jobs) comes purely from `DiamondJob`/`RoughPiece` state — see "Material
with each Karigar" on the Jobs tab. **Money balance** (labour payable) is
the ordinary Phase 2 Accounts Payable balance for that Karigar party —
visible on the Outstanding report exactly like a Supplier's payable, and
reduced by an ordinary Payment Given entry. The two are computed from
completely different tables and never combined into one number.

### Cancellation and reversal

Only an **unused** issue (status `ISSUED`/`IN_PROGRESS`, nothing received
or returned yet) can be cancelled, Owner-only: every issued piece returns
to `AVAILABLE` (its cost stays locked — see above) and the WIP-transfer
voucher is reversed through the *same* generic `cancelVoucher()` engine
Phase 2 already uses (an equal-and-opposite `REVERSAL` voucher, original
marked `CANCELLED`). The moment any polished output has been received
against a job, cancellation is rejected outright. **Polished receipts are
not reversible in Phase 3** — there's no "un-receive" flow. The generic
Accounting-tab "Cancel voucher" button also explicitly refuses to touch a
`DIAMOND_ISSUE`/`DIAMOND_RECEIPT` voucher (redirecting to the Diamond
module's own cancellation, or refusing outright for receipts) — cancelling
the accounting side alone would desync it from stock/job state.

### Media storage (photos, reference images, certificate files)

`src/lib/storage/diamondMedia.ts` is a small, production-shaped
abstraction over Supabase Storage's REST API (no extra SDK dependency):
private bucket, server-only **secret** API key (Supabase's current
server-only key type — the successor to the legacy `service_role` key,
same full-access/never-in-the-browser semantics), random non-guessable
object paths, MIME allowlist, 10 MB cap, short-lived signed URLs for
viewing — never a public bucket URL. Configured via `SUPABASE_URL` /
`SUPABASE_SECRET_KEY` / `SUPABASE_DIAMOND_BUCKET` (see `.env.example`) —
when unset, every non-photo Diamond feature still works fully, and
upload actions return a plain "not available yet" message instead of
pretending to succeed.

Upload is wired into `PhotoUploadField` (a small client component that
calls the upload Server Action directly, then hands the resulting opaque
asset id up to its parent form as a plain field — same shape as every
other field) on: the rough lot photo and each rough piece's photo
(Rough Purchase form), the custom-shape reference photo (Issue Rough
form, when shape is Custom), and each polished output's photo and
certificate file (Receive Polished form, cert file only when Certified).
Thumbnails/links are rendered on Rough Stock, Polished Stock, and a job's
Custom Shape reference — the server resolves each stored asset id to a
short-lived signed URL before it ever crosses into a Client Component
(same "resolve server-only data before the boundary" rule as Decimal
values elsewhere in this codebase), so a page never holds a permanent or
public link to private storage.

## Jewellery Manufacturing workflow (Phase 4)

The `/jewellery-jobs` page has exactly two tabs (`?tab=jobs|metal`) — no
new item was added to the main navigation, per the master plan. Metal
Stock lives as a secondary tab *inside* this page, not its own route.
Business model: ZYNORALUXE buys/holds **metal** (Gold/Silver/Platinum,
by purity) as fungible weight-based stock, issues metal and Phase 3
polished diamonds to a Karigar to manufacture jewellery, and receives
finished pieces back.

- **Metal/Purity master** (Owner-only, Settings page) — Metal type
  (Gold/Silver/Platinum/Other), a display name (e.g. `18K`, `925
  Silver`), and a **fineness percentage** used for every fine-weight
  calculation: `Fine Weight = Gross Weight × Fineness % ÷ 100`, always
  computed server-side with `Decimal` math. Every transaction that uses a
  purity **snapshots** its fineness percentage at that moment
  (`finenessPercentSnapshot` columns throughout) — editing a purity later
  never changes the fine-weight/cost figures on jobs already issued or
  received. Seeded idempotently with 7 starter purities (Gold 10K/14K/
  18K/22K/24K, 925 Silver, 950 Platinum).
- **Metal Stock** (the `?tab=metal` tab) — fungible, weight-based, and
  **derived purely from an immutable `MetalStockMovement` ledger**, never
  a manually-editable balance (same principle as Phase 3's rough/polished
  stock, applied to a fungible material instead of discrete pieces). "New
  Metal Purchase" records gross weight, fineness-derived fine weight, one
  of 3 rate bases (per gross gram / per fine gram / fixed total — the rate
  itself is a reference field; the **total purchase cost** the user
  enters is always the authoritative posted amount), optional GST,
  optional immediate payment. Issuing metal to a job **resolves at the
  current weighted-average cost per gram** for that purity's pool
  (`costPerGram = pool.costValue ÷ pool.grossWeight`, computed fresh at
  issue time) — unlike Phase 3's discrete, individually-costed rough
  pieces. Owner-only: **Opening Metal Stock** (a starting balance, not a
  purchase) and an audited **Adjustment** (with a mandatory reason);
  both, like every movement, can never drive a purity's stock negative.
- **Jewellery Jobs** (the `?tab=jobs` tab, 5 views — All/Pending/In
  Progress/Completed/Cancelled) — "New Jewellery Job" creates a `Draft`
  job (customer optional, Karigar required, jewellery type, design name,
  optional design photo, quantity, optional target metal/purity/weight —
  no accounting/stock impact yet). **"Issue Materials" is a one-time,
  single consolidated action** (not a repeatable multi-call flow like
  Phase 3's rough issue): one or more metal lines (any mix of purities),
  zero or more real Phase 3 **Available** polished diamonds (each
  resolves by its own individual `costAtIssue` — a diamond is discrete
  and already costed; it is never drawn from metal's shared weighted-
  average pool), and optional manual "other material" lines (Moissanite,
  findings, alloy — cost tracked for job-costing display only, see
  "Known Phase 4 limitations"). This posts one balanced WIP-transfer
  voucher and flips the job to `Materials Issued`. "Mark In Progress" is
  a label-only change. **Receive Finished Jewellery** supports one or
  many outputs per receipt, each with its own metal/purity/net weight,
  any of the job's still-issued diamonds set into it, QC status, and an
  optional finished photo — partial receipts are fully supported, exactly
  like Phase 3's polished receive.

### Material reconciliation (metal, by fine weight — and diamonds, individually)

For metal: `Issued Fine + Karigar-Added Fine = Finished Fine + Returned
Fine + Scrap Fine + Process-Loss Fine` — reconciled **by fine weight**,
never by comparing unlike-purity gross weights directly (a job that
issues 22K and finishes at 18K reconciles correctly because both convert
through their own fineness snapshot). Exactly like Phase 3's rough/
polished gap logic: a partial receipt's un-accounted gap is **never**
auto-treated as loss — only when the gap is already zero or the user
explicitly checks "This completes the job" does the remainder become
recognized `processLossFineWeight`, and by default that loss cost stays
silently absorbed inside the surviving finished jewellery's carrying
cost (matching Phase 3's diamond weight-loss treatment). An Owner may
instead explicitly check "Classify this loss as abnormal" (with a
mandatory reason) to carve that specific loss's cost out to Business
Expenses instead. For diamonds: every issued polished diamond must end
in exactly one state — `SET` (into a specific output, using its own
`costAtIssue`), `RETURNED` (back to `Available`, cost returned to WIP),
or `DAMAGED_LOST` (Owner-only, mandatory reason, cost posted to Business
Expenses) — **completion additionally requires every issued diamond to
be resolved**, even once the metal side's gap has reached zero. Once a
job reaches `Completed`, its detail page relabels the "Pending with
Karigar" figure to "Metal loss (final)" (same value — the same gap
that meant "still outstanding" while open now means "recognized as
final loss," exactly mirroring Phase 3's diamond job detail page); a
real bug found during verification had Phase 4 always showing "Pending
with Karigar" even after completion, which read as if metal were still
outstanding on a job that was, in fact, fully done.

### Cost allocation

A receipt's resolved metal cost (plus labour/making/setting/plating/
other charges) is split **proportionally by each output's fine metal
weight** across multiple outputs in one receipt (same deterministic
rounding-remainder pattern as Phase 3). Each output's diamond cost is
the exact sum of its own set diamonds' `costAtIssue` — never allocated
by ratio. Owner may adjust a receipt's output costs afterward with a
mandatory reason, requiring the new totals to sum exactly back to the
receipt's locked total.

The job-level **other-material cost** (display-only, never posted to
the ledger) is allocated separately from the above, and across the
job's **entire output history**, not just one receipt: every time a
new output is created, the full issued other-material cost for the job
is re-split proportionally by finished gross weight across every
output the job has ever received (this receipt's new outputs plus all
prior receipts' existing outputs), using the same deterministic
rounding-remainder pattern — and prior outputs' stored
`otherMaterialCost`/`totalCost` are updated in place when their share
changes. This keeps the allocation fair across partial receipts (an
early small output no longer permanently keeps 100% of the cost just
because it happened first) while guaranteeing that once the job stops
producing new outputs, the sum of every output's allocated share
equals the job's total issued other-material cost exactly, remainder
included. A job that never receives any output has nothing to allocate
against and the cost simply stays unallocated (an explicit rule, not a
crash).

### Accounting integration

Four new asset accounts back this module — `1300` Metal Inventory,
`1310` Scrap Metal Inventory, `1320` Jewellery WIP, `1330` Finished
Jewellery Inventory (seeded idempotently). **Karigar labour AND
Karigar-added-material payable both reuse the existing Accounts Payable
control account** (`2000`, by `partyId`), the same reasoning as Phase
3's labour payable. Every posting happens inside one
`prisma.$transaction` alongside its stock-state changes, with the same
idempotency-key duplicate-submission protection as every other module.
`receiveFinishedJewelleryAction`, `issueMaterialsAction`, and
`cancelJewelleryJobAction` pass an explicit 20-second
`{ timeout: 20000 }` to their `prisma.$transaction` call — per-line,
per-purity, and per-output posting can require enough sequential
round trips against the real database that Prisma's 5-second default
interactive-transaction timeout was measured to be exceeded under real
network latency (see the "real bugs found" note in
`PHASE_4_VERIFICATION.md`).

### Karigar balances — two, never mixed

Same principle as Phase 3: **material balance** (metal fine weight +
diamonds still with a Karigar, across open jobs) is shown on the Jobs
tab, computed purely from job/movement state; **money balance** (labour
+ added-material payable) is the ordinary Accounts Payable balance for
that Karigar, visible on the Outstanding report exactly like Phase 3's.

### Cancellation and reversal

A `Draft` job cancels with zero stock/accounting impact. A
`Materials Issued`/`In Progress` job (nothing received yet) can be
cancelled Owner-only: every issued metal line returns to stock, every
issued diamond returns to `Available`, and the WIP-transfer voucher is
reversed through the same generic `cancelVoucher()` engine every other
module uses. The moment any finished jewellery has been received against
a job, cancellation is rejected outright — matching Phase 3's rule for
polished receipts. The generic Accounting-tab "Cancel voucher" button
also explicitly refuses to touch a `JEWELLERY_ISSUE`/`JEWELLERY_RECEIPT`
voucher.

### Media storage

`src/lib/storage/jewelleryMedia.ts` is a deliberately **separate,
duplicated** module (not shared with `diamondMedia.ts`) — same
security properties (private bucket, server-only secret API key,
magic-byte content-sniffing, random object paths, 10 MB cap, short-lived
signed URLs), duplicated specifically to avoid any risk of regressing
Phase 3's already-verified storage code. By default it reuses the
Diamond bucket (`SUPABASE_DIAMOND_BUCKET`) under jewellery-specific path
prefixes (`jewellery-design/`, `jewellery-finished/`) — set
`SUPABASE_JEWELLERY_BUCKET` to use a dedicated bucket instead. Wired
into the job's design-image field and each finished output's photo
field.

## Costing workflow (Phase 5)

The `/costing` page has exactly three tabs (`?tab=sheets|new|settings`),
**Owner-only** end to end — the nav link itself is hidden from Staff,
and every server-side entry point (`page.tsx`, every Server Action)
independently calls `requireOwner()`, never relying on the hidden nav
link alone. Costing is **informational only**: `src/lib/costing/engine.ts`
(deliberately not named `posting.ts`) never creates a Voucher,
JournalEntry, StockMovement, or MetalStockMovement, and never mutates
any Phase 1–4 row.

- **Cost Sheets** — search/filter by mode (Actual/Estimate)/status
  (Draft/Finalized/Archived)/date, CSV export, mobile-friendly cards.
- **New Costing** — two modes, picked in plain language ("A piece we
  already finished" / "An estimate before making it"):
  - **Actual** — pick any real Phase 4 finished output whose job is
    `COMPLETED` (see "Why `COMPLETED`-only" below); its metal/diamond/
    other-material/labour cost is copied 1:1 from Phase 4's own
    already-resolved figures — **never recomputed**, since Phase 4's
    allocation math has already fully settled it. A Draft can be
    re-synced from its source at any time via an explicit "Refresh from
    source" action (Draft only).
  - **Estimate** — a full multi-line form: any number of metal lines
    (rate basis + wastage %), diamond lines (10 standard shapes +
    Custom, or an optional link to a real Phase 3 polished diamond),
    other-material lines (Moissanite/Coloured stone/Small stone/
    Findings/Alloy/Enamel/Plating/Packaging/Other — display-only, same
    as Phase 4's own other-material lines), and charge lines (Flat/
    Per-gram/Per-carat/Per-piece/% of material cost, each optionally
    flagged as labour). A live client-side preview
    (`src/lib/costing/previewMath.ts`) shows the calculation summary as
    you type — the server always recomputes authoritatively with
    `Decimal` math on save, the preview is never trusted as-is.
  - Either mode: pricing method (markup-on-cost **or** target-margin-
    on-price — never both, never confused: switching recomputes the
    selling value from the same production cost under the newly chosen
    formula), discount (%/fixed), GST (reusing Phase 2's masters and
    CGST+SGST/IGST state-code suggestion — never silently forced),
    inclusive/exclusive pricing, optional rounding, optional fixed +
    percentage selling expenses, and an optional manual override (shown
    with a visible "manually overridden" indicator) — profit/margin
    shown after a manual override or after discount/selling-expenses is
    always the *real*, recalculated figure, never the unachieved target.
- **Costing Settings** — Owner-only defaults for every pricing/GST/
  rounding/selling-expense/quotation-terms field above. Affects a
  **new** Draft's starting values only; saving Settings never rewrites
  an existing Draft or Finalized sheet.

### Why `COMPLETED`-only for Actual costing

Phase 4's `receiveFinishedJewellery` retroactively re-splits an *open*
job's earlier outputs' `otherMaterialCost`/`totalCost` every time a
later receipt adds a new output (see "Cost allocation" under Phase 4
above) — so an output's cost fields are only permanently settled once
its job can never receive another output, i.e. once `status ===
"COMPLETED"`. Costing enforces this as the single Actual-costing
eligibility rule, which also cleanly covers "never cost a cancelled,
incomplete, unresolved, or Needs-Correction job" in one check.

### Lifecycle and immutability

`DRAFT` → `FINALIZED` → (optionally) `ARCHIVED`. A Draft is fully
editable (Estimate: every line/pricing field; Actual: pricing fields
plus an explicit "Refresh from source" for the sourced cost fields).
The moment a sheet is Finalized, **every** field — cost lines, pricing,
GST, source snapshot — is frozen forever, even if the Metal/Purity
master, a GST rate, or Costing Settings changes afterward; a real
browser test proved this by editing the live 22K purity's fineness and
display name after finalizing a costing sourced from a 22K output, then
confirming the Finalized costing's money figures and displayed purity
name were both completely unchanged. A correction is always a new
**revision** (a linked new row, `revisionNumber` incremented,
`previousVersionId` pointing back) — the original Finalized row is
never edited. A Finalized sheet can be Archived (still searchable,
never hard-deleted) and Unarchived. Only a Draft can be deleted, and
only by Owner.

### Customer quotation

A clean, print-friendly view generated only from a `FINALIZED` or
`ARCHIVED` sheet (`src/lib/costing/quotation.ts`'s
`getCustomerQuotationView()` returns an exhaustively allow-listed field
set — company/customer/item/metal/diamond/quantity/selling
value/discount/GST breakdown/final total/valid-until/notes/terms/
image) — it structurally cannot leak cost, Karigar cost, overhead,
markup, margin, profit, or any internal source/audit reference, because
those fields are never read into the object the view returns, not
merely hidden by the component that renders it. Uses `window.print()` /
"Save as PDF" (`.quotation-print-area` print CSS in
`src/app/globals.css`) — there is no public, unauthenticated URL; it's
the same Owner-only `/costing` route, just a different render.

### Media storage

Costing's optional design-image upload reuses
`src/lib/storage/jewelleryMedia.ts` unchanged (same private bucket,
server-only secret key, magic-byte validation, signed URLs) — only the
category union type gained one additive value, `"costing-estimate"`.
Unlike Jewellery's own upload actions (which correctly allow Staff,
since Staff legitimately creates Jewellery Jobs), Costing's
`uploadCostingPhotoAction`/`deleteCostingPhotoAction` are deliberately
separate, Owner-gated wrappers — every Costing action, image uploads
included, independently enforces `requireOwner()`.

## Posting / cancellation rules

Every voucher type posts a balanced set of journal lines inside one DB
transaction (`src/lib/accounting/posting.ts` + `prisma.$transaction`) — a
partially-saved entry cannot exist. In brief:

| Voucher | Posts |
|---|---|
| Credit Purchase | Dr Purchases + Dr Input GST · Cr Accounts Payable (party) |
| Cash/Bank Purchase | as above, plus Dr Accounts Payable · Cr payment account |
| Credit Sale | Dr Accounts Receivable (party) · Cr Sales Income + Cr Output GST |
| Cash/Bank Sale | as above, plus Dr payment account · Cr Accounts Receivable |
| Payment Given | Dr Accounts Payable (party) · Cr payment account |
| Payment Received | Dr payment account · Cr Accounts Receivable (party) |
| Expense | Dr Business Expenses · Cr payment account |
| Opening Receivable | Dr Accounts Receivable (party) · Cr Opening Balance Equity |
| Opening Payable | Dr Opening Balance Equity · Cr Accounts Payable (party) |
| Rough Purchase | Dr Rough Diamond Inventory + Dr Input GST · Cr Accounts Payable (supplier) [+ Dr Accounts Payable · Cr payment account if paid now] |
| Issue Rough to Karigar | Dr Diamond WIP · Cr Rough Diamond Inventory |
| Receive Polished | Dr Polished Diamond Inventory (resolved cost + labour) [+ Dr Rough Diamond Inventory for any returned carat] · Cr Diamond WIP (resolved cost) [+ Cr Accounts Payable (Karigar) for labour] |
| Metal Purchase | Dr Metal Inventory + Dr Input GST · Cr Accounts Payable (supplier) [+ Dr Accounts Payable · Cr payment account if paid now] |
| Issue Materials to Job | Dr Jewellery WIP · Cr Metal Inventory [+ Cr Polished Diamond Inventory for any diamonds issued] |
| Receive Finished Jewellery | Dr Finished Jewellery Inventory (resolved metal + labour/charges + set-diamond cost) [+ Dr Metal Inventory for returned metal] [+ Dr Scrap Metal Inventory for scrap] [+ Dr Polished Diamond Inventory for returned diamonds] [+ Dr Business Expenses for abnormal loss / damaged-lost diamonds] · Cr Jewellery WIP (resolved metal + set/returned/damaged-lost diamond cost) [+ Cr Accounts Payable (Karigar) for charges + Karigar-added material] |

**Cancellation is Owner-only** and never deletes or edits the original: it
posts a new `REVERSAL` voucher with every journal line's debit/credit
swapped, links it back to the original, and marks the original
`CANCELLED` with who/when/why. Cancelling an already-cancelled voucher, or
cancelling a reversal itself, is rejected. Nothing in the system ever
"deletes" a posted entry.

**A Party's opening balance can never be edited directly**, at any role —
`updateParty` doesn't even accept those fields. The only way to correct a
wrong opening balance is the same reversal mechanism above: cancel the
original `OPENING` voucher from the Transactions tab (Owner-only), which
posts a balanced, audited correction instead of silently overwriting a
number.

## Permissions (Phase 2 additions)

- **Owner**: everything Staff can do, plus cancel/reverse posted vouchers,
  manage payment accounts and GST rates, view GST summary/Profit & Loss,
  edit every Party field (including type and active status, both guarded
  as described above), and archive/reactivate a Party.
- **Staff**: create Parties and all five transaction types, view
  Transactions/Parties/Ledger and the operational reports (Purchase, Sales,
  Expense, Cash/Bank, Receivable & Payable), edit a Party's phone/email/
  address. Cannot cancel/reverse, cannot manage payment accounts/GST rates,
  cannot see GST summary or P&L, cannot change a Party's name/type/GSTIN/
  state/active-status, cannot archive/reactivate a Party, cannot edit an
  archived Party at all.

## Permissions (Phase 3 additions)

- **Owner**: everything Staff can do, plus cancel an eligible Diamond Job
  (reversing both stock and accounting), mark a polished diamond for
  Recut, and make audited cost-allocation overrides (rough-piece split
  before issue, polished-output split before any output leaves
  `Available`). Sees every cost/carrying-value figure and the Karigar
  money (labour payable) balance.
- **Staff**: create Rough Purchases, Issue Rough, and Receive Polished —
  the same day-to-day operational permission level as Phase 2's Purchase/
  Sale/Payment entries (any authenticated user, not Owner-gated). Sees
  material quantities, statuses, and codes throughout the Diamond module,
  but **never** a cost, carrying value, or the Karigar's money balance —
  those fields are omitted server-side from what a Staff-rendered page
  even receives, not just hidden with CSS. Cannot cancel a job, cannot
  mark a polished diamond for Recut, cannot make a cost-allocation
  override.

All of the above is enforced **inside the Server Action itself**
(`requireUser()`/`requireOwner()`), exactly like Phase 2 — never only by
which buttons a page happens to render.

Every rule above is enforced **inside the Server Action itself**
(`requireUser()`/`requireOwner()` from the Phase 1 DAL), not just by hiding
a button — a Staff request that reaches `cancelVoucherAction` directly is
rejected the same way a Staff click would be.

## Permissions (Phase 4 additions)

- **Owner**: everything Staff can do, plus purchase/open metal stock and
  make audited stock adjustments, cancel an eligible Jewellery Job
  (reversing both stock and accounting), classify a receipt's loss as
  abnormal, mark a diamond damaged/lost, manage the Metal/Purity master,
  and make audited cost-allocation overrides on a receipt's outputs.
  Sees every cost/carrying-value figure and the Karigar money (labour +
  material payable) balance.
- **Staff**: create Jewellery Jobs, issue materials, and receive finished
  jewellery — the same day-to-day operational permission level as every
  other module's create/issue/receive actions. Sees material weights,
  statuses, and codes throughout, but **never** a cost, carrying value,
  or the Karigar's money balance. Cannot cancel a job, cannot classify a
  loss as abnormal, cannot mark a diamond damaged/lost, cannot make a
  cost-allocation override, cannot purchase/open metal stock or adjust it
  — enforced **inside the Server Action itself**
  (`requireUser()`/`requireOwner()`), not just by which buttons a page
  renders; `receiveFinishedJewelleryAction` independently re-checks the
  abnormal-loss and damaged-lost flags server-side even if a Staff
  request somehow reached it directly with those fields set.

## Known Phase 2 limitations

- Party "current balance" shown in the Parties list and Dashboard totals
  are always derived live from `journal_entries` — correct by construction,
  but every report query re-aggregates rather than reading a cached number.
  Fine at this data volume; would need materialized summaries at scale.
- No inventory/stock exists yet (Phase 3), so Profit & Loss is explicitly
  labelled **provisional** — it has no cost-of-goods-sold and must not be
  read as final business profit.
- GST rate choices are a small seeded example list (0%, 0.25%, 1.5%, 3%,
  5%, 18%) explicitly documented as examples, not legal/tax advice — Owner
  is expected to adjust them for their actual registration.
- CSV export is client-side (builds the file in the browser from already-
  rendered rows) — fine for the row counts a single jewellery shop
  generates, not built for very large exports.
- Payment-account and GST-rate editing is still create + activate/
  deactivate only (no field editing after creation) — Party now has a full
  Owner/Staff-aware edit form (see "Accounting workflow" above), but the
  other two master lists don't yet.
- Wide report tables scroll horizontally within their own container on
  narrow phone screens (as required — the page itself never scrolls
  sideways) but there's no visual scroll-affordance hint, so a user may not
  immediately notice a table has more columns off-screen.
- **Same-page client-side navigation into a stateful form must use a plain
  `<a>`, not `next/link`.** Found via live browser testing: clicking a
  `next/link` `<Link>` that only changes `searchParams` on this same
  dynamic route (e.g. Parties list → `?editPartyId=X`) could render the
  previous view for a brief window before the real data arrived, which —
  for a read-only view — is harmless, but for the Edit Party form looked
  like a user's just-typed input silently vanishing. Fixed by using a plain
  `<a href>` for the "Edit" link (forces a full request every time),
  matching the pattern already used for the tab links on this same page.
  Any *new* link added to this page that navigates into a form holding
  local component state should do the same rather than using `next/link`.

## Known Phase 3 limitations

- **Diamond media storage is optional** — see "Media storage" above.
  When `SUPABASE_URL`/`SUPABASE_SECRET_KEY` are unset, an upload attempt
  returns a plain "not available yet" message rather than silently doing
  nothing or faking success with a local-disk path; every other Diamond
  feature works fully either way. In this deployment it **is** configured
  and live-verified (real upload → private-bucket storage → signed-URL
  retrieval → thumbnail render, through the actual UI, plus direct Storage
  REST-API checks that the bucket is genuinely non-public) — see
  `PHASE_3_VERIFICATION.md`. Photo upload is wired for: rough lot photo,
  rough piece photo, custom-shape reference photo, polished-diamond photo,
  and certificate file — each is optional and additive to its form.
- **Recut has no reverse flow.** Marking a polished diamond `RECUT` is a
  simple, audited, Owner-only status change (with a `POLISHED_RECUT_OUT`
  movement) — it does **not** generate a new rough piece or a new job.
  Modeling "what actually happens to a recut stone" belongs to a later
  phase once Jewellery Jobs/Costing exist to consume the outcome.
- **Polished receipts cannot be reversed or corrected once posted.** Rough
  issue cancellation is fully supported (Owner-only, unused issues only);
  a mis-entered polished receipt has no undo in Phase 3 — this mirrors
  the master plan's "never silently edit/delete a posted movement" rule,
  but a correction *mechanism* (e.g. a receipt-reversal voucher) is future
  work, not yet built.
- **A rough piece is always issued and consumed as a whole physical
  stone** — never split carat-by-carat across two simultaneous jobs. This
  is a deliberate modeling choice (matches how a single rough stone is
  actually handled by a Karigar) documented at the top of the Phase 3
  section of `prisma/schema.prisma`; a business that genuinely needs to
  divide one physical stone's carat across two concurrent cutting jobs
  before either starts is not represented by this model.
- **`Sold` / `Issued to Jewellery` polished statuses don't exist yet** —
  by design, since neither a polished-diamond sale nor a Jewellery Job
  exists until later phases, and the master plan requires every status to
  be backed by a real linked transaction.
- Reports/lists cap at a few hundred rows (`take: 200`–`500`) — fine at
  small-shop data volumes, not built for pagination at scale, matching the
  same known limitation already documented for Phase 2's report queries.

## Known Phase 4 limitations

- **"Other material" cost is a job-costing display figure only — never
  posted to the accounting ledger.** Moissanite/findings/alloy/other
  manual material lines have no real stock account backing them (per
  the master plan's own "do not falsely present manual material as fully
  inventory-traced" instruction), so their cost shows on the job/output
  cost breakdown but never gets its own Dr/Cr journal line.
- **Other-material cost is provisional and recalculated across every
  output the job has received so far, whenever a new output appears** —
  proportionally by fine metal weight (deterministic rounding-remainder,
  same pattern as every other proportional split in this codebase). A
  job whose outputs are spread across several partial receipts has
  earlier outputs' `otherMaterialCost` retroactively corrected each time
  a later receipt adds more outputs, so the total across every output
  for the job always sums exactly to the job's total issued
  other-material cost once the job stops receiving new outputs. If a
  job never receives any output at all (e.g. it resolves entirely via
  return/scrap), the cost simply has nowhere to display and stays
  unallocated — an explicit, documented rule, not a silent drop.
- **Return and scrap lines must each explicitly name their own metal
  purity** — no default is ever silently chosen. A job that issued only
  one purity still needs exactly one line per return/scrap amount (kept
  simple: one pre-filled row, no extra picking required); a job that
  issued more than one purity gets an explicit "+ Add another purity"
  control per return/scrap section, and the server independently
  validates each line's purity was actually issued to that job **and**
  that the requested weight doesn't exceed what's still outstanding for
  that *specific* purity — derived purely from the immutable
  `MetalStockMovement` ledger (job + purity), never a stored balance, so
  a job issuing 22K and 18K together can't have a return/scrap amount
  from one purity silently absorbed against the other's remaining
  balance. **A finished output's own metal purity is restricted the
  same way** — it must be one of the job's issued purities too, using
  that job's own fineness snapshot rather than a fresh Metal/Purity
  master lookup — because the informational `CONSUMED_OUT` movement for
  the metal that becomes finished jewellery is posted against exactly
  that purity: accepting any real purity in the system at large here
  (as an earlier version of this fix did, before being caught during
  this same verification pass) would let an output recorded in a
  purity the job never issued silently drain a real, unrelated
  purity's Metal Stock balance for metal it never actually gave out.
  The finished portion is attributed to each output's own real (issued)
  purity; any recognized process loss, which has no output of its own to
  attach to, is split proportionally across the job's actually-issued
  purities by their issued fine-weight share — never dumped on one
  arbitrarily "first" line either.
- **A polished diamond issued to a Jewellery Job resolves by its own
  exact `costAtIssue`, never Phase 3's proportional-allocation ratio** —
  correct, since it's the same real, already-costed Phase 3 record, not
  a new allocation event.
- Metal Stock's per-purity balance is a simple weighted-average cost pool
  (recomputed fresh from the immutable movement ledger at issue time) —
  there is no FIFO/LIFO lot-tracking option, matching the master plan's
  "fungible metal" model.
- Reports/lists cap at a few hundred rows (`take: 200`–`500`), matching
  the same known limitation already documented for Phase 2/3.
- **No Costing or selling-price/profit functionality** — by explicit
  instruction, Phase 4 stops at manufacturing cost; Phase 5 owns
  Costing/selling-price/profit.

## Permissions (Phase 5 additions)

- **Owner**: full access — create/edit/refresh-from-source/finalize/
  revise/archive/unarchive/delete-Draft, Costing Settings, CSV export,
  the customer quotation view, and every cost/profit/margin/markup/
  rate/internal-quotation figure.
- **Staff**: **no access at all**, the strictest permission boundary in
  the app. `Costing` does not appear in the Staff navigation
  (`src/lib/nav.ts`); a direct request to `/costing` redirects to
  `/unauthorized` (`requireOwner()` at the top of
  `src/app/(app)/costing/page.tsx`); **every** Server Action in
  `src/app/actions/costing.ts` independently calls `requireOwner()`
  before doing anything else, including the image-upload actions — so
  a hand-crafted direct Server Action call, or a request with a
  manipulated URL/query parameter, is rejected exactly the same way a
  Staff click would be, never relying on a hidden button or a client-
  side check alone. Dashboard's "Draft costings" card and "New
  Costing" quick action are only ever fetched inside the `isOwner`
  branch of `src/app/(app)/dashboard/page.tsx` — a Staff-rendered
  Dashboard request never even queries for costing data.

## Authentication & authorization model

- `src/lib/auth/password.ts` — bcrypt hashing (12 rounds).
- `src/lib/auth/session.ts` — signs a JWT containing only `{ userId,
  expiresAt }` (no role — see below) into an httpOnly, `SameSite=Lax`
  cookie.
- `src/lib/auth/dal.ts` — `getCurrentUser()` re-reads the user's role and
  `isActive` flag from the **database** on every call (memoized once per
  request), so a role change or deactivation takes effect immediately
  rather than only after the session cookie expires. `requireUser()` and
  `requireOwner()` build on this and redirect (`/login`,
  `/unauthorized`) when the check fails.
- `src/proxy.ts` (Next 16's renamed `middleware.ts`) does a fast,
  cookie-only "is there a session at all" check before a protected route
  even renders. It intentionally cannot check role (that needs the
  database) — Settings being Owner-only is enforced authoritatively by
  `requireOwner()` inside `src/app/(app)/settings/page.tsx`, not by hiding
  the link in navigation.
- Every Server Action that changes data (`src/app/actions/*.ts`)
  independently re-checks authorization — it does not trust that the UI
  that called it was rendered correctly.

## Known, low-risk dev-tooling advisory

`npm audit` reports 4 high-severity advisories, all inside Prisma CLI's own
bundled MySQL driver (`prisma` → `@prisma/config` → `mysql2`), used only if
you run Prisma CLI commands against MySQL — which this project never does
(PostgreSQL only). It is a `devDependency`, not part of the deployed
runtime bundle. `npm audit fix --force` would downgrade Prisma to 6.19.3,
losing Prisma 7's driver-adapter setup used throughout this codebase; that
trade is not worth it for a transitive, dev-only, unreachable code path.

## Known Phase 5 limitations

- **CSV export is client-side**, same as every earlier phase's export —
  fine at small-shop row counts, not built for very large exports.
- **Reports/lists are not paginated** beyond a reasonable cap, matching
  the same known limitation already documented for Phase 2–4.
- **Actual-vs-Estimate variance only ever compares a genuinely linked
  pair** (`linkedEstimateId`, set explicitly by Owner, never inferred)
  — there is no "closest match" heuristic that could compare two
  unrelated records.
- **No automatic internet/market price fetching** for Costing Settings'
  defaults — every default is a plain Owner-entered number, by
  explicit instruction.
- **Costing Settings changes only affect new Drafts created after the
  change** — an existing Draft or Finalized sheet never gets its
  pricing/GST/rounding silently rewritten by a later Settings edit.

See `PHASE_5_VERIFICATION.md` for the full verification report,
including two real UI bugs found and fixed during live browser
testing (a nested-`<form>` bug and a missing Finalize button for
Draft Estimates), manual reconciliation of real sourced figures, and
end-to-end cleanup/baseline proof. Its "Gap-closure verification pass"
section adds a second round requested after review: a real
diamond-integrated Actual costing (two real polished diamonds, one
`SET` one `RETURNED`, real recognized metal process loss, hand-verified
against direct database reads with zero mismatches), a full
GST+discount+selling-expense+rounding Estimate reconciled line by line,
deep quotation verification (raw server HTML + print media +
unauthenticated-fetch check), an explicit before/after database
snapshot proving zero accounting/stock mutation across every single
Costing action, and a real manipulated-request replay of a captured
Server Action using a Staff session. That pass also found and fixed two
real data-integrity bugs in the (temporary, never-committed) cleanup
tooling — not the product code — that had left orphaned
`MetalStockMovement` and job/receipt `Voucher` rows silently inflating
real ledger/stock figures.

## What's deliberately not built yet

Accounting, Diamond, Jewellery Jobs, and Costing are real, working
business logic. Sale-of-jewellery / invoicing integration, deployment,
and marketplace/e-commerce integration are Phase 6+ and not started.
