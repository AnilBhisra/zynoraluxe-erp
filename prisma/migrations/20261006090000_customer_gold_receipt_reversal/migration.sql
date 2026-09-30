-- Customer Gold receipt reversal (CUSTOMER_GOLD_DESIGN.md §2.6). Additive only:
-- two enum values, nullable columns on jewellery_receipts and
-- jewellery_packet_resolutions, two unique indexes and two foreign keys. No
-- existing row, column type or constraint is changed and nothing is backfilled:
-- every existing receipt keeps reversalSnapshot NULL and is never reversible here.

-- AlterEnum
ALTER TYPE "FinishedJewelleryStockStatus" ADD VALUE IF NOT EXISTS 'RECEIPT_REVERSED';

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'JEWELLERY_RECEIPT_REVERSAL_IN';

-- AlterTable
ALTER TABLE "jewellery_packet_resolutions" ADD COLUMN     "reversedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "jewellery_receipts" ADD COLUMN     "reversalIdempotencyKey" TEXT,
ADD COLUMN     "reversalReason" TEXT,
ADD COLUMN     "reversalSnapshot" JSONB,
ADD COLUMN     "reversalVoucherId" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3),
ADD COLUMN     "reversedByUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_receipts_reversalVoucherId_key" ON "jewellery_receipts"("reversalVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_receipts_reversalIdempotencyKey_key" ON "jewellery_receipts"("reversalIdempotencyKey");

-- AddForeignKey
ALTER TABLE "jewellery_receipts" ADD CONSTRAINT "jewellery_receipts_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_receipts" ADD CONSTRAINT "jewellery_receipts_reversalVoucherId_fkey" FOREIGN KEY ("reversalVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

