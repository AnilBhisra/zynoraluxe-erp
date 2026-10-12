import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { ClearingDocumentKind, ClearingDocumentStatus, ClearingLineType } from "@/generated/prisma/enums";
import type { ClearingReportFilters } from "@/lib/accounting/clearingReportFilters";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";

/**
 * Clearing read side (Owner only). Every figure comes from posted ledger /
 * sub-ledger rows; nothing is estimated except where labelled. Dates are India
 * business dates of the voucher that posted the entry.
 */

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "clearingDocument" | "party">;
const BDATE = Prisma.sql`((v.date + interval '330 minutes')::date)`;
const d4 = (v: Prisma.Decimal | string | null | undefined) => new Decimal(v ?? 0).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
const d2 = (v: Prisma.Decimal | string | null | undefined) => round2(new Decimal(v ?? 0));
const iso = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export type ProviderBalance = {
  partyId: string;
  partyName: string;
  currencyCode: string;
  availableFc: Decimal;
  availableInr: Decimal;
  reserveFc: Decimal;
  reserveInr: Decimal;
  totalInr: Decimal;
  /** Σ (settled − allocated) of posted settlements, clearing currency. */
  unallocatedFc: Decimal;
  nextAvailableOn: string | null;
  lastSettlementDate: string | null;
};

/** Every clearing party × currency with its available / reserve balance (clearing parties with no entry yet appear with INR 0). */
export async function getProviderBalances(db: Db = prisma): Promise<ProviderBalance[]> {
  const rows = await db.$queryRaw<
    {
      party_id: string;
      party_name: string;
      currency: string;
      a_fc: Prisma.Decimal;
      a_inr: Prisma.Decimal;
      r_fc: Prisma.Decimal;
      r_inr: Prisma.Decimal;
      unallocated: Prisma.Decimal;
      next_on: Date | null;
      last_date: Date | null;
    }[]
  >(Prisma.sql`
    with keys as (
      select distinct "partyId" party_id, "currencyCode" currency from clearing_entries
      union select id, 'INR' from parties where "clearingEnabled" and not exists (select 1 from clearing_entries e where e."partyId" = parties.id)
    ),
    bal as (
      select "partyId" party_id, "currencyCode" currency,
             sum("fcAmount") filter (where bucket = 'AVAILABLE') a_fc, sum("inrAmount") filter (where bucket = 'AVAILABLE') a_inr,
             sum("fcAmount") filter (where bucket = 'RESERVE') r_fc, sum("inrAmount") filter (where bucket = 'RESERVE') r_inr
      from clearing_entries group by 1, 2
    ),
    unalloc as (
      select d."partyId" party_id, d."currencyCode" currency,
             sum(d."availableFc" - coalesce((select sum(a."fcAmount") from clearing_allocations a where a."documentId" = d.id and a.status = 'ACTIVE'), 0)) unallocated,
             min(d."availableOn") filter (where d.kind = 'RESERVE_HOLD') next_on,
             max(d."documentDate") filter (where d.kind = 'SETTLEMENT') last_date
      from clearing_documents d where d.status = 'POSTED' and (d.kind = 'SETTLEMENT' or d.kind = 'RESERVE_HOLD')
      group by 1, 2
    )
    select k.party_id, p.name party_name, k.currency,
           coalesce(b.a_fc, 0) a_fc, coalesce(b.a_inr, 0) a_inr, coalesce(b.r_fc, 0) r_fc, coalesce(b.r_inr, 0) r_inr,
           coalesce(u.unallocated, 0) unallocated, u.next_on, u.last_date
    from keys k join parties p on p.id = k.party_id
    left join bal b on b.party_id = k.party_id and b.currency = k.currency
    left join unalloc u on u.party_id = k.party_id and u.currency = k.currency
    order by p.name, k.currency`);
  return rows.map((r) => ({
    partyId: r.party_id,
    partyName: r.party_name,
    currencyCode: r.currency,
    availableFc: d4(r.a_fc),
    availableInr: d2(r.a_inr),
    reserveFc: d4(r.r_fc),
    reserveInr: d2(r.r_inr),
    totalInr: d2(new Decimal(r.a_inr ?? 0).plus(r.r_inr ?? 0)),
    unallocatedFc: d4(r.unallocated),
    nextAvailableOn: iso(r.next_on),
    lastSettlementDate: iso(r.last_date),
  }));
}

