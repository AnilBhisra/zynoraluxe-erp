"use client";

import { useActionState, useState } from "react";

import { cancelJewelleryJobAction } from "@/app/actions/jewellery";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export function CancelJobForm({ jobId, jobCode }: { jobId: string; jobCode: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(cancelJewelleryJobAction, undefined);

  if (state?.success) {
    return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Job cancelled</span>;
  }

  if (!open) {
    return (
      <Button type="button" variant="danger" size="md" onClick={() => setOpen(true)}>
        Cancel job
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const formData = new FormData(e.currentTarget);
        const reason = formData.get("cancellationReason");
        if (!reason || String(reason).trim().length < 3) return;
        if (
          !window.confirm(
            `Cancel job ${jobCode}? Any issued metal returns to stock, issued diamonds become Available again, and the WIP posting reverses. This cannot be undone.`
          )
        ) {
          e.preventDefault();
        }
      }}
      className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30"
    >
      <input type="hidden" name="jobId" value={jobId} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Reason for cancelling</label>
      <input
        name="cancellationReason"
        required
        minLength={3}
        placeholder="e.g. Customer changed their mind"
        className="h-9 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
      />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="md" disabled={pending}>
          {pending ? "Cancelling…" : "Confirm cancel"}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}
