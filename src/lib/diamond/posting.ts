import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  CertificateStatus,
  DiamondShape,
  GstTreatment,
  ProcessChargeRateBasis,
  RateBasis,
} from "@/generated/prisma/enums";

import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { splitGstAmount } from "@/lib/accounting/gst";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import {
  createVoucherHeader,
  insertBalancedJournalLines,
  PostingError,
  type JournalLineInput,
} from "@/lib/accounting/posting";
import { cancelVoucher } from "@/lib/accounting/posting";
import { allocateProportionally, round3 } from "@/lib/diamond/allocation";
import { buildPacketMergeKey } from "@/lib/diamond/packets";
import { nextDiamondCode } from "@/lib/diamond/numbering";
import { computeProcessCharge } from "@/lib/diamond/processCharge";

export { PostingError };

type Tx = Prisma.TransactionClient;

type FyInput = { fyStartMonth: number; fyStartDay: number };

/**
 * Takes a row-level lock (SELECT … FOR UPDATE) on the given rows, in id
 * order so two transactions locking overlapping sets can never deadlock.
 * Issue, cancel and receive all read-then-write balances that another
 * request could change in between; without this two concurrent issues could
 * each pass the same "enough carat left" check and overdraw a parcel. The
 * lock is held until the surrounding transaction commits or rolls back.
 * `table` is always a literal from this file (never user input); the ids are
 * bound as parameters.
 */
async function lockRows(tx: Tx, table: "rough_pieces" | "diamond_jobs", ids: string[]) {
  const unique = [...new Set(ids)].sort();
  if (unique.length === 0) return;
  const placeholders = unique.map((_, i) => `$${i + 1}`).join(", ");
  await tx.$queryRawUnsafe(`SELECT id FROM "${table}" WHERE id IN (${placeholders}) ORDER BY id FOR UPDATE`, ...unique);
}

/** A carat quantity typed by a person: a real, positive number with at most
 * 3 decimals. Anything else is refused rather than silently rounded. */
function parseCaratQuantity(value: DecimalInput, label: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw new PostingError(`${label} is not a valid number.`);
  }
  if (!parsed.isFinite()) throw new PostingError(`${label} is not a valid number.`);
  if (!parsed.greaterThan(0)) throw new PostingError(`${label} must be greater than zero.`);
  if (parsed.decimalPlaces() > 3) throw new PostingError(`${label} can have at most 3 decimal places.`);
  return parsed;
}

function validateStoneCount(count: number | null | undefined, label: string): number | null {
  if (count == null) return null;
  if (!Number.isInteger(count) || count < 1) throw new PostingError(`${label} must be a whole number of at least 1.`);
  return count;
}

// ---------------------------------------------------------------------------
// Rough purchase (creates the lot + every piece + the accounting voucher)
// ---------------------------------------------------------------------------

export type RoughPieceDraft = {
  /** STONE (default) = one individual stone, always issued whole. PARCEL = a
   * multi-stone parcel bought as one row, which can be issued in part. */
  kind?: "STONE" | "PARCEL";
  /** Stones in a parcel, where the Owner counted them. Never for a STONE. */
  pieceCount?: number | null;
  carat: DecimalInput;
  lengthMm?: DecimalInput | null;
  widthMm?: DecimalInput | null;
  heightMm?: DecimalInput | null;
  colorEstimate?: string | null;
  clarityNote?: string | null;
  internalNote?: string | null;
  photoAssetId?: string | null;
  /** Owner-supplied individual cost. Only honored when EVERY piece in the
   * lot supplies one and they sum exactly to the lot total — otherwise
   * proportional-by-carat allocation is used for the whole lot, never a
   * partial mix (which could silently misallocate cost). */
  manualAllocatedCost?: DecimalInput | null;
};

