"use client";

import { useActionState, useState } from "react";

import { cancelVoucherAction } from "@/app/actions/vouchers";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";

export function CancelVoucherForm({ voucherId, voucherNumber }: { voucherId: string; voucherNumber: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(cancelVoucherAction, undefined);

  if (state?.success) {
    return (
      <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Cancelled</span>
    );
  }

  if (!open) {
    return (
      <Button type="button" variant="danger" size="md" onClick={() => setOpen(true)}>
        Cancel
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const formData = new FormData(e.currentTarget);
        const reason = formData.get("cancellationReason");
        if (!reason || String(reason).trim().length < 3) return; // let zod report it
        if (!window.confirm(`Cancel ${voucherNumber}? This posts a reversal — it cannot be undone.`)) {
          e.preventDefault();
        }
      }}
      className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30"
    >
      <input type="hidden" name="voucherId" value={voucherId} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <Field
        label="Cancellation reason"
        name="cancellationReason"
        required
        minLength={3}
        placeholder="e.g. Entered by mistake"
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
