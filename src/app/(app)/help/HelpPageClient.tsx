"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

import { Card, CardHeader, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import type { HelpSection, HelpTaskCard } from "@/lib/help/sections";
import styles from "./help-print.module.css";

function normalize(text: string) {
  return text.toLowerCase();
}

export function HelpPageClient({
  sections,
  taskCards,
  roleLabel,
}: {
  sections: HelpSection[];
  taskCards: HelpTaskCard[];
  roleLabel: string;
}) {
  const [query, setQuery] = useState("");

  const filteredSections = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return sections;
    return sections.filter((s) => {
      const haystack = normalize([s.title, ...s.keywords].join(" "));
      return haystack.includes(q);
    });
  }, [sections, query]);

  const filteredTaskCards = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return taskCards;
    return taskCards.filter((c) => normalize(c.label).includes(q));
  }, [taskCards, query]);

  return (
    <div className={`flex flex-col gap-8 ${styles.root}`}>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          મદદ / Help
        </h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          {roleLabel} તરીકે login થયેલા છો. જે કરવું છે એ નીચે શોધો, અથવા card પર દબાવો.
        </p>
      </div>

      <div className={`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${styles.noPrint}`}>
        <div className="w-full sm:max-w-sm">
          <label htmlFor="help-search" className="sr-only">
            મદદમાં શોધો
          </label>
          <input
            id="help-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="શોધો… (દા.ત. New Sale, party, GST)"
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100 dark:focus-visible:ring-amber-300"
          />
        </div>
        <Button type="button" variant="secondary" onClick={() => window.print()}>
          Print / Save PDF
        </Button>
      </div>

      <div>
        <h2 className="mb-3 text-base font-semibold text-zinc-900 dark:text-zinc-50">
          મારે શું કરવું છે?
        </h2>
        {filteredTaskCards.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">કંઈ મળ્યું નહીં.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {filteredTaskCards.map((card) => (
              <Link
                key={card.id}
                href={`#${card.anchor}`}
                className="flex min-h-20 items-center rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm font-medium text-zinc-800 shadow-sm transition-colors hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus-visible:ring-amber-300"
              >
                {card.label}
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-6">
        {filteredSections.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            કંઈ મળ્યું નહીં — બીજા શબ્દોથી શોધો (Gujarati કે English બંને ચાલશે).
          </p>
        ) : (
          filteredSections.map((section) => (
            <Card key={section.id} id={section.id} className={`min-w-0 scroll-mt-24 ${styles.section}`}>
              <CardHeader className="min-w-0">
                <CardTitle>{section.title}</CardTitle>
                <div className="mt-4">{section.body}</div>
              </CardHeader>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
