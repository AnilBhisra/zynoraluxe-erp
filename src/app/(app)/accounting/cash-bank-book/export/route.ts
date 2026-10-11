import { requireOwner } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { cashBookCsv, listCashBookRows } from "@/lib/accounting/cashBankBook";
import { defaultCashBookDates, parseCashBookFilters } from "@/lib/accounting/cashBankBookFilters";
import { VOUCHER_TYPE_LABELS } from "@/lib/accounting/voucherTypeLabels";

/** CSV of the Cash & Bank Book with exactly the screen's filters (every page). Owner only — enforced here, not by hiding a button. */
export async function GET(request: Request) {
  await requireOwner();
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  const filters = parseCashBookFilters(query, defaultCashBookDates(await getCompanyFySettings()));
  const rows = await listCashBookRows(filters, { limit: null });
  const csv = "﻿" + cashBookCsv(rows, (t) => VOUCHER_TYPE_LABELS[t]);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cash-bank-book_${filters.dateFrom}_${filters.dateTo}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
