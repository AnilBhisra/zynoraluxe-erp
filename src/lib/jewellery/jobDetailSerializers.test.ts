import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jewelleryJobFindUnique: vi.fn(),
  metalStockMovementFindMany: vi.fn(),
  stockMovementFindMany: vi.fn(),
  // Phase 8B carrying-cost read model: this suite has no posted revaluation,
  // so an empty result is enough to send every job through the fast,
  // unaffected path (stored figures, unchanged) — see carryingCost.ts.
  metalRevaluationFindMany: vi.fn().mockResolvedValue([]),
  correctionFindFirst: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: {
    jewelleryJob: { findUnique: mocks.jewelleryJobFindUnique },
    metalStockMovement: { findMany: mocks.metalStockMovementFindMany },
    stockMovement: { findMany: mocks.stockMovementFindMany },
    metalRevaluation: { findMany: mocks.metalRevaluationFindMany },
    correction: { findFirst: mocks.correctionFindFirst },
    // "Can Issue Materials still run?" (Karigar custody): this job had its own
    // issue, so it holds its own issue line — the answer is no.
    jewelleryMetalIssueLine: { count: vi.fn().mockResolvedValue(1) },
    jewelleryReceipt: { count: vi.fn().mockResolvedValue(0) },
    jewelleryDiamondIssueLine: { count: vi.fn().mockResolvedValue(0) },
    jewelleryPacketIssueLine: { count: vi.fn().mockResolvedValue(1) },
    jewelleryOtherMaterialLine: { count: vi.fn().mockResolvedValue(0) },
  },
}));

import { jobManufacturingCost } from "./jobIssuedCost";
import { serializeJobCostSummary, serializeJobPacketLines } from "./jobDetailSerializers";
import { getJewelleryJobDetail } from "./reports";
import type { Decimal } from "@/lib/accounting/money";

// This suite has no posted revaluation, so every carrying-cost figure takes
// the fast, unaffected path and is always a real Decimal — never the
// CARRYING_COST_UNAVAILABLE sentinel. Narrows the type for `.toFixed()`.
function amount(v: Decimal | "UNAVAILABLE"): Decimal {
  if (typeof v === "string") throw new Error(`expected a Decimal, got the unavailable sentinel`);
  return v;
}

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

const noExtras = { karigarAddedCost: "0.00", totalLabourCharge: "0.00" };
const figures = (c: ReturnType<typeof jobManufacturingCost>) =>
  [c.issuedDiamondCost, c.materialsSubtotal, c.karigarSuppliedCost, c.chargesTotal, c.totalManufacturingCost].map((d) => d.toFixed(2));

