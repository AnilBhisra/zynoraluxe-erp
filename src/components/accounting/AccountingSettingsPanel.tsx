"use client";

import { useActionState, useState } from "react";

import {
  createGstRate,
  createPaymentAccount,
  setGstRateActive,
  setPaymentAccountActive,
} from "@/app/actions/accountingSettings";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { useFieldId } from "@/lib/utils/useFieldId";

type PaymentAccountRow = { id: string; name: string; method: string; isActive: boolean };
type GstRateRow = { id: string; label: string; ratePercent: string; isActive: boolean };

function AddPaymentAccountForm() {
  const [state, formAction, pending] = useActionState(createPaymentAccount, undefined);
  const methodId = useFieldId();
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3" noValidate>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="w-48">
        <Field label="Account name" name="name" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={methodId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Type
        </label>
        <select
          id={methodId}
          name="method"
          defaultValue="BANK"
          className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <option value="BANK">Bank</option>
          <option value="UPI">UPI</option>
          <option value="CASH">Cash</option>
          <option value="OTHER">Other</option>
        </select>
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add account"}
      </Button>
    </form>
  );
}

function AddGstRateForm() {
  const [state, formAction, pending] = useActionState(createGstRate, undefined);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3" noValidate>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="w-56">
        <Field label="Label" name="label" placeholder="e.g. 1% — small repairs" />
      </div>
      <div className="w-32">
        <Field label="Rate %" name="ratePercent" type="number" step="0.01" min={0} max={100} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add rate"}
      </Button>
    </form>
  );
}

export function AccountingSettingsPanel({
  paymentAccounts,
  gstRates,
}: {
  paymentAccounts: PaymentAccountRow[];
  gstRates: GstRateRow[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
      >
        {open ? "Hide accounting settings" : "Accounting settings (payment accounts, GST rates)"}
      </button>

      {open ? (
        <div className="mt-5 flex flex-col gap-8">
          <div>
            <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              Payment accounts
            </h3>
            <ul className="mb-4 divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
              {paymentAccounts.map((pa) => (
                <li key={pa.id} className="flex items-center justify-between p-3 text-sm">
                  <span>
                    {pa.name}{" "}
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">({pa.method})</span>
                    {!pa.isActive ? (
                      <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-800">
                        Inactive
                      </span>
                    ) : null}
                  </span>
                  <form action={setPaymentAccountActive}>
                    <input type="hidden" name="paymentAccountId" value={pa.id} />
                    <input type="hidden" name="nextActive" value={(!pa.isActive).toString()} />
                    <Button type="submit" variant="secondary" size="md">
                      {pa.isActive ? "Deactivate" : "Reactivate"}
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
            <AddPaymentAccountForm />
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">GST rates</h3>
            <ul className="mb-4 divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
              {gstRates.map((rate) => (
                <li key={rate.id} className="flex items-center justify-between p-3 text-sm">
                  <span>
                    {rate.label}{" "}
                    {!rate.isActive ? (
                      <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-800">
                        Inactive
                      </span>
                    ) : null}
                  </span>
                  <form action={setGstRateActive}>
                    <input type="hidden" name="gstRateId" value={rate.id} />
                    <input type="hidden" name="nextActive" value={(!rate.isActive).toString()} />
                    <Button type="submit" variant="secondary" size="md">
                      {rate.isActive ? "Deactivate" : "Reactivate"}
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
            <AddGstRateForm />
          </div>
        </div>
      ) : null}
    </div>
  );
}
