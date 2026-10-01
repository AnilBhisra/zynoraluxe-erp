import type { Metadata } from "next";

import { requireUser } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { loadPieceSticker } from "@/lib/jewellery/stickers";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = {
  title: "Finished piece · ZYNORALUXE",
};

/**
 * Where a sticker's QR code lands: the piece by its code, for any signed-in
 * user. Non-financial — the same fields the sticker prints, plus its current
 * status — with links to the job and to reprint.
 */
export default async function PieceLookupPage({ params }: { params: Promise<{ code: string }> }) {
  await requireUser();
  const { code } = await params;
  const finishedCode = decodeURIComponent(code).trim().slice(0, 40);
  const s = await loadPieceSticker(prisma, finishedCode);
  if (!s) {
    return (
      <div>
        <PageHeader title="Finished piece" description="Scanned from a sticker." />
        <p className="text-sm text-zinc-600 dark:text-zinc-400" data-testid="piece-not-found">
          No finished piece {finishedCode} was found.
        </p>
      </div>
    );
  }
  const job = await prisma.jewelleryJob.findUnique({ where: { jobCode: s.jobCode }, select: { id: true } });
  const rows: [string, string][] = [
    ["Status", s.statusLabel],
    ["Job", s.jobCode],
    ["Receipt", `${s.receiptCode} · ${new Date(s.receiptDate).toLocaleDateString("en-IN", { timeZone: "UTC" })}`],
    ["Item", `${s.category}${s.designName ? ` · ${s.designName}` : ""}`],
    ["Metal", s.metalLabel],
    ["Net weight", `${s.netWeight} g`],
    ["Gross weight", s.grossWeight === null ? "Not recorded" : `${s.grossWeight} g`],
    ["Fine weight", `${s.fineWeight} g`],
    ["Stones", s.stonePieces > 0 ? `${s.stonePieces} pcs / ${s.stoneCarat} ct` : "None"],
    ...(s.customerName ? ([["Customer", s.customerName]] as [string, string][]) : []),
    ["Karigar", s.karigarName],
  ];
  return (
    <div>
      <PageHeader title={s.finishedCode} description="Finished piece (scanned from a sticker)." />
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 text-sm sm:grid-cols-2" data-testid="piece-lookup">
        {rows.map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">{k}</dt>
            <dd className={`break-words font-medium ${k === "Status" && !s.active ? "text-red-700 dark:text-red-400" : "text-zinc-900 dark:text-zinc-100"}`}>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        {job ? (
          <a className="font-medium underline underline-offset-4" href={`/jewellery-jobs?jobId=${job.id}`}>
            Open job {s.jobCode}
          </a>
        ) : null}
        <a className="font-medium underline underline-offset-4" href={`/stickers?piece=${encodeURIComponent(s.finishedCode)}&reprint=1&back=${encodeURIComponent(`/p/${s.finishedCode}`)}`}>
          Reprint sticker
        </a>
      </div>
    </div>
  );
}
