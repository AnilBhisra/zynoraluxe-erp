import "server-only";

import QRCode from "qrcode";

import type { FinishedJewelleryOwnership, FinishedJewelleryStockStatus } from "@/generated/prisma/enums";
import { Decimal } from "@/lib/accounting/money";
import type { Tx } from "@/lib/corrections/types";
import { jewelleryTypeLabel, metalTypeLabel } from "@/lib/jewellery/types";

/**
 * Finished-piece stickers. Everything here is NON-FINANCIAL by construction:
 * the queries select no cost, value, charge or price column at all, so the
 * same data is safe for Owner and Staff, in the page, the print HTML, the QR
 * and every network response. Printing reads saved records only and never
 * writes anything.
 */

export const STICKER_SIZES = ["50x25", "50x30", "a4"] as const;
export type StickerSize = (typeof STICKER_SIZES)[number];

export type PieceSticker = {
  finishedCode: string;
  jobCode: string;
  receiptCode: string;
  category: string;
  designName: string | null;
  metalLabel: string;
  netWeight: string;
  /** Null when the receipt did not record it — printed as "Not recorded", never invented. */
  grossWeight: string | null;
  fineWeight: string;
  stonePieces: number;
  stoneCarat: string;
  /** Only for Customer-owned jewellery. */
  customerName: string | null;
  karigarName: string;
  receiptDate: string;
  statusLabel: string;
  /** False for anything that is not live stock awaiting sale / delivery. */
  active: boolean;
  /** The authenticated lookup path encoded in the QR (no id, no token). */
  lookupPath: string;
};

export function stickerStatus(status: FinishedJewelleryStockStatus, ownership: FinishedJewelleryOwnership): { label: string; active: boolean } {
  switch (status) {
    case "AVAILABLE":
      return { label: "COMPANY STOCK", active: true };
    case "CUSTOMER_AWAITING_DELIVERY":
      return { label: "CUSTOMER GOLD — AWAITING DELIVERY", active: true };
    case "DELIVERED_TO_CUSTOMER":
      return { label: "DELIVERED", active: false };
    case "RECEIPT_REVERSED":
      return { label: "RECEIPT REVERSED — NOT ACTIVE", active: false };
    case "SOLD":
      return { label: "SOLD — NOT IN STOCK", active: false };
    case "RETURNED_DAMAGED":
      return { label: "RETURNED DAMAGED — NOT IN STOCK", active: false };
    default:
      return { label: `${String(status).replace(/_/g, " ")}${ownership === "CUSTOMER" ? " (CUSTOMER)" : ""} — NOT ACTIVE`, active: false };
  }
}

/** The QR's target: the piece's code on an authenticated page. Never a database id or a token. */
export function pieceLookupPath(finishedCode: string): string {
  return `/p/${encodeURIComponent(finishedCode)}`;
}

const PIECE_SELECT = {
  finishedCode: true,
  jewelleryType: true,
  description: true,
  grossWeight: true,
  netMetalWeight: true,
  fineMetalWeight: true,
  metalType: true,
  finenessPercentSnapshot: true,
  status: true,
  ownership: true,
  createdAt: true,
  purity: { select: { displayName: true } },
  customer: { select: { name: true } },
  receipt: { select: { receiptCode: true, receiveDate: true } },
  job: { select: { jobCode: true, designName: true, karigar: { select: { name: true } } } },
  diamonds: { where: { resolvedAs: "SET" }, select: { caratAtIssue: true } },
  packetResolutions: { where: { disposition: "SET", reversedAt: null }, select: { pieces: true, carat: true } },
} as const;

type PieceRow = Awaited<ReturnType<typeof loadRows>>[number];

async function loadRows(tx: Tx, where: { receipt?: { receiptCode: string }; finishedCode?: { in: string[] } }) {
  return tx.finishedJewellery.findMany({ where, select: PIECE_SELECT, orderBy: { finishedCode: "asc" } });
}

function toSticker(p: PieceRow): PieceSticker {
  const { label, active } = stickerStatus(p.status, p.ownership);
  const caratIndividual = p.diamonds.reduce((s, d) => s.plus(d.caratAtIssue), new Decimal(0));
  const caratPackets = p.packetResolutions.reduce((s, r) => s.plus(r.carat), new Decimal(0));
  return {
    finishedCode: p.finishedCode,
    jobCode: p.job.jobCode,
    receiptCode: p.receipt.receiptCode,
    category: jewelleryTypeLabel(p.jewelleryType),
    designName: p.job.designName ?? p.description ?? null,
    metalLabel: `${metalTypeLabel(p.metalType)} ${p.purity.displayName} (${new Decimal(p.finenessPercentSnapshot).toFixed(3)}%)`,
    netWeight: new Decimal(p.netMetalWeight).toFixed(3),
    grossWeight: p.grossWeight === null ? null : new Decimal(p.grossWeight).toFixed(3),
    fineWeight: new Decimal(p.fineMetalWeight).toFixed(3),
    stonePieces: p.diamonds.length + p.packetResolutions.reduce((s, r) => s + r.pieces, 0),
    stoneCarat: caratIndividual.plus(caratPackets).toFixed(3),
    customerName: p.ownership === "CUSTOMER" ? (p.customer?.name ?? null) : null,
    karigarName: p.job.karigar.name,
    receiptDate: p.receipt.receiveDate.toISOString(),
    statusLabel: label,
    active,
    lookupPath: pieceLookupPath(p.finishedCode),
  };
}

/** Stickers for every piece of one receipt, or for the listed piece codes (at most 200). */
export async function loadPieceStickers(tx: Tx, query: { receiptCode?: string | null; pieceCodes?: string[] }): Promise<PieceSticker[]> {
  if (query.receiptCode) return (await loadRows(tx, { receipt: { receiptCode: query.receiptCode } })).map(toSticker);
  const codes = [...new Set((query.pieceCodes ?? []).map((c) => c.trim()).filter(Boolean))].slice(0, 200);
  if (codes.length === 0) return [];
  return (await loadRows(tx, { finishedCode: { in: codes } })).map(toSticker);
}

/** One piece, for the authenticated QR lookup page. */
export async function loadPieceSticker(tx: Tx, finishedCode: string): Promise<PieceSticker | null> {
  const [row] = await loadRows(tx, { finishedCode: { in: [finishedCode] } });
  return row ? toSticker(row) : null;
}

export type QrMatrix = { size: number; dark: boolean[] };

/** QR modules (error correction M) for a short text — rendered as an SVG path by the page. */
export function qrMatrix(text: string): QrMatrix {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  const dark: boolean[] = [];
  for (let i = 0; i < size * size; i++) dark.push(Boolean(qr.modules.data[i]));
  return { size, dark };
}

/** SVG path data for the dark modules, one unit per module, offset by the quiet zone. */
export function qrPath(m: QrMatrix, quiet = 2): string {
  const parts: string[] = [];
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.dark[y * m.size + x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  return parts.join("");
}
