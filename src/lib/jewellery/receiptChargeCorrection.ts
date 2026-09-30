import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { UserRole } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import type { JournalLineInput } from "@/lib/accounting/posting";
import { postCorrection, reverseCorrection } from "@/lib/corrections/engine";
import {
  CorrectionError,
  fingerprintPlan,
  type CorrectionPlan,
  type DownstreamUse,
  type PlannedImpact,
  type Tx,
} from "@/lib/corrections/types";
import {
  allocateChargesToPieces,
  CHARGE_CATEGORIES,
  ChargeInputError,
  normaliseCharges,
  totalOf,
  type ChargeAmounts,
  type ChargeInput,
  type PieceChargeShare,
} from "@/lib/jewellery/receiptChargeAllocation";

/**
 * "Add missing charges" — an audited, Owner-only correction that adds Karigar
 * charges (labour / making / setting / plating / other) that were left out of a
 * jewellery receipt.
 *
 *  - The receipt row, its original voucher and every quantity stay exactly as
 *    they were. The addition is a NEW balanced CORRECTION voucher
 *    (Dr Finished Jewellery Inventory, Cr Karigar payable) plus linked
 *    correction rows that record each charge category and each piece's share.
 *  - The pieces' current carrying cost and the job's charge total move in the
 *    SAME transaction, by increments, under row locks — so every reader of
 *    piece cost (finished stock, future sale COGS, adjustments, Actual
 *    Costing) sees the correction exactly once, and a reversal removes exactly
 *    what was added.
 *  - Only while EVERY piece of the receipt is Available and has never been
 *    sold, returned, cancelled or adjusted. Checked again inside the posting
 *    (and reversal) transaction, after the rows are locked.
 */

export type ReceiptChargeEligibility = { ok: true } | { ok: false; reason: string };

const STATUS_WORDS: Record<string, string> = {
  SOLD: "sold",
  RETURNED_DAMAGED: "returned damaged",
};

/** Plain words for why a piece is not Available, from its latest stock movement when there is one. */
async function describeUnavailable(tx: Tx, piece: { id: string; status: string }): Promise<string> {
  const last = await tx.finishedJewelleryStockMovement.findFirst({
    where: { finishedJewelleryId: piece.id },
    orderBy: { createdAt: "desc" },
    select: { type: true },
  });
  if (last?.type === "OWNER_ADJUSTMENT_OUT") return "adjusted out of stock by the Owner";
  if (last?.type === "RETURNED_DAMAGED_OUT") return "returned damaged";
  return STATUS_WORDS[piece.status] ?? piece.status.toLowerCase().replace(/_/g, " ");
}

type PieceRow = {
  id: string;
  finishedCode: string;
  status: string;
  fineMetalWeight: Decimal;
  labourAllocated: Decimal;
  totalCost: Decimal;
};

/**
 * The single rule for "may charges be added to / removed from these pieces":
 * every piece is Available, and none has any stock history beyond being
 * produced (no sale, sale cancellation, return, or Owner adjustment) and no
 * sale line at all. Refusals name the piece and say why.
 */
