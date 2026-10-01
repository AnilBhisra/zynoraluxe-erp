import "server-only";

import type { KarigarMetalCustodyKind, MetalType } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { purityIdsWithActiveRevaluation, replayPuritiesOnce } from "@/lib/corrections/jobCostReplay";
import type { Tx } from "@/lib/corrections/types";
import { prisma } from "@/lib/db/prisma";
import { round3 } from "@/lib/diamond/allocation";
import { CARRYING_COST_UNAVAILABLE, carryingFinishedPieceCosts, formatCarryingAmount, isUnavailable, type CarryingAmount } from "@/lib/jewellery/carryingCost";
import { custodyReversalBlock, KIND_LABEL, listCustodyBalancesInTx } from "@/lib/jewellery/karigarCustody";
import { canStillIssueMaterialsForJobs, getMetalStockBalanceInTx, getScrapMetalBalanceInTx, pendingFineWeightOf } from "@/lib/jewellery/posting";

/**
 * Read side of Karigar metal custody: the per-Karigar metal account (balances,
 * jobs, statement) and the ledger reconciliation. Every money figure is
 * returned only when `includeCost` is true — a Staff request never carries one.
 */

const OPEN_JOB_STATUSES = ["DRAFT", "MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"] as const;
const g3 = (d: Decimal) => round3(d).toFixed(3);
const money = (d: Decimal) => round2(d).toFixed(2);

export type KarigarPurityBalance = {
  metalType: MetalType;
  purityId: string;
  purityDisplayName: string;
  finenessPercent: string | null;
  unallocatedGross: string;
  unallocatedFine: string;
  /** Carrying value (replayed when the purity is revalued); null for Staff. */
  unallocatedCost: string | null;
  allocatedPendingFine: string;
  allocatedPendingGross: string;
  totalWithKarigarFine: string;
  totalWithKarigarGross: string;
};

export type KarigarJobRow = {
  id: string;
  jobCode: string;
  designName: string;
  status: string;
  purityDisplayName: string | null;
  pendingFine: string;
  pendingGross: string | null;
  remainingWipCost: string | null;
  allocatedFromCustodyFine: string;
  releasedToCustodyFine: string;
  canAllocate: boolean;
  canRelease: boolean;
  canIssueMaterials: boolean;
};

export type KarigarStatementRow = {
  id: string;
  entryCode: string;
  kind: KarigarMetalCustodyKind;
  kindLabel: string;
  isReversal: boolean;
  reversalOfCode: string | null;
  reversedByCode: string | null;
  entryDate: string;
  createdAt: string;
  createdByName: string;
  reason: string;
  reference: string | null;
  jobId: string | null;
  jobCode: string | null;
  purityDisplayName: string;
  grossWeight: string;
  fineWeight: string;
  /** "gross" / "fine" when the Owner typed that unit; null for a whole-balance entry. */
  enteredAs: "gross" | "fine" | null;
  /** +1 into the unallocated balance, -1 out of it. */
  direction: 1 | -1;
  costValue: string | null;
  voucherNumber: string | null;
  unallocatedGrossAfter: string;
  unallocatedFineAfter: string;
  /** Owner only: null when it can be reversed now, else why not. Always null for Staff. */
  reverseBlockedReason: string | null;
  canReverse: boolean;
};

export type KarigarMetalAccount = {
  karigarId: string;
  karigarName: string;
  karigarActive: boolean;
  byPurity: KarigarPurityBalance[];
  jobs: KarigarJobRow[];
  outcomes: {
    receivedFinishedFine: string;
    returnedUsableFine: string;
    scrapFine: string;
    confirmedNormalLossFine: string;
    confirmedAbnormalLossFine: string;
  };
  /** Owner only (null for Staff). */
  labourCharged: string | null;
  payableBalance: string | null;
  statement: KarigarStatementRow[];
};

const SIGN: Record<KarigarMetalCustodyKind, 1 | -1> = { ISSUE_TO_KARIGAR: 1, RELEASE_FROM_JOB: 1, RETURN_TO_STOCK: -1, ALLOCATE_TO_JOB: -1 };

