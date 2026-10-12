import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { ClearingEntryKind } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, type DecimalInput, round2 } from "@/lib/accounting/money";

/**
 * The clearing sub-ledger hooks the core posting engine calls (sale to a
 * clearing party, sale return, generic voucher reversal). Kept apart from
 * clearing.ts so posting.ts can use them without an import cycle. See
 * CLEARING_SETTLEMENT_DESIGN.md.
 */
type Tx = Prisma.TransactionClient;
const r4 = (v: DecimalInput) => new Decimal(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);


/** The clearing account ids (null when the migration is not applied — e.g. unit-test fakes). */
export async function clearingAccountIds(tx: Tx): Promise<{ available: string | null; reserve: string | null }> {
  const [a, r] = await Promise.all([
    tx.account.findUnique({ where: { code: SYSTEM_ACCOUNT_CODES.MARKETPLACE_CLEARING } }),
    tx.account.findUnique({ where: { code: SYSTEM_ACCOUNT_CODES.MARKETPLACE_RESERVE } }),
  ]);
  return { available: a?.id ?? null, reserve: r?.id ?? null };
}

export async function recordClearingEntry(
  tx: Tx,
  e: { partyId: string; currencyCode: string; kind: ClearingEntryKind; fc: DecimalInput; inr: DecimalInput; voucherId: string }
) {
  await tx.clearingEntry.create({
    data: { partyId: e.partyId, currencyCode: e.currencyCode.trim().toUpperCase(), bucket: "AVAILABLE", kind: e.kind, fcAmount: r4(e.fc).toFixed(4), inrAmount: round2(e.inr).toFixed(2), voucherId: e.voucherId },
  });
}

/** Called by cancelVoucher: mirror every clearing entry of the original onto its reversal, once. */
export async function mirrorClearingEntries(tx: Tx, originalVoucherId: string, reversalVoucherId: string) {
  const entries = await tx.clearingEntry.findMany({ where: { voucherId: originalVoucherId, reversedBy: { is: null } } });
  if (entries.length === 0) return;
  await tx.clearingEntry.createMany({
    data: entries.map((e) => ({
      partyId: e.partyId,
      currencyCode: e.currencyCode,
      bucket: e.bucket,
      kind: "MIRROR" as const,
      fcAmount: new Decimal(e.fcAmount).negated().toFixed(4),
      inrAmount: new Decimal(e.inrAmount).negated().toFixed(2),
      voucherId: reversalVoucherId,
      documentId: e.documentId,
      reversalOfEntryId: e.id,
    })),
  });
}
