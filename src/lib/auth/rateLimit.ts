import "server-only";

import { createHmac, randomUUID } from "crypto";
import { headers } from "next/headers";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { LoginRateLimitBucket } from "@/generated/prisma/enums";

/**
 * Persistent, DB-backed login brute-force protection.
 *
 * Policy (documented here, not just in code, per the V1 acceptance audit):
 *  - ACCOUNT bucket: keyed on the login email alone. Always active, even
 *    when no trustworthy client IP is available, so this is the one
 *    guarantee that never depends on deployment/proxy configuration.
 *  - ACCOUNT_NETWORK bucket: keyed on (email, IP) together. Catches one
 *    attacker hammering one account from one machine with a tighter
 *    effective limit than the broad NETWORK bucket alone would allow.
 *  - NETWORK bucket: keyed on IP alone, with a much higher threshold.
 *    Exists to catch credential stuffing (many different accounts tried
 *    from one IP) without locking out a shared office/NAT connection over
 *    ordinary mixed traffic. Only active when a trusted client-IP header
 *    is configured (see getTrustedClientIp) — otherwise skipped entirely.
 *
 * Every lock is time-bounded (`lockedUntil`), never indefinite, and a
 * failed attempt recorded while a bucket is already locked does not push
 * `lockedUntil` further out — so no account (including the Owner's) can
 * ever be locked out permanently, only for one bounded window at a time.
 *
 * No raw email, IP, or password is ever stored: `keyHash` is an
 * HMAC-SHA256 of the normalized value, keyed with the existing
 * server-only SESSION_SECRET (never a new secret, per the audit's
 * preference for reusing an existing server-only mechanism).
 */

type BucketPolicy = {
  maxAttempts: number;
  windowMs: number;
  lockMs: number;
};

const ACCOUNT_POLICY: BucketPolicy = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
};

const ACCOUNT_NETWORK_POLICY: BucketPolicy = {
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
};

// Deliberately much higher — this bucket is shared by every account tried
// from one IP, including ordinary multi-staff office traffic, so it must
// tolerate normal mixed legitimate use while still catching a real
// credential-stuffing spray.
const NETWORK_POLICY: BucketPolicy = {
  maxAttempts: 30,
  windowMs: 15 * 60 * 1000,
  lockMs: 15 * 60 * 1000,
};

// Bounds how far back a row can go before cleanup considers it garbage,
// regardless of bucket — see cleanupExpiredLoginRateLimits.
const MAX_RELEVANT_WINDOW_MS = Math.max(
  ACCOUNT_POLICY.windowMs,
  ACCOUNT_NETWORK_POLICY.windowMs,
  NETWORK_POLICY.windowMs
);

function getRateLimitSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not set. Copy .env.example to .env and generate one with `openssl rand -base64 32`."
    );
  }
  return secret;
}

// Exported so tests can independently recompute the exact keyHash a given
// email/IP produces, instead of asserting against an unfiltered "whatever
// row happens to be first" query — this is a pure function of its inputs,
// not a secret itself, so exporting it reveals nothing sensitive.
export function hashKey(label: string, value: string): string {
  return createHmac("sha256", getRateLimitSecret()).update(`${label}:${value}`).digest("hex");
}

