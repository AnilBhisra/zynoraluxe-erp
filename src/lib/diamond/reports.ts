import "server-only";

import { prisma } from "@/lib/db/prisma";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import { round3 } from "@/lib/diamond/allocation";
import { perIssuedCaratLabour } from "@/lib/diamond/processCharge";
import { sumPacketMovements } from "@/lib/diamond/packets";
import type {
  DiamondJobStatus,
  DiamondProcessOutputKind,
  DiamondShape,
  ProcessChargeRateBasis,
  PolishedDiamondStatus,
  RoughPieceKind,
  RoughPieceStatus,
} from "@/generated/prisma/enums";

export type RoughLotStatus = "AVAILABLE" | "PARTLY_ISSUED" | "FULLY_ISSUED" | "COMPLETED" | "CANCELLED";

/** Derives a lot's rollup status purely from its pieces' real statuses —
 * never a stored column. "Partly/Fully Issued" only exist at this rollup
 * level; a single piece is always one of the 4 states in
 * RoughPieceStatus (see schema.prisma's file-header note on why a piece
 * is issued as a whole, never split). */
export function deriveRoughLotStatus(pieceStatuses: RoughPieceStatus[]): RoughLotStatus {
  if (pieceStatuses.length === 0) return "AVAILABLE";
  if (pieceStatuses.every((s) => s === "CANCELLED")) return "CANCELLED";
  const active = pieceStatuses.filter((s) => s !== "CANCELLED");
  if (active.length === 0) return "CANCELLED";
  if (active.every((s) => s === "COMPLETED")) return "COMPLETED";
  if (active.every((s) => s === "AVAILABLE")) return "AVAILABLE";
  if (active.every((s) => s !== "AVAILABLE")) return "FULLY_ISSUED";
  return "PARTLY_ISSUED";
}

/** Where the material of a WITH_KARIGAR row actually stands right now — the
 * job's own pending carat, never the row's issued carat, which does not
 * shrink when a partial receipt comes back. */
export type RoughPieceWithParty = {
  jobCode: string;
  partyName: string;
  issuedCarat: Decimal;
  pendingCarat: Decimal;
};

export type RoughPieceRow = {
  id: string;
  roughCode: string;
  lotCode: string | null;
  supplierName: string | null;
  /** STONE = one individual stone; PARCEL = many stones in one row. */
  kind: RoughPieceKind;
  /** Stones in a parcel where recorded (current balance); null otherwise. */
  pieceCount: number | null;
  /** Immutable snapshot of a parcel as first recorded (null for a STONE). */
  originalCarat: Decimal | null;
  originalPieceCount: number | null;
  originalCost: Decimal | null;
  /** The parcel this row was split from, when it is an issued portion. */
  parentRoughCode: string | null;
  withParty: RoughPieceWithParty | null;
  /** For a PARCEL, the CURRENT remaining carat; for a STONE, its carat. */
  carat: Decimal;
  allocatedCost: Decimal;
  costLocked: boolean;
  status: RoughPieceStatus;
  colorEstimate: string | null;
  clarityNote: string | null;
  photoAssetId: string | null;
  returnedFromJobCode: string | null;
  /** Where processed / returned rough came from (its own job, or — for a
   * portion split off it — its parent's). Null for purchased rough. */
  origin: RoughOrigin | null;
  /** Set when an Owner converted this row from a single stone into a parcel. */
  convertedToParcel: { at: Date; byName: string | null; reason: string } | null;
  createdAt: Date;
};

/**
 * The immutable lineage of processed / returned rough: the job that returned
 * it (process, issued pcs / ct) and the receipt (that return's pcs / ct).
 * Issued pcs / ct are the job's own snapshot; the returned figures are the
 * returned row's immutable original* snapshot, so later splits never change it.
 */
export type RoughOrigin = {
  jobCode: string;
  processName: string | null;
  receiptCode: string | null;
  issuedPieces: number;
  issuedCarat: Decimal;
  returnedPieces: number;
  returnedCarat: Decimal;
  /** The returned row this one was split from, when it is an issued portion. */
  viaParcel: string | null;
};

type OriginJob = { jobCode: string; processNameSnapshot: string | null; issuedPiecesCount: number; issuedRoughCarat: DecimalInput };
type OriginRow = {
  roughCode: string;
  kind: RoughPieceKind;
  carat: DecimalInput;
  originalCarat: DecimalInput | null;
  originalPieceCount: number | null;
  returnedFromJob: OriginJob | null;
  returnedFromReceipt: { receiptCode: string } | null;
};
const ORIGIN_INCLUDE = {
  returnedFromJob: { select: { jobCode: true, processNameSnapshot: true, issuedPiecesCount: true, issuedRoughCarat: true } },
  returnedFromReceipt: { select: { receiptCode: true } },
} as const;

