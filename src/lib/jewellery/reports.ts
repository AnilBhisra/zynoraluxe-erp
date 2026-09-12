import "server-only";

import { prisma } from "@/lib/db/prisma";
import { Decimal, round2, ZERO } from "@/lib/accounting/money";
import { round3 } from "@/lib/diamond/allocation";
import { getAuthoritativeInventoryCost } from "@/lib/jewellery/finishedSalesPosting";
import type {
  FinishedJewelleryStockStatus,
  JewelleryJobStatus,
  JewelleryType,
  MetalType,
  QcStatus,
} from "@/generated/prisma/enums";

// ---------------------------------------------------------------------------
// Metal Purity master
// ---------------------------------------------------------------------------

export async function listMetalPurities(includeInactive = false) {
  return prisma.metalPurity.findMany({
    where: includeInactive ? undefined : { isActive: true },
    orderBy: [{ metalType: "asc" }, { finenessPercent: "asc" }],
  });
}

// ---------------------------------------------------------------------------
// Metal Stock (fungible — derived from immutable movements, never a
// manually-editable balance)
// ---------------------------------------------------------------------------

const OUT_TYPES = new Set(["ISSUE_OUT", "CONSUMED_OUT", "ADJUSTMENT_OUT"]);

export type MetalStockBucket = {
  metalType: MetalType;
  purityId: string;
  purityDisplayName: string;
  finenessPercent: Decimal;
  grossWeight: Decimal;
  fineWeight: Decimal;
  costValue: Decimal;
};

export async function getMetalStockSummary(): Promise<MetalStockBucket[]> {
  const purities = await prisma.metalPurity.findMany({ orderBy: [{ metalType: "asc" }, { finenessPercent: "asc" }] });
  const movements = await prisma.metalStockMovement.findMany({
    select: { type: true, metalType: true, purityId: true, grossWeight: true, fineWeight: true, costValue: true },
  });

  const buckets = new Map<string, { grossWeight: Decimal; fineWeight: Decimal; costValue: Decimal }>();
  for (const m of movements) {
    const key = m.purityId;
    const sign = OUT_TYPES.has(m.type) ? -1 : 1;
    const existing = buckets.get(key) ?? { grossWeight: ZERO, fineWeight: ZERO, costValue: ZERO };
    buckets.set(key, {
      grossWeight: existing.grossWeight.plus(new Decimal(m.grossWeight).times(sign)),
      fineWeight: existing.fineWeight.plus(new Decimal(m.fineWeight).times(sign)),
      costValue: existing.costValue.plus(new Decimal(m.costValue).times(sign)),
    });
  }

  return purities
    .map((p) => {
      const bucket = buckets.get(p.id) ?? { grossWeight: ZERO, fineWeight: ZERO, costValue: ZERO };
      return {
        metalType: p.metalType,
        purityId: p.id,
        purityDisplayName: p.displayName,
        finenessPercent: new Decimal(p.finenessPercent),
        grossWeight: round3(bucket.grossWeight),
        fineWeight: round3(bucket.fineWeight),
        costValue: round2(bucket.costValue),
      };
    })
    .filter((b) => !b.grossWeight.isZero() || !b.fineWeight.isZero());
}

export async function getMetalStockTotals(): Promise<{ totalGrossWeight: Decimal; totalFineWeight: Decimal; totalCost: Decimal }> {
  const buckets = await getMetalStockSummary();
  return {
    totalGrossWeight: round3(buckets.reduce((sum, b) => sum.plus(b.grossWeight), ZERO)),
    totalFineWeight: round3(buckets.reduce((sum, b) => sum.plus(b.fineWeight), ZERO)),
    totalCost: round2(buckets.reduce((sum, b) => sum.plus(b.costValue), ZERO)),
  };
}

export type MetalPurchaseRow = {
  id: string;
  purchaseCode: string;
  purchaseDate: Date;
  supplierName: string;
  metalType: MetalType;
  purityDisplayName: string;
  grossWeight: Decimal;
  fineWeight: Decimal;
  totalPurchaseCost: Decimal;
};

