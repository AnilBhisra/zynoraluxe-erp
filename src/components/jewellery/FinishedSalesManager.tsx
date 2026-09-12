"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  cancelFinishedJewellerySaleAction,
  returnFinishedJewelleryItemsAction,
} from "@/app/actions/finishedSales";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";

export type SerializedFinishedSaleLine = {
  id: string;
  finishedCode: string;
  itemDescription: string;
  taxableValue: string;
  taxAmount: string;
  lineTotal: string;
  returnStatus: string;
};

export type SerializedFinishedSale = {
  id: string;
  saleCode: string;
  saleDate: string;
  customerName: string;
  status: string;
  grandTotal: string;
  lines: SerializedFinishedSaleLine[];
};

function CancelSaleForm({ saleId, onDone }: { saleId: string; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(cancelFinishedJewellerySaleAction, undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);

  if (!open) {
    return (
      <button type="button" className="text-xs font-medium text-red-600 underline dark:text-red-400" onClick={() => setOpen(true)}>
        Cancel sale
      </button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm("Cancel this entire sale? This reverses revenue, GST and COGS, and returns eligible items to Available.")) {
          e.preventDefault();
        }
      }}
      className="mt-2 flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30"
    >
      <input type="hidden" name="saleId" value={saleId} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field label="Cancellation reason" name="cancellationReason" required />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="md" disabled={pending}>
          {pending ? "Cancelling…" : "Confirm cancellation"}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}

function ReturnLineButtons({
  saleId,
  lineId,
  finishedCode,
  onDone,
}: {
  saleId: string;
  lineId: string;
  finishedCode: string;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(returnFinishedJewelleryItemsAction, undefined);
  const [disposition, setDisposition] = useState<"SELLABLE" | "DAMAGED" | null>(null);

  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);

  if (!disposition) {
    return (
      <div className="flex gap-2">
        <button type="button" className="text-xs font-medium text-amber-700 underline dark:text-amber-300" onClick={() => setDisposition("SELLABLE")}>
          Return (Sellable)
        </button>
        <button type="button" className="text-xs font-medium text-red-600 underline dark:text-red-400" onClick={() => setDisposition("DAMAGED")}>
          Return (Damaged)
        </button>
      </div>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm(`Return ${finishedCode} as ${disposition === "SELLABLE" ? "sellable (back to Available)" : "damaged (not for resale)"}?`)) {
          e.preventDefault();
        }
      }}
      className="mt-1 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950/30"
    >
      <input type="hidden" name="saleId" value={saleId} />
      <input type="hidden" name="returnDate" value={new Date().toISOString().slice(0, 10)} />
      <input type="hidden" name="itemsJson" value={JSON.stringify([{ saleLineId: lineId, disposition }])} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field label="Reason" name="reason" required />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="md" disabled={pending}>
          {pending ? "Saving…" : `Confirm ${disposition === "SELLABLE" ? "sellable" : "damaged"} return`}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setDisposition(null)}>
          Back
        </Button>
      </div>
    </form>
  );
}

/** Owner-only Finished Jewellery Sale management — cancellation and
 * item-level return. Never rendered for Staff; the page-level fetch this
 * relies on is itself Owner-gated (see jewellery-jobs/page.tsx). */
export function FinishedSalesManager({ sales, search }: { sales: SerializedFinishedSale[]; search: string }) {
  const router = useRouter();
  function handleDone() {
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Finished Jewellery Sales — cancel / return</h3>
      <form method="GET" action="/jewellery-jobs" className="flex flex-wrap gap-2">
        <input type="hidden" name="tab" value="finished" />
        <input
          type="text"
          name="saleSearch"
          defaultValue={search}
          placeholder="Search sales by code or customer…"
          className="h-10 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <button type="submit" className="h-10 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300">
          Search
        </button>
      </form>
      {sales.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No Finished Jewellery Sales yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {sales.map((sale) => {
            const anyReturned = sale.lines.some((l) => l.returnStatus !== "NONE");
            return (
              <div key={sale.id} data-testid={`finished-sale-${sale.saleCode}`} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-medium text-zinc-900 dark:text-zinc-50">{sale.saleCode}</span>{" "}
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {new Date(sale.saleDate).toLocaleDateString("en-IN")} · {sale.customerName} · ₹{sale.grandTotal}
                    </span>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      sale.status === "CANCELLED"
                        ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400"
                        : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
                    }`}
                  >
                    {sale.status}
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-2">
                  {sale.lines.map((line) => (
                    <li key={line.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {line.finishedCode} — {line.itemDescription} — ₹{line.lineTotal}
                        </span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{line.returnStatus}</span>
                      </div>
                      {sale.status === "POSTED" && line.returnStatus === "NONE" ? (
                        <div className="mt-1">
                          <ReturnLineButtons saleId={sale.id} lineId={line.id} finishedCode={line.finishedCode} onDone={handleDone} />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
                {sale.status === "POSTED" && !anyReturned ? (
                  <div className="mt-2">
                    <CancelSaleForm saleId={sale.id} onDone={handleDone} />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