export async function checkPiecesUntouched(tx: Tx, pieces: PieceRow[], verb: "added" | "reversed"): Promise<ReceiptChargeEligibility> {
  const action = verb === "added" ? "Charges can only be added" : "This correction can only be reversed";
  for (const p of pieces) {
    if (p.status === "RECEIPT_REVERSED") {
      return { ok: false, reason: `${p.finishedCode} belongs to a receipt the Owner reversed — it no longer exists.` };
    }
    if (p.status === "CUSTOMER_AWAITING_DELIVERY" || p.status === "DELIVERED_TO_CUSTOMER") {
      return { ok: false, reason: `${p.finishedCode} is Customer-owned jewellery (made from the Customer's own gold). It is delivered and billed to the Customer from its job — never sold, adjusted or re-costed as Company stock.` };
    }
    if (p.status !== "AVAILABLE") {
      const word = await describeUnavailable(tx, p);
      return {
        ok: false,
        reason: `${p.finishedCode} is ${word}. ${action} while every piece from this receipt is still Available and unsold — sold, returned or adjusted pieces are not supported yet.`,
      };
    }
  }
  const ids = pieces.map((p) => p.id);
  if (ids.length === 0) return { ok: true };

  const history = await tx.finishedJewelleryStockMovement.findMany({
    where: { finishedJewelleryId: { in: ids }, type: { not: "PRODUCED_IN" } },
    select: { finishedJewelleryId: true, type: true },
    take: 1,
  });
  if (history.length > 0) {
    const code = pieces.find((p) => p.id === history[0].finishedJewelleryId)?.finishedCode ?? "A piece";
    return {
      ok: false,
      reason: `${code} has stock history (${history[0].type.replace(/_/g, " ").toLowerCase()}). ${action} while every piece from this receipt is Available and has never been sold, returned or adjusted.`,
    };
  }
  const sales = await tx.finishedJewellerySaleLine.findFirst({
    where: { finishedJewelleryId: { in: ids } },
    select: { finishedJewelleryId: true },
  });
  if (sales) {
    const code = pieces.find((p) => p.id === sales.finishedJewelleryId)?.finishedCode ?? "A piece";
    return {
      ok: false,
      reason: `${code} has a sale on record. ${action} while every piece from this receipt has never been sold.`,
    };
  }
  return { ok: true };
}

async function loadPieces(tx: Tx, where: Prisma.FinishedJewelleryWhereInput): Promise<PieceRow[]> {
  const rows = await tx.finishedJewellery.findMany({
    where,
    orderBy: [{ finishedCode: "asc" }, { id: "asc" }],
    select: { id: true, finishedCode: true, status: true, fineMetalWeight: true, labourAllocated: true, totalCost: true },
  });
  return rows.map((r) => ({
    id: r.id,
    finishedCode: r.finishedCode,
    status: r.status,
    fineMetalWeight: new Decimal(r.fineMetalWeight),
    labourAllocated: new Decimal(r.labourAllocated),
    totalCost: new Decimal(r.totalCost),
  }));
}

