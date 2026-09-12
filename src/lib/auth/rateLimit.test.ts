// Deliberately NOT mocking @/lib/db/prisma here, unlike the rest of this
// suite. The properties under test — real atomic row-locking across
// concurrent requests, and correctness across two independent Prisma
// client connections standing in for two app server instances sharing one
// database — are guarantees the real Postgres engine provides, which a
// mocked client cannot exercise. This file owns the `login_rate_limits`
// table for the duration of the run and wipes it before/after every test.
//
// Needs a real DATABASE_URL, unlike the rest of the suite (which never
// loads .env because everything else mocks @/lib/db/prisma) — load it
// explicitly, matching how prisma/seed.ts does the same thing.
//
// Deliberately the plain `import "dotenv/config"` side-effect form, NOT
// `import { config } from "dotenv"; config({ quiet: true })` — tried the
// quiet-mode call form to suppress dotenv's own console tip line (see
// below) and it broke real env loading here: ES module imports are
// hoisted above all other statements in a file, so a `config({quiet:true})`
// call placed after the `@/lib/db/prisma` import below actually executes
// AFTER that module's own top-level code has already run —
// `src/lib/db/prisma.ts` reads `process.env.DATABASE_URL` at module top
// level (`export const prisma = ... createPrismaClient()`), so it threw
// "DATABASE_URL is not set" before dotenv ever got a chance to populate
// it. `import "dotenv/config"` doesn't have this problem: as an import,
// its side effect (populating process.env) runs during the import phase,
// which Node/ESM guarantees happens before this file's own later imports
// resolve. Reverted for correctness; the console tip line this leaves in
// place is cosmetic only — see the dotenv findings recorded in
// V1_FINAL_ACCEPTANCE.md.
import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";

// This file hits a real remote database over the network (unlike the rest
// of the suite, which is fully mocked) — a handful of these tests make
// dozens of real round trips on purpose (concurrency bursts), so the
// default 5s test timeout is too tight and was, in an earlier version of
// this file, the actual ROOT CAUSE of what first looked like a limiter
// correctness bug. See "ROOT CAUSE" note below.
vi.setConfig({ testTimeout: 30_000 });

let mockIpHeaderValue: string | null = null;
let mockIpHeaderName = "x-forwarded-for";

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (name: string) => (name === mockIpHeaderName ? mockIpHeaderValue : null),
  })),
}));

import {
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginRateLimitOnSuccess,
  cleanupExpiredLoginRateLimits,
  hashKey,
  normalizeEmailForRateLimit,
} from "./rateLimit";

// ---------------------------------------------------------------------------
// ROOT CAUSE (documented here, not just in the turn's report): a concurrent
// 4-failure test was intermittently reading back failureCount=1 instead of
// 4 when the FULL file ran together, but passed when run alone. This was
// NOT a limiter bug:
//
//  1. A separate, minimal, non-vitest tsx script (bypassing this test
//     harness entirely) proved the atomic SQL itself is correct: 4
//     concurrent calls -> exactly one row, failureCount=4; a 50-way burst
//     -> exactly one row, correctly locked, no duplicate/lost rows.
//  2. The actual cause: an earlier version of the "spray across 15
//     accounts" test below made 30 SEQUENTIAL real network round trips in
//     a plain `for` loop, comfortably exceeding vitest's default 5000ms
//     test timeout. Vitest reports a timed-out test as failed and moves on
//     to the next test's lifecycle hooks, but the abandoned test
//     function's own `await` chain keeps running in the background — its
//     still-in-flight database writes (and the next tests' `beforeEach`
//     wipes) then land in whatever order the network happens to deliver
//     them, corrupting what should have been an isolated table between
//     tests.
//  3. Several assertions also queried `findFirst`/`count` without filtering
//     by the exact `keyHash` under test, so once state leaked across test
//     boundaries, those queries could silently pick up an unrelated row.
//
// Fixed by: raising this file's test timeout (`vi.setConfig` above) so no
// test times out and abandons an in-flight write in the first place, by
// parallelizing the spray test's writes, and by scoping every assertion to
// the exact keyHash it cares about (via the exported `hashKey`) instead of
// an unfiltered query. Kept as a permanent regression note.
// ---------------------------------------------------------------------------

