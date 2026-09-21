import type { PrismaClient } from "../src/generated/prisma/client";
import { SYSTEM_ACCOUNT_CODES } from "../src/lib/accounting/accounts";

// Phase 8 master data, shared by `npm run db:seed` and the production-safe
// `npm run db:seed-phase8-masters`. Created only if missing, never updated —
// same rule as the Phase 7 masters.

export const PHASE8_ACCOUNTS: { code: string; name: string; type: "INCOME" | "EXPENSE" }[] = [
  { code: SYSTEM_ACCOUNT_CODES.INVENTORY_ADJUSTMENT_GAIN, name: "Inventory Adjustment Gain", type: "INCOME" },
  { code: SYSTEM_ACCOUNT_CODES.INVENTORY_ADJUSTMENT_LOSS, name: "Inventory Adjustment Loss", type: "EXPENSE" },
];

export type Phase8MasterCounts = { created: number; present: number; lines: string[] };

export async function ensurePhase8Masters(prisma: PrismaClient): Promise<Phase8MasterCounts> {
  const result: Phase8MasterCounts = { created: 0, present: 0, lines: [] };
  for (const account of PHASE8_ACCOUNTS) {
    const existing = await prisma.account.findUnique({ where: { code: account.code } });
    if (!existing) {
      await prisma.account.create({ data: { ...account, isSystem: true } });
      result.created += 1;
    } else {
      result.present += 1;
    }
    result.lines.push(`  ${existing ? "skip   " : "created"} account ${account.code} ${account.name}`);
  }
  return result;
}
