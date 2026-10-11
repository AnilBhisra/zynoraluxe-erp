import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { PartyType, PaymentMethod, VoucherStatus, VoucherType } from "@/generated/prisma/enums";
import { CASH_BOOK_PAGE_SIZE, type CashBookFilters } from "@/lib/accounting/cashBankBookFilters";
import { Decimal, round2 } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";

/**
 * Cash & Bank Book — every journal line posted to a payment account's own
 * ledger account (Cash, Bank, UPI, archived ones too). Debit = money received
 * into the account (પૈસા આવ્યા), credit = money paid out of it (પૈસા ગયા).
 *
 * - The party is the VOUCHER's party (a reversal carries its original's), never
 *   read from line narration.
 * - Dates are India business dates: (voucher.date + 05:30)::date. Ordinary
 *   vouchers are date-only (UTC midnight → same day); old reversals stored a
 *   timestamp and land on the Indian day they were posted.
 * - Running balance = the selected account(s)' balance after this line over the
 *   WHOLE history, ordered (business date, created at, voucher number, line) —
 *   so a filtered page never restarts at ₹0 and same-day rows are stable.
 * - Summary cards are the account over the period, whatever the row filters:
 *   closing = opening (everything before From) + received − paid.
 * - A cancelled voucher and its REVERSAL are both real lines that sum to ₹0; the
 *   "hide reversals" option hides both, never just one.
 *
 * Two queries per page (rows, summary) plus the account list — independent of
 * the number of rows or parties.
 */

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "paymentAccount">;

export type CashBookAccount = { id: string; name: string; method: PaymentMethod; isActive: boolean };

export type CashBookRow = {
  lineId: string;
  voucherId: string;
  voucherNumber: string;
  voucherType: VoucherType;
  status: VoucherStatus;
  businessDate: string;
  createdAt: Date;
  paymentAccountId: string;
  paymentAccountName: string;
  partyId: string | null;
  partyName: string | null;
  partyType: PartyType | null;
  referenceNumber: string | null;
  note: string | null;
  received: Decimal;
  paid: Decimal;
  runningBalance: Decimal;
  /** For a REVERSAL: the voucher it reverses. */
  reversesId: string | null;
  reversesNumber: string | null;
  reversesType: VoucherType | null;
  /** For a CANCELLED voucher: its reversal. */
  reversedById: string | null;
  reversedByNumber: string | null;
};

export type CashBookSummary = {
  /** Everything posted to the selected account(s) before dateFrom. */
  opening: Decimal;
  periodReceived: Decimal;
  periodPaid: Decimal;
  netMovement: Decimal;
  /** opening + netMovement: the balance at the end of dateTo. */
  closing: Decimal;
  /** Every posted line, all dates: the balance right now. */
  live: Decimal;
  /** The rows the filters keep (equal to the period when no row filter is set). */
  shownCount: number;
  shownReceived: Decimal;
  shownPaid: Decimal;
};

export type CashBookPage = {
  accounts: CashBookAccount[];
  summary: CashBookSummary;
  rows: CashBookRow[];
  page: number;
  pageCount: number;
  pageSize: number;
};

const BUSINESS_DATE = Prisma.sql`((v.date + interval '330 minutes')::date)`;

function selectedAccounts(f: CashBookFilters) {
  return f.account === "ALL" ? Prisma.sql`true` : Prisma.sql`pa.id = ${f.account}`;
}

/** The row filters (dates included) as one SQL condition over the `lines` CTE. */
function rowCondition(f: CashBookFilters) {
  const c: Prisma.Sql[] = [Prisma.sql`bdate >= ${f.dateFrom}::date`, Prisma.sql`bdate <= ${f.dateTo}::date`];
  if (f.direction === "RECEIVED") c.push(Prisma.sql`debit > 0`);
  if (f.direction === "PAID") c.push(Prisma.sql`credit > 0`);
  if (f.partyId) c.push(Prisma.sql`party_id = ${f.partyId}`);
  if (f.partySearch) c.push(Prisma.sql`party_name ilike ${`%${f.partySearch}%`}`);
  if (f.partyType === "OTHER") c.push(Prisma.sql`(party_type is null or party_type = 'BROKER')`);
  else if (f.partyType) c.push(Prisma.sql`party_type = ${f.partyType}`);
  if (f.voucherType) c.push(Prisma.sql`voucher_type = ${f.voucherType}`);
  if (f.search) {
    const like = `%${f.search}%`;
    c.push(Prisma.sql`(voucher_number ilike ${like} or coalesce(reference_number, '') ilike ${like} or coalesce(note, '') ilike ${like} or coalesce(reverses_number, '') ilike ${like})`);
  }
  if (!f.includeReversals) c.push(Prisma.sql`voucher_type <> 'REVERSAL' and status <> 'CANCELLED'`);
  return Prisma.join(c, " and ");
}