const originalTrustedHeaderEnv = process.env.TRUSTED_CLIENT_IP_HEADER;

beforeEach(async () => {
  mockIpHeaderValue = null;
  delete process.env.TRUSTED_CLIENT_IP_HEADER;
  await prisma.loginRateLimit.deleteMany({});
});

afterEach(async () => {
  await prisma.loginRateLimit.deleteMany({});
});

afterAll(() => {
  if (originalTrustedHeaderEnv === undefined) {
    delete process.env.TRUSTED_CLIENT_IP_HEADER;
  } else {
    process.env.TRUSTED_CLIENT_IP_HEADER = originalTrustedHeaderEnv;
  }
});

const T0 = new Date("2026-01-01T00:00:00.000Z");
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

function accountKeyHash(email: string) {
  return hashKey("account", normalizeEmailForRateLimit(email));
}
function networkKeyHash(ip: string) {
  return hashKey("network", ip);
}
function comboKeyHash(email: string, ip: string) {
  return hashKey("account_network", `${normalizeEmailForRateLimit(email)}|${ip}`);
}

/** Exact single-row lookup, scoped to precisely the bucket this test cares
 * about — never an unfiltered findFirst that could silently pick up an
 * unrelated row (see the ROOT CAUSE note above). */
function findRow(bucket: "ACCOUNT" | "NETWORK" | "ACCOUNT_NETWORK", keyHash: string) {
  return prisma.loginRateLimit.findUnique({ where: { bucket_keyHash: { bucket, keyHash } } });
}

describe("per-account bucket", () => {
  it("does not block before the threshold", async () => {
    const email = "ratelimit-account-under@example.com";
    for (let i = 0; i < 4; i++) {
      await recordLoginFailure(email, T0);
    }
    expect(await checkLoginRateLimit(email, T0)).toEqual({ blocked: false });
    expect((await findRow("ACCOUNT", accountKeyHash(email)))?.failureCount).toBe(4);
  });

  it("blocks once the threshold is reached, and unblocks after the lock expires (no real sleeping needed — the clock is injected)", async () => {
    const email = "ratelimit-account-over@example.com";
    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(email, T0);
    }

    const blocked = await checkLoginRateLimit(email, T0);
    expect(blocked.blocked).toBe(true);
    if (blocked.blocked) expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    const justBeforeExpiry = new Date(T0.getTime() + LOCK_MS - 1000);
    expect((await checkLoginRateLimit(email, justBeforeExpiry)).blocked).toBe(true);

    const afterExpiry = new Date(T0.getTime() + LOCK_MS + 1000);
    expect(await checkLoginRateLimit(email, afterExpiry)).toEqual({ blocked: false });
  });

  it("crosses the threshold at exactly the configured attempt count, not one before or after", async () => {
    const email = "ratelimit-exact-threshold@example.com";
    for (let i = 0; i < 4; i++) {
      await recordLoginFailure(email, T0);
      expect((await checkLoginRateLimit(email, T0)).blocked).toBe(false);
    }
    // The 5th attempt is the one that trips it.
    const results = await recordLoginFailure(email, T0);
    expect(results[0].lockedUntil).not.toBeNull();
    expect((await checkLoginRateLimit(email, T0)).blocked).toBe(true);
  });

  it("resets the window only when it has genuinely expired relative to `now` — a slightly-newer timestamp within the same window does not reset it", async () => {
    const email = "ratelimit-no-premature-reset@example.com";
    await recordLoginFailure(email, T0);
    await recordLoginFailure(email, new Date(T0.getTime() + 1000)); // 1s later — newer, but nowhere near expired
    await recordLoginFailure(email, new Date(T0.getTime() + WINDOW_MS - 1000)); // just under the window edge

    const row = await findRow("ACCOUNT", accountKeyHash(email));
    // If a merely-newer timestamp incorrectly reset the window, this would
    // read back as 1 (or 2) instead of a true accumulated 3.
    expect(row?.failureCount).toBe(3);

    // Only once the window has ACTUALLY passed does the next attempt reset.
    const afterRealExpiry = new Date(T0.getTime() + WINDOW_MS + 1000);
    await recordLoginFailure(email, afterRealExpiry);
    const rowAfterExpiry = await findRow("ACCOUNT", accountKeyHash(email));
    expect(rowAfterExpiry?.failureCount).toBe(1);
  });

  it("still tracks and eventually blocks attempts against an email with no matching account (protects against enumeration probing too)", async () => {
    const email = "definitely-does-not-exist@example.com";
    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(email, T0);
    }
    expect((await checkLoginRateLimit(email, T0)).blocked).toBe(true);
  });

  it("does not extend the lock when more failures are recorded while already locked", async () => {
    const email = "ratelimit-no-lock-extension@example.com";
    for (let i = 0; i < 5; i++) {
      await recordLoginFailure(email, T0);
    }
    const firstLock = await findRow("ACCOUNT", accountKeyHash(email));
    expect(firstLock?.lockedUntil).not.toBeNull();

    // Keep hammering it well within the same lock window.
    const stillLockedAt = new Date(T0.getTime() + 5000);
    for (let i = 0; i < 3; i++) {
      await recordLoginFailure(email, stillLockedAt);
    }

    const afterMoreAttempts = await findRow("ACCOUNT", accountKeyHash(email));
    expect(afterMoreAttempts?.lockedUntil?.getTime()).toBe(firstLock?.lockedUntil?.getTime());
    expect(afterMoreAttempts?.failureCount).toBe(0);
  });

  it("keeps two different accounts' buckets fully independent", async () => {
    const emailA = "ratelimit-independent-a@example.com";
    const emailB = "ratelimit-independent-b@example.com";
    for (let i = 0; i < 5; i++) await recordLoginFailure(emailA, T0);

    expect((await checkLoginRateLimit(emailA, T0)).blocked).toBe(true);
    expect((await checkLoginRateLimit(emailB, T0)).blocked).toBe(false);
    expect((await findRow("ACCOUNT", accountKeyHash(emailB)))).toBeNull();
  });
});

