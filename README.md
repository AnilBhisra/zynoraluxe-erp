# ZYNORALUXE Jewellery ERP

Phase 1 foundation: project setup, database foundation, login, Owner/Staff
roles, dashboard, navigation, responsive layout, and basic company settings.

Full Phase 1–6 scope is defined in
`../ZYNORALUXE_JEWELLERY_ERP_MASTER_PLAN.md` (the locked source of truth).
This build implements **Phase 1 only** — Accounting, Diamond, Jewellery Jobs
and Costing are route foundations, not working business logic.

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
npm run db:seed             # creates the first Owner account from .env
```

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

## Database foundation (Phase 1 only)

Two tables, defined in `prisma/schema.prisma`:

- **`users`** — id, email (unique), name, `passwordHash`, `role`
  (`OWNER` | `STAFF`), `isActive`, `createdAt`/`updatedAt`.
- **`company_settings`** — a single row (fixed id `"default"`, enforced at
  the application layer since Version 1 supports exactly one company):
  company name, address, phone, email, GST number, default currency,
  financial year start (month/day), plus `updatedByUserId` and
  `createdAt`/`updatedAt` as audit metadata.

Phase 2–5 tables (parties, transactions, rough/polished stock, jewellery
jobs, costing) are intentionally **not** created yet. When they are, any
money/carat/weight column must use Prisma's `Decimal` type (PostgreSQL
`NUMERIC`), never `Float` — see the comment at the top of `schema.prisma`.

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
