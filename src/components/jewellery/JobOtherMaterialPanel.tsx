"use client";

import { startTransition, useActionState, useState } from "react";

import { issueOtherMaterialAction, returnOtherMaterialAction, reverseOtherMaterialDocumentAction } from "@/app/actions/otherMaterial";
import { MaterialStockPicker, materialLineProblem, type MaterialLineDraft, type MaterialStockOption } from "@/components/jewellery/MaterialStockPicker";
import { Alert } from "@/components/ui/Alert";
import { useOnceOnSuccess } from "@/components/ui/useOnceOnSuccess";
import { Button } from "@/components/ui/Button";

/** Serialized on the server; every cost is null for Staff (never sent). */
export type SerializedJobMaterialPanel = {
  open: boolean;
  totalCost: string | null;
  holdings: { itemId: string; code: string; name: string; unit: string; quantity: string; cost: string | null }[];
  documents: { id: string; code: string; kind: string; date: string; status: string; reason: string | null; createdBy: string; total: string | null; lines: { item: string; quantity: string; unit: string; cost: string | null }[]; canReverse: boolean }[];
};

const CARD = "rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6";
const INPUT = "h-10 w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";
const today = () => new Date().toISOString().slice(0, 10);

function MoveForm({ kind, jobId, options, onDone }: { kind: "ISSUE" | "RETURN"; jobId: string; options: MaterialStockOption[]; onDone: () => void }) {
  const [state, action, pending] = useActionState(kind === "ISSUE" ? issueOtherMaterialAction : returnOtherMaterialAction, undefined);
  const [baseKey] = useState(() => crypto.randomUUID());
  const saved = state?.success ? state.code ?? null : null;
  const [lines, setLines] = useState<MaterialLineDraft[]>([{ itemId: "", quantity: "" }]);
  const [date, setDate] = useState(today());
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  useOnceOnSuccess(state, onDone);
  return (
    <form className="flex flex-col gap-2" onSubmit={(e) => e.preventDefault()} data-testid={kind === "ISSUE" ? "material-issue-form" : "material-return-form"}>
      <MaterialStockPicker
        options={options}
        lines={lines}
        onChange={setLines}
        availableLabel={kind === "ISSUE" ? "in stock" : "on this job"}
        emptyHint={kind === "ISSUE" ? "No purchased Other Material in stock. Purchase it first (Jewellery Jobs → Other Material)." : "Nothing of it is left on this job."}
      />
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Date
          <input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} className={INPUT} />
        </label>
        {kind === "RETURN" ? (
          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400 sm:col-span-2">
            Why it comes back
            <input value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} placeholder="Not used" />
          </label>
        ) : null}
      </div>
      {problem ? <Alert tone="error">{problem}</Alert> : null}
      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {saved ? <Alert tone="success">{state?.replayed ? `Already saved as ${saved}.` : `${kind === "ISSUE" ? "Issued" : "Returned"} — ${saved}.`}</Alert> : null}
      <Button
        type="button"
        size="md"
        className="self-start"
        disabled={pending}
        data-testid={kind === "ISSUE" ? "material-issue-btn" : "material-return-btn"}
        onClick={() => {
          const p = lines.map((l) => materialLineProblem(l, options)).find((m) => m !== null) ?? null;
          setProblem(p);
          if (p) return;
          if (!window.confirm(kind === "ISSUE" ? "Issue this material to the job? It leaves stock at its carrying cost." : "Return this material to stock?")) return;
          const fd = new FormData();
          fd.set("jobId", jobId);
          fd.set("date", date);
          fd.set("reason", reason);
          fd.set("linesJson", JSON.stringify(lines.map((l) => ({ itemId: l.itemId, quantity: l.quantity.trim() }))));
          fd.set("idempotencyKey", saved ? `${baseKey}-after-${saved}` : baseKey);
          startTransition(() => action(fd));
        }}
      >
        {pending ? "Saving…" : kind === "ISSUE" ? "Issue to job" : "Return to stock"}
      </Button>
    </form>
  );
}

