-- Additive only: new enum values, four new nullable/default-0 columns on
-- jewellery_jobs, one new nullable column on jewellery_metal_issue_lines, and
-- one new table. No existing row, column type or constraint is touched.

-- AlterEnum
ALTER TYPE "CorrectionMode" ADD VALUE 'METAL_TRANSFER';

-- AlterEnum
ALTER TYPE "JewellerySequenceType" ADD VALUE 'JEWELLERY_METAL_TRANSFER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MetalStockMovementType" ADD VALUE 'JOB_TRANSFER_OUT';
ALTER TYPE "MetalStockMovementType" ADD VALUE 'JOB_TRANSFER_IN';

-- AlterTable
ALTER TABLE "jewellery_jobs" ADD COLUMN     "statusBeforeNeedsCorrection" "JewelleryJobStatus",
ADD COLUMN     "transferredInCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "transferredInFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "transferredOutCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "transferredOutFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "jewellery_metal_issue_lines" ADD COLUMN     "sourceTransferId" TEXT;

-- CreateTable
CREATE TABLE "jewellery_metal_transfers" (
    "id" TEXT NOT NULL,
    "transferCode" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "sourceJobId" TEXT NOT NULL,
    "destinationJobId" TEXT NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "finenessPercentSnapshot" DECIMAL(6,3) NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL,
    "fineWeight" DECIMAL(10,3) NOT NULL,
    "costValue" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "destinationMetalIssueLineId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jewellery_metal_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_metal_transfers_transferCode_key" ON "jewellery_metal_transfers"("transferCode");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_metal_transfers_correctionId_key" ON "jewellery_metal_transfers"("correctionId");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_metal_transfers_destinationMetalIssueLineId_key" ON "jewellery_metal_transfers"("destinationMetalIssueLineId");

-- CreateIndex
CREATE INDEX "jewellery_metal_transfers_sourceJobId_idx" ON "jewellery_metal_transfers"("sourceJobId");

-- CreateIndex
CREATE INDEX "jewellery_metal_transfers_destinationJobId_idx" ON "jewellery_metal_transfers"("destinationJobId");

-- CreateIndex
CREATE INDEX "jewellery_metal_transfers_metalType_purityId_idx" ON "jewellery_metal_transfers"("metalType", "purityId");

-- CreateIndex
CREATE INDEX "jewellery_metal_issue_lines_sourceTransferId_idx" ON "jewellery_metal_issue_lines"("sourceTransferId");

-- AddForeignKey
ALTER TABLE "jewellery_metal_issue_lines" ADD CONSTRAINT "jewellery_metal_issue_lines_sourceTransferId_fkey" FOREIGN KEY ("sourceTransferId") REFERENCES "jewellery_metal_transfers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_metal_transfers" ADD CONSTRAINT "jewellery_metal_transfers_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_metal_transfers" ADD CONSTRAINT "jewellery_metal_transfers_sourceJobId_fkey" FOREIGN KEY ("sourceJobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_metal_transfers" ADD CONSTRAINT "jewellery_metal_transfers_destinationJobId_fkey" FOREIGN KEY ("destinationJobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_metal_transfers" ADD CONSTRAINT "jewellery_metal_transfers_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_metal_transfers" ADD CONSTRAINT "jewellery_metal_transfers_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

