import type { Metadata } from "next";

import { requireOwner } from "@/lib/auth/dal";
import { formatRupees } from "@/lib/accounting/partyBalance";
import { getVoucherDetail } from "@/lib/accounting/voucherDetail";
import { VOUCHER_TYPE_LABELS } from "@/lib/accounting/voucherTypeLabels";
import { PageHeader } from "@/components/ui/PageHeader";
import { partyTypeLabel } from "@/lib/parties/types";

export const metadata: Metadata = { title: "Voucher · ZYNORALUXE" };

const money = (d: { toFixed: (n: number) => string }) => formatRupees(d.toFixed(2));

/** One voucher: header, every journal line, reversal links, the record behind it. Owner only (journal lines carry cost). */
export default async function VoucherPage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const v = await getVoucherDetail(id);
  if (!v) return <p className="text-sm text-zinc-500">Voucher not found.</p>;
  const dr = v.lines.reduce((s, l) => s.plus(l.debit), v.amount.minus(v.amount));
  const cr = v.lines.reduce((s, l) => s.plus(l.credit), v.amount.minus(v.amount));
  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="voucher-detail">
      <PageHeader
        title={v.voucherNumber}
        description={`${v.reverses ? `Reversal of ${VOUCHER_TYPE_LABELS[v.reverses.voucherType]}` : VOUCHER_TYPE_LABELS[v.voucherType]} · ${v.date} · FY ${v.financialYearLabel}`}
      />
      <dl className="grid grid-cols-1 gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm sm:grid-cols-2">
        <div><dt className="inline text-zinc-500">Status: </dt><dd className="inline font-medium" data-testid="voucher-status">{v.status === "CANCELLED" ? "Cancelled" : "Posted"}</dd></div>
        <div><dt className="inline text-zinc-500">Amount: </dt><dd className="inline font-medium">{money(v.amount)}</dd></div>
        <div>
          <dt className="inline text-zinc-500">Party: </dt>
          <dd className="inline">
            {v.party ? (
              <a className="underline" href={`/accounting?tab=ledger&partyId=${v.party.id}`}>
                {v.party.name}
              </a>
            ) : (
              "—"
            )}
            {v.party ? ` (${partyTypeLabel(v.party.type)})` : ""}
          </dd>
        </div>
        <div><dt className="inline text-zinc-500">Payment account: </dt><dd className="inline">{v.paymentAccount?.name ?? "—"}</dd></div>
        <div><dt className="inline text-zinc-500">Reference: </dt><dd className="inline">{v.referenceNumber ?? "—"}</dd></div>
        <div><dt className="inline text-zinc-500">Note: </dt><dd className="inline break-words">{v.note ?? "—"}</dd></div>
        <div><dt className="inline text-zinc-500">Entered by: </dt><dd className="inline">{v.createdBy}</dd></div>
        {v.reverses ? (
          <div>
            <dt className="inline text-zinc-500">Reverses: </dt>
            <dd className="inline"><a className="underline" href={`/accounting/voucher/${v.reverses.id}`} data-testid="voucher-reverses">{v.reverses.voucherNumber}</a></dd>
          </div>
        ) : null}
        {v.reversedBy ? (
          <div>
            <dt className="inline text-zinc-500">Reversed by: </dt>
            <dd className="inline">
              <a className="underline" href={`/accounting/voucher/${v.reversedBy.id}`} data-testid="voucher-reversed-by">{v.reversedBy.voucherNumber}</a>
              {v.cancellationReason ? ` — “${v.cancellationReason}”` : ""}
            </dd>
          </div>
        ) : null}
        {v.related.map((r) => (
          <div key={r.code}>
            <dt className="inline text-zinc-500">{r.label}: </dt>
            <dd className="inline" data-testid="voucher-related">{r.href ? <a className="underline" href={r.href}>{r.code}</a> : r.code}</dd>
          </div>
        ))}
      </dl>
      <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
        <table className="w-full min-w-[560px] text-sm" data-testid="voucher-lines">
          <thead className="bg-[var(--surface-muted)] text-left text-xs text-zinc-500">
            <tr><th className="px-3 py-2">Account</th><th className="px-3 py-2">Party</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Debit</th><th className="px-3 py-2 text-right">Credit</th></tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
            {v.lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2">{l.accountCode} {l.accountName}</td>
                <td className="px-3 py-2">{l.partyName ?? ""}</td>
                <td className="px-3 py-2 text-xs">{l.description ?? ""}</td>
                <td className="px-3 py-2 text-right">{l.debit.greaterThan(0) ? money(l.debit) : ""}</td>
                <td className="px-3 py-2 text-right">{l.credit.greaterThan(0) ? money(l.credit) : ""}</td>
              </tr>
            ))}
            <tr className="font-medium"><td className="px-3 py-2" colSpan={3}>Total {dr.equals(cr) ? "(balanced)" : "(NOT BALANCED)"}</td><td className="px-3 py-2 text-right">{money(dr)}</td><td className="px-3 py-2 text-right">{money(cr)}</td></tr>
          </tbody>
        </table>
      </div>
      <p className="flex flex-wrap gap-3 text-sm">
        <a className="underline" href="/accounting?tab=cash-bank">← Cash &amp; Bank Book</a>
        {v.party ? <a className="underline" href={`/accounting?tab=cash-bank&partyId=${v.party.id}`}>This party&apos;s Cash &amp; Bank entries</a> : null}
      </p>
    </div>
  );
}
