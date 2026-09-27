"use client";

import { useActionState, useEffect, useState } from "react";

import { completeReconciledJobAction } from "@/app/actions/jewellery";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

/**
 * Owner-only. Shown only when every material this job ever took in is fully
 * accounted for (nothing pending, every diamond and packet stone resolved)
 * but the job is not yet Completed — in practice, a job whose last
 * unresolved metal left by a job-to-job transfer rather than a receipt, so
 * it never passed through Receive Finished Jewellery's own completion gate.
 * Changes only `status`, with a written reason kept on the job; posts no
 * voucher and touches no quantity or cost.
 */
export function CompleteReconciledJobButton({ jobId, onDone }: { jobId: string; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(completeReconciledJobAction, undefined);
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  if (state?.success) {
    return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Job completed.</span>;
  }
  if (!open) {
    return (
      <Button type="button" variant="secondary" size="md" onClick={() => setOpen(true)}>
        Complete reconciled job
      </Button>
    );
  }
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (!window.confirm("Mark this job Completed? Every material is fully accounted for, so this posts no receipt, voucher, or cost change — only the status and a note.")) {
          e.preventDefault();
        }
      }}
      className="flex w-full flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/30"
    >
      <input type="hidden" name="jobId" value={jobId} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <p className="text-xs text-zinc-700 dark:text-zinc-300">
        Every material issued to this job is fully accounted for — nothing pending, every diamond and packet stone resolved — but it is not yet marked
        Completed. This changes only the status, with your reason kept on the job; no receipt, voucher, quantity or cost is touched.
      </p>
      <Field label="Reason (required, at least 10 characters)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} maxLength={500} />
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" size="md" disabled={pending}>
          {pending ? "Completing…" : "Confirm complete"}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}
