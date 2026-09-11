"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { markJobInProgressAction } from "@/app/actions/diamond";
import { ReceivePolishedForm } from "@/components/diamond/ReceivePolishedForm";
import { CancelJobForm } from "@/components/diamond/CancelJobForm";
import { Button } from "@/components/ui/Button";
import { shapeLabel } from "@/lib/diamond/shapes";
import type { DiamondShape } from "@/generated/prisma/enums";

export type SerializedJobDetail = {
  id: string;
  jobCode: string;
  karigarName: string;
  requiredShape: DiamondShape;
  customShapeName: string | null;
  customShapeMeasurements: string | null;
  customShapeInstruction: string | null;
  customShapeReferencePhotoUrl: string | null;
  issueDate: string;
  dueDate: string | null;
  issuedPiecesCount: number;
  issuedRoughCarat: string;
  receivedPolishedCarat: string;
  returnedRoughCarat: string;
  pendingCarat: string;
  status: string;
  issuedCostValue: string;
  remainingWipCost: string;
  totalLabourCharge: string;
  notes: string | null;
  isCompleted: boolean;
  finalWeightLossCarat: string | null;
  finalYieldPercent: string | null;
  cancellationReason: string | null;
  pieces: { roughCode: string; carat: string; lotCode: string | null }[];
  receipts: {
    id: string;
    receiptCode: string;
    receiveDate: string;
    polishedCount: number;
    totalPolishedCarat: string;
    returnedRoughCarat: string;
    weightLossCarat: string;
    yieldPercent: string;
    labourCharge: string;
  }[];
  timeline: { id: string; type: string; pieces: number; carat: string; costValue: string; sourceDocument: string; createdAt: string }[];
};

const MOVEMENT_LABELS: Record<string, string> = {
  ROUGH_PURCHASE_IN: "Rough purchased",
  ROUGH_ISSUE_OUT: "Issued to Karigar",
  ROUGH_ISSUE_CANCEL_IN: "Issue cancelled — returned to stock",
  ROUGH_CONSUMED_OUT: "Rough consumed (polished + loss)",
  ROUGH_RETURN_IN: "Unused rough returned",
  POLISHED_RECEIVE_IN: "Polished received",
  POLISHED_RECUT_OUT: "Marked for recut",
};

