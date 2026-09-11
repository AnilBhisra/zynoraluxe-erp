import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/ui/PageHeader";
import { SummaryCard } from "@/components/dashboard/SummaryCard";
import { QuickActionButton } from "@/components/dashboard/QuickActionButton";

export const metadata: Metadata = {
  title: "Dashboard · ZYNORALUXE",
};

const SUMMARY_CARDS = [
  { label: "Cash balance", phase: 2 },
  { label: "Bank balance", phase: 2 },
  { label: "Receivable", phase: 2 },
  { label: "Payable", phase: 2 },
  { label: "Rough stock", unit: "carat", phase: 3 },
  { label: "Polished stock", unit: "carat", phase: 3 },
  { label: "Material with Karigar", phase: 3 },
  { label: "Pending jewellery jobs", phase: 4 },
];

const QUICK_ACTIONS = [
  { label: "New Purchase", href: "/accounting", phase: 2 },
  { label: "New Sale", href: "/accounting", phase: 2 },
  { label: "Issue Rough", href: "/diamond", phase: 3 },
  { label: "Receive Polished", href: "/diamond", phase: 3 },
  { label: "New Jewellery Job", href: "/jewellery-jobs", phase: 4 },
  { label: "New Costing", href: "/costing", phase: 5 },
];

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <div>
      <PageHeader
        title={`Welcome, ${user.name.split(" ")[0]}`}
        description="Here's today's snapshot of the business."
      />

      <section aria-label="Business summary" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {SUMMARY_CARDS.map((card) => (
          <SummaryCard key={card.label} {...card} />
        ))}
      </section>

      <section aria-label="Quick actions" className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Quick actions
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {QUICK_ACTIONS.map((action) => (
            <QuickActionButton key={action.label} {...action} />
          ))}
        </div>
      </section>
    </div>
  );
}
