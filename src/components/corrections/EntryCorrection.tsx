"use client";

import { useState, useTransition } from "react";

import { entryCorrectionOptionsAction, postEntryCorrectionAction, previewEntryCorrectionAction, reverseEntryCorrectionAction } from "@/app/actions/entryCorrections";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import type { EntryHistoryItem } from "@/lib/corrections/entry/service";
import { ENTRY_CLASS_LABEL, type EntryKind, type EntryOption, type EntryPreview, type EntryTarget } from "@/lib/corrections/entry/types";

const INPUT = "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";
const CARD = "rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:p-4";

/** Human labels for the fields a correction can record. */
export const FIELD_LABELS: Record<string, string> = {
  returnedPieces: "Returned pieces",
  pieceCount: "Stones in the row",
  originalPieceCount: "Stones returned (snapshot)",
  kind: "Row type",
  status: "Status",
  state: "Receipt",
  returnedRoughCarat: "Returned carat",
  totalLabourCharge: "Process charge",
  remainingWipCost: "Remaining WIP",
  notes: "Notes",
  dueDate: "Due date",
  customShapeInstruction: "Cutting instruction",
  customShapeMeasurements: "Required measurements",
  specialInstructions: "Special instructions",
  expectedDeliveryDate: "Expected delivery date",
  customerReference: "Customer reference",
};

const KIND_LABEL: Record<EntryKind, string> = {
  METADATA: "Details",
  RETURNED_PIECES: "Returned pieces",
  RECEIPT_REVERSAL: "Receipt reversed",
};

function newKey() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// The Owner correction panel
// ---------------------------------------------------------------------------

