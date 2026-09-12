"use client";

import { useActionState, useState } from "react";

import { createParty } from "@/app/actions/parties";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { useFieldId } from "@/lib/utils/useFieldId";

const PARTY_TYPES = [
  { value: "CUSTOMER", label: "Customer" },
  { value: "SUPPLIER", label: "Supplier" },
  { value: "KARIGAR", label: "Karigar" },
];

export function PartyForm() {
  const [state, formAction, pending] = useActionState(createParty, undefined);
  const [showMore, setShowMore] = useState(false);
  const [hasOpeningBalance, setHasOpeningBalance] = useState(false);
  const typeId = useFieldId();
  const openingBalanceTypeId = useFieldId();

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const name = formData.get("name");
    if (!window.confirm(`Add "${name}" as a party?`)) {
      event.preventDefault();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-4"
      noValidate
    >
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Party added.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" required />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={typeId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Party type <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <select
            id={typeId}
            name="type"
            required
            defaultValue="CUSTOMER"
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            {PARTY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Phone" name="phone" type="tel" />
        <Field label="Email" name="email" type="email" />
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          <input
            type="checkbox"
            checked={hasOpeningBalance}
            onChange={(e) => setHasOpeningBalance(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300"
          />
          This party already owes money, or is already owed money
        </label>
      </div>

      {hasOpeningBalance ? (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
          <Field
            label="Opening balance amount"
            name="openingBalance"
            type="number"
            step="0.01"
            min={0}
            defaultValue={0}
          />
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={openingBalanceTypeId}
              className="text-sm font-medium text-zinc-800 dark:text-zinc-200"
            >
              Direction
            </label>
            <select
              id={openingBalanceTypeId}
              name="openingBalanceType"
              defaultValue="RECEIVABLE"
              className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              <option value="RECEIVABLE">They owe us (Receivable)</option>
              <option value="PAYABLE">We owe them (Payable)</option>
            </select>
          </div>
        </div>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide advanced details" : "More details (address, GSTIN, state)"}
        </button>
      </div>

      {showMore ? (
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <Field label="Address" name="address" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="GSTIN" name="gstin" hint="15-character GSTIN" />
            <Field label="State" name="state" />
            <Field label="State code" name="stateCode" maxLength={2} hint="2 digits, e.g. 24" />
          </div>
        </div>
      ) : null}

      <Button type="submit" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Add party"}
      </Button>
    </form>
  );
}
