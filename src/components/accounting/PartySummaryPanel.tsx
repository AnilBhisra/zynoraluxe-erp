import { formatRupees } from "@/lib/accounting/partyBalance";
import type { PartyPosition } from "@/lib/accounting/receivablePayable";
import type { VoucherListRow } from "@/lib/accounting/reports";
import { VOUCHER_TYPE_LABELS } from "@/lib/accounting/voucherTypeLabels";
import { partyTypeLabel, type PartyTypeValue } from "@/lib/parties/types";

const money = (d: { toFixed: (n: number) => string }) => formatRupees(d.toFixed(2));

function Figure({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 break-words text-base font-semibold" data-testid={testId}>
        {value}
      </p>
    </div>
  );
}

/** Party page header: both sides, advances, net, last payments and quick links. Everything here Staff already see in the ledger. */
export function PartySummaryPanel({
  party,
  position,
  recentVouchers,
  isOwner,
}: {
  party: { id: string; name: string; type: PartyTypeValue };
  position: PartyPosition | null;
  recentVouchers: VoucherListRow[];
  isOwner: boolean;
}) {
  const zero = { toFixed: () => "0.00" };
  const r = position?.receivableSide;
  const p = position?.payableSide;
  const links: { href: string; label: string }[] = [{ href: `/accounting?tab=ledger&partyId=${party.id}`, label: "Party ledger" }];
  if (isOwner) links.push({ href: `/accounting?tab=cash-bank&partyId=${party.id}`, label: "Cash & Bank entries" });
  if (party.type === "CUSTOMER") links.push({ href: `/jewellery-jobs?tab=customer-gold&customerId=${party.id}`, label: "Customer Gold" });
  if (party.type === "KARIGAR") links.push({ href: `/jewellery-jobs?tab=karigar&karigarId=${party.id}`, label: "Karigar Metal account" });
  links.push({ href: `/accounting?tab=receivables`, label: "Receivable & Payable" });
  const lr = position?.lastReceived;
  const lp = position?.lastPaid;
  return (
    <section aria-label={`${party.name} summary`} className="flex min-w-0 flex-col gap-3" data-testid="party-summary">
      <h2 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
        {party.name} <span className="font-normal text-zinc-500">· {partyTypeLabel(party.type)}</span>
      </h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Figure label="લેવાનું / Receivable now" value={money(r && r.greaterThan(0) ? r : zero)} testId="party-receivable" />
        <Figure label="આપવાનું / Payable now" value={money(p && p.greaterThan(0) ? p : zero)} testId="party-payable" />
        <Figure label="Advance paid" value={money(p && p.lessThan(0) ? p.abs() : zero)} testId="party-advance" />
        <Figure label="Customer credit" value={money(r && r.lessThan(0) ? r.abs() : zero)} testId="party-credit" />
        <Figure
          label="Net position"
          value={!position || position.net.isZero() ? "₹0.00 (settled)" : position.net.greaterThan(0) ? `${money(position.net)} owed to us` : `${money(position.net.abs())} we owe`}
          testId="party-net"
        />
      </div>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-400">
        <span data-testid="party-last-received">પૈસા આવ્યા / Last payment received: {lr ? `${lr.date} · ${money(lr.amount)} · ${lr.voucherNumber}` : "—"}</span>
        <span data-testid="party-last-paid">પૈસા ગયા / Last payment given: {lp ? `${lp.date} · ${money(lp.amount)} · ${lp.voucherNumber}` : "—"}</span>
      </p>
      <nav aria-label="Party links" className="flex flex-wrap gap-2 text-xs">
        {links.map((l) => (
          <a key={l.href} href={l.href} className="rounded-full border border-[var(--border)] px-3 py-1 hover:bg-[var(--surface-muted)]">
            {l.label}
          </a>
        ))}
      </nav>
      {recentVouchers.length > 0 ? (
        <details className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
          <summary className="cursor-pointer font-medium">Related purchases, sales, bills and payments ({recentVouchers.length})</summary>
          <ul className="mt-2 flex flex-col gap-1">
            {recentVouchers.map((v) => (
              <li key={v.id} className="break-words">
                {v.date.toISOString().slice(0, 10)} ·{" "}
                {isOwner ? (
                  <a className="underline" href={`/accounting/voucher/${v.id}`}>
                    {v.voucherNumber}
                  </a>
                ) : (
                  v.voucherNumber
                )}{" "}
                · {VOUCHER_TYPE_LABELS[v.voucherType]} · {money(v.amount)} · {v.status === "CANCELLED" ? "Cancelled" : "Posted"}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
