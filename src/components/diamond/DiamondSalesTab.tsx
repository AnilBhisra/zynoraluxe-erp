"use client";

import { startTransition, useActionState, useState } from "react";

import { cancelDiamondSaleAction, postDiamondSaleAction, previewDiamondSaleAction, returnDiamondSaleAction } from "@/app/actions/diamondSale";
import { ClearingSaleFields } from "@/components/accounting/ClearingSaleFields";
import type { PartyOption } from "@/components/accounting/PartySelect";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { purchaseLineAmounts, sumMoney } from "@/lib/jewellery/otherMaterialAmounts";

export type SaleStoneOption = { id: string; code: string; label: string; carat: string };
export type SalePacketOption = { id: string; code: string; label: string; pieces: number; carat: string };
export type DiamondSaleRow = {
  id: string;
  saleCode: string;
  voucherId: string;
  voucherNumber: string;
  date: string;
  customerName: string;
  status: string;
  createdBy: string;
  taxableTotal: string;
  taxTotal: string;
  grandTotal: string;
  /** Owner only. */
  cogsTotal: string | null;
  grossProfit: string | null;
  lines: { id: string; description: string; pieces: number; carat: string; lineTotal: string; cogsAmount: string | null; returnCode: string | null }[];
  returns: { code: string; date: string; total: string }[];
};

type LineDraft = { kind: "STONE" | "PACKET"; sourceId: string; pieces: string; carat: string; pricing: "PER_CARAT" | "PER_PIECE" | "FIXED"; rate: string; discount: string; gstRatePercent: string; taxType: "EXCLUSIVE" | "INCLUSIVE" };
const emptyLine = (): LineDraft => ({ kind: "STONE", sourceId: "", pieces: "", carat: "", pricing: "PER_CARAT", rate: "", discount: "", gstRatePercent: "", taxType: "EXCLUSIVE" });
const INPUT = "h-10 w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";
const LABEL = "flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400";
const CARD = "min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5";
const today = () => new Date().toISOString().slice(0, 10);
const RATE_LABEL = { PER_CARAT: "₹ per carat", PER_PIECE: "₹ per piece", FIXED: "Fixed total ₹" } as const;
/** Display only (the amounts themselves are exact strings): ₹50,000.00. */
const inr = (v: string, maxDp = 2) => `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: maxDp })}`;
/** Same wording as the server preview: "2.500 CT × ₹20,000.00/CT = ₹50,000.00". */
function formulaText(pricing: LineDraft["pricing"], carat: string, pieces: string, rate: string, base: string) {
  if (pricing === "PER_CARAT") return `${Number(carat).toFixed(3)} CT × ${inr(rate, 4)}/CT = ${inr(base)}`;
  if (pricing === "PER_PIECE") return `${pieces} PCS × ${inr(rate, 4)}/PCS = ${inr(base)}`;
  return `Fixed total ${inr(base)}`;
}

