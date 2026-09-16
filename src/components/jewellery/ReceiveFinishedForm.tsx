"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import { receiveFinishedJewelleryAction } from "@/app/actions/jewellery";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { JewelleryPhotoUploadField } from "@/components/jewellery/PhotoUploadField";
import { JEWELLERY_TYPES, metalTypeLabel } from "@/lib/jewellery/types";
import { computeOutputMetal, fineWeightThousandths, formatThousandths, toThousandths } from "@/lib/jewellery/metalMath";

export type MetalPurityOption = { id: string; metalType: string; displayName: string; finenessPercent: string };
export type UnresolvedDiamondOption = { polishedDiamondId: string; polishedCode: string; shape: string; carat: string };
/** One purity actually issued to this job, with the fineness snapshot taken at issue time. */
export type IssuedMetalOption = {
  purityId: string;
  metalType: string;
  displayName: string;
  finenessPercent: string;
  isAlloy: boolean;
  grossWeight: string;
  fineWeight: string;
};

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

type FinalPurityOption = { id: string; displayName: string; finenessPercent: string; isIssued: boolean };

const ZERO = BigInt(0);

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

/** Weight entered by the user → thousandths; blank counts as zero, anything unparseable or negative → null. */
function parseWeight(value: string): bigint | null {
  if (value.trim() === "") return ZERO;
  try {
    const parsed = toThousandths(value);
    return parsed < ZERO ? null : parsed;
  } catch {
    return null;
  }
}

const g = formatThousandths;

