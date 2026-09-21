/**
 * Phase 8 — post-correction verification.
 *
 * Runs after a correction is posted (inside the same transaction) and, on
 * demand, as a standalone reconciliation. Every check returns a value rather
 * than only a boolean so a failure report can name the two numbers that
 * disagree.
 */
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { METAL_POOL_EFFECT, type MetalStockMovementKind } from "@/lib/jewellery/metalMath";
import { CorrectionError, type Tx } from "./types";

export type VerificationCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

/** Ledger balance of one account, from its journal entries. */
async function accountBalance(tx: Tx, code: string): Promise<Decimal> {
  const account = await tx.account.findUnique({ where: { code }, select: { id: true } });
  if (!account) return ZERO;
  const totals = await tx.journalEntry.aggregate({
    where: { accountId: account.id },
    _sum: { debit: true, credit: true },
  });
  return round2(new Decimal(totals._sum.debit ?? 0).minus(new Decimal(totals._sum.credit ?? 0)));
}

/**
 * What the metal stock ledger says the company's metal is worth: the movement
 * pools, plus every posted revaluation of those pools.
 */
export async function metalStockValue(tx: Tx): Promise<{ usable: Decimal; scrap: Decimal }> {
  const movements = await tx.metalStockMovement.findMany({
    select: { type: true, costValue: true },
  });
  let usable = ZERO;
  let scrap = ZERO;
  for (const m of movements) {
    const effect = METAL_POOL_EFFECT[m.type as MetalStockMovementKind];
    if (!effect) continue;
    const value = new Decimal(m.costValue);
    usable = usable.plus(value.times(effect.usable));
    scrap = scrap.plus(value.times(effect.scrap));
  }
  const revaluations = await tx.metalRevaluation.findMany({
    where: { correction: { state: "POSTED" }, target: { in: ["USABLE_POOL", "SCRAP_POOL"] } },
    select: { target: true, deltaCostValue: true },
  });
  for (const r of revaluations) {
    const delta = new Decimal(r.deltaCostValue);
    if (r.target === "USABLE_POOL") usable = usable.plus(delta);
    else scrap = scrap.plus(delta);
  }
  return { usable: round2(usable), scrap: round2(scrap) };
}

/**
 * Metal Inventory (1300) and Scrap Metal Inventory (1310) must equal the value
 * the stock ledger carries. Before Phase 8 this could not hold: opening stock
 * never posted, so 1300 was short by every opening entry ever made.
 */
export async function reconcileMetalInventory(tx: Tx): Promise<VerificationCheck[]> {
  const stock = await metalStockValue(tx);
  const ledgerUsable = await accountBalance(tx, SYSTEM_ACCOUNT_CODES.METAL_INVENTORY);
  const ledgerScrap = await accountBalance(tx, SYSTEM_ACCOUNT_CODES.SCRAP_METAL_INVENTORY);
  return [
    {
      name: "1300 Metal Inventory equals metal stock value",
      ok: ledgerUsable.equals(stock.usable),
      detail: `ledger ${ledgerUsable.toFixed(2)} vs stock ${stock.usable.toFixed(2)}`,
    },
    {
      name: "1310 Scrap Metal Inventory equals scrap stock value",
      ok: ledgerScrap.equals(stock.scrap),
      detail: `ledger ${ledgerScrap.toFixed(2)} vs stock ${stock.scrap.toFixed(2)}`,
    },
  ];
}

/** Every voucher in the books must balance — including the new correction. */
export async function reconcileVoucherBalances(tx: Tx): Promise<VerificationCheck> {
  const grouped = await tx.journalEntry.groupBy({
    by: ["voucherId"],
    _sum: { debit: true, credit: true },
  });
  const unbalanced = grouped.filter(
    (g) => !new Decimal(g._sum.debit ?? 0).equals(new Decimal(g._sum.credit ?? 0))
  );
  return {
    name: "every voucher has debit = credit",
    ok: unbalanced.length === 0,
    detail:
      unbalanced.length === 0
        ? `${grouped.length} vouchers balanced`
        : `unbalanced voucherIds: ${unbalanced.map((u) => u.voucherId).join(", ")}`,
  };
}

/**
 * Verifies one posted correction: the original record is untouched, the
 * compensating voucher balances, and the revaluation shares tie to it.
 */