export type ClearingDocumentRow = {
  id: string;
  kind: ClearingDocumentKind;
  status: ClearingDocumentStatus;
  voucherId: string;
  voucherNumber: string;
  date: string;
  partyId: string;
  partyName: string;
  currencyCode: string;
  reference: string | null;
  paymentAccountName: string | null;
  receivedInr: Decimal;
  receivedFc: Decimal;
  payoutRate: Decimal;
  availableFc: Decimal;
  availableInr: Decimal;
  reserveFc: Decimal;
  deductionsInr: Decimal;
  fxDifferenceInr: Decimal;
  lines: { lineType: ClearingLineType; direction: string; accountCode: string; fc: Decimal; inr: Decimal }[];
  /** Available clearing (fc / INR) right after this document. */
  availableAfterFc: Decimal;
  availableAfterInr: Decimal;
  allocatedFc: Decimal;
  allocations: { id: string; saleVoucherId: string; saleVoucherNumber: string; fc: Decimal; status: string; reason: string }[];
  reversalVoucherId: string | null;
  reversalVoucherNumber: string | null;
  reversalReason: string | null;
  sourceVoucherNumber: string | null;
};

export async function listClearingDocuments(f: Partial<ClearingReportFilters> & { take?: number }, db: Db = prisma): Promise<ClearingDocumentRow[]> {
  const docs = await db.clearingDocument.findMany({
    where: {
      partyId: f.partyId || undefined,
      currencyCode: f.currencyCode || undefined,
      documentDate: { gte: f.dateFrom ? new Date(`${f.dateFrom}T00:00:00.000Z`) : undefined, lte: f.dateTo ? new Date(`${f.dateTo}T00:00:00.000Z`) : undefined },
    },
    include: {
      party: { select: { name: true } },
      paymentAccount: { select: { name: true } },
      voucher: { select: { voucherNumber: true } },
      reversalVoucher: { select: { voucherNumber: true } },
      sourceVoucher: { select: { voucherNumber: true } },
      lines: { include: { account: { select: { code: true } } }, orderBy: { sortOrder: "asc" } },
      allocations: { include: { saleVoucher: { select: { voucherNumber: true } } }, orderBy: { createdAt: "asc" } },
      entries: { select: { id: true } },
    },
    orderBy: [{ createdAt: "desc" }],
    take: f.take ?? 500,
  });
  // Running available balance after each document's own entries (one query for all).
  const entryIds = docs.flatMap((d) => d.entries.map((e) => e.id));
  const running = entryIds.length
    ? await db.$queryRaw<{ document_id: string; fc: Prisma.Decimal; inr: Prisma.Decimal }[]>(Prisma.sql`
        with r as (
          select id, "documentId" document_id, "createdAt",
                 sum("fcAmount") over w fc, sum("inrAmount") over w inr
          from clearing_entries where bucket = 'AVAILABLE'
          window w as (partition by "partyId", "currencyCode" order by "createdAt", id)
        )
        select distinct on (document_id) document_id, fc, inr from r
        where document_id is not null
        order by document_id, "createdAt" desc, id desc`)
    : [];
  const after = new Map(running.map((r) => [r.document_id, r]));
  return docs.map((d) => {
    const lines = d.lines.map((l) => ({ lineType: l.lineType, direction: l.direction, accountCode: l.account.code, fc: d4(l.fcAmount), inr: d2(l.inrAmount) }));
    const a = after.get(d.id);
    const allocations = d.allocations.map((x) => ({ id: x.id, saleVoucherId: x.saleVoucherId, saleVoucherNumber: x.saleVoucher.voucherNumber, fc: d4(x.fcAmount), status: x.status, reason: x.reason }));
    return {
      id: d.id,
      kind: d.kind,
      status: d.status,
      voucherId: d.voucherId,
      voucherNumber: d.voucher.voucherNumber,
      date: iso(d.documentDate)!,
      partyId: d.partyId,
      partyName: d.party.name,
      currencyCode: d.currencyCode,
      reference: d.reference,
      paymentAccountName: d.paymentAccount?.name ?? null,
      receivedInr: d2(d.receivedInr),
      receivedFc: d4(d.receivedFc),
      payoutRate: new Decimal(d.payoutRate),
      availableFc: d4(d.availableFc),
      availableInr: d2(d.availableInr),
      reserveFc: d4(d.reserveFc),
      deductionsInr: round2(lines.filter((l) => l.direction === "DEDUCTION" && !l.lineType.startsWith("FX") && l.lineType !== "RESERVE_HOLD").reduce((s, l) => s.plus(l.inr), ZERO)),
      fxDifferenceInr: d2(d.fxDifferenceInr),
      lines,
      availableAfterFc: d4(a?.fc),
      availableAfterInr: d2(a?.inr),
      allocatedFc: round2(allocations.filter((x) => x.status === "ACTIVE").reduce((s, x) => s.plus(x.fc), ZERO)),
      allocations,
      reversalVoucherId: d.reversalVoucherId,
      reversalVoucherNumber: d.reversalVoucher?.voucherNumber ?? null,
      reversalReason: d.reversalReason,
      sourceVoucherNumber: d.sourceVoucher?.voucherNumber ?? null,
    };
  });
}

