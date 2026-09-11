"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import { receiveFinishedJewelleryAction } from "@/app/actions/jewellery";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { JewelleryPhotoUploadField } from "@/components/jewellery/PhotoUploadField";
import { JEWELLERY_TYPES } from "@/lib/jewellery/types";

export type MetalPurityOption = { id: string; metalType: string; displayName: string; finenessPercent: string };
export type UnresolvedDiamondOption = { polishedDiamondId: string; polishedCode: string; shape: string; carat: string };

type OutputDraft = {
  jewelleryType: string;
  description: string;
  quantity: string;
  grossWeight: string;
  netMetalWeight: string;
  metalType: string;
  purityId: string;
  diamondIds: string[];
  photoAssetId: string | null;
  qcStatus: "PASSED" | "NEEDS_CORRECTION" | "REJECTED";
  notes: string;
};

function emptyOutput(defaultMetalType: string, defaultPurityId: string, jewelleryType: string): OutputDraft {
  return {
    jewelleryType,
    description: "",
    quantity: "1",
    grossWeight: "",
    netMetalWeight: "",
    metalType: defaultMetalType,
    purityId: defaultPurityId,
    diamondIds: [],
    photoAssetId: null,
    qcStatus: "PASSED",
    notes: "",
  };
}

type MetalReturnScrapLineDraft = { purityId: string; grossWeight: string };
function emptyReturnScrapLine(defaultPurityId: string): MetalReturnScrapLineDraft {
  return { purityId: defaultPurityId, grossWeight: "" };
}

