import "server-only";

import { prisma } from "@/lib/db/prisma";

export type CorrectionHistoryImpact = {
  kind: string;
  recordLabel: string;
  field: string;
  oldValue: string;
  newValue: string;
};

export type CorrectionHistoryRow = {
  id: string;
  correctionCode: string;
  entityType: string;
  entityLabel: string;
  mode: string;
  state: string;
  reason: string;
  amount: string | null;
  voucherNumber: string | null;
  preparedBy: string;
  approvedBy: string | null;
  postedAt: string | null;
  createdAt: string;
  rejectionReason: string | null;
  originalValue: string | null;
  correctedValue: string | null;
  impacts: CorrectionHistoryImpact[];
};

function snapshotValue(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = (snapshot as { costValue?: unknown }).costValue;
  return typeof value === "string" ? value : null;
}

/**
 * Every correction, newest first, with the original value, the corrected
 * value, the reason, who prepared and approved it, and the records it moved.
 * Owner-only: the page that calls this holds the role check.
 */
export async function listCorrections(limit = 100): Promise<CorrectionHistoryRow[]> {
  const rows = await prisma.correction.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      impacts: { orderBy: { createdAt: "asc" } },
      preparedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
      correctionVoucher: { select: { voucherNumber: true, amount: true } },
    },
  });

  return rows.map((c) => ({
    id: c.id,
    correctionCode: c.correctionCode,
    entityType: c.entityType,
    entityLabel: c.entityLabel,
    mode: c.mode,
    state: c.state,
    reason: c.reason,
    amount: c.correctionVoucher ? c.correctionVoucher.amount.toFixed(2) : null,
    voucherNumber: c.correctionVoucher?.voucherNumber ?? null,
    preparedBy: c.preparedBy.name,
    approvedBy: c.approvedBy?.name ?? null,
    postedAt: c.postedAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    rejectionReason: c.rejectionReason,
    originalValue: snapshotValue(c.originalSnapshot),
    correctedValue: snapshotValue(c.correctedSnapshot),
    impacts: c.impacts.map((i) => ({
      kind: i.kind,
      recordLabel: i.recordLabel,
      field: i.field,
      oldValue: i.oldValue,
      newValue: i.newValue,
    })),
  }));
}
