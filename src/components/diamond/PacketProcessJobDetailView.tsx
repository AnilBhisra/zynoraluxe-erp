"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { CancelPacketProcessJobForm } from "@/components/diamond/CancelPacketProcessJobForm";
import { PACKET_JOB_STATUS_LABELS } from "@/components/diamond/JobManufacturerTab";
import { PacketProcessReturnForm, type PacketProcessLineOption } from "@/components/diamond/PacketProcessReturnForm";

export type SerializedPacketProcessJobDetail = {
  id: string;
  jobCode: string;
  manufacturerName: string;
  processName: string;
  issueDate: string;
  dueDate: string | null;
  status: string;
  issuedPieces: number;
  issuedCarat: string;
  pendingPieces: number;
  pendingCarat: string;
  returnedPieces: number;
  usedPieces: number;
  damagedPieces: number;
  lossCarat: string;
  chargeRateBasis: string;
  notes: string | null;
  cancellationReason: string | null;
  hasReceipts: boolean;
  /** Owner-only cost figures — null for Staff (redacted on the server). */
  issuedCostValue: string | null;
  remainingWipCost: string | null;
  totalCharge: string | null;
  chargeRate: string | null;
  lines: (PacketProcessLineOption & { lossCarat: string; closedAt: string | null; costAtIssue: string | null })[];
  receipts: {
    id: string;
    receiptCode: string;
    receiveDate: string;
    isFinal: boolean;
    lossCarat: string;
    processCharge: string | null;
    lines: { disposition: string; pieces: number; carat: string; sizeLabel: string; costValue: string | null; jewelleryJobCode: string | null; resultPacketCode: string | null; reason: string | null }[];
  }[];
};

const DISPOSITION_LABELS: Record<string, string> = {
  RETURNED_TO_STOCK: "Returned to stock",
  USED_IN_JEWELLERY_JOB: "Used in Jewellery Job",
  DAMAGED_LOST: "Damaged/Lost",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="font-medium text-zinc-900 dark:text-zinc-50">{value}</dd>
    </div>
  );
}

export function PacketProcessJobDetailView({
  job,
  jewelleryJobs,
  isOwner,
}: {
  job: SerializedPacketProcessJobDetail;
  jewelleryJobs: { id: string; label: string }[];
  isOwner: boolean;
}) {
  const router = useRouter();
  const [showReturn, setShowReturn] = useState(false);
  const canReturn = job.status === "ISSUED" || job.status === "PARTIALLY_RETURNED";
  const canCancel = isOwner && job.status === "ISSUED" && !job.hasReceipts;

  return (
    <div className="flex flex-col gap-5">
      <a href="/diamond?tab=job-manufacturer" className="text-sm text-zinc-600 underline underline-offset-4 dark:text-zinc-400">
        ← All Job Manufacturer jobs
      </a>
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{job.jobCode}</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {job.manufacturerName} · {job.processName} · {PACKET_JOB_STATUS_LABELS[job.status] ?? job.status}
            </p>
          </div>
          {canCancel ? <CancelPacketProcessJobForm jobId={job.id} jobCode={job.jobCode} /> : null}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Stat label="Issued" value={`${job.issuedPieces} pcs / ${job.issuedCarat}ct`} />
          <Stat label="With Manufacturer" value={`${job.pendingPieces} pcs / ${job.pendingCarat}ct`} />
          <Stat label="Returned · Used · Damaged" value={`${job.returnedPieces} · ${job.usedPieces} · ${job.damagedPieces} pcs`} />
          <Stat label="Process Loss" value={`${job.lossCarat}ct`} />
          {isOwner ? <Stat label="Issued cost" value={`₹${job.issuedCostValue}`} /> : null}
          {isOwner ? <Stat label="Still in WIP" value={`₹${job.remainingWipCost}`} /> : null}
          {isOwner ? <Stat label="Process charge" value={`₹${job.totalCharge}`} /> : null}
        </dl>
        {job.status === "CANCELLED" && job.cancellationReason ? (
          <p className="mt-3 text-sm text-red-700 dark:text-red-400">Cancelled: {job.cancellationReason}</p>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="bg-[var(--surface-muted)] text-xs text-zinc-500 dark:text-zinc-400">
            <tr>
              <th className="px-3 py-2 font-medium">Packet (size-wise)</th>
              <th className="px-3 py-2 text-right font-medium">Issued</th>
              <th className="px-3 py-2 text-right font-medium">Pending</th>
              <th className="px-3 py-2 text-right font-medium">Loss</th>
              <th className="px-3 py-2 font-medium">Line</th>
              {isOwner ? <th className="px-3 py-2 text-right font-medium">Cost at issue</th> : null}
            </tr>
          </thead>
          <tbody>
            {job.lines.map((l) => (
              <tr key={l.id} className="border-t border-[var(--border)]">
                <td className="px-3 py-2">
                  {l.packetCode} · {l.label}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {l.piecesAtIssue} pcs / {l.caratAtIssue}ct
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {l.pendingPieces} pcs / {l.pendingCarat}ct
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{l.lossCarat}ct</td>
                <td className="px-3 py-2 text-xs">
                  {l.isClosed
                    ? `Closed${l.closedAt ? ` ${new Date(l.closedAt).toLocaleDateString("en-IN")}` : ""}`
                    : l.pendingPieces === 0
                      ? "Awaiting close confirmation"
                      : "Open"}
                </td>
                {isOwner ? <td className="px-3 py-2 text-right tabular-nums">₹{l.costAtIssue}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canReturn ? (
        <div>
          <Button type="button" variant={showReturn ? "primary" : "secondary"} size="md" onClick={() => setShowReturn((v) => !v)}>
            {showReturn ? "Close" : "Receive return"}
          </Button>
          {showReturn ? (
            <div className="mt-3">
              <PacketProcessReturnForm
                jobId={job.id}
                jobCode={job.jobCode}
                lines={job.lines}
                jewelleryJobs={jewelleryJobs}
                isOwner={isOwner}
                onDone={() => router.refresh()}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {job.receipts.length > 0 ? (
        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Returns</h3>
          {job.receipts.map((r) => (
            <div key={r.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
              <p className="font-medium text-zinc-800 dark:text-zinc-200">
                {r.receiptCode} · {new Date(r.receiveDate).toLocaleDateString("en-IN")}
                {r.isFinal ? " · closed the job" : ""} · loss {r.lossCarat}ct{isOwner ? ` · charge ₹${r.processCharge}` : ""}
              </p>
              <ul className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {r.lines.map((l, i) => (
                  <li key={i}>
                    {DISPOSITION_LABELS[l.disposition] ?? l.disposition}: {l.pieces} pcs / {l.carat}ct · size {l.sizeLabel}
                    {l.resultPacketCode ? ` → ${l.resultPacketCode}` : ""}
                    {l.jewelleryJobCode ? ` → ${l.jewelleryJobCode}` : ""}
                    {l.reason ? ` · ${l.reason}` : ""}
                    {isOwner ? ` · ₹${l.costValue}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
