import "server-only";

import type { MetalStockMovementType, Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/prisma";
import { METAL_POOL_EFFECT } from "@/lib/jewellery/metalMath";

/** Adjustment movement types: the only ones the Owner may reverse from the history. */
const ADJUSTMENT_TYPES = [
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
  "SCRAP_ADJUSTMENT_IN",
  "SCRAP_ADJUSTMENT_OUT",
] as const;

// ---------------------------------------------------------------------------
// Phase 8B — complete, searchable Metal Stock history
// ---------------------------------------------------------------------------

export const HISTORY_CATEGORIES = [
  "ALL",
  "OPENING",
  "PURCHASE",
  "KARIGAR",
  "JOB_ALLOCATION",
  "JOB",
  "ADJUSTMENT",
  "REVALUATION",
  "REVERSAL",
] as const;
export type HistoryCategory = (typeof HISTORY_CATEGORIES)[number];

export const HISTORY_CATEGORY_LABEL: Record<HistoryCategory, string> = {
  ALL: "Everything",
  OPENING: "Opening stock",
  PURCHASE: "Purchases",
  KARIGAR: "Issue to / return from Karigar",
  JOB_ALLOCATION: "Job allocations / releases",
  JOB: "Job issue, return, scrap, used, transfer",
  ADJUSTMENT: "Stock adjustments",
  REVALUATION: "Revaluations (Owner corrections)",
  REVERSAL: "Cancellations and reversals",
};

const CATEGORY_TYPES: Record<Exclude<HistoryCategory, "ALL" | "REVALUATION" | "REVERSAL">, MetalStockMovementType[]> = {
  OPENING: ["OPENING_IN"],
  PURCHASE: ["PURCHASE_IN"],
  KARIGAR: ["KARIGAR_ISSUE_OUT", "KARIGAR_RETURN_IN"],
  JOB_ALLOCATION: ["CUSTODY_TO_JOB", "JOB_TO_CUSTODY"],
  JOB: ["ISSUE_OUT", "ISSUE_CANCEL_IN", "RETURN_IN", "SCRAP_RETURN_IN", "CONSUMED_OUT", "JOB_TRANSFER_OUT", "JOB_TRANSFER_IN"],
  ADJUSTMENT: ["ADJUSTMENT_IN", "ADJUSTMENT_OUT", "SCRAP_ADJUSTMENT_IN", "SCRAP_ADJUSTMENT_OUT"],
};

export const MOVEMENT_LABEL: Record<MetalStockMovementType, string> = {
  PURCHASE_IN: "Purchase",
  OPENING_IN: "Opening stock",
  ISSUE_OUT: "Issued to job",
  ISSUE_CANCEL_IN: "Issue cancelled (back to stock)",
  RETURN_IN: "Returned from job",
  SCRAP_RETURN_IN: "Scrap returned from job",
  CONSUMED_OUT: "Used in finished jewellery",
  ADJUSTMENT_IN: "Added to stock (adjustment)",
  ADJUSTMENT_OUT: "Removed from stock (adjustment)",
  SCRAP_ADJUSTMENT_IN: "Into scrap (adjustment)",
  SCRAP_ADJUSTMENT_OUT: "Out of scrap (adjustment)",
  JOB_TRANSFER_OUT: "Transferred out to another job",
  JOB_TRANSFER_IN: "Transferred in from another job",
  KARIGAR_ISSUE_OUT: "Issued to Karigar",
  KARIGAR_RETURN_IN: "Returned by Karigar",
  CUSTODY_TO_JOB: "Allocated from Karigar balance to job",
  JOB_TO_CUSTODY: "Released from job to Karigar balance",
};

export type MetalHistoryCorrectionLink = { correctionCode: string; state: string; batchCode: string | null };

export type MetalHistoryRow = {
  /** The movement id, or `reval:<id>` for a revaluation row. */
  id: string;
  kind: "MOVEMENT" | "REVALUATION";
  type: string;
  label: string;
  createdAt: string;
  actorName: string | null;
  metalType: string;
  purityDisplayName: string;
  grossWeight: string;
  fineWeight: string;
  /** +1 / -1 / 0 effect on the usable and scrap pools (weights only). */
  usableEffect: -1 | 0 | 1;
  scrapEffect: -1 | 0 | 1;
  /** Owner-only. For a revaluation: the change in value. Null for Staff. */
  costValue: string | null;
  /** Owner-only effective rates of a movement (value ÷ weight); null for Staff and revaluations. */
  ratePerGrossGram: string | null;
  ratePerFineGram: string | null;
  sourceDocument: string;
  /** Owner-only accounting reference. */
  voucherNumber: string | null;
  karigarName: string | null;
  jobCode: string | null;
  /** This row cancels/reverses an earlier one. */
  reversalOf: { id: string; sourceDocument: string; createdAt: string } | null;
  /** This row was itself reversed later. */
  reversedBy: { id: string; sourceDocument: string; createdAt: string } | null;
  /** Both legs of one job-to-job transfer share this. */
  transferPairId: string | null;
  /** Posted corrections that revalued this movement (Owner-only codes). */
  corrections: MetalHistoryCorrectionLink[];
  /** For a revaluation row: the movement it revalued, when it names one. */
  revaluedMovementId: string | null;
  /** Owner may reverse an un-reversed adjustment from the history itself. */
  canReverse: boolean;
};

export type MetalHistoryPage = {
  rows: MetalHistoryRow[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
};

export type MetalHistoryQuery = {
  isOwner: boolean;
  category?: HistoryCategory;
  search?: string;
  purityId?: string;
  page?: number;
  pageSize?: number;
};

const MAX_PAGE = 200;

function movementWhere(category: HistoryCategory, term: string, purityId: string, correctionMatchIds: string[]): Prisma.MetalStockMovementWhereInput {
  const and: Prisma.MetalStockMovementWhereInput[] = [];
  if (category === "REVERSAL") {
    and.push({ OR: [{ reversalOfMovementId: { not: null } }, { reversedByMovement: { isNot: null } }, { type: "ISSUE_CANCEL_IN" }] });
  } else if (category !== "ALL" && category !== "REVALUATION") {
    and.push({ type: { in: CATEGORY_TYPES[category] } });
  }
  if (purityId) and.push({ purityId });
  if (term) {
    and.push({
      OR: [
        { sourceDocument: { contains: term, mode: "insensitive" } },
        { purity: { displayName: { contains: term, mode: "insensitive" } } },
        { karigar: { name: { contains: term, mode: "insensitive" } } },
        { jewelleryJob: { jobCode: { contains: term, mode: "insensitive" } } },
        { voucher: { voucherNumber: { contains: term, mode: "insensitive" } } },
        ...(correctionMatchIds.length > 0 ? [{ id: { in: correctionMatchIds } }] : []),
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

function revaluationWhere(term: string, purityId: string): Prisma.MetalRevaluationWhereInput {
  const and: Prisma.MetalRevaluationWhereInput[] = [{ correction: { state: "POSTED" } }];
  if (purityId) and.push({ purityId });
  if (term) {
    and.push({
      OR: [
        { correction: { correctionCode: { contains: term, mode: "insensitive" } } },
        { correction: { entityLabel: { contains: term, mode: "insensitive" } } },
        { correction: { batch: { batchCode: { contains: term, mode: "insensitive" } } } },
        { purity: { displayName: { contains: term, mode: "insensitive" } } },
        { jewelleryJob: { jobCode: { contains: term, mode: "insensitive" } } },
      ],
    });
  }
  return { AND: and };
}

/**
 * Every Company metal movement — opening stock, purchases (including Customer
 * Gold bought by the Company), Karigar issues/returns, job allocations and
 * releases, job issues/returns/scrap/consumption/transfers, adjustments, and
 * their cancellations/reversals — plus posted revaluations, newest first,
 * searchable and paged. Read-only; nothing here can change a balance.
 *
 * Staff receive the same rows with every ₹ figure, voucher number and
 * correction code nulled on the server, so none reaches the page payload.
 */
export async function listMetalStockHistory(query: MetalHistoryQuery): Promise<MetalHistoryPage> {
  const category: HistoryCategory = HISTORY_CATEGORIES.includes(query.category as HistoryCategory) ? (query.category as HistoryCategory) : "ALL";
  const term = (query.search ?? "").trim().slice(0, 100);
  const purityId = (query.purityId ?? "").trim();
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 5), 100);
  const page = Math.min(Math.max(Math.trunc(query.page ?? 1) || 1, 1), MAX_PAGE);
  const fetchCount = page * pageSize + 1;

  // A correction code lives on the revaluation, not the movement: resolve the
  // matching movement ids first so the search filters in the database.
  const correctionMatchIds =
    term && query.isOwner
      ? (
          await prisma.metalRevaluation.findMany({
            where: { correction: { state: "POSTED", correctionCode: { contains: term, mode: "insensitive" } }, sourceMovementId: { not: null } },
            select: { sourceMovementId: true },
            take: 200,
          })
        ).map((r) => r.sourceMovementId as string)
      : [];

  const wantMovements = category !== "REVALUATION";
  const wantRevaluations = category === "ALL" || category === "REVALUATION";

  const [movements, revaluations] = await Promise.all([
    wantMovements
      ? prisma.metalStockMovement.findMany({
          where: movementWhere(category, term, purityId, correctionMatchIds),
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: fetchCount,
          select: {
            id: true,
            type: true,
            metalType: true,
            grossWeight: true,
            fineWeight: true,
            costValue: true,
            sourceDocument: true,
            createdAt: true,
            transferPairId: true,
            reversalOfMovementId: true,
            purity: { select: { displayName: true } },
            voucher: { select: { voucherNumber: true } },
            karigar: { select: { name: true } },
            jewelleryJob: { select: { jobCode: true } },
            createdBy: { select: { name: true } },
            reversalOfMovement: { select: { id: true, sourceDocument: true, createdAt: true } },
            reversedByMovement: { select: { id: true, sourceDocument: true, createdAt: true } },
          },
        })
      : Promise.resolve([]),
    wantRevaluations
      ? prisma.metalRevaluation.findMany({
          where: revaluationWhere(term, purityId),
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: fetchCount,
          select: {
            id: true,
            target: true,
            metalType: true,
            grossWeight: true,
            fineWeight: true,
            deltaCostValue: true,
            sourceMovementId: true,
            createdAt: true,
            purity: { select: { displayName: true } },
            jewelleryJob: { select: { jobCode: true } },
            finishedJewellery: { select: { finishedCode: true } },
            correction: {
              select: {
                correctionCode: true,
                state: true,
                entityLabel: true,
                batch: { select: { batchCode: true } },
                correctionVoucher: { select: { voucherNumber: true } },
                approvedBy: { select: { name: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  // One batched lookup for every correction that revalued a listed movement.
  const movementIds = movements.map((m) => m.id);
  const linked =
    movementIds.length > 0
      ? await prisma.metalRevaluation.findMany({
          where: { sourceMovementId: { in: movementIds }, correction: { state: "POSTED" } },
          select: { sourceMovementId: true, correction: { select: { correctionCode: true, state: true, batch: { select: { batchCode: true } } } } },
        })
      : [];
  const correctionsByMovement = new Map<string, MetalHistoryCorrectionLink[]>();
  for (const r of linked) {
    const list = correctionsByMovement.get(r.sourceMovementId as string) ?? [];
    list.push({ correctionCode: r.correction.correctionCode, state: r.correction.state, batchCode: r.correction.batch?.batchCode ?? null });
    correctionsByMovement.set(r.sourceMovementId as string, list);
  }

  const owner = query.isOwner;
  const movementRows: MetalHistoryRow[] = movements.map((m) => {
    const effect = METAL_POOL_EFFECT[m.type];
    const isAdjustment = (ADJUSTMENT_TYPES as readonly string[]).includes(m.type);
    return {
      id: m.id,
      kind: "MOVEMENT",
      type: m.type,
      label: m.reversalOfMovementId ? `Reversal — ${MOVEMENT_LABEL[m.type]}` : MOVEMENT_LABEL[m.type],
      createdAt: m.createdAt.toISOString(),
      actorName: m.createdBy?.name ?? null,
      metalType: m.metalType,
      purityDisplayName: m.purity.displayName,
      grossWeight: m.grossWeight.toFixed(3),
      fineWeight: m.fineWeight.toFixed(3),
      usableEffect: effect.usable,
      scrapEffect: effect.scrap,
      costValue: owner ? m.costValue.toFixed(2) : null,
      ratePerGrossGram: owner && m.grossWeight.greaterThan(0) ? m.costValue.dividedBy(m.grossWeight).toFixed(4) : null,
      ratePerFineGram: owner && m.fineWeight.greaterThan(0) ? m.costValue.dividedBy(m.fineWeight).toFixed(4) : null,
      sourceDocument: m.sourceDocument,
      voucherNumber: owner ? (m.voucher?.voucherNumber ?? null) : null,
      karigarName: m.karigar?.name ?? null,
      jobCode: m.jewelleryJob?.jobCode ?? null,
      reversalOf: m.reversalOfMovement
        ? { id: m.reversalOfMovement.id, sourceDocument: m.reversalOfMovement.sourceDocument, createdAt: m.reversalOfMovement.createdAt.toISOString() }
        : null,
      reversedBy: m.reversedByMovement
        ? { id: m.reversedByMovement.id, sourceDocument: m.reversedByMovement.sourceDocument, createdAt: m.reversedByMovement.createdAt.toISOString() }
        : null,
      transferPairId: m.transferPairId,
      corrections: owner ? (correctionsByMovement.get(m.id) ?? []) : [],
      revaluedMovementId: null,
      canReverse: owner && isAdjustment && !m.reversalOfMovementId && !m.reversedByMovement,
    };
  });

  const revaluationRows: MetalHistoryRow[] = revaluations.map((r) => ({
    id: `reval:${r.id}`,
    kind: "REVALUATION",
    type: `REVALUATION_${r.target}`,
    label: "Revaluation (Owner correction — value only, weight unchanged)",
    createdAt: r.createdAt.toISOString(),
    actorName: owner ? (r.correction.approvedBy?.name ?? null) : null,
    metalType: r.metalType,
    purityDisplayName: r.purity.displayName,
    grossWeight: r.grossWeight.toFixed(3),
    fineWeight: r.fineWeight.toFixed(3),
    usableEffect: 0,
    scrapEffect: 0,
    costValue: owner ? r.deltaCostValue.toFixed(2) : null,
    ratePerGrossGram: null,
    ratePerFineGram: null,
    sourceDocument: owner ? r.correction.entityLabel : "Owner correction",
    voucherNumber: owner ? (r.correction.correctionVoucher?.voucherNumber ?? null) : null,
    karigarName: null,
    jobCode: r.jewelleryJob?.jobCode ?? r.finishedJewellery?.finishedCode ?? null,
    reversalOf: null,
    reversedBy: null,
    transferPairId: null,
    corrections: owner
      ? [{ correctionCode: r.correction.correctionCode, state: r.correction.state, batchCode: r.correction.batch?.batchCode ?? null }]
      : [],
    revaluedMovementId: r.sourceMovementId,
    canReverse: false,
  }));

  const merged = [...movementRows, ...revaluationRows].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1
  );
  const start = (page - 1) * pageSize;
  return {
    rows: merged.slice(start, start + pageSize),
    page,
    pageSize,
    hasNextPage: merged.length > start + pageSize,
  };
}
