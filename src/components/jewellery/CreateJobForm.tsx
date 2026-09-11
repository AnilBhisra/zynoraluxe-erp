"use client";

import { useActionState, useEffect, useState } from "react";

import { createJewelleryJobAction } from "@/app/actions/jewellery";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import { JewelleryPhotoUploadField } from "@/components/jewellery/PhotoUploadField";
import { JEWELLERY_TYPES, METAL_TYPES } from "@/lib/jewellery/types";

export type PurityOption = { id: string; metalType: string; displayName: string };

export function CreateJobForm({
  customers,
  karigars,
  purities,
  onDone,
}: {
  customers: PartyOption[];
  karigars: PartyOption[];
  purities: PurityOption[];
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(createJewelleryJobAction, undefined);
  const [designImageAssetId, setDesignImageAssetId] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [targetMetalType, setTargetMetalType] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const purityOptions = purities.filter((p) => p.metalType === targetMetalType);

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const designName = formData.get("designName");
    if (!window.confirm(`Create a new jewellery job for "${designName}"?`)) {
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
      <input type="hidden" name="designImageAssetId" value={designImageAssetId ?? ""} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Job created as {state.code}.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="jewelleryType" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Jewellery type <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <select
            id="jewelleryType"
            name="jewelleryType"
            defaultValue="RING"
            required
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            {JEWELLERY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
        <Field label="Design name / title" name="designName" required />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PartySelect name="karigarId" parties={karigars} label="Karigar" required />
        <Field label="Issue date" name="issueDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PartySelect name="customerId" parties={customers} label="Customer (optional)" />
        <Field label="Customer order/reference (optional)" name="customerReference" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Quantity" name="quantity" type="number" min={1} defaultValue={1} required />
        <Field label="Ring/jewellery size (optional)" name="jewellerySize" />
        <Field label="Expected delivery date (optional)" name="expectedDeliveryDate" type="date" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="targetMetalType" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Target metal (optional)
          </label>
          <select
            id="targetMetalType"
            name="targetMetalType"
            value={targetMetalType}
            onChange={(e) => setTargetMetalType(e.target.value)}
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="">Not decided yet</option>
            {METAL_TYPES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {targetMetalType ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="targetPurityId" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Target purity
            </label>
            <select
              id="targetPurityId"
              name="targetPurityId"
              className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              <option value="">Not decided yet</option>
              {purityOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <JewelleryPhotoUploadField
        category="jewellery-design"
        label="Design image (optional)"
        assetId={designImageAssetId}
        onUploaded={setDesignImageAssetId}
      />

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide more details" : "More details (target weight, instructions, notes)"}
        </button>
      </div>

      {showMore ? (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
          <Field label="Target finished weight (grams, optional)" name="targetFinishedWeight" type="number" step="0.001" min={0} />
          <Field label="Notes (optional)" name="notes" />
          <Field label="Special instructions (optional)" name="specialInstructions" className="sm:col-span-2" />
        </div>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Creating…" : "Create Jewellery Job"}
      </Button>
    </form>
  );
}
