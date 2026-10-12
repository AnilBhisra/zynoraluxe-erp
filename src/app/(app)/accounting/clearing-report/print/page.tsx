import type { Metadata } from "next";

import { requireOwner } from "@/lib/auth/dal";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { defaultCashBookDates } from "@/lib/accounting/cashBankBookFilters";
import { clearingReportQuery, parseClearingReportFilters } from "@/lib/accounting/clearingReportFilters";
import { getClearingReport, listClearingDocuments } from "@/lib/accounting/clearingReports";
import { formatRupees } from "@/lib/accounting/partyBalance";
import { CLEARING_REPORT_COLUMNS, docStatusLabel } from "@/components/accounting/ClearingReportView";
import { CustomerGoldPrintShell } from "@/components/jewellery/CustomerGoldPrint";

export const metadata: Metadata = { title: "Clearing Settlements · ZYNORALUXE" };
const money = (d: { toFixed: (n: number) => string }) => formatRupees(d.toFixed(2));

/** Printable Clearing Settlements report — the screen's filters, every row. Owner only. */
export default async function ClearingReportPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const filters = parseClearingReportFilters(await searchParams, defaultCashBookDates(await getCompanyFySettings()));
  const [rows, docs] = await Promise.all([getClearingReport(filters), listClearingDocuments({ ...filters, take: 5000 })]);
  return (
    <CustomerGoldPrintShell backHref={`/accounting?tab=settlements&view=report&${clearingReportQuery(filters)}`}>
      <h1 className="text-lg font-bold">Clearing Settlements</h1>
      <p className="text-sm">{filters.dateFrom} to {filters.dateTo} · INR</p>
      {rows.map((r) => (
        <table key={`${r.partyId}|${r.currencyCode}`} className="mt-3 w-full text-xs" data-testid="print-provider">
          <caption className="text-left text-sm font-semibold">{r.partyName} · {r.currencyCode}</caption>
          <tbody>
            {CLEARING_REPORT_COLUMNS.map((c) => (
              <tr key={c.key} className="border-b border-zinc-200"><td>{c.label}</td><td className="text-right">{money(r[c.key] as never)}</td></tr>
            ))}
          </tbody>
        </table>
      ))}
      <table className="mt-4 w-full text-[11px]" data-testid="print-docs">
        <thead><tr className="border-b text-left"><th>Date</th><th>Code</th><th>Provider</th><th>Cur.</th><th className="text-right">Settled</th><th className="text-right">Bank</th><th className="text-right">Deductions</th><th>Status</th></tr></thead>
        <tbody>
          {docs.map((d) => (
            <tr key={d.id} className="border-b border-zinc-200"><td>{d.date}</td><td>{d.voucherNumber}</td><td>{d.partyName}</td><td>{d.currencyCode}</td><td className="text-right">{d.availableFc.toFixed(2)}</td><td className="text-right">{money(d.receivedInr)}</td><td className="text-right">{money(d.deductionsInr)}</td><td>{docStatusLabel(d)}</td></tr>
          ))}
        </tbody>
      </table>
    </CustomerGoldPrintShell>
  );
}
