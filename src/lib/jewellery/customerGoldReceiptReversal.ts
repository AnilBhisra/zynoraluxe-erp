import "server-only";

import type { JewelleryJobStatus, MetalType, PolishedDiamondStatus } from "@/generated/prisma/enums";
import { cancelVoucher } from "@/lib/accounting/posting";
import { Decimal, ZERO } from "@/lib/accounting/money";
import type { Tx } from "@/lib/corrections/types";
import { round3 } from "@/lib/diamond/allocation";
import { getPacketBalanceInTx, lockPacketInTx } from "@/lib/diamond/polishedPurchase";
import {
  type Actor,
  CustomerGoldError,
  LOCATION_LABEL,
  type PoolKey,
  assertPoolNonNegative,
  loadPoolInTx,
  lockCustomerGold,
  placeKey,
  scopeOf,
  sumCustomerGoldEntries,
  poolKeyString,
  writeCustomerGoldEntry,
} from "@/lib/jewellery/customerGoldLedger";
import { declareCustodyAware, pendingFineWeightOf } from "@/lib/jewellery/posting";

/**
 * Owner reversal of a posted Customer Gold jewellery receipt
 * (CUSTOMER_GOLD_DESIGN.md §2.6). The receipt is never edited or deleted:
 *
 *   - every Customer Gold entry it wrote (and the receipt-time allocation onto
 *     the job) gets a mirror entry, newest first;
 *   - its posting voucher (1340 / 1330 / WIP / Karigar payable / stones) gets
 *     the standard mirror voucher;
 *   - its pieces become RECEIPT_REVERSED; diamonds and packet stones it
 *     resolved go back to the job;
 *   - the job returns exactly to the state captured before the receipt.
 *
 * A receipt is reversible only when NOTHING depends on it: it is the job's
 * newest live receipt, its pieces are still awaiting delivery and unbilled,
 * the job and the Customer's gold have not moved on in a way that needs it,
 * and it moved no Company metal into stock or scrap. Every refusal names the
 * exact dependency. A correction is this reversal followed by a new receipt.
 */

const COUNTERS = [
  ["receivedFineWeight", 3],
  ["returnedMetalFineWeight", 3],
  ["scrapFineWeight", 3],
  ["karigarAddedFineWeight", 3],
  ["karigarAddedCost", 2],
  ["consumedAlloyGrossWeight", 3],
  ["returnedAlloyGrossWeight", 3],
  ["remainingAlloyWipCost", 2],
  ["totalLabourCharge", 2],
  ["remainingWipCost", 2],
] as const;
type CounterName = (typeof COUNTERS)[number][0];
export type ReversalJobState = Record<CounterName, string> & { status: JewelleryJobStatus };

export type ReceiptReversalSnapshot = {
  version: 1;
  pool: { customerId: string; metalType: MetalType; purityId: string; finenessPercent: string };
  jobBefore: ReversalJobState;
  jobAfter: ReversalJobState;
  priorOutputs: { id: string; before: { otherMaterialCost: string; totalCost: string }; after: { otherMaterialCost: string; totalCost: string } }[];
  /** Receipt-time allocation entries (written before the receipt existed). */
  allocationEntryIds: string[];
  diamonds: { issueLineId: string; polishedDiamondId: string; resolution: "SET" | "RETURNED" | "DAMAGED_LOST"; statusBefore: PolishedDiamondStatus }[];
};

type JobRow = Record<CounterName, unknown> & { status: JewelleryJobStatus };

export function jobStateOf(job: JobRow): ReversalJobState {
  const state = { status: job.status } as ReversalJobState;
  for (const [name, dp] of COUNTERS) state[name] = new Decimal(String(job[name] ?? 0)).toFixed(dp);
  return state;
}

function changedCounters(current: ReversalJobState, expected: ReversalJobState): string[] {
  const out: string[] = [];
  for (const [name] of COUNTERS) if (current[name] !== expected[name]) out.push(`${name} ${expected[name]} → ${current[name]}`);
  if (current.status !== expected.status) out.push(`status ${expected.status} → ${current.status}`);
  return out;
}

