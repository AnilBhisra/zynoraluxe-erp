/**
 * The Cash & Bank Book's filters, parsed from a URL query in ONE place, so the
 * screen, its print view and its CSV export always apply exactly the same
 * filters. No database access (also used by tests and links).
 */
import type { VoucherType } from "@/generated/prisma/enums";
import { formatDateOnly, getFinancialYearBounds, indiaBusinessDate, parseDateOnly } from "@/lib/accounting/financialYear";
import { VOUCHER_TYPE_LABELS } from "@/lib/accounting/voucherTypeLabels";

export const CASH_BOOK_PAGE_SIZE = 50;

/** Default period: the current financial year up to today (India dates). */
export function defaultCashBookDates(fy: { fyStartMonth: number; fyStartDay: number }, now: Date = new Date()) {
  const today = indiaBusinessDate(now);
  return { dateFrom: formatDateOnly(getFinancialYearBounds(today, fy.fyStartMonth, fy.fyStartDay).start), dateTo: formatDateOnly(today) };
}

export type CashBookDirection = "ALL" | "RECEIVED" | "PAID";
/** OTHER = Dalal/Broker, or an entry with no party (e.g. an expense). */
export type CashBookPartyType = "CUSTOMER" | "SUPPLIER" | "KARIGAR" | "MANUFACTURER" | "OTHER";

export type CashBookFilters = {
  /** "ALL" or one payment account id (archived accounts included). */
  account: string;
  /** India business dates, "YYYY-MM-DD", inclusive. */
  dateFrom: string;
  dateTo: string;
  direction: CashBookDirection;
  partyId: string;
  partySearch: string;
  partyType: CashBookPartyType | "";
  voucherType: VoucherType | "";
  /** Voucher number, bill/reference number or note. */
  search: string;
  /** Show cancelled originals and their reversals (they net to ₹0 together). */
  includeReversals: boolean;
  page: number;
};

const DIRECTIONS: CashBookDirection[] = ["ALL", "RECEIVED", "PAID"];
const PARTY_TYPES: CashBookPartyType[] = ["CUSTOMER", "SUPPLIER", "KARIGAR", "MANUFACTURER", "OTHER"];

type Query = Record<string, string | string[] | undefined>;
const one = (q: Query, k: string): string => {
  const v = q[k];
  return (Array.isArray(v) ? v[0] : v ?? "").trim();
};
const validDate = (v: string): string | null => {
  try {
    parseDateOnly(v);
    return v;
  } catch {
    return null;
  }
};

/** Unknown or malformed values fall back to the defaults instead of failing. */
export function parseCashBookFilters(q: Query, defaults: { dateFrom: string; dateTo: string }): CashBookFilters {
  const direction = one(q, "direction").toUpperCase() as CashBookDirection;
  const partyType = one(q, "partyType").toUpperCase() as CashBookPartyType;
  const voucherType = one(q, "voucherType").toUpperCase() as VoucherType;
  let dateFrom = validDate(one(q, "dateFrom")) ?? defaults.dateFrom;
  let dateTo = validDate(one(q, "dateTo")) ?? defaults.dateTo;
  if (dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  const page = Number.parseInt(one(q, "page"), 10);
  return {
    account: one(q, "account") || "ALL",
    dateFrom,
    dateTo,
    direction: DIRECTIONS.includes(direction) ? direction : "ALL",
    partyId: one(q, "partyId"),
    partySearch: one(q, "party").slice(0, 100),
    partyType: PARTY_TYPES.includes(partyType) ? partyType : "",
    voucherType: voucherType in VOUCHER_TYPE_LABELS ? voucherType : "",
    search: one(q, "q").slice(0, 100),
    includeReversals: one(q, "reversals") !== "hide",
    page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** The query string for these filters (optionally overriding some), for links, print and CSV. */
export function cashBookQuery(f: CashBookFilters, override: Partial<CashBookFilters> = {}): string {
  const m = { ...f, ...override };
  const p = new URLSearchParams();
  if (m.account !== "ALL") p.set("account", m.account);
  p.set("dateFrom", m.dateFrom);
  p.set("dateTo", m.dateTo);
  if (m.direction !== "ALL") p.set("direction", m.direction);
  if (m.partyId) p.set("partyId", m.partyId);
  if (m.partySearch) p.set("party", m.partySearch);
  if (m.partyType) p.set("partyType", m.partyType);
  if (m.voucherType) p.set("voucherType", m.voucherType);
  if (m.search) p.set("q", m.search);
  if (!m.includeReversals) p.set("reversals", "hide");
  if (m.page > 1) p.set("page", String(m.page));
  return p.toString();
}

/** True when anything narrows the rows beyond account + dates (the summary cards are always the whole account). */
export function hasRowFilters(f: CashBookFilters): boolean {
  return f.direction !== "ALL" || !!f.partyId || !!f.partySearch || !!f.partyType || !!f.voucherType || !!f.search || !f.includeReversals;
}
