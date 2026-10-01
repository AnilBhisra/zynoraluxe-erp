"use client";

import { useActionState, useState } from "react";

import { reverseMetalStockAdjustmentAction } from "@/app/actions/metal";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { HistoryCategory, MetalHistoryPage, MetalHistoryRow } from "@/lib/jewellery/adjustmentHistory";

/** Mirrors HISTORY_CATEGORY_LABEL on the server (that module is server-only). */
const CATEGORY_OPTIONS: { value: HistoryCategory; label: string }[] = [
  { value: "ALL", label: "Everything" },
  { value: "OPENING", label: "Opening stock" },
  { value: "PURCHASE", label: "Purchases" },
  { value: "KARIGAR", label: "Issue to / return from Karigar" },
  { value: "JOB_ALLOCATION", label: "Job allocations / releases" },
  { value: "JOB", label: "Job issue, return, scrap, used, transfer" },
  { value: "ADJUSTMENT", label: "Stock adjustments" },
  { value: "REVALUATION", label: "Revaluations (Owner corrections)" },
  { value: "REVERSAL", label: "Cancellations and reversals" },
];

export type MetalHistoryFilters = { category: HistoryCategory; search: string; purityId: string };

function effectText(row: MetalHistoryRow) {
  if (row.kind === "REVALUATION") return "value only";
  if (row.usableEffect === 1) return "+ stock";
  if (row.usableEffect === -1) return "− stock";
  if (row.scrapEffect === 1) return "+ scrap";
  if (row.scrapEffect === -1) return "− scrap";
  return "no stock change";
}

function historyHref(filters: MetalHistoryFilters, page: number) {
  const p = new URLSearchParams({ tab: "metal", history: "1", histPage: String(page) });
  if (filters.category !== "ALL") p.set("histCategory", filters.category);
  if (filters.search) p.set("histSearch", filters.search);
  if (filters.purityId) p.set("histPurity", filters.purityId);
  return `/jewellery-jobs?${p.toString()}#metal-history`;
}

