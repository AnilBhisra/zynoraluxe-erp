import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Phase 8B downstream-consistency fix: `adjustFinishedJewelleryStock`,
 * `createActualCostSheet` and `refreshActualCostSheetFromSource` now call
 * into `carryingFinishedPieceCost(s)`, which replays the source purity's
 * ledger when it carries an active revaluation — extra round-trips inside
 * the SAME interactive transaction that previously did none. The corrections
 * engine already lost a production revaluation once (2026-09-22) to exactly
 * this shape of defect: a transaction that quietly grew past Prisma's
 * 5-second interactive default over a remote pooled connection. This test
 * holds the fix in place for these three call sites, the same way
 * correctionTransactionOptions.test.ts holds it for the corrections engine.
 */
const FINISHED_SALES_ACTIONS = path.join(process.cwd(), "src/app/actions/finishedSales.ts");
const COSTING_ACTIONS = path.join(process.cwd(), "src/app/actions/costing.ts");
const DIAMOND_ACTIONS = path.join(process.cwd(), "src/app/actions/diamond.ts");

function read(file: string) {
  return fs.readFileSync(file, "utf8");
}

/** Extracts one exported function's source body by name, up to the next
 * top-level `export` (or end of file) — good enough for these action files,
 * whose functions are all top-level and blank-line separated. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport ", start + 1);
  return next === -1 ? source.slice(start) : source.slice(start, next);
}

function assertHasTimeoutPast5s(source: string, name: string) {
  const body = functionBody(source, name);
  const match = body.match(/timeout:\s*(\d+)/);
  expect(match, `${name} does not set an explicit transaction timeout`).not.toBeNull();
  expect(Number(match![1])).toBeGreaterThan(5_000);
}

describe("write paths that now replay carrying cost inside their transaction", () => {
  it("adjustFinishedJewelleryStockAction's transaction allows well past the 5s default", () => {
    assertHasTimeoutPast5s(read(FINISHED_SALES_ACTIONS), "adjustFinishedJewelleryStockAction");
  });

  it("createActualCostingAction's transaction allows well past the 5s default", () => {
    assertHasTimeoutPast5s(read(COSTING_ACTIONS), "createActualCostingAction");
  });

  it("refreshActualCostingAction's transaction allows well past the 5s default", () => {
    assertHasTimeoutPast5s(read(COSTING_ACTIONS), "refreshActualCostingAction");
  });

  it("createFinishedJewellerySaleAction (unchanged this session) still keeps its own allowance", () => {
    assertHasTimeoutPast5s(read(FINISHED_SALES_ACTIONS), "createFinishedJewellerySaleAction");
  });
});

describe("rough parcel issue and cancel take row locks and split rows inside their transaction", () => {
  it("issueRoughAction allows well past the 5s default", () => {
    assertHasTimeoutPast5s(read(DIAMOND_ACTIONS), "issueRoughAction");
  });

  it("cancelDiamondJobAction allows well past the 5s default", () => {
    assertHasTimeoutPast5s(read(DIAMOND_ACTIONS), "cancelDiamondJobAction");
  });
});
