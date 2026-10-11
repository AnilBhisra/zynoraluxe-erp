import { CustomerRefundForm } from "@/components/accounting/CustomerRefundForm";
import { formatRupees } from "@/lib/accounting/partyBalance";
import { daysBetween, type PartyPosition, type ReceivablePayableBook } from "@/lib/accounting/receivablePayable";
import { partyTypeLabel } from "@/lib/parties/types";

const money = (d: { toFixed: (n: number) => string }) => formatRupees(d.toFixed(2));

/** A side or net in words, never a bare negative: "₹500.00 advance", "₹250.00 credit", "₹40,000.00 owed to us". */
function receivableSideText(d: PartyPosition["net"]) {
  return d.isZero() ? "₹0.00" : d.greaterThan(0) ? `${money(d)} owed to us` : `${money(d.abs())} customer credit`;
}
function payableSideText(d: PartyPosition["net"]) {
  return d.isZero() ? "₹0.00" : d.greaterThan(0) ? `${money(d)} we owe` : `${money(d.abs())} advance paid`;
}
function netText(d: PartyPosition["net"]) {
  return d.isZero() ? "₹0.00 (settled)" : d.greaterThan(0) ? `${money(d)} owed to us` : `${money(d.abs())} we owe`;
}

type Group = "receivable" | "payable" | "advancePaid" | "customerCredit";

const GROUPS: { key: Group; title: string; explain: string }[] = [
  { key: "receivable", title: "લેવાનું / Receivable", explain: "Parties who owe the Company money (Accounts Receivable side)." },
  { key: "payable", title: "આપવાનું / Payable", explain: "Parties the Company owes money to (Accounts Payable side): purchases, Karigar / Manufacturer charges, gold bought from a Customer." },
  { key: "advancePaid", title: "Advance paid", explain: "Paid to a Supplier / Karigar / other party beyond what they billed. Adjusted against their next bill, or refunded by them." },
  { key: "customerCredit", title: "Customer credit", explain: "Received beyond what was billed. Adjusted against the next bill, or refunded." },
];

function amountOf(group: Group, p: PartyPosition) {
  return group === "receivable" || group === "customerCredit" ? p.receivableSide.abs() : p.payableSide.abs();
}

function LastPayment({ label, lp, canOpenVoucher }: { label: string; lp: PartyPosition["lastReceived"]; canOpenVoucher: boolean }) {
  if (!lp) return <span className="text-zinc-400">{label}: —</span>;
  return (
    <span>
      {label}: {lp.date} · {money(lp.amount)} ·{" "}
      {canOpenVoucher ? (
        <a className="underline" href={`/accounting/voucher/${lp.voucherId}`}>
          {lp.voucherNumber}
        </a>
      ) : (
        lp.voucherNumber
      )}
    </span>
  );
}

export function ReceivablePayableView({
  book,
  isOwner,
  paymentAccounts,
}: {
  book: ReceivablePayableBook;
  isOwner: boolean;
  paymentAccounts: { id: string; name: string; method: string }[];
}) {
  const t = book.totals;
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="receivable-payable">
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        <strong>Party-level live balance</strong> as of {book.asOf}. Payments are not matched to individual bills, so these are what each party owes or is owed in
        total. Receivable and payable are kept apart: a party can appear on both sides. &ldquo;Oldest open&rdquo; assumes payments settle the oldest entry first.
      </div>

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="rp-totals">
        {[
          ["લેવાનું / Total receivable", t.receivable, "rp-total-receivable"],
          ["આપવાનું / Total payable", t.payable, "rp-total-payable"],
          ["Total advance paid", t.advancesPaid, "rp-total-advance"],
          ["Total customer credit", t.customerCredit, "rp-total-credit"],
          ["Net position (+ owed to us)", t.net, "rp-total-net"],
        ].map(([label, value, id]) => (
          <div key={id as string} className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{label as string}</p>
            <p className="mt-1 break-words text-lg font-semibold" data-testid={id as string}>
              {money(value as PartyPosition["net"])}
            </p>
          </div>
        ))}
      </section>

      {GROUPS.map((g) => {
        const rows = book[g.key];
        return (
          <section key={g.key} aria-label={g.title} data-testid={`rp-group-${g.key}`} className="flex min-w-0 flex-col gap-2">
            <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
              {g.title} <span className="font-normal text-zinc-500">({rows.length})</span>
            </h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{g.explain}</p>
            {rows.length === 0 ? (
              <p className="text-xs text-zinc-400">None.</p>
            ) : (
              <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
                {rows.map((p) => {
                  const oldest = g.key === "receivable" ? p.oldestReceivableDate : g.key === "payable" ? p.oldestPayableDate : null;
                  const both = !p.receivableSide.isZero() && !p.payableSide.isZero();
                  return (
                    <li key={p.partyId} className="flex min-w-0 flex-col gap-2 bg-[var(--surface)] p-3 text-sm" data-testid="rp-row">
                      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                        <p className="min-w-0 break-words font-medium">
                          <a className="underline" href={`/accounting?tab=ledger&partyId=${p.partyId}`}>
                            {p.name}
                          </a>{" "}
                          <span className="text-xs text-zinc-500">
                            {partyTypeLabel(p.type)}
                            {p.isActive ? "" : " · archived"}
                          </span>
                        </p>
                        <p className="text-base font-semibold" data-testid="rp-amount">
                          {money(amountOf(g.key, p))}
                        </p>
                      </div>
                      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-zinc-600 dark:text-zinc-400 sm:grid-cols-4">
                        <div><dt className="inline">Billed / sold: </dt><dd className="inline">{money(p.billed)}</dd></div>
                        <div><dt className="inline">Purchases / charges: </dt><dd className="inline">{money(p.charged)}</dd></div>
                        <div><dt className="inline">Payments received: </dt><dd className="inline">{money(p.received)}</dd></div>
                        <div><dt className="inline">Payments given: </dt><dd className="inline">{money(p.given)}</dd></div>
                        <div><dt className="inline">Credit / reversal adj.: </dt><dd className="inline">{money(p.adjustments)}</dd></div>
                        <div><dt className="inline">Receivable side: </dt><dd className="inline">{receivableSideText(p.receivableSide)}</dd></div>
                        <div><dt className="inline">Payable side: </dt><dd className="inline">{payableSideText(p.payableSide)}</dd></div>
                        <div><dt className="inline">Net position: </dt><dd className="inline" data-testid="rp-net">{netText(p.net)}</dd></div>
                      </dl>
                      <p className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                        {oldest ? (
                          <span data-testid="rp-oldest">
                            Oldest open: {oldest} ({daysBetween(oldest, book.asOf)} days)
                          </span>
                        ) : null}
                        <LastPayment label="Last received" lp={p.lastReceived} canOpenVoucher={isOwner} />
                        <LastPayment label="Last paid" lp={p.lastPaid} canOpenVoucher={isOwner} />
                        {both ? <span className="text-amber-700 dark:text-amber-300">Has both receivable and payable</span> : null}
                        {isOwner ? (
                          <a className="underline" href={`/accounting?tab=cash-bank&partyId=${p.partyId}`}>
                            Cash &amp; Bank entries
                          </a>
                        ) : null}
                      </p>
                      {isOwner && g.key === "customerCredit" && p.type === "CUSTOMER" ? (
                        <CustomerRefundForm partyId={p.partyId} availableCredit={Number(p.receivableSide.abs().toFixed(2))} paymentAccounts={paymentAccounts} />
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
