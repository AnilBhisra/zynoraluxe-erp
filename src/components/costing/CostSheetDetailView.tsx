"use client";

import { useActionState, useState } from "react";

import {
  archiveCostingAction,
  deleteDraftCostingAction,
  finalizeCostingAction,
  refreshActualCostingAction,
  reviseCostingAction,
  unarchiveCostingAction,
  updateActualCostingAction,
} from "@/app/actions/costing";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Field } from "@/components/ui/Field";
import { CalculationSummary } from "@/components/costing/CalculationSummary";
import { PricingFields, type PricingState } from "@/components/costing/PricingFields";
import { EstimateForm, type InitialEstimateValues, type MetalPurityOption } from "@/components/costing/EstimateForm";
import { jewelleryTypeLabel } from "@/lib/jewellery/types";
import { previewCostSheetTotals } from "@/lib/costing/previewMath";

export type SerializedCostSheetDetail = {
  id: string;
  costingNumber: string;
  mode: "ACTUAL" | "ESTIMATE";
  status: "DRAFT" | "FINALIZED" | "ARCHIVED";
  costingDate: string;
  jewelleryType: string;
  itemName: string;
  referenceNumber: string | null;
  quantity: number;
  sizeOrLength: string | null;
  designImageAssetId: string | null;
  notes: string | null;
  customerId: string | null;
  customerName: string | null;
  sourceFinishedJewelleryId: string | null;
  sourceJobCode: string | null;
  sourceReceiptCode: string | null;
  sourceFinishedCode: string | null;
  sourceVoucherNumber: string | null;
  sourceRefreshedAt: string | null;
  linkedEstimateId: string | null;
  linkedEstimateNumber: string | null;
  pricingMethod: "MARKUP_ON_COST" | "MARGIN_ON_PRICE";
  markupPercent: string;
  targetMarginPercent: string;
  manualSellingPriceOverride: string | null;
  isManualOverride: boolean;
  discountType: "NONE" | "PERCENT" | "FIXED";
  discountValue: string;
  gstTreatment: "NONE" | "CGST_SGST" | "IGST";
  gstRateId: string | null;
  gstRatePercentSnapshot: string;
  priceType: "EXCLUSIVE" | "INCLUSIVE";
  roundingStep: string;
  sellingExpenseFixed: string;
  sellingExpensePercent: string;
  quotationValidUntil: string | null;
  quotationTerms: string | null;
  revisionGroupId: string;
  revisionNumber: number;
  previousVersionId: string | null;
  nextVersionId: string | null;
  finalizedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  metalLines: {
    id: string;
    metalType: string;
    purityId: string | null;
    purityDisplayNameSnapshot: string;
    grossWeight: string;
    wastagePercent: string;
    fineWeight: string;
    rateBasis: string;
    rate: string;
    amount: string;
  }[];
  diamondLines: {
    id: string;
    sourcePolishedDiamondId: string | null;
    polishedCodeSnapshot: string | null;
    diamondType: string | null;
    shape: string;
    customShapeName: string | null;
    quantity: number;
    totalCarat: string;
    ratePerCarat: string | null;
    fixedAmount: string | null;
    certificateCharge: string;
    amount: string;
    notes: string | null;
  }[];
  otherMaterialLines: { id: string; category: string; description: string; quantity: string | null; weight: string | null; rate: string | null; amount: string }[];
  chargeLines: { id: string; label: string; isLabour: boolean; method: string; rate: string; amount: string }[];
  totals: {
    metalCost: string;
    diamondCost: string;
    otherMaterialCost: string;
    labourCost: string;
    additionalChargesCost: string;
    productionCost: string;
    sellingValueBeforeDiscount: string;
    discountAmount: string;
    taxableSellingValue: string;
    gstAmount: string;
    cgst: string;
    sgst: string;
    igst: string;
    customerTotalBeforeRounding: string;
    roundingAdjustment: string;
    customerTotal: string;
    sellingExpenseAmount: string;
    netRealization: string;
    estimatedProfit: string;
    profitMarginPercent: string;
    isManualOverrideApplied: boolean;
  };
  linkedEstimateTotals: { productionCost: string; customerTotal: string; estimatedProfit: string; profitMarginPercent: string } | null;
  auditEvents: { id: string; eventType: string; note: string | null; userName: string; createdAt: string }[];
  revisions: { id: string; costingNumber: string; revisionNumber: number; status: string }[];
};

