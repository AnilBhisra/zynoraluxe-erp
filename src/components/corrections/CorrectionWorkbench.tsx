"use client";

import { useActionState, useState } from "react";

import {
  approveCorrection,
  postOpeningStockCorrection,
  previewOpeningStockCorrection,
  rejectCorrection,
  saveOpeningStockCorrectionDraft,
} from "@/app/actions/corrections";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { OpeningStockEntry } from "@/lib/corrections/history";

function money(value: string | null) {
  if (value === null) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return `₹${number.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Prepare, preview and post a correction to an Opening Metal Stock entry.
 *
 * Nothing posts without the Owner first seeing the impact preview: every
 * affected record, every downstream use, and the exact debit/credit lines.
 * The preview is read-only — it writes nothing at all.
 */
export function CorrectionWorkbench({
  entries,
  canPost,
}: {
  entries: OpeningStockEntry[];
  canPost: boolean;
}) {
  const [previewState, previewAction, previewPending] = useActionState(previewOpeningStockCorrection, undefined);
  const [postState, postAction, postPending] = useActionState(postOpeningStockCorrection, undefined);
  const [draftState, draftAction, draftPending] = useActionState(saveOpeningStockCorrectionDraft, undefined);

  const [movementId, setMovementId] = useState(entries[0]?.id ?? "");
  const [operation, setOperation] = useState<"BACKFILL" | "REVALUE">("REVALUE");
  const [newCostValue, setNewCostValue] = useState("");
  const [reason, setReason] = useState("");
  const [batchCode, setBatchCode] = useState("");
  const [batchStep, setBatchStep] = useState("1");
  const [batchRequiredSteps, setBatchRequiredSteps] = useState("2");
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const preview = previewState?.preview;
  const selected = entries.find((e) => e.id === movementId);
  const sharedFields = (
    <>
      <input type="hidden" name="movementId" value={movementId} />
      <input type="hidden" name="reason" value={reason} />
      {operation === "REVALUE" ? <input type="hidden" name="newCostValue" value={newCostValue} /> : null}
      {batchCode ? (
        <>
          <input type="hidden" name="batchCode" value={batchCode} />
          <input type="hidden" name="batchStep" value={batchStep} />
          <input type="hidden" name="batchRequiredSteps" value={batchRequiredSteps} />
        </>
      ) : null}
    </>
  );

  if (entries.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-zinc-300 px-4 py-6 text-sm text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
        There is no Opening Metal Stock entry to correct yet.
      </p>
    );
  }

  return (
    <section
      data-testid="correction-workbench"
      className="mb-8 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm sm:p-5"
    >
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Correct an Opening Stock entry</h2>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        The original entry is never changed. A correction adds a linked, audited entry. / મૂળ એન્ટ્રી બદલાતી નથી.
      </p>

      <form action={previewAction} className="mt-4 flex flex-col gap-3">
        {sharedFields}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-700 dark:text-zinc-300">Opening entry</span>
            <select
              aria-label="Opening entry"
              value={movementId}
              onChange={(e) => setMovementId(e.target.value)}
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
            >
              {entries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} — {entry.costValue}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-zinc-700 dark:text-zinc-300">Correction</span>
            <select
              aria-label="Correction type"
              value={operation}
              onChange={(e) => setOperation(e.target.value as "BACKFILL" | "REVALUE")}
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100"
            >
              <option value="BACKFILL">Post to the ledger at the saved value (R1)</option>
              <option value="REVALUE">Correct the value (R2)</option>
            </select>
          </label>
        </div>

        {selected ? (
          <p data-testid="selected-entry" className="text-xs text-zinc-600 dark:text-zinc-400">
            {selected.grossWeight}g gross / {selected.fineWeight}g fine, saved at {money(selected.costValue)}.{" "}
            {selected.postedToLedger ? "Already on the ledger." : "Not yet on the ledger."}
          </p>
        ) : null}

        {operation === "REVALUE" ? (
          <Field
            label="Corrected total value (₹)"
            name="newCostValueVisible"
            type="number"
            step="0.01"
            min={0}
            value={newCostValue}
            onChange={(e) => setNewCostValue(e.target.value)}
          />
        ) : null}

        <Field
          label="Reason (required)"
          name="reasonVisible"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <details className="rounded-lg border border-[var(--border)] px-3 py-2 text-sm">
          <summary className="cursor-pointer text-zinc-700 dark:text-zinc-300">
            Part of a multi-step correction batch
          </summary>
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Batch code" name="batchCodeVisible" value={batchCode} onChange={(e) => setBatchCode(e.target.value)} />
            <Field label="Step" name="batchStepVisible" type="number" min={1} value={batchStep} onChange={(e) => setBatchStep(e.target.value)} />
            <Field
              label="Steps in batch"
              name="batchRequiredStepsVisible"
              type="number"
              min={1}
              value={batchRequiredSteps}
              onChange={(e) => setBatchRequiredSteps(e.target.value)}
            />
          </div>
        </details>

        {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}

        <Button type="submit" size="md" variant="secondary" disabled={previewPending} className="self-start">
          {previewPending ? "Checking…" : "Show impact preview"}
        </Button>
      </form>

      {preview ? (
        <div data-testid="impact-preview" className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
            Impact preview — {preview.entityLabel}
          </h3>
          <p className="mt-1 text-sm text-zinc-700 dark:text-zinc-300">
            Total <span data-testid="preview-amount">{money(preview.amount)}</span>. Nothing has been saved yet.
          </p>

          {preview.downstream.length > 0 ? (
            <ul data-testid="preview-downstream" className="mt-3 list-disc pl-5 text-sm text-zinc-700 dark:text-zinc-300">
              {preview.downstream.map((d, i) => (
                <li key={i}>{d.description}</li>
              ))}
            </ul>
          ) : null}

          <table className="mt-3 w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                <th className="pb-1 pr-3 font-medium">Affected record</th>
                <th className="pb-1 pr-3 font-medium">Before</th>
                <th className="pb-1 font-medium">After</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {preview.impacts.map((impact, i) => (
                <tr key={i} data-testid="preview-impact">
                  <td className="py-1.5 pr-3">{impact.recordLabel}</td>
                  <td className="py-1.5 pr-3 tabular-nums text-zinc-600 dark:text-zinc-400">{impact.oldValue}</td>
                  <td className="py-1.5 tabular-nums font-medium">{impact.newValue}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="mt-3 w-full text-left text-sm">
            <tbody className="divide-y divide-[var(--border)]">
              {preview.ledgerLines.map((line, i) => (
                <tr key={i} data-testid="preview-ledger-line">
                  <td className="py-1.5 pr-3 font-mono">{line.accountCode}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{line.debit ? `Dr ${money(line.debit)}` : ""}</td>
                  <td className="py-1.5 tabular-nums">{line.credit ? `Cr ${money(line.credit)}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}
          {postState?.success ? <Alert tone="success">Correction {postState.code} posted.</Alert> : null}
          {draftState?.error ? <Alert tone="error">{draftState.error}</Alert> : null}
          {draftState?.success ? <Alert tone="success">Draft {draftState.code} saved for approval.</Alert> : null}

          <div className="mt-4 flex flex-wrap gap-2">
            {canPost ? (
              <form
                action={postAction}
                onSubmit={(e) => {
                  if (!window.confirm(`Post this correction of ${money(preview.amount)}? It cannot be edited afterwards, only reversed.`)) {
                    e.preventDefault();
                  }
                }}
              >
                {sharedFields}
                <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
                <Button type="submit" size="md" disabled={postPending} data-testid="post-correction">
                  {postPending ? "Posting…" : "Post correction"}
                </Button>
              </form>
            ) : null}
            <form action={draftAction}>
              {sharedFields}
              <Button type="submit" size="md" variant="secondary" disabled={draftPending} data-testid="save-correction-draft">
                {draftPending ? "Saving…" : "Save draft for Owner approval"}
              </Button>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Owner-only approve/reject controls for a correction still awaiting approval. */
