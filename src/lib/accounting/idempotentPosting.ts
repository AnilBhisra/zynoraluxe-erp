import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type { VoucherType } from "@/generated/prisma/enums";

import { Decimal, type DecimalInput } from "@/lib/accounting/money";
import { VOUCHER_TRANSACTION_OPTIONS } from "@/lib/accounting/posting";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";

/** What a create form is asking to post — compared with the voucher an idempotency key already saved. */
export type VoucherRequestFingerprint = {
  voucherType: VoucherType;
  partyId: string | null;
  paymentAccountId: string | null;
  /** The voucher total the request will post. */
  amount: DecimalInput;
  date: Date;
  createdByUserId: string;
};

type SavedVoucher = {
  id: string;
  voucherNumber: string;
  voucherType: VoucherType;
  partyId: string | null;
  paymentAccountId: string | null;
  amount: DecimalInput;
  date: Date;
  createdByUserId: string;
};

export type IdempotentPostResult =
  /** Posted now. */
  | { status: "POSTED"; voucherNumber: string }
  /** The same submission arrived again (double-click, retry, a second tab): nothing new was posted. */
  | { status: "REPLAYED"; voucherNumber: string }
  /**
   * The key already saved a DIFFERENT entry. Nothing was posted. This used to
   * be reported as a success — a second payment typed into a still-open form
   * silently did nothing, so its balance never moved.
   */
  | { status: "KEY_REUSED"; voucherNumber: string };

function sameRequest(saved: SavedVoucher, request: VoucherRequestFingerprint): boolean {
  return (
    saved.voucherType === request.voucherType &&
    (saved.partyId ?? null) === (request.partyId ?? null) &&
    (saved.paymentAccountId ?? null) === (request.paymentAccountId ?? null) &&
    new Decimal(saved.amount).toDecimalPlaces(2).equals(new Decimal(request.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)) &&
    new Date(saved.date).getTime() === request.date.getTime() &&
    saved.createdByUserId === request.createdByUserId
  );
}

async function resolveExisting(idempotencyKey: string, request: VoucherRequestFingerprint): Promise<IdempotentPostResult | null> {
  const saved = await prisma.voucher.findUnique({ where: { idempotencyKey } });
  if (!saved) return null;
  return { status: sameRequest(saved, request) ? "REPLAYED" : "KEY_REUSED", voucherNumber: saved.voucherNumber };
}

/**
 * Posts one Accounting voucher at most once per idempotency key.
 *
 * - An earlier save with this key is returned instead of posting again.
 * - Two simultaneous submissions with the same key: both enter the
 *   transaction, the second blocks on the unique key until the first commits,
 *   then fails and rolls back its WHOLE transaction (voucher number, header,
 *   lines) — so no duplicate voucher and no gap in the numbering — and is
 *   answered with the first one's voucher.
 * - Any other failure rolls everything back and is rethrown.
 */
export async function postVoucherOnce(
  idempotencyKey: string | null | undefined,
  request: VoucherRequestFingerprint,
  post: (tx: Prisma.TransactionClient) => Promise<{ voucherNumber: string }>
): Promise<IdempotentPostResult> {
  if (idempotencyKey) {
    const existing = await resolveExisting(idempotencyKey, request);
    if (existing) return existing;
  }
  try {
    const voucher = await prisma.$transaction(post, VOUCHER_TRANSACTION_OPTIONS);
    return { status: "POSTED", voucherNumber: voucher.voucherNumber };
  } catch (error) {
    if (idempotencyKey && isIdempotencyConflict(error)) {
      const existing = await resolveExisting(idempotencyKey, request);
      if (existing) return existing;
    }
    throw error;
  }
}
