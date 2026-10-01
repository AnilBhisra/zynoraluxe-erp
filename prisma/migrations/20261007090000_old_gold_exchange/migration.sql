-- Old Gold Exchange (Phase 8C) on top of Customer Gold. Additive only:
--  * customer_gold_receipts.statedPurity — what the Customer claimed, beside the
--    tested/approved purity (nullable; documentation only);
--  * customer_gold_purchases.customerGoldReceiptId — links a one-step exchange
--    to the intake it bought (nullable, unique);
--  * customer_gold_purchases.status + reversal columns — audited Owner reversal.
--    status defaults to 'POSTED', so every existing purchase stays exactly as it
--    is; every other new column is NULL on existing rows.
-- No existing row, column type or constraint is changed and nothing is backfilled.

-- AlterTable
ALTER TABLE "customer_gold_purchases" ADD COLUMN     "customerGoldReceiptId" TEXT,
ADD COLUMN     "reversalIdempotencyKey" TEXT,
ADD COLUMN     "reversalReason" TEXT,
ADD COLUMN     "reversalVoucherId" TEXT,
ADD COLUMN     "reversedAt" TIMESTAMP(3),
ADD COLUMN     "reversedByUserId" TEXT,
ADD COLUMN     "status" "CustomerJewelleryDocStatus" NOT NULL DEFAULT 'POSTED';

-- AlterTable
ALTER TABLE "customer_gold_receipts" ADD COLUMN     "statedPurity" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_purchases_customerGoldReceiptId_key" ON "customer_gold_purchases"("customerGoldReceiptId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_purchases_reversalVoucherId_key" ON "customer_gold_purchases"("reversalVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_purchases_reversalIdempotencyKey_key" ON "customer_gold_purchases"("reversalIdempotencyKey");

-- AddForeignKey
ALTER TABLE "customer_gold_purchases" ADD CONSTRAINT "customer_gold_purchases_customerGoldReceiptId_fkey" FOREIGN KEY ("customerGoldReceiptId") REFERENCES "customer_gold_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_purchases" ADD CONSTRAINT "customer_gold_purchases_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_purchases" ADD CONSTRAINT "customer_gold_purchases_reversalVoucherId_fkey" FOREIGN KEY ("reversalVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