function ReverseDocument({ id, code, onDone }: { id: string; code: string; onDone: () => void }) {
  const [state, action, pending] = useActionState(reverseOtherMaterialDocumentAction, undefined);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  useOnceOnSuccess(state, onDone);
  if (state?.success) return <span className="text-emerald-700">reversed</span>;
  if (!open) return <button type="button" className="text-xs font-medium text-red-700 underline" onClick={() => setOpen(true)}>Reverse</button>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <input value={reason} onChange={(e) => setReason(e.target.value)} className={INPUT} placeholder="Reason (at least 10 characters)" />
      <Button
        type="button"
        size="md"
        variant="danger"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Reverse ${code}? A mirror voucher is posted.`)) return;
          const fd = new FormData();
          fd.set("documentId", id);
          fd.set("reason", reason);
          startTransition(() => action(fd));
        }}
      >
        Confirm
      </Button>
      {state?.error ? <span className="text-red-700">{state.error}</span> : null}
    </span>
  );
}

export function JobOtherMaterialPanel({ jobId, panel, stock, isOwner, onDone }: { jobId: string; panel: SerializedJobMaterialPanel; stock: MaterialStockOption[]; isOwner: boolean; onDone: () => void }) {
  const [mode, setMode] = useState<"none" | "issue" | "return">("none");
  const holdingOptions: MaterialStockOption[] = panel.holdings.map((h) => ({
    id: h.itemId,
    code: h.code,
    name: h.name,
    unit: h.unit,
    available: h.quantity,
    averageRate: isOwner && h.cost && Number(h.quantity) > 0 ? (Number(h.cost) / Number(h.quantity)).toFixed(2) : null,
  }));
  return (
    <div className={`${CARD} flex flex-col gap-3`} data-testid="job-other-material">
      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Other Material (purchased stock)</h3>
      {panel.holdings.length ? (
        <ul className="text-xs" data-testid="job-material-holdings">
          {panel.holdings.map((h) => (
            <li key={h.itemId}>
              On this job: {h.code} {h.name} · {h.quantity} {h.unit}
              {h.cost !== null ? ` · ₹${h.cost} at cost` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500">No purchased Other Material on this job.</p>
      )}
      {panel.documents.length ? (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-xs" data-testid="job-material-documents">
          {panel.documents.map((d) => (
            <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2 p-2">
              <span className="min-w-0 break-words">
                {d.code} · {d.date} · {d.kind === "ISSUE" ? "Issued" : "Returned"} · {d.lines.map((l) => `${l.item} ${l.quantity} ${l.unit}${l.cost !== null ? ` (₹${l.cost})` : ""}`).join(", ")}
                {d.reason ? ` · ${d.reason}` : ""} · by {d.createdBy} · {d.status === "POSTED" ? "Posted" : "Reversed"}
              </span>
              {d.canReverse ? <ReverseDocument id={d.id} code={d.code} onDone={onDone} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {panel.open ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant={mode === "issue" ? "primary" : "secondary"} size="md" onClick={() => setMode(mode === "issue" ? "none" : "issue")} data-testid="material-issue-open">
            Issue Other Material
          </Button>
          {panel.holdings.length ? (
            <Button type="button" variant={mode === "return" ? "primary" : "secondary"} size="md" onClick={() => setMode(mode === "return" ? "none" : "return")} data-testid="material-return-open">
              Return unused material
            </Button>
          ) : null}
        </div>
      ) : null}
      {mode === "issue" ? <MoveForm key="issue" kind="ISSUE" jobId={jobId} options={stock} onDone={onDone} /> : null}
      {mode === "return" ? <MoveForm key="return" kind="RETURN" jobId={jobId} options={holdingOptions} onDone={onDone} /> : null}
    </div>
  );
}
