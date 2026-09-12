"use client";

import { useActionState, useEffect, useMemo, useState, useTransition } from "react";

import { createFinishedJewellerySaleAction, getSuggestedSalePriceAction } from "@/app/actions/finishedSales";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import { previewLineTotals, suggestGstTreatment, type GstTreatment } from "@/lib/accounting/previewMath";
import { useFieldId } from "@/lib/utils/useFieldId";
import { jewelleryTypeLabel } from "@/lib/jewellery/types";
import type { SerializedFinishedStockRow } from "@/components/jewellery/FinishedStockTab";

type GstRateOption = { id: string; label: string; ratePercent: string };
type PaymentAccountOption = { id: string; name: string; method: string };

type SaleLineDraft = {
  finishedJewelleryId: string;
  sellingPrice: string;
  discountShare: string;
  gstRateId: string;
  taxType: "EXCLUSIVE" | "INCLUSIVE";
};

function formatMoney(n: number) {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function itemLabel(item: SerializedFinishedStockRow) {
  return `${item.finishedCode} — ${jewelleryTypeLabel(item.jewelleryType)} (${item.designName}) — ${item.metalType} ${item.purityDisplayName}, ${item.netMetalWeight}g${item.diamondCount > 0 ? `, ${item.diamondCount} diamond(s) ${item.totalCarat}ct` : ""}`;
}

export function FinishedJewellerySaleForm({
  customers,
  availableItems,
  paymentAccounts,
  gstRates,
  companyStateCode,
  onDone,
}: {
  customers: PartyOption[];
  availableItems: SerializedFinishedStockRow[];
  paymentAccounts: PaymentAccountOption[];
  gstRates: GstRateOption[];
  companyStateCode: string | null;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(createFinishedJewellerySaleAction, undefined);
  const defaultGstRateId = gstRates[0]?.id ?? "";
  const [partyId, setPartyId] = useState("");
  const [gstTreatment, setGstTreatment] = useState<GstTreatment | "NONE">("NONE");
  const [lines, setLines] = useState<SaleLineDraft[]>([]);
  const [pickerSearch, setPickerSearch] = useState("");
  const [confirmOutsideFy, setConfirmOutsideFy] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [suggestions, setSuggestions] = useState<Record<string, { suggestedPrice: string; costingNumber: string } | null>>({});
  const [, startTransition] = useTransition();
  const paymentAccountFieldId = useFieldId();
  const gstTreatmentSelectId = useFieldId();

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const itemById = useMemo(() => new Map(availableItems.map((i) => [i.id, i])), [availableItems]);
  const selectedIds = useMemo(() => new Set(lines.map((l) => l.finishedJewelleryId)), [lines]);
  const pickerOptions = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase();
    return availableItems.filter((i) => {
      if (selectedIds.has(i.id)) return false;
      if (!q) return true;
      return (
        i.finishedCode.toLowerCase().includes(q) ||
        i.designName.toLowerCase().includes(q) ||
        i.jobCode.toLowerCase().includes(q)
      );
    });
  }, [availableItems, selectedIds, pickerSearch]);

  const selectedParty = customers.find((p) => p.id === partyId) ?? null;
  const suggestion = suggestGstTreatment(companyStateCode, selectedParty?.stateCode ?? null);

  const rateByGstRateId = useMemo(() => new Map(gstRates.map((r) => [r.id, Number(r.ratePercent)])), [gstRates]);

  function addItem(id: string) {
    if (!id || selectedIds.has(id)) return;
    setLines((prev) => [
      ...prev,
      { finishedJewelleryId: id, sellingPrice: "", discountShare: "0", gstRateId: defaultGstRateId, taxType: "EXCLUSIVE" },
    ]);
    setPickerSearch("");
    startTransition(async () => {
      const s = await getSuggestedSalePriceAction(id);
      setSuggestions((prev) => ({ ...prev, [id]: s }));
    });
  }

  function updateLine(index: number, patch: Partial<SaleLineDraft>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  const totals = useMemo(() => {
    let taxable = 0;
    let tax = 0;
    for (const line of lines) {
      const rate = Number(line.sellingPrice) || 0;
      const discount = Number(line.discountShare) || 0;
      const gstRatePercent = rateByGstRateId.get(line.gstRateId) ?? 0;
      if (rate <= 0) continue;
      const result = previewLineTotals({ quantity: 1, rate, discount, gstRatePercent, taxType: line.taxType });
      taxable += result.taxableValue;
      tax += result.taxAmount;
    }
    return { taxable, tax, total: taxable + tax };
  }, [lines, rateByGstRateId]);

  const itemsJson = useMemo(
    () =>
      JSON.stringify(
        lines.map((l) => ({
          finishedJewelleryId: l.finishedJewelleryId,
          sellingPrice: l.sellingPrice,
          discountShare: l.discountShare,
          gstRateId: l.gstRateId,
          gstRatePercent: rateByGstRateId.get(l.gstRateId) ?? 0,
          taxType: l.taxType,
        }))
      ),
    [lines, rateByGstRateId]
  );

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (lines.length === 0) {
      event.preventDefault();
      return;
    }
    if (lines.some((l) => !(Number(l.sellingPrice) > 0))) {
      event.preventDefault();
      window.alert("Enter a selling price greater than zero for every selected piece.");
      return;
    }
    if (
      !window.confirm(
        `Sell ${lines.length} piece${lines.length === 1 ? "" : "s"} to ${selectedParty?.name ?? "this customer"} for ${formatMoney(totals.total)}?`
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
      <input type="hidden" name="itemsJson" value={itemsJson} />
      <input type="hidden" name="gstTreatment" value={gstTreatment} />
      <input type="hidden" name="confirmOutsideFy" value={confirmOutsideFy ? "true" : "false"} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Sale saved as {state.code}.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Date" name="saleDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
        <PartySelect name="customerId" label="Customer" parties={customers} onChange={setPartyId} required />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={paymentAccountFieldId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Payment
          </label>
          <select
            id={paymentAccountFieldId}
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
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Select finished piece(s)</h3>
        <input
          type="text"
          value={pickerSearch}
          onChange={(e) => setPickerSearch(e.target.value)}
          placeholder="Search Available stock by stock #, design or job…"
          className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <select
          aria-label="Add a piece"
          value=""
          onChange={(e) => addItem(e.target.value)}
          className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <option value="">
            {pickerOptions.length === 0 ? "No matching Available pieces" : "Choose a piece to add…"}
          </option>
          {pickerOptions.map((i) => (
            <option key={i.id} value={i.id}>
              {itemLabel(i)}
            </option>
          ))}
        </select>

        {lines.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No pieces selected yet.</p>
        ) : (
          lines.map((line, index) => {
            const item = itemById.get(line.finishedJewelleryId);
            const rate = Number(line.sellingPrice) || 0;
            const discount = Number(line.discountShare) || 0;
            const gstRatePercent = rateByGstRateId.get(line.gstRateId) ?? 0;
            const lineTotal =
              rate > 0 ? previewLineTotals({ quantity: 1, rate, discount, gstRatePercent, taxType: line.taxType }).lineTotal : 0;
            const suggested = suggestions[line.finishedJewelleryId];

            return (
              <div key={line.finishedJewelleryId} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    {item?.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={item.photoUrl} alt="" className="h-10 w-10 rounded object-cover" />
                    ) : null}
                    <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                      {item ? itemLabel(item) : line.finishedJewelleryId}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeLine(index)}
                    className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                  >
                    Remove
                  </button>
                </div>
                {suggested !== undefined && suggested !== null ? (
                  <button
                    type="button"
                    onClick={() => updateLine(index, { sellingPrice: suggested.suggestedPrice })}
                    className="mt-2 text-xs text-amber-700 underline dark:text-amber-300"
                  >
                    Use suggested price {formatMoney(Number(suggested.suggestedPrice))} (from {suggested.costingNumber})
                  </button>
                ) : null}
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-4">
                  <input
                    aria-label="Selling price"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Selling price"
                    value={line.sellingPrice}
                    onChange={(e) => updateLine(index, { sellingPrice: e.target.value })}
                    className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                  />
                  <input
                    aria-label="Discount"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Discount"
                    value={line.discountShare}
                    onChange={(e) => updateLine(index, { discountShare: e.target.value })}
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
                  <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={line.taxType === "INCLUSIVE"}
                      onChange={(e) => updateLine(index, { taxType: e.target.checked ? "INCLUSIVE" : "EXCLUSIVE" })}
                      className="h-3.5 w-3.5 rounded border-zinc-300"
                    />
                    Price includes GST
                  </label>
                </div>
                <p className="mt-2 text-right text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                  {formatMoney(lineTotal)}
                </p>
              </div>
            );
          })
        )}
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
        <span className="text-sm">Total ({lines.length} piece{lines.length === 1 ? "" : "s"})</span>
        <span className="text-lg font-semibold">{formatMoney(totals.total)}</span>
      </div>

      <Button type="submit" size="lg" disabled={pending || lines.length === 0} className="self-start">
        {pending ? "Saving…" : "Save sale"}
      </Button>
    </form>
  );
}
