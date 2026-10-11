import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { indiaToday } from "@/lib/accounting/financialYear";
import { ZERO } from "@/lib/accounting/money";
import { getCashBookPage } from "@/lib/accounting/cashBankBook";
import { defaultCashBookDates, parseCashBookFilters } from "@/lib/accounting/cashBankBookFilters";
import { getReceivablePayableBook } from "@/lib/accounting/receivablePayable";
import {
  getCashBankSummary,
  getGstSummary,
  getPartyBalances,
  getPartyLedger,
  getPaymentAccountBalances,
  getProfitAndLoss,
  listManualSalesWithoutLinkedCogs,
  listVouchers,
  partyNetBalances,
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
import { CashBankBookView } from "@/components/accounting/CashBankBookView";
import { PartySummaryPanel } from "@/components/accounting/PartySummaryPanel";
import { ReceivablePayableView } from "@/components/accounting/ReceivablePayableView";
import {
  CashBankReportView,
  FinishedSalesReportView,
  GstSummaryView,
  ProfitAndLossView,
  ReportsNav,
  VoucherReportView,
  type ReportKey,
} from "@/components/accounting/ReportsView";

export const metadata: Metadata = {
  title: "Accounting · ZYNORALUXE",
};

type SearchParams = Record<string, string | string[] | undefined> & {
  tab?: string;
  partySearch?: string;
  editPartyId?: string;
  partyId?: string;
  report?: string;
  dateFrom?: string;
  dateTo?: string;
  new?: string;
};

const TABS = ["transactions", "parties", "ledger", "cash-bank", "receivables", "reports"] as const;
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

// Indian calendar dates: before 05:30 IST the UTC date is still yesterday.
function startOfMonth(): string {
  return `${indiaToday().slice(0, 7)}-01`;
}
function today(): string {
  return indiaToday();
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
        {user.role === "OWNER" ? <TabLink tab="cash-bank" label="Cash & Bank Book" active={tab === "cash-bank"} /> : null}
        <TabLink tab="receivables" label="લેવાનું / આપવાનું" active={tab === "receivables"} />
        <TabLink tab="reports" label="Reports" active={tab === "reports"} />
      </nav>

      {tab === "transactions" ? (
        <TransactionsTabContent userRole={user.role} initialOpen={mapNewParam(typeof params.new === "string" ? params.new : undefined)} />
      ) : null}
      {tab === "parties" ? (
        <PartiesTabContent
          search={typeof params.partySearch === "string" ? params.partySearch : ""}
          editPartyId={typeof params.editPartyId === "string" ? params.editPartyId : ""}
          userRole={user.role}
        />
      ) : null}
      {tab === "ledger" ? <LedgerTabContent partyId={typeof params.partyId === "string" ? params.partyId : ""} userRole={user.role} /> : null}
      {tab === "cash-bank" ? (
        // Owner only, decided on the server before any Cash/Bank row is read.
        user.role === "OWNER" ? (
          <CashBankBookTabContent params={params} />
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">Owner only.</p>
        )
      ) : null}
      {tab === "receivables" ? <ReceivablesTabContent isOwner={user.role === "OWNER"} /> : null}
      {tab === "reports" ? (
        <ReportsTabContent
          report={(params.report as ReportKey) ?? "purchases"}
          dateFrom={typeof params.dateFrom === "string" ? params.dateFrom : startOfMonth()}
          dateTo={typeof params.dateTo === "string" ? params.dateTo : today()}
          canSeeOwnerReports={user.role === "OWNER"}
          viewerRole={user.role}
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
  const isOwner = userRole === "OWNER";
  const [parties, partyBalances, paymentAccounts, gstRates, fy, vouchers, availableFinishedRows] = await Promise.all([
    prisma.party.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    // The same party balances the Parties tab already shows both roles.
    partyNetBalances(),
    // Per-account money stays Owner-only: Staff get the account list without balances.
    isOwner
      ? getPaymentAccountBalances().then((rows) => rows.filter((r) => r.isActive))
      : prisma.paymentAccount.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    prisma.gstRate.findMany({ where: { isActive: true }, orderBy: { ratePercent: "asc" } }),
    getCompanyFySettings(),
    listVouchers({ take: 50, viewerRole: userRole }),
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
        parties={parties.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          stateCode: p.stateCode,
          balance: (partyBalances.get(p.id) ?? ZERO).toFixed(2),
        }))}
        paymentAccounts={paymentAccounts.map((p) => ({
          id: p.id,
          name: p.name,
          method: p.method,
          balance: isOwner && "balance" in p ? p.balance.toFixed(2) : null,
        }))}
        gstRates={gstRates.map((g) => ({ id: g.id, label: g.label, ratePercent: g.ratePercent.toString() }))}
        companyStateCode={fy.stateCode}
        vouchers={vouchers.map((v) => ({ ...v, amount: v.amount.toFixed(2) }))}
        canCancel={userRole === "OWNER"}
        showsInternalVouchers={userRole === "OWNER"}
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

async function LedgerTabContent({ partyId, userRole }: { partyId: string; userRole: "OWNER" | "STAFF" }) {
  const parties = await prisma.party.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const [rows, party, book, recentVouchers] = partyId
    ? await Promise.all([
        getPartyLedger(partyId),
        prisma.party.findUnique({ where: { id: partyId }, select: { id: true, name: true, type: true } }),
        getReceivablePayableBook({ partyId }),
        // The same visibility as the Transactions list: Staff never load internal costing vouchers.
        listVouchers({ partyId, viewerRole: userRole, take: 30 }),
      ])
    : [[], null, null, []];

  return (
    <div className="flex flex-col gap-6">
      <LedgerPartyPicker parties={parties} selectedPartyId={partyId} />
      {partyId && party ? (
        <>
          <PartySummaryPanel party={party} position={book?.parties[0] ?? null} recentVouchers={recentVouchers} isOwner={userRole === "OWNER"} />
          <LedgerTable rows={rows} partyType={party.type} />
        </>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Choose a party to see their ledger.</p>
      )}
    </div>
  );
}

/** Owner only — the caller checks the role before rendering this. */
async function CashBankBookTabContent({ params }: { params: SearchParams }) {
  const filters = parseCashBookFilters(params, defaultCashBookDates(await getCompanyFySettings()));
  const data = await getCashBookPage(filters);
  return <CashBankBookView filters={filters} data={data} />;
}

async function ReceivablesTabContent({ isOwner }: { isOwner: boolean }) {
  const [book, paymentAccounts] = await Promise.all([
    getReceivablePayableBook(),
    isOwner ? prisma.paymentAccount.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
  ]);
  return (
    <ReceivablePayableView
      book={book}
      isOwner={isOwner}
      paymentAccounts={paymentAccounts.map((p) => ({ id: p.id, name: p.name, method: p.method }))}
    />
  );
}

async function ReportsTabContent({
  report,
  dateFrom,
  dateTo,
  canSeeOwnerReports,
  viewerRole,
}: {
  report: ReportKey;
  dateFrom: string;
  dateTo: string;
  canSeeOwnerReports: boolean;
  viewerRole: "OWNER" | "STAFF";
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
        viewerRole={viewerRole}
      />
    </div>
  );
}

async function ReportBody({
  report,
  dateFrom,
  dateTo,
  canSeeOwnerReports,
  viewerRole,
}: {
  report: ReportKey;
  dateFrom: Date;
  dateTo: Date;
  canSeeOwnerReports: boolean;
  viewerRole: "OWNER" | "STAFF";
}) {
  if (report === "purchases") {
    const vouchers = await listVouchers({ types: ["PURCHASE"], dateFrom, dateTo, viewerRole });
    return <VoucherReportView vouchers={vouchers} label="Purchases" filename="purchases.csv" />;
  }
  if (report === "sales") {
    const vouchers = await listVouchers({ types: ["SALE"], dateFrom, dateTo, viewerRole });
    return <VoucherReportView vouchers={vouchers} label="Sales" filename="sales.csv" />;
  }
  if (report === "expenses") {
    const vouchers = await listVouchers({ types: ["EXPENSE"], dateFrom, dateTo, viewerRole });
    return <VoucherReportView vouchers={vouchers} label="Expenses" filename="expenses.csv" />;
  }
  if (report === "cashbank") {
    const [{ cash, bank }, accounts] = await Promise.all([
      getCashBankSummary(),
      // Per-account balances are Owner-only (Staff keep the two totals they always had).
      canSeeOwnerReports ? getPaymentAccountBalances() : Promise.resolve(undefined),
    ]);
    return <CashBankReportView cash={cash} bank={bank} accounts={accounts} />;
  }
  if (report === "outstanding") {
    // The same party-level Receivable & Payable view as its own tab (one source of figures).
    return <ReceivablesTabContent isOwner={canSeeOwnerReports} />;
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
