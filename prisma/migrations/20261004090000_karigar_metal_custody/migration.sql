-- Karigar metal custody. Additive only: one new enum, new enum values, four
-- default-0 columns on jewellery_jobs, nullable columns on
-- jewellery_metal_issue_lines and metal_stock_movements, and one new table.
-- No existing row, column type or constraint is changed, and nothing is
-- converted: existing jobs keep their metal exactly as posted.
-- CreateEnum
CREATE TYPE "KarigarMetalCustodyKind" AS ENUM ('ISSUE_TO_KARIGAR', 'RETURN_TO_STOCK', 'ALLOCATE_TO_JOB', 'RELEASE_FROM_JOB');

-- AlterEnum
ALTER TYPE "JewellerySequenceType" ADD VALUE 'KARIGAR_METAL_CUSTODY';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MetalStockMovementType" ADD VALUE 'KARIGAR_ISSUE_OUT';
ALTER TYPE "MetalStockMovementType" ADD VALUE 'KARIGAR_RETURN_IN';
ALTER TYPE "MetalStockMovementType" ADD VALUE 'CUSTODY_TO_JOB';
ALTER TYPE "MetalStockMovementType" ADD VALUE 'JOB_TO_CUSTODY';

-- AlterTable
ALTER TABLE "jewellery_jobs" ADD COLUMN     "custodyAllocatedCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "custodyAllocatedFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "custodyReleasedCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "custodyReleasedFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "jewellery_metal_issue_lines" ADD COLUMN     "sourceCustodyEntryId" TEXT;

-- AlterTable
ALTER TABLE "metal_stock_movements" ADD COLUMN     "custodyEntryId" TEXT,
ADD COLUMN     "karigarId" TEXT;

-- CreateTable
CREATE TABLE "karigar_metal_custody_entries" (
    "id" TEXT NOT NULL,
    "entryCode" TEXT NOT NULL,
    "kind" "KarigarMetalCustodyKind" NOT NULL,
    "karigarId" TEXT NOT NULL,
    "jobId" TEXT,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "finenessPercentSnapshot" DECIMAL(6,3) NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL,
    "fineWeight" DECIMAL(10,3) NOT NULL,
    "costValue" DECIMAL(14,2) NOT NULL,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "voucherId" TEXT,
    "reversalOfEntryId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "karigar_metal_custody_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "karigar_metal_custody_entries_entryCode_key" ON "karigar_metal_custody_entries"("entryCode");

-- CreateIndex
CREATE UNIQUE INDEX "karigar_metal_custody_entries_voucherId_key" ON "karigar_metal_custody_entries"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "karigar_metal_custody_entries_reversalOfEntryId_key" ON "karigar_metal_custody_entries"("reversalOfEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "karigar_metal_custody_entries_idempotencyKey_key" ON "karigar_metal_custody_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "karigar_metal_custody_entries_karigarId_metalType_purityId_idx" ON "karigar_metal_custody_entries"("karigarId", "metalType", "purityId");

-- CreateIndex
CREATE INDEX "karigar_metal_custody_entries_jobId_idx" ON "karigar_metal_custody_entries"("jobId");

-- CreateIndex
CREATE INDEX "jewellery_metal_issue_lines_sourceCustodyEntryId_idx" ON "jewellery_metal_issue_lines"("sourceCustodyEntryId");

-- CreateIndex
CREATE INDEX "metal_stock_movements_karigarId_metalType_purityId_idx" ON "metal_stock_movements"("karigarId", "metalType", "purityId");

-- CreateIndex
CREATE INDEX "metal_stock_movements_custodyEntryId_idx" ON "metal_stock_movements"("custodyEntryId");

-- AddForeignKey
ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_karigarId_fkey" FOREIGN KEY ("karigarId") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metal_stock_movements" ADD CONSTRAINT "metal_stock_movements_custodyEntryId_fkey" FOREIGN KEY ("custodyEntryId") REFERENCES "karigar_metal_custody_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_metal_issue_lines" ADD CONSTRAINT "jewellery_metal_issue_lines_sourceCustodyEntryId_fkey" FOREIGN KEY ("sourceCustodyEntryId") REFERENCES "karigar_metal_custody_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karigar_metal_custody_entries" ADD CONSTRAINT "karigar_metal_custody_entries_karigarId_fkey" FOREIGN KEY ("karigarId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karigar_metal_custody_entries" ADD CONSTRAINT "karigar_metal_custody_entries_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karigar_metal_custody_entries" ADD CONSTRAINT "karigar_metal_custody_entries_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karigar_metal_custody_entries" ADD CONSTRAINT "karigar_metal_custody_entries_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karigar_metal_custody_entries" ADD CONSTRAINT "karigar_metal_custody_entries_reversalOfEntryId_fkey" FOREIGN KEY ("reversalOfEntryId") REFERENCES "karigar_metal_custody_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karigar_metal_custody_entries" ADD CONSTRAINT "karigar_metal_custody_entries_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

