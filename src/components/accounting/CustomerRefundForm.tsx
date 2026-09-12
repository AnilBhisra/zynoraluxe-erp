"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { createCustomerRefundAction } from "@/app/actions/finishedSales";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export function CustomerRefundForm({
  partyId,
  availableCredit,
  paymentAccounts,
}: {
  partyId: string;
  availableCredit: number;
  paymentAccounts: { id: string; name: string; method: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(createCustomerRefundAction, undefined);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) router.refresh();
  }, [state?.success, router]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-amber-700 underline dark:text-amber-300"
      >
        Refund
      </button>
    );
  }

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        const amount = new FormData(e.currentTarget).get("amount");
        if (!window.confirm(`Refund ₹${amount} to this customer? This cannot be undone.`)) {
          e.preventDefault();
        }
      }}
      className="mt-2 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left dark:border-amber-900 dark:bg-amber-950/30"
    >
      <input type="hidden" name="partyId" value={partyId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Refund saved as {state.code}.</Alert> : null}
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Available credit: ₹{availableCredit.toFixed(2)}. Leaving it unrefunded keeps it as customer credit — that
        is always fine too.
      </p>
      <Field label="Date" name="date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Refund via</label>
        <select
          name="paymentAccountId"
          required
          className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <option value="">Choose an account…</option>
          {paymentAccounts.map((pa) => (
            <option key={pa.id} value={pa.id}>
              {pa.name}
            </option>
          ))}
        </select>
      </div>
      <Field
        label="Amount"
        name="amount"
        type="number"
        step="0.01"
        min="0.01"
        max={availableCredit}
        defaultValue={availableCredit.toFixed(2)}
        required
      />
      <Field label="Note (optional)" name="note" />
      <div className="flex gap-2">
        <Button type="submit" variant="danger" size="md" disabled={pending}>
          {pending ? "Saving…" : "Save refund"}
        </Button>
        <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
