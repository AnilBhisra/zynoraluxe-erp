"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import type { VoucherFormState } from "@/app/actions/vouchers";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import { previewLineTotals, suggestGstTreatment, type GstTreatment } from "@/lib/accounting/previewMath";
import { useFieldId } from "@/lib/utils/useFieldId";

type PaymentAccountOption = { id: string; name: string; method: string };
type GstRateOption = { id: string; label: string; ratePercent: string };

type LineDraft = {
  description: string;
  hsnSac: string;
  quantity: string;
  unit: "PCS" | "CT" | "GRAM" | "OTHER";
  rate: string;
  discount: string;
  gstRateId: string;
  taxType: "EXCLUSIVE" | "INCLUSIVE";
};

function emptyLine(defaultGstRateId: string): LineDraft {
  return {
    description: "",
    hsnSac: "",
    quantity: "1",
    unit: "PCS",
    rate: "",
    discount: "0",
    gstRateId: defaultGstRateId,
    taxType: "EXCLUSIVE",
  };
}

function formatMoney(n: number) {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function InvoiceVoucherForm({
  voucherType,
  action,
  parties,
  paymentAccounts,
  gstRates,
  companyStateCode,
  onDone,
}: {
  voucherType: "PURCHASE" | "SALE";
  action: (state: VoucherFormState, formData: FormData) => Promise<VoucherFormState>;
  parties: PartyOption[];
  paymentAccounts: PaymentAccountOption[];
  gstRates: GstRateOption[];
  companyStateCode: string | null;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const defaultGstRateId = gstRates[0]?.id ?? "";
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(defaultGstRateId)]);
  const [partyId, setPartyId] = useState("");
  const [gstTreatment, setGstTreatment] = useState<GstTreatment | "NONE">("NONE");
  const [confirmOutsideFy, setConfirmOutsideFy] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const paymentAccountId = useFieldId();
  const gstTreatmentSelectId = useFieldId();

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const selectedParty = parties.find((p) => p.id === partyId) ?? null;
  const suggestion = suggestGstTreatment(companyStateCode, selectedParty?.stateCode ?? null);

  const rateByGstRateId = useMemo(
    () => new Map(gstRates.map((r) => [r.id, Number(r.ratePercent)])),
    [gstRates]
  );

  const totals = useMemo(() => {
    let taxable = 0;
    let tax = 0;
    for (const line of lines) {
      const quantity = Number(line.quantity) || 0;
      const rate = Number(line.rate) || 0;
      const discount = Number(line.discount) || 0;
      const gstRatePercent = rateByGstRateId.get(line.gstRateId) ?? 0;
      if (quantity <= 0 || rate < 0) continue;
      const result = previewLineTotals({ quantity, rate, discount, gstRatePercent, taxType: line.taxType });
      taxable += result.taxableValue;
      tax += result.taxAmount;
    }
    return { taxable, tax, total: taxable + tax };
  }, [lines, rateByGstRateId]);

  function updateLine(index: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine(defaultGstRateId)]);
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!window.confirm(`Save this ${voucherType === "PURCHASE" ? "purchase" : "sale"} for ${formatMoney(totals.total)}?`)) {
      event.preventDefault();
    }
  }

  const label = voucherType === "PURCHASE" ? "Purchase" : "Sale";

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="linesJson" value={JSON.stringify(lines)} />
      <input type="hidden" name="gstTreatment" value={gstTreatment} />
      <input type="hidden" name="currencyCode" value="INR" />
      <input type="hidden" name="exchangeRate" value="1" />
      <input type="hidden" name="confirmOutsideFy" value={confirmOutsideFy ? "true" : "false"} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? (
        <Alert tone="success">{label} saved as {state.voucherNumber}.</Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Date" name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
        <PartySelect name="partyId" parties={parties} onChange={setPartyId} required />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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

        <div className="flex flex-col gap-1.5">
          <label htmlFor={gstTreatmentSelectId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            GST
          </label>
          <select
            id={gstTreatmentSelectId}
            value={gstTreatment}
            onChange={(e) => setGstTreatment(e.target.value as GstTreatment)}
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="NONE">No GST</option>
            <option value="CGST_SGST">CGST + SGST (within state)</option>
            <option value="IGST">IGST (different state)</option>
          </select>
          {suggestion && suggestion !== gstTreatment ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Based on state codes, this looks like it should be{" "}
              {suggestion === "CGST_SGST" ? "CGST + SGST" : "IGST"}.
            </p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Items</h3>
        {lines.map((line, index) => {
          const quantity = Number(line.quantity) || 0;
          const rate = Number(line.rate) || 0;
          const discount = Number(line.discount) || 0;
          const gstRatePercent = rateByGstRateId.get(line.gstRateId) ?? 0;
          const lineTotal =
            quantity > 0 && rate >= 0
              ? previewLineTotals({ quantity, rate, discount, gstRatePercent, taxType: line.taxType }).lineTotal
              : 0;

          return (
            <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
                <input
                  aria-label="Description"
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) => updateLine(index, { description: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm sm:col-span-2 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <input
                  aria-label="Quantity"
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="Qty"
                  value={line.quantity}
                  onChange={(e) => updateLine(index, { quantity: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <select
                  aria-label="Unit"
                  value={line.unit}
                  onChange={(e) => updateLine(index, { unit: e.target.value as LineDraft["unit"] })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  <option value="PCS">PCS</option>
                  <option value="CT">CT</option>
                  <option value="GRAM">GRAM</option>
                  <option value="OTHER">OTHER</option>
                </select>
                <input
                  aria-label="Rate"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Rate"
                  value={line.rate}
                  onChange={(e) => updateLine(index, { rate: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <select
                  aria-label="GST rate"
                  value={line.gstRateId}
                  onChange={(e) => updateLine(index, { gstRateId: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  {gstRates.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                  <input
                    type="checkbox"
                    checked={line.taxType === "INCLUSIVE"}
                    onChange={(e) => updateLine(index, { taxType: e.target.checked ? "INCLUSIVE" : "EXCLUSIVE" })}
                    className="h-3.5 w-3.5 rounded border-zinc-300"
                  />
                  Rate includes GST
                </label>
                <input
                  aria-label="Discount"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Discount"
                  value={line.discount}
                  onChange={(e) => updateLine(index, { discount: e.target.value })}
                  className="h-8 w-28 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <input
                  aria-label="HSN/SAC"
                  placeholder="HSN/SAC (optional)"
                  value={line.hsnSac}
                  onChange={(e) => updateLine(index, { hsnSac: e.target.value })}
                  className="h-8 w-40 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <span className="ml-auto text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                  {formatMoney(lineTotal)}
                </span>
                {lines.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeLine(index)}
                    className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        <Button type="button" variant="secondary" size="md" onClick={addLine} className="self-start">
          + Add another item
        </Button>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide advanced details" : "More details (reference, note)"}
        </button>
      </div>

      {showMore ? (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
          <Field label="Bill/reference number" name="referenceNumber" />
          <Field label="Note" name="note" />
          <label className="col-span-full flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={confirmOutsideFy}
              onChange={(e) => setConfirmOutsideFy(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300"
            />
            This date is outside the current financial year and I confirm that&apos;s intentional
          </label>
        </div>
      ) : null}

      <div className="flex items-center justify-between rounded-xl bg-zinc-900 px-4 py-3 text-white dark:bg-amber-200 dark:text-zinc-900">
        <span className="text-sm">Total</span>
        <span className="text-lg font-semibold">{formatMoney(totals.total)}</span>
      </div>

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Saving…" : `Save ${label.toLowerCase()}`}
      </Button>
    </form>
  );
}
