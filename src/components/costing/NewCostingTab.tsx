"use client";

import { useActionState, useState } from "react";

import { createActualCostingAction } from "@/app/actions/costing";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { EstimateForm, type MetalPurityOption } from "@/components/costing/EstimateForm";
import { defaultPricingState } from "@/components/costing/PricingFields";
import { jewelleryTypeLabel } from "@/lib/jewellery/types";

export type EligibleOutput = {
  id: string;
  finishedCode: string;
  jobCode: string;
  designName: string;
  jewelleryType: string;
  customerName: string | null;
  karigarName: string;
  quantity: number;
  netMetalWeight: string;
  purityDisplayName: string;
  totalCost: string;
  qcStatus: string;
  receiveDate: string;
};

function money(v: string) {
  return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function NewCostingTab({
  initialMode,
  eligibleOutputs,
  purities,
  gstRates,
  customers,
  defaults,
}: {
  initialMode: "actual" | "estimate" | null;
  eligibleOutputs: EligibleOutput[];
  purities: MetalPurityOption[];
  gstRates: { id: string; label: string; ratePercent: string }[];
  customers: { id: string; name: string }[];
  defaults: {
    pricingMethod: "MARKUP_ON_COST" | "MARGIN_ON_PRICE";
    markupPercent: string;
    targetMarginPercent: string;
    discountType: "NONE" | "PERCENT" | "FIXED";
    discountValue: string;
    gstTreatment: "NONE" | "CGST_SGST" | "IGST";
    gstRateId: string | null;
    priceType: "EXCLUSIVE" | "INCLUSIVE";
    roundingStep: string;
    sellingExpenseFixed: string;
    sellingExpensePercent: string;
  };
}) {
  const [mode, setMode] = useState<"actual" | "estimate" | null>(initialMode);

  if (mode === null) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">What are you costing?</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setMode("actual")}
            className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-left transition-colors hover:border-zinc-400 dark:hover:border-zinc-500"
          >
            <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">A piece we already finished</span>
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              Pull the real cost straight from a completed Jewellery Job — metal, diamonds, labour, everything already
              recorded.
            </span>
          </button>
          <button
            type="button"
            onClick={() => setMode("estimate")}
            className="flex flex-col gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-6 text-left transition-colors hover:border-zinc-400 dark:hover:border-zinc-500"
          >
            <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">An estimate before making it</span>
            <span className="text-sm text-zinc-600 dark:text-zinc-400">
              Put together a quotation for a customer before any manufacturing starts — nothing here touches real
              stock.
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button type="button" variant="ghost" size="md" onClick={() => setMode(null)}>
        ← Choose a different type
      </Button>
      {mode === "actual" ? (
        <ActualCostingCreator eligibleOutputs={eligibleOutputs} customers={customers} defaults={defaults} />
      ) : (
        <EstimateForm
          purities={purities}
          gstRates={gstRates}
          customers={customers}
          defaults={defaultPricingState({
            pricingMethod: defaults.pricingMethod,
            markupPercent: defaults.markupPercent,
            targetMarginPercent: defaults.targetMarginPercent,
            discountType: defaults.discountType,
            discountValue: defaults.discountValue,
            gstTreatment: defaults.gstTreatment,
            gstRateId: defaults.gstRateId ?? "",
            priceType: defaults.priceType,
            roundingStep: defaults.roundingStep,
            sellingExpenseFixed: defaults.sellingExpenseFixed,
            sellingExpensePercent: defaults.sellingExpensePercent,
          })}
        />
      )}
    </div>
  );
}

function ActualCostingCreator({
  eligibleOutputs,
  customers,
  defaults,
}: {
  eligibleOutputs: EligibleOutput[];
  customers: { id: string; name: string }[];
  defaults: { pricingMethod: "MARKUP_ON_COST" | "MARGIN_ON_PRICE"; markupPercent: string; targetMarginPercent: string };
}) {
  const [selected, setSelected] = useState<EligibleOutput | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [state, formAction, pending] = useActionState(createActualCostingAction, undefined);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  if (eligibleOutputs.length === 0) {
    return (
      <EmptyState
        title="No finished pieces are ready to cost yet"
        description="A Jewellery Job's finished output becomes eligible once that job is fully Completed."
      />
    );
  }

  if (!selected) {
    return (
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Choose a finished piece</h3>
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
          {eligibleOutputs.map((o) => (
            <li key={o.id} className="flex flex-col gap-2 bg-[var(--surface)] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                  {o.finishedCode} · {jewelleryTypeLabel(o.jewelleryType)}
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {o.designName} · Job {o.jobCode} · {o.karigarName}
                  {o.customerName ? ` · ${o.customerName}` : ""} · {o.netMetalWeight}g {o.purityDisplayName} · Cost so far {money(o.totalCost)}
                </p>
              </div>
              <Button type="button" size="md" onClick={() => setSelected(o)}>
                Use this piece
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
      <input type="hidden" name="sourceFinishedJewelleryId" value={selected.id} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="costingDate" value={new Date().toISOString().slice(0, 10)} />
      <input type="hidden" name="pricingMethod" value={defaults.pricingMethod} />
      <input type="hidden" name="markupPercent" value={defaults.markupPercent} />
      <input type="hidden" name="targetMarginPercent" value={defaults.targetMarginPercent} />
      <input type="hidden" name="discountType" value="NONE" />
      <input type="hidden" name="gstTreatment" value="NONE" />
      <input type="hidden" name="priceType" value="EXCLUSIVE" />
      <input type="hidden" name="customerId" value={customerId} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? (
        <Alert tone="success">
          Created as {state.costingNumber}.{" "}
          <a href={`/costing?tab=sheets&sheetId=${state.id}`} className="underline">
            Open it to set the selling price
          </a>
          .
        </Alert>
      ) : null}

      <div>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{selected.finishedCode} · {jewelleryTypeLabel(selected.jewelleryType)}</p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {selected.designName} · Job {selected.jobCode} · {selected.netMetalWeight}g {selected.purityDisplayName} · Cost so far {money(selected.totalCost)}
        </p>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        The real metal, diamond, other-material and labour cost will be pulled in automatically from this piece&apos;s
        Jewellery Job. You can set the selling price after creating this Draft.
      </p>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Customer (optional)</span>
        <select
          className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
        >
          <option value="">No customer chosen</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={() => setSelected(null)}>
          Choose a different piece
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create Draft costing"}
        </Button>
      </div>
    </form>
  );
}
