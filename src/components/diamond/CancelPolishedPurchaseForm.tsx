"use client";

import { useActionState, useState } from "react";

import { cancelPolishedPurchaseAction } from "@/app/actions/diamond";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export function CancelPolishedPurchaseForm({ purchaseId, purchaseCode }: { purchaseId: string; purchaseCode: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(cancelPolishedPurchaseAction, undefined);

  if (state?.success) {
    return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Purchase cancelled</span>;
  }

  if (!open) {
    return (
      <Button type="button" variant="danger" size="md" onClick={() => setOpen(true)}>
        Cancel purchase
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const reason = new FormData(e.currentTarget).get("cancellationReason");
        if (!reason || String(reason).trim().length < 3) return;
        if (!window.confirm(`Cancel ${purchaseCode}? Its packets leave stock and the posting reverses. This cannot be undone.`)) {
          e.preventDefault();
        }
      }}
      className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30"
    >
      <input type="hidden" name="purchaseId" value={purchaseId} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Reason for cancelling</label>
      <input
        name="cancellationReason"
        required
        minLength={3}
        placeholder="e.g. Entered against the wrong Party / Supplier"
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
