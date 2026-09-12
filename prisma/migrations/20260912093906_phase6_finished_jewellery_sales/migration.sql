-- CreateEnum
CREATE TYPE "FinishedJewelleryStockStatus" AS ENUM ('AVAILABLE', 'SOLD', 'RETURNED_DAMAGED');

-- CreateEnum
CREATE TYPE "FinishedJewelleryStockMovementType" AS ENUM ('PRODUCED_IN', 'SOLD_OUT', 'SALE_CANCELLED_IN', 'RETURNED_SELLABLE_IN', 'RETURNED_DAMAGED_OUT', 'OWNER_ADJUSTMENT_IN', 'OWNER_ADJUSTMENT_OUT');

-- CreateEnum
CREATE TYPE "FinishedJewellerySaleStatus" AS ENUM ('POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FinishedJewellerySaleLineReturnStatus" AS ENUM ('NONE', 'RETURNED_SELLABLE', 'RETURNED_DAMAGED');

-- CreateEnum
CREATE TYPE "FinishedJewelleryReturnDisposition" AS ENUM ('SELLABLE', 'DAMAGED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JewellerySequenceType" ADD VALUE 'FINISHED_JEWELLERY_SALE';
ALTER TYPE "JewellerySequenceType" ADD VALUE 'FINISHED_JEWELLERY_RETURN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VoucherType" ADD VALUE 'SALE_RETURN';
ALTER TYPE "VoucherType" ADD VALUE 'CUSTOMER_REFUND';

-- AlterTable
ALTER TABLE "finished_jewellery" ADD COLUMN     "status" "FinishedJewelleryStockStatus" NOT NULL DEFAULT 'AVAILABLE';

-- CreateTable
CREATE TABLE "finished_jewellery_stock_movements" (
    "id" TEXT NOT NULL,
    "type" "FinishedJewelleryStockMovementType" NOT NULL,
    "finishedJewelleryId" TEXT NOT NULL,
    "pieces" INTEGER NOT NULL DEFAULT 1,
    "costValue" DECIMAL(14,2) NOT NULL,
    "finishedCodeSnapshot" TEXT NOT NULL,
    "jewelleryTypeSnapshot" "JewelleryType" NOT NULL,
    "metalTypeSnapshot" "MetalType" NOT NULL,
    "purityDisplayNameSnapshot" TEXT NOT NULL,
    "netMetalWeightSnapshot" DECIMAL(10,3) NOT NULL,
    "fineMetalWeightSnapshot" DECIMAL(10,3) NOT NULL,
    "totalCaratSnapshot" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "jobCodeSnapshot" TEXT NOT NULL,
    "saleId" TEXT,
    "returnId" TEXT,
    "sourceDocument" TEXT NOT NULL,
    "reversalOfMovementId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finished_jewellery_stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_jewellery_sales" (
    "id" TEXT NOT NULL,
    "saleCode" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "saleDate" TIMESTAMP(3) NOT NULL,
    "voucherId" TEXT NOT NULL,
    "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'NONE',
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(14,2) NOT NULL,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL,
    "cogsTotal" DECIMAL(14,2) NOT NULL,
    "status" "FinishedJewellerySaleStatus" NOT NULL DEFAULT 'POSTED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "cancellationVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finished_jewellery_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_jewellery_sale_lines" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "finishedJewelleryId" TEXT NOT NULL,
    "itemDescriptionSnapshot" TEXT NOT NULL,
    "sellingPrice" DECIMAL(14,2) NOT NULL,
    "discountShare" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "gstRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "cogsAmount" DECIMAL(14,2) NOT NULL,
    "returnStatus" "FinishedJewellerySaleLineReturnStatus" NOT NULL DEFAULT 'NONE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finished_jewellery_sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_jewellery_returns" (
    "id" TEXT NOT NULL,
    "returnCode" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "returnDate" TIMESTAMP(3) NOT NULL,
    "voucherId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finished_jewellery_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finished_jewellery_return_lines" (
    "id" TEXT NOT NULL,
    "returnId" TEXT NOT NULL,
    "saleLineId" TEXT NOT NULL,
    "disposition" "FinishedJewelleryReturnDisposition" NOT NULL,
    "reversedTaxableValue" DECIMAL(14,2) NOT NULL,
    "reversedTaxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reversedTotal" DECIMAL(14,2) NOT NULL,
    "reversedCogsAmount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finished_jewellery_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_stock_movements_reversalOfMovementId_key" ON "finished_jewellery_stock_movements"("reversalOfMovementId");

-- CreateIndex
CREATE INDEX "finished_jewellery_stock_movements_finishedJewelleryId_idx" ON "finished_jewellery_stock_movements"("finishedJewelleryId");

-- CreateIndex
CREATE INDEX "finished_jewellery_stock_movements_type_idx" ON "finished_jewellery_stock_movements"("type");

-- CreateIndex
CREATE INDEX "finished_jewellery_stock_movements_saleId_idx" ON "finished_jewellery_stock_movements"("saleId");

-- CreateIndex
CREATE INDEX "finished_jewellery_stock_movements_returnId_idx" ON "finished_jewellery_stock_movements"("returnId");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_sales_saleCode_key" ON "finished_jewellery_sales"("saleCode");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_sales_voucherId_key" ON "finished_jewellery_sales"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_sales_cancellationVoucherId_key" ON "finished_jewellery_sales"("cancellationVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_sales_idempotencyKey_key" ON "finished_jewellery_sales"("idempotencyKey");

-- CreateIndex
CREATE INDEX "finished_jewellery_sales_customerId_idx" ON "finished_jewellery_sales"("customerId");

-- CreateIndex
CREATE INDEX "finished_jewellery_sales_status_idx" ON "finished_jewellery_sales"("status");

-- CreateIndex
CREATE INDEX "finished_jewellery_sale_lines_finishedJewelleryId_idx" ON "finished_jewellery_sale_lines"("finishedJewelleryId");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_sale_lines_saleId_finishedJewelleryId_key" ON "finished_jewellery_sale_lines"("saleId", "finishedJewelleryId");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_returns_returnCode_key" ON "finished_jewellery_returns"("returnCode");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_returns_voucherId_key" ON "finished_jewellery_returns"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_returns_idempotencyKey_key" ON "finished_jewellery_returns"("idempotencyKey");

-- CreateIndex
CREATE INDEX "finished_jewellery_returns_saleId_idx" ON "finished_jewellery_returns"("saleId");

-- CreateIndex
CREATE UNIQUE INDEX "finished_jewellery_return_lines_saleLineId_key" ON "finished_jewellery_return_lines"("saleLineId");

-- CreateIndex
CREATE INDEX "finished_jewellery_status_idx" ON "finished_jewellery"("status");

-- AddForeignKey
ALTER TABLE "finished_jewellery_stock_movements" ADD CONSTRAINT "finished_jewellery_stock_movements_finishedJewelleryId_fkey" FOREIGN KEY ("finishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_stock_movements" ADD CONSTRAINT "finished_jewellery_stock_movements_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "finished_jewellery_sales"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_stock_movements" ADD CONSTRAINT "finished_jewellery_stock_movements_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "finished_jewellery_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_stock_movements" ADD CONSTRAINT "finished_jewellery_stock_movements_reversalOfMovementId_fkey" FOREIGN KEY ("reversalOfMovementId") REFERENCES "finished_jewellery_stock_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_stock_movements" ADD CONSTRAINT "finished_jewellery_stock_movements_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_sales" ADD CONSTRAINT "finished_jewellery_sales_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_sales" ADD CONSTRAINT "finished_jewellery_sales_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_sales" ADD CONSTRAINT "finished_jewellery_sales_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_sales" ADD CONSTRAINT "finished_jewellery_sales_cancellationVoucherId_fkey" FOREIGN KEY ("cancellationVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_sales" ADD CONSTRAINT "finished_jewellery_sales_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_sale_lines" ADD CONSTRAINT "finished_jewellery_sale_lines_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "finished_jewellery_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_sale_lines" ADD CONSTRAINT "finished_jewellery_sale_lines_finishedJewelleryId_fkey" FOREIGN KEY ("finishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_returns" ADD CONSTRAINT "finished_jewellery_returns_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "finished_jewellery_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_returns" ADD CONSTRAINT "finished_jewellery_returns_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_returns" ADD CONSTRAINT "finished_jewellery_returns_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_return_lines" ADD CONSTRAINT "finished_jewellery_return_lines_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "finished_jewellery_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery_return_lines" ADD CONSTRAINT "finished_jewellery_return_lines_saleLineId_fkey" FOREIGN KEY ("saleLineId") REFERENCES "finished_jewellery_sale_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
