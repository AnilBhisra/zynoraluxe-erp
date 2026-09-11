"use client";

import { useId, useMemo, useState } from "react";

export type PartyOption = {
  id: string;
  name: string;
  type: "CUSTOMER" | "SUPPLIER" | "KARIGAR";
  stateCode: string | null;
};

/** A searchable party picker. Renders a real <select> (name={name}) so it
 * works with plain HTML forms / server actions without extra JS plumbing —
 * the text input above it only filters which <option>s are visible. */
export function PartySelect({
  name,
  parties,
  defaultValue,
  onChange,
  required,
}: {
  name: string;
  parties: PartyOption[];
  defaultValue?: string;
  onChange?: (partyId: string) => void;
  required?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [value, setValue] = useState(defaultValue ?? "");
  const inputId = useId();
  const selectId = useId();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return parties;
    return parties.filter((p) => p.name.toLowerCase().includes(q));
  }, [search, parties]);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
        Party{required ? <span className="text-red-600 dark:text-red-400"> *</span> : null}
      </label>
      <input
        id={inputId}
        type="text"
        placeholder="Search parties by name…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 focus:border-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100 dark:focus-visible:ring-amber-300"
      />
      <select
        id={selectId}
        name={name}
        required={required}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onChange?.(e.target.value);
        }}
        size={Math.min(6, Math.max(3, filtered.length + 1))}
        className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
      >
        <option value="" disabled>
          {filtered.length === 0 ? "No parties match" : "Choose a party…"}
        </option>
        {filtered.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.type}
          </option>
        ))}
      </select>
    </div>
  );
}
