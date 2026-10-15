import { Prisma } from "@/generated/prisma/client";
import { Decimal } from "@/lib/accounting/money";

/**
 * Where a job's GOLD came from, derived only from the movement records —
 * never from notes or the job's customer field (a job can name a Customer and
 * still run on Company gold).
 *
 *  - Customer contribution: Customer-owned gold that left the Customer's
 *    safe / Karigar balance for this job's use (allocated to the job, or
 *    consumed straight from the Karigar into its pieces, scrap or loss at
 *    receipt), less what was released back from the job — counting only
 *    entries that are neither reversed nor themselves reversals (a receipt
 *    reversal therefore removes its consumption).
 *  - Company contribution: the job's GOLD metal issue lines (direct issue,
 *    Karigar Metal allocation or job-to-job transfer; a reversed custody
 *    allocation deletes its line) less active Karigar Metal releases.
 *  - A cancelled job's issues were reversed, so it contributes nothing.
 *  - Alloy, silver, platinum, diamonds, packets and other material are never
 *    gold. Customer gold counts by weight even though its Company cost is ₹0.
 *
 * "Review required" when the records cannot tell: a Customer-owned piece with
 * no Customer gold recorded, or a live receipt with no metal recorded at all
 * (a silver / platinum job is simply "No Gold").
 */
export { GOLD_SOURCE_LABELS, GOLD_SOURCES, isGoldSource, type GoldSource } from "@/lib/jewellery/jobGoldSourceLabels";
import type { GoldSource } from "@/lib/jewellery/jobGoldSourceLabels";

export type GoldContribution = {
  customerFine: Decimal;
  companyFine: Decimal;
  cancelled: boolean;
  hasLiveReceipt: boolean;
  hasCustomerPiece: boolean;
  /** Silver / platinum issued: a receipt without gold is then explained. */
  hasNonGoldMetal?: boolean;
};

export function classifyGoldSource(c: GoldContribution): GoldSource {
  if (c.cancelled) return "NONE";
  const customer = c.customerFine.greaterThan(0);
  const company = c.companyFine.greaterThan(0);
  if (customer && company) return "MIXED";
  if (customer) return "CUSTOMER";
  if (company) return "COMPANY";
  if (c.hasCustomerPiece || (c.hasLiveReceipt && !c.hasNonGoldMetal)) return "REVIEW";
  return "NONE";
}

type Db = Pick<Prisma.TransactionClient, "$queryRaw">;

/** Gold source of many jobs in ONE query (no per-job queries). */
export async function goldSourcesForJobs(db: Db, jobIds: string[]): Promise<Map<string, GoldSource>> {
  const out = new Map<string, GoldSource>();
  if (jobIds.length === 0) return out;
  const rows = await db.$queryRaw<
    { id: string; cancelled: boolean; customer_fine: Prisma.Decimal; company_fine: Prisma.Decimal; live_receipt: boolean; customer_piece: boolean; non_gold: boolean }[]
  >(Prisma.sql`
    with jobs as (select id, status::text = 'CANCELLED' cancelled from jewellery_jobs where id = any(${jobIds}::text[])),
    cg as (
      select e."jobId" job_id,
             sum(case when e."fromLocation"::text in ('CUSTOMER','SAFE','KARIGAR') and e."toLocation"::text in ('JOB','FINISHED','SCRAP','LOSS') then e."fineWeight"
                      when e."fromLocation"::text = 'JOB' and e."toLocation"::text in ('CUSTOMER','SAFE','KARIGAR') then -e."fineWeight" else 0 end) fine
      from customer_gold_entries e
      where e."jobId" = any(${jobIds}::text[]) and e."metalType"::text = 'GOLD' and e."reversalOfEntryId" is null
        and not exists (select 1 from customer_gold_entries r where r."reversalOfEntryId" = e.id)
      group by 1
    ),
    issued as (
      select "jobId" job_id, sum("fineWeight") fine from jewellery_metal_issue_lines
      where "jobId" = any(${jobIds}::text[]) and "metalType"::text = 'GOLD' group by 1
    ),
    released as (
      select c."jobId" job_id, sum(c."fineWeight") fine from karigar_metal_custody_entries c
      where c."jobId" = any(${jobIds}::text[]) and c.kind::text = 'RELEASE_FROM_JOB' and c."metalType"::text = 'GOLD' and c."reversalOfEntryId" is null
        and not exists (select 1 from karigar_metal_custody_entries r where r."reversalOfEntryId" = c.id)
      group by 1
    )
    select j.id, j.cancelled,
           coalesce(cg.fine, 0) customer_fine,
           coalesce(issued.fine, 0) - coalesce(released.fine, 0) company_fine,
           exists (select 1 from jewellery_receipts r where r."jobId" = j.id and r."reversedAt" is null) live_receipt,
           exists (select 1 from finished_jewellery f where f."jobId" = j.id and f.ownership::text = 'CUSTOMER' and f.status::text <> 'RECEIPT_REVERSED') customer_piece,
           exists (select 1 from jewellery_metal_issue_lines l where l."jobId" = j.id and l."metalType"::text not in ('GOLD','ALLOY')) non_gold
    from jobs j left join cg on cg.job_id = j.id left join issued on issued.job_id = j.id left join released on released.job_id = j.id`);
  for (const r of rows) {
    out.set(
      r.id,
      classifyGoldSource({
        customerFine: new Decimal(r.customer_fine),
        companyFine: new Decimal(r.company_fine),
        cancelled: r.cancelled,
        hasLiveReceipt: r.live_receipt,
        hasCustomerPiece: r.customer_piece,
        hasNonGoldMetal: r.non_gold,
      })
    );
  }
  return out;
}
