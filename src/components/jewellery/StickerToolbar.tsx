"use client";

import { Button } from "@/components/ui/Button";

/** Preview chrome for the sticker page — never printed. Printing is always the user's own click. */
export function StickerToolbar({
  backHref,
  sizeLinks,
  current,
  warnings,
  count,
}: {
  backHref: string;
  sizeLinks: { size: string; label: string; href: string }[];
  current: string;
  warnings: string[];
  count: number;
}) {
  return (
    <div className="sticker-no-print mb-4 flex flex-col gap-3" data-testid="sticker-toolbar">
      <div className="flex flex-wrap items-center gap-2">
        <a href={backHref}>
          <Button type="button" variant="ghost">
            ← Back
          </Button>
        </a>
        <Button type="button" onClick={() => window.print()} disabled={count === 0} data-testid="sticker-print">
          Print {count === 1 ? "sticker" : `${count} stickers`}
        </Button>
        <span className="text-sm text-zinc-600 dark:text-zinc-400">Size:</span>
        {sizeLinks.map((l) => (
          <a
            key={l.size}
            href={l.href}
            aria-current={l.size === current ? "page" : undefined}
            data-testid={`sticker-size-${l.size}`}
            className={`rounded-lg border px-3 py-1.5 text-sm ${l.size === current ? "border-zinc-900 bg-zinc-900 text-white dark:border-amber-200 dark:bg-amber-200 dark:text-zinc-900" : "border-zinc-300 dark:border-zinc-600"}`}
          >
            {l.label}
          </a>
        ))}
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">
        Preview at actual size. In the print dialog choose your label printer (or A4 paper), scale 100% / &quot;Actual size&quot;, margins none. Printing
        changes nothing in stock or accounts. / પ્રિન્ટ કરવાથી stock કે હિસાબમાં કંઈ બદલાતું નથી.
      </p>
      {warnings.map((w) => (
        <p key={w} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" data-testid="sticker-warning">
          {w}
        </p>
      ))}
    </div>
  );
}
