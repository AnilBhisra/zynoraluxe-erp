"use client";

import { useActionState, useMemo, useState } from "react";

import { createEstimateCostingAction, updateEstimateCostingAction } from "@/app/actions/costing";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { JEWELLERY_TYPES } from "@/lib/jewellery/types";
import { previewCostSheetTotals } from "@/lib/costing/previewMath";
import { CalculationSummary } from "@/components/costing/CalculationSummary";
import { PricingFields, defaultPricingState, type PricingState } from "@/components/costing/PricingFields";
import { CostingPhotoUploadField } from "@/components/costing/CostingPhotoUploadField";

export type MetalPurityOption = { id: string; metalType: string; displayName: string; finenessPercent: string };

const DIAMOND_SHAPES = [
  "ROUND",
  "OVAL",
  "PEAR",
  "EMERALD",
  "CUSHION",
  "ELONGATED_CUSHION",
  "RADIANT",
  "PRINCESS",
  "MARQUISE",
  "ASSCHER",
  "CUSTOM",
] as const;

const OTHER_MATERIAL_CATEGORIES = [
  ["MOISSANITE", "Moissanite"],
  ["COLOURED_STONE", "Coloured stone"],
  ["SMALL_STONE", "Small stone"],
  ["FINDINGS", "Findings"],
  ["ALLOY", "Alloy"],
  ["ENAMEL", "Enamel"],
  ["PLATING", "Plating"],
  ["PACKAGING", "Packaging"],
  ["OTHER", "Other"],
] as const;

const CHARGE_METHOD_LABELS: Record<string, string> = {
  FLAT: "Flat amount",
  PER_GRAM: "Per gram (of total metal weight)",
  PER_CARAT: "Per carat (of total diamond weight)",
  PER_PIECE: "Per piece",
  PERCENT_OF_MATERIAL_COST: "% of metal + diamond + other-material cost",
};

const CHARGE_LABEL_SUGGESTIONS = [
  "Karigar labour",
  "CAD/design",
  "Hallmark",
  "Certification",
  "Rhodium/plating",
  "Setting",
  "Packaging",
  "Shipping",
  "Miscellaneous",
];

type MetalLineDraft = { metalType: string; purityId: string; grossWeight: string; wastagePercent: string; rateBasis: string; rate: string };
type DiamondLineDraft = { shape: string; customShapeName: string; quantity: string; totalCarat: string; ratePerCarat: string; fixedAmount: string; certificateCharge: string; notes: string };
type OtherMaterialLineDraft = { category: string; description: string; quantity: string; rate: string; manualAmount: string };
type ChargeLineDraft = { label: string; isLabour: boolean; method: string; rate: string };

function emptyMetalLine(defaultPurityId: string, defaultMetalType: string): MetalLineDraft {
  return { metalType: defaultMetalType, purityId: defaultPurityId, grossWeight: "", wastagePercent: "0", rateBasis: "PER_GROSS_GRAM", rate: "" };
}
function emptyDiamondLine(): DiamondLineDraft {
  return { shape: "ROUND", customShapeName: "", quantity: "1", totalCarat: "", ratePerCarat: "", fixedAmount: "", certificateCharge: "0", notes: "" };
}
function emptyOtherMaterialLine(): OtherMaterialLineDraft {
  return { category: "FINDINGS", description: "", quantity: "", rate: "", manualAmount: "" };
}
function emptyChargeLine(): ChargeLineDraft {
  return { label: "Karigar labour", isLabour: true, method: "FLAT", rate: "" };
}

