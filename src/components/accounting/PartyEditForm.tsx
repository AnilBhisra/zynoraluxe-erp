"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import { updateParty } from "@/app/actions/parties";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

const PARTY_TYPES = [
  { value: "CUSTOMER", label: "Customer" },
  { value: "SUPPLIER", label: "Supplier" },
  { value: "KARIGAR", label: "Karigar" },
];

export type EditablePartyValues = {
  id: string;
  name: string;
  type: "CUSTOMER" | "SUPPLIER" | "KARIGAR";
  phone: string;
  email: string;
  gstin: string;
  address: string;
  state: string;
  stateCode: string;
  isActive: boolean;
};

export function PartyEditForm({
  party,
  role,
  voucherCount,
}: {
  party: EditablePartyValues;
  role: "OWNER" | "STAFF";
  voucherCount: number;
}) {
  const [state, formAction, pending] = useActionState(updateParty, undefined);
  const [type, setType] = useState(party.type);
  const [confirmTypeChange, setConfirmTypeChange] = useState(false);
  const isOwner = role === "OWNER";
  const typeChanged = type !== party.type;

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!window.confirm(`Save changes to "${party.name}"?`)) {
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
      <input type="hidden" name="partyId" value={party.id} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Party updated.</Alert> : null}

      {!isOwner ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          You can update phone, email and address. Name, party type, GSTIN and state details are
          Owner-only.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {isOwner ? (
          <Field label="Name" name="name" defaultValue={party.name} required />
        ) : (
          // A disabled input never submits, so the real value travels via
          // this hidden "name" field; "_name_display" (a different name)
          // is just the read-only display Staff sees.
          <>
            <input type="hidden" name="name" value={party.name} />
            <Field label="Name" name="_name_display" defaultValue={party.name} disabled />
          </>
        )}

        {isOwner ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="type" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Party type
            </label>
            <select
              id="type"
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value as EditablePartyValues["type"])}
              className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              {PARTY_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <input type="hidden" name="type" value={party.type} />
        )}
      </div>

      {isOwner && typeChanged && voucherCount > 0 ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <p>
            This party has {voucherCount} existing transaction{voucherCount === 1 ? "" : "s"}.
            Changing its type won&apos;t alter any past transaction, but may change how it&apos;s
            grouped in reports.
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={confirmTypeChange}
              onChange={(e) => setConfirmTypeChange(e.target.checked)}
              className="h-4 w-4 rounded border-zinc-300"
            />
            I understand — change the type anyway
          </label>
          <input type="hidden" name="confirmTypeChange" value={confirmTypeChange ? "true" : "false"} />
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Phone" name="phone" type="tel" defaultValue={party.phone} />
        <Field label="Email" name="email" type="email" defaultValue={party.email} />
      </div>

      <Field label="Address" name="address" defaultValue={party.address} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {isOwner ? (
          <Field label="GSTIN" name="gstin" defaultValue={party.gstin} hint="15-character GSTIN" />
        ) : (
          <input type="hidden" name="gstin" value={party.gstin} />
        )}
        {isOwner ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="State" name="state" defaultValue={party.state} />
            <Field label="State code" name="stateCode" defaultValue={party.stateCode} maxLength={2} />
          </div>
        ) : (
          <>
            <input type="hidden" name="state" value={party.state} />
            <input type="hidden" name="stateCode" value={party.stateCode} />
          </>
        )}
      </div>

      {isOwner ? (
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-800 dark:text-zinc-200">
          {/* Checkbox must come before the hidden fallback in DOM order:
              FormData.get() returns the first same-named entry, and an
              unchecked checkbox submits nothing at all, so this order is
              what makes checked->"true" and unchecked->"false" both work
              without any JS. */}
          <input
            type="checkbox"
            name="isActive"
            value="true"
            defaultChecked={party.isActive}
            className="h-4 w-4 rounded border-zinc-300"
          />
          Active
          <input type="hidden" name="isActive" value="false" />
        </label>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        <Link
          href="/accounting?tab=parties"
          className="text-sm font-medium text-zinc-600 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
