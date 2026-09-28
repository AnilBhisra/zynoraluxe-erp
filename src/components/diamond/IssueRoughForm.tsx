"use client";

import { Fragment, useActionState, useEffect, useMemo, useState } from "react";

import { issueRoughAction } from "@/app/actions/diamond";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import { PhotoUploadField } from "@/components/diamond/PhotoUploadField";
import { STANDARD_SHAPES } from "@/lib/diamond/shapes";
import { useFieldId } from "@/lib/utils/useFieldId";

export type AvailablePieceOption = {
  id: string;
  roughCode: string;
  lotCode: string | null;
  /** For a parcel, the carat still remaining in it. */
  carat: string;
  /** STONE is always issued whole; a PARCEL can be issued by carat. */
  kind: "STONE" | "PARCEL";
  /** Stones still in a parcel, where recorded. */
  pieceCount: number | null;
  /** Owner-only — null for Staff (redacted on the server). */
  allocatedCost: string | null;
};

/** Non-authoritative preview of what a partial parcel issue leaves behind and
 * carries out — the server does the exact allocation. */
function parcelPreview(p: AvailablePieceOption, isOwner: boolean, caratInput: string | undefined): string {
  const carat = Number(caratInput ?? p.carat) || 0;
  const left = Math.max(Number(p.carat) - carat, 0);
  const cost =
    isOwner && p.allocatedCost != null && Number(p.carat) > 0
      ? ` · about ₹${((Number(p.allocatedCost) * carat) / Number(p.carat)).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} of cost goes out`
      : "";
  return `${left.toFixed(3)}ct stays in stock${cost}`;
}

/** Phase 7 — an active Manufacturer process offered at issue. */
export type ProcessOption = { id: string; name: string; outputKind: "ROUGH" | "POLISHED"; defaultRateBasis: "FIXED" | "PER_CARAT" | "PER_PIECE" | "PER_ISSUED_CARAT" };

