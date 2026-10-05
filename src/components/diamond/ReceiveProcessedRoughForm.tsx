"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { receiveProcessedRoughAction } from "@/app/actions/diamond";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { pcsCt } from "@/components/diamond/roughOrigin";

type PieceDraft = { carat: string; colorEstimate: string; clarityNote: string };
const emptyPiece = (): PieceDraft => ({ carat: "", colorEstimate: "", clarityNote: "" });
type BatchDraft = { pieces: string; carat: string; colorEstimate: string; clarityNote: string };
const emptyBatch = (): BatchDraft => ({ pieces: "", carat: "", colorEstimate: "", clarityNote: "" });

export type ReturnMode = "BATCH" | "INDIVIDUAL";
export const MODE_LABELS: Record<ReturnMode, string> = {
  BATCH: "Batch / parcel — enter total pieces and total weight",
  INDIVIDUAL: "Individual pieces — enter each piece separately",
};

const INPUT = "h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

/** Exact thousandths so the pending check never drifts. */
function ct1000(value: string | number): number {
  return Math.round((Number(value) || 0) * 1000);
}
const fmt = (thousandths: number) => (thousandths / 1000).toFixed(3);
const CARAT_PATTERN = /^\d+(\.\d{1,3})?$/;
const WHOLE_PATTERN = /^\d+$/;

