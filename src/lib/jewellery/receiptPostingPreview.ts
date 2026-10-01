import "server-only";

import { Decimal, ZERO } from "@/lib/accounting/money";
import type { Tx } from "@/lib/corrections/types";

/**
 * Exactly what saving a jewellery receipt would post, computed by running the
 * real posting function inside a transaction that is ALWAYS rolled back — no
 * second copy of the accounting formulas, so the preview cannot drift from the
 * save. Owner only: callers must never run this for Staff (it carries cost).
 */
export type ReceiptChargesEcho = {
  labour: string;
  making: string;
  setting: string;
  plating: string;
  other: string;
  total: string;
};

export type ReceiptPostingPreview = {
  /** Company materials in the finished pieces: metal (incl. alloy) + stones. */
  materials: string;
  /** Charges carried by the finished pieces. */
  charges: string;
  /** Customer-owned gold is never Company cost. */
  customerGoldCost: "0.00";
  customerGoldFine: string;
  /** Materials + charges: the Company cost of the pieces this receipt creates. */
  totalCompanyCost: string;
  lines: { accountCode: string; accountName: string; debit: string; credit: string; party: string | null }[];
  balanced: boolean;
};

export function chargesEcho(input: { labourCharge: unknown; makingCharge: unknown; settingCharge: unknown; platingCharge: unknown; otherExpense: unknown }): ReceiptChargesEcho {
  const v = (x: unknown) => new Decimal(String(x ?? 0) || 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const parts = [v(input.labourCharge), v(input.makingCharge), v(input.settingCharge), v(input.platingCharge), v(input.otherExpense)];
  return {
    labour: parts[0].toFixed(2),
    making: parts[1].toFixed(2),
    setting: parts[2].toFixed(2),
    plating: parts[3].toFixed(2),
    other: parts[4].toFixed(2),
    total: parts.reduce((s, p) => s.plus(p), ZERO).toFixed(2),
  };
}

class DryRunRollback extends Error {
  constructor(readonly preview: ReceiptPostingPreview) {
    super("dry-run rollback");
  }
}

type TxRunner = { $transaction: <T>(fn: (tx: Tx) => Promise<T>, options?: { timeout?: number; maxWait?: number }) => Promise<T> };

export async function dryRunReceiptPosting(
  db: TxRunner,
  run: (tx: Tx) => Promise<{ receipt: { postingVoucherId: string | null }; outputs?: { id: string }[] }>
): Promise<ReceiptPostingPreview> {
  try {
    await db.$transaction(
      async (tx) => {
        const result = await run(tx);
        const pieces = result.outputs?.length
          ? await tx.finishedJewellery.findMany({ where: { id: { in: result.outputs.map((o) => o.id) } } })
          : [];
        const lines = result.receipt.postingVoucherId
          ? await tx.journalEntry.findMany({ where: { voucherId: result.receipt.postingVoucherId }, include: { account: true, party: true } })
          : [];
        const sum = (f: (p: (typeof pieces)[number]) => unknown) => pieces.reduce((s, p) => s.plus(new Decimal(String(f(p)))), ZERO);
        const materials = sum((p) => p.metalCost).plus(sum((p) => p.diamondCost));
        const charges = sum((p) => p.labourAllocated);
        const dr = lines.reduce((s, l) => s.plus(new Decimal(String(l.debit))), ZERO);
        const cr = lines.reduce((s, l) => s.plus(new Decimal(String(l.credit))), ZERO);
        throw new DryRunRollback({
          materials: materials.toFixed(2),
          charges: charges.toFixed(2),
          customerGoldCost: "0.00",
          customerGoldFine: sum((p) => p.customerGoldFineWeight).toFixed(3),
          totalCompanyCost: materials.plus(charges).toFixed(2),
          lines: lines
            .filter((l) => !new Decimal(String(l.debit)).isZero() || !new Decimal(String(l.credit)).isZero())
            .sort((a, b) => Number(new Decimal(String(b.debit)).greaterThan(0)) - Number(new Decimal(String(a.debit)).greaterThan(0)) || a.account.code.localeCompare(b.account.code))
            .map((l) => ({
              accountCode: l.account.code,
              accountName: l.account.name,
              debit: new Decimal(String(l.debit)).toFixed(2),
              credit: new Decimal(String(l.credit)).toFixed(2),
              party: l.party?.name ?? null,
            })),
          balanced: dr.equals(cr),
        });
      },
      { timeout: 30000, maxWait: 15000 }
    );
  } catch (error) {
    if (error instanceof DryRunRollback) return error.preview;
    throw error;
  }
  throw new Error("Internal: the posting preview did not roll back.");
}
