import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  GstTreatment,
  JewelleryType,
  MetalRateBasis,
  MetalType,
  QcStatus,
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
import { computeOutputMetal, formatThousandths, METAL_POOL_EFFECT, type MetalStockMovementKind } from "@/lib/jewellery/metalMath";
import { nextJewelleryCode } from "@/lib/jewellery/numbering";

export { PostingError };

type Tx = Prisma.TransactionClient;
type FyInput = { fyStartMonth: number; fyStartDay: number };

// ---------------------------------------------------------------------------
// Metal stock balance (weighted-average cost per fungible metal+purity bucket)
// ---------------------------------------------------------------------------

type MetalPoolTotals = { grossWeight: Decimal; fineWeight: Decimal; costValue: Decimal };

/**
 * Sums immutable movements into ONE of the two pools kept per metal+purity,
 * using METAL_POOL_EFFECT (src/lib/jewellery/metalMath.ts). The usable pool
 * is what can be issued and what 1300 Metal Inventory values; the scrap pool
 * is valued in 1310 Scrap Metal Inventory. CONSUMED_OUT touches neither.
 */
export function sumMetalPool(
  movements: { type: string; grossWeight: DecimalInput; fineWeight: DecimalInput; costValue: DecimalInput }[],
  pool: "usable" | "scrap"
): MetalPoolTotals {
  let grossWeight = ZERO;
  let fineWeight = ZERO;
  let costValue = ZERO;
  for (const m of movements) {
    const sign = METAL_POOL_EFFECT[m.type as MetalStockMovementKind]?.[pool] ?? 0;
    if (sign === 0) continue;
    grossWeight = grossWeight.plus(new Decimal(m.grossWeight).times(sign));
    fineWeight = fineWeight.plus(new Decimal(m.fineWeight).times(sign));
    costValue = costValue.plus(new Decimal(m.costValue).times(sign));
  }
  return { grossWeight: round3(grossWeight), fineWeight: round3(fineWeight), costValue: round2(costValue) };
}

/** Usable (issuable) stock of one metal+purity. */
export async function getMetalStockBalanceInTx(tx: Tx, metalType: MetalType, purityId: string): Promise<MetalPoolTotals> {
  const movements = await tx.metalStockMovement.findMany({
    where: { metalType, purityId },
    select: { type: true, grossWeight: true, fineWeight: true, costValue: true },
  });
  return sumMetalPool(movements, "usable");
}

/** Recoverable scrap of one metal+purity — never issuable (see sumMetalPool). */
export async function getScrapMetalBalanceInTx(tx: Tx, metalType: MetalType, purityId: string): Promise<MetalPoolTotals> {
  const movements = await tx.metalStockMovement.findMany({
    where: { metalType, purityId },
    select: { type: true, grossWeight: true, fineWeight: true, costValue: true },
  });
  return sumMetalPool(movements, "scrap");
}

/** How much fine weight of ONE purity is still outstanding *with the
 * Karigar on this specific job* — derived purely from
 * `MetalStockMovement` rows carrying this job's id, never a stored
 * balance. Used to validate a return/scrap line against the exact
 * purity it claims, not just the job's aggregate pending total (which
 * alone can't catch "returning more 22K than this job ever received"
 * when the job also issued a different purity). */
async function getJobPurityPendingFineWeightInTx(tx: Tx, jobId: string, purityId: string): Promise<Decimal> {
  const movements = await tx.metalStockMovement.findMany({
    where: { jewelleryJobId: jobId, purityId },
    select: { type: true, fineWeight: true },
  });
  const IN_TYPES = new Set(["ISSUE_OUT"]);
  let pending = ZERO;
  for (const m of movements) {
    const sign = IN_TYPES.has(m.type) ? 1 : -1;
    pending = pending.plus(new Decimal(m.fineWeight).times(sign));
  }
  return round3(pending);
}

/** Same deterministic "remainder goes to one predictable target" pattern
 * as `allocateProportionally` (src/lib/diamond/allocation.ts), but at 3
 * decimal places for a WEIGHT total instead of a 2-decimal money total —
 * kept as its own small local helper rather than generalizing the shared
 * one, to avoid any risk of changing its (locked, tested) money-rounding
 * behavior used everywhere else. */
