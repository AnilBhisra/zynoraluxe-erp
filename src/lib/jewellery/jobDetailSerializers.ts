import type { SerializedJobDetail } from "@/components/jewellery/JobDetailView";
import type { JewelleryJobDetail } from "@/lib/jewellery/reports";
import { ownerOnly } from "@/lib/security/ownerOnly";

// Jewellery Job detail DTO pieces that carry cost. Every cost figure passes
// through ownerOnly() here, on the server, so a Staff request's RSC payload
// never carries it; packet identity, pieces and carat stay visible to Staff.
// Kept out of the page so jobDetailSerializers.test.ts covers the redaction.

export function serializeJobCostSummary(
  detail: Pick<JewelleryJobDetail, "issuedMetalCost" | "issuedDiamondCost" | "otherMaterialCost" | "totalIssuedCost">,
  isOwner: boolean
): Pick<SerializedJobDetail, "issuedMetalCost" | "issuedDiamondCost" | "otherMaterialCost" | "totalIssuedCost"> {
  return {
    issuedMetalCost: ownerOnly(isOwner, detail.issuedMetalCost.toFixed(2)),
    issuedDiamondCost: ownerOnly(isOwner, detail.issuedDiamondCost.toFixed(2)),
    otherMaterialCost: ownerOnly(isOwner, detail.otherMaterialCost.toFixed(2)),
    totalIssuedCost: ownerOnly(isOwner, detail.totalIssuedCost.toFixed(2)),
  };
}

export function serializeJobPacketLines(
  lines: JewelleryJobDetail["packetLines"],
  isOwner: boolean
): SerializedJobDetail["packetLines"] {
  return lines.map((l) => ({
    id: l.id,
    packetCode: l.packetCode,
    label: l.label,
    fromJobManufacturer: l.fromJobManufacturer,
    piecesAtIssue: l.piecesAtIssue,
    caratAtIssue: l.caratAtIssue.toFixed(3),
    costAtIssue: ownerOnly(isOwner, l.costAtIssue.toFixed(2)),
    setPieces: l.setPieces,
    setCarat: l.setCarat.toFixed(3),
    returnedPieces: l.returnedPieces,
    returnedCarat: l.returnedCarat.toFixed(3),
    damagedPieces: l.damagedPieces,
    damagedCarat: l.damagedCarat.toFixed(3),
  }));
}
