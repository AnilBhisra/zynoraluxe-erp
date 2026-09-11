-- CreateEnum
CREATE TYPE "DiamondShape" AS ENUM ('ROUND', 'OVAL', 'PEAR', 'EMERALD', 'CUSHION', 'ELONGATED_CUSHION', 'RADIANT', 'PRINCESS', 'MARQUISE', 'ASSCHER', 'CUSTOM');

-- CreateEnum
CREATE TYPE "RateBasis" AS ENUM ('PER_CARAT', 'FIXED_TOTAL');

-- CreateEnum
CREATE TYPE "RoughPieceStatus" AS ENUM ('AVAILABLE', 'WITH_KARIGAR', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DiamondJobStatus" AS ENUM ('ISSUED', 'IN_PROGRESS', 'PARTIALLY_RECEIVED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CertificateStatus" AS ENUM ('NOT_CERTIFIED', 'INTERNAL_GRADE', 'CERTIFIED');

-- CreateEnum
CREATE TYPE "PolishedDiamondStatus" AS ENUM ('AVAILABLE', 'RECUT');

-- CreateEnum
CREATE TYPE "DiamondSequenceType" AS ENUM ('ROUGH_LOT', 'ROUGH_PIECE', 'DIAMOND_JOB', 'POLISHED_RECEIPT', 'POLISHED_DIAMOND');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM ('ROUGH_PURCHASE_IN', 'ROUGH_ISSUE_OUT', 'ROUGH_ISSUE_CANCEL_IN', 'ROUGH_CONSUMED_OUT', 'ROUGH_RETURN_IN', 'POLISHED_RECEIVE_IN', 'POLISHED_RECUT_OUT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VoucherType" ADD VALUE 'DIAMOND_ISSUE';
ALTER TYPE "VoucherType" ADD VALUE 'DIAMOND_RECEIPT';

-- CreateTable
CREATE TABLE "diamond_sequences" (
    "id" TEXT NOT NULL,
    "sequenceType" "DiamondSequenceType" NOT NULL,
    "yearLabel" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diamond_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rough_lots" (
    "id" TEXT NOT NULL,
    "lotCode" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "supplierId" TEXT NOT NULL,
    "piecesCount" INTEGER NOT NULL,
    "totalRoughCarat" DECIMAL(10,3) NOT NULL,
    "purchaseRate" DECIMAL(14,4) NOT NULL,
    "rateBasis" "RateBasis" NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "exchangeRate" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "totalPurchaseCost" DECIMAL(14,2) NOT NULL,
    "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'NONE',
    "gstRateId" TEXT,
    "gstRatePercent" DECIMAL(5,2),
    "supplierInvoiceRef" TEXT,
    "notes" TEXT,
    "photoAssetId" TEXT,
    "voucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rough_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rough_pieces" (
    "id" TEXT NOT NULL,
    "roughCode" TEXT NOT NULL,
    "lotId" TEXT,
    "returnedFromJobId" TEXT,
    "returnedFromReceiptId" TEXT,
    "carat" DECIMAL(10,3) NOT NULL,
    "lengthMm" DECIMAL(8,3),
    "widthMm" DECIMAL(8,3),
    "heightMm" DECIMAL(8,3),
    "colorEstimate" TEXT,
    "clarityNote" TEXT,
    "internalNote" TEXT,
    "photoAssetId" TEXT,
    "allocatedCost" DECIMAL(14,2) NOT NULL,
    "costLocked" BOOLEAN NOT NULL DEFAULT false,
    "status" "RoughPieceStatus" NOT NULL DEFAULT 'AVAILABLE',
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rough_pieces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diamond_job_pieces" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "roughPieceId" TEXT NOT NULL,
    "caratAtIssue" DECIMAL(10,3) NOT NULL,
    "costAtIssue" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diamond_job_pieces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diamond_jobs" (
    "id" TEXT NOT NULL,
    "jobCode" TEXT NOT NULL,
    "karigarId" TEXT NOT NULL,
    "requiredShape" "DiamondShape" NOT NULL,
    "customShapeName" TEXT,
    "customShapeReferencePhotoAssetId" TEXT,
    "customShapeMeasurements" TEXT,
    "customShapeInstruction" TEXT,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "targetPolishedCarat" DECIMAL(10,3),
    "targetLengthMm" DECIMAL(8,3),
    "targetWidthMm" DECIMAL(8,3),
    "targetHeightMm" DECIMAL(8,3),
    "notes" TEXT,
    "issuedPiecesCount" INTEGER NOT NULL,
    "issuedRoughCarat" DECIMAL(10,3) NOT NULL,
    "issuedCostValue" DECIMAL(14,2) NOT NULL,
    "remainingWipCost" DECIMAL(14,2) NOT NULL,
    "receivedPolishedCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "returnedRoughCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "totalLabourCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "DiamondJobStatus" NOT NULL DEFAULT 'ISSUED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "wipVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diamond_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polished_receipts" (
    "id" TEXT NOT NULL,
    "receiptCode" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "receiveDate" TIMESTAMP(3) NOT NULL,
    "polishedCount" INTEGER NOT NULL,
    "totalPolishedCarat" DECIMAL(10,3) NOT NULL,
    "returnedRoughCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "weightLossCarat" DECIMAL(10,3) NOT NULL,
    "yieldPercent" DECIMAL(6,3) NOT NULL,
    "labourCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "shape" "DiamondShape" NOT NULL,
    "notes" TEXT,
    "postingVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "polished_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polished_diamonds" (
    "id" TEXT NOT NULL,
    "polishedCode" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "shape" "DiamondShape" NOT NULL,
    "carat" DECIMAL(10,3) NOT NULL,
    "lengthMm" DECIMAL(8,3),
    "widthMm" DECIMAL(8,3),
    "heightMm" DECIMAL(8,3),
    "color" TEXT,
    "clarity" TEXT,
    "cutGrade" TEXT,
    "polish" TEXT,
    "symmetry" TEXT,
    "fluorescence" TEXT,
    "certificateStatus" "CertificateStatus" NOT NULL DEFAULT 'NOT_CERTIFIED',
    "certLab" TEXT,
    "certNumber" TEXT,
    "certFileAssetId" TEXT,
    "photoAssetId" TEXT,
    "allocatedCost" DECIMAL(14,2) NOT NULL,
    "costPerCarat" DECIMAL(14,2) NOT NULL,
    "status" "PolishedDiamondStatus" NOT NULL DEFAULT 'AVAILABLE',
    "recutAt" TIMESTAMP(3),
    "recutByUserId" TEXT,
    "recutReason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "polished_diamonds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" TEXT NOT NULL,
    "type" "StockMovementType" NOT NULL,
    "roughPieceId" TEXT,
    "polishedDiamondId" TEXT,
    "diamondJobId" TEXT,
    "pieces" INTEGER NOT NULL DEFAULT 1,
    "carat" DECIMAL(10,3) NOT NULL,
    "costValue" DECIMAL(14,2) NOT NULL,
    "sourceDocument" TEXT NOT NULL,
    "reversalOfMovementId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diamond_sequences_sequenceType_yearLabel_key" ON "diamond_sequences"("sequenceType", "yearLabel");

-- CreateIndex
CREATE UNIQUE INDEX "rough_lots_lotCode_key" ON "rough_lots"("lotCode");

-- CreateIndex
CREATE UNIQUE INDEX "rough_lots_voucherId_key" ON "rough_lots"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "rough_lots_idempotencyKey_key" ON "rough_lots"("idempotencyKey");

-- CreateIndex
CREATE INDEX "rough_lots_supplierId_idx" ON "rough_lots"("supplierId");

-- CreateIndex
CREATE INDEX "rough_lots_purchaseDate_idx" ON "rough_lots"("purchaseDate");

-- CreateIndex
CREATE UNIQUE INDEX "rough_pieces_roughCode_key" ON "rough_pieces"("roughCode");

-- CreateIndex
CREATE INDEX "rough_pieces_lotId_idx" ON "rough_pieces"("lotId");

-- CreateIndex
CREATE INDEX "rough_pieces_status_idx" ON "rough_pieces"("status");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_job_pieces_jobId_roughPieceId_key" ON "diamond_job_pieces"("jobId", "roughPieceId");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_jobs_jobCode_key" ON "diamond_jobs"("jobCode");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_jobs_wipVoucherId_key" ON "diamond_jobs"("wipVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_jobs_idempotencyKey_key" ON "diamond_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "diamond_jobs_karigarId_idx" ON "diamond_jobs"("karigarId");

-- CreateIndex
CREATE INDEX "diamond_jobs_status_idx" ON "diamond_jobs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "polished_receipts_receiptCode_key" ON "polished_receipts"("receiptCode");

-- CreateIndex
CREATE UNIQUE INDEX "polished_receipts_postingVoucherId_key" ON "polished_receipts"("postingVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "polished_receipts_idempotencyKey_key" ON "polished_receipts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "polished_receipts_jobId_idx" ON "polished_receipts"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "polished_diamonds_polishedCode_key" ON "polished_diamonds"("polishedCode");

-- CreateIndex
CREATE INDEX "polished_diamonds_jobId_idx" ON "polished_diamonds"("jobId");

-- CreateIndex
CREATE INDEX "polished_diamonds_status_idx" ON "polished_diamonds"("status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_movements_reversalOfMovementId_key" ON "stock_movements"("reversalOfMovementId");

-- CreateIndex
CREATE INDEX "stock_movements_roughPieceId_idx" ON "stock_movements"("roughPieceId");

-- CreateIndex
CREATE INDEX "stock_movements_polishedDiamondId_idx" ON "stock_movements"("polishedDiamondId");

-- CreateIndex
CREATE INDEX "stock_movements_diamondJobId_idx" ON "stock_movements"("diamondJobId");

-- CreateIndex
CREATE INDEX "stock_movements_type_idx" ON "stock_movements"("type");

-- AddForeignKey
ALTER TABLE "rough_lots" ADD CONSTRAINT "rough_lots_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_lots" ADD CONSTRAINT "rough_lots_gstRateId_fkey" FOREIGN KEY ("gstRateId") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_lots" ADD CONSTRAINT "rough_lots_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_lots" ADD CONSTRAINT "rough_lots_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_pieces" ADD CONSTRAINT "rough_pieces_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "rough_lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_pieces" ADD CONSTRAINT "rough_pieces_returnedFromJobId_fkey" FOREIGN KEY ("returnedFromJobId") REFERENCES "diamond_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_pieces" ADD CONSTRAINT "rough_pieces_returnedFromReceiptId_fkey" FOREIGN KEY ("returnedFromReceiptId") REFERENCES "polished_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rough_pieces" ADD CONSTRAINT "rough_pieces_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_job_pieces" ADD CONSTRAINT "diamond_job_pieces_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "diamond_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_job_pieces" ADD CONSTRAINT "diamond_job_pieces_roughPieceId_fkey" FOREIGN KEY ("roughPieceId") REFERENCES "rough_pieces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_jobs" ADD CONSTRAINT "diamond_jobs_karigarId_fkey" FOREIGN KEY ("karigarId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_jobs" ADD CONSTRAINT "diamond_jobs_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_jobs" ADD CONSTRAINT "diamond_jobs_wipVoucherId_fkey" FOREIGN KEY ("wipVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_jobs" ADD CONSTRAINT "diamond_jobs_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_receipts" ADD CONSTRAINT "polished_receipts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "diamond_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_receipts" ADD CONSTRAINT "polished_receipts_postingVoucherId_fkey" FOREIGN KEY ("postingVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_receipts" ADD CONSTRAINT "polished_receipts_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_diamonds" ADD CONSTRAINT "polished_diamonds_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "polished_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_diamonds" ADD CONSTRAINT "polished_diamonds_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "diamond_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_diamonds" ADD CONSTRAINT "polished_diamonds_recutByUserId_fkey" FOREIGN KEY ("recutByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_diamonds" ADD CONSTRAINT "polished_diamonds_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_roughPieceId_fkey" FOREIGN KEY ("roughPieceId") REFERENCES "rough_pieces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_polishedDiamondId_fkey" FOREIGN KEY ("polishedDiamondId") REFERENCES "polished_diamonds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_diamondJobId_fkey" FOREIGN KEY ("diamondJobId") REFERENCES "diamond_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reversalOfMovementId_fkey" FOREIGN KEY ("reversalOfMovementId") REFERENCES "stock_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
