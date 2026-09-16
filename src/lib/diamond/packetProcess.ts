import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { ProcessChargeRateBasis } from "@/generated/prisma/enums";

import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import {
  cancelVoucher,
  createVoucherHeader,
  insertBalancedJournalLines,
  PostingError,
  type JournalLineInput,
} from "@/lib/accounting/posting";
import { allocateProportionally, round3 } from "@/lib/diamond/allocation";
import { nextDiamondCode } from "@/lib/diamond/numbering";
import { buildPacketMergeKey, checkPacketQuantity } from "@/lib/diamond/packets";
import { getPacketBalanceInTx, lockPacketInTx } from "@/lib/diamond/polishedPurchase";
import { computeProcessCharge } from "@/lib/diamond/processCharge";
import { toThousandths } from "@/lib/jewellery/metalMath";

// Phase 7 — Job Manufacturer: bulk polished packets issued to a Manufacturer
// for a process, returned size-wise over one or more receipts. See
// PHASE_7_IMPROVEMENT_PLAN.md §8.4 and §9 (entries 5, 6, 17b).
//
//   Issue    Dr 1210 Diamond WIP / Cr 1220 Polished Inventory
//   Receipt  Dr 1220 returned + Dr 1320 used in a Jewellery Job
//            + Dr 5100 damaged/lost, abnormal loss, unabsorbable cost
//            Cr 1210 resolved cost + Cr 2000 AP (Manufacturer) process charge
//   Cancel   mirror reversal of the issue, stones back into their packets
//
// Every issued piece and carat resolves exactly once. A partial return never
// recognises loss; carat loss exists only once the job is closed.

export { PostingError };

type Tx = Prisma.TransactionClient;
type FyInput = { fyStartMonth: number; fyStartDay: number };

const OPEN_JEWELLERY_JOB_STATUSES = ["MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"];

export type PacketProcessIssueLineInput = { packetId: string; pieces: number; carat: DecimalInput };

