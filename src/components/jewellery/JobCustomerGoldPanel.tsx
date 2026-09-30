"use client";

import { useActionState, useEffect, useState, useTransition } from "react";

import {
  approveCustomerGoldMixAction,
  billCustomerJewelleryAction,
  deliverCustomerJewelleryAction,
  previewCustomerJewelleryBillAction,
  reverseCustomerJewelleryBillAction,
  reverseCustomerJewelleryDeliveryAction,
} from "@/app/actions/customerGold";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

/**
 * A job's Customer-owned gold (CUSTOMER_GOLD_DESIGN.md): where its gold came
 * from, the Customer's pieces, bill (Owner) and delivery (Owner or Staff).
 * Money fields arrive as null for Staff — the server never sends them.
 */
export type SerializedJobCustomerGold = {
  jobId: string;
  jobCode: string;
  customerId: string | null;
  customerName: string | null;
  sources: {
    label: string;
    customerGoldOnJob: { purityDisplayName: string; finenessPercent: string; gross: string; fine: string }[];
    customerGoldConsumedFine: string;
    companyViaKarigarMetalFine: string;
    companyDirectIssueFine: string;
    mixApproved: boolean;
  };
  pieces: { id: string; finishedCode: string; status: string; netMetalWeight: string; customerGoldFineWeight: string; companyCost: string | null }[];
  deliveryBlock: string | null;
  deliveries: { id: string; deliveryCode: string; date: string; status: string; receivedByName: string; deliveredBy: string; reference: string | null; pieces: string[]; canReverse: boolean }[];
  /** Owner only. */
  bills: { id: string; billCode: string; date: string; status: string; taxableValue: string; taxAmount: string; grandTotal: string; creditApplied: string; amountDue: string }[] | null;
  /** Owner only. */
  creditAvailable: string | null;
};

const today = () => new Date().toISOString().slice(0, 10);
const cardCls = "rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6";

