/**
 * Correct entry — RETURNED_PIECES (quantity class, no voucher).
 *
 * A processed-rough receipt (4P / Laser, HPHT / Grow, Rough Polish) saved the
 * wrong number of returned stones, e.g. "1 pc / 21.642 ct" for what is really
 * "20 pcs / 21.642 ct". Only the COUNT changes:
 *
 *   - the returned row's current and original stone count become the corrected
 *     count (a single returned STONE becomes a counted PARCEL when the count is
 *     two or more — the same in-place, audited reshaping as a stone->parcel
 *     conversion);
 *   - a ROUGH_COUNT_CORRECTION_IN/OUT movement (pieces only, 0 ct, Rs 0) keeps the
 *     stock ledger append-only, so the job's returned pieces add up;
 *   - carat, cost, loss, charge, WIP and every voucher stay exactly as they are.
 *
 * Refused when the count is financial (a per-piece charge), when the receipt
 * returned several separately weighed stones (re-counting would invent weights),
 * or when anything has used the row since it came back.
 */
import type { RoughPieceKind } from "@/generated/prisma/enums";
import { CorrectionError, type PlannedImpact, type Tx } from "@/lib/corrections/types";

import type { Blocker, EntryHandler, EntryTarget, HandlerPlan, PostedCorrection } from "../types";
import { loadProcessedReceipt, lockReceiptChain, receiptReversal, roughRowBlockers, stonesOf } from "./diamondShared";

type Data = { rowId: string; jobId: string; delta: number; newKind: RoughPieceKind; count: number };
type Original = { entryKind: "RETURNED_PIECES"; roughId: string; roughCode: string; kind: RoughPieceKind; pieceCount: number | null; originalPieceCount: number | null };
type Corrected = { entryKind: "RETURNED_PIECES"; roughId: string; kind: RoughPieceKind; pieceCount: number; originalPieceCount: number; delta: number };

async function load(tx: Tx, receiptId: string) {
  const receipt = await loadProcessedReceipt(tx, receiptId);
  if (receipt.job.processOutputKindSnapshot !== "ROUGH") return null;
  const blockers: Blocker[] = [];
  const reversal = await receiptReversal(tx, receipt.id);
  if (reversal) blockers.push({ code: reversal.correctionCode, message: `${receipt.receiptCode} was reversed by ${reversal.correctionCode}.` });
  if (receipt.returnedPieces.length !== 1) {
    blockers.push({
      code: receipt.receiptCode,
      message: `${receipt.receiptCode} returned ${receipt.returnedPieces.length} separately weighed stones. Re-counting them would invent stone weights — reverse the receipt and enter it again as one batch.`,
    });
  }
  if (receipt.job.chargeRateBasis === "PER_PIECE") {
    blockers.push({ code: receipt.job.jobCode, message: `${receipt.job.jobCode} charges per piece, so the count decides the charge — it is a stock and accounting correction (reverse the receipt and enter it again).` });
  }
  const row = receipt.returnedPieces[0] ?? null;
  if (row) blockers.push(...(await roughRowBlockers(tx, row)));
  return { receipt, row, blockers };
}

