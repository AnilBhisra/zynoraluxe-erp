import type { Prisma } from "@/generated/prisma/client";
import type { DiamondSequenceType } from "@/generated/prisma/enums";

const PREFIX_BY_TYPE: Record<DiamondSequenceType, string> = {
  ROUGH_LOT: "ZL-RL",
  ROUGH_PIECE: "ZL-RGH",
  DIAMOND_JOB: "ZL-JOB",
  POLISHED_RECEIPT: "ZL-REC",
  POLISHED_DIAMOND: "ZL-POL",
};

/**
 * Allocates the next human-readable diamond code for (sequenceType,
 * calendar year), atomically — the same upsert-based pattern as
 * src/lib/accounting/numbering.ts's nextVoucherNumber, just keyed by
 * calendar year instead of financial year (matches the master plan's own
 * examples, e.g. "ZL-RL-2026-000001"). MUST be called with the same
 * transaction client that inserts the dependent row, so the increment and
 * the insert commit or roll back together.
 *
 * This code is a separate, human-readable, unique column — never the row's
 * real primary key (still a cuid) — so it is safe to display everywhere
 * without exposing or depending on internal ids.
 */
export async function nextDiamondCode(
  tx: Prisma.TransactionClient,
  sequenceType: DiamondSequenceType,
  yearLabel: string = String(new Date().getUTCFullYear())
): Promise<string> {
  const sequence = await tx.diamondSequence.upsert({
    where: { sequenceType_yearLabel: { sequenceType, yearLabel } },
    create: { sequenceType, yearLabel, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });

  const prefix = PREFIX_BY_TYPE[sequenceType];
  const padded = String(sequence.lastNumber).padStart(6, "0");
  return `${prefix}-${yearLabel}-${padded}`;
}