export function JobDetailView({ job, isOwner }: { job: SerializedJobDetail; isOwner: boolean }) {
  const router = useRouter();
  const [showReceiveForm, setShowReceiveForm] = useState(false);

  function handleSaved() {
    router.refresh();
  }

  const canIssueInProgress = job.status === "ISSUED";
  const canReceive = job.status === "ISSUED" || job.status === "IN_PROGRESS" || job.status === "PARTIALLY_RECEIVED";
  const canCancel = isOwner && (job.status === "ISSUED" || job.status === "IN_PROGRESS");

  return (
    <div className="flex flex-col gap-5">
      <a href="/diamond?tab=jobs" className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100">
        ← Back to jobs
      </a>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{job.jobCode}</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
              {job.karigarName} · {job.customShapeName || shapeLabel(job.requiredShape)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {canIssueInProgress ? (
              <form action={markJobInProgressAction}>
                <input type="hidden" name="jobId" value={job.id} />
                <Button type="submit" variant="secondary" size="md">
                  Mark In Progress
                </Button>
              </form>
            ) : null}
            {canCancel ? <CancelJobForm jobId={job.id} jobCode={job.jobCode} /> : null}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Issue date" value={new Date(job.issueDate).toLocaleDateString("en-IN")} />
          <Stat label="Due date" value={job.dueDate ? new Date(job.dueDate).toLocaleDateString("en-IN") : "—"} />
          <Stat label="Pieces issued" value={String(job.issuedPiecesCount)} />
          <Stat label="Issued carat" value={`${job.issuedRoughCarat}ct`} />
          <Stat label="Received" value={`${job.receivedPolishedCarat}ct`} />
          <Stat label="Returned" value={`${job.returnedRoughCarat}ct`} />
          <Stat
            label={job.isCompleted ? "Weight loss (final)" : "Pending with Karigar"}
            value={`${job.isCompleted ? job.finalWeightLossCarat : job.pendingCarat}ct`}
          />
          {job.isCompleted && job.finalYieldPercent ? <Stat label="Yield" value={`${job.finalYieldPercent}%`} /> : null}
          {isOwner ? <Stat label="Issued cost" value={`₹${job.issuedCostValue}`} /> : null}
          {isOwner ? <Stat label="Remaining WIP cost" value={`₹${job.remainingWipCost}`} /> : null}
          {isOwner ? <Stat label="Labour so far" value={`₹${job.totalLabourCharge}`} /> : null}
        </div>

        {job.customShapeInstruction ? (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
            <span className="font-medium">Cutting instruction:</span> {job.customShapeInstruction}
          </p>
        ) : null}
        {job.customShapeMeasurements ? (
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            <span className="font-medium">Required measurements:</span> {job.customShapeMeasurements}
          </p>
        ) : null}
        {job.customShapeReferencePhotoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- signed URL expires; not a Next/Image-cacheable asset
          <img
            src={job.customShapeReferencePhotoUrl}
            alt="Custom shape reference"
            className="mt-2 h-32 w-32 rounded-lg border border-[var(--border)] object-cover"
          />
        ) : null}
        {job.notes ? <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{job.notes}</p> : null}
        {job.status === "CANCELLED" && job.cancellationReason ? (
          <p className="mt-2 text-sm text-red-600 dark:text-red-400">Cancelled: {job.cancellationReason}</p>
        ) : null}

        <div className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Rough pieces issued</h3>
          <div className="flex flex-wrap gap-2">
            {job.pieces.map((p) => (
              <span key={p.roughCode} className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-400">
                {p.roughCode} ({p.carat}ct){p.lotCode ? ` · ${p.lotCode}` : ""}
              </span>
            ))}
          </div>
        </div>
      </div>

      {canReceive ? (
        <div>
          <Button type="button" variant={showReceiveForm ? "primary" : "secondary"} size="md" onClick={() => setShowReceiveForm((v) => !v)}>
            {showReceiveForm ? "Close" : "Receive Polished"}
          </Button>
          {showReceiveForm ? (
            <div className="mt-3">
              <ReceivePolishedForm
                jobId={job.id}
                jobCode={job.jobCode}
                pendingCarat={Number(job.pendingCarat)}
                defaultShape={job.requiredShape}
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
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-[var(--surface-muted)] text-left text-xs text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2">Receipt</th>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Polished</th>
                  <th className="px-3 py-2">Returned</th>
                  <th className="px-3 py-2">Loss</th>
                  <th className="px-3 py-2">Yield</th>
                  <th className="px-3 py-2">Labour</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {job.receipts.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">{r.receiptCode}</td>
                    <td className="px-3 py-2">{new Date(r.receiveDate).toLocaleDateString("en-IN")}</td>
                    <td className="px-3 py-2">
                      {r.totalPolishedCarat}ct ({r.polishedCount})
                    </td>
                    <td className="px-3 py-2">{r.returnedRoughCarat}ct</td>
                    <td className="px-3 py-2">{r.weightLossCarat}ct</td>
                    <td className="px-3 py-2">{r.yieldPercent}%</td>
                    <td className="px-3 py-2">₹{r.labourCharge}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Audit timeline</h3>
        <ul className="flex flex-col gap-2">
          {job.timeline.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] pb-2 text-sm last:border-0 last:pb-0">
              <span className="text-zinc-700 dark:text-zinc-300">{MOVEMENT_LABELS[m.type] ?? m.type}</span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {m.carat}ct{isOwner ? ` · ₹${m.costValue}` : ""} · {new Date(m.createdAt).toLocaleString("en-IN")}
              </span>
            </li>
          ))}
        </ul>
      </div>
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