describe("network and combined buckets — trusted-IP fallback", () => {
  it("skips NETWORK/ACCOUNT_NETWORK entirely when no trusted IP header is configured, even if a spoofable header is present on the request", async () => {
    mockIpHeaderName = "x-forwarded-for";
    mockIpHeaderValue = "1.2.3.4"; // present on the request, but not trusted
    // TRUSTED_CLIENT_IP_HEADER left unset by beforeEach.

    await recordLoginFailure("ratelimit-no-trusted-ip@example.com", T0);

    const rows = await prisma.loginRateLimit.findMany({});
    expect(rows.map((r) => r.bucket)).toEqual(["ACCOUNT"]);
  });

  it("uses the LAST comma-separated value (the trusted proxy's own appended entry) and ignores a changing, client-spoofable first entry", async () => {
    process.env.TRUSTED_CLIENT_IP_HEADER = "x-forwarded-for";
    mockIpHeaderName = "x-forwarded-for";

    // Same real ("trusted") IP both times, but a DIFFERENT spoofed
    // client-claimed first entry — if the code incorrectly trusted the
    // first entry, these two attempts would land on two different network
    // buckets instead of one.
    mockIpHeaderValue = "9.9.9.9, 10.0.0.5";
    await recordLoginFailure("ratelimit-header-fallback-a@example.com", T0);
    mockIpHeaderValue = "8.8.8.8, 10.0.0.5";
    await recordLoginFailure("ratelimit-header-fallback-b@example.com", T0);

    const trustedRow = await findRow("NETWORK", networkKeyHash("10.0.0.5"));
    expect(trustedRow?.failureCount).toBe(2);
    expect(await findRow("NETWORK", networkKeyHash("9.9.9.9"))).toBeNull();
    expect(await findRow("NETWORK", networkKeyHash("8.8.8.8"))).toBeNull();

    // A genuinely different trusted (last) value must land on a different row.
    mockIpHeaderValue = "9.9.9.9, 10.0.0.6";
    await recordLoginFailure("ratelimit-header-fallback-c@example.com", T0);
    expect((await findRow("NETWORK", networkKeyHash("10.0.0.6")))?.failureCount).toBe(1);
  });

  it("blocks across different accounts hitting the same network before any single account reaches its own threshold", async () => {
    process.env.TRUSTED_CLIENT_IP_HEADER = "x-forwarded-for";
    mockIpHeaderName = "x-forwarded-for";
    mockIpHeaderValue = "203.0.113.9";

    // 30 failed attempts spread across 15 different accounts, 2 each —
    // well under the per-account threshold (5) for every single one, but
    // the shared network bucket's threshold (30) is reached exactly. Run
    // concurrently both to exercise the atomic write under load and to
    // keep this test fast (30 sequential real round trips is what
    // originally blew the test timeout — see the ROOT CAUSE note above).
    await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        Promise.all([
          recordLoginFailure(`spray-account-${i}@example.com`, T0),
          recordLoginFailure(`spray-account-${i}@example.com`, T0),
        ])
      )
    );

    for (let i = 0; i < 15; i++) {
      // No single account is anywhere near its own 5-attempt threshold...
      expect((await checkLoginRateLimit(`spray-account-${i}@example.com`, T0)).blocked).toBe(true);
      // ...it's blocked only because the shared network bucket tripped.
      expect((await findRow("ACCOUNT", accountKeyHash(`spray-account-${i}@example.com`)))?.failureCount).toBe(2);
    }

    const networkRow = await findRow("NETWORK", networkKeyHash("203.0.113.9"));
    expect(networkRow?.lockedUntil).not.toBeNull();
  });

  it("checkLoginRateLimit reports blocked when the combined ACCOUNT_NETWORK bucket alone is locked", async () => {
    process.env.TRUSTED_CLIENT_IP_HEADER = "x-forwarded-for";
    mockIpHeaderName = "x-forwarded-for";
    mockIpHeaderValue = "198.51.100.7";
    const email = "ratelimit-combined-only@example.com";

    // Prime the ACCOUNT_NETWORK row via one real failure, then directly
    // force its lock (narrowly-scoped direct test-data manipulation) to
    // isolate this one bucket's effect on checkLoginRateLimit without also
    // tripping the ACCOUNT bucket via 5 real calls.
    await recordLoginFailure(email, T0);
    const comboHash = comboKeyHash(email, "198.51.100.7");
    const comboRowBefore = await findRow("ACCOUNT_NETWORK", comboHash);
    expect(comboRowBefore).not.toBeNull();
    await prisma.loginRateLimit.update({
      where: { bucket_keyHash: { bucket: "ACCOUNT_NETWORK", keyHash: comboHash } },
      data: { lockedUntil: new Date(T0.getTime() + LOCK_MS) },
    });
    // The ACCOUNT bucket for this email is nowhere near its own threshold.
    const accountRow = await findRow("ACCOUNT", accountKeyHash(email));
    expect(accountRow?.failureCount).toBe(1);

    expect((await checkLoginRateLimit(email, T0)).blocked).toBe(true);
  });
});

