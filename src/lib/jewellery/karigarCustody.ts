import "server-only";

import type { KarigarMetalCustodyKind, MetalStockMovementType, MetalType, UserRole } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { createVoucherHeader, insertBalancedJournalLines } from "@/lib/accounting/posting";
import type { Tx } from "@/lib/corrections/types";
import { round3 } from "@/lib/diamond/allocation";
import { nextJewelleryCode } from "@/lib/jewellery/numbering";
import { declareCustodyAware, getMetalStockBalanceInTx, pendingFineWeightOf } from "@/lib/jewellery/posting";

/**
 * Karigar metal custody — company metal issued to a named Karigar without a
 * job, then allocated (all or part) to that Karigar's own jobs, released back
 * from a job, or returned to stock. See the KarigarMetalCustodyEntry model.
 *
 * Accounting (traced from issueMaterialsToJewelleryJob / metalTransfer.ts):
 *   - Issue:    Dr 1320 Jewellery WIP / Cr 1300 Metal Inventory, once, at the
 *               warehouse pool's carrying rate (revaluations included).
 *   - Return:   Dr 1300 / Cr 1320 at the Karigar balance's own carrying share.
 *   - Allocate / release: no voucher. Unallocated custody and job WIP are both
 *               in 1320, so only the attribution moves — weight and value are
 *               carried across exactly, never recosted.
 * A full operation carries the exact remaining value; a part carries its
 * fine-weight share rounded to the paisa, and the remainder stays behind, so
 * the two sides always add back to the whole.
 *
 * A Karigar's unallocated balance per metal + purity holds ONE fineness
 * snapshot at a time. Gold and silver reconcile on fine weight; Company
 * Copper/Alloy is never taken into custody (it stays on its job's own pool).
 */

export class CustodyError extends Error {}

const CUSTODY_MOVEMENT: Record<KarigarMetalCustodyKind, MetalStockMovementType> = {
  ISSUE_TO_KARIGAR: "KARIGAR_ISSUE_OUT",
  RETURN_TO_STOCK: "KARIGAR_RETURN_IN",
  ALLOCATE_TO_JOB: "CUSTODY_TO_JOB",
  RELEASE_FROM_JOB: "JOB_TO_CUSTODY",
};
/** The movement that undoes each kind, used by a reversal. */
const MIRROR_MOVEMENT: Record<KarigarMetalCustodyKind, MetalStockMovementType> = {
  ISSUE_TO_KARIGAR: "KARIGAR_RETURN_IN",
  RETURN_TO_STOCK: "KARIGAR_ISSUE_OUT",
  ALLOCATE_TO_JOB: "JOB_TO_CUSTODY",
  RELEASE_FROM_JOB: "CUSTODY_TO_JOB",
};
/** +1 when the kind adds to the Karigar's unallocated balance. */
const CUSTODY_SIGN: Record<KarigarMetalCustodyKind, 1 | -1> = {
  ISSUE_TO_KARIGAR: 1,
  RELEASE_FROM_JOB: 1,
  RETURN_TO_STOCK: -1,
  ALLOCATE_TO_JOB: -1,
};

export const KIND_LABEL: Record<KarigarMetalCustodyKind, string> = {
  ISSUE_TO_KARIGAR: "Issued to Karigar",
  RETURN_TO_STOCK: "Returned to stock",
  ALLOCATE_TO_JOB: "Allocated to job",
  RELEASE_FROM_JOB: "Released from job",
};

const ALLOCATE_STATUSES = ["DRAFT", "MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"] as const;
const RELEASE_STATUSES = ["MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"] as const;

const statusText = (s: string) => s.replace(/_/g, " ").toLowerCase();

// ---------------------------------------------------------------------------
// Locks — always in this order: purity, Karigar, job. Every custody write and
// Issue Materials follow it, so two of them can never wait on each other.
// ---------------------------------------------------------------------------

