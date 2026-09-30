import "server-only";

import type { CustomerGoldEntryKind, CustomerGoldLocation, MetalType, UserRole } from "@/generated/prisma/enums";
import { Decimal, type DecimalInput, ZERO } from "@/lib/accounting/money";
import type { Tx } from "@/lib/corrections/types";
import { round3 } from "@/lib/diamond/allocation";
import { fineWeightThousandths, formatThousandths, grossForFineThousandths, toThousandths } from "@/lib/jewellery/metalMath";
import { nextJewelleryCode } from "@/lib/jewellery/numbering";

/**
 * Customer Gold ledger core (see CUSTOMER_GOLD_DESIGN.md §2.2).
 *
 * A pool is one Customer's gold of one metal + purity + fineness snapshot.
 * Every entry moves weight from one LOCATION of a pool to another; a
 * location's balance is Σ in − Σ out (a reversal counts the other way). The
 * ledger never touches Company stock, vouchers or cost.
 *
 * This module has no dependency on the Company posting code, so posting.ts
 * can ask it "does this job hold Customer gold?" without a circular import.
 */

export class CustomerGoldError extends Error {}

export type Actor = { id: string; role: UserRole };

export const LOCATION_LABEL: Record<CustomerGoldLocation, string> = {
  CUSTOMER: "Customer",
  SAFE: "In safe (unallocated)",
  KARIGAR: "With Karigar",
  JOB: "On job",
  FINISHED: "Finished, awaiting delivery",
  DELIVERED: "Delivered to Customer",
  RETURNED: "Returned to Customer",
  LOSS: "Authorised process loss",
  SCRAP: "Scrap held for Customer",
  PURCHASED: "Bought by the Company (approved)",
};

export const ENTRY_KIND_LABEL: Record<CustomerGoldEntryKind, string> = {
  INTAKE: "Received from Customer",
  ISSUE_TO_KARIGAR: "Issued to Karigar",
  RETURN_FROM_KARIGAR: "Returned by Karigar",
  ALLOCATE_TO_JOB: "Allocated to job",
  RELEASE_FROM_JOB: "Released from job",
  CONSUME_TO_FINISHED: "Used in finished jewellery",
  JOB_RETURN: "Returned by Karigar at receipt",
  JOB_SCRAP: "Scrap at receipt (Customer's)",
  JOB_LOSS: "Authorised process loss",
  RETURN_TO_CUSTOMER: "Returned to Customer",
  SCRAP_RETURN_TO_CUSTOMER: "Scrap returned to Customer",
  DELIVER: "Delivered in finished jewellery",
  CONVERT_TO_COMPANY: "Bought by the Company (approved)",
};

// ---------------------------------------------------------------------------
// Weights — the exact half-up thousandths rules every receipt uses.
// ---------------------------------------------------------------------------

export const d3 = (v: DecimalInput | null | undefined) => round3(v === null || v === undefined || String(v).trim() === "" ? 0 : v);

export function fineOf(gross: DecimalInput, fineness: DecimalInput): Decimal {
  return new Decimal(formatThousandths(fineWeightThousandths(toThousandths(new Decimal(gross).toFixed(3)), toThousandths(new Decimal(fineness).toFixed(3)))));
}

/** A gross weight whose fine rounds back exactly to `fine`. */
export function grossForFine(fine: Decimal, fineness: Decimal): Decimal {
  const guess = new Decimal(formatThousandths(grossForFineThousandths(toThousandths(fine.toFixed(3)), toThousandths(fineness.toFixed(3)))));
  for (const g of [guess, guess.minus("0.001"), guess.plus("0.001"), guess.minus("0.002"), guess.plus("0.002")]) {
    if (g.greaterThan(0) && fineOf(g, fineness).equals(fine)) return g;
  }
  throw new CustomerGoldError(`${fine.toFixed(3)} g fine cannot be matched to a whole gross weight at ${fineness.toFixed(3)}% — enter the gross weight instead.`);
}

// ---------------------------------------------------------------------------
// Pools and balances (pure)
// ---------------------------------------------------------------------------

export type PoolKey = { customerId: string; metalType: MetalType; purityId: string; finenessPercentSnapshot: Decimal };
export const poolKeyString = (p: { customerId: string; metalType: MetalType; purityId: string; finenessPercentSnapshot: DecimalInput }) =>
  `${p.customerId}|${p.metalType}|${p.purityId}|${new Decimal(p.finenessPercentSnapshot).toFixed(3)}`;

export type Place = { location: CustomerGoldLocation; scopeId: string | null };
export const placeKey = (p: Place) => (p.scopeId ? `${p.location}:${p.scopeId}` : p.location);

type EntryLike = {
  customerId: string;
  metalType: MetalType;
  purityId: string;
  finenessPercentSnapshot: DecimalInput;
  grossWeight: DecimalInput;
  fineWeight: DecimalInput;
  fromLocation: CustomerGoldLocation;
  toLocation: CustomerGoldLocation;
  karigarId: string | null;
  jobId: string | null;
  finishedJewelleryId: string | null;
  reversalOfEntryId: string | null;
};

