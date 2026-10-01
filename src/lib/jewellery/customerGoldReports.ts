import "server-only";

import type { CustomerGoldEntryKind, CustomerGoldLocation } from "@/generated/prisma/enums";
import { Decimal, ZERO } from "@/lib/accounting/money";
import type { Tx } from "@/lib/corrections/types";
import { round3 } from "@/lib/diamond/allocation";
import { customerCreditSummaryInTx } from "@/lib/jewellery/oldGoldExchange";
import {
  ENTRY_KIND_LABEL,
  LOCATION_LABEL,
  type PoolBalance,
  loadCustomerPoolsInTx,
  placeBalance,
  scopeOf,
} from "@/lib/jewellery/customerGoldLedger";

/**
 * Customer Gold reports (CUSTOMER_GOLD_DESIGN.md §2.2). Weights are safe for
 * Staff; every money figure (declared value, purchase value, bill amounts,
 * Company cost) is included ONLY when `includeValues` is true — the caller
 * passes the Owner check, and a Staff payload simply never contains them.
 */

const f3 = (d: Decimal) => round3(d).toFixed(3);
const sumFine = (pool: PoolBalance, location: CustomerGoldLocation) =>
  [...pool.places.values()].filter((p) => p.location === location).reduce((s, p) => s.plus(p.fine), ZERO);
const sumGross = (pool: PoolBalance, location: CustomerGoldLocation) =>
  [...pool.places.values()].filter((p) => p.location === location).reduce((s, p) => s.plus(p.gross), ZERO);

export type CustomerGoldPoolRow = {
  customerId: string;
  customerName: string;
  metalType: string;
  purityId: string;
  purityDisplayName: string;
  finenessPercent: string;
  /** Fine grams. */
  received: string;
  safe: string;
  withKarigar: string;
  onJobs: string;
  finishedAwaitingDelivery: string;
  delivered: string;
  returnedToCustomer: string;
  authorisedLoss: string;
  scrapHeld: string;
  boughtByCompany: string;
  /** Still the Customer's and still with the Company: safe + Karigar + jobs + finished + scrap. */
  remaining: string;
  receivedGross: string;
  remainingGross: string;
  /** received − Σ places. Always 0.000 unless the ledger is corrupt. */
  difference: string;
  byKarigar: { karigarId: string; karigarName: string; fine: string; gross: string }[];
  byJob: { jobId: string; jobCode: string; fine: string; gross: string }[];
};

export async function listCustomerGoldPools(tx: Tx, customerId?: string): Promise<CustomerGoldPoolRow[]> {
  const pools = await loadCustomerPoolsInTx(tx, customerId);
  if (pools.length === 0) return [];
  const partyIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const p of pools) {
    partyIds.add(p.customerId);
    for (const pl of p.places.values()) {
      if (pl.location === "KARIGAR" && pl.scopeId) partyIds.add(pl.scopeId);
      if (pl.location === "JOB" && pl.scopeId) jobIds.add(pl.scopeId);
    }
  }
  const [parties, jobs, purities] = await Promise.all([
    tx.party.findMany({ where: { id: { in: [...partyIds] } }, select: { id: true, name: true } }),
    tx.jewelleryJob.findMany({ where: { id: { in: [...jobIds] } }, select: { id: true, jobCode: true } }),
    tx.metalPurity.findMany({ where: { id: { in: [...new Set(pools.map((p) => p.purityId))] } }, select: { id: true, displayName: true } }),
  ]);
  const name = (id: string) => parties.find((p) => p.id === id)?.name ?? "";
  return pools
    .map((p) => {
      const received = placeBalance(p, { location: "CUSTOMER", scopeId: null }).fine.negated();
      const receivedGross = placeBalance(p, { location: "CUSTOMER", scopeId: null }).gross.negated();
      const b = (l: CustomerGoldLocation) => sumFine(p, l);
      const sumPlaces = (["SAFE", "KARIGAR", "JOB", "FINISHED", "DELIVERED", "RETURNED", "LOSS", "SCRAP", "PURCHASED"] as const).reduce((s, l) => s.plus(b(l)), ZERO);
      const remaining = b("SAFE").plus(b("KARIGAR")).plus(b("JOB")).plus(b("FINISHED")).plus(b("SCRAP"));
      const remainingGross = (["SAFE", "KARIGAR", "JOB", "FINISHED", "SCRAP"] as const).reduce((s, l) => s.plus(sumGross(p, l)), ZERO);
      const nonZero = (loc: CustomerGoldLocation) => [...p.places.values()].filter((pl) => pl.location === loc && (!pl.fine.isZero() || !pl.gross.isZero()));
      return {
        customerId: p.customerId,
        customerName: name(p.customerId),
        metalType: p.metalType,
        purityId: p.purityId,
        purityDisplayName: purities.find((x) => x.id === p.purityId)?.displayName ?? "",
        finenessPercent: p.finenessPercentSnapshot.toFixed(3),
        received: f3(received),
        safe: f3(b("SAFE")),
        withKarigar: f3(b("KARIGAR")),
        onJobs: f3(b("JOB")),
        finishedAwaitingDelivery: f3(b("FINISHED")),
        delivered: f3(b("DELIVERED")),
        returnedToCustomer: f3(b("RETURNED")),
        authorisedLoss: f3(b("LOSS")),
        scrapHeld: f3(b("SCRAP")),
        boughtByCompany: f3(b("PURCHASED")),
        remaining: f3(remaining),
        receivedGross: f3(receivedGross),
        remainingGross: f3(remainingGross),
        difference: f3(received.minus(sumPlaces)),
        byKarigar: nonZero("KARIGAR").map((pl) => ({ karigarId: pl.scopeId!, karigarName: name(pl.scopeId!), fine: f3(pl.fine), gross: f3(pl.gross) })),
        byJob: nonZero("JOB").map((pl) => ({ jobId: pl.scopeId!, jobCode: jobs.find((j) => j.id === pl.scopeId)?.jobCode ?? "", fine: f3(pl.fine), gross: f3(pl.gross) })),
      };
    })
    .sort((a, b) => a.customerName.localeCompare(b.customerName) || a.purityDisplayName.localeCompare(b.purityDisplayName));
}

