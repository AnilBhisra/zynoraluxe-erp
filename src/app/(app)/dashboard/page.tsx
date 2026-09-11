import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { getCashBankSummary, getReceivablePayableSummary } from "@/lib/accounting/reports";
import { PageHeader } from "@/components/ui/PageHeader";
import { SummaryCard } from "@/components/dashboard/SummaryCard";
import { QuickActionButton } from "@/components/dashboard/QuickActionButton";

export const metadata: Metadata = {
  title: "Dashboard · ZYNORALUXE",
};

function money(value: { toFixed: (n: number) => string }) {
  return `₹${Number(value.toFixed(2)).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const PLACEHOLDER_CARDS = [
  { label: "Rough stock", unit: "carat", phase: 3 },
  { label: "Polished stock", unit: "carat", phase: 3 },
  { label: "Material with Karigar", phase: 3 },
  { label: "Pending jewellery jobs", phase: 4 },
];

const PLACEHOLDER_ACTIONS = [
  { label: "Issue Rough", href: "/diamond", phase: 3 },
  { label: "Receive Polished", href: "/diamond", phase: 3 },
  { label: "New Jewellery Job", href: "/jewellery-jobs", phase: 4 },
  { label: "New Costing", href: "/costing", phase: 5 },
];

export default async function DashboardPage() {
  const user = await requireUser();
  const [cashBank, receivablePayable] = await Promise.all([
    getCashBankSummary(),
    getReceivablePayableSummary(),
  ]);

  return (
    <div>
      <PageHeader
        title={`Welcome, ${user.name.split(" ")[0]}`}
        description="Here's today's snapshot of the business."
      />

      <section aria-label="Business summary" className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <SummaryCard label="Cash balance" value={money(cashBank.cash)} />
        <SummaryCard label="Bank balance" value={money(cashBank.bank)} />
        <SummaryCard label="Receivable" value={money(receivablePayable.receivable)} />
        <SummaryCard label="Payable" value={money(receivablePayable.payable)} />
        {PLACEHOLDER_CARDS.map((card) => (
          <SummaryCard key={card.label} {...card} />
        ))}
      </section>

      <section aria-label="Quick actions" className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Quick actions
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <QuickActionButton
            label="New Purchase"
            href="/accounting?tab=transactions&new=purchase"
            enabled
          />
          <QuickActionButton
            label="New Sale"
            href="/accounting?tab=transactions&new=sale"
            enabled
          />
          {PLACEHOLDER_ACTIONS.map((action) => (
            <QuickActionButton key={action.label} {...action} />
          ))}
        </div>
      </section>
    </div>
  );
}
