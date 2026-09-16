"use client";

import { useActionState, useState } from "react";

import { adjustPacketStockAction } from "@/app/actions/diamond";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

const SMALL = "h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

/** Owner-only packet count correction. Rendered only for the Owner; the action re-checks. */
export function AdjustPacketForm({ packetId, packetCode }: { packetId: string; packetCode: string }) {
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<"IN" | "OUT">("OUT");
  const [state, formAction, pending] = useActionState(adjustPacketStockAction, undefined);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-zinc-700 underline underline-offset-4 dark:text-zinc-300">
        Adjust count
      </button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const text = direction === "OUT" ? "remove these stones and expense their cost" : "add these stones at the cost entered";
        if (!window.confirm(`Adjust ${packetCode}: ${text}? Correct a mistake with an opposite adjustment.`)) e.preventDefault();
      }}
      className="mt-2 flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3"
    >
      <input type="hidden" name="packetId" value={packetId} />
      <input type="hidden" name="adjustmentDate" value={new Date().toISOString().slice(0, 10)} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Adjustment saved.</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Direction" name="direction" value={direction} onChange={(e) => setDirection(e.target.value as "IN" | "OUT")} className={SMALL}>
          <option value="OUT">Stones missing / broken (out)</option>
          <option value="IN">Stones found (in)</option>
        </select>
        <input aria-label="Pieces" name="pieces" type="number" min="0" step="1" placeholder="Pieces" className={`${SMALL} w-20`} />
        <input aria-label="Carat" name="carat" type="number" min="0" step="0.001" placeholder="Carat" className={`${SMALL} w-24`} />
        {direction === "IN" ? <input aria-label="Cost" name="costValue" type="number" min="0" step="0.01" placeholder="Cost (₹)" className={`${SMALL} w-28`} /> : null}
        <input aria-label="Reason" name="reason" required minLength={3} placeholder="Reason (required)" className={`${SMALL} min-w-[10rem] flex-1`} />
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="md" disabled={pending}>{pending ? "Saving…" : "Save adjustment"}</Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>Close</Button>
      </div>
    </form>
  );
}