function requireOwner(actor: Actor) {
  if (actor.role !== "OWNER") throw new CustomerGoldError("Only the Owner can reverse a jewellery receipt.");
}

export type ReceiptReversalPlan = {
  receiptId: string;
  receiptCode: string;
  jobId: string;
  jobCode: string;
  customerName: string;
  blockers: string[];
  pieces: { id: string; finishedCode: string; customerGoldFineWeight: string }[];
  /** Customer gold that goes back, per place (fine / gross). */
  goldBack: { label: string; fine: string; gross: string }[];
  diamondsBack: string[];
  packetStonesBack: { packetCode: string; pieces: number; carat: string; disposition: string }[];
  voucher: { number: string; lines: { account: string; debit: string; credit: string }[] } | null;
  jobStatusAfter: JewelleryJobStatus;
  jobPendingFineAfter: string;
};

/** What reversing this receipt would do, and every reason it cannot be done (Owner only — carries voucher amounts). */
export async function planCustomerGoldReceiptReversal(tx: Tx, receiptId: string): Promise<ReceiptReversalPlan> {
  const receipt = await tx.jewelleryReceipt.findUnique({
    where: { id: receiptId },
    include: {
      job: { include: { customer: true, karigar: true } },
      outputs: { include: { customerDeliveryItems: { include: { delivery: true } } } },
      reversedBy: { select: { name: true } },
      packetResolutions: { include: { issueLine: { include: { packet: true } } } },
      postingVoucher: { include: { journalEntries: { include: { account: true } } } },
    },
  });
  if (!receipt) throw new CustomerGoldError("Receipt not found.");
  const job = receipt.job;
  const code = receipt.receiptCode;
  const blockers: string[] = [];
  const snap = receipt.reversalSnapshot as ReceiptReversalSnapshot | null;

  const base = {
    receiptId: receipt.id,
    receiptCode: code,
    jobId: job.id,
    jobCode: job.jobCode,
    customerName: job.customer?.name ?? "",
  };
  if (!snap || snap.version !== 1) {
    return {
      ...base,
      blockers: [`${code} did not receive Customer-owned gold, so it has no reversal record. Company receipts are corrected through Corrections, not reversed here.`],
      pieces: [],
      goldBack: [],
      diamondsBack: [],
      packetStonesBack: [],
      voucher: null,
      jobStatusAfter: job.status,
      jobPendingFineAfter: pendingFineWeightOf(job).toFixed(3),
    };
  }
  if (receipt.reversedAt) {
    blockers.push(`${code} was already reversed on ${receipt.reversedAt.toISOString().slice(0, 10)} by ${receipt.reversedBy?.name ?? "the Owner"}.`);
  }

  // 1. Newest first on the job.
  const laterReceipts = await tx.jewelleryReceipt.findMany({
    where: { jobId: job.id, reversedAt: null, createdAt: { gt: receipt.createdAt } },
    orderBy: { createdAt: "desc" },
  });
  for (const r of laterReceipts) blockers.push(`${r.receiptCode} was recorded on ${job.jobCode} after ${code} — reverse it first (newest first).`);

  // 2. The pieces: still awaiting delivery, never Company stock, never moved.
  for (const p of receipt.outputs) {
    if (p.ownership !== "CUSTOMER") {
      blockers.push(`${p.finishedCode} is Company Finished Stock — a receipt that created Company stock is not reversed here.`);
      continue;
    }
    const liveDelivery = p.customerDeliveryItems.find((i) => i.delivery.status === "POSTED");
    if (liveDelivery) blockers.push(`${p.finishedCode} was delivered to the Customer in ${liveDelivery.delivery.deliveryCode} — reverse that delivery first.`);
    else if (p.status !== "CUSTOMER_AWAITING_DELIVERY" && !receipt.reversedAt) blockers.push(`${p.finishedCode} is ${p.status.replace(/_/g, " ").toLowerCase()}, not awaiting delivery.`);
    const moves = await tx.finishedJewelleryStockMovement.count({ where: { finishedJewelleryId: p.id } });
    if (moves > 0) blockers.push(`${p.finishedCode} has ${moves} finished-stock movement(s) (sold / adjusted) — it cannot be un-made.`);
  }

  // 3. Billing: a posted bill covers this job's Customer jewellery.
  const bills = await tx.customerJewelleryBill.findMany({ where: { jobId: job.id, status: "POSTED" } });
  for (const b of bills) blockers.push(`Bill ${b.billCode} is posted for ${job.jobCode}'s Customer jewellery — reverse the bill first.`);

  // 4. Charges added to this receipt later.
  const chargeCorrections = await tx.jewelleryReceiptChargeCorrection.findMany({
    where: { receiptId: receipt.id, correction: { state: "POSTED" } },
    include: { correction: true },
  });
  for (const c of chargeCorrections) blockers.push(`Charge correction ${c.correction.correctionCode} added ₹${new Decimal(c.totalCharge).toFixed(2)} to ${code} — roll it back first.`);

  // 5. Company metal this receipt put into stock / scrap pools cannot be un-returned by a reversal.
  const companyMoves = await tx.metalStockMovement.findMany({ where: { sourceDocument: code, jewelleryJobId: job.id }, include: { purity: true } });
  for (const m of companyMoves.filter((m) => m.type === "RETURN_IN" || m.type === "SCRAP_RETURN_IN")) {
    blockers.push(
      `${code} returned ${new Decimal(m.grossWeight).toFixed(3)} g ${m.purity.displayName} Company ${m.type === "RETURN_IN" ? "metal to stock" : "scrap to the scrap pool"}. A receipt that moved Company metal into stock is not reversible; correct the Company side through Corrections.`
    );
  }
  // 6. Company metal consumed by this receipt whose purity has since been revalued.
  const consumedPurities = [...new Set(companyMoves.filter((m) => m.type === "CONSUMED_OUT").map((m) => m.purityId))];
  if (consumedPurities.length) {
    const revals = await tx.metalRevaluation.findMany({ where: { purityId: { in: consumedPurities }, correction: { state: "POSTED" } }, include: { correction: true, purity: true }, take: 3 });
    for (const r of revals) blockers.push(`Company ${r.purity.displayName} has a posted revaluation (${r.correction.correctionCode}) — reversing ${code}'s Company gold cost would bypass it.`);
  }
  const pieceIds = receipt.outputs.map((o) => o.id);
  const laterRevals = await tx.metalRevaluation.findMany({
    where: { OR: [{ jewelleryJobId: job.id }, { finishedJewelleryId: { in: pieceIds } }], createdAt: { gt: receipt.createdAt }, correction: { state: "POSTED" } },
    include: { correction: true },
    take: 3,
  });
  for (const r of laterRevals) blockers.push(`Revaluation ${r.correction.correctionCode} restated ${job.jobCode} after ${code} — roll it back first.`);

  // 7. The job must be exactly as this receipt left it.
  if (!receipt.reversedAt) {
    const changes = changedCounters(jobStateOf(job as unknown as JobRow), snap.jobAfter);
    if (changes.length) {
      const [issues, custody, transfers, cgOnJob] = await Promise.all([
        tx.jewelleryMetalIssueLine.count({ where: { jobId: job.id, createdAt: { gt: receipt.createdAt } } }),
        tx.karigarMetalCustodyEntry.findMany({ where: { jobId: job.id, createdAt: { gt: receipt.createdAt } }, take: 3 }),
        tx.jewelleryMetalTransfer.findMany({ where: { OR: [{ sourceJobId: job.id }, { destinationJobId: job.id }], createdAt: { gt: receipt.createdAt } }, take: 3 }),
        tx.customerGoldEntry.findMany({ where: { jobId: job.id, createdAt: { gt: receipt.createdAt }, jewelleryReceiptId: null, reversalOfEntryId: null }, take: 3 }),
      ]);
      const docs = [
        issues ? `${issues} metal issue line(s)` : null,
        ...custody.map((c) => `Karigar Metal entry ${c.entryCode}`),
        ...transfers.map((t) => `metal transfer ${t.transferCode}`),
        ...cgOnJob.map((e) => `Customer gold entry ${e.entryCode}`),
      ].filter(Boolean);
      blockers.push(
        `${job.jobCode} changed after ${code}${docs.length ? ` (${docs.join(", ")})` : ""}: ${changes.join("; ")}. Undo the later change first${job.status === "NEEDS_CORRECTION" ? " (clear Needs Correction)" : ""}.`
      );
    }
    for (const p of snap.priorOutputs) {
      const row = await tx.finishedJewellery.findUnique({ where: { id: p.id }, select: { finishedCode: true, otherMaterialCost: true, totalCost: true } });
      if (!row || new Decimal(row.otherMaterialCost).toFixed(2) !== p.after.otherMaterialCost || new Decimal(row.totalCost).toFixed(2) !== p.after.totalCost) {
        blockers.push(`${row?.finishedCode ?? "An earlier piece"}'s cost changed after ${code} — undo that change first.`);
      }
    }
  }

  // 8. Diamonds this receipt resolved must still be exactly where it put them.
  const diamondsBack: string[] = [];
  for (const d of snap.diamonds) {
    const diamond = await tx.polishedDiamond.findUnique({ where: { id: d.polishedDiamondId } });
    const line = await tx.jewelleryDiamondIssueLine.findUnique({ where: { id: d.issueLineId } });
    if (!diamond || !line) {
      blockers.push("A diamond resolved by this receipt no longer exists.");
      continue;
    }
    diamondsBack.push(`${diamond.polishedCode} (${d.resolution.replace("_", "/").toLowerCase()})`);
    if (receipt.reversedAt) continue;
    const expected = d.resolution === "SET" ? "SET_IN_JEWELLERY" : d.resolution === "RETURNED" ? "AVAILABLE" : "DAMAGED_LOST";
    if (diamond.status !== expected || line.resolvedAs !== d.resolution) {
      blockers.push(`Diamond ${diamond.polishedCode} is now ${diamond.status.replace(/_/g, " ").toLowerCase()} — it was used after ${code}.`);
    } else {
      const laterMoves = await tx.stockMovement.findMany({ where: { polishedDiamondId: diamond.id, createdAt: { gt: receipt.createdAt }, NOT: { sourceDocument: code } }, take: 1 });
      if (laterMoves.length) blockers.push(`Diamond ${diamond.polishedCode} moved again after ${code} (${laterMoves[0].type} ${laterMoves[0].sourceDocument}) — undo that first.`);
    }
  }

  // 9. Packet stones returned to their packet must still be there.
  const packetStonesBack: ReceiptReversalPlan["packetStonesBack"] = [];
  for (const r of receipt.packetResolutions) {
    packetStonesBack.push({ packetCode: r.issueLine.packet.packetCode, pieces: r.pieces, carat: new Decimal(r.carat).toFixed(3), disposition: r.disposition });
    if (r.disposition !== "RETURNED" || receipt.reversedAt) continue;
    const later = await tx.polishedPacketMovement.findMany({ where: { packetId: r.issueLine.packetId, createdAt: { gt: receipt.createdAt }, NOT: { sourceDocument: code } }, take: 1 });
    if (later.length) blockers.push(`Packet ${r.issueLine.packet.packetCode} was used after ${code} (${later[0].type} ${later[0].sourceDocument}) — the returned stones cannot be taken back.`);
  }

  // 10. The Customer's gold: simulate the mirror entries and name whatever later use a place is needed by.
  const pool: PoolKey = { customerId: snap.pool.customerId, metalType: snap.pool.metalType, purityId: snap.pool.purityId, finenessPercentSnapshot: new Decimal(snap.pool.finenessPercent) };
  const receiptEntries = await tx.customerGoldEntry.findMany({
    where: { OR: [{ jewelleryReceiptId: receipt.id, reversalOfEntryId: null }, { id: { in: snap.allocationEntryIds } }] },
    include: { reversedBy: true },
    orderBy: { createdAt: "desc" },
  });
  const goldBackMap = new Map<string, { label: string; fine: Decimal; gross: Decimal }>();
  if (!receipt.reversedAt) {
    for (const e of receiptEntries) if (e.reversedBy) blockers.push(`Customer gold entry ${e.entryCode} of this receipt was already reversed by ${e.reversedBy.entryCode}.`);
    const all = await tx.customerGoldEntry.findMany({ where: { customerId: pool.customerId, metalType: pool.metalType, purityId: pool.purityId, finenessPercentSnapshot: pool.finenessPercentSnapshot.toFixed(3) } });
    const simulated = [...all, ...receiptEntries.map((e) => ({ ...e, id: `sim-${e.id}`, reversalOfEntryId: e.id }))];
    const after = sumCustomerGoldEntries(simulated).get(poolKeyString({ ...pool, finenessPercentSnapshot: pool.finenessPercentSnapshot }));
    for (const place of after?.places.values() ?? []) {
      if (place.location === "CUSTOMER" || !place.fine.isNegative()) continue;
      const users = all.filter(
        (e) => e.createdAt > receipt.createdAt && !e.reversalOfEntryId && e.fromLocation === place.location && scopeOf(e.fromLocation, e) === place.scopeId && !receiptEntries.some((r) => r.id === e.id)
      );
      blockers.push(
        `${base.customerName}'s gold ${LOCATION_LABEL[place.location].toLowerCase()} would go to ${place.fine.toFixed(3)} g fine: it was used after ${code}${users.length ? ` by ${users.slice(0, 3).map((u) => u.entryCode).join(", ")}` : ""}. Reverse that first.`
      );
    }
    for (const e of receiptEntries) {
      // A mirror entry puts the weight back at the entry's FROM place.
      const from = { location: e.fromLocation, scopeId: scopeOf(e.fromLocation, e) };
      if (from.location === "JOB") continue;
      const k = placeKey(from);
      const cur = goldBackMap.get(k) ?? { label: LOCATION_LABEL[from.location], fine: ZERO, gross: ZERO };
      cur.fine = round3(cur.fine.plus(e.fineWeight));
      cur.gross = round3(cur.gross.plus(e.grossWeight));
      goldBackMap.set(k, cur);
    }
    // Returns / scrap / loss are taken back OUT of where they went.
    for (const e of receiptEntries.filter((x) => x.fromLocation === "JOB" && x.toLocation !== "FINISHED")) {
      const to = { location: e.toLocation, scopeId: scopeOf(e.toLocation, e) };
      const k = `undo:${placeKey(to)}`;
      const cur = goldBackMap.get(k) ?? { label: `taken back from ${LOCATION_LABEL[to.location].toLowerCase()}`, fine: ZERO, gross: ZERO };
      cur.fine = round3(cur.fine.minus(e.fineWeight));
      cur.gross = round3(cur.gross.minus(e.grossWeight));
      goldBackMap.set(k, cur);
    }
  }

  const jobBefore = snap.jobBefore;
  return {
    ...base,
    blockers,
    pieces: receipt.outputs.map((o) => ({ id: o.id, finishedCode: o.finishedCode, customerGoldFineWeight: new Decimal(o.customerGoldFineWeight).toFixed(3) })),
    goldBack: [...goldBackMap.values()].map((g) => ({ label: g.label, fine: g.fine.toFixed(3), gross: g.gross.toFixed(3) })),
    diamondsBack,
    packetStonesBack,
    voucher: receipt.postingVoucher
      ? {
          number: receipt.postingVoucher.voucherNumber,
          lines: receipt.postingVoucher.journalEntries.map((j) => ({ account: `${j.account.code} ${j.account.name}`, debit: new Decimal(j.credit).toFixed(2), credit: new Decimal(j.debit).toFixed(2) })),
        }
      : null,
    jobStatusAfter: jobBefore.status,
    jobPendingFineAfter: pendingFineWeightOf({ ...job, ...Object.fromEntries(COUNTERS.map(([n]) => [n, jobBefore[n]])) } as never).toFixed(3),
  };
}

