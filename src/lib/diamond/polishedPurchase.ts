import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import type {
  BrokerageMethod,
  BrokerageTreatment,
  CertificateStatus,
  DiamondShape,
  GstTreatment,
  PolishedRateBasis,
} from "@/generated/prisma/enums";

import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { splitGstAmount } from "@/lib/accounting/gst";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import {
  cancelVoucher,
  createVoucherHeader,
  insertBalancedJournalLines,
  PostingError,
  type JournalLineInput,
} from "@/lib/accounting/posting";
import { allocateProportionally, round3 } from "@/lib/diamond/allocation";
import { nextDiamondCode } from "@/lib/diamond/numbering";
import { buildPacketMergeKey, PACKET_MOVEMENT_EFFECT, type PacketMovementKind } from "@/lib/diamond/packets";

export { PostingError };

type Tx = Prisma.TransactionClient;
type FyInput = { fyStartMonth: number; fyStartDay: number };

/** Live balance of one packet, summed from its immutable movements. */
export async function getPacketBalanceInTx(
  tx: Tx,
  packetId: string
): Promise<{ pieces: number; carat: Decimal; costValue: Decimal }> {
  const movements = await tx.polishedPacketMovement.findMany({
    where: { packetId },
    select: { type: true, pieces: true, carat: true, costValue: true },
  });
  let pieces = 0;
  let carat = ZERO;
  let costValue = ZERO;
  for (const m of movements) {
    const sign = PACKET_MOVEMENT_EFFECT[m.type as PacketMovementKind];
    if (!sign) continue;
    pieces += m.pieces * sign;
    carat = carat.plus(new Decimal(m.carat).times(sign));
    costValue = costValue.plus(new Decimal(m.costValue).times(sign));
  }
  return { pieces, carat: round3(carat), costValue: round2(costValue) };
}

/**
 * Brokerage from the agreed method. PER_CARAT uses the purchase's whole
 * carat, PERCENT is a percentage of the supplier's own amount (never of a
 * figure that already contains brokerage), FIXED is the amount itself.
 */
export function computeBrokerageAmount(input: {
  method: BrokerageMethod;
  rate: DecimalInput;
  supplierAmount: DecimalInput;
  totalCarat: DecimalInput;
}): Decimal {
  const rate = new Decimal(input.rate);
  if (rate.isNegative()) throw new PostingError("Brokerage rate cannot be negative.");
  switch (input.method) {
    case "PER_CARAT":
      return round2(rate.times(new Decimal(input.totalCarat)));
    case "PERCENT":
      return round2(new Decimal(input.supplierAmount).times(rate).dividedBy(100));
    case "FIXED":
      return round2(rate);
    default:
      throw new PostingError("Unknown brokerage method.");
  }
}

export type PolishedPurchaseLineInput = {
  shape: DiamondShape;
  customShapeName?: string | null;
  sizeLabel: string;
  measurements?: string | null;
  pieces: number;
  carat: DecimalInput;
  quality?: string | null;
  colour?: string | null;
  lab?: string | null;
  certificateStatus?: CertificateStatus;
  certNumber?: string | null;
  certFileAssetId?: string | null;
  photoAssetId?: string | null;
  rateBasis: PolishedRateBasis;
  rate: DecimalInput;
  /** Owner-supplied per-line landed cost. Honoured only when EVERY line
   * supplies one and they sum exactly to the purchase's landed cost. */
  manualLandedCost?: DecimalInput | null;
  notes?: string | null;
};

export type CreatePolishedPurchaseInput = FyInput & {
  purchaseDate: Date;
  supplierId: string;
  currencyCode: string;
  exchangeRate: DecimalInput;
  /** Authoritative supplier cost in INR, before GST and before brokerage. */
  supplierAmount: DecimalInput;
  gstTreatment: GstTreatment;
  gstRateId?: string | null;
  gstRatePercent?: DecimalInput | null;
  brokerPartyId?: string | null;
  brokerageMethod?: BrokerageMethod | null;
  brokerageRate?: DecimalInput | null;
  brokerageTreatment: BrokerageTreatment;
  paymentAccountId?: string | null;
  referenceNumber?: string | null;
  notes?: string | null;
  lines: PolishedPurchaseLineInput[];
  idempotencyKey?: string | null;
  createdByUserId: string;
};

