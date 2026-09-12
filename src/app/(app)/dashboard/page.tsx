import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { getCashBankSummary, getReceivablePayableSummary } from "@/lib/accounting/reports";
import { getDashboardDiamondSummary } from "@/lib/diamond/reports";
import { getFinishedJewelleryStockSummary, getPendingJewelleryJobsCount } from "@/lib/jewellery/reports";
import { getDraftCostingsCount } from "@/lib/costing/reports";
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

function carat(value: { toFixed: (n: number) => string }) {
  return `${value.toFixed(3)}`;
}

export default async function DashboardPage() {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";
  const [cashBank, receivablePayable, diamondSummary, pendingJewelleryJobs, draftCostingsCount, finishedStock] =
    await Promise.all([
      getCashBankSummary(),
      getReceivablePayableSummary(),
      getDashboardDiamondSummary(),
      getPendingJewelleryJobsCount(),
      // Costing figures are Owner-only — Staff must never receive even a
      // draft COUNT through this query, so it is only ever fetched when
      // isOwner is true (never fetched-then-hidden).
      isOwner ? getDraftCostingsCount() : Promise.resolve(null),
      // Inventory VALUE is Owner-only — only requested (queried) when
      // isOwner is true, same never-fetched-then-hidden rule as above.
      // Staff still gets the operational count/weight, just no ₹ figure.
      getFinishedJewelleryStockSummary(isOwner),
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
        <SummaryCard label="Rough stock" value={carat(diamondSummary.roughStockCarat)} unit="carat" />
        <SummaryCard label="Polished stock" value={carat(diamondSummary.polishedStockCarat)} unit="carat" />
        <SummaryCard label="Material with Karigar" value={carat(diamondSummary.materialWithKarigarCarat)} unit="carat" />
        <SummaryCard label="Pending jewellery jobs" value={String(pendingJewelleryJobs)} />
        {isOwner && draftCostingsCount !== null ? (
          <SummaryCard label="Draft costings" value={String(draftCostingsCount)} />
        ) : null}
        <SummaryCard label="Finished stock (Available)" value={String(finishedStock.availableCount)} />
        <SummaryCard label="Finished stock weight" value={carat(finishedStock.availableFineWeight)} unit="g fine" />
        {isOwner && finishedStock.availableInventoryValue !== undefined ? (
          <SummaryCard label="Finished stock value" value={money(finishedStock.availableInventoryValue)} />
        ) : null}
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
          <QuickActionButton label="Issue Rough" href="/diamond?tab=jobs&issue=1" enabled />
          <QuickActionButton label="Receive Polished" href="/diamond?tab=jobs" enabled />
          <QuickActionButton label="New Jewellery Job" href="/jewellery-jobs?tab=jobs&issue=1" enabled />
          {isOwner ? <QuickActionButton label="New Costing" href="/costing?tab=new" enabled /> : null}
        </div>
      </section>
    </div>
  );
}