/** Read-only: may charges be added to this receipt right now? (UI + preview.) */
export async function assessReceiptForCharges(tx: Tx, receiptId: string): Promise<ReceiptChargeEligibility> {
  const receipt = await tx.jewelleryReceipt.findUnique({ where: { id: receiptId }, select: { id: true, reversedAt: true, job: { select: { status: true } } } });
  if (!receipt) return { ok: false, reason: "Receipt not found." };
  if (receipt.reversedAt) return { ok: false, reason: "This receipt was reversed by the Owner." };
  if (receipt.job.status === "CANCELLED") return { ok: false, reason: "This job was cancelled." };
  const pieces = await loadPieces(tx, { receiptId });
  if (pieces.length === 0) {
    return { ok: false, reason: "This receipt produced no finished piece, so there is nothing to carry the charges." };
  }
  return checkPiecesUntouched(tx, pieces, "added");
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type ReceiptChargePlan = {
  plan: CorrectionPlan;
  charges: ChargeAmounts;
  total: Decimal;
  shares: PieceChargeShare[];
  receipt: { id: string; receiptCode: string; jobId: string; jobCode: string; karigarId: string; karigarName: string };
  pieces: PieceRow[];
};

async function karigarPayable(tx: Tx, karigarId: string): Promise<Decimal> {
  const account = await tx.account.findUnique({ where: { code: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE } });
  if (!account) return ZERO;
  const sums = await tx.journalEntry.aggregate({
    // Every entry, cancelled vouchers included: a reversal posts mirror entries, so originals and mirrors net to zero.
    where: { accountId: account.id, partyId: karigarId },
    _sum: { debit: true, credit: true },
  });
  return round2(new Decimal(sums._sum.credit ?? 0).minus(new Decimal(sums._sum.debit ?? 0)));
}

/** Builds the correction plan without writing anything. */
export async function planReceiptCharges(
  tx: Tx,
  input: { receiptId: string; charges: ChargeInput; reason: string }
): Promise<ReceiptChargePlan> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10) throw new CorrectionError("Give the reason for adding these charges (at least 10 characters).");

  let charges: ChargeAmounts;
  try {
    charges = normaliseCharges(input.charges);
  } catch (e) {
    if (e instanceof ChargeInputError) throw new CorrectionError(e.message);
    throw e;
  }
  const total = totalOf(charges);

  const receipt = await tx.jewelleryReceipt.findUnique({
    where: { id: input.receiptId },
    include: { job: { select: { id: true, jobCode: true, status: true, karigarId: true, totalLabourCharge: true, karigar: { select: { name: true } } } } },
  });
  if (!receipt) throw new CorrectionError("Receipt not found.");
  if (receipt.reversedAt) throw new CorrectionError("This receipt was reversed by the Owner, so charges cannot be added to it.");
  if (receipt.job.status === "CANCELLED") throw new CorrectionError("This job was cancelled, so charges cannot be added to it.");

  const pieces = await loadPieces(tx, { receiptId: receipt.id });
  if (pieces.length === 0) {
    throw new CorrectionError("This receipt produced no finished piece, so there is nothing to carry the charges.");
  }
  const eligibility = await checkPiecesUntouched(tx, pieces, "added");
  if (!eligibility.ok) throw new CorrectionError(eligibility.reason);

  let shares: PieceChargeShare[];
  try {
    shares = allocateChargesToPieces(charges, pieces);
  } catch (e) {
    if (e instanceof ChargeInputError) throw new CorrectionError(e.message);
    throw e;
  }
  const pieceById = new Map(pieces.map((p) => [p.id, p]));

  const impacts: PlannedImpact[] = [];
  const downstream: DownstreamUse[] = [];
  for (const s of shares) {
    const p = pieceById.get(s.finishedJewelleryId)!;
    impacts.push(
      {
        kind: "FINISHED",
        tableName: "finished_jewellery",
        recordId: p.id,
        recordLabel: p.finishedCode,
        field: "labourAllocated",
        oldValue: p.labourAllocated.toFixed(2),
        newValue: round2(p.labourAllocated.plus(s.total)).toFixed(2),
      },
      {
        kind: "FINISHED",
        tableName: "finished_jewellery",
        recordId: p.id,
        recordLabel: p.finishedCode,
        field: "totalCost",
        oldValue: p.totalCost.toFixed(2),
        newValue: round2(p.totalCost.plus(s.total)).toFixed(2),
      }
    );
  }
  const jobLabour = new Decimal(receipt.job.totalLabourCharge);
  impacts.push({
    kind: "WIP",
    tableName: "jewellery_jobs",
    recordId: receipt.job.id,
    recordLabel: receipt.job.jobCode,
    field: "totalLabourCharge",
    oldValue: jobLabour.toFixed(2),
    newValue: round2(jobLabour.plus(total)).toFixed(2),
  });
  const payableBefore = await karigarPayable(tx, receipt.job.karigarId);
  impacts.push({
    kind: "PARTY",
    tableName: "parties",
    recordId: receipt.job.karigarId,
    recordLabel: receipt.job.karigar.name,
    field: "payable",
    oldValue: payableBefore.toFixed(2),
    newValue: round2(payableBefore.plus(total)).toFixed(2),
  });

  // Frozen Actual Costing sheets for these pieces are historical documents and
  // are never rewritten; the Owner is told they exist so a new revision can be
  // taken deliberately.
  const frozen = await tx.costSheet.findMany({
    where: { sourceFinishedJewelleryId: { in: pieces.map((p) => p.id) }, status: "FINALIZED" },
    select: { id: true, costingNumber: true },
    take: 10,
  });
  for (const sheet of frozen) {
    downstream.push({
      kind: "FINISHED",
      tableName: "cost_sheets",
      recordId: sheet.id,
      recordLabel: sheet.costingNumber,
      description: `${sheet.costingNumber} is a frozen costing document and will NOT change; take a new Actual Costing snapshot to include the added charges.`,
    });
  }

  const label = `${receipt.receiptCode} · ${receipt.job.jobCode}`;
  const ledgerLines: JournalLineInput[] = [
    { accountCode: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, debit: total, description: `Missing charges — ${label}` },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: receipt.job.karigarId,
      credit: total,
      description: `Karigar payable — missing charges ${label}`,
    },
  ];

  const enteredSnapshot: Record<string, string> = {};
  for (const c of CHARGE_CATEGORIES) enteredSnapshot[c.key] = charges[c.key].toFixed(2);

  const plan: CorrectionPlan = {
    entityType: "JEWELLERY_RECEIPT",
    entityId: receipt.id,
    entityLabel: `${receipt.receiptCode} — missing charges`,
    mode: "ADD_CHARGES",
    reason,
    originalSnapshot: {
      receiptCode: receipt.receiptCode,
      labourCharge: new Decimal(receipt.labourCharge).toFixed(2),
      makingCharge: new Decimal(receipt.makingCharge).toFixed(2),
      settingCharge: new Decimal(receipt.settingCharge).toFixed(2),
      platingCharge: new Decimal(receipt.platingCharge).toFixed(2),
      otherExpense: new Decimal(receipt.otherExpense).toFixed(2),
      pieces: pieces.map((p) => ({ code: p.finishedCode, labourAllocated: p.labourAllocated.toFixed(2), totalCost: p.totalCost.toFixed(2) })),
    },
    correctedSnapshot: {
      added: enteredSnapshot,
      totalAdded: total.toFixed(2),
      pieces: shares.map((s) => {
        const p = pieceById.get(s.finishedJewelleryId)!;
        return {
          code: p.finishedCode,
          added: s.total.toFixed(2),
          labourAllocated: round2(p.labourAllocated.plus(s.total)).toFixed(2),
          totalCost: round2(p.totalCost.plus(s.total)).toFixed(2),
        };
      }),
    },
    downstream,
    impacts,
    ledgerLines,
    amount: total.toFixed(2),
    voucherNote: `Missing charges added to ${label} (${reason})`,
    revaluations: [],
  };

  return {
    plan,
    charges,
    total,
    shares,
    receipt: {
      id: receipt.id,
      receiptCode: receipt.receiptCode,
      jobId: receipt.job.id,
      jobCode: receipt.job.jobCode,
      karigarId: receipt.job.karigarId,
      karigarName: receipt.job.karigar.name,
    },
    pieces,
  };
}

