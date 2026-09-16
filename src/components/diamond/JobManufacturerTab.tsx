"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/Button";
import { CsvDownloadButton } from "@/components/accounting/CsvDownloadButton";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PartyOption } from "@/components/accounting/PartySelect";
import type { ProcessOption } from "@/components/diamond/IssueRoughForm";
import { PacketProcessIssueForm } from "@/components/diamond/PacketProcessIssueForm";
import type { AvailablePacketOption } from "@/components/jewellery/IssueMaterialsForm";

export type SerializedPacketProcessJob = {
  id: string;
  jobCode: string;
  manufacturerName: string;
  processName: string;
  issueDate: string;
  status: string;
  issuedPieces: number;
  issuedCarat: string;
  pendingPieces: number;
  pendingCarat: string;
  /** Owner-only — null for Staff. */
  totalCharge: string | null;
};

export const PACKET_JOB_STATUS_LABELS: Record<string, string> = {
  ISSUED: "Issued",
  PARTIALLY_RETURNED: "Partially Returned",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

export function JobManufacturerTab({
  jobs,
  manufacturers,
  processes,
  packets,
  isOwner,
  search,
  statusFilter,
}: {
  jobs: SerializedPacketProcessJob[];
  manufacturers: PartyOption[];
  processes: ProcessOption[];
  packets: AvailablePacketOption[];
  isOwner: boolean;
  search: string;
  statusFilter: string;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Job Manufacturer — polished packets out for a process</h2>
        <Button type="button" variant={showForm ? "primary" : "secondary"} size="md" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Close" : "Issue packets"}
        </Button>
      </div>

      {showForm ? (
        <PacketProcessIssueForm manufacturers={manufacturers} processes={processes} packets={packets} onDone={() => router.refresh()} />
      ) : null}

      <form method="GET" action="/diamond" className="flex flex-wrap gap-2">
        <input type="hidden" name="tab" value="job-manufacturer" />
        <input
          type="text"
          name="jmSearch"
          defaultValue={search}
          placeholder="Search by job code, Manufacturer or process…"
          className="h-11 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <select name="jmStatus" defaultValue={statusFilter} className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100">
          <option value="">All open</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="ALL">All</option>
        </select>
        <button type="submit" className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
          Filter
        </button>
        {jobs.length > 0 ? (
          <CsvDownloadButton
            filename="job-manufacturer.csv"
            headers={["Job", "Manufacturer", "Process", "Issue date", "Status", "Issued pcs", "Issued ct", "Pending pcs", "Pending ct", ...(isOwner ? ["Process charge"] : [])]}
            rows={jobs.map((j) => [
              j.jobCode,
              j.manufacturerName,
              j.processName,
              j.issueDate.slice(0, 10),
              PACKET_JOB_STATUS_LABELS[j.status] ?? j.status,
              j.issuedPieces,
              j.issuedCarat,
              j.pendingPieces,
              j.pendingCarat,
              ...(isOwner ? [j.totalCharge ?? ""] : []),
            ])}
          />
        ) : null}
      </form>

      {jobs.length === 0 ? (
        <EmptyState title="No Job Manufacturer jobs match" description="Issue polished packets to a Manufacturer to create the first job." />
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
          {jobs.map((job) => (
            <li key={job.id} className="flex flex-col gap-2 bg-[var(--surface)] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                  {job.jobCode} <span className="ml-2 text-xs font-normal text-zinc-500">{PACKET_JOB_STATUS_LABELS[job.status] ?? job.status}</span>
                </p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {job.manufacturerName} · {job.processName} · {job.issuedPieces} pcs / {job.issuedCarat}ct issued · {job.pendingPieces} pcs /{" "}
                  {job.pendingCarat}ct pending{isOwner && job.totalCharge ? ` · charge ₹${job.totalCharge}` : ""}
                </p>
              </div>
              <a href={`/diamond?tab=job-manufacturer&jmJobId=${job.id}`} className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300">
                View job
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
