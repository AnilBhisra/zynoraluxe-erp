import "server-only";

import { Prisma } from "@/generated/prisma/client";
import type { PartyType } from "@/generated/prisma/enums";
import { indiaToday } from "@/lib/accounting/financialYear";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";

/**
 * Receivable & Payable — a PARTY-LEVEL LIVE BALANCE (payments are not
 * allocated to individual bills or invoices in this system).
 *
 * The two control accounts are kept apart, so a party with both sides never
 * has one obligation silently netted against the other:
 *   receivableSide = Σ(Dr − Cr) of the party's lines on 1100 Accounts Receivable
 *   payableSide    = Σ(Cr − Dr) of the party's lines on 2000 Accounts Payable
 *   net            = receivableSide − payableSide          (+ = owed to us)
 *
 * Groups (a party can be in two):
 *   A Receivable / લેવાનું   receivableSide > 0
 *   B Payable / આપવાનું      payableSide > 0
 *   C Advance paid           payableSide < 0  (paid a supplier/karigar more than billed)
 *   D Customer credit        receivableSide < 0  (received more than billed)
 * so   Σ receivableSide = receivable − customerCredit = the 1100 control balance
 *      Σ payableSide    = payable − advancesPaid     = −(the 2000 control balance)
 * exactly, and none of it depends on a party's type (type only words the label).
 *
 * Every 1100/2000 line falls in exactly one column, so for every party
 *   billed − charged − received + given + adjustments = net:
 *   adjustments  REVERSAL lines, and gold-purchase credit applied on a
 *                Customer Jewellery Bill (Dr 2000 / Cr 1100 inside the bill)
 *   received     a credit on a voucher that brought money INTO Cash/Bank
 *   given        a debit on a voucher that paid money OUT of Cash/Bank
 *   billed       any other debit (sales, bills, opening receivable …)
 *   charged      any other credit (purchases, Karigar/Manufacturer charges,
 *                gold bought from a Customer, corrections …)
 *
 * "Oldest outstanding" is a first-in-first-out estimate per side (no
 * allocation records exist): settlements are applied to the oldest charge.
 *
 * Three queries in all, whatever the number of parties or lines.
 */

type Db = Pick<Prisma.TransactionClient, "$queryRaw">;

export type LastPayment = { date: string; amount: Decimal; voucherNumber: string; voucherId: string };

export type PartyPosition = {
  partyId: string;
  name: string;
  type: PartyType;
  isActive: boolean;
  receivableSide: Decimal;
  payableSide: Decimal;
  net: Decimal;
  billed: Decimal;
  charged: Decimal;
  received: Decimal;
  given: Decimal;
  adjustments: Decimal;
  oldestReceivableDate: string | null;
  oldestPayableDate: string | null;
  lastReceived: LastPayment | null;
  lastPaid: LastPayment | null;
};

export type ReceivablePayableTotals = {
  receivable: Decimal;
  payable: Decimal;
  advancesPaid: Decimal;
  customerCredit: Decimal;
  /** receivable − customerCredit − payable + advancesPaid = 1100 + 2000 control balances (Dr − Cr). */
  net: Decimal;
};

export type ReceivablePayableBook = {
  asOf: string;
  parties: PartyPosition[];
  receivable: PartyPosition[];
  payable: PartyPosition[];
  advancePaid: PartyPosition[];
  customerCredit: PartyPosition[];
  totals: ReceivablePayableTotals;
};

const BUSINESS_DATE = Prisma.sql`((v.date + interval '330 minutes')::date)`;
const dec = (v: Prisma.Decimal | null | undefined) => round2(new Decimal(v ?? 0));
const iso = (d: Date) => new Date(d).toISOString().slice(0, 10);

export function totalsOf(parties: Pick<PartyPosition, "receivableSide" | "payableSide">[]): ReceivablePayableTotals {
  let receivable = ZERO;
  let payable = ZERO;
  let advancesPaid = ZERO;
  let customerCredit = ZERO;
  for (const p of parties) {
    if (p.receivableSide.greaterThan(0)) receivable = receivable.plus(p.receivableSide);
    if (p.receivableSide.lessThan(0)) customerCredit = customerCredit.plus(p.receivableSide.abs());
    if (p.payableSide.greaterThan(0)) payable = payable.plus(p.payableSide);
    if (p.payableSide.lessThan(0)) advancesPaid = advancesPaid.plus(p.payableSide.abs());
  }
  return {
    receivable: round2(receivable),
    payable: round2(payable),
    advancesPaid: round2(advancesPaid),
    customerCredit: round2(customerCredit),
    net: round2(receivable.minus(customerCredit).minus(payable).plus(advancesPaid)),
  };
}

