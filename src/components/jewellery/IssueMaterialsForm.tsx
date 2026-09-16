"use client";

import { useActionState, useEffect, useMemo, useState } from "react";

import { issueMaterialsAction } from "@/app/actions/jewellery";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Field } from "@/components/ui/Field";
import { METAL_TYPES } from "@/lib/jewellery/types";
import type { PurityOption } from "@/components/jewellery/CreateJobForm";

export type AvailablePolishedDiamondOption = {
  id: string;
  polishedCode: string;
  shape: string;
  carat: string;
  /** Owner-only — null for Staff (redacted on the server). */
  allocatedCost: string | null;
  certificateStatus: string;
};

/** Phase 7 — a bulk polished packet with stock left to issue. */
export type AvailablePacketOption = {
  id: string;
  packetCode: string;
  label: string;
  pieces: number;
  carat: string;
};

type MetalLineDraft = { metalType: string; purityId: string; grossWeight: string };
type OtherMaterialDraft = { description: string; quantity: string; unit: "PCS" | "CT" | "GRAM" | "OTHER"; weight: string; cost: string; note: string };

function emptyMetalLine(): MetalLineDraft {
  return { metalType: "GOLD", purityId: "", grossWeight: "" };
}
function emptyOtherMaterial(): OtherMaterialDraft {
  return { description: "", quantity: "1", unit: "PCS", weight: "", cost: "", note: "" };
}

