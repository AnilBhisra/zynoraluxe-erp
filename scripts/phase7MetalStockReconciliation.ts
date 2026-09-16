import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { METAL_POOL_EFFECT, type MetalStockMovementKind } from "../src/lib/jewellery/metalMath";

// READ-ONLY reconciliation report for the Phase 7 metal-stock fix
// (PHASE_7_CURRENT_STATE_AUDIT.md §4.9 / §4.10). It writes nothing.
//
// Before Phase 7 both balance readers treated CONSUMED_OUT as an outflow —
// deducting fine weight and cost a second time after ISSUE_OUT had already
// removed them — and SCRAP_RETURN_IN re-entered issuable stock while its
// cost sat in 1310. This prints, per metal + purity:
//
//   old      what the app used to show
//   usable   the corrected issuable pool (1300 backs it)
//   scrap    the separate scrap pool (1310 backs it)
//
// and compares the totals with the general ledger. A negative usable gross
// weight means scrap was previously re-issued as ordinary stock, and needs
// an Owner-authorized adjustment — the script only reports it.

const ACCOUNT_METAL_INVENTORY = "1300";
const ACCOUNT_SCRAP_INVENTORY = "1310";

type Totals = { gross: number; fine: number; cost: number };
const zero = (): Totals => ({ gross: 0, fine: 0, cost: 0 });
const money = (n: number) => n.toFixed(2);
const weight = (n: number) => n.toFixed(3);

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  const [purities, movements] = await Promise.all([
    prisma.metalPurity.findMany({ orderBy: [{ metalType: "asc" }, { displayName: "asc" }] }),
    prisma.metalStockMovement.findMany({
      select: { type: true, purityId: true, grossWeight: true, fineWeight: true, costValue: true },
    }),
  ]);

  const OLD_OUT_TYPES = new Set(["ISSUE_OUT", "CONSUMED_OUT", "ADJUSTMENT_OUT"]);
  const byPurity = new Map<string, { old: Totals; usable: Totals; scrap: Totals }>();
  for (const purity of purities) byPurity.set(purity.id, { old: zero(), usable: zero(), scrap: zero() });

  for (const m of movements) {
    const bucket = byPurity.get(m.purityId);
    if (!bucket) continue;
    const gross = Number(m.grossWeight);
    const fine = Number(m.fineWeight);
    const cost = Number(m.costValue);

    const oldSign = OLD_OUT_TYPES.has(m.type) ? -1 : 1;
    bucket.old.gross += gross * oldSign;
    bucket.old.fine += fine * oldSign;
    bucket.old.cost += cost * oldSign;

    const effect = METAL_POOL_EFFECT[m.type as MetalStockMovementKind];
    if (!effect) continue;
    for (const [pool, sign] of [
      ["usable", effect.usable],
      ["scrap", effect.scrap],
    ] as const) {
      if (sign === 0) continue;
      const target = pool === "usable" ? bucket.usable : bucket.scrap;
      target.gross += gross * sign;
      target.fine += fine * sign;
      target.cost += cost * sign;
    }
  }

  const warnings: string[] = [];
  let usableCostTotal = 0;
  let scrapCostTotal = 0;

  console.log("Metal stock — old reading vs corrected pools (read-only)\n");
  for (const purity of purities) {
    const bucket = byPurity.get(purity.id)!;
    const touched = [bucket.old, bucket.usable, bucket.scrap].some((t) => t.gross !== 0 || t.fine !== 0 || t.cost !== 0);
    if (!touched) continue;
    usableCostTotal += bucket.usable.cost;
    scrapCostTotal += bucket.scrap.cost;

    console.log(`${purity.metalType} · ${purity.displayName}`);
    console.log(`  old     gross ${weight(bucket.old.gross)}g  fine ${weight(bucket.old.fine)}g  cost ${money(bucket.old.cost)}`);
    console.log(`  usable  gross ${weight(bucket.usable.gross)}g  fine ${weight(bucket.usable.fine)}g  cost ${money(bucket.usable.cost)}`);
    console.log(`  scrap   gross ${weight(bucket.scrap.gross)}g  fine ${weight(bucket.scrap.fine)}g  cost ${money(bucket.scrap.cost)}`);

    if (bucket.usable.gross < 0 || bucket.usable.fine < 0 || bucket.usable.cost < 0) {
      warnings.push(
        `${purity.metalType} ${purity.displayName}: usable pool is negative (${weight(bucket.usable.gross)}g / ${money(bucket.usable.cost)}) — scrap was most likely re-issued as ordinary stock before Phase 7. Needs an Owner-authorized adjustment.`
      );
    }
  }

  const ledgerRows = await prisma.journalEntry.findMany({
    where: { account: { code: { in: [ACCOUNT_METAL_INVENTORY, ACCOUNT_SCRAP_INVENTORY] } } },
    select: { debit: true, credit: true, account: { select: { code: true } } },
  });
  const ledger = { [ACCOUNT_METAL_INVENTORY]: 0, [ACCOUNT_SCRAP_INVENTORY]: 0 } as Record<string, number>;
  for (const row of ledgerRows) ledger[row.account.code] += Number(row.debit) - Number(row.credit);

  console.log("\nStock vs general ledger");
  console.log(`  usable pools  ${money(usableCostTotal)}   1300 Metal Inventory        ${money(ledger[ACCOUNT_METAL_INVENTORY])}`);
  console.log(`  scrap pools   ${money(scrapCostTotal)}   1310 Scrap Metal Inventory  ${money(ledger[ACCOUNT_SCRAP_INVENTORY])}`);

  const metalGap = usableCostTotal - ledger[ACCOUNT_METAL_INVENTORY];
  const scrapGap = scrapCostTotal - ledger[ACCOUNT_SCRAP_INVENTORY];
  if (Math.abs(metalGap) >= 0.005) warnings.push(`Usable metal pools differ from 1300 by ${money(metalGap)}.`);
  if (Math.abs(scrapGap) >= 0.005) warnings.push(`Scrap pools differ from 1310 by ${money(scrapGap)}.`);

  if (warnings.length === 0) {
    console.log("\nNo divergence found. Nothing to correct.");
  } else {
    console.log("\nReview needed:");
    for (const warning of warnings) console.log(`  - ${warning}`);
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
