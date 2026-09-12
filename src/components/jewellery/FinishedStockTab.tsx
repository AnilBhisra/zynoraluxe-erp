"use client";

import { useRouter } from "next/navigation";
import { Fragment, useActionState, useEffect, useState } from "react";

import { adjustFinishedJewelleryStockAction } from "@/app/actions/finishedSales";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { CsvDownloadButton } from "@/components/accounting/CsvDownloadButton";
import { Phase5VsPhase6Comparison } from "@/components/jewellery/Phase5VsPhase6Comparison";
import { jewelleryTypeLabel } from "@/lib/jewellery/types";

export type SerializedFinishedStockRow = {
  id: string;
  finishedCode: string;
  jobCode: string;
  designName: string;
  karigarName: string;
  jewelleryType: string;
  metalType: string;
  purityDisplayName: string;
  netMetalWeight: string;
  fineMetalWeight: string;
  grossWeight: string | null;
  diamondCount: number;
  totalCarat: string;
  status: "AVAILABLE" | "SOLD" | "RETURNED_DAMAGED";
  producedAt: string;
  photoUrl: string | null;
  saleCode: string | null;
  saleDate: string | null;
  // Owner-only — present only when the page fetched this row for an Owner.
  inventoryCost?: string;
  costSheetNumber?: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Available",
  SOLD: "Sold",
  RETURNED_DAMAGED: "Returned — Damaged",
};

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "AVAILABLE"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      : status === "SOLD"
        ? "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        : "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{STATUS_LABELS[status] ?? status}</span>;
}

function AdjustStockForm({ itemId, onDone }: { itemId: string; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(adjustFinishedJewelleryStockAction, undefined);

  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm("Save this authorized stock adjustment? This directly changes Finished Stock and cannot be undone.")) {
          e.preventDefault();
        }
      }}
      className="mt-2 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30"
    >
      <input type="hidden" name="finishedJewelleryId" value={itemId} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <select
        name="direction"
        aria-label="Adjustment direction"
        defaultValue="OUT"
        className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
      >
        <option value="OUT">Remove from Available (e.g. lost, sent out)</option>
        <option value="IN">Return to Available</option>
      </select>
      <Field label="Reason (required, at least 5 characters)" name="reason" required />
      <Button type="submit" variant="danger" size="md" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Save adjustment"}
      </Button>
    </form>
  );
}

