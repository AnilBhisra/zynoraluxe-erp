import "server-only";

import { createHmac } from "node:crypto";

import type { MetalType, UserRole } from "@/generated/prisma/enums";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import type { Tx } from "@/lib/corrections/types";
import { round3 } from "@/lib/diamond/allocation";
import { CustodyError, getCustodyBalanceInTx, listCustodyBalancesInTx, planCustodyOperation, postCustodyOperation } from "@/lib/jewellery/karigarCustody";
import { fineWeightThousandths, formatThousandths, toThousandths } from "@/lib/jewellery/metalMath";
import { declareCustodyAware, pendingFineWeightOf, receiveFinishedJewellery } from "@/lib/jewellery/posting";

/**
 * Receipt-time allocation from Karigar metal custody.
 *
 * Gold goes to a Karigar before anyone knows how much each job will use. When
 * finished jewellery comes back, its actual net metal weight and purity say
 * how much fine metal the job consumed. This receives the jewellery and, in
 * the SAME transaction, allocates to the job only the fine metal it still
 * needs from that Karigar's unallocated balance:
 *
 *   needed    = fine in the finished pieces (net metal x their fineness)
 *             + fine returned + fine scrapped (source fineness)
 *             + loss the Owner explicitly records when completing
 *   available = what the job already holds (its own pending fine) + Karigar-added fine
 *   allocate  = max(0, needed - available)   -- never more
 *
 * The allocation is an ordinary custody ALLOCATE entry: no warehouse movement
 * and no voucher (the gold left stock when it was issued to the Karigar), its
 * value moves from the Karigar balance into this job's WIP exactly, and the
 * receipt then carries that WIP into finished stock -- counted once.
 *
 * Nothing is guessed: the job is completed only when the Owner ticks it, and
 * then any metal the receipt does not explain must be recorded explicitly as
 * loss (or returned / released first). The Karigar's remaining unallocated
 * gold is never touched by completing a job.
 */

export type ReceiptInput = Parameters<typeof receiveFinishedJewellery>[1];

export type ReceiptCustodyPlanInput = {
  jobId: string;
  sourcePurityId: string;
  receiveDate: Date;
  outputs: { netMetalWeight: DecimalInput; metalType: MetalType; purityId: string }[];
  returnedMetalLines: { purityId: string; grossWeight: DecimalInput }[];
  scrapMetalLines: { purityId: string; grossWeight: DecimalInput }[];
  karigarAddedFineWeight: DecimalInput;
  /** Fine grams the Owner records as lost in making. Only with markJobComplete. */
  explicitLossFineWeight?: DecimalInput | null;
  markJobComplete: boolean;
};

export type ReceiptCustodyPlan = {
  jobId: string;
  jobCode: string;
  karigarId: string;
  karigarName: string;
  source: { metalType: MetalType; purityId: string; displayName: string; finenessPercent: Decimal };
  outputs: { netWeight: Decimal; purityDisplayName: string; finenessPercent: Decimal; fineWeight: Decimal }[];
  outputFine: Decimal;
  returnedFine: Decimal;
  scrapFine: Decimal;
  explicitLossFine: Decimal;
  neededFine: Decimal;
  jobPendingFine: Decimal;
  karigarAddedFine: Decimal;
  allocation: { fineWeight: Decimal; grossWeight: Decimal; costValue: Decimal; isWholeBalance: boolean } | null;
  custodyBefore: { gross: Decimal; fine: Decimal; cost: Decimal };
  custodyAfter: { gross: Decimal; fine: Decimal; cost: Decimal };
  jobPendingAfterReceipt: Decimal;
  completesJob: boolean;
};

const d3 = (v: DecimalInput | null | undefined) => round3(v === null || v === undefined || String(v).trim() === "" ? 0 : v);
/** Fine grams of `gross` at `fineness`, with the exact half-up rule every receipt uses. */
const fineOf = (gross: DecimalInput, fineness: DecimalInput) =>
  new Decimal(formatThousandths(fineWeightThousandths(toThousandths(new Decimal(gross).toFixed(3)), toThousandths(new Decimal(fineness).toFixed(3)))));