describe("reset on successful login", () => {
  it("clears the ACCOUNT and ACCOUNT_NETWORK buckets but leaves the broader NETWORK bucket alone", async () => {
    process.env.TRUSTED_CLIENT_IP_HEADER = "x-forwarded-for";
    mockIpHeaderName = "x-forwarded-for";
    mockIpHeaderValue = "192.0.2.55";
    const email = "ratelimit-reset-on-success@example.com";

    await recordLoginFailure(email, T0);
    await recordLoginFailure(email, T0);
    expect(await findRow("ACCOUNT", accountKeyHash(email))).not.toBeNull();
    expect(await findRow("NETWORK", networkKeyHash("192.0.2.55"))).not.toBeNull();
    expect(await findRow("ACCOUNT_NETWORK", comboKeyHash(email, "192.0.2.55"))).not.toBeNull();

    await resetLoginRateLimitOnSuccess(email);

    expect(await findRow("ACCOUNT", accountKeyHash(email))).toBeNull();
    expect(await findRow("ACCOUNT_NETWORK", comboKeyHash(email, "192.0.2.55"))).toBeNull();
    const networkRow = await findRow("NETWORK", networkKeyHash("192.0.2.55"));
    expect(networkRow?.failureCount).toBe(2); // untouched
    expect(await checkLoginRateLimit(email, T0)).toEqual({ blocked: false });
  });

  it("does not corrupt state when failures and a success race concurrently for the same account", async () => {
    const email = "ratelimit-concurrent-reset@example.com";
    await recordLoginFailure(email, T0); // seed one failure

    await Promise.all([
      recordLoginFailure(email, T0),
      recordLoginFailure(email, T0),
      resetLoginRateLimitOnSuccess(email),
      recordLoginFailure(email, T0),
    ]);

    // Whichever order these actually landed in, the result must be a
    // single, well-formed row (or none) — never a duplicate row, a
    // negative count, or a thrown error propagating out of Promise.all
    // (it already didn't throw, since we got here).
    const rows = await prisma.loginRateLimit.findMany({ where: { bucket: "ACCOUNT", keyHash: accountKeyHash(email) } });
    expect(rows.length).toBeLessThanOrEqual(1);
    if (rows.length === 1) {
      expect(rows[0].failureCount).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(rows[0].failureCount)).toBe(true);
    }
  });
});

