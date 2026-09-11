"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import { createRoughPurchase } from "@/app/actions/diamond";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import { PhotoUploadField } from "@/components/diamond/PhotoUploadField";

type PaymentAccountOption = { id: string; name: string; method: string };
type GstRateOption = { id: string; label: string; ratePercent: string };

type PieceDraft = {
  carat: string;
  lengthMm: string;
  widthMm: string;
  heightMm: string;
  colorEstimate: string;
  clarityNote: string;
  internalNote: string;
  manualAllocatedCost: string;
  photoAssetId: string | null;
};

function emptyPiece(): PieceDraft {
  return {
    carat: "",
    lengthMm: "",
    widthMm: "",
    heightMm: "",
    colorEstimate: "",
    clarityNote: "",
    internalNote: "",
    manualAllocatedCost: "",
    photoAssetId: null,
  };
}

function formatMoney(n: number) {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function RoughPurchaseForm({
  suppliers,
  paymentAccounts,
  gstRates,
  canOverrideCost,
  onDone,
}: {
  suppliers: PartyOption[];
  paymentAccounts: PaymentAccountOption[];
  gstRates: GstRateOption[];
  canOverrideCost: boolean;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(createRoughPurchase, undefined);
  const [pieces, setPieces] = useState<PieceDraft[]>([emptyPiece()]);
  const [totalPurchaseCost, setTotalPurchaseCost] = useState("");
  const [gstTreatment, setGstTreatment] = useState<"NONE" | "CGST_SGST" | "IGST">("NONE");
  const [gstRateId, setGstRateId] = useState(gstRates[0]?.id ?? "");
  const [useManualCosts, setUseManualCosts] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [lotPhotoAssetId, setLotPhotoAssetId] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const rateByGstRateId = useMemo(() => new Map(gstRates.map((r) => [r.id, Number(r.ratePercent)])), [gstRates]);
  const gstRatePercent = gstTreatment === "NONE" ? 0 : rateByGstRateId.get(gstRateId) ?? 0;

  const totalCarat = pieces.reduce((sum, p) => sum + (Number(p.carat) || 0), 0);
  const manualCostSum = pieces.reduce((sum, p) => sum + (Number(p.manualAllocatedCost) || 0), 0);
  const cost = Number(totalPurchaseCost) || 0;
  const taxAmount = round2(cost * (gstRatePercent / 100));
  const payable = cost + taxAmount;

  function round2(n: number) {
    return Math.round(n * 100) / 100;
  }

  function updatePiece(index: number, patch: Partial<PieceDraft>) {
    setPieces((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }
  function addPiece() {
    setPieces((prev) => [...prev, emptyPiece()]);
  }
  function removePiece(index: number) {
    setPieces((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!window.confirm(`Save this rough purchase (${totalCarat.toFixed(3)}ct, ${formatMoney(payable)})?`)) {
      event.preventDefault();
    }
  }

  const piecesForSubmit = pieces.map((p) => ({
    carat: p.carat,
    lengthMm: p.lengthMm || undefined,
    widthMm: p.widthMm || undefined,
    heightMm: p.heightMm || undefined,
    colorEstimate: p.colorEstimate || undefined,
    clarityNote: p.clarityNote || undefined,
    internalNote: p.internalNote || undefined,
    manualAllocatedCost: useManualCosts && p.manualAllocatedCost ? p.manualAllocatedCost : undefined,
    photoAssetId: p.photoAssetId || undefined,
  }));

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="piecesJson" value={JSON.stringify(piecesForSubmit)} />
      <input type="hidden" name="gstTreatment" value={gstTreatment} />
      <input type="hidden" name="gstRateId" value={gstTreatment === "NONE" ? "" : gstRateId} />
      <input type="hidden" name="gstRatePercent" value={String(gstRatePercent)} />
      <input type="hidden" name="currencyCode" value="INR" />
      <input type="hidden" name="exchangeRate" value="1" />
      <input type="hidden" name="photoAssetId" value={lotPhotoAssetId ?? ""} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Rough purchase saved as {state.code}.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Purchase date" name="purchaseDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
        <PartySelect name="supplierId" parties={suppliers} label="Supplier" required />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Rate" name="purchaseRate" type="number" step="0.01" min={0} required />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="rateBasis" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Rate basis
          </label>
          <select
            id="rateBasis"
            name="rateBasis"
            defaultValue="PER_CARAT"
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="PER_CARAT">Per carat</option>
            <option value="FIXED_TOTAL">Fixed total</option>
          </select>
        </div>
        <Field
          label="Total purchase cost (₹)"
          name="totalPurchaseCost"
          type="number"
          step="0.01"
          min={0}
          value={totalPurchaseCost}
          onChange={(e) => setTotalPurchaseCost(e.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            Rough pieces ({totalCarat.toFixed(3)}ct total)
          </h3>
          {canOverrideCost ? (
            <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
              <input
                type="checkbox"
                checked={useManualCosts}
                onChange={(e) => setUseManualCosts(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-zinc-300"
              />
              Set each piece&apos;s cost manually (must sum exactly to total cost)
            </label>
          ) : null}
        </div>

        {pieces.map((piece, index) => (
          <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <input
                aria-label="Carat"
                type="number"
                step="0.001"
                min="0"
                placeholder="Carat"
                value={piece.carat}
                onChange={(e) => updatePiece(index, { carat: e.target.value })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <input
                aria-label="Colour estimate"
                placeholder="Colour (optional)"
                value={piece.colorEstimate}
                onChange={(e) => updatePiece(index, { colorEstimate: e.target.value })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <input
                aria-label="Clarity note"
                placeholder="Clarity note (optional)"
                value={piece.clarityNote}
                onChange={(e) => updatePiece(index, { clarityNote: e.target.value })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              {useManualCosts ? (
                <input
                  aria-label="Manual cost"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Cost (₹)"
                  value={piece.manualAllocatedCost}
                  onChange={(e) => updatePiece(index, { manualAllocatedCost: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
              ) : (
                <span className="flex items-center text-xs text-zinc-500 dark:text-zinc-400">
                  Cost allocated automatically by carat
                </span>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <input
                aria-label="Length mm"
                type="number"
                step="0.001"
                placeholder="L (mm)"
                value={piece.lengthMm}
                onChange={(e) => updatePiece(index, { lengthMm: e.target.value })}
                className="h-8 w-24 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <input
                aria-label="Width mm"
                type="number"
                step="0.001"
                placeholder="W (mm)"
                value={piece.widthMm}
                onChange={(e) => updatePiece(index, { widthMm: e.target.value })}
                className="h-8 w-24 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <input
                aria-label="Height mm"
                type="number"
                step="0.001"
                placeholder="H (mm)"
                value={piece.heightMm}
                onChange={(e) => updatePiece(index, { heightMm: e.target.value })}
                className="h-8 w-24 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <input
                aria-label="Internal note"
                placeholder="Internal note (optional)"
                value={piece.internalNote}
                onChange={(e) => updatePiece(index, { internalNote: e.target.value })}
                className="h-8 w-48 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <PhotoUploadField
                category="rough-piece"
                label="Piece photo"
                assetId={piece.photoAssetId}
                onUploaded={(assetId) => updatePiece(index, { photoAssetId: assetId })}
              />
              {pieces.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removePiece(index)}
                  className="ml-auto text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        ))}
        <Button type="button" variant="secondary" size="md" onClick={addPiece} className="self-start">
          + Add another piece
        </Button>
        {useManualCosts && manualCostSum > 0 && cost > 0 && Math.abs(manualCostSum - cost) > 0.01 ? (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Manual piece costs sum to {formatMoney(manualCostSum)}, which must exactly equal the total purchase cost{" "}
            {formatMoney(cost)} — otherwise automatic allocation will be used instead.
          </p>
        ) : null}
      </div>

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

      {showMore ? (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">GST</label>
            <select
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
              <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">GST rate</label>
              <select
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
            <label htmlFor="paymentAccountId" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Payment
            </label>
            <select
              id="paymentAccountId"
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
          <Field label="Supplier invoice / reference" name="supplierInvoiceRef" />
          <Field label="Notes" name="notes" />
          <PhotoUploadField
            category="rough-lot"
            label="Lot photo (optional)"
            assetId={lotPhotoAssetId}
            onUploaded={setLotPhotoAssetId}
          />
        </div>
      ) : null}

      <div className="flex items-center justify-between rounded-xl bg-zinc-900 px-4 py-3 text-white dark:bg-amber-200 dark:text-zinc-900">
        <span className="text-sm">Payable ({totalCarat.toFixed(3)}ct)</span>
        <span className="text-lg font-semibold">{formatMoney(payable)}</span>
      </div>

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Save rough purchase"}
      </Button>
    </form>
  );
}