export type ReceiptCustodySource = {
  purityId: string;
  metalType: MetalType;
  displayName: string;
  finenessPercent: string;
  unallocatedGross: string;
  unallocatedFine: string;
};

/**
 * The Karigar's unallocated pools a receipt on this job may draw from: all of
 * them for a job holding no fine metal yet, otherwise only the one with the
 * same purity and saved fineness as the job's metal (none if the job already
 * mixes pools). Weights only -- no cost, rate or value -- so Owner and Staff
 * receipt forms both get it.
 */
export async function listReceiptCustodySources(tx: Tx, jobId: string): Promise<ReceiptCustodySource[]> {
  const job = await tx.jewelleryJob.findUnique({ where: { id: jobId }, select: { karigarId: true, status: true } });
  if (!job || job.status === "COMPLETED" || job.status === "CANCELLED") return [];
  const lines = await tx.jewelleryMetalIssueLine.findMany({ where: { jobId, metalType: { not: "ALLOY" } } });
  const jobKeys = new Set(lines.map((l) => `${l.purityId}|${new Decimal(l.finenessPercentSnapshot).toFixed(3)}`));
  if (jobKeys.size > 1) return [];
  const balances = (await listCustodyBalancesInTx(tx, job.karigarId)).filter(
    (b) => b.metalType !== "ALLOY" && b.fineWeight.gt(0) && b.finenessPercentSnapshot && (jobKeys.size === 0 || jobKeys.has(`${b.purityId}|${b.finenessPercentSnapshot.toFixed(3)}`))
  );
  if (balances.length === 0) return [];
  const purities = await tx.metalPurity.findMany({ where: { id: { in: balances.map((b) => b.purityId) } } });
  return balances
    .map((b) => ({
      purityId: b.purityId,
      metalType: b.metalType,
      displayName: purities.find((p) => p.id === b.purityId)?.displayName ?? "",
      finenessPercent: b.finenessPercentSnapshot!.toFixed(3),
      unallocatedGross: b.grossWeight.toFixed(3),
      unallocatedFine: b.fineWeight.toFixed(3),
    }))
    .sort((a, b) => Number(b.finenessPercent) - Number(a.finenessPercent));
}

