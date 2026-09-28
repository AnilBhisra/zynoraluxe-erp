"use client";

import { useActionState, useEffect, useState, useTransition } from "react";

import {
  postMetalTransferAction,
  previewMetalTransferAction,
  reverseMetalTransferAction,
} from "@/app/actions/metalTransfer";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { EligibleDestinationJob, MetalTransferPanel as MetalTransferPanelData, MetalTransferRecord } from "@/lib/jewellery/metalTransferPanels";

/**
 * Owner-only. Moves unresolved fine-bearing metal (and its carrying cost)
 * from THIS job to another job of the same Karigar — never a fresh warehouse
 * issue and never a physical return. Staff never receive this data.
 */
export function MetalTransferPanel({ jobId, panel, onDone }: { jobId: string; panel: MetalTransferPanelData; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const source = panel.sourceOptions[0];
  const hasHistory = panel.transfersOut.length > 0 || panel.transfersIn.length > 0;
  if (!source && !hasHistory) return null;

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
      <h3 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Metal transferred between jobs</h3>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        The same Karigar sometimes works on this metal under a different job number. A transfer moves the unresolved metal and its current
        carrying cost to that other job — it is not a fresh issue from stock and not a return.
      </p>

      {source ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            This job has {source.pendingFineWeight}g fine of {source.purityDisplayName} pending (₹{source.remainingWipCost} WIP) available to transfer out.
          </p>
          <Button type="button" variant={open ? "primary" : "secondary"} size="md" onClick={() => setOpen((v) => !v)} disabled={panel.eligibleDestinations.length === 0}>
            {open ? "Close" : "Transfer metal"}
          </Button>
        </div>
      ) : null}
      {source && panel.eligibleDestinations.length === 0 ? (
        <p className="mb-3 text-xs font-medium text-amber-700 dark:text-amber-400">
          No other open job of this Karigar can receive it yet — create a Draft Jewellery Job for the same Karigar first.
        </p>
      ) : null}
      {open && source ? (
        <TransferForm
          jobId={jobId}
          source={source}
          destinations={panel.eligibleDestinations}
          onDone={() => {
            setOpen(false);
            onDone?.();
          }}
        />
      ) : null}

      {hasHistory ? (
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {panel.transfersOut.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300">Transferred out</p>
              <ul className="flex flex-col gap-2">
                {panel.transfersOut.map((t) => (
                  <TransferRow key={t.id} t={t} direction="out" onDone={onDone} />
                ))}
              </ul>
            </div>
          ) : null}
          {panel.transfersIn.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-semibold text-zinc-700 dark:text-zinc-300">Transferred in</p>
              <ul className="flex flex-col gap-2">
                {panel.transfersIn.map((t) => (
                  <TransferRow key={t.id} t={t} direction="in" onDone={onDone} />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TransferForm({
  jobId,
  source,
  destinations,
  onDone,
}: {
  jobId: string;
  source: { metalType: string; purityId: string; purityDisplayName: string; pendingFineWeight: string; remainingWipCost: string };
  destinations: EligibleDestinationJob[];
  onDone?: () => void;
}) {
  const [previewState, previewAction, previewPending] = useActionState(previewMetalTransferAction, undefined);
  const [postState, postAction, postPending] = useActionState(postMetalTransferAction, undefined);
  const [destinationJobId, setDestinationJobId] = useState(destinations[0]?.id ?? "");
  const [fineWeight, setFineWeight] = useState("");
  const [reason, setReason] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [previewedInputs, setPreviewedInputs] = useState("");
  const currentInputs = JSON.stringify({ destinationJobId, fineWeight, reason });

  useEffect(() => {
    if (postState?.success) onDone?.();
  }, [postState?.success, onDone]);

  const preview = previewState?.preview;
  const fresh = Boolean(preview) && previewedInputs === currentInputs;
  const [, startTransition] = useTransition();

  // Dispatched with a payload built from React state, never by submitting the
  // <form>: React resets a form after its action returns, which snapped the
  // destination <select> back to another job, so a chosen destination other
  // than the default was refused as "changed after this preview".
  const payload = (fingerprint: string) => {
    const fd = new FormData();
    fd.set("sourceJobId", jobId);
    fd.set("destinationJobId", destinationJobId);
    fd.set("fineWeight", fineWeight);
    fd.set("reason", reason);
    fd.set("idempotencyKey", idempotencyKey);
    fd.set("previewFingerprint", fingerprint);
    return fd;
  };

  if (postState?.success) {
    return (
      <Alert tone="success">
        {postState.replayed ? "This transfer was already posted" : "Metal transferred"} — {postState.code}.
      </Alert>
    );
  }

  return (
    <form className="mt-3 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" onSubmit={(e) => e.preventDefault()}>
      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}

      <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        Destination job (same Karigar)
        <select
          name="destinationJobId"
          value={destinationJobId}
          onChange={(e) => setDestinationJobId(e.target.value)}
          className="mt-1 h-10 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          {destinations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.jobCode} — {d.designName} ({d.status.replace(/_/g, " ").toLowerCase()})
            </option>
          ))}
        </select>
      </label>
      <Field
        label={`Fine weight to transfer (g) — up to ${source.pendingFineWeight}g of ${source.purityDisplayName}`}
        name="fineWeight"
        type="number"
        step="0.001"
        min="0"
        max={source.pendingFineWeight}
        value={fineWeight}
        onChange={(e) => setFineWeight(e.target.value)}
      />
      <Field
        label="Reason (required, at least 10 characters)"
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        minLength={10}
        maxLength={500}
      />

      {preview && fresh ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="transfer-preview">
          <p className="font-medium text-zinc-900 dark:text-zinc-50">
            Preview — nothing is saved yet. {preview.fineWeight}g fine ({preview.grossWeightEquivalent}g gross equivalent) of {preview.purityDisplayName}, carrying ₹{preview.costValue}, will
            move from {preview.sourceJobCode} to {preview.destinationJobCode}.
          </p>
          <ul className="mt-2 list-disc pl-5 text-xs text-zinc-700 dark:text-zinc-300">
            <li>
              {preview.sourceJobCode}: pending {preview.sourcePendingBefore}g → {preview.sourcePendingAfter}g fine; WIP ₹{preview.sourceWipBefore} → ₹{preview.sourceWipAfter}
            </li>
            <li>
              {preview.destinationJobCode}: gains {preview.fineWeight}g fine and ₹{preview.costValue} WIP
              {preview.destinationCreatesFirstMetalLine ? " — this is its first metal (not a fresh warehouse issue)" : ""}
            </li>
            <li>No voucher is posted — the same Jewellery WIP account already holds this value for both jobs.</li>
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="md"
          disabled={previewPending || postPending || !destinationJobId || Number(fineWeight) <= 0 || reason.trim().length < 10}
          onClick={() => {
            setPreviewedInputs(currentInputs);
            startTransition(() => previewAction(payload("")));
          }}
        >
          {previewPending ? "Preparing…" : "Preview"}
        </Button>
        {preview && fresh ? (
          <Button
            type="button"
            size="md"
            disabled={postPending || previewPending}
            onClick={() => {
              if (
                !window.confirm(
                  `Transfer ${preview.fineWeight}g fine (₹${preview.costValue}) from ${preview.sourceJobCode} to ${preview.destinationJobCode}?\n\nThis does not touch warehouse stock and posts no voucher — only the two jobs' own metal records change.`
                )
              ) {
                return;
              }
              startTransition(() => postAction(payload(preview.fingerprint)));
            }}
          >
            {postPending ? "Transferring…" : "Post transfer"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function TransferRow({ t, direction, onDone }: { t: MetalTransferRecord; direction: "out" | "in"; onDone?: () => void }) {
  const [state, action, pending] = useActionState(reverseMetalTransferAction, undefined);
  const [openReverse, setOpenReverse] = useState(false);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const arrow = direction === "out" ? `→ ${t.otherJobCode}` : `← ${t.otherJobCode}`;
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs text-zinc-700 dark:text-zinc-300">
      <p className="font-medium text-zinc-900 dark:text-zinc-50">
        {t.correctionCode} {arrow} · {t.fineWeight}g {t.purityDisplayName} · ₹{t.costValue}{" "}
        <span
          className={
            t.state === "POSTED"
              ? "rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
          }
        >
          {t.state === "POSTED" ? "Active" : `Reversed${t.reversedByCode ? ` by ${t.reversedByCode}` : ""}`}
        </span>
      </p>
      <p>{t.postedAt ? new Date(t.postedAt).toLocaleDateString("en-IN") : ""}</p>
      <p className="text-zinc-500 dark:text-zinc-400">Reason: {t.reason}</p>
      {t.state === "POSTED" ? (
        t.reverseBlockedReason ? (
          <p className="mt-1 font-medium text-amber-700 dark:text-amber-400">Cannot be reversed: {t.reverseBlockedReason}</p>
        ) : state?.success ? (
          <Alert tone="success">Reversed — {state.code}.</Alert>
        ) : openReverse ? (
          <form
            action={action}
            className="mt-2 flex flex-col gap-2"
            onSubmit={(e) => {
              if (!window.confirm(`Reverse ${t.correctionCode}? This moves the metal back to its source job.`)) e.preventDefault();
            }}
          >
            <input type="hidden" name="correctionId" value={t.id} />
            {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
            <Field label="Reason for reversing (at least 10 characters)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} maxLength={500} />
            <div className="flex gap-2">
              <Button type="submit" variant="danger" size="md" disabled={pending}>
                {pending ? "Reversing…" : "Confirm reversal"}
              </Button>
              <Button type="button" variant="ghost" size="md" onClick={() => setOpenReverse(false)}>
                Back
              </Button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setOpenReverse(true)} className="mt-1 font-medium text-red-700 underline underline-offset-4 dark:text-red-400">
            Reverse this transfer
          </button>
        )
      ) : null}
    </li>
  );
}
