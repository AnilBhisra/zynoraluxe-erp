import "server-only";

import type { MetalType } from "@/generated/prisma/enums";
import { Decimal, type DecimalInput, ZERO } from "@/lib/accounting/money";
import type { Tx } from "@/lib/corrections/types";
import { round3 } from "@/lib/diamond/allocation";
import { assertCustomerGoldAllowedOnJob, opaqueFingerprint } from "@/lib/jewellery/customerGold";
import {
  type Actor,
  CustomerGoldError,
  type PoolKey,
  type WeightPair,
  d3,
  fineOf,
  loadPoolInTx,
  lockCustomerGold,
  placeBalance,
  writeCustomerGoldEntry,
} from "@/lib/jewellery/customerGoldLedger";
import { computeOutputMetal, formatThousandths } from "@/lib/jewellery/metalMath";
import { allocateWeightProportionally, declareCustodyAware, pendingFineWeightOf, receiveFinishedJewellery } from "@/lib/jewellery/posting";
import { jobStateOf, type ReceiptReversalSnapshot } from "@/lib/jewellery/customerGoldReceiptReversal";

/**
 * Receiving finished jewellery made from a Customer's own gold
 * (CUSTOMER_GOLD_DESIGN.md §2.3) — the Customer-gold twin of receipt-time
 * Company allocation (receiptCustody.ts):
 *
 *   Customer fine needed = fine in the pieces from Customer gold (net weight ×
 *     final purity) + returned + scrap + explicit authorised loss
 *   used first:          Customer gold already on the job
 *   shortfall from:      the same Customer's gold with the job's Karigar, then
 *                        the same Customer's gold in the safe — never another
 *                        Customer's, never Company stock
 *
 * Allocation, the receipt and every Customer-gold movement post in ONE locked,
 * idempotent transaction after the preview's opaque fingerprint is re-checked.
 * Nothing is inferred: whatever stays on a completed job must be returned,
 * scrapped or recorded as authorised loss (Owner) — the Customer's other gold
 * is never touched by completing a job.
 */

export type ReceiptInput = Parameters<typeof receiveFinishedJewellery>[1];

export type CustomerGoldJobReceiptPart = {
  /** The Customer's pool: purity + its fineness snapshot. The Customer is always the job's Customer. */
  purityId: string;
  finenessPercent: DecimalInput;
  /** Mixed Customer + Company jobs only: how much of the pieces' fine gold is the Customer's. */
  customerFineForOutputs?: DecimalInput | null;
  /** Unused Customer gold the Karigar gave back (gross, at the pool's fineness) — back to the safe. */
  returnGross?: DecimalInput | null;
  /** Customer's scrap (gross, at the pool's fineness) — held for the Customer. */
  scrapGross?: DecimalInput | null;
  /** Authorised process loss of Customer gold (fine). Owner only, with a reason. */
  lossFine?: DecimalInput | null;
  lossReason?: string | null;
};

export type CustomerGoldJobReceiptPlan = {
  jobId: string;
  jobCode: string;
  customerId: string;
  customerName: string;
  karigarId: string;
  karigarName: string;
  pool: PoolKey;
  sourceLabel: string;
  outputs: { netWeight: Decimal; purityDisplayName: string; finenessPercent: Decimal; fineWeight: Decimal; customerFine: Decimal }[];
  outputFine: Decimal;
  customerFineForOutputs: Decimal;
  companyFineForOutputs: Decimal;
  returned: WeightPair;
  scrap: WeightPair;
  lossFine: Decimal;
  neededFine: Decimal;
  onJobBefore: WeightPair;
  fromKarigar: WeightPair;
  fromSafe: WeightPair;
  karigarBefore: WeightPair;
  karigarAfter: WeightPair;
  safeBefore: WeightPair;
  safeAfter: WeightPair;
  onJobAfter: WeightPair;
  completesJob: boolean;
  mixed: boolean;
  /**
   * The Company side of the same receipt, computed with exactly the rules
   * receiveFinishedJewellery posts with. On an ordinary Customer-gold job it is
   * all zero; on a mixed job it proves both sources reconcile separately.
   */
  company: {
    pendingBefore: Decimal;
    karigarAdded: Decimal;
    finishedFine: Decimal;
    returnedFine: Decimal;
    scrapFine: Decimal;
    /** Recognised only when the job is completed; otherwise it stays pending. */
    processLossFine: Decimal;
    pendingAfter: Decimal;
    /** WIP cost this receipt moves for the Company gold (Owner only on screen). */
    costMoved: Decimal;
  };
};