async function lockInOrder(tx: Tx, keys: { purityId?: string | null; karigarId: string; jobId?: string | null }) {
  if (keys.purityId) await tx.$queryRawUnsafe(`SELECT id FROM "metal_purities" WHERE id = $1 FOR UPDATE`, keys.purityId);
  const party = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "parties" WHERE id = $1 FOR UPDATE`, keys.karigarId);
  if (party.length === 0) throw new CustodyError("Karigar not found.");
  if (keys.jobId) await tx.$queryRawUnsafe(`SELECT id FROM "jewellery_jobs" WHERE id = $1 FOR UPDATE`, keys.jobId);
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export type CustodyBalance = {
  metalType: MetalType;
  purityId: string;
  /** null only when the balance is empty. */
  finenessPercentSnapshot: Decimal | null;
  grossWeight: Decimal;
  fineWeight: Decimal;
  costValue: Decimal;
};

type EntryForBalance = {
  kind: KarigarMetalCustodyKind;
  metalType: MetalType;
  purityId: string;
  finenessPercentSnapshot: Decimal | string;
  grossWeight: Decimal | string;
  fineWeight: Decimal | string;
  costValue: Decimal | string;
  reversalOfEntryId: string | null;
};

/** Pure: sums entries into balances per metal + purity. A reversal carries the opposite sign of its original. */
export function sumCustodyEntries(entries: EntryForBalance[]): CustodyBalance[] {
  const byPool = new Map<string, { metalType: MetalType; purityId: string; byFineness: Map<string, { gross: Decimal; fine: Decimal; cost: Decimal }> }>();
  for (const e of entries) {
    const sign = CUSTODY_SIGN[e.kind] * (e.reversalOfEntryId ? -1 : 1);
    const key = `${e.metalType}:${e.purityId}`;
    const pool = byPool.get(key) ?? { metalType: e.metalType, purityId: e.purityId, byFineness: new Map() };
    const f = new Decimal(e.finenessPercentSnapshot).toFixed(3);
    const b = pool.byFineness.get(f) ?? { gross: ZERO, fine: ZERO, cost: ZERO };
    b.gross = b.gross.plus(new Decimal(e.grossWeight).times(sign));
    b.fine = b.fine.plus(new Decimal(e.fineWeight).times(sign));
    b.cost = b.cost.plus(new Decimal(e.costValue).times(sign));
    pool.byFineness.set(f, b);
    byPool.set(key, pool);
  }
  const out: CustodyBalance[] = [];
  for (const pool of byPool.values()) {
    const live = [...pool.byFineness.entries()].filter(([, b]) => !b.gross.isZero() || !b.fine.isZero() || !b.cost.isZero());
    if (live.length > 1) {
      throw new CustodyError("A Karigar balance holds metal at two fineness snapshots — this should never happen. Nothing was changed.");
    }
    const [fineness, b] = live[0] ?? [null, { gross: ZERO, fine: ZERO, cost: ZERO }];
    out.push({
      metalType: pool.metalType,
      purityId: pool.purityId,
      finenessPercentSnapshot: fineness === null ? null : new Decimal(fineness),
      grossWeight: round3(b.gross),
      fineWeight: round3(b.fine),
      costValue: round2(b.cost),
    });
  }
  return out;
}

export async function getCustodyBalanceInTx(tx: Tx, karigarId: string, metalType: MetalType, purityId: string): Promise<CustodyBalance> {
  const entries = await tx.karigarMetalCustodyEntry.findMany({ where: { karigarId, metalType, purityId } });
  return (
    sumCustodyEntries(entries)[0] ?? { metalType, purityId, finenessPercentSnapshot: null, grossWeight: ZERO, fineWeight: ZERO, costValue: ZERO }
  );
}

export async function listCustodyBalancesInTx(tx: Tx, karigarId?: string): Promise<(CustodyBalance & { karigarId: string })[]> {
  const entries = await tx.karigarMetalCustodyEntry.findMany({ where: karigarId ? { karigarId } : undefined, orderBy: { createdAt: "asc" } });
  const byKarigar = new Map<string, typeof entries>();
  for (const e of entries) byKarigar.set(e.karigarId, [...(byKarigar.get(e.karigarId) ?? []), e]);
  return [...byKarigar.entries()].flatMap(([k, list]) => sumCustodyEntries(list).map((b) => ({ ...b, karigarId: k })));
}

/** The one fine-bearing metal a job holds (its alloy pool is separate), or why it has none / several. */
async function jobFineMetal(tx: Tx, jobId: string) {
  const lines = await tx.jewelleryMetalIssueLine.findMany({ where: { jobId, metalType: { not: "ALLOY" } }, include: { purity: true } });
  const keys = new Set(lines.map((l) => `${l.metalType}:${l.purityId}:${new Decimal(l.finenessPercentSnapshot).toFixed(3)}`));
  if (lines.length === 0) return { kind: "none" as const };
  if (keys.size > 1) return { kind: "mixed" as const };
  const l = lines[0];
  return {
    kind: "one" as const,
    metalType: l.metalType,
    purityId: l.purityId,
    purityDisplayName: l.purity.displayName,
    finenessPercentSnapshot: new Decimal(l.finenessPercentSnapshot),
  };
}

// ---------------------------------------------------------------------------
// Plans (read-only; the post re-plans under locks and compares fingerprints)
// ---------------------------------------------------------------------------

export type CustodyOperationInput = {
  kind: KarigarMetalCustodyKind;
  karigarId: string;
  purityId?: string | null;
  jobId?: string | null;
  /**
   * The weight, entered ONCE, in exactly one of two units (both ignored when
   * `all` is true):
   *   grossWeight — grams of the metal as weighed (e.g. 10.010 g of 24K);
   *   fineWeight  — grams of pure metal it contains (e.g. 10.000 g fine).
   * The other one is derived from the saved fineness, and the pair always
   * satisfies fine = round3(gross × fineness ÷ 100).
   */
  grossWeight?: string | number | null;
  fineWeight?: string | number | null;
  /** Take the whole available balance (return / allocate / release). */
  all?: boolean;
  entryDate: Date;
  reason: string;
  reference?: string | null;
};

export type CustodyPlan = {
  kind: KarigarMetalCustodyKind;
  karigarId: string;
  karigarName: string;
  jobId: string | null;
  jobCode: string | null;
  metalType: MetalType;
  purityId: string;
  purityDisplayName: string;
  finenessPercentSnapshot: Decimal;
  grossWeight: Decimal;
  fineWeight: Decimal;
  costValue: Decimal;
  isFull: boolean;
  /** Which unit the Owner typed: GROSS, FINE, or ALL (the whole balance). */
  enteredWeightBasis: "GROSS" | "FINE" | "ALL";
  entryDate: Date;
  reason: string;
  reference: string | null;
  custodyBefore: { gross: Decimal; fine: Decimal; cost: Decimal };
  custodyAfter: { gross: Decimal; fine: Decimal; cost: Decimal };
  stockBefore: { gross: Decimal; cost: Decimal } | null;
  stockAfter: { gross: Decimal; cost: Decimal } | null;
  jobBefore: { pendingFine: Decimal; wip: Decimal } | null;
  jobAfter: { pendingFine: Decimal; wip: Decimal } | null;
  postsVoucher: boolean;
};

function checkCommon(input: CustodyOperationInput): { reason: string; reference: string | null } {
  const reason = input.reason?.trim() ?? "";
  const minimum = input.kind === "RELEASE_FROM_JOB" ? 10 : 3;
  if (reason.length < minimum) throw new CustodyError(`Give the reason (at least ${minimum} characters).`);
  if (Number.isNaN(input.entryDate.getTime())) throw new CustodyError("Enter a valid date.");
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);
  if (input.entryDate.getTime() > endOfToday.getTime()) throw new CustodyError("The date cannot be in the future.");
  return { reason, reference: input.reference?.trim() || null };
}

const present = (v: string | number | null | undefined) => v !== null && v !== undefined && String(v).trim() !== "";

/** The one weight the Owner entered, and in which unit. */
function enteredWeight(input: CustodyOperationInput): { basis: "GROSS" | "FINE"; value: Decimal } {
  const hasGross = present(input.grossWeight);
  const hasFine = present(input.fineWeight);
  if (hasGross && hasFine) throw new CustodyError("Enter the weight once — as gross grams or as fine grams, not both.");
  if (!hasGross && !hasFine) throw new CustodyError("Enter the weight in grams (gross or fine).");
  const basis = hasFine ? "FINE" : "GROSS";
  const value = round3((hasFine ? input.fineWeight : input.grossWeight) as string | number);
  if (!value.greaterThan(0)) throw new CustodyError(`Enter a ${basis === "FINE" ? "fine" : "gross"} weight above zero.`);
  return { basis, value };
}

const fineOf = (gross: Decimal, fineness: Decimal) => round3(gross.times(fineness).dividedBy(100));

/**
 * The gross weight (3 dp) whose fine content at `fineness` rounds to exactly
 * `fine` — so a weight entered as fine is stored as a pair that reconciles
 * both ways. Any 0.001 g fine is reachable, because one 0.001 g step of gross
 * adds less than 0.001 g of fine; the nearest candidates are tried in order.
 */
function grossForFine(fine: Decimal, fineness: Decimal): Decimal {
  const guess = round3(fine.times(100).dividedBy(fineness));
  for (const g of [guess, guess.minus("0.001"), guess.plus("0.001"), guess.minus("0.002"), guess.plus("0.002")]) {
    if (g.greaterThan(0) && fineOf(g, fineness).equals(fine)) return g;
  }
  throw new CustodyError(`${fine.toFixed(3)} g fine cannot be matched to a whole gross weight at ${fineness.toFixed(3)}% — enter the gross weight instead.`);
}

export async function planCustodyOperation(tx: Tx, input: CustodyOperationInput): Promise<CustodyPlan> {
  const { reason, reference } = checkCommon(input);
  const karigar = await tx.party.findUnique({ where: { id: input.karigarId } });
  if (!karigar || karigar.type !== "KARIGAR") throw new CustodyError("Choose a Karigar.");

  switch (input.kind) {
    case "ISSUE_TO_KARIGAR": {
      if (!karigar.isActive) throw new CustodyError(`${karigar.name} is inactive — reactivate the Karigar before issuing metal.`);
      if (!input.purityId) throw new CustodyError("Choose the metal and purity.");
      const purity = await tx.metalPurity.findUnique({ where: { id: input.purityId } });
      if (!purity || !purity.isActive) throw new CustodyError("That metal purity was not found or is inactive.");
      if (purity.metalType === "ALLOY") {
        throw new CustodyError("Company Copper/Alloy is issued with a job's own materials, not held as Karigar custody.");
      }
      const fineness = new Decimal(purity.finenessPercent);
      if (!fineness.greaterThan(0)) throw new CustodyError("Only fine-bearing metal (gold, silver, platinum) can be held as Karigar custody.");
      const entered = enteredWeight(input);
      const gross = entered.basis === "FINE" ? grossForFine(entered.value, fineness) : entered.value;
      const stock = await getMetalStockBalanceInTx(tx, purity.metalType, purity.id);
      if (gross.greaterThan(stock.grossWeight)) {
        throw new CustodyError(
          `Not enough ${purity.displayName} stock: ${gross.toFixed(3)} g gross (${fineOf(gross, fineness).toFixed(3)} g fine) requested, ${stock.grossWeight.toFixed(3)} g gross available.`
        );
      }
      const custody = await getCustodyBalanceInTx(tx, karigar.id, purity.metalType, purity.id);
      if (custody.finenessPercentSnapshot && !custody.finenessPercentSnapshot.equals(fineness)) {
        throw new CustodyError(
          `${karigar.name} already holds ${purity.displayName} recorded at ${custody.finenessPercentSnapshot.toFixed(3)}%. Allocate or return it before issuing more at ${fineness.toFixed(3)}%.`
        );
      }
      // The warehouse's own carrying rate (usable pool incl. posted
      // revaluations), exactly as Issue Materials costs a job — and taking
      // the last gram takes the exact remaining value.
      const isFull = gross.equals(stock.grossWeight);
      const cost = isFull ? stock.costValue : stock.grossWeight.greaterThan(0) ? round2(gross.times(stock.costValue.dividedBy(stock.grossWeight))) : ZERO;
      const fine = entered.basis === "FINE" ? entered.value : fineOf(gross, fineness);
      return {
        enteredWeightBasis: entered.basis,
        kind: input.kind,
        karigarId: karigar.id,
        karigarName: karigar.name,
        jobId: null,
        jobCode: null,
        metalType: purity.metalType,
        purityId: purity.id,
        purityDisplayName: purity.displayName,
        finenessPercentSnapshot: fineness,
        grossWeight: gross,
        fineWeight: fine,
        costValue: cost,
        isFull,
        entryDate: input.entryDate,
        reason,
        reference,
        custodyBefore: { gross: custody.grossWeight, fine: custody.fineWeight, cost: custody.costValue },
        custodyAfter: { gross: custody.grossWeight.plus(gross), fine: custody.fineWeight.plus(fine), cost: round2(custody.costValue.plus(cost)) },
        stockBefore: { gross: stock.grossWeight, cost: stock.costValue },
        stockAfter: { gross: stock.grossWeight.minus(gross), cost: round2(stock.costValue.minus(cost)) },
        jobBefore: null,
        jobAfter: null,
        postsVoucher: cost.greaterThan(0),
      };
    }

    case "RETURN_TO_STOCK":
    case "ALLOCATE_TO_JOB": {
      if (!input.purityId) throw new CustodyError("Choose the metal and purity.");
      const purity = await tx.metalPurity.findUnique({ where: { id: input.purityId } });
      if (!purity) throw new CustodyError("That metal purity was not found.");
      const custody = await getCustodyBalanceInTx(tx, karigar.id, purity.metalType, purity.id);
      if (!custody.finenessPercentSnapshot || !custody.grossWeight.greaterThan(0)) {
        throw new CustodyError(`${karigar.name} holds no unallocated ${purity.displayName}.`);
      }
      const fineness = custody.finenessPercentSnapshot;
      let gross: Decimal;
      let fine: Decimal;
      let cost: Decimal;
      let isFull: boolean;
      let basis: "GROSS" | "FINE" | "ALL" = "ALL";
      const holds = `${karigar.name} holds only ${custody.grossWeight.toFixed(3)} g gross / ${custody.fineWeight.toFixed(3)} g fine of unallocated ${purity.displayName}.`;
      if (input.all) {
        [gross, fine, cost, isFull] = [custody.grossWeight, custody.fineWeight, custody.costValue, true];
      } else {
        const entered = enteredWeight(input);
        basis = entered.basis;
        if (entered.basis === "GROSS") {
          gross = entered.value;
          if (gross.greaterThan(custody.grossWeight)) throw new CustodyError(holds);
          isFull = gross.equals(custody.grossWeight);
          fine = isFull ? custody.fineWeight : fineOf(gross, fineness);
        } else {
          fine = entered.value;
          if (fine.greaterThan(custody.fineWeight)) throw new CustodyError(holds);
          isFull = fine.equals(custody.fineWeight);
          gross = isFull ? custody.grossWeight : grossForFine(fine, fineness);
        }
        if (isFull) {
          [gross, fine, cost] = [custody.grossWeight, custody.fineWeight, custody.costValue];
        } else {
          if (!fine.lessThan(custody.fineWeight) || !gross.lessThan(custody.grossWeight)) {
            throw new CustodyError("That is the whole balance after rounding — choose “All of it” instead.");
          }
          // Gold is reconciled on fine weight: a part takes its fine share of the value.
          cost = round2(custody.costValue.times(fine).dividedBy(custody.fineWeight));
        }
      }
      const custodyAfter = { gross: custody.grossWeight.minus(gross), fine: custody.fineWeight.minus(fine), cost: round2(custody.costValue.minus(cost)) };
      const base = {
        enteredWeightBasis: basis,
        kind: input.kind,
        karigarId: karigar.id,
        karigarName: karigar.name,
        metalType: purity.metalType,
        purityId: purity.id,
        purityDisplayName: purity.displayName,
        finenessPercentSnapshot: fineness,
        grossWeight: gross,
        fineWeight: fine,
        costValue: cost,
        isFull,
        entryDate: input.entryDate,
        reason,
        reference,
        custodyBefore: { gross: custody.grossWeight, fine: custody.fineWeight, cost: custody.costValue },
        custodyAfter,
      };

      if (input.kind === "RETURN_TO_STOCK") {
        const stock = await getMetalStockBalanceInTx(tx, purity.metalType, purity.id);
        return {
          ...base,
          jobId: null,
          jobCode: null,
          stockBefore: { gross: stock.grossWeight, cost: stock.costValue },
          stockAfter: { gross: stock.grossWeight.plus(gross), cost: round2(stock.costValue.plus(cost)) },
          jobBefore: null,
          jobAfter: null,
          postsVoucher: cost.greaterThan(0),
        };
      }

      if (!input.jobId) throw new CustodyError("Choose the job to allocate to.");
      const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId } });
      if (!job) throw new CustodyError("Job not found.");
      if (job.karigarId !== karigar.id) {
        throw new CustodyError(`${job.jobCode} belongs to a different Karigar — custody metal only goes to the same Karigar's own jobs.`);
      }
      if (!ALLOCATE_STATUSES.includes(job.status as (typeof ALLOCATE_STATUSES)[number])) {
        throw new CustodyError(`${job.jobCode} is ${statusText(job.status)} — it cannot take more metal.`);
      }
      const held = await jobFineMetal(tx, job.id);
      if (held.kind === "mixed") throw new CustodyError(`${job.jobCode} already holds more than one metal/purity — it cannot take custody metal.`);
      if (held.kind === "one" && (held.metalType !== purity.metalType || held.purityId !== purity.id)) {
        throw new CustodyError(`${job.jobCode} holds ${held.purityDisplayName}; this is ${purity.displayName}. Metal of different purities is never mixed on one job here.`);
      }
      if (held.kind === "one" && !held.finenessPercentSnapshot.equals(fineness)) {
        throw new CustodyError(`${job.jobCode}'s ${purity.displayName} was recorded at a different fineness — the two cannot be merged without losing a snapshot.`);
      }
      const pendingBefore = pendingFineWeightOf(job);
      const wipBefore = new Decimal(job.remainingWipCost);
      return {
        ...base,
        jobId: job.id,
        jobCode: job.jobCode,
        stockBefore: null,
        stockAfter: null,
        jobBefore: { pendingFine: pendingBefore, wip: wipBefore },
        jobAfter: { pendingFine: pendingBefore.plus(fine), wip: round2(wipBefore.plus(cost)) },
        postsVoucher: false,
      };
    }

    case "RELEASE_FROM_JOB": {
      if (!input.jobId) throw new CustodyError("Choose the job to release metal from.");
      const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId } });
      if (!job) throw new CustodyError("Job not found.");
      if (job.karigarId !== karigar.id) throw new CustodyError(`${job.jobCode} belongs to a different Karigar.`);
      if (!RELEASE_STATUSES.includes(job.status as (typeof RELEASE_STATUSES)[number])) {
        throw new CustodyError(`${job.jobCode} is ${statusText(job.status)} — it has no unresolved metal to release.`);
      }
      const held = await jobFineMetal(tx, job.id);
      if (held.kind === "none") throw new CustodyError(`${job.jobCode} holds no gold, silver or platinum.`);
      if (held.kind === "mixed") {
        throw new CustodyError(`${job.jobCode} holds more than one metal/purity, so its pending metal cannot be attributed to one purity for release.`);
      }
      const pending = pendingFineWeightOf(job);
      if (!pending.greaterThan(0)) throw new CustodyError(`${job.jobCode} has no unresolved metal pending with the Karigar.`);
      const wip = new Decimal(job.remainingWipCost);
      const fineness = held.finenessPercentSnapshot;
      // A job reconciles on FINE weight; its gross is only ever an equivalent.
      let fine: Decimal;
      let enteredGross: Decimal | null = null;
      let basis: "GROSS" | "FINE" | "ALL" = "ALL";
      if (input.all) {
        fine = pending;
      } else {
        const entered = enteredWeight(input);
        basis = entered.basis;
        if (entered.basis === "FINE") {
          fine = entered.value;
        } else {
          enteredGross = entered.value;
          fine = fineOf(entered.value, fineness);
        }
        if (fine.greaterThan(pending)) {
          throw new CustodyError(`${job.jobCode} has only ${pending.toFixed(3)} g fine pending (≈ ${round3(pending.times(100).dividedBy(fineness)).toFixed(3)} g gross).`);
        }
        if (!fine.greaterThan(0)) throw new CustodyError("That weight is below 0.001 g fine.");
      }
      const isFull = fine.equals(pending);
      const cost = isFull ? wip : round2(wip.times(fine).dividedBy(pending));
      // The gross equivalent of the fine metal at the job's own fineness: the
      // exact gross the Owner typed, else the gross that reconciles to it.
      let gross: Decimal;
      if (enteredGross && !isFull) gross = enteredGross;
      else {
        try {
          gross = grossForFine(fine, fineness);
        } catch {
          gross = round3(fine.times(100).dividedBy(fineness));
        }
      }
      const custody = await getCustodyBalanceInTx(tx, karigar.id, held.metalType, held.purityId);
      if (custody.finenessPercentSnapshot && !custody.finenessPercentSnapshot.equals(fineness)) {
        throw new CustodyError(
          `${karigar.name}'s unallocated ${held.purityDisplayName} is recorded at ${custody.finenessPercentSnapshot.toFixed(3)}%, this job's at ${fineness.toFixed(3)}% — they cannot be merged.`
        );
      }
      return {
        enteredWeightBasis: basis,
        kind: input.kind,
        karigarId: karigar.id,
        karigarName: karigar.name,
        jobId: job.id,
        jobCode: job.jobCode,
        metalType: held.metalType,
        purityId: held.purityId,
        purityDisplayName: held.purityDisplayName,
        finenessPercentSnapshot: fineness,
        grossWeight: gross,
        fineWeight: fine,
        costValue: cost,
        isFull,
        entryDate: input.entryDate,
        reason,
        reference,
        custodyBefore: { gross: custody.grossWeight, fine: custody.fineWeight, cost: custody.costValue },
        custodyAfter: { gross: custody.grossWeight.plus(gross), fine: custody.fineWeight.plus(fine), cost: round2(custody.costValue.plus(cost)) },
        stockBefore: null,
        stockAfter: null,
        jobBefore: { pendingFine: pending, wip },
        jobAfter: { pendingFine: pending.minus(fine), wip: round2(wip.minus(cost)) },
        postsVoucher: false,
      };
    }
  }
}

