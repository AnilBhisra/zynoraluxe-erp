"use client";

import { useEffect, useState } from "react";

import { getPhase5VsPhase6ComparisonAction, type SerializedPhase5VsPhase6Comparison } from "@/app/actions/finishedSales";

function money(v: string | null) {
  if (v === null) return "—";
  return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_LABELS: Record<string, string> = {
  NOT_SOLD: "Not sold yet",
  SOLD_ACTIVE: "Sold (active)",
  SALE_CANCELLED: "Sale cancelled",
  RETURNED_SELLABLE: "Returned — sellable",
  RETURNED_DAMAGED: "Returned — damaged",
};

/** Owner-only. Fetches on mount via a Server Action gated by requireOwner()
 * — a Staff session gets a thrown redirect, never data, so there is
 * nothing for this component to accidentally render for Staff even if it
 * were mistakenly mounted. */
export function Phase5VsPhase6Comparison({ finishedJewelleryId }: { finishedJewelleryId: string }) {
  const [data, setData] = useState<SerializedPhase5VsPhase6Comparison | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getPhase5VsPhase6ComparisonAction(finishedJewelleryId).then((result) => {
      if (!cancelled) setData(result);
    });
    return () => {
      cancelled = true;
    };
  }, [finishedJewelleryId]);

  if (data === undefined) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">Loading comparison…</p>;
  }
  if (data === null) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">No finalized Costing is linked to this piece.</p>;
  }

  const hasRealized = data.realizedGrossProfit !== null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs">
      <p className="mb-2 font-medium text-zinc-800 dark:text-zinc-200">
        Phase 5 (Costing {data.costingNumber}) vs Phase 6 (actual) —{" "}
        <span className="font-normal text-zinc-500 dark:text-zinc-400">{STATUS_LABELS[data.realizedStatus] ?? data.realizedStatus}</span>
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
          <p className="mb-1 font-medium text-zinc-700 dark:text-zinc-300">Phase 5 — expected</p>
          <dl className="space-y-0.5">
            <div className="flex justify-between"><dt>Selling value</dt><dd>{money(data.expectedSellingValue)}</dd></div>
            <div className="flex justify-between"><dt>Full business cost</dt><dd>{money(data.expectedFullBusinessCost)}</dd></div>
            <div className="flex justify-between"><dt>Expected profit</dt><dd>{money(data.expectedProfit)}</dd></div>
            <div className="flex justify-between"><dt>Expected margin</dt><dd>{data.expectedMarginPercent}%</dd></div>
          </dl>
        </div>
        <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2">
          <p className="mb-1 font-medium text-zinc-700 dark:text-zinc-300">Phase 6 — actual</p>
          <dl className="space-y-0.5">
            <div className="flex justify-between"><dt>Net selling value</dt><dd>{money(data.realizedNetSellingValue)}</dd></div>
            <div className="flex justify-between"><dt>Accounting COGS</dt><dd>{money(data.realizedCogs ?? data.authoritativeAccountingCost)}</dd></div>
            <div className="flex justify-between"><dt>Realized gross profit</dt><dd>{money(data.realizedGrossProfit)}</dd></div>
            <div className="flex justify-between"><dt>Realized margin</dt><dd>{data.realizedMarginPercent ? `${data.realizedMarginPercent}%` : "—"}</dd></div>
          </dl>
        </div>
      </div>
      {hasRealized ? (
        <p className="mt-2 text-zinc-700 dark:text-zinc-300">
          Difference vs Phase 5 expected profit:{" "}
          <span className="font-semibold">{money(data.profitDifference)}</span>
        </p>
      ) : null}
      <p className="mt-2 text-zinc-600 dark:text-zinc-400">
        Accounting COGS (₹{data.authoritativeAccountingCost}) excludes ₹{data.otherMaterialCostExcluded} of
        display-only other-material cost that Phase 5&apos;s full business cost legitimately includes — that is
        why the two cost figures above differ.
      </p>
      <p className="mt-1 text-zinc-500 dark:text-zinc-500">{data.note}</p>
    </div>
  );
}
