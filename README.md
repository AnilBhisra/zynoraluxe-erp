# ZYNORALUXE Jewellery ERP

Phase 1: project setup, database foundation, login, Owner/Staff roles,
dashboard, navigation, responsive layout, basic company settings.
Phase 2 (this branch, `phase-2-accounting`): a full double-entry Accounting
module — Parties, Transactions (Purchase/Sale/Payment Given/Payment
Received/Expense), Ledger, Reports, GST, and Dashboard integration.

Full Phase 1–6 scope is defined in
`../ZYNORALUXE_JEWELLERY_ERP_MASTER_PLAN.md` (the locked source of truth).
This build implements **Phase 1 + Phase 2 only** — Diamond, Jewellery Jobs
and Costing are still route foundations, not working business logic. See
`PHASE_2_VERIFICATION.md` for the detailed verification report.

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

Phase 3–5 tables (rough/polished stock, jewellery jobs, costing) are
intentionally **not** created yet.

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

Accounting, Diamond, Jewellery Jobs and Costing are route foundations only
(`/accounting`, `/diamond`, `/jewellery-jobs`, `/costing`) — each renders a
page explaining which Phase will implement it. No transactions, stock
movements, or costing calculations exist yet, real or fake.
