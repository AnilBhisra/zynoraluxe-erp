import type { SerializedJobDetail } from "@/components/diamond/JobDetailView";
import type { SerializedPacketProcessJob } from "@/components/diamond/JobManufacturerTab";
import type { SerializedPacketProcessJobDetail } from "@/components/diamond/PacketProcessJobDetailView";
import type { SerializedPacket, SerializedPacketGroup, SerializedPolishedPurchase } from "@/components/diamond/PolishedPacketsSection";
import type {
  PacketProcessJobDetail,
  PacketProcessJobRow,
  PolishedPacketRow,
  PolishedPurchaseRow,
} from "@/lib/diamond/packetReports";
import type { PacketGroup } from "@/lib/diamond/packets";
import { shapeLabel } from "@/lib/diamond/shapes";
import { ownerOnly } from "@/lib/security/ownerOnly";

// Phase 7 page DTOs. Every cost, landed cost, brokerage, WIP and charge figure
// passes through ownerOnly() here, on the server, so a Staff request's RSC
// payload never carries it (PHASE_7_CURRENT_STATE_AUDIT.md §4.16). Kept out of
// the page so the redaction is covered by phase7Serializers.test.ts.

export function serializePacket(p: PolishedPacketRow, isOwner: boolean): SerializedPacket {
  return {
    id: p.id,
    packetCode: p.packetCode,
    provenance: p.provenance,
    shape: p.shape,
    customShapeName: p.customShapeName,
    sizeLabel: p.sizeLabel,
    quality: p.quality,
    colour: p.colour,
    certificateStatus: p.certificateStatus,
    certNumber: p.certNumber,
    purchaseCode: p.purchaseCode,
    supplierName: p.supplierName,
    pieces: p.pieces,
    carat: p.carat,
    costValue: ownerOnly(isOwner, p.costValue),
  };
}

export function serializePacketGroup(g: PacketGroup & { sample: PolishedPacketRow }, isOwner: boolean): SerializedPacketGroup {
  return {
    mergeKey: g.mergeKey,
    label: [
      g.sample.shape === "CUSTOM" && g.sample.customShapeName ? g.sample.customShapeName : shapeLabel(g.sample.shape),
      g.sample.sizeLabel,
      g.sample.quality,
      g.sample.colour,
      g.sample.lab,
    ]
      .filter(Boolean)
      .join(" · "),
    provenance: g.sample.provenance,
    pieces: g.pieces,
    carat: g.carat,
    costValue: ownerOnly(isOwner, g.costValue),
    packetCodes: g.packetCodes,
  };
}

export function serializePolishedPurchase(p: PolishedPurchaseRow, isOwner: boolean): SerializedPolishedPurchase {
  return {
    id: p.id,
    purchaseCode: p.purchaseCode,
    purchaseDate: p.purchaseDate.toISOString(),
    supplierName: p.supplierName,
    brokerName: p.brokerName,
    lineCount: p.lineCount,
    totalPieces: p.totalPieces,
    totalCarat: p.totalCarat,
    status: p.status,
    landedCost: ownerOnly(isOwner, p.landedCost),
    brokerageAmount: ownerOnly(isOwner, p.brokerageAmount),
  };
}

export function serializePacketProcessJob(j: PacketProcessJobRow, isOwner: boolean): SerializedPacketProcessJob {
  return {
    id: j.id,
    jobCode: j.jobCode,
    manufacturerName: j.manufacturerName,
    processName: j.processName,
    issueDate: j.issueDate.toISOString(),
    status: j.status,
    issuedPieces: j.issuedPieces,
    issuedCarat: j.issuedCarat,
    pendingPieces: j.pendingPieces,
    pendingCarat: j.pendingCarat,
    totalCharge: ownerOnly(isOwner, j.totalCharge),
  };
}

export function serializePacketProcessJobDetail(detail: PacketProcessJobDetail, isOwner: boolean): SerializedPacketProcessJobDetail {
  return {
    id: detail.id,
    jobCode: detail.jobCode,
    manufacturerName: detail.manufacturerName,
    processName: detail.processName,
    issueDate: detail.issueDate.toISOString(),
    dueDate: detail.dueDate ? detail.dueDate.toISOString() : null,
    status: detail.status,
    issuedPieces: detail.issuedPieces,
    issuedCarat: detail.issuedCarat,
    pendingPieces: detail.pendingPieces,
    pendingCarat: detail.pendingCarat,
    returnedPieces: detail.returnedPieces,
    usedPieces: detail.usedPieces,
    damagedPieces: detail.damagedPieces,
    lossCarat: detail.lossCarat,
    chargeRateBasis: detail.chargeRateBasis,
    notes: detail.notes,
    cancellationReason: detail.cancellationReason,
    hasReceipts: detail.hasReceipts,
    issuedCostValue: ownerOnly(isOwner, detail.issuedCostValue),
    remainingWipCost: ownerOnly(isOwner, detail.remainingWipCost),
    totalCharge: ownerOnly(isOwner, detail.totalCharge),
    chargeRate: ownerOnly(isOwner, detail.chargeRate),
    lines: detail.lines.map((l) => ({
      id: l.id,
      packetCode: l.packetCode,
      label: l.label,
      piecesAtIssue: l.piecesAtIssue,
      caratAtIssue: l.caratAtIssue,
      pendingPieces: l.pendingPieces,
      pendingCarat: l.pendingCarat,
      lossCarat: l.lossCarat,
      isClosed: l.isClosed,
      closedAt: l.closedAt ? l.closedAt.toISOString() : null,
      costAtIssue: ownerOnly(isOwner, l.costAtIssue),
    })),
    receipts: detail.receipts.map((r) => ({
      id: r.id,
      receiptCode: r.receiptCode,
      receiveDate: r.receiveDate.toISOString(),
      isFinal: r.isFinal,
      lossCarat: r.lossCarat,
      processCharge: ownerOnly(isOwner, r.processCharge),
      lines: r.lines.map((l) => ({
        disposition: l.disposition,
        pieces: l.pieces,
        carat: l.carat,
        sizeLabel: l.sizeLabel,
        jewelleryJobCode: l.jewelleryJobCode,
        resultPacketCode: l.resultPacketCode,
        reason: l.reason,
        costValue: ownerOnly(isOwner, l.costValue),
      })),
    })),
  };
}

/** Phase 7 process fields on a Diamond (Manufacturer) job detail. */
export function serializeJobProcessFields(
  detail: { processNameSnapshot: string | null; processOutputKindSnapshot: "ROUGH" | "POLISHED" | null; chargeRateBasis: "FIXED" | "PER_CARAT" | "PER_PIECE" | null; chargeRate: { toFixed(dp: number): string } | null },
  isOwner: boolean
): Pick<SerializedJobDetail, "processName" | "processOutputKind" | "chargeRateBasis" | "chargeRate"> {
  return {
    processName: detail.processNameSnapshot,
    processOutputKind: detail.processOutputKindSnapshot,
    chargeRateBasis: detail.chargeRateBasis,
    chargeRate: ownerOnly(isOwner, detail.chargeRate ? detail.chargeRate.toFixed(4) : null),
  };
}
