import type { Metadata } from "next";

import { Decimal } from "@/lib/accounting/money";
import { requireOwner } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { resolveJewelleryAssetUrl } from "@/lib/storage/jewelleryMedia";
import { CustomerGoldPrintShell } from "@/components/jewellery/CustomerGoldPrint";

export const metadata: Metadata = {
  title: "Old Gold Purchase / Exchange · ZYNORALUXE",
};

const BASIS: Record<string, string> = { PER_FINE_GRAM: "per fine gram", PER_GROSS_GRAM: "per gross gram", FIXED_TOTAL: "fixed total" };

/**
 * Printable acknowledgment of gold the Company bought (or took in exchange)
 * from a Customer. Owner only — it carries the agreed rate and value. Shows
 * the intake it bought (stated vs tested purity, deduction, photo), the
 * approval, the settlement and, if reversed, the reversal.
 */
export default async function CustomerGoldPurchasePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  const [purchase, company] = await Promise.all([
    prisma.customerGoldPurchase.findUnique({
      where: { id },
      include: {
        customer: true,
        purity: true,
        approvedBy: { select: { name: true } },
        reversedBy: { select: { name: true } },
        reversalVoucher: { select: { voucherNumber: true } },
        metalPurchase: { select: { purchaseCode: true, voucher: { select: { voucherNumber: true } } } },
        customerGoldReceipt: true,
      },
    }),
    prisma.companySettings.findUnique({ where: { id: "default" } }),
  ]);
  if (!purchase) return <p className="text-sm text-zinc-500">Purchase not found.</p>;
  const intake = purchase.customerGoldReceipt;
  const photoUrl = await resolveJewelleryAssetUrl(intake?.photoAssetId ?? null);
  const w = (v: unknown) => `${new Decimal(String(v)).toFixed(3)} g`;
  const value = new Decimal(String(purchase.approvedValue));
  const fine = new Decimal(String(purchase.fineWeight));
  const gross = new Decimal(String(purchase.grossWeight));
  return (
    <CustomerGoldPrintShell backHref={`/jewellery-jobs?tab=customer-gold&customerId=${purchase.customerId}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 pb-4">
        <div>
          <h1 className="text-xl font-bold">{company?.companyName || "ZYNORALUXE"}</h1>
          {company?.address ? <p className="text-sm text-zinc-600">{company.address}</p> : null}
          <p className="text-sm text-zinc-600">{[company?.phone, company?.email].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold">{intake ? "Old Gold Exchange" : "Customer Gold Purchase"} {purchase.purchaseCode}</p>
          <p className="text-sm text-zinc-600">Date: {purchase.purchaseDate.toLocaleDateString("en-IN")}</p>
          {purchase.status === "REVERSED" ? <p className="mt-1 text-sm font-bold" data-testid="purchase-reversed-banner">REVERSED — NOT ACTIVE</p> : null}
        </div>
      </div>
      <p className="mt-4 text-sm">
        Bought from <strong>{purchase.customer.name}</strong>
        {purchase.customer.phone ? ` (${purchase.customer.phone})` : ""}. This gold now belongs to the Company at the agreed value below.
      </p>
      <table className="mt-4 w-full text-sm" data-testid="purchase-ack-table">
        <tbody className="[&_td]:border-b [&_td]:border-zinc-200 [&_td]:py-1.5">
          {intake?.statedPurity ? (
            <tr>
              <td>Stated purity (Customer)</td>
              <td className="text-right">{intake.statedPurity}</td>
            </tr>
          ) : null}
          <tr>
            <td>Tested / approved purity</td>
            <td className="text-right font-medium">
              {purchase.metalType} {purchase.purity.displayName} ({new Decimal(String(purchase.finenessPercentSnapshot)).toFixed(3)}%)
            </td>
          </tr>
          {intake ? (
            <>
              <tr>
                <td>Gross weight (as weighed)</td>
                <td className="text-right">{w(intake.grossWeight)}</td>
              </tr>
              <tr>
                <td>Less allowed deduction (stone / dust)</td>
                <td className="text-right">{w(intake.deductionWeight)}</td>
              </tr>
            </>
          ) : null}
          <tr>
            <td>Net gross weight bought</td>
            <td className="text-right font-medium">{w(gross)}</td>
          </tr>
          <tr>
            <td>Accepted fine (pure) weight</td>
            <td className="text-right font-semibold">{w(fine)}</td>
          </tr>
          <tr>
            <td>Agreed rate</td>
            <td className="text-right">
              ₹{new Decimal(String(purchase.rate)).toFixed(4)} {BASIS[purchase.rateBasis]}
            </td>
          </tr>
          <tr>
            <td>Approved value</td>
            <td className="text-right text-base font-bold">₹{value.toFixed(2)}</td>
          </tr>
          <tr>
            <td>Effective rates</td>
            <td className="text-right">
              ₹{value.dividedBy(gross).toFixed(4)} per gross gram / ₹{value.dividedBy(fine).toFixed(4)} per fine gram
            </td>
          </tr>
          <tr>
            <td>Settlement</td>
            <td className="text-right">{purchase.settlement === "CREDIT_TO_INVOICE" ? "Credit against the Customer's jewellery bill" : "Paid to the Customer (Payment Given)"}</td>
          </tr>
          <tr>
            <td>Reference</td>
            <td className="text-right">{purchase.reference ?? "—"}</td>
          </tr>
          <tr>
            <td>Reason / notes</td>
            <td className="text-right">{purchase.reason}</td>
          </tr>
          <tr>
            <td>Accounting</td>
            <td className="text-right">
              {purchase.metalPurchase.purchaseCode}
              {purchase.metalPurchase.voucher ? ` · ${purchase.metalPurchase.voucher.voucherNumber}` : ""}
              {intake ? ` · intake ${intake.receiptCode}` : ""}
            </td>
          </tr>
          {purchase.status === "REVERSED" ? (
            <tr>
              <td>Reversed</td>
              <td className="text-right">
                {purchase.reversedAt?.toLocaleString("en-IN")} by {purchase.reversedBy?.name ?? "—"} · {purchase.reversalVoucher?.voucherNumber ?? ""} · {purchase.reversalReason}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl} alt="Old gold" className="mt-4 max-h-60 rounded-lg border border-zinc-200 object-contain" />
      ) : null}
      <p className="mt-4 text-xs text-zinc-600">
        Approved by {purchase.approvedBy.name} on {purchase.approvedAt.toLocaleString("en-IN")}.
      </p>
      <div className="mt-12 grid grid-cols-2 gap-8 text-sm">
        <p className="border-t border-zinc-400 pt-1">Customer&apos;s signature</p>
        <p className="border-t border-zinc-400 pt-1 text-right">For {company?.companyName || "ZYNORALUXE"}</p>
      </div>
    </CustomerGoldPrintShell>
  );
}