export type ClearingReportRow = {
  partyId: string;
  partyName: string;
  currencyCode: string;
  openingFc: Decimal;
  openingInr: Decimal;
  grossSalesInr: Decimal;
  grossSalesFc: Decimal;
  returnsInr: Decimal;
  payoutsInr: Decimal;
  feesInr: Decimal;
  marketingInr: Decimal;
  refundsInr: Decimal;
  taxesInr: Decimal;
  reserveNetInr: Decimal;
  fxInr: Decimal;
  otherInr: Decimal;
  reclassifiedInr: Decimal;
  unallocatedFc: Decimal;
  closingFc: Decimal;
  closingInr: Decimal;
  closingAvailableInr: Decimal;
  closingReserveInr: Decimal;
};

const FEES: ClearingLineType[] = ["COMMISSION", "PROCESSING_FEE", "SUBSCRIPTION", "SHIPPING"];
const TAXES: ClearingLineType[] = ["TAX_WITHHELD", "TAX_REMITTED"];

/**
 * Per provider and currency for the period. Opening / closing come from the
 * sub-ledger (= the 1150 + 1160 ledger); the columns between come from the
 * posted settlement documents (a reversal inside the period cancels its
 * document). INR unless labelled.
 */
export async function getClearingReport(f: ClearingReportFilters, db: Db = prisma): Promise<ClearingReportRow[]> {
  const partyCond = f.partyId ? Prisma.sql`and e."partyId" = ${f.partyId}` : Prisma.empty;
  const curCond = f.currencyCode ? Prisma.sql`and e."currencyCode" = ${f.currencyCode}` : Prisma.empty;
  const [ledger, docLines] = await Promise.all([
    db.$queryRaw<
      {
        party_id: string;
        party_name: string;
        currency: string;
        open_fc: Prisma.Decimal;
        open_inr: Prisma.Decimal;
        sales_fc: Prisma.Decimal;
        sales_inr: Prisma.Decimal;
        returns_inr: Prisma.Decimal;
        reclass_inr: Prisma.Decimal;
        close_fc: Prisma.Decimal;
        close_inr: Prisma.Decimal;
        close_a: Prisma.Decimal;
        close_r: Prisma.Decimal;
      }[]
    >(Prisma.sql`
      with e as (
        select e.*, ${BDATE} bdate, coalesce(o.kind, e.kind) base_kind
        from clearing_entries e join vouchers v on v.id = e."voucherId"
        left join clearing_entries o on o.id = e."reversalOfEntryId"
        where true ${partyCond} ${curCond}
      )
      select e."partyId" party_id, p.name party_name, e."currencyCode" currency,
             coalesce(sum("fcAmount") filter (where bdate < ${f.dateFrom}::date), 0) open_fc,
             coalesce(sum("inrAmount") filter (where bdate < ${f.dateFrom}::date), 0) open_inr,
             coalesce(sum("fcAmount") filter (where base_kind = 'SALE' and bdate between ${f.dateFrom}::date and ${f.dateTo}::date), 0) sales_fc,
             coalesce(sum("inrAmount") filter (where base_kind = 'SALE' and bdate between ${f.dateFrom}::date and ${f.dateTo}::date), 0) sales_inr,
             coalesce(-sum("inrAmount") filter (where base_kind = 'SALE_RETURN' and bdate between ${f.dateFrom}::date and ${f.dateTo}::date), 0) returns_inr,
             coalesce(sum("inrAmount") filter (where base_kind = 'RECLASSIFY' and bdate between ${f.dateFrom}::date and ${f.dateTo}::date), 0) reclass_inr,
             coalesce(sum("fcAmount") filter (where bdate <= ${f.dateTo}::date), 0) close_fc,
             coalesce(sum("inrAmount") filter (where bdate <= ${f.dateTo}::date), 0) close_inr,
             coalesce(sum("inrAmount") filter (where bdate <= ${f.dateTo}::date and bucket = 'AVAILABLE'), 0) close_a,
             coalesce(sum("inrAmount") filter (where bdate <= ${f.dateTo}::date and bucket = 'RESERVE'), 0) close_r
      from e join parties p on p.id = e."partyId"
      group by 1, 2, 3 order by 2, 3`),
    // Document figures with sign: +1 when posted in the period, −1 when its reversal falls in the period.
    db.$queryRaw<{ party_id: string; currency: string; line_type: string | null; direction: string | null; inr: Prisma.Decimal; received: Prisma.Decimal; fx: Prisma.Decimal; reserve: Prisma.Decimal; unallocated: Prisma.Decimal }[]>(Prisma.sql`
      with d as (
        select d.*, 1 sgn from clearing_documents d where d."documentDate" between ${f.dateFrom}::date and ${f.dateTo}::date
        union all
        select d.*, -1 from clearing_documents d join vouchers rv on rv.id = d."reversalVoucherId"
        where ((rv.date + interval '330 minutes')::date) between ${f.dateFrom}::date and ${f.dateTo}::date
      )
      select d."partyId" party_id, d."currencyCode" currency, l."lineType"::text line_type, l.direction::text direction,
             coalesce(sum(d.sgn * l."inrAmount"), 0) inr, 0 received, 0 fx, 0 reserve, 0 unallocated
      from d join clearing_document_lines l on l."documentId" = d.id
      where d.kind = 'SETTLEMENT' ${f.partyId ? Prisma.sql`and d."partyId" = ${f.partyId}` : Prisma.empty} ${f.currencyCode ? Prisma.sql`and d."currencyCode" = ${f.currencyCode}` : Prisma.empty}
      group by 1, 2, 3, 4
      union all
      select d."partyId", d."currencyCode", null, null, 0,
             coalesce(sum(d.sgn * d."receivedInr") filter (where d.kind = 'SETTLEMENT'), 0),
             coalesce(sum(d.sgn * d."fxDifferenceInr"), 0),
             coalesce(sum(d.sgn * d."reserveInr"), 0),
             coalesce(sum(d."availableFc" - coalesce((select sum(a."fcAmount") from clearing_allocations a where a."documentId" = d.id and a.status = 'ACTIVE'), 0))
                      filter (where d.sgn = 1 and d.kind = 'SETTLEMENT' and d.status = 'POSTED'), 0)
      from d where true ${f.partyId ? Prisma.sql`and d."partyId" = ${f.partyId}` : Prisma.empty} ${f.currencyCode ? Prisma.sql`and d."currencyCode" = ${f.currencyCode}` : Prisma.empty}
      group by 1, 2`),
  ]);
  return ledger.map((l) => {
    const mine = docLines.filter((x) => x.party_id === l.party_id && x.currency === l.currency);
    const sumLines = (types: ClearingLineType[]) =>
      round2(mine.filter((x) => x.line_type && types.includes(x.line_type as ClearingLineType)).reduce((s, x) => s.plus(x.direction === "ADDITION" ? new Decimal(x.inr).negated() : x.inr), ZERO));
    const totals = mine.filter((x) => x.line_type === null);
    const sumOf = (k: "received" | "fx" | "reserve" | "unallocated") => totals.reduce((s, x) => s.plus(x[k]), ZERO);
    return {
      partyId: l.party_id,
      partyName: l.party_name,
      currencyCode: l.currency,
      openingFc: d4(l.open_fc),
      openingInr: d2(l.open_inr),
      grossSalesInr: d2(l.sales_inr),
      grossSalesFc: d4(l.sales_fc),
      returnsInr: d2(l.returns_inr),
      payoutsInr: round2(sumOf("received")),
      feesInr: sumLines(FEES),
      marketingInr: sumLines(["ADVERTISING"]),
      refundsInr: sumLines(["REFUND"]),
      taxesInr: sumLines(TAXES),
      reserveNetInr: round2(sumOf("reserve")),
      fxInr: round2(sumOf("fx")),
      otherInr: sumLines(["OTHER"]),
      reclassifiedInr: d2(l.reclass_inr),
      unallocatedFc: d4(sumOf("unallocated")),
      closingFc: d4(l.close_fc),
      closingInr: d2(l.close_inr),
      closingAvailableInr: d2(l.close_a),
      closingReserveInr: d2(l.close_r),
    };
  });
}