export function chargePlanFingerprint(plan: CorrectionPlan): string {
  return JSON.stringify(fingerprintPlan(plan));
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------

/** Receipt first, then its pieces in id order — one fixed order for post and reverse. */
async function lockReceiptAndPieces(tx: Tx, receiptId: string, pieceIds: string[] | null): Promise<void> {
  const locked = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "jewellery_receipts" WHERE id = $1 FOR UPDATE`, receiptId);
  if (locked.length === 0) throw new CorrectionError("Receipt not found.");
  if (pieceIds === null) {
    await tx.$queryRawUnsafe(`SELECT id FROM "finished_jewellery" WHERE "receiptId" = $1 ORDER BY id FOR UPDATE`, receiptId);
  } else if (pieceIds.length > 0) {
    await tx.$queryRawUnsafe(`SELECT id FROM "finished_jewellery" WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, pieceIds);
  }
}

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------

export type PostReceiptChargesInput = {
  receiptId: string;
  charges: ChargeInput;
  reason: string;
  idempotencyKey: string;
  /** The preview fingerprint the Owner saw; posting is refused if the plan no longer matches. */
  expectedFingerprint?: string | null;
  owner: { id: string; role: UserRole };
  fyStartMonth: number;
  fyStartDay: number;
};

export async function postReceiptChargeCorrection(tx: Tx, input: PostReceiptChargesInput) {
  if (input.owner.role !== "OWNER") throw new CorrectionError("Only the Owner can add missing charges.");
  if (!input.idempotencyKey?.trim()) throw new CorrectionError("Missing submission key — reload the page and try again.");

  // Serialise everything that touches this receipt (a second click, a second
  // tab, a sale of one of its pieces): the receipt row, then its pieces.
  await lockReceiptAndPieces(tx, input.receiptId, null);

  // Duplicate submit: the same key means the same Owner action — return what
  // it already produced instead of posting again. Checked AFTER the lock so
  // two simultaneous submits cannot both get past it.
  const existing = await tx.correction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.entityId !== input.receiptId || existing.mode !== "ADD_CHARGES") {
      throw new CorrectionError("This submission key was already used for a different correction.");
    }
    return { correction: existing, replayed: true as const };
  }

  const built = await planReceiptCharges(tx, { receiptId: input.receiptId, charges: input.charges, reason: input.reason });
  if (input.expectedFingerprint && input.expectedFingerprint !== chargePlanFingerprint(built.plan)) {
    throw new CorrectionError(
      "The pieces or amounts changed after this preview was shown. Review the new preview and confirm again."
    );
  }

  const correction = await postCorrection(tx, {
    plan: built.plan,
    preparedByUserId: input.owner.id,
    approvedByUserId: input.owner.id,
    approverRole: input.owner.role,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    idempotencyKey: input.idempotencyKey,
  });

  const link = await tx.jewelleryReceiptChargeCorrection.create({
    data: {
      correctionId: correction.id,
      receiptId: built.receipt.id,
      jobId: built.receipt.jobId,
      labourCharge: built.charges.labourCharge.toFixed(2),
      makingCharge: built.charges.makingCharge.toFixed(2),
      settingCharge: built.charges.settingCharge.toFixed(2),
      platingCharge: built.charges.platingCharge.toFixed(2),
      otherExpense: built.charges.otherExpense.toFixed(2),
      totalCharge: built.total.toFixed(2),
    },
  });

  const pieceById = new Map(built.pieces.map((p) => [p.id, p]));
  for (const share of built.shares) {
    const piece = pieceById.get(share.finishedJewelleryId)!;
    const newLabour = round2(piece.labourAllocated.plus(share.total));
    const newTotal = round2(piece.totalCost.plus(share.total));
    await tx.jewelleryReceiptChargeCorrectionLine.create({
      data: {
        chargeCorrectionId: link.id,
        finishedJewelleryId: piece.id,
        labourCharge: share.charges.labourCharge.toFixed(2),
        makingCharge: share.charges.makingCharge.toFixed(2),
        settingCharge: share.charges.settingCharge.toFixed(2),
        platingCharge: share.charges.platingCharge.toFixed(2),
        otherExpense: share.charges.otherExpense.toFixed(2),
        totalCharge: share.total.toFixed(2),
        oldLabourAllocated: piece.labourAllocated.toFixed(2),
        newLabourAllocated: newLabour.toFixed(2),
        oldTotalCost: piece.totalCost.toFixed(2),
        newTotalCost: newTotal.toFixed(2),
      },
    });
    // Increments, not overwrites: the row is locked, and an increment can
    // never undo a concurrent change to another column of the same piece.
    await tx.finishedJewellery.update({
      where: { id: piece.id },
      data: { labourAllocated: { increment: share.total.toFixed(2) }, totalCost: { increment: share.total.toFixed(2) } },
    });
  }
  await tx.jewelleryJob.update({
    where: { id: built.receipt.jobId },
    data: { totalLabourCharge: { increment: built.total.toFixed(2) } },
  });

  // Prove the effect landed exactly once, or roll everything back.
  const after = await loadPieces(tx, { id: { in: built.pieces.map((p) => p.id) } });
  for (const share of built.shares) {
    const piece = pieceById.get(share.finishedJewelleryId)!;
    const now = after.find((p) => p.id === piece.id)!;
    if (!now.labourAllocated.equals(round2(piece.labourAllocated.plus(share.total))) || !now.totalCost.equals(round2(piece.totalCost.plus(share.total)))) {
      throw new CorrectionError(`Internal check failed on ${piece.finishedCode}; nothing was saved.`);
    }
  }

  return { correction, replayed: false as const, charge: link, total: built.total };
}

