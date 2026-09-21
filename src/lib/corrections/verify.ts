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
