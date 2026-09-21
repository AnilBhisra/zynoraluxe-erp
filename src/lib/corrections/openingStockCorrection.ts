/**
 * Phase 8 — corrections for an Opening Metal Stock entry.
 *
 * Two operations, deliberately separate so the two defects they fix stay
 * independently auditable:
 *
 *   R1 `planOpeningStockLedgerBackfill` — the opening entry never posted a
 *      journal entry at all (fixed forward in posting.ts). This brings the
 *      already-recorded value on to the books at the value the movement
 *      carries: Dr 1300 Metal Inventory / Cr 3000 Opening Balance Equity.
 *
 *   R2 `planOpeningStockRevaluation` — the value itself was wrong. The
 *      opening LAYER is revalued and the weighted-average pool recomputed
 *      from it, so the uplift lands wherever that metal actually went:
 *      usable stock, a Karigar's WIP, and each finished piece.
 *
 * Neither ever edits the original movement, its fineness snapshot, an issue
 * line, a receipt or a posted voucher.
 */
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import type { JournalLineInput } from "@/lib/accounting/posting";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import {
  replayMetalValues,
  type ReplayMovement,
  type ReplayMovementType,
  type ReplayReceipt,
} from "./metalReplay";
import {
  CorrectionError,
  type CorrectionPlan,
  type DownstreamUse,
  type PlannedImpact,
  type PlannedRevaluation,
  type Tx,
} from "./types";

/** Emits a debit or a credit for a signed delta; zero emits nothing. */
function signedLine(accountCode: string, delta: Decimal, description: string): JournalLineInput[] {
  if (delta.isZero()) return [];
  return delta.greaterThan(0)
    ? [{ accountCode, debit: delta.toFixed(2), description }]
    : [{ accountCode, credit: delta.negated().toFixed(2), description }];
}

async function loadOpeningMovement(tx: Tx, movementId: string) {
  const movement = await tx.metalStockMovement.findUnique({
    where: { id: movementId },
    include: { purity: true, voucher: true },
  });
  if (!movement) throw new CorrectionError("Opening stock entry not found.");
  if (movement.type !== "OPENING_IN") {
    throw new CorrectionError("This correction only applies to an Opening Metal Stock entry.");
  }
  return movement;
}

// ---------------------------------------------------------------------------
// R1 — bring an unposted opening entry on to the books
// ---------------------------------------------------------------------------

export async function planOpeningStockLedgerBackfill(
  tx: Tx,
  input: { movementId: string; reason: string }
): Promise<CorrectionPlan> {
  const movement = await loadOpeningMovement(tx, input.movementId);
  if (movement.voucherId) {
    throw new CorrectionError("This opening entry already posted its own voucher — there is nothing to bring on to the books.");
  }
  const value = round2(movement.costValue);
  if (!value.greaterThan(0)) {
    throw new CorrectionError("This opening entry carries no value, so it posts no journal entry.");
  }

  const label = `Opening stock ${movement.purity.displayName} ${new Decimal(movement.grossWeight).toFixed(3)}g`;
  const existingCorrection = await tx.correction.findFirst({
    where: { entityType: "METAL_OPENING_STOCK", entityId: movement.id, mode: "REVERSE_REPOST", state: "POSTED" },
  });
  if (existingCorrection) {
    throw new CorrectionError(`This opening entry was already brought on to the books by ${existingCorrection.correctionCode}.`);
  }

  const impacts: PlannedImpact[] = [
    {
      kind: "LEDGER",
      tableName: "accounts",
      recordId: SYSTEM_ACCOUNT_CODES.METAL_INVENTORY,
      recordLabel: "1300 Metal Inventory",
      field: "balance",
      oldValue: "not posted",
      newValue: `+${value.toFixed(2)}`,
    },
    {
      kind: "LEDGER",
      tableName: "accounts",
      recordId: SYSTEM_ACCOUNT_CODES.OPENING_BALANCE_EQUITY,
      recordLabel: "3000 Opening Balance Equity",
      field: "balance",
      oldValue: "not posted",
      newValue: `-${value.toFixed(2)}`,
    },
  ];

  return {
    entityType: "METAL_OPENING_STOCK",
    entityId: movement.id,
    entityLabel: label,
    mode: "REVERSE_REPOST",
    reason: input.reason,
    originalSnapshot: {
      movementId: movement.id,
      grossWeight: movement.grossWeight.toString(),
      fineWeight: movement.fineWeight.toString(),
      costValue: movement.costValue.toString(),
      finenessPercentSnapshot: movement.purity.finenessPercent.toString(),
      voucherId: null,
      note: "Opening metal stock posted no journal entry before Phase 8.",
    },
    correctedSnapshot: {
      movementId: movement.id,
      costValue: movement.costValue.toString(),
      postedTo: `Dr ${SYSTEM_ACCOUNT_CODES.METAL_INVENTORY} / Cr ${SYSTEM_ACCOUNT_CODES.OPENING_BALANCE_EQUITY}`,
    },
    downstream: [],
    impacts,
    ledgerLines: [
      { accountCode: SYSTEM_ACCOUNT_CODES.METAL_INVENTORY, debit: value.toFixed(2), description: label },
      { accountCode: SYSTEM_ACCOUNT_CODES.OPENING_BALANCE_EQUITY, credit: value.toFixed(2), description: label },
    ],
    amount: value.toFixed(2),
    voucherNote: `Opening metal stock brought on to the books — ${label}`,
    revaluations: [],
  };
}

