/**
 * Lineage of processed / returned rough, as every screen shows it — weights and
 * counts only (never cost), so it is safe in a Staff payload.
 */
export type SerializedRoughOrigin = {
  jobCode: string;
  processName: string | null;
  receiptCode: string | null;
  issuedPieces: number;
  issuedCarat: string;
  returnedPieces: number;
  returnedCarat: string;
  /** The returned parcel this row was split from, when it is an issued portion. */
  viaParcel: string | null;
};

export const pcs = (n: number) => `${n} pc${n === 1 ? "" : "s"}`;
export const pcsCt = (pieces: number, carat: string) => `${pcs(pieces)} / ${carat} ct`;

/** "4P / Laser · job DJ-0001: issued 10 pcs / 45.130 ct → returned 26 pcs / 43.500 ct (receipt PR-0003)". */
export function originText(o: SerializedRoughOrigin): string {
  const process = o.processName ?? "Manufacturer";
  const receipt = o.receiptCode ? ` (receipt ${o.receiptCode})` : "";
  const via = o.viaParcel ? `portion of ${o.viaParcel} · ` : "";
  return `${via}${process} · job ${o.jobCode}: issued ${pcsCt(o.issuedPieces, o.issuedCarat)} → returned ${pcsCt(o.returnedPieces, o.returnedCarat)}${receipt}`;
}

/** Server-side Decimal → wire format. */
export function serializeOrigin(o: {
  jobCode: string;
  processName: string | null;
  receiptCode: string | null;
  issuedPieces: number;
  issuedCarat: { toFixed(dp: number): string };
  returnedPieces: number;
  returnedCarat: { toFixed(dp: number): string };
  viaParcel: string | null;
} | null): SerializedRoughOrigin | null {
  if (!o) return null;
  return { ...o, issuedCarat: o.issuedCarat.toFixed(3), returnedCarat: o.returnedCarat.toFixed(3) };
}
