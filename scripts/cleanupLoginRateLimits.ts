// Deliberately the plain `import "dotenv/config"` side-effect form, for
// consistency with every other entry point in this codebase — see the
// comment in src/lib/auth/rateLimit.test.ts for why an explicit
// `config({ quiet: true })` call (which would suppress dotenv's own
// console tip line) is a fragile pattern here: it happened to work in
// this specific file (no sibling import reads env vars at module top
// level), but broke real env loading in a sibling file that does, via
// ES modules' import-hoisting order. Kept uniform and safe rather than
// file-by-file "does it happen to work."
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";

// Standalone maintenance script for the login rate limiter (see
// src/lib/auth/rateLimit.ts) — deletes rows that are no longer locked and
// whose window is older than the longest bucket policy uses, i.e. rows
// with nothing left to protect. Safe to run any time; also invoked
// opportunistically (with low probability, no schedule required) from
// login() itself, so running this manually/via cron is a supplement, not
// a requirement, for a single small-business deployment.
//
// Not importing src/lib/db/prisma.ts here: it starts with `import
// "server-only"`, which throws when required outside Next's own bundler —
// same reason prisma/seed.ts builds its own PrismaClient directly.
const MAX_RELEVANT_WINDOW_MS = 15 * 60 * 1000;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  const now = new Date();
  const staleThreshold = new Date(now.getTime() - MAX_RELEVANT_WINDOW_MS);

  const result = await prisma.loginRateLimit.deleteMany({
    where: {
      windowStart: { lt: staleThreshold },
      OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
    },
  });

  console.log(`Deleted ${result.count} expired login rate-limit row(s).`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
