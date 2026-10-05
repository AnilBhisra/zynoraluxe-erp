"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { RoughPurchaseForm } from "@/components/diamond/RoughPurchaseForm";
import { OverrideRoughAllocationForm } from "@/components/diamond/OverrideAllocationForms";
import { ConvertRoughToParcelForm } from "@/components/diamond/ConvertRoughToParcelForm";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PartyOption } from "@/components/accounting/PartySelect";
import { originText, pcsCt, type SerializedRoughOrigin } from "@/components/diamond/roughOrigin";

/** Prisma `Decimal` fields converted to plain strings before crossing the
 * Server -> Client boundary — same rule as SerializedVoucherRow. */
export type SerializedRoughPiece = {
  id: string;
  roughCode: string;
  /** STONE = one individual stone; PARCEL = many stones in one row. */
  kind: "STONE" | "PARCEL";
  /** Stones still in a parcel where recorded. */
  pieceCount: number | null;
  /** The parcel as first recorded — its carat and stone count never change. */
  originalCarat: string | null;
  originalPieceCount: number | null;
  /** Owner-only. */
  originalCost: string | null;
  /** Set on a portion split off a parcel: the parcel it came from. */
  parentRoughCode: string | null;
  /** Set while this row is out on an open job: what is genuinely still pending. */
  withParty: { jobCode: string; partyName: string; issuedCarat: string; pendingCarat: string } | null;
  /** For a parcel, the carat REMAINING in it now. */
  carat: string;
  /** Owner-only — null for Staff (redacted on the server). */
  allocatedCost: string | null;
  costLocked: boolean;
  status: string;
  colorEstimate: string | null;
  clarityNote: string | null;
  returnedFromJobCode: string | null;
  /** Processed / returned rough: the job and receipt it came back from (weights and counts only). */
  origin: SerializedRoughOrigin | null;
  /** Set when an Owner converted this row from a single stone into a parcel. */
  convertedToParcel: { at: string; byName: string | null; reason: string } | null;
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
  WITH_KARIGAR: "With Manufacturer / Karigar",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  MERGED_BACK: "Issue cancelled — merged back",
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
  returnedRough = [],
  isOwner,
  search,
}: {
  lots: SerializedRoughLot[];
  /** Rough with no purchase lot: processed returns (stones or batch parcels), unused leftovers, and portions split off them. */
  returnedRough?: SerializedRoughPiece[];
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
  const [convertedNotice, setConvertedNotice] = useState<string | null>(null);

  function handleSaved() {
    router.refresh();
  }

  function handleConverted(roughCode: string) {
    setConvertedNotice(`${roughCode} is now a parcel — it can be issued in part. Its carat, cost, purchase and supplier balance are unchanged.`);
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

      {convertedNotice ? (
        <div data-testid="converted-notice">
          <Alert tone="success">{convertedNotice}</Alert>
        </div>
      ) : null}

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
                            <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">
                              {piece.roughCode}
                              <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                                {piece.kind === "PARCEL" ? (piece.parentRoughCode ? "Issued portion" : "Parcel") : "Stone"}
                              </span>
                              {piece.parentRoughCode ? (
                                <span className="block text-xs font-normal text-zinc-500 dark:text-zinc-400">
                                  split from {piece.parentRoughCode}
                                </span>
                              ) : null}
                              {piece.convertedToParcel ? (
                                <span className="block text-xs font-normal text-zinc-500 dark:text-zinc-400" data-testid="converted-note">
                                  Converted from a stone on {new Date(piece.convertedToParcel.at).toLocaleDateString("en-IN")}
                                  {piece.convertedToParcel.byName ? ` by ${piece.convertedToParcel.byName}` : ""}: {piece.convertedToParcel.reason}
                                </span>
                              ) : null}
                              {isOwner && piece.kind === "STONE" && piece.status === "AVAILABLE" && !piece.costLocked ? (
                                <div className="mt-2 font-normal">
                                  <ConvertRoughToParcelForm roughPieceId={piece.id} roughCode={piece.roughCode} onDone={handleConverted} />
                                </div>
                              ) : null}
                            </td>
                            <td className="px-3 py-2">
                              {piece.kind === "PARCEL" && piece.pieceCount != null ? pcsCt(piece.pieceCount, piece.carat) : piece.kind === "STONE" ? pcsCt(1, piece.carat) : `${piece.carat} ct`}
                              {piece.kind === "PARCEL" && !piece.parentRoughCode && piece.originalCarat && piece.originalCarat !== piece.carat ? (
                                <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                                  remaining of {piece.originalCarat}ct bought
                                </span>
                              ) : null}
                            </td>
                            {isOwner ? (
                              <td className="px-3 py-2">
                                {formatMoney(piece.allocatedCost)}
                                {piece.kind === "PARCEL" && !piece.parentRoughCode && piece.originalCost && piece.originalCost !== piece.allocatedCost ? (
                                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                                    of {formatMoney(piece.originalCost)} bought
                                  </span>
                                ) : null}
                              </td>
                            ) : null}
                            <td className="px-3 py-2">
                              <StatusPill status={piece.status === "CANCELLED" && piece.parentRoughCode ? "MERGED_BACK" : piece.status} />
                              {piece.withParty ? (
                                <span className="mt-1 block text-xs text-zinc-500 dark:text-zinc-400">
                                  {piece.withParty.partyName} · {piece.withParty.jobCode}: {piece.withParty.pendingCarat}ct still pending of{" "}
                                  {piece.withParty.issuedCarat}ct issued
                                </span>
                              ) : null}
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

      {returnedRough.length > 0 ? <ReturnedRoughSection rows={returnedRough} isOwner={isOwner} /> : null}
    </div>
  );
}

