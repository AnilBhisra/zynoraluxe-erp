"use client";

import { startTransition, useActionState, useState } from "react";

import {
  cancelOtherMaterialPurchaseAction,
  createOtherMaterialItemAction,
  postOtherMaterialPurchaseAction,
  previewOtherMaterialPurchaseAction,
} from "@/app/actions/otherMaterial";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { purchaseLineAmounts, sumMoney, UNIT_RATE_LABEL, type UnitCode } from "@/lib/jewellery/otherMaterialAmounts";

/** Serialized on the server. Money fields are null for Staff (never sent). */
export type MaterialStockRow = { id: string; code: string; name: string; category: string; unit: UnitCode; available: string; stockValue: string | null; averageRate: string | null };
export type MaterialPurchaseRow = {
  id: string;
  code: string;
  date: string;
  supplier: string;
  reference: string | null;
  status: string;
  lines: { item: string; quantity: string; unit: string; rate: string | null; lineTotal: string | null }[];
  grandTotal: string | null;
  cancelBlock: string | null;
};
export type LegacyMaterialRow = { id: string; jobId: string; jobCode: string; description: string; quantity: string; unit: string; cost: string; date: string };

const INPUT = "h-10 w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";
const LABEL = "flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400";
const CARD = "min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5";
const today = () => new Date().toISOString().slice(0, 10);
const CATEGORIES = ["MOISSANITE", "COLOURED_STONE", "SMALL_STONE", "FINDINGS", "ENAMEL", "PLATING", "PACKAGING", "OTHER"];

type LineDraft = { itemId: string; quantity: string; rate: string; discount: string; gstRatePercent: string; taxType: "EXCLUSIVE" | "INCLUSIVE" };
const emptyLine = (): LineDraft => ({ itemId: "", quantity: "", rate: "", discount: "", gstRatePercent: "", taxType: "EXCLUSIVE" });

function NewItemForm() {
  const [state, action, pending] = useActionState(createOtherMaterialItemAction, undefined);
  return (
    <form action={action} className={`${CARD} grid grid-cols-1 gap-3 sm:grid-cols-4`} data-testid="material-item-form">
      <h3 className="text-sm font-semibold sm:col-span-4">New Other Material</h3>
      <label className={`${LABEL} sm:col-span-2`}>
        Name
        <input name="name" className={INPUT} placeholder="e.g. Moissanite 2 mm round" required />
      </label>
      <label className={LABEL}>
        Unit
        <select name="unit" className={INPUT} defaultValue="PCS">
          <option value="PCS">PCS</option>
          <option value="CT">CT</option>
          <option value="GRAM">GRAM</option>
        </select>
      </label>
      <label className={LABEL}>
        Category
        <select name="category" className={INPUT} defaultValue="OTHER">
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, " ").toLowerCase()}
            </option>
          ))}
        </select>
      </label>
      <label className={`${LABEL} sm:col-span-3`}>
        Description (optional)
        <input name="description" className={INPUT} />
      </label>
      <div className="flex items-end">
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : "Add material"}
        </Button>
      </div>
      {state?.error ? <div className="sm:col-span-4"><Alert tone="error">{state.error}</Alert></div> : null}
      {state?.success ? <div className="sm:col-span-4"><Alert tone="success">Added {state.code}.</Alert></div> : null}
    </form>
  );
}

