"use client";

import { useActionState, useEffect, useState } from "react";

import {
  previewReceiptChargesAction,
  postReceiptChargesAction,
  reverseReceiptChargesAction,
} from "@/app/actions/receiptCharges";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { ReceiptChargePanel, ReceiptChargeCorrectionView } from "@/lib/jewellery/receiptChargePanels";

const CATEGORIES = [
  { key: "labourCharge", label: "Labour" },
  { key: "makingCharge", label: "Making" },
  { key: "settingCharge", label: "Setting" },
  { key: "platingCharge", label: "Plating" },
  { key: "otherExpense", label: "Other expense" },
] as const;

type Values = Record<(typeof CATEGORIES)[number]["key"], string>;
const EMPTY: Values = { labourCharge: "", makingCharge: "", settingCharge: "", platingCharge: "", otherExpense: "" };

function breakdown(amounts: Record<string, string>): string {
  const parts = CATEGORIES.filter((c) => Number(amounts[c.key]) > 0).map((c) => `${c.label} ₹${amounts[c.key]}`);
  return parts.length ? parts.join(" · ") : "none";
}

/**
 * Owner-only. For each receipt: what was originally charged, what has been
 * added since through audited corrections, "Add missing charges", and the
 * reversal of an earlier addition (only while its pieces are still Available
 * and unsold). Staff never receive this data.
 */
