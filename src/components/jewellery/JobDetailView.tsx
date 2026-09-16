"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { markJewelleryJobInProgressAction, setJewelleryJobNeedsCorrectionAction } from "@/app/actions/jewellery";
import {
  IssueMaterialsForm,
  type AvailablePacketOption,
  type AvailablePolishedDiamondOption,
} from "@/components/jewellery/IssueMaterialsForm";
import {
  ReceiveFinishedForm,
  type IssuedMetalOption,
  type MetalPurityOption,
  type PendingPacketOption,
} from "@/components/jewellery/ReceiveFinishedForm";
import { CancelJobForm } from "@/components/jewellery/CancelJobForm";
import { OverrideAllocationForm } from "@/components/jewellery/OverrideAllocationForm";
import { Button } from "@/components/ui/Button";
import { jewelleryTypeLabel } from "@/lib/jewellery/types";
import { formatThousandths, toThousandths } from "@/lib/jewellery/metalMath";

/** Cost / payable figures are Owner-only and arrive as null for Staff —
 * redacted on the server in src/app/(app)/jewellery-jobs/page.tsx. */
export type SerializedJobDetail = {
  id: string;
  jobCode: string;
  customerName: string | null;
  customerReference: string | null;
  karigarName: string;
  jewelleryType: string;
  designName: string;
  designImageUrl: string | null;
  issueDate: string;
  expectedDeliveryDate: string | null;
  status: string;
  jewellerySize: string | null;
  quantity: number;
  notes: string | null;
  specialInstructions: string | null;
  targetMetalType: string | null;
  targetPurityDisplayName: string | null;
  targetFinishedWeight: string | null;
  issuedMetalFineWeight: string;
  issuedMetalCost: string | null;
  issuedDiamondCost: string | null;
  otherMaterialCost: string | null;
  remainingWipCost: string | null;
  totalLabourCharge: string | null;
  receivedFineWeight: string;
  returnedMetalFineWeight: string;
  scrapFineWeight: string;
  karigarAddedFineWeight: string;
  karigarAddedCost: string | null;
  issuedAlloyGrossWeight: string;
  issuedAlloyCost: string | null;
  consumedAlloyGrossWeight: string;
  returnedAlloyGrossWeight: string;
  remainingAlloyWipCost: string | null;
  alloyPendingGrossWeight: string;
  pendingFineWeight: string;
  totalIssuedCost: string | null;
  cancellationReason: string | null;
  isCompleted: boolean;
  finalMetalLossFineWeight: string | null;
  metalLines: {
    id: string;
    metalType: string;
    purityId: string;
    purityDisplayName: string;
    finenessPercentSnapshot: string;
    isAlloy: boolean;
    grossWeight: string;
    fineWeight: string;
    costValue: string | null;
  }[];
  diamondLines: {
    id: string;
    polishedDiamondId: string;
    polishedCode: string;
    shape: string;
    carat: string;
    costAtIssue: string | null;
    resolvedAs: string | null;
  }[];
  otherMaterialLines: { id: string; description: string; quantity: string; unit: string; weight: string | null; cost: string | null; note: string | null }[];
  receipts: {
    id: string;
    receiptCode: string;
    receiveDate: string;
    returnedMetalFineWeight: string;
    scrapFineWeight: string;
    processLossFineWeight: string;
    isAbnormalLoss: boolean;
    alloyAddedWeight: string;
    returnedAlloyGrossWeight: string;
    totalCharges: string | null;
    karigarAlloyCost: string | null;
    unabsorbedCost: string | null;
  }[];
  finishedOutputs: {
    id: string;
    receiptId: string;
    finishedCode: string;
    jewelleryType: string;
    quantity: number;
    netMetalWeight: string;
    fineMetalWeight: string;
    purityDisplayName: string;
    sourcePurityDisplayName: string | null;
    alloyAddedWeight: string;
    alloyCost: string | null;
    totalCost: string | null;
    qcStatus: string;
    photoUrl: string | null;
  }[];
  timeline: { id: string; type: string; detail: string; costValue: string | null; sourceDocument: string | null; createdAt: string }[];
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  MATERIALS_ISSUED: "Materials Issued",
  IN_PROGRESS: "In Progress",
  PARTIALLY_RECEIVED: "Partially Received",
  NEEDS_CORRECTION: "Needs Correction",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** Issued metal per purity (a job may have several issue lines of one purity). */
function issuedMetalByPurity(lines: SerializedJobDetail["metalLines"]): IssuedMetalOption[] {
  const byPurity = new Map<string, IssuedMetalOption>();
  for (const line of lines) {
    const existing = byPurity.get(line.purityId);
    if (existing) {
      existing.grossWeight = formatThousandths(toThousandths(existing.grossWeight) + toThousandths(line.grossWeight));
      existing.fineWeight = formatThousandths(toThousandths(existing.fineWeight) + toThousandths(line.fineWeight));
    } else {
      byPurity.set(line.purityId, {
        purityId: line.purityId,
        metalType: line.metalType,
        displayName: line.purityDisplayName,
        finenessPercent: line.finenessPercentSnapshot,
        isAlloy: line.isAlloy,
        grossWeight: line.grossWeight,
        fineWeight: line.fineWeight,
      });
    }
  }
  return [...byPurity.values()];
}

export function JobDetailView({
  job,
  isOwner,
  purities,
  availableDiamonds,
  availablePackets = [],
  pendingPackets = [],
}: {
  job: SerializedJobDetail;
  isOwner: boolean;
  purities: MetalPurityOption[];
  availableDiamonds: AvailablePolishedDiamondOption[];
  availablePackets?: AvailablePacketOption[];
  pendingPackets?: PendingPacketOption[];
}) {
  const router = useRouter();
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [showReceiveForm, setShowReceiveForm] = useState(false);
  const [showOverrideForReceipt, setShowOverrideForReceipt] = useState<string | null>(null);

  function handleSaved() {
    setShowIssueForm(false);
    setShowReceiveForm(false);
    setShowOverrideForReceipt(null);
    router.refresh();
  }

  const canIssueMaterials = job.status === "DRAFT";
  const canMarkInProgress = job.status === "MATERIALS_ISSUED";
  const canReceive =
    job.status === "MATERIALS_ISSUED" || job.status === "IN_PROGRESS" || job.status === "PARTIALLY_RECEIVED" || job.status === "NEEDS_CORRECTION";
  const canCancel = isOwner && (job.status === "DRAFT" || job.status === "MATERIALS_ISSUED" || job.status === "IN_PROGRESS");
  const canToggleNeedsCorrection = job.status === "IN_PROGRESS" || job.status === "PARTIALLY_RECEIVED" || job.status === "NEEDS_CORRECTION";
  const hasCompanyAlloy = toThousandths(job.issuedAlloyGrossWeight) > BigInt(0);

  const unresolvedDiamonds = job.diamondLines
    .filter((l) => !l.resolvedAs)
    .map((l) => ({ polishedDiamondId: l.polishedDiamondId, polishedCode: l.polishedCode, shape: l.shape, carat: l.carat }));

  return (
    <div className="flex flex-col gap-5">
      <a
        href="/jewellery-jobs?tab=jobs"
        className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
      >
        ← Back to jobs
      </a>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{job.jobCode}</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {job.designName} · {jewelleryTypeLabel(job.jewelleryType)} · {job.karigarName}
              {job.customerName ? ` · ${job.customerName}` : ""}
            </p>
            <p className="mt-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">{STATUS_LABELS[job.status] ?? job.status}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canMarkInProgress ? (
              <form action={markJewelleryJobInProgressAction}>
                <input type="hidden" name="jobId" value={job.id} />
                <Button type="submit" variant="secondary" size="md">
                  Mark In Progress
                </Button>
              </form>
            ) : null}
            {canToggleNeedsCorrection ? (
              <form action={setJewelleryJobNeedsCorrectionAction}>
                <input type="hidden" name="jobId" value={job.id} />
                <input type="hidden" name="flag" value={job.status === "NEEDS_CORRECTION" ? "false" : "true"} />
                <Button type="submit" variant="ghost" size="md">
                  {job.status === "NEEDS_CORRECTION" ? "Clear Needs Correction" : "Mark Needs Correction"}
                </Button>
              </form>
            ) : null}
            {canCancel ? <CancelJobForm jobId={job.id} jobCode={job.jobCode} /> : null}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Issue date" value={new Date(job.issueDate).toLocaleDateString("en-IN")} />
          <Stat label="Expected delivery" value={job.expectedDeliveryDate ? new Date(job.expectedDeliveryDate).toLocaleDateString("en-IN") : "—"} />
          <Stat label="Quantity" value={String(job.quantity)} />
          <Stat label="Size" value={job.jewellerySize ?? "—"} />
          <Stat label="Target metal" value={job.targetMetalType ? `${job.targetMetalType} · ${job.targetPurityDisplayName ?? "—"}` : "Not decided"} />
          <Stat label="Metal issued (fine)" value={`${job.issuedMetalFineWeight}g`} />
          <Stat label="Metal received (fine)" value={`${job.receivedFineWeight}g`} />
          <Stat
            label={job.isCompleted ? "Metal loss (final)" : "Pending with Karigar"}
            value={`${job.isCompleted ? job.finalMetalLossFineWeight : job.pendingFineWeight}g`}
          />
          <Stat label="Returned / Scrap" value={`${job.returnedMetalFineWeight}g / ${job.scrapFineWeight}g`} />
          {hasCompanyAlloy ? (
            <Stat
              label="Copper/Alloy issued"
              value={`${job.issuedAlloyGrossWeight}g · ${job.consumedAlloyGrossWeight}g used · ${job.returnedAlloyGrossWeight}g returned · ${job.alloyPendingGrossWeight}g pending`}
            />
          ) : null}
          {isOwner ? <Stat label="Metal cost issued" value={`₹${job.issuedMetalCost}`} /> : null}
          {isOwner ? <Stat label="Diamond cost issued" value={`₹${job.issuedDiamondCost}`} /> : null}
          {isOwner ? <Stat label="Other material cost" value={`₹${job.otherMaterialCost}`} /> : null}
          {isOwner ? <Stat label="Remaining WIP cost" value={`₹${job.remainingWipCost}`} /> : null}
          {isOwner && hasCompanyAlloy ? <Stat label="Remaining alloy cost" value={`₹${job.remainingAlloyWipCost}`} /> : null}
          {isOwner ? <Stat label="Labour/making/setting so far" value={`₹${job.totalLabourCharge}`} /> : null}
          {isOwner ? <Stat label="Total manufacturing cost issued" value={`₹${job.totalIssuedCost}`} /> : null}
        </div>

        {job.customerReference ? (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
            <span className="font-medium">Customer reference:</span> {job.customerReference}
          </p>
        ) : null}
        {job.specialInstructions ? (
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            <span className="font-medium">Special instructions:</span> {job.specialInstructions}
          </p>
        ) : null}
        {job.notes ? <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{job.notes}</p> : null}
        {job.designImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed URL expires; not a Next/Image-cacheable asset
          <img src={job.designImageUrl} alt="Design reference" className="mt-3 h-32 w-32 rounded-lg border border-[var(--border)] object-cover" />
        ) : null}
        {job.status === "CANCELLED" && job.cancellationReason ? (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">Cancelled: {job.cancellationReason}</p>
        ) : null}

        {job.metalLines.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Metal issued</h3>
            <div className="flex flex-wrap gap-2">
              {job.metalLines.map((l) => (
                <span key={l.id} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {l.isAlloy ? `${l.purityDisplayName} · ${l.grossWeight}g` : `${l.purityDisplayName} Issued · ${l.grossWeight}g gross / ${l.fineWeight}g fine`}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {job.diamondLines.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Diamonds issued</h3>
            <div className="flex flex-wrap gap-2">
              {job.diamondLines.map((l) => (
                <span key={l.id} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {l.polishedCode} ({l.carat}ct) — {l.resolvedAs ? l.resolvedAs.replace(/_/g, " ") : "with Karigar"}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {job.otherMaterialLines.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Other material (not stock-tracked)
            </h3>
            <div className="flex flex-wrap gap-2">
              {job.otherMaterialLines.map((l) => (
                <span key={l.id} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {l.description} · {l.quantity} {l.unit}
                  {isOwner ? ` · ₹${l.cost}` : ""}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {canIssueMaterials ? (
        <div>
          <Button type="button" variant={showIssueForm ? "primary" : "secondary"} size="md" onClick={() => setShowIssueForm((v) => !v)}>
            {showIssueForm ? "Close" : "Issue Materials"}
          </Button>
          {showIssueForm ? (
            <div className="mt-3">
              <IssueMaterialsForm
                jobId={job.id}
                jobCode={job.jobCode}
                purities={purities}
                availableDiamonds={availableDiamonds}
                availablePackets={availablePackets}
                isOwner={isOwner}
                onDone={handleSaved}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {canReceive ? (
        <div>
          <Button type="button" variant={showReceiveForm ? "primary" : "secondary"} size="md" onClick={() => setShowReceiveForm((v) => !v)}>
            {showReceiveForm ? "Close" : "Receive Finished Jewellery"}
          </Button>
          {showReceiveForm ? (
            <div className="mt-3">
              <ReceiveFinishedForm
                jobId={job.id}
                jobCode={job.jobCode}
                jewelleryType={job.jewelleryType}
                pendingFineWeight={job.pendingFineWeight}
                purities={purities}
                issuedMetal={issuedMetalByPurity(job.metalLines)}
                alloyPendingGrossWeight={job.alloyPendingGrossWeight}
                unresolvedDiamonds={unresolvedDiamonds}
                pendingPackets={pendingPackets}
                isOwner={isOwner}
                onDone={handleSaved}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {job.receipts.length > 0 ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Receipts</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-[var(--surface-muted)] text-left text-xs text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Receipt</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Returned</th>
                  <th className="px-3 py-2">Scrap</th>
                  <th className="px-3 py-2">Process Loss</th>
                  <th className="px-3 py-2">Alloy Added</th>
                  {isOwner ? <th className="px-3 py-2">Charges</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {job.receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">{r.receiptCode}</td>
                    <td className="px-3 py-2">{new Date(r.receiveDate).toLocaleDateString("en-IN")}</td>
                    <td className="px-3 py-2">
                      {r.returnedMetalFineWeight}g
                      {toThousandths(r.returnedAlloyGrossWeight) > BigInt(0) ? ` + ${r.returnedAlloyGrossWeight}g alloy` : ""}
                    </td>
                    <td className="px-3 py-2">{r.scrapFineWeight}g</td>
                    <td className="px-3 py-2">
                      {r.processLossFineWeight}g{r.isAbnormalLoss ? " (abnormal)" : ""}
                    </td>
                    <td className="px-3 py-2">{r.alloyAddedWeight}g</td>
                    {isOwner ? (
                      <td className="px-3 py-2">
                        ₹{r.totalCharges}
                        {r.karigarAlloyCost && Number(r.karigarAlloyCost) > 0 ? ` + ₹${r.karigarAlloyCost} alloy` : ""}
                        {r.unabsorbedCost && Number(r.unabsorbedCost) > 0 ? ` (₹${r.unabsorbedCost} expensed)` : ""}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {job.finishedOutputs.length > 0 ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Finished jewellery</h3>
          <ul className="flex flex-col gap-3">
            {job.finishedOutputs.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3">
                {o.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed URL expires
                  <img src={o.photoUrl} alt={o.finishedCode} className="h-16 w-16 rounded-lg object-cover" />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                    {o.finishedCode} · {jewelleryTypeLabel(o.jewelleryType)} · {o.purityDisplayName}
                    {o.sourcePurityDisplayName && o.sourcePurityDisplayName !== o.purityDisplayName ? ` (from ${o.sourcePurityDisplayName})` : ""}
                  </p>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Qty {o.quantity} · {o.netMetalWeight}g net / {o.fineMetalWeight}g fine
                    {toThousandths(o.alloyAddedWeight) > BigInt(0) ? ` · Alloy Added ${o.alloyAddedWeight}g` : ""} · QC:{" "}
                    {o.qcStatus.replace(/_/g, " ")}
                    {isOwner ? ` · ₹${o.totalCost}` : ""}
                  </p>
                </div>
                {isOwner ? (
                  <button
                    type="button"
                    onClick={() => setShowOverrideForReceipt((cur) => (cur === o.receiptId ? null : o.receiptId))}
                    className="text-xs font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
                  >
                    Override cost
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {isOwner && showOverrideForReceipt ? (
            <div className="mt-3">
              <OverrideAllocationForm
                receiptId={showOverrideForReceipt}
                outputs={job.finishedOutputs
                  .filter((o) => o.receiptId === showOverrideForReceipt)
                  .map((o) => ({ id: o.id, finishedCode: o.finishedCode, totalCost: o.totalCost }))}
                onDone={handleSaved}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {job.timeline.length > 0 ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Audit timeline</h3>
          <ul className="flex flex-col gap-2">
            {job.timeline.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2 text-sm last:border-0 last:pb-0">
                <span className="text-zinc-700 dark:text-zinc-300">{m.detail}</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {isOwner ? `₹${m.costValue} · ` : ""}
                  {new Date(m.createdAt).toLocaleString("en-IN")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{value}</p>
    </div>
  );
}
