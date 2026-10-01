import type { Metadata } from "next";
import { headers } from "next/headers";

import { requireUser } from "@/lib/auth/dal";
import { prisma } from "@/lib/db/prisma";
import { loadPieceStickers, qrMatrix, qrPath, STICKER_SIZES, type StickerSize } from "@/lib/jewellery/stickers";
import { PieceSticker } from "@/components/jewellery/PieceSticker";
import { StickerToolbar } from "@/components/jewellery/StickerToolbar";

export const metadata: Metadata = {
  title: "Stickers · ZYNORALUXE",
};

const SIZE_LABEL: Record<StickerSize, string> = { "50x25": "50 × 25 mm", "50x30": "50 × 30 mm", a4: "A4 sheet" };
const QUIET = 2;

/** Absolute origin of this request, for the QR link (an authenticated app page — no id, no token). */
async function requestOrigin(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

/**
 * Printable finished-piece stickers: ?receipt=<receipt code> (one per piece of
 * that receipt) or ?piece=<code>&piece=<code>…, with &size=50x25|50x30|a4 and
 * &reprint=1. Owner and Staff alike: the data loaded here has no cost field,
 * so nothing financial can reach the page. Read-only — printing writes nothing.
 * Lives outside the app shell so only the stickers print.
 */
export default async function StickersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireUser();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const size: StickerSize = (STICKER_SIZES as readonly string[]).includes(one(sp.size)) ? (one(sp.size) as StickerSize) : "50x25";
  const reprint = one(sp.reprint) === "1";
  const receiptCode = one(sp.receipt).trim() || null;
  const pieceCodes = (Array.isArray(sp.piece) ? sp.piece : sp.piece ? [sp.piece] : []).map((p) => p.trim()).filter(Boolean);
  const back = one(sp.back);
  const backHref = back.startsWith("/") && !back.startsWith("//") ? back : "/jewellery-jobs?tab=finished";

  const [stickers, origin] = await Promise.all([loadPieceStickers(prisma, { receiptCode, pieceCodes }), requestOrigin()]);
  const withQr = stickers.map((s) => {
    const m = qrMatrix(`${origin}${s.lookupPath}`);
    return { s, qr: { path: qrPath(m, QUIET), side: m.size + 2 * QUIET } };
  });

  const params = (nextSize: string) => {
    const p = new URLSearchParams();
    if (receiptCode) p.set("receipt", receiptCode);
    for (const c of pieceCodes) p.append("piece", c);
    p.set("size", nextSize);
    if (reprint) p.set("reprint", "1");
    if (back) p.set("back", back);
    return `/stickers?${p.toString()}`;
  };
  const warnings = [
    ...stickers.filter((s) => s.grossWeight === null).map((s) => `${s.finishedCode}: gross weight was not recorded — the sticker prints "Gross: Not recorded".`),
    ...stickers.filter((s) => !s.active).map((s) => `${s.finishedCode} is not active stock: ${s.statusLabel}.`),
  ];

  return (
    <main className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <StickerToolbar
        backHref={backHref}
        current={size}
        count={stickers.length}
        warnings={warnings}
        sizeLinks={STICKER_SIZES.map((sz) => ({ size: sz, label: SIZE_LABEL[sz], href: params(sz) }))}
      />
      {stickers.length === 0 ? (
        <p className="sticker-no-print text-sm text-zinc-600 dark:text-zinc-400" data-testid="sticker-none">
          No finished piece found for this sticker request.
        </p>
      ) : (
        <div className={`sticker-sheet sticker-sheet-${size} flex flex-wrap gap-3`} data-testid="sticker-sheet" data-size={size}>
          {withQr.map(({ s, qr }) => (
            <PieceSticker key={s.finishedCode} s={s} qr={qr} size={size === "a4" ? "50x25" : size} reprint={reprint} />
          ))}
        </div>
      )}
    </main>
  );
}
