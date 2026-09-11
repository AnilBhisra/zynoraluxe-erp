import { describe, expect, it } from "vitest";

import { Decimal, isPositive, isZero, round2, toDecimal, ZERO } from "./money";

describe("Decimal precision", () => {
  it("never loses precision the way JavaScript floating point would", () => {
    // The classic float trap: 0.1 + 0.2 !== 0.3 in plain JS numbers.
    const sum = new Decimal("0.1").plus(new Decimal("0.2"));
    expect(sum.toFixed(2)).toBe("0.30");
    expect(sum.equals(new Decimal("0.3"))).toBe(true);
  });

  it("keeps exact precision across many additions (no drift)", () => {
    let total = new Decimal(0);
    for (let i = 0; i < 1000; i++) {
      total = total.plus(new Decimal("0.01"));
    }
    expect(total.toFixed(2)).toBe("10.00");
  });

  it("round2 rounds half-up to 2 decimal places", () => {
    expect(round2("1.005").toFixed(2)).toBe("1.01");
    expect(round2("1.004").toFixed(2)).toBe("1.00");
    expect(round2(2.5).toFixed(2)).toBe("2.50");
  });

  it("toDecimal accepts strings and numbers identically", () => {
    expect(toDecimal("42.50").equals(toDecimal(42.5))).toBe(true);
  });

  it("isPositive / isZero behave correctly at the boundary", () => {
    expect(isPositive(0.01)).toBe(true);
    expect(isPositive(0)).toBe(false);
    expect(isPositive(-0.01)).toBe(false);
    expect(isZero(0)).toBe(true);
    expect(isZero(ZERO)).toBe(true);
    expect(isZero(0.001)).toBe(false);
  });
});
