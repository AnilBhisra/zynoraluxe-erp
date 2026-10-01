/**
 * Finished-piece sticker markup and the print entry points: what each sticker
 * shows (and never shows), and that the job page offers Print after a receipt
 * is saved without opening any print dialog by itself.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
// The real receive form is exercised elsewhere; here it only reports a saved receipt code.
vi.mock("@/components/jewellery/ReceiveFinishedForm", async (orig) => ({
  ...(await orig<typeof import("./ReceiveFinishedForm")>()),
  ReceiveFinishedForm: ({ onDone }: { onDone?: (code?: string) => void }) => (
    <button type="button" onClick={() => onDone?.("ZL-JREC-2026-000004")}>
      fake save receipt
    </button>
  ),
}));

import type { PieceSticker as StickerData } from "@/lib/jewellery/stickers";
import { stickerHref } from "@/lib/jewellery/stickerLinks";
import { JobDetailView, type SerializedJobDetail } from "./JobDetailView";
import { PieceSticker } from "./PieceSticker";

const STICKER: StickerData = {
  finishedCode: "ZL-FJ-2026-000004",
  jobCode: "ZL-JJOB-2026-000003",
  receiptCode: "ZL-JREC-2026-000004",
  category: "Bracelet",
  designName: "ZL-BRC-005",
  metalLabel: "Gold 14K (58.500%)",
  netWeight: "44.091",
  grossWeight: null,
  fineWeight: "26.455",
  stonePieces: 26,
  stoneCarat: "13.269",
  customerName: "YOGESHBHAI SAHYOG",
  karigarName: "AMULAY JAWE",
  receiptDate: "2026-10-01T00:00:00.000Z",
  statusLabel: "CUSTOMER GOLD — AWAITING DELIVERY",
  active: true,
  lookupPath: "/p/ZL-FJ-2026-000004",
};
const QR = { path: "M2 2h1v1h-1z", side: 25 };

describe("PieceSticker", () => {
  it("prints every required field, 'Gross: Not recorded', the Customer and the awaiting-delivery label — and nothing financial", () => {
    const { container } = render(<PieceSticker s={STICKER} qr={QR} size="50x25" reprint={false} />);
    const t = container.textContent ?? "";
    for (const part of [
      "ZYNORALUXE",
      "CUSTOMER GOLD — AWAITING DELIVERY",
      "ZL-FJ-2026-000004",
      "Job ZL-JJOB-2026-000003",
      "Rec ZL-JREC-2026-000004 · 01/10/2026",
      "Bracelet · ZL-BRC-005",
      "Gold 14K (58.500%)",
      "Net 44.091 g · Fine 26.455 g",
      "Gross: Not recorded",
      "Stones 26 pcs / 13.269 ct",
      "Cust YOGESHBHAI SAHYOG",
      "Kar AMULAY JAWE",
    ])
      expect(t).toContain(part);
    expect(t).not.toMatch(/₹|cost|price|REPRINT/i);
    expect(screen.getByTestId("sticker-qr").getAttribute("width")).toBe("16mm");
    expect(screen.getByTestId("sticker-status").className).toBe("sticker-status");
    // No inline style anywhere: the CSP forbids it and print layout lives in globals.css.
    expect(container.querySelectorAll("[style]").length).toBe(0);
  });

  it("a reprint of an inactive piece shows REPRINT and the inverted not-active status; 50 × 30 uses the larger QR", () => {
    render(<PieceSticker s={{ ...STICKER, active: false, statusLabel: "RECEIPT REVERSED — NOT ACTIVE", customerName: null, grossWeight: "46.880" }} qr={QR} size="50x30" reprint />);
    expect(screen.getByTestId("sticker-reprint").textContent).toBe("REPRINT");
    expect(screen.getByTestId("sticker-status").className).toContain("sticker-status-inactive");
    expect(screen.getByTestId("sticker-gross").textContent).toBe("Gross 46.880 g");
    expect(screen.getByTestId("sticker-qr").getAttribute("width")).toBe("20mm");
    expect(screen.queryByText(/^Cust /)).toBeNull();
  });

  it("sticker links carry codes only", () => {
    expect(stickerHref({ receipt: "ZL-JREC-2026-000004", back: "/jewellery-jobs?jobId=j1" })).toBe("/stickers?receipt=ZL-JREC-2026-000004&back=%2Fjewellery-jobs%3FjobId%3Dj1");
    expect(stickerHref({ pieces: ["ZL-FJ-1", "ZL-FJ-2"], reprint: true })).toBe("/stickers?piece=ZL-FJ-1&piece=ZL-FJ-2&reprint=1");
  });
});

function baseJob(isOwner: boolean): SerializedJobDetail {
  const cost = <T,>(value: T) => (isOwner ? value : null);
  return {
    id: "job-1",
    jobCode: "ZL-JJOB-2026-000001",
    karigarId: "karigar-1",
    custodyAllocatedFineWeight: "0.000",
    custodyReleasedFineWeight: "0.000",
    canIssueMaterials: false,
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
    // 1,40,500.00 metal (incl. Company alloy) + 34,997.43 packets = 1,75,497.43; + 3,000.00 charges.
    materialsSubtotal: cost("175497.43"),
    karigarSuppliedCost: cost("0.00"),
    totalManufacturingCost: cost("178497.43"),
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

function job(): SerializedJobDetail {
  return {
    ...baseJob(false),
    id: "j1",
    status: "IN_PROGRESS",
    isCompleted: false,
    receipts: [
      {
        id: "r4",
        receiptCode: "ZL-JREC-2026-000004",
        receiveDate: "2026-10-01T00:00:00.000Z",
        returnedMetalFineWeight: "0.000",
        scrapFineWeight: "0.000",
        processLossFineWeight: "0.000",
        isAbnormalLoss: false,
        alloyAddedWeight: "17.636",
        returnedAlloyGrossWeight: "0.000",
        totalCharges: null,
        chargesAddedLater: null,
        karigarAlloyCost: null,
        unabsorbedCost: null,
        customerGold: false,
        reversedAt: null,
        reversalReason: null,
      },
    ],
    finishedOutputs: [
      {
        id: "f4",
        receiptId: "r4",
        finishedCode: "ZL-FJ-2026-000004",
        jewelleryType: "BRACELET",
        quantity: 1,
        netMetalWeight: "44.091",
        fineMetalWeight: "26.455",
        purityDisplayName: "14K",
        sourcePurityDisplayName: null,
        alloyAddedWeight: "17.636",
        alloyCost: null,
        totalCost: null,
        totalCostCurrent: null,
        qcStatus: "PASSED",
        status: "CUSTOMER_AWAITING_DELIVERY",
        photoUrl: null,
      },
    ],
  };
}

describe("Job page print entry points (Staff and Owner alike)", () => {
  it("each receipt offers its stickers and each piece a sticker — as reprints, opened by the user", () => {
    render(<JobDetailView job={job()} isOwner={false} purities={[]} availableDiamonds={[]} />);
    expect(screen.getByTestId("receipt-stickers-ZL-JREC-2026-000004").getAttribute("href")).toBe(
      "/stickers?receipt=ZL-JREC-2026-000004&reprint=1&back=%2Fjewellery-jobs%3FjobId%3Dj1"
    );
    expect(screen.getByTestId("piece-sticker-ZL-FJ-2026-000004").getAttribute("href")).toBe("/stickers?piece=ZL-FJ-2026-000004&reprint=1&back=%2Fjewellery-jobs%3FjobId%3Dj1");
    expect(screen.getByTestId("piece-sticker-ZL-FJ-2026-000004").getAttribute("target")).toBe("_blank");
  });

  it("after a receipt is saved the page shows it with Print sticker / Print all stickers — never auto-printing", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    render(<JobDetailView job={job()} isOwner={true} purities={[]} availableDiamonds={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Receive Finished Jewellery" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake save receipt" }));
    });
    expect(screen.getByTestId("receipt-saved-banner").textContent).toContain("Receipt saved as ZL-JREC-2026-000004.");
    expect(screen.getByTestId("print-sticker").getAttribute("href")).toBe("/stickers?piece=ZL-FJ-2026-000004&back=%2Fjewellery-jobs%3FjobId%3Dj1");
    expect(screen.getByTestId("print-all-stickers").getAttribute("href")).toBe("/stickers?receipt=ZL-JREC-2026-000004&back=%2Fjewellery-jobs%3FjobId%3Dj1");
    expect(screen.getByTestId("print-all-stickers").textContent).toContain("(1)");
    expect(print).not.toHaveBeenCalled();
  });
});
