import path from "node:path";

import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    exclude: ["**/node_modules/**", "**/.next/**"],
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