async function jobPurityOf(tx: Tx, jobIds: string[]) {
  const lines = jobIds.length
    ? await tx.jewelleryMetalIssueLine.findMany({ where: { jobId: { in: jobIds }, metalType: { not: "ALLOY" } }, include: { purity: true } })
    : [];
  const byJob = new Map<string, { metalType: MetalType; purityId: string; displayName: string; fineness: Decimal } | "MIXED">();
  for (const l of lines) {
    const current = byJob.get(l.jobId);
    const next = { metalType: l.metalType, purityId: l.purityId, displayName: l.purity.displayName, fineness: new Decimal(l.finenessPercentSnapshot) };
    if (current === undefined) byJob.set(l.jobId, next);
    else if (current !== "MIXED" && (current.purityId !== next.purityId || !current.fineness.equals(next.fineness))) byJob.set(l.jobId, "MIXED");
  }
  return byJob;
}

/** Carrying value of each Karigar's unallocated custody for purities under an active revaluation, else the stored value. */
async function custodyCarrying(tx: Tx, karigarId: string, balances: { metalType: MetalType; purityId: string; costValue: Decimal }[]): Promise<Map<string, CarryingAmount>> {
  const out = new Map<string, CarryingAmount>();
  const active = await purityIdsWithActiveRevaluation(tx);
  const revalued = balances.filter((b) => active.has(`${b.metalType}:${b.purityId}`));
  const replays = await replayPuritiesOnce(tx, revalued.map((b) => ({ metalType: b.metalType, purityId: b.purityId })));
  for (const b of balances) {
    const k = `${b.metalType}:${b.purityId}`;
    if (!active.has(k)) {
      out.set(b.purityId, b.costValue);
      continue;
    }
    const outcome = replays.get(k);
    out.set(b.purityId, outcome && outcome.ok ? round2(outcome.custody.get(karigarId)?.newValue ?? ZERO) : CARRYING_COST_UNAVAILABLE);
  }
  return out;
}

