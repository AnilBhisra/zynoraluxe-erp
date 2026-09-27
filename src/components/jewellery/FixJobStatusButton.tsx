"use client";

import { useActionState, useEffect, useState } from "react";

import { recomputeJobStatusAction } from "@/app/actions/jewellery";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

/**
 * Owner-only. Shown only when this job's status looks inconsistent with its
 * own data (an early-stage status despite an existing receipt) — in
 * practice, a job caught by the Needs-Correction "clear" bug before it was
 * fixed. Changes only `status`, with a written reason kept on the job; never
 * touches a quantity, cost or voucher.
 */
export function FixJobStatusButton({ jobId, currentStatus, onDone }: { jobId: string; currentStatus: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(recomputeJobStatusAction, undefined);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  if (state?.success) {
    return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Status corrected.</span>;
  }
  if (!open) {
    return (
      <Button type="button" variant="secondary" size="md" onClick={() => setOpen(true)}>
        Fix inconsistent status
      </Button>
    );
  }
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (
          !window.confirm(
            `This job shows "${currentStatus.replace(/_/g, " ")}" but already has a receipt on record, which cannot happen normally. Set it to Partially Received?`
          )
        ) {
          e.preventDefault();
        }
      }}
      className="flex w-full flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30"
    >
      <input type="hidden" name="jobId" value={jobId} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <p className="text-xs text-zinc-700 dark:text-zinc-300">
        This job shows &ldquo;{currentStatus.replace(/_/g, " ").toLowerCase()}&rdquo; but already has a receipt on record — that status is inconsistent with its own data.
        Correcting it sets the status to Partially Received; it changes nothing else.
      </p>
      <Field label="Reason (required, at least 10 characters)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} maxLength={500} />
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" size="md" disabled={pending}>
          {pending ? "Fixing…" : "Confirm fix"}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}