function allocateWeightProportionally(total: Decimal, targets: { key: string; weight: Decimal }[]): Map<string, Decimal> {
  const result = new Map<string, Decimal>();
  if (targets.length === 0) return result;
  const totalWeight = targets.reduce((sum, t) => sum.plus(t.weight), ZERO);
  if (!totalWeight.greaterThan(0)) return result;

  const ordered = [...targets].sort((a, b) => {
    const cmp = b.weight.minus(a.weight).toNumber();
    if (cmp !== 0) return cmp;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const remainderKey = ordered[ordered.length - 1].key;

  let runningSum = ZERO;
  for (const target of ordered) {
    const share = total.times(target.weight).dividedBy(totalWeight).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
    result.set(target.key, share);
    runningSum = runningSum.plus(share);
  }
  const remainder = total.minus(runningSum);
  result.set(remainderKey, (result.get(remainderKey) ?? ZERO).plus(remainder));
  return result;
}

// ---------------------------------------------------------------------------
// Metal Purchase
// ---------------------------------------------------------------------------

export async function createMetalPurchase(
  tx: Tx,
  input: FyInput & {
    purchaseDate: Date;
    supplierId: string;
    metalType: MetalType;
    purityId: string;
    grossWeight: DecimalInput;
    rateBasis: MetalRateBasis;
    rate: DecimalInput;
    currencyCode: string;
    exchangeRate: DecimalInput;
    totalPurchaseCost: DecimalInput;
    gstTreatment: GstTreatment;
    gstRateId?: string | null;
    gstRatePercent?: DecimalInput | null;
    paymentAccountId?: string | null;
    referenceNumber?: string | null;
    notes?: string | null;
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  const grossWeight = round3(input.grossWeight);
  if (!grossWeight.greaterThan(0)) {
    throw new PostingError("Gross weight must be greater than zero.");
  }
  const totalPurchaseCost = round2(input.totalPurchaseCost);
  if (!totalPurchaseCost.greaterThan(0)) {
    throw new PostingError("Total purchase cost must be greater than zero.");
  }

  const purity = await tx.metalPurity.findUnique({ where: { id: input.purityId } });
  if (!purity || !purity.isActive) {
    throw new PostingError("Selected metal purity was not found or is inactive.");
  }
  const finenessPercentSnapshot = new Decimal(purity.finenessPercent);
  const fineWeight = round3(grossWeight.times(finenessPercentSnapshot).dividedBy(100));

  const purchaseCode = await nextJewelleryCode(tx, "METAL_PURCHASE");

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
      referenceNumber: input.referenceNumber,
      note: `Metal purchase ${purchaseCode}`,
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
      accountCode: SYSTEM_ACCOUNT_CODES.METAL_INVENTORY,
      debit: totalPurchaseCost,
      description: `Metal purchase ${purchaseCode}`,
    },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_CGST, debit: cgst, description: "Input CGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_SGST, debit: sgst, description: "Input SGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_IGST, debit: igst, description: "Input IGST" },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: input.supplierId,
      credit: payableAmount,
      description: `Metal purchase ${purchaseCode}`,
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

  const purchase = await tx.metalPurchase.create({
    data: {
      purchaseCode,
      supplierId: input.supplierId,
      purchaseDate: input.purchaseDate,
      metalType: input.metalType,
      purityId: input.purityId,
      finenessPercentSnapshot: finenessPercentSnapshot.toFixed(3),
      grossWeight: grossWeight.toFixed(3),
      fineWeight: fineWeight.toFixed(3),
      rateBasis: input.rateBasis,
      rate: new Decimal(input.rate).toFixed(4),
      currencyCode: input.currencyCode,
      exchangeRate: new Decimal(input.exchangeRate).toFixed(4),
      totalPurchaseCost: totalPurchaseCost.toFixed(2),
      gstTreatment: input.gstTreatment,
      gstRateId: input.gstRateId ?? null,
      gstRatePercent: input.gstTreatment === "NONE" ? null : gstRatePercent.toFixed(2),
      referenceNumber: input.referenceNumber ?? null,
      notes: input.notes ?? null,
      voucherId: voucher.id,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  await tx.metalStockMovement.create({
    data: {
      type: "PURCHASE_IN",
      metalType: input.metalType,
      purityId: input.purityId,
      grossWeight: grossWeight.toFixed(3),
      fineWeight: fineWeight.toFixed(3),
      costValue: totalPurchaseCost.toFixed(2),
      sourceDocument: purchaseCode,
      createdByUserId: input.createdByUserId,
    },
  });

  return purchase;
}

// ---------------------------------------------------------------------------
// Opening Metal Stock (Owner-only, enforced by the caller)
// ---------------------------------------------------------------------------

export async function postOpeningMetalStock(
  tx: Tx,
  input: {
    metalType: MetalType;
    purityId: string;
    grossWeight: DecimalInput;
    costValue: DecimalInput;
    note?: string | null;
    createdByUserId: string;
  }
) {
  const grossWeight = round3(input.grossWeight);
  if (!grossWeight.greaterThan(0)) throw new PostingError("Opening gross weight must be greater than zero.");
  const costValue = round2(input.costValue);
  if (costValue.isNegative()) throw new PostingError("Opening cost cannot be negative.");

  const purity = await tx.metalPurity.findUnique({ where: { id: input.purityId } });
  if (!purity || !purity.isActive) throw new PostingError("Selected metal purity was not found or is inactive.");
  const fineWeight = round3(grossWeight.times(purity.finenessPercent).dividedBy(100));

  return tx.metalStockMovement.create({
    data: {
      type: "OPENING_IN",
      metalType: input.metalType,
      purityId: input.purityId,
      grossWeight: grossWeight.toFixed(3),
      fineWeight: fineWeight.toFixed(3),
      costValue: costValue.toFixed(2),
      sourceDocument: input.note?.trim() ? `Opening stock: ${input.note.trim()}` : "Opening stock",
      createdByUserId: input.createdByUserId,
    },
  });
}

// ---------------------------------------------------------------------------
// Authorized Metal Stock Adjustment/Reversal (Owner-only)
// ---------------------------------------------------------------------------

export async function adjustMetalStock(
  tx: Tx,
  input: {
    metalType: MetalType;
    purityId: string;
    direction: "IN" | "OUT";
    grossWeight: DecimalInput;
    costValue: DecimalInput;
    reason: string;
    createdByUserId: string;
  }
) {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new PostingError("Give a short reason for this stock adjustment.");
  }
  const grossWeight = round3(input.grossWeight);
  if (!grossWeight.greaterThan(0)) throw new PostingError("Adjustment weight must be greater than zero.");
  const costValue = round2(input.costValue);

  const purity = await tx.metalPurity.findUnique({ where: { id: input.purityId } });
  if (!purity) throw new PostingError("Selected metal purity was not found.");
  const fineWeight = round3(grossWeight.times(purity.finenessPercent).dividedBy(100));

  if (input.direction === "OUT") {
    const balance = await getMetalStockBalanceInTx(tx, input.metalType, input.purityId);
    if (grossWeight.greaterThan(balance.grossWeight)) {
      throw new PostingError(
        `Cannot reduce stock by ${grossWeight.toFixed(3)}g — only ${balance.grossWeight.toFixed(3)}g available.`
      );
    }
  }

  return tx.metalStockMovement.create({
    data: {
      type: input.direction === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
      metalType: input.metalType,
      purityId: input.purityId,
      grossWeight: grossWeight.toFixed(3),
      fineWeight: fineWeight.toFixed(3),
      costValue: costValue.toFixed(2),
      sourceDocument: `Adjustment: ${input.reason.trim()}`,
      createdByUserId: input.createdByUserId,
    },
  });
}

// ---------------------------------------------------------------------------
// Create Jewellery Job (Draft — no accounting/stock impact)
// ---------------------------------------------------------------------------

export async function createJewelleryJob(
  tx: Tx,
  input: {
    customerId?: string | null;
    customerReference?: string | null;
    jewelleryType: JewelleryType;
    designName: string;
    designImageAssetId?: string | null;
    karigarId: string;
    issueDate: Date;
    expectedDeliveryDate?: Date | null;
    notes?: string | null;
    jewellerySize?: string | null;
    quantity: number;
    targetMetalType?: MetalType | null;
    targetPurityId?: string | null;
    targetFinishedWeight?: DecimalInput | null;
    specialInstructions?: string | null;
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  if (input.quantity < 1) throw new PostingError("Quantity must be at least 1.");

  const jobCode = await nextJewelleryCode(tx, "JEWELLERY_JOB");

  return tx.jewelleryJob.create({
    data: {
      jobCode,
      customerId: input.customerId || null,
      customerReference: input.customerReference || null,
      jewelleryType: input.jewelleryType,
      designName: input.designName,
      designImageAssetId: input.designImageAssetId || null,
      karigarId: input.karigarId,
      issueDate: input.issueDate,
      expectedDeliveryDate: input.expectedDeliveryDate ?? null,
      notes: input.notes || null,
      jewellerySize: input.jewellerySize || null,
      quantity: input.quantity,
      targetMetalType: input.targetMetalType ?? null,
      targetPurityId: input.targetPurityId || null,
      targetFinishedWeight:
        input.targetFinishedWeight != null ? round3(input.targetFinishedWeight).toFixed(3) : null,
      specialInstructions: input.specialInstructions || null,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });
}

// ---------------------------------------------------------------------------
// Issue Materials (metal + Phase 3 polished diamonds + other lines)
// ---------------------------------------------------------------------------

export type MetalIssueLineInput = {
  metalType: MetalType;
  purityId: string;
  grossWeight: DecimalInput;
};

export type OtherMaterialLineInput = {
  description: string;
  quantity: DecimalInput;
  unit: "PCS" | "CT" | "GRAM" | "OTHER";
  weight?: DecimalInput | null;
  cost: DecimalInput;
  note?: string | null;
};

export async function issueMaterialsToJewelleryJob(
  tx: Tx,
  input: FyInput & {
    jobId: string;
    issueDate: Date;
    metalLines: MetalIssueLineInput[];
    polishedDiamondIds: string[];
    otherMaterialLines: OtherMaterialLineInput[];
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new PostingError("Job not found.");
  if (job.status !== "DRAFT") {
    throw new PostingError("Materials have already been issued for this job.");
  }
  if (
    input.metalLines.length === 0 &&
    input.polishedDiamondIds.length === 0 &&
    input.otherMaterialLines.length === 0
  ) {
    throw new PostingError("Issue at least one metal line, diamond, or other material.");
  }

  const uniqueDiamondIds = [...new Set(input.polishedDiamondIds)];
  if (uniqueDiamondIds.length !== input.polishedDiamondIds.length) {
    throw new PostingError("The same polished diamond was selected more than once.");
  }

  // ---- Validate + resolve metal lines against real stock ----
  // Phase 7: Company Copper/Alloy (MetalType ALLOY, 0% fineness) is issued
  // through the same metal lines, but tracked in its own GROSS-weight cost
  // pool — it never enters the fine-weight WIP pool that receipts drain by
  // fine weight.
  let issuedMetalFineWeight = ZERO;
  let issuedMetalCost = ZERO;
  let fineBearingMetalCost = ZERO;
  let issuedAlloyGrossWeight = ZERO;
  let issuedAlloyCost = ZERO;
  let alloyPurityId: string | null = null;
  const resolvedMetalLines: {
    metalType: MetalType;
    purityId: string;
    finenessPercentSnapshot: Decimal;
    grossWeight: Decimal;
    fineWeight: Decimal;
    costValue: Decimal;
  }[] = [];

  for (const line of input.metalLines) {
    const grossWeight = round3(line.grossWeight);
    if (!grossWeight.greaterThan(0)) {
      throw new PostingError("Each metal line's gross weight must be greater than zero.");
    }
    const purity = await tx.metalPurity.findUnique({ where: { id: line.purityId } });
    if (!purity || !purity.isActive || purity.metalType !== line.metalType) {
      throw new PostingError("One of the selected metal purities was not found or is inactive.");
    }
    const isAlloy = purity.metalType === "ALLOY";
    if (isAlloy) {
      if (alloyPurityId && alloyPurityId !== line.purityId) {
        throw new PostingError("Issue Company Copper/Alloy from one alloy purity per job.");
      }
      alloyPurityId = line.purityId;
    }
    const balance = await getMetalStockBalanceInTx(tx, line.metalType, line.purityId);
    if (grossWeight.greaterThan(balance.grossWeight)) {
      throw new PostingError(
        `Not enough ${purity.displayName} stock: requested ${grossWeight.toFixed(3)}g, only ${balance.grossWeight.toFixed(3)}g available.`
      );
    }
    const costPerGram = balance.grossWeight.greaterThan(0)
      ? balance.costValue.dividedBy(balance.grossWeight)
      : ZERO;
    const costValue = round2(grossWeight.times(costPerGram));
    const finenessPercentSnapshot = new Decimal(purity.finenessPercent);
    const fineWeight = round3(grossWeight.times(finenessPercentSnapshot).dividedBy(100));

    resolvedMetalLines.push({
      metalType: line.metalType,
      purityId: line.purityId,
      finenessPercentSnapshot,
      grossWeight,
      fineWeight,
      costValue,
    });
    issuedMetalCost = issuedMetalCost.plus(costValue);
    if (isAlloy) {
      issuedAlloyGrossWeight = issuedAlloyGrossWeight.plus(grossWeight);
      issuedAlloyCost = issuedAlloyCost.plus(costValue);
    } else {
      issuedMetalFineWeight = issuedMetalFineWeight.plus(fineWeight);
      fineBearingMetalCost = fineBearingMetalCost.plus(costValue);
    }
  }
  issuedMetalFineWeight = round3(issuedMetalFineWeight);
  issuedMetalCost = round2(issuedMetalCost);
  fineBearingMetalCost = round2(fineBearingMetalCost);
  issuedAlloyGrossWeight = round3(issuedAlloyGrossWeight);
  issuedAlloyCost = round2(issuedAlloyCost);

  // ---- Validate diamonds: must be Available, never double-issued ----
  const diamonds =
    uniqueDiamondIds.length > 0
      ? await tx.polishedDiamond.findMany({ where: { id: { in: uniqueDiamondIds } } })
      : [];
  if (diamonds.length !== uniqueDiamondIds.length) {
    throw new PostingError("One or more selected polished diamonds were not found.");
  }
  for (const d of diamonds) {
    if (d.status !== "AVAILABLE") {
      throw new PostingError(
        `Polished diamond ${d.polishedCode} is not available to issue (current status: ${d.status}).`
      );
    }
  }
  const issuedDiamondCost = round2(diamonds.reduce((sum, d) => sum.plus(new Decimal(d.allocatedCost)), ZERO));

  // ---- Other material lines (never stock-tracked) ----
  let otherMaterialCost = ZERO;
  for (const line of input.otherMaterialLines) {
    const cost = round2(line.cost);
    if (cost.isNegative()) throw new PostingError("Other material cost cannot be negative.");
    otherMaterialCost = otherMaterialCost.plus(cost);
  }
  otherMaterialCost = round2(otherMaterialCost);

  const totalIssuedCost = round2(issuedMetalCost.plus(issuedDiamondCost));
  if (!totalIssuedCost.greaterThan(0) && input.otherMaterialLines.length === 0) {
    throw new PostingError("At least some stock-tracked material (metal or a diamond) must be issued.");
  }

  const jobCode = job.jobCode;

  // ---- Post the WIP transfer voucher (metal + diamond only — other
  // material lines are not stock, so they never touch accounting stock
  // accounts; their cost is tracked on the job for information only) ----
  let voucherId: string | null = null;
  if (totalIssuedCost.greaterThan(0)) {
    const voucher = await createVoucherHeader(
      tx,
      {
        date: input.issueDate,
        fyStartMonth: input.fyStartMonth,
        fyStartDay: input.fyStartDay,
        currencyCode: "INR",
        exchangeRate: 1,
        note: `Materials issued to Karigar — job ${jobCode}`,
        idempotencyKey: input.idempotencyKey,
        createdByUserId: input.createdByUserId,
      },
      "JEWELLERY_ISSUE",
      { amount: totalIssuedCost }
    );
    voucherId = voucher.id;

    const journalLines: JournalLineInput[] = [
      { accountCode: SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, debit: totalIssuedCost, description: `Issue ${jobCode}` },
    ];
    if (issuedMetalCost.greaterThan(0)) {
      journalLines.push({
        accountCode: SYSTEM_ACCOUNT_CODES.METAL_INVENTORY,
        credit: issuedMetalCost,
        description: `Issue ${jobCode}`,
      });
    }
    if (issuedDiamondCost.greaterThan(0)) {
      journalLines.push({
        accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY,
        credit: issuedDiamondCost,
        description: `Issue ${jobCode}`,
      });
    }
    await insertBalancedJournalLines(tx, voucher.id, journalLines);
  }

  // ---- Create metal issue lines + stock movements ----
  for (const line of resolvedMetalLines) {
    await tx.jewelleryMetalIssueLine.create({
      data: {
        jobId: job.id,
        metalType: line.metalType,
        purityId: line.purityId,
        finenessPercentSnapshot: line.finenessPercentSnapshot.toFixed(3),
        grossWeight: line.grossWeight.toFixed(3),
        fineWeight: line.fineWeight.toFixed(3),
        costValue: line.costValue.toFixed(2),
        issueDate: input.issueDate,
      },
    });
    await tx.metalStockMovement.create({
      data: {
        type: "ISSUE_OUT",
        metalType: line.metalType,
        purityId: line.purityId,
        grossWeight: line.grossWeight.toFixed(3),
        fineWeight: line.fineWeight.toFixed(3),
        costValue: line.costValue.toFixed(2),
        sourceDocument: jobCode,
        jewelleryJobId: job.id,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  // ---- Create diamond issue lines + mark diamonds issued ----
  for (const d of diamonds) {
    await tx.jewelleryDiamondIssueLine.create({
      data: {
        jobId: job.id,
        polishedDiamondId: d.id,
        caratAtIssue: d.carat,
        costAtIssue: d.allocatedCost,
      },
    });
    await tx.polishedDiamond.update({ where: { id: d.id }, data: { status: "ISSUED_TO_JEWELLERY" } });
    await tx.stockMovement.create({
      data: {
        type: "JEWELLERY_ISSUE_OUT",
        polishedDiamondId: d.id,
        jewelleryJobId: job.id,
        pieces: 1,
        carat: d.carat,
        costValue: d.allocatedCost,
        sourceDocument: jobCode,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  // ---- Other material lines (documentation only, no movement) ----
  for (const line of input.otherMaterialLines) {
    await tx.jewelleryOtherMaterialLine.create({
      data: {
        jobId: job.id,
        description: line.description,
        quantity: round3(line.quantity).toFixed(3),
        unit: line.unit,
        weight: line.weight != null ? round3(line.weight).toFixed(3) : null,
        cost: round2(line.cost).toFixed(2),
        note: line.note || null,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  // remainingWipCost tracks FINE-BEARING METAL WIP only. Diamonds are
  // discrete and already individually costed (costAtIssue per issue line),
  // so they resolve directly by that exact figure when SET/RETURNED/
  // DAMAGED_LOST — never via a shared-pool ratio the way fungible metal
  // must. Company Copper/Alloy has its own gross-weight pool
  // (remainingAlloyWipCost). All of it still debits the SAME Jewellery WIP
  // account at issue time (correct at the ledger level); these fields only
  // track the application-level pools receipts drain.
  return tx.jewelleryJob.update({
    where: { id: job.id },
    data: {
      status: "MATERIALS_ISSUED",
      issuedMetalFineWeight: issuedMetalFineWeight.toFixed(3),
      issuedMetalCost: issuedMetalCost.toFixed(2),
      issuedDiamondCost: issuedDiamondCost.toFixed(2),
      otherMaterialCost: otherMaterialCost.toFixed(2),
      remainingWipCost: fineBearingMetalCost.toFixed(2),
      issuedAlloyGrossWeight: issuedAlloyGrossWeight.toFixed(3),
      issuedAlloyCost: issuedAlloyCost.toFixed(2),
      remainingAlloyWipCost: issuedAlloyCost.toFixed(2),
      wipVoucherId: voucherId,
      // Keep the job's own create-time idempotency key when it has one —
      // overwriting it would let a late duplicate "create job" submission
      // slip past its duplicate check (PHASE_7_CURRENT_STATE_AUDIT.md §4.18).
      idempotencyKey: job.idempotencyKey ?? input.idempotencyKey ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Mark In Progress (label only — no accounting/stock impact)
// ---------------------------------------------------------------------------

export async function markJewelleryJobInProgress(tx: Tx, jobId: string) {
  return tx.jewelleryJob.updateMany({
    where: { id: jobId, status: "MATERIALS_ISSUED" },
    data: { status: "IN_PROGRESS" },
  });
}

// ---------------------------------------------------------------------------
// Cancel an unused-materials job (Owner-only; enforced by the caller)
// ---------------------------------------------------------------------------

export async function cancelJewelleryJob(
  tx: Tx,
  input: FyInput & { jobId: string; cancelledByUserId: string; cancellationReason: string }
) {
  const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new PostingError("Job not found.");
  if (job.status === "CANCELLED") throw new PostingError("This job has already been cancelled.");

  if (job.status === "DRAFT") {
    return tx.jewelleryJob.update({
      where: { id: job.id },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledByUserId: input.cancelledByUserId,
        cancellationReason: input.cancellationReason,
      },
    });
  }

  if (job.status !== "MATERIALS_ISSUED" && job.status !== "IN_PROGRESS") {
    throw new PostingError(
      "This job cannot be cancelled once any finished jewellery has been received — use a receipt correction instead."
    );
  }
  if (!new Decimal(job.receivedFineWeight).isZero() || !new Decimal(job.returnedMetalFineWeight).isZero()) {
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

  const metalLines = await tx.jewelleryMetalIssueLine.findMany({ where: { jobId: job.id } });
  for (const line of metalLines) {
    await tx.metalStockMovement.create({
      data: {
        type: "ISSUE_CANCEL_IN",
        metalType: line.metalType,
        purityId: line.purityId,
        grossWeight: line.grossWeight,
        fineWeight: line.fineWeight,
        costValue: line.costValue,
        sourceDocument: job.jobCode,
        jewelleryJobId: job.id,
        createdByUserId: input.cancelledByUserId,
      },
    });
  }

  const diamondLines = await tx.jewelleryDiamondIssueLine.findMany({ where: { jobId: job.id } });
  for (const line of diamondLines) {
    await tx.polishedDiamond.update({ where: { id: line.polishedDiamondId }, data: { status: "AVAILABLE" } });
    await tx.stockMovement.create({
      data: {
        type: "JEWELLERY_ISSUE_CANCEL_IN",
        polishedDiamondId: line.polishedDiamondId,
        jewelleryJobId: job.id,
        pieces: 1,
        carat: line.caratAtIssue,
        costValue: line.costAtIssue,
        sourceDocument: job.jobCode,
        createdByUserId: input.cancelledByUserId,
      },
    });
  }

  return tx.jewelleryJob.update({
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
// Needs Correction (simple label toggle — no accounting/stock impact)
// ---------------------------------------------------------------------------

export async function setJewelleryJobNeedsCorrection(tx: Tx, jobId: string, flag: boolean) {
  const job = await tx.jewelleryJob.findUnique({ where: { id: jobId } });
  if (!job) throw new PostingError("Job not found.");
  if (flag) {
    if (job.status === "COMPLETED" || job.status === "CANCELLED" || job.status === "DRAFT") {
      throw new PostingError(`A job in ${job.status} status cannot be marked Needs Correction.`);
    }
    return tx.jewelleryJob.update({ where: { id: jobId }, data: { status: "NEEDS_CORRECTION" } });
  }
  if (job.status !== "NEEDS_CORRECTION") {
    throw new PostingError("This job is not currently marked Needs Correction.");
  }
  return tx.jewelleryJob.update({ where: { id: jobId }, data: { status: "IN_PROGRESS" } });
}

// ---------------------------------------------------------------------------
// Receive Finished Jewellery (partial-receipt-safe, multi-output,
// multi-material reconciliation)
// ---------------------------------------------------------------------------

export type FinishedOutputInput = {
  jewelleryType: JewelleryType;
  description?: string | null;
  quantity: number;
  grossWeight?: DecimalInput | null;
  netMetalWeight: DecimalInput;
  metalType: MetalType;
  purityId: string;
  diamondIds: string[];
  photoAssetId?: string | null;
  qcStatus: QcStatus;
  notes?: string | null;
};

export type DiamondResolutionInput = {
  polishedDiamondId: string;
  resolution: "SET" | "RETURNED" | "DAMAGED_LOST";
  damagedLostReason?: string | null;
};

export type MetalReturnScrapLineInput = { purityId: string; grossWeight: DecimalInput };

/**
 * Phase 7 — where the Alloy Added in this receipt's finished outputs came
 * from. The three gross weights must together equal EXACTLY the alloy
 * computed from the outputs (see computeOutputMetal); a receipt whose
 * outputs add no alloy passes nothing.
 */
export type AlloyAddedInput = {
  /** Consumed from the Company Copper/Alloy issued to this job. */
  companyGrossWeight?: DecimalInput | null;
  /** Supplied by the Karigar. */
  karigarGrossWeight?: DecimalInput | null;
  /** Karigar's charge for that alloy — posted once, to his payable. */
  karigarCost?: DecimalInput | null;
  /** Present in the piece, no separate cost recorded. */
  includedGrossWeight?: DecimalInput | null;
};

export async function receiveFinishedJewellery(
  tx: Tx,
  input: FyInput & {
    jobId: string;
    receiveDate: Date;
    outputs: FinishedOutputInput[];
    diamondResolutions: DiamondResolutionInput[];
    returnedMetalLines: MetalReturnScrapLineInput[];
    scrapMetalLines: MetalReturnScrapLineInput[];
    karigarAddedFineWeight: DecimalInput;
    karigarAddedCost: DecimalInput;
    alloy?: AlloyAddedInput | null;
    labourCharge: DecimalInput;
    makingCharge: DecimalInput;
    settingCharge: DecimalInput;
    platingCharge: DecimalInput;
    otherExpense: DecimalInput;
    markJobComplete: boolean;
    isAbnormalLoss: boolean;
    abnormalLossReason?: string | null;
    notes?: string | null;
    damagedLostByUserId: string;
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new PostingError("Job not found.");
  if (job.status === "CANCELLED") throw new PostingError("This job has been cancelled.");
  if (job.status === "COMPLETED") throw new PostingError("This job is already completed.");
  if (job.status === "DRAFT") throw new PostingError("Issue materials to this job before receiving.");

  if (input.isAbnormalLoss && (!input.abnormalLossReason || input.abnormalLossReason.trim().length < 3)) {
    throw new PostingError("Give a short reason for classifying this loss as abnormal.");
  }

  // ---- Issued metal, split into fine-bearing purities (gold/silver/
  // platinum — reconciled by fine weight) and the job's Company
  // Copper/Alloy purity (0% fineness — reconciled by gross weight). Fine
  // weight always uses the fineness SNAPSHOT from the job's own issue line
  // (the fineness at the moment this exact metal was issued), never a
  // fresh lookup against the (possibly since-edited) purity master. ----
  const metalIssueLines = await tx.jewelleryMetalIssueLine.findMany({ where: { jobId: job.id } });
  const finenessSnapshotByPurityId = new Map<string, Decimal>();
  const metalTypeByPurityId = new Map<string, MetalType>();
  const issuedFineWeightByPurityId = new Map<string, Decimal>();
  let alloyPurityId: string | null = null;
  for (const line of metalIssueLines) {
    if (line.metalType === "ALLOY") {
      alloyPurityId = line.purityId;
      continue;
    }
    finenessSnapshotByPurityId.set(line.purityId, new Decimal(line.finenessPercentSnapshot));
    metalTypeByPurityId.set(line.purityId, line.metalType);
    issuedFineWeightByPurityId.set(
      line.purityId,
      (issuedFineWeightByPurityId.get(line.purityId) ?? ZERO).plus(new Decimal(line.fineWeight))
    );
  }
  const isAlloyLine = (line: MetalReturnScrapLineInput) => alloyPurityId !== null && line.purityId === alloyPurityId;

  // ---- Resolve return/scrap lines — EACH line must explicitly name a
  // purity that was actually issued to THIS job; never a silent default
  // to "the first issued purity." ----
  type ResolvedMetalReturnScrapLine = { purityId: string; metalType: MetalType; grossWeight: Decimal; fineWeight: Decimal };
  function resolveReturnScrapLines(rawLines: MetalReturnScrapLineInput[], label: string): ResolvedMetalReturnScrapLine[] {
    return rawLines.map((raw) => {
      const grossWeight = round3(raw.grossWeight);
      if (!grossWeight.greaterThan(0)) {
        throw new PostingError(`Each ${label} line's weight must be greater than zero.`);
      }
      const finenessPercentSnapshot = finenessSnapshotByPurityId.get(raw.purityId);
      const metalType = metalTypeByPurityId.get(raw.purityId);
      if (!finenessPercentSnapshot || !metalType) {
        throw new PostingError(`Selected ${label} purity was not issued to this job.`);
      }
      const fineWeight = round3(grossWeight.times(finenessPercentSnapshot).dividedBy(100));
      return { purityId: raw.purityId, metalType, grossWeight, fineWeight };
    });
  }

  if (input.scrapMetalLines.some(isAlloyLine)) {
    throw new PostingError("Copper/Alloy cannot be returned as scrap — return unused alloy as returned alloy, or leave the difference as process loss.");
  }
  const resolvedReturnLines = resolveReturnScrapLines(
    input.returnedMetalLines.filter((line) => !isAlloyLine(line)),
    "returned-metal"
  );
  const resolvedScrapLines = resolveReturnScrapLines(input.scrapMetalLines, "scrap");
  const alloyReturnLines = input.returnedMetalLines.filter(isAlloyLine).map((raw) => {
    const grossWeight = round3(raw.grossWeight);
    if (!grossWeight.greaterThan(0)) {
      throw new PostingError("Each returned-metal line's weight must be greater than zero.");
    }
    return { purityId: raw.purityId, grossWeight };
  });

  // Per-purity availability — an aggregate "total pending" check alone
  // can't catch e.g. "returning 15g of 22K when this job only ever
  // issued 10g of 22K" if it also issued a different purity whose own
  // pending would otherwise absorb the difference.
  const purityDemand = new Map<string, Decimal>();
  for (const line of [...resolvedReturnLines, ...resolvedScrapLines]) {
    purityDemand.set(line.purityId, (purityDemand.get(line.purityId) ?? ZERO).plus(line.fineWeight));
  }
  for (const [purityId, demandFineWeight] of purityDemand) {
    const purityPending = await getJobPurityPendingFineWeightInTx(tx, job.id, purityId);
    if (demandFineWeight.greaterThan(purityPending)) {
      const purityRow = await tx.metalPurity.findUnique({ where: { id: purityId } });
      throw new PostingError(
        `Cannot return/scrap ${demandFineWeight.toFixed(3)}g fine weight of ${purityRow?.displayName ?? "this purity"} — only ${purityPending.toFixed(3)}g of that purity is still pending for this job.`
      );
    }
  }

  const returnedGross = round3(resolvedReturnLines.reduce((sum, l) => sum.plus(l.grossWeight), ZERO));
  const scrapGross = round3(resolvedScrapLines.reduce((sum, l) => sum.plus(l.grossWeight), ZERO));
  const returnedFineWeight = round3(resolvedReturnLines.reduce((sum, l) => sum.plus(l.fineWeight), ZERO));
  const scrapFineWeight = round3(resolvedScrapLines.reduce((sum, l) => sum.plus(l.fineWeight), ZERO));
  const alloyReturnedGross = round3(alloyReturnLines.reduce((sum, l) => sum.plus(l.grossWeight), ZERO));

  if (
    input.outputs.length === 0 &&
    returnedGross.isZero() &&
    scrapGross.isZero() &&
    alloyReturnedGross.isZero() &&
    input.diamondResolutions.length === 0
  ) {
    throw new PostingError("Record at least one finished output, return, scrap amount, or diamond resolution.");
  }

  // ---- Resolve outputs: fine weight, source purity, Alloy Added ----
  const resolvedOutputs: {
    input: FinishedOutputInput;
    finenessPercentSnapshot: Decimal;
    netMetalWeight: Decimal;
    fineWeight: Decimal;
    alloyAddedWeight: Decimal;
    sourcePurityId: string;
    sourceFinenessPercentSnapshot: Decimal;
  }[] = [];
  let thisFinishedFineWeight = ZERO;
  let expectedAlloyAdded = ZERO;
  const allOutputDiamondIds = new Set<string>();
  for (const output of input.outputs) {
    if (output.quantity < 1) throw new PostingError("Each output's quantity must be at least 1.");
    const netMetalWeight = round3(output.netMetalWeight);
    if (!netMetalWeight.greaterThan(0)) throw new PostingError("Each output's net metal weight must be greater than zero.");
    if (output.metalType === "ALLOY") {
      throw new PostingError("A finished output cannot be recorded as Copper/Alloy — choose the gold, silver or platinum purity of the finished piece.");
    }

    let finenessPercentSnapshot: Decimal;
    let sourcePurityId: string;
    const issuedSnapshot = finenessSnapshotByPurityId.get(output.purityId);
    if (issuedSnapshot) {
      // Same purity as issued — Phase 4 behaviour, unchanged: the job's own
      // issue-time fineness snapshot, and the consumed metal is this purity.
      if (metalTypeByPurityId.get(output.purityId) !== output.metalType) {
        throw new PostingError("One of the outputs' metal type does not match its selected purity.");
      }
      finenessPercentSnapshot = issuedSnapshot;
      sourcePurityId = output.purityId;
    } else {
      // Phase 7 cross-purity output (e.g. 24K issued, 18K received). The
      // final purity is an ATTRIBUTE of the finished piece, never a claim
      // that 18K stock was issued: the consumed source is still the one
      // issued purity, and no movement is ever posted against the output
      // purity's pool. Only allowed when the job issued exactly one
      // fine-bearing purity of this metal — with two (e.g. 22K + 18K) there
      // is no unambiguous source to trace the fine metal back to, so the
      // Phase 4 "must be an issued purity" rule still applies.
      const sameMetalSources = [...metalTypeByPurityId.entries()].filter(([, metalType]) => metalType === output.metalType);
      if (sameMetalSources.length !== 1) {
        throw new PostingError("Each output's metal purity must be one of the purities issued to this job.");
      }
      sourcePurityId = sameMetalSources[0][0];
      const sourceFineness = finenessSnapshotByPurityId.get(sourcePurityId)!;
      const outputPurity = await tx.metalPurity.findUnique({ where: { id: output.purityId } });
      if (!outputPurity || !outputPurity.isActive || outputPurity.metalType !== output.metalType) {
        throw new PostingError("The selected final purity was not found, is inactive, or does not match the output's metal.");
      }
      finenessPercentSnapshot = new Decimal(outputPurity.finenessPercent);
      if (!finenessPercentSnapshot.greaterThan(0)) {
        throw new PostingError("The selected final purity has no fineness.");
      }
      if (finenessPercentSnapshot.greaterThan(sourceFineness)) {
        throw new PostingError(
          `Final purity ${outputPurity.displayName} (${finenessPercentSnapshot.toFixed(3)}%) is finer than the issued metal (${sourceFineness.toFixed(3)}%) — a finished piece cannot hold more fine metal per gram than was issued.`
        );
      }
    }

    const sourceFinenessPercentSnapshot = finenessSnapshotByPurityId.get(sourcePurityId)!;
    const metal = computeOutputMetal({
      netWeight: netMetalWeight.toFixed(3),
      outputFinenessPercent: finenessPercentSnapshot.toFixed(3),
      sourceFinenessPercent: sourceFinenessPercentSnapshot.toFixed(3),
      samePurity: sourcePurityId === output.purityId,
    });
    const fineWeight = new Decimal(formatThousandths(metal.fine));
    const alloyAddedWeight = new Decimal(formatThousandths(metal.alloyAdded));
    if (alloyAddedWeight.isNegative()) {
      throw new PostingError("A finished output holds more fine metal than its net weight allows at the issued purity.");
    }

    for (const id of output.diamondIds) {
      if (allOutputDiamondIds.has(id)) {
        throw new PostingError("The same diamond cannot be set into two outputs (or the same output twice).");
      }
      allOutputDiamondIds.add(id);
    }
    resolvedOutputs.push({
      input: output,
      finenessPercentSnapshot,
      netMetalWeight,
      fineWeight,
      alloyAddedWeight,
      sourcePurityId,
      sourceFinenessPercentSnapshot,
    });
    thisFinishedFineWeight = thisFinishedFineWeight.plus(fineWeight);
    expectedAlloyAdded = expectedAlloyAdded.plus(alloyAddedWeight);
  }
  thisFinishedFineWeight = round3(thisFinishedFineWeight);
  expectedAlloyAdded = round3(expectedAlloyAdded);
  const hasOutputs = resolvedOutputs.length > 0;

  // ---- Resolve + validate diamond resolutions ----
  const uniqueResolutionIds = new Set(input.diamondResolutions.map((r) => r.polishedDiamondId));
  if (uniqueResolutionIds.size !== input.diamondResolutions.length) {
    throw new PostingError("The same diamond appears more than once in the resolution list.");
  }
  for (const id of allOutputDiamondIds) {
    const resolution = input.diamondResolutions.find((r) => r.polishedDiamondId === id);
    if (!resolution || resolution.resolution !== "SET") {
      throw new PostingError("Every diamond set into an output must have a matching SET resolution.");
    }
  }
  for (const resolution of input.diamondResolutions) {
    if (resolution.resolution === "SET" && !allOutputDiamondIds.has(resolution.polishedDiamondId)) {
      throw new PostingError("A diamond resolved as SET must be assigned to exactly one output.");
    }
    if (resolution.resolution === "DAMAGED_LOST" && (!resolution.damagedLostReason || resolution.damagedLostReason.trim().length < 3)) {
      throw new PostingError("Give a short reason for marking a diamond damaged/lost.");
    }
  }

  const issueLines =
    input.diamondResolutions.length > 0
      ? await tx.jewelleryDiamondIssueLine.findMany({
          where: { jobId: job.id, polishedDiamondId: { in: [...uniqueResolutionIds] } },
        })
      : [];
  if (issueLines.length !== uniqueResolutionIds.size) {
    throw new PostingError("One or more diamonds in the resolution list were not issued to this job.");
  }
  for (const line of issueLines) {
    if (line.resolvedAs) {
      throw new PostingError("One or more diamonds have already been resolved for this job.");
    }
  }

  const setDiamondCost = round2(
    issueLines
      .filter((l) => input.diamondResolutions.find((r) => r.polishedDiamondId === l.polishedDiamondId)?.resolution === "SET")
      .reduce((sum, l) => sum.plus(new Decimal(l.costAtIssue)), ZERO)
  );
  const returnedDiamondCost = round2(
    issueLines
      .filter((l) => input.diamondResolutions.find((r) => r.polishedDiamondId === l.polishedDiamondId)?.resolution === "RETURNED")
      .reduce((sum, l) => sum.plus(new Decimal(l.costAtIssue)), ZERO)
  );
  const damagedLostDiamondCost = round2(
    issueLines
      .filter((l) => input.diamondResolutions.find((r) => r.polishedDiamondId === l.polishedDiamondId)?.resolution === "DAMAGED_LOST")
      .reduce((sum, l) => sum.plus(new Decimal(l.costAtIssue)), ZERO)
  );

  // ---- Alloy Added: the source split must total the computed alloy exactly ----
  const companyAlloyGross = round3(input.alloy?.companyGrossWeight ?? 0);
  const karigarAlloyGross = round3(input.alloy?.karigarGrossWeight ?? 0);
  const karigarAlloyCost = round2(input.alloy?.karigarCost ?? 0);
  const includedAlloyGross = round3(input.alloy?.includedGrossWeight ?? 0);
  if ([companyAlloyGross, karigarAlloyGross, karigarAlloyCost, includedAlloyGross].some((v) => v.isNegative())) {
    throw new PostingError("Alloy weights and alloy charge cannot be negative.");
  }
  const enteredAlloy = round3(companyAlloyGross.plus(karigarAlloyGross).plus(includedAlloyGross));
  if (!enteredAlloy.equals(expectedAlloyAdded)) {
    throw new PostingError(
      `The finished outputs contain ${expectedAlloyAdded.toFixed(3)}g of Alloy Added. Split it across Company stock, Karigar-added and Included so the parts total exactly ${expectedAlloyAdded.toFixed(3)}g (currently ${enteredAlloy.toFixed(3)}g).`
    );
  }
  if (karigarAlloyCost.greaterThan(0) && karigarAlloyGross.isZero()) {
    throw new PostingError("A Karigar alloy charge needs a Karigar-added alloy weight.");
  }
  const alloyPendingBefore = round3(
    new Decimal(job.issuedAlloyGrossWeight).minus(job.consumedAlloyGrossWeight).minus(job.returnedAlloyGrossWeight)
  );
  if ((companyAlloyGross.greaterThan(0) || alloyReturnedGross.greaterThan(0)) && !alloyPurityId) {
    throw new PostingError("No Company Copper/Alloy was issued to this job — record the alloy as Karigar-added or Included instead.");
  }
  if (companyAlloyGross.plus(alloyReturnedGross).greaterThan(alloyPendingBefore)) {
    throw new PostingError(
      `Company alloy used (${companyAlloyGross.toFixed(3)}g) plus returned alloy (${alloyReturnedGross.toFixed(3)}g) exceeds the ${alloyPendingBefore.toFixed(3)}g of Company Copper/Alloy still with the Karigar.`
    );
  }

  // ---- Metal reconciliation (gap-based, same pattern as Phase 3) ----
  const karigarAddedFineWeight = round3(input.karigarAddedFineWeight ?? 0);
  const karigarAddedCost = round2(input.karigarAddedCost ?? 0);
  if (karigarAddedFineWeight.isNegative() || karigarAddedCost.isNegative()) {
    throw new PostingError("Karigar-added weight/cost cannot be negative.");
  }

  const pendingFineWeightBefore = round3(
    new Decimal(job.issuedMetalFineWeight)
      .plus(job.karigarAddedFineWeight)
      .minus(job.receivedFineWeight)
      .minus(job.returnedMetalFineWeight)
      .minus(job.scrapFineWeight)
  );
  const pendingAvailable = round3(pendingFineWeightBefore.plus(karigarAddedFineWeight));
  const resolvedThisReceipt = round3(thisFinishedFineWeight.plus(returnedFineWeight).plus(scrapFineWeight));

  if (resolvedThisReceipt.greaterThan(pendingAvailable)) {
    throw new PostingError(
      `Finished (${thisFinishedFineWeight.toFixed(3)}g) plus returned (${returnedFineWeight.toFixed(3)}g) plus scrap (${scrapFineWeight.toFixed(3)}g) fine weight exceeds the ${pendingAvailable.toFixed(3)}g still pending for this job.`
    );
  }

  const gap = round3(pendingAvailable.minus(resolvedThisReceipt));
  const isFinalMetal = gap.isZero() || input.markJobComplete;
  const processLossFineWeight = isFinalMetal ? gap : ZERO;

  // Fine-bearing cost pool: drains by fine weight — the resolved share is
  // (pool × fine resolved ÷ fine pending), and the final receipt takes
  // the whole remaining pool so it reaches exactly zero.
  const remainingWipCostBefore = new Decimal(job.remainingWipCost);
  const totalCostPool = remainingWipCostBefore.plus(karigarAddedCost);
  const resolvedCost = isFinalMetal
    ? totalCostPool
    : resolvedThisReceipt.greaterThan(0)
      ? totalCostPool.times(resolvedThisReceipt).dividedBy(pendingAvailable).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : ZERO;

  const lossCost = input.isAbnormalLoss && processLossFineWeight.greaterThan(0) && pendingAvailable.greaterThan(0)
    ? resolvedCost.times(processLossFineWeight).dividedBy(pendingAvailable).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : ZERO;
  let returnedCost: Decimal;
  let scrapCost: Decimal;
  let finishedPortionCost: Decimal;
  // Cost resolved by this receipt that no finished output can carry — see
  // JewelleryReceipt.unabsorbedCost. Posted to Business Expenses.
  let unabsorbedCost = ZERO;
  if (hasOutputs) {
    returnedCost = returnedFineWeight.greaterThan(0) && resolvedThisReceipt.greaterThan(0)
      ? resolvedCost.times(returnedFineWeight).dividedBy(resolvedThisReceipt).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : ZERO;
    scrapCost = scrapFineWeight.greaterThan(0) && resolvedThisReceipt.greaterThan(0)
      ? resolvedCost.times(scrapFineWeight).dividedBy(resolvedThisReceipt).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : ZERO;
    // Normal (non-abnormal) process loss is never carved out — its cost
    // silently stays inside finishedPortionCost, absorbed into the
    // surviving finished jewellery, per the master plan.
    finishedPortionCost = round2(resolvedCost.minus(returnedCost).minus(scrapCost).minus(lossCost));
  } else {
    // No finished output in this receipt, so nothing may be debited to
    // Finished Jewellery Inventory. The whole resolved cost (net of any
    // abnormal loss) is split EXACTLY across returned metal and scrap —
    // normal loss stays absorbed in that surviving stock — with the
    // rounding remainder landing on one of them. If nothing survives at
    // all, it is an unabsorbable loss and is expensed.
    const distributable = round2(resolvedCost.minus(lossCost));
    const stockTargets = [
      ...(returnedFineWeight.greaterThan(0) ? [{ key: "returned", weight: returnedFineWeight }] : []),
      ...(scrapFineWeight.greaterThan(0) ? [{ key: "scrap", weight: scrapFineWeight }] : []),
    ];
    if (stockTargets.length > 0) {
      const split = allocateProportionally(distributable, stockTargets);
      returnedCost = split.find((s) => s.key === "returned")?.amount ?? ZERO;
      scrapCost = split.find((s) => s.key === "scrap")?.amount ?? ZERO;
    } else {
      returnedCost = ZERO;
      scrapCost = ZERO;
      unabsorbedCost = distributable;
    }
    finishedPortionCost = ZERO;
  }

  // ---- Company Copper/Alloy pool (gross weight). Non-final: resolves the
  // share used or returned. Final: resolves everything still pending —
  // alloy neither used nor returned is alloy loss, absorbed into the
  // finished pieces unless the Owner classifies the loss as abnormal. ----
  const remainingAlloyCostBefore = new Decimal(job.remainingAlloyWipCost);
  let alloyLossGross = ZERO;
  let alloyResolvedCost = ZERO;
  let alloyReturnedCost = ZERO;
  let alloyAbnormalLossCost = ZERO;
  let alloyToFinishedCost = ZERO;
  if (alloyPendingBefore.greaterThan(0)) {
    const alloyResolvedGross = round3(companyAlloyGross.plus(alloyReturnedGross));
    if (isFinalMetal) {
      alloyLossGross = round3(alloyPendingBefore.minus(alloyResolvedGross));
      alloyResolvedCost = remainingAlloyCostBefore;
      alloyReturnedCost = alloyReturnedGross.greaterThan(0)
        ? round2(remainingAlloyCostBefore.times(alloyReturnedGross).dividedBy(alloyPendingBefore))
        : ZERO;
      alloyAbnormalLossCost = input.isAbnormalLoss && alloyLossGross.greaterThan(0)
        ? round2(remainingAlloyCostBefore.times(alloyLossGross).dividedBy(alloyPendingBefore))
        : ZERO;
    } else if (alloyResolvedGross.greaterThan(0)) {
      alloyResolvedCost = round2(remainingAlloyCostBefore.times(alloyResolvedGross).dividedBy(alloyPendingBefore));
      alloyReturnedCost = alloyReturnedGross.greaterThan(0)
        ? round2(alloyResolvedCost.times(alloyReturnedGross).dividedBy(alloyResolvedGross))
        : ZERO;
    }
    alloyToFinishedCost = round2(alloyResolvedCost.minus(alloyReturnedCost).minus(alloyAbnormalLossCost));
    if (!hasOutputs && alloyToFinishedCost.greaterThan(0)) {
      unabsorbedCost = round2(unabsorbedCost.plus(alloyToFinishedCost));
      alloyToFinishedCost = ZERO;
    }
  }

  // ---- Split the aggregate returned/scrap cost across each individual
  // line proportionally by its own fine weight, so every return/scrap
  // movement posts its OWN cost share to its OWN purity identity —
  // never one lump sum attributed to a single "default" purity. ----
  const returnedCostAllocation =
    resolvedReturnLines.length > 0 && returnedCost.greaterThan(0)
      ? allocateProportionally(returnedCost, resolvedReturnLines.map((l, i) => ({ key: String(i), weight: l.fineWeight })))
      : [];
  const scrapCostAllocation =
    resolvedScrapLines.length > 0 && scrapCost.greaterThan(0)
      ? allocateProportionally(scrapCost, resolvedScrapLines.map((l, i) => ({ key: String(i), weight: l.fineWeight })))
      : [];
  const alloyReturnCostAllocation =
    alloyReturnLines.length > 0 && alloyReturnedCost.greaterThan(0)
      ? allocateProportionally(alloyReturnedCost, alloyReturnLines.map((l, i) => ({ key: String(i), weight: l.grossWeight })))
      : [];

  // ---- Other-material cost: PROVISIONAL, recalculated proportionally
  // by fine metal weight across EVERY output created for this job so
  // far — this receipt's new ones plus every earlier receipt's existing
  // ones — whenever a new output appears, so the total across every
  // output for the job always equals job.otherMaterialCost exactly
  // (deterministic rounding-remainder, same pattern as every other
  // proportional split in this codebase) once the job stops receiving
  // new outputs. If the job never receives ANY output at all, the cost
  // simply has nowhere to display and stays unallocated — an explicit,
  // documented rule, not a silent drop. Never posted through accounting
  // (no real source account backs it) — display/costing figure only. ----
  const jobOtherMaterialCost = new Decimal(job.otherMaterialCost);
  const priorOutputs = hasOutputs ? await tx.finishedJewellery.findMany({ where: { jobId: job.id } }) : [];
  let otherMaterialReallocation = new Map<string, Decimal>();
  if (hasOutputs && jobOtherMaterialCost.greaterThan(0)) {
    const allocationTargets = [
      ...priorOutputs.map((o) => ({ key: `prior:${o.id}`, weight: o.fineMetalWeight })),
      ...resolvedOutputs.map((o, i) => ({ key: `new:${i}`, weight: o.fineWeight })),
    ];
    const allocations = allocateProportionally(
      jobOtherMaterialCost,
      allocationTargets.map((t) => ({ key: t.key, weight: t.weight }))
    );
    otherMaterialReallocation = new Map(allocations.map((a) => [a.key, a.amount]));
  }

  const totalCharges = round2(
    new Decimal(input.labourCharge ?? 0)
      .plus(input.makingCharge ?? 0)
      .plus(input.settingCharge ?? 0)
      .plus(input.platingCharge ?? 0)
      .plus(input.otherExpense ?? 0)
  );
  if (totalCharges.isNegative()) throw new PostingError("Job charges cannot be negative.");
  // Charges become part of a finished piece's cost only when this receipt
  // produces a piece to carry them; otherwise they are expensed.
  const chargesToFinished = hasOutputs ? totalCharges : ZERO;
  if (!hasOutputs) unabsorbedCost = round2(unabsorbedCost.plus(totalCharges));

  const receiptCode = await nextJewelleryCode(tx, "JEWELLERY_RECEIPT");

  // ---- Allocate costs across outputs: metal + charges proportional by
  // each output's fine metal weight; alloy cost proportional by each
  // output's own Alloy Added (other-material uses otherMaterialReallocation,
  // computed above across this job's whole output history) ----
  const byFineWeight = resolvedOutputs.map((o, i) => ({ key: String(i), weight: o.fineWeight }));
  const metalAllocation = hasOutputs ? allocateProportionally(finishedPortionCost, byFineWeight) : [];
  const chargesAllocation = hasOutputs && chargesToFinished.greaterThan(0) ? allocateProportionally(chargesToFinished, byFineWeight) : [];
  const alloyCostToOutputs = round2(alloyToFinishedCost.plus(karigarAlloyCost));
  const alloyWeights = expectedAlloyAdded.greaterThan(0)
    ? resolvedOutputs.map((o, i) => ({ key: String(i), weight: o.alloyAddedWeight }))
    : resolvedOutputs.some((o) => o.fineWeight.greaterThan(0))
      ? byFineWeight
      : resolvedOutputs.map((o, i) => ({ key: String(i), weight: o.netMetalWeight }));
  const alloyAllocation = hasOutputs && alloyCostToOutputs.greaterThan(0) ? allocateProportionally(alloyCostToOutputs, alloyWeights) : [];

  // ---- Journal lines — built first so the voucher amount is the posting's
  // real total debit ----
  const journalLines: JournalLineInput[] = [];
  if (karigarAddedCost.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP,
      debit: karigarAddedCost,
      description: `Karigar-added material ${receiptCode}`,
    });
  }
  const finishedInventoryDebit = round2(finishedPortionCost.plus(alloyCostToOutputs).plus(chargesToFinished).plus(setDiamondCost));
  if (finishedInventoryDebit.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY,
      debit: finishedInventoryDebit,
      description: `Receipt ${receiptCode}`,
    });
  }
  if (returnedCost.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.METAL_INVENTORY,
      debit: returnedCost,
      description: `Returned metal ${receiptCode}`,
    });
  }
  if (alloyReturnedCost.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.METAL_INVENTORY,
      debit: alloyReturnedCost,
      description: `Returned Copper/Alloy ${receiptCode}`,
    });
  }
  if (scrapCost.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.SCRAP_METAL_INVENTORY,
      debit: scrapCost,
      description: `Scrap metal ${receiptCode}`,
    });
  }
  if (returnedDiamondCost.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY,
      debit: returnedDiamondCost,
      description: `Returned diamond(s) ${receiptCode}`,
    });
  }
  const abnormalExpense = round2(lossCost.plus(alloyAbnormalLossCost).plus(damagedLostDiamondCost));
  if (abnormalExpense.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES,
      debit: abnormalExpense,
      description: `Abnormal loss / damaged-lost diamond(s) ${receiptCode}`,
    });
  }
  if (unabsorbedCost.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES,
      debit: unabsorbedCost,
      description: `Loss/charges with no finished output to carry them ${receiptCode}`,
    });
  }
  const wipCredit = round2(
    resolvedCost.plus(alloyResolvedCost).plus(setDiamondCost).plus(returnedDiamondCost).plus(damagedLostDiamondCost)
  );
  if (wipCredit.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP,
      credit: wipCredit,
      description: `Receipt ${receiptCode}`,
    });
  }
  const karigarPayableCredit = round2(totalCharges.plus(karigarAddedCost).plus(karigarAlloyCost));
  if (karigarPayableCredit.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: job.karigarId,
      credit: karigarPayableCredit,
      description: `Karigar payable ${receiptCode}`,
    });
  }
  const totalDebit = round2(journalLines.reduce((sum, line) => sum.plus(new Decimal(line.debit ?? 0)), ZERO));

  const voucher = await createVoucherHeader(
    tx,
    {
      date: input.receiveDate,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
      currencyCode: "INR",
      exchangeRate: 1,
      note: `Jewellery receipt ${receiptCode} for job ${job.jobCode}`,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.createdByUserId,
    },
    "JEWELLERY_RECEIPT",
    { amount: totalDebit }
  );

  await insertBalancedJournalLines(tx, voucher.id, journalLines);

  const receipt = await tx.jewelleryReceipt.create({
    data: {
      receiptCode,
      jobId: job.id,
      receiveDate: input.receiveDate,
      returnedMetalGrossWeight: returnedGross.toFixed(3),
      returnedMetalFineWeight: returnedFineWeight.toFixed(3),
      scrapGrossWeight: scrapGross.toFixed(3),
      scrapFineWeight: scrapFineWeight.toFixed(3),
      processLossFineWeight: processLossFineWeight.toFixed(3),
      isAbnormalLoss: input.isAbnormalLoss,
      abnormalLossReason: input.isAbnormalLoss ? input.abnormalLossReason ?? null : null,
      karigarAddedFineWeight: karigarAddedFineWeight.toFixed(3),
      karigarAddedCost: karigarAddedCost.toFixed(2),
      companyAlloyGrossWeight: companyAlloyGross.toFixed(3),
      companyAlloyCost: alloyToFinishedCost.toFixed(2),
      karigarAlloyGrossWeight: karigarAlloyGross.toFixed(3),
      karigarAlloyCost: karigarAlloyCost.toFixed(2),
      includedAlloyGrossWeight: includedAlloyGross.toFixed(3),
      returnedAlloyGrossWeight: alloyReturnedGross.toFixed(3),
      alloyLossGrossWeight: alloyLossGross.toFixed(3),
      unabsorbedCost: unabsorbedCost.toFixed(2),
      labourCharge: round2(input.labourCharge ?? 0).toFixed(2),
      makingCharge: round2(input.makingCharge ?? 0).toFixed(2),
      settingCharge: round2(input.settingCharge ?? 0).toFixed(2),
      platingCharge: round2(input.platingCharge ?? 0).toFixed(2),
      otherExpense: round2(input.otherExpense ?? 0).toFixed(2),
      notes: input.notes || null,
      postingVoucherId: voucher.id,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  // ---- Create finished outputs ----
  const purityDisplayNameCache = new Map<string, string>();
  async function purityDisplayName(purityId: string): Promise<string> {
    const cached = purityDisplayNameCache.get(purityId);
    if (cached !== undefined) return cached;
    const row = await tx.metalPurity.findUnique({ where: { id: purityId } });
    const name = row?.displayName ?? "";
    purityDisplayNameCache.set(purityId, name);
    return name;
  }

  const createdOutputs = [];
  for (let i = 0; i < resolvedOutputs.length; i++) {
    const resolved = resolvedOutputs[i];
    const finishedCode = await nextJewelleryCode(tx, "FINISHED_JEWELLERY");
    const goldMetalCost = metalAllocation.find((a) => a.key === String(i))?.amount ?? ZERO;
    const alloyCost = alloyAllocation.find((a) => a.key === String(i))?.amount ?? ZERO;
    const metalCost = round2(goldMetalCost.plus(alloyCost));
    const otherCost = otherMaterialReallocation.get(`new:${i}`) ?? ZERO;
    const labourAllocated = chargesAllocation.find((a) => a.key === String(i))?.amount ?? ZERO;
    const outputDiamondIssueLines = issueLines.filter((l) => resolved.input.diamondIds.includes(l.polishedDiamondId));
    const diamondCostForOutput = round2(
      outputDiamondIssueLines.reduce((sum, l) => sum.plus(new Decimal(l.costAtIssue)), ZERO)
    );
    const totalCaratForOutput = round3(
      outputDiamondIssueLines.reduce((sum, l) => sum.plus(new Decimal(l.caratAtIssue)), ZERO)
    );
    const totalCost = round2(metalCost.plus(diamondCostForOutput).plus(otherCost).plus(labourAllocated));

    const output = await tx.finishedJewellery.create({
      data: {
        finishedCode,
        receiptId: receipt.id,
        jobId: job.id,
        jewelleryType: resolved.input.jewelleryType,
        description: resolved.input.description || null,
        quantity: resolved.input.quantity,
        grossWeight: resolved.input.grossWeight != null ? round3(resolved.input.grossWeight).toFixed(3) : null,
        netMetalWeight: resolved.netMetalWeight.toFixed(3),
        metalType: resolved.input.metalType,
        purityId: resolved.input.purityId,
        finenessPercentSnapshot: resolved.finenessPercentSnapshot.toFixed(3),
        fineMetalWeight: resolved.fineWeight.toFixed(3),
        alloyAddedWeight: resolved.alloyAddedWeight.toFixed(3),
        alloyCost: alloyCost.toFixed(2),
        sourcePurityDisplayNameSnapshot: await purityDisplayName(resolved.sourcePurityId),
        sourceFinenessPercentSnapshot: resolved.sourceFinenessPercentSnapshot.toFixed(3),
        metalCost: metalCost.toFixed(2),
        diamondCost: diamondCostForOutput.toFixed(2),
        otherMaterialCost: otherCost.toFixed(2),
        labourAllocated: labourAllocated.toFixed(2),
        totalCost: totalCost.toFixed(2),
        photoAssetId: resolved.input.photoAssetId || null,
        qcStatus: resolved.input.qcStatus,
        notes: resolved.input.notes || null,
        createdByUserId: input.createdByUserId,
      },
    });
    createdOutputs.push(output);

    // Phase 6: every FinishedJewellery output enters the stock ledger
    // exactly once, atomically with its own creation. `costValue` is the
    // AUTHORITATIVE accounting inventory cost — metalCost + diamondCost +
    // labourAllocated, deliberately NOT totalCost (which wrongly includes
    // display-only otherMaterialCost — see the header comment on
    // FinishedJewellery in schema.prisma). This is also why it is safe to
    // snapshot here, at creation time, even though a LATER receipt on this
    // same (still-open) job may retroactively rewrite this output's
    // otherMaterialCost/totalCost (see the "priorOutputs" reallocation
    // above): that reallocation only ever changes otherMaterialCost, which
    // this figure never included in the first place. Phase 7: metalCost
    // already includes this output's real alloy cost.
    const inventoryCost = round2(metalCost.plus(diamondCostForOutput).plus(labourAllocated));
    await tx.finishedJewelleryStockMovement.create({
      data: {
        type: "PRODUCED_IN",
        finishedJewelleryId: output.id,
        pieces: output.quantity,
        costValue: inventoryCost.toFixed(2),
        finishedCodeSnapshot: output.finishedCode,
        jewelleryTypeSnapshot: output.jewelleryType,
        metalTypeSnapshot: output.metalType,
        purityDisplayNameSnapshot: await purityDisplayName(output.purityId),
        netMetalWeightSnapshot: output.netMetalWeight,
        fineMetalWeightSnapshot: output.fineMetalWeight,
        totalCaratSnapshot: totalCaratForOutput.toFixed(3),
        jobCodeSnapshot: job.jobCode,
        sourceDocument: receiptCode,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  // ---- Retroactively correct earlier receipts' outputs' other-material
  // share now that this receipt's new outputs changed the job's total
  // output fine weight — this is the "recalculate provisional
  // allocations when later outputs are received" behavior. A no-op
  // write is skipped so unaffected jobs (the common single-receipt
  // case) never touch rows that didn't actually change. ----
  for (const prior of priorOutputs) {
    const newShare = otherMaterialReallocation.get(`prior:${prior.id}`) ?? ZERO;
    if (!newShare.equals(new Decimal(prior.otherMaterialCost))) {
      const newTotalCost = round2(
        new Decimal(prior.metalCost).plus(prior.diamondCost).plus(newShare).plus(prior.labourAllocated)
      );
      await tx.finishedJewellery.update({
        where: { id: prior.id },
        data: { otherMaterialCost: newShare.toFixed(2), totalCost: newTotalCost.toFixed(2) },
      });
    }
  }

  // ---- Resolve diamond issue lines + move stock + record movements ----
  for (const line of issueLines) {
    const resolution = input.diamondResolutions.find((r) => r.polishedDiamondId === line.polishedDiamondId)!;
    if (resolution.resolution === "SET") {
      const outputIndex = resolvedOutputs.findIndex((o) => o.input.diamondIds.includes(line.polishedDiamondId));
      const output = createdOutputs[outputIndex];
      await tx.jewelleryDiamondIssueLine.update({
        where: { id: line.id },
        data: { resolvedAs: "SET", resolvedAt: new Date(), setInFinishedJewelleryId: output.id },
      });
      await tx.polishedDiamond.update({ where: { id: line.polishedDiamondId }, data: { status: "SET_IN_JEWELLERY" } });
      await tx.stockMovement.create({
        data: {
          type: "JEWELLERY_SET_OUT",
          polishedDiamondId: line.polishedDiamondId,
          jewelleryJobId: job.id,
          pieces: 1,
          carat: line.caratAtIssue,
          costValue: line.costAtIssue,
          sourceDocument: receiptCode,
          createdByUserId: input.createdByUserId,
        },
      });
    } else if (resolution.resolution === "RETURNED") {
      await tx.jewelleryDiamondIssueLine.update({
        where: { id: line.id },
        data: { resolvedAs: "RETURNED", resolvedAt: new Date() },
      });
      await tx.polishedDiamond.update({ where: { id: line.polishedDiamondId }, data: { status: "AVAILABLE" } });
      await tx.stockMovement.create({
        data: {
          type: "JEWELLERY_RETURN_IN",
          polishedDiamondId: line.polishedDiamondId,
          jewelleryJobId: job.id,
          pieces: 1,
          carat: line.caratAtIssue,
          costValue: line.costAtIssue,
          sourceDocument: receiptCode,
          createdByUserId: input.createdByUserId,
        },
      });
    } else {
      await tx.jewelleryDiamondIssueLine.update({
        where: { id: line.id },
        data: { resolvedAs: "DAMAGED_LOST", resolvedAt: new Date() },
      });
      await tx.polishedDiamond.update({
        where: { id: line.polishedDiamondId },
        data: {
          status: "DAMAGED_LOST",
          damagedLostAt: new Date(),
          damagedLostByUserId: input.damagedLostByUserId,
          damagedLostReason: resolution.damagedLostReason,
        },
      });
      await tx.stockMovement.create({
        data: {
          type: "JEWELLERY_DAMAGED_LOSS_OUT",
          polishedDiamondId: line.polishedDiamondId,
          jewelleryJobId: job.id,
          pieces: 1,
          carat: line.caratAtIssue,
          costValue: line.costAtIssue,
          sourceDocument: receiptCode,
          createdByUserId: input.createdByUserId,
        },
      });
    }
  }

  // ---- Metal stock movements (return/scrap) — one movement PER LINE,
  // each posted to its own explicit purity identity with its own
  // proportional cost share. Never one lump sum against a guessed
  // "default" purity. Scrap lands in that purity's SCRAP pool, never back
  // in issuable stock (see METAL_POOL_EFFECT). ----
  for (let i = 0; i < resolvedReturnLines.length; i++) {
    const line = resolvedReturnLines[i];
    const costShare = returnedCostAllocation.find((a) => a.key === String(i))?.amount ?? ZERO;
    await tx.metalStockMovement.create({
      data: {
        type: "RETURN_IN",
        metalType: line.metalType,
        purityId: line.purityId,
        grossWeight: line.grossWeight.toFixed(3),
        fineWeight: line.fineWeight.toFixed(3),
        costValue: costShare.toFixed(2),
        sourceDocument: receiptCode,
        jewelleryJobId: job.id,
        createdByUserId: input.createdByUserId,
      },
    });
  }
  for (let i = 0; i < resolvedScrapLines.length; i++) {
    const line = resolvedScrapLines[i];
    const costShare = scrapCostAllocation.find((a) => a.key === String(i))?.amount ?? ZERO;
    await tx.metalStockMovement.create({
      data: {
        type: "SCRAP_RETURN_IN",
        metalType: line.metalType,
        purityId: line.purityId,
        grossWeight: line.grossWeight.toFixed(3),
        fineWeight: line.fineWeight.toFixed(3),
        costValue: costShare.toFixed(2),
        sourceDocument: receiptCode,
        jewelleryJobId: job.id,
        createdByUserId: input.createdByUserId,
      },
    });
  }
  for (let i = 0; i < alloyReturnLines.length; i++) {
    const line = alloyReturnLines[i];
    const costShare = alloyReturnCostAllocation.find((a) => a.key === String(i))?.amount ?? ZERO;
    await tx.metalStockMovement.create({
      data: {
        type: "RETURN_IN",
        metalType: "ALLOY",
        purityId: line.purityId,
        grossWeight: line.grossWeight.toFixed(3),
        fineWeight: "0.000",
        costValue: costShare.toFixed(2),
        sourceDocument: receiptCode,
        jewelleryJobId: job.id,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  // ---- Informational consumed-out movements (job ledger only — they never
  // change a stock pool, see METAL_POOL_EFFECT) for the metal that
  // permanently left the job this receipt. The finished portion is
  // attributed to each output's consumed SOURCE purity — its own purity for
  // a same-purity output, the issued purity (e.g. 24K) for a lower-karat
  // output — never to an unissued purity. Recognized process loss, which
  // has no physical purity of its own, is split across the job's issued
  // fine-bearing purities by their issued fine-weight share. ----
  for (let i = 0; i < resolvedOutputs.length; i++) {
    const o = resolvedOutputs[i];
    if (o.fineWeight.greaterThan(0)) {
      const metalCostShare = metalAllocation.find((a) => a.key === String(i))?.amount ?? ZERO;
      await tx.metalStockMovement.create({
        data: {
          type: "CONSUMED_OUT",
          metalType: metalTypeByPurityId.get(o.sourcePurityId)!,
          purityId: o.sourcePurityId,
          grossWeight: "0.000",
          fineWeight: o.fineWeight.toFixed(3),
          costValue: metalCostShare.toFixed(2),
          sourceDocument: receiptCode,
          jewelleryJobId: job.id,
          createdByUserId: input.createdByUserId,
        },
      });
    }
  }
  if (isFinalMetal && processLossFineWeight.greaterThan(0) && issuedFineWeightByPurityId.size > 0) {
    const lossWeightByPurity = allocateWeightProportionally(
      processLossFineWeight,
      [...issuedFineWeightByPurityId.entries()].map(([purityId, weight]) => ({ key: purityId, weight }))
    );
    const lossCostByPurity =
      lossCost.greaterThan(0)
        ? new Map(
            allocateProportionally(
              lossCost,
              [...issuedFineWeightByPurityId.entries()].map(([purityId, weight]) => ({ key: purityId, weight }))
            ).map((a) => [a.key, a.amount])
          )
        : new Map<string, Decimal>();
    for (const [purityId, lossFineShare] of lossWeightByPurity) {
      if (!lossFineShare.greaterThan(0)) continue;
      await tx.metalStockMovement.create({
        data: {
          type: "CONSUMED_OUT",
          metalType: metalTypeByPurityId.get(purityId)!,
          purityId,
          grossWeight: "0.000",
          fineWeight: lossFineShare.toFixed(3),
          costValue: (lossCostByPurity.get(purityId) ?? ZERO).toFixed(2),
          sourceDocument: receiptCode,
          jewelleryJobId: job.id,
          createdByUserId: input.createdByUserId,
        },
      });
    }
  }
  const alloyConsumedGross = round3(companyAlloyGross.plus(alloyLossGross));
  if (alloyPurityId && alloyConsumedGross.greaterThan(0)) {
    await tx.metalStockMovement.create({
      data: {
        type: "CONSUMED_OUT",
        metalType: "ALLOY",
        purityId: alloyPurityId,
        grossWeight: alloyConsumedGross.toFixed(3),
        fineWeight: "0.000",
        costValue: round2(alloyResolvedCost.minus(alloyReturnedCost)).toFixed(2),
        sourceDocument: receiptCode,
        jewelleryJobId: job.id,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  // ---- Update job cumulative totals + status ----
  const anyUnresolvedDiamonds = await tx.jewelleryDiamondIssueLine.count({
    where: { jobId: job.id, resolvedAs: null },
  });
  const jobComplete = isFinalMetal && anyUnresolvedDiamonds === 0;

  const updatedJob = await tx.jewelleryJob.update({
    where: { id: job.id },
    data: {
      receivedFineWeight: round3(new Decimal(job.receivedFineWeight).plus(thisFinishedFineWeight)).toFixed(3),
      returnedMetalFineWeight: round3(new Decimal(job.returnedMetalFineWeight).plus(returnedFineWeight)).toFixed(3),
      scrapFineWeight: round3(new Decimal(job.scrapFineWeight).plus(scrapFineWeight)).toFixed(3),
      karigarAddedFineWeight: round3(new Decimal(job.karigarAddedFineWeight).plus(karigarAddedFineWeight)).toFixed(3),
      karigarAddedCost: round2(new Decimal(job.karigarAddedCost).plus(karigarAddedCost)).toFixed(2),
      consumedAlloyGrossWeight: round3(new Decimal(job.consumedAlloyGrossWeight).plus(alloyConsumedGross)).toFixed(3),
      returnedAlloyGrossWeight: round3(new Decimal(job.returnedAlloyGrossWeight).plus(alloyReturnedGross)).toFixed(3),
      remainingAlloyWipCost: round2(remainingAlloyCostBefore.minus(alloyResolvedCost)).toFixed(2),
      totalLabourCharge: round2(new Decimal(job.totalLabourCharge).plus(totalCharges)).toFixed(2),
      remainingWipCost: round2(totalCostPool.minus(resolvedCost)).toFixed(2),
      status: jobComplete ? "COMPLETED" : "PARTIALLY_RECEIVED",
    },
  });

  return { receipt, outputs: createdOutputs, job: updatedJob };
}

// ---------------------------------------------------------------------------
// Owner-authorized cost allocation override for a receipt's outputs
// ---------------------------------------------------------------------------

export async function overrideFinishedJewelleryAllocation(
  tx: Tx,
  input: {
    receiptId: string;
    adjustments: { finishedJewelleryId: string; newTotalCost: DecimalInput }[];
    reason: string;
  }
) {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new PostingError("Give a short reason for this cost override.");
  }
  const receipt = await tx.jewelleryReceipt.findUnique({ where: { id: input.receiptId }, include: { outputs: true } });
  if (!receipt) throw new PostingError("Receipt not found.");

  const outputIds = new Set(receipt.outputs.map((o) => o.id));
  for (const adj of input.adjustments) {
    if (!outputIds.has(adj.finishedJewelleryId)) throw new PostingError("One or more outputs do not belong to this receipt.");
  }
  const adjustedIds = new Set(input.adjustments.map((a) => a.finishedJewelleryId));
  if (adjustedIds.size !== receipt.outputs.length || adjustedIds.size !== input.adjustments.length) {
    throw new PostingError("An allocation override must specify every output in the receipt exactly once.");
  }

  const currentTotal = round2(receipt.outputs.reduce((sum, o) => sum.plus(new Decimal(o.totalCost)), ZERO));
  const newTotal = round2(input.adjustments.reduce((sum, a) => sum.plus(round2(a.newTotalCost)), ZERO));
  if (!newTotal.equals(currentTotal)) {
    throw new PostingError(
      `New output costs sum to ${newTotal.toFixed(2)}, which must exactly equal the receipt's total allocated cost ${currentTotal.toFixed(2)}.`
    );
  }

  for (const adj of input.adjustments) {
    const output = receipt.outputs.find((o) => o.id === adj.finishedJewelleryId)!;
    const newTotalCost = round2(adj.newTotalCost);
    // Only the metal-cost share moves with an override (diamond/other/
    // labour shares stay as originally resolved) — simplest, safest
    // adjustment surface for an exceptional correction.
    const delta = newTotalCost.minus(output.totalCost);
    await tx.finishedJewellery.update({
      where: { id: output.id },
      data: {
        metalCost: round2(new Decimal(output.metalCost).plus(delta)).toFixed(2),
        totalCost: newTotalCost.toFixed(2),
      },
    });
  }

  return tx.jewelleryReceipt.update({
    where: { id: receipt.id },
    data: { notes: `${receipt.notes ? receipt.notes + "\n" : ""}[Cost allocation overridden by Owner: ${input.reason}]` },
  });
}
