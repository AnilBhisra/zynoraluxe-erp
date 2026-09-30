import "server-only";

import { createHmac } from "node:crypto";

import type { CustomerGoldEntryKind, CustomerGoldInputBasis, MetalType } from "@/generated/prisma/enums";
import { Decimal, type DecimalInput, ZERO } from "@/lib/accounting/money";
import type { Tx } from "@/lib/corrections/types";
import { round3 } from "@/lib/diamond/allocation";
import {
  type Actor,
  CustomerGoldError,
  ENTRY_KIND_LABEL,
  LOCATION_LABEL,
  type Place,
  type PoolKey,
  type WeightPair,
  customerGoldOnJobInTx,
  d3,
  fineOf,
  grossForFine,
  loadPoolInTx,
  lockCustomerGold,
  placeBalance,
  scopeOf,
  shareOf,
  writeCustomerGoldEntry,
} from "@/lib/jewellery/customerGoldLedger";
import { nextJewelleryCode } from "@/lib/jewellery/numbering";

/**
 * Customer Gold operations (CUSTOMER_GOLD_DESIGN.md). Everything here moves
 * weight inside the Customer Gold ledger only: no voucher, no Company stock
 * movement, no cost. Owner-only; the one Staff path (receiving jewellery made
 * from Customer gold) lives in customerGoldJobReceipt.ts.
 */

export { CustomerGoldError };

function requireOwner(actor: Actor, what: string) {
  if (actor.role !== "OWNER") throw new CustomerGoldError(`Only the Owner can ${what}.`);
}
function requireReason(reason: string | null | undefined, min = 3): string {
  const r = reason?.trim() ?? "";
  if (r.length < min) throw new CustomerGoldError(min >= 10 ? `Give the reason (at least ${min} characters).` : "Give a short reason.");
  return r;
}

/** Opaque, keyed fingerprint of everything a preview showed (never reveals the figures). */
export function opaqueFingerprint(label: string, figures: unknown): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set. Copy .env.example to .env and generate one with `openssl rand -base64 32`.");
  return createHmac("sha256", secret).update(`${label}:${JSON.stringify(figures)}`).digest("hex");
}

const OPEN_JOB_STATUSES = ["DRAFT", "MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"] as const;

// ---------------------------------------------------------------------------
// A. Intake — "Customer-owned gold — for manufacturing"
// ---------------------------------------------------------------------------

export type CustomerGoldIntakeInput = {
  customerId: string;
  intakeDate: Date;
  purityId: string;
  inputBasis: CustomerGoldInputBasis;
  /** GROSS: the weight as weighed (before deduction). FINE: the fine weight. */
  weight: DecimalInput;
  deductionWeight?: DecimalInput | null;
  reference?: string | null;
  reason: string;
  photoAssetId?: string | null;
  declaredValue?: DecimalInput | null;
  idempotencyKey: string;
  actor: Actor;
};

export type CustomerGoldIntakePlan = {
  customerName: string;
  metalType: MetalType;
  purityDisplayName: string;
  finenessPercent: Decimal;
  grossWeight: Decimal;
  deductionWeight: Decimal;
  netGrossWeight: Decimal;
  fineWeight: Decimal;
};

export async function planCustomerGoldIntake(tx: Tx, input: Omit<CustomerGoldIntakeInput, "idempotencyKey" | "actor">): Promise<CustomerGoldIntakePlan> {
  const customer = await tx.party.findUnique({ where: { id: input.customerId } });
  if (!customer || customer.type !== "CUSTOMER") throw new CustomerGoldError("Choose the Customer whose gold this is.");
  const purity = await tx.metalPurity.findUnique({ where: { id: input.purityId } });
  if (!purity || !purity.isActive) throw new CustomerGoldError("That metal purity was not found or is inactive.");
  if (purity.metalType === "ALLOY") throw new CustomerGoldError("Copper/Alloy is not held as Customer gold.");
  const fineness = new Decimal(purity.finenessPercent);
  if (!fineness.greaterThan(0)) throw new CustomerGoldError("That purity has no fineness.");
  const weight = d3(input.weight);
  const deduction = d3(input.deductionWeight);
  if (!weight.greaterThan(0)) throw new CustomerGoldError("Enter the weight received.");
  if (deduction.isNegative()) throw new CustomerGoldError("Deduction cannot be negative.");
  let gross: Decimal;
  let net: Decimal;
  let fine: Decimal;
  if (input.inputBasis === "GROSS") {
    gross = weight;
    net = round3(gross.minus(deduction));
    if (!net.greaterThan(0)) throw new CustomerGoldError("The stone/dust deduction leaves no metal.");
    fine = fineOf(net, fineness);
  } else {
    fine = weight;
    net = grossForFine(fine, fineness);
    gross = round3(net.plus(deduction));
  }
  return {
    customerName: customer.name,
    metalType: purity.metalType,
    purityDisplayName: purity.displayName,
    finenessPercent: fineness,
    grossWeight: gross,
    deductionWeight: deduction,
    netGrossWeight: net,
    fineWeight: fine,
  };
}