const sub = (a: WeightPair, b: WeightPair): WeightPair => ({ gross: round3(a.gross.minus(b.gross)), fine: round3(a.fine.minus(b.fine)) });
const add = (a: WeightPair, b: WeightPair): WeightPair => ({ gross: round3(a.gross.plus(b.gross)), fine: round3(a.fine.plus(b.fine)) });
const NONE: WeightPair = { gross: ZERO, fine: ZERO };

/** Take `fine` out of a place: the whole gross with the last of its fine, else the fine-weight share of its gross. */
function take(place: WeightPair, fine: Decimal): WeightPair {
  if (!fine.greaterThan(0)) return NONE;
  if (fine.equals(place.fine)) return { gross: place.gross, fine };
  return { gross: place.fine.greaterThan(0) ? round3(place.gross.times(fine).dividedBy(place.fine)) : ZERO, fine };
}

export async function planCustomerGoldJobReceipt(
  tx: Tx,
  input: Pick<ReceiptInput, "jobId" | "outputs" | "karigarAddedFineWeight" | "markJobComplete"> &
    Partial<Pick<ReceiptInput, "returnedMetalLines" | "scrapMetalLines" | "karigarAddedCost">> & { customerGoldSource: CustomerGoldJobReceiptPart }
): Promise<CustomerGoldJobReceiptPlan> {
  const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, include: { customer: true, karigar: true } });
  if (!job) throw new CustomerGoldError("Job not found.");
  if (!job.customerId || !job.customer) throw new CustomerGoldError(`${job.jobCode} has no Customer, so it cannot use Customer gold.`);
  const purity = await tx.metalPurity.findUnique({ where: { id: input.customerGoldSource.purityId } });
  if (!purity || purity.metalType === "ALLOY") throw new CustomerGoldError("Choose the Customer gold the jewellery was made from.");
  const pool: PoolKey = { customerId: job.customerId, metalType: purity.metalType, purityId: purity.id, finenessPercentSnapshot: d3(input.customerGoldSource.finenessPercent) };
  await assertCustomerGoldAllowedOnJob(tx, job.id, pool);
  const fineness = pool.finenessPercentSnapshot;

  // Fine gold in each piece from its ACTUAL net metal weight and final purity.
  const outputPurities = await tx.metalPurity.findMany({ where: { id: { in: [...new Set(input.outputs.map((o) => o.purityId))] } } });
  const outputs = input.outputs.map((o) => {
    const p = outputPurities.find((x) => x.id === o.purityId);
    if (!p || p.metalType !== o.metalType) throw new CustomerGoldError("A finished piece's metal type does not match its purity.");
    if (p.metalType !== pool.metalType) throw new CustomerGoldError(`A ${p.metalType.toLowerCase()} piece cannot be made from the Customer's ${pool.metalType.toLowerCase()}.`);
    const net = d3(o.netMetalWeight);
    if (!net.greaterThan(0)) throw new CustomerGoldError("Each finished piece needs a net metal weight above zero.");
    const pieceFineness = p.id === pool.purityId ? fineness : new Decimal(p.finenessPercent);
    if (pieceFineness.greaterThan(fineness)) throw new CustomerGoldError(`${p.displayName} is finer than the Customer's ${purity.displayName}.`);
    const metal = computeOutputMetal({ netWeight: net.toFixed(3), outputFinenessPercent: pieceFineness.toFixed(3), sourceFinenessPercent: fineness.toFixed(3), samePurity: p.id === pool.purityId });
    return { netWeight: net, purityDisplayName: p.displayName, finenessPercent: pieceFineness, fineWeight: new Decimal(formatThousandths(metal.fine)) };
  });
  const outputFine = round3(outputs.reduce((s, o) => s.plus(o.fineWeight), ZERO));

  // Customer vs Company share of the pieces' fine gold.
  const companyLines = await tx.jewelleryMetalIssueLine.count({ where: { jobId: job.id, metalType: { not: "ALLOY" } } });
  const mixed = companyLines > 0;
  const karigarAdded = d3(input.karigarAddedFineWeight);
  let customerFine: Decimal;
  if (mixed) {
    if (input.customerGoldSource.customerFineForOutputs == null || String(input.customerGoldSource.customerFineForOutputs).trim() === "") {
      throw new CustomerGoldError(`${job.jobCode} holds both Customer and Company gold — enter how much of the finished pieces' fine gold is the Customer's.`);
    }
    customerFine = d3(input.customerGoldSource.customerFineForOutputs);
    if (customerFine.isNegative() || customerFine.greaterThan(outputFine)) throw new CustomerGoldError(`The Customer's share must be between 0 and ${outputFine.toFixed(3)} g fine.`);
  } else {
    // Only Karigar-added metal (Company-paid) can be Company fine on a Customer-gold job.
    customerFine = round3(outputFine.minus(Decimal.min(outputFine, karigarAdded)));
  }
  const companyFine = round3(outputFine.minus(customerFine));
  if (!mixed && companyFine.greaterThan(pendingFineWeightOf(job).plus(karigarAdded))) {
    throw new CustomerGoldError("Internal check failed: Company share exceeds Company metal. Nothing was saved.");
  }
  // Spread the Customer's share over the pieces by their fine weight (exact to the milligram).
  const split = customerFine.equals(outputFine)
    ? new Map(outputs.map((o, i) => [String(i), o.fineWeight]))
    : allocateWeightProportionally(customerFine, outputs.map((o, i) => ({ key: String(i), weight: o.fineWeight })));
  const outputsWithCustomer = outputs.map((o, i) => ({ ...o, customerFine: round3(split.get(String(i)) ?? ZERO) }));

  const returnGross = d3(input.customerGoldSource.returnGross);
  const scrapGross = d3(input.customerGoldSource.scrapGross);
  const lossFine = d3(input.customerGoldSource.lossFine);
  if (returnGross.isNegative() || scrapGross.isNegative() || lossFine.isNegative()) throw new CustomerGoldError("Returned, scrap and loss weights cannot be negative.");
  if (lossFine.greaterThan(0) && (input.customerGoldSource.lossReason?.trim().length ?? 0) < 3) throw new CustomerGoldError("Give the reason for the authorised process loss.");
  const returned: WeightPair = { gross: returnGross, fine: returnGross.greaterThan(0) ? fineOf(returnGross, fineness) : ZERO };
  const scrap: WeightPair = { gross: scrapGross, fine: scrapGross.greaterThan(0) ? fineOf(scrapGross, fineness) : ZERO };
  const neededFine = round3(customerFine.plus(returned.fine).plus(scrap.fine).plus(lossFine));
  if (!neededFine.greaterThan(0)) throw new CustomerGoldError("Enter the finished pieces (or the Customer gold returned / scrapped) first.");

  const balance = await loadPoolInTx(tx, pool);
  const onJobBefore = placeBalance(balance, { location: "JOB", scopeId: job.id });
  const karigarBefore = placeBalance(balance, { location: "KARIGAR", scopeId: job.karigarId });
  const safeBefore = placeBalance(balance, { location: "SAFE", scopeId: null });
  const shortfall = neededFine.greaterThan(onJobBefore.fine) ? round3(neededFine.minus(onJobBefore.fine)) : ZERO;
  const fromKarigarFine = Decimal.min(shortfall, karigarBefore.fine);
  const fromSafeFine = round3(shortfall.minus(fromKarigarFine));
  if (fromSafeFine.greaterThan(safeBefore.fine)) {
    throw new CustomerGoldError(
      `This receipt needs ${shortfall.toFixed(3)} g fine more of ${job.customer.name}'s ${purity.displayName} than ${job.jobCode} holds, but ${job.customer.name} has only ${karigarBefore.fine.toFixed(3)} g fine with ${job.karigar.name} and ${safeBefore.fine.toFixed(3)} g fine in the safe.`
    );
  }
  const fromKarigar = take(karigarBefore, fromKarigarFine);
  const fromSafe = take(safeBefore, fromSafeFine);
  const onJobWithAllocation = add(add(onJobBefore, fromKarigar), fromSafe);
  const leftFine = round3(onJobWithAllocation.fine.minus(neededFine));
  if (input.markJobComplete && !leftFine.isZero()) {
    throw new CustomerGoldError(
      `Completing ${job.jobCode} would leave ${leftFine.toFixed(3)} g fine of ${job.customer.name}'s gold on the job. Return it, record it as scrap, or record it as authorised loss — it is never written off automatically.`
    );
  }
  // The Company side, exactly as receiveFinishedJewellery will post it.
  const issueLines = await tx.jewelleryMetalIssueLine.findMany({ where: { jobId: job.id, metalType: { not: "ALLOY" } } });
  const companyFineOf = (lines: { purityId: string; grossWeight: DecimalInput }[] | undefined) =>
    round3(
      (lines ?? []).reduce((sum, l) => {
        const line = issueLines.find((x) => x.purityId === l.purityId);
        return line ? sum.plus(round3(d3(l.grossWeight).times(line.finenessPercentSnapshot).dividedBy(100))) : sum;
      }, ZERO)
    );
  const companyReturned = companyFineOf(input.returnedMetalLines);
  const companyScrap = companyFineOf(input.scrapMetalLines);
  const companyPendingBefore = pendingFineWeightOf(job);
  const companyAvailable = round3(companyPendingBefore.plus(karigarAdded));
  const companyResolved = round3(companyFine.plus(companyReturned).plus(companyScrap));
  if (companyResolved.greaterThan(companyAvailable)) {
    throw new CustomerGoldError(`The Company share (${companyResolved.toFixed(3)} g fine incl. Company returns/scrap) is more than the ${companyAvailable.toFixed(3)} g fine of Company gold on ${job.jobCode}.`);
  }
  const companyGap = round3(companyAvailable.minus(companyResolved));
  const costPool = new Decimal(job.remainingWipCost).plus(new Decimal(String(input.karigarAddedCost ?? 0)));
  const companyCostMoved = input.markJobComplete
    ? costPool.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    : companyResolved.greaterThan(0)
      ? costPool.times(companyResolved).dividedBy(companyAvailable).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      : ZERO;

  const onJobAfter: WeightPair = leftFine.isZero() ? NONE : { gross: round3(onJobWithAllocation.gross.times(leftFine).dividedBy(onJobWithAllocation.fine)), fine: leftFine };

  return {
    jobId: job.id,
    jobCode: job.jobCode,
    customerId: job.customerId,
    customerName: job.customer.name,
    karigarId: job.karigarId,
    karigarName: job.karigar.name,
    pool,
    sourceLabel: `${purity.metalType} ${purity.displayName}`,
    outputs: outputsWithCustomer,
    outputFine,
    customerFineForOutputs: customerFine,
    companyFineForOutputs: companyFine,
    returned,
    scrap,
    lossFine,
    neededFine,
    onJobBefore,
    fromKarigar,
    fromSafe,
    karigarBefore,
    karigarAfter: sub(karigarBefore, fromKarigar),
    safeBefore,
    safeAfter: sub(safeBefore, fromSafe),
    onJobAfter,
    completesJob: Boolean(input.markJobComplete),
    mixed,
    company: {
      pendingBefore: companyPendingBefore,
      karigarAdded,
      finishedFine: companyFine,
      returnedFine: companyReturned,
      scrapFine: companyScrap,
      processLossFine: input.markJobComplete ? companyGap : ZERO,
      pendingAfter: input.markJobComplete ? ZERO : companyGap,
      costMoved: companyCostMoved,
    },
  };
}

