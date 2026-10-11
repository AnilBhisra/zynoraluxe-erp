import type { Metadata } from "next";

import { requireOwner } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { getCashBookAccounts, getCashBookSummary, listCashBookRows } from "@/lib/accounting/cashBankBook";
import { cashBookQuery, defaultCashBookDates, hasRowFilters, parseCashBookFilters } from "@/lib/accounting/cashBankBookFilters";
import { formatRupees } from "@/lib/accounting/partyBalance";
import { accountLabel, rowTypeLabel } from "@/components/accounting/CashBankBookView";
import { CustomerGoldPrintShell } from "@/components/jewellery/CustomerGoldPrint";

export const metadata: Metadata = { title: "Cash & Bank Book · ZYNORALUXE" };

const money = (d: { toFixed: (n: number) => string }) => formatRupees(d.toFixed(2));

/** Printable Cash & Bank Book — every row the screen's filters keep, all pages. Owner only. */
export default async function CashBankBookPrintPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const filters = parseCashBookFilters(await searchParams, defaultCashBookDates(await getCompanyFySettings()));
  const [accounts, summary, rows, company] = await Promise.all([
    getCashBookAccounts(),
    getCashBookSummary(filters),
    listCashBookRows(filters, { limit: null }),
    prisma.companySettings.findUnique({ where: { id: "default" } }),
  ]);
  const account = accounts.find((a) => a.id === filters.account);
  return (
    <CustomerGoldPrintShell backHref={`/accounting?tab=cash-bank&${cashBookQuery(filters, { page: 1 })}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 pb-3">
        <h1 className="text-lg font-bold">{company?.companyName || "ZYNORALUXE"}</h1>
        <div className="text-right text-sm">
          <p className="font-semibold">Cash &amp; Bank Book</p>
          <p>{account ? accountLabel(account) : "All payment accounts"}</p>
          <p>
            {filters.dateFrom} to {filters.dateTo}
          </p>
        </div>
      </div>
      <table className="mt-3 w-full text-xs" data-testid="print-summary">
        <tbody>
          <tr><td>Opening balance</td><td className="text-right">{money(summary.opening)}</td><td>Money received</td><td className="text-right">{money(summary.periodReceived)}</td></tr>
          <tr><td>Money paid</td><td className="text-right">{money(summary.periodPaid)}</td><td>Closing balance</td><td className="text-right">{money(summary.closing)}</td></tr>
        </tbody>
      </table>
      {hasRowFilters(filters) ? (
        <p className="mt-1 text-[11px]">Filtered: {rows.length} rows, received {money(summary.shownReceived)}, paid {money(summary.shownPaid)}.</p>
      ) : null}
      <table className="mt-3 w-full text-[11px]" data-testid="print-rows">
        <thead>
          <tr className="border-b text-left">
            <th>Date</th><th>Voucher</th><th>Type</th><th>Party</th><th>Account</th><th className="text-right">Received</th><th className="text-right">Paid</th><th className="text-right">Balance</th><th>Link</th>
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-zinc-200 [&_td]:py-0.5 [&_td]:align-top">
          {rows.map((r) => (
            <tr key={r.lineId}>
              <td>{r.businessDate}</td>
              <td>{r.voucherNumber}</td>
              <td>{rowTypeLabel(r)}{r.status === "CANCELLED" ? " (cancelled)" : ""}</td>
              <td>{r.partyName ?? "—"}</td>
              <td>{r.paymentAccountName}</td>
              <td className="text-right">{r.received.greaterThan(0) ? money(r.received) : ""}</td>
              <td className="text-right">{r.paid.greaterThan(0) ? money(r.paid) : ""}</td>
              <td className="text-right">{money(r.runningBalance)}</td>
              <td>{r.reversesNumber ? `reverses ${r.reversesNumber}` : r.reversedByNumber ? `reversed by ${r.reversedByNumber}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </CustomerGoldPrintShell>
  );
}
