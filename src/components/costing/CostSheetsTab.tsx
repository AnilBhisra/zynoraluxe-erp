"use client";

import { useState } from "react";

import { exportCostSheetsCsvAction } from "@/app/actions/costing";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

export type SerializedCostSheetRow = {
  id: string;
  costingNumber: string;
  mode: "ACTUAL" | "ESTIMATE";
  status: "DRAFT" | "FINALIZED" | "ARCHIVED";
  costingDate: string;
  itemName: string;
  customerName: string | null;
  referenceNumber: string | null;
  revisionNumber: number;
  productionCost: string;
  customerTotal: string;
  estimatedProfit: string;
};

const STATUS_FILTERS = [
  { value: "ACTIVE", label: "Draft + Finalized" },
  { value: "DRAFT", label: "Draft" },
  { value: "FINALIZED", label: "Finalized" },
  { value: "ARCHIVED", label: "Archived" },
  { value: "ALL", label: "All" },
] as const;

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "FINALIZED"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      : status === "ARCHIVED"
        ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
        : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  const label = status === "FINALIZED" ? "Finalized" : status === "ARCHIVED" ? "Archived" : "Draft";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{label}</span>;
}

function money(value: string) {
  return `₹${Number(value).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CostSheetsTab({
  sheets,
  search,
  status,
  mode,
}: {
  sheets: SerializedCostSheetRow[];
  search: string;
  status: string;
  mode: string;
}) {
  const [exporting, setExporting] = useState(false);

  async function handleExportCsv() {
    setExporting(true);
    const formData = new FormData();
    formData.set("mode", mode);
    formData.set("search", search);
    const result = await exportCostSheetsCsvAction(formData);
    setExporting(false);
    if ("csv" in result) {
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `cost-sheets-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Cost sheets</h2>
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={handleExportCsv} disabled={exporting}>
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <a href="/costing?tab=new">
            <Button type="button">New Costing</Button>
          </a>
        </div>
      </div>

      <nav aria-label="Costing status" className="flex flex-wrap gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5">
        {STATUS_FILTERS.map((f) => (
          <a
            key={f.value}
            href={`/costing?tab=sheets&status=${f.value}&mode=${mode}`}
            aria-current={status === f.value ? "page" : undefined}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              status === f.value
                ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {f.label}
          </a>
        ))}
      </nav>

      <div className="flex flex-wrap gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5">
        {(["ALL", "ACTUAL", "ESTIMATE"] as const).map((m) => (
          <a
            key={m}
            href={`/costing?tab=sheets&status=${status}&mode=${m}`}
            aria-current={mode === m ? "page" : undefined}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              mode === m
                ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {m === "ALL" ? "All types" : m === "ACTUAL" ? "Actual" : "Estimate"}
          </a>
        ))}
      </div>

      <form method="GET" action="/costing" className="flex flex-wrap gap-2">
        <input type="hidden" name="tab" value="sheets" />
        <input type="hidden" name="status" value={status} />
        <input type="hidden" name="mode" value={mode} />
        <input
          type="text"
          name="search"
          defaultValue={search}
          placeholder="Search by costing number, item, customer or reference…"
          className="h-11 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Search
        </button>
      </form>

      {sheets.length === 0 ? (
        <EmptyState
          title="No cost sheets match"
          description="Create an Actual costing from a finished piece, or start a new Estimate."
        />
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
          {sheets.map((s) => (
            <li key={s.id} className="flex flex-col gap-2 bg-[var(--surface)] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">{s.costingNumber}</p>
                  <StatusPill status={s.status} />
                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                    {s.mode === "ACTUAL" ? "Actual" : "Estimate"}
                  </span>
                  {s.revisionNumber > 1 ? (
                    <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
                      Rev {s.revisionNumber}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {s.itemName}
                  {s.customerName ? ` · ${s.customerName}` : ""}
                  {s.referenceNumber ? ` · Ref ${s.referenceNumber}` : ""} · {new Date(s.costingDate).toLocaleDateString("en-IN")}
                </p>
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  Production cost {money(s.productionCost)} · Customer total {money(s.customerTotal)} · Profit {money(s.estimatedProfit)}
                </p>
              </div>
              <a
                href={`/costing?tab=sheets&sheetId=${s.id}`}
                className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
              >
                View costing
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
