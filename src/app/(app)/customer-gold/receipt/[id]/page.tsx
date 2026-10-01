import type { Metadata } from "next";
import { Decimal } from "@/lib/accounting/money";

import { requireUser } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { resolveJewelleryAssetUrl } from "@/lib/storage/jewelleryMedia";
import { CustomerGoldPrintShell } from "@/components/jewellery/CustomerGoldPrint";

export const metadata: Metadata = {
  title: "Customer Gold Acknowledgment · ZYNORALUXE",
};

/**
 * Printable acknowledgment of a Customer's gold received for manufacturing.
 * Weights for everyone; the declared value (documentation only) is fetched
 * into the page only for the Owner.
 */
export default async function CustomerGoldReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";
  const { id } = await params;
  const [receipt, company] = await Promise.all([
    prisma.customerGoldReceipt.findUnique({ where: { id }, include: { customer: true, purity: true, createdBy: { select: { name: true } }, exchangePurchase: { select: { purchaseCode: true, status: true } } } }),
    prisma.companySettings.findUnique({ where: { id: "default" } }),
  ]);
  if (!receipt) return <p className="text-sm text-zinc-500">Receipt not found.</p>;
  const photoUrl = await resolveJewelleryAssetUrl(receipt.photoAssetId);
  const w = (v: unknown) => `${new Decimal(String(v)).toFixed(3)} g`;
  return (
    <CustomerGoldPrintShell backHref={`/jewellery-jobs?tab=customer-gold&customerId=${receipt.customerId}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 pb-4">
        <div>
          <h1 className="text-xl font-bold">{company?.companyName || "ZYNORALUXE"}</h1>
          {company?.address ? <p className="text-sm text-zinc-600">{company.address}</p> : null}
          <p className="text-sm text-zinc-600">{[company?.phone, company?.email].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold">Customer Gold Receipt {receipt.receiptCode}</p>
          <p className="text-sm text-zinc-600">Date: {receipt.intakeDate.toLocaleDateString("en-IN")}</p>
        </div>
      </div>
      {receipt.exchangePurchase ? (
        <p className="mt-4 text-sm" data-testid="intake-exchange-note">
          Received from <strong>{receipt.customer.name}</strong>
          {receipt.customer.phone ? ` (${receipt.customer.phone})` : ""} as old gold for exchange — bought by the Company in {receipt.exchangePurchase.purchaseCode}
          {receipt.exchangePurchase.status === "REVERSED" ? " (that purchase was later reversed: the gold is the Customer's again)" : ""}.
        </p>
      ) : (
        <p className="mt-4 text-sm">
          Received from <strong>{receipt.customer.name}</strong>
          {receipt.customer.phone ? ` (${receipt.customer.phone})` : ""} — the Customer&apos;s own gold, held for manufacturing their jewellery. It remains the
          Customer&apos;s property and is not purchased by the Company.
        </p>
      )}
      <table className="mt-4 w-full text-sm">
        <tbody className="[&_td]:border-b [&_td]:border-zinc-200 [&_td]:py-1.5">
          {receipt.statedPurity ? (
            <tr>
              <td>Stated purity (Customer)</td>
              <td className="text-right">{receipt.statedPurity}</td>
            </tr>
          ) : null}
          <tr>
            <td>{receipt.statedPurity ? "Tested / approved purity" : "Metal and purity"}</td>
            <td className="text-right font-medium">
              {receipt.metalType} {receipt.purity.displayName} ({new Decimal(String(receipt.finenessPercentSnapshot)).toFixed(3)}%)
            </td>
          </tr>
          <tr>
            <td>Gross weight (as weighed)</td>
            <td className="text-right">{w(receipt.grossWeight)}</td>
          </tr>
          <tr>
            <td>Less stone / dust deduction</td>
            <td className="text-right">{w(receipt.deductionWeight)}</td>
          </tr>
          <tr>
            <td>Net gross weight</td>
            <td className="text-right font-medium">{w(receipt.netGrossWeight)}</td>
          </tr>
          <tr>
            <td>Fine (pure) weight</td>
            <td className="text-right font-semibold">{w(receipt.fineWeight)}</td>
          </tr>
          <tr>
            <td>Entered as</td>
            <td className="text-right">{receipt.inputBasis === "FINE" ? "Fine weight" : "Gross weight"}</td>
          </tr>
          {receipt.reference ? (
            <tr>
              <td>Reference</td>
              <td className="text-right">{receipt.reference}</td>
            </tr>
          ) : null}
          <tr>
            <td>Notes</td>
            <td className="text-right">{receipt.reason}</td>
          </tr>
          {isOwner && receipt.declaredValue !== null ? (
            <tr>
              <td>Declared value (documentation only — not Company cost)</td>
              <td className="text-right">₹{new Decimal(String(receipt.declaredValue)).toFixed(2)}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl} alt="Customer gold" className="mt-4 max-h-60 rounded-lg border border-zinc-200 object-contain" />
      ) : null}
      <p className="mt-4 text-xs text-zinc-600">Recorded by {receipt.createdBy.name}.</p>
      <div className="mt-12 grid grid-cols-2 gap-8 text-sm">
        <p className="border-t border-zinc-400 pt-1">Customer&apos;s signature</p>
        <p className="border-t border-zinc-400 pt-1 text-right">For {company?.companyName || "ZYNORALUXE"}</p>
      </div>
    </CustomerGoldPrintShell>
  );
}
