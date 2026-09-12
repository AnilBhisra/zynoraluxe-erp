// Deliberately the plain `import "dotenv/config"` side-effect form — see
// the comment in src/lib/auth/rateLimit.test.ts for why an explicit
// `config({ quiet: true })` call (tried, to suppress dotenv's own console
// tip line) is unsafe here: ES module imports are hoisted, so a call
// placed after this line would actually run after any later sibling
// import's own top-level code, which can read env vars before dotenv
// populates them. Reverted for correctness.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Prisma CLI (migrate/generate) needs a direct/session connection, not
    // the pooled transaction-mode DATABASE_URL used at runtime — pgbouncer
    // transaction pooling doesn't support what Migrate needs. See
    // src/lib/db/prisma.ts for the runtime client, which uses DATABASE_URL.
    url: env("DIRECT_URL"),
  },
});