export type CustomerGoldStatementEntry = {
  id: string;
  entryCode: string;
  date: string;
  kind: CustomerGoldEntryKind;
  kindLabel: string;
  fromLabel: string;
  toLabel: string;
  purityDisplayName: string;
  finenessPercent: string;
  gross: string;
  fine: string;
  karigarName: string | null;
  jobCode: string | null;
  finishedCode: string | null;
  reference: string | null;
  reason: string;
  actorName: string;
  isReversal: boolean;
  reversedByCode: string | null;
  canReverse: boolean;
};

export type CustomerGoldStatement = {
  customer: { id: string; name: string; phone: string | null; address: string | null };
  pools: CustomerGoldPoolRow[];
  intakeReceipts: {
    id: string;
    receiptCode: string;
    intakeDate: string;
    purityDisplayName: string;
    finenessPercent: string;
    inputBasis: string;
    grossWeight: string;
    deductionWeight: string;
    netGrossWeight: string;
    fineWeight: string;
    reference: string | null;
    reason: string;
    /** Old Gold Exchange: what the Customer said the purity was (documentation only). */
    statedPurity: string | null;
    /** Owner only; documentation / insurance, never Company cost. */
    declaredValue: string | null;
  }[];
  entries: CustomerGoldStatementEntry[];
  purchases: {
    id: string;
    purchaseCode: string;
    date: string;
    purityDisplayName: string;
    gross: string;
    fine: string;
    settlement: string;
    fromCustody: boolean;
    /** Set for a one-step Old Gold Exchange: the intake it bought. */
    intakeReceiptCode: string | null;
    reference: string | null;
    status: string;
    reversedAt: string | null;
    /** Owner only. */
    rateBasis: string | null;
    rate: string | null;
    approvedValue: string | null;
  }[];
  /** Owner only: gold-purchase credit granted, applied by bills, still usable. */
  credit: { granted: string; applied: string; available: string } | null;
  pieces: { id: string; finishedCode: string; jobCode: string; status: string; netMetalWeight: string; fineMetalWeight: string; customerGoldFineWeight: string; companyCost: string | null }[];
  bills: { billCode: string; date: string; jobCode: string; status: string; taxableValue: string; taxAmount: string; grandTotal: string; creditApplied: string; amountDue: string }[] | null;
  deliveries: { deliveryCode: string; date: string; jobCode: string; status: string; receivedByName: string; deliveredBy: string; reference: string | null; customerGoldFine: string; pieces: string[] }[];
};