// ---------------------------------------------------------------------------
// R2 — revalue the opening layer and everything downstream of it
// ---------------------------------------------------------------------------

export async function planOpeningStockRevaluation(
  tx: Tx,
  input: { movementId: string; newCostValue: string | number; reason: string }
): Promise<CorrectionPlan> {
  const movement = await loadOpeningMovement(tx, input.movementId);
  const newValue = round2(input.newCostValue);
  if (newValue.isNegative()) throw new CorrectionError("A corrected opening value cannot be negative.");
  const oldValue = round2(movement.costValue);
  if (newValue.equals(oldValue)) {
    throw new CorrectionError("The corrected value is the same as the saved value.");
  }

  const ledger = await tx.metalStockMovement.findMany({
    where: { metalType: movement.metalType, purityId: movement.purityId },
    orderBy: { createdAt: "asc" },
  });

  const jobIds = [...new Set(ledger.map((m) => m.jewelleryJobId).filter((id): id is string => id !== null))];
  const receipts = jobIds.length
    ? await tx.jewelleryReceipt.findMany({
        where: { jobId: { in: jobIds } },
        orderBy: { createdAt: "asc" },
        include: { job: { select: { id: true, status: true } }, outputs: true },
      })
    : [];

  const lastReceiptIdByJob = new Map<string, string>();
  for (const r of receipts) lastReceiptIdByJob.set(r.jobId, r.id);

  const replayReceipts: ReplayReceipt[] = receipts.map((r) => ({
    id: r.id,
    code: r.receiptCode,
    jobId: r.jobId,
    // A receipt closed the job's metal when the job ended on it: the engine
    // then handed the whole remaining pool to that receipt.
    isFinalMetal: lastReceiptIdByJob.get(r.jobId) === r.id && r.job.status === "COMPLETED",
    outputs: r.outputs.map((o) => ({
      id: o.id,
      label: o.finishedCode,
      fineMetalWeight: o.fineMetalWeight.toString(),
      metalCost: o.metalCost.toString(),
    })),
  }));

  const replayMovements: ReplayMovement[] = ledger.map((m) => ({
    id: m.id,
    type: m.type as ReplayMovementType,
    createdAt: m.createdAt,
    grossWeight: m.grossWeight.toString(),
    fineWeight: m.fineWeight.toString(),
    costValue: m.costValue.toString(),
    sourceDocument: m.sourceDocument,
    jewelleryJobId: m.jewelleryJobId,
  }));

  const result = replayMetalValues({
    movements: replayMovements,
    receipts: replayReceipts,
    targetMovementId: movement.id,
    targetNewCostValue: newValue.toFixed(2),
  });

  const jobsById = new Map(receipts.map((r) => [r.jobId, r.job]));
  const jobCodes = jobIds.length
    ? await tx.jewelleryJob.findMany({ where: { id: { in: jobIds } }, select: { id: true, jobCode: true } })
    : [];
  const jobCodeById = new Map(jobCodes.map((j) => [j.id, j.jobCode]));

  const impacts: PlannedImpact[] = [];
  const revaluations: PlannedRevaluation[] = [];
  const downstream: DownstreamUse[] = [];
  const ledgerLines: JournalLineInput[] = [];

  const label = `Opening stock ${movement.purity.displayName} ${new Decimal(movement.grossWeight).toFixed(3)}g`;

  // --- usable pool ---
  if (!result.usablePool.delta.isZero()) {
    impacts.push({
      kind: "STOCK",
      tableName: "metal_stock_movements",
      recordId: `${movement.metalType}:${movement.purityId}`,
      recordLabel: `${movement.purity.displayName} usable stock (${result.usablePool.grossWeight.toFixed(3)}g)`,
      field: "costValue",
      oldValue: result.usablePool.oldValue.toFixed(2),
      newValue: result.usablePool.newValue.toFixed(2),
    });
    revaluations.push({
      target: "USABLE_POOL",
      metalType: movement.metalType,
      purityId: movement.purityId,
      grossWeight: result.usablePool.grossWeight.toFixed(3),
      fineWeight: "0.000",
      oldCostValue: result.usablePool.oldValue.toFixed(2),
      newCostValue: result.usablePool.newValue.toFixed(2),
      deltaCostValue: result.usablePool.delta.toFixed(2),
      sourceMovementId: movement.id,
    });
    ledgerLines.push(
      ...signedLine(SYSTEM_ACCOUNT_CODES.METAL_INVENTORY, result.usablePool.delta, `Revaluation — ${label}`)
    );
  }

  // --- scrap pool ---
  if (!result.scrapPool.delta.isZero()) {
    impacts.push({
      kind: "STOCK",
      tableName: "metal_stock_movements",
      recordId: `scrap:${movement.metalType}:${movement.purityId}`,
      recordLabel: `${movement.purity.displayName} scrap (${result.scrapPool.grossWeight.toFixed(3)}g)`,
      field: "costValue",
      oldValue: result.scrapPool.oldValue.toFixed(2),
      newValue: result.scrapPool.newValue.toFixed(2),
    });
    revaluations.push({
      target: "SCRAP_POOL",
      metalType: movement.metalType,
      purityId: movement.purityId,
      grossWeight: result.scrapPool.grossWeight.toFixed(3),
      fineWeight: "0.000",
      oldCostValue: result.scrapPool.oldValue.toFixed(2),
      newCostValue: result.scrapPool.newValue.toFixed(2),
      deltaCostValue: result.scrapPool.delta.toFixed(2),
      sourceMovementId: movement.id,
    });
    ledgerLines.push(
      ...signedLine(SYSTEM_ACCOUNT_CODES.SCRAP_METAL_INVENTORY, result.scrapPool.delta, `Revaluation — scrap ${label}`)
    );
  }

  // --- job WIP still with a Karigar ---
  let wipDelta = ZERO;
  for (const [jobId, change] of result.jobWip) {
    if (change.delta.isZero()) continue;
    const jobCode = jobCodeById.get(jobId) ?? jobId;
    wipDelta = wipDelta.plus(change.delta);
    impacts.push({
      kind: "WIP",
      tableName: "jewellery_jobs",
      recordId: jobId,
      recordLabel: jobCode,
      field: "remainingWipCost",
      oldValue: change.oldValue.toFixed(2),
      newValue: change.newValue.toFixed(2),
    });
    downstream.push({
      kind: "WIP",
      tableName: "jewellery_jobs",
      recordId: jobId,
      recordLabel: jobCode,
      description: `${change.fineWeight.toFixed(3)}g fine still with the Karigar on ${jobCode}`,
    });
    revaluations.push({
      target: "JOB_WIP",
      metalType: movement.metalType,
      purityId: movement.purityId,
      grossWeight: "0.000",
      fineWeight: change.fineWeight.toFixed(3),
      oldCostValue: change.oldValue.toFixed(2),
      newCostValue: change.newValue.toFixed(2),
      deltaCostValue: change.delta.toFixed(2),
      jewelleryJobId: jobId,
      sourceMovementId: movement.id,
    });
  }
  if (!wipDelta.isZero()) {
    ledgerLines.push(...signedLine(SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, round2(wipDelta), `Revaluation — ${label}`));
  }

  // --- finished pieces ---
  let finishedDelta = ZERO;
  const soldPieces: string[] = [];
  const finishedIds = [...result.finishedPieces.keys()];
  const finishedRows = finishedIds.length
    ? await tx.finishedJewellery.findMany({
        where: { id: { in: finishedIds } },
        select: { id: true, finishedCode: true, status: true, totalCost: true },
      })
    : [];
  const finishedById = new Map(finishedRows.map((f) => [f.id, f]));

  for (const [pieceId, change] of result.finishedPieces) {
    if (change.delta.isZero()) continue;
    const piece = finishedById.get(pieceId);
    const pieceLabel = piece?.finishedCode ?? change.label;
    if (piece && piece.status === "SOLD") soldPieces.push(pieceLabel);
    finishedDelta = finishedDelta.plus(change.delta);
    impacts.push({
      kind: "FINISHED",
      tableName: "finished_jewellery",
      recordId: pieceId,
      recordLabel: pieceLabel,
      field: "metalCost",
      oldValue: change.oldValue.toFixed(2),
      newValue: change.newValue.toFixed(2),
    });
    downstream.push({
      kind: "FINISHED",
      tableName: "finished_jewellery",
      recordId: pieceId,
      recordLabel: pieceLabel,
      description: `${pieceLabel} carries ${change.fineWeight.toFixed(3)}g fine of this metal`,
    });
    revaluations.push({
      target: "FINISHED_JEWELLERY",
      metalType: movement.metalType,
      purityId: movement.purityId,
      grossWeight: "0.000",
      fineWeight: change.fineWeight.toFixed(3),
      oldCostValue: change.oldValue.toFixed(2),
      newCostValue: change.newValue.toFixed(2),
      deltaCostValue: change.delta.toFixed(2),
      finishedJewelleryId: pieceId,
      sourceMovementId: movement.id,
    });
  }
  if (!finishedDelta.isZero()) {
    ledgerLines.push(
      ...signedLine(SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, round2(finishedDelta), `Revaluation — ${label}`)
    );
  }

  // A sold piece's cost has already reached COGS; restating it silently would
  // change a reported profit. Owner decision D7 defers that to its own path.
  if (soldPieces.length > 0) {
    throw new CorrectionError(
      `${soldPieces.join(", ")} has already been sold. Revaluing a sold piece would change reported profit, so it needs its own COGS correction.`
    );
  }

  const total = round2(
    result.usablePool.delta.plus(result.scrapPool.delta).plus(wipDelta).plus(finishedDelta)
  );
  if (total.isZero()) {
    throw new CorrectionError("This correction has no effect on any current balance.");
  }

  // The counterpart of the whole uplift is the equity the opening entry
  // represents — the same account a correctly posted opening would have hit.
  ledgerLines.push(
    ...signedLine(SYSTEM_ACCOUNT_CODES.OPENING_BALANCE_EQUITY, total.negated(), `Revaluation — ${label}`)
  );

  // The voucher amount is the entry's debit total, which equals the net uplift
  // whenever every affected location moves the same way (the ordinary case).
  const totalDebit = round2(
    ledgerLines.reduce((sum, l) => sum.plus(new Decimal(l.debit ?? 0)), ZERO)
  );

  // Every job that consumed this metal is downstream use, even when fully closed.
  for (const jobId of jobIds) {
    if (result.jobWip.has(jobId)) continue;
    const jobCode = jobCodeById.get(jobId) ?? jobId;
    downstream.push({
      kind: "WIP",
      tableName: "jewellery_jobs",
      recordId: jobId,
      recordLabel: jobCode,
      description: `${jobCode} (${jobsById.get(jobId)?.status ?? "closed"}) drew on this metal`,
    });
  }

  return {
    entityType: "METAL_OPENING_STOCK",
    entityId: movement.id,
    entityLabel: label,
    mode: "REVALUE",
    reason: input.reason,
    originalSnapshot: {
      movementId: movement.id,
      grossWeight: movement.grossWeight.toString(),
      fineWeight: movement.fineWeight.toString(),
      costValue: oldValue.toFixed(2),
      finenessPercentSnapshot: movement.purity.finenessPercent.toString(),
      ratePerFineGram: new Decimal(movement.fineWeight).greaterThan(0)
        ? oldValue.dividedBy(movement.fineWeight).toFixed(4)
        : null,
    },
    correctedSnapshot: {
      movementId: movement.id,
      grossWeight: movement.grossWeight.toString(),
      fineWeight: movement.fineWeight.toString(),
      costValue: newValue.toFixed(2),
      finenessPercentSnapshot: movement.purity.finenessPercent.toString(),
      ratePerFineGram: new Decimal(movement.fineWeight).greaterThan(0)
        ? newValue.dividedBy(movement.fineWeight).toFixed(4)
        : null,
      note: "Weights and the fineness snapshot are unchanged; only value is restated.",
    },
    downstream,
    impacts,
    ledgerLines,
    amount: totalDebit.toFixed(2),
    voucherNote: `Opening metal stock revaluation — ${label}`,
    revaluations,
  };
}

// ---------------------------------------------------------------------------
// Re-planning a stored correction
// ---------------------------------------------------------------------------

/**
 * Rebuilds the plan for a stored correction from the CURRENT state of the
 * database. The approval path compares this with what the Owner approved, so
 * a preview that has gone stale can never post.
 */
export async function replanCorrection(
  tx: Tx,
  correction: { entityType: string; entityId: string; mode: string; reason: string; correctedSnapshot: unknown }
): Promise<CorrectionPlan> {
  if (correction.entityType !== "METAL_OPENING_STOCK") {
    throw new CorrectionError(
      "Corrections for this kind of record are not available yet. Tiers 8B-8E add the remaining modules."
    );
  }
  if (correction.mode === "REVERSE_REPOST") {
    return planOpeningStockLedgerBackfill(tx, {
      movementId: correction.entityId,
      reason: correction.reason,
    });
  }
  const snapshot = (correction.correctedSnapshot ?? {}) as { costValue?: string };
  if (snapshot.costValue === undefined) {
    throw new CorrectionError("This correction has no corrected value to re-check.");
  }
  return planOpeningStockRevaluation(tx, {
    movementId: correction.entityId,
    newCostValue: snapshot.costValue,
    reason: correction.reason,
  });
}