export async function createRoughLotWithPieces(
  tx: Tx,
  input: FyInput & {
    purchaseDate: Date;
    supplierId: string;
    purchaseRate: DecimalInput;
    rateBasis: RateBasis;
    currencyCode: string;
    exchangeRate: DecimalInput;
    totalPurchaseCost: DecimalInput;
    gstTreatment: GstTreatment;
    gstRateId?: string | null;
    gstRatePercent?: DecimalInput | null;
    supplierInvoiceRef?: string | null;
    notes?: string | null;
    photoAssetId?: string | null;
    paymentAccountId?: string | null;
    pieces: RoughPieceDraft[];
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  const totalPurchaseCost = round2(input.totalPurchaseCost);
  if (!totalPurchaseCost.greaterThan(0)) {
    throw new PostingError("Purchase cost must be greater than zero.");
  }
  if (input.pieces.length === 0) {
    throw new PostingError("A rough purchase must have at least one piece.");
  }

  const totalCarat = input.pieces.reduce((sum, p) => sum.plus(new Decimal(p.carat)), ZERO);
  if (!totalCarat.greaterThan(0)) {
    throw new PostingError("Total carat must be greater than zero.");
  }

  // Only a PARCEL may carry a stone count, and only a PARCEL can later be
  // issued in part — an individual stone is never silently treated as one.
  const pieceCounts = input.pieces.map((p) => {
    const count = validateStoneCount(p.pieceCount, "The number of stones");
    if ((p.kind ?? "STONE") === "STONE" && count != null) {
      throw new PostingError("An individual stone cannot have a stone count — record it as a parcel instead.");
    }
    return count;
  });

  const allManual = input.pieces.every((p) => p.manualAllocatedCost != null);
  let allocatedCosts: Decimal[];
  if (allManual) {
    const manual = input.pieces.map((p) => round2(p.manualAllocatedCost!));
    const manualSum = manual.reduce((sum, c) => sum.plus(c), ZERO);
    if (!manualSum.equals(totalPurchaseCost)) {
      throw new PostingError(
        `Manual piece costs sum to ${manualSum.toFixed(2)}, which must exactly equal the lot's total purchase cost ${totalPurchaseCost.toFixed(2)}.`
      );
    }
    allocatedCosts = manual;
  } else {
    const allocation = allocateProportionally(
      totalPurchaseCost,
      input.pieces.map((p, i) => ({ key: String(i), weight: p.carat }))
    );
    allocatedCosts = input.pieces.map((_, i) => allocation.find((a) => a.key === String(i))!.amount);
  }

  const lotCode = await nextDiamondCode(tx, "ROUGH_LOT");

  const gstRatePercent =
    input.gstTreatment === "NONE" ? ZERO : new Decimal(input.gstRatePercent ?? 0);
  const taxAmount =
    input.gstTreatment === "NONE"
      ? ZERO
      : round2(totalPurchaseCost.times(gstRatePercent).dividedBy(100));
  const { cgst, sgst, igst } = splitGstAmount(taxAmount, input.gstTreatment);
  const payableAmount = round2(totalPurchaseCost.plus(taxAmount));

  const voucher = await createVoucherHeader(
    tx,
    {
      date: input.purchaseDate,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
      currencyCode: input.currencyCode,
      exchangeRate: input.exchangeRate,
      referenceNumber: input.supplierInvoiceRef,
      note: `Rough diamond purchase ${lotCode}`,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.createdByUserId,
    },
    "PURCHASE",
    {
      amount: payableAmount,
      partyId: input.supplierId,
      paymentAccountId: input.paymentAccountId,
      gstTreatment: input.gstTreatment,
    }
  );

  const journalLines: JournalLineInput[] = [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY,
      debit: totalPurchaseCost,
      description: `Rough purchase ${lotCode}`,
    },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_CGST, debit: cgst, description: "Input CGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_SGST, debit: sgst, description: "Input SGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_IGST, debit: igst, description: "Input IGST" },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: input.supplierId,
      credit: payableAmount,
      description: `Rough purchase ${lotCode}`,
    },
  ];

  if (input.paymentAccountId) {
    const paymentAccount = await tx.paymentAccount.findUnique({
      where: { id: input.paymentAccountId },
      select: { account: { select: { code: true } } },
    });
    if (!paymentAccount) throw new PostingError("Payment account not found.");
    journalLines.push(
      {
        accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
        partyId: input.supplierId,
        debit: payableAmount,
        description: "Purchase settled immediately",
      },
      {
        accountCode: paymentAccount.account.code,
        credit: payableAmount,
        description: "Purchase settled immediately",
      }
    );
  }

  await insertBalancedJournalLines(tx, voucher.id, journalLines);

  const lot = await tx.roughLot.create({
    data: {
      lotCode,
      purchaseDate: input.purchaseDate,
      supplierId: input.supplierId,
      piecesCount: input.pieces.length,
      totalRoughCarat: round3(totalCarat).toFixed(3),
      purchaseRate: new Decimal(input.purchaseRate).toFixed(4),
      rateBasis: input.rateBasis,
      currencyCode: input.currencyCode,
      exchangeRate: new Decimal(input.exchangeRate).toFixed(4),
      totalPurchaseCost: totalPurchaseCost.toFixed(2),
      gstTreatment: input.gstTreatment,
      gstRateId: input.gstRateId ?? null,
      gstRatePercent: input.gstTreatment === "NONE" ? null : gstRatePercent.toFixed(2),
      supplierInvoiceRef: input.supplierInvoiceRef ?? null,
      notes: input.notes ?? null,
      photoAssetId: input.photoAssetId ?? null,
      voucherId: voucher.id,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  for (let i = 0; i < input.pieces.length; i++) {
    const draft = input.pieces[i];
    const roughCode = await nextDiamondCode(tx, "ROUGH_PIECE");
    const isParcel = (draft.kind ?? "STONE") === "PARCEL";
    const piece = await tx.roughPiece.create({
      data: {
        roughCode,
        lotId: lot.id,
        kind: isParcel ? "PARCEL" : "STONE",
        pieceCount: pieceCounts[i],
        // Immutable snapshot of the parcel as bought — the live carat / cost /
        // count above shrink as portions are issued and grow back on cancel.
        originalCarat: isParcel ? round3(draft.carat).toFixed(3) : null,
        originalPieceCount: isParcel ? pieceCounts[i] : null,
        originalCost: isParcel ? allocatedCosts[i].toFixed(2) : null,
        carat: round3(draft.carat).toFixed(3),
        lengthMm: draft.lengthMm != null ? new Decimal(draft.lengthMm).toFixed(3) : null,
        widthMm: draft.widthMm != null ? new Decimal(draft.widthMm).toFixed(3) : null,
        heightMm: draft.heightMm != null ? new Decimal(draft.heightMm).toFixed(3) : null,
        colorEstimate: draft.colorEstimate ?? null,
        clarityNote: draft.clarityNote ?? null,
        internalNote: draft.internalNote ?? null,
        photoAssetId: draft.photoAssetId ?? null,
        allocatedCost: allocatedCosts[i].toFixed(2),
        createdByUserId: input.createdByUserId,
      },
    });

    await tx.stockMovement.create({
      data: {
        type: "ROUGH_PURCHASE_IN",
        roughPieceId: piece.id,
        pieces: pieceCounts[i] ?? 1,
        carat: piece.carat,
        costValue: piece.allocatedCost,
        sourceDocument: lotCode,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  return lot;
}

// ---------------------------------------------------------------------------
// Issue rough to Karigar
// ---------------------------------------------------------------------------

/** A partial issue from one PARCEL: how much of it goes out. */
export type ParcelIssueInput = {
  roughPieceId: string;
  /** Carat to issue — at most 3 decimals, more than zero, no more than the parcel's remaining carat. */
  carat: DecimalInput;
  /** Stones going out. Required for a partial issue when the parcel's stone count was recorded; refused when it was not. */
  pieceCount?: number | null;
};

/** One rough row (or the issued portion of a parcel) that goes into a job. */
type PlannedIssue = {
  row: { id: string; roughCode: string; lotId: string | null; colorEstimate: string | null; clarityNote: string | null; carat: unknown; allocatedCost: unknown; pieceCount: number | null };
  carat: Decimal;
  cost: Decimal;
  count: number | null;
  split: { remainingCarat: Decimal; remainingCost: Decimal; remainingCount: number | null } | null;
};

export async function issueRoughToKarigar(
  tx: Tx,
  input: FyInput & {
    karigarId: string;
    /** Whole rows to issue: individual stones, or a parcel issued in full. */
    roughPieceIds?: string[];
    /** Parcels issued by carat — a partial issue splits the issued portion off. */
    parcelIssues?: ParcelIssueInput[];
    requiredShape: DiamondShape;
    customShapeName?: string | null;
    customShapeReferencePhotoAssetId?: string | null;
    customShapeMeasurements?: string | null;
    customShapeInstruction?: string | null;
    issueDate: Date;
    dueDate?: Date | null;
    targetPolishedCarat?: DecimalInput | null;
    targetLengthMm?: DecimalInput | null;
    targetWidthMm?: DecimalInput | null;
    targetHeightMm?: DecimalInput | null;
    notes?: string | null;
    /** Phase 7 — the Manufacturer process (4P / Laser, HPHT / Grow, …). */
    processId?: string | null;
    chargeRateBasis?: ProcessChargeRateBasis | null;
    chargeRate?: DecimalInput | null;
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  const wholeIds = input.roughPieceIds ?? [];
  const parcelIssues = input.parcelIssues ?? [];
  if (wholeIds.length === 0 && parcelIssues.length === 0) {
    throw new PostingError("Select at least one rough piece to issue.");
  }
  const requestedIds = [...wholeIds, ...parcelIssues.map((p) => p.roughPieceId)];
  const uniqueIds = [...new Set(requestedIds)];
  if (uniqueIds.length !== requestedIds.length) {
    throw new PostingError("The same rough piece was selected more than once.");
  }

  // Lock every requested row BEFORE reading its balance: whoever gets here
  // second waits for the first to commit, then sees the reduced balance (or
  // the already-created job) instead of both passing the same check.
  await lockRows(tx, "rough_pieces", uniqueIds);

  // Idempotent: a repeat of an already-committed issue (double click, retry)
  // hands back the job it created rather than issuing again. Checked after
  // the lock so a concurrent duplicate that was waiting sees the winner.
  if (input.idempotencyKey) {
    const existing = await tx.diamondJob.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return existing;
  }

  const pieces = await tx.roughPiece.findMany({ where: { id: { in: uniqueIds } } });
  if (pieces.length !== uniqueIds.length) {
    throw new PostingError("One or more selected rough pieces were not found.");
  }
  for (const piece of pieces) {
    if (piece.status !== "AVAILABLE") {
      throw new PostingError(
        `Rough piece ${piece.roughCode} is not available to issue (current status: ${piece.status}).`
      );
    }
  }
  const pieceById = new Map(pieces.map((p) => [p.id, p]));

  // ---- Plan what actually goes out: whole rows, and parcel portions ----
  const plan: PlannedIssue[] = [];
  for (const id of wholeIds) {
    const piece = pieceById.get(id)!;
    plan.push({
      row: piece,
      carat: new Decimal(piece.carat),
      cost: new Decimal(piece.allocatedCost),
      count: piece.pieceCount ?? null,
      split: null,
    });
  }
  for (const request of parcelIssues) {
    const piece = pieceById.get(request.roughPieceId)!;
    if (piece.kind !== "PARCEL") {
      throw new PostingError(
        `Rough piece ${piece.roughCode} is an individual stone — it can only be issued whole, not by carat.`
      );
    }
    const wanted = parseCaratQuantity(request.carat, `Carat to issue from ${piece.roughCode}`);
    const remaining = new Decimal(piece.carat);
    if (wanted.greaterThan(remaining)) {
      throw new PostingError(
        `Cannot issue ${wanted.toFixed(3)}ct from parcel ${piece.roughCode} — only ${remaining.toFixed(3)}ct remain in it.`
      );
    }
    const requestedCount = validateStoneCount(request.pieceCount, `The number of stones for ${piece.roughCode}`);

    if (wanted.equals(remaining)) {
      // The whole remaining parcel goes out — no split, no child row.
      if (requestedCount != null && requestedCount !== (piece.pieceCount ?? null)) {
        throw new PostingError(
          piece.pieceCount == null
            ? `Parcel ${piece.roughCode} has no recorded stone count, so a count cannot be issued from it.`
            : `Issuing all ${remaining.toFixed(3)}ct of ${piece.roughCode} means all ${piece.pieceCount} stones, not ${requestedCount}.`
        );
      }
      plan.push({ row: piece, carat: remaining, cost: new Decimal(piece.allocatedCost), count: piece.pieceCount ?? null, split: null });
      continue;
    }

    let issuedCount: number | null = null;
    let remainingCount: number | null = null;
    if (piece.pieceCount != null) {
      if (requestedCount == null) {
        throw new PostingError(
          `Enter how many stones you are issuing from ${piece.roughCode} — its ${piece.pieceCount} stones are recorded.`
        );
      }
      if (requestedCount >= piece.pieceCount) {
        throw new PostingError(
          `Cannot issue ${requestedCount} stones from ${piece.roughCode} while keeping ${remaining.minus(wanted).toFixed(3)}ct — only ${piece.pieceCount} stones remain, and at least one must stay with the rest.`
        );
      }
      issuedCount = requestedCount;
      remainingCount = piece.pieceCount - requestedCount;
    } else if (requestedCount != null) {
      throw new PostingError(`Parcel ${piece.roughCode} has no recorded stone count, so a count cannot be issued from it.`);
    }

    // Exact proportional split: the issued share is rounded once, and the
    // remainder is whatever is left — the two always sum to the parcel's cost.
    const parcelCost = new Decimal(piece.allocatedCost);
    const issuedShare = round2(parcelCost.times(wanted).dividedBy(remaining));
    if (parcelCost.greaterThan(0) && !issuedShare.greaterThan(0)) {
      throw new PostingError(
        `${wanted.toFixed(3)}ct of parcel ${piece.roughCode} carries less than ₹0.01 of cost — issue a larger quantity.`
      );
    }
    plan.push({
      row: piece,
      carat: wanted,
      cost: issuedShare,
      count: issuedCount,
      split: { remainingCarat: remaining.minus(wanted), remainingCost: parcelCost.minus(issuedShare), remainingCount },
    });
  }

  // ---- Phase 7: Manufacturer process + agreed charge rate ----
  let diamondProcess: { id: string; name: string; outputKind: "ROUGH" | "POLISHED" } | null = null;
  if (input.processId) {
    const found = await tx.diamondProcess.findUnique({ where: { id: input.processId } });
    if (!found || !found.isActive) throw new PostingError("The selected process was not found or is inactive.");
    diamondProcess = found;
  }
  let chargeRate: Decimal | null = null;
  if (input.chargeRateBasis) {
    chargeRate = new Decimal(input.chargeRate ?? 0).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    if (chargeRate.isNegative()) throw new PostingError("The process charge rate cannot be negative.");
  } else if (input.chargeRate != null && !new Decimal(input.chargeRate).isZero()) {
    throw new PostingError("Choose how the process charge is calculated (fixed, per carat or per piece).");
  }

  const issuedRoughCarat = plan.reduce((sum, p) => sum.plus(p.carat), ZERO);
  const issuedCostValue = plan.reduce((sum, p) => sum.plus(p.cost), ZERO);
  // A row without a recorded stone count counts as one piece.
  const issuedPiecesCount = plan.reduce((sum, p) => sum + (p.count ?? 1), 0);

  const jobCode = await nextDiamondCode(tx, "DIAMOND_JOB");

  const voucher = await createVoucherHeader(
    tx,
    {
      date: input.issueDate,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
      currencyCode: "INR",
      exchangeRate: 1,
      note: diamondProcess ? `Rough issued for ${diamondProcess.name} — job ${jobCode}` : `Rough issued to Karigar — job ${jobCode}`,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.createdByUserId,
    },
    "DIAMOND_ISSUE",
    { amount: issuedCostValue }
  );

  await insertBalancedJournalLines(tx, voucher.id, [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.DIAMOND_WIP,
      debit: issuedCostValue,
      description: `Issue ${jobCode}`,
    },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY,
      credit: issuedCostValue,
      description: `Issue ${jobCode}`,
    },
  ]);

  const job = await tx.diamondJob.create({
    data: {
      jobCode,
      karigarId: input.karigarId,
      requiredShape: input.requiredShape,
      customShapeName: input.requiredShape === "CUSTOM" ? input.customShapeName ?? null : null,
      customShapeReferencePhotoAssetId: input.customShapeReferencePhotoAssetId ?? null,
      customShapeMeasurements: input.customShapeMeasurements ?? null,
      customShapeInstruction: input.customShapeInstruction ?? null,
      issueDate: input.issueDate,
      dueDate: input.dueDate ?? null,
      targetPolishedCarat:
        input.targetPolishedCarat != null ? round3(input.targetPolishedCarat).toFixed(3) : null,
      targetLengthMm:
        input.targetLengthMm != null ? new Decimal(input.targetLengthMm).toFixed(3) : null,
      targetWidthMm:
        input.targetWidthMm != null ? new Decimal(input.targetWidthMm).toFixed(3) : null,
      targetHeightMm:
        input.targetHeightMm != null ? new Decimal(input.targetHeightMm).toFixed(3) : null,
      notes: input.notes ?? null,
      processId: diamondProcess?.id ?? null,
      processNameSnapshot: diamondProcess?.name ?? null,
      processOutputKindSnapshot: diamondProcess?.outputKind ?? null,
      chargeRateBasis: input.chargeRateBasis ?? null,
      chargeRate: chargeRate ? chargeRate.toFixed(4) : null,
      issuedPiecesCount,
      issuedRoughCarat: round3(issuedRoughCarat).toFixed(3),
      issuedCostValue: issuedCostValue.toFixed(2),
      remainingWipCost: issuedCostValue.toFixed(2),
      wipVoucherId: voucher.id,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  for (const item of plan) {
    let issuedRowId = item.row.id;

    if (item.split) {
      // Partial parcel issue: split the issued portion off into its own row
      // (linked to the parcel by parentPieceId) and reduce the parcel. Nothing
      // is created or destroyed — the two rows always sum to the parcel as it
      // was — so the original purchase stays reconstructable.
      const childCode = await nextDiamondCode(tx, "ROUGH_PIECE");
      const child = await tx.roughPiece.create({
        data: {
          roughCode: childCode,
          lotId: item.row.lotId,
          kind: "PARCEL",
          pieceCount: item.count,
          originalCarat: item.carat.toFixed(3),
          originalPieceCount: item.count,
          originalCost: item.cost.toFixed(2),
          parentPieceId: item.row.id,
          carat: item.carat.toFixed(3),
          allocatedCost: item.cost.toFixed(2),
          colorEstimate: item.row.colorEstimate ?? null,
          clarityNote: item.row.clarityNote ?? null,
          internalNote: `Issued portion of parcel ${item.row.roughCode} — job ${jobCode}`,
          status: "WITH_KARIGAR",
          costLocked: true,
          createdByUserId: input.createdByUserId,
        },
      });
      await tx.roughPiece.update({
        where: { id: item.row.id },
        data: {
          carat: item.split.remainingCarat.toFixed(3),
          allocatedCost: item.split.remainingCost.toFixed(2),
          pieceCount: item.split.remainingCount,
        },
      });
      await tx.stockMovement.create({
        data: {
          type: "ROUGH_PARCEL_SPLIT_OUT",
          roughPieceId: item.row.id,
          diamondJobId: job.id,
          pieces: item.count ?? 0,
          carat: item.carat.toFixed(3),
          costValue: item.cost.toFixed(2),
          sourceDocument: jobCode,
          createdByUserId: input.createdByUserId,
        },
      });
      await tx.stockMovement.create({
        data: {
          type: "ROUGH_PARCEL_SPLIT_IN",
          roughPieceId: child.id,
          diamondJobId: job.id,
          pieces: item.count ?? 0,
          carat: item.carat.toFixed(3),
          costValue: item.cost.toFixed(2),
          sourceDocument: jobCode,
          createdByUserId: input.createdByUserId,
        },
      });
      issuedRowId = child.id;
    } else {
      await tx.roughPiece.update({
        where: { id: item.row.id },
        data: { status: "WITH_KARIGAR", costLocked: true },
      });
    }

    await tx.diamondJobPiece.create({
      data: {
        jobId: job.id,
        roughPieceId: issuedRowId,
        caratAtIssue: item.carat.toFixed(3),
        costAtIssue: item.cost.toFixed(2),
      },
    });
    await tx.stockMovement.create({
      data: {
        type: "ROUGH_ISSUE_OUT",
        roughPieceId: issuedRowId,
        diamondJobId: job.id,
        pieces: item.count ?? 1,
        carat: item.carat.toFixed(3),
        costValue: item.cost.toFixed(2),
        sourceDocument: jobCode,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  return job;
}

// ---------------------------------------------------------------------------
// Cancel an unused issue (Owner-only; enforced by the caller)
// ---------------------------------------------------------------------------

export async function cancelDiamondJob(
  tx: Tx,
  input: FyInput & { jobId: string; cancelledByUserId: string; cancellationReason: string }
) {
  // Lock the job first: a cancel racing a receipt (or a second cancel) waits
  // here and then sees the job's real status, so a receipt can never slip in
  // beneath a cancel and the reversal can only ever happen once.
  await lockRows(tx, "diamond_jobs", [input.jobId]);

  const job = await tx.diamondJob.findUnique({
    where: { id: input.jobId },
    include: { pieces: true },
  });
  if (!job) throw new PostingError("Job not found.");
  if (job.status === "CANCELLED") throw new PostingError("This job has already been cancelled.");
  if (job.status !== "ISSUED" && job.status !== "IN_PROGRESS") {
    throw new PostingError(
      "This job cannot be cancelled once any polished diamonds have been received — use a receipt correction instead."
    );
  }
  if (!new Decimal(job.receivedPolishedCarat).isZero() || !new Decimal(job.returnedRoughCarat).isZero()) {
    throw new PostingError("This job already has received material; it cannot be cancelled.");
  }

  // Lock the issued rows AND any parcel they were split from, then read them
  // fresh: a parcel portion is merged back into its parent's live balance.
  const linkedIds = job.pieces.map((l) => l.roughPieceId);
  const firstRead = await tx.roughPiece.findMany({ where: { id: { in: linkedIds } } });
  const parentIds = firstRead.map((p) => p.parentPieceId).filter((id): id is string => !!id);
  await lockRows(tx, "rough_pieces", [...linkedIds, ...parentIds]);
  const rows = await tx.roughPiece.findMany({ where: { id: { in: [...linkedIds, ...parentIds] } } });
  const rowById = new Map(rows.map((r) => [r.id, r]));

  for (const link of job.pieces) {
    const piece = rowById.get(link.roughPieceId);
    if (!piece || piece.status !== "WITH_KARIGAR") {
      throw new PostingError(
        `Rough piece ${piece?.roughCode ?? link.roughPieceId} is no longer with the Manufacturer (status ${piece?.status ?? "missing"}) — this job cannot be cancelled safely.`
      );
    }
  }

  if (job.wipVoucherId) {
    await cancelVoucher(tx, {
      voucherId: job.wipVoucherId,
      cancelledByUserId: input.cancelledByUserId,
      cancellationReason: input.cancellationReason,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
    });
  }

  for (const link of job.pieces) {
    const piece = rowById.get(link.roughPieceId)!;
    const parent = piece.parentPieceId ? rowById.get(piece.parentPieceId) : undefined;
    const pieceCount = piece.pieceCount ?? null;

    await tx.stockMovement.create({
      data: {
        type: "ROUGH_ISSUE_CANCEL_IN",
        roughPieceId: link.roughPieceId,
        diamondJobId: job.id,
        pieces: pieceCount ?? 1,
        carat: link.caratAtIssue,
        costValue: link.costAtIssue,
        sourceDocument: job.jobCode,
        createdByUserId: input.cancelledByUserId,
      },
    });

    if (parent && parent.status === "AVAILABLE") {
      // Restore exactly what was issued, once, into the parcel it came from.
      await tx.roughPiece.update({
        where: { id: parent.id },
        data: {
          carat: round3(new Decimal(parent.carat).plus(link.caratAtIssue)).toFixed(3),
          allocatedCost: round2(new Decimal(parent.allocatedCost).plus(link.costAtIssue)).toFixed(2),
          pieceCount: parent.pieceCount != null && pieceCount != null ? parent.pieceCount + pieceCount : (parent.pieceCount ?? null),
        },
      });
      await tx.roughPiece.update({ where: { id: piece.id }, data: { status: "CANCELLED" } });
      await tx.stockMovement.create({
        data: {
          type: "ROUGH_PARCEL_MERGE_OUT",
          roughPieceId: piece.id,
          diamondJobId: job.id,
          pieces: pieceCount ?? 0,
          carat: link.caratAtIssue,
          costValue: link.costAtIssue,
          sourceDocument: job.jobCode,
          createdByUserId: input.cancelledByUserId,
        },
      });
      await tx.stockMovement.create({
        data: {
          type: "ROUGH_PARCEL_MERGE_IN",
          roughPieceId: parent.id,
          diamondJobId: job.id,
          pieces: pieceCount ?? 0,
          carat: link.caratAtIssue,
          costValue: link.costAtIssue,
          sourceDocument: job.jobCode,
          createdByUserId: input.cancelledByUserId,
        },
      });
    } else {
      // A whole row (or a parcel portion whose parent has itself since gone
      // out to another job): back to Available exactly as issued.
      await tx.roughPiece.update({ where: { id: link.roughPieceId }, data: { status: "AVAILABLE" } });
    }
  }

  return tx.diamondJob.update({
    where: { id: job.id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledByUserId: input.cancelledByUserId,
      cancellationReason: input.cancellationReason,
      // The WIP voucher is reversed above, so nothing is left in WIP. The
      // issued carat / cost columns are untouched — they are the history.
      remainingWipCost: "0.00",
    },
  });
}

// ---------------------------------------------------------------------------
// Receive polished diamonds (one or more outputs; supports partial receipts)
// ---------------------------------------------------------------------------

export type PolishedOutputDraft = {
  /** STONE (default) = one individual polished stone, always issued whole.
   * PARCEL = many stones received together; recorded as a packet so a
   * Jewellery Job can take part of it (by carat and stone count). */
  kind?: "STONE" | "PARCEL";
  /** Stones in the parcel — required (at least 2) for a PARCEL, never for a STONE. */
  pieceCount?: number | null;
  /** Parcel size wording for the packet ("2.0 mm", "0.10-0.12 ct"); defaults to "Unsized". */
  sizeLabel?: string | null;
  shape: DiamondShape;
  carat: DecimalInput;
  lengthMm?: DecimalInput | null;
  widthMm?: DecimalInput | null;
  heightMm?: DecimalInput | null;
  color?: string | null;
  clarity?: string | null;
  cutGrade?: string | null;
  polish?: string | null;
  symmetry?: string | null;
  fluorescence?: string | null;
  certificateStatus?: CertificateStatus;
  certLab?: string | null;
  certNumber?: string | null;
  certFileAssetId?: string | null;
  photoAssetId?: string | null;
};

export async function receivePolishedDiamonds(
  tx: Tx,
  input: FyInput & {
    jobId: string;
    receiveDate: Date;
    returnedRoughCarat: DecimalInput;
    labourCharge: DecimalInput;
    shape: DiamondShape;
    notes?: string | null;
    outputs: PolishedOutputDraft[];
    /** Explicit user declaration that no more rough will come back from
     * this Karigar for this job — required before any positive gap
     * between pending and (polished+returned) carat is recognized as
     * real weight loss. Without it, a partial receipt's unaccounted gap
     * is treated as material still with the Karigar (in progress), never
     * silently written off as loss — see the gapCarat/isFinalReceiptForJob
     * logic below. Ignored (irrelevant) when the gap is already zero. */
    markJobComplete: boolean;
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  // Serialise against a concurrent cancel or a second receipt on the same job:
  // the pending carat below is read-then-written.
  await lockRows(tx, "diamond_jobs", [input.jobId]);
  const job = await tx.diamondJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new PostingError("Job not found.");
  if (job.status === "CANCELLED") throw new PostingError("This job has been cancelled.");
  if (job.status === "COMPLETED") throw new PostingError("This job is already completed.");
  if (job.processOutputKindSnapshot === "ROUGH") {
    throw new PostingError(
      `This job's process (${job.processNameSnapshot}) returns processed rough, not polished diamonds — use Receive processed rough.`
    );
  }
  if (input.outputs.length === 0) {
    throw new PostingError("A receipt must include at least one polished diamond.");
  }

  const totalPolishedCarat = round3(
    input.outputs.reduce((sum, o) => sum.plus(new Decimal(o.carat)), ZERO)
  );
  if (!totalPolishedCarat.greaterThan(0)) {
    throw new PostingError("Total polished carat must be greater than zero.");
  }

  // A single stone and a parcel are different things and must be said so at
  // receipt: only a parcel carries a stone count, only a parcel can later be
  // issued in part, and a certified stone is by nature a single stone.
  const outputCounts = input.outputs.map((o, i) => {
    const kind = o.kind ?? "STONE";
    const label = `Polished output ${i + 1}`;
    if (kind === "STONE") {
      if (o.pieceCount != null) throw new PostingError(`${label} is a single stone, so it cannot have a stone count — record it as a parcel instead.`);
      return null;
    }
    if (!Number.isInteger(o.pieceCount ?? NaN) || (o.pieceCount as number) < 2) {
      throw new PostingError(`${label} is a parcel — enter how many stones it holds (at least 2). A single stone should be recorded as a single stone.`);
    }
    const certified = (o.certificateStatus ?? "NOT_CERTIFIED") !== "NOT_CERTIFIED" || !!o.certNumber || !!o.certLab || !!o.certFileAssetId;
    if (certified) throw new PostingError(`${label} is a parcel, which cannot carry a certificate — a certified stone is recorded as a single stone.`);
    if (!round3(o.carat).greaterThan(0)) throw new PostingError(`${label} must have a carat greater than zero.`);
    return o.pieceCount as number;
  });
  const totalStones = outputCounts.reduce<number>((sum, c) => sum + (c ?? 1), 0);
  const returnedRoughCarat = round3(input.returnedRoughCarat ?? 0);
  if (returnedRoughCarat.isNegative()) {
    throw new PostingError("Returned rough carat cannot be negative.");
  }
  const enteredLabourCharge = round2(input.labourCharge ?? 0);
  if (enteredLabourCharge.isNegative()) {
    throw new PostingError("Labour charge cannot be negative.");
  }

  const pendingCaratBefore = round3(
    new Decimal(job.issuedRoughCarat).minus(job.receivedPolishedCarat).minus(job.returnedRoughCarat)
  );
  const resolvedCarat = round3(totalPolishedCarat.plus(returnedRoughCarat));

  if (resolvedCarat.greaterThan(pendingCaratBefore)) {
    throw new PostingError(
      `Polished (${totalPolishedCarat.toFixed(3)}ct) plus returned (${returnedRoughCarat.toFixed(3)}ct) carat exceeds the ${pendingCaratBefore.toFixed(3)}ct still pending for this job.`
    );
  }

  // The gap between what was pending and what this receipt resolves is
  // NOT automatically "loss" — it may simply be other issued pieces still
  // untouched with the Karigar. It only becomes recognized weight loss
  // when there is no gap at all (nothing ambiguous left) or the caller
  // explicitly declares this the job's final receipt.
  const gapCarat = round3(pendingCaratBefore.minus(resolvedCarat));
  const isFinalReceiptForJob = gapCarat.isZero() || input.markJobComplete;
  const weightLossCarat = isFinalReceiptForJob ? gapCarat : ZERO;

  // Phase 7: a job with an agreed rate computes its own charge; a manual
  // figure that disagrees is refused rather than silently replaced.
  let labourCharge = enteredLabourCharge;
  if (job.chargeRateBasis) {
    labourCharge = new Decimal(
      computeProcessCharge({
        basis: job.chargeRateBasis,
        rate: new Decimal(job.chargeRate ?? 0).toFixed(4),
        carat: totalPolishedCarat.toFixed(3),
        pieces: totalStones,
        isFinal: isFinalReceiptForJob,
      })
    );
    if (enteredLabourCharge.greaterThan(0) && !enteredLabourCharge.equals(labourCharge)) {
      throw new PostingError(
        `This job's charge is calculated from its agreed rate (₹${labourCharge.toFixed(2)} for this receipt) — leave the labour charge blank.`
      );
    }
  }
  const cumulativeReceivedAfter = new Decimal(job.receivedPolishedCarat).plus(totalPolishedCarat);
  const yieldPercent = isFinalReceiptForJob
    ? new Decimal(job.issuedRoughCarat).greaterThan(0)
      ? round3(cumulativeReceivedAfter.dividedBy(job.issuedRoughCarat).times(100))
      : ZERO
    : pendingCaratBefore.greaterThan(0)
      ? round3(totalPolishedCarat.dividedBy(pendingCaratBefore).times(100))
      : ZERO;

  // The receipt that finally closes the job always takes exactly whatever
  // WIP cost remains (never a re-derived ratio), so remainingWipCost
  // reaches precisely zero on completion regardless of earlier rounding.
  // A non-final partial receipt drains only the cost proportional to what
  // it actually resolved, leaving the rest in WIP for the still-untouched
  // pieces.
  const remainingWipCostBefore = new Decimal(job.remainingWipCost);
  const resolvedCost = isFinalReceiptForJob
    ? remainingWipCostBefore
    : remainingWipCostBefore
        .times(resolvedCarat)
        .dividedBy(pendingCaratBefore)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const returnedCost = returnedRoughCarat.greaterThan(0)
    ? resolvedCost.times(returnedRoughCarat).dividedBy(resolvedCarat).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : ZERO;
  // Normal manufacturing weight loss is never carved out separately — its
  // cost silently stays inside polishedPortionCost, i.e. absorbed into the
  // surviving polished inventory, per the master plan.
  const polishedPortionCost = round2(resolvedCost.minus(returnedCost));

  const receiptCode = await nextDiamondCode(tx, "POLISHED_RECEIPT");
  const totalToAllocateAcrossOutputs = round2(polishedPortionCost.plus(labourCharge));
  const allocation = allocateProportionally(
    totalToAllocateAcrossOutputs,
    input.outputs.map((o, i) => ({ key: String(i), weight: o.carat }))
  );

  const voucher = await createVoucherHeader(
    tx,
    {
      date: input.receiveDate,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
      currencyCode: "INR",
      exchangeRate: 1,
      note: `Polished receipt ${receiptCode} for job ${job.jobCode}`,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.createdByUserId,
    },
    "DIAMOND_RECEIPT",
    // The voucher amount is the posting's full debit — returned rough
    // included — not just the polished portion.
    { amount: round2(totalToAllocateAcrossOutputs.plus(returnedCost)) }
  );

  const journalLines: JournalLineInput[] = [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY,
      debit: polishedPortionCost.plus(labourCharge),
      description: `Receipt ${receiptCode}`,
    },
  ];
  if (returnedCost.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY,
      debit: returnedCost,
      description: `Returned rough ${receiptCode}`,
    });
  }
  journalLines.push({
    accountCode: SYSTEM_ACCOUNT_CODES.DIAMOND_WIP,
    credit: resolvedCost,
    description: `Receipt ${receiptCode}`,
  });
  if (labourCharge.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: job.karigarId,
      credit: labourCharge,
      description: `Cutting-polishing labour payable ${receiptCode}`,
    });
  }

  await insertBalancedJournalLines(tx, voucher.id, journalLines);

  const receipt = await tx.polishedReceipt.create({
    data: {
      receiptCode,
      jobId: job.id,
      receiveDate: input.receiveDate,
      polishedCount: totalStones,
      totalPolishedCarat: totalPolishedCarat.toFixed(3),
      returnedRoughCarat: returnedRoughCarat.toFixed(3),
      weightLossCarat: weightLossCarat.toFixed(3),
      yieldPercent: yieldPercent.toFixed(3),
      labourCharge: labourCharge.toFixed(2),
      shape: input.shape,
      notes: input.notes ?? null,
      postingVoucherId: voucher.id,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  const createdOutputs = [];
  const createdParcels = [];
  for (let i = 0; i < input.outputs.length; i++) {
    const draft = input.outputs[i];
    const allocatedCost = allocation.find((a) => a.key === String(i))!.amount;
    const caratDec = round3(draft.carat);
    const stoneCount = outputCounts[i];

    if (stoneCount != null) {
      // PARCEL: kept on the packet ledger, whose partial-issue, return and
      // cancellation rules (exact proportional cost, drains to zero) already
      // exist. Lineage: this job, this receipt (and, through the job, the
      // rough lot it was bought in).
      const packetCode = await nextDiamondCode(tx, "POLISHED_PACKET");
      const sizeLabel = draft.sizeLabel?.trim() || "Unsized";
      const packet = await tx.polishedPacket.create({
        data: {
          packetCode,
          provenance: "MANUFACTURED_FROM_ROUGH",
          mergeKey: buildPacketMergeKey({
            shape: draft.shape,
            sizeLabel,
            quality: draft.clarity ?? null,
            colour: draft.color ?? null,
            lab: null,
            certificateStatus: "NOT_CERTIFIED",
            provenance: "MANUFACTURED_FROM_ROUGH",
            currencyCode: "INR",
          }),
          shape: draft.shape,
          sizeLabel,
          measurements:
            draft.lengthMm != null || draft.widthMm != null || draft.heightMm != null
              ? [draft.lengthMm, draft.widthMm, draft.heightMm].map((v) => (v != null ? new Decimal(v).toFixed(3) : "—")).join(" × ") + " mm"
              : null,
          quality: draft.clarity ?? null,
          colour: draft.color ?? null,
          certificateStatus: "NOT_CERTIFIED",
          photoAssetId: draft.photoAssetId ?? null,
          currencyCode: "INR",
          sourceDiamondJobId: job.id,
          sourceReceiptId: receipt.id,
          notes: `Manufactured parcel from job ${job.jobCode}, receipt ${receiptCode}`,
          createdByUserId: input.createdByUserId,
        },
      });
      await tx.polishedPacketMovement.create({
        data: {
          type: "MANUFACTURE_IN",
          packetId: packet.id,
          pieces: stoneCount,
          carat: caratDec.toFixed(3),
          costValue: allocatedCost.toFixed(2),
          sourceDocument: receiptCode,
          createdByUserId: input.createdByUserId,
        },
      });
      await tx.stockMovement.create({
        data: {
          type: "POLISHED_RECEIVE_IN",
          diamondJobId: job.id,
          pieces: stoneCount,
          carat: caratDec.toFixed(3),
          costValue: allocatedCost.toFixed(2),
          sourceDocument: receiptCode,
          createdByUserId: input.createdByUserId,
        },
      });
      createdParcels.push(packet);
      continue;
    }

    const polishedCode = await nextDiamondCode(tx, "POLISHED_DIAMOND");
    const output = await tx.polishedDiamond.create({
      data: {
        polishedCode,
        receiptId: receipt.id,
        jobId: job.id,
        shape: draft.shape,
        carat: caratDec.toFixed(3),
        lengthMm: draft.lengthMm != null ? new Decimal(draft.lengthMm).toFixed(3) : null,
        widthMm: draft.widthMm != null ? new Decimal(draft.widthMm).toFixed(3) : null,
        heightMm: draft.heightMm != null ? new Decimal(draft.heightMm).toFixed(3) : null,
        color: draft.color ?? null,
        clarity: draft.clarity ?? null,
        cutGrade: draft.cutGrade ?? null,
        polish: draft.polish ?? null,
        symmetry: draft.symmetry ?? null,
        fluorescence: draft.fluorescence ?? null,
        certificateStatus: draft.certificateStatus ?? "NOT_CERTIFIED",
        certLab: draft.certLab ?? null,
        certNumber: draft.certNumber ?? null,
        certFileAssetId: draft.certFileAssetId ?? null,
        photoAssetId: draft.photoAssetId ?? null,
        allocatedCost: allocatedCost.toFixed(2),
        costPerCarat: caratDec.greaterThan(0)
          ? allocatedCost.dividedBy(caratDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
          : "0.00",
        createdByUserId: input.createdByUserId,
      },
    });

    await tx.stockMovement.create({
      data: {
        type: "POLISHED_RECEIVE_IN",
        polishedDiamondId: output.id,
        diamondJobId: job.id,
        pieces: 1,
        carat: output.carat,
        costValue: output.allocatedCost,
        sourceDocument: receiptCode,
        createdByUserId: input.createdByUserId,
      },
    });
    createdOutputs.push(output);
  }

  // Carat permanently leaving the rough/WIP pool this receipt: the polished
  // output plus (only once recognized) its share of loss — NOT simply
  // resolvedCarat-minus-returned, which would always equal totalPolishedCarat
  // and silently drop the loss carat from this audit record.
  const consumedCarat = round3(totalPolishedCarat.plus(weightLossCarat));
  if (consumedCarat.greaterThan(0)) {
    await tx.stockMovement.create({
      data: {
        type: "ROUGH_CONSUMED_OUT",
        diamondJobId: job.id,
        pieces: 0,
        carat: consumedCarat.toFixed(3),
        costValue: polishedPortionCost.toFixed(2),
        sourceDocument: receiptCode,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  if (returnedRoughCarat.greaterThan(0)) {
    const roughCode = await nextDiamondCode(tx, "ROUGH_PIECE");
    const leftoverPiece = await tx.roughPiece.create({
      data: {
        roughCode,
        lotId: null,
        returnedFromJobId: job.id,
        returnedFromReceiptId: receipt.id,
        carat: returnedRoughCarat.toFixed(3),
        allocatedCost: returnedCost.toFixed(2),
        costLocked: false,
        status: "AVAILABLE",
        createdByUserId: input.createdByUserId,
      },
    });
    await tx.stockMovement.create({
      data: {
        type: "ROUGH_RETURN_IN",
        roughPieceId: leftoverPiece.id,
        diamondJobId: job.id,
        pieces: 1,
        carat: leftoverPiece.carat,
        costValue: leftoverPiece.allocatedCost,
        sourceDocument: receiptCode,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  const newReceivedPolishedCarat = round3(new Decimal(job.receivedPolishedCarat).plus(totalPolishedCarat));
  const newReturnedRoughCarat = round3(new Decimal(job.returnedRoughCarat).plus(returnedRoughCarat));
  const newTotalLabourCharge = round2(new Decimal(job.totalLabourCharge).plus(labourCharge));
  const newRemainingWipCost = round2(remainingWipCostBefore.minus(resolvedCost));
  const newStatus = isFinalReceiptForJob ? "COMPLETED" : "PARTIALLY_RECEIVED";

  const updatedJob = await tx.diamondJob.update({
    where: { id: job.id },
    data: {
      receivedPolishedCarat: newReceivedPolishedCarat.toFixed(3),
      returnedRoughCarat: newReturnedRoughCarat.toFixed(3),
      totalLabourCharge: newTotalLabourCharge.toFixed(2),
      remainingWipCost: newRemainingWipCost.toFixed(2),
      status: newStatus,
    },
  });

  if (isFinalReceiptForJob) {
    const links = await tx.diamondJobPiece.findMany({
      where: { jobId: job.id },
      select: { roughPieceId: true },
    });
    await tx.roughPiece.updateMany({
      where: { id: { in: links.map((l) => l.roughPieceId) }, status: "WITH_KARIGAR" },
      data: { status: "COMPLETED" },
    });
  }

  return { receipt, outputs: createdOutputs, parcels: createdParcels, job: updatedJob };
}

// ---------------------------------------------------------------------------
// Phase 7 — Manufacturer: receive processed rough (4P / Laser, HPHT / Grow,
// Rough Polish). The stones come back as ROUGH, so each processed piece
// becomes a new Available RoughPiece carrying its share of the resolved WIP
// cost plus the process charge. Same pending/loss rules as a polished
// receipt: a partial return never recognises loss.
// ---------------------------------------------------------------------------

export type ProcessedRoughPieceDraft = {
  carat: DecimalInput;
  colorEstimate?: string | null;
  clarityNote?: string | null;
  internalNote?: string | null;
};

export async function receiveProcessedRough(
  tx: Tx,
  input: FyInput & {
    jobId: string;
    receiveDate: Date;
    pieces: ProcessedRoughPieceDraft[];
    /** Only for a job without an agreed rate; a rate-based job computes its own. */
    manualCharge?: DecimalInput | null;
    markJobComplete: boolean;
    notes?: string | null;
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  // Serialise against a concurrent cancel or a second receipt on the same job:
  // the pending carat below is read-then-written.
  await lockRows(tx, "diamond_jobs", [input.jobId]);
  const job = await tx.diamondJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new PostingError("Job not found.");
  if (job.status === "CANCELLED") throw new PostingError("This job has been cancelled.");
  if (job.status === "COMPLETED") throw new PostingError("This job is already completed.");
  if (job.processOutputKindSnapshot !== "ROUGH") {
    throw new PostingError("Only a job for a rough process (4P / Laser, HPHT / Grow, Rough Polish) can return processed rough.");
  }
  if (input.pieces.length === 0) throw new PostingError("Add at least one processed rough piece.");

  const pieceCarats = input.pieces.map((p) => round3(p.carat));
  if (pieceCarats.some((c) => !c.greaterThan(0))) {
    throw new PostingError("Each processed rough piece's carat must be greater than zero.");
  }
  const processedCarat = round3(pieceCarats.reduce((sum, c) => sum.plus(c), ZERO));

  const pendingCaratBefore = round3(
    new Decimal(job.issuedRoughCarat).minus(job.receivedPolishedCarat).minus(job.returnedRoughCarat)
  );
  if (processedCarat.greaterThan(pendingCaratBefore)) {
    throw new PostingError(
      `Processed rough (${processedCarat.toFixed(3)}ct) exceeds the ${pendingCaratBefore.toFixed(3)}ct still with the Manufacturer.`
    );
  }
  const gapCarat = round3(pendingCaratBefore.minus(processedCarat));
  const isFinal = gapCarat.isZero() || input.markJobComplete;
  const weightLossCarat = isFinal ? gapCarat : ZERO;

  const remainingWipCostBefore = new Decimal(job.remainingWipCost);
  const resolvedCost = isFinal
    ? remainingWipCostBefore
    : round2(remainingWipCostBefore.times(processedCarat).dividedBy(pendingCaratBefore));

  const enteredCharge = round2(input.manualCharge ?? 0);
  if (enteredCharge.isNegative()) throw new PostingError("The process charge cannot be negative.");
  let charge = enteredCharge;
  if (job.chargeRateBasis) {
    charge = new Decimal(
      computeProcessCharge({
        basis: job.chargeRateBasis,
        rate: new Decimal(job.chargeRate ?? 0).toFixed(4),
        carat: processedCarat.toFixed(3),
        pieces: input.pieces.length,
        isFinal,
      })
    );
    if (enteredCharge.greaterThan(0) && !enteredCharge.equals(charge)) {
      throw new PostingError(
        `This job's charge is calculated from its agreed rate (₹${charge.toFixed(2)} for this receipt) — leave the charge blank.`
      );
    }
  }

  // Normal process loss stays absorbed in the processed pieces' cost.
  const totalToPieces = round2(resolvedCost.plus(charge));
  const allocation = allocateProportionally(
    totalToPieces,
    pieceCarats.map((carat, i) => ({ key: String(i), weight: carat }))
  );

  const receiptCode = await nextDiamondCode(tx, "POLISHED_RECEIPT");
  const voucher = await createVoucherHeader(
    tx,
    {
      date: input.receiveDate,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
      currencyCode: "INR",
      exchangeRate: 1,
      note: `${job.processNameSnapshot} return ${receiptCode} for job ${job.jobCode}`,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.createdByUserId,
    },
    "DIAMOND_RECEIPT",
    { amount: totalToPieces }
  );
  const journalLines: JournalLineInput[] = [];
  if (totalToPieces.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY,
      debit: totalToPieces,
      description: `Processed rough ${receiptCode}`,
    });
  }
  if (resolvedCost.greaterThan(0)) {
    journalLines.push({ accountCode: SYSTEM_ACCOUNT_CODES.DIAMOND_WIP, credit: resolvedCost, description: `Receipt ${receiptCode}` });
  }
  if (charge.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: job.karigarId,
      credit: charge,
      description: `${job.processNameSnapshot} charge payable ${receiptCode}`,
    });
  }
  await insertBalancedJournalLines(tx, voucher.id, journalLines);

  const returnedAfter = round3(new Decimal(job.returnedRoughCarat).plus(processedCarat));
  const yieldPercent = isFinal
    ? new Decimal(job.issuedRoughCarat).greaterThan(0)
      ? round3(returnedAfter.dividedBy(job.issuedRoughCarat).times(100))
      : ZERO
    : round3(processedCarat.dividedBy(pendingCaratBefore).times(100));

  const receipt = await tx.polishedReceipt.create({
    data: {
      receiptCode,
      jobId: job.id,
      receiveDate: input.receiveDate,
      polishedCount: 0,
      totalPolishedCarat: "0.000",
      returnedRoughCarat: processedCarat.toFixed(3),
      weightLossCarat: weightLossCarat.toFixed(3),
      yieldPercent: yieldPercent.toFixed(3),
      labourCharge: charge.toFixed(2),
      shape: job.requiredShape,
      notes: input.notes ?? null,
      postingVoucherId: voucher.id,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  const createdPieces = [];
  for (let i = 0; i < input.pieces.length; i++) {
    const draft = input.pieces[i];
    const roughCode = await nextDiamondCode(tx, "ROUGH_PIECE");
    const allocatedCost = allocation.find((a) => a.key === String(i))!.amount;
    const piece = await tx.roughPiece.create({
      data: {
        roughCode,
        lotId: null,
        returnedFromJobId: job.id,
        returnedFromReceiptId: receipt.id,
        carat: pieceCarats[i].toFixed(3),
        colorEstimate: draft.colorEstimate ?? null,
        clarityNote: draft.clarityNote ?? null,
        internalNote: draft.internalNote ?? `${job.processNameSnapshot} — processed on job ${job.jobCode}`,
        allocatedCost: allocatedCost.toFixed(2),
        costLocked: false,
        status: "AVAILABLE",
        createdByUserId: input.createdByUserId,
      },
    });
    await tx.stockMovement.create({
      data: {
        type: "ROUGH_RETURN_IN",
        roughPieceId: piece.id,
        diamondJobId: job.id,
        pieces: 1,
        carat: piece.carat,
        costValue: piece.allocatedCost,
        sourceDocument: receiptCode,
        createdByUserId: input.createdByUserId,
      },
    });
    createdPieces.push(piece);
  }

  if (weightLossCarat.greaterThan(0)) {
    await tx.stockMovement.create({
      data: {
        type: "ROUGH_CONSUMED_OUT",
        diamondJobId: job.id,
        pieces: 0,
        carat: weightLossCarat.toFixed(3),
        costValue: "0.00",
        sourceDocument: receiptCode,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  const updatedJob = await tx.diamondJob.update({
    where: { id: job.id },
    data: {
      returnedRoughCarat: returnedAfter.toFixed(3),
      totalLabourCharge: round2(new Decimal(job.totalLabourCharge).plus(charge)).toFixed(2),
      remainingWipCost: round2(remainingWipCostBefore.minus(resolvedCost)).toFixed(2),
      status: isFinal ? "COMPLETED" : "PARTIALLY_RECEIVED",
    },
  });

  if (isFinal) {
    const links = await tx.diamondJobPiece.findMany({ where: { jobId: job.id }, select: { roughPieceId: true } });
    await tx.roughPiece.updateMany({
      where: { id: { in: links.map((l) => l.roughPieceId) }, status: "WITH_KARIGAR" },
      data: { status: "COMPLETED" },
    });
  }

  return { receipt, pieces: createdPieces, job: updatedJob };
}

// ---------------------------------------------------------------------------
// Recut (Owner-only; enforced by the caller) — no reverse rough flow.
// ---------------------------------------------------------------------------

export async function recutPolishedDiamond(
  tx: Tx,
  input: { polishedDiamondId: string; reason: string; recutByUserId: string }
) {
  const polished = await tx.polishedDiamond.findUnique({ where: { id: input.polishedDiamondId } });
  if (!polished) throw new PostingError("Polished diamond not found.");
  if (polished.status !== "AVAILABLE") {
    throw new PostingError(
      `Only an Available polished diamond can be marked for recut (current status: ${polished.status}).`
    );
  }
  if (!input.reason || input.reason.trim().length < 3) {
    throw new PostingError("Give a short reason for marking this diamond for recut.");
  }

  const updated = await tx.polishedDiamond.update({
    where: { id: polished.id },
    data: {
      status: "RECUT",
      recutAt: new Date(),
      recutByUserId: input.recutByUserId,
      recutReason: input.reason,
    },
  });

  await tx.stockMovement.create({
    data: {
      type: "POLISHED_RECUT_OUT",
      polishedDiamondId: polished.id,
      pieces: 1,
      carat: polished.carat,
      costValue: polished.allocatedCost,
      sourceDocument: polished.polishedCode,
      createdByUserId: input.recutByUserId,
    },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Owner-authorized cost allocation overrides (with a mandatory reason)
// ---------------------------------------------------------------------------

export async function overrideRoughPieceAllocations(
  tx: Tx,
  input: {
    lotId: string;
    adjustments: { pieceId: string; newAllocatedCost: DecimalInput }[];
    reason: string;
  }
) {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new PostingError("Give a short reason for this cost override.");
  }

  const lot = await tx.roughLot.findUnique({ where: { id: input.lotId }, include: { pieces: true } });
  if (!lot) throw new PostingError("Rough lot not found.");

  const pieceIds = new Set(lot.pieces.map((p) => p.id));
  for (const adj of input.adjustments) {
    if (!pieceIds.has(adj.pieceId)) throw new PostingError("One or more pieces do not belong to this lot.");
  }
  const adjustedIds = new Set(input.adjustments.map((a) => a.pieceId));
  if (adjustedIds.size !== lot.pieces.length || adjustedIds.size !== input.adjustments.length) {
    throw new PostingError("An allocation override must specify every piece in the lot exactly once.");
  }
  for (const piece of lot.pieces) {
    if (piece.costLocked) {
      throw new PostingError(
        `Rough piece ${piece.roughCode} already has stock movement and cannot have its cost overridden.`
      );
    }
  }

  const newTotal = input.adjustments.reduce((sum, a) => sum.plus(round2(a.newAllocatedCost)), ZERO);
  const lotTotal = round2(lot.totalPurchaseCost);
  if (!newTotal.equals(lotTotal)) {
    throw new PostingError(
      `New piece costs sum to ${newTotal.toFixed(2)}, which must exactly equal the lot's total purchase cost ${lotTotal.toFixed(2)}.`
    );
  }

  for (const adj of input.adjustments) {
    await tx.roughPiece.update({
      where: { id: adj.pieceId },
      data: { allocatedCost: round2(adj.newAllocatedCost).toFixed(2) },
    });
  }

  return tx.roughLot.update({
    where: { id: lot.id },
    data: { notes: `${lot.notes ? lot.notes + "\n" : ""}[Cost allocation overridden by Owner: ${input.reason}]` },
  });
}

export async function overridePolishedAllocations(
  tx: Tx,
  input: {
    receiptId: string;
    adjustments: { polishedDiamondId: string; newAllocatedCost: DecimalInput }[];
    reason: string;
  }
) {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new PostingError("Give a short reason for this cost override.");
  }

  const receipt = await tx.polishedReceipt.findUnique({
    where: { id: input.receiptId },
    include: { outputs: true },
  });
  if (!receipt) throw new PostingError("Receipt not found.");

  const outputIds = new Set(receipt.outputs.map((o) => o.id));
  for (const adj of input.adjustments) {
    if (!outputIds.has(adj.polishedDiamondId)) {
      throw new PostingError("One or more outputs do not belong to this receipt.");
    }
  }
  const adjustedIds = new Set(input.adjustments.map((a) => a.polishedDiamondId));
  if (adjustedIds.size !== receipt.outputs.length || adjustedIds.size !== input.adjustments.length) {
    throw new PostingError("An allocation override must specify every polished output in the receipt exactly once.");
  }
  for (const output of receipt.outputs) {
    if (output.status !== "AVAILABLE") {
      throw new PostingError(
        `Polished diamond ${output.polishedCode} is no longer Available and cannot have its cost overridden.`
      );
    }
  }

  const currentTotal = receipt.outputs.reduce((sum, o) => sum.plus(new Decimal(o.allocatedCost)), ZERO);
  const newTotal = input.adjustments.reduce((sum, a) => sum.plus(round2(a.newAllocatedCost)), ZERO);
  if (!newTotal.equals(round2(currentTotal))) {
    throw new PostingError(
      `New output costs sum to ${newTotal.toFixed(2)}, which must exactly equal the receipt's total allocated cost ${currentTotal.toFixed(2)}.`
    );
  }

  for (const adj of input.adjustments) {
    const output = receipt.outputs.find((o) => o.id === adj.polishedDiamondId)!;
    const newCost = round2(adj.newAllocatedCost);
    const caratDec = new Decimal(output.carat);
    await tx.polishedDiamond.update({
      where: { id: output.id },
      data: {
        allocatedCost: newCost.toFixed(2),
        costPerCarat: caratDec.greaterThan(0)
          ? newCost.dividedBy(caratDec).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
          : "0.00",
      },
    });
  }

  return tx.polishedReceipt.update({
    where: { id: receipt.id },
    data: {
      notes: `${receipt.notes ? receipt.notes + "\n" : ""}[Cost allocation overridden by Owner: ${input.reason}]`,
    },
  });
}