export async function planReceiptCustody(tx: Tx, input: ReceiptCustodyPlanInput): Promise<ReceiptCustodyPlan> {
  const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, include: { karigar: true } });
  if (!job) throw new CustodyError("Job not found.");
  if (job.status === "COMPLETED" || job.status === "CANCELLED") throw new CustodyError(`${job.jobCode} is ${job.status.toLowerCase()}.`);
  const sourcePurity = await tx.metalPurity.findUnique({ where: { id: input.sourcePurityId } });
  if (!sourcePurity || sourcePurity.metalType === "ALLOY") throw new CustodyError("Choose the Karigar metal the jewellery was made from.");

  // The Karigar's balance of that purity, and the job's own fine metal: they
  // must be the SAME pool (metal, purity and saved fineness), never mixed.
  const custody = await getCustodyBalanceInTx(tx, job.karigarId, sourcePurity.metalType, sourcePurity.id);
  const lines = await tx.jewelleryMetalIssueLine.findMany({ where: { jobId: job.id, metalType: { not: "ALLOY" } } });
  const jobKeys = new Set(lines.map((l) => `${l.purityId}|${new Decimal(l.finenessPercentSnapshot).toFixed(3)}`));
  if (jobKeys.size > 1) throw new CustodyError(`${job.jobCode} already holds more than one metal/purity, so the source of this jewellery is ambiguous.`);
  const jobLine = lines[0];
  if (jobLine && jobLine.purityId !== sourcePurity.id) {
    throw new CustodyError(`${job.jobCode} holds a different purity than the Karigar metal chosen — choose the purity the job already holds.`);
  }
  const fineness = jobLine ? new Decimal(jobLine.finenessPercentSnapshot) : custody.finenessPercentSnapshot;
  if (!fineness) {
    throw new CustodyError(`${job.karigar.name} holds no unallocated ${sourcePurity.displayName}, and ${job.jobCode} has none of its own. Issue it to the Karigar in Karigar Metal first.`);
  }
  if (custody.finenessPercentSnapshot && !custody.finenessPercentSnapshot.equals(fineness)) {
    throw new CustodyError(
      `${job.jobCode}'s ${sourcePurity.displayName} was recorded at ${fineness.toFixed(3)}% but ${job.karigar.name}'s unallocated balance at ${custody.finenessPercentSnapshot.toFixed(3)}% — the two cannot be combined.`
    );
  }

  // Fine metal in each finished piece, from its ACTUAL net metal weight and
  // its own purity (stones are not metal: net weight already excludes them).
  const purityIds = [...new Set(input.outputs.map((o) => o.purityId))];
  const purities = purityIds.length ? await tx.metalPurity.findMany({ where: { id: { in: purityIds } } }) : [];
  const outputs = input.outputs.map((o) => {
    const p = purities.find((x) => x.id === o.purityId);
    if (!p || p.metalType !== o.metalType) throw new CustodyError("A finished piece's metal type does not match its purity.");
    if (p.metalType !== sourcePurity.metalType) {
      throw new CustodyError(`A ${p.metalType.toLowerCase()} piece cannot be made from ${sourcePurity.metalType.toLowerCase()} Karigar metal.`);
    }
    const net = d3(o.netMetalWeight);
    if (!net.greaterThan(0)) throw new CustodyError("Each finished piece needs a net metal weight above zero.");
    const pieceFineness = p.id === sourcePurity.id ? fineness : new Decimal(p.finenessPercent);
    if (pieceFineness.greaterThan(fineness)) {
      throw new CustodyError(`${p.displayName} (${pieceFineness.toFixed(3)}%) is finer than the source metal (${fineness.toFixed(3)}%).`);
    }
    return { netWeight: net, purityDisplayName: p.displayName, finenessPercent: pieceFineness, fineWeight: fineOf(net, pieceFineness) };
  });
  const lineFine = (lineSet: { purityId: string; grossWeight: DecimalInput }[], label: string) =>
    lineSet.reduce((sum, l) => {
      if (l.purityId !== sourcePurity.id) throw new CustodyError(`${label} lines must be in the source metal, ${sourcePurity.displayName}.`);
      return sum.plus(fineOf(d3(l.grossWeight), fineness));
    }, ZERO);

  const outputFine = round3(outputs.reduce((s, o) => s.plus(o.fineWeight), ZERO));
  const returnedFine = round3(lineFine(input.returnedMetalLines, "Returned-metal"));
  const scrapFine = round3(lineFine(input.scrapMetalLines, "Scrap"));
  const explicitLossFine = d3(input.explicitLossFineWeight);
  if (explicitLossFine.isNegative()) throw new CustodyError("Loss cannot be negative.");
  if (explicitLossFine.greaterThan(0) && !input.markJobComplete) {
    throw new CustodyError("A making loss is recorded only when completing the job — tick “Mark job complete”, or leave loss at 0.");
  }
  const neededFine = round3(outputFine.plus(returnedFine).plus(scrapFine).plus(explicitLossFine));
  if (!neededFine.greaterThan(0)) throw new CustodyError("Enter the finished pieces (or returned / scrap metal) first.");

  const jobPendingFine = pendingFineWeightOf(job);
  const karigarAddedFine = d3(input.karigarAddedFineWeight);
  const available = round3(jobPendingFine.plus(karigarAddedFine));
  const shortfall = neededFine.greaterThan(available) ? round3(neededFine.minus(available)) : ZERO;

  let allocation: ReceiptCustodyPlan["allocation"] = null;
  if (shortfall.greaterThan(0)) {
    if (shortfall.greaterThan(custody.fineWeight)) {
      throw new CustodyError(
        `This receipt needs ${shortfall.toFixed(3)} g fine more than ${job.jobCode} holds, but ${job.karigar.name} has only ${custody.fineWeight.toFixed(3)} g fine of ${sourcePurity.displayName} unallocated.`
      );
    }
    // Exactly what a manual allocation of the same fine weight would do.
    const whole = shortfall.equals(custody.fineWeight);
    const alloc = await planCustodyOperation(tx, {
      kind: "ALLOCATE_TO_JOB",
      karigarId: job.karigarId,
      purityId: sourcePurity.id,
      jobId: job.id,
      fineWeight: whole ? null : shortfall.toFixed(3),
      all: whole,
      entryDate: input.receiveDate,
      reason: `Receipt-time allocation for ${job.jobCode}`,
    });
    allocation = { fineWeight: alloc.fineWeight, grossWeight: alloc.grossWeight, costValue: alloc.costValue, isWholeBalance: alloc.isFull };
  }

  // What stays pending on the job after this receipt. When completing, it
  // must be exactly the loss the Owner recorded -- never an inferred one.
  const leftOnJob = round3(available.plus(allocation?.fineWeight ?? ZERO).minus(outputFine).minus(returnedFine).minus(scrapFine));
  if (input.markJobComplete && !leftOnJob.equals(explicitLossFine)) {
    throw new CustodyError(
      `Completing ${job.jobCode} would leave ${leftOnJob.minus(explicitLossFine).toFixed(3)} g fine unexplained on the job. Record it as returned metal or scrap, enter it as loss, or release it to ${job.karigar.name}'s balance first.`
    );
  }

  const takes = allocation ?? { fineWeight: ZERO, grossWeight: ZERO, costValue: ZERO };
  return {
    jobId: job.id,
    jobCode: job.jobCode,
    karigarId: job.karigarId,
    karigarName: job.karigar.name,
    source: { metalType: sourcePurity.metalType, purityId: sourcePurity.id, displayName: sourcePurity.displayName, finenessPercent: fineness },
    outputs,
    outputFine,
    returnedFine,
    scrapFine,
    explicitLossFine,
    neededFine,
    jobPendingFine,
    karigarAddedFine,
    allocation,
    custodyBefore: { gross: custody.grossWeight, fine: custody.fineWeight, cost: custody.costValue },
    custodyAfter: {
      gross: round3(custody.grossWeight.minus(takes.grossWeight)),
      fine: round3(custody.fineWeight.minus(takes.fineWeight)),
      cost: round2(custody.costValue.minus(takes.costValue)),
    },
    jobPendingAfterReceipt: input.markJobComplete ? ZERO : leftOnJob,
    completesJob: input.markJobComplete,
  };
}