export function ReceiveFinishedForm({
  jobId,
  jobCode,
  jewelleryType,
  pendingFineWeight,
  purities,
  issuedPurityIds,
  unresolvedDiamonds,
  isOwner,
  onDone,
}: {
  jobId: string;
  jobCode: string;
  jewelleryType: string;
  pendingFineWeight: number;
  purities: MetalPurityOption[];
  /** Purities this job actually issued metal in — return/scrap lines may
   * only name one of these, never any purity in the system at large. */
  issuedPurityIds: string[];
  unresolvedDiamonds: UnresolvedDiamondOption[];
  isOwner: boolean;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(receiveFinishedJewelleryAction, undefined);
  const issuedPurities = useMemo(
    () => purities.filter((p) => issuedPurityIds.includes(p.id)),
    [purities, issuedPurityIds]
  );
  const defaultMetalType = issuedPurities[0]?.metalType ?? purities[0]?.metalType ?? "GOLD";
  const defaultIssuedPurityId = issuedPurities[0]?.id ?? "";
  const [outputs, setOutputs] = useState<OutputDraft[]>([emptyOutput(defaultMetalType, defaultIssuedPurityId, jewelleryType)]);
  const [returnedLines, setReturnedLines] = useState<MetalReturnScrapLineDraft[]>([emptyReturnScrapLine(defaultIssuedPurityId)]);
  const [scrapLines, setScrapLines] = useState<MetalReturnScrapLineDraft[]>([emptyReturnScrapLine(defaultIssuedPurityId)]);
  const [diamondResolutions, setDiamondResolutions] = useState<Record<string, "RETURNED" | "DAMAGED_LOST">>({});
  const [damagedLostReasons, setDamagedLostReasons] = useState<Record<string, string>>({});
  const [karigarAddedFineWeight, setKarigarAddedFineWeight] = useState("0");
  const [karigarAddedCost, setKarigarAddedCost] = useState("0");
  const [labourCharge, setLabourCharge] = useState("0");
  const [makingCharge, setMakingCharge] = useState("0");
  const [settingCharge, setSettingCharge] = useState("0");
  const [platingCharge, setPlatingCharge] = useState("0");
  const [otherExpense, setOtherExpense] = useState("0");
  const [markJobComplete, setMarkJobComplete] = useState(false);
  const [isAbnormalLoss, setIsAbnormalLoss] = useState(false);
  const [abnormalLossReason, setAbnormalLossReason] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [notes, setNotes] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  const purityById = useMemo(() => new Map(purities.map((p) => [p.id, p])), [purities]);

  function updateOutput(index: number, patch: Partial<OutputDraft>) {
    setOutputs((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  }
  function addOutput() {
    setOutputs((prev) => [...prev, emptyOutput(defaultMetalType, defaultIssuedPurityId, jewelleryType)]);
  }
  function removeOutput(index: number) {
    setOutputs((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function updateReturnedLine(index: number, patch: Partial<MetalReturnScrapLineDraft>) {
    setReturnedLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addReturnedLine() {
    setReturnedLines((prev) => [...prev, emptyReturnScrapLine(defaultIssuedPurityId)]);
  }
  function removeReturnedLine(index: number) {
    setReturnedLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }
  function updateScrapLine(index: number, patch: Partial<MetalReturnScrapLineDraft>) {
    setScrapLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addScrapLine() {
    setScrapLines((prev) => [...prev, emptyReturnScrapLine(defaultIssuedPurityId)]);
  }
  function removeScrapLine(index: number) {
    setScrapLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  const assignedDiamondIds = useMemo(() => new Set(outputs.flatMap((o) => o.diamondIds)), [outputs]);
  const remainingDiamonds = unresolvedDiamonds.filter((d) => !assignedDiamondIds.has(d.polishedDiamondId));

  function toggleDiamondForOutput(outputIndex: number, polishedDiamondId: string) {
    setDiamondResolutions((prev) => {
      const next = { ...prev };
      delete next[polishedDiamondId];
      return next;
    });
    setOutputs((prev) =>
      prev.map((o, i) => {
        if (i !== outputIndex) {
          return { ...o, diamondIds: o.diamondIds.filter((id) => id !== polishedDiamondId) };
        }
        const has = o.diamondIds.includes(polishedDiamondId);
        return { ...o, diamondIds: has ? o.diamondIds.filter((id) => id !== polishedDiamondId) : [...o.diamondIds, polishedDiamondId] };
      })
    );
  }

  function setRemainingResolution(polishedDiamondId: string, resolution: "RETURNED" | "DAMAGED_LOST" | null) {
    setDiamondResolutions((prev) => {
      const next = { ...prev };
      if (resolution === null) delete next[polishedDiamondId];
      else next[polishedDiamondId] = resolution;
      return next;
    });
  }

  function fineWeightOf(grossWeight: number, purityId: string): number {
    const purity = purityById.get(purityId);
    if (!purity) return 0;
    return (grossWeight * Number(purity.finenessPercent)) / 100;
  }

  const outputsFineWeight = outputs.reduce((sum, o) => sum + fineWeightOf(Number(o.netMetalWeight) || 0, o.purityId), 0);
  const returnedFineWeight = returnedLines.reduce((sum, l) => sum + fineWeightOf(Number(l.grossWeight) || 0, l.purityId), 0);
  const scrapFineWeight = scrapLines.reduce((sum, l) => sum + fineWeightOf(Number(l.grossWeight) || 0, l.purityId), 0);
  const karigarAdded = Number(karigarAddedFineWeight) || 0;
  const pendingAvailable = pendingFineWeight + karigarAdded;
  const resolvedThisReceipt = outputsFineWeight + returnedFineWeight + scrapFineWeight;
  const exceedsAvailable = resolvedThisReceipt > pendingAvailable + 0.0005;
  const gap = pendingAvailable - resolvedThisReceipt;
  const willCompleteMetal = gap <= 0.0005 || markJobComplete;
  const previewLoss = willCompleteMetal ? Math.max(0, gap) : 0;
  const allDiamondsResolvedThisReceipt = remainingDiamonds.every((d) => diamondResolutions[d.polishedDiamondId]);
  const willCompleteJob = willCompleteMetal && allDiamondsResolvedThisReceipt;

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (exceedsAvailable) {
      window.alert("Finished plus returned plus scrap fine weight cannot exceed the fine weight still pending for this job.");
      event.preventDefault();
      return;
    }
    for (const d of remainingDiamonds) {
      const resolution = diamondResolutions[d.polishedDiamondId];
      if (resolution === "DAMAGED_LOST" && (damagedLostReasons[d.polishedDiamondId] ?? "").trim().length < 3) {
        window.alert(`Give a reason for marking diamond ${d.polishedCode} damaged/lost.`);
        event.preventDefault();
        return;
      }
    }
    if (isAbnormalLoss && abnormalLossReason.trim().length < 3) {
      window.alert("Give a reason for classifying this loss as abnormal.");
      event.preventDefault();
      return;
    }
    const summary = willCompleteJob
      ? `This will COMPLETE job ${jobCode}.`
      : willCompleteMetal
        ? `Metal is fully resolved but some diamonds remain unresolved — job ${jobCode} will stay Partially Received.`
        : `Partial receipt for job ${jobCode}. ${Math.max(0, gap).toFixed(3)}g fine metal remains with the Karigar.`;
    if (!window.confirm(`${summary}\n\nSave this receipt?`)) {
      event.preventDefault();
    }
  }

  const outputsForSubmit = outputs
    .filter((o) => Number(o.netMetalWeight) > 0)
    .map((o) => ({
      jewelleryType: o.jewelleryType,
      description: o.description || undefined,
      quantity: o.quantity || "1",
      grossWeight: o.grossWeight || undefined,
      netMetalWeight: o.netMetalWeight,
      metalType: o.metalType,
      purityId: o.purityId,
      diamondIds: o.diamondIds,
      photoAssetId: o.photoAssetId || undefined,
      qcStatus: o.qcStatus,
      notes: o.notes || undefined,
    }));

  const returnedLinesForSubmit = returnedLines
    .filter((l) => l.purityId && Number(l.grossWeight) > 0)
    .map((l) => ({ purityId: l.purityId, grossWeight: l.grossWeight }));
  const scrapLinesForSubmit = scrapLines
    .filter((l) => l.purityId && Number(l.grossWeight) > 0)
    .map((l) => ({ purityId: l.purityId, grossWeight: l.grossWeight }));

  const setResolutions = outputs.flatMap((o) => o.diamondIds.map((id) => ({ polishedDiamondId: id, resolution: "SET" as const })));
  const remainingResolutionsForSubmit = Object.entries(diamondResolutions).map(([polishedDiamondId, resolution]) => ({
    polishedDiamondId,
    resolution,
    damagedLostReason: resolution === "DAMAGED_LOST" ? damagedLostReasons[polishedDiamondId] || undefined : undefined,
  }));
  const diamondResolutionsForSubmit = [...setResolutions, ...remainingResolutionsForSubmit];

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="outputsJson" value={JSON.stringify(outputsForSubmit)} />
      <input type="hidden" name="diamondResolutionsJson" value={JSON.stringify(diamondResolutionsForSubmit)} />
      <input type="hidden" name="returnedMetalLinesJson" value={JSON.stringify(returnedLinesForSubmit)} />
      <input type="hidden" name="scrapMetalLinesJson" value={JSON.stringify(scrapLinesForSubmit)} />
      <input type="hidden" name="markJobComplete" value={markJobComplete ? "true" : "false"} />
      <input type="hidden" name="isAbnormalLoss" value={isAbnormalLoss ? "true" : "false"} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Receipt saved as {state.code}.</Alert> : null}

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Pending with Karigar: <span className="font-semibold text-zinc-900 dark:text-zinc-50">{pendingFineWeight.toFixed(3)}g fine metal</span>
      </p>

      <Field label="Receive date" name="receiveDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Finished jewellery outputs ({outputsFineWeight.toFixed(3)}g fine metal)
        </h3>
        {outputs.map((output, index) => {
          const purityOptions = issuedPurities.filter((p) => p.metalType === output.metalType);
          return (
            <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <select
                  aria-label="Jewellery type"
                  value={output.jewelleryType}
                  onChange={(e) => updateOutput(index, { jewelleryType: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  {JEWELLERY_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Description"
                  placeholder="Description (optional)"
                  value={output.description}
                  onChange={(e) => updateOutput(index, { description: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <input
                  aria-label="Quantity"
                  type="number"
                  min="1"
                  placeholder="Qty"
                  value={output.quantity}
                  onChange={(e) => updateOutput(index, { quantity: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <input
                  aria-label="Net metal weight"
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="Net metal weight (g)"
                  value={output.netMetalWeight}
                  onChange={(e) => updateOutput(index, { netMetalWeight: e.target.value })}
                  className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
              </div>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-4">
                <select
                  aria-label="Metal type"
                  value={output.metalType}
                  onChange={(e) => {
                    const nextPurity = issuedPurities.find((p) => p.metalType === e.target.value)?.id ?? "";
                    updateOutput(index, { metalType: e.target.value, purityId: nextPurity });
                  }}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  {[...new Set(issuedPurities.map((p) => p.metalType))].map((mt) => (
                    <option key={mt} value={mt}>
                      {mt}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Final purity"
                  value={output.purityId}
                  onChange={(e) => updateOutput(index, { purityId: e.target.value })}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  {purityOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Gross weight"
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="Gross weight (optional)"
                  value={output.grossWeight}
                  onChange={(e) => updateOutput(index, { grossWeight: e.target.value })}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
                <select
                  aria-label="QC status"
                  value={output.qcStatus}
                  onChange={(e) => updateOutput(index, { qcStatus: e.target.value as OutputDraft["qcStatus"] })}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  <option value="PASSED">QC: Passed</option>
                  <option value="NEEDS_CORRECTION">QC: Needs Correction</option>
                  <option value="REJECTED">QC: Rejected</option>
                </select>
              </div>

              {unresolvedDiamonds.length > 0 ? (
                <div className="mt-2">
                  <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Diamonds set in this piece</p>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {unresolvedDiamonds
                      .filter((d) => output.diamondIds.includes(d.polishedDiamondId) || remainingDiamonds.includes(d))
                      .map((d) => (
                        <label
                          key={d.polishedDiamondId}
                          className="flex items-center gap-1.5 rounded-full border border-[var(--border)] px-2.5 py-1 text-xs text-zinc-600 dark:text-zinc-400"
                        >
                          <input
                            type="checkbox"
                            checked={output.diamondIds.includes(d.polishedDiamondId)}
                            onChange={() => toggleDiamondForOutput(index, d.polishedDiamondId)}
                            className="h-3.5 w-3.5 rounded border-zinc-300"
                          />
                          {d.polishedCode} ({d.carat}ct)
                        </label>
                      ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <JewelleryPhotoUploadField
                  category="jewellery-finished"
                  label="Finished photo"
                  assetId={output.photoAssetId}
                  onUploaded={(assetId) => updateOutput(index, { photoAssetId: assetId })}
                />
                {outputs.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => removeOutput(index)}
                    className="ml-auto text-xs font-medium text-red-600 hover:underline dark:text-red-400"
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
        <Button type="button" variant="secondary" size="md" onClick={addOutput} className="self-start">
          + Add another output
        </Button>
      </div>

      {remainingDiamonds.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/30">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            Remaining issued diamonds not set in an output ({remainingDiamonds.length})
          </h3>
          {remainingDiamonds.map((d) => (
            <div key={d.polishedDiamondId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-700 dark:text-zinc-300">
                {d.polishedCode} · {d.shape} · {d.carat}ct
              </span>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="radio"
                  name={`resolution-${d.polishedDiamondId}`}
                  checked={diamondResolutions[d.polishedDiamondId] === "RETURNED"}
                  onChange={() => setRemainingResolution(d.polishedDiamondId, "RETURNED")}
                />
                Return to stock
              </label>
              {isOwner ? (
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="radio"
                    name={`resolution-${d.polishedDiamondId}`}
                    checked={diamondResolutions[d.polishedDiamondId] === "DAMAGED_LOST"}
                    onChange={() => setRemainingResolution(d.polishedDiamondId, "DAMAGED_LOST")}
                  />
                  Damaged/Lost (Owner)
                </label>
              ) : null}
              <label className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                <input
                  type="radio"
                  name={`resolution-${d.polishedDiamondId}`}
                  checked={!diamondResolutions[d.polishedDiamondId]}
                  onChange={() => setRemainingResolution(d.polishedDiamondId, null)}
                />
                Leave with Karigar
              </label>
              {diamondResolutions[d.polishedDiamondId] === "DAMAGED_LOST" ? (
                <input
                  type="text"
                  placeholder="Reason (required)"
                  value={damagedLostReasons[d.polishedDiamondId] ?? ""}
                  onChange={(e) => setDamagedLostReasons((prev) => ({ ...prev, [d.polishedDiamondId]: e.target.value }))}
                  className="h-8 flex-1 min-w-[10rem] rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            Returned unused metal ({returnedFineWeight.toFixed(3)}g fine)
          </h3>
          {issuedPurities.length > 1 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              This job issued more than one purity — say exactly which purity each returned amount belongs to.
            </p>
          ) : null}
        </div>
        {returnedLines.map((line, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Returned metal purity"
              value={line.purityId}
              onChange={(e) => updateReturnedLine(index, { purityId: e.target.value })}
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              <option value="">Choose purity…</option>
              {issuedPurities.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.metalType} · {p.displayName}
                </option>
              ))}
            </select>
            <input
              aria-label="Returned gross weight"
              type="number"
              step="0.001"
              min="0"
              placeholder="Gross weight (g)"
              value={line.grossWeight}
              onChange={(e) => updateReturnedLine(index, { grossWeight: e.target.value })}
              className="h-10 w-40 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            />
            {returnedLines.length > 1 ? (
              <button
                type="button"
                onClick={() => removeReturnedLine(index)}
                className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {issuedPurities.length > 1 ? (
          <Button type="button" variant="secondary" size="md" onClick={addReturnedLine} className="self-start">
            + Add another returned-metal purity
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            Recoverable scrap ({scrapFineWeight.toFixed(3)}g fine)
          </h3>
          {issuedPurities.length > 1 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Say exactly which purity each scrap amount belongs to.
            </p>
          ) : null}
        </div>
        {scrapLines.map((line, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Scrap metal purity"
              value={line.purityId}
              onChange={(e) => updateScrapLine(index, { purityId: e.target.value })}
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            >
              <option value="">Choose purity…</option>
              {issuedPurities.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.metalType} · {p.displayName}
                </option>
              ))}
            </select>
            <input
              aria-label="Scrap gross weight"
              type="number"
              step="0.001"
              min="0"
              placeholder="Gross weight (g)"
              value={line.grossWeight}
              onChange={(e) => updateScrapLine(index, { grossWeight: e.target.value })}
              className="h-10 w-40 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
            />
            {scrapLines.length > 1 ? (
              <button
                type="button"
                onClick={() => removeScrapLine(index)}
                className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
              >
                Remove
              </button>
            ) : null}
          </div>
        ))}
        {issuedPurities.length > 1 ? (
          <Button type="button" variant="secondary" size="md" onClick={addScrapLine} className="self-start">
            + Add another scrap purity
          </Button>
        ) : null}
      </div>

      {gap > 0.0005 ? (
        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={markJobComplete}
            onChange={(e) => setMarkJobComplete(e.target.checked)}
            className="h-4 w-4 rounded border-zinc-300"
          />
          This completes the job — no more metal will come back from this Karigar
        </label>
      ) : null}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm">
        <p>
          Finished: <span className="font-semibold">{outputsFineWeight.toFixed(3)}g</span>
        </p>
        <p>
          Returned: <span className="font-semibold">{returnedFineWeight.toFixed(3)}g</span> · Scrap:{" "}
          <span className="font-semibold">{scrapFineWeight.toFixed(3)}g</span>
        </p>
        <p>
          {willCompleteMetal ? "Process loss (fine metal)" : "Still with Karigar (not yet resolved)"}:{" "}
          <span className="font-semibold">{willCompleteMetal ? previewLoss.toFixed(3) : Math.max(0, gap).toFixed(3)}g</span>
        </p>
        {willCompleteJob ? (
          <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">This job will be marked Completed.</p>
        ) : willCompleteMetal ? (
          <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            Metal is fully resolved, but unresolved diamonds remain — this job will stay Partially Received.
          </p>
        ) : (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">This job will be marked Partially Received.</p>
        )}
      </div>

      {isOwner && willCompleteMetal && previewLoss > 0.0005 ? (
        <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={isAbnormalLoss}
            onChange={(e) => setIsAbnormalLoss(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-zinc-300"
          />
          <span>
            Classify this loss as abnormal (Owner only) — posts to Business Expenses instead of being absorbed into the finished
            jewellery cost
          </span>
        </label>
      ) : null}
      {isAbnormalLoss ? (
        <input
          type="text"
          name="abnormalLossReason"
          placeholder="Reason for abnormal loss (required)"
          value={abnormalLossReason}
          onChange={(e) => setAbnormalLossReason(e.target.value)}
          className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide charges & notes" : "Labour, making, setting, plating charges & notes"}
        </button>
      </div>

      {showMore ? (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-3">
          <Field label="Labour charge (₹)" name="labourCharge" type="number" step="0.01" min={0} value={labourCharge} onChange={(e) => setLabourCharge(e.target.value)} />
          <Field label="Making charge (₹)" name="makingCharge" type="number" step="0.01" min={0} value={makingCharge} onChange={(e) => setMakingCharge(e.target.value)} />
          <Field label="Setting charge (₹)" name="settingCharge" type="number" step="0.01" min={0} value={settingCharge} onChange={(e) => setSettingCharge(e.target.value)} />
          <Field label="Plating charge (₹)" name="platingCharge" type="number" step="0.01" min={0} value={platingCharge} onChange={(e) => setPlatingCharge(e.target.value)} />
          <Field label="Other job expense (₹)" name="otherExpense" type="number" step="0.01" min={0} value={otherExpense} onChange={(e) => setOtherExpense(e.target.value)} />
          <Field label="Karigar-added fine metal (g)" name="karigarAddedFineWeight" type="number" step="0.001" min={0} value={karigarAddedFineWeight} onChange={(e) => setKarigarAddedFineWeight(e.target.value)} />
          <Field label="Karigar-added material cost (₹)" name="karigarAddedCost" type="number" step="0.01" min={0} value={karigarAddedCost} onChange={(e) => setKarigarAddedCost(e.target.value)} />
          <Field label="Notes (optional)" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="sm:col-span-2" />
        </div>
      ) : null}

      <Button type="submit" size="lg" disabled={pending || exceedsAvailable} className="self-start">
        {pending ? "Saving…" : "Receive Finished Jewellery"}
      </Button>
    </form>
  );
}
