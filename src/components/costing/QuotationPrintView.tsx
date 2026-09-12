"use client";

import { Button } from "@/components/ui/Button";

/**
 * Renders ONLY what src/lib/costing/quotation.ts's CustomerQuotationView
 * type carries — no cost, profit, margin, markup, or internal source
 * reference ever reaches this component's props, so there is nothing
 * here that could leak them even by a rendering mistake.
 */
export type SerializedQuotationView = {
  costingNumber: string;
  costingDate: string;
  quotationValidUntil: string | null;
  itemName: string;
  jewelleryType: string;
  referenceNumber: string | null;
  quantity: number;
  sizeOrLength: string | null;
  notes: string | null;
  customerName: string | null;
  metalSummary: { metalType: string; purityDisplayName: string; grossWeight: string }[];
  diamondSummary: { shape: string; quantity: number; totalCarat: string }[];
  sellingValueBeforeDiscount: string;
  discountAmount: string;
  taxableSellingValue: string;
  gstTreatment: "NONE" | "CGST_SGST" | "IGST";
  gstRatePercent: string;
  cgst: string;
  sgst: string;
  igst: string;
  customerTotal: string;
  quotationTerms: string | null;
};

function money(v: string) {
  return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function QuotationPrintView({
  quotation,
  designImageUrl,
  company,
}: {
  quotation: SerializedQuotationView;
  designImageUrl: string | null;
  company: { name: string; address: string | null; phone: string | null; email: string | null; gstNumber: string | null };
}) {
  return (
    <div>
      <div className="quotation-no-print mb-4 flex gap-2">
        <a href={`/costing?tab=sheets`}>
          <Button type="button" variant="ghost">
            ← Back
          </Button>
        </a>
        <Button type="button" onClick={() => window.print()}>
          Print / Save as PDF
        </Button>
      </div>

      <div className="quotation-print-area mx-auto max-w-2xl rounded-2xl border border-[var(--border)] bg-white p-8 text-zinc-900">
        <div className="flex items-start justify-between border-b border-zinc-200 pb-4">
          <div>
            <h1 className="text-xl font-bold">{company.name || "ZYNORALUXE"}</h1>
            {company.address ? <p className="text-sm text-zinc-600">{company.address}</p> : null}
            <p className="text-sm text-zinc-600">
              {[company.phone, company.email].filter(Boolean).join(" · ")}
            </p>
            {company.gstNumber ? <p className="text-sm text-zinc-600">GSTIN: {company.gstNumber}</p> : null}
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold">Quotation {quotation.costingNumber}</p>
            <p className="text-sm text-zinc-600">Date: {new Date(quotation.costingDate).toLocaleDateString("en-IN")}</p>
            {quotation.quotationValidUntil ? (
              <p className="text-sm text-zinc-600">Valid until: {new Date(quotation.quotationValidUntil).toLocaleDateString("en-IN")}</p>
            ) : null}
          </div>
        </div>

        {quotation.customerName ? (
          <p className="mt-4 text-sm text-zinc-700">
            <span className="font-medium">To:</span> {quotation.customerName}
          </p>
        ) : null}

        <div className="mt-4">
          <h2 className="text-base font-semibold">{quotation.itemName}</h2>
          <p className="text-sm text-zinc-600">
            {quotation.jewelleryType} · Qty {quotation.quantity}
            {quotation.sizeOrLength ? ` · Size/length ${quotation.sizeOrLength}` : ""}
            {quotation.referenceNumber ? ` · Ref ${quotation.referenceNumber}` : ""}
          </p>
          {designImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={designImageUrl} alt="Design" className="mt-2 h-40 w-40 rounded-lg object-cover" />
          ) : null}
        </div>

        {quotation.metalSummary.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-zinc-700">Metal</h3>
            {quotation.metalSummary.map((m, i) => (
              <p key={i} className="text-sm text-zinc-600">
                {m.metalType} {m.purityDisplayName} · {m.grossWeight}g
              </p>
            ))}
          </div>
        ) : null}

        {quotation.diamondSummary.length > 0 ? (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-zinc-700">Diamonds</h3>
            {quotation.diamondSummary.map((d, i) => (
              <p key={i} className="text-sm text-zinc-600">
                {d.shape} · {d.quantity} pc · {d.totalCarat}ct
              </p>
            ))}
          </div>
        ) : null}

        <div className="mt-6 border-t border-zinc-200 pt-4">
          <div className="flex justify-between text-sm">
            <span>Selling value</span>
            <span>{money(quotation.sellingValueBeforeDiscount)}</span>
          </div>
          {Number(quotation.discountAmount) > 0 ? (
            <div className="flex justify-between text-sm">
              <span>Discount</span>
              <span>- {money(quotation.discountAmount)}</span>
            </div>
          ) : null}
          <div className="flex justify-between text-sm">
            <span>Taxable value</span>
            <span>{money(quotation.taxableSellingValue)}</span>
          </div>
          {quotation.gstTreatment === "CGST_SGST" ? (
            <>
              <div className="flex justify-between text-sm">
                <span>CGST ({(Number(quotation.gstRatePercent) / 2).toFixed(2)}%)</span>
                <span>{money(quotation.cgst)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span>SGST ({(Number(quotation.gstRatePercent) / 2).toFixed(2)}%)</span>
                <span>{money(quotation.sgst)}</span>
              </div>
            </>
          ) : quotation.gstTreatment === "IGST" ? (
            <div className="flex justify-between text-sm">
              <span>IGST ({quotation.gstRatePercent}%)</span>
              <span>{money(quotation.igst)}</span>
            </div>
          ) : null}
          <div className="mt-2 flex justify-between border-t border-zinc-200 pt-2 text-base font-bold">
            <span>Total</span>
            <span>{money(quotation.customerTotal)}</span>
          </div>
        </div>

        {quotation.notes ? <p className="mt-4 text-sm text-zinc-600">{quotation.notes}</p> : null}
        {quotation.quotationTerms ? (
          <div className="mt-4 border-t border-zinc-200 pt-3">
            <h3 className="text-xs font-semibold text-zinc-500">Terms</h3>
            <p className="whitespace-pre-line text-xs text-zinc-500">{quotation.quotationTerms}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
