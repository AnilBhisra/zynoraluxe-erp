import { CorrectionApproval } from "@/components/corrections/CorrectionWorkbench";
import { EmptyState } from "@/components/ui/EmptyState";
import type { CorrectionHistoryRow } from "@/lib/corrections/history";

const MODE_LABELS: Record<string, string> = {
  EDIT_DRAFT: "Draft edited",
  REVERSE_REPOST: "Reversed and reposted",
  REVALUE: "Revalued",
};

const STATE_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  AWAITING_APPROVAL: "Waiting for Owner",
  POSTED: "Posted",
  REJECTED: "Closed",
  REVERSED: "Reversed",
};

const ENTITY_LABELS: Record<string, string> = {
  METAL_OPENING_STOCK: "Opening Metal Stock",
  METAL_PURCHASE: "Metal Purchase",
  METAL_ADJUSTMENT: "Metal Adjustment",
  VOUCHER: "Transaction",
  JEWELLERY_JOB: "Jewellery Job",
  JEWELLERY_RECEIPT: "Jewellery Receipt",
  FINISHED_JEWELLERY: "Finished Jewellery",
};

function money(value: string | null) {
  if (value === null) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return `₹${number.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function stateTone(state: string) {
  if (state === "POSTED") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200";
  if (state === "AWAITING_APPROVAL") return "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100";
  if (state === "REVERSED") return "bg-rose-100 text-rose-900 dark:bg-rose-900/50 dark:text-rose-100";
  return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
}

export function CorrectionHistoryView({ rows }: { rows: CorrectionHistoryRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No corrections yet"
        description="When a posted entry is corrected, the original entry, the corrected value, the reason and every affected record appear here. / સુધારો કર્યા પછી અહીં આખી વિગત દેખાશે."
      />
    );
  }

  return (
    <ul className="flex flex-col gap-4" data-testid="correction-history">
      {rows.map((row) => (
        <li
          key={row.id}
          data-testid={`correction-${row.correctionCode}`}
          className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm sm:p-5"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-mono text-sm font-medium text-zinc-900 dark:text-zinc-50">
                {row.correctionCode}
              </p>
              <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                {ENTITY_LABELS[row.entityType] ?? row.entityType} — {row.entityLabel}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${stateTone(row.state)}`}>
                {STATE_LABELS[row.state] ?? row.state}
              </span>
              <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {MODE_LABELS[row.mode] ?? row.mode}
              </span>
              {row.batchCode ? (
                <span
                  data-testid={`batch-${row.batchCode}-${row.batchStep}`}
                  className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-900 dark:bg-sky-900/50 dark:text-sky-100"
                >
                  {row.batchCode} · step {row.batchStep} of {row.batchRequiredSteps}
                  {row.batchState === "COMPLETE" ? " · complete" : " · in progress"}
                </span>
              ) : null}
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Original value</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-100">{money(row.originalValue)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Corrected value</dt>
              <dd className="font-medium text-zinc-900 dark:text-zinc-100">{money(row.correctedValue)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Posted</dt>
              <dd className="text-zinc-900 dark:text-zinc-100">{formatDate(row.postedAt)}</dd>
            </div>
            <div>
              <dt className="text-xs text-zinc-500 dark:text-zinc-400">Voucher</dt>
              <dd className="font-mono text-zinc-900 dark:text-zinc-100">
                {row.voucherNumber ?? "—"} {row.amount ? `· ${money(row.amount)}` : ""}
              </dd>
            </div>
          </dl>

          <p className="mt-4 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300">
            <span className="font-medium">Reason / કારણ:</span> {row.reason}
          </p>

          <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
            Prepared by {row.preparedBy}
            {row.approvedBy ? ` · Approved by ${row.approvedBy}` : " · not yet approved"}
            {row.rejectionReason ? ` · ${row.rejectionReason}` : ""}
          </p>

          {row.state === "AWAITING_APPROVAL" ? <CorrectionApproval correctionId={row.id} /> : null}

          {row.impacts.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                    <th className="pb-2 pr-3 font-medium">Affected record</th>
                    <th className="pb-2 pr-3 font-medium">Field</th>
                    <th className="pb-2 pr-3 font-medium">Before</th>
                    <th className="pb-2 font-medium">After</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {row.impacts.map((impact, index) => (
                    <tr key={`${row.id}-${index}`}>
                      <td className="py-2 pr-3 text-zinc-900 dark:text-zinc-100">{impact.recordLabel}</td>
                      <td className="py-2 pr-3 text-zinc-600 dark:text-zinc-400">{impact.field}</td>
                      <td className="py-2 pr-3 tabular-nums text-zinc-600 dark:text-zinc-400">{impact.oldValue}</td>
                      <td className="py-2 tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                        {impact.newValue}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
