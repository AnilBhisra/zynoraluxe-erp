import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { ensurePhase8Masters } from "../prisma/phase8Masters";

// Idempotent Phase 8 master data: the 4200 Inventory Adjustment Gain and
// 5500 Inventory Adjustment Loss accounts. Created only if missing and never
// updated. Deliberately separate from `npm run db:seed`, which also upserts
// the Owner account and would reset a live Owner's password.

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const counts = await ensurePhase8Masters(prisma);
    for (const line of counts.lines) console.log(line);
    console.log(`Phase 8 masters: ${counts.created} created, ${counts.present} already present.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
