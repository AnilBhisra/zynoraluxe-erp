/**
 * Polished packet stock — pure helpers shared by the posting engine, the
 * reports layer and the client preview. No Prisma or server-only imports,
 * so a Client Component can use the same merge-key and quantity rules the
 * server enforces.
 */

export type PacketMovementKind =
  | "PURCHASE_IN"
  | "PURCHASE_CANCEL_OUT"
  | "PROCESS_ISSUE_OUT"
  | "PROCESS_ISSUE_CANCEL_IN"
  | "PROCESS_RETURN_IN"
  | "JEWELLERY_ISSUE_OUT"
  | "JEWELLERY_ISSUE_CANCEL_IN"
  | "JEWELLERY_RETURN_IN"
  | "ADJUSTMENT_IN"
  | "ADJUSTMENT_OUT";

/** Direction each immutable movement applies to a packet's own balance. */
export const PACKET_MOVEMENT_EFFECT: Partial<Record<string, -1 | 1>> = {
  PURCHASE_IN: 1,
  PURCHASE_CANCEL_OUT: -1,
  PROCESS_ISSUE_OUT: -1,
  PROCESS_ISSUE_CANCEL_IN: 1,
  PROCESS_RETURN_IN: 1,
  JEWELLERY_ISSUE_OUT: -1,
  JEWELLERY_ISSUE_CANCEL_IN: 1,
  JEWELLERY_RETURN_IN: 1,
  ADJUSTMENT_IN: 1,
  ADJUSTMENT_OUT: -1,
};

export type PacketAttributes = {
  shape: string;
  customShapeName?: string | null;
  sizeLabel: string;
  quality?: string | null;
  colour?: string | null;
  lab?: string | null;
  certificateStatus: string;
  provenance: string;
  currencyCode?: string | null;
};

function normalise(value: string | null | undefined): string {
  return (value ?? "").trim().toUpperCase();
}

/**
 * The approved merge key: two packets are shown together in the aggregated
 * Polished Diamond view only when every one of these matches. Provenance and
 * currency are part of it deliberately — purchased and manufactured stones,
 * or two different cost bases, are never averaged into one line. Certificate
 * NUMBER is not part of it: a certified single stone is identified by the
 * packet itself, not grouped.
 */
export function buildPacketMergeKey(attributes: PacketAttributes): string {
  return [
    normalise(attributes.shape),
    normalise(attributes.customShapeName),
    normalise(attributes.sizeLabel),
    normalise(attributes.quality),
    normalise(attributes.colour),
    normalise(attributes.lab),
    normalise(attributes.certificateStatus),
    normalise(attributes.provenance),
    normalise(attributes.currencyCode ?? "INR"),
  ].join("|");
}

export type PacketQuantity = { pieces: number; carat: string };

/**
 * Whether a requested issue/resolution quantity is valid against what the
 * packet (or issue line) still holds. Pieces and carat must empty together:
 * taking every carat while leaving pieces behind — or the reverse — would
 * strand an unusable residue that no later movement could clear.
 */
