"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";

import {
  allocateAction,
  postReclassifyAction,
  postReserveAction,
  postSettlementAction,
  previewReclassifyAction,
  previewReserveAction,
  previewSettlementAction,
  reverseAllocationAction,
  reverseClearingAction,
  setClearingPartyAction,
  updateLineMappingAction,
  type ClearingFormState,
  type SerializedPlan,
} from "@/app/actions/clearing";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { indiaToday } from "@/lib/accounting/financialYear";
import { formatRupees } from "@/lib/accounting/partyBalance";

// ---------------------------------------------------------------------------
// Serialized props (strings only — computed on the server, Owner only)
// ---------------------------------------------------------------------------

export type ProviderRow = {
  partyId: string;
  partyName: string;
  currencyCode: string;
  availableFc: string;
  availableInr: string;
  reserveFc: string;
  reserveInr: string;
  totalInr: string;
  unallocatedFc: string;
  nextAvailableOn: string | null;
  lastSettlementDate: string | null;
};
export type DocumentRow = {
  id: string;
  kind: string;
  status: string;
  voucherId: string;
  voucherNumber: string;
  date: string;
  partyId: string;
  partyName: string;
  currencyCode: string;
  reference: string | null;
  paymentAccountName: string | null;
  receivedInr: string;
  receivedFc: string;
  availableFc: string;
  availableInr: string;
  reserveFc: string;
  deductionsInr: string;
  fxDifferenceInr: string;
  availableAfterFc: string;
  availableAfterInr: string;
  allocatedFc: string;
  allocations: { id: string; saleVoucherId: string; saleVoucherNumber: string; fc: string; status: string; reason: string }[];
  reversalVoucherId: string | null;
  reversalVoucherNumber: string | null;
  reversalReason: string | null;
  sourceVoucherNumber: string | null;
  lines: { lineType: string; direction: string; accountCode: string; fc: string; inr: string }[];
};
export type SaleOption = { voucherId: string; voucherNumber: string; date: string; openFc: string };
export type ReclassifyRow = { voucherId: string; voucherNumber: string; date: string; partyName: string; amount: string; accountName: string; block: string | null };
export type MappingRow = { lineType: string; label: string; accountId: string; accountLabel: string; fixed: boolean };

const LINE_LABELS: Record<string, string> = {
  COMMISSION: "Commission / platform fee",
  PROCESSING_FEE: "Payment-processing fee",
  ADVERTISING: "Advertising / marketing",
  SHIPPING: "Shipping / courier deduction",
  SUBSCRIPTION: "Subscription / listing fee",
  REFUND: "Refund not recorded as a Sale Return",
  TAX_WITHHELD: "Tax withheld (TDS / TCS)",
  TAX_REMITTED: "Tax collected / remitted by marketplace",
  RESERVE_HOLD: "Moved to reserve / hold",
  RESERVE_RELEASE: "Released from reserve",
  OTHER: "Other adjustment",
  FX_GAIN: "FX gain",
  FX_LOSS: "FX loss",
};
const USER_LINES = ["COMMISSION", "PROCESSING_FEE", "ADVERTISING", "SHIPPING", "SUBSCRIPTION", "REFUND", "TAX_WITHHELD", "TAX_REMITTED", "RESERVE_HOLD", "RESERVE_RELEASE", "OTHER"];
const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AUD", "CAD", "AED", "SGD"];
const INPUT = "h-10 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100";
const LABEL = "flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400";
const CARD = "min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5";
const inr = (v: string) => formatRupees(v);
const fc = (cur: string, v: string) => (cur === "INR" ? formatRupees(v) : `${cur} ${v}`);
const newKey = () => crypto.randomUUID();

/**
 * Dispatch an action with the form's CURRENT values without submitting the
 * form: a form-action submit makes React reset the form afterwards, which
 * would empty the fields between Preview and Confirm.
 */
