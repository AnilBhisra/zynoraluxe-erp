import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CorrectionHistoryView } from "./CorrectionHistoryView";
import type { CorrectionHistoryRow } from "@/lib/corrections/history";

const posted: CorrectionHistoryRow = {
  id: "c-1",
  correctionCode: "CORR/2026-27/0002",
  entityType: "METAL_OPENING_STOCK",
  entityLabel: "Opening stock 24K 22.001g",
  mode: "REVALUE",
  state: "POSTED",
  reason: "Opening gold was saved at half the actual purchase rate.",
  amount: "191664.00",
  voucherNumber: "CORR/2026-27/0002",
  preparedBy: "Anil",
  approvedBy: "Anil",
  postedAt: "2026-09-21T10:30:00.000Z",
  createdAt: "2026-09-21T10:30:00.000Z",
  rejectionReason: null,
  originalValue: "160000.00",
  correctedValue: "351664.00",
  impacts: [
    {
      kind: "STOCK",
      recordLabel: "24K usable stock (12.147g)",
      field: "costValue",
      oldValue: "102657.40",
      newValue: "193361.21",
    },
    {
      kind: "FINISHED",
      recordLabel: "ZL-FJ-2026-000087",
      field: "metalCost",
      oldValue: "15668.63",
      newValue: "29512.78",
    },
  ],
};

describe("CorrectionHistoryView", () => {
  it("shows the original value, the corrected value and the reason", () => {
    render(<CorrectionHistoryView rows={[posted]} />);
    const card = screen.getByTestId("correction-CORR/2026-27/0002");

    expect(within(card).getByText("₹1,60,000.00")).toBeTruthy();
    expect(within(card).getByText("₹3,51,664.00")).toBeTruthy();
    expect(within(card).getByText(/half the actual purchase rate/)).toBeTruthy();
  });

  it("names every affected record with its before and after value", () => {
    render(<CorrectionHistoryView rows={[posted]} />);
    const card = screen.getByTestId("correction-CORR/2026-27/0002");

    expect(within(card).getByText("24K usable stock (12.147g)")).toBeTruthy();
    expect(within(card).getByText("102657.40")).toBeTruthy();
    expect(within(card).getByText("193361.21")).toBeTruthy();
    expect(within(card).getByText("ZL-FJ-2026-000087")).toBeTruthy();
    expect(within(card).getByText("29512.78")).toBeTruthy();
  });

  it("records who prepared and who approved it", () => {
    render(<CorrectionHistoryView rows={[posted]} />);
    expect(screen.getByText(/Prepared by Anil · Approved by Anil/)).toBeTruthy();
  });

  it("marks a draft as waiting for the Owner and shows no approver", () => {
    render(
      <CorrectionHistoryView
        rows={[
          {
            ...posted,
            id: "c-2",
            correctionCode: "CORR-DRAFT-xyz",
            state: "AWAITING_APPROVAL",
            approvedBy: null,
            postedAt: null,
            voucherNumber: null,
            amount: null,
            impacts: [],
          },
        ]}
      />
    );
    expect(screen.getByText("Waiting for Owner")).toBeTruthy();
    expect(screen.getByText(/not yet approved/)).toBeTruthy();
  });

  it("explains the page rather than showing an empty list", () => {
    render(<CorrectionHistoryView rows={[]} />);
    expect(screen.getByText("No corrections yet")).toBeTruthy();
    expect(screen.queryByTestId("correction-history")).toBeNull();
  });
});
