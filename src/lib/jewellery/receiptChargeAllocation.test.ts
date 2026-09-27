import { describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import {
  allocateChargesToPieces,
  CHARGE_CATEGORIES,
  ChargeInputError,
  normaliseCharges,
  totalOf,
  zeroCharges,
} from "@/lib/jewellery/receiptChargeAllocation";

const fix = (o: Partial<Record<(typeof CHARGE_CATEGORIES)[number]["key"], string>>) => normaliseCharges(o);

describe("normaliseCharges", () => {
  it("keeps each category separate, to 2 decimals, blanks are zero", () => {
    const c = fix({ labourCharge: "1200", makingCharge: "350.50", settingCharge: "", plating: undefined } as never);
    expect(c.labourCharge.toFixed(2)).toBe("1200.00");
    expect(c.makingCharge.toFixed(2)).toBe("350.50");
    expect(c.settingCharge.toFixed(2)).toBe("0.00");
    expect(totalOf(c).toFixed(2)).toBe("1550.50");
  });
  it("refuses nothing-to-add, negatives, non-numbers and more than 2 decimals", () => {
    expect(() => normaliseCharges({})).toThrow(/at least one charge/);
    expect(() => normaliseCharges({ labourCharge: "0" })).toThrow(/at least one charge/);
    expect(() => normaliseCharges({ labourCharge: "-5" })).toThrow(/cannot be negative/);
    expect(() => normaliseCharges({ labourCharge: "abc" })).toThrow(/must be a number/);
    expect(() => normaliseCharges({ labourCharge: "10.005" })).toThrow(/at most 2 decimal/);
    expect(() => normaliseCharges({ labourCharge: "Infinity" })).toThrow(ChargeInputError);
  });
});

describe("allocateChargesToPieces", () => {
  it("one piece carries everything", () => {
    const shares = allocateChargesToPieces(fix({ labourCharge: "1000", settingCharge: "250.25" }), [
      { id: "a", finishedCode: "ZL-FJ-1", fineMetalWeight: "1.520" },
    ]);
    expect(shares).toHaveLength(1);
    expect(shares[0].total.toFixed(2)).toBe("1250.25");
    expect(shares[0].charges.labourCharge.toFixed(2)).toBe("1000.00");
    expect(shares[0].charges.settingCharge.toFixed(2)).toBe("250.25");
  });

  it("splits by fine weight and every category and the grand total reconcile to the paisa", () => {
    const charges = fix({ labourCharge: "100.01", makingCharge: "33.33", otherExpense: "0.07" });
    const pieces = [
      { id: "a", finishedCode: "ZL-FJ-1", fineMetalWeight: "1.111" },
      { id: "b", finishedCode: "ZL-FJ-2", fineMetalWeight: "2.222" },
      { id: "c", finishedCode: "ZL-FJ-3", fineMetalWeight: "3.333" },
    ];
    const shares = allocateChargesToPieces(charges, pieces);
    for (const c of CHARGE_CATEGORIES) {
      const sum = shares.reduce((s, x) => s.plus(x.charges[c.key]), new Decimal(0));
      expect(sum.toFixed(2)).toBe(charges[c.key].toFixed(2));
    }
    expect(shares.reduce((s, x) => s.plus(x.total), new Decimal(0)).toFixed(2)).toBe("133.41");
    // heavier pieces carry more
    expect(shares[2].total.greaterThan(shares[0].total)).toBe(true);
    // each piece's total is exactly the sum of its own categories
    for (const s of shares) expect(s.total.toFixed(2)).toBe(totalOf(s.charges).toFixed(2));
  });

  it("is the same split the receipt itself would make for a single total on one category", () => {
    // ₹100.00 over weights 1:2 -> 33.33 / 66.67 (remainder lands on the lighter piece, as at receipt time)
    const shares = allocateChargesToPieces(fix({ labourCharge: "100" }), [
      { id: "a", finishedCode: "ZL-FJ-1", fineMetalWeight: "1" },
      { id: "b", finishedCode: "ZL-FJ-2", fineMetalWeight: "2" },
    ]);
    expect(shares.map((s) => s.total.toFixed(2))).toEqual(["33.33", "66.67"]);
  });

  it("refuses when there is no piece, or the pieces carry no fine weight", () => {
    expect(() => allocateChargesToPieces(fix({ labourCharge: "10" }), [])).toThrow(/no finished piece/);
    expect(() => allocateChargesToPieces(fix({ labourCharge: "10" }), [{ id: "a", finishedCode: "X", fineMetalWeight: "0" }])).toThrow(/no fine metal weight/);
  });

  it("zeroCharges is all zero", () => {
    expect(totalOf(zeroCharges()).toFixed(2)).toBe("0.00");
  });
});