/** Sub-ledger vs ledger, per party (reconciliation). Empty = all agree. */
export async function clearingReconciliation(db: Db = prisma) {
  return db.$queryRaw<{ party_id: string; party_name: string; bucket: string; ledger: Prisma.Decimal; subledger: Prisma.Decimal }[]>(Prisma.sql`
    with l as (
      select j."partyId" party_id, case a.code when '1150' then 'AVAILABLE' else 'RESERVE' end bucket, sum(j.debit - j.credit) amt
      from journal_entries j join accounts a on a.id = j."accountId" where a.code in ('1150', '1160') group by 1, 2
    ),
    s as (select "partyId" party_id, bucket::text bucket, sum("inrAmount") amt from clearing_entries group by 1, 2)
    select coalesce(l.party_id, s.party_id) party_id, p.name party_name, coalesce(l.bucket, s.bucket) bucket,
           coalesce(l.amt, 0) ledger, coalesce(s.amt, 0) subledger
    from l full join s on s.party_id is not distinct from l.party_id and s.bucket = l.bucket
    left join parties p on p.id = coalesce(l.party_id, s.party_id)
    where coalesce(l.amt, 0) <> coalesce(s.amt, 0)`);
}

/** Clearing sales of a provider/currency that still have an unallocated amount (for the optional allocation). */
export async function allocatableSales(partyId: string, currencyCode: string, db: Db = prisma) {
  return db.$queryRaw<{ voucher_id: string; voucher_number: string; bdate: Date; sale_fc: Prisma.Decimal; open_fc: Prisma.Decimal }[]>(Prisma.sql`
    with s as (
      select e."voucherId" voucher_id, v."voucherNumber" voucher_number, ${BDATE} bdate, e."fcAmount" sale_fc,
             coalesce((select sum(r."fcAmount") from clearing_entries r join finished_jewellery_returns fr on fr."voucherId" = r."voucherId"
                       join finished_jewellery_sales fs on fs.id = fr."saleId" where fs."voucherId" = e."voucherId"), 0) returned,
             coalesce((select sum(a."fcAmount") from clearing_allocations a where a."saleVoucherId" = e."voucherId" and a.status = 'ACTIVE'), 0) allocated
      from clearing_entries e join vouchers v on v.id = e."voucherId"
      where e.kind = 'SALE' and e."partyId" = ${partyId} and e."currencyCode" = ${currencyCode} and v.status = 'POSTED'
    )
    select voucher_id, voucher_number, bdate, sale_fc, sale_fc + returned - allocated open_fc from s
    where sale_fc + returned - allocated > 0 order by bdate, voucher_number`);
}

/** SALE vouchers of clearing parties that were paid straight into Cash/Bank and not yet reclassified. */
export async function reclassifyCandidates(db: Db = prisma) {
  return db.$queryRaw<{ voucher_id: string; voucher_number: string; bdate: Date; party_name: string; amount: Prisma.Decimal; account_name: string }[]>(Prisma.sql`
    select v.id voucher_id, v."voucherNumber" voucher_number, ${BDATE} bdate, p.name party_name, v.amount, pa.name account_name
    from vouchers v join parties p on p.id = v."partyId" join payment_accounts pa on pa.id = v."paymentAccountId"
    where v."voucherType" = 'SALE' and v.status = 'POSTED' and p."clearingEnabled"
      and not exists (select 1 from clearing_documents d where d."sourceVoucherId" = v.id and d.status = 'POSTED')
    order by v.date, v."voucherNumber"`);
}
