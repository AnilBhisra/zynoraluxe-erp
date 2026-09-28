import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { UserRole } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import type { JournalLineInput } from "@/lib/accounting/posting";
import { postCorrection, reverseCorrection } from "@/lib/corrections/engine";
import { CorrectionError, fingerprintPlan, type CorrectionPlan, type PlannedImpact, type Tx } from "@/lib/corrections/types";
import { allocateProportionally } from "@/lib/diamond/allocation";
import { perIssuedCaratLabour } from "@/lib/diamond/processCharge";

/**
 * "Correct labour" — an audited, Owner-only correction that raises the labour
 * of a Manufacturer (diamond) polished receipt after it was posted, e.g. when
 * Polishing should have been charged per ISSUED carat (10.190 ct × ₹850)
 * rather than per received carat (5.091 ct × ₹850).
 *
 *  - The receipt row, its original voucher and every quantity stay exactly as
 *    posted. The addition is a NEW balanced CORRECTION voucher (Dr 1220
 *    Polished Diamond Inventory, Cr the Manufacturer's payable) plus a
 *    DiamondReceiptLabourCorrection recording each output's share.
 *  - The added labour is spread over the receipt's POLISHED outputs by carat
 *    (the same outputs that carried the original labour): a stone's
 *    allocated cost / cost per carat, or a parcel packet's manufacture-in cost.
 *    Rough returned on the receipt never carried labour and is not touched.
 *  - Only while every output is untouched: stones Available with no movement
 *    but their receipt; packets Active with no movement but their
 *    manufacture-in. Checked again inside the posting (and reversal)
 *    transaction after the rows are locked.
 *  - One live correction per receipt (reverse it to change the figure), and
 *    increases only.
 */

export const MANUFACTURER_LABOUR_MODE = "ADD_MANUFACTURER_LABOUR" as const;

type Output = {
  kind: "STONE" | "PACKET";
  /** polished_diamonds.id or polished_packets.id */
  id: string;
  /** The packet's MANUFACTURE_IN movement (the row that holds its cost). */
  movementId: string | null;
  code: string;
  carat: Decimal;
  cost: Decimal;
};

export type LabourCorrectionLine = {
  kind: "STONE" | "PACKET";
  id: string;
  movementId: string | null;
  code: string;
  carat: string;
  added: string;
  costBefore: string;
  costAfter: string;
};

async function loadReceipt(tx: Tx, receiptId: string) {
  return tx.polishedReceipt.findUnique({
    where: { id: receiptId },
    include: {
      job: {
        select: {
          id: true,
          jobCode: true,
          status: true,
          karigarId: true,
          totalLabourCharge: true,
          chargeRateBasis: true,
          chargeRate: true,
          processNameSnapshot: true,
          karigar: { select: { name: true } },
        },
      },
    },
  });
}

