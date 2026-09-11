"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { CreateJobForm, type PurityOption } from "@/components/jewellery/CreateJobForm";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PartyOption } from "@/components/accounting/PartySelect";
import { jewelleryTypeLabel } from "@/lib/jewellery/types";
import type { JewelleryType } from "@/generated/prisma/enums";

export type SerializedJewelleryJob = {
  id: string;
  jobCode: string;
  customerName: string | null;
  karigarName: string;
  jewelleryType: JewelleryType;
  designName: string;
  issueDate: string;
  expectedDeliveryDate: string | null;
  status: string;
  issuedMetalFineWeight: string;
  pendingFineWeight: string;
  totalIssuedCost: string;
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  MATERIALS_ISSUED: "Materials Issued",
  IN_PROGRESS: "In Progress",
  PARTIALLY_RECEIVED: "Partially Received",
  NEEDS_CORRECTION: "Needs Correction",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const VIEWS = [
  { value: "PENDING", label: "Pending" },
  { value: "IN_PROGRESS", label: "In Progress" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "ALL", label: "All Jobs" },
] as const;

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "COMPLETED"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      : status === "CANCELLED"
        ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400"
        : status === "NEEDS_CORRECTION"
          ? "bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
          : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function JobsTab({
  jobs,
  customers,
  karigars,
  purities,
  isOwner,
  search,
  view,
  initialShowForm,
}: {
  jobs: SerializedJewelleryJob[];
  customers: PartyOption[];
  karigars: PartyOption[];
  purities: PurityOption[];
  isOwner: boolean;
  search: string;
  view: string;
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
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Jewellery jobs</h2>
        <Button type="button" variant={showForm ? "primary" : "secondary"} size="md" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Close" : "New Jewellery Job"}
        </Button>
      </div>

      {showForm ? (
        <CreateJobForm customers={customers} karigars={karigars} purities={purities} onDone={handleSaved} />
      ) : null}

      <nav aria-label="Job views" className="flex flex-wrap gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5">
        {VIEWS.map((v) => (
          <a
            key={v.value}
            href={`/jewellery-jobs?tab=jobs&view=${v.value}`}
            aria-current={view === v.value ? "page" : undefined}
            className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              view === v.value
                ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {v.label}
          </a>
        ))}
      </nav>

      <form method="GET" action="/jewellery-jobs" className="flex flex-wrap gap-2">
        <input type="hidden" name="tab" value="jobs" />
        <input type="hidden" name="view" value={view} />
        <input
          type="text"
          name="jobSearch"
          defaultValue={search}
          placeholder="Search by job code, design or Karigar…"
          className="h-11 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Search
        </button>
      </form>

      {jobs.length === 0 ? (
        <EmptyState title="No jobs match" description="Create a new jewellery job to get started." />
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
                  {job.designName} · {jewelleryTypeLabel(job.jewelleryType)} · {job.karigarName}
                  {job.customerName ? ` · ${job.customerName}` : ""} · {job.pendingFineWeight}g pending
                  {isOwner ? ` · ₹${job.totalIssuedCost}` : ""}
                </p>
              </div>
              <a
                href={`/jewellery-jobs?tab=jobs&view=${view}&jobId=${job.id}`}
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
