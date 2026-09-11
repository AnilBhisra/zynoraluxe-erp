import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Static regression guard: `SUPABASE_SECRET_KEY` (and the module that
 * reads it) must never be reachable from a "use client" file — that's
 * the difference between "server-only, never in a bundle" and "quietly
 * shipped to the browser". This scans real source files on disk rather
 * than mocking anything, so it catches a future accidental import
 * regardless of which component introduces it.
 */

const SRC_DIR = path.resolve(__dirname, "../../..", "src");

function listFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "node_modules") return [];
      return listFilesRecursive(full);
    }
    if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      return [full];
    }
    return [];
  });
}

function isClientFile(source: string): boolean {
  const firstStatement = source.trimStart().split("\n")[0].trim();
  return firstStatement === '"use client";' || firstStatement === "'use client';";
}

/** True if every import of the given module in this source is a
 * type-only import (`import type { X } from "..."`) — those are erased
 * at compile time and never reach the browser bundle. */
function importsAreTypeOnly(source: string, modulePath: string): boolean {
  const importLineRegex = new RegExp(`^import\\s+(.*)\\s+from\\s+["']${modulePath}["'];?$`, "gm");
  let match: RegExpExecArray | null;
  let sawAny = false;
  while ((match = importLineRegex.exec(source)) !== null) {
    sawAny = true;
    const clause = match[1].trim();
    if (!clause.startsWith("type ")) return false;
  }
  return sawAny ? true : true; // no import at all also passes trivially
}

describe("SUPABASE_SECRET_KEY / diamondMedia server-only boundary", () => {
  const allFiles = listFilesRecursive(SRC_DIR);
  const clientFiles = allFiles.filter((f) => isClientFile(fs.readFileSync(f, "utf8")));

  it("scanned at least one real 'use client' file (sanity check that this test isn't vacuous)", () => {
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it("no 'use client' file references the literal env var name SUPABASE_SECRET_KEY", () => {
    const offenders = clientFiles.filter((f) => fs.readFileSync(f, "utf8").includes("SUPABASE_SECRET_KEY"));
    expect(offenders).toEqual([]);
  });

  it("no 'use client' file imports a runtime value (only types) from src/lib/storage/diamondMedia", () => {
    const offenders = clientFiles.filter((f) => {
      const source = fs.readFileSync(f, "utf8");
      return !importsAreTypeOnly(source, "@/lib/storage/diamondMedia");
    });
    expect(offenders).toEqual([]);
  });

  it("no 'use client' file imports a runtime value (only types) from src/lib/storage/jewelleryMedia", () => {
    const offenders = clientFiles.filter((f) => {
      const source = fs.readFileSync(f, "utf8");
      return !importsAreTypeOnly(source, "@/lib/storage/jewelleryMedia");
    });
    expect(offenders).toEqual([]);
  });

  it("diamondMedia.ts itself is marked server-only", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "diamondMedia.ts"), "utf8");
    expect(source.trimStart().startsWith('import "server-only";')).toBe(true);
  });

  it("jewelleryMedia.ts itself is marked server-only", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "jewelleryMedia.ts"), "utf8");
    expect(source.trimStart().startsWith('import "server-only";')).toBe(true);
  });
});