export async function listMetalPurchases(filters?: { search?: string }): Promise<MetalPurchaseRow[]> {
  const purchases = await prisma.metalPurchase.findMany({
    where: filters?.search
      ? {
          OR: [
            { purchaseCode: { contains: filters.search, mode: "insensitive" } },
            { supplier: { name: { contains: filters.search, mode: "insensitive" } } },
          ],
        }
      : undefined,
    include: { supplier: true, purity: true },
    orderBy: { purchaseDate: "desc" },
    take: 200,
  });
  return purchases.map((p) => ({
    id: p.id,
    purchaseCode: p.purchaseCode,
    purchaseDate: p.purchaseDate,
    supplierName: p.supplier.name,
    metalType: p.metalType,
    purityDisplayName: p.purity.displayName,
    grossWeight: round3(p.grossWeight),
    fineWeight: round3(p.fineWeight),
    totalPurchaseCost: round2(p.totalPurchaseCost),
  }));
}

// ---------------------------------------------------------------------------
// Jewellery Jobs
// ---------------------------------------------------------------------------

export type JewelleryJobRow = {
  id: string;
  jobCode: string;
  customerName: string | null;
  karigarName: string;
  jewelleryType: JewelleryType;
  designName: string;
  issueDate: Date;
  expectedDeliveryDate: Date | null;
  status: JewelleryJobStatus;
  issuedMetalFineWeight: Decimal;
  pendingFineWeight: Decimal;
  totalIssuedCost: Decimal;
};

export function pendingFineWeightOf(job: {
  issuedMetalFineWeight: Decimal | string;
  karigarAddedFineWeight: Decimal | string;
  receivedFineWeight: Decimal | string;
  returnedMetalFineWeight: Decimal | string;
  scrapFineWeight: Decimal | string;
}): Decimal {
  return round3(
    new Decimal(job.issuedMetalFineWeight)
      .plus(job.karigarAddedFineWeight)
      .minus(job.receivedFineWeight)
      .minus(job.returnedMetalFineWeight)
      .minus(job.scrapFineWeight)
  );
}

export async function listJewelleryJobs(filters?: {
  status?: JewelleryJobStatus[];
  karigarId?: string;
  search?: string;
}): Promise<JewelleryJobRow[]> {
  const jobs = await prisma.jewelleryJob.findMany({
    where: {
      status: filters?.status ? { in: filters.status } : undefined,
      karigarId: filters?.karigarId,
      OR: filters?.search
        ? [
            { jobCode: { contains: filters.search, mode: "insensitive" } },
            { designName: { contains: filters.search, mode: "insensitive" } },
            { karigar: { name: { contains: filters.search, mode: "insensitive" } } },
            { customer: { name: { contains: filters.search, mode: "insensitive" } } },
          ]
        : undefined,
    },
    include: { karigar: true, customer: true },
    orderBy: { issueDate: "desc" },
    take: 300,
  });

  return jobs.map((j) => ({
    id: j.id,
    jobCode: j.jobCode,
    customerName: j.customer?.name ?? null,
    karigarName: j.karigar.name,
    jewelleryType: j.jewelleryType,
    designName: j.designName,
    issueDate: j.issueDate,
    expectedDeliveryDate: j.expectedDeliveryDate,
    status: j.status,
    issuedMetalFineWeight: round3(j.issuedMetalFineWeight),
    pendingFineWeight: pendingFineWeightOf(j),
    totalIssuedCost: round2(new Decimal(j.issuedMetalCost).plus(j.issuedDiamondCost).plus(j.otherMaterialCost)),
  }));
}