/** The scope (Karigar / job / piece) a location refers to on an entry. */
export function scopeOf(location: CustomerGoldLocation, e: { karigarId: string | null; jobId: string | null; finishedJewelleryId: string | null }): string | null {
  if (location === "KARIGAR") return e.karigarId;
  if (location === "JOB") return e.jobId;
  if (location === "FINISHED") return e.finishedJewelleryId;
  return null;
}

export type WeightPair = { gross: Decimal; fine: Decimal };
export type PoolBalance = PoolKey & { places: Map<string, WeightPair & Place> };

/** Pure: every pool's balance at every place. CUSTOMER (the outside world) is kept too: it is −(everything received). */
export function sumCustomerGoldEntries(entries: EntryLike[]): Map<string, PoolBalance> {
  const pools = new Map<string, PoolBalance>();
  for (const e of entries) {
    const key = poolKeyString(e);
    const pool =
      pools.get(key) ??
      ({ customerId: e.customerId, metalType: e.metalType, purityId: e.purityId, finenessPercentSnapshot: new Decimal(e.finenessPercentSnapshot), places: new Map() } as PoolBalance);
    const sign = e.reversalOfEntryId ? -1 : 1;
    const gross = new Decimal(e.grossWeight).times(sign);
    const fine = new Decimal(e.fineWeight).times(sign);
    for (const [location, direction] of [
      [e.fromLocation, -1],
      [e.toLocation, 1],
    ] as const) {
      const place: Place = { location, scopeId: scopeOf(location, e) };
      const k = placeKey(place);
      const b = pool.places.get(k) ?? { ...place, gross: ZERO, fine: ZERO };
      b.gross = round3(b.gross.plus(gross.times(direction)));
      b.fine = round3(b.fine.plus(fine.times(direction)));
      pool.places.set(k, b);
    }
    pools.set(key, pool);
  }
  return pools;
}

export function placeBalance(pool: PoolBalance | undefined, place: Place): WeightPair {
  const b = pool?.places.get(placeKey(place));
  return { gross: b?.gross ?? ZERO, fine: b?.fine ?? ZERO };
}

