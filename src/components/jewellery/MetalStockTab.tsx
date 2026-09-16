"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";

import { createOpeningMetalStock, adjustMetalStockAction } from "@/app/actions/metal";
import { MetalPurchaseForm } from "@/components/jewellery/MetalPurchaseForm";
import type { MetalPurityOption } from "@/components/jewellery/ReceiveFinishedForm";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PartyOption } from "@/components/accounting/PartySelect";
import { metalTypeLabel } from "@/lib/jewellery/types";

/** Usable stock (issuable, valued in Metal Inventory) and recoverable scrap
 * (never issuable, valued in Scrap Metal Inventory) per metal + purity.
 * Cost figures are Owner-only and arrive as null for Staff. */
export type SerializedMetalStockBucket = {
  metalType: string;
  purityId: string;
  purityDisplayName: string;
  grossWeight: string;
  fineWeight: string;
  costValue: string | null;
  scrapGrossWeight: string;
  scrapFineWeight: string;
  scrapCostValue: string | null;
};

export type SerializedMetalPurchase = {
  id: string;
  purchaseCode: string;
  purchaseDate: string;
  supplierName: string;
  metalType: string;
  purityDisplayName: string;
  grossWeight: string;
  fineWeight: string;
  totalPurchaseCost: string | null;
};

function OpeningMetalStockForm({ purities, onDone }: { purities: MetalPurityOption[]; onDone?: () => void }) {
  const [state, formAction, pending] = useActionState(createOpeningMetalStock, undefined);
  const [metalType, setMetalType] = useState(purities[0]?.metalType ?? "GOLD");
  const [purityId, setPurityId] = useState(purities[0]?.id ?? "");
  const purityOptions = purities.filter((p) => p.metalType === metalType);

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Opening stock recorded.</Alert> : null}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Owner only — records existing metal stock as a starting balance (not a purchase).
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <select
          aria-label="Metal"
          value={metalType}
          onChange={(e) => {
            setMetalType(e.target.value);
            setPurityId(purities.find((p) => p.metalType === e.target.value)?.id ?? "");
          }}
          className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          {[...new Set(purities.map((p) => p.metalType))].map((mt) => (
            <option key={mt} value={mt}>
              {metalTypeLabel(mt)}
            </option>
          ))}
        </select>
        <select
          aria-label="Purity"
          value={purityId}
          onChange={(e) => setPurityId(e.target.value)}
          className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          {purityOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </div>
      <input type="hidden" name="metalType" value={metalType} />
      <input type="hidden" name="purityId" value={purityId} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Gross weight (g)" name="grossWeight" type="number" step="0.001" min={0} required />
        <Field label="Cost value (₹)" name="costValue" type="number" step="0.01" min={0} required />
      </div>
      <Field label="Note (optional)" name="note" />
      <Button type="submit" size="md" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Save opening stock"}
      </Button>
    </form>
  );
}

function MetalAdjustmentForm({ purities, onDone }: { purities: MetalPurityOption[]; onDone?: () => void }) {
  const [state, formAction, pending] = useActionState(adjustMetalStockAction, undefined);
  const [metalType, setMetalType] = useState(purities[0]?.metalType ?? "GOLD");
  const [purityId, setPurityId] = useState(purities[0]?.id ?? "");
  const purityOptions = purities.filter((p) => p.metalType === metalType);

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const formData = new FormData(e.currentTarget);
        const reason = formData.get("reason");
        if (!reason || String(reason).trim().length < 3) return;
        if (!window.confirm("Save this authorized stock adjustment? This directly changes Metal Stock and cannot be undone.")) {
          e.preventDefault();
        }
      }}
      className="flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30"
    >
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Adjustment saved.</Alert> : null}
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Owner only — use this only to correct a genuine stock-count error, with a reason for the audit trail.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <select
          aria-label="Metal"
          value={metalType}
          onChange={(e) => {
            setMetalType(e.target.value);
            setPurityId(purities.find((p) => p.metalType === e.target.value)?.id ?? "");
          }}
          className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          {[...new Set(purities.map((p) => p.metalType))].map((mt) => (
            <option key={mt} value={mt}>
              {metalTypeLabel(mt)}
            </option>
          ))}
        </select>
        <select
          aria-label="Purity"
          value={purityId}
          onChange={(e) => setPurityId(e.target.value)}
          className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          {purityOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
        <select
          aria-label="Direction"
          name="direction"
          defaultValue="IN"
          className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <option value="IN">Add to stock</option>
          <option value="OUT">Remove from stock</option>
        </select>
      </div>
      <input type="hidden" name="metalType" value={metalType} />
      <input type="hidden" name="purityId" value={purityId} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Weight (g)" name="grossWeight" type="number" step="0.001" min={0} required />
        <Field label="Cost value (₹, optional)" name="costValue" type="number" step="0.01" min={0} />
      </div>
      <Field label="Reason (required)" name="reason" required />
      <Button type="submit" variant="danger" size="md" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Save adjustment"}
      </Button>
    </form>
  );
}

