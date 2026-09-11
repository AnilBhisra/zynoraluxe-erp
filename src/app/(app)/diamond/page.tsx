import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhaseNotice } from "@/components/ui/PhaseNotice";

export const metadata: Metadata = {
  title: "Diamond · ZYNORALUXE",
};

const UPCOMING_TABS = ["Rough Stock", "Cutting-Polishing Jobs", "Polished Stock"];

export default async function DiamondPage() {
  await requireUser();

  return (
    <div>
      <PageHeader
        title="Diamond"
        description="Rough stock, cutting-polishing jobs and polished stock."
      />
      <PhaseNotice
        title="Diamond manufacturing is built in Phase 3"
        phase={3}
        summary="Rough purchase and stock, Karigar issue with custom shape details, polished receive, automatic yield/loss calculation and polished stock will live here."
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {UPCOMING_TABS.map((tab) => (
          <span
            key={tab}
            className="rounded-full border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400"
          >
            {tab}
          </span>
        ))}
      </div>
    </div>
  );
}