function runWith(form: HTMLFormElement | null, dispatch: (fd: FormData) => void) {
  if (!form) return;
  const fd = new FormData(form);
  startTransition(() => dispatch(fd));
}

/** Rotates the submission key and runs onSaved once per saved result (never on every render). */
function useSavedOnce(state: ClearingFormState, onSaved: () => void) {
  const handled = useRef<ClearingFormState>(undefined);
  const cb = useRef(onSaved);
  useEffect(() => {
    cb.current = onSaved;
  });
  useEffect(() => {
    if (!state?.success || handled.current === state) return;
    handled.current = state;
    cb.current();
  }, [state]);
}

function PlanPreview({ plan }: { plan: SerializedPlan }) {
  const cur = plan.currencyCode;
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50/60 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/20" data-testid="clearing-preview">
      <p className="font-semibold">
        Preview — {plan.partyName} · {cur} · {plan.documentDate}
      </p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div><dt className="inline">Available clearing before: </dt><dd className="inline font-medium" data-testid="preview-before">{fc(cur, plan.before.availableFc)} ({inr(plan.before.availableInr)})</dd></div>
        <div><dt className="inline">Reserve before: </dt><dd className="inline">{fc(cur, plan.before.reserveFc)} ({inr(plan.before.reserveInr)})</dd></div>
        {plan.kind === "SETTLEMENT" ? (
          <>
            <div><dt className="inline">Received in {plan.paymentAccountName ?? "—"}: </dt><dd className="inline font-medium" data-testid="preview-received">{inr(plan.receivedInr)}{cur !== "INR" ? ` (${cur} ${plan.receivedFc} at ${plan.payoutRate})` : ""}</dd></div>
            <div><dt className="inline">Clearing settled: </dt><dd className="inline font-medium" data-testid="preview-settled">{fc(cur, plan.availableFc)} ({inr(plan.availableInr)})</dd></div>
          </>
        ) : null}
        <div><dt className="inline">Available clearing after: </dt><dd className="inline font-semibold" data-testid="preview-after">{fc(cur, plan.after.availableFc)} ({inr(plan.after.availableInr)})</dd></div>
        <div><dt className="inline">Reserve after: </dt><dd className="inline">{fc(cur, plan.after.reserveFc)} ({inr(plan.after.reserveInr)})</dd></div>
        {plan.fxDifferenceInr !== "0.00" ? (
          <div><dt className="inline">FX: </dt><dd className="inline font-medium" data-testid="preview-fx">{plan.fxDifferenceInr.startsWith("-") ? `loss ${inr(plan.fxDifferenceInr.slice(1))}` : `gain ${inr(plan.fxDifferenceInr)}`}</dd></div>
        ) : null}
        <div><dt className="inline">Order allocations supplied: </dt><dd className="inline">{plan.allocationsSupplied ? "yes" : "no"}</dd></div>
      </dl>
      {plan.lines.length ? (
        <ul className="text-xs">
          {plan.lines.map((l, i) => (
            <li key={i}>
              {l.direction === "DEDUCTION" ? "−" : "+"} {LINE_LABELS[l.lineType] ?? l.lineType}: {fc(cur, l.fc)} = {inr(l.inr)} → {l.account}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full min-w-[480px] text-xs" data-testid="preview-voucher">
          <thead className="text-left text-zinc-500"><tr><th className="px-2 py-1">Account</th><th className="px-2 py-1">Party</th><th className="px-2 py-1 text-right">Debit</th><th className="px-2 py-1 text-right">Credit</th></tr></thead>
          <tbody>
            {plan.journal.map((j, i) => (
              <tr key={i} className="border-t border-[var(--border)]">
                <td className="px-2 py-1">{j.account}</td>
                <td className="px-2 py-1">{j.party ?? ""}</td>
                <td className="px-2 py-1 text-right">{j.debit !== "0.00" ? inr(j.debit) : ""}</td>
                <td className="px-2 py-1 text-right">{j.credit !== "0.00" ? inr(j.credit) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="list-disc pl-5 text-xs text-amber-900 dark:text-amber-200" data-testid="preview-warnings">
        {plan.warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New settlement (payout + deductions)
// ---------------------------------------------------------------------------

type LineDraft = { lineType: string; amount: string; direction: "DEDUCTION" | "ADDITION"; description: string };

export function SettlementForm({ providers, clearingParties, paymentAccounts }: { providers: ProviderRow[]; clearingParties: { id: string; name: string }[]; paymentAccounts: { id: string; name: string }[] }) {
  const [preview, previewAction, previewing] = useActionState(previewSettlementAction, undefined);
  const [saved, saveAction, saving] = useActionState(postSettlementAction, undefined);
  const [key, setKey] = useState(newKey);
  // A preview is "fresh" until anything is edited after it; saving needs a fresh one.
  const [staleFor, setStaleFor] = useState<ClearingFormState>(undefined);
  const [partyId, setPartyId] = useState(clearingParties[0]?.id ?? "");
  const [cur, setCur] = useState("INR");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const markEdited = () => setStaleFor(preview);
  useSavedOnce(saved, () => {
    setKey(newKey());
    setLines([]);
    setStaleFor(preview);
    formRef.current?.reset();
  });
  const bal = providers.find((p) => p.partyId === partyId && p.currencyCode === cur);
  const fresh = !!preview?.preview && staleFor !== preview;
  return (
    <form ref={formRef} className={`${CARD} flex flex-col gap-4`} onChange={markEdited} onSubmit={(e) => e.preventDefault()} data-testid="settlement-form">
      <h3 className="text-sm font-semibold">New settlement / payout</h3>
      <input type="hidden" name="idempotencyKey" value={key} />
      <input type="hidden" name="fingerprint" value={preview?.preview?.fingerprint ?? ""} />
      <input type="hidden" name="linesJson" value={JSON.stringify(lines)} />
      {clearingParties.length === 0 ? <Alert tone="error">No clearing party yet. Mark one (e.g. ETSY) as a marketplace party under Settings below.</Alert> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={LABEL}>
          Provider
          <select name="partyId" className={INPUT} value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
            {clearingParties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Clearing currency
          <select name="currencyCode" className={INPUT} value={cur} onChange={(e) => setCur(e.target.value)}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Settlement date
          <input type="date" name="documentDate" defaultValue={indiaToday()} className={INPUT} required />
        </label>
        <label className={LABEL}>
          Money received into
          <select name="paymentAccountId" className={INPUT} defaultValue={paymentAccounts[0]?.id}>
            <option value="">— nothing received —</option>
            {paymentAccounts.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          Amount received (INR)
          <input name="receivedInr" inputMode="decimal" className={INPUT} placeholder="0.00" data-testid="received-inr" />
        </label>
        {cur !== "INR" ? (
          <>
            <label className={LABEL}>
              Same payout in {cur}
              <input name="receivedFc" inputMode="decimal" className={INPUT} placeholder="0.00" data-testid="received-fc" />
            </label>
            <label className={LABEL}>
              FX rate (only if nothing received)
              <input name="payoutRate" inputMode="decimal" className={INPUT} placeholder={`INR per 1 ${cur}`} />
            </label>
          </>
        ) : null}
        <label className={LABEL}>
          Gross clearing settled (optional check)
          <input name="grossFc" inputMode="decimal" className={INPUT} placeholder={cur} />
        </label>
        <label className={LABEL}>
          Settlement / payout reference
          <input name="reference" className={INPUT} placeholder="e.g. Etsy deposit 14 Oct" />
        </label>
        <label className={`${LABEL} sm:col-span-2 lg:col-span-3`}>
          Notes / reason
          <input name="notes" className={INPUT} />
        </label>
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="form-balance">
        {bal ? `Available now: ${fc(cur, bal.availableFc)} (${inr(bal.availableInr)}) · reserve ${fc(cur, bal.reserveFc)}` : `No ${cur} clearing balance for this provider.`}
      </p>
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Deductions and adjustments (in {cur})</p>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-1 gap-2 rounded-lg border border-[var(--border)] p-2 sm:grid-cols-[2fr_1fr_1fr_2fr_auto]" data-testid="deduction-line">
            <select aria-label="Line type" className={INPUT} value={l.lineType} onChange={(e) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, lineType: e.target.value } : x)))}>
              {USER_LINES.map((t) => (
                <option key={t} value={t}>{LINE_LABELS[t]}</option>
              ))}
            </select>
            <input aria-label="Amount" inputMode="decimal" className={INPUT} value={l.amount} placeholder="0.00" onChange={(e) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
            <select aria-label="Direction" className={INPUT} value={l.lineType === "RESERVE_RELEASE" ? "ADDITION" : l.lineType === "OTHER" ? l.direction : "DEDUCTION"} disabled={l.lineType !== "OTHER"} onChange={(e) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, direction: e.target.value as LineDraft["direction"] } : x)))}>
              <option value="DEDUCTION">deducted</option>
              <option value="ADDITION">added</option>
            </select>
            <input aria-label="Description" className={INPUT} value={l.description} placeholder="description" onChange={(e) => setLines((xs) => xs.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <button type="button" className="h-10 rounded-lg border border-zinc-300 px-3 text-xs dark:border-zinc-600" onClick={() => { setLines((xs) => xs.filter((_, j) => j !== i)); markEdited(); }}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="self-start text-xs font-medium underline" onClick={() => { setLines((xs) => [...xs, { lineType: "COMMISSION", amount: "", direction: "DEDUCTION", description: "" }]); markEdited(); }} data-testid="add-line">
          + Add a deduction / adjustment
        </button>
      </div>
      {preview?.error ? <Alert tone="error">{preview.error}</Alert> : null}
      {saved?.error ? <Alert tone="error">{saved.error}</Alert> : null}
      {saved?.success ? <Alert tone="success">{saved.replayed ? `Already saved as ${saved.success} — the repeated submit was ignored.` : `Settlement saved as ${saved.success}.`}</Alert> : null}
      {fresh && preview?.preview ? <PlanPreview plan={preview.preview} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => runWith(formRef.current, previewAction)} variant="secondary" disabled={previewing || clearingParties.length === 0} data-testid="settlement-preview">
          {previewing ? "Previewing…" : "Preview"}
        </Button>
        <Button
          type="button"
          disabled={!fresh || saving}
          data-testid="settlement-confirm"
          onClick={() => {
            if (window.confirm("Post this settlement? It cannot be edited afterwards (only reversed).")) runWith(formRef.current, saveAction);
          }}
        >
          {saving ? "Saving…" : "Confirm and save"}
        </Button>
        {!fresh ? <span className="self-center text-xs text-zinc-500">Preview first — saving needs a fresh preview.</span> : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Reserve hold / release
// ---------------------------------------------------------------------------

export function ReserveForm({ clearingParties }: { clearingParties: { id: string; name: string }[] }) {
  const [preview, previewAction, previewing] = useActionState(previewReserveAction, undefined);
  const [saved, saveAction, saving] = useActionState(postReserveAction, undefined);
  const [key, setKey] = useState(newKey);
  const [staleFor, setStaleFor] = useState<ClearingFormState>(undefined);
  const formRef = useRef<HTMLFormElement>(null);
  useSavedOnce(saved, () => {
    setKey(newKey());
    setStaleFor(preview);
    formRef.current?.reset();
  });
  const fresh = !!preview?.preview && staleFor !== preview;
  return (
    <form ref={formRef} className={`${CARD} flex flex-col gap-3`} onChange={() => setStaleFor(preview)} onSubmit={(e) => e.preventDefault()} data-testid="reserve-form">
      <h3 className="text-sm font-semibold">Reserve / held funds</h3>
      <p className="text-xs text-zinc-500">The provider holds some of our money for a while. Still our asset: no Bank, revenue or expense moves.</p>
      <input type="hidden" name="idempotencyKey" value={key} />
      <input type="hidden" name="fingerprint" value={preview?.preview?.fingerprint ?? ""} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label className={LABEL}>Provider<select name="partyId" className={INPUT}>{clearingParties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className={LABEL}>Currency<select name="currencyCode" className={INPUT}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></label>
        <label className={LABEL}>Move<select name="direction" className={INPUT}><option value="HOLD">Clearing → reserve</option><option value="RELEASE">Reserve → clearing</option></select></label>
        <label className={LABEL}>Amount<input name="amountFc" inputMode="decimal" className={INPUT} /></label>
        <label className={LABEL}>Date<input type="date" name="documentDate" defaultValue={indiaToday()} className={INPUT} /></label>
        <label className={LABEL}>Available on (hold)<input type="date" name="availableOn" className={INPUT} /></label>
        <label className={`${LABEL} sm:col-span-2 lg:col-span-6`}>Notes<input name="notes" className={INPUT} /></label>
      </div>
      {preview?.error ? <Alert tone="error">{preview.error}</Alert> : null}
      {saved?.error ? <Alert tone="error">{saved.error}</Alert> : null}
      {saved?.success ? <Alert tone="success">Saved as {saved.success}.</Alert> : null}
      {fresh && preview?.preview ? <PlanPreview plan={preview.preview} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => runWith(formRef.current, previewAction)} variant="secondary" disabled={previewing || clearingParties.length === 0}>Preview</Button>
        <Button type="button" disabled={!fresh || saving} onClick={() => { if (window.confirm("Post this reserve move?")) runWith(formRef.current, saveAction); }}>Confirm and save</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Reclassify a sale receipt that went straight to Cash/Bank
// ---------------------------------------------------------------------------

function ReclassifyRowForm({ row }: { row: ReclassifyRow }) {
  const [preview, previewAction, previewing] = useActionState(previewReclassifyAction, undefined);
  const [saved, saveAction, saving] = useActionState(postReclassifyAction, undefined);
  const [key] = useState(newKey);
  const [staleFor, setStaleFor] = useState<ClearingFormState>(undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const fresh = !!preview?.preview && staleFor !== preview;
  return (
    <li className="flex min-w-0 flex-col gap-2 p-3" data-testid="reclassify-row">
      <p className="text-sm">
        <strong>{row.voucherNumber}</strong> · {row.date} · {row.partyName} · {inr(row.amount)} paid into {row.accountName}
      </p>
      {row.block ? (
        <p className="text-xs text-red-700 dark:text-red-400" data-testid="reclassify-block">Cannot reclassify: {row.block}</p>
      ) : saved?.success ? (
        <Alert tone="success">Reclassified as {saved.success}. Now post the real payout as a settlement.</Alert>
      ) : (
        <form ref={formRef} className="flex flex-col gap-2" onChange={() => setStaleFor(preview)} onSubmit={(e) => e.preventDefault()}>
          <input type="hidden" name="saleVoucherId" value={row.voucherId} />
          <input type="hidden" name="idempotencyKey" value={key} />
          <input type="hidden" name="fingerprint" value={preview?.preview?.fingerprint ?? ""} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
            <label className={LABEL}>Date<input type="date" name="documentDate" defaultValue={indiaToday()} className={INPUT} /></label>
            <label className={LABEL}>Clearing currency<select name="currencyCode" className={INPUT}>{CURRENCIES.map((c) => <option key={c}>{c}</option>)}</select></label>
            <label className={LABEL}>Amount in that currency (non-INR)<input name="amountFc" inputMode="decimal" className={INPUT} /></label>
            <label className={LABEL}>Reason<input name="notes" className={INPUT} placeholder="Etsy had not paid out yet" /></label>
          </div>
          {preview?.error ? <Alert tone="error">{preview.error}</Alert> : null}
          {saved?.error ? <Alert tone="error">{saved.error}</Alert> : null}
          {fresh && preview?.preview ? <PlanPreview plan={preview.preview} /> : null}
          <div className="flex gap-2">
            <Button type="button" onClick={() => runWith(formRef.current, previewAction)} variant="secondary" disabled={previewing}>Preview reclassification</Button>
            <Button type="button" disabled={!fresh || saving} onClick={() => { if (window.confirm(`Move the receipt of ${row.voucherNumber} from ${row.accountName} to clearing? The sale itself is not changed.`)) runWith(formRef.current, saveAction); }}>Confirm</Button>
          </div>
        </form>
      )}
    </li>
  );
}

export function ReclassifyPanel({ rows }: { rows: ReclassifyRow[] }) {
  return (
    <section className={`${CARD} flex flex-col gap-2`} data-testid="reclassify-panel">
      <h3 className="text-sm font-semibold">Marketplace sales recorded as paid straight into Cash / Bank</h3>
      <p className="text-xs text-zinc-500">
        If a marketplace sale was entered with &ldquo;Paid now&rdquo; but the money really arrives later through a payout, move just that receipt to clearing (Dr clearing, Cr the payment account). The sale, its GST, revenue, cost and stock are not touched.
      </p>
      {rows.length === 0 ? <p className="text-xs text-zinc-400">None.</p> : <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">{rows.map((r) => <ReclassifyRowForm key={r.voucherId} row={r} />)}</ul>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Settlement list: reverse, allocate
// ---------------------------------------------------------------------------

function ReverseForm({ doc }: { doc: DocumentRow }) {
  const [state, action, pending] = useActionState(reverseClearingAction, undefined);
  const [key] = useState(newKey);
  const [open, setOpen] = useState(false);
  if (state?.success) return <span className="text-xs text-emerald-700">{state.success}</span>;
  if (!open) return <button type="button" className="text-xs font-medium text-red-700 underline dark:text-red-400" onClick={() => setOpen(true)} data-testid="reverse-open">Reverse</button>;
  return (
    <form action={action} className="flex flex-col gap-2" data-testid="reverse-form">
      <input type="hidden" name="documentId" value={doc.id} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <input name="reason" className={INPUT} placeholder="Reason (at least 10 characters)" />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="md" disabled={pending} onClick={(e) => { if (!window.confirm(`Reverse ${doc.voucherNumber}? A mirror voucher is posted; this cannot be undone.`)) e.preventDefault(); }}>Confirm reversal</Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>Back</Button>
      </div>
    </form>
  );
}

function AllocateForm({ doc, sales }: { doc: DocumentRow; sales: SaleOption[] }) {
  const [state, action, pending] = useActionState(allocateAction, undefined);
  const [key, setKey] = useState(newKey);
  useSavedOnce(state, () => setKey(newKey()));
  if (sales.length === 0) return null;
  return (
    <form action={action} className="grid grid-cols-1 gap-2 sm:grid-cols-[2fr_1fr_2fr_auto]" data-testid="allocate-form">
      <input type="hidden" name="documentId" value={doc.id} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <select name="saleVoucherId" className={INPUT} aria-label="Sale">
        {sales.map((s) => (
          <option key={s.voucherId} value={s.voucherId}>{s.voucherNumber} · {s.date} · open {doc.currencyCode} {s.openFc}</option>
        ))}
      </select>
      <input name="amountFc" inputMode="decimal" className={INPUT} placeholder={doc.currencyCode} aria-label="Amount" />
      <input name="reason" className={INPUT} placeholder="Source (payout statement line)" aria-label="Reason" />
      <Button type="submit" size="md" variant="secondary" disabled={pending}>Allocate</Button>
      {state?.error ? <div className="sm:col-span-4"><Alert tone="error">{state.error}</Alert></div> : null}
      {state?.success ? <div className="sm:col-span-4"><Alert tone="success">{state.success}</Alert></div> : null}
    </form>
  );
}

function UndoAllocation({ id }: { id: string }) {
  const [state, action, pending] = useActionState(reverseAllocationAction, undefined);
  if (state?.success) return <span className="text-emerald-700">reversed</span>;
  return (
    <form action={action} className="inline-flex gap-1">
      <input type="hidden" name="allocationId" value={id} />
      <input type="hidden" name="reason" value="Allocation entered by mistake — undone by the Owner" />
      <button type="submit" disabled={pending} className="underline">undo</button>
      {state?.error ? <span className="text-red-700">{state.error}</span> : null}
    </form>
  );
}

export function SettlementList({ docs, salesByKey }: { docs: DocumentRow[]; salesByKey: Record<string, SaleOption[]> }) {
  return (
    <section className={`${CARD} flex flex-col gap-2`} data-testid="settlement-list">
      <h3 className="text-sm font-semibold">Posted settlements, reserve moves and reclassifications (newest first)</h3>
      {docs.length === 0 ? <p className="text-xs text-zinc-400">None yet.</p> : null}
      <ul className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
        {docs.map((d, i) => {
          const newestLive = !docs.slice(0, i).some((x) => x.partyId === d.partyId && x.currencyCode === d.currencyCode && x.status === "POSTED");
          const unallocated = (Number(d.availableFc) - Number(d.allocatedFc)).toFixed(2);
          return (
            <li key={d.id} className="flex min-w-0 flex-col gap-1 p-3 text-sm" data-testid="settlement-row">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="min-w-0 break-words">
                  <a className="font-medium underline" href={`/accounting/voucher/${d.voucherId}`}>{d.voucherNumber}</a> · {d.date} · {d.partyName} · {d.currencyCode}
                  {d.reference ? ` · ${d.reference}` : ""} ·{" "}
                  <span className={d.status === "REVERSED" ? "text-red-700 dark:text-red-400" : ""}>{d.status === "REVERSED" ? "Reversed" : d.kind === "SETTLEMENT" ? (d.allocatedFc === "0.00" ? "Unallocated pooled settlement" : "Partly allocated") : d.kind === "RECLASSIFY" ? `Reclassified ${d.sourceVoucherNumber}` : d.kind === "RESERVE_HOLD" ? "Reserve hold" : "Reserve release"}</span>
                </p>
                {d.status === "POSTED" && newestLive ? <ReverseForm doc={d} /> : null}
              </div>
              <p className="text-xs text-zinc-600 dark:text-zinc-400">
                {d.kind === "SETTLEMENT" ? <>Bank {inr(d.receivedInr)}{d.paymentAccountName ? ` (${d.paymentAccountName})` : ""} · deductions {inr(d.deductionsInr)} · clearing settled {fc(d.currencyCode, d.availableFc)} ({inr(d.availableInr)}){d.fxDifferenceInr !== "0.00" ? ` · FX ${d.fxDifferenceInr}` : ""} · </> : null}
                available after {fc(d.currencyCode, d.availableAfterFc)}
                {d.reversalVoucherNumber ? (
                  <> · reversed by <a className="underline" href={`/accounting/voucher/${d.reversalVoucherId}`}>{d.reversalVoucherNumber}</a>{d.reversalReason ? ` — “${d.reversalReason}”` : ""}</>
                ) : null}
              </p>
              {d.allocations.length ? (
                <ul className="text-xs">
                  {d.allocations.map((a) => (
                    <li key={a.id}>
                      Allocated {d.currencyCode} {a.fc} to {a.saleVoucherNumber} ({a.reason}) · {a.status === "ACTIVE" ? <UndoAllocation id={a.id} /> : "reversed"}
                    </li>
                  ))}
                </ul>
              ) : null}
              {d.kind === "SETTLEMENT" && d.status === "POSTED" && Number(unallocated) > 0 ? (
                <details className="text-xs">
                  <summary className="cursor-pointer">Optional: record which sales this paid ({d.currencyCode} {unallocated} unallocated)</summary>
                  <div className="mt-2"><AllocateForm doc={d} sales={salesByKey[`${d.partyId}|${d.currencyCode}`] ?? []} /></div>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Settings: clearing parties and line → account mapping
// ---------------------------------------------------------------------------

function PartyToggle({ party, enable }: { party: { id: string; name: string }; enable: boolean }) {
  const [state, action, pending] = useActionState(setClearingPartyAction, undefined);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 text-xs">
      <input type="hidden" name="partyId" value={party.id} />
      <input type="hidden" name="enable" value={String(enable)} />
      <span>{party.name}</span>
      <button type="submit" disabled={pending} className="underline" onClick={(e) => { if (!window.confirm(enable ? `Make ${party.name} a marketplace / clearing party? Its NEW sales will post to 1150 clearing and be paid through settlements.` : `Make ${party.name} an ordinary party again?`)) e.preventDefault(); }}>
        {enable ? "Mark as marketplace / clearing" : "Turn off"}
      </button>
      {state?.error ? <span className="text-red-700">{state.error}</span> : null}
      {state?.success ? <span className="text-emerald-700">{state.success}</span> : null}
    </form>
  );
}

function MappingRowForm({ row, accounts }: { row: MappingRow; accounts: { id: string; label: string }[] }) {
  const [state, action, pending] = useActionState(updateLineMappingAction, undefined);
  return (
    <form action={action} className="grid grid-cols-1 items-center gap-2 py-1 text-xs sm:grid-cols-[2fr_3fr_auto]">
      <input type="hidden" name="lineType" value={row.lineType} />
      <span>{row.label}</span>
      {row.fixed ? (
        <span>{row.accountLabel} (fixed)</span>
      ) : (
        <select name="accountId" defaultValue={row.accountId} className={INPUT}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.label}</option>
          ))}
        </select>
      )}
      {row.fixed ? <span /> : <Button type="submit" size="md" variant="secondary" disabled={pending}>Save</Button>}
      {state?.error ? <span className="text-red-700 sm:col-span-3">{state.error}</span> : null}
      {state?.success ? <span className="text-emerald-700 sm:col-span-3">{state.success}</span> : null}
    </form>
  );
}

export function ClearingSettings({ clearingParties, otherParties, mappings, accounts }: { clearingParties: { id: string; name: string }[]; otherParties: { id: string; name: string }[]; mappings: MappingRow[]; accounts: { id: string; label: string }[] }) {
  return (
    <section className={`${CARD} flex flex-col gap-3`} data-testid="clearing-settings">
      <h3 className="text-sm font-semibold">Settings</h3>
      <details>
        <summary className="cursor-pointer text-sm">Marketplace / clearing parties ({clearingParties.length})</summary>
        <div className="mt-2 flex flex-col gap-1">
          {clearingParties.map((p) => <PartyToggle key={p.id} party={p} enable={false} />)}
          <p className="mt-2 text-xs text-zinc-500">Mark another party (Etsy, Amazon, PayPal, a COD courier, a dealer …):</p>
          {otherParties.map((p) => <PartyToggle key={p.id} party={p} enable />)}
        </div>
      </details>
      <details>
        <summary className="cursor-pointer text-sm">Account mapping for deduction lines (CA to confirm)</summary>
        <div className="mt-2 divide-y divide-[var(--border)]">
          {mappings.map((m) => <MappingRowForm key={m.lineType} row={m} accounts={accounts} />)}
        </div>
      </details>
    </section>
  );
}
