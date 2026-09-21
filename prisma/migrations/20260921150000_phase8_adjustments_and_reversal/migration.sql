-- AlterEnum
ALTER TYPE "CorrectionMode" ADD VALUE 'REVERSAL';

-- AlterEnum
ALTER TYPE "CorrectionState" ADD VALUE 'REVERSED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "MetalStockMovementType" ADD VALUE 'SCRAP_ADJUSTMENT_IN';
ALTER TYPE "MetalStockMovementType" ADD VALUE 'SCRAP_ADJUSTMENT_OUT';

-- AlterTable
ALTER TABLE "corrections" ADD COLUMN     "reversedByCorrectionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "corrections_reversedByCorrectionId_key" ON "corrections"("reversedByCorrectionId");

-- AddForeignKey
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_reversedByCorrectionId_fkey" FOREIGN KEY ("reversedByCorrectionId") REFERENCES "corrections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