/**
 * Every figure behind the preview -- weights AND the Karigar balance's value --
 * so a change in any refuses the post. It is returned to the browser, and
 * Staff see it too, so it is an opaque keyed hash (HMAC with the server's
 * SESSION_SECRET): it reveals no weight, cost or rate, and cannot be guessed
 * back from candidate values without the secret.
 */
export function receiptCustodyFingerprint(plan: ReceiptCustodyPlan): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set. Copy .env.example to .env and generate one with `openssl rand -base64 32`.");
  const figures = JSON.stringify({
    jobId: plan.jobId,
    source: plan.source.purityId,
    fineness: plan.source.finenessPercent.toFixed(3),
    needed: plan.neededFine.toFixed(3),
    jobPending: plan.jobPendingFine.toFixed(3),
    alloc: plan.allocation ? [plan.allocation.fineWeight.toFixed(3), plan.allocation.grossWeight.toFixed(3), plan.allocation.costValue.toFixed(2)] : null,
    custody: [plan.custodyBefore.gross.toFixed(3), plan.custodyBefore.fine.toFixed(3), plan.custodyBefore.cost.toFixed(2)],
    complete: plan.completesJob,
  });
  return createHmac("sha256", secret).update(`receipt-custody-preview:${figures}`).digest("hex");
}

/**
 * What the receipt form shows. Weights for everyone; the three rupee figures
 * only when `showCost` (the Owner). For Staff they are null in the response
 * itself -- never sent, not merely hidden.
 */