/** Owner only. Records the Customer's gold in custody: no voucher, no Company stock, no payable, no cost. */
export async function receiveCustomerGold(tx: Tx, input: CustomerGoldIntakeInput) {
  requireOwner(input.actor, "record gold received from a Customer");
  const reason = requireReason(input.reason);
  if (!input.idempotencyKey?.trim()) throw new CustomerGoldError("Missing submission key — reload the page and try again.");
  const existing = await tx.customerGoldReceipt.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { receipt: existing, replayed: true as const };
  if (input.declaredValue != null && String(input.declaredValue).trim() !== "" && new Decimal(input.declaredValue).isNegative()) {
    throw new CustomerGoldError("Declared value cannot be negative.");
  }
  await lockCustomerGold(tx, { purityId: input.purityId, customerId: input.customerId });
  const plan = await planCustomerGoldIntake(tx, input);
  const receiptCode = await nextJewelleryCode(tx, "CUSTOMER_GOLD_RECEIPT");
  const receipt = await tx.customerGoldReceipt.create({
    data: {
      receiptCode,
      customerId: input.customerId,
      intakeDate: input.intakeDate,
      metalType: plan.metalType,
      purityId: input.purityId,
      finenessPercentSnapshot: plan.finenessPercent.toFixed(3),
      inputBasis: input.inputBasis,
      grossWeight: plan.grossWeight.toFixed(3),
      deductionWeight: plan.deductionWeight.toFixed(3),
      netGrossWeight: plan.netGrossWeight.toFixed(3),
      fineWeight: plan.fineWeight.toFixed(3),
      reference: input.reference?.trim() || null,
      reason,
      photoAssetId: input.photoAssetId || null,
      declaredValue: input.declaredValue != null && String(input.declaredValue).trim() !== "" ? new Decimal(input.declaredValue).toFixed(2) : null,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.actor.id,
    },
  });
  await writeCustomerGoldEntry(tx, {
    kind: "INTAKE",
    pool: { customerId: input.customerId, metalType: plan.metalType, purityId: input.purityId, finenessPercentSnapshot: plan.finenessPercent },
    from: { location: "CUSTOMER", scopeId: null },
    to: { location: "SAFE", scopeId: null },
    gross: plan.netGrossWeight,
    fine: plan.fineWeight,
    entryDate: input.intakeDate,
    reason,
    reference: receiptCode,
    customerGoldReceiptId: receipt.id,
    createdByUserId: input.actor.id,
  });
  return { receipt, replayed: false as const };
}

// ---------------------------------------------------------------------------
// B. Movements between places (Owner)
// ---------------------------------------------------------------------------

export const TRANSFER_KINDS = [
  "ISSUE_TO_KARIGAR",
  "RETURN_FROM_KARIGAR",
  "ALLOCATE_TO_JOB",
  "RELEASE_FROM_JOB",
  "RETURN_TO_CUSTOMER",
  "SCRAP_RETURN_TO_CUSTOMER",
] as const;
export type CustomerGoldTransferKind = (typeof TRANSFER_KINDS)[number];

export type CustomerGoldTransferInput = {
  kind: CustomerGoldTransferKind;
  customerId: string;
  purityId: string;
  /** Fineness snapshot of the Customer's pool (a Customer may hold one purity at two tested finenesses). */
  finenessPercent: DecimalInput;
  karigarId?: string | null;
  jobId?: string | null;
  /** Exactly one of: gross, fine, all. */
  grossWeight?: DecimalInput | null;
  fineWeight?: DecimalInput | null;
  all?: boolean;
  entryDate: Date;
  reason: string;
  reference?: string | null;
};

