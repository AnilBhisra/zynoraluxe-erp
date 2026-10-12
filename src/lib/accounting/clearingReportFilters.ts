/**
 * Clearing Settlements report filters, parsed in ONE place for the screen,
 * its CSV and its print view. No database access.
 */
import { parseDateOnly } from "@/lib/accounting/financialYear";

export type ClearingReportFilters = {
  /** "" = every provider. */
  partyId: string;
  /** "" = every currency. */
  currencyCode: string;
  /** India business dates, inclusive. */
  dateFrom: string;
  dateTo: string;
};

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, k: string) => {
  const v = q[k];
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
};
const validDate = (v: string) => {
  try {
    parseDateOnly(v);
    return v;
  } catch {
    return null;
  }
};

export function parseClearingReportFilters(q: Query, defaults: { dateFrom: string; dateTo: string }): ClearingReportFilters {
  let dateFrom = validDate(one(q, "dateFrom")) ?? defaults.dateFrom;
  let dateTo = validDate(one(q, "dateTo")) ?? defaults.dateTo;
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  const cur = one(q, "currency").toUpperCase();
  return { partyId: one(q, "provider"), currencyCode: /^[A-Z]{3}$/.test(cur) ? cur : "", dateFrom, dateTo };
}

export function clearingReportQuery(f: ClearingReportFilters): string {
  const p = new URLSearchParams();
  if (f.partyId) p.set("provider", f.partyId);
  if (f.currencyCode) p.set("currency", f.currencyCode);
  p.set("dateFrom", f.dateFrom);
  p.set("dateTo", f.dateTo);
  return p.toString();
}