export function customerGoldJobReceiptFingerprint(plan: CustomerGoldJobReceiptPlan): string {
  const w = (p: WeightPair) => [p.gross.toFixed(3), p.fine.toFixed(3)];
  return opaqueFingerprint("customer-gold-job-receipt", {
    job: plan.jobId,
    pool: [plan.pool.customerId, plan.pool.purityId, plan.pool.finenessPercentSnapshot.toFixed(3)],
    outputs: plan.outputs.map((o) => [o.fineWeight.toFixed(3), o.customerFine.toFixed(3)]),
    needed: plan.neededFine.toFixed(3),
    onJob: w(plan.onJobBefore),
    karigar: w(plan.karigarBefore),
    safe: w(plan.safeBefore),
    fromKarigar: w(plan.fromKarigar),
    fromSafe: w(plan.fromSafe),
    complete: plan.completesJob,
    company: [plan.company.pendingBefore.toFixed(3), plan.company.finishedFine.toFixed(3), plan.company.returnedFine.toFixed(3), plan.company.scrapFine.toFixed(3), plan.company.costMoved.toFixed(2)],
  });
}

export type ReceiveWithCustomerGoldInput = ReceiptInput & {
  customerGoldSource: CustomerGoldJobReceiptPart;
  expectedFingerprint?: string | null;
  idempotencyKey: string;
  /** Who is receiving (Owner or Staff); recorded on the receipt and every Customer-gold entry. */
  actor: Actor;
};

