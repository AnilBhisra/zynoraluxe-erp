import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/db/prisma";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { round3 } from "@/lib/diamond/allocation";
import { PostingError } from "@/lib/accounting/posting";
import { computeCostSheetTotals } from "@/lib/costing/calculations";
import { toTotalsInput } from "@/lib/costing/reports";
import { getAuthoritativeInventoryCost } from "@/lib/jewellery/finishedSalesPosting";

/**
 * Audits Phase 3/4's own posted, allocated figures and reads them as the
 * SINGLE authoritative source for an Actual costing — never independently
 * recomputes a cost Phase 4 already resolved. See the schema.prisma
 * header comment above `model CostSheet` and PHASE_5_VERIFICATION.md's
 * "cost-source mapping" section for the full reasoning; the short version:
 *
 *  - FinishedJewellery.metalCost   already has any NORMAL (non-abnormal)
 *    process loss silently absorbed into it (Phase 4's
 *    receiveFinishedJewellery computes finishedPortionCost as
 *    resolvedCost minus returned/scrap/abnormal-loss cost — never minus
 *    normal loss) — so this is copied as-is, never adjusted for loss again.
 *  - FinishedJewellery.diamondCost is already the exact sum of costAtIssue
 *    for only the diamonds whose JewelleryDiamondIssueLine.resolvedAs is
 *    literally SET into this exact output (never RETURNED/DAMAGED_LOST —
 *    structurally impossible for those to appear here, since only SET
 *    diamonds ever get `setInFinishedJewelleryId` populated).
 *  - FinishedJewellery.otherMaterialCost / .labourAllocated are already
 *    this output's fully-resolved proportional shares (Phase 4 retroactively
 *    corrects these on EVERY output of a job until that job completes —
 *    see the eligibility rule below).
 *  - Returned/scrap metal never appears here at all — it lives only in
 *    MetalStockMovement RETURN_IN/SCRAP_RETURN_IN rows, never in any
 *    FinishedJewellery column.
 *  - Recoverable GST input tax already sits in its own Input CGST/SGST/
 *    IGST ledger accounts (Phase 2/3/4 posting), never inside any of the
 *    Metal/Diamond/WIP/Finished inventory figures this reads from.
 *
 * Eligibility: ONLY a FinishedJewellery whose parent JewelleryJob is
 * COMPLETED may be sourced. Phase 4 keeps recalculating an OPEN job's
 * existing outputs' otherMaterialCost/totalCost every time a later receipt
 * adds a new output (see the "priorOutputs" reallocation in
 * src/lib/jewellery/posting.ts) — sourcing from a still-open job's output
 * would risk snapshotting a number Phase 4 is about to change underneath
 * it. This single rule also naturally rejects a cancelled, still-in-
 * progress, partially-received, or Needs-Correction job's outputs, since
 * none of those statuses is COMPLETED.
 */

type Tx = Prisma.TransactionClient;

export type EligibleFinishedJewelleryOutput = {
  id: string;
  finishedCode: string;
  jobId: string;
  jobCode: string;
  designName: string;
  jewelleryType: string;
  customerName: string | null;
  karigarName: string;
  quantity: number;
  netMetalWeight: Decimal;
  purityDisplayName: string;
  totalCost: Decimal;
  qcStatus: string;
  receiveDate: Date;
};