/**
 * Direct Polished Diamond Purchase. Each line becomes one PolishedPacket
 * (provenance PURCHASED — never a fabricated parent Rough ID) with a single
 * PURCHASE_IN movement carrying its share of the landed cost.
 *
 * Brokerage posts exactly once, according to its treatment:
 *   INCLUDED_IN_SUPPLIER_COST     recorded only; the supplier's invoice already has it
 *   CAPITALISED_PAYABLE_TO_BROKER inside the inventory debit, credited to the broker
 *   EXPENSED_PAYABLE_TO_BROKER    Dr Brokerage Expense, credited to the broker
 */
export async function createPolishedPurchase(tx: Tx, input: CreatePolishedPurchaseInput) {
  if (input.lines.length === 0) {
    throw new PostingError("A polished purchase must have at least one packet line.");
  }
  const supplierAmount = round2(input.supplierAmount);
  if (!supplierAmount.greaterThan(0)) {
    throw new PostingError("Supplier amount must be greater than zero.");
  }

  let totalCarat = ZERO;
  for (const line of input.lines) {
    const carat = round3(line.carat);
    if (!Number.isInteger(line.pieces) || line.pieces <= 0) {
      throw new PostingError("Each packet line must have a whole number of pieces, greater than zero.");
    }
    if (!carat.greaterThan(0)) throw new PostingError("Each packet line's carat must be greater than zero.");
    if (!line.sizeLabel || !line.sizeLabel.trim()) throw new PostingError("Give each packet line a size.");
    if (line.shape === "CUSTOM" && !line.customShapeName?.trim()) {
      throw new PostingError("Name the custom shape on each custom-shape line.");
    }
    totalCarat = totalCarat.plus(carat);
  }
  totalCarat = round3(totalCarat);

  // ---- Dalal / Broker ----
  let brokerageAmount = ZERO;
  let brokerNameSnapshot: string | null = null;
  if (input.brokerageTreatment === "NONE") {
    if (input.brokerPartyId) brokerNameSnapshot = null;
  } else {
    if (!input.brokerPartyId) throw new PostingError("Choose the Dalal / Broker for this brokerage.");
    if (!input.brokerageMethod) throw new PostingError("Choose how the brokerage is calculated.");
    const broker = await tx.party.findUnique({ where: { id: input.brokerPartyId } });
    if (!broker || !broker.isActive) throw new PostingError("The selected Dalal / Broker was not found or is inactive.");
    if (broker.type !== "BROKER") {
      throw new PostingError("The selected party is not a Dalal / Broker — change the party type in Accounting first.");
    }
    brokerNameSnapshot = broker.name;
    brokerageAmount = computeBrokerageAmount({
      method: input.brokerageMethod,
      rate: input.brokerageRate ?? 0,
      supplierAmount,
      totalCarat,
    });
    if (!brokerageAmount.greaterThan(0)) {
      throw new PostingError("Brokerage must be greater than zero, or set the treatment to none.");
    }
  }

  const capitalisedBrokerage = input.brokerageTreatment === "CAPITALISED_PAYABLE_TO_BROKER" ? brokerageAmount : ZERO;
  const expensedBrokerage = input.brokerageTreatment === "EXPENSED_PAYABLE_TO_BROKER" ? brokerageAmount : ZERO;
  const brokerPayable = round2(capitalisedBrokerage.plus(expensedBrokerage));
  const landedCost = round2(supplierAmount.plus(capitalisedBrokerage));

  // ---- Per-line landed cost: manual only when every line supplies one and
  // they sum exactly; otherwise proportional by carat. ----
  const allManual = input.lines.every((l) => l.manualLandedCost != null);
  let lineCosts: Decimal[];
  if (allManual) {
    lineCosts = input.lines.map((l) => round2(l.manualLandedCost!));
    const manualSum = lineCosts.reduce((sum, c) => sum.plus(c), ZERO);
    if (!manualSum.equals(landedCost)) {
      throw new PostingError(
        `Line costs sum to ${manualSum.toFixed(2)}, which must exactly equal the purchase's landed cost ${landedCost.toFixed(2)}.`
      );
    }
  } else {
    const allocation = allocateProportionally(
      landedCost,
      input.lines.map((l, i) => ({ key: String(i), weight: round3(l.carat) }))
    );
    lineCosts = input.lines.map((_, i) => allocation.find((a) => a.key === String(i))!.amount);
  }

  const purchaseCode = await nextDiamondCode(tx, "POLISHED_PURCHASE");

  const gstRatePercent = input.gstTreatment === "NONE" ? ZERO : new Decimal(input.gstRatePercent ?? 0);
  const taxAmount =
    input.gstTreatment === "NONE" ? ZERO : round2(supplierAmount.times(gstRatePercent).dividedBy(100));
  const { cgst, sgst, igst } = splitGstAmount(taxAmount, input.gstTreatment);
  const supplierPayable = round2(supplierAmount.plus(taxAmount));

  const voucher = await createVoucherHeader(
    tx,
    {
      date: input.purchaseDate,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
      currencyCode: input.currencyCode,
      exchangeRate: input.exchangeRate,
      referenceNumber: input.referenceNumber,
      note: `Polished diamond purchase ${purchaseCode}`,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.createdByUserId,
    },
    "PURCHASE",
    {
      amount: round2(supplierPayable.plus(brokerPayable)),
      partyId: input.supplierId,
      paymentAccountId: input.paymentAccountId,
      gstTreatment: input.gstTreatment,
    }
  );

  const journalLines: JournalLineInput[] = [
    {
      accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY,
      debit: landedCost,
      description: `Polished purchase ${purchaseCode}`,
    },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_CGST, debit: cgst, description: "Input CGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_SGST, debit: sgst, description: "Input SGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_IGST, debit: igst, description: "Input IGST" },
    {
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: input.supplierId,
      credit: supplierPayable,
      description: `Polished purchase ${purchaseCode}`,
    },
  ];
  if (expensedBrokerage.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.BROKERAGE_EXPENSE,
      debit: expensedBrokerage,
      description: `Brokerage — ${brokerNameSnapshot ?? "Dalal / Broker"} ${purchaseCode}`,
    });
  }
  if (brokerPayable.greaterThan(0)) {
    journalLines.push({
      accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
      partyId: input.brokerPartyId!,
      credit: brokerPayable,
      description: `Brokerage payable ${purchaseCode}`,
    });
  }
  if (input.paymentAccountId) {
    // Settles the SUPPLIER only — brokerage stays payable and is cleared by
    // an ordinary Payment Given against the broker.
    const paymentAccount = await tx.paymentAccount.findUnique({
      where: { id: input.paymentAccountId },
      select: { account: { select: { code: true } } },
    });
    if (!paymentAccount) throw new PostingError("Payment account not found.");
    journalLines.push(
      {
        accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE,
        partyId: input.supplierId,
        debit: supplierPayable,
        description: "Purchase settled immediately",
      },
      { accountCode: paymentAccount.account.code, credit: supplierPayable, description: "Purchase settled immediately" }
    );
  }

  await insertBalancedJournalLines(tx, voucher.id, journalLines);

  const purchase = await tx.polishedPurchase.create({
    data: {
      purchaseCode,
      purchaseDate: input.purchaseDate,
      supplierId: input.supplierId,
      currencyCode: input.currencyCode,
      exchangeRate: new Decimal(input.exchangeRate).toFixed(4),
      supplierAmount: supplierAmount.toFixed(2),
      gstTreatment: input.gstTreatment,
      gstRateId: input.gstRateId ?? null,
      gstRatePercent: input.gstTreatment === "NONE" ? null : gstRatePercent.toFixed(2),
      brokerPartyId: input.brokerageTreatment === "NONE" ? null : input.brokerPartyId ?? null,
      brokerNameSnapshot,
      brokerageMethod: input.brokerageTreatment === "NONE" ? null : input.brokerageMethod ?? null,
      brokerageRate: input.brokerageTreatment === "NONE" ? null : new Decimal(input.brokerageRate ?? 0).toFixed(4),
      brokerageAmount: brokerageAmount.toFixed(2),
      brokerageTreatment: input.brokerageTreatment,
      landedCost: landedCost.toFixed(2),
      paymentAccountId: input.paymentAccountId ?? null,
      referenceNumber: input.referenceNumber ?? null,
      notes: input.notes ?? null,
      voucherId: voucher.id,
      idempotencyKey: input.idempotencyKey ?? null,
      createdByUserId: input.createdByUserId,
    },
  });

  const packets = [];
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    const carat = round3(line.carat);
    const cost = lineCosts[i];
    const certificateStatus: CertificateStatus = line.certificateStatus ?? "NOT_CERTIFIED";

    const purchaseLine = await tx.polishedPurchaseLine.create({
      data: {
        purchaseId: purchase.id,
        shape: line.shape,
        customShapeName: line.customShapeName || null,
        sizeLabel: line.sizeLabel.trim(),
        measurements: line.measurements || null,
        pieces: line.pieces,
        carat: carat.toFixed(3),
        quality: line.quality || null,
        colour: line.colour || null,
        lab: line.lab || null,
        certificateStatus,
        certNumber: line.certNumber || null,
        certFileAssetId: line.certFileAssetId || null,
        photoAssetId: line.photoAssetId || null,
        rateBasis: line.rateBasis,
        rate: new Decimal(line.rate ?? 0).toFixed(4),
        landedCost: cost.toFixed(2),
        notes: line.notes || null,
        sortOrder: i,
      },
    });

    const packetCode = await nextDiamondCode(tx, "POLISHED_PACKET");
    const packet = await tx.polishedPacket.create({
      data: {
        packetCode,
        provenance: "PURCHASED",
        mergeKey: buildPacketMergeKey({
          shape: line.shape,
          customShapeName: line.customShapeName,
          sizeLabel: line.sizeLabel,
          quality: line.quality,
          colour: line.colour,
          lab: line.lab,
          certificateStatus,
          provenance: "PURCHASED",
          currencyCode: input.currencyCode,
        }),
        shape: line.shape,
        customShapeName: line.customShapeName || null,
        sizeLabel: line.sizeLabel.trim(),
        measurements: line.measurements || null,
        quality: line.quality || null,
        colour: line.colour || null,
        lab: line.lab || null,
        certificateStatus,
        certNumber: line.certNumber || null,
        certFileAssetId: line.certFileAssetId || null,
        photoAssetId: line.photoAssetId || null,
        currencyCode: input.currencyCode,
        purchaseLineId: purchaseLine.id,
        createdByUserId: input.createdByUserId,
      },
    });

    await tx.polishedPacketMovement.create({
      data: {
        type: "PURCHASE_IN",
        packetId: packet.id,
        pieces: line.pieces,
        carat: carat.toFixed(3),
        costValue: cost.toFixed(2),
        sourceDocument: purchaseCode,
        createdByUserId: input.createdByUserId,
      },
    });
    packets.push(packet);
  }

  return { purchase, packets };
}

