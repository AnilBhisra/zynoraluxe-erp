"use client";

import { useActionState, useState } from "react";

import { convertPolishedToParcelAction } from "@/app/actions/diamond";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";

/**
 * Owner-only, audited: this record is a single stone unless the Owner says it
 * is a parcel of many. Converting retires the ZL-POL record (kept as history)
 * and moves its carat and current cost into a parcel packet that a Jewellery
 * Job can take in part.
 */
export function ConvertToParcelForm({
  polishedDiamondId,
  polishedCode,
  carat,
}: {
  polishedDiamondId: string;
  polishedCode: string;
  carat: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(convertPolishedToParcelAction, undefined);

  if (state?.success) {
    return (
      <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
        Converted to parcel {state.code}
      </span>
    );
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="md" onClick={() => setOpen(true)}>
        Convert to parcel
      </Button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const data = new FormData(e.currentTarget);
        const count = Number(data.get("pieceCount"));
        const reason = String(data.get("reason") ?? "").trim();
        if (!Number.isInteger(count) || count < 2 || reason.length < 10) return;
        if (
          !window.confirm(
            `Convert ${polishedCode} (${carat}ct) into a parcel of ${count} stones?\n\nThis record stops being a single stone and moves, with its current cost, into a parcel that can be issued in part. The reason is kept in the audit trail. This is not silently reversible.`
          )
        ) {
          e.preventDefault();
        }
      }}
      className="flex w-full flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30"
    >
      <input type="hidden" name="polishedDiamondId" value={polishedDiamondId} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <p className="text-xs text-zinc-700 dark:text-zinc-300">
        Only use this if {polishedCode} really is a parcel of many stones. A single stone stays as it is.
      </p>
      <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        Number of stones in the parcel
        <input
          name="pieceCount"
          type="number"
          min={2}
          step={1}
          required
          className="mt-1 h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
      </label>
      <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        Size (optional, e.g. 1.5 mm)
        <input
          name="sizeLabel"
          className="mt-1 h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
      </label>
      <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
        Reason (required, at least 10 characters)
        <input
          name="reason"
          required
          minLength={10}
          placeholder="e.g. Receipt recorded the whole 35 ct lot as one row; it is a parcel of 120 stones"
          className="mt-1 h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" size="md" disabled={pending}>
          {pending ? "Converting…" : "Confirm conversion"}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}