function originOf(row: OriginRow & { parentPiece?: OriginRow | null }): RoughOrigin | null {
  const source = row.returnedFromJob ? row : row.parentPiece?.returnedFromJob ? row.parentPiece : null;
  if (!source || !source.returnedFromJob) return null;
  const j = source.returnedFromJob;
  return {
    jobCode: j.jobCode,
    processName: j.processNameSnapshot,
    receiptCode: source.returnedFromReceipt?.receiptCode ?? null,
    issuedPieces: j.issuedPiecesCount,
    issuedCarat: round3(j.issuedRoughCarat),
    returnedPieces: source.kind === "PARCEL" ? (source.originalPieceCount ?? 1) : 1,
    returnedCarat: round3(source.originalCarat ?? source.carat),
    viaParcel: source === row ? null : source.roughCode,
  };
}

type ConversionFields = {
  convertedToParcelAt: Date | null;
  convertedToParcelReason: string | null;
  convertedToParcelBy: { name: string } | null;
};

function conversionOf(p: ConversionFields): RoughPieceRow["convertedToParcel"] {
  return p.convertedToParcelAt
    ? { at: p.convertedToParcelAt, byName: p.convertedToParcelBy?.name ?? null, reason: p.convertedToParcelReason ?? "" }
    : null;
}

/** For each given rough row still with a Manufacturer/Karigar, the open job
 * holding it and how much of that job is genuinely still pending. */
async function withPartyByPieceId(pieceIds: string[]): Promise<Map<string, RoughPieceWithParty>> {
  const result = new Map<string, RoughPieceWithParty>();
  if (pieceIds.length === 0) return result;
  const links = await prisma.diamondJobPiece.findMany({
    where: { roughPieceId: { in: pieceIds }, job: { status: { in: ["ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"] } } },
    include: { job: { include: { karigar: true } } },
  });
  for (const link of links) {
    result.set(link.roughPieceId, {
      jobCode: link.job.jobCode,
      partyName: link.job.karigar.name,
      issuedCarat: round3(link.job.issuedRoughCarat),
      pendingCarat: unresolvedCarat(link.job),
    });
  }
  return result;
}

