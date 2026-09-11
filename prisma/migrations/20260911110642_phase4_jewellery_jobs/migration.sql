-- CreateEnum
CREATE TYPE "MetalType" AS ENUM ('GOLD', 'SILVER', 'PLATINUM', 'OTHER');

-- CreateEnum
CREATE TYPE "MetalRateBasis" AS ENUM ('PER_GROSS_GRAM', 'PER_FINE_GRAM', 'FIXED_TOTAL');

-- CreateEnum
CREATE TYPE "MetalStockMovementType" AS ENUM ('PURCHASE_IN', 'OPENING_IN', 'ISSUE_OUT', 'ISSUE_CANCEL_IN', 'RETURN_IN', 'SCRAP_RETURN_IN', 'CONSUMED_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT');

-- CreateEnum
CREATE TYPE "JewelleryType" AS ENUM ('RING', 'EARRINGS', 'PENDANT', 'NECKLACE', 'BRACELET', 'BANGLE', 'CHAIN', 'COUPLE_RING', 'CUSTOM');

-- CreateEnum
CREATE TYPE "JewelleryJobStatus" AS ENUM ('DRAFT', 'MATERIALS_ISSUED', 'IN_PROGRESS', 'PARTIALLY_RECEIVED', 'NEEDS_CORRECTION', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JewelleryDiamondResolution" AS ENUM ('SET', 'RETURNED', 'DAMAGED_LOST');

-- CreateEnum
CREATE TYPE "QcStatus" AS ENUM ('PASSED', 'NEEDS_CORRECTION', 'REJECTED');

-- CreateEnum
CREATE TYPE "JewellerySequenceType" AS ENUM ('METAL_PURCHASE', 'JEWELLERY_JOB', 'JEWELLERY_RECEIPT', 'FINISHED_JEWELLERY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PolishedDiamondStatus" ADD VALUE 'ISSUED_TO_JEWELLERY';
ALTER TYPE "PolishedDiamondStatus" ADD VALUE 'SET_IN_JEWELLERY';
ALTER TYPE "PolishedDiamondStatus" ADD VALUE 'DAMAGED_LOST';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE 'JEWELLERY_ISSUE_OUT';
ALTER TYPE "StockMovementType" ADD VALUE 'JEWELLERY_ISSUE_CANCEL_IN';
ALTER TYPE "StockMovementType" ADD VALUE 'JEWELLERY_RETURN_IN';
ALTER TYPE "StockMovementType" ADD VALUE 'JEWELLERY_SET_OUT';
ALTER TYPE "StockMovementType" ADD VALUE 'JEWELLERY_DAMAGED_LOSS_OUT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VoucherType" ADD VALUE 'JEWELLERY_ISSUE';
ALTER TYPE "VoucherType" ADD VALUE 'JEWELLERY_RECEIPT';

-- AlterTable
ALTER TABLE "polished_diamonds" ADD COLUMN     "damagedLostAt" TIMESTAMP(3),
ADD COLUMN     "damagedLostByUserId" TEXT,
ADD COLUMN     "damagedLostReason" TEXT;

-- AlterTable
ALTER TABLE "stock_movements" ADD COLUMN     "jewelleryJobId" TEXT;

-- CreateTable
CREATE TABLE "metal_purities" (
    "id" TEXT NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "displayName" TEXT NOT NULL,
    "finenessPercent" DECIMAL(6,3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metal_purities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metal_purchases" (
    "id" TEXT NOT NULL,
    "purchaseCode" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "finenessPercentSnapshot" DECIMAL(6,3) NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL,
    "fineWeight" DECIMAL(10,3) NOT NULL,
    "rateBasis" "MetalRateBasis" NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "exchangeRate" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "totalPurchaseCost" DECIMAL(14,2) NOT NULL,
    "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'NONE',
    "gstRateId" TEXT,
    "gstRatePercent" DECIMAL(5,2),
    "referenceNumber" TEXT,
    "notes" TEXT,
    "voucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "metal_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metal_stock_movements" (
    "id" TEXT NOT NULL,
    "type" "MetalStockMovementType" NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL,
    "fineWeight" DECIMAL(10,3) NOT NULL,
    "costValue" DECIMAL(14,2) NOT NULL,
    "sourceDocument" TEXT NOT NULL,
    "jewelleryJobId" TEXT,
    "reversalOfMovementId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metal_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_jobs" (
    "id" TEXT NOT NULL,
    "jobCode" TEXT NOT NULL,
    "customerId" TEXT,
    "customerReference" TEXT,
    "jewelleryType" "JewelleryType" NOT NULL,
    "designName" TEXT NOT NULL,
    "designImageAssetId" TEXT,
    "karigarId" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "expectedDeliveryDate" TIMESTAMP(3),
    "notes" TEXT,
    "jewellerySize" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "targetMetalType" "MetalType",
    "targetPurityId" TEXT,
    "targetFinishedWeight" DECIMAL(10,3),
    "specialInstructions" TEXT,
    "status" "JewelleryJobStatus" NOT NULL DEFAULT 'DRAFT',
    "issuedMetalFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "issuedMetalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "issuedDiamondCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherMaterialCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "receivedFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "returnedMetalFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "scrapFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "karigarAddedFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "karigarAddedCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "remainingWipCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalLabourCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "wipVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jewellery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_metal_issue_lines" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "finenessPercentSnapshot" DECIMAL(6,3) NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL,
    "fineWeight" DECIMAL(10,3) NOT NULL,
    "costValue" DECIMAL(14,2) NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jewellery_metal_issue_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_diamond_issue_lines" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "polishedDiamondId" TEXT NOT NULL,
    "caratAtIssue" DECIMAL(10,3) NOT NULL,
    "costAtIssue" DECIMAL(14,2) NOT NULL,
    "resolvedAs" "JewelleryDiamondResolution",
    "resolvedAt" TIMESTAMP(3),
    "setInFinishedJewelleryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jewellery_diamond_issue_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_other_material_lines" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,3) NOT NULL,
    "unit" "InvoiceUnit" NOT NULL DEFAULT 'PCS',
    "weight" DECIMAL(10,3),
    "cost" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jewellery_other_material_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_receipts" (
    "id" TEXT NOT NULL,
    "receiptCode" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "receiveDate" TIMESTAMP(3) NOT NULL,
    "returnedMetalGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "returnedMetalFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "scrapGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "scrapFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "processLossFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "isAbnormalLoss" BOOLEAN NOT NULL DEFAULT false,
    "abnormalLossReason" TEXT,
    "karigarAddedFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "karigarAddedCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "labourCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "makingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "settingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherExpense" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "postingVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jewellery_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_jewellery" (
    "id" TEXT NOT NULL,
    "finishedCode" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jewelleryType" "JewelleryType" NOT NULL,
    "description" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "grossWeight" DECIMAL(10,3),
    "netMetalWeight" DECIMAL(10,3) NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "finenessPercentSnapshot" DECIMAL(6,3) NOT NULL,
    "fineMetalWeight" DECIMAL(10,3) NOT NULL,
    "metalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "diamondCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherMaterialCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "labourAllocated" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "photoAssetId" TEXT,
    "qcStatus" "QcStatus" NOT NULL DEFAULT 'PASSED',
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finished_jewellery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_sequences" (
    "id" TEXT NOT NULL,
    "sequenceType" "JewellerySequenceType" NOT NULL,
    "yearLabel" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jewellery_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "metal_purities_metalType_displayName_key" ON "metal_purities"("metalType", "displayName");

-- CreateIndex
CREATE UNIQUE INDEX "metal_purchases_purchaseCode_key" ON "metal_purchases"("purchaseCode");

-- CreateIndex
CREATE UNIQUE INDEX "metal_purchases_voucherId_key" ON "metal_purchases"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "metal_purchases_idempotencyKey_key" ON "metal_purchases"("idempotencyKey");

-- CreateIndex
CREATE INDEX "metal_purchases_supplierId_idx" ON "metal_purchases"("supplierId");

-- CreateIndex
CREATE INDEX "metal_purchases_purchaseDate_idx" ON "metal_purchases"("purchaseDate");

-- CreateIndex
CREATE INDEX "metal_purchases_metalType_purityId_idx" ON "metal_purchases"("metalType", "purityId");

-- CreateIndex
CREATE UNIQUE INDEX "metal_stock_movements_reversalOfMovementId_key" ON "metal_stock_movements"("reversalOfMovementId");

-- CreateIndex
CREATE INDEX "metal_stock_movements_metalType_purityId_idx" ON "metal_stock_movements"("metalType", "purityId");

-- CreateIndex
CREATE INDEX "metal_stock_movements_jewelleryJobId_idx" ON "metal_stock_movements"("jewelleryJobId");

-- CreateIndex
CREATE INDEX "metal_stock_movements_type_idx" ON "metal_stock_movements"("type");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_jobs_jobCode_key" ON "jewellery_jobs"("jobCode");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_jobs_wipVoucherId_key" ON "jewellery_jobs"("wipVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_jobs_idempotencyKey_key" ON "jewellery_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "jewellery_jobs_karigarId_idx" ON "jewellery_jobs"("karigarId");

-- CreateIndex
CREATE INDEX "jewellery_jobs_customerId_idx" ON "jewellery_jobs"("customerId");

-- CreateIndex
CREATE INDEX "jewellery_jobs_status_idx" ON "jewellery_jobs"("status");

-- CreateIndex
CREATE INDEX "jewellery_metal_issue_lines_jobId_idx" ON "jewellery_metal_issue_lines"("jobId");

-- CreateIndex
CREATE INDEX "jewellery_diamond_issue_lines_jobId_idx" ON "jewellery_diamond_issue_lines"("jobId");

-- CreateIndex
CREATE INDEX "jewellery_diamond_issue_lines_polishedDiamondId_idx" ON "jewellery_diamond_issue_lines"("polishedDiamondId");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_diamond_issue_lines_jobId_polishedDiamondId_key" ON "jewellery_diamond_issue_lines"("jobId", "polishedDiamondId");

-- CreateIndex
CREATE INDEX "jewellery_other_material_lines_jobId_idx" ON "jewellery_other_material_lines"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_receipts_receiptCode_key" ON "jewellery_receipts"("receiptCode");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_receipts_postingVoucherId_key" ON "jewellery_receipts"("postingVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_receipts_idempotencyKey_key" ON "jewellery_receipts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "jewellery_receipts_jobId_idx" ON "jewellery_receipts"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_finishedCode_key" ON "finished_jewellery"("finishedCode");

-- CreateIndex
CREATE INDEX "finished_jewellery_jobId_idx" ON "finished_jewellery"("jobId");

-- CreateIndex
CREATE INDEX "finished_jewellery_receiptId_idx" ON "finished_jewellery"("receiptId");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_sequences_sequenceType_yearLabel_key" ON "jewellery_sequences"("sequenceType", "yearLabel");

-- AddForeignKey
ALTER TABLE "polished_diamonds" ADD CONSTRAINT "polished_diamonds_damagedLostByUserId_fkey" FOREIGN KEY ("damagedLostByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_jewelleryJobId_fkey" FOREIGN KEY ("jewelleryJobId") REFERENCES "jewellery_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_purities" ADD CONSTRAINT "metal_purities_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_purities" ADD CONSTRAINT "metal_purities_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_purchases" ADD CONSTRAINT "metal_purchases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_purchases" ADD CONSTRAINT "metal_purchases_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_purchases" ADD CONSTRAINT "metal_purchases_gstRateId_fkey" FOREIGN KEY ("gstRateId") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_purchases" ADD CONSTRAINT "metal_purchases_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_purchases" ADD CONSTRAINT "metal_purchases_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_jewelleryJobId_fkey" FOREIGN KEY ("jewelleryJobId") REFERENCES "jewellery_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_reversalOfMovementId_fkey" FOREIGN KEY ("reversalOfMovementId") REFERENCES "metal_stock_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_jobs" ADD CONSTRAINT "jewellery_jobs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_jobs" ADD CONSTRAINT "jewellery_jobs_karigarId_fkey" FOREIGN KEY ("karigarId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_jobs" ADD CONSTRAINT "jewellery_jobs_targetPurityId_fkey" FOREIGN KEY ("targetPurityId") REFERENCES "metal_purities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_jobs" ADD CONSTRAINT "jewellery_jobs_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_jobs" ADD CONSTRAINT "jewellery_jobs_wipVoucherId_fkey" FOREIGN KEY ("wipVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_jobs" ADD CONSTRAINT "jewellery_jobs_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_metal_issue_lines" ADD CONSTRAINT "jewellery_metal_issue_lines_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_metal_issue_lines" ADD CONSTRAINT "jewellery_metal_issue_lines_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_diamond_issue_lines" ADD CONSTRAINT "jewellery_diamond_issue_lines_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_diamond_issue_lines" ADD CONSTRAINT "jewellery_diamond_issue_lines_polishedDiamondId_fkey" FOREIGN KEY ("polishedDiamondId") REFERENCES "polished_diamonds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_diamond_issue_lines" ADD CONSTRAINT "jewellery_diamond_issue_lines_setInFinishedJewelleryId_fkey" FOREIGN KEY ("setInFinishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_other_material_lines" ADD CONSTRAINT "jewellery_other_material_lines_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_other_material_lines" ADD CONSTRAINT "jewellery_other_material_lines_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_receipts" ADD CONSTRAINT "jewellery_receipts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_receipts" ADD CONSTRAINT "jewellery_receipts_postingVoucherId_fkey" FOREIGN KEY ("postingVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_receipts" ADD CONSTRAINT "jewellery_receipts_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery" ADD CONSTRAINT "finished_jewellery_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "jewellery_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery" ADD CONSTRAINT "finished_jewellery_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery" ADD CONSTRAINT "finished_jewellery_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery" ADD CONSTRAINT "finished_jewellery_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