export function ReceiveFinishedForm({
  jobId,
  jobCode,
  jewelleryType,
  pendingFineWeight,
  purities,
  issuedMetal,
  alloyPendingGrossWeight,
  unresolvedDiamonds,
  isOwner,
  onDone,
}: {
  jobId: string;
  jobCode: string;
  jewelleryType: string;
  pendingFineWeight: string;
  /** Active Metal/Purity master — the candidate Final Purity list for a single-source job. */
  purities: MetalPurityOption[];
  /** What this job actually issued, per purity. Return/scrap lines may only name one of these. */
  issuedMetal: IssuedMetalOption[];
  alloyPendingGrossWeight: string;
  unresolvedDiamonds: UnresolvedDiamondOption[];
  isOwner: boolean;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(receiveFinishedJewelleryAction, undefined);
  const fineBearing = useMemo(() => issuedMetal.filter((m) => !m.isAlloy), [issuedMetal]);
  const companyAlloy = useMemo(() => issuedMetal.find((m) => m.isAlloy) ?? null, [issuedMetal]);
  const defaultMetalType = fineBearing[0]?.metalType ?? "GOLD";
  const defaultIssuedPurityId = fineBearing[0]?.purityId ?? "";
  const [outputs, setOutputs] = useState<OutputDraft[]>([emptyOutput(defaultMetalType, defaultIssuedPurityId, jewelleryType)]);
  const [returnedLines, setReturnedLines] = useState<MetalReturnScrapLineDraft[]>([emptyReturnScrapLine(defaultIssuedPurityId)]);
  const [scrapLines, setScrapLines] = useState<MetalReturnScrapLineDraft[]>([emptyReturnScrapLine(defaultIssuedPurityId)]);
  const [returnedAlloy, setReturnedAlloy] = useState("");
  const [diamondResolutions, setDiamondResolutions] = useState<Record<string, "RETURNED" | "DAMAGED_LOST">>({});
  const [damagedLostReasons, setDamagedLostReasons] = useState<Record<string, string>>({});
  const [karigarAddedFineWeight, setKarigarAddedFineWeight] = useState("0");
  const [karigarAddedCost, setKarigarAddedCost] = useState("0");
  const [alloyTouched, setAlloyTouched] = useState(false);
  const [companyAlloyInput, setCompanyAlloyInput] = useState("0");
  const [karigarAlloyInput, setKarigarAlloyInput] = useState("0");
  const [karigarAlloyCost, setKarigarAlloyCost] = useState("0");
  const [includedAlloyInput, setIncludedAlloyInput] = useState("0");
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

  /** Final Purity choices for an output of `metalType` — mirrors the server rule in receiveFinishedJewellery. */
  function finalPurityOptions(metalType: string): FinalPurityOption[] {
    const sources = fineBearing.filter((m) => m.metalType === metalType);
    const issued = sources.map((s) => ({ id: s.purityId, displayName: s.displayName, finenessPercent: s.finenessPercent, isIssued: true }));
    if (sources.length !== 1) return issued;
    const sourceFineness = toThousandths(sources[0].finenessPercent);
    const lower = purities
      .filter((p) => p.metalType === metalType && p.id !== sources[0].purityId)
      .filter((p) => {
        const fineness = toThousandths(p.finenessPercent);
        return fineness > ZERO && fineness <= sourceFineness;
      })
      .sort((a, b) => Number(toThousandths(b.finenessPercent) - toThousandths(a.finenessPercent)))
      .map((p) => ({ id: p.id, displayName: p.displayName, finenessPercent: p.finenessPercent, isIssued: false }));
    return [...issued, ...lower];
  }

  function outputMetal(output: OutputDraft): { fine: bigint; alloy: bigint; valid: boolean } {
    const net = parseWeight(output.netMetalWeight);
    if (net === null) return { fine: ZERO, alloy: ZERO, valid: false };
    if (net === ZERO) return { fine: ZERO, alloy: ZERO, valid: true };
    const sources = fineBearing.filter((m) => m.metalType === output.metalType);
    const samePuritySource = sources.find((s) => s.purityId === output.purityId);
    const source = samePuritySource ?? (sources.length === 1 ? sources[0] : undefined);
    const option = finalPurityOptions(output.metalType).find((p) => p.id === output.purityId);
    if (!source || !option) return { fine: ZERO, alloy: ZERO, valid: false };
    const metal = computeOutputMetal({
      netWeight: output.netMetalWeight,
      outputFinenessPercent: option.finenessPercent,
      sourceFinenessPercent: source.finenessPercent,
      samePurity: Boolean(samePuritySource),
    });
    return { fine: metal.fine, alloy: metal.alloyAdded, valid: metal.alloyAdded >= ZERO };
  }

  function lineFine(line: MetalReturnScrapLineDraft): bigint | null {
    const gross = parseWeight(line.grossWeight);
    if (gross === null) return null;
    const purity = fineBearing.find((m) => m.purityId === line.purityId);
    if (!purity) return ZERO;
    return fineWeightThousandths(gross, toThousandths(purity.finenessPercent));
  }

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

  // ---- Reconciliation (exact thousandths — the same math the server enforces) ----
  const outputMetals = outputs.map(outputMetal);
  const outputsFine = outputMetals.reduce((sum, m) => sum + m.fine, ZERO);
  const expectedAlloy = outputMetals.reduce((sum, m) => sum + m.alloy, ZERO);
  const invalidOutput = outputMetals.some((m) => !m.valid);
  const returnedFines = returnedLines.map(lineFine);
  const scrapFines = scrapLines.map(lineFine);
  const invalidReturnOrScrap = [...returnedFines, ...scrapFines].some((v) => v === null);
  const returnedFine = returnedFines.reduce<bigint>((sum, v) => sum + (v ?? ZERO), ZERO);
  const scrapFine = scrapFines.reduce<bigint>((sum, v) => sum + (v ?? ZERO), ZERO);
  const karigarAdded = parseWeight(karigarAddedFineWeight) ?? ZERO;
  const pendingAvailable = toThousandths(pendingFineWeight) + karigarAdded;
  const resolvedThisReceipt = outputsFine + returnedFine + scrapFine;
  const exceedsAvailable = resolvedThisReceipt > pendingAvailable;
  const gap = pendingAvailable - resolvedThisReceipt;
  const willCompleteMetal = gap === ZERO || markJobComplete;
  const previewLoss = willCompleteMetal && gap > ZERO ? gap : ZERO;
  const allDiamondsResolvedThisReceipt = remainingDiamonds.every((d) => diamondResolutions[d.polishedDiamondId]);
  const willCompleteJob = willCompleteMetal && allDiamondsResolvedThisReceipt;

  // ---- Alloy Added source split ----
  const alloyPending = toThousandths(alloyPendingGrossWeight);
  const returnedAlloyWeight = parseWeight(returnedAlloy);
  const defaultCompany = companyAlloy && alloyPending >= expectedAlloy ? expectedAlloy : ZERO;
  const defaultIncluded = expectedAlloy - defaultCompany;
  const companySplit = alloyTouched ? parseWeight(companyAlloyInput) : defaultCompany;
  const karigarSplit = alloyTouched ? parseWeight(karigarAlloyInput) : ZERO;
  const includedSplit = alloyTouched ? parseWeight(includedAlloyInput) : defaultIncluded;
  const splitValid = companySplit !== null && karigarSplit !== null && includedSplit !== null;
  const enteredAlloy = splitValid ? companySplit + karigarSplit + includedSplit : null;
  const alloyMismatch = enteredAlloy === null || enteredAlloy !== expectedAlloy;
  const companyOverUse =
    companySplit !== null && returnedAlloyWeight !== null && companySplit + returnedAlloyWeight > (companyAlloy ? alloyPending : ZERO);
  const karigarAlloyCostValue = Number(karigarAlloyCost) || 0;
  const orphanKarigarCost = karigarAlloyCostValue > 0 && (karigarSplit === null || karigarSplit === ZERO);

  function editAlloy(field: "company" | "karigar" | "included", value: string) {
    if (!alloyTouched) {
      setCompanyAlloyInput(g(defaultCompany));
      setKarigarAlloyInput("0.000");
      setIncludedAlloyInput(g(defaultIncluded));
      setAlloyTouched(true);
    }
    if (field === "company") setCompanyAlloyInput(value);
    if (field === "karigar") setKarigarAlloyInput(value);
    if (field === "included") setIncludedAlloyInput(value);
  }

  const blockReason = invalidOutput
    ? "Check each output: enter a valid net metal weight and a Final Purity no finer than the issued metal."
    : invalidReturnOrScrap || returnedAlloyWeight === null
      ? "Check the returned and scrap weights."
      : exceedsAvailable
        ? "Finished plus returned plus scrap fine weight cannot exceed the fine weight still pending for this job."
        : alloyMismatch
          ? `Alloy Added is ${g(expectedAlloy)}g — the Company / Karigar / Included split must total exactly ${g(expectedAlloy)}g.`
          : companyOverUse
            ? `Company alloy used plus returned alloy cannot exceed the ${alloyPendingGrossWeight}g of Copper/Alloy still with the Karigar.`
            : orphanKarigarCost
              ? "A Karigar alloy charge needs a Karigar-added alloy weight."
              : null;

  const isGoldJob = fineBearing.length > 0 && fineBearing.every((m) => m.metalType === "GOLD");
  const fineLabel = isGoldJob ? "Fine Gold Weight" : "Fine metal weight";

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (blockReason) {
      window.alert(blockReason);
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
      ? `This will COMPLETE job ${jobCode}. Process Loss: ${g(previewLoss)}g fine.`
      : willCompleteMetal
        ? `Metal is fully resolved but some diamonds remain unresolved — job ${jobCode} will stay Partially Received.`
        : `Partial receipt for job ${jobCode}. ${g(gap > ZERO ? gap : ZERO)}g fine metal remains with the Karigar.`;
    const alloyLine = expectedAlloy > ZERO ? `\nAlloy Added: ${g(expectedAlloy)}g.` : "";
    if (!window.confirm(`${summary}${alloyLine}\n\nSave this receipt?`)) {
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

  const returnedLinesForSubmit = [
    ...returnedLines.filter((l) => l.purityId && Number(l.grossWeight) > 0).map((l) => ({ purityId: l.purityId, grossWeight: l.grossWeight })),
    ...(companyAlloy && returnedAlloyWeight !== null && returnedAlloyWeight > ZERO
      ? [{ purityId: companyAlloy.purityId, grossWeight: g(returnedAlloyWeight) }]
      : []),
  ];
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
      <input type="hidden" name="companyAlloyGrossWeight" value={companySplit !== null ? g(companySplit) : ""} />
      <input type="hidden" name="karigarAlloyGrossWeight" value={karigarSplit !== null ? g(karigarSplit) : ""} />
      <input type="hidden" name="includedAlloyGrossWeight" value={includedSplit !== null ? g(includedSplit) : ""} />
      <input type="hidden" name="karigarAlloyCost" value={karigarAlloyCost || "0"} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Receipt saved as {state.code}.</Alert> : null}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm text-zinc-700 dark:text-zinc-300">
        {fineBearing.map((m) => (
          <p key={m.purityId}>
            <span className="font-semibold">{m.displayName} Issued</span> · {m.grossWeight}g gross / {m.fineWeight}g fine
          </p>
        ))}
        {companyAlloy ? (
          <p>
            <span className="font-semibold">Copper/Alloy issued</span> · {companyAlloy.grossWeight}g · {alloyPendingGrossWeight}g still with Karigar
          </p>
        ) : null}
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Pending with Karigar: <span className="font-semibold text-zinc-900 dark:text-zinc-50">{pendingFineWeight}g fine metal</span>
        </p>
      </div>

      <Field label="Receive date" name="receiveDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Finished jewellery outputs ({g(outputsFine)}g fine metal)
        </h3>
        {outputs.map((output, index) => {
          const purityOptions = finalPurityOptions(output.metalType);
          const metal = outputMetals[index];
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
                    const nextPurity = fineBearing.find((p) => p.metalType === e.target.value)?.purityId ?? "";
                    updateOutput(index, { metalType: e.target.value, purityId: nextPurity });
                  }}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  {[...new Set(fineBearing.map((p) => p.metalType))].map((mt) => (
                    <option key={mt} value={mt}>
                      {metalTypeLabel(mt)}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Final Purity"
                  value={output.purityId}
                  onChange={(e) => updateOutput(index, { purityId: e.target.value })}
                  className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                >
                  {purityOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      Final Purity: {p.displayName}
                      {p.isIssued ? " (as issued)" : ""}
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Gross Weight"
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="Gross Weight (optional, with stones)"
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
              <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                {fineLabel}: <span className="font-semibold">{g(metal.fine)}g</span>
                {metal.alloy > ZERO ? (
                  <>
                    {" "}
                    · Alloy Added: <span className="font-semibold">{g(metal.alloy)}g</span>
                  </>
                ) : null}
                {!metal.valid ? <span className="ml-2 font-medium text-red-600 dark:text-red-400">Check this output</span> : null}
              </p>

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

      {expectedAlloy > ZERO || companyAlloy ? (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div>
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Alloy Added ({g(expectedAlloy)}g)</h3>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Net weight of the finished pieces that is not issued fine metal — e.g. copper mixed into 24K to make 18K. Say where it came from; the
              parts must total exactly {g(expectedAlloy)}g.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {companyAlloy ? (
              <Field
                label="From Company Copper/Alloy (g)"
                name="companyAlloyInput"
                type="number"
                step="0.001"
                min={0}
                value={alloyTouched ? companyAlloyInput : g(defaultCompany)}
                onChange={(e) => editAlloy("company", e.target.value)}
              />
            ) : null}
            <Field
              label="Karigar-added alloy (g)"
              name="karigarAlloyInput"
              type="number"
              step="0.001"
              min={0}
              value={alloyTouched ? karigarAlloyInput : "0.000"}
              onChange={(e) => editAlloy("karigar", e.target.value)}
            />
            <Field
              label="Karigar alloy charge (₹)"
              name="karigarAlloyCostInput"
              type="number"
              step="0.01"
              min={0}
              value={karigarAlloyCost}
              onChange={(e) => setKarigarAlloyCost(e.target.value)}
            />
            <Field
              label="Included, no separate cost (g)"
              name="includedAlloyInput"
              type="number"
              step="0.001"
              min={0}
              value={alloyTouched ? includedAlloyInput : g(defaultIncluded)}
              onChange={(e) => editAlloy("included", e.target.value)}
            />
          </div>
          {companyAlloy ? (
            <div className="max-w-xs">
              <Field
                label="Returned Copper/Alloy (g)"
                name="returnedAlloyInput"
                type="number"
                step="0.001"
                min={0}
                value={returnedAlloy}
                onChange={(e) => setReturnedAlloy(e.target.value)}
              />
            </div>
          ) : null}
          <p className={`text-xs font-medium ${alloyMismatch ? "text-red-600 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>
            {alloyMismatch
              ? `Split totals ${enteredAlloy !== null ? g(enteredAlloy) : "—"}g — must be exactly ${g(expectedAlloy)}g`
              : `Split balances: ${g(expectedAlloy)}g`}
          </p>
        </div>
      ) : null}

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
            {isGoldJob ? "Returned Gold" : "Returned unused metal"} ({g(returnedFine)}g fine)
          </h3>
          {fineBearing.length > 1 ? (
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
              {fineBearing.map((p) => (
                <option key={p.purityId} value={p.purityId}>
                  {metalTypeLabel(p.metalType)} · {p.displayName}
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
        {fineBearing.length > 1 ? (
          <Button type="button" variant="secondary" size="md" onClick={addReturnedLine} className="self-start">
            + Add another returned-metal purity
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Scrap ({g(scrapFine)}g fine)</h3>
          {fineBearing.length > 1 ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">Say exactly which purity each scrap amount belongs to.</p>
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
              {fineBearing.map((p) => (
                <option key={p.purityId} value={p.purityId}>
                  {metalTypeLabel(p.metalType)} · {p.displayName}
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
        {fineBearing.length > 1 ? (
          <Button type="button" variant="secondary" size="md" onClick={addScrapLine} className="self-start">
            + Add another scrap purity
          </Button>
        ) : null}
      </div>

      {gap > ZERO ? (
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

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-sm" aria-live="polite">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">Reconciliation (fine metal)</p>
        <p>
          Pending with Karigar{karigarAdded > ZERO ? " + Karigar-added" : ""}: <span className="font-semibold">{g(pendingAvailable)}g</span>
        </p>
        <p>
          {isGoldJob ? "Finished Fine Gold" : "Finished fine metal"}: <span className="font-semibold">{g(outputsFine)}g</span> ·{" "}
          {isGoldJob ? "Returned Gold" : "Returned"}: <span className="font-semibold">{g(returnedFine)}g</span> · Scrap:{" "}
          <span className="font-semibold">{g(scrapFine)}g</span>
        </p>
        <p>
          {willCompleteMetal ? "Process Loss" : "Still with Karigar (not yet resolved)"}:{" "}
          <span className="font-semibold">{willCompleteMetal ? g(previewLoss) : g(gap > ZERO ? gap : ZERO)}g</span>
        </p>
        {expectedAlloy > ZERO ? (
          <p>
            Alloy Added: <span className="font-semibold">{g(expectedAlloy)}g</span>
          </p>
        ) : null}
        {blockReason ? (
          <p className="mt-1 text-xs font-medium text-red-600 dark:text-red-400">{blockReason}</p>
        ) : willCompleteJob ? (
          <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-400">Balances — this job will be marked Completed.</p>
        ) : willCompleteMetal ? (
          <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
            Metal is fully resolved, but unresolved diamonds remain — this job will stay Partially Received.
          </p>
        ) : (
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Balances — this job will be marked Partially Received.</p>
        )}
      </div>

      {isOwner && willCompleteMetal && (previewLoss > ZERO || (companyAlloy && alloyPending > ZERO)) ? (
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

      <Button type="submit" size="lg" disabled={pending || Boolean(blockReason)} className="self-start">
        {pending ? "Saving…" : "Receive Finished Jewellery"}
      </Button>
    </form>
  );
}
