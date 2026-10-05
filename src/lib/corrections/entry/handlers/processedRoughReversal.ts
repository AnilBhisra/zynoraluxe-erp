/**
 * Correct entry — RECEIPT_REVERSAL (stock and accounting class).
 *
 * The way to correct a processed-rough receipt's CARAT, CHARGE, LOSS or outcome:
 * reverse it in full, then enter the receipt again with the right figures (the
 * job is open again, with exactly the pending carat and WIP it had before).
 *
 *   - the receipt's posting voucher is NOT touched: a CORRECTION voucher posts
 *     its exact mirror (Dr 1210 resolved cost, Dr Manufacturer payable charge,
 *     Cr 1200 what came back), so the ledger nets to the pre-receipt balances;
 *   - every returned row leaves stock through ROUGH_RETURN_REVERSAL_OUT and the
 *     recognised loss comes back through ROUGH_CONSUMED_REVERSAL_IN, each linked
 *     to the movement it mirrors; the rows become CANCELLED;
 *   - the job's returned carat, labour, remaining WIP and status (and, if this
 *     receipt completed it, the issued rows' status) return to their values
 *     before the receipt.
 *
 * Refused while anything depends on the receipt: a later live receipt on the
 * job, any use of a returned row, an active count correction or labour
 * correction on it. Not reversible itself — the remedy is a new receipt.
 */
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import type { JournalLineInput } from "@/lib/accounting/posting";
import { round3 } from "@/lib/diamond/allocation";
import { CorrectionError, type PlannedImpact, type Tx } from "@/lib/corrections/types";

import type { Blocker, EntryHandler, HandlerPlan, LedgerPreviewLine, StockLine } from "../types";
import { loadProcessedReceipt, lockReceiptChain, receiptReversal, roughRowBlockers, stonesOf } from "./diamondShared";

type JobState = { returnedRoughCarat: string; totalLabourCharge: string; remainingWipCost: string; status: string };
type Data = {
  receiptCode: string;
  jobId: string;
  wasFinal: boolean;
  jobAfter: JobState;
  rows: { id: string; returnMovementId: string; pieces: number; carat: string; cost: string }[];
  loss: { movementId: string; carat: string } | null;
};

async function load(tx: Tx, receiptId: string) {
  const receipt = await loadProcessedReceipt(tx, receiptId);
  const job = receipt.job;
  if (job.processOutputKindSnapshot !== "ROUGH") return null;
  const blockers: Blocker[] = [];

  const reversal = await receiptReversal(tx, receipt.id);
  if (reversal) blockers.push({ code: reversal.correctionCode, message: `${receipt.receiptCode} has already been reversed.` });

  const later = await tx.polishedReceipt.findMany({ where: { jobId: job.id, createdAt: { gt: receipt.createdAt } }, orderBy: { createdAt: "asc" } });
  for (const r of later) {
    if (!(await receiptReversal(tx, r.id))) blockers.push({ code: r.receiptCode, message: `${r.receiptCode} was received on ${job.jobCode} later — reverse it first (newest first).` });
  }
  for (const row of receipt.returnedPieces) blockers.push(...(await roughRowBlockers(tx, row)));

  const counts = await tx.correction.findMany({ where: { entityType: "DIAMOND_RECEIPT", entityId: receipt.id, mode: "ENTRY_QUANTITY", state: "POSTED", reversedByCorrectionId: null } });
  for (const c of counts) blockers.push({ code: c.correctionCode, message: `${c.correctionCode} corrected this receipt's returned pieces — reverse it first (newest first).` });
  const labour = await tx.diamondReceiptLabourCorrection.findMany({ where: { receiptId: receipt.id, correction: { state: "POSTED", reversedByCorrectionId: null } }, include: { correction: true } });
  for (const l of labour) blockers.push({ code: l.correction.correctionCode, message: `${l.correction.correctionCode} added labour to this receipt — reverse it first.` });

  const voucher = receipt.postingVoucherId
    ? await tx.voucher.findUnique({ where: { id: receipt.postingVoucherId }, include: { journalEntries: { include: { account: true, party: true } } } })
    : null;
  if (!voucher || voucher.status !== "POSTED") blockers.push({ code: receipt.receiptCode, message: `${receipt.receiptCode} has no posted voucher to mirror.` });

  const returnMoves = await tx.stockMovement.findMany({ where: { type: "ROUGH_RETURN_IN", sourceDocument: receipt.receiptCode, diamondJobId: job.id } });
  const lossMove = await tx.stockMovement.findFirst({ where: { type: "ROUGH_CONSUMED_OUT", sourceDocument: receipt.receiptCode, diamondJobId: job.id } });
  const others = await tx.polishedReceipt.findMany({ where: { jobId: job.id, id: { not: receipt.id } } });
  let otherLive = 0;
  for (const r of others) if (!(await receiptReversal(tx, r.id))) otherLive++;
  return { receipt, job, blockers, voucher, returnMoves, lossMove, otherLive };
}