function num(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type InitialEstimateValues = {
  costSheetId?: string;
  costingDate: string;
  jewelleryType: string;
  itemName: string;
  referenceNumber: string;
  quantity: string;
  sizeOrLength: string;
  designImageAssetId: string | null;
  customerId: string;
  notes: string;
  metalLines: MetalLineDraft[];
  diamondLines: DiamondLineDraft[];
  otherMaterialLines: OtherMaterialLineDraft[];
  chargeLines: ChargeLineDraft[];
  pricing: PricingState;
};

export function EstimateForm({
  purities,
  gstRates,
  customers,
  defaults,
  initial,
}: {
  purities: MetalPurityOption[];
  gstRates: { id: string; label: string; ratePercent: string }[];
  customers: { id: string; name: string }[];
  defaults: PricingState;
  initial?: InitialEstimateValues;
}) {
  const isEdit = Boolean(initial?.costSheetId);
  const action = isEdit ? updateEstimateCostingAction : createEstimateCostingAction;
  const [state, formAction, pending] = useActionState(action, undefined);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const [costingDate, setCostingDate] = useState(initial?.costingDate ?? new Date().toISOString().slice(0, 10));
  const [jewelleryType, setJewelleryType] = useState(initial?.jewelleryType ?? "RING");
  const [itemName, setItemName] = useState(initial?.itemName ?? "");
  const [referenceNumber, setReferenceNumber] = useState(initial?.referenceNumber ?? "");
  const [quantity, setQuantity] = useState(initial?.quantity ?? "1");
  const [sizeOrLength, setSizeOrLength] = useState(initial?.sizeOrLength ?? "");
  const [customerId, setCustomerId] = useState(initial?.customerId ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [designImageAssetId, setDesignImageAssetId] = useState<string | null>(initial?.designImageAssetId ?? null);
  const [showMore, setShowMore] = useState(false);

  const defaultPurity = purities[0];
  const [metalLines, setMetalLines] = useState<MetalLineDraft[]>(initial?.metalLines ?? [emptyMetalLine(defaultPurity?.id ?? "", defaultPurity?.metalType ?? "GOLD")]);
  const [diamondLines, setDiamondLines] = useState<DiamondLineDraft[]>(initial?.diamondLines ?? []);
  const [otherMaterialLines, setOtherMaterialLines] = useState<OtherMaterialLineDraft[]>(initial?.otherMaterialLines ?? []);
  const [chargeLines, setChargeLines] = useState<ChargeLineDraft[]>(initial?.chargeLines ?? [emptyChargeLine()]);

  const [pricing, setPricing] = useState<PricingState>(initial?.pricing ?? defaultPricingState(defaults));
  const [showAdvancedPricing, setShowAdvancedPricing] = useState(false);

  const purityById = useMemo(() => new Map(purities.map((p) => [p.id, p])), [purities]);

  function updateMetalLine(index: number, patch: Partial<MetalLineDraft>) {
    setMetalLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function updateDiamondLine(index: number, patch: Partial<DiamondLineDraft>) {
    setDiamondLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function updateOtherMaterialLine(index: number, patch: Partial<OtherMaterialLineDraft>) {
    setOtherMaterialLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function updateChargeLine(index: number, patch: Partial<ChargeLineDraft>) {
    setChargeLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function metalLineFineWeight(line: MetalLineDraft): number {
    const fineness = Number(purityById.get(line.purityId)?.finenessPercent ?? 0);
    return (num(line.grossWeight) * fineness) / 100;
  }
  function metalLineBilledGrossWeight(line: MetalLineDraft): number {
    return num(line.grossWeight) * (1 + num(line.wastagePercent) / 100);
  }
  function metalLineAmount(line: MetalLineDraft): number {
    const fineness = Number(purityById.get(line.purityId)?.finenessPercent ?? 0);
    const billedGross = metalLineBilledGrossWeight(line);
    if (line.rateBasis === "FIXED_TOTAL") return num(line.rate);
    if (line.rateBasis === "PER_FINE_GRAM") return (billedGross * fineness) / 100 * num(line.rate);
    return billedGross * num(line.rate);
  }
  function diamondLineAmount(line: DiamondLineDraft): number {
    const cert = num(line.certificateCharge);
    if (line.fixedAmount.trim() !== "") return num(line.fixedAmount) + cert;
    return num(line.totalCarat) * num(line.ratePerCarat) + cert;
  }
  function otherMaterialLineAmount(line: OtherMaterialLineDraft): number {
    if (line.quantity.trim() !== "" && line.rate.trim() !== "") return num(line.quantity) * num(line.rate);
    return num(line.manualAmount);
  }
  const totalMetalBilledGrossWeight = metalLines.reduce((sum, l) => sum + metalLineBilledGrossWeight(l), 0);
  const totalDiamondCarat = diamondLines.reduce((sum, l) => sum + num(l.totalCarat), 0);
  const metalCost = metalLines.reduce((sum, l) => sum + metalLineAmount(l), 0);
  const diamondCost = diamondLines.reduce((sum, l) => sum + diamondLineAmount(l), 0);
  const otherMaterialCost = otherMaterialLines.reduce((sum, l) => sum + otherMaterialLineAmount(l), 0);
  const materialCostSubtotal = metalCost + diamondCost + otherMaterialCost;

  function chargeLineAmount(line: ChargeLineDraft): number {
    const rate = num(line.rate);
    switch (line.method) {
      case "PER_GRAM":
        return rate * totalMetalBilledGrossWeight;
      case "PER_CARAT":
        return rate * totalDiamondCarat;
      case "PER_PIECE":
        return rate * num(quantity);
      case "PERCENT_OF_MATERIAL_COST":
        return (materialCostSubtotal * rate) / 100;
      default:
        return rate;
    }
  }
  const labourCost = chargeLines.filter((l) => l.isLabour).reduce((sum, l) => sum + chargeLineAmount(l), 0);
  const additionalChargesCost = chargeLines.filter((l) => !l.isLabour).reduce((sum, l) => sum + chargeLineAmount(l), 0);

  const totals = previewCostSheetTotals({
    metalCost,
    diamondCost,
    otherMaterialCost,
    labourCost,
    additionalChargesCost,
    pricingMethod: pricing.pricingMethod,
    markupPercent: num(pricing.markupPercent),
    targetMarginPercent: num(pricing.targetMarginPercent),
    manualSellingPriceOverride: pricing.useManualOverride ? num(pricing.manualSellingPriceOverride) : null,
    discountType: pricing.discountType,
    discountValue: num(pricing.discountValue),
    gstTreatment: pricing.gstTreatment,
    gstRatePercent: Number(gstRates.find((g) => g.id === pricing.gstRateId)?.ratePercent ?? 0),
    priceType: pricing.priceType,
    roundingStep: num(pricing.roundingStep),
    sellingExpenseFixed: num(pricing.sellingExpenseFixed),
    sellingExpensePercent: num(pricing.sellingExpensePercent),
  });

  const metalLinesJson = JSON.stringify(
    metalLines
      .filter((l) => l.purityId && num(l.grossWeight) > 0)
      .map((l) => ({ metalType: l.metalType, purityId: l.purityId, grossWeight: l.grossWeight, wastagePercent: l.wastagePercent, rateBasis: l.rateBasis, rate: l.rate || "0" }))
  );
  const diamondLinesJson = JSON.stringify(
    diamondLines
      .filter((l) => num(l.totalCarat) > 0)
      .map((l) => ({
        shape: l.shape,
        customShapeName: l.customShapeName || undefined,
        quantity: l.quantity || "1",
        totalCarat: l.totalCarat,
        ratePerCarat: l.ratePerCarat || undefined,
        fixedAmount: l.fixedAmount || undefined,
        certificateCharge: l.certificateCharge || "0",
        notes: l.notes || undefined,
      }))
  );
  const otherMaterialLinesJson = JSON.stringify(
    otherMaterialLines
      .filter((l) => l.description.trim())
      .map((l) => ({ category: l.category, description: l.description, quantity: l.quantity || undefined, rate: l.rate || undefined, manualAmount: l.manualAmount || undefined }))
  );
  const chargeLinesJson = JSON.stringify(
    chargeLines
      .filter((l) => l.label.trim() && num(l.rate) > 0)
      .map((l) => ({ label: l.label, isLabour: l.isLabour, method: l.method, rate: l.rate }))
  );

  return (
    <form action={formAction} className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
      {initial?.costSheetId ? <input type="hidden" name="costSheetId" value={initial.costSheetId} /> : null}
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="metalLinesJson" value={metalLinesJson} />
      <input type="hidden" name="diamondLinesJson" value={diamondLinesJson} />
      <input type="hidden" name="otherMaterialLinesJson" value={otherMaterialLinesJson} />
      <input type="hidden" name="chargeLinesJson" value={chargeLinesJson} />
      <input type="hidden" name="designImageAssetId" value={designImageAssetId ?? ""} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? (
        <Alert tone="success">
          Saved as {state.costingNumber ?? "Draft"}.{" "}
          {state.id ? (
            <a href={`/costing?tab=sheets&sheetId=${state.id}`} className="underline">
              Open it
            </a>
          ) : null}
        </Alert>
      ) : null}

      <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Jewellery details</h3>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Costing date" name="costingDate" type="date" value={costingDate} onChange={(e) => setCostingDate(e.target.value)} required />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Category / jewellery type</span>
          <select className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" name="jewelleryType" value={jewelleryType} onChange={(e) => setJewelleryType(e.target.value)}>
            {JEWELLERY_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <Field label="Item name" name="itemName" value={itemName} onChange={(e) => setItemName(e.target.value)} required placeholder="e.g. Custom diamond solitaire ring" />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Customer (optional)</span>
          <select className="h-11 rounded-lg border border-zinc-300 bg-white px-3 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" name="customerId" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">No customer chosen</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <Field label="Quantity" name="quantity" type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </div>

      <button type="button" onClick={() => setShowMore((v) => !v)} className="self-start text-sm font-medium text-zinc-700 underline underline-offset-4 dark:text-zinc-300">
        {showMore ? "Hide more details" : "More Details — reference, size, notes, photo"}
      </button>
      {showMore ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Reference/design number" name="referenceNumber" value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} />
          <Field label="Size/length" name="sizeOrLength" value={sizeOrLength} onChange={(e) => setSizeOrLength(e.target.value)} />
          <Field label="Notes" name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <CostingPhotoUploadField assetId={designImageAssetId} onUploaded={setDesignImageAssetId} label="Design photo" />
        </div>
      ) : null}

      <h3 className="mt-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Estimated metal ({metalCost.toFixed(2) === "0.00" ? "none yet" : `₹${metalCost.toFixed(2)}`})</h3>
      {metalLines.map((line, index) => (
        <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <select
              aria-label="Metal type"
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              value={line.metalType}
              onChange={(e) => {
                const nextPurity = purities.find((p) => p.metalType === e.target.value)?.id ?? "";
                updateMetalLine(index, { metalType: e.target.value, purityId: nextPurity });
              }}
            >
              {[...new Set(purities.map((p) => p.metalType))].map((mt) => (
                <option key={mt} value={mt}>
                  {mt}
                </option>
              ))}
            </select>
            <select
              aria-label="Purity"
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              value={line.purityId}
              onChange={(e) => updateMetalLine(index, { purityId: e.target.value })}
            >
              {purities.filter((p) => p.metalType === line.metalType).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <input aria-label="Gross weight (g)" type="number" step="0.001" min="0" placeholder="Gross weight (g)" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.grossWeight} onChange={(e) => updateMetalLine(index, { grossWeight: e.target.value })} />
            <input aria-label="Wastage %" type="number" step="0.01" min="0" placeholder="Wastage %" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.wastagePercent} onChange={(e) => updateMetalLine(index, { wastagePercent: e.target.value })} />
          </div>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <select aria-label="Rate basis" className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.rateBasis} onChange={(e) => updateMetalLine(index, { rateBasis: e.target.value })}>
              <option value="PER_GROSS_GRAM">Rate per gross gram</option>
              <option value="PER_FINE_GRAM">Rate per fine gram</option>
              <option value="FIXED_TOTAL">Fixed total amount</option>
            </select>
            <input aria-label="Rate" type="number" step="0.01" min="0" placeholder="Rate (₹)" className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.rate} onChange={(e) => updateMetalLine(index, { rate: e.target.value })} />
            <span className="flex items-center text-xs text-zinc-500 dark:text-zinc-400">Fine weight: {metalLineFineWeight(line).toFixed(3)}g</span>
            <span className="flex items-center justify-end text-sm font-medium text-zinc-800 dark:text-zinc-200">₹{metalLineAmount(line).toFixed(2)}</span>
          </div>
          {metalLines.length > 1 ? (
            <button type="button" onClick={() => setMetalLines((prev) => prev.filter((_, i) => i !== index))} className="mt-2 text-xs font-medium text-red-600 hover:underline dark:text-red-400">
              Remove
            </button>
          ) : null}
        </div>
      ))}
      <Button type="button" variant="secondary" size="md" onClick={() => setMetalLines((prev) => [...prev, emptyMetalLine(defaultPurity?.id ?? "", defaultPurity?.metalType ?? "GOLD")])}>
        + Add metal line
      </Button>

      <h3 className="mt-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Diamonds ({diamondCost.toFixed(2) === "0.00" ? "none" : `₹${diamondCost.toFixed(2)}`})</h3>
      {diamondLines.map((line, index) => (
        <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <select aria-label="Shape" className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.shape} onChange={(e) => updateDiamondLine(index, { shape: e.target.value })}>
              {DIAMOND_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            {line.shape === "CUSTOM" ? (
              <input aria-label="Custom shape name" placeholder="Custom shape name" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.customShapeName} onChange={(e) => updateDiamondLine(index, { customShapeName: e.target.value })} />
            ) : (
              <input aria-label="Quantity" type="number" min="1" placeholder="Qty" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.quantity} onChange={(e) => updateDiamondLine(index, { quantity: e.target.value })} />
            )}
            <input aria-label="Total carat" type="number" step="0.001" min="0" placeholder="Total carat" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.totalCarat} onChange={(e) => updateDiamondLine(index, { totalCarat: e.target.value })} />
            <input aria-label="Rate per carat" type="number" step="0.01" min="0" placeholder="Rate/carat (₹)" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.ratePerCarat} onChange={(e) => updateDiamondLine(index, { ratePerCarat: e.target.value })} disabled={line.fixedAmount.trim() !== ""} />
          </div>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <input aria-label="Fixed amount (overrides rate)" type="number" step="0.01" min="0" placeholder="Or a fixed amount (₹)" className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.fixedAmount} onChange={(e) => updateDiamondLine(index, { fixedAmount: e.target.value })} />
            <input aria-label="Certificate charge" type="number" step="0.01" min="0" placeholder="Certificate charge (₹)" className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.certificateCharge} onChange={(e) => updateDiamondLine(index, { certificateCharge: e.target.value })} />
            <input aria-label="Notes" placeholder="Notes (optional)" className="h-9 rounded-lg border border-zinc-300 bg-white px-2 text-xs dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.notes} onChange={(e) => updateDiamondLine(index, { notes: e.target.value })} />
            <span className="flex items-center justify-end text-sm font-medium text-zinc-800 dark:text-zinc-200">₹{diamondLineAmount(line).toFixed(2)}</span>
          </div>
          <button type="button" onClick={() => setDiamondLines((prev) => prev.filter((_, i) => i !== index))} className="mt-2 text-xs font-medium text-red-600 hover:underline dark:text-red-400">
            Remove
          </button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="md" onClick={() => setDiamondLines((prev) => [...prev, emptyDiamondLine()])}>
        + Add diamond line
      </Button>

      <h3 className="mt-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
        Other material ({otherMaterialCost.toFixed(2) === "0.00" ? "none" : `₹${otherMaterialCost.toFixed(2)}`})
      </h3>
      {otherMaterialLines.map((line, index) => (
        <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
            <select aria-label="Category" className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.category} onChange={(e) => updateOtherMaterialLine(index, { category: e.target.value })}>
              {OTHER_MATERIAL_CATEGORIES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input aria-label="Description" placeholder="Description" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.description} onChange={(e) => updateOtherMaterialLine(index, { description: e.target.value })} />
            <input aria-label="Quantity/weight" type="number" step="0.001" min="0" placeholder="Qty/weight" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.quantity} onChange={(e) => updateOtherMaterialLine(index, { quantity: e.target.value })} />
            <input aria-label="Rate" type="number" step="0.01" min="0" placeholder="Rate (₹)" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.rate} onChange={(e) => updateOtherMaterialLine(index, { rate: e.target.value })} />
            <input aria-label="Or a manual amount" type="number" step="0.01" min="0" placeholder="Or amount (₹)" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.manualAmount} onChange={(e) => updateOtherMaterialLine(index, { manualAmount: e.target.value })} disabled={line.quantity.trim() !== "" && line.rate.trim() !== ""} />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <button type="button" onClick={() => setOtherMaterialLines((prev) => prev.filter((_, i) => i !== index))} className="text-xs font-medium text-red-600 hover:underline dark:text-red-400">
              Remove
            </button>
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">₹{otherMaterialLineAmount(line).toFixed(2)}</span>
          </div>
        </div>
      ))}
      <Button type="button" variant="secondary" size="md" onClick={() => setOtherMaterialLines((prev) => [...prev, emptyOtherMaterialLine()])}>
        + Add other-material line
      </Button>

      <h3 className="mt-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Labour and additional charges</h3>
      {chargeLines.map((line, index) => (
        <div key={index} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <input
              aria-label="Label"
              list="charge-label-suggestions"
              placeholder="Label, e.g. Karigar labour"
              className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
              value={line.label}
              onChange={(e) => updateChargeLine(index, { label: e.target.value })}
            />
            <select aria-label="Calculation method" className="h-10 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.method} onChange={(e) => updateChargeLine(index, { method: e.target.value })}>
              {Object.entries(CHARGE_METHOD_LABELS).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input aria-label="Rate" type="number" step="0.01" min="0" placeholder="Rate/amount (₹)" className="h-10 rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100" value={line.rate} onChange={(e) => updateChargeLine(index, { rate: e.target.value })} />
            <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
              <input type="checkbox" checked={line.isLabour} onChange={(e) => updateChargeLine(index, { isLabour: e.target.checked })} className="h-4 w-4 rounded border-zinc-300 dark:border-zinc-600" />
              Counts as labour
            </label>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <button type="button" onClick={() => setChargeLines((prev) => prev.filter((_, i) => i !== index))} className="text-xs font-medium text-red-600 hover:underline dark:text-red-400">
              Remove
            </button>
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">₹{chargeLineAmount(line).toFixed(2)}</span>
          </div>
        </div>
      ))}
      <datalist id="charge-label-suggestions">
        {CHARGE_LABEL_SUGGESTIONS.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <Button type="button" variant="secondary" size="md" onClick={() => setChargeLines((prev) => [...prev, emptyChargeLine()])}>
        + Add charge line
      </Button>

      <h3 className="mt-2 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Selling price</h3>
      <PricingFields value={pricing} onChange={setPricing} gstRates={gstRates} showAdvanced={showAdvancedPricing} onToggleAdvanced={() => setShowAdvancedPricing((v) => !v)} />

      <CalculationSummary
        metalCost={metalCost}
        diamondCost={diamondCost}
        otherMaterialCost={otherMaterialCost}
        labourCost={labourCost}
        additionalChargesCost={additionalChargesCost}
        totals={totals}
        isManualOverride={pricing.useManualOverride}
      />

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Save as Draft"}
        </Button>
      </div>
    </form>
  );
}