export type CustomerGoldTransferPlan = {
  kind: CustomerGoldTransferKind;
  pool: PoolKey;
  customerName: string;
  purityDisplayName: string;
  from: Place;
  to: Place;
  fromLabel: string;
  toLabel: string;
  moved: WeightPair;
  fromBefore: WeightPair;
  fromAfter: WeightPair;
  toBefore: WeightPair;
  toAfter: WeightPair;
  jobCode: string | null;
  karigarName: string | null;
  setsJobMaterialsIssued: boolean;
};

async function jobCompanyFineMetal(tx: Tx, jobId: string) {
  return tx.jewelleryMetalIssueLine.findMany({ where: { jobId, metalType: { not: "ALLOY" } } });
}

/**
 * Can this Customer's pool go onto this job? One Customer pool per job, only
 * the job's own Customer, and Company gold on the same job only with the
 * Owner's recorded approval and the same purity + fineness.
 */
export async function assertCustomerGoldAllowedOnJob(tx: Tx, jobId: string, pool: PoolKey) {
  const job = await tx.jewelleryJob.findUnique({ where: { id: jobId }, include: { customer: true } });
  if (!job) throw new CustomerGoldError("Job not found.");
  if (!job.customerId) throw new CustomerGoldError(`${job.jobCode} has no Customer. Customer gold can only go to that Customer's own job.`);
  if (job.customerId !== pool.customerId) {
    throw new CustomerGoldError(`${job.jobCode} belongs to ${job.customer?.name ?? "another Customer"} — one Customer's gold can never be used on another Customer's job.`);
  }
  if (!(OPEN_JOB_STATUSES as readonly string[]).includes(job.status)) throw new CustomerGoldError(`${job.jobCode} is ${job.status.replace(/_/g, " ").toLowerCase()}.`);
  const onJob = await customerGoldOnJobInTx(tx, jobId);
  const otherPool = onJob.find((p) => p.purityId !== pool.purityId || !p.finenessPercentSnapshot.equals(pool.finenessPercentSnapshot) || p.customerId !== pool.customerId);
  if (otherPool) throw new CustomerGoldError(`${job.jobCode} already holds this Customer's gold of another purity/fineness — one Customer gold pool per job.`);
  const company = await jobCompanyFineMetal(tx, jobId);
  if (company.length > 0) {
    if (!job.customerGoldMixApprovedAt) {
      throw new CustomerGoldError(`${job.jobCode} already holds Company gold. Mixing Customer and Company gold on one job needs the Owner's approval first (job page → Gold source).`);
    }
    const mismatch = company.find((l) => l.purityId !== pool.purityId || !new Decimal(l.finenessPercentSnapshot).equals(pool.finenessPercentSnapshot));
    if (mismatch) throw new CustomerGoldError(`${job.jobCode}'s Company gold is a different purity/fineness — a mixed job must use one purity and fineness.`);
  }
  return job;
}

/**
 * The reverse guard, for Company gold going onto a job: allowed on a job
 * holding Customer gold only with the Owner's mix approval and the same
 * purity + fineness. Called by Karigar Metal allocation and job-to-job transfer.
 */
export async function assertCompanyGoldAllowedOnJob(tx: Tx, jobId: string, company: { purityId: string; finenessPercent: DecimalInput }) {
  const onJob = await customerGoldOnJobInTx(tx, jobId);
  if (onJob.length === 0) return;
  const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: jobId } });
  if (!job.customerGoldMixApprovedAt) {
    throw new CustomerGoldError(`${job.jobCode} holds Customer-owned gold. Adding Company gold needs the Owner's approval first (job page → Gold source).`);
  }
  const f = new Decimal(company.finenessPercent);
  if (onJob.some((p) => p.purityId !== company.purityId || !p.finenessPercentSnapshot.equals(f))) {
    throw new CustomerGoldError(`${job.jobCode}'s Customer gold is a different purity/fineness — a mixed job must use one purity and fineness.`);
  }
}

