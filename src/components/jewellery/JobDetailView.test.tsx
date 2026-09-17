import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The view's forms import Server Actions, whose module creates the real Prisma
// client at import time (no DATABASE_URL under Vitest) — mock them out.
vi.mock("@/app/actions/jewellery", () => ({
  markJewelleryJobInProgressAction: vi.fn(),
  setJewelleryJobNeedsCorrectionAction: vi.fn(),
  issueMaterialsAction: vi.fn(),
  receiveFinishedJewelleryAction: vi.fn(),
  cancelJewelleryJobAction: vi.fn(),
  overrideFinishedAllocationAction: vi.fn(),
  uploadJewelleryPhotoAction: vi.fn(),
  deleteJewelleryPhotoAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { JobDetailView, type SerializedJobDetail } from "./JobDetailView";

function job(isOwner: boolean): SerializedJobDetail {
  const cost = <T,>(value: T) => (isOwner ? value : null);
  return {
    id: "job-1",
    jobCode: "ZL-JJOB-2026-000001",
    customerName: null,
    customerReference: null,
    karigarName: "PHASE7TEST Karigar",
    jewelleryType: "RING",
    designName: "PHASE7TEST 24K to 18K-14K-9K",
    designImageUrl: null,
    issueDate: "2026-09-17T00:00:00.000Z",
    expectedDeliveryDate: null,
    status: "COMPLETED",
    jewellerySize: null,
    quantity: 3,
    notes: null,
    specialInstructions: null,
    targetMetalType: null,
    targetPurityDisplayName: null,
    targetFinishedWeight: null,
    issuedMetalFineWeight: "19.980",
    issuedMetalCost: cost("140500.00"),
    issuedDiamondCost: cost("34997.43"),
    otherMaterialCost: cost("0.00"),
    remainingWipCost: cost("0.00"),
    totalLabourCharge: cost("3000.00"),
    receivedFineWeight: "15.930",
    returnedMetalFineWeight: "1.998",
    scrapFineWeight: "0.999",
    karigarAddedFineWeight: "0.000",
    karigarAddedCost: cost("0.00"),
    issuedAlloyGrossWeight: "5.000",
    issuedAlloyCost: cost("500.00"),
    consumedAlloyGrossWeight: "5.000",
    returnedAlloyGrossWeight: "0.000",
    remainingAlloyWipCost: cost("0.00"),
    alloyPendingGrossWeight: "0.000",
    pendingFineWeight: "1.053",
    totalIssuedCost: cost("175497.43"),
    cancellationReason: null,
    isCompleted: true,
    finalMetalLossFineWeight: "1.053",
    metalLines: [],
    diamondLines: [],
    packetLines: [
      {
        id: "jpl-a",
        packetCode: "ZL-PKT-2026-000001",
        label: "Round · 1.00-1.20MM · VS · F",
        fromJobManufacturer: false,
        piecesAtIssue: 20,
        caratAtIssue: "2.000",
        costAtIssue: cost("10212.58"),
        setPieces: 20,
        setCarat: "2.000",
        returnedPieces: 0,
        returnedCarat: "0.000",
        damagedPieces: 0,
        damagedCarat: "0.000",
      },
      {
        id: "jpl-b",
        packetCode: "ZL-PKT-2026-000002",
        label: "Round · 1.50MM · VS · F",
        fromJobManufacturer: true,
        piecesAtIssue: 30,
        caratAtIssue: "3.000",
        costAtIssue: cost("24784.85"),
        setPieces: 30,
        setCarat: "3.000",
        returnedPieces: 0,
        returnedCarat: "0.000",
        damagedPieces: 0,
        damagedCarat: "0.000",
      },
    ],
    otherMaterialLines: [],
    receipts: [],
    finishedOutputs: [],
    timeline: [],
  };
}

function renderFor(isOwner: boolean) {
  return render(<JobDetailView job={job(isOwner)} isOwner={isOwner} purities={[]} availableDiamonds={[]} />);
}

describe("JobDetailView — packet stones issued", () => {
  it("shows Staff each packet's code, description, pieces and carat, with no cost anywhere", () => {
    const { container } = renderFor(false);

    const a = screen.getByTestId("packet-line-ZL-PKT-2026-000001");
    expect(a.textContent).toContain("ZL-PKT-2026-000001 · Round · 1.00-1.20MM · VS · F · 20 pcs / 2.000ct");
    const b = screen.getByTestId("packet-line-ZL-PKT-2026-000002");
    expect(b.textContent).toContain("30 pcs / 3.000ct · from Job Manufacturer");
    expect(b.textContent).toContain("Set 30 pcs / 3.000ct");

    expect(screen.queryByText("Diamond cost issued")).toBeNull();
    expect(screen.queryByText("Total manufacturing cost issued")).toBeNull();
    expect(container.textContent).not.toContain("₹");
    for (const secret of ["10212.58", "24784.85", "34997.43", "175497.43"]) expect(container.innerHTML).not.toContain(secret);
  });

  it("shows the Owner packet costs and packet-inclusive diamond and total cost issued", () => {
    renderFor(true);

    expect(screen.getByTestId("packet-line-ZL-PKT-2026-000001").textContent).toContain("20 pcs / 2.000ct · ₹10212.58");
    expect(screen.getByTestId("packet-line-ZL-PKT-2026-000002").textContent).toContain("₹24784.85");
    expect(screen.getByText("Diamond cost issued").nextSibling?.textContent).toBe("₹34997.43");
    expect(screen.getByText("Total manufacturing cost issued").nextSibling?.textContent).toBe("₹175497.43");
  });
});
