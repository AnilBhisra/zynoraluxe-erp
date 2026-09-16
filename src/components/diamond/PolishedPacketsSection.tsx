"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { PartyOption } from "@/components/accounting/PartySelect";
import { CancelPolishedPurchaseForm } from "@/components/diamond/CancelPolishedPurchaseForm";
import { PolishedPurchaseForm } from "@/components/diamond/PolishedPurchaseForm";
import { shapeLabel } from "@/lib/diamond/shapes";
import type { DiamondShape } from "@/generated/prisma/enums";

export type SerializedPacket = {
  id: string;
  packetCode: string;
  provenance: string;
  shape: DiamondShape;
  customShapeName: string | null;
  sizeLabel: string;
  quality: string | null;
  colour: string | null;
  certificateStatus: string;
  certNumber: string | null;
  purchaseCode: string | null;
  supplierName: string | null;
  pieces: number;
  carat: string;
  /** Owner-only — null for Staff (redacted on the server). */
  costValue: string | null;
};

export type SerializedPacketGroup = {
  mergeKey: string;
  label: string;
  provenance: string;
  pieces: number;
  carat: string;
  costValue: string | null;
  packetCodes: string[];
};

export type SerializedPolishedPurchase = {
  id: string;
  purchaseCode: string;
  purchaseDate: string;
  supplierName: string;
  brokerName: string | null;
  lineCount: number;
  totalPieces: number;
  totalCarat: string;
  status: string;
  /** Owner-only — null for Staff. */
  landedCost: string | null;
  brokerageAmount: string | null;
};

export const PROVENANCE_LABELS: Record<string, string> = {
  PURCHASED: "Purchased",
  MANUFACTURED_FROM_ROUGH: "Manufactured from rough",
  RETURNED_FROM_JOB: "Returned from job",
  ADJUSTMENT: "Adjustment",
};

export function PolishedPacketsSection({
  packets,
  groups,
  purchases,
  suppliers,
  brokers,
  paymentAccounts,
  gstRates,
  isOwner,
}: {
  packets: SerializedPacket[];
  groups: SerializedPacketGroup[];
  purchases: SerializedPolishedPurchase[];
  suppliers: PartyOption[];
  brokers: PartyOption[];
  paymentAccounts: { id: string; name: string; method: string }[];
  gstRates: { id: string; label: string; ratePercent: string }[];
  isOwner: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const [view, setView] = useState<"grouped" | "packets" | "purchases">("grouped");
  const closeForm = useCallback(() => setShowForm(false), []);

  const tabClass = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-xs font-medium ${
      active ? "bg-zinc-900 text-white dark:bg-amber-200 dark:text-zinc-900" : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
    }`;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">Polished Diamond packets</h2>
        <Button type="button" size="md" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Close" : "+ New Polished Purchase"}
        </Button>
      </div>

      {showForm ? (
        <PolishedPurchaseForm
          suppliers={suppliers}
          brokers={brokers}
          paymentAccounts={paymentAccounts}
          gstRates={gstRates}
          onDone={closeForm}
        />
      ) : null}

      <div role="tablist" aria-label="Packet views" className="flex flex-wrap gap-1">
        <button type="button" role="tab" aria-selected={view === "grouped"} className={tabClass(view === "grouped")} onClick={() => setView("grouped")}>
          Grouped stock
        </button>
        <button type="button" role="tab" aria-selected={view === "packets"} className={tabClass(view === "packets")} onClick={() => setView("packets")}>
          Each packet
        </button>
        <button type="button" role="tab" aria-selected={view === "purchases"} className={tabClass(view === "purchases")} onClick={() => setView("purchases")}>
          Purchases
        </button>
      </div>

      {view === "grouped" ? (
        groups.length === 0 ? (
          <EmptyState title="No polished packets in stock" description="Record a Polished Purchase to add packet stock." />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead className="bg-[var(--surface-muted)] text-xs text-zinc-500 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 font-medium">Stones</th>
                  <th className="px-3 py-2 font-medium">Provenance</th>
                  <th className="px-3 py-2 text-right font-medium">Pieces</th>
                  <th className="px-3 py-2 text-right font-medium">Carat</th>
                  {isOwner ? <th className="px-3 py-2 text-right font-medium">Cost</th> : null}
                  <th className="px-3 py-2 font-medium">Packets</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => (
                  <tr key={g.mergeKey} className="border-t border-[var(--border)]">
                    <td className="px-3 py-2 text-zinc-900 dark:text-zinc-100">{g.label}</td>
                    <td className="px-3 py-2 text-zinc-600 dark:text-zinc-400">{PROVENANCE_LABELS[g.provenance] ?? g.provenance}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{g.pieces}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{g.carat}</td>
                    {isOwner ? <td className="px-3 py-2 text-right tabular-nums">₹{g.costValue}</td> : null}
                    <td className="px-3 py-2 text-xs text-zinc-500 dark:text-zinc-400">{g.packetCodes.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {view === "packets" ? (
        packets.length === 0 ? (
          <EmptyState title="No polished packets yet" description="Record a Polished Purchase to create packets." />
        ) : (
          <ul className="flex flex-col gap-2">
            {packets.map((p) => (
              <li key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{p.packetCode}</p>
                  <p className="text-sm tabular-nums text-zinc-700 dark:text-zinc-300">
                    {p.pieces} pcs · {p.carat}ct{isOwner ? ` · ₹${p.costValue}` : ""}
                  </p>
                </div>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {p.shape === "CUSTOM" && p.customShapeName ? p.customShapeName : shapeLabel(p.shape)} · {p.sizeLabel}
                  {p.quality ? ` · ${p.quality}` : ""}
                  {p.colour ? ` · ${p.colour}` : ""}
                  {p.certNumber ? ` · Cert ${p.certNumber}` : ""} · {PROVENANCE_LABELS[p.provenance] ?? p.provenance}
                  {p.purchaseCode ? ` · ${p.purchaseCode}` : ""}
                  {p.supplierName ? ` · Party / Supplier: ${p.supplierName}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )
      ) : null}

      {view === "purchases" ? (
        purchases.length === 0 ? (
          <EmptyState title="No polished purchases yet" description="Use “New Polished Purchase” to record one." />
        ) : (
          <ul className="flex flex-col gap-2">
            {purchases.map((p) => (
              <li key={p.id} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                      {p.purchaseCode}
                      {p.status === "CANCELLED" ? (
                        <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
                          Cancelled
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      {new Date(p.purchaseDate).toLocaleDateString("en-IN")} · Party / Supplier: {p.supplierName}
                      {p.brokerName ? ` · Dalal / Broker: ${p.brokerName}` : ""} · {p.lineCount} packet{p.lineCount === 1 ? "" : "s"} ·{" "}
                      {p.totalPieces} pcs · {p.totalCarat}ct
                      {isOwner ? ` · Landed ₹${p.landedCost}` : ""}
                      {isOwner && p.brokerageAmount && p.brokerageAmount !== "0.00" ? ` · Brokerage ₹${p.brokerageAmount}` : ""}
                    </p>
                  </div>
                  {isOwner && p.status !== "CANCELLED" ? <CancelPolishedPurchaseForm purchaseId={p.id} purchaseCode={p.purchaseCode} /> : null}
                </div>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}