function placesFor(kind: CustomerGoldTransferKind, karigarId: string | null, jobId: string | null): { from: Place; to: Place } {
  switch (kind) {
    case "ISSUE_TO_KARIGAR":
      return { from: { location: "SAFE", scopeId: null }, to: { location: "KARIGAR", scopeId: karigarId } };
    case "RETURN_FROM_KARIGAR":
      return { from: { location: "KARIGAR", scopeId: karigarId }, to: { location: "SAFE", scopeId: null } };
    case "ALLOCATE_TO_JOB":
      return { from: { location: "KARIGAR", scopeId: karigarId }, to: { location: "JOB", scopeId: jobId } };
    case "RELEASE_FROM_JOB":
      return { from: { location: "JOB", scopeId: jobId }, to: { location: "KARIGAR", scopeId: karigarId } };
    case "RETURN_TO_CUSTOMER":
      return { from: { location: "SAFE", scopeId: null }, to: { location: "RETURNED", scopeId: null } };
    case "SCRAP_RETURN_TO_CUSTOMER":
      return { from: { location: "SCRAP", scopeId: null }, to: { location: "RETURNED", scopeId: null } };
  }
}

export async function planCustomerGoldTransfer(tx: Tx, input: CustomerGoldTransferInput): Promise<CustomerGoldTransferPlan> {
  if (!(TRANSFER_KINDS as readonly string[]).includes(input.kind)) throw new CustomerGoldError("Unknown Customer gold operation.");
  requireReason(input.reason);
  const customer = await tx.party.findUnique({ where: { id: input.customerId } });
  if (!customer || customer.type !== "CUSTOMER") throw new CustomerGoldError("Choose the Customer.");
  const purity = await tx.metalPurity.findUnique({ where: { id: input.purityId } });
  if (!purity) throw new CustomerGoldError("That metal purity was not found.");
  const pool: PoolKey = { customerId: customer.id, metalType: purity.metalType, purityId: purity.id, finenessPercentSnapshot: d3(input.finenessPercent) };

  let karigarId = input.karigarId ?? null;
  const jobId = input.jobId ?? null;
  let jobCode: string | null = null;
  let setsJobMaterialsIssued = false;
  if (input.kind === "ALLOCATE_TO_JOB" || input.kind === "RELEASE_FROM_JOB") {
    if (!jobId) throw new CustomerGoldError("Choose the job.");
    const job =
      input.kind === "ALLOCATE_TO_JOB" ? await assertCustomerGoldAllowedOnJob(tx, jobId, pool) : await tx.jewelleryJob.findUnique({ where: { id: jobId } });
    if (!job) throw new CustomerGoldError("Job not found.");
    if (job.customerId !== pool.customerId) throw new CustomerGoldError(`${job.jobCode} is not this Customer's job.`);
    if (!(OPEN_JOB_STATUSES as readonly string[]).includes(job.status)) throw new CustomerGoldError(`${job.jobCode} is ${job.status.replace(/_/g, " ").toLowerCase()}.`);
    // The gold moves between the job and ITS OWN Karigar.
    karigarId = job.karigarId;
    jobCode = job.jobCode;
    setsJobMaterialsIssued = input.kind === "ALLOCATE_TO_JOB" && job.status === "DRAFT";
  }
  let karigarName: string | null = null;
  if (input.kind === "ISSUE_TO_KARIGAR" || input.kind === "RETURN_FROM_KARIGAR" || karigarId) {
    if (!karigarId) throw new CustomerGoldError("Choose the Karigar.");
    const karigar = await tx.party.findUnique({ where: { id: karigarId } });
    if (!karigar || karigar.type !== "KARIGAR") throw new CustomerGoldError("Choose a Karigar.");
    if (input.kind === "ISSUE_TO_KARIGAR" && !karigar.isActive) throw new CustomerGoldError(`${karigar.name} is inactive.`);
    karigarName = karigar.name;
  }

  const { from, to } = placesFor(input.kind, karigarId, jobId);
  const poolBalance = await loadPoolInTx(tx, pool);
  if (!poolBalance) throw new CustomerGoldError(`${customer.name} holds no ${purity.displayName} at ${pool.finenessPercentSnapshot.toFixed(3)}%.`);
  const fromBefore = placeBalance(poolBalance, from);
  const toBefore = placeBalance(poolBalance, to);
  const given = [input.all ? 1 : 0, input.fineWeight != null && String(input.fineWeight).trim() !== "" ? 1 : 0, input.grossWeight != null && String(input.grossWeight).trim() !== "" ? 1 : 0].reduce(
    (a, b) => a + b,
    0
  );
  if (given !== 1) throw new CustomerGoldError("Enter the gross weight, the fine weight, or choose all of it.");
  const moved = shareOf(
    fromBefore,
    input.all ? { all: true } : input.fineWeight != null && String(input.fineWeight).trim() !== "" ? { fine: d3(input.fineWeight) } : { gross: d3(input.grossWeight) },
    pool.finenessPercentSnapshot
  );
  if (!moved.fine.greaterThan(0) && !moved.gross.greaterThan(0)) throw new CustomerGoldError(`Nothing ${LOCATION_LABEL[from.location].toLowerCase()} to move.`);
  if (moved.fine.greaterThan(fromBefore.fine) || moved.gross.greaterThan(fromBefore.gross)) {
    throw new CustomerGoldError(
      `Only ${fromBefore.fine.toFixed(3)} g fine / ${fromBefore.gross.toFixed(3)} g gross is ${LOCATION_LABEL[from.location].toLowerCase()} — you asked for ${moved.fine.toFixed(3)} g fine / ${moved.gross.toFixed(3)} g gross.`
    );
  }
  const label = (p: Place) => `${LOCATION_LABEL[p.location]}${p.location === "KARIGAR" && karigarName ? ` (${karigarName})` : p.location === "JOB" && jobCode ? ` (${jobCode})` : ""}`;
  return {
    kind: input.kind,
    pool,
    customerName: customer.name,
    purityDisplayName: purity.displayName,
    from,
    to,
    fromLabel: label(from),
    toLabel: label(to),
    moved,
    fromBefore,
    fromAfter: { gross: round3(fromBefore.gross.minus(moved.gross)), fine: round3(fromBefore.fine.minus(moved.fine)) },
    toBefore,
    toAfter: { gross: round3(toBefore.gross.plus(moved.gross)), fine: round3(toBefore.fine.plus(moved.fine)) },
    jobCode,
    karigarName,
    setsJobMaterialsIssued,
  };
}

