import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { PageHeader } from "@/components/ui/PageHeader";
import { HelpLink } from "@/components/help/HelpLink";
import {
  getDiamondJobDetail,
  getKarigarMaterialBalances,
  getRoughStockSummary,
  getPolishedStockSummary,
  listDiamondJobs,
  listPolishedDiamonds,
  listRoughLots,
  listRoughPieces,
} from "@/lib/diamond/reports";
import { RoughStockTab, type SerializedRoughLot } from "@/components/diamond/RoughStockTab";
import { JobsTab, type SerializedDiamondJob } from "@/components/diamond/JobsTab";
import { JobDetailView, type SerializedJobDetail } from "@/components/diamond/JobDetailView";
import { PolishedStockTab, type SerializedPolishedDiamond } from "@/components/diamond/PolishedStockTab";
import type { AvailablePieceOption } from "@/components/diamond/IssueRoughForm";
import { resolveDiamondAssetUrl } from "@/lib/storage/diamondMedia";
import { ownerOnly } from "@/lib/security/ownerOnly";
import type { DiamondJobStatus } from "@/generated/prisma/enums";

export const metadata: Metadata = {
  title: "Diamond · ZYNORALUXE",
};

// Every cost / carrying-value / labour-payable figure below goes through
// ownerOnly() on the server: a Staff request's RSC payload must not carry
// those values at all, not merely have them hidden by the client
// components (PHASE_7_CURRENT_STATE_AUDIT.md §4.16).

type SearchParams = {
  tab?: string;
  roughSearch?: string;
  jobSearch?: string;
  jobStatus?: string;
  jobId?: string;
  polishedSearch?: string;
  issue?: string;
};

const TABS = ["rough", "jobs", "polished"] as const;
type Tab = (typeof TABS)[number];