export type JewelleryJobDetail = JewelleryJobRow & {
  customerReference: string | null;
  jewellerySize: string | null;
  quantity: number;
  notes: string | null;
  specialInstructions: string | null;
  designImageAssetId: string | null;
  targetMetalType: MetalType | null;
  targetPurityDisplayName: string | null;
  targetFinishedWeight: Decimal | null;
  issuedMetalCost: Decimal;
  issuedDiamondCost: Decimal;
  otherMaterialCost: Decimal;
  remainingWipCost: Decimal;
  totalLabourCharge: Decimal;
  receivedFineWeight: Decimal;
  returnedMetalFineWeight: Decimal;
  scrapFineWeight: Decimal;
  karigarAddedFineWeight: Decimal;
  karigarAddedCost: Decimal;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  isCompleted: boolean;
  finalMetalLossFineWeight: Decimal | null;
  metalLines: {
    id: string;
    metalType: MetalType;
    purityId: string;
    purityDisplayName: string;
    grossWeight: Decimal;
    fineWeight: Decimal;
    costValue: Decimal;
  }[];
  diamondLines: {
    id: string;
    polishedDiamondId: string;
    polishedCode: string;
    shape: string;
    carat: Decimal;
    costAtIssue: Decimal;
    resolvedAs: string | null;
  }[];
  otherMaterialLines: {
    id: string;
    description: string;
    quantity: Decimal;
    unit: string;
    weight: Decimal | null;
    cost: Decimal;
    note: string | null;
  }[];
  receipts: {
    id: string;
    receiptCode: string;
    receiveDate: Date;
    returnedMetalFineWeight: Decimal;
    scrapFineWeight: Decimal;
    processLossFineWeight: Decimal;
    isAbnormalLoss: boolean;
    labourCharge: Decimal;
    makingCharge: Decimal;
    settingCharge: Decimal;
    platingCharge: Decimal;
    otherExpense: Decimal;
  }[];
  finishedOutputs: {
    id: string;
    receiptId: string;
    finishedCode: string;
    jewelleryType: JewelleryType;
    quantity: number;
    netMetalWeight: Decimal;
    fineMetalWeight: Decimal;
    totalCost: Decimal;
    qcStatus: QcStatus;
    photoAssetId: string | null;
  }[];
  timeline: {
    id: string;
    type: string;
    detail: string;
    costValue: Decimal;
    sourceDocument: string | null;
    createdAt: Date;
  }[];
};

const METAL_MOVEMENT_LABELS: Record<string, string> = {
  PURCHASE_IN: "Metal purchased",
  OPENING_IN: "Opening metal stock",
  ISSUE_OUT: "Metal issued to job",
  ISSUE_CANCEL_IN: "Issue cancelled — metal returned to stock",
  RETURN_IN: "Unused metal returned",
  SCRAP_RETURN_IN: "Recoverable scrap returned",
  CONSUMED_OUT: "Metal consumed (finished + process loss)",
  ADJUSTMENT_IN: "Owner adjustment (in)",
  ADJUSTMENT_OUT: "Owner adjustment (out)",
};

const DIAMOND_MOVEMENT_LABELS: Record<string, string> = {
  JEWELLERY_ISSUE_OUT: "Diamond issued to job",
  JEWELLERY_ISSUE_CANCEL_IN: "Issue cancelled — diamond returned to stock",
  JEWELLERY_RETURN_IN: "Diamond returned to stock",
  JEWELLERY_SET_OUT: "Diamond set in finished jewellery",
  JEWELLERY_DAMAGED_LOSS_OUT: "Diamond marked damaged/lost",
};