export async function reverseCustomerGoldJobReceipt(
  tx: Tx,
  input: { receiptId: string; reason: string; idempotencyKey: string; actor: Actor; fyStartMonth: number; fyStartDay: number }
) {
  requireOwner(input.actor);
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10) throw new CustomerGoldError("Give the reason for reversing (at least 10 characters).");
  if (!input.idempotencyKey?.trim()) throw new CustomerGoldError("Missing submission key — reload the page and try again.");
  const replay = await tx.jewelleryReceipt.findUnique({ where: { reversalIdempotencyKey: input.idempotencyKey } });
  if (replay) return { replayed: true as const, receipt: replay };

  const first = await tx.jewelleryReceipt.findUnique({ where: { id: input.receiptId }, include: { job: true } });
  if (!first) throw new CustomerGoldError("Receipt not found.");
  const snap = first.reversalSnapshot as ReceiptReversalSnapshot | null;
  if (snap) await lockCustomerGold(tx, { purityId: snap.pool.purityId, customerId: snap.pool.customerId, karigarId: first.job.karigarId, jobId: first.jobId });
  await tx.$queryRawUnsafe(`SELECT id FROM "jewellery_receipts" WHERE id = $1 FOR UPDATE`, first.id);
  await declareCustodyAware(tx);

  const plan = await planCustomerGoldReceiptReversal(tx, first.id);
  if (plan.blockers.length) throw new CustomerGoldError(`Cannot reverse ${plan.receiptCode}: ${plan.blockers.join(" ")}`);
  const receipt = await tx.jewelleryReceipt.findUniqueOrThrow({ where: { id: first.id }, include: { outputs: true, packetResolutions: { include: { issueLine: true } } } });
  const s = receipt.reversalSnapshot as ReceiptReversalSnapshot;
  const label = `Reversal of ${receipt.receiptCode}: ${reason}`;
  const now = new Date();

  // 1. Accounting: the standard mirror voucher (1340 / 1330 / WIP / Karigar payable / stones).
  const reversalVoucher = receipt.postingVoucherId
    ? await cancelVoucher(tx, { voucherId: receipt.postingVoucherId, cancelledByUserId: input.actor.id, cancellationReason: label, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay })
    : null;

  // 2. The Customer's gold: a mirror for every entry, newest first; proven non-negative once, at the end.
  const pool: PoolKey = { customerId: s.pool.customerId, metalType: s.pool.metalType, purityId: s.pool.purityId, finenessPercentSnapshot: new Decimal(s.pool.finenessPercent) };
  const entries = await tx.customerGoldEntry.findMany({
    where: { OR: [{ jewelleryReceiptId: receipt.id, reversalOfEntryId: null }, { id: { in: s.allocationEntryIds } }] },
    orderBy: [{ createdAt: "desc" }, { entryCode: "desc" }],
  });
  for (const e of entries) {
    await writeCustomerGoldEntry(tx, {
      kind: e.kind,
      pool,
      from: { location: e.fromLocation, scopeId: scopeOf(e.fromLocation, e) },
      to: { location: e.toLocation, scopeId: scopeOf(e.toLocation, e) },
      gross: new Decimal(e.grossWeight),
      fine: new Decimal(e.fineWeight),
      entryDate: now,
      reason: label,
      reference: e.entryCode,
      karigarId: e.karigarId,
      jobId: e.jobId,
      finishedJewelleryId: e.finishedJewelleryId,
      jewelleryReceiptId: receipt.id,
      reversalOfEntryId: e.id,
      createdByUserId: input.actor.id,
      deferBalanceCheck: true,
    });
  }
  await assertPoolNonNegative(tx, pool);

  // 3. The pieces no longer exist (kept, never deleted, for the audit trail).
  await tx.finishedJewellery.updateMany({ where: { receiptId: receipt.id }, data: { status: "RECEIPT_REVERSED" } });

  // 4. Diamonds back with the job.
  for (const d of s.diamonds) {
    const line = await tx.jewelleryDiamondIssueLine.update({
      where: { id: d.issueLineId },
      data: { resolvedAs: null, resolvedAt: null, setInFinishedJewelleryId: null },
    });
    await tx.polishedDiamond.update({
      where: { id: d.polishedDiamondId },
      data: { status: d.statusBefore, ...(d.resolution === "DAMAGED_LOST" ? { damagedLostAt: null, damagedLostByUserId: null, damagedLostReason: null } : {}) },
    });
    await tx.stockMovement.create({
      data: {
        type: "JEWELLERY_RECEIPT_REVERSAL_IN",
        polishedDiamondId: d.polishedDiamondId,
        jewelleryJobId: receipt.jobId,
        pieces: 1,
        carat: line.caratAtIssue,
        costValue: line.costAtIssue,
        sourceDocument: receipt.receiptCode,
        createdByUserId: input.actor.id,
      },
    });
  }

  // 5. Packet stones back with the job: counters down; returned stones leave their packet again.
  for (const r of receipt.packetResolutions) {
    const counters =
      r.disposition === "SET"
        ? { setPieces: { decrement: r.pieces }, setCarat: { decrement: r.carat }, setCost: { decrement: r.costValue } }
        : r.disposition === "RETURNED"
          ? { returnedPieces: { decrement: r.pieces }, returnedCarat: { decrement: r.carat }, returnedCost: { decrement: r.costValue } }
          : { damagedPieces: { decrement: r.pieces }, damagedCarat: { decrement: r.carat }, damagedCost: { decrement: r.costValue } };
    await tx.jewelleryPacketIssueLine.update({ where: { id: r.issueLineId }, data: counters });
    if (r.disposition === "RETURNED") {
      const packetId = r.resultPacketId ?? r.issueLine.packetId;
      if (!(await lockPacketInTx(tx, packetId, ["ACTIVE", "EMPTY"]))) throw new CustomerGoldError("A packet the stones went back into is no longer active. Nothing was saved.");
      const balance = await getPacketBalanceInTx(tx, packetId);
      if (balance.pieces < r.pieces || balance.carat.lessThan(new Decimal(String(r.carat)))) throw new CustomerGoldError("The returned packet stones are no longer in their packet. Nothing was saved.");
      await tx.polishedPacketMovement.create({
        data: {
          type: "JEWELLERY_ISSUE_OUT",
          packetId,
          pieces: r.pieces,
          carat: r.carat,
          costValue: r.costValue,
          sourceDocument: receipt.receiptCode,
          jewelleryJobId: receipt.jobId,
          createdByUserId: input.actor.id,
        },
      });
      if (balance.pieces === r.pieces && balance.carat.equals(new Decimal(String(r.carat)))) await tx.polishedPacket.update({ where: { id: packetId }, data: { status: "EMPTY" } });
    }
    await tx.jewelleryPacketResolution.update({ where: { id: r.id }, data: { reversedAt: now } });
  }

  // 6. The job exactly as before the receipt; earlier pieces' shared material cost as before.
  const data: Record<string, string> = {};
  for (const [name] of COUNTERS) data[name] = s.jobBefore[name];
  await tx.jewelleryJob.update({ where: { id: receipt.jobId }, data: { ...data, status: s.jobBefore.status } });
  for (const p of s.priorOutputs) {
    await tx.finishedJewellery.update({ where: { id: p.id }, data: { otherMaterialCost: p.before.otherMaterialCost, totalCost: p.before.totalCost } });
  }

  // 7. The receipt records who reversed it, when and why — nothing else about it changes.
  const reversed = await tx.jewelleryReceipt.update({
    where: { id: receipt.id },
    data: { reversedAt: now, reversedByUserId: input.actor.id, reversalReason: reason, reversalVoucherId: reversalVoucher?.id ?? null, reversalIdempotencyKey: input.idempotencyKey },
  });

  // 8. Proven, not assumed.
  const jobNow = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: receipt.jobId } });
  if (changedCounters(jobStateOf(jobNow as unknown as JobRow), s.jobBefore).length) throw new CustomerGoldError("Internal check failed: the job did not return to its state before the receipt. Nothing was saved.");
  const poolNow = await loadPoolInTx(tx, pool);
  for (const piece of receipt.outputs) {
    const p = poolNow?.places.get(placeKey({ location: "FINISHED", scopeId: piece.id }));
    if (p && !p.fine.isZero()) throw new CustomerGoldError("Internal check failed: a reversed piece still holds Customer gold. Nothing was saved.");
  }
  return { replayed: false as const, receipt: reversed, plan };
}