export function EntryCorrectionPanel({ target, recordLabel, onDone }: { target: EntryTarget; recordLabel: string; onDone?: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<EntryOption[] | null>(null);
  const [kind, setKind] = useState<EntryKind | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<EntryPreview | null>(null);
  const [submitKey, setSubmitKey] = useState<string>(newKey);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const option = options?.find((o) => o.kind === kind) ?? null;

  function choose(next: EntryOption) {
    setKind(next.kind);
    setValues(Object.fromEntries(next.fields.map((f) => [f.field, f.current])));
    setPreview(null);
    setError(null);
  }
  /** Any change after Preview invalidates it — Confirm must follow a fresh Preview. */
  function edit(patch: Record<string, string>) {
    setValues((v) => ({ ...v, ...patch }));
    setPreview(null);
  }
  function openPanel() {
    setOpen(true);
    setError(null);
    start(async () => {
      const res = await entryCorrectionOptionsAction(target);
      if (!res.ok) return setError(res.error);
      setOptions(res.data);
      const first = res.data.find((o) => o.blockers.length === 0) ?? res.data[0];
      if (first) choose(first);
    });
  }
  function changedValues(): Record<string, string> {
    if (!option) return {};
    return Object.fromEntries(option.fields.filter((f) => (values[f.field] ?? "") !== f.current).map((f) => [f.field, values[f.field] ?? ""]));
  }
  function runPreview() {
    if (!kind) return;
    setError(null);
    start(async () => {
      const res = await previewEntryCorrectionAction({ target, kind, values: changedValues(), reason });
      if (!res.ok) {
        setPreview(null);
        return setError(res.error);
      }
      setPreview(res.data);
      setSubmitKey(newKey()); // one key per approved preview: a double click replays, a new preview is a new submission
    });
  }
  function confirm() {
    if (!kind || !preview) return;
    setError(null);
    start(async () => {
      const res = await postEntryCorrectionAction({ target, kind, values: changedValues(), reason, idempotencyKey: submitKey, fingerprint: preview.fingerprint });
      if (!res.ok) {
        setPreview(null);
        return setError(res.error);
      }
      setOpen(false);
      setPreview(null);
      setOptions(null);
      setReason("");
      onDone?.(`Correction posted — ${res.data.code}.`);
    });
  }

  if (!open) {
    return (
      <button type="button" onClick={openPanel} className="text-xs font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900 dark:text-zinc-300" data-testid={`correct-entry-${recordLabel}`}>
        Correct entry
      </button>
    );
  }

  const blocked = !!option && option.blockers.length > 0;
  const reasonOk = reason.trim().length >= 10;
  return (
    <div className={`${CARD} mt-2 flex w-full flex-col gap-3 text-sm`} data-testid="entry-correction-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">Correct entry — {recordLabel}</h3>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {!options ? <p className="text-zinc-500">{pending ? "Loading…" : ""}</p> : null}
      {options && options.length === 0 ? <p className="text-zinc-500">Nothing on this record can be corrected here.</p> : null}

      {options && options.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">What to correct</legend>
          {options.map((o) => (
            <label key={o.kind} className="flex items-start gap-2">
              <input type="radio" name={`entry-kind-${recordLabel}`} className="mt-1 h-4 w-4 shrink-0" checked={kind === o.kind} onChange={() => choose(o)} />
              <span className="min-w-0">
                <span className="font-medium text-zinc-800 dark:text-zinc-200">{o.label}</span>
                <span className="block text-xs text-zinc-500">{ENTRY_CLASS_LABEL[o.entryClass]}</span>
                {o.blockers.length ? (
                  <span className="block text-xs font-medium text-red-600 dark:text-red-400" data-testid={`entry-blockers-${o.kind}`}>
                    Blocked: {o.blockers.map((b) => `${b.code} — ${b.message}`).join(" ")}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {option ? (
        <div className="flex flex-col gap-3">
          {option.note ? <p className="text-xs text-zinc-600 dark:text-zinc-400">{option.note}</p> : null}
          {option.fields.map((f) => (
            <label key={f.field} className="flex flex-col gap-1">
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{f.label}</span>
              {f.type === "textarea" ? (
                <textarea aria-label={f.label} className={INPUT} rows={2} maxLength={f.maxLength} value={values[f.field] ?? ""} disabled={blocked} onChange={(e) => edit({ [f.field]: e.target.value })} />
              ) : (
                <input
                  aria-label={f.label}
                  className={`${INPUT} h-10`}
                  type={f.type === "date" ? "date" : f.type === "integer" ? "number" : "text"}
                  inputMode={f.type === "integer" ? "numeric" : undefined}
                  step={f.type === "integer" ? 1 : undefined}
                  min={f.type === "integer" ? 1 : undefined}
                  maxLength={f.maxLength}
                  value={values[f.field] ?? ""}
                  disabled={blocked}
                  onChange={(e) => edit({ [f.field]: e.target.value })}
                />
              )}
              <span className="text-xs text-zinc-500">Saved now: {f.current || "(empty)"}</span>
            </label>
          ))}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Reason (at least 10 characters)</span>
            <textarea aria-label="Reason for the correction" className={INPUT} rows={2} maxLength={500} value={reason} disabled={blocked} onChange={(e) => { setReason(e.target.value); setPreview(null); }} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="md" disabled={pending || blocked || !reasonOk} onClick={runPreview}>
              {pending && !preview ? "Checking…" : "Preview"}
            </Button>
            {preview && !preview.blockers.length ? (
              <Button type="button" size="md" disabled={pending} onClick={confirm}>
                {pending ? "Saving…" : "Confirm correction"}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {preview ? <PreviewView preview={preview} /> : null}
    </div>
  );
}

function PreviewView({ preview }: { preview: EntryPreview }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="entry-correction-preview">
      <p className="font-medium">
        {preview.entityLabel} · {ENTRY_CLASS_LABEL[preview.entryClass]}
      </p>
      <ul className="flex flex-col gap-1" data-testid="entry-preview-changes">
        {preview.changes.map((c) => (
          <li key={c.field} className="break-words">
            {c.label}: <span className="line-through opacity-70">{c.before}</span> → <strong>{c.after}</strong>
          </li>
        ))}
      </ul>
      {preview.stock.length ? (
        <div data-testid="entry-preview-stock">
          <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Stock</p>
          {preview.stock.map((s) => (
            <p key={s.label} className="break-words">
              {s.label}: {s.pieces > 0 ? `+${s.pieces}` : s.pieces} pcs · {Number(s.carat) > 0 ? `+${s.carat}` : s.carat} ct
              {s.cost !== null ? ` · ₹${s.cost}` : ""}
            </p>
          ))}
        </div>
      ) : null}
      <div data-testid="entry-preview-ledger">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Accounting</p>
        {preview.ledger.length === 0 ? (
          <p>No voucher and no journal entry — accounts are not touched.</p>
        ) : (
          preview.ledger.map((l, i) => (
            <p key={i} className="break-words">
              {Number(l.debit) > 0 ? `Dr ${l.accountCode} ${l.accountName} ₹${l.debit}` : `Cr ${l.accountCode} ${l.accountName} ₹${l.credit}`}
              {l.party ? ` (${l.party})` : ""}
            </p>
          ))
        )}
      </div>
      {preview.affected.length ? <p className="text-xs">Also affects: {preview.affected.join(", ")}</p> : null}
      {preview.blockers.length ? (
        <Alert tone="error">Cannot be posted: {preview.blockers.map((b) => `${b.code} — ${b.message}`).join(" ")}</Alert>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Correction history (Owner and Staff; money only arrives for the Owner)
// ---------------------------------------------------------------------------

export function EntryCorrectionHistory({ items, isOwner, onDone }: { items: EntryHistoryItem[]; isOwner: boolean; onDone?: (message: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6" data-testid="entry-correction-history">
      <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Correction history</h3>
      <ul className="flex flex-col gap-3">
        {items.map((h) => (
          <HistoryItem key={h.id} item={h} isOwner={isOwner} onDone={onDone} />
        ))}
      </ul>
    </div>
  );
}

function HistoryItem({ item, isOwner, onDone }: { item: EntryHistoryItem; isOwner: boolean; onDone?: (message: string) => void }) {
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <li className={`${CARD} text-sm`} data-testid={`entry-history-${item.code}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-zinc-900 dark:text-zinc-50">{item.code}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${item.state === "ACTIVE" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`} data-testid="entry-history-state">
          {item.state === "ACTIVE" ? "Active correction" : "Reversed"}
        </span>
        <span className="text-xs text-zinc-500">
          {KIND_LABEL[item.kind]} · {item.entityLabel}
        </span>
      </div>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        By {item.by} on {new Date(item.at).toLocaleString("en-IN")} · Reason: {item.reason}
        {item.voucher ? ` · Voucher ${item.voucher}${item.amount ? ` ₹${item.amount}` : ""}` : ""}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5 text-xs">
        {item.changes.map((c, i) => (
          <li key={i} className="break-words">
            {c.record} · {FIELD_LABELS[c.field] ?? c.field}: <span className="line-through opacity-70">{c.before || "(empty)"}</span> → {c.after || "(empty)"}
          </li>
        ))}
      </ul>
      {item.reversal ? (
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400" data-testid="entry-history-reversal">
          Reversed by {item.reversal.code} ({item.reversal.by}, {new Date(item.reversal.at).toLocaleString("en-IN")}): {item.reversal.reason}
        </p>
      ) : null}
      {isOwner && item.state === "ACTIVE" && !item.canReverse && item.reverseBlockers.length ? (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">Cannot be reversed now: {item.reverseBlockers.join(" ")}</p>
      ) : null}
      {isOwner && item.canReverse ? (
        reversing ? (
          <div className="mt-2 flex flex-col gap-2">
            {error ? <Alert tone="error">{error}</Alert> : null}
            <textarea aria-label={`Reason for reversing ${item.code}`} className={INPUT} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="danger"
                size="md"
                disabled={pending || reason.trim().length < 10}
                onClick={() =>
                  start(async () => {
                    const res = await reverseEntryCorrectionAction({ correctionId: item.id, reason });
                    if (!res.ok) return setError(res.error);
                    setReversing(false);
                    onDone?.(`${item.code} reversed by ${res.data.code}.`);
                  })
                }
              >
                {pending ? "Reversing…" : "Confirm reversal"}
              </Button>
              <Button type="button" variant="ghost" size="md" onClick={() => setReversing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" className="mt-2 text-xs font-medium underline underline-offset-2" onClick={() => setReversing(true)}>
            Reverse this correction
          </button>
        )
      ) : null}
    </li>
  );
}