function NewDiamondSaleForm({ customers, paymentAccounts, stones, packets }: { customers: PartyOption[]; paymentAccounts: { id: string; name: string }[]; stones: SaleStoneOption[]; packets: SalePacketOption[] }) {
  const [previewState, previewAction, previewing] = useActionState(previewDiamondSaleAction, undefined);
  const [saved, saveAction, saving] = useActionState(postDiamondSaleAction, undefined);
  const [baseKey] = useState(() => crypto.randomUUID());
  const savedCode = saved?.success ? saved.code ?? null : null;
  const idempotencyKey = savedCode ? `${baseKey}-after-${savedCode}` : baseKey;
  const [customerId, setCustomerId] = useState("");
  const [saleDate, setSaleDate] = useState(today());
  const [gstTreatment, setGst] = useState("NONE");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [reference, setReference] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [previewed, setPreviewed] = useState("");
  const [formEl, setFormEl] = useState<HTMLFormElement | null>(null);
  const customer = customers.find((c) => c.id === customerId) ?? null;
  const current = JSON.stringify({ customerId, saleDate, gstTreatment, paymentAccountId, reference, lines, after: savedCode });
  const preview = previewState?.preview && previewed === current ? previewState.preview : null;
  const set = (i: number, patch: Partial<LineDraft>) => setLines((xs) => xs.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const lineAmount = (l: LineDraft) => {
    const stone = l.kind === "STONE" ? stones.find((s) => s.id === l.sourceId) : null;
    const carat = l.kind === "STONE" ? stone?.carat ?? "" : l.carat;
    const pieces = l.kind === "STONE" ? "1" : l.pieces;
    const quantity = l.pricing === "PER_CARAT" ? carat : l.pricing === "PER_PIECE" ? pieces : "1";
    if (!l.sourceId || !quantity) return null;
    return purchaseLineAmounts({ quantity, unit: l.pricing === "PER_CARAT" ? "CT" : "PCS", rate: l.rate, discount: l.discount, gstRatePercent: gstTreatment === "NONE" ? "0" : l.gstRatePercent, taxType: l.taxType });
  };
  const amounts = lines.map(lineAmount);
  const allOk = amounts.every((a) => a?.ok);
  const payload = (withFingerprint: boolean) => {
    const fd = formEl ? new FormData(formEl) : new FormData();
    fd.set("customerId", customerId);
    fd.set("saleDate", saleDate);
    fd.set("gstTreatment", gstTreatment);
    fd.set("paymentAccountId", customer?.clearingEnabled ? "" : paymentAccountId);
    fd.set("reference", reference);
    fd.set(
      "linesJson",
      JSON.stringify(
        lines.map((l) => ({
          kind: l.kind,
          polishedDiamondId: l.kind === "STONE" ? l.sourceId : null,
          packetId: l.kind === "PACKET" ? l.sourceId : null,
          pieces: l.kind === "PACKET" ? l.pieces : null,
          carat: l.kind === "PACKET" ? l.carat : null,
          pricing: l.pricing,
          rate: l.rate,
          discount: l.discount,
          gstRatePercent: gstTreatment === "NONE" ? "" : l.gstRatePercent,
          taxType: l.taxType,
        }))
      )
    );
    fd.set("idempotencyKey", idempotencyKey);
    if (withFingerprint && preview) fd.set("fingerprint", preview.fingerprint);
    return fd;
  };
  return (
    <form ref={setFormEl} className={`${CARD} flex flex-col gap-3`} onSubmit={(e) => e.preventDefault()} data-testid="diamond-sale-form">
      <h3 className="text-sm font-semibold">New Diamond Sale</h3>
      <p className="text-xs text-zinc-500">Sell an available polished stone, a whole packet or part of a packet straight to a Customer — no Jewellery Job needed.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className={LABEL}>
          Customer
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} className={INPUT} data-testid="ds-customer">
            <option value="">— choose —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.clearingEnabled ? " (marketplace)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Sale date
          <input type="date" value={saleDate} max={today()} onChange={(e) => setSaleDate(e.target.value)} className={INPUT} />
        </label>
        <label className={LABEL}>
          GST
          <select value={gstTreatment} onChange={(e) => setGst(e.target.value)} className={INPUT}>
            <option value="NONE">No GST</option>
            <option value="CGST_SGST">CGST + SGST</option>
            <option value="IGST">IGST</option>
          </select>
        </label>
        <label className={LABEL}>
          Payment
          <select value={customer?.clearingEnabled ? "" : paymentAccountId} disabled={!!customer?.clearingEnabled} onChange={(e) => setPaymentAccountId(e.target.value)} className={INPUT} data-testid="ds-payment">
            <option value="">On credit (receivable)</option>
            {paymentAccounts.map((p) => (
              <option key={p.id} value={p.id}>
                Paid now — {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className={`${LABEL} sm:col-span-4`}>
          Reference (optional)
          <input value={reference} onChange={(e) => setReference(e.target.value)} className={INPUT} />
        </label>
        <ClearingSaleFields party={customer} />
      </div>
      {lines.map((l, i) => {
        const packet = l.kind === "PACKET" ? packets.find((p) => p.id === l.sourceId) : null;
        const a = amounts[i];
        return (
          <div key={i} className="grid min-w-0 grid-cols-2 gap-2 rounded-lg border border-[var(--border)] p-2 sm:grid-cols-6" data-testid="ds-line">
            <select aria-label="Stone or packet" value={l.kind} onChange={(e) => set(i, { kind: e.target.value as LineDraft["kind"], sourceId: "", pieces: "", carat: "" })} className={INPUT}>
              <option value="STONE">Single stone</option>
              <option value="PACKET">Packet</option>
            </select>
            <select aria-label="Stock" value={l.sourceId} onChange={(e) => set(i, { sourceId: e.target.value })} className={`${INPUT} col-span-1 sm:col-span-2`} data-testid="ds-source">
              <option value="">— choose available {l.kind === "STONE" ? "stone" : "packet"} —</option>
              {(l.kind === "STONE" ? stones : packets).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} · {x.label} · {"pieces" in x ? `${x.pieces} pcs / ` : ""}
                  {x.carat} ct
                </option>
              ))}
            </select>
            {l.kind === "PACKET" ? (
              <>
                <input aria-label="Pieces sold" inputMode="numeric" placeholder={packet ? `pcs (of ${packet.pieces})` : "pcs"} value={l.pieces} onChange={(e) => set(i, { pieces: e.target.value })} className={INPUT} />
                <input aria-label="Carat sold" inputMode="decimal" placeholder={packet ? `ct (of ${packet.carat})` : "ct"} value={l.carat} onChange={(e) => set(i, { carat: e.target.value })} className={INPUT} />
              </>
            ) : (
              <span className="col-span-2 self-center text-xs text-zinc-500">1 piece · {stones.find((s) => s.id === l.sourceId)?.carat ?? "—"} ct</span>
            )}
            <button type="button" className="h-10 text-xs text-red-600" onClick={() => setLines((xs) => xs.filter((_, j) => j !== i))}>
              Remove
            </button>
            <select aria-label="Pricing" value={l.pricing} onChange={(e) => set(i, { pricing: e.target.value as LineDraft["pricing"] })} className={INPUT} data-testid="ds-pricing">
              <option value="PER_CARAT">Rate per carat</option>
              <option value="PER_PIECE">Rate per piece</option>
              <option value="FIXED">Fixed total</option>
            </select>
            <input aria-label="Rate" inputMode="decimal" placeholder={RATE_LABEL[l.pricing]} value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} className={INPUT} data-testid="ds-rate" />
            <input aria-label="Discount" inputMode="decimal" placeholder="Discount ₹" value={l.discount} onChange={(e) => set(i, { discount: e.target.value })} className={INPUT} />
            <input aria-label="GST %" inputMode="decimal" placeholder="GST %" disabled={gstTreatment === "NONE"} value={gstTreatment === "NONE" ? "" : l.gstRatePercent} onChange={(e) => set(i, { gstRatePercent: e.target.value })} className={INPUT} />
            <select aria-label="Tax type" disabled={gstTreatment === "NONE"} value={l.taxType} onChange={(e) => set(i, { taxType: e.target.value as LineDraft["taxType"] })} className={`${INPUT} col-span-2 sm:col-span-2`}>
              <option value="EXCLUSIVE">GST extra</option>
              <option value="INCLUSIVE">GST included</option>
            </select>
            <p className="col-span-2 text-xs sm:col-span-6" data-testid="ds-line-amount">
              {a && a.ok ? (
                <>
                  <strong>
                    Base amount:{" "}
                    {formulaText(l.pricing, l.kind === "STONE" ? stones.find((x) => x.id === l.sourceId)?.carat ?? "" : l.carat, l.kind === "STONE" ? "1" : l.pieces, l.rate, a.amounts.baseAmount)}
                  </strong>
                  {a.amounts.discount !== "0.00" ? ` · discount ${inr(a.amounts.discount)}` : ""}
                  {gstTreatment !== "NONE" ? ` · taxable ${inr(a.amounts.taxableValue)} + GST ${inr(a.amounts.taxAmount)}` : ""} · line total {inr(a.amounts.lineTotal)}
                </>
              ) : a && !a.ok ? (
                <span className="text-amber-700 dark:text-amber-300">{a.error}</span>
              ) : (
                <span className="text-zinc-400">Choose the stock, the quantity and the rate.</span>
              )}
            </p>
          </div>
        );
      })}
      <Button type="button" variant="secondary" size="md" className="self-start" onClick={() => setLines((xs) => [...xs, emptyLine()])} data-testid="ds-add-line">
        + Add stone / packet
      </Button>
      {allOk ? (
        <p className="text-sm" data-testid="ds-totals">
          Taxable {inr(sumMoney(amounts.map((a) => (a && a.ok ? a.amounts.taxableValue : "0"))))} · GST {inr(sumMoney(amounts.map((a) => (a && a.ok ? a.amounts.taxAmount : "0"))))} ·{" "}
          <strong>grand total {inr(sumMoney(amounts.map((a) => (a && a.ok ? a.amounts.lineTotal : "0"))))}</strong>
        </p>
      ) : null}
      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {saved?.error ? <Alert tone="error">{saved.error}</Alert> : null}
      {savedCode && !preview ? <Alert tone="success">{saved?.replayed ? `Already saved as ${savedCode}.` : `Diamond sale saved — ${savedCode}.`}</Alert> : null}
      {preview ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="ds-preview">
          <p className="font-medium">
            Preview — {preview.customerName} · {preview.paymentMode}
          </p>
          <ul className="text-xs">
            {preview.lines.map((l, i) => (
              <li key={i}>
                {l.description}: {l.formula}
                {l.discount !== "0.00" ? ` − ₹${l.discount}` : ""} · taxable ₹{l.taxableValue} + GST ₹{l.taxAmount} = ₹{l.lineTotal}
                {l.cogsAmount !== null ? ` · cost ₹${l.cogsAmount}` : ""}
              </li>
            ))}
          </ul>
          <p>
            Grand total <strong>₹{preview.grandTotal}</strong>
            {preview.cogsTotal !== null ? ` · cost ₹${preview.cogsTotal} · gross profit ₹${preview.grossProfit}` : ""}
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={previewing || saving || !customerId}
          onClick={() => {
            setPreviewed(current);
            startTransition(() => previewAction(payload(false)));
          }}
          data-testid="ds-preview-btn"
        >
          {previewing ? "Checking…" : "Preview sale"}
        </Button>
        {preview ? (
          <Button
            type="button"
            disabled={saving}
            onClick={() => {
              if (window.confirm(`Post this diamond sale of ₹${preview.grandTotal}? It cannot be edited afterwards (the Owner can cancel or record a return).`)) startTransition(() => saveAction(payload(true)));
            }}
            data-testid="ds-confirm"
          >
            {saving ? "Saving…" : "Confirm sale"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function OwnerActions({ sale }: { sale: DiamondSaleRow }) {
  const [cancelState, cancelAction, cancelling] = useActionState(cancelDiamondSaleAction, undefined);
  const [returnState, returnAction, returning] = useActionState(returnDiamondSaleAction, undefined);
  const [mode, setMode] = useState<"none" | "cancel" | "return">("none");
  const [reason, setReason] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [key] = useState(() => crypto.randomUUID());
  if (cancelState?.success) return <span className="text-xs text-emerald-700">Cancelled</span>;
  if (returnState?.success) return <span className="text-xs text-emerald-700">Return {returnState.code} posted</span>;
  const open = sale.lines.filter((l) => !l.returnCode);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex gap-3">
        {sale.returns.length === 0 ? (
          <button type="button" className="font-medium text-red-700 underline" onClick={() => setMode(mode === "cancel" ? "none" : "cancel")}>
            Cancel sale
          </button>
        ) : null}
        {open.length ? (
          <button type="button" className="font-medium underline" onClick={() => setMode(mode === "return" ? "none" : "return")} data-testid="ds-return-open">
            Customer return
          </button>
        ) : null}
      </div>
      {mode !== "none" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] p-2">
          {mode === "return"
            ? open.map((l) => (
                <label key={l.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked((xs) => (e.target.checked ? [...xs, l.id] : xs.filter((x) => x !== l.id)))} />
                  {l.description}
                </label>
              ))
            : null}
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} placeholder={mode === "cancel" ? "Reason (at least 10 characters)" : "Reason for the return"} />
          <Button
            type="button"
            size="md"
            variant="danger"
            disabled={cancelling || returning}
            onClick={() => {
              const fd = new FormData();
              fd.set("saleId", sale.id);
              fd.set("reason", reason);
              if (mode === "cancel") {
                if (window.confirm(`Cancel ${sale.saleCode}? A mirror voucher is posted and every stone goes back to stock.`)) startTransition(() => cancelAction(fd));
              } else {
                fd.set("lineIdsJson", JSON.stringify(picked));
                fd.set("returnDate", today());
                fd.set("idempotencyKey", key);
                if (window.confirm("Record this return? Revenue and GST reverse and the stones go back to stock.")) startTransition(() => returnAction(fd));
              }
            }}
          >
            Confirm
          </Button>
          {cancelState?.error ? <Alert tone="error">{cancelState.error}</Alert> : null}
          {returnState?.error ? <Alert tone="error">{returnState.error}</Alert> : null}
        </div>
      ) : null}
    </div>
  );
}

export function DiamondSalesTab({
  isOwner,
  customers,
  paymentAccounts,
  stones,
  packets,
  sales,
}: {
  isOwner: boolean;
  customers: PartyOption[];
  paymentAccounts: { id: string; name: string }[];
  stones: SaleStoneOption[];
  packets: SalePacketOption[];
  sales: DiamondSaleRow[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="diamond-sales-tab">
      <NewDiamondSaleForm customers={customers} paymentAccounts={paymentAccounts} stones={stones} packets={packets} />
      <section className={CARD} data-testid="diamond-sales-list">
        <h3 className="mb-2 text-sm font-semibold">Diamond sales</h3>
        {sales.length === 0 ? <p className="text-xs text-zinc-500">None yet.</p> : null}
        <ul className="divide-y divide-[var(--border)]">
          {sales.map((s) => (
            <li key={s.id} className="flex min-w-0 flex-col gap-1 py-2 text-xs" data-testid="ds-row">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 break-words">
                  <strong>{s.saleCode}</strong> ·{" "}
                  {isOwner ? (
                    <a className="underline" href={`/accounting/voucher/${s.voucherId}`}>
                      {s.voucherNumber}
                    </a>
                  ) : (
                    s.voucherNumber
                  )}{" "}
                  · {s.date} · {s.customerName} · ₹{s.grandTotal}
                  {s.cogsTotal !== null ? ` · cost ₹${s.cogsTotal} · gross profit ₹${s.grossProfit}` : ""} · by {s.createdBy} · {s.status === "POSTED" ? "Posted" : "Cancelled"}
                </p>
                {isOwner && s.status === "POSTED" ? <OwnerActions sale={s} /> : null}
              </div>
              <ul className="pl-3 text-zinc-600 dark:text-zinc-400">
                {s.lines.map((l) => (
                  <li key={l.id}>
                    {l.description} · ₹{l.lineTotal}
                    {l.cogsAmount !== null ? ` (cost ₹${l.cogsAmount})` : ""}
                    {l.returnCode ? ` · returned (${l.returnCode})` : ""}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