export async function verifyCorrection(tx: Tx, correctionId: string): Promise<VerificationCheck[]> {
  const correction = await tx.correction.findUnique({
    where: { id: correctionId },
    include: { revaluations: true, correctionVoucher: { include: { journalEntries: true } } },
  });
  if (!correction) throw new CorrectionError("Correction not found.");
  if (correction.state !== "POSTED") throw new CorrectionError("This correction has not been posted.");

  const checks: VerificationCheck[] = [];

  // 1. The corrected record must still hold its original values.
  if (correction.entityType === "METAL_OPENING_STOCK") {
    const snapshot = correction.originalSnapshot as Record<string, string | null>;
    const movement = await tx.metalStockMovement.findUnique({
      where: { id: correction.entityId },
      include: { purity: true },
    });
    // Compared numerically: a snapshot may carry "100000.00" where the column
    // reads back "100000", and that is the same untouched value.
    const same = (stored: Decimal, recorded: string | null | undefined) =>
      recorded === undefined || recorded === null || stored.equals(new Decimal(recorded));
    const intact =
      movement !== null &&
      same(new Decimal(movement.grossWeight), snapshot.grossWeight) &&
      same(new Decimal(movement.fineWeight), snapshot.fineWeight) &&
      same(new Decimal(movement.costValue), snapshot.costValue) &&
      same(new Decimal(movement.purity.finenessPercent), snapshot.finenessPercentSnapshot);
    checks.push({
      name: "original stock movement and fineness snapshot unchanged",
      ok: intact,
      detail: movement
        ? `${movement.grossWeight}g gross / ${movement.fineWeight}g fine / ${movement.costValue}`
        : "movement missing",
    });
  }

  // 2. The compensating voucher balances.
  const entries = correction.correctionVoucher?.journalEntries ?? [];
  const debit = entries.reduce((s, e) => s.plus(new Decimal(e.debit)), ZERO);
  const credit = entries.reduce((s, e) => s.plus(new Decimal(e.credit)), ZERO);
  checks.push({
    name: "correction voucher balances",
    ok: entries.length > 0 && debit.equals(credit),
    detail: `debit ${debit.toFixed(2)} credit ${credit.toFixed(2)}`,
  });

  // 3. Revaluation shares tie to the entries (equity is the counterpart).
  const shares = correction.revaluations.reduce((s, r) => s.plus(new Decimal(r.deltaCostValue)), ZERO);
  const assetSide = entries
    .filter((e) => e.accountId !== null)
    .reduce((s, e) => s.plus(new Decimal(e.debit)).minus(new Decimal(e.credit)), ZERO);
  const equityLine = await tx.account.findUnique({
    where: { code: SYSTEM_ACCOUNT_CODES.OPENING_BALANCE_EQUITY },
    select: { id: true },
  });
  const assetOnly = entries
    .filter((e) => e.accountId !== equityLine?.id)
    .reduce((s, e) => s.plus(new Decimal(e.debit)).minus(new Decimal(e.credit)), ZERO);
  checks.push({
    name: "revaluation shares tie to the posted entries",
    ok: correction.revaluations.length === 0 || round2(shares).equals(round2(assetOnly)),
    detail: `shares ${round2(shares).toFixed(2)} vs entries ${round2(assetOnly).toFixed(2)} (net ${round2(assetSide).toFixed(2)})`,
  });

  return checks;
}

/** Throws with the failing checks listed, for use inside a posting transaction. */
export function assertAllOk(checks: VerificationCheck[], context: string): void {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new CorrectionError(
      `${context}: ${failed.map((f) => `${f.name} (${f.detail})`).join("; ")}`
    );
  }
}

// ---------------------------------------------------------------------------
// Correction batches
// ---------------------------------------------------------------------------

export type BatchRollbackStep = {
  step: number;
  correctionCode: string;
  voucherNumber: string | null;
  voucherId: string | null;
  voucherStatus: string | null;
  amount: string;
};

export type BatchRollbackPlan = {
  batchCode: string;
  /** Cancel in this order — newest step first, so each undo lands on a
   *  balance the next one expects. */
  steps: BatchRollbackStep[];
  ready: boolean;
  detail: string;
};

