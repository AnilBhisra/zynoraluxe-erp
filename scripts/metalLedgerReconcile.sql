-- READ-ONLY metal ledger reconciliation, one line per account:
--   code|ledger|records|difference
-- 1300 Metal Inventory      vs usable stock of every metal + purity
-- 1310 Scrap Metal          vs scrap stock
-- 1320 Jewellery WIP        vs open jobs' metal/alloy WIP + unresolved stones
--                              + unallocated Karigar custody (0 before the custody migration)
-- 1330 Finished Jewellery   vs AVAILABLE pieces at authoritative cost (metal + diamond + labour)
-- 1340 Customer Jewellery   vs Company cost in Customer-owned pieces awaiting delivery
--                              (only once account 1340 exists: 4 lines before the Customer Gold migration, 5 after)
-- CGCR Customer gold credit  (Phase 8C, a 6th line, same 4-field shape): Accounts Payable lines of every
--                              Customer Gold purchase/exchange voucher (+ its reversal) and of every bill's
--                              "Gold-purchase credit applied" lines (+ their reversals), against the records:
--                              approved value of live purchases − credit applied by live bills.
--                              Needs the Customer Gold tables (production has them since 027a8a2); the
--                              purchase status is read through row_to_json so the line also runs, unchanged,
--                              before the Old Gold Exchange migration (every purchase then counts as live).
-- Posted revaluations are added to the pool/WIP/finished figure they restate.
-- Works before and after the custody migration: movement types are compared
-- as text and no custody column is referenced. The transaction is READ ONLY.
begin transaction read only;
with eff as (
  select m."costValue", case m.type::text
      when 'PURCHASE_IN' then 1 when 'OPENING_IN' then 1 when 'ISSUE_OUT' then -1 when 'ISSUE_CANCEL_IN' then 1
      when 'RETURN_IN' then 1 when 'ADJUSTMENT_IN' then 1 when 'ADJUSTMENT_OUT' then -1
      when 'KARIGAR_ISSUE_OUT' then -1 when 'KARIGAR_RETURN_IN' then 1 else 0 end as u,
    case m.type::text when 'SCRAP_RETURN_IN' then 1 when 'SCRAP_ADJUSTMENT_IN' then 1 when 'SCRAP_ADJUSTMENT_OUT' then -1 else 0 end as s,
    case m.type::text when 'KARIGAR_ISSUE_OUT' then 1 when 'KARIGAR_RETURN_IN' then -1 when 'CUSTODY_TO_JOB' then -1 when 'JOB_TO_CUSTODY' then 1 else 0 end as k
  from metal_stock_movements m
),
reval as (
  select r.target::text as target, sum(r."deltaCostValue") as d
  from metal_revaluations r join corrections c on c.id = r."correctionId" where c.state = 'POSTED' group by 1
),
led as (
  select a.code, round(coalesce(sum(j.debit), 0) - coalesce(sum(j.credit), 0), 2) as bal
  from accounts a left join journal_entries j on j."accountId" = a.id
  where a.code in ('1300', '1310', '1320', '1330', '1340') group by a.code
),
jobs as (select * from jewellery_jobs where status <> 'CANCELLED'),
rec as (
  select '1300' as code, (select coalesce(sum(u * "costValue"), 0) from eff) + coalesce((select d from reval where target = 'USABLE_POOL'), 0) as expected
  union all select '1310', (select coalesce(sum(s * "costValue"), 0) from eff) + coalesce((select d from reval where target = 'SCRAP_POOL'), 0)
  union all select '1320',
      (select coalesce(sum("remainingWipCost" + "remainingAlloyWipCost"), 0) from jobs)
    + (select coalesce(sum(l."costAtIssue"), 0) from jewellery_diamond_issue_lines l join jobs on jobs.id = l."jobId" where l."resolvedAs" is null)
    + (select coalesce(sum(l."costAtIssue" - l."setCost" - l."returnedCost" - l."damagedCost"), 0) from jewellery_packet_issue_lines l join jobs on jobs.id = l."jobId")
    + coalesce((select d from reval where target = 'JOB_WIP'), 0)
    + (select coalesce(sum(k * "costValue"), 0) from eff)
  union all select '1330',
      (select coalesce(sum("metalCost" + "diamondCost" + "labourAllocated"), 0) from finished_jewellery where status::text = 'AVAILABLE')
    + coalesce((select d from reval where target = 'FINISHED_JEWELLERY'), 0)
  -- Customer Gold (reported only once account 1340 exists): Company cost in
  -- Customer-owned pieces awaiting delivery. Status compared as text so this
  -- script also runs, unchanged, on a database without that status value.
  union all select '1340',
      (select coalesce(sum("metalCost" + "diamondCost" + "labourAllocated"), 0) from finished_jewellery where status::text = 'CUSTOMER_AWAITING_DELIVERY')
)
select led.code || '|' || led.bal || '|' || round(rec.expected, 2) || '|' || round(led.bal - rec.expected, 2)
from led join rec on rec.code = led.code order by led.code;
with ap as (select id from accounts where code = '2000'),
p as (
  select p.*, coalesce(row_to_json(p)->>'status', 'POSTED') as st, row_to_json(p)->>'reversalVoucherId' as rv, mp."voucherId" as pv
  from customer_gold_purchases p join metal_purchases mp on mp.id = p."metalPurchaseId"
),
b as (select * from customer_jewellery_bills),
ledger as (
  select coalesce((select sum(j.credit - j.debit) from journal_entries j join p on j."voucherId" in (p.pv, p.rv) and j."partyId" = p."customerId"
                   where j."accountId" = (select id from ap)), 0)
       + coalesce((select sum(j.credit - j.debit) from journal_entries j join b on j."voucherId" in (b."voucherId", b."reversalVoucherId") and j."partyId" = b."customerId"
                   where j."accountId" = (select id from ap) and j.description like '%Gold-purchase credit applied%'), 0) as bal
),
records as (
  select coalesce((select sum("approvedValue") from p where st = 'POSTED'), 0)
       - coalesce((select sum("creditApplied") from b where status::text = 'POSTED'), 0) as expected
)
select 'CGCR|' || round(ledger.bal, 2) || '|' || round(records.expected, 2) || '|' || round(ledger.bal - records.expected, 2) from ledger, records;
rollback;