export async function createPacketProcessJob(
  tx: Tx,
  input: FyInput & {
    manufacturerId: string;
    processId: string;
    issueDate: Date;
    dueDate?: Date | null;
    lines: PacketProcessIssueLineInput[];
    chargeRateBasis: ProcessChargeRateBasis;
    chargeRate: DecimalInput;
    notes?: string | null;
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  if (input.lines.length === 0) throw new PostingError("Issue at least one packet.");

  const manufacturer = await tx.party.findUnique({ where: { id: input.manufacturerId } });
  if (!manufacturer || !manufacturer.isActive || (manufacturer.type !== "MANUFACTURER" && manufacturer.type !== "KARIGAR")) {
    throw new PostingError("Choose an active Manufacturer.");
  }
  const diamondProcess = await tx.diamondProcess.findUnique({ where: { id: input.processId } });
  if (!diamondProcess || !diamondProcess.isActive) throw new PostingError("The selected process was not found or is inactive.");
  const chargeRate = new Decimal(input.chargeRate ?? 0).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (chargeRate.isNegative()) throw new PostingError("The process charge rate cannot be negative.");

  const seen = new Set<string>();
  const resolved: { packetId: string; packetCode: string; pieces: number; carat: Decimal; cost: Decimal; empties: boolean }[] = [];
  for (const line of input.lines) {
    if (seen.has(line.packetId)) throw new PostingError("The same packet was selected more than once.");
    seen.add(line.packetId);
    if (!Number.isInteger(line.pieces) || line.pieces < 1) {
      throw new PostingError("Each packet line must issue a whole number of pieces, at least one.");
    }
    const packet = (await lockPacketInTx(tx, line.packetId)) ? await tx.polishedPacket.findUnique({ where: { id: line.packetId } }) : null;
    if (!packet) throw new PostingError("One or more selected packets were not found or are no longer active.");
    const carat = round3(line.carat);
    const balance = await getPacketBalanceInTx(tx, line.packetId);
    const check = checkPacketQuantity(
      { pieces: line.pieces, caratThousandths: toThousandths(carat.toFixed(3)) },
      { pieces: balance.pieces, caratThousandths: toThousandths(balance.carat.toFixed(3)) }
    );
    if (!check.ok) throw new PostingError(`Packet ${packet.packetCode}: ${check.reason}`);
    const empties = carat.equals(balance.carat);
    const cost = empties ? balance.costValue : round2(balance.costValue.times(carat).dividedBy(balance.carat));
    resolved.push({ packetId: line.packetId, packetCode: packet.packetCode, pieces: line.pieces, carat, cost, empties });
  }
  const issuedPieces = resolved.reduce((sum, l) => sum + l.pieces, 0);
  const issuedCarat = round3(resolved.reduce((sum, l) => sum.plus(l.carat), ZERO));
  const issuedCost = round2(resolved.reduce((sum, l) => sum.plus(l.cost), ZERO));

  const jobCode = await nextDiamondCode(tx, "PACKET_PROCESS_JOB");
  let wipVoucherId: string | null = null;
  if (issuedCost.greaterThan(0)) {
    const voucher = await createVoucherHeader(
      tx,
      {
        date: input.issueDate,
        fyStartMonth: input.fyStartMonth,
        fyStartDay: input.fyStartDay,
        currencyCode: "INR",
        exchangeRate: 1,
        note: `Polished packets issued for ${diamondProcess.name} — Job Manufacturer ${jobCode}`,
        idempotencyKey: input.idempotencyKey,
        createdByUserId: input.createdByUserId,
      },
      "DIAMOND_ISSUE",
      { amount: issuedCost }
    );
    await insertBalancedJournalLines(tx, voucher.id, [
      { accountCode: SYSTEM_ACCOUNT_CODES.DIAMOND_WIP, debit: issuedCost, description: `Issue ${jobCode}` },
      { accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, credit: issuedCost, description: `Issue ${jobCode}` },
    ]);
    wipVoucherId = voucher.id;
  }

  const job = await tx.packetProcessJob.create({
    data: {
      jobCode,
      manufacturerId: manufacturer.id,
      processId: diamondProcess.id,
      processNameSnapshot: diamondProcess.name,
      issueDate: input.issueDate,
      dueDate: input.dueDate ?? null,
      notes: input.notes ?? null,
      issuedPieces,
      issuedCarat: issuedCarat.toFixed(3),
      issuedCostValue: issuedCost.toFixed(2),
      remainingWipCost: issuedCost.toFixed(2),
      chargeRateBasis: input.chargeRateBasis,
      chargeRate: chargeRate.toFixed(4),
      wipVoucherId,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  for (const line of resolved) {
    await tx.packetProcessJobLine.create({
      data: {
        jobId: job.id,
        packetId: line.packetId,
        piecesAtIssue: line.pieces,
        caratAtIssue: line.carat.toFixed(3),
        costAtIssue: line.cost.toFixed(2),
      },
    });
    await tx.polishedPacketMovement.create({
      data: {
        type: "PROCESS_ISSUE_OUT",
        packetId: line.packetId,
        pieces: line.pieces,
        carat: line.carat.toFixed(3),
        costValue: line.cost.toFixed(2),
        sourceDocument: jobCode,
        packetProcessJobId: job.id,
        createdByUserId: input.createdByUserId,
      },
    });
    if (line.empties) {
      await tx.polishedPacket.update({ where: { id: line.packetId }, data: { status: "EMPTY" } });
    }
  }

  return job;
}

// ---------------------------------------------------------------------------
// Cancel (Owner-only; enforced by the caller) — only before any return
// ---------------------------------------------------------------------------

export async function cancelPacketProcessJob(
  tx: Tx,
  input: FyInput & { jobId: string; cancelledByUserId: string; cancellationReason: string }
) {
  if (!input.cancellationReason || input.cancellationReason.trim().length < 3) {
    throw new PostingError("Give a short reason for cancelling this job.");
  }
  const job = await tx.packetProcessJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new PostingError("Job not found.");
  if (job.status === "CANCELLED") throw new PostingError("This job has already been cancelled.");
  const receiptCount = await tx.packetProcessReceipt.count({ where: { jobId: job.id } });
  if (job.status !== "ISSUED" || receiptCount > 0) {
    throw new PostingError("Stones have already come back on this job — it can no longer be cancelled.");
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

  const lines = await tx.packetProcessJobLine.findMany({ where: { jobId: job.id } });
  for (const line of lines) {
    await lockPacketInTx(tx, line.packetId, ["ACTIVE", "EMPTY"]);
    await tx.polishedPacketMovement.create({
      data: {
        type: "PROCESS_ISSUE_CANCEL_IN",
        packetId: line.packetId,
        pieces: line.piecesAtIssue,
        carat: line.caratAtIssue,
        costValue: line.costAtIssue,
        sourceDocument: job.jobCode,
        packetProcessJobId: job.id,
        createdByUserId: input.cancelledByUserId,
      },
    });
    await tx.polishedPacket.updateMany({ where: { id: line.packetId, status: "EMPTY" }, data: { status: "ACTIVE" } });
  }

  return tx.packetProcessJob.update({
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
// Return (partial or final) — size-wise rows per issued line
// ---------------------------------------------------------------------------

export type PacketReturnRowInput = {
  jobLineId: string;
  disposition: "RETURNED_TO_STOCK" | "USED_IN_JEWELLERY_JOB" | "DAMAGED_LOST";
  pieces: number;
  carat: DecimalInput;
  /** Size as returned; defaults to the issued packet's size. */
  sizeLabel?: string | null;
  jewelleryJobId?: string | null;
  damagedLostReason?: string | null;
};

export async function receivePacketProcessReturn(
  tx: Tx,
  input: FyInput & {
    jobId: string;
    receiveDate: Date;
    rows: PacketReturnRowInput[];
    /** Explicitly closes the job: any carat still unaccounted for becomes process loss. */
    markJobComplete: boolean;
    isAbnormalLoss: boolean;
    abnormalLossReason?: string | null;
    notes?: string | null;
    idempotencyKey?: string | null;
    createdByUserId: string;
  }
) {
  const job = await tx.packetProcessJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new PostingError("Job not found.");
  if (job.status === "CANCELLED") throw new PostingError("This job has been cancelled.");
  if (job.status === "COMPLETED") throw new PostingError("This job is already completed.");
  if (input.isAbnormalLoss && (!input.abnormalLossReason || input.abnormalLossReason.trim().length < 3)) {
    throw new PostingError("Give a short reason for classifying this loss as abnormal.");
  }
  if (input.rows.length === 0 && !input.markJobComplete) {
    throw new PostingError("Record at least one returned, used or damaged/lost line.");
  }

  const jobLines = await tx.packetProcessJobLine.findMany({ where: { jobId: job.id } });
  const lineById = new Map(jobLines.map((l) => [l.id, l]));

  type Row = PacketReturnRowInput & { carat3: Decimal; lineIndex: number };
  const rows: Row[] = input.rows.map((row, lineIndex) => {
    const line = lineById.get(row.jobLineId);
    if (!line) throw new PostingError("One or more return lines do not belong to this job.");
    const carat3 = round3(row.carat);
    if (!Number.isInteger(row.pieces) || row.pieces < 1 || !carat3.greaterThan(0)) {
      throw new PostingError("Each return line needs at least one piece and a carat greater than zero.");
    }
    if (row.disposition === "USED_IN_JEWELLERY_JOB" && !row.jewelleryJobId) {
      throw new PostingError("Choose the Jewellery Job the stones were used in.");
    }
    if (row.disposition === "DAMAGED_LOST" && (!row.damagedLostReason || row.damagedLostReason.trim().length < 3)) {
      throw new PostingError("Give a short reason for marking stones damaged/lost.");
    }
    return { ...row, carat3, lineIndex };
  });

  // ---- Per issued line: this receipt's quantities against what is pending ----
  type LinePlan = {
    line: (typeof jobLines)[number];
    rows: Row[];
    pendingPieces: number;
    pendingCarat: Decimal;
    thisPieces: number;
    thisCarat: Decimal;
  };
  const plans: LinePlan[] = jobLines.map((line) => {
    const lineRows = rows.filter((r) => r.jobLineId === line.id);
    return {
      line,
      rows: lineRows,
      pendingPieces: line.piecesAtIssue - line.resolvedPieces,
      pendingCarat: round3(new Decimal(line.caratAtIssue).minus(line.resolvedCarat).minus(line.lossCarat)),
      thisPieces: lineRows.reduce((sum, r) => sum + r.pieces, 0),
      thisCarat: round3(lineRows.reduce((sum, r) => sum.plus(r.carat3), ZERO)),
    };
  });
  const packetCodeById = new Map<string, string>();
  for (const plan of plans) {
    const packet = await tx.polishedPacket.findUnique({ where: { id: plan.line.packetId } });
    packetCodeById.set(plan.line.packetId, packet?.packetCode ?? plan.line.packetId);
    if (plan.thisPieces > plan.pendingPieces || plan.thisCarat.greaterThan(plan.pendingCarat)) {
      throw new PostingError(
        `Packet ${packetCodeById.get(plan.line.packetId)}: this return is more than the ${plan.pendingPieces} pcs / ${plan.pendingCarat.toFixed(3)}ct still with the Manufacturer.`
      );
    }
  }

  // A line closes once every one of its pieces is accounted for: no stone is
  // left with the Manufacturer, so any carat gap is definite process loss.
  // While even one piece is pending, nothing is treated as loss.
  const openPlans = plans.filter((p) => !p.line.isClosed);
  for (const plan of openPlans) {
    if (plan.thisPieces < plan.pendingPieces && plan.thisCarat.greaterThan(0) && plan.thisCarat.equals(plan.pendingCarat)) {
      throw new PostingError(
        `Packet ${packetCodeById.get(plan.line.packetId)}: every carat is back but ${plan.pendingPieces - plan.thisPieces} piece(s) are not — check the pieces.`
      );
    }
  }
  const closesLine = (plan: LinePlan) => plan.thisPieces === plan.pendingPieces && plan.pendingPieces > 0;
  const isFinal = input.markJobComplete || openPlans.every(closesLine);
  if (isFinal) {
    for (const plan of openPlans) {
      if (!closesLine(plan)) {
        throw new PostingError(
          `Packet ${packetCodeById.get(plan.line.packetId)}: ${plan.pendingPieces - plan.thisPieces} piece(s) are still unaccounted for — return them, mark them used or damaged/lost before closing the job.`
        );
      }
    }
  }

  // ---- Jewellery Jobs receiving "used" stones must be open, and must not
  // already hold this packet directly (one issue line per job and packet,
  // so two cost layers are never averaged together). ----
  for (const row of rows.filter((r) => r.disposition === "USED_IN_JEWELLERY_JOB")) {
    const jewelleryJob = await tx.jewelleryJob.findUnique({ where: { id: row.jewelleryJobId! } });
    if (!jewelleryJob || !OPEN_JEWELLERY_JOB_STATUSES.includes(jewelleryJob.status)) {
      throw new PostingError("Stones can only be marked used in an open Jewellery Job that already has materials issued.");
    }
    const line = lineById.get(row.jobLineId)!;
    const existing = await tx.jewelleryPacketIssueLine.findMany({ where: { jobId: jewelleryJob.id, packetId: line.packetId } });
    const sameReceipt = rows.filter(
      (r) => r.disposition === "USED_IN_JEWELLERY_JOB" && r.jewelleryJobId === row.jewelleryJobId && lineById.get(r.jobLineId)!.packetId === line.packetId
    );
    if (existing.length > 0 || sameReceipt.length > 1) {
      throw new PostingError(
        `Jewellery Job ${jewelleryJob.jobCode} already holds stones from packet ${packetCodeById.get(line.packetId)} — record them as one line, or return them to stock and issue from the Jewellery Job.`
      );
    }
  }

  // ---- Cost: each line drains by carat; a closing line takes its whole
  // remainder. Normal loss stays inside the surviving stones; abnormal
  // loss (Owner) is carved out to Business Expenses. ----
  const stoneCostByRow = new Map<Row, Decimal>();
  let wipCredit = ZERO;
  let lossExpense = ZERO;
  let unabsorbed = ZERO;
  let totalLossCarat = ZERO;
  const lineUpdates: { plan: LinePlan; resolvedLineCost: Decimal; lossCarat: Decimal; closes: boolean }[] = [];
  for (const plan of openPlans) {
    const closes = closesLine(plan);
    if (!closes && plan.rows.length === 0) continue;
    const remaining = round2(new Decimal(plan.line.costAtIssue).minus(plan.line.resolvedCost));
    const lossCarat = closes ? round3(plan.pendingCarat.minus(plan.thisCarat)) : ZERO;
    const resolvedLineCost = closes ? remaining : round2(remaining.times(plan.thisCarat).dividedBy(plan.pendingCarat));
    const lossCost =
      input.isAbnormalLoss && lossCarat.greaterThan(0)
        ? plan.thisCarat.greaterThan(0)
          ? round2(resolvedLineCost.times(lossCarat).dividedBy(plan.pendingCarat))
          : resolvedLineCost
        : ZERO;
    const distributable = round2(resolvedLineCost.minus(lossCost));
    if (plan.rows.length > 0) {
      const split = allocateProportionally(distributable, plan.rows.map((r, i) => ({ key: String(i), weight: r.carat3 })));
      plan.rows.forEach((r, i) => stoneCostByRow.set(r, split.find((s) => s.key === String(i))!.amount));
    } else {
      unabsorbed = unabsorbed.plus(distributable);
    }
    wipCredit = wipCredit.plus(resolvedLineCost);
    lossExpense = lossExpense.plus(lossCost);
    totalLossCarat = totalLossCarat.plus(lossCarat);
    lineUpdates.push({ plan, resolvedLineCost, lossCarat, closes });
  }

  // ---- Process charge on stones actually returned or used ----
  const chargeable = rows.filter((r) => r.disposition !== "DAMAGED_LOST");
  const charge = new Decimal(
    computeProcessCharge({
      basis: job.chargeRateBasis,
      rate: new Decimal(job.chargeRate).toFixed(4),
      carat: round3(chargeable.reduce((sum, r) => sum.plus(r.carat3), ZERO)).toFixed(3),
      pieces: chargeable.reduce((sum, r) => sum + r.pieces, 0),
      isFinal,
    })
  );
  const chargeByRow = new Map<Row, Decimal>();
  if (charge.greaterThan(0)) {
    if (chargeable.length > 0) {
      const split = allocateProportionally(charge, chargeable.map((r, i) => ({ key: String(i), weight: r.carat3 })));
      chargeable.forEach((r, i) => chargeByRow.set(r, split.find((s) => s.key === String(i))!.amount));
    } else {
      unabsorbed = unabsorbed.plus(charge);
    }
  }
  const rowCost = (r: Row) => round2((stoneCostByRow.get(r) ?? ZERO).plus(chargeByRow.get(r) ?? ZERO));

  const returnedDebit = round2(rows.filter((r) => r.disposition === "RETURNED_TO_STOCK").reduce((s, r) => s.plus(rowCost(r)), ZERO));
  const usedDebit = round2(rows.filter((r) => r.disposition === "USED_IN_JEWELLERY_JOB").reduce((s, r) => s.plus(rowCost(r)), ZERO));
  const damagedDebit = round2(rows.filter((r) => r.disposition === "DAMAGED_LOST").reduce((s, r) => s.plus(rowCost(r)), ZERO));
  const expenseDebit = round2(damagedDebit.plus(lossExpense).plus(unabsorbed));
  wipCredit = round2(wipCredit);

  // ---- Post ----
  const receiptCode = await nextDiamondCode(tx, "PACKET_PROCESS_RECEIPT");
  const journalLines: JournalLineInput[] = [];
  if (returnedDebit.greaterThan(0)) {
    journalLines.push({ accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, debit: returnedDebit, description: `Returned from ${job.jobCode} ${receiptCode}` });
  }
  if (usedDebit.greaterThan(0)) {
    journalLines.push({ accountCode: SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, debit: usedDebit, description: `Used in Jewellery Job ${receiptCode}` });
  }
  if (expenseDebit.greaterThan(0)) {
    journalLines.push({ accountCode: SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, debit: expenseDebit, description: `Damaged/lost or abnormal loss ${receiptCode}` });
  }
  if (wipCredit.greaterThan(0)) {
    journalLines.push({ accountCode: SYSTEM_ACCOUNT_CODES.DIAMOND_WIP, credit: wipCredit, description: `Receipt ${receiptCode}` });
  }
  if (charge.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: job.manufacturerId,
      credit: charge,
      description: `${job.processNameSnapshot} charge payable ${receiptCode}`,
    });
  }
  const totalDebit = round2(journalLines.reduce((sum, l) => sum.plus(new Decimal(l.debit ?? 0)), ZERO));
  let postingVoucherId: string | null = null;
  if (totalDebit.greaterThan(0)) {
    const voucher = await createVoucherHeader(
      tx,
      {
        date: input.receiveDate,
        fyStartMonth: input.fyStartMonth,
        fyStartDay: input.fyStartDay,
        currencyCode: "INR",
        exchangeRate: 1,
        note: `Job Manufacturer return ${receiptCode} for ${job.jobCode}`,
        idempotencyKey: input.idempotencyKey,
        createdByUserId: input.createdByUserId,
      },
      "DIAMOND_RECEIPT",
      { amount: totalDebit }
    );
    await insertBalancedJournalLines(tx, voucher.id, journalLines);
    postingVoucherId = voucher.id;
  }

  const receipt = await tx.packetProcessReceipt.create({
    data: {
      receiptCode,
      jobId: job.id,
      receiveDate: input.receiveDate,
      isFinal,
      lossCarat: round3(totalLossCarat).toFixed(3),
      isAbnormalLoss: input.isAbnormalLoss && totalLossCarat.greaterThan(0),
      abnormalLossReason: input.isAbnormalLoss && totalLossCarat.greaterThan(0) ? input.abnormalLossReason ?? null : null,
      processCharge: charge.toFixed(2),
      notes: input.notes ?? null,
      postingVoucherId,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  // ---- Stones: back into stock, onto a Jewellery Job, or written off ----
  for (const row of rows) {
    const line = lineById.get(row.jobLineId)!;
    const cost = rowCost(row);
    let resultPacketId: string | null = null;
    if (row.disposition === "RETURNED_TO_STOCK") {
      resultPacketId = await returnStonesToPacket(tx, {
        sourcePacketId: line.packetId,
        sizeLabel: row.sizeLabel?.trim() || null,
        pieces: row.pieces,
        carat: row.carat3,
        cost,
        jobId: job.id,
        receiptCode,
        createdByUserId: input.createdByUserId,
      });
    }
    const receiptLine = await tx.packetProcessReceiptLine.create({
      data: {
        receiptId: receipt.id,
        jobLineId: line.id,
        disposition: row.disposition,
        pieces: row.pieces,
        carat: row.carat3.toFixed(3),
        sizeLabel: row.sizeLabel?.trim() || (await tx.polishedPacket.findUnique({ where: { id: line.packetId } }))!.sizeLabel,
        costValue: cost.toFixed(2),
        chargeShare: (chargeByRow.get(row) ?? ZERO).toFixed(2),
        resultPacketId,
        jewelleryJobId: row.disposition === "USED_IN_JEWELLERY_JOB" ? row.jewelleryJobId! : null,
        damagedLostReason: row.disposition === "DAMAGED_LOST" ? row.damagedLostReason!.trim() : null,
      },
    });
    if (row.disposition === "USED_IN_JEWELLERY_JOB") {
      await tx.jewelleryPacketIssueLine.create({
        data: {
          jobId: row.jewelleryJobId!,
          packetId: line.packetId,
          piecesAtIssue: row.pieces,
          caratAtIssue: row.carat3.toFixed(3),
          costAtIssue: cost.toFixed(2),
          sourcePacketProcessReceiptLineId: receiptLine.id,
        },
      });
      const jewelleryJob = await tx.jewelleryJob.findUnique({ where: { id: row.jewelleryJobId! } });
      await tx.jewelleryJob.update({
        where: { id: row.jewelleryJobId! },
        data: { issuedPacketDiamondCost: round2(new Decimal(jewelleryJob!.issuedPacketDiamondCost).plus(cost)).toFixed(2) },
      });
    }
  }

  // ---- Line and job totals ----
  for (const update of lineUpdates) {
    const { plan } = update;
    await tx.packetProcessJobLine.update({
      where: { id: plan.line.id },
      data: {
        resolvedPieces: plan.line.resolvedPieces + plan.thisPieces,
        resolvedCarat: round3(new Decimal(plan.line.resolvedCarat).plus(plan.thisCarat)).toFixed(3),
        lossCarat: round3(new Decimal(plan.line.lossCarat).plus(update.lossCarat)).toFixed(3),
        resolvedCost: round2(new Decimal(plan.line.resolvedCost).plus(update.resolvedLineCost)).toFixed(2),
        isClosed: update.closes,
      },
    });
  }
  const sumOf = (disposition: PacketReturnRowInput["disposition"]) => {
    const matching = rows.filter((r) => r.disposition === disposition);
    return { pieces: matching.reduce((s, r) => s + r.pieces, 0), carat: matching.reduce((s, r) => s.plus(r.carat3), ZERO) };
  };
  const returned = sumOf("RETURNED_TO_STOCK");
  const used = sumOf("USED_IN_JEWELLERY_JOB");
  const damaged = sumOf("DAMAGED_LOST");
  const updatedJob = await tx.packetProcessJob.update({
    where: { id: job.id },
    data: {
      returnedPieces: job.returnedPieces + returned.pieces,
      returnedCarat: round3(new Decimal(job.returnedCarat).plus(returned.carat)).toFixed(3),
      usedPieces: job.usedPieces + used.pieces,
      usedCarat: round3(new Decimal(job.usedCarat).plus(used.carat)).toFixed(3),
      damagedPieces: job.damagedPieces + damaged.pieces,
      damagedCarat: round3(new Decimal(job.damagedCarat).plus(damaged.carat)).toFixed(3),
      lossCarat: round3(new Decimal(job.lossCarat).plus(totalLossCarat)).toFixed(3),
      remainingWipCost: round2(new Decimal(job.remainingWipCost).minus(wipCredit)).toFixed(2),
      totalCharge: round2(new Decimal(job.totalCharge).plus(charge)).toFixed(2),
      status: isFinal ? "COMPLETED" : "PARTIALLY_RETURNED",
    },
  });

  return { receipt, job: updatedJob };
}

/**
 * Returned stones re-enter their original packet when nothing that defines
 * the packet changed (same merge key). A different returned size creates a
 * child packet with provenance RETURNED_FROM_JOB, so a re-sized parcel is
 * never averaged into the stones it came from.
 */
async function returnStonesToPacket(
  tx: Tx,
  input: {
    sourcePacketId: string;
    sizeLabel: string | null;
    pieces: number;
    carat: Decimal;
    cost: Decimal;
    jobId: string;
    receiptCode: string;
    createdByUserId: string;
  }
): Promise<string> {
  const source = await tx.polishedPacket.findUnique({ where: { id: input.sourcePacketId } });
  if (!source) throw new PostingError("The issued packet no longer exists.");
  const sizeLabel = input.sizeLabel ?? source.sizeLabel;
  const attributes = {
    shape: source.shape,
    customShapeName: source.customShapeName,
    sizeLabel,
    quality: source.quality,
    colour: source.colour,
    lab: source.lab,
    certificateStatus: source.certificateStatus,
    currencyCode: source.currencyCode,
  };

  let targetPacketId = source.id;
  if (buildPacketMergeKey({ ...attributes, provenance: source.provenance }) === source.mergeKey) {
    if (!(await lockPacketInTx(tx, source.id, ["ACTIVE", "EMPTY"]))) {
      throw new PostingError(`Packet ${source.packetCode} is no longer active — the returned stones cannot go back into it.`);
    }
    await tx.polishedPacket.updateMany({ where: { id: source.id, status: "EMPTY" }, data: { status: "ACTIVE" } });
  } else {
    const child = await tx.polishedPacket.create({
      data: {
        packetCode: await nextDiamondCode(tx, "POLISHED_PACKET"),
        provenance: "RETURNED_FROM_JOB",
        mergeKey: buildPacketMergeKey({ ...attributes, provenance: "RETURNED_FROM_JOB" }),
        ...attributes,
        certNumber: source.certNumber,
        certFileAssetId: source.certFileAssetId,
        parentPacketId: source.id,
        sourcePacketProcessJobId: input.jobId,
        createdByUserId: input.createdByUserId,
      },
    });
    targetPacketId = child.id;
  }

  await tx.polishedPacketMovement.create({
    data: {
      type: "PROCESS_RETURN_IN",
      packetId: targetPacketId,
      pieces: input.pieces,
      carat: input.carat.toFixed(3),
      costValue: input.cost.toFixed(2),
      sourceDocument: input.receiptCode,
      packetProcessJobId: input.jobId,
      createdByUserId: input.createdByUserId,
    },
  });
  return targetPacketId;
}