export async function receiveWithCustomerGold(tx: Tx, input: ReceiveWithCustomerGoldInput) {
  if (input.actor.role !== "OWNER" && input.actor.role !== "STAFF") throw new CustomerGoldError("You are not allowed to receive finished jewellery.");
  if (input.createdByUserId !== input.actor.id) throw new CustomerGoldError("Internal check failed: the receipt and the Customer gold entries must record the same person.");
  if (input.actor.role !== "OWNER" && (await tx.jewelleryMetalIssueLine.count({ where: { jobId: input.jobId, metalType: { not: "ALLOY" } } })) > 0) {
    throw new CustomerGoldError("This job holds both Customer and Company gold. Only the Owner can record a mixed receipt and decide the Customer's share.");
  }
  if (d3(input.customerGoldSource.lossFine).greaterThan(0) && input.actor.role !== "OWNER") {
    throw new CustomerGoldError("Only the Owner can record authorised process loss of a Customer's gold.");
  }
  if (!input.idempotencyKey?.trim()) throw new CustomerGoldError("Missing submission key — reload the page and try again.");

  const jobForLock = await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, select: { customerId: true, karigarId: true } });
  if (!jobForLock) throw new CustomerGoldError("Job not found.");
  if (!jobForLock.customerId) throw new CustomerGoldError("This job has no Customer, so it cannot use Customer gold.");
  await lockCustomerGold(tx, { purityId: input.customerGoldSource.purityId, customerId: jobForLock.customerId, karigarId: jobForLock.karigarId, jobId: input.jobId });
  await declareCustodyAware(tx);

  const already = await tx.jewelleryReceipt.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (already) {
    if (already.jobId !== input.jobId) throw new CustomerGoldError("This submission key was already used for a different receipt.");
    return { replayed: true as const, receipt: already, plan: null };
  }

  const plan = await planCustomerGoldJobReceipt(tx, input);
  if (input.expectedFingerprint && input.expectedFingerprint !== customerGoldJobReceiptFingerprint(plan)) {
    throw new CustomerGoldError("The job or the Customer's gold balance changed after this preview was shown. Preview again and confirm.");
  }
  const entryBase = { pool: plan.pool, entryDate: input.receiveDate, createdByUserId: input.actor.id };

  // 0. What an Owner reversal must restore exactly (CUSTOMER_GOLD_DESIGN.md §2.6).
  const jobBefore = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: plan.jobId } });
  const priorBefore = await tx.finishedJewellery.findMany({ where: { jobId: plan.jobId }, select: { id: true, otherMaterialCost: true, totalCost: true } });
  const resolvedDiamondIds = input.diamondResolutions.map((r) => r.polishedDiamondId);
  const diamondLines = resolvedDiamondIds.length
    ? await tx.jewelleryDiamondIssueLine.findMany({ where: { jobId: plan.jobId, polishedDiamondId: { in: resolvedDiamondIds } }, include: { polishedDiamond: { select: { status: true } } } })
    : [];
  const allocationEntryIds: string[] = [];

  // 1. The shortfall onto the job: from the Customer's gold with this Karigar, then from the safe.
  const allocationReason = `Receipt-time allocation for ${plan.jobCode}`;
  if (plan.fromKarigar.fine.greaterThan(0)) {
    const e = await writeCustomerGoldEntry(tx, {
      ...entryBase,
      kind: "ALLOCATE_TO_JOB",
      from: { location: "KARIGAR", scopeId: plan.karigarId },
      to: { location: "JOB", scopeId: plan.jobId },
      gross: plan.fromKarigar.gross,
      fine: plan.fromKarigar.fine,
      reason: allocationReason,
    });
    allocationEntryIds.push(e.id);
  }
  if (plan.fromSafe.fine.greaterThan(0)) {
    const e = await writeCustomerGoldEntry(tx, {
      ...entryBase,
      kind: "ALLOCATE_TO_JOB",
      from: { location: "SAFE", scopeId: null },
      to: { location: "JOB", scopeId: plan.jobId },
      gross: plan.fromSafe.gross,
      fine: plan.fromSafe.fine,
      reason: `${allocationReason} (given to ${plan.karigarName} at receipt)`,
      karigarId: plan.karigarId,
    });
    allocationEntryIds.push(e.id);
  }
  const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: plan.jobId } });
  if (job.status === "DRAFT") await tx.jewelleryJob.update({ where: { id: job.id }, data: { status: "MATERIALS_ISSUED" } });

  // 2. The receipt: Company stones, alloy, charges and any approved Company gold, exactly as always.
  const result = await receiveFinishedJewellery(tx, {
    ...input,
    customerGold: {
      customerId: plan.customerId,
      purityId: plan.pool.purityId,
      metalType: plan.pool.metalType as MetalType,
      finenessPercent: plan.pool.finenessPercentSnapshot,
      fineByOutput: plan.outputs.map((o) => o.customerFine),
      resolvesCustomerGold: plan.returned.fine.greaterThan(0) || plan.scrap.fine.greaterThan(0) || plan.lossFine.greaterThan(0),
    },
    // Completing is the Owner's / Staff's explicit tick, never "Customer gold reached zero".
    autoCompleteWhenSettled: false,
  });

  // 3. Where the Customer's gold went: into each piece, back to the safe, to scrap, to authorised loss.
  const pool = await loadPoolInTx(tx, plan.pool);
  let onJob = placeBalance(pool, { location: "JOB", scopeId: plan.jobId });
  const outflows: { kind: "CONSUME_TO_FINISHED" | "JOB_RETURN" | "JOB_SCRAP" | "JOB_LOSS"; fine: Decimal; gross?: Decimal; to: "FINISHED" | "SAFE" | "SCRAP" | "LOSS"; pieceId?: string; reason: string }[] = [];
  plan.outputs.forEach((o, i) => {
    if (o.customerFine.greaterThan(0)) {
      outflows.push({ kind: "CONSUME_TO_FINISHED", fine: o.customerFine, to: "FINISHED", pieceId: result.outputs[i].id, reason: `Used in ${result.outputs[i].finishedCode}` });
    }
  });
  if (plan.returned.fine.greaterThan(0)) outflows.push({ kind: "JOB_RETURN", fine: plan.returned.fine, gross: plan.returned.gross, to: "SAFE", reason: "Unused Customer gold returned by the Karigar" });
  if (plan.scrap.fine.greaterThan(0)) outflows.push({ kind: "JOB_SCRAP", fine: plan.scrap.fine, gross: plan.scrap.gross, to: "SCRAP", reason: "Customer's scrap — held for the Customer" });
  if (plan.lossFine.greaterThan(0)) outflows.push({ kind: "JOB_LOSS", fine: plan.lossFine, to: "LOSS", reason: input.customerGoldSource.lossReason!.trim() });
  for (const [idx, o] of outflows.entries()) {
    // The last outflow of a completed job takes the job's whole remaining gross, so it closes exactly.
    const isLast = idx === outflows.length - 1;
    const gross =
      plan.completesJob && isLast ? onJob.gross : o.gross ?? take(onJob, o.fine).gross;
    await writeCustomerGoldEntry(tx, {
      ...entryBase,
      kind: o.kind,
      from: { location: "JOB", scopeId: plan.jobId },
      to: { location: o.to, scopeId: o.to === "FINISHED" ? o.pieceId! : null },
      gross,
      fine: o.fine,
      reason: o.reason,
      reference: result.receipt.receiptCode,
      jobId: plan.jobId,
      finishedJewelleryId: o.pieceId ?? null,
      jewelleryReceiptId: result.receipt.id,
    });
    onJob = sub(onJob, { gross, fine: o.fine });
  }

  // 4. Proven, not assumed.
  const after = await loadPoolInTx(tx, plan.pool);
  const jobAfter = placeBalance(after, { location: "JOB", scopeId: plan.jobId });
  if (!jobAfter.fine.equals(plan.onJobAfter.fine) || (plan.completesJob && !jobAfter.gross.isZero())) {
    throw new CustomerGoldError("Internal balance check failed: nothing was saved.");
  }
  for (const [i, piece] of result.outputs.entries()) {
    if (!new Decimal(piece.customerGoldFineWeight).equals(plan.outputs[i].customerFine)) throw new CustomerGoldError("Internal check failed: piece Customer gold mismatch. Nothing was saved.");
  }

  // 5. The reversal record, written with the receipt in the same transaction.
  const priorAfter = new Map(
    (await tx.finishedJewellery.findMany({ where: { id: { in: priorBefore.map((p) => p.id) } }, select: { id: true, otherMaterialCost: true, totalCost: true } })).map((p) => [p.id, p])
  );
  const money2 = (v: DecimalInput) => new Decimal(String(v)).toFixed(2);
  const snapshot: ReceiptReversalSnapshot = {
    version: 1,
    pool: { customerId: plan.pool.customerId, metalType: plan.pool.metalType as MetalType, purityId: plan.pool.purityId, finenessPercent: plan.pool.finenessPercentSnapshot.toFixed(3) },
    jobBefore: jobStateOf(jobBefore),
    jobAfter: jobStateOf(result.job),
    priorOutputs: priorBefore.map((p) => ({
      id: p.id,
      before: { otherMaterialCost: money2(p.otherMaterialCost), totalCost: money2(p.totalCost) },
      after: { otherMaterialCost: money2(priorAfter.get(p.id)!.otherMaterialCost), totalCost: money2(priorAfter.get(p.id)!.totalCost) },
    })),
    allocationEntryIds,
    diamonds: diamondLines.map((l) => ({
      issueLineId: l.id,
      polishedDiamondId: l.polishedDiamondId,
      resolution: input.diamondResolutions.find((r) => r.polishedDiamondId === l.polishedDiamondId)!.resolution,
      statusBefore: l.polishedDiamond.status,
    })),
  };
  const receipt = await tx.jewelleryReceipt.update({ where: { id: result.receipt.id }, data: { reversalSnapshot: snapshot } });
  return { replayed: false as const, receipt, outputs: result.outputs, job: result.job, plan };
}
