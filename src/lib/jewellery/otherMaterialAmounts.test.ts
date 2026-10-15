import { describe, expect, it } from "vitest";

import { Decimal, round2 } from "@/lib/accounting/money";
import { purchaseLineAmounts, sumMoney } from "@/lib/jewellery/otherMaterialAmounts";

const ok = (l: Parameters<typeof purchaseLineAmounts>[0]) => {
  const r = purchaseLineAmounts(l);
  if (!r.ok) throw new Error(r.error);
  return r.amounts;
};

describe("Other Material purchase amounts (exact, no floating point)", () => {
  it("200 CT × ₹50/CT = ₹10,000.00 — and the formula says so", () => {
    const a = ok({ quantity: "200", unit: "CT", rate: "50" });
    expect(a.baseAmount).toBe("10000.00");
    expect(a.lineTotal).toBe("10000.00");
    expect(a.formula).toBe("200 CT × ₹50.00/CT = ₹10,000.00");
  });

  it("GRAM and PCS, decimal quantities and rates, half-up to the paisa", () => {
    expect(ok({ quantity: "12.345", unit: "GRAM", rate: "99.9999" }).baseAmount).toBe("1234.50"); // 1234.4987655 → 1234.50
    expect(ok({ quantity: "3", unit: "PCS", rate: "0.335" }).baseAmount).toBe("1.01"); // 1.005 → 1.01 (half-up, exact)
    expect(ok({ quantity: "0.1", unit: "CT", rate: "0.2" }).baseAmount).toBe("0.02");
    expect(ok({ quantity: "1.005", unit: "PCS", rate: "1000" }).formula).toBe("1.005 PCS × ₹1,000.00/PCS = ₹1,005.00");
  });

  it("discount, exclusive and inclusive GST", () => {
    expect(ok({ quantity: "10", unit: "PCS", rate: "100", discount: "50", gstRatePercent: "3" })).toMatchObject({ baseAmount: "1000.00", taxableValue: "950.00", taxAmount: "28.50", lineTotal: "978.50" });
    expect(ok({ quantity: "1", unit: "PCS", rate: "1180", gstRatePercent: "18", taxType: "INCLUSIVE" })).toMatchObject({ taxableValue: "1000.00", taxAmount: "180.00", lineTotal: "1180.00" });
    expect(ok({ quantity: "1", unit: "PCS", rate: "100", gstRatePercent: "3", taxType: "INCLUSIVE" })).toMatchObject({ taxableValue: "97.09", taxAmount: "2.91", lineTotal: "100.00" });
  });

  it("refuses blank, zero, negative, NaN, excessive precision and a discount above the base", () => {
    for (const bad of [
      { quantity: "", unit: "CT" as const, rate: "50" },
      { quantity: "0", unit: "CT" as const, rate: "50" },
      { quantity: "-1", unit: "CT" as const, rate: "50" },
      { quantity: "abc", unit: "CT" as const, rate: "50" },
      { quantity: "1.0001", unit: "CT" as const, rate: "50" },
      { quantity: "1", unit: "CT" as const, rate: "0" },
      { quantity: "1", unit: "CT" as const, rate: "1.00001" },
      { quantity: "1", unit: "CT" as const, rate: "10", discount: "10.01" },
      { quantity: "1", unit: "CT" as const, rate: "10", gstRatePercent: "101" },
    ]) {
      expect(purchaseLineAmounts(bad).ok).toBe(false);
    }
  });

  it("matches Prisma Decimal on many random lines (browser = server)", () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    for (let i = 0; i < 500; i++) {
      const q = `${rnd(500)}.${String(rnd(1000)).padStart(3, "0")}`;
      const r = `${rnd(20000)}.${String(rnd(10000)).padStart(4, "0")}`;
      if (new Decimal(q).isZero() || new Decimal(r).isZero()) continue;
      const g = ["0", "3", "5", "12", "18", "28"][rnd(6)];
      const a = ok({ quantity: q, unit: "GRAM", rate: r, gstRatePercent: g });
      const base = round2(new Decimal(q).times(r));
      expect(a.baseAmount).toBe(base.toFixed(2));
      expect(a.taxAmount).toBe(round2(base.times(g).dividedBy(100)).toFixed(2));
    }
  });

  it("sums exactly", () => {
    expect(sumMoney(["0.10", "0.20", "1000.05"])).toBe("1000.35");
  });
});
