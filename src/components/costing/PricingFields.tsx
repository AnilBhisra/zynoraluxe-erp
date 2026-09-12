"use client";

export type PricingState = {
  pricingMethod: "MARKUP_ON_COST" | "MARGIN_ON_PRICE";
  markupPercent: string;
  targetMarginPercent: string;
  useManualOverride: boolean;
  manualSellingPriceOverride: string;
  discountType: "NONE" | "PERCENT" | "FIXED";
  discountValue: string;
  gstTreatment: "NONE" | "CGST_SGST" | "IGST";
  gstRateId: string;
  priceType: "EXCLUSIVE" | "INCLUSIVE";
  roundingStep: string;
  sellingExpenseFixed: string;
  sellingExpensePercent: string;
  quotationTerms: string;
};

export function defaultPricingState(defaults?: Partial<PricingState>): PricingState {
  return {
    pricingMethod: "MARKUP_ON_COST",
    markupPercent: "0",
    targetMarginPercent: "0",
    useManualOverride: false,
    manualSellingPriceOverride: "",
    discountType: "NONE",
    discountValue: "0",
    gstTreatment: "NONE",
    gstRateId: "",
    priceType: "EXCLUSIVE",
    roundingStep: "0",
    sellingExpenseFixed: "0",
    sellingExpensePercent: "0",
    quotationTerms: "",
    ...defaults,
  };
}

const selectClasses =
  "h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";
const inputClasses =
  "h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

export function PricingFields({
  value,
  onChange,
  gstRates,
  showAdvanced,
  onToggleAdvanced,
}: {
  value: PricingState;
  onChange: (next: PricingState) => void;
  gstRates: { id: string; label: string; ratePercent: string }[];
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
}) {
  function set<K extends keyof PricingState>(key: K, v: PricingState[K]) {
    onChange({ ...value, [key]: v });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Pricing method</span>
          <select className={selectClasses} value={value.pricingMethod} onChange={(e) => set("pricingMethod", e.target.value as PricingState["pricingMethod"])}>
            <option value="MARKUP_ON_COST">Markup on cost</option>
            <option value="MARGIN_ON_PRICE">Target margin on selling price</option>
          </select>
        </label>
        {value.pricingMethod === "MARKUP_ON_COST" ? (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Markup %</span>
            <input type="number" step="0.001" min="0" className={inputClasses} value={value.markupPercent} onChange={(e) => set("markupPercent", e.target.value)} />
          </label>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Target margin %</span>
            <input
              type="number"
              step="0.001"
              min="0"
              max="99.999"
              className={inputClasses}
              value={value.targetMarginPercent}
              onChange={(e) => set("targetMarginPercent", e.target.value)}
            />
            {Number(value.targetMarginPercent) >= 100 ? (
              <span className="text-xs font-medium text-red-600 dark:text-red-400">Target margin must be below 100%.</span>
            ) : null}
          </label>
        )}
      </div>

      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input
          type="checkbox"
          checked={value.useManualOverride}
          onChange={(e) => set("useManualOverride", e.target.checked)}
          className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600"
        />
        Set the selling value manually instead
      </label>
      {value.useManualOverride ? (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Manual selling value (₹)</span>
          <input
            type="number"
            step="0.01"
            min="0"
            className={inputClasses}
            value={value.manualSellingPriceOverride}
            onChange={(e) => set("manualSellingPriceOverride", e.target.value)}
          />
          <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Overridden — the calculated markup/margin value above will not be used.
          </span>
        </label>
      ) : null}

      <button type="button" onClick={onToggleAdvanced} className="self-start text-sm font-medium text-zinc-700 underline underline-offset-4 dark:text-zinc-300">
        {showAdvanced ? "Hide advanced pricing options" : "Advanced Details — discount, GST, rounding, selling expenses"}
      </button>

      {showAdvanced ? (
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Discount type</span>
              <select className={selectClasses} value={value.discountType} onChange={(e) => set("discountType", e.target.value as PricingState["discountType"])}>
                <option value="NONE">No discount</option>
                <option value="PERCENT">Percentage</option>
                <option value="FIXED">Fixed amount</option>
              </select>
            </label>
            {value.discountType !== "NONE" ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Discount value</span>
                <input type="number" step="0.01" min="0" className={inputClasses} value={value.discountValue} onChange={(e) => set("discountValue", e.target.value)} />
              </label>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">GST</span>
              <select className={selectClasses} value={value.gstTreatment} onChange={(e) => set("gstTreatment", e.target.value as PricingState["gstTreatment"])}>
                <option value="NONE">No GST</option>
                <option value="CGST_SGST">CGST + SGST</option>
                <option value="IGST">IGST</option>
              </select>
            </label>
            {value.gstTreatment !== "NONE" ? (
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">GST rate</span>
                <select className={selectClasses} value={value.gstRateId} onChange={(e) => set("gstRateId", e.target.value)}>
                  <option value="">Choose a rate…</option>
                  {gstRates.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label} ({g.ratePercent}%)
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {value.gstTreatment !== "NONE" ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Customer price shown as</span>
              <select className={selectClasses} value={value.priceType} onChange={(e) => set("priceType", e.target.value as PricingState["priceType"])}>
                <option value="EXCLUSIVE">Tax-exclusive (GST added on top)</option>
                <option value="INCLUSIVE">Tax-inclusive (GST already included)</option>
              </select>
            </label>
          ) : null}

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Round customer total to nearest (₹)</span>
            <input type="number" step="0.01" min="0" className={inputClasses} value={value.roundingStep} onChange={(e) => set("roundingStep", e.target.value)} />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Fixed selling expense (₹)</span>
              <input type="number" step="0.01" min="0" className={inputClasses} value={value.sellingExpenseFixed} onChange={(e) => set("sellingExpenseFixed", e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Selling expense % (e.g. commission)</span>
              <input type="number" step="0.001" min="0" max="100" className={inputClasses} value={value.sellingExpensePercent} onChange={(e) => set("sellingExpensePercent", e.target.value)} />
            </label>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Quotation terms (shown to customer)</span>
            <textarea rows={2} className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={value.quotationTerms} onChange={(e) => set("quotationTerms", e.target.value)} />
          </label>
        </div>
      ) : null}

      <input type="hidden" name="pricingMethod" value={value.pricingMethod} />
      <input type="hidden" name="markupPercent" value={value.markupPercent} />
      <input type="hidden" name="targetMarginPercent" value={value.targetMarginPercent} />
      <input type="hidden" name="manualSellingPriceOverride" value={value.useManualOverride ? value.manualSellingPriceOverride : ""} />
      <input type="hidden" name="discountType" value={value.discountType} />
      <input type="hidden" name="discountValue" value={value.discountValue} />
      <input type="hidden" name="gstTreatment" value={value.gstTreatment} />
      <input type="hidden" name="gstRateId" value={value.gstRateId} />
      <input type="hidden" name="priceType" value={value.priceType} />
      <input type="hidden" name="roundingStep" value={value.roundingStep} />
      <input type="hidden" name="sellingExpenseFixed" value={value.sellingExpenseFixed} />
      <input type="hidden" name="sellingExpensePercent" value={value.sellingExpensePercent} />
      <input type="hidden" name="quotationTerms" value={value.quotationTerms} />
    </div>
  );
}
