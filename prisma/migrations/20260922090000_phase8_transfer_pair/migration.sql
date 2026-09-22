-- AlterTable
ALTER TABLE "metal_stock_movements" ADD COLUMN     "transferPairId" TEXT;

-- CreateIndex
CREATE INDEX "metal_stock_movements_transferPairId_idx" ON "metal_stock_movements"("transferPairId");