function ReverseAdjustment({ row }: { row: MetalHistoryRow }) {
  const [state, formAction, pending] = useActionState(reverseMetalStockAdjustmentAction, undefined);
  const [reason, setReason] = useState("");
  return (
    <form action={formAction} className="mt-2 flex flex-wrap items-end gap-2">
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Adjustment reversed.</Alert> : null}
      <input type="hidden" name="movementId" value={row.id} />
      <input type="hidden" name="reason" value={reason} />
      <Field label="Reverse because" name={`reverseReason-${row.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button type="submit" variant="ghost" size="md" disabled={pending} data-testid={`reverse-adjustment-${row.id}`}>
        Reverse
      </Button>
    </form>
  );
}

/**
 * Read-only Metal Stock audit trail. Every row is an immutable movement or a
 * posted revaluation; a correction, reversal or batch is shown as a link to
 * the row or correction it belongs to — never by editing the original.
 * Staff rows arrive from the server with every ₹ figure already removed.
 */
export function MetalStockHistory({
  history,
  filters,
  purities,
  isOwner,
}: {
  history: MetalHistoryPage;
  filters: MetalHistoryFilters;
  purities: { id: string; displayName: string }[];
  isOwner: boolean;
}) {
  return (
    <section id="metal-history" data-testid="metal-history" className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Metal Stock history</h3>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Every entry is kept forever. A correction or reversal is a new entry linked to the original — nothing is edited. / દરેક entry કાયમ રહે છે; સુધારો નવી entry તરીકે જોડાય છે.
      </p>
      <form method="GET" action="/jewellery-jobs#metal-history" className="grid grid-cols-1 gap-2 sm:grid-cols-4" data-testid="metal-history-filters">
        <input type="hidden" name="tab" value="metal" />
        <input type="hidden" name="history" value="1" />
        <select
          aria-label="History type"
          name="histCategory"
          defaultValue={filters.category}
          className="h-11 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          {CATEGORY_OPTIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          aria-label="History purity"
          name="histPurity"
          defaultValue={filters.purityId}
          className="h-11 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <option value="">All purities</option>
          {purities.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="histSearch"
          aria-label="Search history"
          defaultValue={filters.search}
          placeholder={isOwner ? "Code, Karigar, job, voucher or correction…" : "Code, Karigar or job…"}
          className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Filter
        </button>
      </form>

      {history.rows.length === 0 ? (
        <p data-testid="metal-history-empty" className="text-sm text-zinc-600 dark:text-zinc-400">
          No matching entries.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {history.rows.map((row) => (
            <li
              key={row.id}
              id={`mh-${row.id}`}
              data-testid={`metal-history-row-${row.id}`}
              data-type={row.type}
              className="min-w-0 rounded-xl border border-[var(--border)] p-3 text-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-zinc-900 dark:text-zinc-100">{row.label}</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">{new Date(row.createdAt).toLocaleString("en-IN")}</span>
              </div>
              <p className="mt-1 break-words text-zinc-700 dark:text-zinc-300">
                {row.purityDisplayName} · {row.grossWeight}g gross / {row.fineWeight}g fine · {effectText(row)}
                {row.costValue !== null ? ` · ₹${row.costValue}` : ""}
                {row.voucherNumber ? ` · ${row.voucherNumber}` : ""}
              </p>
              {row.ratePerGrossGram !== null && Number(row.costValue) > 0 ? (
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400" data-testid={`metal-history-rates-${row.id}`}>
                  = ₹{row.ratePerGrossGram} per gross gram{row.ratePerFineGram !== null ? ` / ₹${row.ratePerFineGram} per fine gram` : ""}
                </p>
              ) : null}
              <p className="mt-1 break-words text-xs text-zinc-600 dark:text-zinc-400">
                {row.sourceDocument}
                {row.karigarName ? ` · Karigar ${row.karigarName}` : ""}
                {row.jobCode ? ` · ${row.jobCode}` : ""}
                {row.actorName ? ` · by ${row.actorName}` : ""}
              </p>
              {row.reversalOf ? (
                <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300" data-testid={`metal-history-reversal-of-${row.id}`}>
                  Reverses <a className="underline underline-offset-2" href={`#mh-${row.reversalOf.id}`}>{row.reversalOf.sourceDocument}</a>
                </p>
              ) : null}
              {row.reversedBy ? (
                <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300" data-testid={`metal-history-reversed-${row.id}`}>
                  Reversed later by <a className="underline underline-offset-2" href={`#mh-${row.reversedBy.id}`}>{row.reversedBy.sourceDocument}</a> — the original is kept for the audit trail.
                </p>
              ) : null}
              {row.transferPairId ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Part of one job-to-job transfer (both legs share {row.sourceDocument}).</p> : null}
              {row.revaluedMovementId ? (
                <p className="mt-1 text-xs text-sky-700 dark:text-sky-300">
                  Revalues <a className="underline underline-offset-2" href={`#mh-${row.revaluedMovementId}`}>this original entry</a>
                </p>
              ) : null}
              {row.corrections.map((c) => (
                <p key={c.correctionCode} className="mt-1 text-xs font-medium text-sky-700 dark:text-sky-300" data-testid={`metal-history-correction-${row.id}`}>
                  {row.kind === "REVALUATION" ? "Posted by" : "Revalued via"}{" "}
                  <a href="/corrections" className="underline underline-offset-2">{c.correctionCode}</a>
                  {c.batchCode ? ` (batch ${c.batchCode})` : ""} — {c.state.toLowerCase()}
                </p>
              ))}
              {isOwner && row.canReverse ? <ReverseAdjustment row={row} /> : null}
            </li>
          ))}
        </ol>
      )}
      <nav className="flex items-center gap-3 text-sm" aria-label="History pages">
        {history.page > 1 ? (
          <a className="underline underline-offset-2" href={historyHref(filters, history.page - 1)} data-testid="metal-history-prev">
            ← Newer
          </a>
        ) : null}
        <span className="text-xs text-zinc-500 dark:text-zinc-400">Page {history.page}</span>
        {history.hasNextPage ? (
          <a className="underline underline-offset-2" href={historyHref(filters, history.page + 1)} data-testid="metal-history-next">
            Older →
          </a>
        ) : null}
      </nav>
    </section>
  );
}