export function FinishedStockTab({
  items,
  isOwner,
  search,
  status,
}: {
  items: SerializedFinishedStockRow[];
  isOwner: boolean;
  search: string;
  status: string;
}) {
  const router = useRouter();
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const [comparingId, setComparingId] = useState<string | null>(null);

  const availableCount = items.filter((i) => i.status === "AVAILABLE").length;
  const availableFineWeight = items
    .filter((i) => i.status === "AVAILABLE")
    .reduce((sum, i) => sum + Number(i.fineMetalWeight), 0);

  const csvHeaders = [
    "Stock #",
    "Jewellery",
    "Type",
    "Source Job",
    "Metal",
    "Purity",
    "Net Wt (g)",
    "Fine Wt (g)",
    "Diamonds",
    "Total Carat",
    "Status",
    "Produced",
    "Sale Ref",
    ...(isOwner ? ["Inventory Cost", "Costing Ref"] : []),
  ];
  const csvRows = items.map((i) => [
    i.finishedCode,
    i.designName,
    jewelleryTypeLabel(i.jewelleryType),
    i.jobCode,
    i.metalType,
    i.purityDisplayName,
    i.netMetalWeight,
    i.fineMetalWeight,
    i.diamondCount,
    i.totalCarat,
    STATUS_LABELS[i.status] ?? i.status,
    new Date(i.producedAt).toLocaleDateString("en-IN"),
    i.saleCode ?? "",
    ...(isOwner ? [i.inventoryCost ?? "", i.costSheetNumber ?? ""] : []),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Available pieces</p>
          <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{availableCount}</p>
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Available fine weight</p>
          <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{availableFineWeight.toFixed(3)}g</p>
        </div>
      </div>

      <form method="GET" action="/jewellery-jobs" className="flex flex-wrap gap-2">
        <input type="hidden" name="tab" value="finished" />
        <input
          type="text"
          name="finishedSearch"
          defaultValue={search}
          placeholder="Search by stock #, job, or design…"
          className="h-11 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <select
          name="finishedStatus"
          defaultValue={status}
          className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <option value="">All statuses</option>
          <option value="AVAILABLE">Available</option>
          <option value="SOLD">Sold</option>
          <option value="RETURNED_DAMAGED">Returned — Damaged</option>
        </select>
        <button
          type="submit"
          className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Search
        </button>
        <CsvDownloadButton filename="finished-stock.csv" headers={csvHeaders} rows={csvRows} />
      </form>

      {items.length === 0 ? (
        <EmptyState title="No finished jewellery yet" description="Pieces appear here as soon as they're received from a Jewellery Job." />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl border border-[var(--border)] sm:block">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-[var(--surface-muted)] text-left text-xs text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Stock #</th>
                  <th className="px-3 py-2">Jewellery</th>
                  <th className="px-3 py-2">Source job</th>
                  <th className="px-3 py-2">Metal · Purity</th>
                  <th className="px-3 py-2">Weight</th>
                  <th className="px-3 py-2">Diamonds</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Produced</th>
                  <th className="px-3 py-2">Sale ref</th>
                  {isOwner ? <th className="px-3 py-2">Inventory cost</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {items.map((i) => (
                  <Fragment key={i.id}>
                  <tr>
                    <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">
                      <div className="flex items-center gap-2">
                        {i.photoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={i.photoUrl} alt="" className="h-8 w-8 rounded object-cover" />
                        ) : null}
                        {i.finishedCode}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {jewelleryTypeLabel(i.jewelleryType)} — {i.designName}
                    </td>
                    <td className="px-3 py-2">{i.jobCode}</td>
                    <td className="px-3 py-2">
                      {i.metalType} · {i.purityDisplayName}
                    </td>
                    <td className="px-3 py-2">
                      {i.netMetalWeight}g / {i.fineMetalWeight}g fine
                      {i.diamondCount > 0 ? ` · ${i.totalCarat}ct` : ""}
                    </td>
                    <td className="px-3 py-2">{i.diamondCount}</td>
                    <td className="px-3 py-2">
                      <StatusPill status={i.status} />
                    </td>
                    <td className="px-3 py-2">{new Date(i.producedAt).toLocaleDateString("en-IN")}</td>
                    <td className="px-3 py-2">{i.saleCode ?? "—"}</td>
                    {isOwner ? (
                      <td className="px-3 py-2">
                        ₹{i.inventoryCost}
                        {i.costSheetNumber ? (
                          <span className="block text-xs text-zinc-500 dark:text-zinc-400">{i.costSheetNumber}</span>
                        ) : null}
                        <div className="mt-1 flex flex-col items-start gap-0.5">
                          {i.status === "AVAILABLE" ? (
                            <button
                              type="button"
                              className="text-xs text-amber-700 underline dark:text-amber-300"
                              onClick={() => setAdjustingId(adjustingId === i.id ? null : i.id)}
                            >
                              Adjust
                            </button>
                          ) : null}
                          {i.costSheetNumber ? (
                            <button
                              type="button"
                              className="text-xs text-amber-700 underline dark:text-amber-300"
                              onClick={() => setComparingId(comparingId === i.id ? null : i.id)}
                            >
                              Compare vs Costing
                            </button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                  {isOwner && comparingId === i.id ? (
                    <tr>
                      <td colSpan={10} className="px-3 py-2">
                        <Phase5VsPhase6Comparison finishedJewelleryId={i.id} />
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 sm:hidden">
            {items.map((i) => (
              <div key={i.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {i.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={i.photoUrl} alt="" className="h-10 w-10 rounded object-cover" />
                    ) : null}
                    <div>
                      <p className="font-medium text-zinc-900 dark:text-zinc-50">{i.finishedCode}</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400">
                        {jewelleryTypeLabel(i.jewelleryType)} — {i.designName}
                      </p>
                    </div>
                  </div>
                  <StatusPill status={i.status} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                  <div>
                    <dt className="text-zinc-400 dark:text-zinc-500">Source job</dt>
                    <dd>{i.jobCode}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400 dark:text-zinc-500">Metal · Purity</dt>
                    <dd>
                      {i.metalType} · {i.purityDisplayName}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400 dark:text-zinc-500">Weight</dt>
                    <dd>
                      {i.netMetalWeight}g / {i.fineMetalWeight}g fine
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400 dark:text-zinc-500">Diamonds</dt>
                    <dd>
                      {i.diamondCount}
                      {i.diamondCount > 0 ? ` (${i.totalCarat}ct)` : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400 dark:text-zinc-500">Produced</dt>
                    <dd>{new Date(i.producedAt).toLocaleDateString("en-IN")}</dd>
                  </div>
                  <div>
                    <dt className="text-zinc-400 dark:text-zinc-500">Sale ref</dt>
                    <dd>{i.saleCode ?? "—"}</dd>
                  </div>
                  {isOwner ? (
                    <div>
                      <dt className="text-zinc-400 dark:text-zinc-500">Inventory cost</dt>
                      <dd>₹{i.inventoryCost}</dd>
                    </div>
                  ) : null}
                  {isOwner && i.costSheetNumber ? (
                    <div>
                      <dt className="text-zinc-400 dark:text-zinc-500">Costing</dt>
                      <dd>{i.costSheetNumber}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="mt-2 flex flex-wrap gap-3">
                  {isOwner && i.status === "AVAILABLE" ? (
                    <button
                      type="button"
                      className="text-xs text-amber-700 underline dark:text-amber-300"
                      onClick={() => setAdjustingId(adjustingId === i.id ? null : i.id)}
                    >
                      Adjust stock
                    </button>
                  ) : null}
                  {isOwner && i.costSheetNumber ? (
                    <button
                      type="button"
                      className="text-xs text-amber-700 underline dark:text-amber-300"
                      onClick={() => setComparingId(comparingId === i.id ? null : i.id)}
                    >
                      Compare vs Costing
                    </button>
                  ) : null}
                </div>
                {adjustingId === i.id ? (
                  <AdjustStockForm
                    itemId={i.id}
                    onDone={() => {
                      setAdjustingId(null);
                      router.refresh();
                    }}
                  />
                ) : null}
                {isOwner && comparingId === i.id ? (
                  <div className="mt-2">
                    <Phase5VsPhase6Comparison finishedJewelleryId={i.id} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {isOwner
            ? items
                .filter((i) => i.status === "AVAILABLE" && adjustingId === i.id)
                .map((i) => (
                  <div key={`adjust-desktop-${i.id}`} className="hidden sm:block">
                    <AdjustStockForm
                      itemId={i.id}
                      onDone={() => {
                        setAdjustingId(null);
                        router.refresh();
                      }}
                    />
                  </div>
                ))
            : null}
        </>
      )}
    </div>
  );
}