export async function customerGoldStatement(tx: Tx, customerId: string, opts: { includeValues: boolean }): Promise<CustomerGoldStatement | null> {
  const customer = await tx.party.findUnique({ where: { id: customerId } });
  if (!customer || customer.type !== "CUSTOMER") return null;
  const [pools, receipts, entries, purchases, pieces, bills, deliveries, credit] = await Promise.all([
    listCustomerGoldPools(tx, customerId),
    tx.customerGoldReceipt.findMany({ where: { customerId }, include: { purity: true }, orderBy: { createdAt: "asc" } }),
    tx.customerGoldEntry.findMany({
      where: { customerId },
      include: { purity: true, karigar: true, job: true, finishedJewellery: true, createdBy: true, reversedBy: true },
      orderBy: { createdAt: "asc" },
    }),
    tx.customerGoldPurchase.findMany({ where: { customerId }, include: { purity: true, customerGoldReceipt: { select: { receiptCode: true } } }, orderBy: { createdAt: "asc" } }),
    tx.finishedJewellery.findMany({ where: { customerId, ownership: "CUSTOMER" }, include: { job: true }, orderBy: { finishedCode: "asc" } }),
    opts.includeValues ? tx.customerJewelleryBill.findMany({ where: { customerId }, include: { job: true }, orderBy: { createdAt: "asc" } }) : Promise.resolve(null),
    tx.customerJewelleryDelivery.findMany({ where: { customerId }, include: { job: true, deliveredBy: true, items: { include: { finishedJewellery: true } } }, orderBy: { createdAt: "asc" } }),
    opts.includeValues ? customerCreditSummaryInTx(tx, customerId) : Promise.resolve(null),
  ]);
  const place = (loc: CustomerGoldLocation, e: (typeof entries)[number]) => {
    const s = scopeOf(loc, e);
    const suffix = loc === "KARIGAR" && e.karigar ? ` (${e.karigar.name})` : loc === "JOB" && e.job ? ` (${e.job.jobCode})` : loc === "FINISHED" && e.finishedJewellery ? ` (${e.finishedJewellery.finishedCode})` : "";
    return s !== undefined ? `${LOCATION_LABEL[loc]}${suffix}` : LOCATION_LABEL[loc];
  };
  const reversibleKinds: CustomerGoldEntryKind[] = ["INTAKE", "ISSUE_TO_KARIGAR", "RETURN_FROM_KARIGAR", "ALLOCATE_TO_JOB", "RELEASE_FROM_JOB", "RETURN_TO_CUSTOMER", "SCRAP_RETURN_TO_CUSTOMER"];
  // Newest-first: only the newest live entry of each pool can be reversed.
  const newestLive = new Map<string, string>();
  for (const e of entries) {
    if (e.reversalOfEntryId || e.reversedBy) continue;
    newestLive.set(`${e.purityId}|${new Decimal(e.finenessPercentSnapshot).toFixed(3)}`, e.id);
  }
  return {
    customer: { id: customer.id, name: customer.name, phone: customer.phone, address: customer.address },
    pools,
    intakeReceipts: receipts.map((r) => ({
      id: r.id,
      receiptCode: r.receiptCode,
      intakeDate: r.intakeDate.toISOString(),
      purityDisplayName: r.purity.displayName,
      finenessPercent: new Decimal(r.finenessPercentSnapshot).toFixed(3),
      inputBasis: r.inputBasis,
      grossWeight: new Decimal(r.grossWeight).toFixed(3),
      deductionWeight: new Decimal(r.deductionWeight).toFixed(3),
      netGrossWeight: new Decimal(r.netGrossWeight).toFixed(3),
      fineWeight: new Decimal(r.fineWeight).toFixed(3),
      reference: r.reference,
      reason: r.reason,
      statedPurity: r.statedPurity,
      declaredValue: opts.includeValues && r.declaredValue != null ? new Decimal(r.declaredValue).toFixed(2) : null,
    })),
    entries: entries.map((e) => ({
      id: e.id,
      entryCode: e.entryCode,
      date: e.entryDate.toISOString(),
      kind: e.kind,
      kindLabel: `${e.reversalOfEntryId ? "Reversal — " : ""}${ENTRY_KIND_LABEL[e.kind]}`,
      fromLabel: place(e.fromLocation, e),
      toLabel: place(e.toLocation, e),
      purityDisplayName: e.purity.displayName,
      finenessPercent: new Decimal(e.finenessPercentSnapshot).toFixed(3),
      gross: new Decimal(e.grossWeight).toFixed(3),
      fine: new Decimal(e.fineWeight).toFixed(3),
      karigarName: e.karigar?.name ?? null,
      jobCode: e.job?.jobCode ?? null,
      finishedCode: e.finishedJewellery?.finishedCode ?? null,
      reference: e.reference,
      reason: e.reason,
      actorName: e.createdBy.name,
      isReversal: Boolean(e.reversalOfEntryId),
      reversedByCode: e.reversedBy?.entryCode ?? null,
      canReverse:
        opts.includeValues &&
        !e.reversalOfEntryId &&
        !e.reversedBy &&
        !e.jewelleryReceiptId &&
        reversibleKinds.includes(e.kind) &&
        newestLive.get(`${e.purityId}|${new Decimal(e.finenessPercentSnapshot).toFixed(3)}`) === e.id,
    })),
    purchases: purchases.map((p) => ({
      id: p.id,
      purchaseCode: p.purchaseCode,
      date: p.purchaseDate.toISOString(),
      purityDisplayName: p.purity.displayName,
      gross: new Decimal(p.grossWeight).toFixed(3),
      fine: new Decimal(p.fineWeight).toFixed(3),
      settlement: p.settlement,
      fromCustody: p.fromCustody,
      intakeReceiptCode: p.customerGoldReceipt?.receiptCode ?? null,
      reference: p.reference,
      status: p.status,
      reversedAt: p.reversedAt?.toISOString() ?? null,
      rateBasis: opts.includeValues ? p.rateBasis : null,
      rate: opts.includeValues ? new Decimal(p.rate).toFixed(4) : null,
      approvedValue: opts.includeValues ? new Decimal(p.approvedValue).toFixed(2) : null,
    })),
    credit: credit ? { granted: credit.granted.toFixed(2), applied: credit.applied.toFixed(2), available: credit.available.toFixed(2) } : null,
    pieces: pieces.map((p) => ({
      id: p.id,
      finishedCode: p.finishedCode,
      jobCode: p.job.jobCode,
      status: p.status,
      netMetalWeight: new Decimal(p.netMetalWeight).toFixed(3),
      fineMetalWeight: new Decimal(p.fineMetalWeight).toFixed(3),
      customerGoldFineWeight: new Decimal(p.customerGoldFineWeight).toFixed(3),
      companyCost: opts.includeValues ? new Decimal(p.metalCost).plus(p.diamondCost).plus(p.labourAllocated).toFixed(2) : null,
    })),
    bills: bills
      ? bills.map((b) => ({
          billCode: b.billCode,
          date: b.billDate.toISOString(),
          jobCode: b.job.jobCode,
          status: b.status,
          taxableValue: new Decimal(b.taxableValue).toFixed(2),
          taxAmount: new Decimal(b.taxAmount).toFixed(2),
          grandTotal: new Decimal(b.grandTotal).toFixed(2),
          creditApplied: new Decimal(b.creditApplied).toFixed(2),
          amountDue: new Decimal(b.amountDue).toFixed(2),
        }))
      : null,
    deliveries: deliveries.map((d) => ({
      deliveryCode: d.deliveryCode,
      date: d.deliveryDate.toISOString(),
      jobCode: d.job.jobCode,
      status: d.status,
      receivedByName: d.receivedByName,
      deliveredBy: d.deliveredBy.name,
      reference: d.reference,
      customerGoldFine: new Decimal(d.customerGoldFineTotal).toFixed(3),
      pieces: d.items.map((i) => i.finishedJewellery.finishedCode),
    })),
  };
}