export function customerGoldTransferFingerprint(plan: CustomerGoldTransferPlan): string {
  return opaqueFingerprint("customer-gold-transfer", {
    kind: plan.kind,
    pool: [plan.pool.customerId, plan.pool.purityId, plan.pool.finenessPercentSnapshot.toFixed(3)],
    from: [plan.from.location, plan.from.scopeId, plan.fromBefore.gross.toFixed(3), plan.fromBefore.fine.toFixed(3)],
    to: [plan.to.location, plan.to.scopeId, plan.toBefore.gross.toFixed(3), plan.toBefore.fine.toFixed(3)],
    moved: [plan.moved.gross.toFixed(3), plan.moved.fine.toFixed(3)],
  });
}

export async function postCustomerGoldTransfer(
  tx: Tx,
  input: CustomerGoldTransferInput & { expectedFingerprint?: string | null; idempotencyKey: string; actor: Actor }
) {
  requireOwner(input.actor, "move a Customer's gold");
  if (!input.idempotencyKey?.trim()) throw new CustomerGoldError("Missing submission key — reload the page and try again.");
  const existing = await tx.customerGoldEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.kind !== input.kind || existing.customerId !== input.customerId) throw new CustomerGoldError("This submission key was already used for a different entry.");
    return { entry: existing, replayed: true as const };
  }
  // Lock first (the job's Karigar is found from the job, so read it before locking the parties).
  const job = input.jobId ? await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, select: { karigarId: true } }) : null;
  await lockCustomerGold(tx, { purityId: input.purityId, customerId: input.customerId, karigarId: job?.karigarId ?? input.karigarId ?? null, jobId: input.jobId ?? null });
  const plan = await planCustomerGoldTransfer(tx, input);
  if (input.expectedFingerprint && input.expectedFingerprint !== customerGoldTransferFingerprint(plan)) {
    throw new CustomerGoldError("The Customer's gold balance changed after this preview was shown. Review the new preview and confirm again.");
  }
  const entry = await writeCustomerGoldEntry(tx, {
    kind: input.kind,
    pool: plan.pool,
    from: plan.from,
    to: plan.to,
    gross: plan.moved.gross,
    fine: plan.moved.fine,
    entryDate: input.entryDate,
    reason: requireReason(input.reason),
    reference: input.reference?.trim() || null,
    karigarId: plan.from.location === "KARIGAR" ? plan.from.scopeId : plan.to.location === "KARIGAR" ? plan.to.scopeId : null,
    jobId: input.jobId ?? null,
    idempotencyKey: input.idempotencyKey,
    createdByUserId: input.actor.id,
  });
  if (plan.setsJobMaterialsIssued && input.jobId) {
    await tx.jewelleryJob.update({ where: { id: input.jobId }, data: { status: "MATERIALS_ISSUED" } });
  }
  return { entry, replayed: false as const, plan };
}

