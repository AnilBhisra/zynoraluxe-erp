import type { PieceSticker as PieceStickerData, StickerSize } from "@/lib/jewellery/stickers";

/**
 * One printed finished-piece sticker, at its real millimetre size (styles:
 * .sticker* in globals.css — no inline style, which the CSP forbids). Pure
 * markup: every figure comes from the saved piece, and the data type carries
 * no cost, value or price at all.
 */
export function PieceSticker({
  s,
  qr,
  size,
  reprint,
}: {
  s: PieceStickerData;
  /** SVG path of the QR modules and the viewBox side (modules + quiet zone). */
  qr: { path: string; side: number };
  size: StickerSize;
  reprint: boolean;
}) {
  const qrMm = size === "50x30" ? 20 : 16;
  const date = new Date(s.receiptDate).toLocaleDateString("en-IN", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
  return (
    <div className="sticker" data-testid={`sticker-${s.finishedCode}`} data-active={s.active ? "1" : "0"}>
      <div className="sticker-head">
        <span className="sticker-brand">ZYNORALUXE</span>
        {reprint ? (
          <span className="sticker-reprint" data-testid="sticker-reprint">
            REPRINT
          </span>
        ) : null}
      </div>
      <div className={s.active ? "sticker-status" : "sticker-status sticker-status-inactive"} data-testid="sticker-status">
        {s.statusLabel}
      </div>
      <div className="sticker-body">
        <svg
          viewBox={`0 0 ${qr.side} ${qr.side}`}
          width={`${qrMm}mm`}
          height={`${qrMm}mm`}
          shapeRendering="crispEdges"
          role="img"
          aria-label={`QR code for ${s.finishedCode}`}
          data-testid="sticker-qr"
          className="sticker-qr"
        >
          <rect width={qr.side} height={qr.side} fill="#fff" />
          <path d={qr.path} fill="#000" />
        </svg>
        <div className="sticker-text">
          <div className="sticker-code">{s.finishedCode}</div>
          <div>Job {s.jobCode}</div>
          <div>
            Rec {s.receiptCode} · {date}
          </div>
          <div>
            {s.category}
            {s.designName ? ` · ${s.designName}` : ""}
          </div>
          <div>{s.metalLabel}</div>
          <div>
            Net {s.netWeight} g · Fine {s.fineWeight} g
          </div>
          <div data-testid="sticker-gross">{s.grossWeight === null ? "Gross: Not recorded" : `Gross ${s.grossWeight} g`}</div>
          <div>{s.stonePieces > 0 ? `Stones ${s.stonePieces} pcs / ${s.stoneCarat} ct` : "Stones: none"}</div>
          {s.customerName ? <div>Cust {s.customerName}</div> : null}
          <div>Kar {s.karigarName}</div>
        </div>
      </div>
    </div>
  );
}
