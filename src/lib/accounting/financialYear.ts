/**
 * Financial-year helpers. Company financial year start (month/day) lives in
 * CompanySettings and repeats every year (e.g. month=4, day=1 -> "1 April").
 *
 * All date arithmetic here uses UTC getters/constructors so a plain
 * "YYYY-MM-DD" form value always means the same calendar date regardless of
 * server timezone — Voucher.date is a calendar date, not a timestamp.
 */

/** Parses a "YYYY-MM-DD" string into a UTC-midnight Date. Throws on anything else. */
export function parseDateOnly(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${value}".`);
  }
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    throw new Error(`"${value}" is not a real calendar date.`);
  }
  return date;
}

export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Returns a label like "2026-27" for the financial year containing `date`. */
export function getFinancialYearLabel(
  date: Date,
  fyStartMonth: number,
  fyStartDay: number
): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  const isOnOrAfterStart = month > fyStartMonth || (month === fyStartMonth && day >= fyStartDay);
  const startYear = isOnOrAfterStart ? year : year - 1;
  const endYearShort = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYearShort}`;
}

/** [start, end] UTC-midnight Date bounds (inclusive) of the FY containing `date`. */
export function getFinancialYearBounds(
  date: Date,
  fyStartMonth: number,
  fyStartDay: number
): { start: Date; end: Date } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();

  const isOnOrAfterStart = month > fyStartMonth || (month === fyStartMonth && day >= fyStartDay);
  const startYear = isOnOrAfterStart ? year : year - 1;

  const start = new Date(Date.UTC(startYear, fyStartMonth - 1, fyStartDay));
  const end = new Date(
    Date.UTC(startYear + 1, fyStartMonth - 1, fyStartDay) - 24 * 60 * 60 * 1000
  );
  return { start, end };
}

export function isWithinFinancialYear(
  date: Date,
  fyStartMonth: number,
  fyStartDay: number,
  referenceDate: Date = new Date()
): boolean {
  const { start, end } = getFinancialYearBounds(referenceDate, fyStartMonth, fyStartDay);
  return date.getTime() >= start.getTime() && date.getTime() <= end.getTime();
}

/**
 * A voucher date outside the current financial year needs Owner
 * confirmation before it can be saved (master plan validation rule). Staff
 * can never override this; Owner can, but only by explicitly checking the
 * "confirm" box in the form — never silently.
 */
export function checkVoucherDateAllowed(
  date: Date,
  role: "OWNER" | "STAFF",
  confirmedOutsideFy: boolean,
  fyStartMonth: number,
  fyStartDay: number,
  referenceDate: Date = new Date()
): { ok: true } | { ok: false; message: string } {
  if (isWithinFinancialYear(date, fyStartMonth, fyStartDay, referenceDate)) {
    return { ok: true };
  }
  if (role === "STAFF") {
    return {
      ok: false,
      message: "This date is outside the current financial year. Ask the Owner to enter it.",
    };
  }
  if (!confirmedOutsideFy) {
    return {
      ok: false,
      message: "This date is outside the current financial year — confirm to continue.",
    };
  }
  return { ok: true };
}
