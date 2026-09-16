import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";

// Idempotent Phase 7 master data: the 9K Gold purity (37.5% fine) and the
// Company Copper/Alloy purity (0% fine — real weight and cost, no precious
// metal). Every row is CREATED ONLY IF MISSING and never updated, so a
// re-run can neither duplicate a row nor revert an Owner's edit.
//
// Deliberately separate from `npm run db:seed`: that script also upserts
// the Owner account from OWNER_EMAIL/OWNER_PASSWORD, which would reset a
// live Owner's password. This script touches nothing but MetalPurity.
//
// Not importing src/lib/db/prisma.ts: it starts with `import "server-only"`,
// which throws outside Next's bundler — same reason as the other scripts here.

const PHASE7_PURITIES: { metalType: "GOLD" | "ALLOY"; displayName: string; finenessPercent: string }[] = [
  { metalType: "GOLD", displayName: "9K", finenessPercent: "37.500" },
  { metalType: "ALLOY", displayName: "Copper/Alloy", finenessPercent: "0.000" },
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  const owner = await prisma.user.findFirst({ where: { role: "OWNER" }, orderBy: { createdAt: "asc" } });
  if (!owner) {
    throw new Error("No Owner account exists yet — run `npm run db:seed` on a fresh database first.");
  }

  let created = 0;
  for (const purity of PHASE7_PURITIES) {
    const existing = await prisma.metalPurity.findUnique({
      where: { metalType_displayName: { metalType: purity.metalType, displayName: purity.displayName } },
    });
    if (existing) {
      console.log(`  skip ${purity.metalType} ${purity.displayName} — already present (${existing.finenessPercent}% fine)`);
      continue;
    }
    await prisma.metalPurity.create({
      data: {
        metalType: purity.metalType,
        displayName: purity.displayName,
        finenessPercent: purity.finenessPercent,
        createdByUserId: owner.id,
      },
    });
    created += 1;
    console.log(`  created ${purity.metalType} ${purity.displayName} (${purity.finenessPercent}% fine)`);
  }

  console.log(`Phase 7 masters ready: ${created} created, ${PHASE7_PURITIES.length - created} already present.`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
