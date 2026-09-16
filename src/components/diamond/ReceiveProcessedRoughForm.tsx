"use client";

import { useActionState, useEffect, useState } from "react";

import { receiveProcessedRoughAction } from "@/app/actions/diamond";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

type PieceDraft = { carat: string; colorEstimate: string; clarityNote: string };
const emptyPiece = (): PieceDraft => ({ carat: "", colorEstimate: "", clarityNote: "" });

const INPUT = "h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

/** Exact thousandths so the pending check never drifts. */
function ct1000(value: string | number): number {
  return Math.round((Number(value) || 0) * 1000);
}
const fmt = (thousandths: number) => (thousandths / 1000).toFixed(3);

export function ReceiveProcessedRoughForm({
  jobId,
  jobCode,
  processName,
  pendingCarat,
  chargeFromAgreedRate,
  onDone,
}: {
  jobId: string;
  jobCode: string;
  processName: string;
  pendingCarat: string;
  chargeFromAgreedRate: boolean;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(receiveProcessedRoughAction, undefined);
  const [pieces, setPieces] = useState<PieceDraft[]>([emptyPiece()]);
  const [markJobComplete, setMarkJobComplete] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const processed = pieces.reduce((sum, p) => sum + ct1000(p.carat), 0);
  const gap = ct1000(pendingCarat) - processed;
  const willComplete = gap === 0 || markJobComplete;

  function update(index: number, patch: Partial<PieceDraft>) {
    setPieces((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (gap < 0) {
      window.alert(`Processed rough cannot exceed the ${pendingCarat}ct still with the Manufacturer.`);
      event.preventDefault();
      return;
    }
    const summary = willComplete
      ? `This will COMPLETE job ${jobCode}. Processed: ${fmt(processed)}ct, weight loss: ${fmt(Math.max(gap, 0))}ct.`
      : `Partial return for job ${jobCode}. ${fmt(gap)}ct stays with the Manufacturer (not counted as loss).`;
    if (!window.confirm(`${summary}\n\nSave this return?`)) event.preventDefault();
  }

  const piecesForSubmit = pieces
    .filter((p) => Number(p.carat) > 0)
    .map((p) => ({ carat: p.carat, colorEstimate: p.colorEstimate || undefined, clarityNote: p.clarityNote || undefined }));

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="markJobComplete" value={markJobComplete ? "true" : "false"} />
      <input type="hidden" name="piecesJson" value={JSON.stringify(piecesForSubmit)} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Processed rough received as {state.code}.</Alert> : null}

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        {processName} returns rough: each processed piece becomes a new Rough Diamond piece in stock. {pendingCarat}ct is still with the
        Manufacturer.
      </p>

      <Field label="Receive date" name="receiveDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Processed rough pieces ({fmt(processed)}ct)</h3>
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
      </div>

      {chargeFromAgreedRate ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">The process charge is calculated from this job&apos;s agreed rate when you save.</p>
      ) : (
        <Field label="Process charge (₹)" name="manualCharge" type="number" step="0.01" min={0} defaultValue="0" />
      )}
      <Field label="Notes" name="notes" />

      {gap > 0 ? (
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={markJobComplete} onChange={(e) => setMarkJobComplete(e.target.checked)} className="h-4 w-4 rounded border-zinc-300" />
          Nothing more will come back — record the remaining {fmt(gap)}ct as weight loss and complete the job
        </label>
      ) : null}
      {gap < 0 ? <p className="text-sm font-medium text-red-600 dark:text-red-400">More than the {pendingCarat}ct still pending.</p> : null}

      <Button type="submit" size="lg" disabled={pending || gap < 0} className="self-start">
        {pending ? "Saving…" : "Save processed rough"}
      </Button>
    </form>
  );
}