/** Customer gold each Karigar holds, per Customer (weights only). */
export async function karigarWiseCustomerGold(tx: Tx) {
  const pools = await listCustomerGoldPools(tx);
  return pools.flatMap((p) =>
    p.byKarigar.map((k) => ({ karigarId: k.karigarId, karigarName: k.karigarName, customerName: p.customerName, purityDisplayName: p.purityDisplayName, finenessPercent: p.finenessPercent, fine: k.fine, gross: k.gross }))
  ).sort((a, b) => a.karigarName.localeCompare(b.karigarName) || a.customerName.localeCompare(b.customerName));
}

/** Per job: Customer gold on it now and what its receipts consumed / returned / scrapped / lost (weights only). */
export async function jobWiseCustomerGold(tx: Tx) {
  const entries = await tx.customerGoldEntry.findMany({ where: { jobId: { not: null } }, include: { job: { include: { customer: true } }, purity: true } });
  const byJob = new Map<string, { jobId: string; jobCode: string; status: string; customerName: string; purityDisplayName: string; onJob: Decimal; consumed: Decimal; returned: Decimal; scrap: Decimal; loss: Decimal }>();
  for (const e of entries) {
    if (!e.job) continue;
    const r = byJob.get(e.job.id) ?? { jobId: e.job.id, jobCode: e.job.jobCode, status: e.job.status, customerName: e.job.customer?.name ?? "", purityDisplayName: e.purity.displayName, onJob: ZERO, consumed: ZERO, returned: ZERO, scrap: ZERO, loss: ZERO };
    const sign = e.reversalOfEntryId ? -1 : 1;
    const fine = new Decimal(e.fineWeight).times(sign);
    if (e.toLocation === "JOB") r.onJob = r.onJob.plus(fine);
    if (e.fromLocation === "JOB") r.onJob = r.onJob.minus(fine);
    if (e.kind === "CONSUME_TO_FINISHED") r.consumed = r.consumed.plus(fine);
    if (e.kind === "JOB_RETURN") r.returned = r.returned.plus(fine);
    if (e.kind === "JOB_SCRAP") r.scrap = r.scrap.plus(fine);
    if (e.kind === "JOB_LOSS") r.loss = r.loss.plus(fine);
    byJob.set(e.job.id, r);
  }
  return [...byJob.values()]
    .map((r) => ({ ...r, onJob: f3(r.onJob), consumed: f3(r.consumed), returned: f3(r.returned), scrap: f3(r.scrap), loss: f3(r.loss) }))
    .sort((a, b) => a.jobCode.localeCompare(b.jobCode));
}