export async function listRoughPieces(filters?: {
  status?: RoughPieceStatus;
  search?: string;
  supplierId?: string;
}): Promise<RoughPieceRow[]> {
  const pieces = await prisma.roughPiece.findMany({
    where: {
      status: filters?.status,
      lot: filters?.supplierId ? { supplierId: filters.supplierId } : undefined,
      OR: filters?.search
        ? [
            { roughCode: { contains: filters.search, mode: "insensitive" } },
            { lot: { lotCode: { contains: filters.search, mode: "insensitive" } } },
          ]
        : undefined,
    },
    include: {
      lot: { include: { supplier: true } },
      ...ORIGIN_INCLUDE,
      parentPiece: { select: { roughCode: true, kind: true, carat: true, originalCarat: true, originalPieceCount: true, ...ORIGIN_INCLUDE } },
      convertedToParcelBy: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const withParty = await withPartyByPieceId(pieces.filter((p) => p.status === "WITH_KARIGAR").map((p) => p.id));
  return pieces.map((p) => toRoughPieceRow(p, withParty));
}

type RoughRowSource = OriginRow & {
  id: string;
  lot: { lotCode: string; supplier: { name: string } } | null;
  pieceCount: number | null;
  originalCost: DecimalInput | null;
  parentPiece: OriginRow | null;
  allocatedCost: DecimalInput;
  costLocked: boolean;
  status: RoughPieceStatus;
  colorEstimate: string | null;
  clarityNote: string | null;
  photoAssetId: string | null;
  createdAt: Date;
} & ConversionFields;

function toRoughPieceRow(p: RoughRowSource, withParty: Map<string, RoughPieceWithParty>): RoughPieceRow {
  return {
    id: p.id,
    roughCode: p.roughCode,
    lotCode: p.lot?.lotCode ?? null,
    supplierName: p.lot?.supplier.name ?? null,
    kind: p.kind,
    pieceCount: p.pieceCount ?? null,
    originalCarat: p.originalCarat ? round3(p.originalCarat) : null,
    originalPieceCount: p.originalPieceCount ?? null,
    originalCost: p.originalCost ? round2(p.originalCost) : null,
    parentRoughCode: p.parentPiece?.roughCode ?? null,
    withParty: withParty.get(p.id) ?? null,
    carat: round3(p.carat),
    allocatedCost: round2(p.allocatedCost),
    costLocked: p.costLocked,
    status: p.status,
    colorEstimate: p.colorEstimate,
    clarityNote: p.clarityNote,
    photoAssetId: p.photoAssetId,
    returnedFromJobCode: p.returnedFromJob?.jobCode ?? null,
    origin: originOf(p),
    convertedToParcel: conversionOf(p),
    createdAt: p.createdAt,
  };
}

/**
 * Rough that did not come from a purchase lot: processed rough returned by a
 * Manufacturer (4P / Laser, HPHT / Grow, Rough Polish — as stones or as a
 * counted batch parcel), unused rough handed back on a polished receipt, and
 * any portion later split off those. The purchase-lot list cannot show these.
 */
export async function listReturnedRough(filters?: { search?: string }): Promise<RoughPieceRow[]> {
  const rows = await prisma.roughPiece.findMany({
    where: {
      lotId: null,
      OR: filters?.search
        ? [
            { roughCode: { contains: filters.search, mode: "insensitive" } },
            { returnedFromJob: { jobCode: { contains: filters.search, mode: "insensitive" } } },
            { parentPiece: { roughCode: { contains: filters.search, mode: "insensitive" } } },
          ]
        : undefined,
    },
    include: {
      lot: { include: { supplier: true } },
      ...ORIGIN_INCLUDE,
      parentPiece: { select: { roughCode: true, kind: true, carat: true, originalCarat: true, originalPieceCount: true, ...ORIGIN_INCLUDE } },
      convertedToParcelBy: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const withParty = await withPartyByPieceId(rows.filter((p) => p.status === "WITH_KARIGAR").map((p) => p.id));
  return rows.map((p) => toRoughPieceRow(p, withParty));
}

/** Stones in a rough row: a counted parcel's count, else one (an uncounted parcel is reported separately). */
const stonesIn = (p: { kind: RoughPieceKind; pieceCount: number | null }) => (p.kind === "PARCEL" ? (p.pieceCount ?? 1) : 1);

export type RoughLotRow = {
  id: string;
  lotCode: string;
  purchaseDate: Date;
  supplierName: string;
  piecesCount: number;
  totalRoughCarat: Decimal;
  totalPurchaseCost: Decimal;
  status: RoughLotStatus;
  availableCarat: Decimal;
  photoAssetId: string | null;
  pieces: RoughPieceRow[];
};

export async function listRoughLots(filters?: {
  search?: string;
  supplierId?: string;
  status?: RoughLotStatus;
}): Promise<RoughLotRow[]> {
  const lots = await prisma.roughLot.findMany({
    where: {
      supplierId: filters?.supplierId,
      OR: filters?.search
        ? [
            { lotCode: { contains: filters.search, mode: "insensitive" } },
            { supplier: { name: { contains: filters.search, mode: "insensitive" } } },
          ]
        : undefined,
    },
    include: { supplier: true, pieces: { include: { convertedToParcelBy: { select: { name: true } } } } },
    orderBy: { purchaseDate: "desc" },
    take: 200,
  });
  const withParty = await withPartyByPieceId(
    lots.flatMap((l) => l.pieces.filter((p) => p.status === "WITH_KARIGAR").map((p) => p.id))
  );

  const rows = lots.map((lot) => {
    const status = deriveRoughLotStatus(lot.pieces.map((p) => p.status));
    const availableCarat = round3(
      lot.pieces
        .filter((p) => p.status === "AVAILABLE")
        .reduce((sum, p) => sum.plus(new Decimal(p.carat)), ZERO)
    );
    return {
      id: lot.id,
      lotCode: lot.lotCode,
      purchaseDate: lot.purchaseDate,
      supplierName: lot.supplier.name,
      // The purchase record's own count — split-off portions are extra rows
      // in the list below, not extra pieces bought.
      piecesCount: lot.piecesCount,
      totalRoughCarat: round3(lot.totalRoughCarat),
      totalPurchaseCost: round2(lot.totalPurchaseCost),
      status,
      availableCarat,
      photoAssetId: lot.photoAssetId,
      pieces: lot.pieces
        .sort((a, b) => a.roughCode.localeCompare(b.roughCode))
        .map((p) => ({
          id: p.id,
          roughCode: p.roughCode,
          lotCode: lot.lotCode,
          supplierName: lot.supplier.name,
          kind: p.kind,
          pieceCount: p.pieceCount ?? null,
          originalCarat: p.originalCarat ? round3(p.originalCarat) : null,
          originalPieceCount: p.originalPieceCount ?? null,
          originalCost: p.originalCost ? round2(p.originalCost) : null,
          parentRoughCode: p.parentPieceId ? (lot.pieces.find((q) => q.id === p.parentPieceId)?.roughCode ?? null) : null,
          withParty: withParty.get(p.id) ?? null,
          carat: round3(p.carat),
          allocatedCost: round2(p.allocatedCost),
          costLocked: p.costLocked,
          status: p.status,
          colorEstimate: p.colorEstimate,
          clarityNote: p.clarityNote,
          photoAssetId: p.photoAssetId,
          returnedFromJobCode: null,
          origin: null,
          convertedToParcel: conversionOf(p),
          createdAt: p.createdAt,
        })),
    };
  });

  return filters?.status ? rows.filter((r) => r.status === filters.status) : rows;
}

export async function getRoughStockSummary(): Promise<{
  totalCarat: Decimal;
  totalCost: Decimal;
  /** Rows (stones and parcels). */
  pieceCount: number;
  /** Stones: a counted parcel's count, one per stone, one per uncounted parcel. */
  stoneCount: number;
  /** Parcels whose stone count was never recorded (each counted once above). */
  uncountedParcels: number;
}> {
  const available = await prisma.roughPiece.findMany({
    where: { status: "AVAILABLE" },
    select: { carat: true, allocatedCost: true, kind: true, pieceCount: true },
  });
  const totalCarat = available.reduce((sum, p) => sum.plus(new Decimal(p.carat)), ZERO);
  const totalCost = available.reduce((sum, p) => sum.plus(new Decimal(p.allocatedCost)), ZERO);
  return {
    totalCarat: round3(totalCarat),
    totalCost: round2(totalCost),
    pieceCount: available.length,
    stoneCount: available.reduce((n, p) => n + stonesIn(p), 0),
    uncountedParcels: available.filter((p) => p.kind === "PARCEL" && p.pieceCount == null).length,
  };
}

/** Rough currently out with Manufacturers / Karigars: the carat still
 * genuinely pending on open jobs and the WIP cost that carries. */
export async function getRoughWithPartySummary(): Promise<{
  pendingCarat: Decimal;
  wipCost: Decimal;
  openJobs: number;
}> {
  const open = await prisma.diamondJob.findMany({
    where: { status: { in: ["ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"] } },
    select: { status: true, issuedRoughCarat: true, receivedPolishedCarat: true, returnedRoughCarat: true, remainingWipCost: true },
  });
  return {
    pendingCarat: round3(open.reduce((sum, j) => sum.plus(unresolvedCarat(j)), ZERO)),
    wipCost: round2(open.reduce((sum, j) => sum.plus(new Decimal(j.remainingWipCost)), ZERO)),
    openJobs: open.length,
  };
}

export type PolishedDiamondRow = {
  id: string;
  polishedCode: string;
  jobCode: string;
  lotCode: string | null;
  shape: DiamondShape;
  carat: Decimal;
  lengthMm: Decimal | null;
  widthMm: Decimal | null;
  heightMm: Decimal | null;
  certificateStatus: string;
  allocatedCost: Decimal;
  costPerCarat: Decimal;
  status: PolishedDiamondStatus;
  photoAssetId: string | null;
  certFileAssetId: string | null;
  /** Set once an Owner converted this single-stone record into a parcel packet. */
  convertedToPacketCode: string | null;
  convertedReason: string | null;
  createdAt: Date;
};

export async function listPolishedDiamonds(filters?: {
  status?: PolishedDiamondStatus;
  shape?: DiamondShape;
  search?: string;
}): Promise<PolishedDiamondRow[]> {
  const outputs = await prisma.polishedDiamond.findMany({
    where: {
      status: filters?.status,
      shape: filters?.shape,
      OR: filters?.search
        ? [
            { polishedCode: { contains: filters.search, mode: "insensitive" } },
            { job: { jobCode: { contains: filters.search, mode: "insensitive" } } },
          ]
        : undefined,
    },
    include: {
      job: { include: { pieces: { include: { roughPiece: { include: { lot: true } } } } } },
      convertedToPacket: { select: { packetCode: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return outputs.map((o) => ({
    id: o.id,
    polishedCode: o.polishedCode,
    jobCode: o.job.jobCode,
    lotCode: o.job.pieces[0]?.roughPiece?.lot?.lotCode ?? null,
    shape: o.shape,
    carat: round3(o.carat),
    lengthMm: o.lengthMm ? round3(o.lengthMm) : null,
    widthMm: o.widthMm ? round3(o.widthMm) : null,
    heightMm: o.heightMm ? round3(o.heightMm) : null,
    certificateStatus: o.certificateStatus,
    allocatedCost: round2(o.allocatedCost),
    costPerCarat: round2(o.costPerCarat),
    status: o.status,
    photoAssetId: o.photoAssetId,
    certFileAssetId: o.certFileAssetId,
    convertedToPacketCode: o.convertedToPacket?.packetCode ?? null,
    convertedReason: o.convertedReason,
    createdAt: o.createdAt,
  }));
}

/**
 * Available polished stock — individual stones AND packets together.
 *
 * A packet (purchased directly as a parcel, or manufactured/converted into
 * one — see PolishedPacket) is real available stock exactly like a single
 * ZL-POL stone; a job whose entire purchase or output was recorded as a
 * packet would otherwise show zero here even while its carat, pieces and
 * cost sit in Polished Diamond Inventory untouched. Only CANCELLED packets
 * are excluded; an EMPTY one already nets to zero and costs nothing to
 * include.
 */
export async function getPolishedStockSummary(): Promise<{
  totalCarat: Decimal;
  totalCost: Decimal;
  pieceCount: number;
}> {
  const [available, packets] = await Promise.all([
    prisma.polishedDiamond.findMany({
      where: { status: "AVAILABLE" },
      select: { carat: true, allocatedCost: true },
    }),
    prisma.polishedPacket.findMany({
      where: { status: { in: ["ACTIVE", "EMPTY"] } },
      select: { movements: { select: { type: true, pieces: true, carat: true, costValue: true } } },
    }),
  ]);
  let totalCarat = available.reduce((sum, p) => sum.plus(new Decimal(p.carat)), ZERO);
  let totalCost = available.reduce((sum, p) => sum.plus(new Decimal(p.allocatedCost)), ZERO);
  let pieceCount = available.length;
  for (const packet of packets) {
    const balance = sumPacketMovements(
      packet.movements.map((m) => ({ type: m.type, pieces: m.pieces, carat: m.carat.toFixed(3), costValue: m.costValue.toFixed(2) }))
    );
    totalCarat = totalCarat.plus(balance.carat);
    totalCost = totalCost.plus(balance.costValue);
    pieceCount += balance.pieces;
  }
  return { totalCarat: round3(totalCarat), totalCost: round2(totalCost), pieceCount };
}

export type DiamondJobRow = {
  id: string;
  jobCode: string;
  karigarId: string;
  karigarName: string;
  requiredShape: DiamondShape;
  customShapeName: string | null;
  issueDate: Date;
  dueDate: Date | null;
  issuedPiecesCount: number;
  issuedRoughCarat: Decimal;
  receivedPolishedCarat: Decimal;
  returnedRoughCarat: Decimal;
  /** Rough stones returned so far (processed or unused), from the immutable
   * stock ledger — may exceed issuedPiecesCount (4P / Laser divides stones). */
  returnedRoughPieces: number;
  pendingCarat: Decimal;
  status: DiamondJobStatus;
  issuedCostValue: Decimal;
  remainingWipCost: Decimal;
  totalLabourCharge: Decimal;
  /** Phase 7 — null for cutting-polishing jobs created before processes existed. */
  processNameSnapshot: string | null;
  processOutputKindSnapshot: DiamondProcessOutputKind | null;
  chargeRateBasis: ProcessChargeRateBasis | null;
  chargeRate: Decimal | null;
};

/** Carat genuinely still with the Manufacturer for an OPEN job. A completed
 * job has resolved every carat (what is left over is recognised loss, not
 * pending) and a cancelled job handed everything back, so both are zero. */
function unresolvedCarat(j: {
  status: DiamondJobStatus;
  issuedRoughCarat: DecimalInput;
  receivedPolishedCarat: DecimalInput;
  returnedRoughCarat: DecimalInput;
}): Decimal {
  if (j.status === "CANCELLED" || j.status === "COMPLETED") return ZERO;
  return round3(new Decimal(j.issuedRoughCarat).minus(j.receivedPolishedCarat).minus(j.returnedRoughCarat));
}

function toJobRow(j: {
  id: string;
  jobCode: string;
  karigarId: string;
  karigar: { name: string };
  requiredShape: DiamondShape;
  customShapeName: string | null;
  issueDate: Date;
  dueDate: Date | null;
  issuedPiecesCount: number;
  issuedRoughCarat: Decimal;
  receivedPolishedCarat: Decimal;
  returnedRoughCarat: Decimal;
  status: DiamondJobStatus;
  issuedCostValue: Decimal;
  remainingWipCost: Decimal;
  totalLabourCharge: Decimal;
  processNameSnapshot: string | null;
  processOutputKindSnapshot: DiamondProcessOutputKind | null;
  chargeRateBasis: ProcessChargeRateBasis | null;
  chargeRate: Decimal | null;
}, returnedRoughPieces: number): DiamondJobRow {
  const pendingCarat = unresolvedCarat(j);
  return {
    id: j.id,
    jobCode: j.jobCode,
    karigarId: j.karigarId,
    karigarName: j.karigar.name,
    requiredShape: j.requiredShape,
    customShapeName: j.customShapeName,
    issueDate: j.issueDate,
    dueDate: j.dueDate,
    issuedPiecesCount: j.issuedPiecesCount,
    issuedRoughCarat: round3(j.issuedRoughCarat),
    receivedPolishedCarat: round3(j.receivedPolishedCarat),
    returnedRoughCarat: round3(j.returnedRoughCarat),
    returnedRoughPieces,
    pendingCarat,
    status: j.status,
    // Issue history is preserved; only what is CURRENTLY still in WIP is
    // zeroed for a cancelled job (its WIP voucher was reversed).
    issuedCostValue: round2(j.issuedCostValue),
    remainingWipCost: j.status === "CANCELLED" ? ZERO : round2(j.remainingWipCost),
    totalLabourCharge: round2(j.totalLabourCharge),
    processNameSnapshot: j.processNameSnapshot,
    processOutputKindSnapshot: j.processOutputKindSnapshot,
    chargeRateBasis: j.chargeRateBasis,
    chargeRate: j.chargeRate,
  };
}

export async function listDiamondJobs(filters?: {
  status?: DiamondJobStatus[];
  karigarId?: string;
  search?: string;
}): Promise<DiamondJobRow[]> {
  const jobs = await prisma.diamondJob.findMany({
    where: {
      status: filters?.status ? { in: filters.status } : undefined,
      karigarId: filters?.karigarId,
      OR: filters?.search
        ? [
            { jobCode: { contains: filters.search, mode: "insensitive" } },
            { karigar: { name: { contains: filters.search, mode: "insensitive" } } },
            { processNameSnapshot: { contains: filters.search, mode: "insensitive" } },
          ]
        : undefined,
    },
    include: { karigar: true },
    orderBy: { issueDate: "desc" },
    take: 300,
  });

  const returned = await returnedPiecesByJob(jobs.map((j) => j.id));
  return jobs.map((j) => toJobRow(j, returned.get(j.id) ?? 0));
}

/**
 * Signed effect of each movement type on a job's RETURNED stone count: what came
 * back, plus Owner count corrections, minus returns undone by a receipt reversal.
 * The one definition every report uses, so job, receipt and stock always agree.
 */
export const RETURNED_PIECES_SIGN: Partial<Record<string, 1 | -1>> = {
  ROUGH_RETURN_IN: 1,
  ROUGH_COUNT_CORRECTION_IN: 1,
  ROUGH_COUNT_CORRECTION_OUT: -1,
  ROUGH_RETURN_REVERSAL_OUT: -1,
};
export const netReturnedPieces = (moves: { type: string; pieces: number }[]) => moves.reduce((n, m) => n + (RETURNED_PIECES_SIGN[m.type] ?? 0) * m.pieces, 0);

/** Rough stones each job has returned, net of corrections and reversals (immutable stock ledger). */
async function returnedPiecesByJob(jobIds: string[]): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();
  const grouped = await prisma.stockMovement.groupBy({
    by: ["diamondJobId", "type"],
    where: { diamondJobId: { in: jobIds }, type: { in: ["ROUGH_RETURN_IN", "ROUGH_COUNT_CORRECTION_IN", "ROUGH_COUNT_CORRECTION_OUT", "ROUGH_RETURN_REVERSAL_OUT"] } },
    _sum: { pieces: true },
  });
  const out = new Map<string, number>();
  for (const g of grouped) out.set(g.diamondJobId!, (out.get(g.diamondJobId!) ?? 0) + (RETURNED_PIECES_SIGN[g.type] ?? 0) * (g._sum.pieces ?? 0));
  return out;
}

export type KarigarMaterialBalance = {
  karigarId: string;
  karigarName: string;
  openJobsCount: number;
  /** Stones on open jobs nothing has come back from yet (each job's issued stone count). */
  pendingPiecesCount: number;
  /** Stones issued on every open job, and stones already returned on them. */
  issuedPiecesCount: number;
  returnedPiecesCount: number;
  pendingCarat: Decimal;
};

/** Material balance ONLY — never money. Money (labour payable) always
 * comes from the Phase 2 accounting ledger (Accounts Payable by partyId),
 * kept deliberately separate — see getKarigarMoneyBalance below. */
export async function getKarigarMaterialBalances(): Promise<KarigarMaterialBalance[]> {
  const karigars = await prisma.party.findMany({
    // A Manufacturer is issued rough exactly like a Karigar (the issue form
    // offers both), so both must appear wherever material-with-party is shown.
    where: { type: { in: ["KARIGAR", "MANUFACTURER"] }, isActive: true },
    orderBy: { name: "asc" },
  });

  const openJobs = await prisma.diamondJob.findMany({
    where: { status: { in: ["ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"] } },
  });
  const returned = await returnedPiecesByJob(openJobs.map((j) => j.id));

  return karigars.map((k) => {
    const jobsForKarigar = openJobs.filter((j) => j.karigarId === k.id);
    const pendingCarat = round3(
      jobsForKarigar.reduce((sum, j) => sum.plus(unresolvedCarat(j)), ZERO)
    );
    // Stones, not rows: a parcel issued as one row carries its stone count.
    // Once anything has come back the pending STONE count is unknowable (4P /
    // Laser divides stones), so only untouched jobs count here; carat is exact.
    const pendingPiecesCount = jobsForKarigar.reduce(
      (sum, j) => sum + (j.status === "ISSUED" || j.status === "IN_PROGRESS" ? j.issuedPiecesCount : 0),
      0
    );
    return {
      karigarId: k.id,
      karigarName: k.name,
      openJobsCount: jobsForKarigar.length,
      pendingPiecesCount,
      issuedPiecesCount: jobsForKarigar.reduce((sum, j) => sum + j.issuedPiecesCount, 0),
      returnedPiecesCount: jobsForKarigar.reduce((sum, j) => sum + (returned.get(j.id) ?? 0), 0),
      pendingCarat,
    };
  });
}

export type JobTimelineEntry = {
  id: string;
  type: string;
  pieces: number;
  carat: Decimal;
  costValue: Decimal;
  sourceDocument: string;
  createdAt: Date;
};

export type DiamondJobDetail = DiamondJobRow & {
  notes: string | null;
  customShapeReferencePhotoAssetId: string | null;
  customShapeMeasurements: string | null;
  customShapeInstruction: string | null;
  targetPolishedCarat: Decimal | null;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  isCompleted: boolean;
  finalWeightLossCarat: Decimal | null;
  finalYieldPercent: Decimal | null;
  /** Each issued row: its carat and stones AT ISSUE (immutable), and — for
   * processed rough issued onward — where it came from. */
  pieces: { roughCode: string; carat: Decimal; pieces: number; kind: RoughPieceKind; lotCode: string | null; origin: RoughOrigin | null }[];
  receipts: {
    id: string;
    receiptCode: string;
    receiveDate: Date;
    polishedCount: number;
    totalPolishedCarat: Decimal;
    returnedRoughCarat: Decimal;
    /** Rough stones this receipt returned (a batch counts its stones), after any Owner count correction. */
    returnedRoughPieces: number;
    /** Set when the receipt was reversed through Correct entry: that correction's code. */
    reversedBy: string | null;
    /** The rough rows this receipt created, as created (original* snapshot). */
    returnedRows: { roughCode: string; kind: RoughPieceKind; pieces: number; carat: Decimal }[];
    weightLossCarat: Decimal;
    yieldPercent: Decimal;
    labourCharge: Decimal;
    /** The live (posted, not reversed) Owner labour correction on this receipt, if any. */
    labourCorrection: { correctionId: string; code: string; added: Decimal; corrected: Decimal } | null;
    /** This receipt's labour re-priced per ISSUED carat at the job's per-carat rate; null without one. */
    perIssuedCaratLabour: string | null;
  }[];
  timeline: JobTimelineEntry[];
};

export async function getDiamondJobDetail(jobId: string): Promise<DiamondJobDetail | null> {
  const job = await prisma.diamondJob.findUnique({
    where: { id: jobId },
    include: {
      karigar: true,
      pieces: {
        include: {
          roughPiece: {
            include: {
              lot: true,
              ...ORIGIN_INCLUDE,
              parentPiece: { select: { roughCode: true, kind: true, carat: true, originalCarat: true, originalPieceCount: true, ...ORIGIN_INCLUDE } },
            },
          },
        },
      },
      receipts: {
        orderBy: { receiveDate: "asc" },
        include: {
          labourCorrections: {
            where: { correction: { state: "POSTED", reversedByCorrectionId: null } },
            include: { correction: { select: { id: true, correctionCode: true } } },
          },
          returnedPieces: { select: { roughCode: true, kind: true, carat: true, originalCarat: true, originalPieceCount: true }, orderBy: { roughCode: "asc" } },
        },
      },
      stockMovements: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!job) return null;

  const row = toJobRow(job, netReturnedPieces(job.stockMovements));
  const reversals = await prisma.correction.findMany({
    where: { entityType: "DIAMOND_RECEIPT", entityId: { in: job.receipts.map((r) => r.id) }, mode: "REVERSE_REPOST", state: "POSTED", reversedByCorrectionId: null },
    select: { entityId: true, correctionCode: true },
  });
  const reversedBy = new Map(reversals.map((c) => [c.entityId, c.correctionCode]));
  // Stones each row went out with, from the immutable issue movement.
  const issuedStones = new Map(job.stockMovements.filter((m) => m.type === "ROUGH_ISSUE_OUT" && m.roughPieceId).map((m) => [m.roughPieceId!, m.pieces]));

  return {
    ...row,
    notes: job.notes,
    customShapeReferencePhotoAssetId: job.customShapeReferencePhotoAssetId,
    customShapeMeasurements: job.customShapeMeasurements,
    customShapeInstruction: job.customShapeInstruction,
    targetPolishedCarat: job.targetPolishedCarat ? round3(job.targetPolishedCarat) : null,
    cancelledAt: job.cancelledAt,
    cancellationReason: job.cancellationReason,
    isCompleted: job.status === "COMPLETED",
    // Only meaningful once the job is completed — the same
    // issued-received-returned subtraction that shows "still pending"
    // while open becomes the final recognized loss once every issued
    // carat has been accounted for.
    finalWeightLossCarat:
      job.status === "COMPLETED"
        ? round3(new Decimal(job.issuedRoughCarat).minus(job.receivedPolishedCarat).minus(job.returnedRoughCarat))
        : null,
    finalYieldPercent:
      job.status === "COMPLETED" && new Decimal(job.issuedRoughCarat).greaterThan(0)
        ? round3(new Decimal(job.receivedPolishedCarat).dividedBy(job.issuedRoughCarat).times(100))
        : null,
    pieces: job.pieces.map((link) => ({
      roughCode: link.roughPiece.roughCode,
      carat: round3(link.caratAtIssue),
      pieces: issuedStones.get(link.roughPieceId) ?? 1,
      kind: link.roughPiece.kind,
      lotCode: link.roughPiece.lot?.lotCode ?? null,
      origin: originOf(link.roughPiece),
    })),
    receipts: job.receipts.map((r) => ({
      id: r.id,
      receiptCode: r.receiptCode,
      receiveDate: r.receiveDate,
      polishedCount: r.polishedCount,
      totalPolishedCarat: round3(r.totalPolishedCarat),
      returnedRoughCarat: round3(r.returnedRoughCarat),
      // The rows this receipt created, at their current (Owner-corrected) count.
      returnedRoughPieces: r.returnedPieces.reduce((n, p) => n + (p.kind === "PARCEL" ? (p.originalPieceCount ?? 1) : 1), 0),
      reversedBy: reversedBy.get(r.id) ?? null,
      returnedRows: r.returnedPieces.map((p) => ({
        roughCode: p.roughCode,
        kind: p.kind,
        pieces: p.kind === "PARCEL" ? (p.originalPieceCount ?? 1) : 1,
        carat: round3(p.originalCarat ?? p.carat),
      })),
      weightLossCarat: round3(r.weightLossCarat),
      yieldPercent: round3(r.yieldPercent),
      labourCharge: round2(r.labourCharge),
      labourCorrection: r.labourCorrections[0]
        ? {
            correctionId: r.labourCorrections[0].correction.id,
            code: r.labourCorrections[0].correction.correctionCode,
            added: round2(r.labourCorrections[0].addedLabour),
            corrected: round2(r.labourCorrections[0].correctedLabour),
          }
        : null,
      perIssuedCaratLabour:
        job.processOutputKindSnapshot === "ROUGH"
          ? null
          : perIssuedCaratLabour({
              basis: job.chargeRateBasis,
              rate: job.chargeRate ? new Decimal(job.chargeRate).toFixed(4) : null,
              polishedCarat: round3(r.totalPolishedCarat).toFixed(3),
              weightLossCarat: round3(r.weightLossCarat).toFixed(3),
            }),
    })),
    timeline: job.stockMovements.map((m) => ({
      id: m.id,
      type: m.type,
      pieces: m.pieces,
      carat: round3(m.carat),
      costValue: round2(m.costValue),
      sourceDocument: m.sourceDocument,
      createdAt: m.createdAt,
    })),
  };
}

export async function getDashboardDiamondSummary(): Promise<{
  roughStockCarat: Decimal;
  polishedStockCarat: Decimal;
  materialWithKarigarCarat: Decimal;
}> {
  const [rough, polished, karigarBalances] = await Promise.all([
    getRoughStockSummary(),
    getPolishedStockSummary(),
    getKarigarMaterialBalances(),
  ]);
  const materialWithKarigarCarat = round3(
    karigarBalances.reduce((sum, k) => sum.plus(k.pendingCarat), ZERO)
  );
  return {
    roughStockCarat: rough.totalCarat,
    polishedStockCarat: polished.totalCarat,
    materialWithKarigarCarat,
  };
}
