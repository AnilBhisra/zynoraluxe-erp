import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { PageHeader } from "@/components/ui/PageHeader";
import { PhaseNotice } from "@/components/ui/PhaseNotice";

export const metadata: Metadata = {
  title: "Accounting · ZYNORALUXE",
};

const UPCOMING_TABS = ["Transactions", "Parties", "Ledger", "Reports"];

export default async function AccountingPage() {
  await requireUser();

  return (
    <div>
      <PageHeader
        title="Accounting"
        description="Transactions, parties, ledger and reports."
      />
      <PhaseNotice
        title="Accounting is built in Phase 2"
        phase={2}
        summary="Purchase, sale, payment, expense entries, party ledgers, cash/bank balances and GST/P&L reports will live here, organised into simple tabs."
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
