function money(value: number) {
  return `₹${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function Row({ label, value, bold, muted }: { label: string; value: string; bold?: boolean; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-1.5 ${bold ? "border-t border-[var(--border)] pt-2 font-semibold" : ""}`}>
      <span className={`text-sm ${muted ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-700 dark:text-zinc-300"}`}>{label}</span>
      <span className={`text-sm ${bold ? "text-zinc-900 dark:text-zinc-50" : "text-zinc-800 dark:text-zinc-200"}`}>{value}</span>
    </div>
  );
}

export function CalculationSummary({
  metalCost,
  diamondCost,
  otherMaterialCost,
  labourCost,
  additionalChargesCost,
  totals,
  isManualOverride,
  targetLabel,
}: {
  metalCost: number;
  diamondCost: number;
  otherMaterialCost: number;
  labourCost: number;
  additionalChargesCost: number;
  totals: {
    productionCost: number;
    sellingValueBeforeDiscount: number;
    discountAmount: number;
    taxableSellingValue: number;
    gstAmount: number;
    customerTotalBeforeRounding: number;
    roundingAdjustment: number;
    customerTotal: number;
    sellingExpenseAmount: number;
    netRealization: number;
    estimatedProfit: number;
    profitMarginPercent: number;
  };
  isManualOverride?: boolean;
  targetLabel?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
      <h3 className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">Calculation summary</h3>
      <Row label="Metal cost" value={money(metalCost)} />
      <Row label="Diamond cost" value={money(diamondCost)} />
      <Row label="Other-material cost" value={money(otherMaterialCost)} />
      <Row label="Labour cost" value={money(labourCost)} />
      <Row label="Additional manufacturing charges" value={money(additionalChargesCost)} />
      <Row label="Total production cost" value={money(totals.productionCost)} bold />
      <Row
        label={isManualOverride ? "Selling value (manually set — overridden)" : "Suggested selling value before discount"}
        value={money(totals.sellingValueBeforeDiscount)}
      />
      <Row label="Discount" value={`- ${money(totals.discountAmount)}`} />
      <Row label="Taxable selling value" value={money(totals.taxableSellingValue)} />
      <Row label="GST" value={money(totals.gstAmount)} />
      {totals.roundingAdjustment !== 0 ? <Row label="Rounding adjustment" value={money(totals.roundingAdjustment)} muted /> : null}
      <Row label="Customer total" value={money(totals.customerTotal)} bold />
      <Row label="Estimated selling expenses" value={`- ${money(totals.sellingExpenseAmount)}`} />
      <Row label="Net realization" value={money(totals.netRealization)} />
      <Row label="Estimated profit" value={money(totals.estimatedProfit)} bold />
      <Row label={targetLabel ? `Profit margin (target was ${targetLabel})` : "Profit margin"} value={`${totals.profitMarginPercent.toFixed(2)}%`} />
    </div>
  );
}