/** Every figure the Owner saw, so a changed balance is caught before posting. */
export function custodyPlanFingerprint(plan: CustodyPlan): string {
  const pair = (p: { gross?: Decimal; fine?: Decimal; cost?: Decimal; pendingFine?: Decimal; wip?: Decimal } | null) =>
    p ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v.toString()])) : null;
  return JSON.stringify({
    kind: plan.kind,
    karigarId: plan.karigarId,
    jobId: plan.jobId,
    purityId: plan.purityId,
    fineness: plan.finenessPercentSnapshot.toFixed(3),
    basis: plan.enteredWeightBasis,
    gross: plan.grossWeight.toFixed(3),
    fine: plan.fineWeight.toFixed(3),
    cost: plan.costValue.toFixed(2),
    custodyBefore: pair(plan.custodyBefore),
    stockBefore: pair(plan.stockBefore),
    jobBefore: pair(plan.jobBefore),
    date: plan.entryDate.toISOString().slice(0, 10),
    reason: plan.reason,
    reference: plan.reference,
  });
}

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------

type Owner = { id: string; role: UserRole };
type Fy = { fyStartMonth: number; fyStartDay: number };

async function postCustodyVoucher(
  tx: Tx,
  args: Fy & { date: Date; amount: Decimal; toWip: boolean; note: string; reference: string | null; userId: string; idempotencyKey?: string | null }
) {
  const voucher = await createVoucherHeader(
    tx,
    {
      date: args.date,
      fyStartMonth: args.fyStartMonth,
      fyStartDay: args.fyStartDay,
      currencyCode: "INR",
      exchangeRate: 1,
      referenceNumber: args.reference,
      note: args.note,
      idempotencyKey: args.idempotencyKey ?? null,
      createdByUserId: args.userId,
    },
    "JEWELLERY_ISSUE",
    { amount: args.amount }
  );
  const [debit, credit] = args.toWip
    ? [SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY]
    : [SYSTEM_ACCOUNT_CODES.METAL_INVENTORY, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP];
  await insertBalancedJournalLines(tx, voucher.id, [
    { accountCode: debit, debit: args.amount, description: args.note },
    { accountCode: credit, credit: args.amount, description: args.note },
  ]);
  return voucher.id;
}

