import "server-only";

import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { assessReceiptForCharges, checkPiecesUntouched } from "@/lib/jewellery/receiptChargeCorrection";
import { CHARGE_CATEGORIES, type ChargeKey } from "@/lib/jewellery/receiptChargeAllocation";

export type SerializedChargeAmounts = Record<ChargeKey, string>;

export type ReceiptChargeCorrectionView = {
  id: string;
  correctionCode: string;
  state: "POSTED" | "REVERSED";
  reason: string;
  postedAt: string | null;
  amounts: SerializedChargeAmounts;
  total: string;
  pieces: { code: string; added: string }[];
  voucherNumber: string | null;
  reversedByCode: string | null;
  /** null when it can be reversed right now; otherwise the plain-language reason it cannot. */
  reverseBlockedReason: string | null;
};

export type ReceiptChargePanel = {
  receiptId: string;
  receiptCode: string;
  originalAmounts: SerializedChargeAmounts;
  originalTotal: string;
  /** Sum of POSTED (not reversed) corrections — what has been added since the receipt was saved. */
  addedLaterTotal: string;
  /** null when charges can be added right now; otherwise why not. */
  addBlockedReason: string | null;
  corrections: ReceiptChargeCorrectionView[];
};

function amountsOf(source: Record<ChargeKey, Decimal | string | number>): SerializedChargeAmounts {
  const out = {} as SerializedChargeAmounts;
  for (const c of CHARGE_CATEGORIES) out[c.key] = new Decimal(source[c.key]).toFixed(2);
  return out;
}

/**
 * Owner-only data for the "Add missing charges" panel of one job. Never called
 * for Staff: every figure here is cost data.
 */
export async function getReceiptChargePanels(jobId: string): Promise<ReceiptChargePanel[]> {
  const receipts = await prisma.jewelleryReceipt.findMany({
    where: { jobId, reversedAt: null },
    orderBy: { createdAt: "asc" },
    include: {
      chargeCorrections: {
        orderBy: { createdAt: "asc" },
        include: {
          correction: { select: { correctionCode: true, state: true, reason: true, postedAt: true, reversedBy: { select: { correctionCode: true } }, correctionVoucher: { select: { voucherNumber: true } } } },
          lines: { include: { finishedJewellery: { select: { id: true, finishedCode: true, status: true, fineMetalWeight: true, labourAllocated: true, totalCost: true } } } },
        },
      },
    },
  });

  const panels: ReceiptChargePanel[] = [];
  for (const r of receipts) {
    const eligibility = await assessReceiptForCharges(prisma, r.id);
    const corrections: ReceiptChargeCorrectionView[] = [];
    let added = ZERO;
    for (const c of r.chargeCorrections) {
      const state = c.correction.state === "POSTED" ? "POSTED" : "REVERSED";
      if (state === "POSTED") added = added.plus(c.totalCharge);
      let blocked: string | null = null;
      if (state === "POSTED") {
        const check = await checkPiecesUntouched(
          prisma,
          c.lines.map((l) => ({
            id: l.finishedJewellery.id,
            finishedCode: l.finishedJewellery.finishedCode,
            status: l.finishedJewellery.status,
            fineMetalWeight: new Decimal(l.finishedJewellery.fineMetalWeight),
            labourAllocated: new Decimal(l.finishedJewellery.labourAllocated),
            totalCost: new Decimal(l.finishedJewellery.totalCost),
          })),
          "reversed"
        );
        blocked = check.ok ? null : check.reason;
      }
      corrections.push({
        id: c.correctionId,
        correctionCode: c.correction.correctionCode,
        state,
        reason: c.correction.reason,
        postedAt: c.correction.postedAt?.toISOString() ?? null,
        amounts: amountsOf(c),
        total: new Decimal(c.totalCharge).toFixed(2),
        pieces: c.lines.map((l) => ({ code: l.finishedJewellery.finishedCode, added: new Decimal(l.totalCharge).toFixed(2) })),
        voucherNumber: c.correction.correctionVoucher?.voucherNumber ?? null,
        reversedByCode: c.correction.reversedBy?.correctionCode ?? null,
        reverseBlockedReason: blocked,
      });
    }
    const original = amountsOf(r);
    panels.push({
      receiptId: r.id,
      receiptCode: r.receiptCode,
      originalAmounts: original,
      originalTotal: round2(CHARGE_CATEGORIES.reduce((s, c) => s.plus(original[c.key]), ZERO)).toFixed(2),
      addedLaterTotal: round2(added).toFixed(2),
      addBlockedReason: eligibility.ok ? null : eligibility.reason,
      corrections,
    });
  }
  return panels;
}
