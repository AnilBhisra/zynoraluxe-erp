import type { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/accounting/money";
import { getJobGoldSources } from "@/lib/jewellery/customerGold";
import { availableCustomerCreditInTx, customerDeliveryBlock } from "@/lib/jewellery/customerGoldCommercial";
import { listCustomerGoldPools } from "@/lib/jewellery/customerGoldReports";
import type { SerializedJobCustomerGold } from "@/components/jewellery/JobCustomerGoldPanel";
import type { CustomerGoldSourceOption } from "@/components/jewellery/ReceiveFinishedForm";

type Tx = Prisma.TransactionClient;

/**
 * Everything the job page shows about Customer-owned gold. SECURITY: every
 * money figure (piece cost, bills, credit) is read from the database only
 * when includeValues is true (the Owner) — a Staff payload never carries it.
 * Returns null for a job with no Customer.
 */
export async function getJobCustomerGoldPanel(
  tx: Tx,
  jobId: string,
  opts: { includeValues: boolean }
): Promise<{ panel: SerializedJobCustomerGold; receiveSources: CustomerGoldSourceOption[] } | null> {
  const job = await tx.jewelleryJob.findUnique({ where: { id: jobId }, select: { id: true, jobCode: true, customerId: true, karigarId: true, status: true, customer: { select: { name: true } } } });
  if (!job || !job.customerId) return null;
  const customerId = job.customerId;
  const [sources, pieces, deliveries, deliveryBlock, pools, bills, credit] = await Promise.all([
    getJobGoldSources(tx, jobId),
    tx.finishedJewellery.findMany({
      where: { jobId, ownership: "CUSTOMER" },
      orderBy: { finishedCode: "asc" },
      select: {
        id: true,
        finishedCode: true,
        status: true,
        netMetalWeight: true,
        customerGoldFineWeight: true,
        ...(opts.includeValues ? { metalCost: true, diamondCost: true, labourAllocated: true } : {}),
      },
    }),
    tx.customerJewelleryDelivery.findMany({
      where: { jobId },
      orderBy: { deliveryDate: "desc" },
      select: {
        id: true,
        deliveryCode: true,
        deliveryDate: true,
        status: true,
        receivedByName: true,
        reference: true,
        deliveredBy: { select: { name: true } },
        items: { select: { finishedJewellery: { select: { finishedCode: true } } } },
      },
    }),
    customerDeliveryBlock(tx, jobId),
    listCustomerGoldPools(tx, customerId),
    opts.includeValues ? tx.customerJewelleryBill.findMany({ where: { jobId }, orderBy: { billDate: "desc" } }) : Promise.resolve(null),
    opts.includeValues ? availableCustomerCreditInTx(tx, customerId) : Promise.resolve(null),
  ]);

  const receiveSources: CustomerGoldSourceOption[] = ["DRAFT", "MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"].includes(job.status)
    ? pools
        .map((p) => ({
          purityId: p.purityId,
          metalType: p.metalType,
          displayName: p.purityDisplayName,
          finenessPercent: p.finenessPercent,
          onJobFine: p.byJob.find((j) => j.jobId === jobId)?.fine ?? "0.000",
          withKarigarFine: p.byKarigar.find((k) => k.karigarId === job.karigarId)?.fine ?? "0.000",
          safeFine: p.safe,
        }))
        .filter((s) => Number(s.onJobFine) > 0 || Number(s.withKarigarFine) > 0 || Number(s.safeFine) > 0)
    : [];

  const f3 = (v: unknown) => new Decimal(String(v)).toFixed(3);
  const panel: SerializedJobCustomerGold = {
    jobId,
    jobCode: job.jobCode,
    customerId,
    customerName: job.customer?.name ?? null,
    sources: {
      label: sources.label,
      customerGoldOnJob: sources.customerGoldOnJob.map((p) => ({ purityDisplayName: p.purityDisplayName, finenessPercent: p.finenessPercent, gross: p.gross, fine: p.fine })),
      customerGoldConsumedFine: sources.customerGoldConsumedFine,
      companyViaKarigarMetalFine: sources.companyViaKarigarMetalFine,
      companyDirectIssueFine: sources.companyDirectIssueFine,
      mixApproved: sources.mixApproved,
    },
    pieces: pieces.map((p) => {
      const costed = p as typeof p & { metalCost?: unknown; diamondCost?: unknown; labourAllocated?: unknown };
      return {
        id: p.id,
        finishedCode: p.finishedCode,
        status: p.status,
        netMetalWeight: f3(p.netMetalWeight),
        customerGoldFineWeight: f3(p.customerGoldFineWeight),
        companyCost: opts.includeValues
          ? new Decimal(String(costed.metalCost ?? 0)).plus(String(costed.diamondCost ?? 0)).plus(String(costed.labourAllocated ?? 0)).toFixed(2)
          : null,
      };
    }),
    deliveryBlock,
    deliveries: deliveries.map((d, i) => ({
      id: d.id,
      deliveryCode: d.deliveryCode,
      date: d.deliveryDate.toISOString(),
      status: d.status,
      receivedByName: d.receivedByName,
      deliveredBy: d.deliveredBy.name,
      reference: d.reference,
      pieces: d.items.map((it) => it.finishedJewellery.finishedCode),
      // Newest first; the server refuses any reversal a later entry depends on.
      canReverse: opts.includeValues && d.status === "POSTED" && deliveries.slice(0, i).every((x) => x.status !== "POSTED"),
    })),
    bills: bills
      ? bills.map((b) => ({
          id: b.id,
          billCode: b.billCode,
          date: b.billDate.toISOString(),
          status: b.status,
          taxableValue: new Decimal(String(b.taxableValue)).toFixed(2),
          taxAmount: new Decimal(String(b.taxAmount)).toFixed(2),
          grandTotal: new Decimal(String(b.grandTotal)).toFixed(2),
          creditApplied: new Decimal(String(b.creditApplied)).toFixed(2),
          amountDue: new Decimal(String(b.amountDue)).toFixed(2),
        }))
      : null,
    creditAvailable: credit ? credit.toFixed(2) : null,
  };
  return { panel, receiveSources };
}
