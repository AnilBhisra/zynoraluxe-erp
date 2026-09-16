"use client";

import { useActionState } from "react";

import { saveDiamondProcessAction } from "@/app/actions/diamond";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export type DiamondProcessRow = {
  id: string;
  name: string;
  outputKind: "ROUGH" | "POLISHED";
  defaultRateBasis: "FIXED" | "PER_CARAT" | "PER_PIECE";
  isActive: boolean;
};

const INPUT = "h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

function ProcessForm({ process }: { process?: DiamondProcessRow }) {
  const [state, formAction, pending] = useActionState(saveDiamondProcessAction, undefined);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2" noValidate>
      {process ? <input type="hidden" name="processId" value={process.id} /> : null}
      <input aria-label="Process name" name="name" defaultValue={process?.name ?? ""} placeholder="Process name" className={`${INPUT} w-44`} />
      <select aria-label="Returns" name="outputKind" defaultValue={process?.outputKind ?? "ROUGH"} className={INPUT}>
        <option value="ROUGH">Returns rough</option>
        <option value="POLISHED">Returns polished</option>
      </select>
      <select aria-label="Default charge" name="defaultRateBasis" defaultValue={process?.defaultRateBasis ?? "PER_CARAT"} className={INPUT}>
        <option value="PER_CARAT">Charge per carat</option>
        <option value="PER_PIECE">Charge per piece</option>
        <option value="FIXED">Fixed charge</option>
      </select>
      <select aria-label="Status" name="isActive" defaultValue={process ? String(process.isActive) : "true"} className={INPUT}>
        <option value="true">Active</option>
        <option value="false">Inactive</option>
      </select>
      <Button type="submit" size="md" variant={process ? "secondary" : "primary"} disabled={pending}>
        {pending ? "Saving…" : process ? "Save" : "Add process"}
      </Button>
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <span className="text-xs text-emerald-700 dark:text-emerald-400">Saved</span> : null}
    </form>
  );
}

/**
 * Owner-only Manufacturer process master. HPHT / Grow is an outsourced
 * issue-return-cost process — there is no in-house growing module.
 * Jobs snapshot the process name and output kind, so edits only affect
 * jobs issued afterwards.
 */
export function DiamondProcessSettingsPanel({ processes }: { processes: DiamondProcessRow[] }) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
      <div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">Manufacturer processes</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Processes offered when rough or polished stones go to a Manufacturer (e.g. 4P / Laser, HPHT / Grow, Polishing, Rough Polish). Changes apply
          to jobs issued afterwards.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {processes.map((p) => (
          <ProcessForm key={p.id} process={p} />
        ))}
      </div>
      <div className="border-t border-[var(--border)] pt-4">
        <ProcessForm />
      </div>
    </section>
  );
}
