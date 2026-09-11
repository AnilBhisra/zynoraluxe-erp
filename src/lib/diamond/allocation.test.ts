import { describe, expect, it } from "vitest";

import { allocateProportionally, round3 } from "./allocation";

describe("allocateProportionally", () => {
  it("splits an amount exactly by weight with no remainder", () => {
    const result = allocateProportionally(100, [
      { key: "a", weight: 1 },
      { key: "b", weight: 1 },
    ]);
    expect(result.find((r) => r.key === "a")!.amount.toNumber()).toBe(50);
    expect(result.find((r) => r.key === "b")!.amount.toNumber()).toBe(50);
  });

  it("allocates proportionally by carat and the shares sum EXACTLY to the total, even with rounding", () => {
    // 100 split across weights 1, 1, 1 -> 33.33 + 33.33 + 33.33 = 99.99,
    // the 0.01 remainder must land on exactly one deterministic piece.
    const result = allocateProportionally(100, [
      { key: "a", weight: 1 },
      { key: "b", weight: 1 },
      { key: "c", weight: 1 },
    ]);
    const total = result.reduce((sum, r) => sum.plus(r.amount), result[0].amount.minus(result[0].amount));
    expect(total.toFixed(2)).toBe("100.00");
    // Exactly one of the three shares differs from a plain third by the
    // rounding remainder; the other two are identical thirds.
    const amounts = result.map((r) => r.amount.toFixed(2)).sort();
    expect(amounts.filter((a) => a === "33.33")).toHaveLength(2);
  });

  it("assigns the whole remainder deterministically regardless of input order", () => {
    const inputOrderA = allocateProportionally(10, [
      { key: "x", weight: 3 },
      { key: "y", weight: 3 },
      { key: "z", weight: 3 },
    ]);
    const inputOrderB = allocateProportionally(10, [
      { key: "z", weight: 3 },
      { key: "x", weight: 3 },
      { key: "y", weight: 3 },
    ]);
    const byKeyA = new Map(inputOrderA.map((r) => [r.key, r.amount.toFixed(2)]));
    const byKeyB = new Map(inputOrderB.map((r) => [r.key, r.amount.toFixed(2)]));
    expect(byKeyA.get("x")).toBe(byKeyB.get("x"));
    expect(byKeyA.get("y")).toBe(byKeyB.get("y"));
    expect(byKeyA.get("z")).toBe(byKeyB.get("z"));
  });

  it("allocates proportionally by carat weight, not equally", () => {
    const result = allocateProportionally(300, [
      { key: "big", weight: 2 },
      { key: "small", weight: 1 },
    ]);
    expect(result.find((r) => r.key === "big")!.amount.toFixed(2)).toBe("200.00");
    expect(result.find((r) => r.key === "small")!.amount.toFixed(2)).toBe("100.00");
  });

  it("rejects a non-zero total across zero targets", () => {
    expect(() => allocateProportionally(100, [])).toThrow();
  });

  it("rejects allocation when every weight is zero", () => {
    expect(() =>
      allocateProportionally(100, [
        { key: "a", weight: 0 },
        { key: "b", weight: 0 },
      ])
    ).toThrow();
  });

  it("handles a single target by giving it the entire total", () => {
    const result = allocateProportionally(123.45, [{ key: "only", weight: 5 }]);
    expect(result[0].amount.toFixed(2)).toBe("123.45");
  });
});

describe("round3", () => {
  it("rounds to 3 decimal places using round-half-up", () => {
    expect(round3(1.2345).toFixed(3)).toBe("1.235");
    expect(round3("0.0004").toFixed(3)).toBe("0.000");
    expect(round3(2).toFixed(3)).toBe("2.000");
  });
});
