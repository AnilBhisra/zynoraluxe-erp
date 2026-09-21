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
  /** Set when this correction is one required step of a cumulative batch. */
  batchCode: string | null;
  batchStep: number | null;
  batchRequiredSteps: number | null;
  batchState: string | null;
  impacts: CorrectionHistoryImpact[];
};

function snapshotValue(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  const value = (snapshot as { costValue?: unknown }).costValue;
  if (typeof value !== "string") return null;
  // Snapshots may carry either "160000" or "160000.00" depending on which
  // planner wrote them; history always shows money at 2 dp.
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : value;
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
      batch: { select: { batchCode: true, requiredSteps: true, state: true } },
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
    batchCode: c.batch?.batchCode ?? null,
    batchStep: c.batchStep,
    batchRequiredSteps: c.batch?.requiredSteps ?? null,
    batchState: c.batch?.state ?? null,
    impacts: c.impacts.map((i) => ({
      kind: i.kind,
      recordLabel: i.recordLabel,
      field: i.field,
      oldValue: i.oldValue,
      newValue: i.newValue,
    })),
  }));
}
