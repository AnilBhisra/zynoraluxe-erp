import { describe, expect, it } from "vitest";

import {
  checkVoucherDateAllowed,
  formatDateOnly,
  getFinancialYearBounds,
  getFinancialYearLabel,
  isWithinFinancialYear,
  parseDateOnly,
} from "./financialYear";

describe("parseDateOnly / formatDateOnly", () => {
  it("round-trips a plain date string", () => {
    const date = parseDateOnly("2026-04-01");
    expect(formatDateOnly(date)).toBe("2026-04-01");
  });

  it("rejects a non-calendar date", () => {
    expect(() => parseDateOnly("2026-02-30")).toThrow();
  });

  it("rejects a malformed string", () => {
    expect(() => parseDateOnly("15/04/2026")).toThrow();
  });
});

describe("getFinancialYearLabel", () => {
  it("labels a date on/after the FY start in the same calendar year", () => {
    expect(getFinancialYearLabel(parseDateOnly("2026-04-01"), 4, 1)).toBe("2026-27");
    expect(getFinancialYearLabel(parseDateOnly("2027-03-31"), 4, 1)).toBe("2026-27");
  });

  it("labels a date before the FY start using the previous calendar year", () => {
    expect(getFinancialYearLabel(parseDateOnly("2026-01-15"), 4, 1)).toBe("2025-26");
  });
});

describe("getFinancialYearBounds / isWithinFinancialYear", () => {
  it("computes inclusive start/end bounds", () => {
    const { start, end } = getFinancialYearBounds(parseDateOnly("2026-06-15"), 4, 1);
    expect(formatDateOnly(start)).toBe("2026-04-01");
    expect(formatDateOnly(end)).toBe("2027-03-31");
  });

  it("reports true for a date inside the current FY, false for outside", () => {
    const reference = parseDateOnly("2026-06-15");
    expect(isWithinFinancialYear(parseDateOnly("2026-04-01"), 4, 1, reference)).toBe(true);
    expect(isWithinFinancialYear(parseDateOnly("2027-03-31"), 4, 1, reference)).toBe(true);
    expect(isWithinFinancialYear(parseDateOnly("2027-04-01"), 4, 1, reference)).toBe(false);
    expect(isWithinFinancialYear(parseDateOnly("2026-03-31"), 4, 1, reference)).toBe(false);
  });
});

describe("checkVoucherDateAllowed", () => {
  const reference = parseDateOnly("2026-06-15");

  it("allows an in-FY date for Staff and Owner alike", () => {
    expect(checkVoucherDateAllowed(reference, "STAFF", false, 4, 1, reference)).toEqual({
      ok: true,
    });
    expect(checkVoucherDateAllowed(reference, "OWNER", false, 4, 1, reference)).toEqual({
      ok: true,
    });
  });

  it("blocks Staff from an out-of-FY date even if they claim to confirm it", () => {
    const outside = parseDateOnly("2025-01-01");
    const result = checkVoucherDateAllowed(outside, "STAFF", true, 4, 1, reference);
    expect(result.ok).toBe(false);
  });

  it("blocks Owner from an out-of-FY date unless explicitly confirmed", () => {
    const outside = parseDateOnly("2025-01-01");
    expect(checkVoucherDateAllowed(outside, "OWNER", false, 4, 1, reference).ok).toBe(false);
    expect(checkVoucherDateAllowed(outside, "OWNER", true, 4, 1, reference).ok).toBe(true);
  });
});
