import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  FinishedJewelleryReturnDisposition,
  FinishedJewelleryStockMovementType,
  GstTreatment,
  TaxType,
} from "@/generated/prisma/enums";

import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { splitGstAmount } from "@/lib/accounting/gst";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import {
  computeLineTotalsForAll,
  createVoucherHeader,
  insertBalancedJournalLines,
  postSale,
  cancelVoucher,
  PostingError,
  type CommonVoucherInput,
  type InvoiceLineInput,
  type JournalLineInput,
} from "@/lib/accounting/posting";
import { nextJewelleryCode } from "@/lib/jewellery/numbering";

type Tx = Prisma.TransactionClient;
type FyInput = { fyStartMonth: number; fyStartDay: number };

/**
 * The ONE authoritative definition of a FinishedJewellery output's real
 * accounting inventory carrying cost, used EVERYWHERE in this file —
 * never `output.totalCost` (which wrongly includes display-only
 * `otherMaterialCost`, never posted to any account — see the header
 * comment on `model FinishedJewellery` in schema.prisma and
 * PHASE_6_VERIFICATION.md §1 for the full audit trail proving this).
 */
export function getAuthoritativeInventoryCost(output: {
  metalCost: DecimalInput;
  diamondCost: DecimalInput;
  labourAllocated: DecimalInput;
}): Decimal {
  return round2(
    new Decimal(output.metalCost).plus(output.diamondCost).plus(output.labourAllocated)
  );
}

// ---------------------------------------------------------------------------
// Availability-delta reconciliation — the runtime code path NEVER sums this
// (FinishedJewellery.status is the single fast, concurrency-safe source of
// truth for whether an item is Available — see the conditional `updateMany`
// pattern used everywhere below). This map exists purely so the immutable
// FinishedJewelleryStockMovement LEDGER can be independently reconciled
// against `status` for audit purposes, and so a future report/dashboard
// that naively sums "_IN adds one, _OUT removes one" (a reasonable reading
// of the type names) gets the CORRECT answer rather than double-subtracting.
//
// The one deliberately non-obvious entry is RETURNED_DAMAGED_OUT: despite
// the "_OUT" suffix, its availability delta is ZERO, not -1. By the time a
// damaged return posts, the item already left the Available pool via its
// own earlier SOLD_OUT movement (delta -1, already applied once). A damaged
// return does not remove the item from stock a second time — it only
// reclassifies an already-unavailable item's terminal status from "Sold"
// to "Returned-Damaged" (and reclassifies its cost from COGS into Damaged
// Jewellery Loss, a purely financial entry — see returnFinishedJewelleryItems
// below). Kept as its existing, established name rather than renamed
// (renaming an already-applied enum value on the live database is its own
// migration risk) — this map and comment are the documentation the name by
// itself doesn't provide. See PHASE_6_VERIFICATION.md §6 for the full
// lifecycle-by-lifecycle proof that summing these deltas across every real
// movement path always equals 0 or 1, never negative, never above 1, for
// any single unique FinishedJewellery item.
export const AVAILABILITY_DELTA: Record<FinishedJewelleryStockMovementType, number> = {
  PRODUCED_IN: 1,
  SOLD_OUT: -1,
  SALE_CANCELLED_IN: 1,
  RETURNED_SELLABLE_IN: 1,
  RETURNED_DAMAGED_OUT: 0,
  OWNER_ADJUSTMENT_IN: 1,
  OWNER_ADJUSTMENT_OUT: -1,
};

/**
 * Sums AVAILABILITY_DELTA across one item's full movement history (ordered
 * oldest-first) and returns both the final total and the running total
 * after every single movement — a reconciliation proof, never used by any
 * real posting path (which always trusts `status` directly).
 */
export function reconcileAvailabilityLedger(
  movementsOldestFirst: { type: FinishedJewelleryStockMovementType }[]
): { finalTotal: number; runningTotals: number[] } {
  let total = 0;
  const runningTotals: number[] = [];
  for (const m of movementsOldestFirst) {
    total += AVAILABILITY_DELTA[m.type];
    runningTotals.push(total);
  }
  return { finalTotal: total, runningTotals };
}