function money(v: string) {
  return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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

const EVENT_LABELS: Record<string, string> = {
  CREATED: "Created",
  UPDATED: "Updated",
  REFRESHED: "Refreshed from source",
  FINALIZED: "Finalized",
  REVISED: "Revised",
  ARCHIVED: "Archived",
  UNARCHIVED: "Restored from archive",
  DRAFT_DELETED: "Draft deleted",
};

export function CostSheetDetailView({
  detail,
  designImageUrl,
  gstRates,
  customers,
  estimateOptions,
  purities,
}: {
  detail: SerializedCostSheetDetail;
  designImageUrl: string | null;
  gstRates: { id: string; label: string; ratePercent: string }[];
  customers: { id: string; name: string }[];
  estimateOptions: { id: string; costingNumber: string; itemName: string }[];
  purities: MetalPurityOption[];
}) {
  const [showQuotationHint, setShowQuotationHint] = useState(false);

  return (
    <div className="flex flex-col gap-6">
      <a href="/costing?tab=sheets" className="text-sm text-zinc-600 underline underline-offset-4 dark:text-zinc-400">
        ← Back to cost sheets
      </a>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{detail.costingNumber}</h2>
          <StatusPill status={detail.status} />
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
            {detail.mode === "ACTUAL" ? "Actual" : "Estimate"}
          </span>
          {detail.revisionNumber > 1 ? (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
              Revision {detail.revisionNumber}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          {detail.itemName} · {jewelleryTypeLabel(detail.jewelleryType)}
          {detail.customerName ? ` · ${detail.customerName}` : ""} · {new Date(detail.costingDate).toLocaleDateString("en-IN")}
        </p>
        {detail.mode === "ACTUAL" ? (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Sourced from Job {detail.sourceJobCode} · Receipt {detail.sourceReceiptCode} · Output {detail.sourceFinishedCode}
            {detail.sourceVoucherNumber ? ` · Voucher ${detail.sourceVoucherNumber}` : ""}
            {detail.sourceRefreshedAt ? ` · Last refreshed ${new Date(detail.sourceRefreshedAt).toLocaleString("en-IN")}` : ""}
          </p>
        ) : null}
        {designImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={designImageUrl} alt="Design" className="mt-3 h-32 w-32 rounded-lg object-cover" />
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          {detail.status === "FINALIZED" ? (
            <>
              <a href={`/costing?tab=sheets&sheetId=${detail.id}&quotation=1`}>
                <Button type="button" variant="secondary" onClick={() => setShowQuotationHint(true)}>
                  Open customer quotation
                </Button>
              </a>
              <ReviseButton costSheetId={detail.id} />
              <ArchiveButton costSheetId={detail.id} />
            </>
          ) : null}
          {detail.status === "ARCHIVED" ? <UnarchiveButton costSheetId={detail.id} /> : null}
          {detail.status === "DRAFT" ? (
            <>
              <FinalizeButton costSheetId={detail.id} />
              <DeleteDraftButton costSheetId={detail.id} />
            </>
          ) : null}
        </div>
        {showQuotationHint ? (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            Opening the print-friendly quotation in a moment — use your browser&apos;s Print / Save as PDF once it
            loads.
          </p>
        ) : null}
      </div>

      {detail.status === "DRAFT" && detail.mode === "ACTUAL" ? (
        <ActualDraftEditor detail={detail} gstRates={gstRates} customers={customers} estimateOptions={estimateOptions} />
      ) : null}

      {detail.status === "DRAFT" && detail.mode === "ESTIMATE" ? (
        <EstimateForm
          purities={purities}
          gstRates={gstRates}
          customers={customers}
          defaults={{
            pricingMethod: detail.pricingMethod,
            markupPercent: detail.markupPercent,
            targetMarginPercent: detail.targetMarginPercent,
            useManualOverride: detail.isManualOverride,
            manualSellingPriceOverride: detail.manualSellingPriceOverride ?? "",
            discountType: detail.discountType,
            discountValue: detail.discountValue,
            gstTreatment: detail.gstTreatment,
            gstRateId: detail.gstRateId ?? "",
            priceType: detail.priceType,
            roundingStep: detail.roundingStep,
            sellingExpenseFixed: detail.sellingExpenseFixed,
            sellingExpensePercent: detail.sellingExpensePercent,
            quotationTerms: detail.quotationTerms ?? "",
          }}
          initial={toInitialEstimateValues(detail)}
        />
      ) : null}

      {detail.status !== "DRAFT" ? (
        <ReadOnlyBreakdown detail={detail} />
      ) : null}

      {detail.revisions.length > 1 ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Revision history</h3>
          <ul className="flex flex-col gap-2">
            {detail.revisions.map((r) => (
              <li key={r.id} className="flex items-center justify-between text-sm">
                <span className={r.id === detail.id ? "font-semibold text-zinc-900 dark:text-zinc-50" : "text-zinc-600 dark:text-zinc-400"}>
                  Rev {r.revisionNumber} · {r.costingNumber} · {r.status}
                </span>
                {r.id !== detail.id ? (
                  <a href={`/costing?tab=sheets&sheetId=${r.id}`} className="text-xs text-zinc-600 underline underline-offset-4 dark:text-zinc-400">
                    View
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Audit history</h3>
        <ul className="flex flex-col gap-2">
          {detail.auditEvents.map((e) => (
            <li key={e.id} className="text-xs text-zinc-600 dark:text-zinc-400">
              {EVENT_LABELS[e.eventType] ?? e.eventType} by {e.userName} · {new Date(e.createdAt).toLocaleString("en-IN")}
              {e.note ? ` — ${e.note}` : ""}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function toInitialEstimateValues(detail: SerializedCostSheetDetail): InitialEstimateValues {
  return {
    costSheetId: detail.id,
    costingDate: detail.costingDate.slice(0, 10),
    jewelleryType: detail.jewelleryType,
    itemName: detail.itemName,
    referenceNumber: detail.referenceNumber ?? "",
    quantity: String(detail.quantity),
    sizeOrLength: detail.sizeOrLength ?? "",
    designImageAssetId: detail.designImageAssetId,
    customerId: detail.customerId ?? "",
    notes: detail.notes ?? "",
    metalLines: detail.metalLines.map((l) => ({
      metalType: l.metalType,
      purityId: l.purityId ?? "",
      grossWeight: l.grossWeight,
      wastagePercent: l.wastagePercent,
      rateBasis: l.rateBasis,
      rate: l.rate,
    })),
    diamondLines: detail.diamondLines.map((l) => ({
      shape: l.shape,
      customShapeName: l.customShapeName ?? "",
      quantity: String(l.quantity),
      totalCarat: l.totalCarat,
      ratePerCarat: l.ratePerCarat ?? "",
      fixedAmount: l.fixedAmount ?? "",
      certificateCharge: l.certificateCharge,
      notes: l.notes ?? "",
    })),
    otherMaterialLines: detail.otherMaterialLines.map((l) => ({
      category: l.category,
      description: l.description,
      quantity: l.quantity ?? "",
      rate: l.rate ?? "",
      manualAmount: l.quantity && l.rate ? "" : l.amount,
    })),
    chargeLines: detail.chargeLines.map((l) => ({ label: l.label, isLabour: l.isLabour, method: l.method, rate: l.rate })),
    pricing: {
      pricingMethod: detail.pricingMethod,
      markupPercent: detail.markupPercent,
      targetMarginPercent: detail.targetMarginPercent,
      useManualOverride: detail.isManualOverride,
      manualSellingPriceOverride: detail.manualSellingPriceOverride ?? "",
      discountType: detail.discountType,
      discountValue: detail.discountValue,
      gstTreatment: detail.gstTreatment,
      gstRateId: detail.gstRateId ?? "",
      priceType: detail.priceType,
      roundingStep: detail.roundingStep,
      sellingExpenseFixed: detail.sellingExpenseFixed,
      sellingExpensePercent: detail.sellingExpensePercent,
      quotationTerms: detail.quotationTerms ?? "",
    },
  };
}

function LineItemsList({ detail }: { detail: SerializedCostSheetDetail }) {
  return (
    <div className="flex flex-col gap-3">
      {detail.metalLines.map((l) => (
        <p key={l.id} className="text-sm text-zinc-700 dark:text-zinc-300">
          Metal — {l.metalType} {l.purityDisplayNameSnapshot} · {l.grossWeight}g gross / {l.fineWeight}g fine · {money(l.amount)}
        </p>
      ))}
      {detail.diamondLines.map((l) => (
        <p key={l.id} className="text-sm text-zinc-700 dark:text-zinc-300">
          Diamond — {l.polishedCodeSnapshot ?? l.shape} · {l.quantity} pc · {l.totalCarat}ct · {money(l.amount)}
        </p>
      ))}
      {detail.otherMaterialLines.map((l) => (
        <p key={l.id} className="text-sm text-zinc-700 dark:text-zinc-300">
          Other material — {l.description} · {money(l.amount)}
        </p>
      ))}
      {detail.chargeLines.map((l) => (
        <p key={l.id} className="text-sm text-zinc-700 dark:text-zinc-300">
          {l.isLabour ? "Labour" : "Charge"} — {l.label} · {money(l.amount)}
        </p>
      ))}
    </div>
  );
}

function ReadOnlyBreakdown({ detail }: { detail: SerializedCostSheetDetail }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
      <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Cost breakdown</h3>
      <LineItemsList detail={detail} />
      <div className="mt-4">
        <CalculationSummary
          metalCost={Number(detail.totals.metalCost)}
          diamondCost={Number(detail.totals.diamondCost)}
          otherMaterialCost={Number(detail.totals.otherMaterialCost)}
          labourCost={Number(detail.totals.labourCost)}
          additionalChargesCost={Number(detail.totals.additionalChargesCost)}
          totals={{
            productionCost: Number(detail.totals.productionCost),
            sellingValueBeforeDiscount: Number(detail.totals.sellingValueBeforeDiscount),
            discountAmount: Number(detail.totals.discountAmount),
            taxableSellingValue: Number(detail.totals.taxableSellingValue),
            gstAmount: Number(detail.totals.gstAmount),
            customerTotalBeforeRounding: Number(detail.totals.customerTotalBeforeRounding),
            roundingAdjustment: Number(detail.totals.roundingAdjustment),
            customerTotal: Number(detail.totals.customerTotal),
            sellingExpenseAmount: Number(detail.totals.sellingExpenseAmount),
            netRealization: Number(detail.totals.netRealization),
            estimatedProfit: Number(detail.totals.estimatedProfit),
            profitMarginPercent: Number(detail.totals.profitMarginPercent),
          }}
          isManualOverride={detail.totals.isManualOverrideApplied}
        />
      </div>
      {detail.linkedEstimateTotals ? (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <h4 className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            Estimate vs Actual (linked to {detail.linkedEstimateNumber})
          </h4>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            Estimated production cost {money(detail.linkedEstimateTotals.productionCost)} vs actual {money(detail.totals.productionCost)}
          </p>
          <p className="text-sm text-zinc-700 dark:text-zinc-300">
            Estimated profit {money(detail.linkedEstimateTotals.estimatedProfit)} ({detail.linkedEstimateTotals.profitMarginPercent}%) vs actual{" "}
            {money(detail.totals.estimatedProfit)} ({detail.totals.profitMarginPercent}%)
          </p>
        </div>
      ) : null}
      {detail.status === "FINALIZED" || detail.status === "ARCHIVED" ? (
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          This costing is {detail.status === "FINALIZED" ? "finalized" : "archived"} — its figures are locked and will
          never change, even if the Metal/Purity master, GST rate, or Costing Settings change later. To correct it,
          create a revision.
        </p>
      ) : null}
    </div>
  );
}

function ActualDraftEditor({
  detail,
  gstRates,
  customers,
  estimateOptions,
}: {
  detail: SerializedCostSheetDetail;
  gstRates: { id: string; label: string; ratePercent: string }[];
  customers: { id: string; name: string }[];
  estimateOptions: { id: string; costingNumber: string; itemName: string }[];
}) {
  const [state, formAction, pending] = useActionState(updateActualCostingAction, undefined);
  const [pricing, setPricing] = useState<PricingState>({
    pricingMethod: detail.pricingMethod,
    markupPercent: detail.markupPercent,
    targetMarginPercent: detail.targetMarginPercent,
    useManualOverride: detail.isManualOverride,
    manualSellingPriceOverride: detail.manualSellingPriceOverride ?? "",
    discountType: detail.discountType,
    discountValue: detail.discountValue,
    gstTreatment: detail.gstTreatment,
    gstRateId: detail.gstRateId ?? "",
    priceType: detail.priceType,
    roundingStep: detail.roundingStep,
    sellingExpenseFixed: detail.sellingExpenseFixed,
    sellingExpensePercent: detail.sellingExpensePercent,
    quotationTerms: detail.quotationTerms ?? "",
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [quantity, setQuantity] = useState(String(detail.quantity));
  const [customerId, setCustomerId] = useState(detail.customerId ?? "");
  const [linkedEstimateId, setLinkedEstimateId] = useState(detail.linkedEstimateId ?? "");
  const [notes, setNotes] = useState(detail.notes ?? "");

  function num(v: string) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  const metalCost = detail.metalLines.reduce((s, l) => s + num(l.amount), 0);
  const diamondCost = detail.diamondLines.reduce((s, l) => s + num(l.amount), 0);
  const otherMaterialCost = detail.otherMaterialLines.reduce((s, l) => s + num(l.amount), 0);
  const labourCost = detail.chargeLines.filter((l) => l.isLabour).reduce((s, l) => s + num(l.amount), 0);
  const additionalChargesCost = detail.chargeLines.filter((l) => !l.isLabour).reduce((s, l) => s + num(l.amount), 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Cost breakdown (sourced from the finished piece)</h3>
        <LineItemsList detail={detail} />
      </div>

      <form action={formAction} className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <input type="hidden" name="costSheetId" value={detail.id} />
        <input type="hidden" name="costingDate" value={detail.costingDate.slice(0, 10)} />

        {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
        {state?.success ? <Alert tone="success">Saved.</Alert> : null}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Quantity" name="quantity" type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Customer (optional)</span>
            <select className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" name="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">No customer chosen</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {estimateOptions.length > 0 ? (
            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Compare against an earlier Estimate (optional)</span>
              <select className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" name="linkedEstimateId" value={linkedEstimateId} onChange={(e) => setLinkedEstimateId(e.target.value)}>
                <option value="">No linked estimate</option>
                {estimateOptions.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.costingNumber} — {e.itemName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Field label="Notes" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Selling price</h3>
        <PricingFields value={pricing} onChange={setPricing} gstRates={gstRates} showAdvanced={showAdvanced} onToggleAdvanced={() => setShowAdvanced((v) => !v)} />

        <div>
          <Button type="submit" variant="secondary" disabled={pending}>
            {pending ? "Saving…" : "Save pricing"}
          </Button>
        </div>
      </form>

      {/* Deliberately a sibling of the pricing <form> above, never nested
       * inside it — a <form> nested inside another <form> is invalid
       * HTML, and browsers silently reparent/corrupt the inner form's
       * controls when that happens, which is exactly what broke "Save
       * pricing" here until this was caught via live testing. Finalize
       * itself lives once in the shared header above (both modes need
       * it), not duplicated here. */}
      <div className="flex gap-2">
        <RefreshFromSourceButton costSheetId={detail.id} />
      </div>

      <CalculationSummary
        metalCost={metalCost}
        diamondCost={diamondCost}
        otherMaterialCost={otherMaterialCost}
        labourCost={labourCost}
        additionalChargesCost={additionalChargesCost}
        totals={computePreviewTotalsPlain(metalCost, diamondCost, otherMaterialCost, labourCost, additionalChargesCost, pricing, gstRates)}
        isManualOverride={pricing.useManualOverride}
      />
    </div>
  );
}

function computePreviewTotalsPlain(
  metalCost: number,
  diamondCost: number,
  otherMaterialCost: number,
  labourCost: number,
  additionalChargesCost: number,
  pricing: PricingState,
  gstRates: { id: string; label: string; ratePercent: string }[]
) {
  function num(v: string) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return previewCostSheetTotals({
    metalCost,
    diamondCost,
    otherMaterialCost,
    labourCost,
    additionalChargesCost,
    pricingMethod: pricing.pricingMethod,
    markupPercent: num(pricing.markupPercent),
    targetMarginPercent: num(pricing.targetMarginPercent),
    manualSellingPriceOverride: pricing.useManualOverride ? num(pricing.manualSellingPriceOverride) : null,
    discountType: pricing.discountType,
    discountValue: num(pricing.discountValue),
    gstTreatment: pricing.gstTreatment,
    gstRatePercent: Number(gstRates.find((g) => g.id === pricing.gstRateId)?.ratePercent ?? 0),
    priceType: pricing.priceType,
    roundingStep: num(pricing.roundingStep),
    sellingExpenseFixed: num(pricing.sellingExpenseFixed),
    sellingExpensePercent: num(pricing.sellingExpensePercent),
  });
}

function RefreshFromSourceButton({ costSheetId }: { costSheetId: string }) {
  const [state, formAction, pending] = useActionState(refreshActualCostingAction, undefined);
  return (
    <form action={formAction}>
      <input type="hidden" name="costSheetId" value={costSheetId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Refreshing…" : "Refresh from source"}
      </Button>
      {state?.error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
    </form>
  );
}

function FinalizeButton({ costSheetId }: { costSheetId: string }) {
  const [state, formAction, pending] = useActionState(finalizeCostingAction, undefined);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm("Finalize this costing? Its figures will be locked and can only be changed by creating a new revision.")) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="costSheetId" value={costSheetId} />
      <Button type="submit" disabled={pending}>
        {pending ? "Finalizing…" : "Finalize"}
      </Button>
      {state?.error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
    </form>
  );
}

function ReviseButton({ costSheetId }: { costSheetId: string }) {
  const [state, formAction, pending] = useActionState(reviseCostingAction, undefined);
  return (
    <form action={formAction}>
      <input type="hidden" name="costSheetId" value={costSheetId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Creating revision…" : "Revise"}
      </Button>
      {state?.success && state.id ? (
        <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
          <a href={`/costing?tab=sheets&sheetId=${state.id}`} className="underline">
            New Draft revision {state.costingNumber} created — edit it
          </a>
        </p>
      ) : null}
      {state?.error ? <p className="mt-1 text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
    </form>
  );
}

function ArchiveButton({ costSheetId }: { costSheetId: string }) {
  return (
    <form action={archiveCostingAction}>
      <input type="hidden" name="costSheetId" value={costSheetId} />
      <Button type="submit" variant="secondary">
        Archive
      </Button>
    </form>
  );
}

function UnarchiveButton({ costSheetId }: { costSheetId: string }) {
  return (
    <form action={unarchiveCostingAction}>
      <input type="hidden" name="costSheetId" value={costSheetId} />
      <Button type="submit" variant="secondary">
        Restore from archive
      </Button>
    </form>
  );
}

function DeleteDraftButton({ costSheetId }: { costSheetId: string }) {
  return (
    <form
      action={deleteDraftCostingAction}
      onSubmit={(e) => {
        if (!window.confirm("Delete this Draft costing? This cannot be undone.")) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="costSheetId" value={costSheetId} />
      <Button type="submit" variant="danger">
        Delete Draft
      </Button>
    </form>
  );
}
