import { describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { fineWeightOf, ratePerGram, sameMoney, summariseRate, totalFromRate } from "./metalRates";

/** The server's own formulas (posting.ts), for parity. */
const serverFine = (gross: string, fineness: string) => new Decimal(gross).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).times(fineness).dividedBy(100).toDecimalPlaces(3, Decimal.ROUND_HALF_UP).toFixed(3);
const serverTotal = (rate: string, weight: string) => new Decimal(rate).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).times(weight).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

describe("metal rate arithmetic — exact, half-up, identical to the server", () => {
  it("fine weight = gross × fineness / 100 to 3 dp", () => {
    expect(fineWeightOf("10", "91.700")).toBe("9.170");
    expect(fineWeightOf("44.091", "60")).toBe("26.455"); // 26.4546 → 26.455
    expect(fineWeightOf("1.001", "99.95")).toBe("1.000"); // 1.0004995 → 1.000
    expect(fineWeightOf("0.0005", "100")).toBe("0.001"); // gross itself rounds half-up to 3 dp first
    expect(fineWeightOf("abc", "91.7")).toBeNull();
    expect(fineWeightOf("-1", "91.7")).toBeNull();
  });

  it("gross-rate and fine-rate totals differ and each rounds to the paisa", () => {
    expect(totalFromRate({ basis: "PER_GROSS_GRAM", rate: "6543.21", grossWeight: "100", fineWeight: "91.700" })).toBe("654321.00");
    expect(totalFromRate({ basis: "PER_FINE_GRAM", rate: "6543.21", grossWeight: "100", fineWeight: "91.700" })).toBe("600012.36"); // 600012.357
    expect(totalFromRate({ basis: "FIXED_TOTAL", rate: "1234.5", grossWeight: "100", fineWeight: "91.7" })).toBe("1234.50");
    expect(totalFromRate({ basis: "PER_GROSS_GRAM", rate: "0.005", grossWeight: "1", fineWeight: "1" })).toBe("0.01"); // half-up, not banker's
    expect(totalFromRate({ basis: "PER_GROSS_GRAM", rate: "0.0049", grossWeight: "1", fineWeight: "1" })).toBe("0.00");
  });

  it("matches the server's Decimal formulas across awkward values", () => {
    const cases: [string, string, string][] = [
      ["6000.005", "10.001", "91.700"],
      ["7123.45678", "10", "99.900"],
      ["1", "0.001", "75"],
      ["99999.9999", "123.456", "58.500"],
      ["6543.21", "44.091", "60.000"],
    ];
    for (const [rate, gross, fineness] of cases) {
      const fine = fineWeightOf(gross, fineness)!;
      expect(fine).toBe(serverFine(gross, fineness));
      expect(totalFromRate({ basis: "PER_GROSS_GRAM", rate, grossWeight: gross, fineWeight: fine })).toBe(serverTotal(rate, gross));
      expect(totalFromRate({ basis: "PER_FINE_GRAM", rate, grossWeight: gross, fineWeight: fine })).toBe(serverTotal(rate, fine));
    }
  });

  it("effective rates per gross and per fine gram, 4 dp half-up; none for 0% fine metal", () => {
    expect(ratePerGram("50000.00", "10.000")).toBe("5000.0000");
    expect(ratePerGram("50000.00", "9.170")).toBe("5452.5627"); // 5452.56270447…
    expect(ratePerGram("1.00", "3.000")).toBe("0.3333");
    expect(ratePerGram("2.00", "3.000")).toBe("0.6667");
    expect(ratePerGram("10.00", "0.000")).toBeNull();
    const s = summariseRate({ basis: "PER_FINE_GRAM", grossWeight: "100", finenessPercent: "91.7", total: "600012.36" })!;
    expect(s).toEqual({
      basis: "PER_FINE_GRAM",
      basisLabel: "Per fine gram",
      grossWeight: "100.000",
      finenessPercent: "91.700",
      fineWeight: "91.700",
      total: "600012.36",
      perGrossGram: "6000.1236",
      perFineGram: "6543.2100",
    });
    expect(summariseRate({ basis: "PER_GROSS_GRAM", grossWeight: "5", finenessPercent: "0", total: "100" })!.perFineGram).toBeNull();
    expect(summariseRate({ basis: "PER_GROSS_GRAM", grossWeight: "0", finenessPercent: "91.7", total: "100" })).toBeNull();
    expect(sameMoney("10", "10.00")).toBe(true);
    expect(sameMoney("10.001", "10.00")).toBe(true); // both are ₹10.00 at 2 dp
    expect(sameMoney("10.01", "10.00")).toBe(false);
  });
});
