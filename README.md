# ZYNORALUXE Jewellery ERP

Phase 1: project setup, database foundation, login, Owner/Staff roles,
dashboard, navigation, responsive layout, basic company settings.
Phase 2: a full double-entry Accounting module — Parties, Transactions
(Purchase/Sale/Payment Given/Payment Received/Expense), Ledger, Reports,
GST, and Dashboard integration.
Phase 3 (this branch, `phase-3-diamond`): Rough-to-Polished Diamond
Manufacturing — Rough purchase/stock, Issue Rough to Karigar, Cutting-
Polishing Jobs, Receive Polished (yield/loss, multi-output), Polished
Stock, all fully integrated into the Phase 2 accounting engine.

Full Phase 1–6 scope is defined in
`../ZYNORALUXE_JEWELLERY_ERP_MASTER_PLAN.md` (the locked source of truth).
This build implements **Phase 1 + Phase 2 + Phase 3 only** — Jewellery
Jobs and Costing are still route foundations, not working business logic.
See `PHASE_2_VERIFICATION.md` and `PHASE_3_VERIFICATION.md` for the
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

Phase 4–5 tables (jewellery jobs, costing) are intentionally **not**
created yet.

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

## What's deliberately not built yet

Accounting and Diamond are real, working business logic. Jewellery Jobs
and Costing (`/jewellery-jobs`, `/costing`) are still route foundations
only — each renders a page explaining which Phase will implement it. No
jewellery-job transactions or costing calculations exist yet, real or
fake.