// ---------------------------------------------------------------------------
// C. Reversal — audited, newest first, never of something a later entry uses
// ---------------------------------------------------------------------------

const REVERSIBLE_KINDS: CustomerGoldEntryKind[] = ["INTAKE", ...TRANSFER_KINDS];

/** Why an entry cannot be reversed right now, or null. */
export async function customerGoldReversalBlock(tx: Tx, entryId: string): Promise<string | null> {
  const e = await tx.customerGoldEntry.findUnique({ where: { id: entryId }, include: { reversedBy: true } });
  if (!e) return "Entry not found.";
  if (e.reversalOfEntryId) return "It is itself a reversal.";
  if (e.reversedBy) return `It was already reversed by ${e.reversedBy.entryCode}.`;
  if (e.jewelleryReceiptId) return "It is part of a jewellery receipt and cannot be reversed on its own.";
  if (e.kind === "DELIVER") return "Deliveries are reversed from the delivery itself (job page).";
  if (e.kind === "CONVERT_TO_COMPANY") return "An approved purchase/exchange is corrected by an Owner correction, not reversed here.";
  if (!REVERSIBLE_KINDS.includes(e.kind)) return "This kind of entry cannot be reversed.";
  // Newest first: any LATER live entry of the same pool depends on this one's balance.
  const later = await tx.customerGoldEntry.findMany({
    where: {
      customerId: e.customerId,
      metalType: e.metalType,
      purityId: e.purityId,
      finenessPercentSnapshot: e.finenessPercentSnapshot,
      createdAt: { gt: e.createdAt },
      reversalOfEntryId: null,
      reversedBy: null,
    },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  if (later.length > 0) return `later entries depend on it (${later.map((l) => l.entryCode).join(", ")}). Reverse newest first.`;
  return null;
}

export async function reverseCustomerGoldEntry(tx: Tx, input: { entryId: string; reason: string; idempotencyKey?: string | null; actor: Actor }) {
  requireOwner(input.actor, "reverse a Customer gold entry");
  const reason = requireReason(input.reason, 10);
  if (input.idempotencyKey) {
    const replay = await tx.customerGoldEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (replay) return { reversal: replay, replayed: true as const };
  }
  const first = await tx.customerGoldEntry.findUnique({ where: { id: input.entryId } });
  if (!first) throw new CustomerGoldError("Entry not found.");
  await lockCustomerGold(tx, { purityId: first.purityId, customerId: first.customerId, karigarId: first.karigarId, jobId: first.jobId });
  const block = await customerGoldReversalBlock(tx, input.entryId);
  if (block) throw new CustomerGoldError(`Cannot reverse ${first.entryCode}: ${block}`);
  const e = await tx.customerGoldEntry.findUniqueOrThrow({ where: { id: input.entryId } });
  const pool: PoolKey = { customerId: e.customerId, metalType: e.metalType, purityId: e.purityId, finenessPercentSnapshot: new Decimal(e.finenessPercentSnapshot) };
  const reversal = await writeCustomerGoldEntry(tx, {
    kind: e.kind,
    pool,
    from: { location: e.fromLocation, scopeId: scopeOf(e.fromLocation, e) },
    to: { location: e.toLocation, scopeId: scopeOf(e.toLocation, e) },
    gross: new Decimal(e.grossWeight),
    fine: new Decimal(e.fineWeight),
    entryDate: new Date(),
    reason,
    reference: e.entryCode,
    karigarId: e.karigarId,
    jobId: e.jobId,
    finishedJewelleryId: e.finishedJewelleryId,
    customerGoldReceiptId: e.customerGoldReceiptId,
    reversalOfEntryId: e.id,
    idempotencyKey: input.idempotencyKey ?? null,
    createdByUserId: input.actor.id,
  });
  // A job left holding nothing at all returns to Draft, as with Karigar Metal.
  if (e.kind === "ALLOCATE_TO_JOB" && e.jobId) {
    const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: e.jobId } });
    const [metal, diamonds, packets, others, onJob] = await Promise.all([
      tx.jewelleryMetalIssueLine.count({ where: { jobId: e.jobId } }),
      tx.jewelleryDiamondIssueLine.count({ where: { jobId: e.jobId } }),
      tx.jewelleryPacketIssueLine.count({ where: { jobId: e.jobId } }),
      tx.jewelleryOtherMaterialLine.count({ where: { jobId: e.jobId } }),
      customerGoldOnJobInTx(tx, e.jobId),
    ]);
    if (job.status === "MATERIALS_ISSUED" && metal + diamonds + packets + others === 0 && onJob.length === 0) {
      await tx.jewelleryJob.update({ where: { id: e.jobId }, data: { status: "DRAFT" } });
    }
  }
  return { reversal, replayed: false as const, original: e };
}