export function ReceiveProcessedRoughForm({
  jobId,
  jobCode,
  processName,
  pendingCarat,
  issuedPieces,
  issuedCarat,
  returnedPieces,
  returnedCarat,
  chargeFromAgreedRate,
  onDone,
}: {
  jobId: string;
  jobCode: string;
  processName: string;
  pendingCarat: string;
  /** The job as issued, and what its earlier receipts returned. */
  issuedPieces: number;
  issuedCarat: string;
  returnedPieces: number;
  returnedCarat: string;
  chargeFromAgreedRate: boolean;
  /** Called with the receipt code once saved. */
  onDone?: (code: string) => void;
}) {
  // Success is reported from inside the action, before React commits its
  // result: the same server refresh can complete the job and unmount this form
  // in that commit, so an effect watching `state` would never run.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  const [state, formAction, pending] = useActionState(async (prev: Awaited<ReturnType<typeof receiveProcessedRoughAction>>, formData: FormData) => {
    const result = await receiveProcessedRoughAction(prev, formData);
    if (result?.success) onDoneRef.current?.(result.code ?? "");
    return result;
  }, undefined);
  const [mode, setMode] = useState<ReturnMode>("BATCH");
  const [batch, setBatch] = useState<BatchDraft>(emptyBatch());
  const [pieces, setPieces] = useState<PieceDraft[]>([emptyPiece()]);
  const [markJobComplete, setMarkJobComplete] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  // ---- This return, in the active mode only ----
  const validRows = pieces.filter((p) => ct1000(p.carat) > 0);
  const batchPiecesValid = WHOLE_PATTERN.test(batch.pieces.trim()) && Number(batch.pieces) >= 1;
  const batchCaratValid = CARAT_PATTERN.test(batch.carat.trim()) && ct1000(batch.carat) > 0;
  const thisPieces = mode === "BATCH" ? (batchPiecesValid ? Number(batch.pieces) : 0) : validRows.length;
  const thisCarat = mode === "BATCH" ? (batchCaratValid ? ct1000(batch.carat) : 0) : validRows.reduce((sum, p) => sum + ct1000(p.carat), 0);
  const gap = ct1000(pendingCarat) - thisCarat;
  const willComplete = gap === 0 || markJobComplete;
  const totalPiecesAfter = returnedPieces + thisPieces;
  const totalCaratAfter = ct1000(returnedCarat) + thisCarat;

  const batchError =
    mode !== "BATCH"
      ? null
      : batch.pieces.trim() !== "" && !batchPiecesValid
        ? "Returned pieces must be a whole number of at least 1."
        : batch.carat.trim() !== "" && !batchCaratValid
          ? "Total returned carat must be more than zero, with at most 3 decimals."
          : null;
  const canSubmit = !pending && gap >= 0 && thisCarat > 0 && (mode === "BATCH" ? batchPiecesValid && batchCaratValid : validRows.length > 0);

  function hasData(m: ReturnMode) {
    return m === "BATCH"
      ? Object.values(batch).some((v) => v.trim() !== "")
      : pieces.some((p) => p.carat.trim() !== "" || p.colorEstimate.trim() !== "" || p.clarityNote.trim() !== "");
  }

  function switchMode(next: ReturnMode) {
    if (next === mode) return;
    if (hasData(mode)) {
      const what = mode === "BATCH" ? "the batch pieces, carat, colour and clarity" : "every individual piece row";
      if (!window.confirm(`Switching to "${MODE_LABELS[next]}" will clear ${what} you have entered. Continue?`)) return;
      if (mode === "BATCH") setBatch(emptyBatch());
      else setPieces([emptyPiece()]);
    }
    setMode(next);
  }

  function update(index: number, patch: Partial<PieceDraft>) {
    setPieces((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!canSubmit) {
      event.preventDefault();
      return;
    }
    const summary = willComplete
      ? `This will COMPLETE job ${jobCode}. This return: ${pcsCt(thisPieces, fmt(thisCarat))}. Weight loss: ${fmt(Math.max(gap, 0))} ct.`
      : `Partial return for job ${jobCode}: ${pcsCt(thisPieces, fmt(thisCarat))}. ${fmt(gap)} ct stays with the Manufacturer (not counted as loss).`;
    if (!window.confirm(`${summary}\n\nSave this return?`)) event.preventDefault();
  }

  const piecesForSubmit = validRows.map((p) => ({
    carat: p.carat,
    colorEstimate: p.colorEstimate || undefined,
    clarityNote: p.clarityNote || undefined,
  }));

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      data-testid="processed-rough-form"
      noValidate
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="markJobComplete" value={markJobComplete ? "true" : "false"} />
      <input type="hidden" name="mode" value={mode} />
      {mode === "BATCH" ? (
        <>
          <input type="hidden" name="batchPieces" value={batch.pieces.trim()} />
          <input type="hidden" name="batchCarat" value={batch.carat.trim()} />
          <input type="hidden" name="batchColor" value={batch.colorEstimate} />
          <input type="hidden" name="batchClarity" value={batch.clarityNote} />
        </>
      ) : (
        <input type="hidden" name="piecesJson" value={JSON.stringify(piecesForSubmit)} />
      )}

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Processed rough received as {state.code}.</Alert> : null}

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {processName} returns rough. The number of pieces may differ from what was issued — only a carat difference is ever weight loss.
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">How was it returned?</legend>
        {(["BATCH", "INDIVIDUAL"] as const).map((m) => (
          <label key={m} className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input type="radio" name="returnMode" value={m} checked={mode === m} onChange={() => switchMode(m)} className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{MODE_LABELS[m]}</span>
          </label>
        ))}
      </fieldset>

      <Field label="Receive date" name="receiveDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />

      {mode === "BATCH" ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="batch-fields">
          <Field
            label="Returned pieces"
            name="batchPiecesInput"
            type="number"
            inputMode="numeric"
            step="1"
            min={1}
            value={batch.pieces}
            onChange={(e) => setBatch((b) => ({ ...b, pieces: e.target.value }))}
          />
          <Field
            label="Total returned carat"
            name="batchCaratInput"
            type="number"
            inputMode="decimal"
            step="0.001"
            min={0}
            value={batch.carat}
            onChange={(e) => setBatch((b) => ({ ...b, carat: e.target.value }))}
          />
          <Field label="Colour (optional)" name="batchColorInput" value={batch.colorEstimate} onChange={(e) => setBatch((b) => ({ ...b, colorEstimate: e.target.value }))} />
          <Field label="Clarity note (optional)" name="batchClarityInput" value={batch.clarityNote} onChange={(e) => setBatch((b) => ({ ...b, clarityNote: e.target.value }))} />
          {batchError ? <p className="text-sm font-medium text-red-600 dark:text-red-400 sm:col-span-2">{batchError}</p> : null}
          <p className="text-xs text-zinc-500 dark:text-zinc-400 sm:col-span-2">
            Saved as ONE rough parcel of these pieces at this total weight. No single stone gets its own weight.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2" data-testid="individual-fields">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            Processed rough pieces ({pcsCt(validRows.length, fmt(thisCarat))})
          </h3>
          {pieces.map((piece, index) => (
            <div key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-4">
              <input aria-label="Carat" type="number" min="0" step="0.001" placeholder="Carat" value={piece.carat} onChange={(e) => update(index, { carat: e.target.value })} className={INPUT} />
              <input aria-label="Colour" placeholder="Colour (optional)" value={piece.colorEstimate} onChange={(e) => update(index, { colorEstimate: e.target.value })} className={INPUT} />
              <input aria-label="Clarity note" placeholder="Clarity note (optional)" value={piece.clarityNote} onChange={(e) => update(index, { clarityNote: e.target.value })} className={INPUT} />
              {pieces.length > 1 ? (
                <button type="button" onClick={() => setPieces((prev) => prev.filter((_, i) => i !== index))} className="text-left text-xs font-medium text-red-600 hover:underline dark:text-red-400">
                  Remove
                </button>
              ) : null}
            </div>
          ))}
          <Button type="button" variant="secondary" size="md" onClick={() => setPieces((prev) => [...prev, emptyPiece()])} className="self-start">
            + Add another piece
          </Button>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Each row becomes one rough stone with its own weight.</p>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm sm:grid-cols-2" data-testid="return-summary">
        <SummaryRow id="issued" label="Originally issued" value={pcsCt(issuedPieces, issuedCarat)} />
        <SummaryRow id="previous" label="Previously returned" value={pcsCt(returnedPieces, returnedCarat)} />
        <SummaryRow id="this" label="This return" value={pcsCt(thisPieces, fmt(thisCarat))} strong />
        <SummaryRow id="after" label="Total returned after save" value={pcsCt(totalPiecesAfter, fmt(totalCaratAfter))} />
        <SummaryRow id="pending" label="Carat still pending after save" value={gap >= 0 ? `${fmt(willComplete ? 0 : gap)} ct` : "—"} />
        <SummaryRow id="loss" label="Final weight loss if completing" value={gap >= 0 ? `${fmt(gap)} ct` : "—"} />
      </dl>

      {chargeFromAgreedRate ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">The process charge is calculated from this job&apos;s agreed rate when you save.</p>
      ) : (
        <Field label="Process charge (₹)" name="manualCharge" type="number" step="0.01" min={0} defaultValue="0" />
      )}
      <Field label="Notes" name="notes" />

      {gap > 0 ? (
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={markJobComplete} onChange={(e) => setMarkJobComplete(e.target.checked)} className="h-4 w-4 shrink-0 rounded border-zinc-300" />
          Nothing more will come back — record the remaining {fmt(gap)} ct as weight loss and complete the job
        </label>
      ) : null}
      {gap < 0 ? <p className="text-sm font-medium text-red-600 dark:text-red-400">More than the {pendingCarat} ct still pending.</p> : null}

      <Button type="submit" size="lg" disabled={!canSubmit} className="self-start">
        {pending ? "Saving…" : "Save processed rough"}
      </Button>
    </form>
  );
}

function SummaryRow({ id, label, value, strong }: { id: string; label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className={strong ? "font-semibold text-zinc-900 dark:text-zinc-50" : "text-zinc-800 dark:text-zinc-200"} data-testid={`summary-${id}`}>
        {value}
      </dd>
    </div>
  );
}
