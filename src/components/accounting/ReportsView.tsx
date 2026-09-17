import Link from "next/link";

import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { CsvDownloadButton } from "@/components/accounting/CsvDownloadButton";
import { CustomerRefundForm } from "@/components/accounting/CustomerRefundForm";
import { useFieldId } from "@/lib/utils/useFieldId";
import type {
  GstSummary,
  PartyBalanceRow,
  ProfitAndLoss,
  VoucherListRow,
} from "@/lib/accounting/reports";
import type { FinishedJewellerySaleLineReportRow } from "@/lib/jewellery/reports";

export type ReportKey =
  | "purchases"
  | "sales"
  | "expenses"
  | "cashbank"
  | "outstanding"
  | "gst"
  | "pnl"
  | "finishedSales";

const REPORT_LABELS: Record<ReportKey, string> = {
  purchases: "Purchase report",
  sales: "Sales report",
  expenses: "Expense report",
  cashbank: "Cash/Bank report",
  outstanding: "Receivable & Payable",
  gst: "GST summary",
  pnl: "Profit and Loss",
  finishedSales: "Finished Sales & Profit",
};

function money(value: { toFixed: (n: number) => string }) {
  return `₹${Number(value.toFixed(2)).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function ReportsNav({
  active,
  dateFrom,
  dateTo,
}: {
  active: ReportKey;
  dateFrom: string;
  dateTo: string;
}) {
  const dateFromId = useFieldId();
  const dateToId = useFieldId();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {(Object.keys(REPORT_LABELS) as ReportKey[]).map((key) => (
          <Link
            key={key}
            href={`/accounting?tab=reports&report=${key}&dateFrom=${dateFrom}&dateTo=${dateTo}`}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              active === key
                ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900"
                : "border border-[var(--border)] text-zinc-600 hover:bg-zinc-50 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {REPORT_LABELS[key]}
          </Link>
        ))}
      </div>
      <form method="GET" action="/accounting" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="tab" value="reports" />
        <input type="hidden" name="report" value={active} />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={dateFromId} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            From
          </label>
          <input
            id={dateFromId}
            type="date"
            name="dateFrom"
            defaultValue={dateFrom}
            className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={dateToId} className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            To
          </label>
          <input
            id={dateToId}
            type="date"
            name="dateTo"
            defaultValue={dateTo}
            className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          />
        </div>
        <button
          type="submit"
          className="h-10 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Apply
        </button>
      </form>
    </div>
  );
}

export function VoucherReportView({
  vouchers,
  label,
  filename,
}: {
  vouchers: VoucherListRow[];
  label: string;
  filename: string;
}) {
  const total = vouchers.reduce((sum, v) => sum + v.amount.toNumber(), 0);

  if (vouchers.length === 0) {
    return <EmptyState title={`No ${label.toLowerCase()} in this range`} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {vouchers.length} entries — total {money({ toFixed: (n) => total.toFixed(n) })}
        </p>
        <CsvDownloadButton
          filename={filename}
          headers={["Voucher", "Date", "Party", "Amount", "Status"]}
          rows={vouchers.map((v) => [
            v.voucherNumber,
            v.date.toISOString().slice(0, 10),
            v.partyName ?? "",
            v.amount.toFixed(2),
            v.status,
          ])}
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[480px] text-sm">
          <thead className="bg-[var(--surface-muted)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3">Voucher</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Party</th>
              <th className="px-4 py-3 text-right">Amount</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {vouchers.map((v) => (
              <tr key={v.id}>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{v.voucherNumber}</td>
                <td className="whitespace-nowrap px-4 py-3 text-zinc-700 dark:text-zinc-300">
                  {v.date.toISOString().slice(0, 10)}
                </td>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{v.partyName ?? "—"}</td>
                <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-50">
                  {money(v.amount)}
                </td>
                <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{v.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function CashBankReportView({
  cash,
  bank,
}: {
  cash: { toFixed: (n: number) => string };
  bank: { toFixed: (n: number) => string };
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Cash balance</CardTitle>
          <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{money(cash)}</p>
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Bank balance</CardTitle>
          <p className="mt-2 text-2xl font-semibold text-zinc-900 dark:text-zinc-50">{money(bank)}</p>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Includes Bank, UPI and Other accounts.</p>
        </CardHeader>
      </Card>
    </div>
  );
}

export function OutstandingReportView({
  parties,
  isOwner,
  paymentAccounts,
}: {
  parties: PartyBalanceRow[];
  isOwner?: boolean;
  paymentAccounts?: { id: string; name: string; method: string }[];
}) {
  const withBalance = parties.filter((p) => p.balance.toNumber() !== 0);
  const totalReceivable = withBalance
    .filter((p) => p.balance.toNumber() > 0)
    .reduce((sum, p) => sum + p.balance.toNumber(), 0);
  const totalPayable = withBalance
    .filter((p) => p.balance.toNumber() < 0)
    .reduce((sum, p) => sum + Math.abs(p.balance.toNumber()), 0);

  if (withBalance.length === 0) {
    return <EmptyState title="Nothing outstanding" description="Every party is settled." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Total receivable {money({ toFixed: (n) => totalReceivable.toFixed(n) })} · Total payable{" "}
          {money({ toFixed: (n) => totalPayable.toFixed(n) })}
        </p>
        <CsvDownloadButton
          filename="outstanding.csv"
          headers={["Party", "Type", "Balance", "Direction"]}
          rows={withBalance.map((p) => [
            p.name,
            p.type,
            Math.abs(p.balance.toNumber()).toFixed(2),
            p.balance.toNumber() > 0 ? "Receivable" : "Payable",
          ])}
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[420px] text-sm">
          <thead className="bg-[var(--surface-muted)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
            <tr>
              <th className="px-4 py-3">Party</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3 text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {withBalance.map((p) => (
              <tr key={p.partyId}>
                <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{p.name}</td>
                <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{p.type}</td>
                <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-50">
                  {money({ toFixed: (n) => Math.abs(p.balance.toNumber()).toFixed(n) })}{" "}
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">
                    ({p.balance.toNumber() > 0 ? "owes us" : "we owe"})
                  </span>
                  {isOwner && p.type === "CUSTOMER" && p.balance.toNumber() < 0 ? (
                    <div className="mt-1">
                      <CustomerRefundForm
                        partyId={p.partyId}
                        availableCredit={Math.abs(p.balance.toNumber())}
                        paymentAccounts={paymentAccounts ?? []}
                      />
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function GstSummaryView({ summary }: { summary: GstSummary }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Input GST (on purchases)</CardTitle>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><dt>CGST</dt><dd>{money(summary.inputCgst)}</dd></div>
              <div className="flex justify-between"><dt>SGST</dt><dd>{money(summary.inputSgst)}</dd></div>
              <div className="flex justify-between"><dt>IGST</dt><dd>{money(summary.inputIgst)}</dd></div>
            </dl>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Output GST (on sales)</CardTitle>
            <dl className="mt-3 space-y-1 text-sm">
              <div className="flex justify-between"><dt>CGST</dt><dd>{money(summary.outputCgst)}</dd></div>
              <div className="flex justify-between"><dt>SGST</dt><dd>{money(summary.outputSgst)}</dd></div>
              <div className="flex justify-between"><dt>IGST</dt><dd>{money(summary.outputIgst)}</dd></div>
            </dl>
          </CardHeader>
        </Card>
      </div>
      <div className="rounded-xl bg-zinc-900 px-4 py-3 text-white dark:bg-amber-200 dark:text-zinc-900">
        <div className="flex items-center justify-between">
          <span className="text-sm">Net GST payable (Output − Input)</span>
          <span className="text-lg font-semibold">{money(summary.netPayable)}</span>
        </div>
      </div>
    </div>
  );
}

export function FinishedSalesReportView({
  lines,
  manualSales,
}: {
  lines: FinishedJewellerySaleLineReportRow[];
  manualSales: VoucherListRow[];
}) {
  if (lines.length === 0 && manualSales.length === 0) {
    return <EmptyState title="No sales in this period" description="Finished Jewellery and manual sales will appear here." />;
  }
  // A cancelled sale reverses its revenue AND its COGS in full; a returned
  // line (sellable or damaged) likewise reverses the original sale's
  // revenue, with its cost either returned to inventory or reclassified as
  // Damaged Jewellery Loss (never left standing as this sale's COGS) — see
  // cancelFinishedJewellerySale / returnFinishedJewelleryItems. So neither
  // kind of row still contributes real, realized profit; only ACTIVE lines
  // (still-posted sale, not returned) are summed into the totals below —
  // otherwise a cancelled/returned row's frozen historical figures would
  // read as still-standing profit, which the Profit and Loss report (a
  // ledger-based, reversal-aware source of truth) already correctly excludes.
  const activeLines = lines.filter((l) => l.saleStatus !== "CANCELLED" && l.returnStatus === "NONE");
  const reversedLinesCount = lines.length - activeLines.length;
  const totalTaxable = activeLines.reduce((sum, l) => sum + l.taxableValue.toNumber(), 0);
  const totalCogs = activeLines.reduce((sum, l) => sum + l.cogsAmount.toNumber(), 0);
  const totalProfit = activeLines.reduce((sum, l) => sum + l.grossProfit.toNumber(), 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Sales {money({ toFixed: (n) => totalTaxable.toFixed(n) })} · COGS{" "}
          {money({ toFixed: (n) => totalCogs.toFixed(n) })} · Gross profit{" "}
          {money({ toFixed: (n) => totalProfit.toFixed(n) })}
          {reversedLinesCount > 0 ? (
            <span className="ml-1 text-xs text-zinc-400 dark:text-zinc-500">
              ({reversedLinesCount} cancelled/returned line{reversedLinesCount === 1 ? "" : "s"} excluded — reversed, no realized profit)
            </span>
          ) : null}
        </p>
        <CsvDownloadButton
          filename="finished-sales-profit.csv"
          headers={["Sale", "Status", "Date", "Customer", "Item", "Taxable value", "COGS", "Gross profit", "Return status"]}
          rows={lines.map((l) => [
            l.saleCode,
            l.saleStatus,
            l.saleDate.toISOString().slice(0, 10),
            l.customerName,
            `${l.finishedCode} — ${l.itemDescription}`,
            l.taxableValue.toFixed(2),
            l.cogsAmount.toFixed(2),
            l.grossProfit.toFixed(2),
            l.returnStatus,
          ])}
        />
      </div>
      {lines.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-[var(--surface-muted)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="px-4 py-3">Sale</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3 text-right">Taxable</th>
                <th className="px-4 py-3 text-right">COGS</th>
                <th className="px-4 py-3 text-right">Gross profit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
              {lines.map((l, i) => (
                <tr key={`${l.saleId}-${i}`}>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                    {l.saleCode}
                    {l.saleStatus === "CANCELLED" ? (
                      <span className="ml-1 text-xs text-red-600 dark:text-red-400">(cancelled)</span>
                    ) : null}
                    {l.returnStatus !== "NONE" ? (
                      <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                        ({l.returnStatus === "RETURNED_SELLABLE" ? "returned" : "returned — damaged"})
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">
                    {l.saleDate.toLocaleDateString("en-IN")}
                  </td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{l.customerName}</td>
                  <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                    {l.finishedCode} — {l.itemDescription}
                  </td>
                  <td className="px-4 py-3 text-right">{money({ toFixed: (n) => l.taxableValue.toFixed(n) })}</td>
                  <td className="px-4 py-3 text-right">{money({ toFixed: (n) => l.cogsAmount.toFixed(n) })}</td>
                  <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-50">
                    {l.saleStatus === "CANCELLED" || l.returnStatus !== "NONE" ? (
                      <span className="font-normal text-zinc-400 dark:text-zinc-500" title="Reversed — revenue and cost both reversed, no realized profit">
                        —
                      </span>
                    ) : (
                      money({ toFixed: (n) => l.grossProfit.toFixed(n) })
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {manualSales.length > 0 ? (
        <div>
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            {manualSales.length} &quot;Other / Accounting-only&quot; sale{manualSales.length === 1 ? "" : "s"} in this
            period — no linked Finished Jewellery stock or COGS, so they are not included in the gross profit above.
          </div>
          <div className="mt-3 overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="bg-[var(--surface-muted)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="px-4 py-3">Voucher</th>
                  <th className="px-4 py-3">Date</th>
                  <th className="px-4 py-3">Party</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
                {manualSales.map((v) => (
                  <tr key={v.id}>
                    <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{v.voucherNumber}</td>
                    <td className="px-4 py-3 text-zinc-500 dark:text-zinc-400">{v.date.toLocaleDateString("en-IN")}</td>
                    <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">{v.partyName ?? "—"}</td>
                    <td className="px-4 py-3 text-right">{money({ toFixed: (n) => v.amount.toFixed(n) })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ProfitAndLossView({ pnl }: { pnl: ProfitAndLoss }) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="flex justify-between px-4 py-3 text-sm">
          <dt className="text-zinc-600 dark:text-zinc-400">Gross sales</dt>
          <dd className="font-medium text-zinc-900 dark:text-zinc-50">{money(pnl.grossSales)}</dd>
        </div>
        <div className="flex justify-between px-4 py-3 text-sm">
          <dt className="text-zinc-600 dark:text-zinc-400">Sales returns</dt>
          <dd className="font-medium text-zinc-900 dark:text-zinc-50">− {money(pnl.salesReturns)}</dd>
        </div>
        <div className="flex justify-between px-4 py-3 text-sm">
          <dt className="font-semibold text-zinc-900 dark:text-zinc-50">Net sales</dt>
          <dd className="font-semibold text-zinc-900 dark:text-zinc-50">{money(pnl.netSales)}</dd>
        </div>
        <div className="flex justify-between px-4 py-3 text-sm">
          <dt className="text-zinc-600 dark:text-zinc-400">Finished jewellery COGS</dt>
          <dd className="font-medium text-zinc-900 dark:text-zinc-50">
            − {money(pnl.finishedJewelleryCogs)}
          </dd>
        </div>
        <div className="flex justify-between px-4 py-3 text-sm">
          <dt className="font-semibold text-zinc-900 dark:text-zinc-50">Gross profit</dt>
          <dd className="font-semibold text-zinc-900 dark:text-zinc-50">
            {money(pnl.grossProfit)}{" "}
            <span className="font-normal text-zinc-500 dark:text-zinc-400">
              ({pnl.grossMarginPercent.toFixed(2)}% margin)
            </span>
          </dd>
        </div>
        <div className="flex justify-between px-4 py-3 text-sm">
          <dt className="text-zinc-600 dark:text-zinc-400">Damaged jewellery loss</dt>
          <dd className="font-medium text-zinc-900 dark:text-zinc-50">
            − {money(pnl.damagedJewelleryLoss)}
          </dd>
        </div>
        <div className="flex justify-between px-4 py-3 text-sm">
          <dt className="text-zinc-600 dark:text-zinc-400">Other purchases</dt>
          <dd className="font-medium text-zinc-900 dark:text-zinc-50">− {money(pnl.purchases)}</dd>
        </div>
        <div className="flex justify-between px-4 py-3 text-sm">
          <dt className="text-zinc-600 dark:text-zinc-400">Business expenses</dt>
          <dd className="font-medium text-zinc-900 dark:text-zinc-50">
            − {money(pnl.businessExpenses)}
          </dd>
        </div>
        {pnl.otherExpenses.map((e) => (
          <div key={e.code} className="flex justify-between px-4 py-3 text-sm">
            <dt className="text-zinc-600 dark:text-zinc-400">{e.name}</dt>
            <dd className="font-medium text-zinc-900 dark:text-zinc-50">− {money(e.amount)}</dd>
          </div>
        ))}
        <div className="flex justify-between px-4 py-3 text-sm">
          <dt className="font-semibold text-zinc-900 dark:text-zinc-50">Net profit</dt>
          <dd className="font-semibold text-zinc-900 dark:text-zinc-50">{money(pnl.netProfit)}</dd>
        </div>
      </dl>
      {pnl.manualSalesAmount.greaterThan(0) ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          <strong>{money(pnl.manualSalesAmount)}</strong> of gross sales ({pnl.manualSalesCount}{" "}
          voucher{pnl.manualSalesCount === 1 ? "" : "s"}) came from &quot;Other / Accounting-only&quot; Sales
          with no linked finished-jewellery stock or COGS. Gross profit and margin above do not
          account for the cost of those sales — treat them as an incomplete picture of
          whole-business margin whenever this note appears.
        </div>
      ) : null}
    </div>
  );
}