export const processedRoughPiecesHandler: EntryHandler = {
  kind: "RETURNED_PIECES",
  entityTypes: ["DIAMOND_RECEIPT"],
  mode: "ENTRY_QUANTITY",
  entryClass: "QUANTITY",
  reversible: true,

  async lock(tx, target: EntryTarget) {
    await lockReceiptChain(tx, target.entityId);
  },

  async option(tx, target) {
    const l = await load(tx, target.entityId);
    if (!l) return null;
    return {
      kind: "RETURNED_PIECES",
      label: "Returned pieces",
      entryClass: "QUANTITY",
      fields: [{ field: "returnedPieces", label: "Returned pieces", type: "integer", current: l.row ? String(stonesOf(l.row)) : "" }],
      blockers: l.blockers,
      note: "Only the stone count changes. Carat, cost, weight loss, the process charge, WIP and every voucher stay exactly as they are.",
      reversible: true,
    };
  },

  async plan(tx, target, values, reason): Promise<HandlerPlan> {
    const l = await load(tx, target.entityId);
    if (!l) throw new CorrectionError("Only a processed-rough receipt (4P / Laser, HPHT / Grow, Rough Polish) has returned pieces to correct.");
    const { receipt, row } = l;
    if (!row) throw new CorrectionError(`${receipt.receiptCode} has no returned rough row.`);
    const text = String(values.returnedPieces ?? "").trim();
    if (!/^\d+$/.test(text) || Number(text) < 1) throw new CorrectionError("Returned pieces must be a whole number of at least 1.");
    const count = Number(text);
    const before = stonesOf(row);
    if (count === before) throw new CorrectionError(`${row.roughCode} already holds ${before} ${before === 1 ? "piece" : "pieces"} — nothing to change.`);
    const newKind: RoughPieceKind = row.kind === "STONE" && count > 1 ? "PARCEL" : row.kind;
    const label = `${receipt.receiptCode} (${receipt.job.jobCode})`;
    const rec = (field: string, oldValue: string, newValue: string): PlannedImpact => ({
      kind: "RECORD",
      tableName: "rough_pieces",
      recordId: row.id,
      recordLabel: row.roughCode,
      field,
      oldValue,
      newValue,
    });
    const impacts: PlannedImpact[] = [
      { kind: "RECORD", tableName: "polished_receipts", recordId: receipt.id, recordLabel: receipt.receiptCode, field: "returnedPieces", oldValue: String(before), newValue: String(count) },
      rec("pieceCount", row.pieceCount == null ? "" : String(row.pieceCount), String(count)),
      rec("originalPieceCount", row.originalPieceCount == null ? "" : String(row.originalPieceCount), String(count)),
    ];
    if (newKind !== row.kind) impacts.push(rec("kind", row.kind, newKind));
    const original: Original = { entryKind: "RETURNED_PIECES", roughId: row.id, roughCode: row.roughCode, kind: row.kind, pieceCount: row.pieceCount, originalPieceCount: row.originalPieceCount };
    const corrected: Corrected = { entryKind: "RETURNED_PIECES", roughId: row.id, kind: newKind, pieceCount: count, originalPieceCount: count, delta: count - before };
    const carat = String(row.carat);
    return {
      entityLabel: label,
      plan: {
        entityType: "DIAMOND_RECEIPT",
        entityId: receipt.id,
        entityLabel: label,
        mode: "ENTRY_QUANTITY",
        reason,
        originalSnapshot: original,
        correctedSnapshot: corrected,
        downstream: [],
        impacts,
        ledgerLines: [],
        amount: "0.00",
        voucherNote: "",
        revaluations: [],
      },
      changes: [{ field: "returnedPieces", label: "Returned pieces", before: `${before} pc${before === 1 ? "" : "s"} / ${Number(carat).toFixed(3)} ct`, after: `${count} pcs / ${Number(carat).toFixed(3)} ct` }],
      stock: [{ label: `${row.roughCode}${newKind !== row.kind ? " (becomes a counted parcel)" : ""}`, pieces: count - before, carat: "0.000", cost: "0.00" }],
      ledger: [],
      affected: [row.roughCode],
      blockers: l.blockers,
      data: { rowId: row.id, jobId: receipt.jobId, delta: count - before, newKind, count } satisfies Data,
    };
  },

  async apply(tx, built, correction) {
    const d = built.data as Data;
    await tx.roughPiece.update({ where: { id: d.rowId }, data: { kind: d.newKind, pieceCount: d.count, originalPieceCount: d.count } });
    await tx.stockMovement.create({
      data: {
        type: d.delta > 0 ? "ROUGH_COUNT_CORRECTION_IN" : "ROUGH_COUNT_CORRECTION_OUT",
        roughPieceId: d.rowId,
        diamondJobId: d.jobId,
        pieces: Math.abs(d.delta),
        carat: "0.000",
        costValue: "0.00",
        sourceDocument: correction.correctionCode,
        createdByUserId: correction.approvedByUserId!,
      },
    });
    const after = await tx.roughPiece.findUniqueOrThrow({ where: { id: d.rowId } });
    if (after.pieceCount !== d.count || after.originalPieceCount !== d.count) throw new CorrectionError("Internal check failed: the count did not land. Nothing was saved.");
  },

  async reverseBlockers(tx, correction: PostedCorrection) {
    const c = correction.correctedSnapshot as Corrected;
    const row = await tx.roughPiece.findUnique({ where: { id: c.roughId } });
    if (!row) return [{ code: "MISSING", message: "The returned row no longer exists." }];
    const out = await roughRowBlockers(tx, row);
    if (row.pieceCount !== c.pieceCount || row.kind !== c.kind) {
      out.push({ code: row.roughCode, message: `${row.roughCode} no longer holds the corrected ${c.pieceCount} pieces.` });
    }
    return out;
  },

  async undo(tx, correction, reversal) {
    const o = correction.originalSnapshot as Original;
    const c = correction.correctedSnapshot as Corrected;
    const row = await tx.roughPiece.findUniqueOrThrow({ where: { id: o.roughId } });
    await tx.roughPiece.update({ where: { id: o.roughId }, data: { kind: o.kind, pieceCount: o.pieceCount, originalPieceCount: o.originalPieceCount } });
    const link = await tx.polishedReceipt.findUniqueOrThrow({ where: { id: correction.entityId }, select: { jobId: true } });
    await tx.stockMovement.create({
      data: {
        type: c.delta > 0 ? "ROUGH_COUNT_CORRECTION_OUT" : "ROUGH_COUNT_CORRECTION_IN",
        roughPieceId: row.id,
        diamondJobId: link.jobId,
        pieces: Math.abs(c.delta),
        carat: "0.000",
        costValue: "0.00",
        sourceDocument: reversal.code,
        createdByUserId: reversal.actorId,
      },
    });
  },
};
