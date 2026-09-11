"use client";

import { useActionState, useState } from "react";

import { recutPolishedAction } from "@/app/actions/diamond";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export function RecutForm({ polishedDiamondId, polishedCode }: { polishedDiamondId: string; polishedCode: string }) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(recutPolishedAction, undefined);

  if (state?.success) {
    return <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Marked for recut</span>;
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="md" onClick={() => setOpen(true)}>
        Mark for recut
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const formData = new FormData(e.currentTarget);
        const reason = formData.get("reason");
        if (!reason || String(reason).trim().length < 3) return;
        if (!window.confirm(`Mark ${polishedCode} for recut? It will be removed from Available polished stock.`)) {
          e.preventDefault();
        }
      }}
      className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30"
    >
      <input type="hidden" name="polishedDiamondId" value={polishedDiamondId} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Reason</label>
      <input
        name="reason"
        required
        minLength={3}
        placeholder="e.g. Chip found, needs recutting"
        className="h-9 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
      />
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" size="md" disabled={pending}>
          {pending ? "Saving…" : "Confirm"}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}