/** Rough that came back from a Manufacturer (or was split off such rough): one card per row, pcs and ct always together. */
function ReturnedRoughSection({ rows, isOwner }: { rows: SerializedRoughPiece[]; isOwner: boolean }) {
  return (
    <section className="flex flex-col gap-2" data-testid="returned-rough">
      <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Processed and returned rough</h2>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Rough returned by a Manufacturer (4P / Laser and other rough processes) or left over on a receipt. A batch return is one parcel:
        its stones were counted and weighed together, so no single stone has its own weight.
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((p) => {
          const stones = p.kind === "PARCEL" ? p.pieceCount : 1;
          const changed = p.kind === "PARCEL" && p.originalCarat != null && (p.originalCarat !== p.carat || p.originalPieceCount !== p.pieceCount);
          return (
            <li key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm" data-testid={`returned-rough-${p.roughCode}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-zinc-900 dark:text-zinc-50">
                  {p.roughCode}
                  <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {p.kind === "PARCEL" ? (p.parentRoughCode ? "Issued portion" : "Batch parcel") : "Stone"}
                  </span>
                </p>
                <StatusPill status={p.status === "CANCELLED" && p.parentRoughCode ? "MERGED_BACK" : p.status} />
              </div>
              <p className="mt-1 font-medium text-zinc-800 dark:text-zinc-200" data-testid="returned-rough-balance">
                {stones != null ? pcsCt(stones, p.carat) : `${p.carat} ct (stones not counted)`}
                {changed ? (
                  <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                    {" "}
                    remaining of {pcsCt(p.originalPieceCount ?? 0, p.originalCarat!)} returned
                  </span>
                ) : null}
                {isOwner && p.allocatedCost != null ? (
                  <span className="text-xs font-normal text-zinc-600 dark:text-zinc-400">
                    {" "}
                    · {formatMoney(p.allocatedCost)}
                    {changed && p.originalCost ? ` of ${formatMoney(p.originalCost)}` : ""}
                  </span>
                ) : null}
              </p>
              {p.origin ? (
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400" data-testid="returned-rough-origin">
                  {originText(p.origin)}
                </p>
              ) : p.returnedFromJobCode ? (
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">Returned from job {p.returnedFromJobCode}</p>
              ) : null}
              {p.withParty ? (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {p.withParty.partyName} · {p.withParty.jobCode}: {p.withParty.pendingCarat} ct still pending of {p.withParty.issuedCarat} ct issued
                </p>
              ) : null}
              {p.colorEstimate || p.clarityNote ? (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{[p.colorEstimate, p.clarityNote].filter(Boolean).join(" · ")}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
