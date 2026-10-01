import { summariseRate, type MetalRateBasisValue } from "@/lib/jewellery/metalRates";

function rupees(value: string) {
  const [whole, frac = ""] = value.split(".");
  return `₹${Number(whole).toLocaleString("en-IN")}${frac ? `.${frac}` : ""}`;
}

/**
 * ₹/gross-gram and ₹/fine-gram implied by a total, shown together with the
 * entered rate basis, gross weight, fineness, fine weight and total —
 * regardless of which basis was used to derive it. Shared by the Opening
 * Metal Stock and Metal Purchase forms so a rate entered on one basis never
 * hides what it implies on the other: the exact number that went unnoticed in
 * the original opening-stock defect (D-1).
 */
export function EffectiveRates({
  basis,
  grossWeight,
  finenessPercent,
  total,
}: {
  basis: MetalRateBasisValue;
  grossWeight: string;
  finenessPercent: string;
  total: string;
}) {
  const s = summariseRate({ basis, grossWeight: grossWeight || "0", finenessPercent: finenessPercent || "0", total: total || "0" });
  if (!s) return null;
  return (
    <dl
      data-testid="effective-rates"
      className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-zinc-700 sm:grid-cols-4 dark:text-zinc-300"
    >
      <div className="col-span-2 sm:col-span-4">
        <dt className="inline text-zinc-500 dark:text-zinc-400">Rate basis that will be saved: </dt>
        <dd className="inline font-semibold" data-testid="effective-rates-basis">
          {s.basisLabel}
        </dd>
      </div>
      <div>
        <dt className="text-zinc-500 dark:text-zinc-400">Gross weight</dt>
        <dd className="font-medium tabular-nums">{s.grossWeight} g</dd>
      </div>
      <div>
        <dt className="text-zinc-500 dark:text-zinc-400">Fineness</dt>
        <dd className="font-medium tabular-nums">{s.finenessPercent}%</dd>
      </div>
      <div>
        <dt className="text-zinc-500 dark:text-zinc-400">Fine weight</dt>
        <dd className="font-medium tabular-nums">{s.fineWeight} g</dd>
      </div>
      <div>
        <dt className="text-zinc-500 dark:text-zinc-400">Total amount</dt>
        <dd className="font-medium tabular-nums" data-testid="effective-rates-total">
          {rupees(s.total)}
        </dd>
      </div>
      <div className="col-span-2">
        <dt className="text-zinc-500 dark:text-zinc-400">₹ per gross gram</dt>
        <dd className="font-medium tabular-nums" data-testid="effective-rates-gross">
          {s.perGrossGram === null ? "—" : rupees(s.perGrossGram)}
        </dd>
      </div>
      <div className="col-span-2">
        <dt className="text-zinc-500 dark:text-zinc-400">₹ per fine gram</dt>
        <dd className="font-medium tabular-nums" data-testid="effective-rates-fine">
          {s.perFineGram === null ? "— (0% fine metal)" : rupees(s.perFineGram)}
        </dd>
      </div>
    </dl>
  );
}