export async function getJewelleryJobDetail(jobId: string): Promise<JewelleryJobDetail | null> {
  const [job, metalMovements, diamondMovements] = await Promise.all([
    prisma.jewelleryJob.findUnique({
      where: { id: jobId },
      include: {
        karigar: true,
        customer: true,
        targetPurity: true,
        metalIssueLines: { include: { purity: true } },
        diamondIssueLines: { include: { polishedDiamond: true } },
        otherMaterialLines: true,
        receipts: { orderBy: { receiveDate: "asc" } },
        finishedJewellery: true,
      },
    }),
    prisma.metalStockMovement.findMany({
      where: { jewelleryJobId: jobId },
      include: { purity: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.stockMovement.findMany({
      where: { jewelleryJobId: jobId },
      include: { polishedDiamond: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  if (!job) return null;

  const timeline: JewelleryJobDetail["timeline"] = [
    ...metalMovements.map((m) => ({
      id: m.id,
      type: m.type,
      detail: `${METAL_MOVEMENT_LABELS[m.type] ?? m.type} — ${round3(m.grossWeight).toFixed(3)}g gross / ${round3(m.fineWeight).toFixed(3)}g fine (${m.purity.displayName})`,
      costValue: round2(m.costValue),
      sourceDocument: m.sourceDocument,
      createdAt: m.createdAt,
    })),
    ...diamondMovements.map((m) => ({
      id: m.id,
      type: m.type,
      detail: `${DIAMOND_MOVEMENT_LABELS[m.type] ?? m.type} — ${m.polishedDiamond?.polishedCode ?? "diamond"} (${round3(m.carat).toFixed(3)}ct)`,
      costValue: round2(m.costValue),
      sourceDocument: m.sourceDocument,
      createdAt: m.createdAt,
    })),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return {
    id: job.id,
    jobCode: job.jobCode,
    customerName: job.customer?.name ?? null,
    customerReference: job.customerReference,
    karigarName: job.karigar.name,
    jewelleryType: job.jewelleryType,
    designName: job.designName,
    designImageAssetId: job.designImageAssetId,
    issueDate: job.issueDate,
    expectedDeliveryDate: job.expectedDeliveryDate,
    status: job.status,
    jewellerySize: job.jewellerySize,
    quantity: job.quantity,
    notes: job.notes,
    specialInstructions: job.specialInstructions,
    targetMetalType: job.targetMetalType,
    targetPurityDisplayName: job.targetPurity?.displayName ?? null,
    targetFinishedWeight: job.targetFinishedWeight ? round3(job.targetFinishedWeight) : null,
    issuedMetalFineWeight: round3(job.issuedMetalFineWeight),
    issuedMetalCost: round2(job.issuedMetalCost),
    issuedDiamondCost: round2(job.issuedDiamondCost),
    otherMaterialCost: round2(job.otherMaterialCost),
    remainingWipCost: round2(job.remainingWipCost),
    totalLabourCharge: round2(job.totalLabourCharge),
    receivedFineWeight: round3(job.receivedFineWeight),
    returnedMetalFineWeight: round3(job.returnedMetalFineWeight),
    scrapFineWeight: round3(job.scrapFineWeight),
    karigarAddedFineWeight: round3(job.karigarAddedFineWeight),
    karigarAddedCost: round2(job.karigarAddedCost),
    pendingFineWeight: pendingFineWeightOf(job),
    totalIssuedCost: round2(new Decimal(job.issuedMetalCost).plus(job.issuedDiamondCost).plus(job.otherMaterialCost)),
    cancelledAt: job.cancelledAt,
    cancellationReason: job.cancellationReason,
    isCompleted: job.status === "COMPLETED",
    // Only meaningful once the job is completed — the same issued-minus-
    // received-minus-returned-minus-scrap gap that shows "still pending"
    // while open becomes the final recognized process loss once every
    // issued gram has been accounted for (mirrors Phase 3's diamond job).
    finalMetalLossFineWeight: job.status === "COMPLETED" ? pendingFineWeightOf(job) : null,
    metalLines: job.metalIssueLines.map((l) => ({
      id: l.id,
      metalType: l.metalType,
      purityId: l.purityId,
      purityDisplayName: l.purity.displayName,
      grossWeight: round3(l.grossWeight),
      fineWeight: round3(l.fineWeight),
      costValue: round2(l.costValue),
    })),
    diamondLines: job.diamondIssueLines.map((l) => ({
      id: l.id,
      polishedDiamondId: l.polishedDiamondId,
      polishedCode: l.polishedDiamond.polishedCode,
      shape: l.polishedDiamond.shape,
      carat: round3(l.caratAtIssue),
      costAtIssue: round2(l.costAtIssue),
      resolvedAs: l.resolvedAs,
    })),
    otherMaterialLines: job.otherMaterialLines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: round3(l.quantity),
      unit: l.unit,
      weight: l.weight ? round3(l.weight) : null,
      cost: round2(l.cost),
      note: l.note,
    })),
    receipts: job.receipts.map((r) => ({
      id: r.id,
      receiptCode: r.receiptCode,
      receiveDate: r.receiveDate,
      returnedMetalFineWeight: round3(r.returnedMetalFineWeight),
      scrapFineWeight: round3(r.scrapFineWeight),
      processLossFineWeight: round3(r.processLossFineWeight),
      isAbnormalLoss: r.isAbnormalLoss,
      labourCharge: round2(r.labourCharge),
      makingCharge: round2(r.makingCharge),
      settingCharge: round2(r.settingCharge),
      platingCharge: round2(r.platingCharge),
      otherExpense: round2(r.otherExpense),
    })),
    finishedOutputs: job.finishedJewellery.map((f) => ({
      id: f.id,
      receiptId: f.receiptId,
      finishedCode: f.finishedCode,
      jewelleryType: f.jewelleryType,
      quantity: f.quantity,
      netMetalWeight: round3(f.netMetalWeight),
      fineMetalWeight: round3(f.fineMetalWeight),
      totalCost: round2(f.totalCost),
      qcStatus: f.qcStatus,
      photoAssetId: f.photoAssetId,
    })),
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Karigar material balance (Jewellery side — separate from money/labour
// payable, which is the ordinary Phase 2 Accounts Payable balance)
// ---------------------------------------------------------------------------

export type KarigarJewelleryMaterialBalance = {
  karigarId: string;
  karigarName: string;
  openJobsCount: number;
  pendingFineWeight: Decimal;
  pendingDiamondsCount: number;
};

export async function getKarigarJewelleryMaterialBalances(): Promise<KarigarJewelleryMaterialBalance[]> {
  const karigars = await prisma.party.findMany({ where: { type: "KARIGAR", isActive: true }, orderBy: { name: "asc" } });
  const openJobs = await prisma.jewelleryJob.findMany({
    where: { status: { in: ["MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"] } },
    include: { diamondIssueLines: true },
  });

  return karigars.map((k) => {
    const jobsForKarigar = openJobs.filter((j) => j.karigarId === k.id);
    const pendingFineWeight = round3(
      jobsForKarigar.reduce((sum, j) => sum.plus(pendingFineWeightOf(j)), ZERO)
    );
    const pendingDiamondsCount = jobsForKarigar.reduce(
      (sum, j) => sum + j.diamondIssueLines.filter((l) => !l.resolvedAs).length,
      0
    );
    return {
      karigarId: k.id,
      karigarName: k.name,
      openJobsCount: jobsForKarigar.length,
      pendingFineWeight,
      pendingDiamondsCount,
    };
  });
}

// ---------------------------------------------------------------------------
// Finished Jewellery records
// ---------------------------------------------------------------------------

export type FinishedJewelleryRow = {
  id: string;
  finishedCode: string;
  jobCode: string;
  customerName: string | null;
  designName: string;
  karigarName: string;
  jewelleryType: JewelleryType;
  metalType: MetalType;
  purityDisplayName: string;
  netMetalWeight: Decimal;
  fineMetalWeight: Decimal;
  grossWeight: Decimal | null;
  diamondCount: number;
  totalCost: Decimal;
  qcStatus: QcStatus;
  photoAssetId: string | null;
  createdAt: Date;
};

export async function listFinishedJewellery(filters?: { search?: string }): Promise<FinishedJewelleryRow[]> {
  const outputs = await prisma.finishedJewellery.findMany({
    where: filters?.search
      ? {
          OR: [
            { finishedCode: { contains: filters.search, mode: "insensitive" } },
            { job: { jobCode: { contains: filters.search, mode: "insensitive" } } },
            { job: { designName: { contains: filters.search, mode: "insensitive" } } },
          ],
        }
      : undefined,
    include: { job: { include: { karigar: true, customer: true } }, purity: true, diamonds: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });

  return outputs.map((o) => ({
    id: o.id,
    finishedCode: o.finishedCode,
    jobCode: o.job.jobCode,
    customerName: o.job.customer?.name ?? null,
    designName: o.job.designName,
    karigarName: o.job.karigar.name,
    jewelleryType: o.jewelleryType,
    metalType: o.metalType,
    purityDisplayName: o.purity.displayName,
    netMetalWeight: round3(o.netMetalWeight),
    fineMetalWeight: round3(o.fineMetalWeight),
    grossWeight: o.grossWeight ? round3(o.grossWeight) : null,
    diamondCount: o.diamonds.length,
    totalCost: round2(o.totalCost),
    qcStatus: o.qcStatus,
    photoAssetId: o.photoAssetId,
    createdAt: o.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// Finished Jewellery Stock (Phase 6) — the FinishedJewelleryStockMovement
// ledger in schema.prisma is the immutable audit trail; `status` on
// FinishedJewellery is the fast, concurrency-safe derived gate. This list
// reads from `status` (cheap, indexed), never from re-deriving state by
// summing movements, matching how RoughPiece/PolishedDiamond stock lists
// already work elsewhere in this codebase.
//
// SECURITY BOUNDARY: cost/Costing fields are fetched from the database ONLY
// when `includeCost` is true (a separate `select`, not merely a field
// omitted after the fact) — the caller (page-level, keyed off
// `user.role === "OWNER"`) must never pass includeCost:true for a Staff
// viewer. See src/app/(app)/jewellery-jobs/page.tsx and
// FinishedStockTab.tsx.
// ---------------------------------------------------------------------------

export type FinishedJewelleryStockRow = {
  id: string;
  finishedCode: string;
  jobCode: string;
  designName: string;
  karigarName: string;
  jewelleryType: JewelleryType;
  metalType: MetalType;
  purityDisplayName: string;
  netMetalWeight: Decimal;
  fineMetalWeight: Decimal;
  grossWeight: Decimal | null;
  diamondCount: number;
  totalCarat: Decimal;
  status: FinishedJewelleryStockStatus;
  producedAt: Date;
  photoAssetId: string | null;
  saleCode: string | null;
  saleDate: Date | null;
  // Owner-only. Present only when the query was run with includeCost:true.
  inventoryCost?: Decimal;
  costSheetNumber?: string | null;
};

type StockRowSource = {
  id: string;
  finishedCode: string;
  jewelleryType: JewelleryType;
  metalType: MetalType;
  netMetalWeight: Decimal;
  fineMetalWeight: Decimal;
  grossWeight: Decimal | null;
  photoAssetId: string | null;
  status: FinishedJewelleryStockStatus;
  createdAt: Date;
  job: { jobCode: string; designName: string; karigar: { name: string } };
  purity: { displayName: string };
  diamonds: { caratAtIssue: Decimal }[];
  saleLines: { sale: { saleCode: string; saleDate: Date } }[];
};

function toStockRow(o: StockRowSource, cost?: { inventoryCost: Decimal; costSheetNumber: string | null }): FinishedJewelleryStockRow {
  const activeSaleLine = o.saleLines[0] ?? null;
  return {
    id: o.id,
    finishedCode: o.finishedCode,
    jobCode: o.job.jobCode,
    designName: o.job.designName,
    karigarName: o.job.karigar.name,
    jewelleryType: o.jewelleryType,
    metalType: o.metalType,
    purityDisplayName: o.purity.displayName,
    netMetalWeight: round3(o.netMetalWeight),
    fineMetalWeight: round3(o.fineMetalWeight),
    grossWeight: o.grossWeight ? round3(o.grossWeight) : null,
    diamondCount: o.diamonds.length,
    totalCarat: round3(o.diamonds.reduce((sum, d) => sum.plus(d.caratAtIssue), new Decimal(0))),
    status: o.status,
    producedAt: o.createdAt,
    photoAssetId: o.photoAssetId,
    saleCode: activeSaleLine?.sale.saleCode ?? null,
    saleDate: activeSaleLine?.sale.saleDate ?? null,
    ...(cost ? { inventoryCost: cost.inventoryCost, costSheetNumber: cost.costSheetNumber } : {}),
  };
}

const ACTIVE_SALE_LINE_ARGS = {
  where: { returnStatus: "NONE" as const, sale: { status: "POSTED" as const } },
  select: { sale: { select: { saleCode: true, saleDate: true } } },
  orderBy: { createdAt: "desc" as const },
  take: 1,
};

export async function listFinishedJewelleryStock(filters?: {
  search?: string;
  status?: FinishedJewelleryStockStatus;
  includeCost?: boolean;
}): Promise<FinishedJewelleryStockRow[]> {
  const where = {
    ...(filters?.status ? { status: filters.status } : {}),
    ...(filters?.search
      ? {
          OR: [
            { finishedCode: { contains: filters.search, mode: "insensitive" as const } },
            { job: { jobCode: { contains: filters.search, mode: "insensitive" as const } } },
            { job: { designName: { contains: filters.search, mode: "insensitive" as const } } },
          ],
        }
      : {}),
  };

  if (filters?.includeCost) {
    const outputs = await prisma.finishedJewellery.findMany({
      where,
      select: {
        id: true,
        finishedCode: true,
        jewelleryType: true,
        metalType: true,
        netMetalWeight: true,
        fineMetalWeight: true,
        grossWeight: true,
        photoAssetId: true,
        status: true,
        createdAt: true,
        metalCost: true,
        diamondCost: true,
        labourAllocated: true,
        job: { select: { jobCode: true, designName: true, karigar: { select: { name: true } } } },
        purity: { select: { displayName: true } },
        diamonds: { select: { caratAtIssue: true } },
        costSheets: {
          where: { status: "FINALIZED", mode: "ACTUAL" },
          select: { costingNumber: true },
          orderBy: { finalizedAt: "desc" },
          take: 1,
        },
        saleLines: ACTIVE_SALE_LINE_ARGS,
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    });
    return outputs.map((o) =>
      toStockRow(o, {
        inventoryCost: getAuthoritativeInventoryCost(o),
        costSheetNumber: o.costSheets[0]?.costingNumber ?? null,
      })
    );
  }

  const outputs = await prisma.finishedJewellery.findMany({
    where,
    select: {
      id: true,
      finishedCode: true,
      jewelleryType: true,
      metalType: true,
      netMetalWeight: true,
      fineMetalWeight: true,
      grossWeight: true,
      photoAssetId: true,
      status: true,
      createdAt: true,
      job: { select: { jobCode: true, designName: true, karigar: { select: { name: true } } } },
      purity: { select: { displayName: true } },
      diamonds: { select: { caratAtIssue: true } },
      saleLines: ACTIVE_SALE_LINE_ARGS,
    },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return outputs.map((o) => toStockRow(o));
}

/**
 * The one Available piece a Sale form list picker needs — deliberately the
 * SAME shape/query as the Staff-safe branch above (never the includeCost
 * branch): item selection during sale entry must never leak cost even to
 * an Owner's own list-picking UI, since the picker is a shared component.
 * The Owner-only cost view lives only in the Finished Stock tab.
 */
export async function listAvailableFinishedJewelleryForSale(search?: string): Promise<FinishedJewelleryStockRow[]> {
  return listFinishedJewelleryStock({ search, status: "AVAILABLE", includeCost: false });
}

// ---------------------------------------------------------------------------
// Finished Jewellery Sales & Profit report (Owner-only — every field here
// is cost/margin data) — sale-line grain so it can be filtered/grouped by
// item, customer or date on the client, and CSV-exported as-is.
// ---------------------------------------------------------------------------

export type FinishedJewellerySaleLineReportRow = {
  saleId: string;
  saleCode: string;
  saleStatus: string;
  saleDate: Date;
  customerName: string;
  finishedCode: string;
  itemDescription: string;
  taxableValue: Decimal;
  cogsAmount: Decimal;
  grossProfit: Decimal;
  returnStatus: string;
};

export async function listFinishedJewellerySaleLines(filters?: {
  finishedJewelleryId?: string;
  customerId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}): Promise<FinishedJewellerySaleLineReportRow[]> {
  const lines = await prisma.finishedJewellerySaleLine.findMany({
    where: {
      finishedJewelleryId: filters?.finishedJewelleryId,
      sale: {
        customerId: filters?.customerId,
        saleDate: { gte: filters?.dateFrom, lte: filters?.dateTo },
      },
    },
    include: {
      sale: { include: { customer: true } },
      finishedJewellery: { select: { finishedCode: true } },
    },
    orderBy: [{ sale: { saleDate: "desc" } }, { sortOrder: "asc" }],
    take: 500,
  });

  return lines.map((l) => {
    const taxableValue = round2(l.taxableValue);
    const cogsAmount = round2(l.cogsAmount);
    return {
      saleId: l.saleId,
      saleCode: l.sale.saleCode,
      saleStatus: l.sale.status,
      saleDate: l.sale.saleDate,
      customerName: l.sale.customer.name,
      finishedCode: l.finishedJewellery.finishedCode,
      itemDescription: l.itemDescriptionSnapshot,
      taxableValue,
      cogsAmount,
      grossProfit: round2(taxableValue.minus(cogsAmount)),
      returnStatus: l.returnStatus,
    };
  });
}

// ---------------------------------------------------------------------------
// Dashboard integration
// ---------------------------------------------------------------------------

export async function getPendingJewelleryJobsCount(): Promise<number> {
  return prisma.jewelleryJob.count({
    where: { status: { in: ["DRAFT", "MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"] } },
  });
}

export type FinishedJewelleryStockSummary = {
  availableCount: number;
  availableFineWeight: Decimal;
  // Owner-only — undefined unless includeValue was requested.
  availableInventoryValue?: Decimal;
};

// ---------------------------------------------------------------------------
// Finished Jewellery Sale management (Owner-only — cancellation/return UI)
// ---------------------------------------------------------------------------

export type FinishedJewellerySaleLineForManagement = {
  id: string;
  finishedCode: string;
  itemDescription: string;
  taxableValue: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
  returnStatus: string;
};

export type FinishedJewellerySaleForManagement = {
  id: string;
  saleCode: string;
  saleDate: Date;
  customerName: string;
  status: string;
  grandTotal: Decimal;
  lines: FinishedJewellerySaleLineForManagement[];
};

/** Recent Finished Jewellery Sales with their lines, for the Owner-only
 * cancellation/return management UI. Cost fields are deliberately NOT
 * included here — this view only needs enough to identify a sale/line and
 * drive the cancel/return actions, not COGS/margin. */
export async function listFinishedJewellerySalesForManagement(
  search?: string
): Promise<FinishedJewellerySaleForManagement[]> {
  const sales = await prisma.finishedJewellerySale.findMany({
    where: search
      ? {
          OR: [
            { saleCode: { contains: search, mode: "insensitive" } },
            { customer: { name: { contains: search, mode: "insensitive" } } },
          ],
        }
      : undefined,
    include: {
      customer: { select: { name: true } },
      lines: { include: { finishedJewellery: { select: { finishedCode: true } } }, orderBy: { sortOrder: "asc" } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return sales.map((s) => ({
    id: s.id,
    saleCode: s.saleCode,
    saleDate: s.saleDate,
    customerName: s.customer.name,
    status: s.status,
    grandTotal: round2(s.grandTotal),
    lines: s.lines.map((l) => ({
      id: l.id,
      finishedCode: l.finishedJewellery.finishedCode,
      itemDescription: l.itemDescriptionSnapshot,
      taxableValue: round2(l.taxableValue),
      taxAmount: round2(l.taxAmount),
      lineTotal: round2(l.lineTotal),
      returnStatus: l.returnStatus,
    })),
  }));
}

export async function getFinishedJewelleryStockSummary(includeValue = false): Promise<FinishedJewelleryStockSummary> {
  if (includeValue) {
    const rows = await prisma.finishedJewellery.findMany({
      where: { status: "AVAILABLE" },
      select: { fineMetalWeight: true, metalCost: true, diamondCost: true, labourAllocated: true },
    });
    return {
      availableCount: rows.length,
      availableFineWeight: round3(rows.reduce((sum, r) => sum.plus(r.fineMetalWeight), new Decimal(0))),
      availableInventoryValue: round2(
        rows.reduce((sum, r) => sum.plus(getAuthoritativeInventoryCost(r)), ZERO)
      ),
    };
  }
  const rows = await prisma.finishedJewellery.findMany({
    where: { status: "AVAILABLE" },
    select: { fineMetalWeight: true },
  });
  return {
    availableCount: rows.length,
    availableFineWeight: round3(rows.reduce((sum, r) => sum.plus(r.fineMetalWeight), new Decimal(0))),
  };
}
