import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jewelleryJobFindUnique: vi.fn(),
  metalStockMovementFindMany: vi.fn(),
  stockMovementFindMany: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    jewelleryJob: { findUnique: mocks.jewelleryJobFindUnique },
    metalStockMovement: { findMany: mocks.metalStockMovementFindMany },
    stockMovement: { findMany: mocks.stockMovementFindMany },
  },
}));

import { jobIssuedCosts } from "./jobIssuedCost";
import { serializeJobCostSummary, serializeJobPacketLines } from "./jobDetailSerializers";
import { getJewelleryJobDetail } from "./reports";

const D = new Date("2026-09-17T00:00:00.000Z");

// The Jewellery Job from the real acceptance run: 24K 20 g + Company alloy 5 g
// (₹1,40,500), 20 pcs / 2 ct from packet A issued from stock (₹10,212.58 —
// packet A's average cost after its Job Manufacturer returns), then 30 pcs /
// 3 ct of packet B used from a Job Manufacturer return (₹24,784.85).
function packetLine(overrides: Record<string, unknown>) {
  return {
    id: "jpl-a",
    jobId: "job-1",
    packetId: "pkt-a",
    packet: { packetCode: "ZL-PKT-2026-000001", shape: "ROUND", customShapeName: null, sizeLabel: "1.00-1.20MM", quality: "VS", colour: "F" },
    piecesAtIssue: 20,
    caratAtIssue: "2.000",
    costAtIssue: "10212.58",
    setPieces: 0,
    setCarat: "0",
    setCost: "0",
    returnedPieces: 0,
    returnedCarat: "0",
    returnedCost: "0",
    damagedPieces: 0,
    damagedCarat: "0",
    damagedCost: "0",
    sourcePacketProcessReceiptLineId: null,
    createdAt: D,
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    jobCode: "ZL-JJOB-2026-000001",
    customer: null,
    customerReference: null,
    karigar: { name: "PHASE7TEST Karigar" },
    jewelleryType: "RING",
    designName: "PHASE7TEST 24K to 18K-14K-9K",
    designImageAssetId: null,
    issueDate: D,
    expectedDeliveryDate: null,
    status: "MATERIALS_ISSUED",
    jewellerySize: null,
    quantity: 3,
    notes: null,
    specialInstructions: null,
    targetMetalType: null,
    targetPurity: null,
    targetFinishedWeight: null,
    issuedMetalFineWeight: "19.980",
    issuedMetalCost: "140500.00",
    issuedDiamondCost: "0.00",
    issuedPacketDiamondCost: "10212.58",
    otherMaterialCost: "0.00",
    remainingWipCost: "140000.00",
    totalLabourCharge: "0.00",
    receivedFineWeight: "0",
    returnedMetalFineWeight: "0",
    scrapFineWeight: "0",
    karigarAddedFineWeight: "0",
    karigarAddedCost: "0",
    issuedAlloyGrossWeight: "5.000",
    issuedAlloyCost: "500.00",
    consumedAlloyGrossWeight: "0",
    returnedAlloyGrossWeight: "0",
    remainingAlloyWipCost: "500.00",
    cancelledAt: null,
    cancellationReason: null,
    metalIssueLines: [],
    diamondIssueLines: [],
    packetIssueLines: [packetLine({})],
    otherMaterialLines: [],
    receipts: [],
    finishedJewellery: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.metalStockMovementFindMany.mockResolvedValue([]);
  mocks.stockMovementFindMany.mockResolvedValue([]);
});

describe("Jewellery Job issued cost includes packet stones", () => {
  it("adds packet cost to diamond cost issued and to the total manufacturing cost issued", () => {
    const costs = jobIssuedCosts({ issuedMetalCost: "140500.00", issuedDiamondCost: "0.00", issuedPacketDiamondCost: "10212.58", otherMaterialCost: "0.00" });
    expect(costs.issuedDiamondCost.toFixed(2)).toBe("10212.58");
    expect(costs.totalIssuedCost.toFixed(2)).toBe("150712.58");
  });

  it("sums individually costed diamonds, packets and other material exactly once", () => {
    const costs = jobIssuedCosts({ issuedMetalCost: "140500.00", issuedDiamondCost: "8000.00", issuedPacketDiamondCost: "34997.43", otherMaterialCost: "250.50" });
    expect(costs.issuedDiamondCost.toFixed(2)).toBe("42997.43");
    expect(costs.totalIssuedCost.toFixed(2)).toBe("183747.93");
  });
});

