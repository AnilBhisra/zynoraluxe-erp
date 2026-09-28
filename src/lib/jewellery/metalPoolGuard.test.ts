import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { METAL_POOL_EFFECT, type MetalStockMovementKind } from "./metalMath";

/**
 * The database guard zl_guard_usable_metal_stock (migration
 * 20261004090000_karigar_metal_custody) re-sums usable stock in SQL. If its
 * CASE ever disagreed with METAL_POOL_EFFECT, the guard would refuse a valid
 * issue or allow an overdraw — so the two are held equal here.
 */
describe("usable-stock guard matches METAL_POOL_EFFECT", () => {
  const sql = readFileSync(join(process.cwd(), "prisma/migrations/20261004090000_karigar_metal_custody/migration.sql"), "utf8");
  const fn = sql.slice(sql.indexOf("FUNCTION zl_guard_usable_metal_stock"), sql.indexOf("CREATE TRIGGER zl_guard_usable_metal_stock"));
  const sqlEffect = new Map([...fn.matchAll(/WHEN '([A-Z_]+)' THEN (-?1)/g)].map((m) => [m[1], Number(m[2])]));

  it("gives every movement type the same usable-pool sign", () => {
    for (const [type, effect] of Object.entries(METAL_POOL_EFFECT) as [MetalStockMovementKind, { usable: number }][]) {
      expect({ type, sign: sqlEffect.get(type) ?? 0 }).toEqual({ type, sign: effect.usable });
    }
    for (const type of sqlEffect.keys()) expect(type in METAL_POOL_EFFECT).toBe(true);
  });

  it("guards exactly the movement types that take metal out of usable stock", () => {
    const outgoing = (Object.entries(METAL_POOL_EFFECT) as [MetalStockMovementKind, { usable: number }][]).filter(([, e]) => e.usable < 0).map(([t]) => t).sort();
    const guarded = [...(/WHEN \(NEW\.type::text IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? "").matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(guarded).toEqual(outgoing);
  });
});
