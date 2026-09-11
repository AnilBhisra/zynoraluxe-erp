import type { Prisma } from "@/generated/prisma/client";
import type { JewellerySequenceType } from "@/generated/prisma/enums";

// "ZL-JJOB-" deliberately, not "ZL-JOB-" — Phase 3's DiamondJob already
// owns "ZL-JOB-" with its own independent counter; reusing that display
// prefix here would let a Diamond Job and a Jewellery Job show the
// identical human-readable code. See the JewelleryJob model's comment in
// schema.prisma.
const PREFIX_BY_TYPE: Record<JewellerySequenceType, string> = {
  METAL_PURCHASE: "ZL-MP",
  JEWELLERY_JOB: "ZL-JJOB",
  JEWELLERY_RECEIPT: "ZL-JREC",
  FINISHED_JEWELLERY: "ZL-FJ",
};

/**
 * Allocates the next human-readable Phase 4 code for (sequenceType,
 * calendar year), atomically — the same upsert-based pattern as
 * src/lib/diamond/numbering.ts's nextDiamondCode, kept in its own table
 * (JewellerySequence) so Phase 3's DiamondSequence stays untouched. MUST
 * be called with the same transaction client that inserts the dependent
 * row, so the increment and the insert commit or roll back together.
 *
 * This code is a separate, human-readable, unique column — never the
 * row's real primary key (still a cuid) — so it is safe to display
 * everywhere without exposing or depending on internal ids.
 */
export async function nextJewelleryCode(
  tx: Prisma.TransactionClient,
  sequenceType: JewellerySequenceType,
  yearLabel: string = String(new Date().getUTCFullYear())
): Promise<string> {
  const sequence = await tx.jewellerySequence.upsert({
    where: { sequenceType_yearLabel: { sequenceType, yearLabel } },
    create: { sequenceType, yearLabel, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });

  const prefix = PREFIX_BY_TYPE[sequenceType];
  const padded = String(sequence.lastNumber).padStart(6, "0");
  return `${prefix}-${yearLabel}-${padded}`;
}