function TabLink({ tab, label, active }: { tab: Tab; label: string; active: boolean }) {
  return (
    <a
      href={`/diamond?tab=${tab}`}
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

export default async function DiamondPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";
  const params = await searchParams;
  const tab: Tab = TABS.includes(params.tab as Tab) ? (params.tab as Tab) : "rough";

  return (
    <div>
      <PageHeader
        title="Diamond"
        description="Rough purchase and stock, cutting-polishing jobs, and polished stock."
        actions={<HelpLink anchor="diamond" />}
      />

      <nav aria-label="Diamond sections" className="mb-6 flex flex-wrap gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5">
        <TabLink tab="rough" label="Rough Stock" active={tab === "rough"} />
        <TabLink tab="jobs" label="Cutting-Polishing Jobs" active={tab === "jobs"} />
        <TabLink tab="polished" label="Polished Stock" active={tab === "polished"} />
      </nav>

      {tab === "rough" ? <RoughStockTabContent search={params.roughSearch ?? ""} isOwner={isOwner} /> : null}
      {tab === "jobs" ? (
        <JobsTabContent
          search={params.jobSearch ?? ""}
          statusFilter={params.jobStatus ?? ""}
          jobId={params.jobId ?? ""}
          isOwner={isOwner}
          initialShowForm={params.issue === "1"}
        />
      ) : null}
      {tab === "polished" ? <PolishedStockTabContent search={params.polishedSearch ?? ""} isOwner={isOwner} /> : null}
    </div>
  );
}

async function RoughStockTabContent({ search, isOwner }: { search: string; isOwner: boolean }) {
  const [lots, suppliers, paymentAccounts, gstRates, summary] = await Promise.all([
    listRoughLots({ search: search || undefined }),
    prisma.party.findMany({ where: { type: "SUPPLIER", isActive: true }, orderBy: { name: "asc" } }),
    prisma.paymentAccount.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    prisma.gstRate.findMany({ where: { isActive: true }, orderBy: { ratePercent: "asc" } }),
    getRoughStockSummary(),
  ]);

  const serializedLots: SerializedRoughLot[] = await Promise.all(
    lots.map(async (lot) => ({
      id: lot.id,
      lotCode: lot.lotCode,
      purchaseDate: lot.purchaseDate.toISOString(),
      supplierName: lot.supplierName,
      piecesCount: lot.piecesCount,
      totalRoughCarat: lot.totalRoughCarat.toFixed(3),
      totalPurchaseCost: ownerOnly(isOwner, lot.totalPurchaseCost.toFixed(2)),
      status: lot.status,
      availableCarat: lot.availableCarat.toFixed(3),
      photoUrl: await resolveDiamondAssetUrl(lot.photoAssetId),
      pieces: await Promise.all(
        lot.pieces.map(async (p) => ({
          id: p.id,
          roughCode: p.roughCode,
          carat: p.carat.toFixed(3),
          allocatedCost: ownerOnly(isOwner, p.allocatedCost.toFixed(2)),
          costLocked: p.costLocked,
          status: p.status,
          colorEstimate: p.colorEstimate,
          clarityNote: p.clarityNote,
          returnedFromJobCode: p.returnedFromJobCode,
          photoUrl: await resolveDiamondAssetUrl(p.photoAssetId),
        }))
      ),
    }))
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SummaryStat label="Available rough" value={`${summary.totalCarat.toFixed(3)}ct`} sub={`${summary.pieceCount} pieces`} />
        {isOwner ? <SummaryStat label="Available rough cost" value={`₹${summary.totalCost.toFixed(2)}`} /> : null}
      </div>
      <RoughStockTab
        lots={serializedLots}
        suppliers={suppliers.map((s) => ({ id: s.id, name: s.name, type: s.type, stateCode: s.stateCode }))}
        paymentAccounts={paymentAccounts.map((p) => ({ id: p.id, name: p.name, method: p.method }))}
        gstRates={gstRates.map((g) => ({ id: g.id, label: g.label, ratePercent: g.ratePercent.toString() }))}
        isOwner={isOwner}
        search={search}
      />
    </div>
  );
}

async function JobsTabContent({
  search,
  statusFilter,
  jobId,
  isOwner,
  initialShowForm,
}: {
  search: string;
  statusFilter: string;
  jobId: string;
  isOwner: boolean;
  initialShowForm?: boolean;
}) {
  if (jobId) {
    const detail = await getDiamondJobDetail(jobId);
    if (!detail) {
      return <p className="text-sm text-zinc-500 dark:text-zinc-400">Job not found.</p>;
    }
    const serialized: SerializedJobDetail = {
      id: detail.id,
      jobCode: detail.jobCode,
      karigarName: detail.karigarName,
      requiredShape: detail.requiredShape,
      customShapeName: detail.customShapeName,
      customShapeMeasurements: detail.customShapeMeasurements,
      customShapeInstruction: detail.customShapeInstruction,
      customShapeReferencePhotoUrl: await resolveDiamondAssetUrl(detail.customShapeReferencePhotoAssetId),
      issueDate: detail.issueDate.toISOString(),
      dueDate: detail.dueDate ? detail.dueDate.toISOString() : null,
      issuedPiecesCount: detail.issuedPiecesCount,
      issuedRoughCarat: detail.issuedRoughCarat.toFixed(3),
      receivedPolishedCarat: detail.receivedPolishedCarat.toFixed(3),
      returnedRoughCarat: detail.returnedRoughCarat.toFixed(3),
      pendingCarat: detail.pendingCarat.toFixed(3),
      status: detail.status,
      issuedCostValue: ownerOnly(isOwner, detail.issuedCostValue.toFixed(2)),
      remainingWipCost: ownerOnly(isOwner, detail.remainingWipCost.toFixed(2)),
      totalLabourCharge: ownerOnly(isOwner, detail.totalLabourCharge.toFixed(2)),
      notes: detail.notes,
      isCompleted: detail.isCompleted,
      finalWeightLossCarat: detail.finalWeightLossCarat ? detail.finalWeightLossCarat.toFixed(3) : null,
      finalYieldPercent: detail.finalYieldPercent ? detail.finalYieldPercent.toFixed(3) : null,
      cancellationReason: detail.cancellationReason,
      pieces: detail.pieces.map((p) => ({ roughCode: p.roughCode, carat: p.carat.toFixed(3), lotCode: p.lotCode })),
      receipts: detail.receipts.map((r) => ({
        id: r.id,
        receiptCode: r.receiptCode,
        receiveDate: r.receiveDate.toISOString(),
        polishedCount: r.polishedCount,
        totalPolishedCarat: r.totalPolishedCarat.toFixed(3),
        returnedRoughCarat: r.returnedRoughCarat.toFixed(3),
        weightLossCarat: r.weightLossCarat.toFixed(3),
        yieldPercent: r.yieldPercent.toFixed(3),
        labourCharge: ownerOnly(isOwner, r.labourCharge.toFixed(2)),
      })),
      timeline: detail.timeline.map((m) => ({
        id: m.id,
        type: m.type,
        pieces: m.pieces,
        carat: m.carat.toFixed(3),
        costValue: ownerOnly(isOwner, m.costValue.toFixed(2)),
        sourceDocument: m.sourceDocument,
        createdAt: m.createdAt.toISOString(),
      })),
    };
    return <JobDetailView job={serialized} isOwner={isOwner} />;
  }

  const statusList: DiamondJobStatus[] | undefined =
    statusFilter === "COMPLETED"
      ? ["COMPLETED"]
      : statusFilter === "CANCELLED"
        ? ["CANCELLED"]
        : statusFilter === "ALL"
          ? undefined
          : ["ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"];

  const [jobs, karigars, availablePiecesRaw, karigarBalances] = await Promise.all([
    listDiamondJobs({ status: statusList, search: search || undefined }),
    prisma.party.findMany({ where: { type: "KARIGAR", isActive: true }, orderBy: { name: "asc" } }),
    listRoughPieces({ status: "AVAILABLE" }),
    getKarigarMaterialBalances(),
  ]);

  const serializedJobs: SerializedDiamondJob[] = jobs.map((j) => ({
    id: j.id,
    jobCode: j.jobCode,
    karigarName: j.karigarName,
    requiredShape: j.requiredShape,
    customShapeName: j.customShapeName,
    issueDate: j.issueDate.toISOString(),
    dueDate: j.dueDate ? j.dueDate.toISOString() : null,
    issuedPiecesCount: j.issuedPiecesCount,
    issuedRoughCarat: j.issuedRoughCarat.toFixed(3),
    pendingCarat: j.pendingCarat.toFixed(3),
    status: j.status,
    totalLabourCharge: ownerOnly(isOwner, j.totalLabourCharge.toFixed(2)),
  }));

  const availablePieces: AvailablePieceOption[] = availablePiecesRaw.map((p) => ({
    id: p.id,
    roughCode: p.roughCode,
    lotCode: p.lotCode,
    carat: p.carat.toFixed(3),
    allocatedCost: ownerOnly(isOwner, p.allocatedCost.toFixed(2)),
  }));

  return (
    <div className="flex flex-col gap-6">
      {karigarBalances.length > 0 ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Material with each Karigar</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {karigarBalances.map((k) => (
              <div key={k.karigarId} className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{k.karigarName}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {k.openJobsCount} open job{k.openJobsCount === 1 ? "" : "s"} · {k.pendingCarat.toFixed(3)}ct pending
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <JobsTab
        jobs={serializedJobs}
        karigars={karigars.map((k) => ({ id: k.id, name: k.name, type: k.type, stateCode: k.stateCode }))}
        availablePieces={availablePieces}
        isOwner={isOwner}
        search={search}
        statusFilter={statusFilter}
        initialShowForm={initialShowForm}
      />
    </div>
  );
}

async function PolishedStockTabContent({ search, isOwner }: { search: string; isOwner: boolean }) {
  const [polished, summary] = await Promise.all([
    listPolishedDiamonds({ search: search || undefined }),
    getPolishedStockSummary(),
  ]);

  const serialized: SerializedPolishedDiamond[] = await Promise.all(
    polished.map(async (p) => ({
      id: p.id,
      polishedCode: p.polishedCode,
      jobCode: p.jobCode,
      lotCode: p.lotCode,
      shape: p.shape,
      carat: p.carat.toFixed(3),
      lengthMm: p.lengthMm ? p.lengthMm.toFixed(3) : null,
      widthMm: p.widthMm ? p.widthMm.toFixed(3) : null,
      heightMm: p.heightMm ? p.heightMm.toFixed(3) : null,
      certificateStatus: p.certificateStatus,
      allocatedCost: ownerOnly(isOwner, p.allocatedCost.toFixed(2)),
      costPerCarat: ownerOnly(isOwner, p.costPerCarat.toFixed(2)),
      status: p.status,
      photoUrl: await resolveDiamondAssetUrl(p.photoAssetId),
      certFileUrl: await resolveDiamondAssetUrl(p.certFileAssetId),
    }))
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SummaryStat label="Available polished" value={`${summary.totalCarat.toFixed(3)}ct`} sub={`${summary.pieceCount} pieces`} />
        {isOwner ? <SummaryStat label="Available polished cost" value={`₹${summary.totalCost.toFixed(2)}`} /> : null}
      </div>
      <PolishedStockTab polished={serialized} isOwner={isOwner} search={search} />
    </div>
  );
}

function SummaryStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-50">{value}</p>
      {sub ? <p className="text-xs text-zinc-500 dark:text-zinc-400">{sub}</p> : null}
    </div>
  );
}
