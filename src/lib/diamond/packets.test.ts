import { describe, expect, it } from "vitest";

import { buildPacketMergeKey, checkPacketQuantity, groupPacketsByMergeKey, sumPacketMovements } from "./packets";

describe("sumPacketMovements", () => {
  it("nets in and out movements exactly, without floating-point drift", () => {
    const balance = sumPacketMovements([
      { type: "PURCHASE_IN", pieces: 100, carat: "10.000", costValue: "33333.33" },
      { type: "JEWELLERY_ISSUE_OUT", pieces: 30, carat: "3.001", costValue: "10003.33" },
      { type: "JEWELLERY_RETURN_IN", pieces: 5, carat: "0.501", costValue: "1670.00" },
    ]);
    expect(balance).toEqual({ pieces: 75, carat: "7.500", costValue: "25000.00" });
  });

  it("ignores unknown movement types instead of guessing a direction", () => {
    const balance = sumPacketMovements([
      { type: "PURCHASE_IN", pieces: 1, carat: "0.100", costValue: "100.00" },
      { type: "SOMETHING_NEW", pieces: 1, carat: "0.100", costValue: "100.00" },
    ]);
    expect(balance).toEqual({ pieces: 1, carat: "0.100", costValue: "100.00" });
  });

  it("a fully issued and cancelled packet returns to its purchase balance", () => {
    const balance = sumPacketMovements([
      { type: "PURCHASE_IN", pieces: 8, carat: "2.000", costValue: "8000.00" },
      { type: "JEWELLERY_ISSUE_OUT", pieces: 8, carat: "2.000", costValue: "8000.00" },
      { type: "JEWELLERY_ISSUE_CANCEL_IN", pieces: 8, carat: "2.000", costValue: "8000.00" },
    ]);
    expect(balance).toEqual({ pieces: 8, carat: "2.000", costValue: "8000.00" });
  });
});

describe("groupPacketsByMergeKey", () => {
  const key = (provenance: string, size = "1.00-1.20MM") =>
    buildPacketMergeKey({ shape: "ROUND", sizeLabel: size, certificateStatus: "NOT_CERTIFIED", provenance });

  it("shows identical packets together while keeping each packet listed", () => {
    const groups = groupPacketsByMergeKey([
      { id: "a", packetCode: "ZL-PKT-1", mergeKey: key("PURCHASED"), pieces: 10, carat: "1.000", costValue: "5000.00" },
      { id: "b", packetCode: "ZL-PKT-2", mergeKey: key("PURCHASED"), pieces: 20, carat: "2.000", costValue: "12000.00" },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ pieces: 30, carat: "3.000", costValue: "17000.00", packetCodes: ["ZL-PKT-1", "ZL-PKT-2"] });
  });

  it("never groups purchased stones with manufactured ones", () => {
    const groups = groupPacketsByMergeKey([
      { id: "a", packetCode: "ZL-PKT-1", mergeKey: key("PURCHASED"), pieces: 10, carat: "1.000", costValue: "5000.00" },
      { id: "b", packetCode: "ZL-PKT-2", mergeKey: key("MANUFACTURED_FROM_ROUGH"), pieces: 10, carat: "1.000", costValue: "4000.00" },
    ]);
    expect(groups).toHaveLength(2);
  });

  it("leaves empty packets out of the view", () => {
    const groups = groupPacketsByMergeKey([
      { id: "a", packetCode: "ZL-PKT-1", mergeKey: key("PURCHASED"), pieces: 0, carat: "0.000", costValue: "0.00" },
    ]);
    expect(groups).toEqual([]);
  });
});

describe("buildPacketMergeKey + checkPacketQuantity", () => {
  it("normalises case and whitespace so the same stones share a key", () => {
    expect(
      buildPacketMergeKey({ shape: "round", sizeLabel: " 1.00-1.20mm ", certificateStatus: "NOT_CERTIFIED", provenance: "PURCHASED" })
    ).toBe(buildPacketMergeKey({ shape: "ROUND", sizeLabel: "1.00-1.20MM", certificateStatus: "NOT_CERTIFIED", provenance: "PURCHASED" }));
  });

  it("rejects stranding carat with no pieces behind it", () => {
    const result = checkPacketQuantity(
      { pieces: 10, caratThousandths: BigInt(900) },
      { pieces: 10, caratThousandths: BigInt(1000) }
    );
    expect(result.ok).toBe(false);
  });
});
