import type { ClearingDocumentRow, ClearingReportRow } from "@/lib/accounting/clearingReports";
import { clearingReportQuery, type ClearingReportFilters } from "@/lib/accounting/clearingReportFilters";
import { formatRupees } from "@/lib/accounting/partyBalance";

const money = (d: { toFixed: (n: number) => string }) => formatRupees(d.toFixed(2));
const INPUT = "h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100";

export const CLEARING_REPORT_COLUMNS: { key: keyof ClearingReportRow; label: string }[] = [
  { key: "openingInr", label: "Opening clearing" },
  { key: "grossSalesInr", label: "Gross sales posted" },
  { key: "returnsInr", label: "Returns" },
  { key: "reclassifiedInr", label: "Receipts reclassified" },
  { key: "grossUpInr", label: "Sale gross-ups" },
  { key: "payoutsInr", label: "Bank / Cash payouts" },
  { key: "feesInr", label: "Fees / commission / shipping" },
  { key: "marketingInr", label: "Marketing / ads" },
  { key: "refundsInr", label: "Refunds" },
  { key: "taxesInr", label: "Withholding / taxes" },
  { key: "reserveNetInr", label: "Reserve moved (net)" },
  { key: "fxInr", label: "FX gain (+) / loss (−)" },
  { key: "otherInr", label: "Other adjustments" },
  { key: "closingInr", label: "Closing clearing" },
];

export function docStatusLabel(d: ClearingDocumentRow): string {
  if (d.status === "REVERSED") return "Reversed";
  if (d.kind === "SETTLEMENT") return d.allocatedFc.isZero() ? "Unallocated pooled settlement" : "Partly allocated";
  if (d.kind === "RECLASSIFY") return `Reclassified ${d.sourceVoucherNumber ?? ""}`;
  if (d.kind === "GROSS_UP") return `Gross-up ${d.sourceVoucherNumber ?? ""}`;
  return d.kind === "RESERVE_HOLD" ? "Reserve hold" : "Reserve release";
}

export function ClearingReportView({
  filters,
  rows,
  docs,
  providers,
}: {
  filters: ClearingReportFilters;
  rows: ClearingReportRow[];
  docs: ClearingDocumentRow[];
  providers: { id: string; name: string }[];
}) {
  const q = clearingReportQuery(filters);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="clearing-report">
      <form method="GET" action="/accounting" className="grid grid-cols-1 gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:grid-cols-2 lg:grid-cols-5">
        <input type="hidden" name="tab" value="settlements" />
        <input type="hidden" name="view" value="report" />
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600">
          Provider
          <select name="provider" defaultValue={filters.partyId} className={INPUT}>
            <option value="">All</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600">
          Currency
          <input name="currency" defaultValue={filters.currencyCode} placeholder="All" className={INPUT} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600">
          From
          <input type="date" name="dateFrom" defaultValue={filters.dateFrom} className={INPUT} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600">
          To
          <input type="date" name="dateTo" defaultValue={filters.dateTo} className={INPUT} />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <button type="submit" className="h-10 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-amber-200 dark:text-zinc-900">Apply</button>
          <a href={`/accounting/clearing-report/export?${q}`} className="flex h-10 items-center rounded-lg border border-zinc-300 px-3 text-sm" data-testid="clearing-csv">CSV</a>
          <a href={`/accounting/clearing-report/print?${q}`} className="flex h-10 items-center rounded-lg border border-zinc-300 px-3 text-sm" data-testid="clearing-print">Print</a>
        </div>
      </form>
      <p className="text-xs text-zinc-500">
        INR. Opening and closing are the provider&apos;s clearing ledger (1150 available + 1160 reserve). A reversal inside the period cancels its settlement. &ldquo;Unallocated&rdquo; is settled money not yet tied to any order — the
        balance is party-level; no order is marked paid without an explicit allocation.
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-zinc-500">No clearing activity for these filters.</p>
      ) : (
        rows.map((r) => (
          <section key={`${r.partyId}|${r.currencyCode}`} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3" data-testid="clearing-report-row">
            <h3 className="text-sm font-semibold">
              <a className="underline" href={`/accounting?tab=settlements&provider=${r.partyId}`}>{r.partyName}</a> · {r.currencyCode}
            </h3>
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-0.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
              {CLEARING_REPORT_COLUMNS.map((c) => (
                <div key={c.key} className="flex justify-between gap-2">
                  <dt>{c.label}</dt>
                  <dd className="font-medium" data-testid={`clearing-${c.key}`}>{money(r[c.key] as never)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-2"><dt>Unallocated settled ({r.currencyCode})</dt><dd className="font-medium">{r.unallocatedFc.toFixed(2)}</dd></div>
              <div className="flex justify-between gap-2"><dt>Closing in {r.currencyCode}</dt><dd className="font-medium">{r.closingFc.toFixed(2)}</dd></div>
              <div className="flex justify-between gap-2"><dt>of which reserve</dt><dd className="font-medium">{money(r.closingReserveInr)}</dd></div>
            </dl>
          </section>
        ))
      )}
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[900px] text-xs" data-testid="clearing-docs">
          <thead className="bg-[var(--surface-muted)] text-left text-zinc-500">
            <tr>
              <th className="px-2 py-2">Date</th><th className="px-2 py-2">Code</th><th className="px-2 py-2">Provider</th><th className="px-2 py-2">Reference</th><th className="px-2 py-2">Cur.</th>
              <th className="px-2 py-2 text-right">Settled (fc)</th><th className="px-2 py-2 text-right">INR value</th><th className="px-2 py-2 text-right">Bank</th><th className="px-2 py-2 text-right">Deductions</th>
              <th className="px-2 py-2 text-right">Remaining</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Links</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {docs.map((d) => (
              <tr key={d.id}>
                <td className="px-2 py-1.5">{d.date}</td>
                <td className="px-2 py-1.5"><a className="underline" href={`/accounting/voucher/${d.voucherId}`}>{d.voucherNumber}</a></td>
                <td className="px-2 py-1.5">{d.partyName}</td>
                <td className="px-2 py-1.5">{d.reference ?? ""}</td>
                <td className="px-2 py-1.5">{d.currencyCode}</td>
                <td className="px-2 py-1.5 text-right">{d.availableFc.toFixed(2)}</td>
                <td className="px-2 py-1.5 text-right">{money(d.availableInr)}</td>
                <td className="px-2 py-1.5 text-right">{money(d.receivedInr)}</td>
                <td className="px-2 py-1.5 text-right">{money(d.deductionsInr)}</td>
                <td className="px-2 py-1.5 text-right">{d.availableAfterFc.toFixed(2)}</td>
                <td className="px-2 py-1.5">{docStatusLabel(d)}{d.reversalVoucherNumber ? <> · <a className="underline" href={`/accounting/voucher/${d.reversalVoucherId}`}>{d.reversalVoucherNumber}</a></> : null}</td>
                <td className="px-2 py-1.5">
                  <a className="underline" href={`/accounting?tab=cash-bank&partyId=${d.partyId}`}>Cash &amp; Bank</a>
                  {d.allocations.length ? <> · {d.allocations.filter((a) => a.status === "ACTIVE").map((a) => <a key={a.id} className="underline" href={`/accounting/voucher/${a.saleVoucherId}`}> {a.saleVoucherNumber}</a>)}</> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
