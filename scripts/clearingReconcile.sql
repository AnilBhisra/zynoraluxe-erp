-- READ-ONLY clearing reconciliation (after migration 20261012090000_clearing_settlement):
-- every party's clearing sub-ledger (clearing_entries, INR) must equal its 1150 / 1160 ledger.
-- Prints party|bucket|ledger|subledger|difference for every party with clearing activity;
-- every difference must be 0.00. The transaction is READ ONLY.
begin transaction read only;
with l as (
  select j."partyId" party_id, case a.code when '1150' then 'AVAILABLE' else 'RESERVE' end bucket, sum(j.debit - j.credit) amt
  from journal_entries j join accounts a on a.id = j."accountId" where a.code in ('1150', '1160') group by 1, 2
),
s as (select "partyId" party_id, bucket::text bucket, sum("inrAmount") amt from clearing_entries group by 1, 2)
select coalesce(p.name, '(no party)') || '|' || coalesce(l.bucket, s.bucket) || '|' || round(coalesce(l.amt, 0), 2) || '|' || round(coalesce(s.amt, 0), 2) || '|' || round(coalesce(l.amt, 0) - coalesce(s.amt, 0), 2)
from l full join s on s.party_id is not distinct from l.party_id and s.bucket = l.bucket
left join parties p on p.id = coalesce(l.party_id, s.party_id)
order by 1;
select 'CLEARING-LINES-WITHOUT-PARTY|' || count(*) from journal_entries j join accounts a on a.id = j."accountId" where a.code in ('1150', '1160') and j."partyId" is null;
rollback;
