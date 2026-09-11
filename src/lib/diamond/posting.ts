import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  CertificateStatus,
  DiamondShape,
  GstTreatment,
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
import { nextDiamondCode } from "@/lib/diamond/numbering";

export { PostingError };

type Tx = Prisma.TransactionClient;

type FyInput = { fyStartMonth: number; fyStartDay: number };

// ---------------------------------------------------------------------------
// Rough purchase (creates the lot + every piece + the accounting voucher)
// ---------------------------------------------------------------------------

export type RoughPieceDraft = {
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
    const piece = await tx.roughPiece.create({
      data: {
        roughCode,
        lotId: lot.id,
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
        pieces: 1,
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

export async function issueRoughToKarigar(
  tx: Tx,
  input: FyInput & {
    karigarId: string;
    roughPieceIds: string[];
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
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  if (input.roughPieceIds.length === 0) {
    throw new PostingError("Select at least one rough piece to issue.");
  }
  const uniqueIds = [...new Set(input.roughPieceIds)];
  if (uniqueIds.length !== input.roughPieceIds.length) {
    throw new PostingError("The same rough piece was selected more than once.");
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

  const issuedRoughCarat = pieces.reduce((sum, p) => sum.plus(new Decimal(p.carat)), ZERO);
  const issuedCostValue = pieces.reduce((sum, p) => sum.plus(new Decimal(p.allocatedCost)), ZERO);

  const jobCode = await nextDiamondCode(tx, "DIAMOND_JOB");

  const voucher = await createVoucherHeader(
    tx,
    {
      date: input.issueDate,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
      currencyCode: "INR",
      exchangeRate: 1,
      note: `Rough issued to Karigar — job ${jobCode}`,
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
      issuedPiecesCount: pieces.length,
      issuedRoughCarat: round3(issuedRoughCarat).toFixed(3),
      issuedCostValue: issuedCostValue.toFixed(2),
      remainingWipCost: issuedCostValue.toFixed(2),
      wipVoucherId: voucher.id,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  for (const piece of pieces) {
    await tx.diamondJobPiece.create({
      data: {
        jobId: job.id,
        roughPieceId: piece.id,
        caratAtIssue: piece.carat,
        costAtIssue: piece.allocatedCost,
      },
    });
    await tx.roughPiece.update({
      where: { id: piece.id },
      data: { status: "WITH_KARIGAR", costLocked: true },
    });
    await tx.stockMovement.create({
      data: {
        type: "ROUGH_ISSUE_OUT",
        roughPieceId: piece.id,
        diamondJobId: job.id,
        pieces: 1,
        carat: piece.carat,
        costValue: piece.allocatedCost,
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
    await tx.roughPiece.update({ where: { id: link.roughPieceId }, data: { status: "AVAILABLE" } });
    await tx.stockMovement.create({
      data: {
        type: "ROUGH_ISSUE_CANCEL_IN",
        roughPieceId: link.roughPieceId,
        diamondJobId: job.id,
        pieces: 1,
        carat: link.caratAtIssue,
        costValue: link.costAtIssue,
        sourceDocument: job.jobCode,
        createdByUserId: input.cancelledByUserId,
      },
    });
  }

  return tx.diamondJob.update({
    where: { id: job.id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledByUserId: input.cancelledByUserId,
      cancellationReason: input.cancellationReason,
    },
  });
}

// ---------------------------------------------------------------------------
// Receive polished diamonds (one or more outputs; supports partial receipts)
// ---------------------------------------------------------------------------

export type PolishedOutputDraft = {
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
  const job = await tx.diamondJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new PostingError("Job not found.");
  if (job.status === "CANCELLED") throw new PostingError("This job has been cancelled.");
  if (job.status === "COMPLETED") throw new PostingError("This job is already completed.");
  if (input.outputs.length === 0) {
    throw new PostingError("A receipt must include at least one polished diamond.");
  }

  const totalPolishedCarat = round3(
    input.outputs.reduce((sum, o) => sum.plus(new Decimal(o.carat)), ZERO)
  );
  if (!totalPolishedCarat.greaterThan(0)) {
    throw new PostingError("Total polished carat must be greater than zero.");
  }
  const returnedRoughCarat = round3(input.returnedRoughCarat ?? 0);
  if (returnedRoughCarat.isNegative()) {
    throw new PostingError("Returned rough carat cannot be negative.");
  }
  const labourCharge = round2(input.labourCharge ?? 0);
  if (labourCharge.isNegative()) {
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
    { amount: totalToAllocateAcrossOutputs }
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
      polishedCount: input.outputs.length,
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
  for (let i = 0; i < input.outputs.length; i++) {
    const draft = input.outputs[i];
    const polishedCode = await nextDiamondCode(tx, "POLISHED_DIAMOND");
    const allocatedCost = allocation.find((a) => a.key === String(i))!.amount;
    const caratDec = round3(draft.carat);
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

  return { receipt, outputs: createdOutputs, job: updatedJob };
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
