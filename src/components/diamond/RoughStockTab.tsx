"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { RoughPurchaseForm } from "@/components/diamond/RoughPurchaseForm";
import { OverrideRoughAllocationForm } from "@/components/diamond/OverrideAllocationForms";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PartyOption } from "@/components/accounting/PartySelect";

/** Prisma `Decimal` fields converted to plain strings before crossing the
 * Server -> Client boundary — same rule as SerializedVoucherRow. */
export type SerializedRoughPiece = {
  id: string;
  roughCode: string;
  carat: string;
  /** Owner-only — null for Staff (redacted on the server). */
  allocatedCost: string | null;
  costLocked: boolean;
  status: string;
  colorEstimate: string | null;
  clarityNote: string | null;
  returnedFromJobCode: string | null;
  photoUrl: string | null;
};

export type SerializedRoughLot = {
  id: string;
  lotCode: string;
  purchaseDate: string;
  supplierName: string;
  piecesCount: number;
  totalRoughCarat: string;
  /** Owner-only — null for Staff (redacted on the server). */
  totalPurchaseCost: string | null;
  status: string;
  availableCarat: string;
  photoUrl: string | null;
  pieces: SerializedRoughPiece[];
};

function formatMoney(v: string | null) {
  if (v === null) return "—";
  return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: "Available",
  PARTLY_ISSUED: "Partly Issued",
  FULLY_ISSUED: "Fully Issued",
  WITH_KARIGAR: "With Karigar",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

function StatusPill({ status }: { status: string }) {
  const tone =
    status === "AVAILABLE"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
      : status === "WITH_KARIGAR" || status === "FULLY_ISSUED" || status === "PARTLY_ISSUED"
        ? "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
        : status === "CANCELLED"
          ? "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400"
          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400";
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function RoughStockTab({
  lots,
  suppliers,
  paymentAccounts,
  gstRates,
  isOwner,
  search,
}: {
  lots: SerializedRoughLot[];
  suppliers: PartyOption[];
  paymentAccounts: { id: string; name: string; method: string }[];
  gstRates: { id: string; label: string; ratePercent: string }[];
  isOwner: boolean;
  search: string;
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [expandedLotId, setExpandedLotId] = useState<string | null>(null);
  const [overrideLotId, setOverrideLotId] = useState<string | null>(null);

  function handleSaved() {
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Rough purchases and stock</h2>
        <Button type="button" variant={showForm ? "primary" : "secondary"} size="md" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Close" : "New Rough Purchase"}
        </Button>
      </div>

      {showForm ? (
        <RoughPurchaseForm
          suppliers={suppliers}
          paymentAccounts={paymentAccounts}
          gstRates={gstRates}
          canOverrideCost={isOwner}
          onDone={handleSaved}
        />
      ) : null}

      <form method="GET" action="/diamond" className="flex gap-2">
        <input type="hidden" name="tab" value="rough" />
        <input
          type="text"
          name="roughSearch"
          defaultValue={search}
          placeholder="Search by lot code, rough ID or supplier…"
          className="h-11 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        <button
          type="submit"
          className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          Search
        </button>
      </form>

      {lots.length === 0 ? (
        <EmptyState
          title={search ? "No rough lots match your search" : "No rough purchases yet"}
          description={search ? "Try a different search." : "Record your first rough diamond purchase above."}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {lots.map((lot) => {
            const expanded = expandedLotId === lot.id;
            const canOverride = isOwner && lot.pieces.every((p) => !p.costLocked);
            return (
              <li key={lot.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {lot.photoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed URL expires; not a Next/Image-cacheable asset
                      <img
                        src={lot.photoUrl}
                        alt={`${lot.lotCode} photo`}
                        className="h-12 w-12 rounded-lg border border-[var(--border)] object-cover"
                      />
                    ) : null}
                    <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{lot.lotCode}</p>
                      <StatusPill status={lot.status} />
                    </div>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {lot.supplierName} · {new Date(lot.purchaseDate).toLocaleDateString("en-IN")} · {lot.piecesCount}{" "}
                      piece{lot.piecesCount === 1 ? "" : "s"} · {lot.totalRoughCarat}ct
                      {isOwner ? <> · {formatMoney(lot.totalPurchaseCost)}</> : null}
                    </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      Available: {lot.availableCarat}ct
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="md"
                      onClick={() => setExpandedLotId(expanded ? null : lot.id)}
                    >
                      {expanded ? "Hide pieces" : "View pieces"}
                    </Button>
                    {canOverride ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="md"
                        onClick={() => setOverrideLotId(overrideLotId === lot.id ? null : lot.id)}
                      >
                        Adjust cost split
                      </Button>
                    ) : null}
                  </div>
                </div>

                {overrideLotId === lot.id ? (
                  <div className="mt-3">
                    <OverrideRoughAllocationForm lot={lot} onDone={handleSaved} />
                  </div>
                ) : null}

                {expanded ? (
                  <div className="mt-3 overflow-x-auto rounded-lg border border-[var(--border)]">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead className="bg-[var(--surface-muted)] text-left text-xs text-zinc-500 dark:text-zinc-400">
                        <tr>
                          <th className="px-3 py-2"></th>
                          <th className="px-3 py-2">Rough ID</th>
                          <th className="px-3 py-2">Carat</th>
                          {isOwner ? <th className="px-3 py-2">Cost</th> : null}
                          <th className="px-3 py-2">Status</th>
                          <th className="px-3 py-2">Notes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {lot.pieces.map((piece) => (
                          <tr key={piece.id}>
                            <td className="px-3 py-2">
                              {piece.photoUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element -- signed URL expires
                                <img
                                  src={piece.photoUrl}
                                  alt={`${piece.roughCode} photo`}
                                  className="h-8 w-8 rounded object-cover"
                                />
                              ) : null}
                            </td>
                            <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">{piece.roughCode}</td>
                            <td className="px-3 py-2">{piece.carat}ct</td>
                            {isOwner ? <td className="px-3 py-2">{formatMoney(piece.allocatedCost)}</td> : null}
                            <td className="px-3 py-2">
                              <StatusPill status={piece.status} />
                            </td>
                            <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                              {[piece.colorEstimate, piece.clarityNote].filter(Boolean).join(" · ") || "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
