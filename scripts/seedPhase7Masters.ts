import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { ensurePhase7Masters } from "../prisma/phase7Masters";

// Idempotent Phase 7 master data: the 9K Gold purity (37.5% fine), the
// Company Copper/Alloy purity (0% fine), the 5400 Brokerage & Commission
// account, and the Manufacturer processes (4P / Laser, HPHT / Grow,
// Polishing, Rough Polish). Every row is CREATED ONLY IF MISSING and never
// updated, so a re-run can neither duplicate a row nor revert an Owner's edit.
//
// Deliberately separate from `npm run db:seed`: that script also upserts
// the Owner account from OWNER_EMAIL/OWNER_PASSWORD, which would reset a
// live Owner's password. This script touches only the rows listed above.
//
// Not importing src/lib/db/prisma.ts: it starts with `import "server-only"`,
// which throws outside Next's bundler — same reason as the other scripts here.

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

  const result = await ensurePhase7Masters(prisma, owner.id);
  for (const line of result.lines) console.log(line);
  console.log(`Phase 7 masters ready: ${result.created} created, ${result.present} already present.`);
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