export type ReceiptCustodyPreview = {
  jobCode: string;
  karigarName: string;
  sourceLabel: string;
  sourceFineness: string;
  outputs: { netWeight: string; purityDisplayName: string; finenessPercent: string; fineWeight: string }[];
  outputFine: string;
  returnedFine: string;
  scrapFine: string;
  explicitLossFine: string;
  neededFine: string;
  jobPendingFine: string;
  allocation: { fineWeight: string; grossWeight: string; costValue: string | null } | null;
  custodyBefore: { gross: string; fine: string; cost: string | null };
  custodyAfter: { gross: string; fine: string; cost: string | null };
  jobPendingAfterReceipt: string;
  completesJob: boolean;
  fingerprint: string;
};

export function toReceiptCustodyPreview(plan: ReceiptCustodyPlan, showCost: boolean): ReceiptCustodyPreview {
  const money = (v: Decimal) => (showCost ? v.toFixed(2) : null);
  const balance = (p: ReceiptCustodyPlan["custodyBefore"]) => ({ gross: p.gross.toFixed(3), fine: p.fine.toFixed(3), cost: money(p.cost) });
  return {
    jobCode: plan.jobCode,
    karigarName: plan.karigarName,
    sourceLabel: `${plan.source.metalType} ${plan.source.displayName}`,
    sourceFineness: plan.source.finenessPercent.toFixed(3),
    outputs: plan.outputs.map((o) => ({
      netWeight: o.netWeight.toFixed(3),
      purityDisplayName: o.purityDisplayName,
      finenessPercent: o.finenessPercent.toFixed(3),
      fineWeight: o.fineWeight.toFixed(3),
    })),
    outputFine: plan.outputFine.toFixed(3),
    returnedFine: plan.returnedFine.toFixed(3),
    scrapFine: plan.scrapFine.toFixed(3),
    explicitLossFine: plan.explicitLossFine.toFixed(3),
    neededFine: plan.neededFine.toFixed(3),
    jobPendingFine: plan.jobPendingFine.toFixed(3),
    allocation: plan.allocation
      ? { fineWeight: plan.allocation.fineWeight.toFixed(3), grossWeight: plan.allocation.grossWeight.toFixed(3), costValue: money(plan.allocation.costValue) }
      : null,
    custodyBefore: balance(plan.custodyBefore),
    custodyAfter: balance(plan.custodyAfter),
    jobPendingAfterReceipt: plan.jobPendingAfterReceipt.toFixed(3),
    completesJob: plan.completesJob,
    fingerprint: receiptCustodyFingerprint(plan),
  };
}

/**
 * Last line of defence for Staff-facing messages on this path: the messages
 * here carry weights only, but a message that ever mentions money (a rupee
 * figure, rate or value) is replaced rather than shown to Staff.
 */
export function staffSafeMessage(message: string, isOwner: boolean): string {
  if (isOwner) return message;
  return /₹|\bRs\.?\s*\d|\brate\b|\bcost\b|\bvalue\b|\bamount\b/i.test(message)
    ? "This receipt cannot be saved as entered. Ask the Owner to check it."
    : message;
}

export type ReceiveWithCustodyInput = ReceiptInput & {
  sourcePurityId: string;
  explicitLossFineWeight?: DecimalInput | null;
  expectedFingerprint?: string | null;
  idempotencyKey: string;
  /** Who is receiving (Owner or Staff); recorded on the allocation and the receipt. */
  actor: { id: string; role: UserRole };
};

/**
 * Receives finished jewellery and allocates the shortfall from the Karigar's
 * custody in ONE transaction: under the purity -> Karigar -> job locks, the
 * plan is rebuilt and compared with the preview, the allocation is posted,
 * then the receipt. Any failure rolls back both. A repeated submission key
 * returns the first receipt without posting anything.
 */