export async function getKarigarMetalAccount(karigarId: string, options: { includeCost: boolean }): Promise<KarigarMetalAccount> {
  const tx = prisma;
  const karigar = await tx.party.findUniqueOrThrow({ where: { id: karigarId } });
  const [balances, allJobs, entries] = await Promise.all([
    listCustodyBalancesInTx(tx, karigarId),
    tx.jewelleryJob.findMany({ where: { karigarId }, orderBy: { createdAt: "desc" }, include: { receipts: { where: { reversedAt: null } } } }),
    tx.karigarMetalCustodyEntry.findMany({
      where: { karigarId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      include: { purity: true, job: true, createdBy: true, voucher: true, reversalOf: true, reversedBy: true },
    }),
  ]);
  const openJobs = allJobs.filter((j) => (OPEN_JOB_STATUSES as readonly string[]).includes(j.status));
  const jobPurity = await jobPurityOf(tx, allJobs.map((j) => j.id));
  const purityRows = await tx.metalPurity.findMany({
    where: { id: { in: [...new Set([...balances.map((b) => b.purityId), ...[...jobPurity.values()].flatMap((p) => (p === "MIXED" ? [] : [p.purityId]))])] } },
  });
  const purityById = new Map(purityRows.map((p) => [p.id, p]));
  const carrying = options.includeCost ? await custodyCarrying(tx, karigarId, balances) : new Map<string, CarryingAmount>();

  // Per purity: unallocated custody + pending on this Karigar's open jobs.
  const purityKeys = new Set<string>([...balances.map((b) => b.purityId)]);
  for (const j of openJobs) {
    const p = jobPurity.get(j.id);
    if (p && p !== "MIXED") purityKeys.add(p.purityId);
  }
  const byPurity: KarigarPurityBalance[] = [...purityKeys].map((pid) => {
    const b = balances.find((x) => x.purityId === pid);
    const purity = purityById.get(pid)!;
    let pendingFine = ZERO;
    let pendingGross = ZERO;
    for (const j of openJobs) {
      const p = jobPurity.get(j.id);
      if (!p || p === "MIXED" || p.purityId !== pid) continue;
      const pending = pendingFineWeightOf(j);
      pendingFine = pendingFine.plus(pending);
      if (p.fineness.greaterThan(0)) pendingGross = pendingGross.plus(round3(pending.times(100).dividedBy(p.fineness)));
    }
    const unGross = b?.grossWeight ?? ZERO;
    const unFine = b?.fineWeight ?? ZERO;
    const cost = carrying.get(pid);
    return {
      metalType: purity.metalType,
      purityId: pid,
      purityDisplayName: purity.displayName,
      finenessPercent: b?.finenessPercentSnapshot ? b.finenessPercentSnapshot.toFixed(3) : null,
      unallocatedGross: g3(unGross),
      unallocatedFine: g3(unFine),
      unallocatedCost: options.includeCost ? formatCarryingAmount(cost ?? b?.costValue ?? ZERO) : null,
      allocatedPendingFine: g3(pendingFine),
      allocatedPendingGross: g3(pendingGross),
      totalWithKarigarFine: g3(unFine.plus(pendingFine)),
      totalWithKarigarGross: g3(unGross.plus(pendingGross)),
    };
  });
  byPurity.sort((a, b) => a.purityDisplayName.localeCompare(b.purityDisplayName));

  const jobs: KarigarJobRow[] = [];
  const listedJobs = allJobs.filter((x) => (OPEN_JOB_STATUSES as readonly string[]).includes(x.status) || !new Decimal(x.custodyAllocatedFineWeight).isZero() || !new Decimal(x.custodyReleasedFineWeight).isZero());
  // One grouped query per table for every listed job (was six queries per job, one after another).
  const canIssue = await canStillIssueMaterialsForJobs(tx, listedJobs);
  for (const j of listedJobs) {
    const p = jobPurity.get(j.id);
    const pending = pendingFineWeightOf(j);
    const single = p && p !== "MIXED" ? p : null;
    jobs.push({
      id: j.id,
      jobCode: j.jobCode,
      designName: j.designName,
      status: j.status,
      purityDisplayName: p === "MIXED" ? "Mixed purities" : (single?.displayName ?? null),
      pendingFine: g3(pending),
      pendingGross: single && single.fineness.greaterThan(0) ? g3(pending.times(100).dividedBy(single.fineness)) : null,
      remainingWipCost: options.includeCost ? money(new Decimal(j.remainingWipCost)) : null,
      allocatedFromCustodyFine: g3(new Decimal(j.custodyAllocatedFineWeight)),
      releasedToCustodyFine: g3(new Decimal(j.custodyReleasedFineWeight)),
      canAllocate: ["DRAFT", "MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"].includes(j.status) && p !== "MIXED",
      canRelease: ["MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"].includes(j.status) && !!single && pending.greaterThan(0),
      canIssueMaterials: canIssue.get(j.id) ?? false,
    });
  }

  // Outcomes across every non-cancelled job of this Karigar.
  const counted = allJobs.filter((j) => j.status !== "CANCELLED");
  const sum = (f: (j: (typeof counted)[number]) => Decimal) => counted.reduce((s, j) => s.plus(f(j)), ZERO);
  const receipts = counted.flatMap((j) => j.receipts);
  const outcomes = {
    receivedFinishedFine: g3(sum((j) => new Decimal(j.receivedFineWeight))),
    returnedUsableFine: g3(sum((j) => new Decimal(j.returnedMetalFineWeight))),
    scrapFine: g3(sum((j) => new Decimal(j.scrapFineWeight))),
    confirmedNormalLossFine: g3(receipts.filter((r) => !r.isAbnormalLoss).reduce((s, r) => s.plus(r.processLossFineWeight), ZERO)),
    confirmedAbnormalLossFine: g3(receipts.filter((r) => r.isAbnormalLoss).reduce((s, r) => s.plus(r.processLossFineWeight), ZERO)),
  };

  let labourCharged: string | null = null;
  let payableBalance: string | null = null;
  if (options.includeCost) {
    labourCharged = money(receipts.reduce((s, r) => s.plus(r.labourCharge).plus(r.makingCharge).plus(r.settingCharge).plus(r.platingCharge).plus(r.otherExpense), ZERO));
    const accounts = await tx.account.findMany({ where: { code: { in: [SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE] } } });
    const agg = await tx.journalEntry.aggregate({ where: { partyId: karigarId, accountId: { in: accounts.map((a) => a.id) } }, _sum: { debit: true, credit: true } });
    // Positive = we owe the Karigar.
    payableBalance = money(new Decimal(agg._sum.credit ?? 0).minus(agg._sum.debit ?? 0));
  }

  // Reversal blocks (Owner only). custodyReversalBlock's first rule — a later
  // live entry in the same Karigar + metal + purity balance blocks it, newest
  // first — is decided here from the entries already loaded, with the same
  // message; only the newest live entry of each balance (at most one per
  // purity) still needs the full database check, and those run in parallel.
  const blocks = new Map<string, string | null>();
  if (options.includeCost) {
    const live = entries.filter((e) => !e.reversalOfEntryId && !e.reversedBy);
    const candidates: string[] = [];
    for (const e of live) {
      const later = live.filter(
        (l) => l.id !== e.id && l.metalType === e.metalType && l.purityId === e.purityId && l.createdAt.getTime() >= e.createdAt.getTime()
      );
      if (later.length > 0) {
        blocks.set(e.id, `Later entries in this Karigar balance depend on it (${later.map((l) => l.entryCode).join(", ")}). Reverse those first, newest first.`);
      } else {
        candidates.push(e.id);
      }
    }
    const checked = await Promise.all(candidates.map(async (id) => [id, await custodyReversalBlock(tx, id)] as const));
    for (const [id, b] of checked) blocks.set(id, b);
  }

  // Statement with the running unallocated balance per purity.
  const running = new Map<string, { gross: Decimal; fine: Decimal }>();
  const statement: KarigarStatementRow[] = [];
  for (const e of entries) {
    const direction = (SIGN[e.kind] * (e.reversalOfEntryId ? -1 : 1)) as 1 | -1;
    const r = running.get(e.purityId) ?? { gross: ZERO, fine: ZERO };
    r.gross = r.gross.plus(new Decimal(e.grossWeight).times(direction));
    r.fine = r.fine.plus(new Decimal(e.fineWeight).times(direction));
    running.set(e.purityId, r);
    const block = options.includeCost && !e.reversalOfEntryId && !e.reversedBy ? (blocks.get(e.id) ?? null) : "n/a";
    statement.push({
      id: e.id,
      entryCode: e.entryCode,
      kind: e.kind,
      kindLabel: e.reversalOfEntryId ? `Reversal: ${KIND_LABEL[e.kind]}` : KIND_LABEL[e.kind],
      isReversal: !!e.reversalOfEntryId,
      reversalOfCode: e.reversalOf?.entryCode ?? null,
      reversedByCode: e.reversedBy?.entryCode ?? null,
      entryDate: e.entryDate.toISOString(),
      createdAt: e.createdAt.toISOString(),
      createdByName: e.createdBy.name,
      reason: e.reason,
      reference: e.reference,
      jobId: e.jobId,
      jobCode: e.job?.jobCode ?? null,
      purityDisplayName: e.purity.displayName,
      grossWeight: g3(new Decimal(e.grossWeight)),
      fineWeight: g3(new Decimal(e.fineWeight)),
      enteredAs: e.enteredWeightBasis === "FINE" ? "fine" : e.enteredWeightBasis === "GROSS" ? "gross" : null,
      direction,
      costValue: options.includeCost ? money(new Decimal(e.costValue)) : null,
      voucherNumber: options.includeCost ? (e.voucher?.voucherNumber ?? null) : null,
      unallocatedGrossAfter: g3(r.gross),
      unallocatedFineAfter: g3(r.fine),
      reverseBlockedReason: options.includeCost && block !== "n/a" ? block : null,
      canReverse: options.includeCost && block === null,
    });
  }

  return {
    karigarId,
    karigarName: karigar.name,
    karigarActive: karigar.isActive,
    byPurity,
    jobs,
    outcomes,
    labourCharged,
    payableBalance,
    statement,
  };
}

export type KarigarCustodySummary = {
  karigarId: string;
  karigarName: string;
  unallocated: { purityDisplayName: string; gross: string; fine: string }[];
  openJobsCount: number;
  allocatedPendingFine: string;
  totalWithKarigarFine: string;
};

/** One row per Karigar that holds custody metal or has an open job — weights only. */
export async function listKarigarCustodySummaries(): Promise<KarigarCustodySummary[]> {
  const [karigars, balances, openJobs] = await Promise.all([
    prisma.party.findMany({ where: { type: "KARIGAR" }, orderBy: { name: "asc" } }),
    listCustodyBalancesInTx(prisma),
    prisma.jewelleryJob.findMany({ where: { status: { in: [...OPEN_JOB_STATUSES] } } }),
  ]);
  const purities = await prisma.metalPurity.findMany({ where: { id: { in: [...new Set(balances.map((b) => b.purityId))] } } });
  const nameOf = new Map(purities.map((p) => [p.id, p.displayName]));
  return karigars
    .map((k) => {
      const mine = balances.filter((b) => b.karigarId === k.id && b.grossWeight.greaterThan(0));
      const jobs = openJobs.filter((j) => j.karigarId === k.id);
      const pending = jobs.reduce((s, j) => s.plus(pendingFineWeightOf(j)), ZERO);
      const unFine = mine.reduce((s, b) => s.plus(b.fineWeight), ZERO);
      return {
        karigarId: k.id,
        karigarName: k.name,
        unallocated: mine.map((b) => ({ purityDisplayName: nameOf.get(b.purityId) ?? "", gross: g3(b.grossWeight), fine: g3(b.fineWeight) })),
        openJobsCount: jobs.length,
        allocatedPendingFine: g3(pending),
        totalWithKarigarFine: g3(unFine.plus(pending)),
      };
    })
    .filter((r) => r.unallocated.length > 0 || r.openJobsCount > 0);
}

// ---------------------------------------------------------------------------
// Ledger reconciliation
// ---------------------------------------------------------------------------

export type ReconciliationLine = {
  accountCode: string;
  label: string;
  ledger: Decimal;
  expected: Decimal;
  difference: Decimal;
  parts: { label: string; value: Decimal }[];
};

/**
 * Ledger against physical records: 1300 against every usable pool, 1310
 * against every scrap pool, 1320 against open-job WIP PLUS every Karigar's
 * unallocated custody, and 1330 against available finished stock at its
 * authoritative cost. A non-zero difference is shown, never hidden.
 */
export async function reconcileMetalLedger(tx: Tx): Promise<{ lines: ReconciliationLine[]; unavailable: boolean }> {
  const ledgerOf = async (code: string) => {
    const account = await tx.account.findUnique({ where: { code } });
    if (!account) return ZERO;
    const t = await tx.journalEntry.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } });
    return round2(new Decimal(t._sum.debit ?? 0).minus(t._sum.credit ?? 0));
  };

  const pools = await tx.metalStockMovement.findMany({ distinct: ["metalType", "purityId"], select: { metalType: true, purityId: true } });
  let usable = ZERO;
  let scrap = ZERO;
  for (const p of pools) {
    usable = usable.plus((await getMetalStockBalanceInTx(tx, p.metalType, p.purityId)).costValue);
    scrap = scrap.plus((await getScrapMetalBalanceInTx(tx, p.metalType, p.purityId)).costValue);
  }

  const jobs = await tx.jewelleryJob.findMany({
    where: { status: { not: "CANCELLED" } },
    include: { diamondIssueLines: { where: { resolvedAs: null } }, packetIssueLines: true },
  });
  const jobMetal = jobs.reduce((s, j) => s.plus(j.remainingWipCost).plus(j.remainingAlloyWipCost), ZERO);
  const jobStones = jobs.reduce(
    (s, j) =>
      s
        .plus(j.diamondIssueLines.reduce((d, l) => d.plus(l.costAtIssue), ZERO))
        .plus(j.packetIssueLines.reduce((d, l) => d.plus(l.costAtIssue).minus(l.setCost).minus(l.returnedCost).minus(l.damagedCost), ZERO)),
    ZERO
  );
  const wipReval = await tx.metalRevaluation.aggregate({ where: { correction: { state: "POSTED" }, target: "JOB_WIP" }, _sum: { deltaCostValue: true } });
  const custody = (await listCustodyBalancesInTx(tx)).reduce((s, b) => s.plus(b.costValue), ZERO);

  const available = await tx.finishedJewellery.findMany({
    where: { status: "AVAILABLE" },
    select: { id: true, jobId: true, metalCost: true, diamondCost: true, otherMaterialCost: true, labourAllocated: true, totalCost: true },
  });
  const carrying = await carryingFinishedPieceCosts(
    tx,
    available.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      metalCost: new Decimal(r.metalCost),
      diamondCost: new Decimal(r.diamondCost),
      otherMaterialCost: new Decimal(r.otherMaterialCost),
      labourAllocated: new Decimal(r.labourAllocated),
      totalCost: new Decimal(r.totalCost),
    }))
  );
  let unavailable = false;
  let finished = ZERO;
  for (const r of available) {
    const c = carrying.get(r.id)?.authoritativeCost;
    if (!c || isUnavailable(c)) unavailable = true;
    else finished = finished.plus(c);
  }

  const awaiting = await tx.finishedJewellery.findMany({
    where: { status: "CUSTOMER_AWAITING_DELIVERY" },
    select: { metalCost: true, diamondCost: true, labourAllocated: true },
  });
  const customerPieces = awaiting.reduce((s, p) => s.plus(p.metalCost).plus(p.diamondCost).plus(p.labourAllocated), ZERO);

  const line = (accountCode: string, label: string, ledger: Decimal, parts: { label: string; value: Decimal }[]): ReconciliationLine => {
    const expected = round2(parts.reduce((s, p) => s.plus(p.value), ZERO));
    return { accountCode, label, ledger, expected, difference: round2(ledger.minus(expected)), parts: parts.map((p) => ({ ...p, value: round2(p.value) })) };
  };

  return {
    unavailable,
    lines: [
      line(SYSTEM_ACCOUNT_CODES.METAL_INVENTORY, "Metal Inventory (warehouse)", await ledgerOf(SYSTEM_ACCOUNT_CODES.METAL_INVENTORY), [{ label: "Usable stock, every purity", value: usable }]),
      line(SYSTEM_ACCOUNT_CODES.SCRAP_METAL_INVENTORY, "Scrap Metal Inventory", await ledgerOf(SYSTEM_ACCOUNT_CODES.SCRAP_METAL_INVENTORY), [{ label: "Scrap stock, every purity", value: scrap }]),
      line(SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, "Jewellery WIP (with Karigars)", await ledgerOf(SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP), [
        { label: "Unallocated Karigar custody", value: custody },
        { label: "Metal pending on open jobs", value: jobMetal },
        { label: "Posted revaluations of job WIP", value: new Decimal(wipReval._sum.deltaCostValue ?? 0) },
        { label: "Diamonds / packet stones pending on open jobs", value: jobStones },
      ]),
      line(SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "Finished Jewellery Inventory", await ledgerOf(SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY), [
        { label: "Available finished pieces (authoritative cost)", value: finished },
      ]),
      // Customer Gold: the Company's own cost in Customer-owned pieces not yet delivered.
      line(SYSTEM_ACCOUNT_CODES.CUSTOMER_JEWELLERY_WIP, "Customer Jewellery Work Awaiting Delivery", await ledgerOf(SYSTEM_ACCOUNT_CODES.CUSTOMER_JEWELLERY_WIP), [
        { label: "Company cost in Customer-owned pieces awaiting delivery", value: customerPieces },
      ]),
    ],
  };
}