// ---------------------------------------------------------------------------
// D. Mixed Customer + Company gold on one job — explicit Owner approval
// ---------------------------------------------------------------------------

export async function approveCustomerGoldMix(tx: Tx, input: { jobId: string; reason: string; actor: Actor }) {
  requireOwner(input.actor, "approve mixing Customer and Company gold");
  const reason = requireReason(input.reason, 10);
  const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId } });
  if (!job) throw new CustomerGoldError("Job not found.");
  if (!job.customerId) throw new CustomerGoldError(`${job.jobCode} has no Customer.`);
  if (job.customerGoldMixApprovedAt) return job;
  return tx.jewelleryJob.update({
    where: { id: job.id },
    data: { customerGoldMixApprovedAt: new Date(), customerGoldMixApprovedByUserId: input.actor.id, customerGoldMixReason: reason },
  });
}

// ---------------------------------------------------------------------------
// E. What a job's gold is made of (weights only; safe for Staff)
// ---------------------------------------------------------------------------

export type JobGoldSources = {
  customerName: string | null;
  customerGoldOnJob: { purityId: string; purityDisplayName: string; finenessPercent: string; gross: string; fine: string }[];
  customerGoldConsumedFine: string;
  companyViaKarigarMetalFine: string;
  companyDirectIssueFine: string;
  mixApproved: boolean;
  label: string;
};

export async function getJobGoldSources(tx: Tx, jobId: string): Promise<JobGoldSources> {
  const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: jobId }, include: { customer: true } });
  const [onJob, lines, consumed] = await Promise.all([
    customerGoldOnJobInTx(tx, jobId),
    tx.jewelleryMetalIssueLine.findMany({ where: { jobId, metalType: { not: "ALLOY" } } }),
    tx.customerGoldEntry.findMany({ where: { jobId, kind: "CONSUME_TO_FINISHED" } }),
  ]);
  const purities = onJob.length ? await tx.metalPurity.findMany({ where: { id: { in: onJob.map((p) => p.purityId) } } }) : [];
  const sum = (xs: { fineWeight: DecimalInput }[]) => round3(xs.reduce((s, x) => s.plus(x.fineWeight), ZERO));
  const consumedFine = round3(consumed.reduce((s, e) => s.plus(new Decimal(e.fineWeight).times(e.reversalOfEntryId ? -1 : 1)), ZERO));
  const everCustomer = onJob.length > 0 || (await tx.customerGoldEntry.count({ where: { jobId } })) > 0;
  const viaCustody = sum(lines.filter((l) => l.sourceCustodyEntryId));
  const direct = sum(lines.filter((l) => !l.sourceCustodyEntryId));
  const parts = [
    everCustomer ? "Customer-owned gold" : null,
    viaCustody.greaterThan(0) ? "Company gold through Karigar Metal" : null,
    direct.greaterThan(0) ? "Historical direct Company issue" : null,
  ].filter(Boolean);
  return {
    customerName: job.customer?.name ?? null,
    customerGoldOnJob: onJob.map((p) => ({
      purityId: p.purityId,
      purityDisplayName: purities.find((x) => x.id === p.purityId)?.displayName ?? "",
      finenessPercent: p.finenessPercentSnapshot.toFixed(3),
      gross: p.gross.toFixed(3),
      fine: p.fine.toFixed(3),
    })),
    customerGoldConsumedFine: consumedFine.toFixed(3),
    companyViaKarigarMetalFine: viaCustody.toFixed(3),
    companyDirectIssueFine: direct.toFixed(3),
    mixApproved: Boolean(job.customerGoldMixApprovedAt),
    label: parts.length === 0 ? "No gold yet" : parts.join(" + "),
  };
}

export { ENTRY_KIND_LABEL, LOCATION_LABEL };
