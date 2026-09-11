import type { Prisma } from "@/generated/prisma/client";
import type { VoucherType } from "@/generated/prisma/enums";

const PREFIX_BY_TYPE: Record<VoucherType, string> = {
  PURCHASE: "PUR",
  SALE: "SAL",
  PAYMENT_GIVEN: "PMT-OUT",
  PAYMENT_RECEIVED: "PMT-IN",
  EXPENSE: "EXP",
  OPENING: "OPEN",
  REVERSAL: "REV",
  DIAMOND_ISSUE: "DIA-ISS",
  DIAMOND_RECEIPT: "DIA-REC",
  JEWELLERY_ISSUE: "JWL-ISS",
  JEWELLERY_RECEIPT: "JWL-REC",
};

/**
 * Allocates the next voucher number for (type, financial year), atomically.
 * MUST be called with the same transaction client (`tx`) that will insert
 * the Voucher row, so the increment and the insert commit or roll back
 * together — that is what makes numbering concurrency-safe: the upsert's
 * INSERT ... ON CONFLICT DO UPDATE is a single atomic statement, so two
 * concurrent requests serialize on the row lock and never see the same
 * `lastNumber`.
 */
export async function nextVoucherNumber(
  tx: Prisma.TransactionClient,
  voucherType: VoucherType,
  financialYearLabel: string
): Promise<string> {
  const sequence = await tx.voucherSequence.upsert({
    where: { voucherType_financialYearLabel: { voucherType, financialYearLabel } },
    create: { voucherType, financialYearLabel, lastNumber: 1 },
    update: { lastNumber: { increment: 1 } },
  });

  const prefix = PREFIX_BY_TYPE[voucherType];
  const padded = String(sequence.lastNumber).padStart(4, "0");
  return `${prefix}/${financialYearLabel}/${padded}`;
}