export function JobCustomerGoldPanel({ data, isOwner, onDone }: { data: SerializedJobCustomerGold; isOwner: boolean; onDone: () => void }) {
  const s = data.sources;
  const hasCustomerGold = s.customerGoldOnJob.length > 0 || s.customerGoldConsumedFine !== "0.000";
  const awaiting = data.pieces.filter((p) => p.status === "CUSTOMER_AWAITING_DELIVERY");
  return (
    <div className={`${cardCls} flex flex-col gap-4`} data-testid="job-customer-gold">
      <div>
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Gold source</h3>
        <p className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-50" data-testid="job-gold-source">
          {s.label}
        </p>
        <ul className="mt-2 flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-400">
          {s.customerGoldOnJob.map((p) => (
            <li key={`${p.purityDisplayName}${p.finenessPercent}`}>
              {data.customerName}&apos;s {p.purityDisplayName} ({p.finenessPercent}%) on this job: {p.fine}g fine ({p.gross}g gross) — Customer-owned
            </li>
          ))}
          {hasCustomerGold ? (
            <li data-testid="job-customer-gold-used">
              Customer gold in finished pieces: {s.customerGoldConsumedFine}g fine — Customer-owned — excluded from Company material cost
            </li>
          ) : null}
          {s.companyViaKarigarMetalFine !== "0.000" ? <li>Company gold via Karigar Metal: {s.companyViaKarigarMetalFine}g fine</li> : null}
          {s.companyDirectIssueFine !== "0.000" ? <li>Historical direct Company issue: {s.companyDirectIssueFine}g fine</li> : null}
          {hasCustomerGold && (s.companyViaKarigarMetalFine !== "0.000" || s.companyDirectIssueFine !== "0.000" || s.mixApproved) ? (
            <li>{s.mixApproved ? "Mixing Customer and Company gold on this job: approved by the Owner." : "Mixed gold without Owner approval — ask the Owner."}</li>
          ) : null}
        </ul>
        {isOwner && data.customerId && !s.mixApproved && (hasCustomerGold || s.companyViaKarigarMetalFine !== "0.000" || s.companyDirectIssueFine !== "0.000") ? (
          <MixApproval jobId={data.jobId} onDone={onDone} />
        ) : null}
      </div>

      {data.pieces.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Customer jewellery</h3>
          <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="job-customer-pieces">
            {data.pieces.map((p) => (
              <li key={p.id}>
                {p.finishedCode} · {p.status === "DELIVERED_TO_CUSTOMER" ? "Delivered" : p.status === "RECEIPT_REVERSED" ? "Receipt reversed" : "Ready for delivery"} · net {p.netMetalWeight}g · Customer gold {p.customerGoldFineWeight}g fine
                {p.companyCost !== null ? ` · Company work cost ₹${p.companyCost} (Customer gold ₹0)` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {isOwner && data.bills !== null && data.pieces.length > 0 ? <BillSection data={data} onDone={onDone} /> : null}

      {awaiting.length > 0 ? (
        data.deliveryBlock ? (
          <p className="text-xs font-medium text-amber-700 dark:text-amber-400" data-testid="delivery-block">
            {data.deliveryBlock}
          </p>
        ) : (
          <DeliverForm jobId={data.jobId} pieces={awaiting} onDone={onDone} />
        )
      ) : null}

      {data.deliveries.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Deliveries</h3>
          <ul className="mt-2 flex flex-col gap-2 text-xs" data-testid="job-deliveries">
            {data.deliveries.map((d) => (
              <li key={d.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-2">
                {d.deliveryCode} · {new Date(d.date).toLocaleDateString("en-IN")} · {d.pieces.join(", ")} · received by {d.receivedByName} · delivered by {d.deliveredBy}
                {d.reference ? ` · ${d.reference}` : ""} · {d.status === "POSTED" ? "Delivered" : "Reversed"}
                {isOwner && d.canReverse ? <ReverseButton kind="delivery" id={d.id} onDone={onDone} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function MixApproval({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(approveCustomerGoldMixAction, undefined);
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);
  if (!open) {
    return (
      <button type="button" className="mt-2 text-xs font-medium underline underline-offset-2" onClick={() => setOpen(true)}>
        Approve mixing Customer and Company gold on this job (Owner)
      </button>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field label="Why Company gold is added (required)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      <Button
        type="button"
        variant="secondary"
        disabled={pending || reason.trim().length < 10}
        onClick={() => {
          const fd = new FormData();
          fd.set("jobId", jobId);
          fd.set("reason", reason);
          startTransition(() => action(fd));
        }}
      >
        {pending ? "Saving…" : "Approve mixed gold"}
      </Button>
    </div>
  );
}

function BillSection({ data, onDone }: { data: SerializedJobCustomerGold; onDone: () => void }) {
  const [previewState, previewAction, previewPending] = useActionState(previewCustomerJewelleryBillAction, undefined);
  const [postState, postAction, postPending] = useActionState(billCustomerJewelleryAction, undefined);
  const [, startTransition] = useTransition();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [open, setOpen] = useState(false);
  const [billDate, setBillDate] = useState(today());
  const [making, setMaking] = useState("");
  const [diamond, setDiamond] = useState("");
  const [material, setMaterial] = useState("");
  const [other, setOther] = useState("");
  const [gst, setGst] = useState("CGST_SGST");
  const [rate, setRate] = useState("3");
  const [credit, setCredit] = useState("");
  const [description, setDescription] = useState("");
  const [previewed, setPreviewed] = useState("");
  const current = JSON.stringify({ billDate, making, diamond, material, other, gst, rate, credit, description });
  const preview = previewState?.preview && previewed === current ? previewState.preview : null;
  useEffect(() => {
    if (postState?.success) onDone();
  }, [postState?.success, onDone]);
  const payload = () => {
    const fd = new FormData();
    fd.set("jobId", data.jobId);
    fd.set("billDate", billDate);
    fd.set("makingCharge", making);
    fd.set("diamondCharge", diamond);
    fd.set("materialCharge", material);
    fd.set("otherCharge", other);
    fd.set("gstTreatment", gst);
    fd.set("gstRatePercent", gst === "NONE" ? "" : rate);
    fd.set("creditToApply", credit);
    fd.set("description", description);
    fd.set("idempotencyKey", idempotencyKey);
    return fd;
  };
  const posted = (data.bills ?? []).filter((b) => b.status === "POSTED");
  return (
    <div data-testid="job-customer-bill">
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Bill (Owner)</h3>
      <ul className="mt-1 flex flex-col gap-1 text-xs">
        {(data.bills ?? []).map((b) => (
          <li key={b.id}>
            {b.billCode} · {new Date(b.date).toLocaleDateString("en-IN")} · taxable ₹{b.taxableValue} + GST ₹{b.taxAmount} = ₹{b.grandTotal} · gold credit ₹{b.creditApplied} · due ₹
            {b.amountDue} · {b.status === "POSTED" ? "Posted" : "Reversed"}
            {b.status === "POSTED" ? <ReverseButton kind="bill" id={b.id} onDone={onDone} /> : null}
          </li>
        ))}
      </ul>
      {postState?.success ? <Alert tone="success">Bill posted — {postState.code}.</Alert> : null}
      {posted.length === 0 && !postState?.success ? (
        open ? (
          <form className="mt-2 flex flex-col gap-3" onSubmit={(e) => e.preventDefault()}>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              Bill making, Company diamonds, materials and other charges. The Customer&apos;s own gold is never billed as sold gold. Gold-purchase credit available: ₹
              {data.creditAvailable}.
            </p>
            {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
            {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Bill date" name="billDate" type="date" value={billDate} max={today()} onChange={(e) => setBillDate(e.target.value)} />
              <Field label="Making charge (₹)" name="makingCharge" type="number" step="0.01" min="0" value={making} onChange={(e) => setMaking(e.target.value)} />
              <Field label="Diamonds (₹)" name="diamondCharge" type="number" step="0.01" min="0" value={diamond} onChange={(e) => setDiamond(e.target.value)} />
              <Field label="Company materials (₹)" name="materialCharge" type="number" step="0.01" min="0" value={material} onChange={(e) => setMaterial(e.target.value)} />
              <Field label="Other charges (₹)" name="otherCharge" type="number" step="0.01" min="0" value={other} onChange={(e) => setOther(e.target.value)} />
              <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                GST
                <select aria-label="GST" value={gst} onChange={(e) => setGst(e.target.value)} className="mt-1 h-11 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600">
                  <option value="CGST_SGST">CGST + SGST</option>
                  <option value="IGST">IGST</option>
                  <option value="NONE">No GST</option>
                </select>
              </label>
              {gst !== "NONE" ? <Field label="GST rate (%)" name="gstRatePercent" type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} /> : null}
              <Field label="Gold-purchase credit to apply (₹)" name="creditToApply" type="number" step="0.01" min="0" value={credit} onChange={(e) => setCredit(e.target.value)} />
              <Field label="Description (optional)" name="description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
            </div>
            {preview ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="bill-preview">
                <p>
                  {preview.customerName} · {preview.jobCode}: taxable ₹{preview.taxableValue} + GST ₹{preview.taxAmount} = <strong>₹{preview.grandTotal}</strong>
                </p>
                <p>
                  Gold-purchase credit applied ₹{preview.creditApplied} → amount due <strong>₹{preview.amountDue}</strong>
                </p>
                <p className="text-xs">Posts: Dr Accounts Receivable / Cr Sales + Output GST{Number(preview.creditApplied) > 0 ? "; credit: Dr Accounts Payable / Cr Accounts Receivable" : ""}.</p>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                disabled={previewPending || postPending}
                onClick={() => {
                  setPreviewed(current);
                  startTransition(() => previewAction(payload()));
                }}
              >
                {previewPending ? "Checking…" : "Preview bill"}
              </Button>
              {preview ? (
                <Button type="button" disabled={postPending} onClick={() => startTransition(() => postAction(payload()))}>
                  {postPending ? "Posting…" : "Post bill"}
                </Button>
              ) : null}
            </div>
          </form>
        ) : (
          <Button type="button" variant="secondary" className="mt-2" onClick={() => setOpen(true)}>
            Bill the Customer
          </Button>
        )
      ) : null}
    </div>
  );
}

function DeliverForm({ jobId, pieces, onDone }: { jobId: string; pieces: SerializedJobCustomerGold["pieces"]; onDone: () => void }) {
  const [state, action, pending] = useActionState(deliverCustomerJewelleryAction, undefined);
  const [, startTransition] = useTransition();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(pieces.map((p) => p.id));
  const [deliveryDate, setDeliveryDate] = useState(today());
  const [receivedBy, setReceivedBy] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);
  if (state?.success) return <Alert tone="success">Delivered — {state.code}.</Alert>;
  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)} className="self-start">
        Deliver to the Customer
      </Button>
    );
  }
  return (
    <form className="flex flex-col gap-3" data-testid="deliver-form" onSubmit={(e) => e.preventDefault()}>
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Deliver to the Customer</h3>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="flex flex-col gap-1 text-sm">
        {pieces.map((p) => (
          <label key={p.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={selected.includes(p.id)}
              onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id)))}
            />
            {p.finishedCode} · net {p.netMetalWeight}g · Customer gold {p.customerGoldFineWeight}g fine
          </label>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Delivery date" name="deliveryDate" type="date" value={deliveryDate} max={today()} onChange={(e) => setDeliveryDate(e.target.value)} />
        <Field label="Received by (name)" name="receivedByName" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} maxLength={120} />
        <Field label="Reference (optional)" name="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
        <Field label="Notes (optional)" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} />
      </div>
      <Button
        type="button"
        disabled={pending || selected.length === 0 || receivedBy.trim().length < 2}
        className="self-start"
        onClick={() => {
          if (!window.confirm(`Deliver ${selected.length} piece(s) to the Customer, received by ${receivedBy.trim()}?`)) return;
          const fd = new FormData();
          fd.set("jobId", jobId);
          fd.set("pieceIdsJson", JSON.stringify(selected));
          fd.set("deliveryDate", deliveryDate);
          fd.set("receivedByName", receivedBy);
          fd.set("reference", reference);
          fd.set("notes", notes);
          fd.set("idempotencyKey", idempotencyKey);
          startTransition(() => action(fd));
        }}
      >
        {pending ? "Saving…" : "Record delivery"}
      </Button>
    </form>
  );
}

function ReverseButton({ kind, id, onDone }: { kind: "bill" | "delivery"; id: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(kind === "bill" ? reverseCustomerJewelleryBillAction : reverseCustomerJewelleryDeliveryAction, undefined);
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);
  if (!open) {
    return (
      <button type="button" className="ml-2 text-xs font-medium underline underline-offset-2" onClick={() => setOpen(true)}>
        Reverse
      </button>
    );
  }
  return (
    <span className="mt-2 flex flex-col gap-2">
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field label="Reason for reversing (at least 10 characters)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      <Button
        type="button"
        variant="danger"
        disabled={pending || reason.trim().length < 10}
        onClick={() => {
          const fd = new FormData();
          fd.set(kind === "bill" ? "billId" : "deliveryId", id);
          fd.set("reason", reason);
          startTransition(() => action(fd));
        }}
      >
        {pending ? "Reversing…" : `Confirm ${kind} reversal`}
      </Button>
    </span>
  );
}