/**
 * Cancel a polished purchase (Owner-only, enforced by the caller).
 *
 * Only possible while every packet from the purchase is still exactly as
 * bought — one PURCHASE_IN movement and nothing else. Once any of the stones
 * have been issued, returned or adjusted, reversing the accounting would
 * leave real stock behind referencing a cancelled purchase, the same trap the
 * Rough/Metal purchase guards exist to prevent (V1_FINAL_ACCEPTANCE.md 6).
 */
export async function cancelPolishedPurchase(
  tx: Tx,
  input: FyInput & { purchaseId: string; cancelledByUserId: string; cancellationReason: string }
) {
  if (!input.cancellationReason || input.cancellationReason.trim().length < 3) {
    throw new PostingError("Give a short reason for cancelling this purchase.");
  }
  const purchase = await tx.polishedPurchase.findUnique({
    where: { id: input.purchaseId },
    include: { lines: { include: { packet: true } } },
  });
  if (!purchase) throw new PostingError("Polished purchase not found.");
  if (purchase.status === "CANCELLED") throw new PostingError("This purchase has already been cancelled.");

  const packets = purchase.lines.map((line) => line.packet).filter((packet) => packet !== null);
  for (const packet of packets) {
    const movements = await tx.polishedPacketMovement.findMany({
      where: { packetId: packet.id },
      select: { type: true },
    });
    if (movements.some((m) => m.type !== "PURCHASE_IN")) {
      throw new PostingError(
        `Stones from packet ${packet.packetCode} have already been used — this purchase can no longer be cancelled.`
      );
    }
  }

  let cancellationVoucherId: string | null = null;
  if (purchase.voucherId) {
    const reversal = await cancelVoucher(tx, {
      voucherId: purchase.voucherId,
      cancelledByUserId: input.cancelledByUserId,
      cancellationReason: input.cancellationReason,
      fyStartMonth: input.fyStartMonth,
      fyStartDay: input.fyStartDay,
    });
    cancellationVoucherId = reversal.id;
  }

  for (const line of purchase.lines) {
    const packet = line.packet;
    if (!packet) continue;
    const purchaseMovement = await tx.polishedPacketMovement.findFirst({
      where: { packetId: packet.id, type: "PURCHASE_IN" },
    });
    await tx.polishedPacketMovement.create({
      data: {
        type: "PURCHASE_CANCEL_OUT",
        packetId: packet.id,
        pieces: line.pieces,
        carat: line.carat,
        costValue: line.landedCost,
        sourceDocument: purchase.purchaseCode,
        reversalOfMovementId: purchaseMovement?.id ?? null,
        createdByUserId: input.cancelledByUserId,
      },
    });
    await tx.polishedPacket.update({ where: { id: packet.id }, data: { status: "CANCELLED" } });
  }

  return tx.polishedPurchase.update({
    where: { id: purchase.id },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledByUserId: input.cancelledByUserId,
      cancellationReason: input.cancellationReason,
      cancellationVoucherId,
    },
  });
}
