"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import { createMetalPurchase } from "@/app/actions/metal";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import type { MetalPurityOption } from "@/components/jewellery/ReceiveFinishedForm";
import { EffectiveRates } from "@/components/jewellery/EffectiveRates";
import { RATE_BASIS_LABEL, RATE_INPUT_LABEL, fineWeightOf, summariseRate, totalFromRate } from "@/lib/jewellery/metalRates";
import { useFieldId } from "@/lib/utils/useFieldId";

type PaymentAccountOption = { id: string; name: string; method: string };
type GstRateOption = { id: string; label: string; ratePercent: string };

function formatMoney(n: number) {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function MetalPurchaseForm({
  suppliers,
  purities,
  paymentAccounts,
  gstRates,
  onDone,
}: {
  suppliers: PartyOption[];
  purities: MetalPurityOption[];
  paymentAccounts: PaymentAccountOption[];
  gstRates: GstRateOption[];
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(createMetalPurchase, undefined);
  const [metalType, setMetalType] = useState(purities[0]?.metalType ?? "GOLD");
  const [purityId, setPurityId] = useState(purities[0]?.id ?? "");
  const [grossWeight, setGrossWeight] = useState("");
  const [rateBasis, setRateBasis] = useState<"PER_GROSS_GRAM" | "PER_FINE_GRAM" | "FIXED_TOTAL">("PER_GROSS_GRAM");
  const [rate, setRate] = useState("");
  const [totalPurchaseCostOverride, setTotalPurchaseCostOverride] = useState("");
  const [totalTouched, setTotalTouched] = useState(false);
  const [gstTreatment, setGstTreatment] = useState<"NONE" | "CGST_SGST" | "IGST">("NONE");
  const [gstRateId, setGstRateId] = useState(gstRates[0]?.id ?? "");
  const [showMore, setShowMore] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const metalTypeId = useFieldId();
  const purityIdFieldId = useFieldId();
  const rateBasisId = useFieldId();
  const gstTreatmentId = useFieldId();
  const gstRateIdFieldId = useFieldId();
  const paymentAccountId = useFieldId();

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const purityOptions = purities.filter((p) => p.metalType === metalType);
  const purity = purities.find((p) => p.id === purityId);
  // Exact fixed-point, the server's own rounding — never floating point.
  const fineWeightText = purity ? (fineWeightOf(grossWeight || "0", purity.finenessPercent) ?? "0.000") : "0.000";
  const fineWeight = Number(fineWeightText);
  const suggestedTotal = totalFromRate({ basis: rateBasis, rate: rate || "0", grossWeight: grossWeight || "0", fineWeight: fineWeightText }) ?? "0.00";

  const totalPurchaseCost = totalTouched ? totalPurchaseCostOverride : Number(suggestedTotal) > 0 ? suggestedTotal : "";
  const summary = summariseRate({ basis: rateBasis, grossWeight: grossWeight || "0", finenessPercent: purity?.finenessPercent ?? "0", total: totalPurchaseCost || "0" });

  const rateByGstRateId = useMemo(() => new Map(gstRates.map((r) => [r.id, Number(r.ratePercent)])), [gstRates]);
  const gstRatePercent = gstTreatment === "NONE" ? 0 : rateByGstRateId.get(gstRateId) ?? 0;
  const cost = Number(totalPurchaseCost) || 0;
  const taxAmount = Math.round(cost * (gstRatePercent / 100) * 100) / 100;
  const payable = cost + taxAmount;

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    const rateLine = summary
      ? `Rate basis saved: ${RATE_BASIS_LABEL[rateBasis]}${rateBasis === "FIXED_TOTAL" ? "" : ` at ₹${rate}`}\n= ₹${summary.perGrossGram ?? "—"} per gross gram / ₹${summary.perFineGram ?? "—"} per fine gram\n`
      : "";
    if (
      !window.confirm(
        `Save this metal purchase?\n${(Number(grossWeight) || 0).toFixed(3)}g gross × ${purity?.finenessPercent ?? "?"}% = ${fineWeight.toFixed(3)}g fine\n${rateLine}Total ${formatMoney(cost)}${taxAmount > 0 ? ` + GST ${formatMoney(taxAmount)}` : ""} = payable ${formatMoney(payable)}${totalTouched ? "\n(Total was typed manually.)" : ""}`
      )
    ) {
      event.preventDefault();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="metalType" value={metalType} />
      <input type="hidden" name="purityId" value={purityId} />
      <input type="hidden" name="gstTreatment" value={gstTreatment} />
      <input type="hidden" name="gstRateId" value={gstTreatment === "NONE" ? "" : gstRateId} />
      <input type="hidden" name="gstRatePercent" value={String(gstRatePercent)} />
      <input type="hidden" name="currencyCode" value="INR" />
      <input type="hidden" name="exchangeRate" value="1" />
      <input type="hidden" name="totalManuallyEdited" value={totalTouched ? "true" : "false"} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Metal purchase saved as {state.code}.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Purchase date" name="purchaseDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
        <PartySelect name="supplierId" parties={suppliers} label="Supplier" required />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={metalTypeId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Metal
          </label>
          <select
            id={metalTypeId}
            value={metalType}
            onChange={(e) => {
              const nextPurity = purities.find((p) => p.metalType === e.target.value)?.id ?? "";
              setMetalType(e.target.value);
              setPurityId(nextPurity);
            }}
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            {[...new Set(purities.map((p) => p.metalType))].map((mt) => (
              <option key={mt} value={mt}>
                {mt}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={purityIdFieldId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Purity
          </label>
          <select
            id={purityIdFieldId}
            value={purityId}
            onChange={(e) => setPurityId(e.target.value)}
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            {purityOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName} ({p.finenessPercent}%)
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Gross weight (g)"
          name="grossWeight"
          type="number"
          step="0.001"
          min={0}
          value={grossWeight}
          onChange={(e) => setGrossWeight(e.target.value)}
          required
        />
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Fine weight (automatic): <span className="font-semibold text-zinc-700 dark:text-zinc-300">{fineWeightText}g</span>
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={rateBasisId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Rate basis
          </label>
          <select
            id={rateBasisId}
            value={rateBasis}
            onChange={(e) => setRateBasis(e.target.value as typeof rateBasis)}
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="PER_GROSS_GRAM">Per gross gram</option>
            <option value="PER_FINE_GRAM">Per fine gram</option>
            <option value="FIXED_TOTAL">Fixed total</option>
          </select>
          <p className="text-xs text-zinc-500 dark:text-zinc-400" data-testid="rate-basis-hint">
            {rateBasis === "PER_GROSS_GRAM"
              ? "Rate × full (gross) weight. / આખા વજન પર ભાવ."
              : rateBasis === "PER_FINE_GRAM"
                ? "Rate × pure (fine) weight only. / ફક્ત શુદ્ધ (fine) વજન પર ભાવ."
                : "One total amount for the whole lot. / આખા માલનો એક જ ભાવ."}
          </p>
        </div>
        <input type="hidden" name="rateBasis" value={rateBasis} />
        <Field
          label={RATE_INPUT_LABEL[rateBasis]}
          name="rate"
          type="number"
          step="0.01"
          min={0}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          required
        />
        <Field
          label="Total purchase cost (₹)"
          name="totalPurchaseCost"
          type="number"
          step="0.01"
          min={0}
          value={totalPurchaseCost}
          onChange={(e) => {
            setTotalPurchaseCostOverride(e.target.value);
            setTotalTouched(true);
          }}
          hint={totalTouched ? "Manually edited — not from the rate" : "Calculated automatically from the rate"}
        />
      </div>
      <EffectiveRates basis={rateBasis} grossWeight={grossWeight} finenessPercent={purity?.finenessPercent ?? "0"} total={totalPurchaseCost} />

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide more details" : "More details (GST, payment, invoice reference)"}
        </button>
      </div>

      {/* Kept mounted while hidden: a collapsed section must never drop what was typed into it. */}
      <div hidden={!showMore} data-testid="purchase-more-details">
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={gstTreatmentId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              GST
            </label>
            <select
              id={gstTreatmentId}
              value={gstTreatment}
              onChange={(e) => setGstTreatment(e.target.value as typeof gstTreatment)}
              className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              <option value="NONE">No GST</option>
              <option value="CGST_SGST">CGST + SGST (within state)</option>
              <option value="IGST">IGST (different state)</option>
            </select>
          </div>
          {gstTreatment !== "NONE" ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={gstRateIdFieldId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                GST rate
              </label>
              <select
                id={gstRateIdFieldId}
                value={gstRateId}
                onChange={(e) => setGstRateId(e.target.value)}
                className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              >
                {gstRates.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={paymentAccountId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Payment
            </label>
            <select
              id={paymentAccountId}
              name="paymentAccountId"
              defaultValue=""
              className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              <option value="">Credit (pay later)</option>
              {paymentAccounts.map((pa) => (
                <option key={pa.id} value={pa.id}>
                  Paid now — {pa.name}
                </option>
              ))}
            </select>
          </div>
          <Field label="Supplier bill / reference (optional)" name="referenceNumber" />
          <Field label="Notes (optional)" name="notes" className="sm:col-span-2" />
        </div>
      </div>

      <div className="flex items-center justify-between rounded-xl bg-zinc-900 px-4 py-3 text-white dark:bg-amber-200 dark:text-zinc-900">
        <span className="text-sm">Payable ({(Number(grossWeight) || 0).toFixed(3)}g gross)</span>
        <span className="text-lg font-semibold">{formatMoney(payable)}</span>
      </div>

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Save metal purchase"}
      </Button>
    </form>
  );
}