/** Customer-owned finished pieces not yet delivered. Company cost only with includeValues. */
export async function customerJewelleryAwaitingDelivery(tx: Tx, opts: { includeValues: boolean }) {
  const pieces = await tx.finishedJewellery.findMany({ where: { status: "CUSTOMER_AWAITING_DELIVERY" }, include: { job: true, customer: true }, orderBy: { finishedCode: "asc" } });
  return pieces.map((p) => ({
    id: p.id,
    finishedCode: p.finishedCode,
    jobId: p.jobId,
    jobCode: p.job.jobCode,
    jobStatus: p.job.status,
    customerName: p.customer?.name ?? "",
    netMetalWeight: new Decimal(p.netMetalWeight).toFixed(3),
    customerGoldFineWeight: new Decimal(p.customerGoldFineWeight).toFixed(3),
    companyCost: opts.includeValues ? new Decimal(p.metalCost).plus(p.diamondCost).plus(p.labourAllocated).toFixed(2) : null,
  }));
}

/** Things that need someone's attention (weights only). */
export async function customerGoldExceptions(tx: Tx) {
  const [pools, jobs, deliveredUnbilled] = await Promise.all([
    listCustomerGoldPools(tx),
    jobWiseCustomerGold(tx),
    tx.customerJewelleryDelivery.findMany({ where: { status: "POSTED", job: { customerJewelleryBills: { none: { status: "POSTED" } } } }, include: { job: true } }),
  ]);
  const out: { kind: string; detail: string }[] = [];
  for (const p of pools) {
    if (p.difference !== "0.000") out.push({ kind: "LEDGER", detail: `${p.customerName} ${p.purityDisplayName}: received and places differ by ${p.difference} g fine.` });
    if (p.scrapHeld !== "0.000") out.push({ kind: "SCRAP", detail: `${p.customerName}: ${p.scrapHeld} g fine of scrap held — return it to the Customer.` });
  }
  for (const j of jobs) {
    if ((j.status === "COMPLETED" || j.status === "CANCELLED") && j.onJob !== "0.000") out.push({ kind: "JOB", detail: `${j.jobCode} is ${j.status.toLowerCase()} but still shows ${j.onJob} g fine of Customer gold.` });
    if (j.loss !== "0.000") out.push({ kind: "LOSS", detail: `${j.jobCode}: ${j.loss} g fine authorised process loss of ${j.customerName}'s gold.` });
  }
  for (const d of deliveredUnbilled) out.push({ kind: "UNBILLED", detail: `${d.deliveryCode} (${d.job.jobCode}) was delivered but the job has no bill.` });
  return out;
}

/** Global: every pool's received = its places; the Company ledger lines are reported alongside by the caller. */
export async function customerGoldReconciliation(tx: Tx) {
  const pools = await listCustomerGoldPools(tx);
  const total = (k: keyof CustomerGoldPoolRow) => f3(pools.reduce((s, p) => s.plus(new Decimal(p[k] as string)), ZERO));
  return {
    pools,
    totals: {
      received: total("received"),
      safe: total("safe"),
      withKarigar: total("withKarigar"),
      onJobs: total("onJobs"),
      finishedAwaitingDelivery: total("finishedAwaitingDelivery"),
      delivered: total("delivered"),
      returnedToCustomer: total("returnedToCustomer"),
      authorisedLoss: total("authorisedLoss"),
      scrapHeld: total("scrapHeld"),
      boughtByCompany: total("boughtByCompany"),
      difference: total("difference"),
    },
  };
}
