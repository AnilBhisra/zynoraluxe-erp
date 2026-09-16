import { describe, expect, it } from "vitest";

import {
  serializeJobProcessFields,
  serializePacket,
  serializePacketGroup,
  serializePacketProcessJob,
  serializePacketProcessJobDetail,
  serializePolishedPurchase,
} from "./phase7Serializers";

// Staff pages must never carry cost, landed cost, brokerage, WIP or charge
// figures. Every secret below uses a distinctive value, and the Staff DTO is
// checked by serialising it and searching for those values — so a field added
// later without ownerOnly() fails here even if nobody remembers to list it.

const SECRETS = ["11111.11", "22222.22", "33333.33", "44444.44", "55555.55", "66666.66", "777.7777", "88888.88"];
const D = new Date("2026-09-17T00:00:00.000Z");

const packetRow = {
  id: "pkt-1", packetCode: "ZL-PKT-1", provenance: "PURCHASED" as const, mergeKey: "k", shape: "ROUND" as const, customShapeName: null,
  sizeLabel: "1.00MM", quality: "VS", colour: "F", lab: null, certificateStatus: "NOT_CERTIFIED" as const, certNumber: null,
  status: "ACTIVE" as const, purchaseCode: "ZL-PP-1", supplierName: "Supplier", pieces: 10, carat: "1.000", costValue: "11111.11",
};

const detail = {
  id: "ppj-1", jobCode: "ZL-PJ-1", manufacturerName: "M", processName: "Polishing", issueDate: D, dueDate: null,
  status: "PARTIALLY_RETURNED" as const, issuedPieces: 10, issuedCarat: "1.000", pendingPieces: 5, pendingCarat: "0.500",
  returnedPieces: 5, usedPieces: 0, damagedPieces: 0, lossCarat: "0.000", issuedCostValue: "22222.22", remainingWipCost: "33333.33",
  totalCharge: "44444.44", notes: null, chargeRateBasis: "PER_CARAT", chargeRate: "777.7777", cancellationReason: null, hasReceipts: true,
  lines: [{ id: "l1", packetCode: "ZL-PKT-1", label: "1.00MM", piecesAtIssue: 10, caratAtIssue: "1.000", costAtIssue: "55555.55", pendingPieces: 5, pendingCarat: "0.500", lossCarat: "0.000", isClosed: false }],
  receipts: [{
    id: "r1", receiptCode: "ZL-PJR-1", receiveDate: D, isFinal: false, lossCarat: "0.000", processCharge: "66666.66",
    lines: [{ disposition: "RETURNED_TO_STOCK", pieces: 5, carat: "0.500", sizeLabel: "1.00MM", costValue: "88888.88", jewelleryJobCode: null, resultPacketCode: "ZL-PKT-1", reason: null }],
  }],
};

function staffPayloads() {
  return [
    serializePacket(packetRow, false),
    serializePacketGroup({ mergeKey: "k", pieces: 10, carat: "1.000", costValue: "11111.11", packetIds: ["pkt-1"], packetCodes: ["ZL-PKT-1"], sample: packetRow }, false),
    serializePolishedPurchase(
      { id: "pp-1", purchaseCode: "ZL-PP-1", purchaseDate: D, supplierName: "S", brokerName: "Dalal", brokerageTreatment: "CAPITALISED_PAYABLE_TO_BROKER", brokerageAmount: "22222.22", supplierAmount: "33333.33", landedCost: "44444.44", lineCount: 1, totalPieces: 10, totalCarat: "1.000", status: "POSTED", referenceNumber: null },
      false
    ),
    serializePacketProcessJob({ ...detail, returnedPieces: 5 }, false),
    serializePacketProcessJobDetail(detail, false),
    serializeJobProcessFields({ processNameSnapshot: "4P / Laser", processOutputKindSnapshot: "ROUGH", chargeRateBasis: "PER_CARAT", chargeRate: { toFixed: () => "777.7777" } }, false),
  ];
}

describe("Phase 7 serializers — Staff redaction", () => {
  it("never puts a cost, brokerage, WIP or charge figure into a Staff payload", () => {
    const json = JSON.stringify(staffPayloads());
    for (const secret of SECRETS) expect(json).not.toContain(secret);
  });

  it("keeps quantities and identities that Staff need to work", () => {
    const [packet, , purchase, , jobDetail, process] = staffPayloads();
    expect(packet).toMatchObject({ packetCode: "ZL-PKT-1", pieces: 10, carat: "1.000", costValue: null });
    expect(purchase).toMatchObject({ brokerName: "Dalal", landedCost: null, brokerageAmount: null });
    expect(jobDetail).toMatchObject({ pendingPieces: 5, issuedCostValue: null, chargeRate: null });
    expect(process).toEqual({ processName: "4P / Laser", processOutputKind: "ROUGH", chargeRateBasis: "PER_CARAT", chargeRate: null });
  });

  it("gives the Owner every figure", () => {
    const json = JSON.stringify([
      serializePacket(packetRow, true),
      serializePacketProcessJobDetail(detail, true),
    ]);
    for (const secret of ["11111.11", "22222.22", "33333.33", "44444.44", "55555.55", "66666.66", "777.7777", "88888.88"]) {
      expect(json).toContain(secret);
    }
  });
});
