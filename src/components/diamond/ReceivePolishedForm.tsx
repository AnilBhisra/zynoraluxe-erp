"use client";

import { useActionState, useEffect, useState } from "react";

import { receivePolishedAction } from "@/app/actions/diamond";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PhotoUploadField } from "@/components/diamond/PhotoUploadField";
import { STANDARD_SHAPES } from "@/lib/diamond/shapes";

type OutputDraft = {
  shape: string;
  carat: string;
  color: string;
  clarity: string;
  cutGrade: string;
  certificateStatus: "NOT_CERTIFIED" | "INTERNAL_GRADE" | "CERTIFIED";
  certLab: string;
  certNumber: string;
  photoAssetId: string | null;
  certFileAssetId: string | null;
};

function emptyOutput(shape: string): OutputDraft {
  return {
    shape,
    carat: "",
    color: "",
    clarity: "",
    cutGrade: "",
    certificateStatus: "NOT_CERTIFIED",
    certLab: "",
    certNumber: "",
    photoAssetId: null,
    certFileAssetId: null,
  };
}

export function ReceivePolishedForm({
  jobId,
  jobCode,
  pendingCarat,
  defaultShape,
  onDone,
}: {
  jobId: string;
  jobCode: string;
  pendingCarat: number;
  defaultShape: string;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(receivePolishedAction, undefined);
  const [outputs, setOutputs] = useState<OutputDraft[]>([emptyOutput(defaultShape)]);
  const [returnedRoughCarat, setReturnedRoughCarat] = useState("0");
  const [labourCharge, setLabourCharge] = useState("0");
  const [markJobComplete, setMarkJobComplete] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  function updateOutput(index: number, patch: Partial<OutputDraft>) {
    setOutputs((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  }
  function addOutput() {
    setOutputs((prev) => [...prev, emptyOutput(defaultShape)]);
  }
  function removeOutput(index: number) {
    setOutputs((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  const totalPolishedCarat = outputs.reduce((sum, o) => sum + (Number(o.carat) || 0), 0);
  const returnedCarat = Number(returnedRoughCarat) || 0;
  const gap = pendingCarat - totalPolishedCarat - returnedCarat;
  const willComplete = gap <= 0.0005 || markJobComplete;
  const previewLoss = willComplete ? Math.max(0, gap) : 0;
  const exceedsAvailable = totalPolishedCarat + returnedCarat > pendingCarat + 0.0005;

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (exceedsAvailable) {
      window.alert("Polished plus returned carat cannot exceed the carat still pending for this job.");
      event.preventDefault();
      return;
    }
    const summary = willComplete
      ? `This will COMPLETE job ${jobCode}. Polished: ${totalPolishedCarat.toFixed(3)}ct, Returned: ${returnedCarat.toFixed(3)}ct, Weight loss: ${previewLoss.toFixed(3)}ct.`
      : `Partial receipt for job ${jobCode}. Polished: ${totalPolishedCarat.toFixed(3)}ct, Returned: ${returnedCarat.toFixed(3)}ct. ${gap.toFixed(3)}ct remains with the Karigar.`;
    if (!window.confirm(`${summary}\n\nSave this receipt?`)) {
      event.preventDefault();
    }
  }

  const outputsForSubmit = outputs.map((o) => ({
    shape: o.shape,
    carat: o.carat,
    color: o.color || undefined,
    clarity: o.clarity || undefined,
    cutGrade: o.cutGrade || undefined,
    certificateStatus: o.certificateStatus,
    certLab: o.certLab || undefined,
    certNumber: o.certNumber || undefined,
    photoAssetId: o.photoAssetId || undefined,
    certFileAssetId: o.certFileAssetId || undefined,
  }));

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="outputsJson" value={JSON.stringify(outputsForSubmit)} />
      <input type="hidden" name="shape" value={outputs[0]?.shape ?? defaultShape} />
      <input type="hidden" name="markJobComplete" value={markJobComplete ? "true" : "false"} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Receipt saved as {state.code}.</Alert> : null}

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Pending with Karigar: <span className="font-semibold text-zinc-900 dark:text-zinc-50">{pendingCarat.toFixed(3)}ct</span>
      </p>

      <Field label="Receive date" name="receiveDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Polished diamonds received</h3>
        {outputs.map((output, index) => (
          <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              <select
                aria-label="Shape"
                value={output.shape}
                onChange={(e) => updateOutput(index, { shape: e.target.value })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              >
                {STANDARD_SHAPES.filter((s) => s.value !== "CUSTOM").map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <input
                aria-label="Carat"
                type="number"
                step="0.001"
                min="0"
                placeholder="Carat"
                value={output.carat}
                onChange={(e) => updateOutput(index, { carat: e.target.value })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <input
                aria-label="Colour"
                placeholder="Colour (optional)"
                value={output.color}
                onChange={(e) => updateOutput(index, { color: e.target.value })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <input
                aria-label="Clarity"
                placeholder="Clarity (optional)"
                value={output.clarity}
                onChange={(e) => updateOutput(index, { clarity: e.target.value })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <select
                aria-label="Certificate status"
                value={output.certificateStatus}
                onChange={(e) => updateOutput(index, { certificateStatus: e.target.value as OutputDraft["certificateStatus"] })}
                className="h-8 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              >
                <option value="NOT_CERTIFIED">Not certified</option>
                <option value="INTERNAL_GRADE">Internal grade</option>
                <option value="CERTIFIED">Certified</option>
              </select>
              {output.certificateStatus === "CERTIFIED" ? (
                <>
                  <input
                    aria-label="Cert lab"
                    placeholder="Cert lab"
                    value={output.certLab}
                    onChange={(e) => updateOutput(index, { certLab: e.target.value })}
                    className="h-8 w-32 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                  />
                  <input
                    aria-label="Cert number"
                    placeholder="Cert number"
                    value={output.certNumber}
                    onChange={(e) => updateOutput(index, { certNumber: e.target.value })}
                    className="h-8 w-40 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                  />
                  <PhotoUploadField
                    category="certificate"
                    label="Cert file"
                    assetId={output.certFileAssetId}
                    onUploaded={(assetId) => updateOutput(index, { certFileAssetId: assetId })}
                  />
                </>
              ) : null}
              <PhotoUploadField
                category="polished-diamond"
                label="Photo"
                assetId={output.photoAssetId}
                onUploaded={(assetId) => updateOutput(index, { photoAssetId: assetId })}
              />
              {outputs.length > 1 ? (
                <button
                  type="button"
                  onClick={() => removeOutput(index)}
                  className="ml-auto text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        ))}
        <Button type="button" variant="secondary" size="md" onClick={addOutput} className="self-start">
          + Add another polished diamond
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Returned unused rough carat"
          name="returnedRoughCarat"
          type="number"
          step="0.001"
          min={0}
          value={returnedRoughCarat}
          onChange={(e) => setReturnedRoughCarat(e.target.value)}
        />
        <Field
          label="Cutting-polishing labour charge (₹)"
          name="labourCharge"
          type="number"
          step="0.01"
          min={0}
          value={labourCharge}
          onChange={(e) => setLabourCharge(e.target.value)}
        />
      </div>

      {gap > 0.0005 ? (
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={markJobComplete}
            onChange={(e) => setMarkJobComplete(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300"
          />
          This completes the job — no more rough will come back from this Karigar
        </label>
      ) : null}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm">
        <p>Polished: <span className="font-semibold">{totalPolishedCarat.toFixed(3)}ct</span></p>
        <p>Returned: <span className="font-semibold">{returnedCarat.toFixed(3)}ct</span></p>
        <p>
          {willComplete ? "Weight loss (final)" : "Still with Karigar (not yet resolved)"}:{" "}
          <span className="font-semibold">{willComplete ? previewLoss.toFixed(3) : Math.max(0, gap).toFixed(3)}ct</span>
        </p>
        {willComplete ? (
          <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">This job will be marked Completed.</p>
        ) : (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">This job will be marked Partially Received.</p>
        )}
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide notes" : "Add notes (optional)"}
        </button>
      </div>
      {showMore ? <Field label="Notes" name="notes" /> : null}

      <Button type="submit" size="lg" disabled={pending || exceedsAvailable} className="self-start">
        {pending ? "Saving…" : "Receive Polished"}
      </Button>
    </form>
  );
}
