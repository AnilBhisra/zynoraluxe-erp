import "server-only";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { listEligibleDestinationJobs, listSourcePurityOptions, type SourcePurityOption } from "@/lib/jewellery/metalTransfer";

export type EligibleDestinationJob = { id: string; jobCode: string; designName: string; status: string };

export type MetalTransferRecord = {
  id: string;
  correctionCode: string;
  state: "POSTED" | "REVERSED";
  reason: string;
  postedAt: string | null;
  purityDisplayName: string;
  fineWeight: string;
  grossWeight: string;
  costValue: string;
  otherJobCode: string;
  reversedByCode: string | null;
  /** null when it can be reversed right now; otherwise the plain-language reason it cannot. */
  reverseBlockedReason: string | null;
};

export type MetalTransferPanel = {
  jobId: string;
  jobKarigarId: string;
  sourceOptions: SourcePurityOption[];
  eligibleDestinations: EligibleDestinationJob[];
  transfersOut: MetalTransferRecord[];
  transfersIn: MetalTransferRecord[];
  /** True when this job's status looks inconsistent with its own receipts — offers "Fix job status". */
  statusLooksInconsistent: boolean;
};

async function reverseBlockReason(destinationJobId: string, metalType: string, purityId: string, fineWeight: Decimal, costValue: Decimal): Promise<string | null> {
  const destination = await prisma.jewelleryJob.findUnique({ where: { id: destinationJobId } });
  if (!destination) return "Destination job not found.";
  if (destination.status === "CANCELLED") return `${destination.jobCode} has been cancelled.`;
  const receiptCount = await prisma.jewelleryReceipt.count({ where: { jobId: destination.id } });
  if (receiptCount > 0) return `${destination.jobCode} has already received a receipt since this transfer.`;
  const onward = await prisma.jewelleryMetalTransfer.findFirst({
    where: { sourceJobId: destination.id, metalType: metalType as never, purityId, correction: { state: "POSTED" } },
  });
  if (onward) return `${destination.jobCode} has already transferred this onward (${onward.transferCode}).`;
  if (new Decimal(destination.remainingWipCost).lessThan(costValue) || new Decimal(destination.issuedMetalFineWeight).lessThan(fineWeight)) {
    return `${destination.jobCode}'s metal pool has fallen below the amount transferred.`;
  }
  return null;
}

/**
 * Owner-only data for the "Transfer metal" panel of one job. Never called
 * for Staff: every figure here is cost data.
 */
export async function getMetalTransferPanel(jobId: string): Promise<MetalTransferPanel> {
  const job = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: jobId } });
  const [sourceOptions, eligibleDestinations, transfersOutRaw, transfersInRaw, receiptCount] = await Promise.all([
    listSourcePurityOptions(prisma, jobId),
    listEligibleDestinationJobs(prisma, { sourceJobId: jobId, karigarId: job.karigarId }),
    prisma.jewelleryMetalTransfer.findMany({
      where: { sourceJobId: jobId },
      orderBy: { createdAt: "asc" },
      include: {
        purity: { select: { displayName: true } },
        destinationJob: { select: { jobCode: true } },
        correction: { select: { correctionCode: true, state: true, reason: true, postedAt: true, reversedBy: { select: { correctionCode: true } } } },
      },
    }),
    prisma.jewelleryMetalTransfer.findMany({
      where: { destinationJobId: jobId },
      orderBy: { createdAt: "asc" },
      include: {
        purity: { select: { displayName: true } },
        sourceJob: { select: { jobCode: true } },
        correction: { select: { correctionCode: true, state: true, reason: true, postedAt: true, reversedBy: { select: { correctionCode: true } } } },
      },
    }),
    prisma.jewelleryReceipt.count({ where: { jobId } }),
  ]);

  const toRecord = async (
    t: (typeof transfersOutRaw)[number] | (typeof transfersInRaw)[number],
    otherJobCode: string,
    direction: "out" | "in"
  ): Promise<MetalTransferRecord> => {
    const state = t.correction.state === "POSTED" ? "POSTED" : "REVERSED";
    const blocked =
      state === "POSTED" ? await reverseBlockReason(direction === "out" ? t.destinationJobId : jobId, t.metalType, t.purityId, new Decimal(t.fineWeight), new Decimal(t.costValue)) : null;
    return {
      id: t.correctionId,
      correctionCode: t.correction.correctionCode,
      state,
      reason: t.correction.reason,
      postedAt: t.correction.postedAt?.toISOString() ?? null,
      purityDisplayName: t.purity.displayName,
      fineWeight: new Decimal(t.fineWeight).toFixed(3),
      grossWeight: new Decimal(t.grossWeight).toFixed(3),
      costValue: new Decimal(t.costValue).toFixed(2),
      otherJobCode,
      reversedByCode: t.correction.reversedBy?.correctionCode ?? null,
      reverseBlockedReason: blocked,
    };
  };

  const transfersOut = await Promise.all(transfersOutRaw.map((t) => toRecord(t, t.destinationJob.jobCode, "out")));
  const transfersIn = await Promise.all(transfersInRaw.map((t) => toRecord(t, t.sourceJob.jobCode, "in")));

  return {
    jobId,
    jobKarigarId: job.karigarId,
    sourceOptions,
    eligibleDestinations,
    transfersOut,
    transfersIn,
    statusLooksInconsistent: (job.status === "MATERIALS_ISSUED" || job.status === "IN_PROGRESS") && receiptCount > 0,
  };
}