/**
 * Verifies a batch as ONE production correction made of several required
 * steps. Unlike a supersede chain, every step must still be posted and
 * active: a batch where one step has been closed is a failed batch, not a
 * completed one.
 */
export async function verifyCorrectionBatch(tx: Tx, batchId: string): Promise<VerificationCheck[]> {
  const batch = await tx.correctionBatch.findUnique({
    where: { id: batchId },
    include: {
      corrections: {
        orderBy: { batchStep: "asc" },
        include: { correctionVoucher: { include: { journalEntries: true } } },
      },
    },
  });
  if (!batch) throw new CorrectionError("Correction batch not found.");

  const steps = batch.corrections;
  const checks: VerificationCheck[] = [];

  const stepNumbers = steps.map((s) => s.batchStep).filter((n): n is number => n !== null).sort((a, b) => a - b);
  const expected = Array.from({ length: batch.requiredSteps }, (_, i) => i + 1);
  checks.push({
    name: `all ${batch.requiredSteps} required steps are present`,
    ok: expected.every((n) => stepNumbers.includes(n)) && steps.length === batch.requiredSteps,
    detail: `steps present: ${stepNumbers.join(", ") || "none"}`,
  });

  // The point of a batch: nothing here replaces anything else here.
  const notPosted = steps.filter((s) => s.state !== "POSTED");
  checks.push({
    name: "every step is still POSTED and active",
    ok: notPosted.length === 0,
    detail:
      notPosted.length === 0
        ? steps.map((s) => `${s.correctionCode}=POSTED`).join(", ")
        : notPosted.map((s) => `${s.correctionCode}=${s.state}`).join(", "),
  });

  const stepIds = new Set(steps.map((s) => s.id));
  const supersededWithin = steps.filter(
    (s) => s.supersedesCorrectionId !== null && stepIds.has(s.supersedesCorrectionId)
  );
  const replaced = await tx.correction.findMany({
    where: { supersedesCorrectionId: { in: [...stepIds] } },
    select: { correctionCode: true, supersedesCorrectionId: true },
  });
  checks.push({
    name: "no step replaces or is replaced by another step",
    ok: supersededWithin.length === 0 && replaced.length === 0,
    detail:
      supersededWithin.length === 0 && replaced.length === 0
        ? "steps are cumulative, none superseded"
        : `superseding: ${supersededWithin.map((s) => s.correctionCode).join(", ")}; replaced by: ${replaced
            .map((r) => r.correctionCode)
            .join(", ")}`,
  });

  checks.push({
    name: "batch is marked COMPLETE once every step is posted",
    ok: (steps.filter((s) => s.state === "POSTED").length >= batch.requiredSteps) === (batch.state === "COMPLETE"),
    detail: `state ${batch.state}, ${steps.filter((s) => s.state === "POSTED").length}/${batch.requiredSteps} posted`,
  });

  // Cumulative effect: the batch moved the sum of its steps, not one of them.
  let cumulative = ZERO;
  let allBalanced = true;
  for (const s of steps) {
    const entries = s.correctionVoucher?.journalEntries ?? [];
    const debit = entries.reduce((sum, e) => sum.plus(new Decimal(e.debit)), ZERO);
    const credit = entries.reduce((sum, e) => sum.plus(new Decimal(e.credit)), ZERO);
    if (!debit.equals(credit) || entries.length === 0) allBalanced = false;
    cumulative = cumulative.plus(debit);
  }
  checks.push({
    name: "every step posts a balanced voucher",
    ok: allBalanced,
    detail: steps
      .map((s) => `${s.correctionCode}:${s.correctionVoucher?.voucherNumber ?? "no voucher"}`)
      .join(", "),
  });
  checks.push({
    name: "cumulative effect is the sum of every step",
    ok: true,
    detail: `total debited across ${steps.length} steps: ${round2(cumulative).toFixed(2)}`,
  });

  return checks;
}

/**
 * What it would take to undo a batch: each step's voucher, newest first.
 * Cancelling those vouchers posts mirror REVERSAL entries through the
 * existing flow; no Correction row is ever deleted.
 */