export function IssueMaterialsForm({
  jobId,
  jobCode,
  purities,
  availableDiamonds,
  availablePackets = [],
  isOwner,
  onDone,
}: {
  jobId: string;
  jobCode: string;
  purities: PurityOption[];
  availableDiamonds: AvailablePolishedDiamondOption[];
  availablePackets?: AvailablePacketOption[];
  isOwner: boolean;
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(issueMaterialsAction, undefined);
  const [metalLines, setMetalLines] = useState<MetalLineDraft[]>([emptyMetalLine()]);
  const [selectedDiamondIds, setSelectedDiamondIds] = useState<string[]>([]);
  const [diamondSearch, setDiamondSearch] = useState("");
  const [packetDrafts, setPacketDrafts] = useState<Record<string, { pieces: string; carat: string }>>({});
  const [showOtherMaterial, setShowOtherMaterial] = useState(false);
  const [otherMaterialLines, setOtherMaterialLines] = useState<OtherMaterialDraft[]>([]);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (state?.success) onDone?.();
  }, [state?.success, onDone]);

  function updateMetalLine(index: number, patch: Partial<MetalLineDraft>) {
    setMetalLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addMetalLine() {
    setMetalLines((prev) => [...prev, emptyMetalLine()]);
  }
  function removeMetalLine(index: number) {
    setMetalLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function updateOtherLine(index: number, patch: Partial<OtherMaterialDraft>) {
    setOtherMaterialLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addOtherLine() {
    setOtherMaterialLines((prev) => [...prev, emptyOtherMaterial()]);
  }
  function removeOtherLine(index: number) {
    setOtherMaterialLines((prev) => prev.filter((_, i) => i !== index));
  }

  const filteredDiamonds = useMemo(() => {
    const q = diamondSearch.trim().toLowerCase();
    if (!q) return availableDiamonds;
    return availableDiamonds.filter((d) => d.polishedCode.toLowerCase().includes(q) || d.shape.toLowerCase().includes(q));
  }, [diamondSearch, availableDiamonds]);

  function toggleDiamond(id: string) {
    setSelectedDiamondIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const packetLinesForSubmit = availablePackets
    .map((p) => ({ packet: p, draft: packetDrafts[p.id] }))
    .filter(({ draft }) => draft && (Number(draft.pieces) > 0 || Number(draft.carat) > 0))
    .map(({ packet, draft }) => ({ packetId: packet.id, pieces: draft.pieces || "0", carat: draft.carat || "0" }));
  const packetProblems = availablePackets
    .map((p) => {
      const draft = packetDrafts[p.id];
      if (!draft || (!Number(draft.pieces) && !Number(draft.carat))) return null;
      const pieces = Number(draft.pieces) || 0;
      const carat = Number(draft.carat) || 0;
      if (pieces > p.pieces || carat > Number(p.carat)) return `${p.packetCode}: only ${p.pieces} pcs / ${p.carat}ct available.`;
      if (!(carat > 0)) return `${p.packetCode}: enter the carat being issued.`;
      if ((pieces === p.pieces) !== (carat.toFixed(3) === Number(p.carat).toFixed(3))) {
        return `${p.packetCode}: taking every piece must also take every carat (and the reverse).`;
      }
      return null;
    })
    .filter((m): m is string => m !== null);
  const packetCarat = packetLinesForSubmit.reduce((sum, l) => sum + (Number(l.carat) || 0), 0);

  const totalGrossWeight = metalLines.reduce((sum, l) => sum + (Number(l.grossWeight) || 0), 0);
  const selectedDiamondsCarat = availableDiamonds
    .filter((d) => selectedDiamondIds.includes(d.id))
    .reduce((sum, d) => sum + Number(d.carat), 0);

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    const validMetalLines = metalLines.filter((l) => l.purityId && Number(l.grossWeight) > 0);
    if (packetProblems.length > 0) {
      window.alert(packetProblems[0]);
      event.preventDefault();
      return;
    }
    if (
      validMetalLines.length === 0 &&
      selectedDiamondIds.length === 0 &&
      packetLinesForSubmit.length === 0 &&
      otherMaterialLines.length === 0
    ) {
      window.alert("Issue at least one metal line, diamond, packet, or other material.");
      event.preventDefault();
      return;
    }
    if (
      !window.confirm(
        `Issue materials to job ${jobCode}? Metal: ${totalGrossWeight.toFixed(3)}g, Diamonds: ${selectedDiamondIds.length} (${selectedDiamondsCarat.toFixed(3)}ct), Packets: ${packetLinesForSubmit.length} (${packetCarat.toFixed(3)}ct).`
      )
    ) {
      event.preventDefault();
    }
  }

  const metalLinesForSubmit = metalLines
    .filter((l) => l.purityId && Number(l.grossWeight) > 0)
    .map((l) => ({ metalType: l.metalType, purityId: l.purityId, grossWeight: l.grossWeight }));

  const otherMaterialForSubmit = otherMaterialLines
    .filter((l) => l.description.trim())
    .map((l) => ({
      description: l.description,
      quantity: l.quantity || "1",
      unit: l.unit,
      weight: l.weight || undefined,
      cost: l.cost || "0",
      note: l.note || undefined,
    }));

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
    >
      <input type="hidden" name="jobId" value={jobId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="metalLinesJson" value={JSON.stringify(metalLinesForSubmit)} />
      <input type="hidden" name="polishedDiamondIdsJson" value={JSON.stringify(selectedDiamondIds)} />
      <input type="hidden" name="packetLinesJson" value={JSON.stringify(packetLinesForSubmit)} />
      <input type="hidden" name="otherMaterialLinesJson" value={JSON.stringify(otherMaterialForSubmit)} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? <Alert tone="success">Materials issued for job {state.code}.</Alert> : null}

      <Field label="Issue date" name="issueDate" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required />

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Metal ({totalGrossWeight.toFixed(3)}g total)
        </h3>
        {metalLines.map((line, index) => {
          const purityOptions = purities.filter((p) => p.metalType === line.metalType);
          return (
            <div key={index} className="grid grid-cols-1 gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 sm:grid-cols-4">
              <select
                aria-label="Metal type"
                value={line.metalType}
                onChange={(e) => updateMetalLine(index, { metalType: e.target.value, purityId: "" })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              >
                {METAL_TYPES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Purity"
                value={line.purityId}
                onChange={(e) => updateMetalLine(index, { purityId: e.target.value })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              >
                <option value="">Choose purity…</option>
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
                placeholder="Gross weight (g)"
                value={line.grossWeight}
                onChange={(e) => updateMetalLine(index, { grossWeight: e.target.value })}
                className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              {metalLines.length > 1 ? (
                <button type="button" onClick={() => removeMetalLine(index)} className="text-xs font-medium text-red-600 hover:underline dark:text-red-400">
                  Remove
                </button>
              ) : null}
            </div>
          );
        })}
        <Button type="button" variant="secondary" size="md" onClick={addMetalLine} className="self-start">
          + Add material (another metal line)
        </Button>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Diamonds from Polished Stock ({selectedDiamondIds.length} selected, {selectedDiamondsCarat.toFixed(3)}ct)
        </h3>
        <input
          type="text"
          placeholder="Search available polished diamonds…"
          value={diamondSearch}
          onChange={(e) => setDiamondSearch(e.target.value)}
          className="h-10 w-full max-w-sm rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        />
        {filteredDiamonds.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">No available polished diamonds match.</p>
        ) : (
          <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-[var(--border)]">
                {filteredDiamonds.map((d) => (
                  <tr key={d.id} className="cursor-pointer hover:bg-[var(--surface-muted)]" onClick={() => toggleDiamond(d.id)}>
                    <td className="w-10 px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selectedDiamondIds.includes(d.id)}
                        onChange={() => toggleDiamond(d.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-4 w-4 rounded border-zinc-300"
                      />
                    </td>
                    <td className="px-3 py-2 font-medium text-zinc-800 dark:text-zinc-200">{d.polishedCode}</td>
                    <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">{d.shape}</td>
                    <td className="px-3 py-2">{d.carat}ct</td>
                    {isOwner ? <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">₹{Number(d.allocatedCost).toFixed(2)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {availablePackets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">
            Polished Diamond packets ({packetLinesForSubmit.length} selected, {packetCarat.toFixed(3)}ct)
          </h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">Enter the pieces and carat taken from each packet.</p>
          <div className="max-h-64 overflow-auto rounded-lg border border-[var(--border)]">
            <table className="w-full min-w-[32rem] text-sm">
              <tbody className="divide-y divide-[var(--border)]">
                {availablePackets.map((p) => {
                  const draft = packetDrafts[p.id] ?? { pieces: "", carat: "" };
                  const setDraft = (patch: Partial<{ pieces: string; carat: string }>) =>
                    setPacketDrafts((prev) => ({ ...prev, [p.id]: { ...draft, ...patch } }));
                  return (
                    <tr key={p.id}>
                      <td className="px-3 py-2">
                        <p className="font-medium text-zinc-800 dark:text-zinc-200">{p.packetCode}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {p.label} · {p.pieces} pcs · {p.carat}ct available
                        </p>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          aria-label={`Pieces from ${p.packetCode}`}
                          type="number"
                          min="0"
                          step="1"
                          placeholder="Pieces"
                          value={draft.pieces}
                          onChange={(e) => setDraft({ pieces: e.target.value })}
                          className="h-9 w-24 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                        />
                      </td>
                      <td className="px-2 py-2">
                        <input
                          aria-label={`Carat from ${p.packetCode}`}
                          type="number"
                          min="0"
                          step="0.001"
                          placeholder="Carat"
                          value={draft.carat}
                          onChange={(e) => setDraft({ carat: e.target.value })}
                          className="h-9 w-28 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {packetProblems.length > 0 ? (
            <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{packetProblems[0]}</p>
          ) : null}
        </div>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowOtherMaterial((v) => !v)}
          aria-expanded={showOtherMaterial}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showOtherMaterial ? "Hide other material" : "More details (moissanite, findings, alloy, other material)"}
        </button>
      </div>

      {showOtherMaterial ? (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            These are simple manual entries for cost/documentation only — not tracked against a real stock ledger.
          </p>
          {otherMaterialLines.map((line, index) => (
            <div key={index} className="grid grid-cols-1 gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 sm:grid-cols-5">
              <input
                aria-label="Description"
                placeholder="Description"
                value={line.description}
                onChange={(e) => updateOtherLine(index, { description: e.target.value })}
                className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm sm:col-span-2 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <input
                aria-label="Quantity"
                type="number"
                step="0.001"
                placeholder="Qty"
                value={line.quantity}
                onChange={(e) => updateOtherLine(index, { quantity: e.target.value })}
                className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <select
                aria-label="Unit"
                value={line.unit}
                onChange={(e) => updateOtherLine(index, { unit: e.target.value as OtherMaterialDraft["unit"] })}
                className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              >
                <option value="PCS">PCS</option>
                <option value="CT">CT</option>
                <option value="GRAM">GRAM</option>
                <option value="OTHER">OTHER</option>
              </select>
              <input
                aria-label="Cost"
                type="number"
                step="0.01"
                min="0"
                placeholder="Cost (₹)"
                value={line.cost}
                onChange={(e) => updateOtherLine(index, { cost: e.target.value })}
                className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              />
              <button type="button" onClick={() => removeOtherLine(index)} className="text-xs font-medium text-red-600 hover:underline dark:text-red-400">
                Remove
              </button>
            </div>
          ))}
          <Button type="button" variant="secondary" size="md" onClick={addOtherLine} className="self-start">
            + Add other material
          </Button>
        </div>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Issuing…" : "Issue Materials"}
      </Button>
    </form>
  );
}
