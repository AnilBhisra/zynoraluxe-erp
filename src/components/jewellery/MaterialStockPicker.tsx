"use client";

import { Button } from "@/components/ui/Button";

/**
 * Purchased Other Material available in stock. `averageRate` is the Owner's
 * carrying rate per unit — null for Staff (never sent to them).
 */
export type MaterialStockOption = { id: string; code: string; name: string; unit: string; available: string; averageRate: string | null };
export type MaterialLineDraft = { itemId: string; quantity: string };

const INPUT = "h-10 w-full min-w-0 rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

/** What a line problem is, or null — mirrors the server (it re-checks under a stock lock). */
export function materialLineProblem(line: MaterialLineDraft, options: MaterialStockOption[], available?: (o: MaterialStockOption) => string): string | null {
  if (!line.itemId) return "Choose a purchased material.";
  const o = options.find((x) => x.id === line.itemId);
  if (!o) return "That material is not in stock.";
  if (!/^\d+(\.\d{1,3})?$/.test(line.quantity.trim()) || !(Number(line.quantity) > 0)) return `${o.name}: enter a quantity more than zero (at most 3 decimals).`;
  const have = available ? available(o) : o.available;
  if (Number(line.quantity) > Number(have)) return `${o.name}: only ${have} ${o.unit} available.`;
  return null;
}

/** Item + quantity lines picked from purchased stock. No free text, no typed cost. */
export function MaterialStockPicker({
  options,
  lines,
  onChange,
  availableLabel = "in stock",
  emptyHint = "No purchased Other Material in stock. Purchase it first (Jewellery Jobs → Other Material).",
}: {
  options: MaterialStockOption[];
  lines: MaterialLineDraft[];
  onChange: (lines: MaterialLineDraft[]) => void;
  availableLabel?: string;
  emptyHint?: string;
}) {
  const usable = options.filter((o) => Number(o.available) > 0);
  if (usable.length === 0) return <p className="text-xs text-zinc-500 dark:text-zinc-400" data-testid="material-none">{emptyHint}</p>;
  const set = (i: number, patch: Partial<MaterialLineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="flex flex-col gap-2" data-testid="material-picker">
      {lines.map((line, i) => {
        const o = options.find((x) => x.id === line.itemId);
        const estimate = o?.averageRate && Number(line.quantity) > 0 ? (Number(o.averageRate) * Number(line.quantity)).toFixed(2) : null;
        return (
          <div key={i} className="grid min-w-0 grid-cols-1 gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 sm:grid-cols-[2fr_1fr_auto]" data-testid="material-line">
            <select aria-label="Material" value={line.itemId} onChange={(e) => set(i, { itemId: e.target.value })} className={INPUT}>
              <option value="">— choose purchased material —</option>
              {usable.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} · {x.name} · {x.available} {x.unit} {availableLabel}
                </option>
              ))}
            </select>
            <input aria-label="Quantity" inputMode="decimal" placeholder={o ? `Qty (${o.unit})` : "Qty"} value={line.quantity} onChange={(e) => set(i, { quantity: e.target.value })} className={INPUT} />
            <button type="button" onClick={() => onChange(lines.filter((_, j) => j !== i))} className="h-10 text-xs font-medium text-red-600 hover:underline dark:text-red-400">
              Remove
            </button>
            {o ? (
              <p className="text-[11px] text-zinc-500 sm:col-span-3">
                {o.available} {o.unit} {availableLabel}
                {estimate ? ` · ≈ ₹${estimate} at carrying cost (exact figure on save)` : ""}
              </p>
            ) : null}
          </div>
        );
      })}
      <Button type="button" variant="secondary" size="md" className="self-start" onClick={() => onChange([...lines, { itemId: "", quantity: "" }])} data-testid="material-add">
        + Add purchased material
      </Button>
    </div>
  );
}