/** Every place except the outside world must be ≥ 0 in both gross and fine. */
export function negativePlaces(pool: PoolBalance): (WeightPair & Place)[] {
  return [...pool.places.values()].filter((b) => b.location !== "CUSTOMER" && (b.gross.isNegative() || b.fine.isNegative()));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function loadPoolInTx(tx: Tx, key: PoolKey): Promise<PoolBalance | undefined> {
  const entries = await tx.customerGoldEntry.findMany({
    where: { customerId: key.customerId, metalType: key.metalType, purityId: key.purityId, finenessPercentSnapshot: key.finenessPercentSnapshot.toFixed(3) },
  });
  return sumCustomerGoldEntries(entries).get(poolKeyString(key));
}

export async function loadCustomerPoolsInTx(tx: Tx, customerId?: string): Promise<PoolBalance[]> {
  const entries = await tx.customerGoldEntry.findMany({ where: customerId ? { customerId } : undefined, orderBy: { createdAt: "asc" } });
  return [...sumCustomerGoldEntries(entries).values()];
}

/** Customer gold currently ON a job (fine + gross), per pool. Used by the Company posting code as a guard. */
export async function customerGoldOnJobInTx(tx: Tx, jobId: string): Promise<(PoolKey & WeightPair)[]> {
  const touching = await tx.customerGoldEntry.findMany({ where: { jobId }, select: { customerId: true, metalType: true, purityId: true, finenessPercentSnapshot: true } });
  if (touching.length === 0) return [];
  const keys = new Map(touching.map((t) => [poolKeyString(t), t]));
  const out: (PoolKey & WeightPair)[] = [];
  for (const t of keys.values()) {
    const key = { ...t, finenessPercentSnapshot: new Decimal(t.finenessPercentSnapshot) };
    const pool = await loadPoolInTx(tx, key);
    const b = placeBalance(pool, { location: "JOB", scopeId: jobId });
    if (!b.fine.isZero() || !b.gross.isZero()) out.push({ ...key, ...b });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Locks — always purity → Customer → Karigar → job (the Company custody paths
// lock purity → Karigar → job, so the two can never wait on each other).
// ---------------------------------------------------------------------------

export async function lockCustomerGold(tx: Tx, keys: { purityId: string; customerId: string; karigarId?: string | null; jobId?: string | null }) {
  await tx.$queryRawUnsafe(`SELECT id FROM "metal_purities" WHERE id = $1 FOR UPDATE`, keys.purityId);
  const customer = await tx.$queryRawUnsafe<{ id: string }[]>(`SELECT id FROM "parties" WHERE id = $1 FOR UPDATE`, keys.customerId);
  if (customer.length === 0) throw new CustomerGoldError("Customer not found.");
  if (keys.karigarId) await tx.$queryRawUnsafe(`SELECT id FROM "parties" WHERE id = $1 FOR UPDATE`, keys.karigarId);
  if (keys.jobId) await tx.$queryRawUnsafe(`SELECT id FROM "jewellery_jobs" WHERE id = $1 FOR UPDATE`, keys.jobId);
}

// ---------------------------------------------------------------------------
// The one write path
// ---------------------------------------------------------------------------

export type EntryWrite = {
  kind: CustomerGoldEntryKind;
  pool: PoolKey;
  from: Place;
  to: Place;
  gross: Decimal;
  fine: Decimal;
  entryDate: Date;
  reason: string;
  reference?: string | null;
  karigarId?: string | null;
  jobId?: string | null;
  finishedJewelleryId?: string | null;
  jewelleryReceiptId?: string | null;
  customerGoldReceiptId?: string | null;
  purchaseId?: string | null;
  deliveryId?: string | null;
  reversalOfEntryId?: string | null;
  idempotencyKey?: string | null;
  createdByUserId: string;
  /**
   * A multi-entry reversal writes all its mirror entries first and proves the
   * pool non-negative once, on the final state (assertPoolNonNegative), so an
   * intermediate step can never refuse a reversal whose end state is sound.
   */
  deferBalanceCheck?: boolean;
};

/** Refuses (throws) if any place of the pool is negative. */
export async function assertPoolNonNegative(tx: Tx, key: PoolKey) {
  const pool = await loadPoolInTx(tx, key);
  const negative = pool ? negativePlaces(pool) : [];
  if (negative.length > 0) {
    const n = negative[0];
    throw new CustomerGoldError(
      `Not enough Customer gold ${LOCATION_LABEL[n.location].toLowerCase()} for this — it would go to ${n.fine.toFixed(3)} g fine. Nothing was saved.`
    );
  }
}

/**
 * Writes one ledger entry and proves the pool stays non-negative at every
 * place. Callers hold the locks. Throws (so the caller's transaction rolls
 * back) rather than ever leaving a negative balance.
 */
export async function writeCustomerGoldEntry(tx: Tx, w: EntryWrite) {
  if (w.gross.isNegative() || w.fine.isNegative() || (w.gross.isZero() && w.fine.isZero())) {
    throw new CustomerGoldError("Enter a weight above zero.");
  }
  const scopes = {
    karigarId: w.karigarId ?? (w.from.location === "KARIGAR" ? w.from.scopeId : w.to.location === "KARIGAR" ? w.to.scopeId : null),
    jobId: w.jobId ?? (w.from.location === "JOB" ? w.from.scopeId : w.to.location === "JOB" ? w.to.scopeId : null),
    finishedJewelleryId: w.finishedJewelleryId ?? (w.from.location === "FINISHED" ? w.from.scopeId : w.to.location === "FINISHED" ? w.to.scopeId : null),
  };
  for (const p of [w.from, w.to]) {
    if (p.scopeId && scopeOf(p.location, scopes) !== p.scopeId) throw new CustomerGoldError("Internal check failed: entry scope mismatch. Nothing was saved.");
  }
  const entryCode = await nextJewelleryCode(tx, "CUSTOMER_GOLD_ENTRY");
  const entry = await tx.customerGoldEntry.create({
    data: {
      entryCode,
      kind: w.kind,
      customerId: w.pool.customerId,
      metalType: w.pool.metalType,
      purityId: w.pool.purityId,
      finenessPercentSnapshot: w.pool.finenessPercentSnapshot.toFixed(3),
      grossWeight: w.gross.toFixed(3),
      fineWeight: w.fine.toFixed(3),
      fromLocation: w.from.location,
      toLocation: w.to.location,
      ...scopes,
      jewelleryReceiptId: w.jewelleryReceiptId ?? null,
      customerGoldReceiptId: w.customerGoldReceiptId ?? null,
      purchaseId: w.purchaseId ?? null,
      deliveryId: w.deliveryId ?? null,
      entryDate: w.entryDate,
      reason: w.reason,
      reference: w.reference ?? null,
      reversalOfEntryId: w.reversalOfEntryId ?? null,
      idempotencyKey: w.idempotencyKey ?? null,
      createdByUserId: w.createdByUserId,
    },
  });
  if (!w.deferBalanceCheck) await assertPoolNonNegative(tx, w.pool);
  return entry;
}

/**
 * Weight moved out of a place: the whole balance (exact), or a part whose
 * gross is its fine-weight share of the place's gross (rounded; the remainder
 * stays behind, so both always add back to the whole).
 */
export function shareOf(place: WeightPair, want: { fine?: Decimal | null; gross?: Decimal | null; all?: boolean }, fineness: Decimal): WeightPair {
  if (want.all) return { gross: place.gross, fine: place.fine };
  if (want.fine != null) {
    const fine = round3(want.fine);
    if (fine.equals(place.fine)) return { gross: place.gross, fine };
    const gross = place.fine.greaterThan(0) ? round3(place.gross.times(fine).dividedBy(place.fine)) : grossForFine(fine, fineness);
    return { gross, fine };
  }
  if (want.gross != null) {
    const gross = round3(want.gross);
    if (gross.equals(place.gross)) return { gross, fine: place.fine };
    return { gross, fine: fineOf(gross, fineness) };
  }
  throw new CustomerGoldError("Enter a weight.");
}
