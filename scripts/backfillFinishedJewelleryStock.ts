import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";

// Idempotent Phase 6 backfill: any FinishedJewellery output that predates
// this phase (created before the PRODUCED_IN movement was added inside
// receiveFinishedJewellery) needs exactly one PRODUCED_IN stock movement
// to enter the ledger. Safe to run any number of times — an output that
// already has a PRODUCED_IN movement is skipped, never double-counted.
//
// Not importing src/lib/db/prisma.ts here: it starts with `import
// "server-only"`, which throws when required outside Next's own bundler —
// same reason prisma/seed.ts and the other standalone scripts in this
// directory build their own PrismaClient directly.

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  const outputs = await prisma.finishedJewellery.findMany({
    include: {
      job: true,
      purity: true,
      stockMovements: { where: { type: "PRODUCED_IN" }, take: 1 },
    },
  });

  const missing = outputs.filter((o) => o.stockMovements.length === 0);

  console.log(`Found ${outputs.length} finished jewellery output(s); ${missing.length} missing a PRODUCED_IN movement.`);

  for (const output of missing) {
    const inventoryCost = (
      Number(output.metalCost) + Number(output.diamondCost) + Number(output.labourAllocated)
    ).toFixed(2);

    await prisma.finishedJewelleryStockMovement.create({
      data: {
        type: "PRODUCED_IN",
        finishedJewelleryId: output.id,
        pieces: output.quantity,
        costValue: inventoryCost,
        finishedCodeSnapshot: output.finishedCode,
        jewelleryTypeSnapshot: output.jewelleryType,
        metalTypeSnapshot: output.metalType,
        purityDisplayNameSnapshot: output.purity.displayName,
        netMetalWeightSnapshot: output.netMetalWeight,
        fineMetalWeightSnapshot: output.fineMetalWeight,
        totalCaratSnapshot: 0,
        jobCodeSnapshot: output.job.jobCode,
        sourceDocument: `Backfill for ${output.finishedCode}`,
        createdByUserId: output.createdByUserId,
      },
    });
    console.log(`  backfilled ${output.finishedCode} — cost ${inventoryCost}`);
  }

  console.log(`Backfill complete. ${missing.length} row(s) created.`);
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