function PurchaseForm({ items, suppliers }: { items: MaterialStockRow[]; suppliers: { id: string; name: string }[] }) {
  const [previewState, previewAction, previewing] = useActionState(previewOtherMaterialPurchaseAction, undefined);
  const [saved, saveAction, saving] = useActionState(postOtherMaterialPurchaseAction, undefined);
  const [baseKey] = useState(() => crypto.randomUUID());
  const savedCode = saved?.success ? saved.code ?? null : null;
  const idempotencyKey = savedCode ? `${baseKey}-after-${savedCode}` : baseKey;
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [purchaseDate, setPurchaseDate] = useState(today());
  const [reference, setReference] = useState("");
  const [gstTreatment, setGst] = useState("NONE");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [previewed, setPreviewed] = useState("");
  const current = JSON.stringify({ supplierId, purchaseDate, reference, gstTreatment, lines, after: savedCode });
  const preview = previewState?.preview && previewed === current ? previewState.preview : null;
  const set = (i: number, patch: Partial<LineDraft>) => setLines((xs) => xs.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const computed = lines.map((l) => {
    const item = items.find((x) => x.id === l.itemId);
    if (!item) return null;
    return purchaseLineAmounts({ quantity: l.quantity, unit: item.unit, rate: l.rate, discount: l.discount, gstRatePercent: gstTreatment === "NONE" ? "0" : l.gstRatePercent, taxType: l.taxType });
  });
  const okTotals = computed.every((c) => c?.ok) ? computed.map((c) => (c && c.ok ? c.amounts : null)) : null;
  const payload = (withFingerprint: boolean) => {
    const fd = new FormData();
    fd.set("supplierId", supplierId);
    fd.set("purchaseDate", purchaseDate);
    fd.set("reference", reference);
    fd.set("gstTreatment", gstTreatment);
    fd.set("linesJson", JSON.stringify(lines.map((l) => ({ ...l, gstRatePercent: gstTreatment === "NONE" ? "" : l.gstRatePercent }))));
    fd.set("idempotencyKey", idempotencyKey);
    if (withFingerprint && preview) fd.set("fingerprint", preview.fingerprint);
    return fd;
  };
  return (
    <form className={`${CARD} flex flex-col gap-3`} onSubmit={(e) => e.preventDefault()} data-testid="material-purchase-form">
      <h3 className="text-sm font-semibold">Purchase Other Material</h3>
      <p className="text-xs text-zinc-500">Material must be purchased into stock before a job can use it. The amount is always quantity × rate — it cannot be typed.</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <label className={LABEL}>
          Supplier
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className={INPUT} data-testid="purchase-supplier">
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Purchase date
          <input type="date" value={purchaseDate} max={today()} onChange={(e) => setPurchaseDate(e.target.value)} className={INPUT} />
        </label>
        <label className={LABEL}>
          Supplier invoice / reference
          <input value={reference} onChange={(e) => setReference(e.target.value)} className={INPUT} />
        </label>
        <label className={LABEL}>
          GST
          <select value={gstTreatment} onChange={(e) => setGst(e.target.value)} className={INPUT}>
            <option value="NONE">No GST</option>
            <option value="CGST_SGST">CGST + SGST</option>
            <option value="IGST">IGST</option>
          </select>
        </label>
      </div>
      {lines.map((l, i) => {
        const item = items.find((x) => x.id === l.itemId);
        const c = computed[i];
        return (
          <div key={i} className="grid min-w-0 grid-cols-2 gap-2 rounded-lg border border-[var(--border)] p-2 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_auto]" data-testid="purchase-line">
            <select aria-label="Material" value={l.itemId} onChange={(e) => set(i, { itemId: e.target.value })} className={`${INPUT} col-span-2 sm:col-span-1`}>
              <option value="">— material —</option>
              {items.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} · {x.name} ({x.unit})
                </option>
              ))}
            </select>
            <input aria-label="Quantity" inputMode="decimal" placeholder={item ? `Qty (${item.unit})` : "Qty"} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} className={INPUT} />
            <input aria-label="Rate" inputMode="decimal" placeholder={item ? UNIT_RATE_LABEL[item.unit] : "Rate"} value={l.rate} onChange={(e) => set(i, { rate: e.target.value })} className={INPUT} />
            <input aria-label="Discount" inputMode="decimal" placeholder="Discount ₹" value={l.discount} onChange={(e) => set(i, { discount: e.target.value })} className={INPUT} />
            <input aria-label="GST %" inputMode="decimal" placeholder="GST %" disabled={gstTreatment === "NONE"} value={gstTreatment === "NONE" ? "" : l.gstRatePercent} onChange={(e) => set(i, { gstRatePercent: e.target.value })} className={INPUT} />
            <select aria-label="Tax type" disabled={gstTreatment === "NONE"} value={l.taxType} onChange={(e) => set(i, { taxType: e.target.value as LineDraft["taxType"] })} className={INPUT}>
              <option value="EXCLUSIVE">GST extra</option>
              <option value="INCLUSIVE">GST included</option>
            </select>
            <button type="button" className="h-10 text-xs text-red-600" onClick={() => setLines((xs) => xs.filter((_, j) => j !== i))}>
              Remove
            </button>
            <p className="col-span-2 text-xs sm:col-span-7" data-testid="purchase-line-amount">
              {!item ? (
                <span className="text-zinc-400">Choose a material, then quantity and {`₹ per unit`}.</span>
              ) : c && c.ok ? (
                <>
                  <strong>Base amount: {c.amounts.formula}</strong>
                  {c.amounts.discount !== "0.00" ? ` · discount ₹${c.amounts.discount}` : ""}
                  {gstTreatment !== "NONE" ? ` · taxable ₹${c.amounts.taxableValue} + GST ₹${c.amounts.taxAmount}` : ""} · line total ₹{c.amounts.lineTotal}
                </>
              ) : (
                <span className="text-amber-700 dark:text-amber-300">{c && !c.ok ? c.error : ""}</span>
              )}
            </p>
          </div>
        );
      })}
      <Button type="button" variant="secondary" size="md" className="self-start" onClick={() => setLines((xs) => [...xs, emptyLine()])} data-testid="purchase-add-line">
        + Add line
      </Button>
      {okTotals ? (
        <p className="text-sm" data-testid="purchase-totals">
          Subtotal ₹{sumMoney(okTotals.map((a) => a!.baseAmount))} · discount ₹{sumMoney(okTotals.map((a) => a!.discount))} · taxable ₹{sumMoney(okTotals.map((a) => a!.taxableValue))} · GST ₹
          {sumMoney(okTotals.map((a) => a!.taxAmount))} · <strong>grand total ₹{sumMoney(okTotals.map((a) => a!.lineTotal))}</strong>
        </p>
      ) : null}
      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {saved?.error ? <Alert tone="error">{saved.error}</Alert> : null}
      {savedCode && !preview ? <Alert tone="success">{saved?.replayed ? `Already saved as ${savedCode}.` : `Purchase saved — ${savedCode}. The material is now in stock.`}</Alert> : null}
      {preview ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="purchase-preview">
          <p className="font-medium">Preview — {preview.supplierName}</p>
          <ul className="text-xs">
            {preview.lines.map((l, i) => (
              <li key={i}>
                {l.item}: {l.formula} · taxable ₹{l.taxableValue} + GST ₹{l.taxAmount} = ₹{l.lineTotal}
              </li>
            ))}
          </ul>
          <p>
            Grand total <strong>₹{preview.grandTotal}</strong> — posts Dr Other Material Inventory ₹{preview.taxableTotal}
            {preview.taxTotal !== "0.00" ? ` + Input GST ₹${preview.taxTotal}` : ""} / Cr {preview.supplierName} (payable).
          </p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={previewing || saving || !supplierId}
          onClick={() => {
            setPreviewed(current);
            startTransition(() => previewAction(payload(false)));
          }}
          data-testid="purchase-preview-btn"
        >
          {previewing ? "Checking…" : "Preview purchase"}
        </Button>
        {preview ? (
          <Button type="button" disabled={saving} onClick={() => startTransition(() => saveAction(payload(true)))} data-testid="purchase-confirm">
            {saving ? "Saving…" : "Confirm purchase"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function CancelPurchase({ purchase }: { purchase: MaterialPurchaseRow }) {
  const [state, action, pending] = useActionState(cancelOtherMaterialPurchaseAction, undefined);
  const [open, setOpen] = useState(false);
  if (state?.success) return <span className="text-xs text-emerald-700">Cancelled</span>;
  if (purchase.cancelBlock) return <span className="text-xs text-zinc-500" title={purchase.cancelBlock}>Used — cannot cancel</span>;
  if (!open) return <button type="button" className="text-xs font-medium text-red-700 underline" onClick={() => setOpen(true)}>Cancel purchase</button>;
  return (
    <form action={action} className="flex flex-wrap gap-2">
      <input type="hidden" name="purchaseId" value={purchase.id} />
      <input name="reason" className={INPUT} placeholder="Reason (at least 10 characters)" />
      <Button type="submit" variant="danger" size="md" disabled={pending} onClick={(e) => { if (!window.confirm(`Cancel ${purchase.code}? A mirror voucher is posted and the stock is removed.`)) e.preventDefault(); }}>
        Confirm cancel
      </Button>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
    </form>
  );
}

export function OtherMaterialTab({
  isOwner,
  items,
  purchases,
  suppliers,
  legacy,
}: {
  isOwner: boolean;
  items: MaterialStockRow[];
  purchases: MaterialPurchaseRow[];
  suppliers: { id: string; name: string }[];
  legacy: LegacyMaterialRow[] | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="other-material-tab">
      <section className={CARD} data-testid="material-stock">
        <h3 className="mb-2 text-sm font-semibold">Other Material stock</h3>
        {items.length === 0 ? (
          <p className="text-xs text-zinc-500">No Other Material yet — add one below, then purchase it.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-xs">
              <thead className="text-left text-zinc-500">
                <tr className="[&>th]:px-2 [&>th]:py-1">
                  <th>Code</th>
                  <th>Material</th>
                  <th className="text-right">Available</th>
                  {isOwner ? <th className="text-right">Avg rate</th> : null}
                  {isOwner ? <th className="text-right">Stock value</th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-t border-[var(--border)] [&>td]:px-2 [&>td]:py-1.5" data-testid="material-stock-row">
                    <td>{i.code}</td>
                    <td>{i.name}</td>
                    <td className="text-right">
                      {i.available} {i.unit}
                    </td>
                    {isOwner ? <td className="text-right">{i.averageRate ? `₹${i.averageRate}/${i.unit}` : "—"}</td> : null}
                    {isOwner ? <td className="text-right">₹{i.stockValue}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <NewItemForm />
      {suppliers.length ? <PurchaseForm items={items} suppliers={suppliers} /> : <p className="text-xs text-zinc-500">Add a Supplier party first to record purchases.</p>}
      <section className={CARD} data-testid="material-purchases">
        <h3 className="mb-2 text-sm font-semibold">Purchases</h3>
        {purchases.length === 0 ? <p className="text-xs text-zinc-500">None yet.</p> : null}
        <ul className="divide-y divide-[var(--border)]">
          {purchases.map((p) => (
            <li key={p.id} className="flex min-w-0 flex-col gap-1 py-2 text-xs" data-testid="material-purchase-row">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 break-words">
                  <strong>{p.code}</strong> · {p.date} · {p.supplier}
                  {p.reference ? ` · ${p.reference}` : ""}
                  {p.grandTotal ? ` · ₹${p.grandTotal}` : ""} · {p.status === "POSTED" ? "Posted" : "Cancelled"}
                </p>
                {isOwner && p.status === "POSTED" ? <CancelPurchase purchase={p} /> : null}
              </div>
              <p className="text-zinc-600 dark:text-zinc-400">
                {p.lines.map((l) => `${l.item} ${l.quantity} ${l.unit}${l.rate ? ` × ₹${l.rate}` : ""}${l.lineTotal ? ` = ₹${l.lineTotal}` : ""}`).join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      </section>
      {legacy ? (
        <section className={CARD} data-testid="material-legacy">
          <h3 className="mb-1 text-sm font-semibold">Legacy manual entries (audit)</h3>
          <p className="mb-2 text-xs text-zinc-500">Free-text Other Material entered before purchased stock existed. They have no purchase or stock source, are display-only and were never posted. They are left exactly as they are.</p>
          {legacy.length === 0 ? (
            <p className="text-xs text-zinc-500">None.</p>
          ) : (
            <ul className="text-xs">
              {legacy.map((l) => (
                <li key={l.id}>
                  <a className="underline" href={`/jewellery-jobs?tab=jobs&view=ALL&jobId=${l.jobId}`}>
                    {l.jobCode}
                  </a>{" "}
                  · {l.date} · {l.description} · {l.quantity} {l.unit} · ₹{l.cost} · Manual (legacy) — no purchase / stock source
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
