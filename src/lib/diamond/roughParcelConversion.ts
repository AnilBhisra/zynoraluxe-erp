import "server-only";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { Decimal } from "@/lib/accounting/money";
import { PostingError } from "@/lib/accounting/posting";

export { PostingError };

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaClient;

export const MIN_ROUGH_CONVERSION_REASON_LENGTH = 10;

/**
 * Audited Owner conversion of a rough row that was bought as a single STONE
 * but is really a parcel of many stones.
 *
 * Unlike the polished conversion (which retires the row into a packet), a
 * rough parcel is the same table with kind = PARCEL — partial issue splits
 * child rows off it. So the conversion reclassifies the SAME row in place,
 * setting exactly what a parcel bought as a parcel carries (kind, optional
 * stone count, and the immutable original* snapshot) plus who/when/why.
 *
 * Nothing else changes: carat, allocated (carrying) cost, lot, supplier,
 * purchase voucher and journal, supplier payable, and the original
 * ROUGH_PURCHASE_IN movement all stay exactly as recorded. No voucher and no
 * stock movement is posted — no stock moves and no value changes.
 *
 * Only a stone that has never left stock is supported: bought on a purchase
 * lot, Available, never linked to any Manufacturer job (not even one later
 * cancelled), and with no movement other than its purchase. Anything else is
 * refused with the reason, never converted partially.
 */

const STATUS_WORDS: Record<string, string> = {
  WITH_KARIGAR: "with a Manufacturer / Karigar",
  COMPLETED: "completed (consumed by a receipt)",
  CANCELLED: "cancelled",
};

type PieceForCheck = {
  roughCode: string;
  kind: string;
  status: string;
  lotId: string | null;
  parentPieceId: string | null;
  carat: Decimal | Prisma.Decimal;
  allocatedCost: Decimal | Prisma.Decimal;
  convertedToParcelAt: Date | null;
  jobCodes: string[];
  childCount: number;
  otherMovementTypes: string[];
};

/** Why this row cannot be converted, or null when it can. */
export function refusalFor(piece: PieceForCheck): string | null {
  if (piece.kind === "PARCEL") {
    return piece.convertedToParcelAt
      ? `${piece.roughCode} was already converted to a parcel on ${piece.convertedToParcelAt.toISOString().slice(0, 10)}.`
      : `${piece.roughCode} is already a parcel — it can be issued in part as it is.`;
  }
  if (piece.status !== "AVAILABLE") {
    return `${piece.roughCode} is ${STATUS_WORDS[piece.status] ?? piece.status}. Only an Available stone that has never been issued can be converted.`;
  }
  if (piece.jobCodes.length > 0) {
    return `${piece.roughCode} has already been issued (${piece.jobCodes.join(", ")}). Converting a stone with issue history is not supported — its job records describe it as one stone.`;
  }
  if (!piece.lotId) {
    return `${piece.roughCode} was not bought on a rough purchase (it was returned from a job). Only a purchased stone can be converted.`;
  }
  if (piece.parentPieceId || piece.childCount > 0) {
    return `${piece.roughCode} is linked to a parcel split, so it cannot be converted.`;
  }
  if (piece.otherMovementTypes.length > 0) {
    return `${piece.roughCode} has stock history beyond its purchase (${piece.otherMovementTypes.join(", ")}), so it cannot be converted.`;
  }
  if (!new Decimal(piece.carat).greaterThan(0) || !new Decimal(piece.allocatedCost).greaterThan(0)) {
    return `${piece.roughCode} has no carat or cost to carry into a parcel.`;
  }
  return null;
}

async function loadForCheck(db: Db, roughPieceId: string) {
  const piece = await db.roughPiece.findUnique({
    where: { id: roughPieceId },
    include: {
      lot: { include: { supplier: { select: { name: true } }, voucher: { select: { voucherNumber: true } } } },
      jobLinks: { include: { job: { select: { jobCode: true } } }, orderBy: { createdAt: "asc" } },
      stockMovements: { select: { type: true }, orderBy: { createdAt: "asc" } },
      _count: { select: { childPieces: true } },
    },
  });
  if (!piece) throw new PostingError("Rough piece not found.");
  const check: PieceForCheck = {
    roughCode: piece.roughCode,
    kind: piece.kind,
    status: piece.status,
    lotId: piece.lotId,
    parentPieceId: piece.parentPieceId,
    carat: piece.carat,
    allocatedCost: piece.allocatedCost,
    convertedToParcelAt: piece.convertedToParcelAt,
    jobCodes: piece.jobLinks.map((l) => l.job.jobCode),
    childCount: piece._count.childPieces,
    otherMovementTypes: [...new Set(piece.stockMovements.map((m) => m.type).filter((t) => t !== "ROUGH_PURCHASE_IN"))],
  };
  return { piece, check };
}

