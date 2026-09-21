import { describe, expect, it } from "vitest";

import {
  computeOutputMetal,
  fineWeightThousandths,
  formatThousandths,
  grossForFineThousandths,
  METAL_POOL_EFFECT,
  toThousandths,
} from "./metalMath";

const n = (value: number) => BigInt(value);

describe("toThousandths / formatThousandths", () => {
  it("parses plain, short and padded decimals exactly", () => {
    expect(toThousandths("12")).toBe(n(12000));
    expect(toThousandths("12.5")).toBe(n(12500));
    expect(toThousandths("0.001")).toBe(n(1));
    expect(toThousandths(" 99.900 ")).toBe(n(99900));
    expect(toThousandths(37.5)).toBe(n(37500));
  });

  it("rounds half-up beyond 3 decimal places, like Decimal ROUND_HALF_UP", () => {
    expect(toThousandths("1.0004999")).toBe(n(1000));
    expect(toThousandths("1.0005")).toBe(n(1001));
    expect(toThousandths("-1.0005")).toBe(n(-1001));
  });

  it("rejects non-numeric input", () => {
    expect(() => toThousandths("abc")).toThrow();
    expect(() => toThousandths("")).toThrow();
  });

  it("formats back to a fixed 3-decimal string", () => {
    expect(formatThousandths(n(9009))).toBe("9.009");
    expect(formatThousandths(n(3))).toBe("0.003");
    expect(formatThousandths(n(-2991))).toBe("-2.991");
  });
});

describe("fine / gross conversions", () => {
  it("computes fine weight from gross and fineness, half-up", () => {
    expect(formatThousandths(fineWeightThousandths(n(12000), n(75000)))).toBe("9.000");
    expect(formatThousandths(fineWeightThousandths(n(7001), n(58500)))).toBe("4.096"); // 4.0955850
  });

  it("computes the gross weight of a purity that holds a given fine weight", () => {
    expect(formatThousandths(grossForFineThousandths(n(9000), n(100000)))).toBe("9.000");
    expect(formatThousandths(grossForFineThousandths(n(9000), n(99900)))).toBe("9.009");
  });
});

describe("computeOutputMetal — cross-purity alloy", () => {
  it("locked example at 100% 24K: 12.000 g of 18K = 9.000 g fine + 3.000 g alloy", () => {
    const result = computeOutputMetal({ netWeight: "12", outputFinenessPercent: "75", sourceFinenessPercent: "100", samePurity: false });
    expect(formatThousandths(result.fine)).toBe("9.000");
    expect(formatThousandths(result.sourceGrossEquivalent)).toBe("9.000");
    expect(formatThousandths(result.alloyAdded)).toBe("3.000");
  });

  it("same example with the seeded 99.9% 24K: 9.009 g of 24K consumed, 2.991 g alloy", () => {
    const result = computeOutputMetal({ netWeight: "12", outputFinenessPercent: "75", sourceFinenessPercent: "99.9", samePurity: false });
    expect(formatThousandths(result.fine)).toBe("9.000");
    expect(formatThousandths(result.sourceGrossEquivalent)).toBe("9.009");
    expect(formatThousandths(result.alloyAdded)).toBe("2.991");
  });

  it("14K (58.5%) and 9K (37.5%) outputs from 24K", () => {
    const k14 = computeOutputMetal({ netWeight: "10", outputFinenessPercent: "58.5", sourceFinenessPercent: "99.9", samePurity: false });
    expect(formatThousandths(k14.fine)).toBe("5.850");
    expect(formatThousandths(k14.sourceGrossEquivalent)).toBe("5.856");
    expect(formatThousandths(k14.alloyAdded)).toBe("4.144");

    const k9 = computeOutputMetal({ netWeight: "8", outputFinenessPercent: "37.5", sourceFinenessPercent: "100", samePurity: false });
    expect(formatThousandths(k9.fine)).toBe("3.000");
    expect(formatThousandths(k9.alloyAdded)).toBe("5.000");
  });

  it("a same-purity output never reports alloy added (no round-trip rounding artefact)", () => {
    const result = computeOutputMetal({ netWeight: "7.001", outputFinenessPercent: "58.5", sourceFinenessPercent: "58.5", samePurity: true });
    expect(formatThousandths(result.fine)).toBe("4.096");
    expect(result.sourceGrossEquivalent).toBe(n(7001));
    expect(result.alloyAdded).toBe(n(0));
  });
});

describe("METAL_POOL_EFFECT", () => {
  it("never lets CONSUMED_OUT touch a stock pool", () => {
    expect(METAL_POOL_EFFECT.CONSUMED_OUT).toEqual({ usable: 0, scrap: 0 });
  });

  it("keeps scrap out of issuable stock", () => {
    expect(METAL_POOL_EFFECT.SCRAP_RETURN_IN).toEqual({ usable: 0, scrap: 1 });
    // Only the three scrap-side types touch the scrap pool, and none of them
    // touches issuable stock — a transfer moves value through its own paired
    // usable-side movement, never by making one movement do both.
    const SCRAP_TYPES = ["SCRAP_RETURN_IN", "SCRAP_ADJUSTMENT_IN", "SCRAP_ADJUSTMENT_OUT"];
    for (const [type, effect] of Object.entries(METAL_POOL_EFFECT)) {
      if (SCRAP_TYPES.includes(type)) expect(effect.usable).toBe(0);
      else expect(effect.scrap).toBe(0);
    }
    expect(METAL_POOL_EFFECT.SCRAP_ADJUSTMENT_IN).toEqual({ usable: 0, scrap: 1 });
    expect(METAL_POOL_EFFECT.SCRAP_ADJUSTMENT_OUT).toEqual({ usable: 0, scrap: -1 });
  });

  it("treats every other _IN as usable-in and every other _OUT as usable-out", () => {
    expect(METAL_POOL_EFFECT.PURCHASE_IN.usable).toBe(1);
    expect(METAL_POOL_EFFECT.RETURN_IN.usable).toBe(1);
    expect(METAL_POOL_EFFECT.ISSUE_CANCEL_IN.usable).toBe(1);
    expect(METAL_POOL_EFFECT.ISSUE_OUT.usable).toBe(-1);
    expect(METAL_POOL_EFFECT.ADJUSTMENT_OUT.usable).toBe(-1);
  });
});