/** The receipt's polished outputs with their current cost, and why any of them blocks a correction. */
async function loadOutputs(tx: Tx, receiptId: string): Promise<{ outputs: Output[]; blocker: string | null }> {
  const stones = await tx.polishedDiamond.findMany({
    where: { receiptId },
    orderBy: [{ polishedCode: "asc" }, { id: "asc" }],
    select: { id: true, polishedCode: true, status: true, carat: true, allocatedCost: true },
  });
  const packets = await tx.polishedPacket.findMany({
    where: { sourceReceiptId: receiptId },
    orderBy: [{ packetCode: "asc" }, { id: "asc" }],
    select: { id: true, packetCode: true, status: true, movements: { select: { id: true, type: true, carat: true, costValue: true } } },
  });

  const outputs: Output[] = [];
  let blocker: string | null = null;
  const block = (msg: string) => {
    if (!blocker) blocker = msg;
  };

  // A stone that was issued, set, recut, converted or lost carries its cost somewhere else now.
  for (const s of stones) {
    if (s.status === "CONVERTED_TO_PARCEL") continue; // its cost moved into the packet listed below
    if (s.status !== "AVAILABLE") {
      block(`${s.polishedCode} is ${s.status.toLowerCase().replace(/_/g, " ")}. Labour can only be corrected while every output of this receipt is still in stock and untouched.`);
      continue;
    }
    outputs.push({ kind: "STONE", id: s.id, movementId: null, code: s.polishedCode, carat: new Decimal(s.carat), cost: new Decimal(s.allocatedCost) });
  }
  const stoneIds = stones.map((s) => s.id);
  if (stoneIds.length > 0) {
    const moved = await tx.stockMovement.findFirst({
      where: { polishedDiamondId: { in: stoneIds }, type: { not: "POLISHED_RECEIVE_IN" } },
      select: { type: true, polishedDiamond: { select: { polishedCode: true } } },
    });
    if (moved && moved.type !== "POLISHED_CONVERTED_OUT") {
      block(`${moved.polishedDiamond?.polishedCode ?? "A stone"} has stock history (${moved.type.replace(/_/g, " ").toLowerCase()}), so its cost has already travelled on.`);
    }
    if (moved && moved.type === "POLISHED_CONVERTED_OUT") {
      block(`A stone from this receipt was converted into a parcel after the receipt. Correcting labour across that conversion is not supported.`);
    }
  }

  for (const p of packets) {
    const manufactureIn = p.movements.filter((m) => m.type === "MANUFACTURE_IN");
    const others = p.movements.filter((m) => m.type !== "MANUFACTURE_IN");
    if (p.status !== "ACTIVE" || manufactureIn.length !== 1 || others.length > 0) {
      block(
        `${p.packetCode} has been used since the receipt (${others.map((m) => m.type.replace(/_/g, " ").toLowerCase()).join(", ") || p.status.toLowerCase()}). Labour can only be corrected while every output of this receipt is still in stock and untouched.`
      );
      continue;
    }
    const m = manufactureIn[0];
    outputs.push({ kind: "PACKET", id: p.id, movementId: m.id, code: p.packetCode, carat: new Decimal(m.carat), cost: new Decimal(m.costValue) });
  }

  if (!blocker && outputs.length === 0) block("This receipt has no polished output to carry the labour (only returned rough).");
  return { outputs, blocker };
}

async function manufacturerPayable(tx: Tx, partyId: string): Promise<Decimal> {
  const account = await tx.account.findUnique({ where: { code: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE } });
  if (!account) return ZERO;
  const sums = await tx.journalEntry.aggregate({ where: { accountId: account.id, partyId }, _sum: { debit: true, credit: true } });
  return round2(new Decimal(sums._sum.credit ?? 0).minus(new Decimal(sums._sum.debit ?? 0)));
}

/** A live (posted, not reversed) labour correction on this receipt, if any. */
async function liveCorrection(tx: Tx, receiptId: string) {
  return tx.diamondReceiptLabourCorrection.findFirst({
    where: { receiptId, correction: { state: "POSTED", reversedByCorrectionId: null } },
    include: { correction: { select: { id: true, correctionCode: true } } },
  });
}

/** This receipt's labour re-priced per ISSUED carat at the job's per-carat rate (null without one). */
export function suggestPerIssuedCaratLabour(
  receipt: { totalPolishedCarat: Prisma.Decimal | Decimal; weightLossCarat: Prisma.Decimal | Decimal },
  job: { chargeRateBasis: string | null; chargeRate: Prisma.Decimal | Decimal | null }
): string | null {
  return perIssuedCaratLabour({
    basis: job.chargeRateBasis,
    rate: job.chargeRate ? new Decimal(job.chargeRate).toFixed(4) : null,
    polishedCarat: new Decimal(receipt.totalPolishedCarat).toFixed(3),
    weightLossCarat: new Decimal(receipt.weightLossCarat).toFixed(3),
  });
}

export type LabourEligibility = { ok: true } | { ok: false; reason: string };

/** Read-only: may this receipt's labour be corrected right now? */
export async function assessReceiptForLabour(tx: Tx, receiptId: string): Promise<LabourEligibility> {
  const receipt = await loadReceipt(tx, receiptId);
  if (!receipt) return { ok: false, reason: "Receipt not found." };
  if (receipt.job.status === "CANCELLED") return { ok: false, reason: "This job was cancelled." };
  const live = await liveCorrection(tx, receiptId);
  if (live) return { ok: false, reason: `This receipt's labour was already corrected (${live.correction.correctionCode}). Reverse that correction first to change it again.` };
  const { blocker } = await loadOutputs(tx, receiptId);
  return blocker ? { ok: false, reason: blocker } : { ok: true };
}

