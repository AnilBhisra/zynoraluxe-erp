"use client";

import { useActionState, useEffect, useState } from "react";

import type { VoucherFormState } from "@/app/actions/vouchers";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import { useFieldId } from "@/lib/utils/useFieldId";

type PaymentAccountOption = { id: string; name: string; method: string };

const LABELS: Record<"PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "EXPENSE", string> = {
  PAYMENT_GIVEN: "Payment Given",
  PAYMENT_RECEIVED: "Payment Received",
  EXPENSE: "Expense",
};

export function CashVoucherForm({
  voucherType,
  action,
  parties,
  paymentAccounts,
  onDone,
}: {
  voucherType: "PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "EXPENSE";
  action: (state: VoucherFormState, formData: FormData) => Promise<VoucherFormState>;
  parties: PartyOption[];
  paymentAccounts: PaymentAccountOption[];
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [showMore, setShowMore] = useState(false);
  const [confirmOutsideFy, setConfirmOutsideFy] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const partyRequired = voucherType !== "EXPENSE";
  const label = LABELS[voucherType];
  const paymentAccountId = useFieldId();

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const amount = formData.get("amount");
    if (!window.confirm(`Save this ${label.toLowerCase()} of ₹${amount}?`)) {
      event.preventDefault();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="currencyCode" value="INR" />
      <input type="hidden" name="exchangeRate" value="1" />
      <input type="hidden" name="confirmOutsideFy" value={confirmOutsideFy ? "true" : "false"} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">{label} saved as {state.voucherNumber}.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          label="Date"
          name="date"
          type="date"
          defaultValue={new Date().toISOString().slice(0, 10)}
          required
        />
        <Field label="Amount" name="amount" type="number" step="0.01" min="0.01" required />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PartySelect name="partyId" parties={parties} required={partyRequired} />
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={paymentAccountId}
            className="text-sm font-medium text-zinc-800 dark:text-zinc-200"
          >
            Payment account <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <select
            id={paymentAccountId}
            name="paymentAccountId"
            required
            defaultValue=""
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="" disabled>
              Choose an account…
            </option>
            {paymentAccounts.map((pa) => (
              <option key={pa.id} value={pa.id}>
                {pa.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide advanced details" : "More details (reference, note)"}
        </button>
      </div>

      {showMore ? (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
          <Field label="Bill/reference number" name="referenceNumber" />
          <Field label="Note" name="note" />
          <label className="col-span-full flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={confirmOutsideFy}
              onChange={(e) => setConfirmOutsideFy(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300"
            />
            This date is outside the current financial year and I confirm that&apos;s intentional
          </label>
        </div>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Saving…" : `Save ${label.toLowerCase()}`}
      </Button>
    </form>
  );
}
