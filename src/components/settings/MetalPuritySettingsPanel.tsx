"use client";

import { useActionState, useEffect, useState } from "react";

import { createMetalPurity, setMetalPurityActive, updateMetalPurity } from "@/app/actions/metal";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { METAL_TYPES, metalTypeLabel } from "@/lib/jewellery/types";
import { useFieldId } from "@/lib/utils/useFieldId";

export type MetalPurityRow = { id: string; metalType: string; displayName: string; finenessPercent: string; isActive: boolean };

function MetalTypeOptions() {
  return (
    <>
      {METAL_TYPES.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
    </>
  );
}

function AddPurityForm() {
  const [state, formAction, pending] = useActionState(createMetalPurity, undefined);
  const metalTypeId = useFieldId();
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3" noValidate>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={metalTypeId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Metal
        </label>
        <select
          id={metalTypeId}
          name="metalType"
          defaultValue="GOLD"
          className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <MetalTypeOptions />
        </select>
      </div>
      <div className="w-40">
        <Field label="Display name" name="displayName" placeholder="e.g. 9K" />
      </div>
      <div className="w-32">
        <Field label="Fineness %" name="finenessPercent" type="number" step="0.001" min={0} max={100} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add purity"}
      </Button>
    </form>
  );
}

function EditPurityForm({ purity, onDone }: { purity: MetalPurityRow; onDone: () => void }) {
  const [state, formAction, pending] = useActionState(updateMetalPurity, undefined);

  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
      <input type="hidden" name="purityId" value={purity.id} />
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`edit-metalType-${purity.id}`} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Metal
        </label>
        <select
          id={`edit-metalType-${purity.id}`}
          name="metalType"
          defaultValue={purity.metalType}
          className="h-10 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <MetalTypeOptions />
        </select>
      </div>
      <div className="w-40">
        <Field label="Display name" name="displayName" defaultValue={purity.displayName} />
      </div>
      <div className="w-32">
        <Field label="Fineness %" name="finenessPercent" type="number" step="0.001" min={0} max={100} defaultValue={purity.finenessPercent} />
      </div>
      <Button type="submit" size="md" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <Button type="button" variant="ghost" size="md" onClick={onDone}>
        Cancel
      </Button>
    </form>
  );
}

export function MetalPuritySettingsPanel({ purities }: { purities: MetalPurityRow[] }) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
      >
        {open ? "Hide Metal/Purity master" : "Metal/Purity master (gold, silver, platinum karats, Copper/Alloy)"}
      </button>

      {open ? (
        <div className="mt-5 flex flex-col gap-4">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Fineness % drives every fine-weight calculation across Metal Stock and Jewellery Jobs. Existing jobs keep a snapshot
            of the fineness at the time they were issued/received, so editing a purity here never changes historical figures.
            Copper/Alloy is Company-owned alloy stock with 0% fineness — it adds weight and cost, never fine metal.
          </p>
          {purities.length === 0 ? (
            <EmptyState title="No purities yet" description="Add your first metal purity below." />
          ) : (
            <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
              {purities.map((p) =>
                editingId === p.id ? (
                  <li key={p.id} className="bg-[var(--surface)] p-3">
                    <EditPurityForm purity={p} onDone={() => setEditingId(null)} />
                  </li>
                ) : (
                  <li key={p.id} className="flex items-center justify-between gap-3 bg-[var(--surface)] p-3 text-sm">
                    <span>
                      <span className="font-medium text-zinc-800 dark:text-zinc-200">
                        {metalTypeLabel(p.metalType)} · {p.displayName}
                      </span>{" "}
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">({p.finenessPercent}% fine)</span>
                      {!p.isActive ? (
                        <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] dark:bg-zinc-800">Inactive</span>
                      ) : null}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button type="button" variant="ghost" size="md" onClick={() => setEditingId(p.id)}>
                        Edit
                      </Button>
                      <form action={setMetalPurityActive}>
                        <input type="hidden" name="purityId" value={p.id} />
                        <input type="hidden" name="nextActive" value={(!p.isActive).toString()} />
                        <Button type="submit" variant="secondary" size="md">
                          {p.isActive ? "Deactivate" : "Reactivate"}
                        </Button>
                      </form>
                    </div>
                  </li>
                )
              )}
            </ul>
          )}
          <AddPurityForm />
        </div>
      ) : null}
    </div>
  );
}