export function IssueRoughForm({
  karigars,
  availablePieces,
  processes = [],
  isOwner,
  onDone,
}: {
  karigars: PartyOption[];
  availablePieces: AvailablePieceOption[];
  processes?: ProcessOption[];
  isOwner: boolean;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(issueRoughAction, undefined);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // What to issue from each selected PARCEL (its carat, and stones where the
  // parcel's count is recorded). Individual stones are always issued whole.
  const [parcelInputs, setParcelInputs] = useState<Record<string, { carat: string; count: string }>>({});
  const [requiredShape, setRequiredShape] = useState("ROUND");
  const [showMore, setShowMore] = useState(false);
  const [customShapeReferencePhotoAssetId, setCustomShapeReferencePhotoAssetId] = useState<string | null>(null);
  const [pieceSearch, setPieceSearch] = useState("");
  const [processId, setProcessId] = useState("");
  const [chargeRateBasis, setChargeRateBasis] = useState<"" | ProcessOption["defaultRateBasis"]>("");
  const selectedProcess = processes.find((p) => p.id === processId) ?? null;
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const requiredShapeId = useFieldId();

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const filteredPieces = useMemo(() => {
    const q = pieceSearch.trim().toLowerCase();
    if (!q) return availablePieces;
    return availablePieces.filter(
      (p) => p.roughCode.toLowerCase().includes(q) || (p.lotCode ?? "").toLowerCase().includes(q)
    );
  }, [pieceSearch, availablePieces]);

  const selectedPieces = availablePieces.filter((p) => selectedIds.includes(p.id));
  const issuedCaratOf = (p: AvailablePieceOption) =>
    p.kind === "PARCEL" ? Number(parcelInputs[p.id]?.carat ?? p.carat) || 0 : Number(p.carat);
  const totalCarat = selectedPieces.reduce((sum, p) => sum + issuedCaratOf(p), 0);
  const stoneIds = selectedPieces.filter((p) => p.kind !== "PARCEL").map((p) => p.id);
  const parcelIssues = selectedPieces
    .filter((p) => p.kind === "PARCEL")
    .map((p) => {
      const input = parcelInputs[p.id] ?? { carat: p.carat, count: "" };
      return { roughPieceId: p.id, carat: input.carat, pieceCount: input.count || undefined };
    });

  function toggle(id: string) {
    const piece = availablePieces.find((p) => p.id === id);
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    if (piece?.kind === "PARCEL" && !parcelInputs[id]) {
      // Default to the whole parcel; the Owner types a smaller carat to issue part of it.
      setParcelInputs((prev) => ({
        ...prev,
        [id]: { carat: piece.carat, count: piece.pieceCount != null ? String(piece.pieceCount) : "" },
      }));
    }
  }
  function setParcelInput(id: string, patch: Partial<{ carat: string; count: string }>) {
    setParcelInputs((prev) => ({ ...prev, [id]: { carat: prev[id]?.carat ?? "", count: prev[id]?.count ?? "", ...patch } }));
  }

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (selectedIds.length === 0) {
      window.alert("Select at least one rough piece to issue.");
      event.preventDefault();
      return;
    }
    const forProcess = selectedProcess ? ` for ${selectedProcess.name}` : "";
    if (!window.confirm(`Issue ${selectedIds.length} piece(s) (${totalCarat.toFixed(3)}ct)${forProcess}?`)) {
      event.preventDefault();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="roughPieceIdsJson" value={JSON.stringify(stoneIds)} />
      <input type="hidden" name="parcelIssuesJson" value={JSON.stringify(parcelIssues)} />
      <input
        type="hidden"
        name="customShapeReferencePhotoAssetId"
        value={customShapeReferencePhotoAssetId ?? ""}
      />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Rough issued as job {state.code}.</Alert> : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PartySelect name="karigarId" parties={karigars} label="Karigar / Manufacturer" required />
        <Field label="Issue date" name="issueDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />
      </div>

      {processes.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="issue-rough-process" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Process
            </label>
            <select
              id="issue-rough-process"
              name="processId"
              value={processId}
              onChange={(e) => {
                setProcessId(e.target.value);
                const next = processes.find((p) => p.id === e.target.value);
                setChargeRateBasis(next ? next.defaultRateBasis : "");
              }}
              className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              <option value="">Cutting &amp; polishing (no process)</option>
              {processes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — returns {p.outputKind === "ROUGH" ? "rough" : "polished"}
                </option>
              ))}
            </select>
          </div>
          {selectedProcess ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="issue-rough-charge-basis" className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                  Process charge
                </label>
                <select
                  id="issue-rough-charge-basis"
                  name="chargeRateBasis"
                  value={chargeRateBasis}
                  onChange={(e) => setChargeRateBasis(e.target.value as typeof chargeRateBasis)}
                  className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  <option value="">Enter on each receipt</option>
                  <option value="PER_CARAT">Per received carat</option>
                  <option value="PER_ISSUED_CARAT">Per issued carat (weight loss included)</option>
                  <option value="PER_PIECE">Per piece</option>
                  <option value="FIXED">Fixed amount</option>
                </select>
              </div>
              {chargeRateBasis ? (
                <Field
                  label={chargeRateBasis === "FIXED" ? "Charge amount (₹)" : chargeRateBasis === "PER_PIECE" ? "Rate per piece (₹)" : "Rate per carat (₹)"}
                  name="chargeRate"
                  type="number"
                  step="0.0001"
                  min={0}
                  required
                />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Select rough pieces to issue ({selectedIds.length} selected, {totalCarat.toFixed(3)}ct)
        </h3>
        <input
          type="text"
          placeholder="Search available pieces by Rough ID or lot…"
          value={pieceSearch}
          onChange={(e) => setPieceSearch(e.target.value)}
          className="h-10 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        {filteredPieces.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No available rough pieces match.</p>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-[var(--border)]">
                {filteredPieces.map((p) => (
                  <Fragment key={p.id}>
                  <tr
                    className="cursor-pointer hover:bg-[var(--surface-muted)]"
                    onClick={() => toggle(p.id)}
                  >
                    <td className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(p.id)}
                        onChange={() => toggle(p.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 rounded border-zinc-300"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">
                      {p.roughCode}
                      <span className="ml-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                        {p.kind === "PARCEL" ? "Parcel" : "Stone"}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">{p.lotCode ?? "—"}</td>
                    <td className="px-3 py-2">
                      {p.carat}ct
                      {p.kind === "PARCEL" && p.pieceCount != null ? (
                        <span className="ml-1 text-xs text-zinc-500 dark:text-zinc-400">· {p.pieceCount} stones</span>
                      ) : null}
                    </td>
                    {isOwner ? (
                      <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">
                        ₹{Number(p.allocatedCost).toFixed(2)}
                      </td>
                    ) : null}
                  </tr>
                  {p.kind === "PARCEL" && selectedIds.includes(p.id) ? (
                    <tr className="bg-[var(--surface-muted)]">
                      <td />
                      <td colSpan={isOwner ? 4 : 3} className="px-3 py-3">
                        <div className="flex flex-wrap items-end gap-3">
                          <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                            Carat to issue
                            <input
                              aria-label={`Carat to issue from ${p.roughCode}`}
                              type="number"
                              step="0.001"
                              min="0"
                              value={parcelInputs[p.id]?.carat ?? p.carat}
                              onChange={(e) => setParcelInput(p.id, { carat: e.target.value })}
                              className="h-10 w-36 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                            />
                          </label>
                          {p.pieceCount != null ? (
                            <label className="flex flex-col gap-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
                              Stones to issue
                              <input
                                aria-label={`Stones to issue from ${p.roughCode}`}
                                type="number"
                                step="1"
                                min="1"
                                value={parcelInputs[p.id]?.count ?? ""}
                                onChange={(e) => setParcelInput(p.id, { count: e.target.value })}
                                className="h-10 w-32 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                              />
                            </label>
                          ) : null}
                          <p className="pb-2 text-xs text-zinc-500 dark:text-zinc-400">{parcelPreview(p, isOwner, parcelInputs[p.id]?.carat)}</p>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={requiredShapeId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
            Required shape <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <select
            id={requiredShapeId}
            name="requiredShape"
            value={requiredShape}
            onChange={(e) => setRequiredShape(e.target.value)}
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            {STANDARD_SHAPES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <Field label="Due date (optional)" name="dueDate" type="date" />
      </div>

      {requiredShape === "CUSTOM" ? (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
          <Field label="Custom shape name" name="customShapeName" required />
          <Field label="Required measurements (optional)" name="customShapeMeasurements" />
          <Field label="Cutting instruction (optional)" name="customShapeInstruction" className="sm:col-span-2" />
          <PhotoUploadField
            category="custom-shape-reference"
            label="Reference photo (optional)"
            assetId={customShapeReferencePhotoAssetId}
            onUploaded={setCustomShapeReferencePhotoAssetId}
          />
        </div>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide more details" : "More details (target size, notes)"}
        </button>
      </div>

      {showMore ? (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
          <Field label="Target polished carat" name="targetPolishedCarat" type="number" step="0.001" min={0} />
          <Field label="Notes" name="notes" />
          <Field label="Target L (mm)" name="targetLengthMm" type="number" step="0.001" min={0} />
          <Field label="Target W (mm)" name="targetWidthMm" type="number" step="0.001" min={0} />
          <Field label="Target H (mm)" name="targetHeightMm" type="number" step="0.001" min={0} />
        </div>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Issuing…" : "Issue Rough"}
      </Button>
    </form>
  );
}