export function ReceiptChargesPanel({ panels, onDone }: { panels: ReceiptChargePanel[]; onDone?: () => void }) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  if (panels.length === 0) return null;
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
      <h3 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Karigar charges by receipt</h3>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        A receipt&apos;s saved charges are never edited. If labour, making, setting, plating or other charges were left out, add them here — they are posted as an audited correction
        and added to the finished piece&apos;s cost and the Karigar&apos;s payable together.
      </p>
      <ul className="flex flex-col gap-4">
        {panels.map((p) => (
          <li key={p.receiptId} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{p.receiptCode}</p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  As saved: ₹{p.originalTotal} ({breakdown(p.originalAmounts)})
                  {Number(p.addedLaterTotal) > 0 ? ` · Added later by correction: ₹${p.addedLaterTotal}` : ""}
                </p>
              </div>
              {p.addBlockedReason ? null : (
                <Button
                  type="button"
                  variant={openFor === p.receiptId ? "primary" : "secondary"}
                  size="md"
                  onClick={() => setOpenFor((cur) => (cur === p.receiptId ? null : p.receiptId))}
                >
                  {openFor === p.receiptId ? "Close" : "Add missing charges"}
                </Button>
              )}
            </div>
            {p.addBlockedReason ? (
              <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">Missing charges cannot be added: {p.addBlockedReason}</p>
            ) : null}
            {openFor === p.receiptId && !p.addBlockedReason ? (
              <AddMissingChargesForm
                receiptId={p.receiptId}
                receiptCode={p.receiptCode}
                onDone={() => {
                  setOpenFor(null);
                  onDone?.();
                }}
              />
            ) : null}
            {p.corrections.length > 0 ? (
              <ul className="mt-3 flex flex-col gap-2">
                {p.corrections.map((c) => (
                  <CorrectionRow key={c.id} c={c} onDone={onDone} />
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddMissingChargesForm({ receiptId, receiptCode, onDone }: { receiptId: string; receiptCode: string; onDone?: () => void }) {
  const [previewState, previewAction, previewPending] = useActionState(previewReceiptChargesAction, undefined);
  const [postState, postAction, postPending] = useActionState(postReceiptChargesAction, undefined);
  const [values, setValues] = useState<Values>(EMPTY);
  const [reason, setReason] = useState("");
  // One key per form instance: a double-click or a re-sent request is the SAME
  // Owner action and the server posts it once.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [previewedInputs, setPreviewedInputs] = useState("");
  const currentInputs = JSON.stringify({ values, reason });

  useEffect(() => {
    if (postState?.success) onDone?.();
  }, [postState?.success, onDone]);

  const preview = previewState?.preview;
  const fresh = Boolean(preview) && previewedInputs === currentInputs;
  const total = CATEGORIES.reduce((s, c) => s + (Number(values[c.key]) || 0), 0);

  if (postState?.success) {
    return (
      <Alert tone="success">
        {postState.replayed ? "This correction was already posted" : "Charges added"} — {postState.code}.
      </Alert>
    );
  }

  return (
    <form className="mt-3 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <input type="hidden" name="receiptId" value={receiptId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="previewFingerprint" value={fresh && preview ? preview.fingerprint : ""} />

      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}

      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Enter only the amounts that were left out of {receiptCode}. Each is added to the finished piece&apos;s cost and to the Karigar&apos;s payable.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {CATEGORIES.map((c) => (
          <Field
            key={c.key}
            label={`${c.label} charge (₹)`}
            name={c.key}
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            value={values[c.key]}
            onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.value }))}
          />
        ))}
      </div>
      <Field
        label="Reason (required, at least 10 characters)"
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        minLength={10}
        maxLength={500}
      />
      <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Total to add: ₹{total.toFixed(2)}</p>

      {preview && fresh ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="charge-preview">
          <p className="font-medium text-zinc-900 dark:text-zinc-50">
            Preview — nothing is saved yet. ₹{preview.total} will be added to {preview.receiptCode} ({preview.jobCode}).
          </p>
          <ul className="mt-2 list-disc pl-5 text-xs text-zinc-700 dark:text-zinc-300">
            {preview.charges.map((c) => (
              <li key={c.key}>
                {c.label}: ₹{c.amount}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">Finished piece cost</p>
          <ul className="list-disc pl-5 text-xs text-zinc-700 dark:text-zinc-300">
            {preview.pieces.map((pc) => (
              <li key={pc.code}>
                {pc.code}: +₹{pc.added} — labour ₹{pc.labourBefore} → ₹{pc.labourAfter}, total cost ₹{pc.totalBefore} → ₹{pc.totalAfter}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">Accounting entry (balanced)</p>
          <ul className="list-disc pl-5 text-xs text-zinc-700 dark:text-zinc-300">
            {preview.ledgerLines.map((l, i) => (
              <li key={i}>
                {l.debit ? `Debit ₹${l.debit}` : `Credit ₹${l.credit}`} — {l.account}
              </li>
            ))}
          </ul>
          {preview.downstream.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">
              {preview.downstream.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant="secondary"
          size="md"
          formAction={previewAction}
          disabled={previewPending || postPending || total <= 0 || reason.trim().length < 10}
          onClick={() => {
            setPreviewedInputs(currentInputs);
          }}
        >
          {previewPending ? "Preparing…" : "Preview"}
        </Button>
        {preview && fresh ? (
          <Button
            type="submit"
            size="md"
            formAction={postAction}
            disabled={postPending || previewPending}
            onClick={(e) => {
              if (
                !window.confirm(
                  `Add ₹${preview.total} of missing charges to ${preview.receiptCode}?\n\nThis raises the finished piece's cost and the payable to ${preview.karigarName} by ₹${preview.total}, and is recorded as an audited correction.`
                )
              ) {
                e.preventDefault();
              }
            }}
          >
            {postPending ? "Posting…" : "Post correction"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function CorrectionRow({ c, onDone }: { c: ReceiptChargeCorrectionView; onDone?: () => void }) {
  const [state, action, pending] = useActionState(reverseReceiptChargesAction, undefined);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-xs text-zinc-700 dark:text-zinc-300">
      <p className="font-medium text-zinc-900 dark:text-zinc-50">
        {c.correctionCode} · +₹{c.total} ({breakdown(c.amounts)}){" "}
        <span
          className={
            c.state === "POSTED"
              ? "rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          }
        >
          {c.state === "POSTED" ? "Active" : `Reversed${c.reversedByCode ? ` by ${c.reversedByCode}` : ""}`}
        </span>
      </p>
      <p>
        {c.pieces.map((p) => `${p.code} +₹${p.added}`).join(", ")}
        {c.voucherNumber ? ` · Voucher ${c.voucherNumber}` : ""}
        {c.postedAt ? ` · ${new Date(c.postedAt).toLocaleDateString("en-IN")}` : ""}
      </p>
      <p className="text-zinc-500 dark:text-zinc-400">Reason: {c.reason}</p>
      {c.state === "POSTED" ? (
        c.reverseBlockedReason ? (
          <p className="mt-1 font-medium text-amber-700 dark:text-amber-400">Cannot be reversed: {c.reverseBlockedReason}</p>
        ) : state?.success ? (
          <Alert tone="success">Reversed — {state.code}.</Alert>
        ) : open ? (
          <form
            action={action}
            className="mt-2 flex flex-col gap-2"
            onSubmit={(e) => {
              if (!window.confirm(`Reverse ${c.correctionCode}? This removes ₹${c.total} from the piece cost and the Karigar payable, and posts a mirror entry.`)) {
                e.preventDefault();
              }
            }}
          >
            <input type="hidden" name="correctionId" value={c.id} />
            {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
            <Field
              label="Reason for reversing (at least 10 characters)"
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={10}
              maxLength={500}
            />
            <div className="flex gap-2">
              <Button type="submit" variant="danger" size="md" disabled={pending}>
                {pending ? "Reversing…" : "Confirm reversal"}
              </Button>
              <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
                Back
              </Button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="mt-1 font-medium text-red-700 underline underline-offset-4 dark:text-red-400">
            Reverse this correction
          </button>
        )
      ) : null}
    </li>
  );
}