export const processedRoughReversalHandler: EntryHandler = {
  kind: "RECEIPT_REVERSAL",
  entityTypes: ["DIAMOND_RECEIPT"],
  mode: "REVERSE_REPOST",
  entryClass: "STOCK_ACCOUNTING",
  reversible: false,

  async lock(tx, target) {
    await lockReceiptChain(tx, target.entityId);
  },

  async option(tx, target) {
    const l = await load(tx, target.entityId);
    if (!l) return null;
    return {
      kind: "RECEIPT_REVERSAL",
      label: "Reverse this receipt (to correct carat, charge or loss)",
      entryClass: "STOCK_ACCOUNTING",
      fields: [],
      blockers: l.blockers,
      note: "Posts a mirror correction voucher, takes the returned rough out of stock and puts the carat back as pending with the Manufacturer. Then receive the rough again with the right figures.",
      reversible: false,
    };
  },

  async plan(tx, target, _values, reason): Promise<HandlerPlan> {
    const l = await load(tx, target.entityId);
    if (!l) throw new CorrectionError("Only a processed-rough receipt can be reversed here.");
    const { receipt, job, voucher } = l;
    const lines = voucher?.journalEntries ?? [];
    const ledgerLines: JournalLineInput[] = [];
    const ledger: LedgerPreviewLine[] = [];
    let resolvedCost = ZERO;
    for (const j of lines) {
      const debit = new Decimal(j.debit);
      const credit = new Decimal(j.credit);
      if (debit.isZero() && credit.isZero()) continue;
      if (j.account.code === SYSTEM_ACCOUNT_CODES.DIAMOND_WIP) resolvedCost = resolvedCost.plus(credit).minus(debit);
      ledgerLines.push({ accountCode: j.account.code, partyId: j.partyId, debit: credit.toFixed(2), credit: debit.toFixed(2), description: `Reversal of ${receipt.receiptCode}` });
      ledger.push({ accountCode: j.account.code, accountName: j.account.name, party: j.party?.name ?? null, debit: credit.toFixed(2), credit: debit.toFixed(2) });
    }
    const amount = round2(ledgerLines.reduce((s, x) => s.plus(new Decimal(String(x.debit))), ZERO));

    const wasFinal = job.status === "COMPLETED";
    const before: JobState = {
      returnedRoughCarat: round3(job.returnedRoughCarat).toFixed(3),
      totalLabourCharge: round2(job.totalLabourCharge).toFixed(2),
      remainingWipCost: round2(job.remainingWipCost).toFixed(2),
      status: job.status,
    };
    const after: JobState = {
      returnedRoughCarat: round3(new Decimal(job.returnedRoughCarat).minus(receipt.returnedRoughCarat)).toFixed(3),
      totalLabourCharge: round2(new Decimal(job.totalLabourCharge).minus(receipt.labourCharge)).toFixed(2),
      remainingWipCost: round2(new Decimal(job.remainingWipCost).plus(resolvedCost)).toFixed(2),
      status: l.otherLive > 0 ? "PARTIALLY_RECEIVED" : "IN_PROGRESS",
    };

    const rows: Data["rows"] = [];
    const stock: StockLine[] = [];
    const impacts: PlannedImpact[] = [];
    for (const row of receipt.returnedPieces) {
      const move = l.returnMoves.find((m) => m.roughPieceId === row.id);
      if (!move) throw new CorrectionError(`${row.roughCode} has no return movement to mirror.`);
      rows.push({ id: row.id, returnMovementId: move.id, pieces: stonesOf(row), carat: round3(move.carat).toFixed(3), cost: round2(move.costValue).toFixed(2) });
      stock.push({ label: `${row.roughCode} leaves rough stock`, pieces: -stonesOf(row), carat: `-${round3(move.carat).toFixed(3)}`, cost: `-${round2(move.costValue).toFixed(2)}` });
      impacts.push({ kind: "STOCK", tableName: "rough_pieces", recordId: row.id, recordLabel: row.roughCode, field: "status", oldValue: row.status, newValue: "CANCELLED" });
    }
    const loss = l.lossMove ? { movementId: l.lossMove.id, carat: round3(l.lossMove.carat).toFixed(3) } : null;
    if (loss) stock.push({ label: `Weight loss goes back to pending with ${job.jobCode}`, pieces: 0, carat: loss.carat, cost: "0.00" });

    const jobImpact = (field: keyof JobState, kind: PlannedImpact["kind"]): PlannedImpact => ({
      kind, tableName: "diamond_jobs", recordId: job.id, recordLabel: job.jobCode, field, oldValue: before[field], newValue: after[field],
    });
    impacts.push(jobImpact("returnedRoughCarat", "RECORD"), jobImpact("totalLabourCharge", "PARTY"), jobImpact("remainingWipCost", "WIP"), jobImpact("status", "RECORD"));
    impacts.push({ kind: "LEDGER", tableName: "polished_receipts", recordId: receipt.id, recordLabel: receipt.receiptCode, field: "state", oldValue: "POSTED", newValue: "REVERSED" });

    const label = `${receipt.receiptCode} (${job.jobCode})`;
    return {
      entityLabel: label,
      plan: {
        entityType: "DIAMOND_RECEIPT",
        entityId: receipt.id,
        entityLabel: label,
        mode: "REVERSE_REPOST",
        reason,
        originalSnapshot: { entryKind: "RECEIPT_REVERSAL", receiptCode: receipt.receiptCode, voucher: voucher?.voucherNumber ?? null, job: before },
        correctedSnapshot: { entryKind: "RECEIPT_REVERSAL", receiptCode: receipt.receiptCode, job: after, cancelledRows: rows.map((r) => r.id) },
        downstream: [],
        impacts,
        ledgerLines,
        amount: amount.toFixed(2),
        voucherNote: `Reversal of ${job.processNameSnapshot ?? "processed rough"} receipt ${receipt.receiptCode} (${job.jobCode}) — mirror of ${voucher?.voucherNumber ?? "its voucher"}`,
        revaluations: [],
      },
      changes: [
        { field: "receipt", label: "Receipt", before: "Posted", after: "Reversed (enter it again with the right figures)" },
        { field: "returnedRoughCarat", label: `${job.jobCode} returned carat`, before: `${before.returnedRoughCarat} ct`, after: `${after.returnedRoughCarat} ct` },
        {
          field: "pending",
          label: `${job.jobCode} pending with the Manufacturer`,
          // A completed job has nothing pending (its gap was recognised as loss).
          before: wasFinal ? "0.000 ct (completed)" : `${round3(new Decimal(job.issuedRoughCarat).minus(job.receivedPolishedCarat).minus(before.returnedRoughCarat)).toFixed(3)} ct`,
          after: `${round3(new Decimal(job.issuedRoughCarat).minus(job.receivedPolishedCarat).minus(after.returnedRoughCarat)).toFixed(3)} ct`,
        },
        { field: "status", label: `${job.jobCode} status`, before: before.status, after: after.status },
        { field: "totalLabourCharge", label: `${job.jobCode} process charge`, before: `₹${before.totalLabourCharge}`, after: `₹${after.totalLabourCharge}` },
        { field: "remainingWipCost", label: `${job.jobCode} remaining WIP`, before: `₹${before.remainingWipCost}`, after: `₹${after.remainingWipCost}` },
      ],
      stock,
      ledger,
      affected: [...receipt.returnedPieces.map((r) => r.roughCode), job.jobCode, ...(voucher ? [voucher.voucherNumber] : [])],
      blockers: l.blockers,
      data: { receiptCode: receipt.receiptCode, jobId: job.id, wasFinal, jobAfter: after, rows, loss } satisfies Data,
    };
  },

  async apply(tx, built, correction) {
    const d = built.data as Data;
    const actor = correction.approvedByUserId!;
    for (const r of d.rows) {
      await tx.stockMovement.create({
        data: {
          type: "ROUGH_RETURN_REVERSAL_OUT",
          roughPieceId: r.id,
          diamondJobId: d.jobId,
          pieces: r.pieces,
          carat: r.carat,
          costValue: r.cost,
          sourceDocument: correction.correctionCode,
          reversalOfMovementId: r.returnMovementId,
          createdByUserId: actor,
        },
      });
      await tx.roughPiece.update({ where: { id: r.id }, data: { status: "CANCELLED" } });
    }
    if (d.loss) {
      await tx.stockMovement.create({
        data: {
          type: "ROUGH_CONSUMED_REVERSAL_IN",
          diamondJobId: d.jobId,
          pieces: 0,
          carat: d.loss.carat,
          costValue: "0.00",
          sourceDocument: correction.correctionCode,
          reversalOfMovementId: d.loss.movementId,
          createdByUserId: actor,
        },
      });
    }
    await tx.diamondJob.update({
      where: { id: d.jobId },
      data: {
        returnedRoughCarat: d.jobAfter.returnedRoughCarat,
        totalLabourCharge: d.jobAfter.totalLabourCharge,
        remainingWipCost: d.jobAfter.remainingWipCost,
        status: d.jobAfter.status as "IN_PROGRESS" | "PARTIALLY_RECEIVED",
      },
    });
    if (d.wasFinal) {
      const links = await tx.diamondJobPiece.findMany({ where: { jobId: d.jobId }, select: { roughPieceId: true } });
      await tx.roughPiece.updateMany({ where: { id: { in: links.map((x) => x.roughPieceId) }, status: "COMPLETED" }, data: { status: "WITH_KARIGAR" } });
    }
    const job = await tx.diamondJob.findUniqueOrThrow({ where: { id: d.jobId } });
    if (round3(job.returnedRoughCarat).toFixed(3) !== d.jobAfter.returnedRoughCarat || round2(job.remainingWipCost).toFixed(2) !== d.jobAfter.remainingWipCost) {
      throw new CorrectionError("Internal check failed: the job did not return to its state before the receipt. Nothing was saved.");
    }
  },

  async reverseBlockers() {
    return [{ code: "RECEIPT REVERSAL", message: "A receipt reversal is not undone — receive the rough again instead." }];
  },

  async undo() {
    throw new CorrectionError("A receipt reversal is not undone — receive the rough again instead.");
  },
};
