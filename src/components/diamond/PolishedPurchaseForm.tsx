"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import { createPolishedPurchaseAction } from "@/app/actions/diamond";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import { STANDARD_SHAPES } from "@/lib/diamond/shapes";

type PaymentAccountOption = { id: string; name: string; method: string };
type GstRateOption = { id: string; label: string; ratePercent: string };
type BrokerageTreatment = "NONE" | "INCLUDED_IN_SUPPLIER_COST" | "CAPITALISED_PAYABLE_TO_BROKER" | "EXPENSED_PAYABLE_TO_BROKER";
type BrokerageMethod = "PER_CARAT" | "PERCENT" | "FIXED";

type LineDraft = {
  shape: string;
  customShapeName: string;
  sizeLabel: string;
  pieces: string;
  carat: string;
  quality: string;
  colour: string;
  lab: string;
  certificateStatus: "NOT_CERTIFIED" | "INTERNAL_GRADE" | "CERTIFIED";
  certNumber: string;
  rateBasis: "PER_CARAT" | "PER_PIECE" | "FIXED_TOTAL";
  rate: string;
};

function emptyLine(): LineDraft {
  return {
    shape: "ROUND",
    customShapeName: "",
    sizeLabel: "",
    pieces: "",
    carat: "",
    quality: "",
    colour: "",
    lab: "",
    certificateStatus: "NOT_CERTIFIED",
    certNumber: "",
    rateBasis: "PER_CARAT",
    rate: "",
  };
}

const INPUT = "h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";
const SELECT =
  "h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