export type LabourPlan = {
  plan: CorrectionPlan;
  previousLabour: Decimal;
  correctedLabour: Decimal;
  added: Decimal;
  suggestion: string | null;
  lines: LabourCorrectionLine[];
  receipt: { id: string; receiptCode: string; jobId: string; jobCode: string; manufacturerId: string; manufacturerName: string; processName: string | null };
};

/** Builds the correction plan without writing anything. */
export async function planReceiptLabour(tx: Tx, input: { receiptId: string; correctedLabour: string; reason: string }): Promise<LabourPlan> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10) throw new CorrectionError("Give the reason for correcting this labour (at least 10 characters).");
  const text = String(input.correctedLabour ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new CorrectionError("Enter the corrected labour as an amount in rupees, e.g. 8661.50.");
  const correctedLabour = round2(text);

  const receipt = await loadReceipt(tx, input.receiptId);
  if (!receipt) throw new CorrectionError("Receipt not found.");
  if (receipt.job.status === "CANCELLED") throw new CorrectionError("This job was cancelled, so its labour cannot be corrected.");
  const live = await liveCorrection(tx, receipt.id);
  if (live) {
    throw new CorrectionError(`This receipt's labour was already corrected (${live.correction.correctionCode}). Reverse that correction first to change it again.`);
  }

  const previousLabour = round2(receipt.labourCharge);
  const added = round2(correctedLabour.minus(previousLabour));
  if (!added.greaterThan(0)) {
    throw new CorrectionError(`The corrected labour must be more than the ₹${previousLabour.toFixed(2)} already posted — only additions are supported.`);
  }

  const { outputs, blocker } = await loadOutputs(tx, receipt.id);
  if (blocker) throw new CorrectionError(blocker);

  const split = allocateProportionally(added, outputs.map((o, i) => ({ key: String(i), weight: o.carat })));
  const lines: LabourCorrectionLine[] = outputs.map((o, i) => {
    const share = round2(split.find((s) => s.key === String(i))!.amount);
    return {
      kind: o.kind,
      id: o.id,
      movementId: o.movementId,
      code: o.code,
      carat: o.carat.toFixed(3),
      added: share.toFixed(2),
      costBefore: o.cost.toFixed(2),
      costAfter: round2(o.cost.plus(share)).toFixed(2),
    };
  });

  const impacts: PlannedImpact[] = lines.map((l) =>
    l.kind === "STONE"
      ? { kind: "STOCK", tableName: "polished_diamonds", recordId: l.id, recordLabel: l.code, field: "allocatedCost", oldValue: l.costBefore, newValue: l.costAfter }
      : { kind: "STOCK", tableName: "polished_packet_movements", recordId: l.movementId!, recordLabel: l.code, field: "costValue", oldValue: l.costBefore, newValue: l.costAfter }
  );
  const jobLabour = round2(receipt.job.totalLabourCharge);
  impacts.push({
    kind: "WIP",
    tableName: "diamond_jobs",
    recordId: receipt.job.id,
    recordLabel: receipt.job.jobCode,
    field: "totalLabourCharge",
    oldValue: jobLabour.toFixed(2),
    newValue: round2(jobLabour.plus(added)).toFixed(2),
  });
  const payableBefore = await manufacturerPayable(tx, receipt.job.karigarId);
  impacts.push({
    kind: "PARTY",
    tableName: "parties",
    recordId: receipt.job.karigarId,
    recordLabel: receipt.job.karigar.name,
    field: "payable",
    oldValue: payableBefore.toFixed(2),
    newValue: round2(payableBefore.plus(added)).toFixed(2),
  });

  const label = `${receipt.receiptCode} · ${receipt.job.jobCode}`;
  const ledgerLines: JournalLineInput[] = [
    { accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, debit: added, description: `Labour correction — ${label}` },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: receipt.job.karigarId,
      credit: added,
      description: `Manufacturer labour payable — correction ${label}`,
    },
  ];
  const suggestion = suggestPerIssuedCaratLabour(receipt, receipt.job);

  const plan: CorrectionPlan = {
    entityType: "DIAMOND_RECEIPT",
    entityId: receipt.id,
    entityLabel: `${receipt.receiptCode} — labour corrected`,
    mode: MANUFACTURER_LABOUR_MODE,
    reason,
    originalSnapshot: {
      receiptCode: receipt.receiptCode,
      jobCode: receipt.job.jobCode,
      process: receipt.job.processNameSnapshot,
      chargeRateBasis: receipt.job.chargeRateBasis,
      chargeRate: receipt.job.chargeRate ? new Decimal(receipt.job.chargeRate).toFixed(4) : null,
      totalPolishedCarat: new Decimal(receipt.totalPolishedCarat).toFixed(3),
      weightLossCarat: new Decimal(receipt.weightLossCarat).toFixed(3),
      labourCharge: previousLabour.toFixed(2),
      outputs: lines.map((l) => ({ code: l.code, carat: l.carat, cost: l.costBefore })),
    },
    correctedSnapshot: {
      labourCharge: correctedLabour.toFixed(2),
      added: added.toFixed(2),
      perIssuedCaratSuggestion: suggestion,
      outputs: lines.map((l) => ({ code: l.code, added: l.added, cost: l.costAfter })),
    },
    downstream: [],
    impacts,
    ledgerLines,
    amount: added.toFixed(2),
    voucherNote: `Manufacturer labour corrected on ${label}: ₹${previousLabour.toFixed(2)} → ₹${correctedLabour.toFixed(2)} (${reason})`,
    revaluations: [],
  };

  return {
    plan,
    previousLabour,
    correctedLabour,
    added,
    suggestion,
    lines,
    receipt: {
      id: receipt.id,
      receiptCode: receipt.receiptCode,
      jobId: receipt.job.id,
      jobCode: receipt.job.jobCode,
      manufacturerId: receipt.job.karigarId,
      manufacturerName: receipt.job.karigar.name,
      processName: receipt.job.processNameSnapshot,
    },
  };
}

