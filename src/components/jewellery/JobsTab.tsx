"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import { CreateJobForm, type PurityOption } from "@/components/jewellery/CreateJobForm";
import { Button } from "@/components/ui/Button";
import type { PartyOption } from "@/components/accounting/PartySelect";
import { jewelleryTypeLabel } from "@/lib/jewellery/types";
import { CARRYING_COST_UNAVAILABLE_MESSAGE } from "@/lib/jewellery/carryingCostMessage";
import { GOLD_SOURCE_LABELS, GOLD_SOURCES, type GoldSource } from "@/lib/jewellery/jobGoldSourceLabels";
import { jobListHref, type JobListFilters } from "@/lib/jewellery/jobListHref";
import type { JewelleryType } from "@/generated/prisma/enums";

/** A cost field may carry the fail-closed message instead of a number — see
 * carryingCostMessage.ts. Shown as-is, without a ₹ prefix. */
function money(value: string): string {
  return value === CARRYING_COST_UNAVAILABLE_MESSAGE ? value : `₹${value}`;
}

export type SerializedJewelleryJob = {
  id: string;
  jobCode: string;
  customerName: string | null;
  karigarName: string;
  /** Derived from the gold movement records (jobGoldSource.ts), never from notes. */
  goldSource: GoldSource;
  jewelleryType: JewelleryType;
  designName: string;
  issueDate: string;
  expectedDeliveryDate: string | null;
  status: string;
  issuedMetalFineWeight: string;
  pendingFineWeight: string;
  /** Owner-only — null for Staff (redacted on the server). */
  /** Materials + Karigar-supplied + charges; Owner only. */
  totalManufacturingCost: string | null;
};

export type JobFilterParty = { id: string; name: string; archived: boolean };
export type { JobListFilters };

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

const INPUT =
  "h-11 w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "COMPLETED"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      : status === "CANCELLED"
        ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400"
        : status === "NEEDS_CORRECTION"
          ? "bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
          : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  return <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{STATUS_LABELS[status] ?? status}</span>;
}

const SOURCE_TONE: Record<GoldSource, string> = {
  CUSTOMER: "text-sky-700 dark:text-sky-300",
  COMPANY: "text-amber-800 dark:text-amber-300",
  MIXED: "text-violet-700 dark:text-violet-300",
  NONE: "text-zinc-500 dark:text-zinc-400",
  REVIEW: "text-red-700 dark:text-red-400",
};

/** Type-to-search party picker for a GET form: the visible text box shows
 * names (archived ones marked), the hidden field carries the chosen id. */
