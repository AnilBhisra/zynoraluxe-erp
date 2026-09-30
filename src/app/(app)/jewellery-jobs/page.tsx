import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { HelpLink } from "@/components/help/HelpLink";
import {
  getJewelleryJobDetail,
  getKarigarJewelleryMaterialBalances,
  getMetalStockSummary,
  listFinishedJewelleryStock,
  listFinishedJewellerySalesForManagement,
  listJewelleryJobs,
  listMetalPurchases,
  listMetalPurities,
} from "@/lib/jewellery/reports";
import { listPolishedDiamonds } from "@/lib/diamond/reports";
import { resolveJewelleryAssetUrl } from "@/lib/storage/jewelleryMedia";
import { ownerOnly } from "@/lib/security/ownerOnly";
import { serializeJobCostSummary, serializeJobPacketLines } from "@/lib/jewellery/jobDetailSerializers";
import { JobsTab, type SerializedJewelleryJob } from "@/components/jewellery/JobsTab";
import { JobDetailView, type SerializedJobDetail } from "@/components/jewellery/JobDetailView";
import { getReceiptChargePanels } from "@/lib/jewellery/receiptChargePanels";
import { getMetalTransferPanel } from "@/lib/jewellery/metalTransferPanels";
import { listReceiptCustodySources } from "@/lib/jewellery/receiptCustody";
import { MetalStockTab, type SerializedMetalStockBucket, type SerializedMetalPurchase } from "@/components/jewellery/MetalStockTab";
import { FinishedStockTab, type SerializedFinishedStockRow } from "@/components/jewellery/FinishedStockTab";
import { FinishedSalesManager, type SerializedFinishedSale } from "@/components/jewellery/FinishedSalesManager";
import type { PurityOption } from "@/components/jewellery/CreateJobForm";
import type { AvailablePacketOption, AvailablePolishedDiamondOption } from "@/components/jewellery/IssueMaterialsForm";
import type { PendingPacketOption } from "@/components/jewellery/ReceiveFinishedForm";
import { listJobPacketLines, listPolishedPackets } from "@/lib/diamond/packetReports";
import { listMetalAdjustments } from "@/lib/jewellery/adjustmentHistory";
import { formatCarryingAmount } from "@/lib/jewellery/carryingCost";
import { shapeLabel } from "@/lib/diamond/shapes";
import type { MetalPurityOption } from "@/components/jewellery/ReceiveFinishedForm";
import type { FinishedJewelleryStockStatus, JewelleryJobStatus } from "@/generated/prisma/enums";
import { getKarigarMetalAccount, listKarigarCustodySummaries, reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { KarigarMetalAccountView, type CustodyKind, type IssuePurityOption } from "@/components/jewellery/KarigarMetalAccountView";
import { CustomerGoldTab } from "@/components/jewellery/CustomerGoldTab";
import { getJobCustomerGoldPanel } from "@/lib/jewellery/customerGoldJobPanel";
import {
  customerGoldExceptions,
  customerGoldReconciliation,
  customerGoldStatement,
  customerJewelleryAwaitingDelivery,
  jobWiseCustomerGold,
  karigarWiseCustomerGold,
} from "@/lib/jewellery/customerGoldReports";

export const metadata: Metadata = {
  title: "Jewellery Jobs · ZYNORALUXE",
};

// Every cost / carrying-value / Karigar-payable figure below goes through
// ownerOnly() on the server: a Staff request's RSC payload must not carry
// those values at all, not merely have them hidden by the client
// components (PHASE_7_CURRENT_STATE_AUDIT.md §4.16).

type SearchParams = {
  tab?: string;
  view?: string;
  jobSearch?: string;
  jobId?: string;
  metalSearch?: string;
  issue?: string;
  finishedSearch?: string;
  finishedStatus?: string;
  saleSearch?: string;
  karigarId?: string;
  custodyOp?: string;
  custodyJobId?: string;
  customerId?: string;
};

const TABS = ["jobs", "karigar", "customer-gold", "metal", "finished"] as const;
type Tab = (typeof TABS)[number];

function TabLink({ tab, label, active }: { tab: Tab; label: string; active: boolean }) {
  return (
    <a
      href={`/jewellery-jobs?tab=${tab}`}
      aria-current={active ? "page" : undefined}
      className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900"
          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      }`}
    >
      {label}
    </a>
  );
}

export default async function JewelleryJobsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";
  const params = await searchParams;
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : "jobs";

  return (
    <div>
      <PageHeader
        title="Jewellery Jobs"
        description="Create jobs, issue metal and diamonds, receive finished jewellery, and track Metal Stock and Finished Stock."
        actions={<HelpLink anchor="metal-jewellery" />}
      />

      <nav aria-label="Jewellery sections" className="mb-6 flex flex-wrap gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5">
        <TabLink tab="jobs" label="Jewellery Jobs" active={tab === "jobs"} />
        <TabLink tab="karigar" label="Karigar Metal" active={tab === "karigar"} />
        <TabLink tab="customer-gold" label="Customer Gold" active={tab === "customer-gold"} />
        <TabLink tab="metal" label="Metal Stock" active={tab === "metal"} />
        <TabLink tab="finished" label="Finished Stock" active={tab === "finished"} />
      </nav>

      {tab === "jobs" ? (
        <JobsTabContent
          search={params.jobSearch ?? ""}
          view={params.view ?? "PENDING"}
          jobId={params.jobId ?? ""}
          isOwner={isOwner}
          initialShowForm={params.issue === "1"}
        />
      ) : null}
      {tab === "karigar" ? (
        <KarigarTabContent
          karigarId={params.karigarId ?? ""}
          isOwner={isOwner}
          op={CUSTODY_KINDS.includes(params.custodyOp as CustodyKind) ? (params.custodyOp as CustodyKind) : null}
          jobId={params.custodyJobId ?? null}
        />
      ) : null}
      {tab === "customer-gold" ? <CustomerGoldTabContent customerId={params.customerId ?? ""} isOwner={isOwner} /> : null}
      {tab === "metal" ? <MetalTabContent search={params.metalSearch ?? ""} isOwner={isOwner} /> : null}
      {tab === "finished" ? (
        <FinishedTabContent
          search={params.finishedSearch ?? ""}
          status={params.finishedStatus ?? ""}
          saleSearch={params.saleSearch ?? ""}
          isOwner={isOwner}
        />
      ) : null}
    </div>
  );
}

function toPurityOptions(purities: { id: string; metalType: string; displayName: string }[]): PurityOption[] {
  return purities.map((p) => ({ id: p.id, metalType: p.metalType, displayName: p.displayName }));
}

function toMetalPurityOptions(
  purities: { id: string; metalType: string; displayName: string; finenessPercent: unknown }[]
): MetalPurityOption[] {
  return purities.map((p) => ({
    id: p.id,
    metalType: p.metalType,
    displayName: p.displayName,
    finenessPercent: String(p.finenessPercent),
  }));
}

async function JobsTabContent({
  search,
  view,
  jobId,
  isOwner,
  initialShowForm,
}: {
  search: string;
  view: string;
  jobId: string;
  isOwner: boolean;
  initialShowForm?: boolean;
}) {
  const purities = await listMetalPurities();

  if (jobId) {
    const detail = await getJewelleryJobDetail(jobId);
    if (!detail) {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Job not found.</p>;
    }
    const [availableDiamondsRaw, packetRows, jobPacketLines, chargePanels, transferPanel, custodySources, customerGold] = await Promise.all([
      listPolishedDiamonds({ status: "AVAILABLE" }),
      listPolishedPackets(),
      listJobPacketLines(detail.id),
      // Cost data: never fetched for Staff.
      isOwner ? getReceiptChargePanels(detail.id) : Promise.resolve(null),
      isOwner ? getMetalTransferPanel(detail.id) : Promise.resolve(null),
      // The job's own Karigar's unallocated metal, as weights only (no cost,
      // rate or value): Owner and Staff both receive against it.
      listReceiptCustodySources(prisma, detail.id),
      // Customer-owned gold: weights for everyone; money only for the Owner.
      getJobCustomerGoldPanel(prisma, detail.id, { includeValues: isOwner }),
    ]);
    const addedLaterByReceipt = new Map((chargePanels ?? []).map((p) => [p.receiptId, p.addedLaterTotal]));
    // Packet quantities only — no packet cost ever reaches these props.
    const availablePackets: AvailablePacketOption[] = packetRows
      .filter((p) => p.pieces > 0 || p.carat !== "0.000")
      .map((p) => ({
        id: p.id,
        packetCode: p.packetCode,
        label: [
          shapeLabel(p.shape),
          p.sizeLabel,
          p.quality,
          p.colour,
          p.sourceJobCode ? `from ${p.sourceJobCode}` : null,
          p.convertedFromCode ? `was ${p.convertedFromCode}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        pieces: p.pieces,
        carat: p.carat,
      }));
    const pendingPackets: PendingPacketOption[] = jobPacketLines
      .filter((l) => l.pendingPieces > 0 || l.pendingCarat !== "0.000")
      .map((l) => ({
        packetId: l.packetId,
        packetCode: l.packetCode,
        label: `${shapeLabel(l.shape)} · ${l.sizeLabel}`,
        pendingPieces: l.pendingPieces,
        pendingCarat: l.pendingCarat,
      }));
    const availableDiamonds: AvailablePolishedDiamondOption[] = availableDiamondsRaw.map((d) => ({
      id: d.id,
      polishedCode: d.polishedCode,
      shape: d.shape,
      carat: d.carat.toFixed(3),
      allocatedCost: ownerOnly(isOwner, d.allocatedCost.toFixed(2)),
      certificateStatus: d.certificateStatus,
    }));

    const serialized: SerializedJobDetail = {
      id: detail.id,
      jobCode: detail.jobCode,
      customerName: detail.customerName,
      customerReference: detail.customerReference,
      karigarName: detail.karigarName,
      jewelleryType: detail.jewelleryType,
      designName: detail.designName,
      designImageUrl: await resolveJewelleryAssetUrl(detail.designImageAssetId),
      issueDate: detail.issueDate.toISOString(),
      expectedDeliveryDate: detail.expectedDeliveryDate ? detail.expectedDeliveryDate.toISOString() : null,
      status: detail.status,
      jewellerySize: detail.jewellerySize,
      quantity: detail.quantity,
      notes: detail.notes,
      specialInstructions: detail.specialInstructions,
      targetMetalType: detail.targetMetalType,
      targetPurityDisplayName: detail.targetPurityDisplayName,
      targetFinishedWeight: detail.targetFinishedWeight ? detail.targetFinishedWeight.toFixed(3) : null,
      issuedMetalFineWeight: detail.issuedMetalFineWeight.toFixed(3),
      ...serializeJobCostSummary(detail, isOwner),
      remainingWipCost: ownerOnly(isOwner, formatCarryingAmount(detail.remainingWipCost)),
      receivedFineWeight: detail.receivedFineWeight.toFixed(3),
      returnedMetalFineWeight: detail.returnedMetalFineWeight.toFixed(3),
      scrapFineWeight: detail.scrapFineWeight.toFixed(3),
      karigarAddedFineWeight: detail.karigarAddedFineWeight.toFixed(3),
      karigarAddedCost: ownerOnly(isOwner, detail.karigarAddedCost.toFixed(2)),
      issuedAlloyGrossWeight: detail.issuedAlloyGrossWeight.toFixed(3),
      issuedAlloyCost: ownerOnly(isOwner, detail.issuedAlloyCost.toFixed(2)),
      consumedAlloyGrossWeight: detail.consumedAlloyGrossWeight.toFixed(3),
      returnedAlloyGrossWeight: detail.returnedAlloyGrossWeight.toFixed(3),
      remainingAlloyWipCost: ownerOnly(isOwner, detail.remainingAlloyWipCost.toFixed(2)),
      alloyPendingGrossWeight: detail.alloyPendingGrossWeight.toFixed(3),
      pendingFineWeight: detail.pendingFineWeight.toFixed(3),
      karigarId: detail.karigarId,
      custodyAllocatedFineWeight: detail.custodyAllocatedFineWeight.toFixed(3),
      custodyReleasedFineWeight: detail.custodyReleasedFineWeight.toFixed(3),
      canIssueMaterials: detail.canIssueMaterials,
      cancellationReason: detail.cancellationReason,
      isCompleted: detail.isCompleted,
      finalMetalLossFineWeight: detail.finalMetalLossFineWeight ? detail.finalMetalLossFineWeight.toFixed(3) : null,
      metalLines: detail.metalLines.map((l) => ({
        id: l.id,
        metalType: l.metalType,
        purityId: l.purityId,
        purityDisplayName: l.purityDisplayName,
        finenessPercentSnapshot: l.finenessPercentSnapshot.toFixed(3),
        isAlloy: l.isAlloy,
        grossWeight: l.grossWeight.toFixed(3),
        fineWeight: l.fineWeight.toFixed(3),
        costValue: ownerOnly(isOwner, l.costValue.toFixed(2)),
      })),
      diamondLines: detail.diamondLines.map((l) => ({
        id: l.id,
        polishedDiamondId: l.polishedDiamondId,
        polishedCode: l.polishedCode,
        shape: l.shape,
        carat: l.carat.toFixed(3),
        costAtIssue: ownerOnly(isOwner, l.costAtIssue.toFixed(2)),
        resolvedAs: l.resolvedAs,
      })),
      packetLines: serializeJobPacketLines(detail.packetLines, isOwner),
      otherMaterialLines: detail.otherMaterialLines.map((l) => ({
        id: l.id,
        description: l.description,
        quantity: l.quantity.toFixed(3),
        unit: l.unit,
        weight: l.weight ? l.weight.toFixed(3) : null,
        cost: ownerOnly(isOwner, l.cost.toFixed(2)),
        note: l.note,
      })),
      receipts: detail.receipts.map((r) => ({
        id: r.id,
        receiptCode: r.receiptCode,
        receiveDate: r.receiveDate.toISOString(),
        returnedMetalFineWeight: r.returnedMetalFineWeight.toFixed(3),
        scrapFineWeight: r.scrapFineWeight.toFixed(3),
        processLossFineWeight: r.processLossFineWeight.toFixed(3),
        isAbnormalLoss: r.isAbnormalLoss,
        alloyAddedWeight: r.companyAlloyGrossWeight.plus(r.karigarAlloyGrossWeight).plus(r.includedAlloyGrossWeight).toFixed(3),
        returnedAlloyGrossWeight: r.returnedAlloyGrossWeight.toFixed(3),
        totalCharges: ownerOnly(
          isOwner,
          r.labourCharge.plus(r.makingCharge).plus(r.settingCharge).plus(r.platingCharge).plus(r.otherExpense).toFixed(2)
        ),
        chargesAddedLater: isOwner ? (addedLaterByReceipt.get(r.id) ?? "0.00") : null,
        karigarAlloyCost: ownerOnly(isOwner, r.karigarAlloyCost.toFixed(2)),
        unabsorbedCost: ownerOnly(isOwner, r.unabsorbedCost.toFixed(2)),
      })),
      finishedOutputs: await Promise.all(
        detail.finishedOutputs.map(async (f) => ({
          id: f.id,
          receiptId: f.receiptId,
          finishedCode: f.finishedCode,
          jewelleryType: f.jewelleryType,
          quantity: f.quantity,
          netMetalWeight: f.netMetalWeight.toFixed(3),
          fineMetalWeight: f.fineMetalWeight.toFixed(3),
          purityDisplayName: f.purityDisplayName,
          sourcePurityDisplayName: f.sourcePurityDisplayName,
          alloyAddedWeight: f.alloyAddedWeight.toFixed(3),
          alloyCost: ownerOnly(isOwner, f.alloyCost.toFixed(2)),
          totalCost: ownerOnly(isOwner, f.totalCost.toFixed(2)),
          totalCostCurrent: ownerOnly(isOwner, formatCarryingAmount(f.totalCostCurrent)),
          qcStatus: f.qcStatus,
          photoUrl: await resolveJewelleryAssetUrl(f.photoAssetId),
        }))
      ),
      timeline: detail.timeline.map((m) => ({
        id: m.id,
        type: m.type,
        detail: m.detail,
        costValue: ownerOnly(isOwner, m.costValue.toFixed(2)),
        sourceDocument: m.sourceDocument,
        createdAt: m.createdAt.toISOString(),
      })),
    };

    return (
      <JobDetailView
        job={serialized}
        isOwner={isOwner}
        purities={toMetalPurityOptions(purities)}
        availableDiamonds={availableDiamonds}
        availablePackets={availablePackets}
        pendingPackets={pendingPackets}
        chargePanels={chargePanels}
        transferPanel={transferPanel}
        custodySources={custodySources}
        customerGoldSources={customerGold?.receiveSources ?? []}
        customerGold={customerGold?.panel ?? null}
      />
    );
  }

  const statusList: JewelleryJobStatus[] | undefined =
    view === "IN_PROGRESS"
      ? ["IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"]
      : view === "COMPLETED"
        ? ["COMPLETED"]
        : view === "CANCELLED"
          ? ["CANCELLED"]
          : view === "ALL"
            ? undefined
            : ["DRAFT", "MATERIALS_ISSUED"];

  const [jobs, customers, karigars, karigarBalances] = await Promise.all([
    listJewelleryJobs({ status: statusList, search: search || undefined }),
    prisma.party.findMany({ where: { type: "CUSTOMER", isActive: true }, orderBy: { name: "asc" } }),
    prisma.party.findMany({ where: { type: "KARIGAR", isActive: true }, orderBy: { name: "asc" } }),
    getKarigarJewelleryMaterialBalances(),
  ]);

  const serializedJobs: SerializedJewelleryJob[] = jobs.map((j) => ({
    id: j.id,
    jobCode: j.jobCode,
    customerName: j.customerName,
    karigarName: j.karigarName,
    jewelleryType: j.jewelleryType,
    designName: j.designName,
    issueDate: j.issueDate.toISOString(),
    expectedDeliveryDate: j.expectedDeliveryDate ? j.expectedDeliveryDate.toISOString() : null,
    status: j.status,
    issuedMetalFineWeight: j.issuedMetalFineWeight.toFixed(3),
    pendingFineWeight: j.pendingFineWeight.toFixed(3),
    totalManufacturingCost: ownerOnly(isOwner, formatCarryingAmount(j.totalManufacturingCost)),
  }));

  return (
    <div className="flex flex-col gap-6">
      {karigarBalances.filter((k) => k.openJobsCount > 0).length > 0 ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Material with each Karigar</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {karigarBalances
              .filter((k) => k.openJobsCount > 0)
              .map((k) => (
                <a
                  key={k.karigarId}
                  href={`/jewellery-jobs?tab=karigar&karigarId=${k.karigarId}`}
                  className="block rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 hover:border-zinc-400"
                >
                  <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{k.karigarName}</p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {k.openJobsCount} open job{k.openJobsCount === 1 ? "" : "s"} · {k.pendingFineWeight.toFixed(3)}g pending
                    {k.pendingDiamondsCount > 0 ? ` · ${k.pendingDiamondsCount} diamond${k.pendingDiamondsCount === 1 ? "" : "s"}` : ""}
                  </p>
                </a>
              ))}
          </div>
        </div>
      ) : null}
      <JobsTab
        jobs={serializedJobs}
        customers={customers.map((c) => ({ id: c.id, name: c.name, type: c.type, stateCode: c.stateCode }))}
        karigars={karigars.map((k) => ({ id: k.id, name: k.name, type: k.type, stateCode: k.stateCode }))}
        purities={toPurityOptions(purities)}
        isOwner={isOwner}
        search={search}
        view={view}
        initialShowForm={initialShowForm}
      />
    </div>
  );
}

