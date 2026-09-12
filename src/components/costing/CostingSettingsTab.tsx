"use client";

import { useActionState } from "react";

import { saveCostingSettingsAction } from "@/app/actions/costing";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export type CostingSettingsValues = {
  defaultPricingMethod: "MARKUP_ON_COST" | "MARGIN_ON_PRICE";
  defaultMarkupPercent: string;
  defaultTargetMarginPercent: string;
  defaultDiscountType: "NONE" | "PERCENT" | "FIXED";
  defaultDiscountValue: string;
  defaultGstTreatment: "NONE" | "CGST_SGST" | "IGST";
  defaultGstRateId: string;
  defaultPriceType: "EXCLUSIVE" | "INCLUSIVE";
  defaultValidityDays: string;
  defaultRoundingStep: string;
  defaultSellingExpenseFixed: string;
  defaultSellingExpensePercent: string;
  quotationTerms: string;
};

export function CostingSettingsTab({
  initialValues,
  gstRates,
}: {
  initialValues: CostingSettingsValues;
  gstRates: { id: string; label: string; ratePercent: string }[];
}) {
  const [state, formAction, pending] = useActionState(saveCostingSettingsAction, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
      <div>
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Costing defaults</h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          These fill in a brand-new Draft costing only. Changing them here never rewrites a costing you already
          created — Draft or Finalized.
        </p>
      </div>

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Costing Settings saved.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Default pricing method" name="defaultPricingMethod" required>
          <select
            name="defaultPricingMethod"
            defaultValue={initialValues.defaultPricingMethod}
            className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="MARKUP_ON_COST">Markup on cost</option>
            <option value="MARGIN_ON_PRICE">Target margin on selling price</option>
          </select>
        </Field>
        <Field
          label="Default markup %"
          name="defaultMarkupPercent"
          type="number"
          step="0.001"
          min="0"
          defaultValue={initialValues.defaultMarkupPercent}
        />
        <Field
          label="Default target margin %"
          name="defaultTargetMarginPercent"
          type="number"
          step="0.001"
          min="0"
          max="99.999"
          defaultValue={initialValues.defaultTargetMarginPercent}
          hint="Must be below 100%."
        />
        <Field label="Default discount type" name="defaultDiscountType">
          <select
            name="defaultDiscountType"
            defaultValue={initialValues.defaultDiscountType}
            className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="NONE">No discount</option>
            <option value="PERCENT">Percentage</option>
            <option value="FIXED">Fixed amount</option>
          </select>
        </Field>
        <Field label="Default discount value" name="defaultDiscountValue" type="number" step="0.01" min="0" defaultValue={initialValues.defaultDiscountValue} />
        <Field label="Default GST treatment" name="defaultGstTreatment">
          <select
            name="defaultGstTreatment"
            defaultValue={initialValues.defaultGstTreatment}
            className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="NONE">No GST</option>
            <option value="CGST_SGST">CGST + SGST</option>
            <option value="IGST">IGST</option>
          </select>
        </Field>
        <Field label="Default GST rate" name="defaultGstRateId">
          <select
            name="defaultGstRateId"
            defaultValue={initialValues.defaultGstRateId}
            className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="">Choose a rate…</option>
            {gstRates.map((g) => (
              <option key={g.id} value={g.id}>
                {g.label} ({g.ratePercent}%)
              </option>
            ))}
          </select>
        </Field>
        <Field label="Customer price type" name="defaultPriceType">
          <select
            name="defaultPriceType"
            defaultValue={initialValues.defaultPriceType}
            className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="EXCLUSIVE">Tax-exclusive (add GST on top)</option>
            <option value="INCLUSIVE">Tax-inclusive (GST already included)</option>
          </select>
        </Field>
        <Field label="Quotation validity (days)" name="defaultValidityDays" type="number" min="0" max="365" defaultValue={initialValues.defaultValidityDays} />
        <Field
          label="Round customer total to nearest (₹)"
          name="defaultRoundingStep"
          type="number"
          step="0.01"
          min="0"
          defaultValue={initialValues.defaultRoundingStep}
          hint="Leave 0 for no rounding."
        />
        <Field label="Default fixed selling expense (₹)" name="defaultSellingExpenseFixed" type="number" step="0.01" min="0" defaultValue={initialValues.defaultSellingExpenseFixed} />
        <Field label="Default selling expense %" name="defaultSellingExpensePercent" type="number" step="0.001" min="0" max="100" defaultValue={initialValues.defaultSellingExpensePercent} hint="e.g. a payment/marketplace commission." />
      </div>

      <Field label="Quotation terms shown to customers" name="quotationTerms">
        <textarea
          name="quotationTerms"
          defaultValue={initialValues.quotationTerms}
          rows={3}
          placeholder="e.g. Prices valid till the date shown. Making charges may vary slightly at final weighing."
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
      </Field>

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save Costing Settings"}
        </Button>
      </div>
    </form>
  );
}
