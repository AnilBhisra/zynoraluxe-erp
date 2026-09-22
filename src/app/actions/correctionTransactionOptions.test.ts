import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CORRECTION_TRANSACTION_OPTIONS } from "@/lib/corrections/types";

/**
 * The production revaluation on 2026-09-22 was rolled back because the posting
 * transaction ran past Prisma's 5-second interactive default against a remote
 * database. These tests hold the fix in place: the values themselves, and the
 * fact that EVERY correction posting and reversal path passes them.
 */
const ACTIONS = path.join(process.cwd(), "src/app/actions/corrections.ts");
const REVERSAL_SCRIPT = path.join(process.cwd(), "scripts/reverseCorrectionBatch.ts");

function read(file: string) {
  return fs.readFileSync(file, "utf8");
}

describe("CORRECTION_TRANSACTION_OPTIONS", () => {
  it("allows a transaction far longer than Prisma's 5-second default", () => {
    expect(CORRECTION_TRANSACTION_OPTIONS.timeout).toBe(30_000);
    expect(CORRECTION_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(5_000);
  });

  it("waits for a connection rather than failing instantly under load", () => {
    expect(CORRECTION_TRANSACTION_OPTIONS.maxWait).toBe(15_000);
    expect(CORRECTION_TRANSACTION_OPTIONS.maxWait).toBeLessThan(CORRECTION_TRANSACTION_OPTIONS.timeout);
  });
});

describe("every correction transaction uses the shared options", () => {
  it("passes them at every $transaction call in the correction actions", () => {
    const source = read(ACTIONS);
    const calls = source.split("prisma.$transaction(").length - 1;
    expect(calls).toBeGreaterThanOrEqual(4);

    // Each call must name the constant before the next one begins, so a new
    // call site cannot quietly inherit the old 5-second default.
    const segments = source.split("prisma.$transaction(").slice(1);
    for (const [index, segment] of segments.entries()) {
      const upToNextCall = segment.split("prisma.$transaction(")[0];
      expect(
        upToNextCall.includes("CORRECTION_TRANSACTION_OPTIONS"),
        `transaction ${index + 1} in corrections.ts does not pass CORRECTION_TRANSACTION_OPTIONS`
      ).toBe(true);
    }
  });

  it("passes them in the batch reversal script", () => {
    const source = read(REVERSAL_SCRIPT);
    expect(source).toContain("prisma.$transaction(");
    expect(source).toContain("CORRECTION_TRANSACTION_OPTIONS");
  });

  it("keeps the values in one place — no literal timeouts at the call sites", () => {
    for (const file of [ACTIONS, REVERSAL_SCRIPT]) {
      const source = read(file);
      expect(source).not.toMatch(/timeout:\s*\d/);
      expect(source).not.toMatch(/maxWait:\s*\d/);
    }
  });
});

describe("failure diagnostics", () => {
  const source = read(ACTIONS);

  it("recognises Prisma's transaction-timeout code and says nothing was saved", () => {
    expect(source).toContain('"P2028"');
    expect(source).toMatch(/rolled back and nothing was saved/i);
  });

  it("logs the context needed to diagnose a failure", () => {
    for (const field of ["operation", "entityType", "batchCode", "batchStep", "errorName", "prismaCode"]) {
      expect(source, `diagnostics do not log ${field}`).toContain(`${field}:`);
    }
  });

  it("never logs a connection string, credential, cookie or request body", () => {
    const logged = source.slice(source.indexOf("function reportCorrectionFailure"), source.indexOf("export type CorrectionFormState") + 1);
    for (const secret of ["DATABASE_URL", "DIRECT_URL", "password", "cookie", "formData", "headers", "process.env"]) {
      expect(logged.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it("keeps the generic message for anything that is not a timeout", () => {
    expect(source).toContain("Could not post this correction. Please try again.");
    expect(source).toContain("Could not approve this correction. Please try again.");
  });
});
