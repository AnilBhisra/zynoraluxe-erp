import "server-only";

import { prisma } from "@/lib/db/prisma";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { round3 } from "@/lib/diamond/allocation";
import type {
  DiamondJobStatus,
  DiamondShape,
  PolishedDiamondStatus,
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

export type RoughPieceRow = {
  id: string;
  roughCode: string;
  lotCode: string | null;
  supplierName: string | null;
  carat: Decimal;
  allocatedCost: Decimal;
  costLocked: boolean;
  status: RoughPieceStatus;
  colorEstimate: string | null;
  clarityNote: string | null;
  photoAssetId: string | null;
  returnedFromJobCode: string | null;
  createdAt: Date;
};

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
    include: { lot: { include: { supplier: true } }, returnedFromJob: true },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  return pieces.map((p) => ({
    id: p.id,
    roughCode: p.roughCode,
    lotCode: p.lot?.lotCode ?? null,
    supplierName: p.lot?.supplier.name ?? null,
    carat: round3(p.carat),
    allocatedCost: round2(p.allocatedCost),
    costLocked: p.costLocked,
    status: p.status,
    colorEstimate: p.colorEstimate,
    clarityNote: p.clarityNote,
    photoAssetId: p.photoAssetId,
    returnedFromJobCode: p.returnedFromJob?.jobCode ?? null,
    createdAt: p.createdAt,
  }));
}

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
    include: { supplier: true, pieces: true },
    orderBy: { purchaseDate: "desc" },
    take: 200,
  });

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
      piecesCount: lot.pieces.length,
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
          carat: round3(p.carat),
          allocatedCost: round2(p.allocatedCost),
          costLocked: p.costLocked,
          status: p.status,
          colorEstimate: p.colorEstimate,
          clarityNote: p.clarityNote,
          photoAssetId: p.photoAssetId,
          returnedFromJobCode: null,
          createdAt: p.createdAt,
        })),
    };
  });

  return filters?.status ? rows.filter((r) => r.status === filters.status) : rows;
}

export async function getRoughStockSummary(): Promise<{
  totalCarat: Decimal;
  totalCost: Decimal;
  pieceCount: number;
}> {
  const available = await prisma.roughPiece.findMany({
    where: { status: "AVAILABLE" },
    select: { carat: true, allocatedCost: true },
  });
  const totalCarat = available.reduce((sum, p) => sum.plus(new Decimal(p.carat)), ZERO);
  const totalCost = available.reduce((sum, p) => sum.plus(new Decimal(p.allocatedCost)), ZERO);
  return { totalCarat: round3(totalCarat), totalCost: round2(totalCost), pieceCount: available.length };
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
    include: { job: { include: { pieces: { include: { roughPiece: { include: { lot: true } } } } } } },
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
    createdAt: o.createdAt,
  }));
}

export async function getPolishedStockSummary(): Promise<{
  totalCarat: Decimal;
  totalCost: Decimal;
  pieceCount: number;
}> {
  const available = await prisma.polishedDiamond.findMany({
    where: { status: "AVAILABLE" },
    select: { carat: true, allocatedCost: true },
  });
  const totalCarat = available.reduce((sum, p) => sum.plus(new Decimal(p.carat)), ZERO);
  const totalCost = available.reduce((sum, p) => sum.plus(new Decimal(p.allocatedCost)), ZERO);
  return { totalCarat: round3(totalCarat), totalCost: round2(totalCost), pieceCount: available.length };
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
  pendingCarat: Decimal;
  status: DiamondJobStatus;
  issuedCostValue: Decimal;
  remainingWipCost: Decimal;
  totalLabourCharge: Decimal;
};

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
}): DiamondJobRow {
  const pendingCarat = round3(
    new Decimal(j.issuedRoughCarat).minus(j.receivedPolishedCarat).minus(j.returnedRoughCarat)
  );
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
    pendingCarat,
    status: j.status,
    issuedCostValue: round2(j.issuedCostValue),
    remainingWipCost: round2(j.remainingWipCost),
    totalLabourCharge: round2(j.totalLabourCharge),
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
          ]
        : undefined,
    },
    include: { karigar: true },
    orderBy: { issueDate: "desc" },
    take: 300,
  });

  return jobs.map(toJobRow);
}

