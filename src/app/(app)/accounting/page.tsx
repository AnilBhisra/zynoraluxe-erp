import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { getCompanyFySettings } from "@/lib/accounting/company";
import {
  getCashBankSummary,
  getGstSummary,
  getPartyBalances,
  getPartyLedger,
  getProfitAndLoss,
  listManualSalesWithoutLinkedCogs,
  listVouchers,
} from "@/lib/accounting/reports";
import { listAvailableFinishedJewelleryForSale, listFinishedJewellerySaleLines } from "@/lib/jewellery/reports";
import { resolveJewelleryAssetUrl } from "@/lib/storage/jewelleryMedia";
import type { SerializedFinishedStockRow } from "@/components/jewellery/FinishedStockTab";
import { PageHeader } from "@/components/ui/PageHeader";
import { HelpLink } from "@/components/help/HelpLink";
import { PartyForm } from "@/components/accounting/PartyForm";
import { PartyEditForm } from "@/components/accounting/PartyEditForm";
import { PartyList } from "@/components/accounting/PartyList";
import { TransactionsTab } from "@/components/accounting/TransactionsTab";
import { AccountingSettingsPanel } from "@/components/accounting/AccountingSettingsPanel";
import { LedgerPartyPicker, LedgerTable } from "@/components/accounting/LedgerView";
import {
  CashBankReportView,
  FinishedSalesReportView,
  GstSummaryView,
  OutstandingReportView,
  ProfitAndLossView,
  ReportsNav,
  VoucherReportView,
  type ReportKey,
} from "@/components/accounting/ReportsView";

export const metadata: Metadata = {
  title: "Accounting · ZYNORALUXE",
};

type SearchParams = {
  tab?: string;
  partySearch?: string;
  editPartyId?: string;
  partyId?: string;
  report?: string;
  dateFrom?: string;
  dateTo?: string;
  new?: string;
};

const TABS = ["transactions", "parties", "ledger", "reports"] as const;
type Tab = (typeof TABS)[number];

