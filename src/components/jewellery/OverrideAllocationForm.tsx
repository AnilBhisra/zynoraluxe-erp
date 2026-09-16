"use client";

import { useActionState, useEffect, useState } from "react";

import { overrideFinishedAllocationAction } from "@/app/actions/jewellery";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Field } from "@/components/ui/Field";

/** Owner-only cost-allocation override for a receipt's finished outputs —
 * new costs must sum exactly back to the receipt's locked total, with a
 * mandatory reason. Mirrors src/components/diamond/OverrideAllocationForms.tsx. */
export function OverrideAllocationForm({
  receiptId,
  outputs,
  onDone,
}: {
  receiptId: string;
  outputs: { id: string; finishedCode: string; totalCost: string | null }[];
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(overrideFinishedAllocationAction, undefined);
  const [costs, setCosts] = useState<Record<string, string>>(
    Object.fromEntries(outputs.map((o) => [o.id, o.totalCost ?? ""]))
  );
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const total = outputs.reduce((sum, o) => sum + (Number(costs[o.id]) || 0), 0);
  const currentTotal = outputs.reduce((sum, o) => sum + Number(o.totalCost), 0);
  const matches = Math.abs(total - currentTotal) < 0.01;

  const adjustments = outputs.map((o) => ({ finishedJewelleryId: o.id, newTotalCost: costs[o.id] || "0" }));

  return (
    <form action={formAction} className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
      <input type="hidden" name="receiptId" value={receiptId} />
      <input type="hidden" name="adjustmentsJson" value={JSON.stringify(adjustments)} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Cost allocation updated.</Alert> : null}

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Adjust each output&apos;s total cost — must sum exactly to ₹{currentTotal.toFixed(2)}.
      </p>
      {outputs.map((o) => (
        <div key={o.id} className="flex items-center gap-3">
          <span className="w-32 text-sm text-zinc-700 dark:text-zinc-300">{o.finishedCode}</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={costs[o.id] ?? ""}
            onChange={(e) => setCosts((prev) => ({ ...prev, [o.id]: e.target.value }))}
            className="h-9 w-40 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          />
        </div>
      ))}
      <p className={`text-xs font-medium ${matches ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
        Total: ₹{total.toFixed(2)} {matches ? "✓ matches" : `(must equal ₹${currentTotal.toFixed(2)})`}
      </p>
      <Field label="Reason" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
      <Button type="submit" size="md" disabled={pending || !matches} className="self-start">
        {pending ? "Saving…" : "Save cost override"}
      </Button>
    </form>
  );
}