export function CorrectionApproval({ correctionId }: { correctionId: string }) {
  const [approveState, approveAction, approvePending] = useActionState(approveCorrection, undefined);
  const [rejectState, rejectAction, rejectPending] = useActionState(rejectCorrection, undefined);
  const [rejectionReason, setRejectionReason] = useState("");

  return (
    <div data-testid={`approval-${correctionId}`} className="mt-4 flex flex-col gap-2 border-t border-[var(--border)] pt-3">
      {approveState?.error ? <Alert tone="error">{approveState.error}</Alert> : null}
      {rejectState?.error ? <Alert tone="error">{rejectState.error}</Alert> : null}
      <div className="flex flex-wrap items-end gap-2">
        <form action={approveAction}>
          <input type="hidden" name="correctionId" value={correctionId} />
          <Button type="submit" size="md" disabled={approvePending} data-testid="approve-correction">
            {approvePending ? "Approving…" : "Approve and post"}
          </Button>
        </form>
        <form action={rejectAction} className="flex items-end gap-2">
          <input type="hidden" name="correctionId" value={correctionId} />
          <input type="hidden" name="rejectionReason" value={rejectionReason} />
          <Field
            label="Reject because"
            name="rejectionReasonVisible"
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
          />
          <Button type="submit" size="md" variant="ghost" disabled={rejectPending} data-testid="reject-correction">
            Reject
          </Button>
        </form>
      </div>
    </div>
  );
}
