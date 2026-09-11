import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhaseNotice } from "@/components/ui/PhaseNotice";

export const metadata: Metadata = {
  title: "Costing · ZYNORALUXE",
};

const UPCOMING_SECTIONS = [
  "Metal, diamond and labour cost",
  "Making, wastage and certification cost",
  "Suggested selling price",
  "Costing PDF/print",
];

export default async function CostingPage() {
  await requireUser();

  return (
    <div>
      <PageHeader title="Costing" description="Product/job cost and selling price." />
      <PhaseNotice
        title="Costing is built in Phase 5"
        phase={5}
        summary="Final cost, suggested selling price and actual profit will be calculated automatically from real accounting, diamond and jewellery job data — not entered by hand."
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {UPCOMING_SECTIONS.map((section) => (
          <span
            key={section}
            className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400"
          >
            {section}
          </span>
        ))}
      </div>
    </div>
  );
}
