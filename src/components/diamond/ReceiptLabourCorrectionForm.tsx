"use client";

import { useActionState, useState } from "react";

import {
  postLabourCorrectionAction,
  previewLabourCorrectionAction,
  reverseLabourCorrectionAction,
  type LabourCorrectionFormState,
} from "@/app/actions/diamondLabourCorrection";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";

function money(v: string) {
  return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const inputClass =
  "mt-1 h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

/**
 * Owner-only, audited: raise a posted Manufacturer receipt's labour. Two steps
 * — a server preview of exactly what posts (outputs before/after, the
 * correction voucher), then confirm with the preview's fingerprint so a change
 * in between is refused rather than posted unseen.
 */
export function ReceiptLabourCorrectionForm({
  receiptId,
  receiptCode,
  currentLabour,
  suggestion,
  onDone,
}: {
  receiptId: string;
  receiptCode: string;
  currentLabour: string;
  /** Labour re-priced per issued carat at the job's rate, when it has one. */
  suggestion: string | null;
  onDone?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [correctedLabour, setCorrectedLabour] = useState(suggestion ?? "");
  const [reason, setReason] = useState("");
  const [idempotencyKey] = useState(() => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `lab-${Date.now()}-${Math.random()}`));
  const [previewState, previewAction, previewing] = useActionState(previewLabourCorrectionAction, undefined);
  // Notify the parent as the action resolves: revalidation re-renders this
  // receipt with its correction in the same commit, unmounting this form.
  const [postState, postAction, posting] = useActionState(async (prev: LabourCorrectionFormState, formData: FormData) => {
    const result = await postLabourCorrectionAction(prev, formData);
    if (result?.success) onDone?.(`${receiptCode} labour corrected (${result.code}).`);
    return result;
  }, undefined);

  if (postState?.success) {
    return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Labour corrected ({postState.code}).</span>;
  }
  if (!open) {
    return (
      <Button type="button" variant="secondary" size="md" onClick={() => setOpen(true)}>
        Correct labour
      </Button>
    );
  }

  const preview = previewState?.preview;
  const edited = preview && (preview.correctedLabour !== Number(correctedLabour || 0).toFixed(2));

  return (
    <div className="mt-2 flex w-full min-w-[320px] max-w-xl flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left dark:border-amber-900 dark:bg-amber-950/30" data-testid="labour-correction">
      <form action={previewAction} className="flex flex-col gap-2">
        <input type="hidden" name="receiptId" value={receiptId} />
        <p className="text-xs text-zinc-700 dark:text-zinc-300">
          Posted labour on {receiptCode}: <strong>{money(currentLabour)}</strong>
          {suggestion ? (
            <>
              {" "}· per issued carat at this job&apos;s rate: <strong>{money(suggestion)}</strong>
            </>
          ) : null}
        </p>
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Corrected labour for this receipt (₹)
          <input name="correctedLabour" inputMode="decimal" value={correctedLabour} onChange={(e) => setCorrectedLabour(e.target.value.trim())} className={inputClass} />
        </label>
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Reason (required, at least 10 characters)
          <input
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Polishing is charged per issued carat, not per received carat"
            className={inputClass}
          />
        </label>
        {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
        <div className="flex gap-2">
          <Button type="submit" variant="secondary" size="md" disabled={previewing || reason.trim().length < 10 || !correctedLabour}>
            {previewing ? "Loading preview…" : "Preview correction"}
          </Button>
          <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </form>

      {preview && !edited ? (
        <form action={postAction} className="flex flex-col gap-2 border-t border-amber-200 pt-2 dark:border-amber-900" data-testid="labour-correction-preview">
          <input type="hidden" name="receiptId" value={receiptId} />
          <input type="hidden" name="correctedLabour" value={preview.correctedLabour} />
          <input type="hidden" name="reason" value={reason} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <input type="hidden" name="previewFingerprint" value={preview.fingerprint} />
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Preview — {preview.receiptCode} · {preview.jobCode} · {preview.manufacturerName}
            {preview.processName ? ` · ${preview.processName}` : ""}
          </p>
          <p className="text-xs text-zinc-700 dark:text-zinc-300">
            Labour {money(preview.previousLabour)} → <strong>{money(preview.correctedLabour)}</strong> (adds <strong>{money(preview.added)}</strong>)
          </p>
          <table className="w-full text-xs">
            <thead className="text-left text-zinc-500">
              <tr>
                <th className="py-1">Output</th>
                <th className="py-1">Carat</th>
                <th className="py-1">Adds</th>
                <th className="py-1">Cost before → after</th>
              </tr>
            </thead>
            <tbody>
              {preview.outputs.map((o) => (
                <tr key={o.code}>
                  <td className="py-1">{o.code}{o.kind === "PACKET" ? " (parcel)" : ""}</td>
                  <td className="py-1">{o.carat}ct</td>
                  <td className="py-1">{money(o.added)}</td>
                  <td className="py-1">{money(o.costBefore)} → {money(o.costAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="text-xs text-zinc-700 dark:text-zinc-300">
            {preview.ledgerLines.map((l) => (
              <li key={l.account}>
                {l.debit ? `Dr ${l.account} ${money(l.debit)}` : `Cr ${l.account} ${money(l.credit ?? "0")}`}
              </li>
            ))}
          </ul>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            The original receipt and its voucher stay exactly as posted. One correction voucher is added, recorded with your name, the date and the reason, and it can be reversed.
          </p>
          {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}
          <Button type="submit" variant="primary" size="md" disabled={posting}>
            {posting ? "Posting…" : "Confirm correction"}
          </Button>
        </form>
      ) : null}
      {preview && edited ? <p className="text-xs text-amber-700 dark:text-amber-400">You changed the amount — preview again before confirming.</p> : null}
    </div>
  );
}

/** Owner-only: undo a posted labour correction (only while the outputs are untouched). */
export function ReverseLabourCorrectionForm({ correctionId, onDone }: { correctionId: string; onDone?: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(async (prev: LabourCorrectionFormState, formData: FormData) => {
    const result = await reverseLabourCorrectionAction(prev, formData);
    if (result?.success) onDone?.(`Labour correction reversed (${result.code}).`);
    return result;
  }, undefined);
  if (state?.success) return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Reversed ({state.code}).</span>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-red-600 hover:underline dark:text-red-400">
        Reverse correction
      </button>
    );
  }
  return (
    <form action={action} className="mt-1 flex flex-col gap-1.5">
      <input type="hidden" name="correctionId" value={correctionId} />
      <input name="reason" placeholder="Reason for reversing (at least 10 characters)" className={inputClass} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" size="md" disabled={pending}>
          {pending ? "Reversing…" : "Confirm reversal"}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}
