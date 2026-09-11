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
