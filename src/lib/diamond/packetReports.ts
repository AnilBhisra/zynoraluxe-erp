import "server-only";

import { prisma } from "@/lib/db/prisma";
import type {
  BrokerageTreatment,
  CertificateStatus,
  DiamondShape,
  PolishedPacketStatus,
  PolishedProvenance,
  VoucherStatus,
} from "@/generated/prisma/enums";
import {
  groupPacketsByMergeKey,
  pendingPacketQuantity,
  sumPacketMovements,
  type PacketGroup,
} from "@/lib/diamond/packets";

// Phase 7 — read models for bulk polished packets and direct Polished
// Diamond Purchases. Every balance is summed from the immutable packet
// ledger; nothing here is a stored running total. Figures are returned as
// exact decimal strings, and cost fields are left for the page to redact
// with ownerOnly() before they reach a Staff response.

export type PolishedPacketRow = {
  id: string;
  packetCode: string;
  provenance: PolishedProvenance;
  mergeKey: string;
  shape: DiamondShape;
  customShapeName: string | null;
  sizeLabel: string;
  quality: string | null;
  colour: string | null;
  lab: string | null;
  certificateStatus: CertificateStatus;
  certNumber: string | null;
  status: PolishedPacketStatus;
  purchaseCode: string | null;
  supplierName: string | null;
  pieces: number;
  carat: string;
  costValue: string;
};

export async function listPolishedPackets(filters?: { search?: string; includeEmpty?: boolean }): Promise<PolishedPacketRow[]> {
  const search = filters?.search?.trim();
  const packets = await prisma.polishedPacket.findMany({
    where: {
      ...(filters?.includeEmpty ? {} : { status: "ACTIVE" }),
      ...(search
        ? {
            OR: [
              { packetCode: { contains: search, mode: "insensitive" } },
              { sizeLabel: { contains: search, mode: "insensitive" } },
              { certNumber: { contains: search, mode: "insensitive" } },
              { purchaseLine: { purchase: { purchaseCode: { contains: search, mode: "insensitive" } } } },
              { purchaseLine: { purchase: { supplier: { name: { contains: search, mode: "insensitive" } } } } },
            ],
          }
        : {}),
    },
    include: {
      movements: { select: { type: true, pieces: true, carat: true, costValue: true } },
      purchaseLine: { include: { purchase: { select: { purchaseCode: true, supplier: { select: { name: true } } } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return packets.map((p) => {
    const balance = sumPacketMovements(
      p.movements.map((m) => ({ type: m.type, pieces: m.pieces, carat: m.carat.toFixed(3), costValue: m.costValue.toFixed(2) }))
    );
    return {
      id: p.id,
      packetCode: p.packetCode,
      provenance: p.provenance,
      mergeKey: p.mergeKey,
      shape: p.shape,
      customShapeName: p.customShapeName,
      sizeLabel: p.sizeLabel,
      quality: p.quality,
      colour: p.colour,
      lab: p.lab,
      certificateStatus: p.certificateStatus,
      certNumber: p.certNumber,
      status: p.status,
      purchaseCode: p.purchaseLine?.purchase.purchaseCode ?? null,
      supplierName: p.purchaseLine?.purchase.supplier.name ?? null,
      ...balance,
    };
  });
}

/** The grouped "same stones" view over the live packets. */
export function groupPacketRows(rows: PolishedPacketRow[]): (PacketGroup & { sample: PolishedPacketRow })[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return groupPacketsByMergeKey(rows).map((g) => ({ ...g, sample: byId.get(g.packetIds[0])! }));
}

export type PolishedPurchaseRow = {
  id: string;
  purchaseCode: string;
  purchaseDate: Date;
  supplierName: string;
  brokerName: string | null;
  brokerageTreatment: BrokerageTreatment;
  brokerageAmount: string;
  supplierAmount: string;
  landedCost: string;
  lineCount: number;
  totalPieces: number;
  totalCarat: string;
  status: VoucherStatus;
  referenceNumber: string | null;
};

export async function listPolishedPurchases(filters?: { search?: string }): Promise<PolishedPurchaseRow[]> {
  const search = filters?.search?.trim();
  const purchases = await prisma.polishedPurchase.findMany({
    where: search
      ? {
          OR: [
            { purchaseCode: { contains: search, mode: "insensitive" } },
            { referenceNumber: { contains: search, mode: "insensitive" } },
            { supplier: { name: { contains: search, mode: "insensitive" } } },
            { brokerNameSnapshot: { contains: search, mode: "insensitive" } },
          ],
        }
      : undefined,
    include: {
      supplier: { select: { name: true } },
      lines: { select: { pieces: true, carat: true } },
    },
    orderBy: [{ purchaseDate: "desc" }, { createdAt: "desc" }],
    take: 200,
  });

  return purchases.map((p) => {
    const totals = sumPacketMovements(
      p.lines.map((l) => ({ type: "PURCHASE_IN", pieces: l.pieces, carat: l.carat.toFixed(3), costValue: "0.00" }))
    );
    return {
      id: p.id,
      purchaseCode: p.purchaseCode,
      purchaseDate: p.purchaseDate,
      supplierName: p.supplier.name,
      brokerName: p.brokerNameSnapshot,
      brokerageTreatment: p.brokerageTreatment,
      brokerageAmount: p.brokerageAmount.toFixed(2),
      supplierAmount: p.supplierAmount.toFixed(2),
      landedCost: p.landedCost.toFixed(2),
      lineCount: p.lines.length,
      totalPieces: totals.pieces,
      totalCarat: totals.carat,
      status: p.status,
      referenceNumber: p.referenceNumber,
    };
  });
}

export type JobPacketLineRow = {
  packetId: string;
  packetCode: string;
  sizeLabel: string;
  shape: DiamondShape;
  piecesAtIssue: number;
  caratAtIssue: string;
  costAtIssue: string;
  pendingPieces: number;
  pendingCarat: string;
  setPieces: number;
  returnedPieces: number;
  damagedPieces: number;
};

/** Packet stones issued to one Jewellery Job, with what is still pending. */
export async function listJobPacketLines(jobId: string): Promise<JobPacketLineRow[]> {
  const lines = await prisma.jewelleryPacketIssueLine.findMany({
    where: { jobId },
    include: { packet: { select: { packetCode: true, sizeLabel: true, shape: true } } },
    orderBy: { createdAt: "asc" },
  });
  return lines.map((l) => {
    const pending = pendingPacketQuantity({
      piecesAtIssue: l.piecesAtIssue,
      caratAtIssue: l.caratAtIssue.toFixed(3),
      resolved: [
        { pieces: l.setPieces, carat: l.setCarat.toFixed(3) },
        { pieces: l.returnedPieces, carat: l.returnedCarat.toFixed(3) },
        { pieces: l.damagedPieces, carat: l.damagedCarat.toFixed(3) },
      ],
    });
    return {
      packetId: l.packetId,
      packetCode: l.packet.packetCode,
      sizeLabel: l.packet.sizeLabel,
      shape: l.packet.shape,
      piecesAtIssue: l.piecesAtIssue,
      caratAtIssue: l.caratAtIssue.toFixed(3),
      costAtIssue: l.costAtIssue.toFixed(2),
      pendingPieces: pending.pieces,
      pendingCarat: pending.carat,
      setPieces: l.setPieces,
      returnedPieces: l.returnedPieces,
      damagedPieces: l.damagedPieces,
    };
  });
}