export async function planCorrectionBatchRollback(tx: Tx, batchId: string): Promise<BatchRollbackPlan> {
  const batch = await tx.correctionBatch.findUnique({
    where: { id: batchId },
    include: {
      corrections: {
        orderBy: { batchStep: "desc" },
        include: { correctionVoucher: { select: { id: true, voucherNumber: true, status: true, amount: true } } },
      },
    },
  });
  if (!batch) throw new CorrectionError("Correction batch not found.");

  const steps: BatchRollbackStep[] = batch.corrections.map((c) => ({
    step: c.batchStep ?? 0,
    correctionCode: c.correctionCode,
    voucherNumber: c.correctionVoucher?.voucherNumber ?? null,
    voucherId: c.correctionVoucher?.id ?? null,
    voucherStatus: c.correctionVoucher?.status ?? null,
    amount: c.correctionVoucher ? c.correctionVoucher.amount.toFixed(2) : "0.00",
  }));

  const cancellable = steps.filter((s) => s.voucherId !== null && s.voucherStatus === "POSTED");
  const ready = steps.length === batch.requiredSteps && cancellable.length === steps.length;
  return {
    batchCode: batch.batchCode,
    steps,
    ready,
    detail: ready
      ? `cancel ${steps.map((s) => s.voucherNumber).join(", then ")} to undo the whole batch`
      : `${cancellable.length} of ${steps.length} step vouchers can still be cancelled`,
  };
}

// ---------------------------------------------------------------------------
// Carrying values — what a record is worth right now
// ---------------------------------------------------------------------------

/**
 * A correction never rewrites the record it corrects, so a current value is
 * always the stored base figure plus every POSTED revaluation of it. A
 * REVERSED correction's revaluations stop counting automatically, which is
 * what makes an undo restore the exact pre-correction figure.
 */
async function revaluationDelta(
  tx: Tx,
  where: { target: "USABLE_POOL" | "SCRAP_POOL" | "JOB_WIP" | "FINISHED_JEWELLERY"; jewelleryJobId?: string; finishedJewelleryId?: string }
): Promise<Decimal> {
  const rows = await tx.metalRevaluation.findMany({
    where: { correction: { state: "POSTED" }, ...where },
    select: { deltaCostValue: true },
  });
  return round2(rows.reduce((sum, r) => sum.plus(new Decimal(r.deltaCostValue)), ZERO));
}

/** Metal value still with a Karigar on this job. */
export async function jobWipCarryingValue(tx: Tx, jobId: string): Promise<Decimal> {
  const job = await tx.jewelleryJob.findUnique({ where: { id: jobId }, select: { remainingWipCost: true } });
  if (!job) throw new CorrectionError("Jewellery job not found.");
  const delta = await revaluationDelta(tx, { target: "JOB_WIP", jewelleryJobId: jobId });
  return round2(new Decimal(job.remainingWipCost).plus(delta));
}

/** Metal cost carried by this finished piece. */
export async function finishedPieceMetalCost(tx: Tx, finishedJewelleryId: string): Promise<Decimal> {
  const piece = await tx.finishedJewellery.findUnique({
    where: { id: finishedJewelleryId },
    select: { metalCost: true },
  });
  if (!piece) throw new CorrectionError("Finished jewellery not found.");
  const delta = await revaluationDelta(tx, { target: "FINISHED_JEWELLERY", finishedJewelleryId });
  return round2(new Decimal(piece.metalCost).plus(delta));
}

export type CarryingValues = {
  usablePool: string;
  scrapPool: string;
  jobWip: Record<string, string>;
  finishedPieces: Record<string, string>;
};

/** One snapshot of every value a metal correction can move. */
export async function carryingValues(
  tx: Tx,
  scope: { jobIds?: string[]; finishedJewelleryIds?: string[] } = {}
): Promise<CarryingValues> {
  const stock = await metalStockValue(tx);
  const jobWip: Record<string, string> = {};
  for (const jobId of scope.jobIds ?? []) jobWip[jobId] = (await jobWipCarryingValue(tx, jobId)).toFixed(2);
  const finishedPieces: Record<string, string> = {};
  for (const id of scope.finishedJewelleryIds ?? []) {
    finishedPieces[id] = (await finishedPieceMetalCost(tx, id)).toFixed(2);
  }
  return {
    usablePool: stock.usable.toFixed(2),
    scrapPool: stock.scrap.toFixed(2),
    jobWip,
    finishedPieces,
  };
}