export function MetalStockTab({
  buckets,
  purchases,
  suppliers,
  purities,
  paymentAccounts,
  gstRates,
  isOwner,
  search,
}: {
  buckets: SerializedMetalStockBucket[];
  purchases: SerializedMetalPurchase[];
  suppliers: PartyOption[];
  purities: MetalPurityOption[];
  paymentAccounts: { id: string; name: string; method: string }[];
  gstRates: { id: string; label: string; ratePercent: string }[];
  isOwner: boolean;
  search: string;
}) {
  const router = useRouter();
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [showOpeningForm, setShowOpeningForm] = useState(false);
  const [showAdjustForm, setShowAdjustForm] = useState(false);

  function handleSaved() {
    setShowPurchaseForm(false);
    setShowOpeningForm(false);
    setShowAdjustForm(false);
    router.refresh();
  }

  const totalFineWeight = buckets.reduce((sum, b) => sum + Number(b.fineWeight), 0);
  const totalScrapFineWeight = buckets.reduce((sum, b) => sum + Number(b.scrapFineWeight), 0);
  const totalCost = buckets.reduce((sum, b) => sum + Number(b.costValue ?? 0), 0);
  const totalScrapCost = buckets.reduce((sum, b) => sum + Number(b.scrapCostValue ?? 0), 0);
  const hasScrap = buckets.some((b) => Number(b.scrapGrossWeight) > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Total fine metal (usable)</p>
          <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{totalFineWeight.toFixed(3)}g</p>
        </div>
        {isOwner ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Total metal stock cost</p>
            <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">₹{totalCost.toFixed(2)}</p>
          </div>
        ) : null}
        {hasScrap ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Scrap (fine, not issuable)</p>
            <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{totalScrapFineWeight.toFixed(3)}g</p>
          </div>
        ) : null}
        {isOwner && hasScrap ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Scrap cost</p>
            <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">₹{totalScrapCost.toFixed(2)}</p>
          </div>
        ) : null}
      </div>

      {buckets.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-[var(--surface-muted)] text-left text-xs text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2">Metal · Purity</th>
                <th className="px-3 py-2">Gross weight</th>
                <th className="px-3 py-2">Fine weight</th>
                {isOwner ? <th className="px-3 py-2">Cost</th> : null}
                <th className="px-3 py-2">Scrap</th>
                {isOwner ? <th className="px-3 py-2">Scrap cost</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {buckets.map((b) => (
                <tr key={b.purityId}>
                  <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">
                    {metalTypeLabel(b.metalType)} · {b.purityDisplayName}
                  </td>
                  <td className="px-3 py-2">{b.grossWeight}g</td>
                  <td className="px-3 py-2">{b.fineWeight}g</td>
                  {isOwner ? <td className="px-3 py-2">₹{b.costValue}</td> : null}
                  <td className="px-3 py-2">{Number(b.scrapGrossWeight) > 0 ? `${b.scrapGrossWeight}g / ${b.scrapFineWeight}g fine` : "—"}</td>
                  {isOwner ? <td className="px-3 py-2">{Number(b.scrapGrossWeight) > 0 ? `₹${b.scrapCostValue}` : "—"}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No metal stock yet" description="Record a metal purchase or opening stock to get started." />
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant={showPurchaseForm ? "primary" : "secondary"} size="md" onClick={() => setShowPurchaseForm((v) => !v)}>
          {showPurchaseForm ? "Close" : "New Metal Purchase"}
        </Button>
        {isOwner ? (
          <>
            <Button type="button" variant="ghost" size="md" onClick={() => setShowOpeningForm((v) => !v)}>
              {showOpeningForm ? "Close" : "Opening Metal Stock"}
            </Button>
            <Button type="button" variant="ghost" size="md" onClick={() => setShowAdjustForm((v) => !v)}>
              {showAdjustForm ? "Close" : "Authorized Adjustment"}
            </Button>
          </>
        ) : null}
      </div>

      {showPurchaseForm ? (
        <MetalPurchaseForm suppliers={suppliers} purities={purities} paymentAccounts={paymentAccounts} gstRates={gstRates} onDone={handleSaved} />
      ) : null}
      {isOwner && showOpeningForm ? <OpeningMetalStockForm purities={purities} onDone={handleSaved} /> : null}
      {isOwner && showAdjustForm ? <MetalAdjustmentForm purities={purities} onDone={handleSaved} /> : null}

      <form method="GET" action="/jewellery-jobs" className="flex flex-wrap gap-2">
        <input type="hidden" name="tab" value="metal" />
        <input
          type="text"
          name="metalSearch"
          defaultValue={search}
          placeholder="Search purchases by code or supplier…"
          className="h-11 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Search
        </button>
      </form>

      {purchases.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-[var(--surface-muted)] text-left text-xs text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="px-3 py-2">Purchase</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Supplier</th>
                <th className="px-3 py-2">Metal · Purity</th>
                <th className="px-3 py-2">Weight</th>
                {isOwner ? <th className="px-3 py-2">Cost</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {purchases.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">{p.purchaseCode}</td>
                  <td className="px-3 py-2">{new Date(p.purchaseDate).toLocaleDateString("en-IN")}</td>
                  <td className="px-3 py-2">{p.supplierName}</td>
                  <td className="px-3 py-2">
                    {metalTypeLabel(p.metalType)} · {p.purityDisplayName}
                  </td>
                  <td className="px-3 py-2">
                    {p.grossWeight}g / {p.fineWeight}g fine
                  </td>
                  {isOwner ? <td className="px-3 py-2">₹{p.totalPurchaseCost}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
