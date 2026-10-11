import "server-only";

import type { VoucherStatus, VoucherType } from "@/generated/prisma/enums";
import { Decimal, round2 } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";

/** One voucher with its journal lines, reversal links and the business record it belongs to. Owner-only (lines carry cost). */
export type VoucherDetail = {
  id: string;
  voucherNumber: string;
  voucherType: VoucherType;
  status: VoucherStatus;
  date: string;
  financialYearLabel: string;
  amount: Decimal;
  party: { id: string; name: string; type: string } | null;
  paymentAccount: { id: string; name: string } | null;
  referenceNumber: string | null;
  note: string | null;
  createdBy: string;
  createdAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  reverses: { id: string; voucherNumber: string; voucherType: VoucherType } | null;
  reversedBy: { id: string; voucherNumber: string } | null;
  lines: { id: string; accountCode: string; accountName: string; partyName: string | null; debit: Decimal; credit: Decimal; description: string | null }[];
  /** The record that posted this voucher, with a page to open it on (when there is one). */
  related: { label: string; code: string; href: string | null }[];
};

export async function getVoucherDetail(id: string): Promise<VoucherDetail | null> {
  const v = await prisma.voucher.findUnique({
    where: { id },
    include: {
      party: { select: { id: true, name: true, type: true } },
      paymentAccount: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
      reversalOfVoucher: { select: { id: true, voucherNumber: true, voucherType: true } },
      reversedByVoucher: { select: { id: true, voucherNumber: true } },
      journalEntries: { include: { account: { select: { code: true, name: true } }, party: { select: { name: true } } }, orderBy: [{ debit: "desc" }, { id: "asc" }] },
    },
  });
  if (!v) return null;
  // The record behind it: the original's, for a reversal.
  const sourceId = v.reversalOfVoucher?.id ?? v.id;
  const [sale, metal, polished, rough, bill, delivery, receipt, correction] = await Promise.all([
    prisma.finishedJewellerySale.findFirst({ where: { voucherId: sourceId }, select: { saleCode: true } }),
    prisma.metalPurchase.findFirst({ where: { voucherId: sourceId }, select: { purchaseCode: true, customerGoldPurchase: { select: { id: true, purchaseCode: true } } } }),
    prisma.polishedPurchase.findFirst({ where: { voucherId: sourceId }, select: { purchaseCode: true } }),
    prisma.roughLot.findFirst({ where: { voucherId: sourceId }, select: { lotCode: true } }),
    prisma.customerJewelleryBill.findFirst({ where: { voucherId: sourceId }, select: { billCode: true, customerId: true, jobId: true } }),
    prisma.customerJewelleryDelivery.findFirst({ where: { cogsVoucherId: sourceId }, select: { deliveryCode: true, customerId: true } }),
    prisma.jewelleryReceipt.findFirst({ where: { postingVoucherId: sourceId }, select: { receiptCode: true, jobId: true } }),
    prisma.correction.findFirst({ where: { correctionVoucherId: sourceId }, select: { correctionCode: true } }),
  ]);
  const related: VoucherDetail["related"] = [];
  if (sale) related.push({ label: "Finished jewellery sale", code: sale.saleCode, href: "/jewellery-jobs?tab=finished" });
  if (metal?.customerGoldPurchase) related.push({ label: "Customer gold purchase", code: metal.customerGoldPurchase.purchaseCode, href: `/customer-gold/purchase/${metal.customerGoldPurchase.id}` });
  else if (metal) related.push({ label: "Metal purchase", code: metal.purchaseCode, href: "/jewellery-jobs?tab=metal" });
  if (polished) related.push({ label: "Polished diamond purchase", code: polished.purchaseCode, href: "/diamond?tab=polished" });
  if (rough) related.push({ label: "Rough diamond purchase", code: rough.lotCode, href: "/diamond?tab=rough" });
  if (bill) related.push({ label: "Customer jewellery bill", code: bill.billCode, href: `/jewellery-jobs?tab=jobs&jobId=${bill.jobId}` });
  if (delivery) related.push({ label: "Customer jewellery delivery", code: delivery.deliveryCode, href: `/jewellery-jobs?tab=customer-gold&customerId=${delivery.customerId}` });
  if (receipt) related.push({ label: "Jewellery receipt", code: receipt.receiptCode, href: `/jewellery-jobs?tab=jobs&jobId=${receipt.jobId}` });
  if (correction) related.push({ label: "Correction", code: correction.correctionCode, href: "/corrections" });
  return {
    id: v.id,
    voucherNumber: v.voucherNumber,
    voucherType: v.voucherType,
    status: v.status,
    date: new Date(v.date.getTime() + 330 * 60_000).toISOString().slice(0, 10),
    financialYearLabel: v.financialYearLabel,
    amount: round2(new Decimal(v.amount)),
    party: v.party,
    paymentAccount: v.paymentAccount,
    referenceNumber: v.referenceNumber,
    note: v.note,
    createdBy: v.createdBy.name,
    createdAt: v.createdAt,
    cancelledAt: v.cancelledAt,
    cancellationReason: v.cancellationReason,
    reverses: v.reversalOfVoucher,
    reversedBy: v.reversedByVoucher,
    lines: v.journalEntries.map((j) => ({
      id: j.id,
      accountCode: j.account.code,
      accountName: j.account.name,
      partyName: j.party?.name ?? null,
      debit: round2(new Decimal(j.debit)),
      credit: round2(new Decimal(j.credit)),
      description: j.description,
    })),
    related,
  };
}