export async function listEligibleFinishedJewelleryOutputs(
  search?: string
): Promise<EligibleFinishedJewelleryOutput[]> {
  const outputs = await prisma.finishedJewellery.findMany({
    where: {
      job: { status: "COMPLETED" },
      ...(search
        ? {
            OR: [
              { finishedCode: { contains: search, mode: "insensitive" } },
              { job: { jobCode: { contains: search, mode: "insensitive" } } },
              { job: { designName: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    include: {
      job: { include: { customer: true, karigar: true } },
      receipt: true,
      purity: true,
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return outputs.map((o) => ({
    id: o.id,
    finishedCode: o.finishedCode,
    jobId: o.jobId,
    jobCode: o.job.jobCode,
    designName: o.job.designName,
    jewelleryType: o.jewelleryType,
    customerName: o.job.customer?.name ?? null,
    karigarName: o.job.karigar.name,
    quantity: o.quantity,
    netMetalWeight: round3(o.netMetalWeight),
    purityDisplayName: o.purity.displayName,
    totalCost: round2(o.totalCost),
    qcStatus: o.qcStatus,
    receiveDate: o.receipt.receiveDate,
  }));
}

export type ActualSourceSnapshot = {
  jewelleryType: string;
  itemName: string;
  referenceNumber: string | null;
  quantity: number;
  designImageAssetId: string | null;
  sourceJobCode: string;
  sourceReceiptCode: string;
  sourceFinishedCode: string;
  sourceVoucherNumber: string | null;
  metalLine: {
    metalType: string;
    purityId: string;
    purityDisplayNameSnapshot: string;
    finenessPercentSnapshot: Decimal;
    grossWeight: Decimal;
    fineWeight: Decimal;
    amount: Decimal;
  };
  diamondLines: {
    sourcePolishedDiamondId: string;
    polishedCodeSnapshot: string;
    shape: string;
    quantity: number;
    totalCarat: Decimal;
    amount: Decimal;
    notes: string | null;
  }[];
  otherMaterialLine: { description: string; amount: Decimal } | null;
  labourLine: { label: string; amount: Decimal } | null;
};

/**
 * Reads and freezes ONE FinishedJewellery output's full cost breakdown for
 * an Actual costing — either at first creation or via an explicit "Refresh
 * from source" on a still-Draft sheet. Always call inside the same
 * transaction that writes the resulting CostSheet/lines, so the read and
 * the write are consistent with each other.
 */
export async function buildActualSourceSnapshot(tx: Tx, finishedJewelleryId: string): Promise<ActualSourceSnapshot> {
  const output = await tx.finishedJewellery.findUnique({
    where: { id: finishedJewelleryId },
    include: {
      job: true,
      receipt: { include: { postingVoucher: true } },
      purity: true,
      diamonds: { include: { polishedDiamond: true } },
    },
  });
  if (!output) throw new PostingError("Finished jewellery output not found.");
  if (output.job.status !== "COMPLETED") {
    throw new PostingError(
      "This output's job is not Completed yet. Actual costing can only be created once the job is fully finished, since Phase 4 may still retroactively adjust an open job's other-material cost."
    );
  }

  const setDiamonds = output.diamonds.filter((d) => d.resolvedAs === "SET" && d.setInFinishedJewelleryId === output.id);

  return {
    jewelleryType: output.jewelleryType,
    itemName: output.job.designName,
    referenceNumber: output.job.customerReference,
    quantity: output.quantity,
    designImageAssetId: output.photoAssetId ?? output.job.designImageAssetId,
    sourceJobCode: output.job.jobCode,
    sourceReceiptCode: output.receipt.receiptCode,
    sourceFinishedCode: output.finishedCode,
    sourceVoucherNumber: output.receipt.postingVoucher?.voucherNumber ?? null,
    metalLine: {
      metalType: output.metalType,
      purityId: output.purityId,
      purityDisplayNameSnapshot: output.purity.displayName,
      finenessPercentSnapshot: new Decimal(output.finenessPercentSnapshot),
      grossWeight: round3(output.netMetalWeight),
      fineWeight: round3(output.fineMetalWeight),
      amount: round2(output.metalCost),
    },
    diamondLines: setDiamonds.map((d) => ({
      sourcePolishedDiamondId: d.polishedDiamondId,
      polishedCodeSnapshot: d.polishedDiamond.polishedCode,
      shape: d.polishedDiamond.shape,
      quantity: 1,
      totalCarat: round3(d.caratAtIssue),
      amount: round2(d.costAtIssue),
      notes: null,
    })),
    otherMaterialLine: new Decimal(output.otherMaterialCost).greaterThan(0)
      ? { description: `Other material (from job ${output.job.jobCode}, allocated)`, amount: round2(output.otherMaterialCost) }
      : null,
    labourLine: new Decimal(output.labourAllocated).greaterThan(0)
      ? { label: "Karigar labour & manufacturing charges (from job, allocated)", amount: round2(output.labourAllocated) }
      : null,
  };
}

export type SuggestedSalePrice = {
  costSheetId: string;
  costingNumber: string;
  suggestedPrice: Decimal;
};

/**
 * Phase 6 Sale form price suggestion, Owner-only. Reads the MOST RECENT
 * FINALIZED Actual CostSheet linked to this output (if any) and recomputes
 * its customer total live from the sheet's own frozen line items — never
 * mutates the Cost Sheet, never writes anything. This is a suggestion only:
 * the Sale form always requires the Owner/Staff to confirm an actual
 * selling price, and Phase 6 NEVER uses this figure (or any Costing figure)
 * as COGS — COGS is always `getAuthoritativeInventoryCost` in
 * src/lib/jewellery/finishedSalesPosting.ts, a completely separate number.
 */
export async function getSuggestedSalePrice(finishedJewelleryId: string): Promise<SuggestedSalePrice | null> {
  const sheet = await prisma.costSheet.findFirst({
    where: { sourceFinishedJewelleryId: finishedJewelleryId, mode: "ACTUAL", status: "FINALIZED" },
    include: { metalLines: true, diamondLines: true, otherMaterialLines: true, chargeLines: true },
    orderBy: { finalizedAt: "desc" },
  });
  if (!sheet) return null;

  const totals = computeCostSheetTotals(toTotalsInput(sheet));
  return {
    costSheetId: sheet.id,
    costingNumber: sheet.costingNumber,
    suggestedPrice: totals.customerTotal,
  };
}

// ---------------------------------------------------------------------------
// Phase 5 vs Phase 6 comparison — Owner-only (every field here is cost/
// margin/profit data). Read-only: never writes to CostSheet, never uses
// any Phase 5 figure as accounting COGS. See PHASE_6_VERIFICATION.md §4
// for the full design rationale and the live-browser verification.
// ---------------------------------------------------------------------------

export type Phase6RealizedStatus =
  | "NOT_SOLD"
  | "SOLD_ACTIVE"
  | "SALE_CANCELLED"
  | "RETURNED_SELLABLE"
  | "RETURNED_DAMAGED";

export type Phase5VsPhase6Comparison = {
  finishedJewelleryId: string;
  finishedCode: string;
  costSheetId: string;
  costingNumber: string;
  costSheetFinalizedAt: Date | null;

  // ---- Phase 5 (Costing) — read-only, never mutated here ----
  expectedSellingValue: Decimal; // customerTotal
  expectedFullBusinessCost: Decimal; // productionCost — legitimately INCLUDES otherMaterialCost
  expectedProfit: Decimal; // estimatedProfit
  expectedMarginPercent: Decimal;

  // ---- Phase 6 (accounting) — the item's authoritative carrying cost,
  // shown regardless of sale status, since it never changes with a sale ----
  authoritativeAccountingCost: Decimal; // metalCost + diamondCost + labourAllocated
  otherMaterialCostExcluded: Decimal; // exactly why expectedFullBusinessCost > authoritativeAccountingCost

  // ---- Realized outcome — null unless there is an ACTIVE (unreversed) sale ----
  realizedStatus: Phase6RealizedStatus;
  saleCode: string | null;
  realizedNetSellingValue: Decimal | null; // frozen taxableValue — GST and discount already excluded
  realizedCogs: Decimal | null;
  realizedGrossProfit: Decimal | null;
  realizedMarginPercent: Decimal | null;
  profitDifference: Decimal | null; // realizedGrossProfit - expectedProfit

  /** Plain-language explanation of the current state — always populated,
   * covers the not-sold/cancelled/returned-sellable/returned-damaged cases
   * where no realized profit exists to show. */
  note: string;
};

/**
 * Compares a finished piece's Phase 5 (Costing) expectation against its
 * Phase 6 (actual sale) reality — Owner-only, computed on demand, never
 * stored. Returns null when there is no genuinely LINKED, FINALIZED Actual
 * Costing for this exact output (never compares an unrelated Cost Sheet).
 *
 * Looks at the MOST RECENT FinishedJewellerySaleLine for this item (if
 * any) to determine realized status — since an item can only be actively
 * Sold via one unreversed line at a time (claimed atomically, freed again
 * only by a full cancellation or a sellable return), this is always THE
 * one relevant sale for "realized" purposes; older, already-reversed
 * sale/return cycles are implicitly superseded, matching how the item's
 * own `status` column already works.
 */
export async function getPhase5VsPhase6Comparison(
  finishedJewelleryId: string
): Promise<Phase5VsPhase6Comparison | null> {
  const item = await prisma.finishedJewellery.findUnique({
    where: { id: finishedJewelleryId },
    select: { id: true, finishedCode: true, metalCost: true, diamondCost: true, labourAllocated: true, otherMaterialCost: true },
  });
  if (!item) return null;

  const sheet = await prisma.costSheet.findFirst({
    where: { sourceFinishedJewelleryId: finishedJewelleryId, mode: "ACTUAL", status: "FINALIZED" },
    include: { metalLines: true, diamondLines: true, otherMaterialLines: true, chargeLines: true },
    orderBy: { finalizedAt: "desc" },
  });
  if (!sheet) return null; // no genuinely linked, finalized Costing — never compare an unrelated sheet

  const totals = computeCostSheetTotals(toTotalsInput(sheet));
  const authoritativeAccountingCost = getAuthoritativeInventoryCost(item);
  const otherMaterialCostExcluded = round2(new Decimal(item.otherMaterialCost));

  const latestLine = await prisma.finishedJewellerySaleLine.findFirst({
    where: { finishedJewelleryId },
    include: { sale: { select: { saleCode: true, status: true } } },
    orderBy: { createdAt: "desc" },
  });

  let realizedStatus: Phase6RealizedStatus = "NOT_SOLD";
  let saleCode: string | null = null;
  let realizedNetSellingValue: Decimal | null = null;
  let realizedCogs: Decimal | null = null;
  let realizedGrossProfit: Decimal | null = null;
  let realizedMarginPercent: Decimal | null = null;
  let note = "This piece has not been sold yet — no realized figures to compare.";

  if (latestLine) {
    saleCode = latestLine.sale.saleCode;
    if (latestLine.sale.status === "CANCELLED") {
      realizedStatus = "SALE_CANCELLED";
      note = `Sale ${saleCode} was cancelled — revenue and COGS were both fully reversed, so no realized profit applies to it.`;
    } else if (latestLine.returnStatus === "RETURNED_DAMAGED") {
      realizedStatus = "RETURNED_DAMAGED";
      note = `Sold via ${saleCode}, then returned damaged — its cost (₹${authoritativeAccountingCost.toFixed(2)}) was reclassified into Damaged Jewellery Loss, not realized as sale profit.`;
    } else if (latestLine.returnStatus === "RETURNED_SELLABLE") {
      realizedStatus = "RETURNED_SELLABLE";
      note = `Sold via ${saleCode}, then returned sellable — the piece is Available again; that sale's revenue and COGS were both reversed, so no realized profit applies to it.`;
    } else {
      realizedStatus = "SOLD_ACTIVE";
      realizedNetSellingValue = round2(new Decimal(latestLine.taxableValue));
      realizedCogs = round2(new Decimal(latestLine.cogsAmount));
      realizedGrossProfit = round2(realizedNetSellingValue.minus(realizedCogs));
      realizedMarginPercent = realizedNetSellingValue.greaterThan(0)
        ? realizedGrossProfit.dividedBy(realizedNetSellingValue).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
        : ZERO;
      note = `Sold via ${saleCode} — figures below are the ACTUAL sale price (net of discount, GST excluded) and the authoritative accounting COGS, not Phase 5's estimate.`;
    }
  }

  const profitDifference = realizedGrossProfit !== null ? round2(realizedGrossProfit.minus(totals.estimatedProfit)) : null;

  return {
    finishedJewelleryId,
    finishedCode: item.finishedCode,
    costSheetId: sheet.id,
    costingNumber: sheet.costingNumber,
    costSheetFinalizedAt: sheet.finalizedAt,
    expectedSellingValue: totals.customerTotal,
    expectedFullBusinessCost: totals.productionCost,
    expectedProfit: totals.estimatedProfit,
    expectedMarginPercent: totals.profitMarginPercent,
    authoritativeAccountingCost,
    otherMaterialCostExcluded,
    realizedStatus,
    saleCode,
    realizedNetSellingValue,
    realizedCogs,
    realizedGrossProfit,
    realizedMarginPercent,
    profitDifference,
    note,
  };
}