export function normalizeEmailForRateLimit(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Reads the client IP ONLY from an explicitly-configured, operator-trusted
 * header — never from a default guess like `x-forwarded-for`, which any
 * client can set to an arbitrary value on a request that never passed
 * through a real reverse proxy. Until `TRUSTED_CLIENT_IP_HEADER` is set
 * (a deliberate post-deployment step, once the hosting platform's exact
 * trusted header is known — e.g. a platform-specific single-value header
 * such as `cf-connecting-ip`/`fly-client-ip`/`x-vercel-forwarded-for`, or
 * `x-forwarded-for` if there is exactly one trusted proxy hop in front of
 * the app), this returns null and NETWORK/ACCOUNT_NETWORK bucketing is
 * skipped entirely — the ACCOUNT bucket alone still fully protects every
 * account regardless. When the configured header is a comma-separated
 * list (the `x-forwarded-for` convention), the LAST entry is used, since
 * that is the one the trusted proxy itself appended — everything earlier
 * in the list is client-supplied and untrustworthy.
 */
export async function getTrustedClientIp(): Promise<string | null> {
  const headerName = process.env.TRUSTED_CLIENT_IP_HEADER?.trim();
  if (!headerName) return null;

  const hdrs = await headers();
  const raw = hdrs.get(headerName);
  if (!raw) return null;

  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

type BucketKey = { bucket: LoginRateLimitBucket; keyHash: string; policy: BucketPolicy };

async function bucketsFor(email: string): Promise<BucketKey[]> {
  const normalized = normalizeEmailForRateLimit(email);
  const buckets: BucketKey[] = [
    { bucket: "ACCOUNT", keyHash: hashKey("account", normalized), policy: ACCOUNT_POLICY },
  ];

  const ip = await getTrustedClientIp();
  if (ip) {
    buckets.push({ bucket: "NETWORK", keyHash: hashKey("network", ip), policy: NETWORK_POLICY });
    buckets.push({
      bucket: "ACCOUNT_NETWORK",
      keyHash: hashKey("account_network", `${normalized}|${ip}`),
      policy: ACCOUNT_NETWORK_POLICY,
    });
  }

  return buckets;
}

export type LoginRateLimitStatus =
  | { blocked: false }
  | { blocked: true; retryAfterSeconds: number };

/**
 * Checks whether login should be blocked, BEFORE any password work is
 * done. If the database itself is unreachable, this fails CLOSED (blocks
 * with a short, generic retry-after) rather than silently letting every
 * login through unprotected — a limiter outage must never become an
 * authentication bypass.
 */
export async function checkLoginRateLimit(
  email: string,
  now: Date = new Date()
): Promise<LoginRateLimitStatus> {
  const buckets = await bucketsFor(email);

  let rows;
  try {
    rows = await prisma.loginRateLimit.findMany({
      where: { OR: buckets.map((b) => ({ bucket: b.bucket, keyHash: b.keyHash })) },
    });
  } catch (err) {
    console.error("[login-rate-limit] status lookup failed; blocking as a fail-safe", err);
    return { blocked: true, retryAfterSeconds: 60 };
  }

  let retryAfterSeconds = 0;
  for (const row of rows) {
    if (row.lockedUntil && row.lockedUntil.getTime() > now.getTime()) {
      retryAfterSeconds = Math.max(
        retryAfterSeconds,
        Math.ceil((row.lockedUntil.getTime() - now.getTime()) / 1000)
      );
    }
  }

  return retryAfterSeconds > 0 ? { blocked: true, retryAfterSeconds } : { blocked: false };
}

export type RecordedBucketState = {
  bucket: LoginRateLimitBucket;
  keyHash: string;
  failureCount: number;
  lockedUntil: Date | null;
};

// Referenced by bucket type from inside the SQL below via `EXCLUDED.bucket`
// (the just-attempted row's own bucket column) — this is what lets ONE
// multi-row statement apply different ACCOUNT/NETWORK/ACCOUNT_NETWORK
// thresholds without a per-row policy column in the schema. If a policy
// constant above changes, this CASE must be kept in sync (there are only
// 3 fixed bucket types, so this is a narrow, deliberate coupling, not a
// general mechanism).
function policyCase(field: "maxAttempts" | "windowMs" | "lockMs") {
  // Cast to a concrete numeric type: the raw pg driver sends these as
  // unspecified-type parameters, which Postgres otherwise defaults to
  // `text` inside a bare CASE — breaking `text * interval` arithmetic
  // wherever this is used for windowMs/lockMs.
  return Prisma.sql`(CASE EXCLUDED.bucket
    WHEN 'ACCOUNT' THEN ${ACCOUNT_POLICY[field]}
    WHEN 'NETWORK' THEN ${NETWORK_POLICY[field]}
    ELSE ${ACCOUNT_NETWORK_POLICY[field]}
  END)::bigint`;
}

/**
 * Records one failed login attempt against every applicable bucket
 * (ACCOUNT always; NETWORK and ACCOUNT_NETWORK too, when a trusted IP is
 * available) in a SINGLE database round trip, returning the authoritative
 * post-write state straight from `RETURNING` — never computed
 * app-side/read back separately.
 *
 * This is one `INSERT ... SELECT FROM unnest(...) ... ON CONFLICT DO
 * UPDATE ... RETURNING` statement, deliberately NOT a multi-statement
 * `prisma.$transaction` callback with an explicit `SELECT ... FOR UPDATE`.
 * An earlier, per-bucket version of this function used exactly that
 * interactive-transaction-plus-FOR-UPDATE pattern and was observed to
 * hang under concurrent load against this project's real Supabase
 * transaction-pooler connection string (see src/lib/db/prisma.ts /
 * .env.example) — the exact low-level mechanism of that hang was not
 * conclusively proven, and this comment does not claim more than that.
 * (Separately: the apparent concurrency UNDER-COUNT investigated at the
 * same time turned out to be a Vitest test-timeout/background-write
 * contamination bug, not a defect in the atomic upsert itself — see
 * rateLimit.test.ts's ROOT CAUSE note, and the standalone real-database
 * script that proved 4-way and 50-way concurrent writes land correctly on
 * exactly one row either way.) Regardless of the interactive transaction's
 * exact failure mode, this single-statement design is a strictly simpler
 * one to reason about here: it needs one network round trip instead of
 * several, requires no session-scoped row lock, and Postgres evaluates
 * the whole `INSERT ... ON CONFLICT DO UPDATE` atomically per conflicting
 * row as one implicit statement-level transaction — which is what makes
 * it a safe fit for this project's verified pooled runtime, without
 * depending on interactive-transaction semantics that were observed not
 * to hold up under load. `unnest` lets 1–3 rows be upserted in that one
 * statement instead of one round trip per bucket.
 *
 * For each row, the three SET expressions independently detect: already
 * locked (leave untouched — this is what guarantees no account, including
 * the Owner's, can ever be locked out indefinitely by continued retries
 * during a lock); window genuinely expired relative to THIS call's own
 * `now` (reset to a fresh count of 1); or still within an active window
 * (increment `existing_count + 1`, resetting to a clean 0 right when that
 * increment is the one that trips the lock).
 */
export async function recordLoginFailure(
  email: string,
  now: Date = new Date()
): Promise<RecordedBucketState[]> {
  const buckets = await bucketsFor(email);
  if (buckets.length === 0) return [];

  const ids = buckets.map(() => randomUUID());
  const bucketNames = buckets.map((b) => b.bucket);
  const keyHashes = buckets.map((b) => b.keyHash);

  // Every `${now}` used in arithmetic below goes through this cast: an
  // unspecified-type query parameter mixed into a `<value> - (int *
  // interval)` expression gets resolved by Postgres as `interval`, not
  // `timestamp`, which then fails the `timestamp < interval` comparison
  // one level up — a real bug this cast fixes, found by running this
  // exact statement standalone (see rateLimit.test.ts's root-cause notes).
  const nowParam = Prisma.sql`${now}::timestamp(3)`;
  const windowMsCase = policyCase("windowMs");
  const maxAttemptsCase = policyCase("maxAttempts");
  const lockMsCase = policyCase("lockMs");
  const isWindowStale = Prisma.sql`login_rate_limits."windowStart" < ${nowParam} - (${windowMsCase} * interval '1 millisecond')`;
  const isAlreadyLocked = Prisma.sql`login_rate_limits."lockedUntil" IS NOT NULL AND login_rate_limits."lockedUntil" > ${nowParam}`;

  try {
    const rows = await prisma.$queryRaw<
      Array<{ bucket: LoginRateLimitBucket; keyHash: string; failureCount: number; lockedUntil: Date | null }>
    >(Prisma.sql`
      INSERT INTO login_rate_limits (id, bucket, "keyHash", "failureCount", "windowStart", "lockedUntil", "updatedAt")
      SELECT t.id, t.bucket::"LoginRateLimitBucket", t."keyHash", 1, ${nowParam}, NULL, ${nowParam}
      FROM unnest(${ids}::text[], ${bucketNames}::text[], ${keyHashes}::text[]) AS t(id, bucket, "keyHash")
      ON CONFLICT (bucket, "keyHash") DO UPDATE SET
        "failureCount" = CASE
          WHEN ${isAlreadyLocked} THEN login_rate_limits."failureCount"
          WHEN ${isWindowStale} THEN 1
          WHEN login_rate_limits."failureCount" + 1 >= ${maxAttemptsCase} THEN 0
          ELSE login_rate_limits."failureCount" + 1
        END,
        "windowStart" = CASE
          WHEN ${isAlreadyLocked} THEN login_rate_limits."windowStart"
          WHEN ${isWindowStale} THEN ${nowParam}
          WHEN login_rate_limits."failureCount" + 1 >= ${maxAttemptsCase} THEN ${nowParam}
          ELSE login_rate_limits."windowStart"
        END,
        "lockedUntil" = CASE
          WHEN ${isAlreadyLocked} THEN login_rate_limits."lockedUntil"
          WHEN (
            CASE WHEN ${isWindowStale} THEN 1 ELSE login_rate_limits."failureCount" + 1 END
          ) >= ${maxAttemptsCase}
            THEN ${nowParam} + (${lockMsCase} * interval '1 millisecond')
          ELSE NULL
        END,
        "updatedAt" = ${nowParam}
      RETURNING bucket, "keyHash", "failureCount", "lockedUntil"
    `);

    return rows;
  } catch (err) {
    // Best-effort only: this login attempt has already been rejected by
    // the caller regardless of whether recording it succeeds, so a
    // transient failure here must not throw and break the login response.
    console.error("[login-rate-limit] failed to record a failed attempt", err);
    return [];
  }
}

/**
 * Clears rate-limit state after a successful login. Only the ACCOUNT and
 * ACCOUNT_NETWORK buckets are cleared — the broad NETWORK bucket is left
 * alone deliberately: one successful login doesn't mean a shared IP isn't
 * still being used to attack OTHER accounts.
 */
export async function resetLoginRateLimitOnSuccess(email: string): Promise<void> {
  const normalized = normalizeEmailForRateLimit(email);
  const accountHash = hashKey("account", normalized);
  const ip = await getTrustedClientIp();

  const or: Array<{ bucket: LoginRateLimitBucket; keyHash: string }> = [
    { bucket: "ACCOUNT", keyHash: accountHash },
  ];
  if (ip) {
    or.push({ bucket: "ACCOUNT_NETWORK", keyHash: hashKey("account_network", `${normalized}|${ip}`) });
  }

  try {
    await prisma.loginRateLimit.deleteMany({ where: { OR: or } });
  } catch (err) {
    // A successful login must still proceed even if this best-effort
    // cleanup fails — worst case, stale counters age out via
    // cleanupExpiredLoginRateLimits or simply expire on their own window.
    console.error("[login-rate-limit] failed to reset state after a successful login", err);
  }
}

/**
 * Deletes rate-limit rows that are no longer relevant to any policy: not
 * currently locked, and whose window is older than the longest window any
 * bucket policy uses. Safe to call opportunistically (see the small
 * probabilistic call site in login()) or from a standalone maintenance
 * script — see scripts/cleanup-login-rate-limits.ts.
 */
export async function cleanupExpiredLoginRateLimits(now: Date = new Date()): Promise<number> {
  const staleThreshold = new Date(now.getTime() - MAX_RELEVANT_WINDOW_MS);
  const result = await prisma.loginRateLimit.deleteMany({
    where: {
      windowStart: { lt: staleThreshold },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
  });
  return result.count;
}