function TabLink({ tab, label, active }: { tab: Tab; label: string; active: boolean }) {
  return (
    <a
      href={`/accounting?tab=${tab}`}
      aria-current={active ? "page" : undefined}
      className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900"
          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      }`}
    >
      {label}
    </a>
  );
}

const NEW_PARAM_MAP: Record<string, "PURCHASE" | "SALE" | "PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "EXPENSE"> = {
  purchase: "PURCHASE",
  sale: "SALE",
  "payment-given": "PAYMENT_GIVEN",
  "payment-received": "PAYMENT_RECEIVED",
  expense: "EXPENSE",
};

function mapNewParam(
  value: string | undefined
): "PURCHASE" | "SALE" | "PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "EXPENSE" | undefined {
  if (!value) return undefined;
  return NEW_PARAM_MAP[value];
}

function startOfMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function AccountingPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : "transactions";

  return (
    <div>
      <PageHeader
        title="Accounting"
        description="Transactions, parties, ledger and reports."
        actions={<HelpLink anchor="accounting" />}
      />

      <nav aria-label="Accounting sections" className="mb-6 flex flex-wrap gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5">
        <TabLink tab="transactions" label="Transactions" active={tab === "transactions"} />
        <TabLink tab="parties" label="Parties" active={tab === "parties"} />
        <TabLink tab="ledger" label="Ledger" active={tab === "ledger"} />
        <TabLink tab="reports" label="Reports" active={tab === "reports"} />
      </nav>

      {tab === "transactions" ? (
        <TransactionsTabContent userRole={user.role} initialOpen={mapNewParam(params.new)} />
      ) : null}
      {tab === "parties" ? (
        <PartiesTabContent
          search={params.partySearch ?? ""}
          editPartyId={params.editPartyId ?? ""}
          userRole={user.role}
        />
      ) : null}
      {tab === "ledger" ? <LedgerTabContent partyId={params.partyId ?? ""} /> : null}
      {tab === "reports" ? (
        <ReportsTabContent
          report={(params.report as ReportKey) ?? "purchases"}
          dateFrom={params.dateFrom ?? startOfMonth()}
          dateTo={params.dateTo ?? today()}
          canSeeOwnerReports={user.role === "OWNER"}
        />
      ) : null}
    </div>
  );
}

async function TransactionsTabContent({
  userRole,
  initialOpen,
}: {
  userRole: "OWNER" | "STAFF";
  initialOpen?: "PURCHASE" | "SALE" | "PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "EXPENSE";
}) {
  const [parties, paymentAccounts, gstRates, fy, vouchers, availableFinishedRows] = await Promise.all([
    prisma.party.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    prisma.paymentAccount.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    prisma.gstRate.findMany({ where: { isActive: true }, orderBy: { ratePercent: "asc" } }),
    getCompanyFySettings(),
    listVouchers({ take: 50 }),
    listAvailableFinishedJewelleryForSale(),
  ]);

  const availableFinishedItems: SerializedFinishedStockRow[] = await Promise.all(
    availableFinishedRows.map(async (r) => ({
      id: r.id,
      finishedCode: r.finishedCode,
      jobCode: r.jobCode,
      designName: r.designName,
      karigarName: r.karigarName,
      jewelleryType: r.jewelleryType,
      metalType: r.metalType,
      purityDisplayName: r.purityDisplayName,
      netMetalWeight: r.netMetalWeight.toFixed(3),
      fineMetalWeight: r.fineMetalWeight.toFixed(3),
      grossWeight: r.grossWeight ? r.grossWeight.toFixed(3) : null,
      diamondCount: r.diamondCount,
      totalCarat: r.totalCarat.toFixed(3),
      status: r.status,
      producedAt: r.producedAt.toISOString(),
      photoUrl: await resolveJewelleryAssetUrl(r.photoAssetId),
      saleCode: r.saleCode,
      saleDate: r.saleDate ? r.saleDate.toISOString() : null,
    }))
  );

  return (
    <div className="flex flex-col gap-6">
      <TransactionsTab
        parties={parties.map((p) => ({ id: p.id, name: p.name, type: p.type, stateCode: p.stateCode }))}
        paymentAccounts={paymentAccounts.map((p) => ({ id: p.id, name: p.name, method: p.method }))}
        gstRates={gstRates.map((g) => ({ id: g.id, label: g.label, ratePercent: g.ratePercent.toString() }))}
        companyStateCode={fy.stateCode}
        vouchers={vouchers.map((v) => ({ ...v, amount: v.amount.toFixed(2) }))}
        canCancel={userRole === "OWNER"}
        initialOpen={initialOpen ?? null}
        availableFinishedItems={availableFinishedItems}
      />
      {userRole === "OWNER" ? (
        <AccountingSettingsPanel
          paymentAccounts={await prisma.paymentAccount.findMany({ orderBy: { name: "asc" } })}
          gstRates={(await prisma.gstRate.findMany({ orderBy: { ratePercent: "asc" } })).map((g) => ({
            id: g.id,
            label: g.label,
            ratePercent: g.ratePercent.toString(),
            isActive: g.isActive,
          }))}
        />
      ) : null}
    </div>
  );
}

async function PartiesTabContent({
  search,
  editPartyId,
  userRole,
}: {
  search: string;
  editPartyId: string;
  userRole: "OWNER" | "STAFF";
}) {
  const parties = await getPartyBalances({ search: search || undefined, includeInactive: true });

  const editingParty = editPartyId
    ? await prisma.party.findUnique({ where: { id: editPartyId } })
    : null;
  const editingVoucherCount = editingParty
    ? await prisma.voucher.count({ where: { partyId: editingParty.id } })
    : 0;

  // Staff cannot open the editor for an archived party at all — matches
  // the same rule enforced server-side in updateParty().
  const canEditThisParty =
    editingParty && (userRole === "OWNER" || editingParty.isActive);

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        {canEditThisParty ? (
          <>
            <h2 className="mb-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              Edit {editingParty.name}
            </h2>
            <PartyEditForm
              party={{
                id: editingParty.id,
                name: editingParty.name,
                type: editingParty.type,
                phone: editingParty.phone ?? "",
                email: editingParty.email ?? "",
                gstin: editingParty.gstin ?? "",
                address: editingParty.address ?? "",
                state: editingParty.state ?? "",
                stateCode: editingParty.stateCode ?? "",
                isActive: editingParty.isActive,
              }}
              role={userRole}
              voucherCount={editingVoucherCount}
            />
          </>
        ) : (
          <>
            <h2 className="mb-4 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
              Add a party
            </h2>
            <PartyForm />
          </>
        )}
      </div>

      <form method="GET" action="/accounting" className="flex gap-2">
        <input type="hidden" name="tab" value="parties" />
        <input
          type="text"
          name="partySearch"
          defaultValue={search}
          placeholder="Search parties by name…"
          className="h-11 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Search
        </button>
      </form>

      <PartyList parties={parties} search={search} role={userRole} />
    </div>
  );
}

async function LedgerTabContent({ partyId }: { partyId: string }) {
  const parties = await prisma.party.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const rows = partyId ? await getPartyLedger(partyId) : [];

  return (
    <div className="flex flex-col gap-6">
      <LedgerPartyPicker parties={parties} selectedPartyId={partyId} />
      {partyId ? (
        <LedgerTable rows={rows} />
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Choose a party to see their ledger.</p>
      )}
    </div>
  );
}

async function ReportsTabContent({
  report,
  dateFrom,
  dateTo,
  canSeeOwnerReports,
}: {
  report: ReportKey;
  dateFrom: string;
  dateTo: string;
  canSeeOwnerReports: boolean;
}) {
  const dateFromDate = new Date(`${dateFrom}T00:00:00.000Z`);
  const dateToDate = new Date(`${dateTo}T23:59:59.999Z`);

  return (
    <div className="flex flex-col gap-6">
      <ReportsNav active={report} dateFrom={dateFrom} dateTo={dateTo} />
      <ReportBody
        report={report}
        dateFrom={dateFromDate}
        dateTo={dateToDate}
        canSeeOwnerReports={canSeeOwnerReports}
      />
    </div>
  );
}

async function ReportBody({
  report,
  dateFrom,
  dateTo,
  canSeeOwnerReports,
}: {
  report: ReportKey;
  dateFrom: Date;
  dateTo: Date;
  canSeeOwnerReports: boolean;
}) {
  if (report === "purchases") {
    const vouchers = await listVouchers({ types: ["PURCHASE"], dateFrom, dateTo });
    return <VoucherReportView vouchers={vouchers} label="Purchases" filename="purchases.csv" />;
  }
  if (report === "sales") {
    const vouchers = await listVouchers({ types: ["SALE"], dateFrom, dateTo });
    return <VoucherReportView vouchers={vouchers} label="Sales" filename="sales.csv" />;
  }
  if (report === "expenses") {
    const vouchers = await listVouchers({ types: ["EXPENSE"], dateFrom, dateTo });
    return <VoucherReportView vouchers={vouchers} label="Expenses" filename="expenses.csv" />;
  }
  if (report === "cashbank") {
    const { cash, bank } = await getCashBankSummary();
    return <CashBankReportView cash={cash} bank={bank} />;
  }
  if (report === "outstanding") {
    const parties = await getPartyBalances({ includeInactive: false });
    const paymentAccounts = canSeeOwnerReports
      ? await prisma.paymentAccount.findMany({ where: { isActive: true }, orderBy: { name: "asc" } })
      : [];
    return (
      <OutstandingReportView
        parties={parties}
        isOwner={canSeeOwnerReports}
        paymentAccounts={paymentAccounts.map((p) => ({ id: p.id, name: p.name, method: p.method }))}
      />
    );
  }
  if (report === "gst") {
    if (!canSeeOwnerReports) {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Owner only.</p>;
    }
    const summary = await getGstSummary({ dateFrom, dateTo });
    return <GstSummaryView summary={summary} />;
  }
  if (report === "pnl") {
    if (!canSeeOwnerReports) {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Owner only.</p>;
    }
    const pnl = await getProfitAndLoss({ dateFrom, dateTo });
    return <ProfitAndLossView pnl={pnl} />;
  }
  if (report === "finishedSales") {
    if (!canSeeOwnerReports) {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Owner only.</p>;
    }
    const [lines, manualSales] = await Promise.all([
      listFinishedJewellerySaleLines({ dateFrom, dateTo }),
      listManualSalesWithoutLinkedCogs({ dateFrom, dateTo }),
    ]);
    return <FinishedSalesReportView lines={lines} manualSales={manualSales} />;
  }
  return null;
}
