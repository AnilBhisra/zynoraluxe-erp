import {
  BILLING_LABELS,
  CUSTOMER_PIECE_FILTER_LABELS,
  CUSTOMER_PIECE_FILTERS,
  DELIVERY_LABELS,
  LOCATION_LABELS,
  OWNERSHIP_LABELS,
  type CustomerPieceFilter,
  type CustomerPieceRow,
  type CustomerPieceSummary,
} from "@/lib/jewellery/customerFinishedJewelleryRules";

type Gold = { purity: string; safe: string; withKarigar: string; onJobs: string; finishedAwaitingDelivery: string; remaining: string };

const jobHref = (jobId: string) => `/jewellery-jobs?tab=jobs&view=ALL&jobId=${jobId}`;

/**
 * Customer Account → Finished Jewellery (JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §11).
 * Weights, purity, codes, bill numbers and delivery state only — the same for
 * Owner and Staff; no cost or profit is ever passed in.
 */
export function CustomerFinishedJewelleryPanel({
  partyId,
  rows,
  total,
  summary,
  gold,
  filter,
}: {
  partyId: string;
  rows: CustomerPieceRow[];
  total: number;
  summary: CustomerPieceSummary;
  gold: Gold[];
  filter: CustomerPieceFilter;
}) {
  const href = (f: CustomerPieceFilter) => `/accounting?tab=ledger&partyId=${partyId}${f === "ALL" ? "" : `&fj=${f}`}#finished-jewellery`;
  return (
    <section id="finished-jewellery" className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5" data-testid="customer-finished-jewellery">
      <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">Finished Jewellery</h3>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4" data-testid="cfj-summary">
        {(
          [
            ["Ready / undelivered", summary.readyUndelivered],
            ["Unbilled", summary.unbilled],
            ["Billed, not delivered", summary.billedUndelivered],
            ["Delivered", summary.delivered],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-2">
            <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
            <dd className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{n}</dd>
          </div>
        ))}
      </dl>
      {gold.length ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[480px] text-xs" data-testid="cfj-gold">
            <thead className="text-left text-zinc-500">
              <tr className="[&>th]:px-2 [&>th]:py-1">
                <th>Customer gold (fine g)</th>
                <th className="text-right">Safe</th>
                <th className="text-right">With Karigar</th>
                <th className="text-right">On jobs</th>
                <th className="text-right">In finished pieces</th>
                <th className="text-right">Total held</th>
              </tr>
            </thead>
            <tbody>
              {gold.map((g) => (
                <tr key={g.purity} className="border-t border-[var(--border)] [&>td]:px-2 [&>td]:py-1">
                  <td>{g.purity}</td>
                  <td className="text-right">{g.safe}</td>
                  <td className="text-right">{g.withKarigar}</td>
                  <td className="text-right">{g.onJobs}</td>
                  <td className="text-right">{g.finishedAwaitingDelivery}</td>
                  <td className="text-right font-medium">{g.remaining}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <nav aria-label="Finished jewellery filter" className="mt-3 flex flex-wrap gap-1" data-testid="cfj-filters">
        {CUSTOMER_PIECE_FILTERS.map((f) => (
          <a
            key={f}
            href={href(f)}
            aria-current={filter === f ? "page" : undefined}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-medium ${filter === f ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900" : "border border-[var(--border)] text-zinc-600 dark:text-zinc-300"}`}
          >
            {CUSTOMER_PIECE_FILTER_LABELS[f]}
          </a>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-zinc-500" data-testid="cfj-empty">
          {total === 0 ? "No finished jewellery for this Customer yet." : "No pieces match this filter."}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]" data-testid="cfj-list">
          {rows.map((r) => (
            <li key={r.id} className="flex min-w-0 flex-col gap-1 p-3 text-xs" data-testid="cfj-row">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 break-words">
                  <a href={`/jewellery-jobs?tab=finished&finishedSearch=${encodeURIComponent(r.finishedCode)}`} className="font-semibold underline underline-offset-2" data-testid="cfj-code">
                    {r.finishedCode}
                  </a>{" "}
                  · {r.description}
                </p>
                {r.canCreateBill && r.location === "FINISHED_STOCK" ? (
                  <a href={jobHref(r.jobId)} className="inline-flex min-h-9 items-center rounded-lg border border-zinc-300 px-2.5 font-medium dark:border-zinc-600" data-testid="cfj-create-bill">
                    Create bill
                  </a>
                ) : null}
              </div>
              <p className="text-zinc-600 dark:text-zinc-400">
                Job{" "}
                <a href={jobHref(r.jobId)} className="underline">
                  {r.jobCode}
                </a>{" "}
                · Receipt{" "}
                <a href={jobHref(r.jobId)} className="underline">
                  {r.receiptCode}
                </a>{" "}
                · {r.purity} · {r.grossWeight ? `gross ${r.grossWeight} g · ` : ""}net {r.netWeight} g · fine {r.fineWeight} g{r.ownership !== "COMPANY" ? ` (Customer gold ${r.customerGoldFine} g)` : ""}
              </p>
              <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-700 dark:text-zinc-300">
                <span data-testid="cfj-ownership">{OWNERSHIP_LABELS[r.ownership]}</span>
                <span data-testid="cfj-billing">
                  {BILLING_LABELS[r.billing]}
                  {r.bill ? ` · ${r.bill.code} (${r.bill.date})` : ""}
                </span>
                <span data-testid="cfj-delivery">
                  {DELIVERY_LABELS[r.delivery]}
                  {r.deliveryRef ? ` · ${r.deliveryRef.code} (${r.deliveryRef.date})` : ""}
                </span>
                <span data-testid="cfj-location">{LOCATION_LABELS[r.location]}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