export type PostCustodyInput = CustodyOperationInput &
  Fy & {
    idempotencyKey: string;
    expectedFingerprint?: string | null;
    owner: Owner;
  };

/**
 * Internal permission, never read from a form: the ONE case where someone other
 * than the Owner may post a custody entry is the allocation a finished-jewellery
 * receipt makes for its own job (receiveWithCustodyAllocation), in the same
 * transaction as that receipt. Issue, return, release, manual allocation and
 * reversal stay Owner-only.
 */
export type CustodyPostOptions = { forReceiptOfJob?: string };

export async function postCustodyOperation(tx: Tx, input: PostCustodyInput, options: CustodyPostOptions = {}) {
  const receiptAllocation =
    options.forReceiptOfJob !== undefined && input.kind === "ALLOCATE_TO_JOB" && input.jobId === options.forReceiptOfJob && input.owner.role === "STAFF";
  if (input.owner.role !== "OWNER" && !receiptAllocation) throw new CustodyError("Only the Owner can post Karigar metal entries.");
  if (!input.idempotencyKey?.trim()) throw new CustodyError("Missing submission key — reload the page and try again.");

  // Purity is known up front except for a release (it comes from the job).
  let purityId = input.purityId ?? null;
  if (input.kind === "RELEASE_FROM_JOB" && input.jobId) {
    const line = await tx.jewelleryMetalIssueLine.findFirst({ where: { jobId: input.jobId, metalType: { not: "ALLOY" } }, select: { purityId: true } });
    purityId = line?.purityId ?? null;
  }
  await lockInOrder(tx, { purityId, karigarId: input.karigarId, jobId: input.jobId ?? null });
  await declareCustodyAware(tx);

  const existing = await tx.karigarMetalCustodyEntry.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.kind !== input.kind || existing.karigarId !== input.karigarId) {
      throw new CustodyError("This submission key was already used for a different entry.");
    }
    return { entry: existing, replayed: true as const };
  }

  const plan = await planCustodyOperation(tx, input);
  const fingerprint = custodyPlanFingerprint(plan);
  if (input.expectedFingerprint && input.expectedFingerprint !== fingerprint) {
    // Names only, never values: which figures moved since the preview.
    let changed: string[] = ["unreadable preview"];
    try {
      const was = JSON.parse(input.expectedFingerprint) as Record<string, unknown>;
      const now = JSON.parse(fingerprint) as Record<string, unknown>;
      changed = Object.keys(now).filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k]));
    } catch {
      /* keep the default */
    }
    console.warn(JSON.stringify({ event: "custody-stale-preview", kind: input.kind, changed }));
    throw new CustodyError("The balance changed after this preview was shown. Review the new preview and confirm again.");
  }

  const entryCode = await nextJewelleryCode(tx, "KARIGAR_METAL_CUSTODY");
  const noteBase = `${KIND_LABEL[plan.kind]} ${entryCode} — ${plan.karigarName}${plan.jobCode ? ` · ${plan.jobCode}` : ""} · ${plan.grossWeight.toFixed(3)}g ${plan.purityDisplayName}`;
  const voucherId = plan.postsVoucher
    ? await postCustodyVoucher(tx, {
        date: plan.entryDate,
        amount: plan.costValue,
        toWip: plan.kind === "ISSUE_TO_KARIGAR",
        note: noteBase,
        reference: plan.reference,
        userId: input.owner.id,
        fyStartMonth: input.fyStartMonth,
        fyStartDay: input.fyStartDay,
      })
    : null;

  const entry = await tx.karigarMetalCustodyEntry.create({
    data: {
      entryCode,
      kind: plan.kind,
      karigarId: plan.karigarId,
      jobId: plan.jobId,
      metalType: plan.metalType,
      purityId: plan.purityId,
      finenessPercentSnapshot: plan.finenessPercentSnapshot.toFixed(3),
      grossWeight: plan.grossWeight.toFixed(3),
      fineWeight: plan.fineWeight.toFixed(3),
      costValue: plan.costValue.toFixed(2),
      enteredWeightBasis: plan.enteredWeightBasis,
      entryDate: plan.entryDate,
      reason: plan.reason,
      reference: plan.reference,
      voucherId,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.owner.id,
    },
  });

  await tx.metalStockMovement.create({
    data: {
      type: CUSTODY_MOVEMENT[plan.kind],
      metalType: plan.metalType,
      purityId: plan.purityId,
      grossWeight: plan.grossWeight.toFixed(3),
      fineWeight: plan.fineWeight.toFixed(3),
      costValue: plan.costValue.toFixed(2),
      sourceDocument: entryCode,
      jewelleryJobId: plan.jobId,
      karigarId: plan.karigarId,
      custodyEntryId: entry.id,
      createdByUserId: input.owner.id,
    },
  });

  if (plan.kind === "ALLOCATE_TO_JOB" && plan.jobId) {
    const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: plan.jobId } });
    await tx.jewelleryMetalIssueLine.create({
      data: {
        jobId: plan.jobId,
        metalType: plan.metalType,
        purityId: plan.purityId,
        finenessPercentSnapshot: plan.finenessPercentSnapshot.toFixed(3),
        grossWeight: plan.grossWeight.toFixed(3),
        fineWeight: plan.fineWeight.toFixed(3),
        costValue: plan.costValue.toFixed(2),
        sourceCustodyEntryId: entry.id,
        issueDate: plan.entryDate,
      },
    });
    await tx.jewelleryJob.update({
      where: { id: plan.jobId },
      data: {
        status: job.status === "DRAFT" ? "MATERIALS_ISSUED" : undefined,
        issuedMetalFineWeight: { increment: plan.fineWeight.toFixed(3) },
        issuedMetalCost: { increment: plan.costValue.toFixed(2) },
        remainingWipCost: { increment: plan.costValue.toFixed(2) },
        custodyAllocatedFineWeight: { increment: plan.fineWeight.toFixed(3) },
        custodyAllocatedCost: { increment: plan.costValue.toFixed(2) },
      },
    });
  }
  if (plan.kind === "RELEASE_FROM_JOB" && plan.jobId) {
    await tx.jewelleryJob.update({
      where: { id: plan.jobId },
      data: {
        remainingWipCost: { decrement: plan.costValue.toFixed(2) },
        custodyReleasedFineWeight: { increment: plan.fineWeight.toFixed(3) },
        custodyReleasedCost: { increment: plan.costValue.toFixed(2) },
      },
    });
  }

  await assertConservation(tx, plan);
  return { entry, replayed: false as const, plan };
}

