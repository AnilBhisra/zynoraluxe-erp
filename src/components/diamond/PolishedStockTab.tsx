"use client";

import { useState } from "react";

import { RecutForm } from "@/components/diamond/RecutForm";
import { EmptyState } from "@/components/ui/EmptyState";
import { shapeLabel } from "@/lib/diamond/shapes";
import type { DiamondShape } from "@/generated/prisma/enums";

export type SerializedPolishedDiamond = {
  id: string;
  polishedCode: string;
  jobCode: string;
  lotCode: string | null;
  shape: DiamondShape;
  carat: string;
  lengthMm: string | null;
  widthMm: string | null;
  heightMm: string | null;
  certificateStatus: string;
  allocatedCost: string;
  costPerCarat: string;
  status: string;
  photoUrl: string | null;
  certFileUrl: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Available",
  RECUT: "Recut",
};

const CERT_LABELS: Record<string, string> = {
  NOT_CERTIFIED: "Not certified",
  INTERNAL_GRADE: "Internal grade",
  CERTIFIED: "Certified",
};

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "AVAILABLE"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      : "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  return <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function PolishedStockTab({
  polished,
  isOwner,
  search,
}: {
  polished: SerializedPolishedDiamond[];
  isOwner: boolean;
  search: string;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Polished diamond stock</h2>

      <form method="GET" action="/diamond" className="flex gap-2">
        <input type="hidden" name="tab" value="polished" />
        <input
          type="text"
          name="polishedSearch"
          defaultValue={search}
          placeholder="Search by Polished ID or job code…"
          className="h-11 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Search
        </button>
      </form>

      {polished.length === 0 ? (
        <EmptyState
          title={search ? "No polished diamonds match your search" : "No polished diamonds yet"}
          description={search ? "Try a different search." : "Receive polished output from a cutting-polishing job to see it here."}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {polished.map((p) => {
            const expanded = expandedId === p.id;
            return (
              <li key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {p.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed URL expires; not a Next/Image-cacheable asset
                      <img
                        src={p.photoUrl}
                        alt={`${p.polishedCode} photo`}
                        className="h-12 w-12 rounded-lg border border-[var(--border)] object-cover"
                      />
                    ) : null}
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{p.polishedCode}</p>
                      <StatusPill status={p.status} />
                    </div>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {shapeLabel(p.shape)} · {p.carat}ct · Job {p.jobCode}
                      {p.lotCode ? ` · Lot ${p.lotCode}` : ""} · {CERT_LABELS[p.certificateStatus] ?? p.certificateStatus}
                    </p>
                  </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isOwner ? (
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        ₹{p.allocatedCost} (₹{p.costPerCarat}/ct)
                      </span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : p.id)}
                      className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
                    >
                      {expanded ? "Hide details" : "Details"}
                    </button>
                  </div>
                </div>

                {expanded ? (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--surface-muted)] p-3 text-xs text-zinc-600 dark:text-zinc-400">
                    <span>
                      {p.lengthMm ? `L ${p.lengthMm}mm` : null} {p.widthMm ? `W ${p.widthMm}mm` : null}{" "}
                      {p.heightMm ? `H ${p.heightMm}mm` : null}
                      {!p.lengthMm && !p.widthMm && !p.heightMm ? "No measurements recorded" : null}
                    </span>
                    {p.certFileUrl ? (
                      <a
                        href={p.certFileUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
                      >
                        View certificate
                      </a>
                    ) : null}
                    {isOwner && p.status === "AVAILABLE" ? <RecutForm polishedDiamondId={p.id} polishedCode={p.polishedCode} /> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
