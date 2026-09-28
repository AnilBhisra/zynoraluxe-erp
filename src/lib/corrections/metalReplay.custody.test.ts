import { describe, expect, it } from "vitest";

import { replayMetalValues, ReplayError, type ReplayMovement } from "./metalReplay";

/**
 * Karigar metal custody inside a revaluation replay: an opening of 100 g at
 * ₹1,000/g is restated to ₹1,200/g. 10 g goes to a Karigar's unallocated
 * balance, 4 g of it to Job A, 3 g to Job B; 1 g is released back from A;
 * 2 g is returned to stock. Every custody leg must carry the RESTATED value,
 * and a reversal must mirror exactly what it reverses.
 */
const at = (n: number) => new Date(Date.UTC(2026, 8, 28, 10, n, 0));
const mv = (id: string, n: number, type: ReplayMovement["type"], gross: string, fine: string, cost: string, extra: Partial<ReplayMovement> = {}): ReplayMovement => ({
  id,
  type,
  createdAt: at(n),
  grossWeight: gross,
  fineWeight: fine,
  costValue: cost,
  sourceDocument: id,
  jewelleryJobId: null,
  karigarId: null,
  ...extra,
});

const base = (): ReplayMovement[] => [
  mv("open", 0, "OPENING_IN", "100.000", "100.000", "100000.00"),
  mv("issue-k", 1, "KARIGAR_ISSUE_OUT", "10.000", "10.000", "10000.00", { karigarId: "k1" }),
  mv("alloc-a", 2, "CUSTODY_TO_JOB", "4.000", "4.000", "4000.00", { karigarId: "k1", jewelleryJobId: "A" }),
  mv("alloc-b", 3, "CUSTODY_TO_JOB", "3.000", "3.000", "3000.00", { karigarId: "k1", jewelleryJobId: "B" }),
  mv("release-a", 4, "JOB_TO_CUSTODY", "1.000", "1.000", "1000.00", { karigarId: "k1", jewelleryJobId: "A" }),
  mv("return-k", 5, "KARIGAR_RETURN_IN", "2.000", "2.000", "2000.00", { karigarId: "k1" }),
];

describe("metal replay — Karigar custody", () => {
  it("carries the restated value through issue, allocation, release and return, and conserves it", () => {
    const r = replayMetalValues({ movements: base(), receipts: [], targetMovementId: "open", targetNewCostValue: "120000.00" });
    expect(r.movements.get("issue-k")!.newValue.toFixed(2)).toBe("12000.00");
    expect(r.movements.get("alloc-a")!.newValue.toFixed(2)).toBe("4800.00");
    expect(r.movements.get("alloc-b")!.newValue.toFixed(2)).toBe("3600.00");
    expect(r.movements.get("release-a")!.newValue.toFixed(2)).toBe("1200.00");
    expect(r.movements.get("return-k")!.newValue.toFixed(2)).toBe("2400.00");

    const k = r.custody.get("k1")!;
    expect([k.grossWeight.toFixed(3), k.fineWeight.toFixed(3), k.newValue.toFixed(2), k.oldValue.toFixed(2)]).toEqual(["2.000", "2.000", "2400.00", "2000.00"]);
    expect(r.jobWip.get("A")!.newValue.toFixed(2)).toBe("3600.00");
    expect(r.jobWip.get("B")!.newValue.toFixed(2)).toBe("3600.00");
    // Pool 100 -> -10 +2 = 92 g at ₹1,200.
    expect(r.usablePool.grossWeight.toFixed(3)).toBe("92.000");
    expect(r.usablePool.newValue.toFixed(2)).toBe("110400.00");
    // Total conserved: stock + custody + job WIP = restated opening.
    const total = r.usablePool.newValue.plus(k.newValue).plus(r.jobWip.get("A")!.newValue).plus(r.jobWip.get("B")!.newValue);
    expect(total.toFixed(2)).toBe("120000.00");
  });

  it("a partial allocation takes its fine-weight share rounded to the paisa, and the remainder stays behind", () => {
    const movements = [
      mv("open", 0, "OPENING_IN", "3.000", "3.000", "100.00"),
      mv("issue-k", 1, "KARIGAR_ISSUE_OUT", "3.000", "3.000", "100.00", { karigarId: "k1" }),
      mv("alloc-1", 2, "CUSTODY_TO_JOB", "1.000", "1.000", "33.33", { karigarId: "k1", jewelleryJobId: "J1" }),
      mv("alloc-2", 3, "CUSTODY_TO_JOB", "1.000", "1.000", "33.34", { karigarId: "k1", jewelleryJobId: "J2" }),
      mv("alloc-3", 4, "CUSTODY_TO_JOB", "1.000", "1.000", "33.33", { karigarId: "k1", jewelleryJobId: "J3" }),
    ];
    const r = replayMetalValues({ movements, receipts: [], targetMovementId: "open", targetNewCostValue: "100.00" });
    const shares = ["alloc-1", "alloc-2", "alloc-3"].map((id) => r.movements.get(id)!.newValue);
    expect(shares.map((s) => s.toFixed(2))).toEqual(["33.33", "33.34", "33.33"]); // last takes the exact remainder
    expect(shares.reduce((s, v) => s.plus(v)).toFixed(2)).toBe("100.00");
    expect(r.custody.has("k1")).toBe(false); // fully allocated: nothing left
  });

  it("a reversal mirrors the restated value of what it reverses, netting to zero", () => {
    const movements = [
      ...base().slice(0, 3),
      mv("alloc-a-rev", 3, "JOB_TO_CUSTODY", "4.000", "4.000", "4000.00", { karigarId: "k1", jewelleryJobId: "A", reversalOfMovementId: "alloc-a" }),
      mv("issue-k-rev", 4, "KARIGAR_RETURN_IN", "10.000", "10.000", "10000.00", { karigarId: "k1", reversalOfMovementId: "issue-k" }),
    ];
    const r = replayMetalValues({ movements, receipts: [], targetMovementId: "open", targetNewCostValue: "120000.00" });
    expect(r.movements.get("alloc-a-rev")!.newValue.toFixed(2)).toBe("4800.00");
    expect(r.movements.get("issue-k-rev")!.newValue.toFixed(2)).toBe("12000.00");
    expect(r.custody.size).toBe(0);
    expect(r.jobWip.size).toBe(0);
    expect(r.usablePool.newValue.toFixed(2)).toBe("120000.00");
  });

  it("refuses a custody movement that takes more than the Karigar held, or has no Karigar", () => {
    const over = [mv("open", 0, "OPENING_IN", "10.000", "10.000", "10000.00"), mv("alloc", 1, "CUSTODY_TO_JOB", "1.000", "1.000", "1000.00", { karigarId: "k1", jewelleryJobId: "A" })];
    expect(() => replayMetalValues({ movements: over, receipts: [], targetMovementId: "open", targetNewCostValue: "12000.00" })).toThrow(ReplayError);
    const orphan = [mv("open", 0, "OPENING_IN", "10.000", "10.000", "10000.00"), mv("issue", 1, "KARIGAR_ISSUE_OUT", "1.000", "1.000", "1000.00")];
    expect(() => replayMetalValues({ movements: orphan, receipts: [], targetMovementId: "open", targetNewCostValue: "12000.00" })).toThrow(/no Karigar/);
  });
});