function formatMoney(n: number) {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What a line's own rate implies — a guide for the supplier amount, never the posted figure. */
function lineRateValue(line: LineDraft): number {
  const rate = Number(line.rate) || 0;
  if (line.rateBasis === "PER_CARAT") return rate * (Number(line.carat) || 0);
  if (line.rateBasis === "PER_PIECE") return rate * (Number(line.pieces) || 0);
  return rate;
}

export function PolishedPurchaseForm({
  suppliers,
  brokers,
  paymentAccounts,
  gstRates,
  onDone,
}: {
  suppliers: PartyOption[];
  brokers: PartyOption[];
  paymentAccounts: PaymentAccountOption[];
  gstRates: GstRateOption[];
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(createPolishedPurchaseAction, undefined);
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [supplierAmount, setSupplierAmount] = useState("");
  const [gstTreatment, setGstTreatment] = useState<"NONE" | "CGST_SGST" | "IGST">("NONE");
  const [gstRateId, setGstRateId] = useState(gstRates[0]?.id ?? "");
  const [brokerageTreatment, setBrokerageTreatment] = useState<BrokerageTreatment>("NONE");
  const [brokerageMethod, setBrokerageMethod] = useState<BrokerageMethod>("PERCENT");
  const [brokerageRate, setBrokerageRate] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const rateByGstRateId = useMemo(() => new Map(gstRates.map((r) => [r.id, Number(r.ratePercent)])), [gstRates]);
  const gstRatePercent = gstTreatment === "NONE" ? 0 : rateByGstRateId.get(gstRateId) ?? 0;

  const totalPieces = lines.reduce((sum, l) => sum + (Number(l.pieces) || 0), 0);
  const totalCarat = lines.reduce((sum, l) => sum + (Number(l.carat) || 0), 0);
  const rateTotal = round2(lines.reduce((sum, l) => sum + lineRateValue(l), 0));
  const amount = Number(supplierAmount) || 0;
  const rate = Number(brokerageRate) || 0;
  const brokerage =
    brokerageTreatment === "NONE"
      ? 0
      : round2(brokerageMethod === "PER_CARAT" ? rate * totalCarat : brokerageMethod === "PERCENT" ? (amount * rate) / 100 : rate);
  const gst = round2((amount * gstRatePercent) / 100);
  const landed = round2(amount + (brokerageTreatment === "CAPITALISED_PAYABLE_TO_BROKER" ? brokerage : 0));
  const brokerPayable =
    brokerageTreatment === "CAPITALISED_PAYABLE_TO_BROKER" || brokerageTreatment === "EXPENSED_PAYABLE_TO_BROKER" ? brokerage : 0;

  function updateLine(index: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  const linesForSubmit = lines.map((l) => ({
    shape: l.shape,
    customShapeName: l.shape === "CUSTOM" ? l.customShapeName : undefined,
    sizeLabel: l.sizeLabel,
    pieces: l.pieces,
    carat: l.carat,
    quality: l.quality || undefined,
    colour: l.colour || undefined,
    lab: l.lab || undefined,
    certificateStatus: l.certificateStatus,
    certNumber: l.certNumber || undefined,
    rateBasis: l.rateBasis,
    rate: l.rate || "0",
  }));

  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (!window.confirm(`Save this polished purchase (${totalCarat.toFixed(3)}ct, landed cost ${formatMoney(landed)})?`)) {
          event.preventDefault();
        }
      }}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="linesJson" value={JSON.stringify(linesForSubmit)} />
      <input type="hidden" name="gstTreatment" value={gstTreatment} />
      <input type="hidden" name="gstRateId" value={gstTreatment === "NONE" ? "" : gstRateId} />
      <input type="hidden" name="gstRatePercent" value={String(gstRatePercent)} />
      <input type="hidden" name="currencyCode" value="INR" />
      <input type="hidden" name="exchangeRate" value="1" />
      <input type="hidden" name="brokerageTreatment" value={brokerageTreatment} />
      <input type="hidden" name="brokerageMethod" value={brokerageTreatment === "NONE" ? "" : brokerageMethod} />
      <input type="hidden" name="brokerageRate" value={brokerageTreatment === "NONE" ? "" : brokerageRate} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Polished purchase saved as {state.code}.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Purchase date" name="purchaseDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
        <PartySelect name="supplierId" parties={suppliers} label="Party / Supplier" required />
      </div>

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Packets ({totalPieces} pcs · {totalCarat.toFixed(3)}ct)
        </h3>
        {lines.map((line, index) => (
          <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <select aria-label="Shape" value={line.shape} onChange={(e) => updateLine(index, { shape: e.target.value })} className={INPUT}>
                {STANDARD_SHAPES.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <input aria-label="Size" placeholder="Size (e.g. 1.00-1.20 MM)" value={line.sizeLabel} onChange={(e) => updateLine(index, { sizeLabel: e.target.value })} className={INPUT} />
              <input aria-label="Pieces" type="number" min="1" step="1" placeholder="Pieces" value={line.pieces} onChange={(e) => updateLine(index, { pieces: e.target.value })} className={INPUT} />
              <input aria-label="Carat" type="number" min="0" step="0.001" placeholder="Carat" value={line.carat} onChange={(e) => updateLine(index, { carat: e.target.value })} className={INPUT} />
              {line.shape === "CUSTOM" ? (
                <input aria-label="Custom shape name" placeholder="Custom shape name" value={line.customShapeName} onChange={(e) => updateLine(index, { customShapeName: e.target.value })} className={INPUT} />
              ) : null}
              <input aria-label="Quality" placeholder="Quality (optional)" value={line.quality} onChange={(e) => updateLine(index, { quality: e.target.value })} className={INPUT} />
              <input aria-label="Colour" placeholder="Colour (optional)" value={line.colour} onChange={(e) => updateLine(index, { colour: e.target.value })} className={INPUT} />
              <select aria-label="Certificate" value={line.certificateStatus} onChange={(e) => updateLine(index, { certificateStatus: e.target.value as LineDraft["certificateStatus"] })} className={INPUT}>
                <option value="NOT_CERTIFIED">Not certified</option>
                <option value="INTERNAL_GRADE">Internal grade</option>
                <option value="CERTIFIED">Certified</option>
              </select>
              {line.certificateStatus === "CERTIFIED" ? (
                <>
                  <input aria-label="Lab" placeholder="Lab (e.g. IGI, GIA)" value={line.lab} onChange={(e) => updateLine(index, { lab: e.target.value })} className={INPUT} />
                  <input aria-label="Certificate number" placeholder="Certificate number" value={line.certNumber} onChange={(e) => updateLine(index, { certNumber: e.target.value })} className={INPUT} />
                </>
              ) : null}
              <select aria-label="Rate basis" value={line.rateBasis} onChange={(e) => updateLine(index, { rateBasis: e.target.value as LineDraft["rateBasis"] })} className={INPUT}>
                <option value="PER_CARAT">Rate per carat</option>
                <option value="PER_PIECE">Rate per piece</option>
                <option value="FIXED_TOTAL">Fixed line total</option>
              </select>
              <input aria-label="Rate" type="number" min="0" step="0.01" placeholder="Rate (₹)" value={line.rate} onChange={(e) => updateLine(index, { rate: e.target.value })} className={INPUT} />
            </div>
            {lines.length > 1 ? (
              <button type="button" onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))} className="mt-2 text-xs font-medium text-red-600 hover:underline dark:text-red-400">
                Remove packet
              </button>
            ) : null}
          </div>
        ))}
        <Button type="button" variant="secondary" size="md" onClick={() => setLines((prev) => [...prev, emptyLine()])} className="self-start">
          + Add another packet
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Supplier amount (₹, before GST and brokerage)"
          name="supplierAmount"
          type="number"
          step="0.01"
          min={0}
          value={supplierAmount}
          onChange={(e) => setSupplierAmount(e.target.value)}
          required
        />
        {rateTotal > 0 && amount > 0 && Math.abs(rateTotal - amount) >= 0.01 ? (
          <p className="self-end text-xs font-medium text-amber-700 dark:text-amber-400">
            The packet rates add up to {formatMoney(rateTotal)} — check the supplier amount ({formatMoney(amount)}) before saving.
          </p>
        ) : null}
      </div>

      <fieldset className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Dalal / Broker</legend>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Brokerage</label>
          <select value={brokerageTreatment} onChange={(e) => setBrokerageTreatment(e.target.value as BrokerageTreatment)} className={SELECT}>
            <option value="NONE">No Dalal / Broker</option>
            <option value="INCLUDED_IN_SUPPLIER_COST">Already included in the supplier amount (record only)</option>
            <option value="CAPITALISED_PAYABLE_TO_BROKER">Add to diamond cost, payable to Dalal / Broker</option>
            <option value="EXPENSED_PAYABLE_TO_BROKER">Business expense, payable to Dalal / Broker</option>
          </select>
        </div>
        {brokerageTreatment !== "NONE" ? (
          <>
            <PartySelect name="brokerPartyId" parties={brokers} label="Dalal / Broker" required />
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Brokerage method</label>
              <select value={brokerageMethod} onChange={(e) => setBrokerageMethod(e.target.value as BrokerageMethod)} className={SELECT}>
                <option value="PERCENT">Percentage of supplier amount</option>
                <option value="PER_CARAT">Per carat</option>
                <option value="FIXED">Fixed amount</option>
              </select>
            </div>
            <Field
              label={brokerageMethod === "PERCENT" ? "Brokerage %" : brokerageMethod === "PER_CARAT" ? "Brokerage per carat (₹)" : "Brokerage amount (₹)"}
              name="brokerageRateDisplay"
              type="number"
              step="0.0001"
              min={0}
              value={brokerageRate}
              onChange={(e) => setBrokerageRate(e.target.value)}
            />
            <p className="text-xs text-zinc-600 dark:text-zinc-400 sm:col-span-2">
              Brokerage: <strong>{formatMoney(brokerage)}</strong>
              {brokerageTreatment === "INCLUDED_IN_SUPPLIER_COST" ? " — recorded only; it is not posted again." : ""}
            </p>
          </>
        ) : null}
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">GST</label>
          <select value={gstTreatment} onChange={(e) => setGstTreatment(e.target.value as typeof gstTreatment)} className={SELECT}>
            <option value="NONE">No GST</option>
            <option value="CGST_SGST">CGST + SGST (within state)</option>
            <option value="IGST">IGST (different state)</option>
          </select>
        </div>
        {gstTreatment !== "NONE" ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">GST rate</label>
            <select value={gstRateId} onChange={(e) => setGstRateId(e.target.value)} className={SELECT}>
              {gstRates.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Payment</label>
          <select name="paymentAccountId" defaultValue="" className={SELECT}>
            <option value="">Credit (pay later)</option>
            {paymentAccounts.map((pa) => (
              <option key={pa.id} value={pa.id}>
                Paid now — {pa.name}
              </option>
            ))}
          </select>
        </div>
        <Field label="Invoice / reference" name="referenceNumber" />
        <Field label="Notes" name="notes" />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-zinc-900 px-4 py-3 text-sm text-white dark:bg-amber-200 dark:text-zinc-900">
        <dt>Payable to Party / Supplier</dt>
        <dd className="text-right font-semibold">{formatMoney(round2(amount + gst))}</dd>
        {brokerPayable > 0 ? (
          <>
            <dt>Payable to Dalal / Broker</dt>
            <dd className="text-right font-semibold">{formatMoney(brokerPayable)}</dd>
          </>
        ) : null}
        <dt>Landed diamond cost</dt>
        <dd className="text-right text-lg font-semibold">{formatMoney(landed)}</dd>
      </dl>

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Save polished purchase"}
      </Button>
    </form>
  );
}