/** Proven inside the transaction, never assumed: every balance moved by exactly the planned amount. */
async function assertConservation(tx: Tx, plan: CustodyPlan) {
  const custody = await getCustodyBalanceInTx(tx, plan.karigarId, plan.metalType, plan.purityId);
  const ok =
    custody.grossWeight.equals(round3(plan.custodyAfter.gross)) &&
    custody.fineWeight.equals(round3(plan.custodyAfter.fine)) &&
    custody.costValue.equals(round2(plan.custodyAfter.cost)) &&
    !custody.grossWeight.isNegative() &&
    !custody.fineWeight.isNegative() &&
    !custody.costValue.isNegative();
  let jobOk = true;
  if (plan.jobId && plan.jobAfter) {
    const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: plan.jobId } });
    jobOk =
      pendingFineWeightOf(job).equals(round3(plan.jobAfter.pendingFine)) &&
      new Decimal(job.remainingWipCost).equals(round2(plan.jobAfter.wip)) &&
      !new Decimal(job.remainingWipCost).isNegative();
  }
  let stockOk = true;
  if (plan.stockAfter) {
    const stock = await getMetalStockBalanceInTx(tx, plan.metalType, plan.purityId);
    stockOk = stock.grossWeight.equals(round3(plan.stockAfter.gross)) && stock.costValue.equals(round2(plan.stockAfter.cost)) && !stock.grossWeight.isNegative();
  }
  if (!ok || !jobOk || !stockOk) throw new CustodyError("Internal balance check failed; nothing was saved.");
}

