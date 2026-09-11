"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { IssueRoughForm, type AvailablePieceOption } from "@/components/diamond/IssueRoughForm";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PartyOption } from "@/components/accounting/PartySelect";
import { shapeLabel } from "@/lib/diamond/shapes";
import type { DiamondShape } from "@/generated/prisma/enums";

export type SerializedDiamondJob = {
  id: string;
  jobCode: string;
  karigarName: string;
  requiredShape: DiamondShape;
  customShapeName: string | null;
  issueDate: string;
  dueDate: string | null;
  issuedPiecesCount: number;
  issuedRoughCarat: string;
  pendingCarat: string;
  status: string;
  totalLabourCharge: string;
};

const STATUS_LABELS: Record<string, string> = {
  ISSUED: "Issued",
  IN_PROGRESS: "In Progress",
  PARTIALLY_RECEIVED: "Partially Received",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "COMPLETED"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      : status === "CANCELLED"
        ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400"
        : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function JobsTab({
  jobs,
  karigars,
  availablePieces,
  isOwner,
  search,
  statusFilter,
  initialShowForm,
}: {
  jobs: SerializedDiamondJob[];
  karigars: PartyOption[];
  availablePieces: AvailablePieceOption[];
  isOwner: boolean;
  search: string;
  statusFilter: string;
  initialShowForm?: boolean;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(initialShowForm ?? false);

  function handleSaved() {
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Cutting-polishing jobs</h2>
        <Button type="button" variant={showForm ? "primary" : "secondary"} size="md" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Close" : "Issue Rough"}
        </Button>
      </div>

      {showForm ? (
        <IssueRoughForm karigars={karigars} availablePieces={availablePieces} isOwner={isOwner} onDone={handleSaved} />
      ) : null}

      <form method="GET" action="/diamond" className="flex flex-wrap gap-2">
        <input type="hidden" name="tab" value="jobs" />
        <input
          type="text"
          name="jobSearch"
          defaultValue={search}
          placeholder="Search by job code or Karigar…"
          className="h-11 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <select
          name="jobStatus"
          defaultValue={statusFilter}
          className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <option value="">All open</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
          <option value="ALL">All</option>
        </select>
        <button
          type="submit"
          className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Filter
        </button>
      </form>

      {jobs.length === 0 ? (
        <EmptyState title="No jobs match" description="Issue rough to a Karigar to create the first job." />
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
          {jobs.map((job) => (
            <li key={job.id} className="flex flex-col gap-2 bg-[var(--surface)] p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">{job.jobCode}</p>
                  <StatusPill status={job.status} />
                </div>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {job.karigarName} · {job.customShapeName || shapeLabel(job.requiredShape)} · {job.issuedPiecesCount} piece
                  {job.issuedPiecesCount === 1 ? "" : "s"} · {job.issuedRoughCarat}ct issued · {job.pendingCarat}ct pending
                </p>
              </div>
              <a
                href={`/diamond?tab=jobs&jobId=${job.id}`}
                className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
              >
                View job
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
