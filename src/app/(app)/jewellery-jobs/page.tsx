import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhaseNotice } from "@/components/ui/PhaseNotice";

export const metadata: Metadata = {
  title: "Jewellery Jobs · ZYNORALUXE",
};

const UPCOMING_FILTERS = ["Pending", "In Progress", "Completed"];

export default async function JewelleryJobsPage() {
  await requireUser();

  return (
    <div>
      <PageHeader
        title="Jewellery Jobs"
        description="Jewellery job issue, receive and status."
      />
      <PhaseNotice
        title="Jewellery Job is built in Phase 4"
        phase={4}
        summary="Job creation, metal/diamond issue to a Karigar, finished jewellery receive, return and wastage tracking, and job-wise total cost will live here."
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {UPCOMING_FILTERS.map((filter) => (
          <span
            key={filter}
            className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400"
          >
            {filter}
          </span>
        ))}
      </div>
    </div>
  );
}