// ---------------------------------------------------------------------------
// Reversal
// ---------------------------------------------------------------------------

/**
 * Why this entry cannot be reversed right now, or null when it can. A reversal
 * restores every balance EXACTLY, so it is only allowed while nothing that
 * came later depends on the entry: no later un-reversed entry in the same
 * Karigar balance, and (for a job entry) no later receipt, transfer or
 * custody entry on that job.
 */
export async function custodyReversalBlock(tx: Tx, entryId: string): Promise<string | null> {
  const entry = await tx.karigarMetalCustodyEntry.findUnique({ where: { id: entryId }, include: { reversedBy: true, purity: true } });
  if (!entry) return "Entry not found.";
  if (entry.reversalOfEntryId) return "This entry is itself a reversal.";
  if (entry.reversedBy) return `Already reversed by ${entry.reversedBy.entryCode}.`;

  const later = await tx.karigarMetalCustodyEntry.findMany({
    where: {
      karigarId: entry.karigarId,
      metalType: entry.metalType,
      purityId: entry.purityId,
      createdAt: { gte: entry.createdAt },
      id: { not: entry.id },
      reversalOfEntryId: null,
      reversedBy: { is: null },
    },
    orderBy: { createdAt: "asc" },
  });
  if (later.length > 0) {
    return `Later entries in this Karigar balance depend on it (${later.map((l) => l.entryCode).join(", ")}). Reverse those first, newest first.`;
  }

  if (entry.jobId) {
    const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: entry.jobId } });
    if (job.status === "CANCELLED" || job.status === "COMPLETED") return `${job.jobCode} is ${statusText(job.status)}.`;
    const receipt = await tx.jewelleryReceipt.findFirst({ where: { jobId: job.id, createdAt: { gte: entry.createdAt } } });
    if (receipt) return `${job.jobCode} received ${receipt.receiptCode} after this entry — that receipt has used the metal.`;
    const transfer = await tx.jewelleryMetalTransfer.findFirst({
      where: { OR: [{ sourceJobId: job.id }, { destinationJobId: job.id }], createdAt: { gte: entry.createdAt }, correction: { state: "POSTED" } },
    });
    if (transfer) return `${job.jobCode} has a later metal transfer (${transfer.transferCode}). Reverse it first.`;
    const laterOnJob = await tx.karigarMetalCustodyEntry.findFirst({
      where: { jobId: job.id, createdAt: { gte: entry.createdAt }, id: { not: entry.id }, reversalOfEntryId: null, reversedBy: { is: null } },
    });
    if (laterOnJob) return `${job.jobCode} has a later custody entry (${laterOnJob.entryCode}). Reverse it first.`;
    const laterIssue = await tx.jewelleryMetalIssueLine.findFirst({
      where: { jobId: job.id, createdAt: { gte: entry.createdAt }, sourceCustodyEntryId: null, sourceTransferId: null },
    });
    if (laterIssue) return `${job.jobCode} had materials issued after this entry.`;
    if (entry.kind === "ALLOCATE_TO_JOB") {
      if (pendingFineWeightOf(job).lessThan(entry.fineWeight) || new Decimal(job.remainingWipCost).lessThan(entry.costValue)) {
        return `${job.jobCode} no longer holds the ${new Decimal(entry.fineWeight).toFixed(3)}g fine this entry allocated.`;
      }
    }
  }

  if (entry.kind === "RETURN_TO_STOCK") {
    const stock = await getMetalStockBalanceInTx(tx, entry.metalType, entry.purityId);
    if (stock.grossWeight.lessThan(entry.grossWeight) || stock.costValue.lessThan(entry.costValue)) {
      return `Only ${stock.grossWeight.toFixed(3)}g of ${entry.purity.displayName} is in stock now — the returned metal has since been used.`;
    }
  }
  return null;
}

