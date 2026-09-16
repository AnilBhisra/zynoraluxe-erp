"use client";

import { useActionState, useEffect, useState } from "react";

import { createPacketProcessJobAction } from "@/app/actions/diamond";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import type { ProcessOption } from "@/components/diamond/IssueRoughForm";
import type { AvailablePacketOption } from "@/components/jewellery/IssueMaterialsForm";

const SELECT = "h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";
const SMALL = "h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

function ct1000(value: string): number {
  return Math.round((Number(value) || 0) * 1000);
}

export function PacketProcessIssueForm({
  manufacturers,
  processes,
  packets,
  onDone,
}: {
  manufacturers: PartyOption[];
  processes: ProcessOption[];
  packets: AvailablePacketOption[];
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(createPacketProcessJobAction, undefined);
  const [processId, setProcessId] = useState(processes[0]?.id ?? "");
  const [chargeRateBasis, setChargeRateBasis] = useState<ProcessOption["defaultRateBasis"]>(processes[0]?.defaultRateBasis ?? "PER_CARAT");
  const [drafts, setDrafts] = useState<Record<string, { pieces: string; carat: string }>>({});
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const lines = packets
    .map((p) => ({ packet: p, draft: drafts[p.id] }))
    .filter(({ draft }) => draft && (Number(draft.pieces) > 0 || Number(draft.carat) > 0));
  const problems = lines
    .map(({ packet, draft }) => {
      const pieces = Number(draft.pieces) || 0;
      const carat = ct1000(draft.carat);
      if (!Number.isInteger(pieces) || pieces < 1 || carat <= 0) return `${packet.packetCode}: enter whole pieces and a carat greater than zero.`;
      if (pieces > packet.pieces || carat > ct1000(packet.carat)) return `${packet.packetCode}: only ${packet.pieces} pcs / ${packet.carat}ct available.`;
      if ((pieces === packet.pieces) !== (carat === ct1000(packet.carat))) return `${packet.packetCode}: taking every piece must also take every carat (and the reverse).`;
      return null;
    })
    .filter((m): m is string => m !== null);
  const totalPieces = lines.reduce((sum, l) => sum + (Number(l.draft.pieces) || 0), 0);
  const totalCarat = lines.reduce((sum, l) => sum + ct1000(l.draft.carat), 0);

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (lines.length === 0 || problems.length > 0) {
      window.alert(problems[0] ?? "Enter pieces and carat for at least one packet.");
      event.preventDefault();
      return;
    }
    const process = processes.find((p) => p.id === processId);
    if (!window.confirm(`Issue ${totalPieces} pcs / ${(totalCarat / 1000).toFixed(3)}ct for ${process?.name ?? "this process"}?`)) {
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
      <input
        type="hidden"
        name="linesJson"
        value={JSON.stringify(lines.map(({ packet, draft }) => ({ packetId: packet.id, pieces: draft.pieces || "0", carat: draft.carat || "0" })))}
      />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Packets issued as Job Manufacturer job {state.code}.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PartySelect name="manufacturerId" parties={manufacturers} label="Manufacturer" required />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="jm-process" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Process</label>
          <select
            id="jm-process"
            name="processId"
            value={processId}
            onChange={(e) => {
              setProcessId(e.target.value);
              const next = processes.find((p) => p.id === e.target.value);
              if (next) setChargeRateBasis(next.defaultRateBasis);
            }}
            className={SELECT}
          >
            {processes.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        <Field label="Issue date" name="issueDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
        <Field label="Due date (optional)" name="dueDate" type="date" />
        <div className="flex flex-col gap-1.5">
          <label htmlFor="jm-charge-basis" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Process charge</label>
          <select id="jm-charge-basis" name="chargeRateBasis" value={chargeRateBasis} onChange={(e) => setChargeRateBasis(e.target.value as typeof chargeRateBasis)} className={SELECT}>
            <option value="PER_CARAT">Per carat returned or used</option>
            <option value="PER_PIECE">Per piece returned or used</option>
            <option value="FIXED">Fixed amount (charged when the job closes)</option>
          </select>
        </div>
        <Field
          label={chargeRateBasis === "FIXED" ? "Charge amount (₹)" : chargeRateBasis === "PER_PIECE" ? "Rate per piece (₹)" : "Rate per carat (₹)"}
          name="chargeRate"
          type="number"
          step="0.0001"
          min={0}
          defaultValue="0"
        />
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Polished Diamond packets — size-wise ({totalPieces} pcs, {(totalCarat / 1000).toFixed(3)}ct)
        </h3>
        {packets.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No polished packets in stock.</p>
        ) : (
          <div className="max-h-72 overflow-auto rounded-lg border border-[var(--border)]">
            <table className="w-full min-w-[32rem] text-sm">
              <tbody className="divide-y divide-[var(--border)]">
                {packets.map((p) => {
                  const draft = drafts[p.id] ?? { pieces: "", carat: "" };
                  const set = (patch: Partial<typeof draft>) => setDrafts((prev) => ({ ...prev, [p.id]: { ...draft, ...patch } }));
                  return (
                    <tr key={p.id}>
                      <td className="px-3 py-2">
                        <p className="font-medium text-zinc-800 dark:text-zinc-200">{p.packetCode}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {p.label} · {p.pieces} pcs · {p.carat}ct available
                        </p>
                      </td>
                      <td className="px-2 py-2">
                        <input aria-label={`Pieces from ${p.packetCode}`} type="number" min="0" step="1" placeholder="Pieces" value={draft.pieces} onChange={(e) => set({ pieces: e.target.value })} className={`${SMALL} w-24`} />
                      </td>
                      <td className="px-2 py-2">
                        <input aria-label={`Carat from ${p.packetCode}`} type="number" min="0" step="0.001" placeholder="Carat" value={draft.carat} onChange={(e) => set({ carat: e.target.value })} className={`${SMALL} w-28`} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {problems.length > 0 ? <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{problems[0]}</p> : null}
      </div>

      <Field label="Notes" name="notes" />

      <Button type="submit" size="lg" disabled={pending || processes.length === 0} className="self-start">
        {pending ? "Issuing…" : "Issue to Manufacturer"}
      </Button>
    </form>
  );
}