export function checkPacketQuantity(
  requested: { pieces: number; caratThousandths: bigint },
  available: { pieces: number; caratThousandths: bigint }
): { ok: true } | { ok: false; reason: string } {
  const zero = BigInt(0);
  if (requested.pieces < 0 || requested.caratThousandths < zero) {
    return { ok: false, reason: "Pieces and carat cannot be negative." };
  }
  if (requested.pieces === 0 && requested.caratThousandths === zero) {
    return { ok: false, reason: "Enter pieces or carat." };
  }
  if (requested.pieces > available.pieces) {
    return { ok: false, reason: `Only ${available.pieces} piece(s) available.` };
  }
  if (requested.caratThousandths > available.caratThousandths) {
    return { ok: false, reason: "Requested carat is more than this packet still holds." };
  }
  const takesAllPieces = requested.pieces === available.pieces;
  const takesAllCarat = requested.caratThousandths === available.caratThousandths;
  if (takesAllPieces !== takesAllCarat) {
    return {
      ok: false,
      reason: takesAllPieces
        ? "Taking every piece must also take every carat — otherwise carat would be left with no stones behind it."
        : "Taking every carat must also take every piece — otherwise pieces would be left with no weight behind them.",
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Balances + the grouped "same stones" view
// ---------------------------------------------------------------------------

function toScaled(value: string, scale: number): bigint {
  const negative = value.trim().startsWith("-");
  const [whole, fraction = ""] = value.trim().replace(/^[-+]/, "").split(".");
  const digits = BigInt(whole || "0") * BigInt(10 ** scale) + BigInt((fraction + "0".repeat(scale)).slice(0, scale) || "0");
  return negative ? -digits : digits;
}

function fromScaled(value: bigint, scale: number): string {
  const negative = value < BigInt(0);
  const abs = negative ? -value : value;
  const unit = BigInt(10 ** scale);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(scale, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export type PacketMovementAmounts = { type: string; pieces: number; carat: string; costValue: string };
export type PacketBalance = { pieces: number; carat: string; costValue: string };

/** Exact live balance from a packet's immutable movements (3dp carat, 2dp cost). */
export function sumPacketMovements(movements: PacketMovementAmounts[]): PacketBalance {
  let pieces = 0;
  let carat = BigInt(0);
  let cost = BigInt(0);
  for (const m of movements) {
    const sign = PACKET_MOVEMENT_EFFECT[m.type];
    if (!sign) continue;
    pieces += sign * m.pieces;
    carat += BigInt(sign) * toScaled(m.carat, 3);
    cost += BigInt(sign) * toScaled(m.costValue, 2);
  }
  return { pieces, carat: fromScaled(carat, 3), costValue: fromScaled(cost, 2) };
}

export type PacketGroupInput = PacketBalance & { id: string; packetCode: string; mergeKey: string };
export type PacketGroup = PacketBalance & { mergeKey: string; packetIds: string[]; packetCodes: string[] };

/**
 * Groups packets that share a merge key for display. Totals are exact sums;
 * nothing is averaged and no packet loses its own identity — each group
 * still lists the packets inside it. Empty packets are left out.
 */
export function groupPacketsByMergeKey(packets: PacketGroupInput[]): PacketGroup[] {
  const groups = new Map<string, { pieces: number; carat: bigint; cost: bigint; ids: string[]; codes: string[] }>();
  for (const p of packets) {
    if (p.pieces === 0 && toScaled(p.carat, 3) === BigInt(0)) continue;
    const g = groups.get(p.mergeKey) ?? { pieces: 0, carat: BigInt(0), cost: BigInt(0), ids: [], codes: [] };
    g.pieces += p.pieces;
    g.carat += toScaled(p.carat, 3);
    g.cost += toScaled(p.costValue, 2);
    g.ids.push(p.id);
    g.codes.push(p.packetCode);
    groups.set(p.mergeKey, g);
  }
  return [...groups.entries()]
    .map(([mergeKey, g]) => ({
      mergeKey,
      pieces: g.pieces,
      carat: fromScaled(g.carat, 3),
      costValue: fromScaled(g.cost, 2),
      packetIds: g.ids,
      packetCodes: g.codes,
    }))
    .sort((a, b) => a.mergeKey.localeCompare(b.mergeKey));
}

/** Pieces and carat of a job's packet issue line not yet set, returned or written off. */
export function pendingPacketQuantity(line: {
  piecesAtIssue: number;
  caratAtIssue: string;
  resolved: { pieces: number; carat: string }[];
}): { pieces: number; carat: string } {
  let pieces = line.piecesAtIssue;
  let carat = toScaled(line.caratAtIssue, 3);
  for (const r of line.resolved) {
    pieces -= r.pieces;
    carat -= toScaled(r.carat, 3);
  }
  return { pieces, carat: fromScaled(carat, 3) };
}