export type KarigarMaterialBalance = {
  karigarId: string;
  karigarName: string;
  openJobsCount: number;
  pendingPiecesCount: number;
  pendingCarat: Decimal;
};

/** Material balance ONLY — never money. Money (labour payable) always
 * comes from the Phase 2 accounting ledger (Accounts Payable by partyId),
 * kept deliberately separate — see getKarigarMoneyBalance below. */
export async function getKarigarMaterialBalances(): Promise<KarigarMaterialBalance[]> {
  const karigars = await prisma.party.findMany({
    where: { type: "KARIGAR", isActive: true },
    orderBy: { name: "asc" },
  });

  const openJobs = await prisma.diamondJob.findMany({
    where: { status: { in: ["ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED"] } },
    include: { pieces: true },
  });

  return karigars.map((k) => {
    const jobsForKarigar = openJobs.filter((j) => j.karigarId === k.id);
    const pendingCarat = round3(
      jobsForKarigar.reduce(
        (sum, j) =>
          sum
            .plus(new Decimal(j.issuedRoughCarat))
            .minus(j.receivedPolishedCarat)
            .minus(j.returnedRoughCarat),
        ZERO
      )
    );
    const pendingPiecesCount = jobsForKarigar.reduce(
      (sum, j) => sum + (j.status === "ISSUED" || j.status === "IN_PROGRESS" ? j.pieces.length : 0),
      0
    );
    return {
      karigarId: k.id,
      karigarName: k.name,
      openJobsCount: jobsForKarigar.length,
      pendingPiecesCount,
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
  pieces: { roughCode: string; carat: Decimal; lotCode: string | null }[];
  receipts: {
    id: string;
    receiptCode: string;
    receiveDate: Date;
    polishedCount: number;
    totalPolishedCarat: Decimal;
    returnedRoughCarat: Decimal;
    weightLossCarat: Decimal;
    yieldPercent: Decimal;
    labourCharge: Decimal;
  }[];
  timeline: JobTimelineEntry[];
};

export async function getDiamondJobDetail(jobId: string): Promise<DiamondJobDetail | null> {
  const job = await prisma.diamondJob.findUnique({
    where: { id: jobId },
    include: {
      karigar: true,
      pieces: { include: { roughPiece: { include: { lot: true } } } },
      receipts: { orderBy: { receiveDate: "asc" } },
      stockMovements: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!job) return null;

  const row = toJobRow(job);

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
    finalWeightLossCarat: job.status === "COMPLETED" ? row.pendingCarat : null,
    finalYieldPercent:
      job.status === "COMPLETED" && new Decimal(job.issuedRoughCarat).greaterThan(0)
        ? round3(new Decimal(job.receivedPolishedCarat).dividedBy(job.issuedRoughCarat).times(100))
        : null,
    pieces: job.pieces.map((link) => ({
      roughCode: link.roughPiece.roughCode,
      carat: round3(link.caratAtIssue),
      lotCode: link.roughPiece.lot?.lotCode ?? null,
    })),
    receipts: job.receipts.map((r) => ({
      id: r.id,
      receiptCode: r.receiptCode,
      receiveDate: r.receiveDate,
      polishedCount: r.polishedCount,
      totalPolishedCarat: round3(r.totalPolishedCarat),
      returnedRoughCarat: round3(r.returnedRoughCarat),
      weightLossCarat: round3(r.weightLossCarat),
      yieldPercent: round3(r.yieldPercent),
      labourCharge: round2(r.labourCharge),
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