export async function reverseCustodyEntry(
  tx: Tx,
  input: Fy & { entryId: string; reason: string; idempotencyKey?: string | null; owner: Owner }
) {
  if (input.owner.role !== "OWNER") throw new CustodyError("Only the Owner can reverse a Karigar metal entry.");
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10) throw new CustodyError("Give the reason for reversing (at least 10 characters).");

  const first = await tx.karigarMetalCustodyEntry.findUnique({ where: { id: input.entryId } });
  if (!first) throw new CustodyError("Entry not found.");
  await lockInOrder(tx, { purityId: first.purityId, karigarId: first.karigarId, jobId: first.jobId });
  await declareCustodyAware(tx);

  const block = await custodyReversalBlock(tx, input.entryId);
  if (block) throw new CustodyError(`Cannot reverse ${first.entryCode}: ${block}`);
  const entry = await tx.karigarMetalCustodyEntry.findUniqueOrThrow({
    where: { id: input.entryId },
    include: { karigar: true, job: true, purity: true, movements: true },
  });
  const original = entry.movements.find((m) => m.type === CUSTODY_MOVEMENT[entry.kind] && !m.reversalOfMovementId);
  if (!original) throw new CustodyError("The original ledger row for this entry is missing — nothing was changed.");

  const before = await getCustodyBalanceInTx(tx, entry.karigarId, entry.metalType, entry.purityId);
  const sign = CUSTODY_SIGN[entry.kind];
  const [gross, fine, cost] = [new Decimal(entry.grossWeight), new Decimal(entry.fineWeight), new Decimal(entry.costValue)];

  const entryCode = await nextJewelleryCode(tx, "KARIGAR_METAL_CUSTODY");
  const note = `Reversal ${entryCode} of ${entry.entryCode} (${KIND_LABEL[entry.kind].toLowerCase()}) — ${entry.karigar.name}${entry.job ? ` · ${entry.job.jobCode}` : ""}`;
  const today = new Date();
  // A reversal of an issue sends value back to stock; of a return, takes it out again.
  const voucherId =
    (entry.kind === "ISSUE_TO_KARIGAR" || entry.kind === "RETURN_TO_STOCK") && cost.greaterThan(0)
      ? await postCustodyVoucher(tx, {
          date: today,
          amount: cost,
          toWip: entry.kind === "RETURN_TO_STOCK",
          note,
          reference: entry.entryCode,
          userId: input.owner.id,
          fyStartMonth: input.fyStartMonth,
          fyStartDay: input.fyStartDay,
        })
      : null;

  const reversal = await tx.karigarMetalCustodyEntry.create({
    data: {
      entryCode,
      kind: entry.kind,
      karigarId: entry.karigarId,
      jobId: entry.jobId,
      metalType: entry.metalType,
      purityId: entry.purityId,
      finenessPercentSnapshot: entry.finenessPercentSnapshot,
      grossWeight: entry.grossWeight,
      fineWeight: entry.fineWeight,
      costValue: entry.costValue,
      entryDate: today,
      reason,
      reference: entry.entryCode,
      voucherId,
      reversalOfEntryId: entry.id,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.owner.id,
    },
  });
  await tx.metalStockMovement.create({
    data: {
      type: MIRROR_MOVEMENT[entry.kind],
      metalType: entry.metalType,
      purityId: entry.purityId,
      grossWeight: entry.grossWeight,
      fineWeight: entry.fineWeight,
      costValue: entry.costValue,
      sourceDocument: entryCode,
      jewelleryJobId: entry.jobId,
      karigarId: entry.karigarId,
      custodyEntryId: reversal.id,
      reversalOfMovementId: original.id,
      createdByUserId: input.owner.id,
    },
  });

  if (entry.kind === "ALLOCATE_TO_JOB" && entry.job) {
    // The job line this allocation created is derived data; the entry, its
    // reversal and both ledger rows keep the full history.
    await tx.jewelleryMetalIssueLine.deleteMany({ where: { sourceCustodyEntryId: entry.id } });
    const [otherMetal, diamonds, packets, others] = await Promise.all([
      tx.jewelleryMetalIssueLine.count({ where: { jobId: entry.job.id } }),
      tx.jewelleryDiamondIssueLine.count({ where: { jobId: entry.job.id } }),
      tx.jewelleryPacketIssueLine.count({ where: { jobId: entry.job.id } }),
      tx.jewelleryOtherMaterialLine.count({ where: { jobId: entry.job.id } }),
    ]);
    const nothingLeft = otherMetal + diamonds + packets + others === 0 && entry.job.status === "MATERIALS_ISSUED";
    await tx.jewelleryJob.update({
      where: { id: entry.job.id },
      data: {
        status: nothingLeft ? "DRAFT" : undefined,
        issuedMetalFineWeight: { decrement: entry.fineWeight },
        issuedMetalCost: { decrement: entry.costValue },
        remainingWipCost: { decrement: entry.costValue },
        custodyAllocatedFineWeight: { decrement: entry.fineWeight },
        custodyAllocatedCost: { decrement: entry.costValue },
      },
    });
  }
  if (entry.kind === "RELEASE_FROM_JOB" && entry.job) {
    await tx.jewelleryJob.update({
      where: { id: entry.job.id },
      data: {
        remainingWipCost: { increment: entry.costValue },
        custodyReleasedFineWeight: { decrement: entry.fineWeight },
        custodyReleasedCost: { decrement: entry.costValue },
      },
    });
  }

  const after = await getCustodyBalanceInTx(tx, entry.karigarId, entry.metalType, entry.purityId);
  const expected = {
    gross: before.grossWeight.minus(gross.times(sign)),
    fine: before.fineWeight.minus(fine.times(sign)),
    cost: round2(before.costValue.minus(cost.times(sign))),
  };
  if (
    !after.grossWeight.equals(expected.gross) ||
    !after.fineWeight.equals(expected.fine) ||
    !after.costValue.equals(expected.cost) ||
    after.grossWeight.isNegative() ||
    after.fineWeight.isNegative() ||
    after.costValue.isNegative()
  ) {
    throw new CustodyError("Internal balance check failed; nothing was changed.");
  }
  if (entry.job) {
    const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: entry.job.id } });
    if (new Decimal(job.remainingWipCost).isNegative() || pendingFineWeightOf(job).isNegative()) {
      throw new CustodyError("Internal balance check failed; nothing was changed.");
    }
  }
  return { reversal, original: entry };
}
