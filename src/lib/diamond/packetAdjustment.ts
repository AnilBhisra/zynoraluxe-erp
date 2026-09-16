import "server-only";

import type { Prisma } from "@/generated/prisma/client";

import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, type DecimalInput, round2 } from "@/lib/accounting/money";
import { createVoucherHeader, insertBalancedJournalLines, PostingError } from "@/lib/accounting/posting";
import { round3 } from "@/lib/diamond/allocation";
import { checkPacketQuantity } from "@/lib/diamond/packets";
import { getPacketBalanceInTx, lockPacketInTx } from "@/lib/diamond/polishedPurchase";
import { toThousandths } from "@/lib/jewellery/metalMath";

export { PostingError };

type Tx = Prisma.TransactionClient;

/**
 * Owner-authorized packet count correction (Owner-only; enforced by the
 * caller). Unlike the Phase 4 metal adjustment, this posts its accounting in
 * the same transaction so 1220 Polished Diamond Inventory keeps tying out:
 *
 *   OUT  stones found missing or broken at a count — removed at their carat
 *        share of the packet's cost (the whole remainder when it empties):
 *        Dr 5100 Business Expenses / Cr 1220
 *   IN   stones found that the ledger did not hold — at the cost the Owner
 *        enters (may be zero): Dr 1220 / Cr 5100
 *
 * A mistaken adjustment is corrected by an opposite adjustment, never by
 * editing or cancelling the movement.
 */
export async function adjustPacketStock(
  tx: Tx,
  input: {
    fyStartMonth: number;
    fyStartDay: number;
    packetId: string;
    direction: "IN" | "OUT";
    pieces: number;
    carat: DecimalInput;
    /** Required for IN; ignored for OUT, whose cost comes from the packet. */
    costValue?: DecimalInput | null;
    adjustmentDate: Date;
    reason: string;
    createdByUserId: string;
  }
) {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) throw new PostingError("Give a short reason for this packet adjustment.");
  if (!Number.isInteger(input.pieces) || input.pieces < 0) throw new PostingError("Pieces must be a whole number, zero or more.");
  const carat = round3(input.carat);
  if (carat.isNegative() || (input.pieces === 0 && carat.isZero())) {
    throw new PostingError("Enter the pieces and carat being adjusted.");
  }

  if (!(await lockPacketInTx(tx, input.packetId, ["ACTIVE", "EMPTY"]))) {
    throw new PostingError("This packet was not found or has been cancelled.");
  }
  const packet = (await tx.polishedPacket.findUnique({ where: { id: input.packetId } }))!;
  const balance = await getPacketBalanceInTx(tx, input.packetId);

  let cost: Decimal;
  let emptiesPacket = false;
  if (input.direction === "OUT") {
    const check = checkPacketQuantity(
      { pieces: input.pieces, caratThousandths: toThousandths(carat.toFixed(3)) },
      { pieces: balance.pieces, caratThousandths: toThousandths(balance.carat.toFixed(3)) }
    );
    if (!check.ok) throw new PostingError(`Packet ${packet.packetCode}: ${check.reason}`);
    emptiesPacket = input.pieces === balance.pieces && carat.equals(balance.carat);
    cost = emptiesPacket || balance.carat.isZero() ? balance.costValue : round2(balance.costValue.times(carat).dividedBy(balance.carat));
  } else {
    cost = round2(input.costValue ?? 0);
    if (cost.isNegative()) throw new PostingError("The adjustment cost cannot be negative.");
    // An empty packet must come back with both pieces and carat, never one alone.
    if (balance.pieces === 0 && balance.carat.isZero() && (input.pieces === 0 || carat.isZero())) {
      throw new PostingError("An empty packet needs both pieces and carat to be added back.");
    }
  }

  const movement = await tx.polishedPacketMovement.create({
    data: {
      type: input.direction === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
      packetId: packet.id,
      pieces: input.pieces,
      carat: carat.toFixed(3),
      costValue: cost.toFixed(2),
      sourceDocument: `Adjustment: ${reason}`,
      createdByUserId: input.createdByUserId,
    },
  });

  if (cost.greaterThan(0)) {
    const voucher = await createVoucherHeader(
      tx,
      {
        date: input.adjustmentDate,
        fyStartMonth: input.fyStartMonth,
        fyStartDay: input.fyStartDay,
        currencyCode: "INR",
        exchangeRate: 1,
        note: `Packet ${packet.packetCode} adjustment ${input.direction === "IN" ? "in" : "out"} — ${reason}`,
        createdByUserId: input.createdByUserId,
      },
      "STOCK_ADJUSTMENT",
      { amount: cost }
    );
    const inventory = { accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, description: `Adjust ${packet.packetCode}` };
    const offset = { accountCode: SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, description: `Adjust ${packet.packetCode}: ${reason}` };
    await insertBalancedJournalLines(
      tx,
      voucher.id,
      input.direction === "IN"
        ? [{ ...inventory, debit: cost }, { ...offset, credit: cost }]
        : [{ ...offset, debit: cost }, { ...inventory, credit: cost }]
    );
  }

  const after = await getPacketBalanceInTx(tx, packet.id);
  const isEmpty = after.pieces === 0 && after.carat.isZero();
  if (isEmpty !== (packet.status === "EMPTY")) {
    await tx.polishedPacket.update({ where: { id: packet.id }, data: { status: isEmpty ? "EMPTY" : "ACTIVE" } });
  }
  if (!after.carat.isZero() && after.pieces === 0) {
    throw new PostingError("This adjustment would leave carat with no pieces behind it.");
  }
  if (after.pieces > 0 && after.carat.isZero()) {
    throw new PostingError("This adjustment would leave pieces with no carat behind them.");
  }

  return { movement, emptiesPacket };
}