describe("concurrency", () => {
  it("never loses an increment when many failures for the same account are recorded concurrently", async () => {
    const email = "ratelimit-concurrent@example.com";
    const CONCURRENT_ATTEMPTS = 4; // stays under the 5-attempt threshold so we can assert the exact count

    const results = await Promise.all(
      Array.from({ length: CONCURRENT_ATTEMPTS }, () => recordLoginFailure(email, T0))
    );

    const row = await findRow("ACCOUNT", accountKeyHash(email));
    expect(row?.failureCount).toBe(CONCURRENT_ATTEMPTS);

    // The RETURNING-derived count each call got back must, as a set, be
    // exactly {1, 2, 3, 4} — every intermediate value actually observed by
    // some caller, none skipped or duplicated — and the LAST one committed
    // must agree with the final stored row.
    const returnedCounts = results.map((r) => r[0].failureCount).sort((a, b) => a - b);
    expect(returnedCounts).toEqual([1, 2, 3, 4]);
    expect(Math.max(...returnedCounts)).toBe(row?.failureCount);
  });

  it("loses no increments across a 40-way concurrent burst, and correctly locks exactly at the configured threshold", async () => {
    const email = "ratelimit-burst@example.com";
    const BURST_SIZE = 40; // > the 5-attempt ACCOUNT threshold, well within the "25-50" required range

    const results = await Promise.all(
      Array.from({ length: BURST_SIZE }, () => recordLoginFailure(email, T0))
    );

    const row = await findRow("ACCOUNT", accountKeyHash(email));
    // Exactly one row — never one row per concurrent caller.
    expect(await prisma.loginRateLimit.count({ where: { bucket: "ACCOUNT", keyHash: accountKeyHash(email) } })).toBe(1);
    // Tripped and locked (reset to 0 at the moment of tripping, per design).
    expect(row?.failureCount).toBe(0);
    expect(row?.lockedUntil).not.toBeNull();
    expect(row?.lockedUntil!.getTime()).toBe(T0.getTime() + LOCK_MS);

    // Every returned count must be a value the row genuinely passed
    // through (1..5) or the post-trip reset value (0) — never anything
    // outside that range, and never negative or fractional.
    const distinctReturned = new Set(results.map((r) => r[0].failureCount));
    for (const v of distinctReturned) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it("stays correct across two independent Prisma connections standing in for two app server instances sharing one database", async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL must be set for this test.");
    const instanceB = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    const email = "ratelimit-multi-instance@example.com";
    try {
      // Seed the row first so both instances race on an UPDATE (not one
      // of them racing an INSERT), which is the scenario that actually
      // needs the row lock.
      await recordLoginFailure(email, T0);

      // "Instance A" uses the module's own `prisma` singleton (already
      // exercised by rateLimit.ts internally, i.e. simulates app server
      // #1); "instance B" is a second, fully independent client and
      // connection pool (simulates app server #2). Both record failures
      // for the exact same account CONCURRENTLY. Stays at 4 total (under
      // the 5-attempt lock threshold) so the assertion below is a plain
      // count check rather than also exercising the lock-and-reset branch.
      await Promise.all([
        recordLoginFailure(email, T0),
        recordLoginFailure(email, T0),
        instanceBRecordFailure(instanceB, email, T0),
      ]);

      const row = await findRow("ACCOUNT", accountKeyHash(email));
      // 1 (seed) + 3 concurrent increments, none lost to a race.
      expect(row?.failureCount).toBe(4);
      expect(row?.lockedUntil).toBeNull();
    } finally {
      await instanceB.$disconnect();
    }
  });
});

// Re-implements just enough of recordLoginFailure's single-statement
// increment against a second, independent PrismaClient — proving the
// atomic `INSERT ... ON CONFLICT DO UPDATE` this relies on is enforced by
// Postgres itself, not by anything process-local, so it holds across two
// separate app server instances (each with its own connection/pool) that
// happen to share one database.
async function instanceBRecordFailure(client: PrismaClient, email: string, now: Date) {
  const { randomUUID } = await import("crypto");
  const keyHash = accountKeyHash(email);

  await client.$executeRaw`
    INSERT INTO login_rate_limits (id, bucket, "keyHash", "failureCount", "windowStart", "lockedUntil", "updatedAt")
    VALUES (${randomUUID()}, 'ACCOUNT'::"LoginRateLimitBucket", ${keyHash}, 1, ${now}, NULL, ${now})
    ON CONFLICT (bucket, "keyHash") DO UPDATE SET
      "failureCount" = login_rate_limits."failureCount" + 1,
      "updatedAt" = ${now}
  `;
}

describe("privacy: no raw email or IP is ever stored", () => {
  it("keyHash never contains the raw email or IP substring", async () => {
    process.env.TRUSTED_CLIENT_IP_HEADER = "x-forwarded-for";
    mockIpHeaderName = "x-forwarded-for";
    mockIpHeaderValue = "198.51.100.200";
    const email = "privacy-check@example.com";

    await recordLoginFailure(email, T0);

    const rows = await prisma.loginRateLimit.findMany({});
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.keyHash).not.toContain("privacy-check");
      expect(row.keyHash).not.toContain("198.51.100.200");
      // A 32-byte HMAC-SHA256 digest, hex-encoded, is always 64 hex chars.
      expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("cleanup of expired rows", () => {
  it("deletes only rows that are both unlocked and past every policy's window, leaving active/locked rows untouched", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const longAgo = new Date(now.getTime() - WINDOW_MS - 60_000);
    const recent = new Date(now.getTime() - 60_000);

    await prisma.loginRateLimit.createMany({
      data: [
        { bucket: "ACCOUNT", keyHash: "expired-unlocked".padEnd(64, "0"), failureCount: 3, windowStart: longAgo, lockedUntil: null },
        { bucket: "ACCOUNT", keyHash: "recent-unlocked".padEnd(64, "0"), failureCount: 2, windowStart: recent, lockedUntil: null },
        { bucket: "ACCOUNT", keyHash: "expired-but-still-locked".padEnd(64, "0"), failureCount: 5, windowStart: longAgo, lockedUntil: new Date(now.getTime() + 60_000) },
        { bucket: "ACCOUNT", keyHash: "long-expired-lock".padEnd(64, "0"), failureCount: 5, windowStart: longAgo, lockedUntil: new Date(longAgo.getTime() + 1000) },
      ],
    });

    const deletedCount = await cleanupExpiredLoginRateLimits(now);

    const remaining = await prisma.loginRateLimit.findMany({ orderBy: { keyHash: "asc" } });
    const remainingKeys = remaining.map((r) => r.keyHash.replace(/0+$/, ""));
    expect(remainingKeys.sort()).toEqual(["expired-but-still-locked", "recent-unlocked"].sort());
    expect(deletedCount).toBe(2);
  });

  it("never deletes a row with an active (not-yet-expired) window, locked or not", async () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    const active = new Date(now.getTime() - 60_000); // well within the 15-minute window

    await prisma.loginRateLimit.createMany({
      data: [
        { bucket: "ACCOUNT", keyHash: "active-unlocked".padEnd(64, "0"), failureCount: 2, windowStart: active, lockedUntil: null },
        { bucket: "ACCOUNT", keyHash: "active-locked".padEnd(64, "0"), failureCount: 0, windowStart: active, lockedUntil: new Date(now.getTime() + LOCK_MS) },
      ],
    });

    const deletedCount = await cleanupExpiredLoginRateLimits(now);

    expect(deletedCount).toBe(0);
    expect(await prisma.loginRateLimit.count({})).toBe(2);
  });
});
