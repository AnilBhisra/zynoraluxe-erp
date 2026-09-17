"use client";

import { useActionState, useEffect, useState } from "react";

import { receivePacketProcessReturnAction } from "@/app/actions/diamond";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export type PacketProcessLineOption = {
  id: string;
  packetCode: string;
  label: string;
  piecesAtIssue: number;
  caratAtIssue: string;
  pendingPieces: number;
  pendingCarat: string;
  isClosed: boolean;
};

type Disposition = "RETURNED_TO_STOCK" | "USED_IN_JEWELLERY_JOB" | "DAMAGED_LOST";
type RowDraft = { jobLineId: string; disposition: Disposition; pieces: string; carat: string; sizeLabel: string; jewelleryJobId: string; damagedLostReason: string };

const SMALL = "h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";
const ct1000 = (value: string) => Math.round((Number(value) || 0) * 1000);
const fmt = (thousandths: number) => (thousandths / 1000).toFixed(3);
const emptyRow = (jobLineId: string): RowDraft => ({
  jobLineId,
  disposition: "RETURNED_TO_STOCK",
  pieces: "",
  carat: "",
  sizeLabel: "",
  jewelleryJobId: "",
  damagedLostReason: "",
});

/**
 * Size-wise Job Manufacturer return. A line closes on its own only when every
 * piece and every carat is back. When all pieces are back but carat is short,
 * closing — and recording that gap as the line's Process Loss — needs the
 * explicit "Close this line" confirmation (or closing the whole job). The
 * server applies the same rule.
 */
