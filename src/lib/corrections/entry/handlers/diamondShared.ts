/**
 * Shared by the processed-rough handlers: one lock order, one receipt loader and
 * one definition of "a returned rough row is unused".
 *
 * Lock order (always): diamond_jobs -> polished_receipts -> rough_pieces (by id) ->
 * corrections of the receipt. Receiving locks the job; issuing locks rough rows;
 * cancelling locks the job then its rows — the same direction, so no cycle.
 */
import type { RoughPieceKind, RoughPieceStatus } from "@/generated/prisma/enums";
import { Decimal } from "@/lib/accounting/money";
import { CorrectionError, type Tx } from "@/lib/corrections/types";

import type { Blocker } from "../types";

export type LockableTable = "diamond_jobs" | "polished_receipts" | "rough_pieces" | "corrections" | "jewellery_jobs" | "jewellery_receipts";

/** `table` is always one of the literals above (never user input); ids are bound. */
export async function lockIds(tx: Tx, table: LockableTable, ids: string[]) {
  const unique = [...new Set(ids)].sort();
  if (!unique.length) return;
  await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, unique);
}

/** A receipt reversed through Correct entry (REVERSE_REPOST, still POSTED). */
export async function receiptReversal(tx: Tx, receiptId: string) {
  return tx.correction.findFirst({
    where: { entityType: "DIAMOND_RECEIPT", entityId: receiptId, mode: "REVERSE_REPOST", state: "POSTED", reversedByCorrectionId: null },
  });
}

export async function loadProcessedReceipt(tx: Tx, receiptId: string) {
  const receipt = await tx.polishedReceipt.findUnique({
    where: { id: receiptId },
    include: { job: true, returnedPieces: { orderBy: { roughCode: "asc" } } },
  });
  if (!receipt) throw new CorrectionError("Receipt not found.");
  return receipt;
}

/** job -> receipt -> its returned rows, in the fixed order. */
export async function lockReceiptChain(tx: Tx, receiptId: string) {
  const head = await tx.polishedReceipt.findUnique({ where: { id: receiptId }, select: { jobId: true } });
  if (!head) throw new CorrectionError("Receipt not found.");
  await lockIds(tx, "diamond_jobs", [head.jobId]);
  await lockIds(tx, "polished_receipts", [receiptId]);
  const rows = await tx.roughPiece.findMany({ where: { returnedFromReceiptId: receiptId }, select: { id: true } });
  await lockIds(tx, "rough_pieces", rows.map((r) => r.id));
}

type RoughRow = {
  id: string;
  roughCode: string;
  kind: RoughPieceKind;
  status: RoughPieceStatus;
  pieceCount: number | null;
  originalPieceCount: number | null;
  carat: unknown;
  originalCarat: unknown;
};

/**
 * Everything that has used a returned rough row since it came back. A job that
 * was CANCELLED returned the row exactly as it was, so it does not block.
 */
export async function roughRowBlockers(tx: Tx, row: RoughRow): Promise<Blocker[]> {
  const out: Blocker[] = [];
  const links = await tx.diamondJobPiece.findMany({ where: { roughPieceId: row.id, job: { status: { not: "CANCELLED" } } }, include: { job: true } });
  for (const l of links) {
    out.push({ code: l.job.jobCode, message: `${row.roughCode} was issued to ${l.job.jobCode} (${l.job.status.toLowerCase().replace(/_/g, " ")}). That job's receipts and issue must be reversed first.` });
  }
  const children = await tx.roughPiece.findMany({ where: { parentPieceId: row.id, status: { not: "CANCELLED" } } });
  for (const c of children) {
    const link = await tx.diamondJobPiece.findFirst({ where: { roughPieceId: c.id }, include: { job: true } });
    out.push({ code: link?.job.jobCode ?? c.roughCode, message: `${c.roughCode} (part of ${row.roughCode}) went out${link ? ` on ${link.job.jobCode}` : ""}.` });
  }
  if (!links.length && !children.length && row.status !== "AVAILABLE") {
    out.push({ code: row.roughCode, message: `${row.roughCode} is ${row.status.toLowerCase().replace(/_/g, " ")}, not available in stock.` });
  }
  if (
    row.kind === "PARCEL" &&
    ((row.originalPieceCount != null && row.pieceCount !== row.originalPieceCount) ||
      (row.originalCarat != null && !new Decimal(String(row.carat)).equals(new Decimal(String(row.originalCarat)))))
  ) {
    out.push({ code: row.roughCode, message: `${row.roughCode} has been partly issued since it came back.` });
  }
  return out;
}

/** Stones a returned row holds (a counted parcel's count, else one). */
export const stonesOf = (row: { kind: RoughPieceKind; pieceCount: number | null }) => (row.kind === "PARCEL" ? (row.pieceCount ?? 1) : 1);