export function labourPlanFingerprint(plan: CorrectionPlan): string {
  return JSON.stringify(fingerprintPlan(plan));
}

/** Receipt, then its stones, then its packets — one fixed order for post and reverse. */
async function lockReceiptAndOutputs(tx: Tx, receiptId: string): Promise<void> {
  const locked = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "polished_receipts" WHERE id = $1 FOR UPDATE`, receiptId);
  if (locked.length === 0) throw new CorrectionError("Receipt not found.");
  await tx.$queryRawUnsafe(`SELECT id FROM "polished_diamonds" WHERE "receiptId" = $1 ORDER BY id FOR UPDATE`, receiptId);
  await tx.$queryRawUnsafe(`SELECT id FROM "polished_packets" WHERE "sourceReceiptId" = $1 ORDER BY id FOR UPDATE`, receiptId);
}

async function currentCost(tx: Tx, line: LabourCorrectionLine): Promise<Decimal> {
  if (line.kind === "STONE") {
    const s = await tx.polishedDiamond.findUniqueOrThrow({ where: { id: line.id }, select: { allocatedCost: true } });
    return new Decimal(s.allocatedCost);
  }
  const m = await tx.polishedPacketMovement.findUniqueOrThrow({ where: { id: line.movementId! }, select: { costValue: true } });
  return new Decimal(m.costValue);
}

async function applyDelta(tx: Tx, line: LabourCorrectionLine, delta: Decimal): Promise<void> {
  if (line.kind === "STONE") {
    const s = await tx.polishedDiamond.findUniqueOrThrow({ where: { id: line.id }, select: { allocatedCost: true, carat: true } });
    const cost = round2(new Decimal(s.allocatedCost).plus(delta));
    const carat = new Decimal(s.carat);
    await tx.polishedDiamond.update({
      where: { id: line.id },
      data: {
        allocatedCost: cost.toFixed(2),
        costPerCarat: carat.greaterThan(0) ? cost.dividedBy(carat).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) : "0.00",
      },
    });
  } else {
    await tx.polishedPacketMovement.update({ where: { id: line.movementId! }, data: { costValue: { increment: delta.toFixed(2) } } });
  }
}

export type PostReceiptLabourInput = {
  receiptId: string;
  correctedLabour: string;
  reason: string;
  idempotencyKey: string;
  /** The preview fingerprint the Owner saw; posting is refused if the plan no longer matches. */
  expectedFingerprint?: string | null;
  owner: { id: string; role: UserRole };
  fyStartMonth: number;
  fyStartDay: number;
};

export async function postReceiptLabourCorrection(tx: Tx, input: PostReceiptLabourInput) {
  if (input.owner.role !== "OWNER") throw new CorrectionError("Only the Owner can correct Manufacturer labour.");
  if (!input.idempotencyKey?.trim()) throw new CorrectionError("Missing submission key — reload the page and try again.");

  await lockReceiptAndOutputs(tx, input.receiptId);

  // Duplicate submit: same key, same Owner action — return what it already produced.
  const existing = await tx.correction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.entityId !== input.receiptId || existing.mode !== MANUFACTURER_LABOUR_MODE) {
      throw new CorrectionError("This submission key was already used for a different correction.");
    }
    return { correction: existing, replayed: true as const };
  }

  const built = await planReceiptLabour(tx, { receiptId: input.receiptId, correctedLabour: input.correctedLabour, reason: input.reason });
  if (input.expectedFingerprint && input.expectedFingerprint !== labourPlanFingerprint(built.plan)) {
    throw new CorrectionError("The receipt, its outputs or the amounts changed after this preview was shown. Review the new preview and confirm again.");
  }

  const correction = await postCorrection(tx, {
    plan: built.plan,
    preparedByUserId: input.owner.id,
    approvedByUserId: input.owner.id,
    approverRole: input.owner.role,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    idempotencyKey: input.idempotencyKey,
  });

  const link = await tx.diamondReceiptLabourCorrection.create({
    data: {
      correctionId: correction.id,
      receiptId: built.receipt.id,
      jobId: built.receipt.jobId,
      previousLabour: built.previousLabour.toFixed(2),
      addedLabour: built.added.toFixed(2),
      correctedLabour: built.correctedLabour.toFixed(2),
      lines: built.lines as unknown as Prisma.InputJsonValue,
    },
  });

  for (const line of built.lines) await applyDelta(tx, line, new Decimal(line.added));
  await tx.diamondJob.update({ where: { id: built.receipt.jobId }, data: { totalLabourCharge: { increment: built.added.toFixed(2) } } });

  // Prove the effect landed exactly once, or roll everything back.
  for (const line of built.lines) {
    if (!(await currentCost(tx, line)).equals(new Decimal(line.costAfter))) {
      throw new CorrectionError(`Internal check failed on ${line.code}; nothing was saved.`);
    }
  }

  return { correction, replayed: false as const, link, added: built.added };
}

export async function reverseReceiptLabourCorrection(
  tx: Tx,
  input: { correctionId: string; reason: string; owner: { id: string; role: UserRole }; fyStartMonth: number; fyStartDay: number }
) {
  if (input.owner.role !== "OWNER") throw new CorrectionError("Only the Owner can reverse a correction.");
  if (input.reason.trim().length < 10) throw new CorrectionError("Give the reason for reversing this correction (at least 10 characters).");

  const first = await tx.correction.findUnique({ where: { id: input.correctionId }, select: { mode: true, entityId: true } });
  if (!first || first.mode !== MANUFACTURER_LABOUR_MODE) throw new CorrectionError("This is not a Manufacturer labour correction.");
  await lockReceiptAndOutputs(tx, first.entityId);

  const correction = await tx.correction.findUnique({ where: { id: input.correctionId }, include: { diamondLabourCorrection: true } });
  const link = correction?.diamondLabourCorrection;
  if (!correction || !link) throw new CorrectionError("This is not a Manufacturer labour correction.");
  if (correction.state === "REVERSED" || correction.reversedByCorrectionId) throw new CorrectionError("This correction has already been reversed.");
  if (correction.state !== "POSTED") throw new CorrectionError("Only a posted correction can be reversed.");

  const { blocker } = await loadOutputs(tx, link.receiptId);
  if (blocker) throw new CorrectionError(blocker.replace("Labour can only be corrected", "This correction can only be reversed"));
  const lines = link.lines as unknown as LabourCorrectionLine[];
  for (const line of lines) {
    if ((await currentCost(tx, line)).minus(line.added).isNegative()) {
      throw new CorrectionError(`${line.code}'s cost has fallen below the amount this correction added, so it cannot be removed cleanly.`);
    }
  }

  const reversal = await reverseCorrection(tx, {
    correctionId: correction.id,
    reason: input.reason,
    approverRole: input.owner.role,
    approvedByUserId: input.owner.id,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
  });

  for (const line of lines) await applyDelta(tx, line, new Decimal(line.added).negated());
  await tx.diamondJob.update({ where: { id: link.jobId }, data: { totalLabourCharge: { decrement: new Decimal(link.addedLabour).toFixed(2) } } });

  return { reversal, added: new Decimal(link.addedLabour) };
}