function PartyFilter({ label, name, allLabel, parties, value }: { label: string; name: string; allLabel: string; parties: JobFilterParty[]; value: string }) {
  const listId = useId();
  const display = (p: JobFilterParty) => {
    const dup = parties.filter((x) => x.name === p.name).length > 1;
    return `${p.name}${p.archived ? " (archived)" : ""}${dup ? ` · ${p.id.slice(-4)}` : ""}`;
  };
  const [text, setText] = useState(() => {
    const p = parties.find((x) => x.id === value);
    return p ? display(p) : "";
  });
  const chosen = parties.find((p) => display(p) === text);
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
      {label}
      <input
        type="search"
        list={listId}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={allLabel}
        aria-label={label}
        className={INPUT}
        data-testid={`filter-${name}`}
      />
      <datalist id={listId}>
        {parties.map((p) => (
          <option key={p.id} value={display(p)} />
        ))}
      </datalist>
      <input type="hidden" name={name} value={chosen?.id ?? ""} />
      {text && !chosen ? <span className="text-[11px] font-normal text-amber-700 dark:text-amber-300">Pick a name from the list ({allLabel.toLowerCase()} until then).</span> : null}
    </label>
  );
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
  filters = { customerId: "", karigarId: "", goldSource: "" },
  filterCustomers = [],
  filterKarigars = [],
  unavailableFilters = [],
  total,
}: {
  jobs: SerializedJewelleryJob[];
  customers: PartyOption[];
  karigars: PartyOption[];
  purities: PurityOption[];
  isOwner: boolean;
  search: string;
  view: string;
  initialShowForm?: boolean;
  filters?: JobListFilters;
  filterCustomers?: JobFilterParty[];
  filterKarigars?: JobFilterParty[];
  unavailableFilters?: string[];
  total?: number;
  /** Rows are capped server-side (JOB_LIST_LIMIT); `total` says how many matched. */
  limit?: number;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(initialShowForm ?? false);
  const filtered = Boolean(filters.customerId || filters.karigarId || filters.goldSource || search);
  const clearHref = jobListHref(view, {});

  function handleSaved() {
    router.refresh();
  }

  return (
    <div className="flex min-w-0 flex-col gap-5">
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
            href={jobListHref(v.value, { ...filters, search })}
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

      <form method="GET" action="/jewellery-jobs" className="grid min-w-0 grid-cols-1 gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:grid-cols-2 lg:grid-cols-5" data-testid="job-filters">
        <input type="hidden" name="tab" value="jobs" />
        <input type="hidden" name="view" value={view} />
        <PartyFilter key={`c-${filters.customerId}`} label="Customer" name="jobCustomer" allLabel="All customers" parties={filterCustomers} value={filters.customerId} />
        <PartyFilter key={`k-${filters.karigarId}`} label="Karigar" name="jobKarigar" allLabel="All karigars" parties={filterKarigars} value={filters.karigarId} />
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Gold source
          <select name="goldSource" defaultValue={filters.goldSource} className={INPUT} data-testid="filter-goldSource">
            <option value="">All sources</option>
            {GOLD_SOURCES.map((g) => (
              <option key={g} value={g}>
                {GOLD_SOURCE_LABELS[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          Search
          <input
            type="text"
            name="jobSearch"
            defaultValue={search}
            placeholder="Job, design, item, Customer, Karigar, piece or receipt code…"
            className={INPUT}
            data-testid="filter-search"
          />
        </label>
        <div className="flex min-w-0 items-end gap-2">
          <button
            type="submit"
            className="h-11 flex-1 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-amber-200 dark:text-zinc-900"
            data-testid="filter-apply"
          >
            Apply
          </button>
          <a
            href={clearHref}
            className="inline-flex h-11 flex-1 items-center justify-center rounded-lg border border-zinc-300 px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
            data-testid="filter-clear"
          >
            Clear filters
          </a>
        </div>
      </form>

      {unavailableFilters.length ? (
        <p className="text-xs text-amber-800 dark:text-amber-300" data-testid="filter-unavailable">
          {unavailableFilters.join(", ")} filter: Unavailable (not found) — ignored.
        </p>
      ) : null}

      {total !== undefined ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400" data-testid="job-count">
          {total === 0 ? "" : total > jobs.length ? `Showing the newest ${jobs.length} of ${total} jobs — narrow the filters to see the rest.` : `${total} job${total === 1 ? "" : "s"}${filtered ? " match these filters" : ""}.`}
        </p>
      ) : null}

      {jobs.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-[var(--border)] p-8 text-center" data-testid="job-empty">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{filtered ? "No jewellery jobs match these filters." : "No jobs in this view yet."}</p>
          {filtered ? (
            <a href={clearHref} className="text-sm font-medium underline underline-offset-4">
              Clear filters
            </a>
          ) : (
            <p className="text-xs text-zinc-500">Create a new jewellery job to get started.</p>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]" data-testid="job-list">
          {jobs.map((job) => (
            <li key={job.id} className="flex min-w-0 flex-col gap-2 bg-[var(--surface)] p-4 sm:flex-row sm:items-start sm:justify-between" data-testid="job-row">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50" data-testid="job-code">
                    {job.jobCode}
                  </p>
                  <StatusPill status={job.status} />
                </div>
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                  <div className="flex min-w-0 gap-1">
                    <dt className="shrink-0 text-zinc-500 dark:text-zinc-400">Customer:</dt>
                    <dd className="min-w-0 break-words text-zinc-800 dark:text-zinc-200" data-testid="job-customer">
                      {job.customerName ?? <span className="text-zinc-400">No customer selected</span>}
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1">
                    <dt className="shrink-0 text-zinc-500 dark:text-zinc-400">Karigar:</dt>
                    <dd className="min-w-0 break-words text-zinc-800 dark:text-zinc-200" data-testid="job-karigar">
                      {job.karigarName || <span className="text-zinc-400">Not assigned</span>}
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1">
                    <dt className="shrink-0 text-zinc-500 dark:text-zinc-400">Gold source:</dt>
                    <dd className={`min-w-0 font-medium ${SOURCE_TONE[job.goldSource]}`} data-testid="job-gold-source">
                      {GOLD_SOURCE_LABELS[job.goldSource]}
                    </dd>
                  </div>
                  <div className="flex min-w-0 gap-1">
                    <dt className="shrink-0 text-zinc-500 dark:text-zinc-400">Pending metal:</dt>
                    <dd className="min-w-0 text-zinc-800 dark:text-zinc-200">{job.pendingFineWeight}g fine</dd>
                  </div>
                  <div className="flex min-w-0 gap-1 sm:col-span-2">
                    <dt className="shrink-0 text-zinc-500 dark:text-zinc-400">Item:</dt>
                    <dd className="min-w-0 break-words text-zinc-800 dark:text-zinc-200">
                      {job.designName} · {jewelleryTypeLabel(job.jewelleryType)}
                      {isOwner && job.totalManufacturingCost !== null ? ` · ${money(job.totalManufacturingCost)}` : ""}
                    </dd>
                  </div>
                </dl>
              </div>
              <a
                href={jobListHref(view, { ...filters, search, jobId: job.id })}
                className="inline-flex min-h-11 shrink-0 items-center text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
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
