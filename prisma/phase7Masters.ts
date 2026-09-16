import type { PrismaClient } from "../src/generated/prisma/client";
import { SYSTEM_ACCOUNT_CODES } from "../src/lib/accounting/accounts";

// Phase 7 master data, shared by `npm run db:seed` and the production-safe
// `npm run db:seed-phase7-masters`. Every row is CREATED ONLY IF MISSING and
// never updated, so a re-run can neither duplicate a row nor revert an
// Owner's later edit (a corrected fineness, a renamed or deactivated process).

export const PHASE7_METAL_PURITIES: { metalType: "GOLD" | "ALLOY"; displayName: string; finenessPercent: string }[] = [
  { metalType: "GOLD", displayName: "9K", finenessPercent: "37.500" },
  // Company-owned alloy stock: real weight and cost, zero precious metal.
  { metalType: "ALLOY", displayName: "Copper/Alloy", finenessPercent: "0.000" },
];

export const PHASE7_ACCOUNTS: { code: string; name: string; type: "EXPENSE" }[] = [
  { code: SYSTEM_ACCOUNT_CODES.BROKERAGE_EXPENSE, name: "Brokerage & Commission", type: "EXPENSE" },
];

/** HPHT / Grow is an outsourced issue-return-cost process — no in-house growing module. */
export const PHASE7_DIAMOND_PROCESSES: {
  name: string;
  outputKind: "ROUGH" | "POLISHED";
  defaultRateBasis: "FIXED" | "PER_CARAT" | "PER_PIECE";
  sortOrder: number;
}[] = [
  { name: "4P / Laser", outputKind: "ROUGH", defaultRateBasis: "PER_CARAT", sortOrder: 1 },
  { name: "HPHT / Grow", outputKind: "ROUGH", defaultRateBasis: "PER_CARAT", sortOrder: 2 },
  { name: "Polishing", outputKind: "POLISHED", defaultRateBasis: "PER_CARAT", sortOrder: 3 },
  { name: "Rough Polish", outputKind: "ROUGH", defaultRateBasis: "PER_CARAT", sortOrder: 4 },
];

export type Phase7MasterCounts = { created: number; present: number; lines: string[] };

export async function ensurePhase7Masters(prisma: PrismaClient, ownerId: string): Promise<Phase7MasterCounts> {
  const result: Phase7MasterCounts = { created: 0, present: 0, lines: [] };
  const note = (created: boolean, label: string) => {
    if (created) result.created += 1;
    else result.present += 1;
    result.lines.push(`  ${created ? "created" : "skip   "} ${label}`);
  };

  for (const purity of PHASE7_METAL_PURITIES) {
    const where = { metalType_displayName: { metalType: purity.metalType, displayName: purity.displayName } };
    const existing = await prisma.metalPurity.findUnique({ where });
    if (!existing) {
      await prisma.metalPurity.create({ data: { ...purity, createdByUserId: ownerId } });
    }
    note(!existing, `purity ${purity.metalType} ${purity.displayName}`);
  }

  for (const account of PHASE7_ACCOUNTS) {
    const existing = await prisma.account.findUnique({ where: { code: account.code } });
    if (!existing) {
      await prisma.account.create({ data: { ...account, isSystem: true } });
    }
    note(!existing, `account ${account.code} ${account.name}`);
  }

  for (const process of PHASE7_DIAMOND_PROCESSES) {
    const existing = await prisma.diamondProcess.findUnique({ where: { name: process.name } });
    if (!existing) {
      await prisma.diamondProcess.create({ data: { ...process, createdByUserId: ownerId } });
    }
    note(!existing, `process ${process.name}`);
  }

  return result;
}
