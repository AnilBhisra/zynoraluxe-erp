import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/accounting/money";
import { listCustomerGoldPools } from "@/lib/jewellery/customerGoldReports";
import {
  CUSTOMER_PIECE_FILTERS,
  matchesPieceFilter,
  type CustomerPieceFilter,
  type CustomerPieceRow,
  type CustomerPieceSummary,
} from "@/lib/jewellery/customerFinishedJewelleryRules";
import { jewelleryTypeLabel } from "@/lib/jewellery/types";

export { CUSTOMER_PIECE_FILTERS, type CustomerPieceFilter, type CustomerPieceRow };

type Db = Pick<Prisma.TransactionClient, "finishedJewellery" | "customerJewelleryBill" | "customerGoldEntry" | "party" | "jewelleryJob" | "metalPurity">;

/**
 * A Customer's Finished Jewellery on their account page: the pieces of the
 * jobs made for them (job.customerId) and every piece they own (customerId),
 * linked through the records — never matched by name. Weights, purity, codes,
 * bill numbers and delivery state only: safe for Staff (no cost, no profit).
 */
export async function customerFinishedJewellery(db: Db, customerId: string, filter: CustomerPieceFilter = "ALL") {
  const pieces = await db.finishedJewellery.findMany({
    where: { OR: [{ customerId }, { job: { customerId } }] },
    orderBy: [{ createdAt: "desc" }, { finishedCode: "desc" }],
    select: {
      id: true,
      finishedCode: true,
      status: true,
      ownership: true,
      customerId: true,
      jewelleryType: true,
      grossWeight: true,
      netMetalWeight: true,
      fineMetalWeight: true,
      customerGoldFineWeight: true,
      purity: { select: { displayName: true } },
      job: { select: { id: true, jobCode: true, designName: true, customerId: true } },
      receipt: { select: { id: true, receiptCode: true, reversedAt: true } },
      customerBillPieces: { select: { activeFinishedJewelleryId: true, bill: { select: { billCode: true, billDate: true, status: true } } } },
      customerDeliveryItems: { select: { delivery: { select: { deliveryCode: true, deliveryDate: true, status: true } } } },
      saleLines: { select: { returnStatus: true, sale: { select: { saleCode: true, saleDate: true, status: true, customerId: true } } } },
    },
  });
  const jobIds = [...new Set(pieces.map((p) => p.job.id))];
  const wholeJobBills = jobIds.length
    ? await db.customerJewelleryBill.findMany({
        where: { jobId: { in: jobIds }, status: "POSTED", pieces: { none: {} } },
        select: { jobId: true, billCode: true, billDate: true },
      })
    : [];
  const wholeJob = new Map(wholeJobBills.map((b) => [b.jobId, b]));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const w = (v: Prisma.Decimal | null) => (v === null ? null : new Decimal(v).toFixed(3));

  const rows: CustomerPieceRow[] = pieces.map((p) => {
    const receiptReversed = p.status === "RECEIPT_REVERSED" || p.receipt.reversedAt !== null;
    const customerFine = new Decimal(p.customerGoldFineWeight);
    const ownership: CustomerPieceRow["ownership"] =
      p.ownership === "CUSTOMER" ? (customerFine.lessThan(new Decimal(p.fineMetalWeight)) ? "MIXED" : "CUSTOMER") : "COMPANY";
    const live = p.customerBillPieces.find((l) => l.activeFinishedJewelleryId !== null && l.bill.status === "POSTED");
    const legacy = wholeJob.get(p.job.id);
    const hadReversedBill = p.customerBillPieces.some((l) => l.bill.status !== "POSTED");
    const sale = p.saleLines.find((l) => l.sale.status === "POSTED" && l.returnStatus === "NONE");
    const delivered = p.customerDeliveryItems.find((d) => d.delivery.status === "POSTED");
    const deliveryReversed = p.customerDeliveryItems.some((d) => d.delivery.status !== "POSTED");

    let billing: CustomerPieceRow["billing"];
    let bill: CustomerPieceRow["bill"] = null;
    if (receiptReversed) billing = "NOT_APPLICABLE";
    else if (p.ownership === "CUSTOMER") {
      if (live) {
        billing = "BILLED";
        bill = { code: live.bill.billCode, date: day(live.bill.billDate), kind: "BILL" };
      } else if (legacy) {
        billing = "BILLED";
        bill = { code: legacy.billCode, date: day(legacy.billDate), kind: "BILL" };
      } else billing = hadReversedBill ? "BILL_REVERSED" : "UNBILLED";
    } else if (sale) {
      billing = "BILLED";
      bill = { code: sale.sale.saleCode, date: day(sale.sale.saleDate), kind: "SALE" };
    } else billing = "UNBILLED";

    let delivery: CustomerPieceRow["delivery"];
    let location: CustomerPieceRow["location"];
    if (receiptReversed) {
      delivery = "RECEIPT_REVERSED";
      location = "RECEIPT_REVERSED";
    } else if (p.status === "DELIVERED_TO_CUSTOMER" || delivered) {
      delivery = "DELIVERED";
      location = "DELIVERED";
    } else if (p.status === "SOLD") {
      delivery = "DELIVERED";
      location = "SOLD";
    } else if (p.status === "RETURNED_DAMAGED") {
      delivery = "NOT_APPLICABLE";
      location = "RETURNED_DAMAGED";
    } else {
      delivery = deliveryReversed ? "DELIVERY_REVERSED" : "READY";
      location = "FINISHED_STOCK";
    }

    return {
      id: p.id,
      finishedCode: p.finishedCode,
      jobId: p.job.id,
      jobCode: p.job.jobCode,
      receiptId: p.receipt.id,
      receiptCode: p.receipt.receiptCode,
      description: `${p.job.designName} · ${jewelleryTypeLabel(p.jewelleryType)}`,
      grossWeight: w(p.grossWeight),
      netWeight: w(p.netMetalWeight)!,
      fineWeight: w(p.fineMetalWeight)!,
      customerGoldFine: customerFine.toFixed(3),
      purity: p.purity.displayName,
      ownership,
      billing,
      bill,
      delivery,
      deliveryRef: delivered ? { code: delivered.delivery.deliveryCode, date: day(delivered.delivery.deliveryDate) } : null,
      location,
      // A Customer-owned piece is billed on its job page; a Company piece is sold from Finished Stock.
      canCreateBill: !receiptReversed && p.ownership === "CUSTOMER" && billing !== "BILLED",
    };
  });

  const summary: CustomerPieceSummary = {
    readyUndelivered: rows.filter((r) => r.delivery === "READY" || r.delivery === "DELIVERY_REVERSED").length,
    unbilled: rows.filter((r) => r.billing === "UNBILLED" || r.billing === "BILL_REVERSED").length,
    billedUndelivered: rows.filter((r) => r.billing === "BILLED" && r.location === "FINISHED_STOCK").length,
    delivered: rows.filter((r) => r.delivery === "DELIVERED").length,
  };
  const pools = await listCustomerGoldPools(db as unknown as Prisma.TransactionClient, customerId);
  const gold = pools.map((p) => ({
    purity: `${p.purityDisplayName} (${p.finenessPercent}%)`,
    safe: p.safe,
    withKarigar: p.withKarigar,
    onJobs: p.onJobs,
    finishedAwaitingDelivery: p.finishedAwaitingDelivery,
    remaining: p.remaining,
  }));
  return { rows: rows.filter((r) => matchesPieceFilter(r, filter)), total: rows.length, summary, gold, filter };
}
