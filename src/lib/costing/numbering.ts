import type { Prisma } from "@/generated/prisma/client";

import { getFinancialYearLabel } from "@/lib/accounting/financialYear";

/**
 * Allocates the next human-readable costing number for the financial year
 * containing `date`, atomically — the same upsert-based, race-safe pattern
 * as src/lib/accounting/numbering.ts's nextVoucherNumber. MUST be called
 * with the same transaction client that inserts the dependent CostSheet
 * row, so the increment and the insert commit or roll back together.
 */
export async function nextCostingNumber(
  tx: Prisma.TransactionClient,
  date: Date,
  fyStartMonth: number,
  fyStartDay: number
): Promise<string> {
  const financialYearLabel = getFinancialYearLabel(date, fyStartMonth, fyStartDay);
  const sequence = await tx.costingSequence.upsert({
    where: { financialYearLabel },
    create: { financialYearLabel, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });
  const padded = String(sequence.lastNumber).padStart(4, "0");
  return `CST/${financialYearLabel}/${padded}`;
}
