-- READ-ONLY metal ledger reconciliation, one line per account:
--   code|ledger|records|difference
-- 1300 Metal Inventory      vs usable stock of every metal + purity
-- 1310 Scrap Metal          vs scrap stock
-- 1320 Jewellery WIP        vs open jobs' metal/alloy WIP + unresolved stones
--                              + unallocated Karigar custody (0 before the custody migration)
-- 1330 Finished Jewellery   vs AVAILABLE pieces at authoritative cost (metal + diamond + labour)
-- 1340 Customer Jewellery   vs Company cost in Customer-owned pieces awaiting delivery
--                              (only once account 1340 exists: 4 lines before the Customer Gold migration, 5 after)
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
rollback;
