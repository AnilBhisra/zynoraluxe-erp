"use client";

import { Button } from "@/components/ui/Button";

/** Print chrome for the Customer gold acknowledgment and statement (uses the .quotation-print-area print rules in globals.css). */
export function CustomerGoldPrintShell({ backHref, children }: { backHref: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="quotation-no-print mb-4 flex gap-2">
        <a href={backHref}>
          <Button type="button" variant="ghost">
            ← Back
          </Button>
        </a>
        <Button type="button" onClick={() => window.print()}>
          Print / Save as PDF
        </Button>
      </div>
      <div className="quotation-print-area mx-auto max-w-3xl rounded-2xl border border-[var(--border)] bg-white p-6 text-zinc-900 sm:p-8">{children}</div>
    </div>
  );
}
