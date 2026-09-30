import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { customerGoldStatement } from "@/lib/jewellery/customerGoldReports";
import { CustomerGoldPrintShell } from "@/components/jewellery/CustomerGoldPrint";

export const metadata: Metadata = {
  title: "Customer Gold Statement · ZYNORALUXE",
};

/** Printable Customer gold statement. Money (declared, purchase, bills) only reaches an Owner's page. */
export default async function CustomerGoldStatementPage({ params }: { params: Promise<{ customerId: string }> }) {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";
  const { customerId } = await params;
  const [statement, company] = await Promise.all([
    customerGoldStatement(prisma, customerId, { includeValues: isOwner }),
    prisma.companySettings.findUnique({ where: { id: "default" } }),
  ]);
  if (!statement) return <p className="text-sm text-zinc-500">Customer not found.</p>;
  const date = (iso: string) => new Date(iso).toLocaleDateString("en-IN");
  return (
    <CustomerGoldPrintShell backHref={`/jewellery-jobs?tab=customer-gold&customerId=${customerId}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 pb-4">
        <div>
          <h1 className="text-xl font-bold">{company?.companyName || "ZYNORALUXE"}</h1>
          {company?.address ? <p className="text-sm text-zinc-600">{company.address}</p> : null}
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold">Customer Gold Statement</p>
          <p className="text-sm text-zinc-600">As of {new Date().toLocaleDateString("en-IN")}</p>
        </div>
      </div>
      <p className="mt-4 text-sm">
        <strong>{statement.customer.name}</strong>
        {statement.customer.phone ? ` · ${statement.customer.phone}` : ""}
        {statement.customer.address ? ` · ${statement.customer.address}` : ""}
      </p>
      <p className="mt-1 text-xs text-zinc-600">Your own gold held by us for manufacturing. It is not Company stock. Weights are fine (pure) grams unless marked gross.</p>

      <h2 className="mt-5 text-sm font-semibold">Balances</h2>
      {statement.pools.length === 0 ? <p className="text-sm text-zinc-600">No gold recorded.</p> : null}
      {statement.pools.map((p) => (
        <table key={`${p.purityId}|${p.finenessPercent}`} className="mt-2 w-full text-xs" data-testid="print-pool">
          <caption className="text-left text-sm font-medium">
            {p.metalType} {p.purityDisplayName} ({p.finenessPercent}%)
          </caption>
          <tbody className="[&_td]:border-b [&_td]:border-zinc-200 [&_td]:py-1">
            {(
              [
                ["Received", `${p.received} g (${p.receivedGross} g gross)`],
                ["In our safe (unallocated)", `${p.safe} g`],
                ["With Karigar", `${p.withKarigar} g`],
                ["On jobs", `${p.onJobs} g`],
                ["In finished jewellery awaiting delivery", `${p.finishedAwaitingDelivery} g`],
                ["Delivered to you in jewellery", `${p.delivered} g`],
                ["Returned to you", `${p.returnedToCustomer} g`],
                ["Authorised loss", `${p.authorisedLoss} g`],
                ["Scrap held for you", `${p.scrapHeld} g`],
                ["Bought by the Company (approved)", `${p.boughtByCompany} g`],
                ["Remaining with us", `${p.remaining} g`],
              ] as const
            ).map(([label, v]) => (
              <tr key={label}>
                <td>{label}</td>
                <td className="text-right font-medium">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}

      <h2 className="mt-5 text-sm font-semibold">Movements</h2>
      <table className="mt-2 w-full text-xs">
        <thead>
          <tr className="text-left text-zinc-600">
            <th className="py-1">No.</th>
            <th>Date</th>
            <th>What</th>
            <th>From → To</th>
            <th className="text-right">Fine g</th>
          </tr>
        </thead>
        <tbody className="[&_td]:border-t [&_td]:border-zinc-200 [&_td]:py-1 [&_td]:align-top">
          {[...statement.entries].reverse().map((e) => (
            <tr key={e.id}>
              <td>{e.entryCode}</td>
              <td>{date(e.date)}</td>
              <td>
                {e.kindLabel}
                {e.jobCode ? ` · ${e.jobCode}` : ""}
                {e.finishedCode ? ` · ${e.finishedCode}` : ""}
                {e.reversedByCode ? ` (reversed by ${e.reversedByCode})` : ""}
              </td>
              <td>
                {e.fromLabel} → {e.toLabel}
              </td>
              <td className="text-right">{e.fine}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {statement.deliveries.length ? (
        <>
          <h2 className="mt-5 text-sm font-semibold">Deliveries</h2>
          <ul className="mt-1 text-xs">
            {statement.deliveries.map((d) => (
              <li key={d.deliveryCode}>
                {d.deliveryCode} · {date(d.date)} · {d.pieces.join(", ")} · {d.customerGoldFine} g fine · received by {d.receivedByName} · {d.status}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {isOwner && statement.purchases.length ? (
        <>
          <h2 className="mt-5 text-sm font-semibold">Gold bought from you (approved)</h2>
          <ul className="mt-1 text-xs">
            {statement.purchases.map((p) => (
              <li key={p.purchaseCode}>
                {p.purchaseCode} · {date(p.date)} · {p.fine} g fine · ₹{p.approvedValue} · {p.settlement === "CREDIT_TO_INVOICE" ? "credited to your bill" : "paid to you"}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {isOwner && statement.bills && statement.bills.length ? (
        <>
          <h2 className="mt-5 text-sm font-semibold">Bills</h2>
          <ul className="mt-1 text-xs">
            {statement.bills.map((b) => (
              <li key={b.billCode}>
                {b.billCode} · {date(b.date)} · {b.jobCode} · ₹{b.grandTotal} · credit ₹{b.creditApplied} · due ₹{b.amountDue} · {b.status}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <div className="mt-12 grid grid-cols-2 gap-8 text-sm">
        <p className="border-t border-zinc-400 pt-1">Customer&apos;s signature</p>
        <p className="border-t border-zinc-400 pt-1 text-right">For {company?.companyName || "ZYNORALUXE"}</p>
      </div>
    </CustomerGoldPrintShell>
  );
}
