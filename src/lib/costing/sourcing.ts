import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { prisma } from "@/lib/db/prisma";
import { Decimal, round2 } from "@/lib/accounting/money";
import { round3 } from "@/lib/diamond/allocation";
import { PostingError } from "@/lib/accounting/posting";

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