function linesCte(f: CashBookFilters) {
  return Prisma.sql`
    lines as (
      select j.id line_id, v.id voucher_id, v."voucherNumber" voucher_number, v."voucherType"::text voucher_type, v.status::text status,
             ${BUSINESS_DATE} bdate, v."createdAt" created_at, v."referenceNumber" reference_number, v.note,
             pa.id pa_id, pa.name pa_name, p.id party_id, p.name party_name, p.type::text party_type,
             j.debit, j.credit,
             sum(j.debit - j.credit) over (order by ${BUSINESS_DATE}, v."createdAt", v."voucherNumber", j.id) running,
             o.id reverses_id, o."voucherNumber" reverses_number, o."voucherType"::text reverses_type,
             r.id reversed_by_id, r."voucherNumber" reversed_by_number
      from journal_entries j
      join payment_accounts pa on pa."accountId" = j."accountId" and ${selectedAccounts(f)}
      join vouchers v on v.id = j."voucherId"
      left join parties p on p.id = v."partyId"
      left join vouchers o on o.id = v."reversalOfVoucherId"
      left join vouchers r on r."reversalOfVoucherId" = v.id
    )`;
}

type RawRow = {
  line_id: string;
  voucher_id: string;
  voucher_number: string;
  voucher_type: VoucherType;
  status: VoucherStatus;
  bdate: Date;
  created_at: Date;
  reference_number: string | null;
  note: string | null;
  pa_id: string;
  pa_name: string;
  party_id: string | null;
  party_name: string | null;
  party_type: PartyType | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  running: Prisma.Decimal;
  reverses_id: string | null;
  reverses_number: string | null;
  reverses_type: VoucherType | null;
  reversed_by_id: string | null;
  reversed_by_number: string | null;
};

const toRow = (r: RawRow): CashBookRow => ({
  lineId: r.line_id,
  voucherId: r.voucher_id,
  voucherNumber: r.voucher_number,
  voucherType: r.voucher_type,
  status: r.status,
  businessDate: new Date(r.bdate).toISOString().slice(0, 10),
  createdAt: r.created_at,
  paymentAccountId: r.pa_id,
  paymentAccountName: r.pa_name,
  partyId: r.party_id,
  partyName: r.party_name,
  partyType: r.party_type,
  referenceNumber: r.reference_number,
  note: r.note,
  received: round2(new Decimal(r.debit)),
  paid: round2(new Decimal(r.credit)),
  runningBalance: round2(new Decimal(r.running)),
  reversesId: r.reverses_id,
  reversesNumber: r.reverses_number,
  reversesType: r.reverses_type,
  reversedById: r.reversed_by_id,
  reversedByNumber: r.reversed_by_number,
});

const dec = (v: Prisma.Decimal | null | undefined) => round2(new Decimal(v ?? 0));

export async function getCashBookAccounts(db: Db = prisma): Promise<CashBookAccount[]> {
  return db.paymentAccount.findMany({
    select: { id: true, name: true, method: true, isActive: true },
    orderBy: [{ isActive: "desc" }, { method: "asc" }, { name: "asc" }],
  });
}