describe("getJewelleryJobDetail loads packet lines", () => {
  it("returns every packet line with code, description, pieces, carat and cost, and packet-inclusive totals", async () => {
    mocks.jewelleryJobFindUnique.mockResolvedValue(
      job({
        issuedPacketDiamondCost: "34997.43",
        packetIssueLines: [
          packetLine({}),
          packetLine({
            id: "jpl-b",
            packetId: "pkt-b",
            packet: { packetCode: "ZL-PKT-2026-000002", shape: "ROUND", customShapeName: null, sizeLabel: "1.50MM", quality: "VS", colour: "F" },
            piecesAtIssue: 30,
            caratAtIssue: "3.000",
            costAtIssue: "24784.85",
            sourcePacketProcessReceiptLineId: "pprl-1",
          }),
        ],
      })
    );

    const detail = await getJewelleryJobDetail("job-1");

    expect(mocks.jewelleryJobFindUnique.mock.calls[0][0].include.packetIssueLines).toEqual({ include: { packet: true }, orderBy: { createdAt: "asc" } });
    expect(detail!.packetLines.map((l) => [l.packetCode, l.label, l.piecesAtIssue, l.caratAtIssue.toFixed(3), l.costAtIssue.toFixed(2), l.fromJobManufacturer])).toEqual([
      ["ZL-PKT-2026-000001", "Round · 1.00-1.20MM · VS · F", 20, "2.000", "10212.58", false],
      ["ZL-PKT-2026-000002", "Round · 1.50MM · VS · F", 30, "3.000", "24784.85", true],
    ]);
    expect(detail!.issuedDiamondCost.toFixed(2)).toBe("34997.43");
    expect(detail!.totalIssuedCost.toFixed(2)).toBe("175497.43");
  });

  it("shows the acceptance run's exact figures after the direct packet issue: ₹10,212.58 diamond, ₹1,50,712.58 total", async () => {
    mocks.jewelleryJobFindUnique.mockResolvedValue(job());
    const detail = await getJewelleryJobDetail("job-1");
    expect(detail!.issuedDiamondCost.toFixed(2)).toBe("10212.58");
    expect(detail!.totalIssuedCost.toFixed(2)).toBe("150712.58");
  });
});

describe("Jewellery Job detail DTO — Staff sees packet identity and quantities, never cost", () => {
  async function detail() {
    mocks.jewelleryJobFindUnique.mockResolvedValue(job({ issuedPacketDiamondCost: "10212.58", issuedMetalCost: "140500.00" }));
    return (await getJewelleryJobDetail("job-1"))!;
  }

  it("redacts every packet and summary cost for Staff", async () => {
    const d = await detail();
    const lines = serializeJobPacketLines(d.packetLines, false);
    const summary = serializeJobCostSummary(d, false);

    expect(lines).toEqual([
      {
        id: "jpl-a",
        packetCode: "ZL-PKT-2026-000001",
        label: "Round · 1.00-1.20MM · VS · F",
        fromJobManufacturer: false,
        piecesAtIssue: 20,
        caratAtIssue: "2.000",
        costAtIssue: null,
        setPieces: 0,
        setCarat: "0.000",
        returnedPieces: 0,
        returnedCarat: "0.000",
        damagedPieces: 0,
        damagedCarat: "0.000",
      },
    ]);
    expect(summary).toEqual({ issuedMetalCost: null, issuedDiamondCost: null, otherMaterialCost: null, totalIssuedCost: null });
    const payload = JSON.stringify({ lines, summary });
    for (const secret of ["10212.58", "140500", "150712.58"]) expect(payload).not.toContain(secret);
  });

  it("keeps the exact costs for the Owner", async () => {
    const d = await detail();
    expect(serializeJobPacketLines(d.packetLines, true)[0].costAtIssue).toBe("10212.58");
    expect(serializeJobCostSummary(d, true)).toEqual({
      issuedMetalCost: "140500.00",
      issuedDiamondCost: "10212.58",
      otherMaterialCost: "0.00",
      totalIssuedCost: "150712.58",
    });
  });
});
