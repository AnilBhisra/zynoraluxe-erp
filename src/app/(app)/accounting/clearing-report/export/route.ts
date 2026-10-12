import { requireOwner } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { defaultCashBookDates } from "@/lib/accounting/cashBankBookFilters";
import { clearingReportCsv } from "@/lib/accounting/clearingCsv";
import { parseClearingReportFilters } from "@/lib/accounting/clearingReportFilters";
import { getClearingReport, listClearingDocuments } from "@/lib/accounting/clearingReports";

/** CSV of the Clearing Settlements report with exactly the screen's filters. Owner only — enforced here. */
export async function GET(request: Request) {
  await requireOwner();
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  const filters = parseClearingReportFilters(query, defaultCashBookDates(await getCompanyFySettings()));
  const [rows, docs] = await Promise.all([getClearingReport(filters), listClearingDocuments({ ...filters, take: 5000 })]);
  return new Response("\uFEFF" + clearingReportCsv(rows, docs), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="clearing-settlements_${filters.dateFrom}_${filters.dateTo}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
