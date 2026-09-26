import path from "node:path";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const ALWAYS_EXCLUDED = ["**/node_modules/**", "**/.next/**"];

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    exclude: ALWAYS_EXCLUDED,
    // Real-database suites (*.db.test.ts) share one isolated test database and
    // some clear whole tables, so two of them running at once would corrupt
    // each other. They run in their own project, one file at a time; every
    // other test file still runs in parallel exactly as before.
    projects: [
      {
        extends: true,
        test: { name: "unit", exclude: [...ALWAYS_EXCLUDED, "**/*.db.test.ts"] },
      },
      {
        extends: true,
        test: {
          name: "db",
          include: ["**/*.db.test.ts"],
          exclude: ALWAYS_EXCLUDED,
          fileParallelism: false,
          // Refuses any database but the isolated test one, and clears leftover diamond rows.
          globalSetup: ["./test/setup/dbGlobalSetup.ts"],
        },
      },
    ],
  },
  resolve: {
    alias: {
      // The real `server-only` package throws when a bundler resolves the
      // "browser" condition, which Vite's jsdom test environment does. This
      // no-op stub keeps the server/client boundary marker harmless in tests.
      "server-only": path.resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
});