export function PacketProcessReturnForm({
  jobId,
  jobCode,
  lines,
  jewelleryJobs,
  isOwner,
  onDone,
}: {
  jobId: string;
  jobCode: string;
  lines: PacketProcessLineOption[];
  jewelleryJobs: { id: string; label: string }[];
  isOwner: boolean;
  onDone?: () => void;
}) {
  const openLines = lines.filter((l) => !l.isClosed);
  const [state, formAction, pending] = useActionState(receivePacketProcessReturnAction, undefined);
  const [rows, setRows] = useState<RowDraft[]>(openLines.filter((l) => l.pendingPieces > 0).map((l) => emptyRow(l.id)));
  const [closeIds, setCloseIds] = useState<string[]>([]);
  const [markJobComplete, setMarkJobComplete] = useState(false);
  const [isAbnormalLoss, setIsAbnormalLoss] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const filled = rows.filter((r) => Number(r.pieces) > 0 || Number(r.carat) > 0);
  const lineStatus = openLines.map((line) => {
    const mine = filled.filter((r) => r.jobLineId === line.id);
    const pieces = mine.reduce((s, r) => s + (Number(r.pieces) || 0), 0);
    const carat = mine.reduce((s, r) => s + ct1000(r.carat), 0);
    const pendingCarat = ct1000(line.pendingCarat);
    const allPiecesBack = pieces === line.pendingPieces;
    const gap = pendingCarat - carat;
    const exact = allPiecesBack && pieces > 0 && gap === 0;
    const confirmed = markJobComplete || closeIds.includes(line.id);
    const closes = allPiecesBack && (confirmed || exact);
    let problem: string | null = null;
    if (line.pendingPieces === 0 && pieces > 0) problem = `${line.packetCode}: every piece is already back — confirm closing the line instead.`;
    else if (pieces > line.pendingPieces || gap < 0) problem = `${line.packetCode}: more than the ${line.pendingPieces} pcs / ${line.pendingCarat}ct pending.`;
    else if (!allPiecesBack && carat > 0 && gap === 0) problem = `${line.packetCode}: every carat is back but ${line.pendingPieces - pieces} piece(s) are not.`;
    else if (confirmed && !allPiecesBack) problem = `${line.packetCode}: ${line.pendingPieces - pieces} piece(s) still unaccounted for — the line cannot close.`;
    return { line, pieces, carat, allPiecesBack, gap, exact, closes, loss: closes ? gap : 0, problem };
  });
  const rowProblem = filled
    .map((r) => {
      if (!Number.isInteger(Number(r.pieces)) || Number(r.pieces) < 1 || ct1000(r.carat) <= 0) return "Each line needs whole pieces and a carat greater than zero.";
      if (r.disposition === "USED_IN_JEWELLERY_JOB" && !r.jewelleryJobId) return "Choose the Jewellery Job the stones were used in.";
      if (r.disposition === "DAMAGED_LOST" && r.damagedLostReason.trim().length < 3) return "Give a reason for damaged/lost stones.";
      return null;
    })
    .find((m) => m !== null);
  const problem = rowProblem ?? lineStatus.find((s) => s.problem)?.problem ?? null;
  const jobCloses = lineStatus.length > 0 && lineStatus.every((s) => s.closes);
  const closingLines = lineStatus.filter((s) => s.closes);
  const totalLoss = closingLines.reduce((s, l) => s + l.loss, 0);

  function update(index: number, patch: Partial<RowDraft>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }
  function toggleClose(lineId: string, checked: boolean) {
    setCloseIds((prev) => (checked ? [...prev, lineId] : prev.filter((id) => id !== lineId)));
  }

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (problem || (filled.length === 0 && !markJobComplete && closeIds.length === 0)) {
      window.alert(problem ?? "Enter a returned, used or damaged/lost line, or confirm closing a line.");
      event.preventDefault();
      return;
    }
    const closing = closingLines.map((s) => `${s.line.packetCode} (Process Loss ${fmt(s.loss)}ct)`);
    const summary = [
      jobCloses ? `This CLOSES job ${jobCode}.` : `Partial return for job ${jobCode}. Stones not entered stay with the Manufacturer (not counted as loss).`,
      closing.length > 0 ? `Lines closing — no further returns can be recorded for them: ${closing.join(", ")}.` : "No line closes.",
    ].join("\n");
    if (!window.confirm(`${summary}\n\nSave this return?`)) event.preventDefault();
  }

  const rowsForSubmit = filled.map((r) => ({
    jobLineId: r.jobLineId,
    disposition: r.disposition,
    pieces: r.pieces,
    carat: r.carat,
    sizeLabel: r.sizeLabel || undefined,
    jewelleryJobId: r.disposition === "USED_IN_JEWELLERY_JOB" ? r.jewelleryJobId : undefined,
    damagedLostReason: r.disposition === "DAMAGED_LOST" ? r.damagedLostReason : undefined,
  }));

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="rowsJson" value={JSON.stringify(rowsForSubmit)} />
      <input type="hidden" name="closeLineIdsJson" value={JSON.stringify(closeIds)} />
      <input type="hidden" name="markJobComplete" value={markJobComplete ? "true" : "false"} />
      <input type="hidden" name="isAbnormalLoss" value={isAbnormalLoss ? "true" : "false"} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Return saved as {state.code}.</Alert> : null}

      <Field label="Receive date" name="receiveDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />

      {lineStatus.map((status) => {
        const { line } = status;
        const awaitingClose = line.pendingPieces === 0;
        return (
          <div key={line.id} className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              {line.packetCode} · {line.label}
            </p>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-zinc-600 dark:text-zinc-400 sm:grid-cols-4" aria-label={`Reconciliation for ${line.packetCode}`}>
              <div><dt className="inline">Issued: </dt><dd className="inline font-medium">{line.piecesAtIssue} pcs / {line.caratAtIssue}ct</dd></div>
              <div><dt className="inline">Pending before: </dt><dd className="inline font-medium">{line.pendingPieces} pcs / {line.pendingCarat}ct</dd></div>
              <div><dt className="inline">This return: </dt><dd className="inline font-medium">{status.pieces} pcs / {fmt(status.carat)}ct</dd></div>
              <div><dt className="inline">Still with Manufacturer: </dt><dd className="inline font-medium">{line.pendingPieces - status.pieces} pcs / {fmt(Math.max(status.gap, 0))}ct</dd></div>
            </dl>
            {awaitingClose ? (
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                Every piece is already back; {line.pendingCarat}ct is unaccounted for. The line stays open until closing is confirmed.
              </p>
            ) : null}
            {!awaitingClose
              ? rows.map((row, index) =>
                  row.jobLineId !== line.id ? null : (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      <select aria-label="What happened" value={row.disposition} onChange={(e) => update(index, { disposition: e.target.value as Disposition })} className={SMALL}>
                        <option value="RETURNED_TO_STOCK">Returned to stock</option>
                        <option value="USED_IN_JEWELLERY_JOB">Used in Jewellery Job</option>
                        {isOwner ? <option value="DAMAGED_LOST">Damaged/Lost (Owner)</option> : null}
                      </select>
                      <input aria-label="Pieces" type="number" min="0" step="1" placeholder="Pieces" value={row.pieces} onChange={(e) => update(index, { pieces: e.target.value })} className={`${SMALL} w-20`} />
                      <input aria-label="Carat" type="number" min="0" step="0.001" placeholder="Carat" value={row.carat} onChange={(e) => update(index, { carat: e.target.value })} className={`${SMALL} w-24`} />
                      <input aria-label="Returned size" placeholder="Size (if changed)" value={row.sizeLabel} onChange={(e) => update(index, { sizeLabel: e.target.value })} className={`${SMALL} w-36`} />
                      {row.disposition === "USED_IN_JEWELLERY_JOB" ? (
                        <select aria-label="Jewellery Job" value={row.jewelleryJobId} onChange={(e) => update(index, { jewelleryJobId: e.target.value })} className={SMALL}>
                          <option value="">Choose Jewellery Job…</option>
                          {jewelleryJobs.map((j) => (
                            <option key={j.id} value={j.id}>{j.label}</option>
                          ))}
                        </select>
                      ) : null}
                      {row.disposition === "DAMAGED_LOST" ? (
                        <input aria-label="Reason" placeholder="Reason (required)" value={row.damagedLostReason} onChange={(e) => update(index, { damagedLostReason: e.target.value })} className={`${SMALL} min-w-[10rem] flex-1`} />
                      ) : null}
                    </div>
                  )
                )
              : null}
            {!awaitingClose ? (
              <button type="button" onClick={() => setRows((prev) => [...prev, emptyRow(line.id)])} className="self-start text-xs font-medium text-zinc-700 underline underline-offset-4 dark:text-zinc-300">
                + Add another size / outcome
              </button>
            ) : null}
            {status.exact ? (
              <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">Every piece and carat is back — this line closes with no loss.</p>
            ) : status.allPiecesBack && status.gap > 0 && !markJobComplete ? (
              <label className="flex items-center gap-2 text-sm text-zinc-800 dark:text-zinc-200">
                <input type="checkbox" checked={closeIds.includes(line.id)} onChange={(e) => toggleClose(line.id, e.target.checked)} className="h-4 w-4 rounded border-zinc-300" />
                Close this line — record {fmt(status.gap)}ct as Process Loss (no further returns for this line)
              </label>
            ) : null}
          </div>
        );
      })}

      <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
        <input type="checkbox" checked={markJobComplete} onChange={(e) => setMarkJobComplete(e.target.checked)} className="h-4 w-4 rounded border-zinc-300" />
        Nothing more will come back — close every line and the job (every piece must be accounted for)
      </label>
      {isOwner && totalLoss > 0 ? (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
            <input type="checkbox" checked={isAbnormalLoss} onChange={(e) => setIsAbnormalLoss(e.target.checked)} className="h-4 w-4 rounded border-zinc-300" />
            Classify the {fmt(totalLoss)}ct process loss as abnormal (Owner)
          </label>
          {isAbnormalLoss ? <Field label="Abnormal loss reason" name="abnormalLossReason" required /> : null}
        </div>
      ) : null}
      <Field label="Notes" name="notes" />

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm" aria-live="polite">
        {closingLines.length > 0 ? (
          <p>
            Lines closing: <span className="font-semibold">{closingLines.map((s) => `${s.line.packetCode} (${fmt(s.loss)}ct loss)`).join(", ")}</span>
          </p>
        ) : (
          <p>No line closes with this return.</p>
        )}
        {jobCloses ? <p className="font-medium text-emerald-700 dark:text-emerald-400">This return closes the job.</p> : null}
        {problem ? <p className="mt-1 font-medium text-red-600 dark:text-red-400">{problem}</p> : null}
      </div>

      <Button type="submit" size="lg" disabled={pending || !!problem} className="self-start">
        {pending ? "Saving…" : "Save return"}
      </Button>
    </form>
  );
}