export type RoughConversionPreview = {
  roughPieceId: string;
  roughCode: string;
  lotCode: string | null;
  supplierName: string | null;
  purchaseDate: Date | null;
  purchaseVoucherNumber: string | null;
  kind: string;
  status: string;
  /** Exact current values — echoed back on confirm so nothing can change unseen. */
  carat: string;
  allocatedCost: string;
  issueHistory: string[];
  purchaseMovements: number;
  refusal: string | null;
};

/** Read-only: what a conversion would change, or why it is refused. */
export async function previewRoughStoneToParcel(db: Db, roughPieceId: string): Promise<RoughConversionPreview> {
  const { piece, check } = await loadForCheck(db, roughPieceId);
  return {
    roughPieceId: piece.id,
    roughCode: piece.roughCode,
    lotCode: piece.lot?.lotCode ?? null,
    supplierName: piece.lot?.supplier.name ?? null,
    purchaseDate: piece.lot?.purchaseDate ?? null,
    purchaseVoucherNumber: piece.lot?.voucher?.voucherNumber ?? null,
    kind: piece.kind,
    status: piece.status,
    carat: new Decimal(piece.carat).toFixed(3),
    allocatedCost: new Decimal(piece.allocatedCost).toFixed(2),
    issueHistory: check.jobCodes,
    purchaseMovements: piece.stockMovements.filter((m) => m.type === "ROUGH_PURCHASE_IN").length,
    refusal: refusalFor(check),
  };
}

export async function convertRoughStoneToParcel(
  tx: Tx,
  input: {
    roughPieceId: string;
    /** Stones in the parcel where counted; null = not recorded (same as a parcel purchase). */
    pieceCount: number | null;
    reason: string;
    /** The carat and cost the Owner saw on the preview. */
    expectedCarat: string;
    expectedCost: string;
    convertedByUserId: string;
  }
) {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < MIN_ROUGH_CONVERSION_REASON_LENGTH) {
    throw new PostingError(
      `Say why this stone is really a parcel (at least ${MIN_ROUGH_CONVERSION_REASON_LENGTH} characters) — the reason is kept in the audit trail.`
    );
  }
  if (input.pieceCount != null && (!Number.isInteger(input.pieceCount) || input.pieceCount < 2)) {
    throw new PostingError("If you enter the number of stones, a parcel holds at least 2. Leave it blank if they were not counted.");
  }

  // Serialise with issue / cancel / another conversion of this row: they all
  // take the same row lock, so the loser re-reads the new state and is refused.
  await tx.$queryRawUnsafe(`SELECT id FROM "rough_pieces" WHERE id = $1 FOR UPDATE`, input.roughPieceId);

  const { piece, check } = await loadForCheck(tx, input.roughPieceId);
  const refusal = refusalFor(check);
  if (refusal) throw new PostingError(refusal);

  const carat = new Decimal(piece.carat);
  const cost = new Decimal(piece.allocatedCost);
  if (!carat.equals(new Decimal(input.expectedCarat)) || !cost.equals(new Decimal(input.expectedCost))) {
    throw new PostingError(
      `${piece.roughCode} changed since the preview (now ${carat.toFixed(3)}ct / ₹${cost.toFixed(2)}). Preview it again before converting.`
    );
  }

  return tx.roughPiece.update({
    where: { id: piece.id },
    data: {
      kind: "PARCEL",
      pieceCount: input.pieceCount,
      // Same snapshot a parcel bought as a parcel gets at purchase. The row
      // has never been issued, so its current carat/cost are the as-bought ones.
      originalCarat: carat.toFixed(3),
      originalPieceCount: input.pieceCount,
      originalCost: cost.toFixed(2),
      convertedToParcelAt: new Date(),
      convertedToParcelByUserId: input.convertedByUserId,
      convertedToParcelReason: reason,
    },
  });
}