export async function receiveWithCustodyAllocation(tx: Tx, input: ReceiveWithCustodyInput) {
  // Owner or Staff may receive against the job's OWN Karigar's balance; the
  // receipt's createdByUserId and the allocation's createdByUserId are both
  // this actor. General custody operations remain Owner-only.
  if (input.actor.role !== "OWNER" && input.actor.role !== "STAFF") throw new CustodyError("You are not allowed to receive finished jewellery.");
  if (input.createdByUserId !== input.actor.id) throw new CustodyError("Internal check failed: the receipt and the allocation must record the same person.");
  if (!input.idempotencyKey?.trim()) throw new CustodyError("Missing submission key — reload the page and try again.");

  const jobForLock = await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, select: { karigarId: true } });
  if (!jobForLock) throw new CustodyError("Job not found.");
  await tx.$queryRawUnsafe(`SELECT id FROM "metal_purities" WHERE id = $1 FOR UPDATE`, input.sourcePurityId);
  await tx.$queryRawUnsafe(`SELECT id FROM "parties" WHERE id = $1 FOR UPDATE`, jobForLock.karigarId);
  await tx.$queryRawUnsafe(`SELECT id FROM "jewellery_jobs" WHERE id = $1 FOR UPDATE`, input.jobId);
  await declareCustodyAware(tx);

  const already = await tx.jewelleryReceipt.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (already) {
    if (already.jobId !== input.jobId) throw new CustodyError("This submission key was already used for a different receipt.");
    return { replayed: true as const, receipt: already, allocationEntry: null, plan: null };
  }

  const plan = await planReceiptCustody(tx, {
    jobId: input.jobId,
    sourcePurityId: input.sourcePurityId,
    receiveDate: input.receiveDate,
    outputs: input.outputs,
    returnedMetalLines: input.returnedMetalLines,
    scrapMetalLines: input.scrapMetalLines,
    karigarAddedFineWeight: input.karigarAddedFineWeight,
    explicitLossFineWeight: input.explicitLossFineWeight,
    markJobComplete: input.markJobComplete,
  });
  if (input.expectedFingerprint && input.expectedFingerprint !== receiptCustodyFingerprint(plan)) {
    throw new CustodyError("The job or the Karigar's balance changed after this preview was shown. Preview again and confirm.");
  }

  let allocationEntry = null;
  if (plan.allocation) {
    const posted = await postCustodyOperation(tx, {
      kind: "ALLOCATE_TO_JOB",
      karigarId: plan.karigarId,
      purityId: plan.source.purityId,
      jobId: plan.jobId,
      fineWeight: plan.allocation.isWholeBalance ? null : plan.allocation.fineWeight.toFixed(3),
      all: plan.allocation.isWholeBalance,
      entryDate: input.receiveDate,
      reason: `Receipt-time allocation for ${plan.jobCode}`,
      idempotencyKey: `${input.idempotencyKey}:allocation`,
      owner: input.actor,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
    }, { forReceiptOfJob: plan.jobId });
    allocationEntry = posted.entry;
    if (!new Decimal(posted.entry.fineWeight).equals(plan.allocation.fineWeight) || !new Decimal(posted.entry.costValue).equals(plan.allocation.costValue)) {
      throw new CustodyError("Internal check failed: the allocation differs from the preview. Nothing was saved.");
    }
  }

  const result = await receiveFinishedJewellery(tx, {
    ...input,
    // The completion rule is the Owner's tick, never "pending reached zero".
    autoCompleteWhenSettled: false,
  });

  if (allocationEntry) {
    await tx.karigarMetalCustodyEntry.update({ where: { id: allocationEntry.id }, data: { reference: result.receipt.receiptCode } });
  }

  // Proven, not assumed: what is left on the job and with the Karigar.
  const jobAfter = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: plan.jobId } });
  const expectedLeft = plan.completesJob ? plan.explicitLossFine : plan.jobPendingAfterReceipt;
  const custodyAfter = await getCustodyBalanceInTx(tx, plan.karigarId, plan.source.metalType, plan.source.purityId);
  if (
    !pendingFineWeightOf(jobAfter).equals(expectedLeft) ||
    !custodyAfter.fineWeight.equals(plan.custodyAfter.fine) ||
    !custodyAfter.costValue.equals(plan.custodyAfter.cost) ||
    (plan.completesJob && Number(result.receipt.processLossFineWeight) !== Number(plan.explicitLossFine))
  ) {
    throw new CustodyError("Internal balance check failed: nothing was saved.");
  }
  return { replayed: false as const, receipt: result.receipt, outputs: result.outputs, job: result.job, allocationEntry, plan };
}
