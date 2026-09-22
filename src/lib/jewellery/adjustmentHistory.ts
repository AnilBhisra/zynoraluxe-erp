import "server-only";

import { prisma } from "@/lib/db/prisma";

export type MetalAdjustmentRow = {
  id: string;
  type: string;
  purityDisplayName: string;
  metalType: string;
  grossWeight: string;
  fineWeight: string;
  /** Owner-only; null for Staff. */
  costValue: string | null;
  sourceDocument: string;
  voucherNumber: string | null;
  createdAt: string;
  reversedByMovementId: string | null;
  isReversal: boolean;
};

const ADJUSTMENT_TYPES = [
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
  "SCRAP_ADJUSTMENT_IN",
  "SCRAP_ADJUSTMENT_OUT",
] as const;

/**
 * Owner-authorized adjustments, newest first, each showing whether it has
 * already been reversed. A posted adjustment is never edited or deleted, so
 * this list is the audit trail.
 */
export async function listMetalAdjustments(isOwner: boolean, limit = 50): Promise<MetalAdjustmentRow[]> {
  const rows = await prisma.metalStockMovement.findMany({
    where: { type: { in: [...ADJUSTMENT_TYPES] } },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      purity: { select: { displayName: true } },
      voucher: { select: { voucherNumber: true } },
      reversedByMovement: { select: { id: true } },
    },
  });

  return rows.map((m) => ({
    id: m.id,
    type: m.type,
    purityDisplayName: m.purity.displayName,
    metalType: m.metalType,
    grossWeight: m.grossWeight.toFixed(3),
    fineWeight: m.fineWeight.toFixed(3),
    costValue: isOwner ? m.costValue.toFixed(2) : null,
    sourceDocument: m.sourceDocument,
    voucherNumber: m.voucher?.voucherNumber ?? null,
    createdAt: m.createdAt.toISOString(),
    reversedByMovementId: m.reversedByMovement?.id ?? null,
    isReversal: m.reversalOfMovementId !== null,
  }));
}