describe("Jewellery Job manufacturing cost = materials + Karigar-supplied + charges, each once", () => {
  it("adds packet cost to diamond cost issued and to the materials subtotal", () => {
    const costs = jobManufacturingCost({ issuedMetalCost: "140500.00", issuedDiamondCost: "0.00", issuedPacketDiamondCost: "10212.58", otherMaterialCost: "0.00", ...noExtras }, 0);
    expect(figures(costs)).toEqual(["10212.58", "150712.58", "0.00", "0.00", "150712.58"]);
  });

  it("sums individually costed diamonds, packets and other material exactly once", () => {
    const costs = jobManufacturingCost({ issuedMetalCost: "140500.00", issuedDiamondCost: "8000.00", issuedPacketDiamondCost: "34997.43", otherMaterialCost: "250.50", ...noExtras }, 0);
    expect(figures(costs)).toEqual(["42997.43", "183747.93", "0.00", "0.00", "183747.93"]);
  });

  // The two jobs reported, each from its OWN recorded figures (production, read-only).
  it("ZL-JJOB-2026-000001: 48,384.00 metal + 24,961.25 packets = 73,345.25 materials; + 5,166.00 making = 78,511.25", () => {
    const costs = jobManufacturingCost(
      { issuedMetalCost: "48384.00", issuedDiamondCost: "0.00", issuedPacketDiamondCost: "24961.25", otherMaterialCost: "0.00", karigarAddedCost: "0.00", totalLabourCharge: "5166.00" },
      "0.00"
    );
    expect(figures(costs)).toEqual(["24961.25", "73345.25", "0.00", "5166.00", "78511.25"]);
  });

  it("ZL-JJOB-2026-000002: 66,592.00 metal + 20,101.17 packets = 86,693.17 materials; + 6,571.00 making + 3,450.00 other = 96,714.17", () => {
    const costs = jobManufacturingCost(
      { issuedMetalCost: "66592.00", issuedDiamondCost: "0.00", issuedPacketDiamondCost: "20101.17", otherMaterialCost: "0.00", karigarAddedCost: "0.00", totalLabourCharge: "10021.00" },
      "0.00"
    );
    expect(figures(costs)).toEqual(["20101.17", "86693.17", "0.00", "10021.00", "96714.17"]);
  });

  it("never adds Company alloy twice: issuedMetalCost already holds it", () => {
    // 24K 20 g (Rs 1,40,000) + Company alloy 5 g (Rs 500) -> issuedMetalCost 1,40,500.
    const costs = jobManufacturingCost({ issuedMetalCost: "140500.00", issuedDiamondCost: "0.00", issuedPacketDiamondCost: "0.00", otherMaterialCost: "0.00", ...noExtras }, 0);
    expect(costs.materialsSubtotal.toFixed(2)).toBe("140500.00");
  });

  it("includes Karigar-added material and Karigar alloy charges, and charges added later, once each", () => {
    const costs = jobManufacturingCost(
      // 1,000.00 charged at receipt + 250.00 added later by a charge correction = 1,250.00.
      { issuedMetalCost: "10000.00", issuedDiamondCost: "2000.00", issuedPacketDiamondCost: "0.00", otherMaterialCost: "100.00", karigarAddedCost: "700.00", totalLabourCharge: "1250.00" },
      "300.00"
    );
    expect(figures(costs)).toEqual(["2000.00", "12100.00", "1000.00", "1250.00", "14350.00"]);
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
    expect(amount(detail!.materialsSubtotal).toFixed(2)).toBe("175497.43");
    expect(amount(detail!.totalManufacturingCost).toFixed(2)).toBe("175497.43"); // no charges yet
  });

  it("shows the acceptance run's exact figures after the direct packet issue: ₹10,212.58 diamond, ₹1,50,712.58 total", async () => {
    mocks.jewelleryJobFindUnique.mockResolvedValue(job());
    const detail = await getJewelleryJobDetail("job-1");
    expect(detail!.issuedDiamondCost.toFixed(2)).toBe("10212.58");
    expect(amount(detail!.totalManufacturingCost).toFixed(2)).toBe("150712.58");
  });

  it("after a receipt, the total includes its charges and Karigar alloy charge (the reported defect)", async () => {
    mocks.jewelleryJobFindUnique.mockResolvedValue(
      job({ totalLabourCharge: "3000.00", karigarAddedCost: "400.00", receipts: [
          {
            id: "r1", receiptCode: "ZL-JREC-2026-000001", receiveDate: D, returnedMetalFineWeight: "0", scrapFineWeight: "0", processLossFineWeight: "0", isAbnormalLoss: false,
            labourCharge: "3000.00", makingCharge: "0", settingCharge: "0", platingCharge: "0", otherExpense: "0", companyAlloyGrossWeight: "0", karigarAlloyGrossWeight: "0.200",
            karigarAlloyCost: "150.00", includedAlloyGrossWeight: "0", returnedAlloyGrossWeight: "0", alloyLossGrossWeight: "0", unabsorbedCost: "0",
          },
        ] })
    );
    const detail = (await getJewelleryJobDetail("job-1"))!;
    expect([amount(detail.materialsSubtotal).toFixed(2), detail.karigarSuppliedCost.toFixed(2), detail.totalLabourCharge.toFixed(2), amount(detail.totalManufacturingCost).toFixed(2)]).toEqual([
      "150712.58",
      "550.00",
      "3000.00",
      "154262.58",
    ]);
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
    expect(summary).toEqual({
      issuedMetalCost: null,
      issuedDiamondCost: null,
      otherMaterialCost: null,
      materialsSubtotal: null,
      karigarSuppliedCost: null,
      totalLabourCharge: null,
      totalManufacturingCost: null,
    });
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
      materialsSubtotal: "150712.58",
      karigarSuppliedCost: "0.00",
      totalLabourCharge: "0.00",
      totalManufacturingCost: "150712.58",
    });
  });
});