// ---------------------------------------------------------------------------
// Sale
// ---------------------------------------------------------------------------

export type FinishedSaleItemInput = {
  finishedJewelleryId: string;
  sellingPrice: DecimalInput;
  discountShare?: DecimalInput;
  gstRateId?: string | null;
  gstRatePercent: DecimalInput;
  taxType: TaxType;
};

export async function postFinishedJewellerySale(
  tx: Tx,
  input: CommonVoucherInput &
    FyInput & {
      customerId: string;
      saleDate: Date;
      gstTreatment: GstTreatment;
      paymentAccountId?: string | null;
      items: FinishedSaleItemInput[];
    }
) {
  if (input.items.length === 0) {
    throw new PostingError("Select at least one finished piece to sell.");
  }
  const uniqueIds = new Set(input.items.map((i) => i.finishedJewelleryId));
  if (uniqueIds.size !== input.items.length) {
    throw new PostingError("The same finished piece was selected more than once.");
  }

  // ---- Claim every item FIRST, atomically, one conditional UPDATE per
  // item — this is the database-enforced invariant that makes a double
  // sale (two concurrent requests, or a browser double-click) impossible:
  // whichever transaction's UPDATE actually flips AVAILABLE -> SOLD wins;
  // any other transaction's own UPDATE (or this same one, if the row was
  // already claimed a moment earlier by someone else) affects zero rows,
  // and the whole transaction throws and rolls back — including any
  // OTHER items in this same multi-item sale that WERE just claimed a
  // statement ago. No partial sale is possible. ----
  const claimedOutputs = [];
  for (const item of input.items) {
    const claim = await tx.finishedJewellery.updateMany({
      where: { id: item.finishedJewelleryId, status: "AVAILABLE" },
      data: { status: "SOLD" },
    });
    if (claim.count !== 1) {
      throw new PostingError(
        "One or more selected pieces are no longer available — someone may have just sold, returned, or adjusted it. Refresh and try again."
      );
    }
    const output = await tx.finishedJewellery.findUnique({
      where: { id: item.finishedJewelleryId },
      include: { job: true, purity: true },
    });
    if (!output) throw new PostingError("Finished piece not found.");
    claimedOutputs.push({ item, output });
  }

  // ---- Build invoice lines (reusing the exact same GST computation as
  // every other Sale in this codebase) + snapshot descriptions ----
  const lines: InvoiceLineInput[] = claimedOutputs.map(({ item, output }) => ({
    description: `${output.finishedCode} — ${output.jewelleryType}${output.description ? ` (${output.description})` : ""}`,
    hsnSac: null,
    quantity: 1,
    unit: "PCS",
    rate: item.sellingPrice,
    discount: item.discountShare ?? 0,
    gstRateId: item.gstRateId ?? null,
    gstRatePercent: item.gstRatePercent,
    taxType: item.taxType,
  }));

  const { computed } = computeLineTotalsForAll(lines);

  const cogsPerItem = claimedOutputs.map(({ output }) => getAuthoritativeInventoryCost(output));
  const cogsTotal = round2(cogsPerItem.reduce((sum, c) => sum.plus(c), ZERO));

  const additionalLines: JournalLineInput[] = [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS,
      debit: cogsTotal,
      description: "Finished jewellery COGS",
    },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY,
      credit: cogsTotal,
      description: "Finished jewellery COGS",
    },
  ];

  const voucher = await postSale(tx, {
    date: input.saleDate,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    currencyCode: input.currencyCode,
    exchangeRate: input.exchangeRate,
    referenceNumber: input.referenceNumber,
    note: input.note,
    idempotencyKey: input.idempotencyKey,
    createdByUserId: input.createdByUserId,
    partyId: input.customerId,
    paymentAccountId: input.paymentAccountId,
    gstTreatment: input.gstTreatment,
    lines,
    additionalLines,
  });

  const saleCode = await nextJewelleryCode(tx, "FINISHED_JEWELLERY_SALE");

  const totalDiscount = round2(
    claimedOutputs.reduce((sum, { item }) => sum.plus(item.discountShare ?? 0), ZERO)
  );
  const taxableTotal = round2(computed.reduce((sum, c) => sum.plus(c.totals.taxableValue), ZERO));
  const taxTotal = round2(computed.reduce((sum, c) => sum.plus(c.totals.taxAmount), ZERO));
  const grandTotal = round2(taxableTotal.plus(taxTotal));

  const sale = await tx.finishedJewellerySale.create({
    data: {
      saleCode,
      customerId: input.customerId,
      saleDate: input.saleDate,
      voucherId: voucher.id,
      gstTreatment: input.gstTreatment,
      subtotal: taxableTotal.plus(totalDiscount).toFixed(2),
      discountTotal: totalDiscount.toFixed(2),
      taxableTotal: taxableTotal.toFixed(2),
      taxTotal: taxTotal.toFixed(2),
      grandTotal: grandTotal.toFixed(2),
      cogsTotal: cogsTotal.toFixed(2),
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  for (let i = 0; i < claimedOutputs.length; i++) {
    const { item, output } = claimedOutputs[i];
    const { totals } = computed[i];
    const cogsAmount = cogsPerItem[i];

    await tx.finishedJewellerySaleLine.create({
      data: {
        saleId: sale.id,
        finishedJewelleryId: output.id,
        itemDescriptionSnapshot: lines[i].description,
        sellingPrice: new Decimal(item.sellingPrice).toFixed(2),
        discountShare: new Decimal(item.discountShare ?? 0).toFixed(2),
        taxableValue: totals.taxableValue.toFixed(2),
        gstRatePercent: new Decimal(item.gstRatePercent).toFixed(2),
        taxAmount: totals.taxAmount.toFixed(2),
        lineTotal: totals.lineTotal.toFixed(2),
        cogsAmount: cogsAmount.toFixed(2),
        sortOrder: i,
      },
    });

    await tx.finishedJewelleryStockMovement.create({
      data: {
        type: "SOLD_OUT",
        finishedJewelleryId: output.id,
        pieces: output.quantity,
        costValue: cogsAmount.toFixed(2),
        finishedCodeSnapshot: output.finishedCode,
        jewelleryTypeSnapshot: output.jewelleryType,
        metalTypeSnapshot: output.metalType,
        purityDisplayNameSnapshot: output.purity.displayName,
        netMetalWeightSnapshot: output.netMetalWeight,
        fineMetalWeightSnapshot: output.fineMetalWeight,
        jobCodeSnapshot: output.job.jobCode,
        saleId: sale.id,
        sourceDocument: saleCode,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  return { sale, voucher };
}

// ---------------------------------------------------------------------------
// Full sale cancellation (Owner-only, enforced by the caller)
// ---------------------------------------------------------------------------

export async function cancelFinishedJewellerySale(
  tx: Tx,
  input: FyInput & {
    saleId: string;
    cancelledByUserId: string;
    cancellationReason: string;
  }
) {
  const sale = await tx.finishedJewellerySale.findUnique({
    where: { id: input.saleId },
    include: { lines: { include: { finishedJewellery: { include: { job: true, purity: true } } } } },
  });
  if (!sale) throw new PostingError("Sale not found.");
  if (sale.status === "CANCELLED") throw new PostingError("This sale has already been cancelled.");
  if (sale.lines.some((l) => l.returnStatus !== "NONE")) {
    throw new PostingError(
      "One or more items from this sale have already been returned — cancel is not safe here. Use item-level return for the remaining pieces instead."
    );
  }

  const reversal = await cancelVoucher(tx, {
    voucherId: sale.voucherId,
    cancelledByUserId: input.cancelledByUserId,
    cancellationReason: input.cancellationReason,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
  });

  for (const line of sale.lines) {
    const claim = await tx.finishedJewellery.updateMany({
      where: { id: line.finishedJewelleryId, status: "SOLD" },
      data: { status: "AVAILABLE" },
    });
    if (claim.count !== 1) {
      throw new PostingError(
        `${line.finishedJewellery.finishedCode} is not in the expected "Sold" state — cannot safely cancel. Contact support before retrying.`
      );
    }
    const originalMovement = await tx.finishedJewelleryStockMovement.findFirst({
      where: { finishedJewelleryId: line.finishedJewelleryId, type: "SOLD_OUT", saleId: sale.id },
      orderBy: { createdAt: "desc" },
    });
    await tx.finishedJewelleryStockMovement.create({
      data: {
        type: "SALE_CANCELLED_IN",
        finishedJewelleryId: line.finishedJewelleryId,
        pieces: 1,
        costValue: line.cogsAmount,
        finishedCodeSnapshot: line.finishedJewellery.finishedCode,
        jewelleryTypeSnapshot: line.finishedJewellery.jewelleryType,
        metalTypeSnapshot: line.finishedJewellery.metalType,
        purityDisplayNameSnapshot: line.finishedJewellery.purity.displayName,
        netMetalWeightSnapshot: line.finishedJewellery.netMetalWeight,
        fineMetalWeightSnapshot: line.finishedJewellery.fineMetalWeight,
        jobCodeSnapshot: line.finishedJewellery.job.jobCode,
        saleId: sale.id,
        reversalOfMovementId: originalMovement?.id ?? null,
        sourceDocument: `Cancel ${sale.saleCode}`,
        createdByUserId: input.cancelledByUserId,
      },
    });
  }

  await tx.finishedJewellerySale.update({
    where: { id: sale.id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledByUserId: input.cancelledByUserId,
      cancellationReason: input.cancellationReason,
      cancellationVoucherId: reversal.id,
    },
  });

  return { sale, reversal };
}

// ---------------------------------------------------------------------------
// Item-level return (Owner-only, enforced by the caller)
// ---------------------------------------------------------------------------

export type ReturnItemInput = {
  saleLineId: string;
  disposition: FinishedJewelleryReturnDisposition;
};

export async function returnFinishedJewelleryItems(
  tx: Tx,
  input: FyInput & {
    saleId: string;
    items: ReturnItemInput[];
    reason: string;
    returnDate: Date;
    createdByUserId: string;
    idempotencyKey?: string | null;
  }
) {
  if (!input.reason || input.reason.trim().length < 3) {
    throw new PostingError("Give a short reason for this return.");
  }
  if (input.items.length === 0) {
    throw new PostingError("Select at least one item to return.");
  }
  const uniqueLineIds = new Set(input.items.map((i) => i.saleLineId));
  if (uniqueLineIds.size !== input.items.length) {
    throw new PostingError("The same sale line was selected more than once.");
  }

  const sale = await tx.finishedJewellerySale.findUnique({ where: { id: input.saleId } });
  if (!sale) throw new PostingError("Sale not found.");
  if (sale.status === "CANCELLED") throw new PostingError("This sale has already been cancelled.");

  const saleLines = await tx.finishedJewellerySaleLine.findMany({
    where: { id: { in: [...uniqueLineIds] }, saleId: sale.id },
    include: { finishedJewellery: { include: { job: true, purity: true } } },
  });
  if (saleLines.length !== uniqueLineIds.size) {
    throw new PostingError("One or more selected lines do not belong to this sale.");
  }
  for (const line of saleLines) {
    if (line.returnStatus !== "NONE") {
      throw new PostingError(`${line.itemDescriptionSnapshot} has already been returned.`);
    }
  }

  const dispositionByLineId = new Map(input.items.map((i) => [i.saleLineId, i.disposition]));

  const returnedTaxable = round2(saleLines.reduce((sum, l) => sum.plus(l.taxableValue), ZERO));
  const returnedTax = round2(saleLines.reduce((sum, l) => sum.plus(l.taxAmount), ZERO));
  const returnedTotal = round2(returnedTaxable.plus(returnedTax));
  const sellableCogs = round2(
    saleLines
      .filter((l) => dispositionByLineId.get(l.id) === "SELLABLE")
      .reduce((sum, l) => sum.plus(l.cogsAmount), ZERO)
  );
  const damagedCogs = round2(
    saleLines
      .filter((l) => dispositionByLineId.get(l.id) === "DAMAGED")
      .reduce((sum, l) => sum.plus(l.cogsAmount), ZERO)
  );

  const { cgst, sgst, igst } = splitGstAmount(returnedTax, sale.gstTreatment);

  const returnCode = await nextJewelleryCode(tx, "FINISHED_JEWELLERY_RETURN");

  const voucher = await createVoucherHeader(
    tx,
    {
      date: input.returnDate,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
      currencyCode: "INR",
      exchangeRate: 1,
      note: `Return ${returnCode} against sale ${sale.saleCode}`,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.createdByUserId,
    },
    "SALE_RETURN",
    { amount: returnedTotal, partyId: sale.customerId }
  );

  const journalLines: JournalLineInput[] = [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.SALES_RETURNS,
      debit: returnedTaxable,
      description: `Return ${returnCode}`,
    },
  ];
  if (cgst.greaterThan(0)) {
    journalLines.push({ accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_CGST, debit: cgst, description: `Return ${returnCode}` });
  }
  if (sgst.greaterThan(0)) {
    journalLines.push({ accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_SGST, debit: sgst, description: `Return ${returnCode}` });
  }
  if (igst.greaterThan(0)) {
    journalLines.push({ accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_IGST, debit: igst, description: `Return ${returnCode}` });
  }
  journalLines.push({
    accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE,
    partyId: sale.customerId,
    credit: returnedTotal,
    description: `Return ${returnCode}`,
  });
  if (sellableCogs.greaterThan(0)) {
    journalLines.push(
      {
        accountCode: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY,
        debit: sellableCogs,
        description: `Return ${returnCode} — sellable`,
      },
      {
        accountCode: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS,
        credit: sellableCogs,
        description: `Return ${returnCode} — sellable`,
      }
    );
  }
  if (damagedCogs.greaterThan(0)) {
    journalLines.push(
      {
        accountCode: SYSTEM_ACCOUNT_CODES.DAMAGED_JEWELLERY_LOSS,
        debit: damagedCogs,
        description: `Return ${returnCode} — damaged`,
      },
      {
        accountCode: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS,
        credit: damagedCogs,
        description: `Return ${returnCode} — damaged`,
      }
    );
  }

  await insertBalancedJournalLines(tx, voucher.id, journalLines);

  const returnRow = await tx.finishedJewelleryReturn.create({
    data: {
      returnCode,
      saleId: sale.id,
      returnDate: input.returnDate,
      voucherId: voucher.id,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  for (const line of saleLines) {
    const disposition = dispositionByLineId.get(line.id)!;

    await tx.finishedJewelleryReturnLine.create({
      data: {
        returnId: returnRow.id,
        saleLineId: line.id,
        disposition,
        reversedTaxableValue: line.taxableValue,
        reversedTaxAmount: line.taxAmount,
        reversedTotal: new Decimal(line.taxableValue).plus(line.taxAmount).toFixed(2),
        reversedCogsAmount: line.cogsAmount,
      },
    });

    await tx.finishedJewellerySaleLine.update({
      where: { id: line.id },
      data: { returnStatus: disposition === "SELLABLE" ? "RETURNED_SELLABLE" : "RETURNED_DAMAGED" },
    });

    if (disposition === "SELLABLE") {
      const claim = await tx.finishedJewellery.updateMany({
        where: { id: line.finishedJewelleryId, status: "SOLD" },
        data: { status: "AVAILABLE" },
      });
      if (claim.count !== 1) {
        throw new PostingError(`${line.finishedJewellery.finishedCode} is not in the expected "Sold" state.`);
      }
      await tx.finishedJewelleryStockMovement.create({
        data: {
          type: "RETURNED_SELLABLE_IN",
          finishedJewelleryId: line.finishedJewelleryId,
          pieces: 1,
          costValue: line.cogsAmount,
          finishedCodeSnapshot: line.finishedJewellery.finishedCode,
          jewelleryTypeSnapshot: line.finishedJewellery.jewelleryType,
          metalTypeSnapshot: line.finishedJewellery.metalType,
          purityDisplayNameSnapshot: line.finishedJewellery.purity.displayName,
          netMetalWeightSnapshot: line.finishedJewellery.netMetalWeight,
          fineMetalWeightSnapshot: line.finishedJewellery.fineMetalWeight,
          jobCodeSnapshot: line.finishedJewellery.job.jobCode,
          returnId: returnRow.id,
          sourceDocument: returnCode,
          createdByUserId: input.createdByUserId,
        },
      });
    } else {
      const claim = await tx.finishedJewellery.updateMany({
        where: { id: line.finishedJewelleryId, status: "SOLD" },
        data: { status: "RETURNED_DAMAGED" },
      });
      if (claim.count !== 1) {
        throw new PostingError(`${line.finishedJewellery.finishedCode} is not in the expected "Sold" state.`);
      }
      await tx.finishedJewelleryStockMovement.create({
        data: {
          type: "RETURNED_DAMAGED_OUT",
          finishedJewelleryId: line.finishedJewelleryId,
          pieces: 1,
          costValue: line.cogsAmount,
          finishedCodeSnapshot: line.finishedJewellery.finishedCode,
          jewelleryTypeSnapshot: line.finishedJewellery.jewelleryType,
          metalTypeSnapshot: line.finishedJewellery.metalType,
          purityDisplayNameSnapshot: line.finishedJewellery.purity.displayName,
          netMetalWeightSnapshot: line.finishedJewellery.netMetalWeight,
          fineMetalWeightSnapshot: line.finishedJewellery.fineMetalWeight,
          jobCodeSnapshot: line.finishedJewellery.job.jobCode,
          returnId: returnRow.id,
          sourceDocument: returnCode,
          createdByUserId: input.createdByUserId,
        },
      });
    }
  }

  return { return: returnRow, voucher };
}

// ---------------------------------------------------------------------------
// Owner-only manual stock adjustment — exceptional, fully audited
// ---------------------------------------------------------------------------

export async function adjustFinishedJewelleryStock(
  tx: Tx,
  input: {
    finishedJewelleryId: string;
    direction: "IN" | "OUT";
    reason: string;
    createdByUserId: string;
  }
) {
  if (!input.reason || input.reason.trim().length < 5) {
    throw new PostingError("Give a specific reason (at least 5 characters) for this manual adjustment.");
  }
  const targetStatus = input.direction === "IN" ? "AVAILABLE" : "SOLD";
  const fromStatus = input.direction === "IN" ? "SOLD" : "AVAILABLE";
  // Deliberately narrow: only ever toggles between AVAILABLE and SOLD —
  // never touches a RETURNED_DAMAGED item, which is a permanent terminal
  // state by design (see FinishedJewelleryStockStatus in schema.prisma).
  const claim = await tx.finishedJewellery.updateMany({
    where: { id: input.finishedJewelleryId, status: fromStatus },
    data: { status: targetStatus },
  });
  if (claim.count !== 1) {
    throw new PostingError(
      `This item is not currently "${fromStatus === "SOLD" ? "Sold" : "Available"}" — cannot apply this adjustment.`
    );
  }
  const output = await tx.finishedJewellery.findUnique({
    where: { id: input.finishedJewelleryId },
    include: { job: true, purity: true },
  });
  if (!output) throw new PostingError("Item not found.");

  const costValue = getAuthoritativeInventoryCost(output);
  await tx.finishedJewelleryStockMovement.create({
    data: {
      type: input.direction === "IN" ? "OWNER_ADJUSTMENT_IN" : "OWNER_ADJUSTMENT_OUT",
      finishedJewelleryId: output.id,
      pieces: 1,
      costValue: costValue.toFixed(2),
      finishedCodeSnapshot: output.finishedCode,
      jewelleryTypeSnapshot: output.jewelleryType,
      metalTypeSnapshot: output.metalType,
      purityDisplayNameSnapshot: output.purity.displayName,
      netMetalWeightSnapshot: output.netMetalWeight,
      fineMetalWeightSnapshot: output.fineMetalWeight,
      jobCodeSnapshot: output.job.jobCode,
      sourceDocument: `Owner adjustment: ${input.reason}`,
      createdByUserId: input.createdByUserId,
    },
  });

  return output;
}
