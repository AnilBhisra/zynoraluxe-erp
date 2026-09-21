-- CreateEnum
CREATE TYPE "CorrectionEntityType" AS ENUM ('VOUCHER', 'PARTY_OPENING_BALANCE', 'METAL_OPENING_STOCK', 'METAL_PURCHASE', 'METAL_ADJUSTMENT', 'ROUGH_LOT', 'POLISHED_PURCHASE', 'POLISHED_PACKET', 'DIAMOND_JOB', 'PACKET_PROCESS_JOB', 'JEWELLERY_JOB', 'JEWELLERY_RECEIPT', 'FINISHED_JEWELLERY', 'FINISHED_JEWELLERY_SALE', 'MASTER_SETTING');

-- CreateEnum
CREATE TYPE "CorrectionMode" AS ENUM ('EDIT_DRAFT', 'REVERSE_REPOST', 'REVALUE');

-- CreateEnum
CREATE TYPE "CorrectionState" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'POSTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CorrectionImpactKind" AS ENUM ('STOCK', 'WIP', 'FINISHED', 'PARTY', 'LEDGER', 'CUSTODY');

-- CreateEnum
CREATE TYPE "MetalRevaluationTarget" AS ENUM ('USABLE_POOL', 'SCRAP_POOL', 'JOB_WIP', 'FINISHED_JEWELLERY');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VoucherType" ADD VALUE 'OPENING_STOCK';
ALTER TYPE "VoucherType" ADD VALUE 'CORRECTION';

-- AlterTable
ALTER TABLE "metal_stock_movements" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "voucherId" TEXT;

-- CreateTable
CREATE TABLE "corrections" (
    "id" TEXT NOT NULL,
    "correctionCode" TEXT NOT NULL,
    "entityType" "CorrectionEntityType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityLabel" TEXT NOT NULL,
    "mode" "CorrectionMode" NOT NULL,
    "state" "CorrectionState" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT NOT NULL,
    "originalSnapshot" JSONB NOT NULL,
    "correctedSnapshot" JSONB NOT NULL,
    "impactPreview" JSONB NOT NULL,
    "preparedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "rejectionReason" TEXT,
    "postedAt" TIMESTAMP(3),
    "correctionVoucherId" TEXT,
    "supersedesCorrectionId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "correction_impacts" (
    "id" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "kind" "CorrectionImpactKind" NOT NULL,
    "tableName" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "recordLabel" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" TEXT NOT NULL,
    "newValue" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "correction_impacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metal_revaluations" (
    "id" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "target" "MetalRevaluationTarget" NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL,
    "fineWeight" DECIMAL(10,3) NOT NULL,
    "oldCostValue" DECIMAL(14,2) NOT NULL,
    "newCostValue" DECIMAL(14,2) NOT NULL,
    "deltaCostValue" DECIMAL(14,2) NOT NULL,
    "jewelleryJobId" TEXT,
    "finishedJewelleryId" TEXT,
    "sourceMovementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metal_revaluations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "corrections_correctionCode_key" ON "corrections"("correctionCode");

-- CreateIndex
CREATE UNIQUE INDEX "corrections_correctionVoucherId_key" ON "corrections"("correctionVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "corrections_supersedesCorrectionId_key" ON "corrections"("supersedesCorrectionId");

-- CreateIndex
CREATE UNIQUE INDEX "corrections_idempotencyKey_key" ON "corrections"("idempotencyKey");

-- CreateIndex
CREATE INDEX "corrections_entityType_entityId_idx" ON "corrections"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "corrections_state_idx" ON "corrections"("state");

-- CreateIndex
CREATE INDEX "correction_impacts_correctionId_idx" ON "correction_impacts"("correctionId");

-- CreateIndex
CREATE INDEX "correction_impacts_tableName_recordId_idx" ON "correction_impacts"("tableName", "recordId");

-- CreateIndex
CREATE INDEX "metal_revaluations_correctionId_idx" ON "metal_revaluations"("correctionId");

-- CreateIndex
CREATE INDEX "metal_revaluations_metalType_purityId_idx" ON "metal_revaluations"("metalType", "purityId");

-- CreateIndex
CREATE UNIQUE INDEX "metal_stock_movements_voucherId_key" ON "metal_stock_movements"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "metal_stock_movements_idempotencyKey_key" ON "metal_stock_movements"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_preparedByUserId_fkey" FOREIGN KEY ("preparedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_correctionVoucherId_fkey" FOREIGN KEY ("correctionVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_supersedesCorrectionId_fkey" FOREIGN KEY ("supersedesCorrectionId") REFERENCES "corrections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_impacts" ADD CONSTRAINT "correction_impacts_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "corrections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_revaluations" ADD CONSTRAINT "metal_revaluations_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "corrections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_revaluations" ADD CONSTRAINT "metal_revaluations_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_revaluations" ADD CONSTRAINT "metal_revaluations_jewelleryJobId_fkey" FOREIGN KEY ("jewelleryJobId") REFERENCES "jewellery_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_revaluations" ADD CONSTRAINT "metal_revaluations_finishedJewelleryId_fkey" FOREIGN KEY ("finishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