export async function getCashBookSummary(f: CashBookFilters, db: Db = prisma): Promise<CashBookSummary> {
  const [s] = await db.$queryRaw<
    { opening: Prisma.Decimal; period_received: Prisma.Decimal; period_paid: Prisma.Decimal; live: Prisma.Decimal; shown_count: bigint; shown_received: Prisma.Decimal; shown_paid: Prisma.Decimal }[]
  >(Prisma.sql`
    with ${linesCte(f)}
    select coalesce(sum(debit - credit) filter (where bdate < ${f.dateFrom}::date), 0) opening,
           coalesce(sum(debit) filter (where bdate between ${f.dateFrom}::date and ${f.dateTo}::date), 0) period_received,
           coalesce(sum(credit) filter (where bdate between ${f.dateFrom}::date and ${f.dateTo}::date), 0) period_paid,
           coalesce(sum(debit - credit), 0) live,
           count(*) filter (where ${rowCondition(f)}) shown_count,
           coalesce(sum(debit) filter (where ${rowCondition(f)}), 0) shown_received,
           coalesce(sum(credit) filter (where ${rowCondition(f)}), 0) shown_paid
    from lines`);
  const opening = dec(s?.opening);
  const periodReceived = dec(s?.period_received);
  const periodPaid = dec(s?.period_paid);
  const netMovement = round2(periodReceived.minus(periodPaid));
  return {
    opening,
    periodReceived,
    periodPaid,
    netMovement,
    closing: round2(opening.plus(netMovement)),
    live: dec(s?.live),
    shownCount: Number(s?.shown_count ?? 0),
    shownReceived: dec(s?.shown_received),
    shownPaid: dec(s?.shown_paid),
  };
}

/** The filtered rows in book order; `limit` null = every row (print, CSV). */
export async function listCashBookRows(f: CashBookFilters, opts: { limit: number | null; offset?: number }, db: Db = prisma): Promise<CashBookRow[]> {
  const paging = opts.limit === null ? Prisma.empty : Prisma.sql`limit ${opts.limit} offset ${opts.offset ?? 0}`;
  const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`
    with ${linesCte(f)}
    select * from lines where ${rowCondition(f)}
    order by bdate, created_at, voucher_number, line_id
    ${paging}`);
  return rows.map(toRow);
}

export async function getCashBookPage(f: CashBookFilters, db: Db = prisma): Promise<CashBookPage> {
  const [accounts, summary] = await Promise.all([getCashBookAccounts(db), getCashBookSummary(f, db)]);
  const pageCount = Math.max(1, Math.ceil(summary.shownCount / CASH_BOOK_PAGE_SIZE));
  const page = Math.min(f.page, pageCount);
  const rows = await listCashBookRows(f, { limit: CASH_BOOK_PAGE_SIZE, offset: (page - 1) * CASH_BOOK_PAGE_SIZE }, db);
  return { accounts, summary, rows, page, pageCount, pageSize: CASH_BOOK_PAGE_SIZE };
}

/** One CSV cell: quoted when needed; text a spreadsheet would run as a formula is neutralised (numbers stay numbers). */
function csvCell(value: string): string {
  const isNumber = /^-?\d+(\.\d+)?$/.test(value);
  const safe = !isNumber && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) || safe !== value ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export const CASH_BOOK_CSV_HEADERS = [
  "Date",
  "Voucher",
  "Type",
  "Direction",
  "Party",
  "Party type",
  "Payment account",
  "Reference",
  "Note",
  "Money received",
  "Money paid",
  "Running balance",
  "Status",
  "Linked voucher",
] as const;

/** CSV of exactly the rows the screen filters keep (all pages). */
export function cashBookCsv(rows: CashBookRow[], typeLabel: (t: VoucherType) => string): string {
  const lines = [CASH_BOOK_CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.businessDate,
        r.voucherNumber,
        r.voucherType === "REVERSAL" && r.reversesType ? `Reversal of ${typeLabel(r.reversesType)}` : typeLabel(r.voucherType),
        r.received.greaterThan(0) ? "Received" : "Paid",
        r.partyName ?? "",
        r.partyType ?? "",
        r.paymentAccountName,
        r.referenceNumber ?? "",
        r.note ?? "",
        r.received.toFixed(2),
        r.paid.toFixed(2),
        r.runningBalance.toFixed(2),
        r.status,
        r.reversesNumber ? `reverses ${r.reversesNumber}` : r.reversedByNumber ? `reversed by ${r.reversedByNumber}` : "",
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}
