import { EmptyState } from "@/components/ui/EmptyState";
import type { CashBookAccount, CashBookPage, CashBookRow } from "@/lib/accounting/cashBankBook";
import { cashBookQuery, hasRowFilters, type CashBookFilters } from "@/lib/accounting/cashBankBookFilters";
import { formatRupees } from "@/lib/accounting/partyBalance";
import { VOUCHER_TYPE_LABELS } from "@/lib/accounting/voucherTypeLabels";
import { partyTypeLabel } from "@/lib/parties/types";

const money = (d: { toFixed: (n: number) => string }) => formatRupees(d.toFixed(2));
const INPUT = "h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100";

export function accountLabel(a: CashBookAccount): string {
  return `${a.name} (${a.method === "CASH" ? "Cash" : a.method === "BANK" ? "Bank" : a.method === "UPI" ? "UPI" : "Other"})${a.isActive ? "" : " — archived"}`;
}

export function rowTypeLabel(r: CashBookRow): string {
  return r.voucherType === "REVERSAL" && r.reversesType ? `Reversal of ${VOUCHER_TYPE_LABELS[r.reversesType]}` : VOUCHER_TYPE_LABELS[r.voucherType];
}

function Card({ label, value, testId, hint }: { label: string; value: string; testId: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 break-words text-lg font-semibold text-zinc-900 dark:text-zinc-50" data-testid={testId}>
        {value}
      </p>
      {hint ? <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
    </div>
  );
}

function LinkedVoucher({ r }: { r: CashBookRow }) {
  if (r.reversesId) {
    return (
      <a className="underline" href={`/accounting/voucher/${r.reversesId}`} data-testid="book-reverses">
        reverses {r.reversesNumber}
      </a>
    );
  }
  if (r.reversedById) {
    return (
      <a className="underline" href={`/accounting/voucher/${r.reversedById}`} data-testid="book-reversed-by">
        reversed by {r.reversedByNumber}
      </a>
    );
  }
  return <span className="text-zinc-400">—</span>;
}

export function CashBankBookView({ filters, data }: { filters: CashBookFilters; data: CashBookPage }) {
  const { summary, rows, accounts } = data;
  const q = cashBookQuery(filters, { page: 1 });
  const rowFiltered = hasRowFilters(filters);
  const selected = accounts.find((a) => a.id === filters.account);
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="cash-bank-book">
      <form method="GET" action="/accounting" className="grid grid-cols-1 gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:grid-cols-2 lg:grid-cols-4">
        <input type="hidden" name="tab" value="cash-bank" />
        {filters.partyId ? <input type="hidden" name="partyId" value={filters.partyId} /> : null}
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Payment account
          <select name="account" defaultValue={filters.account} className={INPUT}>
            <option value="ALL">All accounts</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {accountLabel(a)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          From
          <input type="date" name="dateFrom" defaultValue={filters.dateFrom} className={INPUT} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          To
          <input type="date" name="dateTo" defaultValue={filters.dateTo} className={INPUT} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Direction
          <select name="direction" defaultValue={filters.direction} className={INPUT}>
            <option value="ALL">All</option>
            <option value="RECEIVED">પૈસા આવ્યા / Money received</option>
            <option value="PAID">પૈસા ગયા / Money paid</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Party
          <input type="text" name="party" defaultValue={filters.partySearch} placeholder="Name contains…" className={INPUT} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Party type
          <select name="partyType" defaultValue={filters.partyType} className={INPUT}>
            <option value="">All</option>
            <option value="CUSTOMER">Customer</option>
            <option value="SUPPLIER">Supplier</option>
            <option value="KARIGAR">Karigar</option>
            <option value="MANUFACTURER">Manufacturer</option>
            <option value="OTHER">Other (Dalal / no party)</option>
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Transaction type
          <select name="voucherType" defaultValue={filters.voucherType} className={INPUT}>
            <option value="">All</option>
            {Object.entries(VOUCHER_TYPE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Voucher / reference / note
          <input type="text" name="q" defaultValue={filters.search} className={INPUT} />
        </label>
        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400 sm:col-span-2">
          <input type="checkbox" name="reversals" value="hide" defaultChecked={!filters.includeReversals} className="h-4 w-4" />
          Hide cancelled entries and their reversals (each pair nets to ₹0)
        </label>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:justify-end">
          <button type="submit" className="h-10 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white dark:bg-amber-200 dark:text-zinc-900">
            Apply
          </button>
          <a href="/accounting?tab=cash-bank" className="flex h-10 items-center rounded-lg border border-zinc-300 px-4 text-sm dark:border-zinc-600">
            Reset
          </a>
          <a href={`/accounting/cash-bank-book/export?${q}`} className="flex h-10 items-center rounded-lg border border-zinc-300 px-4 text-sm dark:border-zinc-600" data-testid="book-csv">
            CSV
          </a>
          <a href={`/accounting/cash-bank-book/print?${q}`} className="flex h-10 items-center rounded-lg border border-zinc-300 px-4 text-sm dark:border-zinc-600" data-testid="book-print">
            Print
          </a>
        </div>
      </form>

      <section aria-label="Summary" className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Card label={`Opening balance (before ${filters.dateFrom})`} value={money(summary.opening)} testId="book-opening" />
        <Card label="પૈસા આવ્યા / Money received" value={money(summary.periodReceived)} testId="book-received" />
        <Card label="પૈસા ગયા / Money paid" value={money(summary.periodPaid)} testId="book-paid" />
        <Card label="Net movement" value={money(summary.netMovement)} testId="book-net" />
        <Card label={`Closing balance (end of ${filters.dateTo})`} value={money(summary.closing)} testId="book-closing" />
        <Card label="Live balance now" value={money(summary.live)} testId="book-live" hint={selected ? accountLabel(selected) : "All payment accounts"} />
      </section>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Cards cover {selected ? accountLabel(selected) : "every payment account together"} for the dates above, whatever the other filters. Running balance is that
        account&apos;s balance after each line, over its whole history — so it is correct on every page and with any filter. India dates.
        {rowFiltered ? (
          <span data-testid="book-shown-totals">
            {" "}
            Shown rows ({summary.shownCount}): received {money(summary.shownReceived)}, paid {money(summary.shownPaid)}.
          </span>
        ) : null}
      </p>

      {rows.length === 0 ? (
        <EmptyState title="No Cash / Bank entries match" description="Change the account, dates or filters." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-[var(--surface-muted)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Voucher</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Party</th>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2">Reference / note</th>
                <th className="px-3 py-2 text-right">Received</th>
                <th className="px-3 py-2 text-right">Paid</th>
                <th className="px-3 py-2 text-right">Balance</th>
                <th className="px-3 py-2">Status / link</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
              {rows.map((r) => (
                <tr key={r.lineId} data-testid="book-row" className={r.status === "CANCELLED" || r.voucherType === "REVERSAL" ? "text-zinc-500" : ""}>
                  <td className="whitespace-nowrap px-3 py-2">{r.businessDate}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <a className="underline" href={`/accounting/voucher/${r.voucherId}`}>
                      {r.voucherNumber}
                    </a>
                  </td>
                  <td className="px-3 py-2">
                    {rowTypeLabel(r)}
                    <span className={`ml-1 rounded-full px-1.5 text-[11px] ${r.received.greaterThan(0) ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"}`}>
                      {r.received.greaterThan(0) ? "Received" : "Paid"}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.partyId ? (
                      <a className="underline" href={`/accounting?tab=ledger&partyId=${r.partyId}`}>
                        {r.partyName}
                      </a>
                    ) : (
                      "—"
                    )}
                    {r.partyType ? <span className="block text-[11px] text-zinc-500">{partyTypeLabel(r.partyType)}</span> : null}
                  </td>
                  <td className="px-3 py-2">{r.paymentAccountName}</td>
                  <td className="max-w-[220px] break-words px-3 py-2 text-xs">
                    {r.referenceNumber ?? ""}
                    {r.referenceNumber && r.note ? " · " : ""}
                    {r.note ?? ""}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{r.received.greaterThan(0) ? money(r.received) : ""}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right">{r.paid.greaterThan(0) ? money(r.paid) : ""}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium" data-testid="book-running">
                    {money(r.runningBalance)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className="block">{r.status === "CANCELLED" ? "Cancelled" : r.voucherType === "REVERSAL" ? "Reversal" : "Posted"}</span>
                    <LinkedVoucher r={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.pageCount > 1 ? (
        <nav aria-label="Pages" className="flex flex-wrap items-center gap-2 text-sm" data-testid="book-pages">
          {data.page > 1 ? (
            <a className="rounded-lg border border-[var(--border)] px-3 py-1.5" href={`/accounting?tab=cash-bank&${cashBookQuery(filters, { page: data.page - 1 })}`}>
              ← Earlier
            </a>
          ) : null}
          <span>
            Page {data.page} of {data.pageCount}
          </span>
          {data.page < data.pageCount ? (
            <a className="rounded-lg border border-[var(--border)] px-3 py-1.5" href={`/accounting?tab=cash-bank&${cashBookQuery(filters, { page: data.page + 1 })}`}>
              Later →
            </a>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