const CUSTODY_KINDS: CustodyKind[] = ["ISSUE_TO_KARIGAR", "RETURN_TO_STOCK", "ALLOCATE_TO_JOB", "RELEASE_FROM_JOB"];

async function KarigarTabContent({ karigarId, isOwner, op, jobId }: { karigarId: string; isOwner: boolean; op: CustodyKind | null; jobId: string | null }) {
  if (karigarId) {
    const karigar = await prisma.party.findUnique({ where: { id: karigarId } });
    if (!karigar || karigar.type !== "KARIGAR") {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Karigar not found.</p>;
    }
    // Weights for everyone; every cost figure only for the Owner (never in a Staff payload).
    const [account, buckets] = await Promise.all([
      getKarigarMetalAccount(karigarId, { includeCost: isOwner }),
      isOwner ? getMetalStockSummary() : Promise.resolve([]),
    ]);
    const issuePurities: IssuePurityOption[] = buckets
      .filter((b) => b.metalType !== "ALLOY" && b.finenessPercent.greaterThan(0) && b.grossWeight.greaterThan(0))
      .map((b) => ({ id: b.purityId, label: `${b.metalType} ${b.purityDisplayName} (${b.finenessPercent.toFixed(3)}%)`, stockGross: b.grossWeight.toFixed(3) }));
    return <KarigarMetalAccountView account={account} isOwner={isOwner} issuePurities={issuePurities} initialOp={op} initialJobId={jobId} />;
  }

  const [summaries, karigars, reconciliation] = await Promise.all([
    listKarigarCustodySummaries(),
    prisma.party.findMany({ where: { type: "KARIGAR", isActive: true }, orderBy: { name: "asc" } }),
    isOwner ? reconcileMetalLedger(prisma) : Promise.resolve(null),
  ]);
  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <h3 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Company metal with Karigars</h3>
        <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
          Metal can be given to a Karigar without a job, then allocated to that Karigar&apos;s jobs. Open a Karigar to issue, allocate, return or release metal and
          to see the statement.
        </p>
        {summaries.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No Karigar holds company metal right now.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {summaries.map((s) => (
              <li key={s.karigarId}>
                <a
                  href={`/jewellery-jobs?tab=karigar&karigarId=${s.karigarId}`}
                  className="block rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 hover:border-zinc-400"
                  data-testid={`karigar-summary-${s.karigarName}`}
                >
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">{s.karigarName}</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    Unallocated: {s.unallocated.length === 0 ? "none" : s.unallocated.map((u) => `${u.gross}g ${u.purityDisplayName}`).join(", ")}
                  </p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    {s.openJobsCount} open job{s.openJobsCount === 1 ? "" : "s"} · {s.allocatedPendingFine}g fine pending on jobs · total {s.totalWithKarigarFine}g fine
                  </p>
                </a>
              </li>
            ))}
          </ul>
        )}
        {karigars.length > 0 ? (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer font-medium text-zinc-700 dark:text-zinc-300">Open any Karigar</summary>
            <ul className="mt-2 flex flex-wrap gap-2">
              {karigars.map((k) => (
                <li key={k.id}>
                  <a href={`/jewellery-jobs?tab=karigar&karigarId=${k.id}`} className="inline-block rounded-full border border-[var(--border)] px-3 py-1.5 text-xs hover:border-zinc-400">
                    {k.name}
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      {reconciliation ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6" data-testid="metal-reconciliation">
          <h3 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Ledger reconciliation (Owner)</h3>
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            Each account&apos;s ledger balance against the records behind it. Jewellery WIP includes metal with Karigars that is not yet allocated to a job.
          </p>
          <ul className="flex flex-col gap-2">
            {reconciliation.lines.map((l) => (
              <li key={l.accountCode} className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs text-zinc-700 dark:text-zinc-300">
                <p className="font-medium text-zinc-900 dark:text-zinc-50">
                  {l.accountCode} {l.label}: ledger ₹{l.ledger.toFixed(2)} · records ₹{l.expected.toFixed(2)} ·{" "}
                  <span className={l.difference.isZero() ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}>
                    difference ₹{l.difference.toFixed(2)}
                  </span>
                </p>
                <p className="text-zinc-500 dark:text-zinc-400">{l.parts.map((p) => `${p.label} ₹${p.value.toFixed(2)}`).join(" · ")}</p>
              </li>
            ))}
          </ul>
          {reconciliation.unavailable ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Some finished pieces&apos; revalued cost could not be replayed, so finished stock is incomplete here.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Customer-owned gold: weights for everyone; declared values, approved
// purchase values, Company cost and bills only in an Owner's payload
// (customerGoldStatement / customerJewelleryAwaitingDelivery includeValues).
async function CustomerGoldTabContent({ customerId, isOwner }: { customerId: string; isOwner: boolean }) {
  const [customers, purities, karigars, karigarWise, jobWise, awaiting, exceptions, reconciliation] = await Promise.all([
    prisma.party.findMany({ where: { type: "CUSTOMER", isActive: true }, orderBy: { name: "asc" } }),
    listMetalPurities(),
    prisma.party.findMany({ where: { type: "KARIGAR", isActive: true }, orderBy: { name: "asc" } }),
    karigarWiseCustomerGold(prisma),
    jobWiseCustomerGold(prisma),
    customerJewelleryAwaitingDelivery(prisma, { includeValues: isOwner }),
    customerGoldExceptions(prisma),
    customerGoldReconciliation(prisma),
  ]);
  const selected = customers.find((c) => c.id === customerId) ?? null;
  const [statement, jobs] = selected
    ? await Promise.all([
        customerGoldStatement(prisma, selected.id, { includeValues: isOwner }),
        prisma.jewelleryJob.findMany({
          where: { customerId: selected.id, status: { in: ["DRAFT", "MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"] } },
          include: { karigar: true },
          orderBy: { jobCode: "asc" },
        }),
      ])
    : [null, []];
  return (
    <CustomerGoldTab
      isOwner={isOwner}
      customers={customers.map((c) => ({ id: c.id, name: c.name }))}
      selectedCustomerId={selected?.id ?? ""}
      statement={statement}
      purities={purities.filter((p) => p.metalType !== "ALLOY").map((p) => ({ id: p.id, metalType: p.metalType, displayName: p.displayName, finenessPercent: String(p.finenessPercent) }))}
      karigars={karigars.map((k) => ({ id: k.id, name: k.name }))}
      customerJobs={jobs.map((j) => ({ id: j.id, jobCode: j.jobCode, designName: j.designName, karigarName: j.karigar.name, status: j.status }))}
      reports={{ karigarWise, jobWise, awaiting, exceptions, totals: reconciliation.totals }}
    />
  );
}

async function MetalTabContent({ search, isOwner }: { search: string; isOwner: boolean }) {
  const [buckets, purchases, suppliers, purities, paymentAccounts, gstRates] = await Promise.all([
    getMetalStockSummary(),
    listMetalPurchases({ search: search || undefined }),
    prisma.party.findMany({ where: { type: "SUPPLIER", isActive: true }, orderBy: { name: "asc" } }),
    listMetalPurities(),
    prisma.paymentAccount.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    prisma.gstRate.findMany({ where: { isActive: true }, orderBy: { ratePercent: "asc" } }),
  ]);

  const serializedBuckets: SerializedMetalStockBucket[] = buckets.map((b) => ({
    metalType: b.metalType,
    purityId: b.purityId,
    purityDisplayName: b.purityDisplayName,
    grossWeight: b.grossWeight.toFixed(3),
    fineWeight: b.fineWeight.toFixed(3),
    costValue: ownerOnly(isOwner, b.costValue.toFixed(2)),
    scrapGrossWeight: b.scrapGrossWeight.toFixed(3),
    scrapFineWeight: b.scrapFineWeight.toFixed(3),
    scrapCostValue: ownerOnly(isOwner, b.scrapCostValue.toFixed(2)),
  }));

  const serializedPurchases: SerializedMetalPurchase[] = purchases.map((p) => ({
    id: p.id,
    purchaseCode: p.purchaseCode,
    purchaseDate: p.purchaseDate.toISOString(),
    supplierName: p.supplierName,
    metalType: p.metalType,
    purityDisplayName: p.purityDisplayName,
    grossWeight: p.grossWeight.toFixed(3),
    fineWeight: p.fineWeight.toFixed(3),
    totalPurchaseCost: ownerOnly(isOwner, p.totalPurchaseCost.toFixed(2)),
  }));

  return (
    <MetalStockTab
      buckets={serializedBuckets}
      purchases={serializedPurchases}
      suppliers={suppliers.map((s) => ({ id: s.id, name: s.name, type: s.type, stateCode: s.stateCode }))}
      purities={toMetalPurityOptions(purities)}
      paymentAccounts={paymentAccounts.map((p) => ({ id: p.id, name: p.name, method: p.method }))}
      gstRates={gstRates.map((g) => ({ id: g.id, label: g.label, ratePercent: g.ratePercent.toString() }))}
      isOwner={isOwner}
      search={search}
      adjustments={await listMetalAdjustments(isOwner)}
    />
  );
}

async function FinishedTabContent({
  search,
  status,
  saleSearch,
  isOwner,
}: {
  search: string;
  status: string;
  saleSearch: string;
  isOwner: boolean;
}) {
  // Owner-only cost/Costing fields are fetched from the database ONLY when
  // isOwner is true — never fetched-then-hidden. See the SECURITY BOUNDARY
  // comment on listFinishedJewelleryStock in src/lib/jewellery/reports.ts.
  const rows = await listFinishedJewelleryStock({
    search: search || undefined,
    status: (status || undefined) as FinishedJewelleryStockStatus | undefined,
    includeCost: isOwner,
  });

  const items: SerializedFinishedStockRow[] = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      finishedCode: r.finishedCode,
      jobCode: r.jobCode,
      designName: r.designName,
      karigarName: r.karigarName,
      jewelleryType: r.jewelleryType,
      metalType: r.metalType,
      purityDisplayName: r.purityDisplayName,
      netMetalWeight: r.netMetalWeight.toFixed(3),
      fineMetalWeight: r.fineMetalWeight.toFixed(3),
      grossWeight: r.grossWeight ? r.grossWeight.toFixed(3) : null,
      diamondCount: r.diamondCount,
      totalCarat: r.totalCarat.toFixed(3),
      status: r.status,
      producedAt: r.producedAt.toISOString(),
      photoUrl: await resolveJewelleryAssetUrl(r.photoAssetId),
      saleCode: r.saleCode,
      saleDate: r.saleDate ? r.saleDate.toISOString() : null,
      ...(isOwner
        ? { inventoryCost: r.inventoryCost === undefined ? undefined : formatCarryingAmount(r.inventoryCost), costSheetNumber: r.costSheetNumber ?? null }
        : {}),
    }))
  );

  // Owner-only sale management (cancel/return) — never fetched for Staff.
  const sales: SerializedFinishedSale[] = isOwner
    ? (await listFinishedJewellerySalesForManagement(saleSearch || undefined)).map((s) => ({
        id: s.id,
        saleCode: s.saleCode,
        saleDate: s.saleDate.toISOString(),
        customerName: s.customerName,
        status: s.status,
        grandTotal: s.grandTotal.toFixed(2),
        lines: s.lines.map((l) => ({
          id: l.id,
          finishedCode: l.finishedCode,
          itemDescription: l.itemDescription,
          taxableValue: l.taxableValue.toFixed(2),
          taxAmount: l.taxAmount.toFixed(2),
          lineTotal: l.lineTotal.toFixed(2),
          returnStatus: l.returnStatus,
        })),
      }))
    : [];

  return (
    <div className="flex flex-col gap-8">
      <FinishedStockTab items={items} isOwner={isOwner} search={search} status={status} />
      {isOwner ? <FinishedSalesManager sales={sales} search={saleSearch} /> : null}
    </div>
  );
}