/**
 * First-in-first-out over one side's lines (already in book order): `charge`
 * increases what is owed, the opposite direction settles the oldest charge
 * first. Returns the date of the oldest charge still (partly) open, or null.
 */
export function oldestOpenCharge(lines: { date: string; charge: Decimal; settle: Decimal }[]): string | null {
  const open: { date: string; left: Decimal }[] = [];
  let credit = ZERO; // settlements beyond every charge so far (an advance on this side)
  for (const l of lines) {
    let charge = l.charge;
    if (charge.greaterThan(0) && credit.greaterThan(0)) {
      const used = Decimal.min(charge, credit);
      charge = charge.minus(used);
      credit = credit.minus(used);
    }
    if (charge.greaterThan(0)) open.push({ date: l.date, left: charge });
    let settle = l.settle;
    while (settle.greaterThan(0) && open.length > 0) {
      const used = Decimal.min(settle, open[0].left);
      open[0].left = open[0].left.minus(used);
      settle = settle.minus(used);
      if (open[0].left.isZero()) open.shift();
    }
    if (settle.greaterThan(0)) credit = credit.plus(settle);
  }
  return open[0]?.date ?? null;
}

export async function getReceivablePayableBook(opts: { partyId?: string } = {}, db: Db = prisma): Promise<ReceivablePayableBook> {
  const onlyParty = opts.partyId ? Prisma.sql`and j."partyId" = ${opts.partyId}` : Prisma.empty;
  const onlyVoucherParty = opts.partyId ? Prisma.sql`and v."partyId" = ${opts.partyId}` : Prisma.empty;

  const [aggregates, lines, lastPayments] = await Promise.all([
    db.$queryRaw<
      {
        party_id: string;
        name: string;
        type: PartyType;
        is_active: boolean;
        ar_side: Prisma.Decimal;
        ap_side: Prisma.Decimal;
        billed: Prisma.Decimal;
        charged: Prisma.Decimal;
        received: Prisma.Decimal;
        given: Prisma.Decimal;
        adjustments: Prisma.Decimal;
      }[]
    >(Prisma.sql`
      with cash as (
        select j."voucherId" voucher_id, bool_or(j.debit > 0) cash_in, bool_or(j.credit > 0) cash_out
        from journal_entries j join payment_accounts pa on pa."accountId" = j."accountId"
        group by 1
      ),
      ctl as (
        select j."partyId" party_id, a.code, j.debit, j.credit,
               case
                 when v."voucherType" = 'REVERSAL' then 'ADJ'
                 when v."voucherType" = 'CUSTOMER_JEWELLERY_BILL' and ((a.code = '2000' and j.debit > 0) or (a.code = '1100' and j.credit > 0)) then 'ADJ'
                 when j.credit > 0 and coalesce(c.cash_in, false) then 'RECEIVED'
                 when j.debit > 0 and coalesce(c.cash_out, false) then 'GIVEN'
                 when j.debit > 0 then 'BILLED'
                 else 'CHARGED'
               end cat
        from journal_entries j
        join accounts a on a.id = j."accountId"
        join vouchers v on v.id = j."voucherId"
        left join cash c on c.voucher_id = v.id
        where a.code in ('1100', '2000') and j."partyId" is not null ${onlyParty}
      )
      select p.id party_id, p.name, p.type::text type, p."isActive" is_active,
             coalesce(sum(case when code = '1100' then debit - credit end), 0) ar_side,
             coalesce(sum(case when code = '2000' then credit - debit end), 0) ap_side,
             coalesce(sum(debit) filter (where cat = 'BILLED'), 0) billed,
             coalesce(sum(credit) filter (where cat = 'CHARGED'), 0) charged,
             coalesce(sum(credit) filter (where cat = 'RECEIVED'), 0) received,
             coalesce(sum(debit) filter (where cat = 'GIVEN'), 0) given,
             coalesce(sum(debit - credit) filter (where cat = 'ADJ'), 0) adjustments
      from ctl join parties p on p.id = ctl.party_id
      group by p.id, p.name, p.type, p."isActive"
      order by p.name, p.id`),
    db.$queryRaw<{ party_id: string; code: string; bdate: Date; debit: Prisma.Decimal; credit: Prisma.Decimal }[]>(Prisma.sql`
      select j."partyId" party_id, a.code, ${BUSINESS_DATE} bdate, j.debit, j.credit
      from journal_entries j join accounts a on a.id = j."accountId" join vouchers v on v.id = j."voucherId"
      where a.code in ('1100', '2000') and j."partyId" is not null ${onlyParty}
      order by j."partyId", a.code, ${BUSINESS_DATE}, v."createdAt", v."voucherNumber", j.id`),
    db.$queryRaw<{ party_id: string; dir: "IN" | "OUT"; bdate: Date; amount: Prisma.Decimal; voucher_number: string; voucher_id: string }[]>(Prisma.sql`
      select distinct on (v."partyId", m.dir) v."partyId" party_id, m.dir, d.bdate, m.amount, v."voucherNumber" voucher_number, v.id voucher_id
      from (
        select j."voucherId", case when j.debit > 0 then 'IN' else 'OUT' end dir, j.debit + j.credit amount
        from journal_entries j join payment_accounts pa on pa."accountId" = j."accountId"
      ) m
      join vouchers v on v.id = m."voucherId"
      cross join lateral (select ${BUSINESS_DATE} bdate) d
      where v."partyId" is not null and v.status = 'POSTED' and v."voucherType" <> 'REVERSAL' ${onlyVoucherParty}
      order by v."partyId", m.dir, d.bdate desc, v."createdAt" desc, v."voucherNumber" desc`),
  ]);

  // FIFO oldest-open charge per party and side.
  const bySide = new Map<string, { date: string; charge: Decimal; settle: Decimal }[]>();
  for (const l of lines) {
    const k = `${l.party_id}|${l.code}`;
    const debit = new Decimal(l.debit);
    const credit = new Decimal(l.credit);
    // 1100: a debit is a charge to the party; 2000: a credit is a charge by the party.
    const entry = l.code === "1100" ? { date: iso(l.bdate), charge: debit, settle: credit } : { date: iso(l.bdate), charge: credit, settle: debit };
    const list = bySide.get(k);
    if (list) list.push(entry);
    else bySide.set(k, [entry]);
  }
  const last = new Map<string, LastPayment>();
  for (const r of lastPayments) {
    last.set(`${r.party_id}|${r.dir}`, { date: iso(r.bdate), amount: dec(r.amount), voucherNumber: r.voucher_number, voucherId: r.voucher_id });
  }

  const parties: PartyPosition[] = aggregates.map((a) => {
    const receivableSide = dec(a.ar_side);
    const payableSide = dec(a.ap_side);
    return {
      partyId: a.party_id,
      name: a.name,
      type: a.type,
      isActive: a.is_active,
      receivableSide,
      payableSide,
      net: round2(receivableSide.minus(payableSide)),
      billed: dec(a.billed),
      charged: dec(a.charged),
      received: dec(a.received),
      given: dec(a.given),
      adjustments: dec(a.adjustments),
      oldestReceivableDate: receivableSide.greaterThan(0) ? oldestOpenCharge(bySide.get(`${a.party_id}|1100`) ?? []) : null,
      oldestPayableDate: payableSide.greaterThan(0) ? oldestOpenCharge(bySide.get(`${a.party_id}|2000`) ?? []) : null,
      lastReceived: last.get(`${a.party_id}|IN`) ?? null,
      lastPaid: last.get(`${a.party_id}|OUT`) ?? null,
    };
  });

  const byAmount = (pick: (p: PartyPosition) => Decimal) => (x: PartyPosition, y: PartyPosition) =>
    pick(y).comparedTo(pick(x)) || x.name.localeCompare(y.name);
  return {
    asOf: indiaToday(),
    parties,
    receivable: parties.filter((p) => p.receivableSide.greaterThan(0)).sort(byAmount((p) => p.receivableSide)),
    payable: parties.filter((p) => p.payableSide.greaterThan(0)).sort(byAmount((p) => p.payableSide)),
    advancePaid: parties.filter((p) => p.payableSide.lessThan(0)).sort(byAmount((p) => p.payableSide.abs())),
    customerCredit: parties.filter((p) => p.receivableSide.lessThan(0)).sort(byAmount((p) => p.receivableSide.abs())),
    totals: totalsOf(parties),
  };
}

/** Whole days from `date` to `asOf` (India dates). */
export function daysBetween(date: string, asOf: string): number {
  return Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
}
