"use client";

import { useActionState, useState } from "react";

import { updateCompanySettings } from "@/app/actions/settings";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

type CompanySettingsValues = {
  companyName: string;
  address: string;
  phone: string;
  email: string;
  gstNumber: string;
  defaultCurrency: string;
  financialYearStartMonth: number;
  financialYearStartDay: number;
};

export function CompanySettingsForm({
  initialValues,
}: {
  initialValues: CompanySettingsValues;
}) {
  const [state, formAction, pending] = useActionState(updateCompanySettings, undefined);
  const [showMore, setShowMore] = useState(
    Boolean(initialValues.address || initialValues.phone || initialValues.email || initialValues.gstNumber)
  );

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const name = formData.get("companyName");
    if (!window.confirm(`Save company settings for "${name}"?`)) {
      event.preventDefault();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5"
      noValidate
    >
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Company settings saved.</Alert> : null}

      <Field
        label="Company name"
        name="companyName"
        defaultValue={initialValues.companyName}
        required
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field
          label="Default currency"
          name="defaultCurrency"
          defaultValue={initialValues.defaultCurrency}
          maxLength={3}
          hint="3-letter code, e.g. INR"
          required
        />
        <Field
          label="Financial year start — month"
          name="financialYearStartMonth"
          type="number"
          min={1}
          max={12}
          defaultValue={initialValues.financialYearStartMonth}
          hint="1–12 (4 = April)"
          required
        />
        <Field
          label="Financial year start — day"
          name="financialYearStartDay"
          type="number"
          min={1}
          max={31}
          defaultValue={initialValues.financialYearStartDay}
          hint="1–31"
          required
        />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide advanced details" : "More details (address, phone, GST)"}
        </button>
      </div>

      {showMore ? (
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <Field
            label="Address"
            name="address"
            defaultValue={initialValues.address}
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Phone"
              name="phone"
              type="tel"
              defaultValue={initialValues.phone}
            />
            <Field
              label="Email"
              name="email"
              type="email"
              defaultValue={initialValues.email}
            />
          </div>
          <Field
            label="GST number"
            name="gstNumber"
            defaultValue={initialValues.gstNumber}
            hint="15-character GSTIN"
          />
        </div>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Saving…" : "Save company settings"}
      </Button>
    </form>
  );
}