// ---------------------------------------------------------------------------
// Reverse
// ---------------------------------------------------------------------------

export async function reverseReceiptChargeCorrection(
  tx: Tx,
  input: {
    correctionId: string;
    reason: string;
    owner: { id: string; role: UserRole };
    fyStartMonth: number;
    fyStartDay: number;
  }
) {
  if (input.owner.role !== "OWNER") throw new CorrectionError("Only the Owner can reverse a correction.");
  if (input.reason.trim().length < 10) throw new CorrectionError("Give the reason for reversing this correction (at least 10 characters).");

  const first = await tx.correction.findUnique({
    where: { id: input.correctionId },
    select: { id: true, mode: true, entityId: true, receiptChargeCorrection: { select: { id: true } } },
  });
  if (!first || first.mode !== "ADD_CHARGES" || !first.receiptChargeCorrection) {
    throw new CorrectionError("This is not a missing-charges correction.");
  }

  // Lock the receipt and exactly the pieces this correction touched, then
  // re-read EVERYTHING — state, pieces, history — so what is checked is what
  // is reversed.
  const pieceIdRows = await tx.jewelleryReceiptChargeCorrectionLine.findMany({
    where: { chargeCorrectionId: first.receiptChargeCorrection.id },
    select: { finishedJewelleryId: true },
  });
  await lockReceiptAndPieces(tx, first.entityId, pieceIdRows.map((r) => r.finishedJewelleryId).sort());

  const correction = await tx.correction.findUnique({
    where: { id: input.correctionId },
    include: { receiptChargeCorrection: { include: { lines: true } } },
  });
  const link = correction?.receiptChargeCorrection;
  if (!correction || !link) throw new CorrectionError("This is not a missing-charges correction.");
  if (correction.state === "REVERSED" || correction.reversedByCorrectionId) {
    throw new CorrectionError("This correction has already been reversed.");
  }
  if (correction.state !== "POSTED") throw new CorrectionError("Only a posted correction can be reversed.");

  const pieces = await loadPieces(tx, { id: { in: link.lines.map((l) => l.finishedJewelleryId) } });
  const eligibility = await checkPiecesUntouched(tx, pieces, "reversed");
  if (!eligibility.ok) throw new CorrectionError(eligibility.reason);
  for (const line of link.lines) {
    const p = pieces.find((x) => x.id === line.finishedJewelleryId)!;
    if (p.labourAllocated.minus(line.totalCharge).isNegative() || p.totalCost.minus(line.totalCharge).isNegative()) {
      throw new CorrectionError(`${p.finishedCode}'s cost has fallen below the amount this correction added, so it cannot be removed cleanly.`);
    }
  }

  const reversal = await reverseCorrection(tx, {
    correctionId: correction.id,
    reason: input.reason,
    approverRole: input.owner.role,
    approvedByUserId: input.owner.id,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
  });

  for (const line of link.lines) {
    await tx.finishedJewellery.update({
      where: { id: line.finishedJewelleryId },
      data: { labourAllocated: { decrement: line.totalCharge.toFixed(2) }, totalCost: { decrement: line.totalCharge.toFixed(2) } },
    });
  }
  await tx.jewelleryJob.update({ where: { id: link.jobId }, data: { totalLabourCharge: { decrement: link.totalCharge.toFixed(2) } } });

  return { reversal, total: new Decimal(link.totalCharge) };
}
