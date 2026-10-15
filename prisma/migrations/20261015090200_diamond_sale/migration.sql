-- Diamond-only Sale (JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §13). Additive only:
--  * new enum values (ADD VALUE IF NOT EXISTS, none used inside this migration):
--    PolishedDiamondStatus SOLD; StockMovementType POLISHED_SALE_OUT / _CANCEL_IN / _RETURN_IN;
--    PolishedPacketMovementType SALE_OUT / SALE_CANCEL_IN / SALE_RETURN_IN;
--    DiamondSequenceType DIAMOND_SALE / DIAMOND_SALE_RETURN;
--  * enum DiamondSalePricing; 3 new empty tables (diamond_sales, diamond_sale_lines, diamond_sale_returns);
--  * system account 5210 Polished Diamond Cost of Sales, inserted only if missing.
-- No existing row, column or constraint is changed or backfilled.
-- Guard FIRST: account code 5210 must be free or already be exactly this system account.
DO $guard$
DECLARE existing RECORD;
BEGIN
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '5210';
  IF FOUND AND NOT (existing.id = 'sysacct_5210_diamond_cogs' OR (existing.name = 'Polished Diamond Cost of Sales' AND existing.type = 'EXPENSE')) THEN
    RAISE EXCEPTION 'Account code 5210 already exists as "%" (%, id %). Diamond Sale needs 5210 for Polished Diamond Cost of Sales; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_5210_diamond_cogs' AND code <> '5210') THEN
    RAISE EXCEPTION 'Account id sysacct_5210_diamond_cogs already exists under another code. Nothing was changed.';
  END IF;
END
$guard$;

-- CreateEnum
CREATE TYPE "DiamondSalePricing" AS ENUM ('PER_CARAT', 'PER_PIECE', 'FIXED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DiamondSequenceType" ADD VALUE IF NOT EXISTS 'DIAMOND_SALE';
ALTER TYPE "DiamondSequenceType" ADD VALUE IF NOT EXISTS 'DIAMOND_SALE_RETURN';

-- AlterEnum
ALTER TYPE "PolishedDiamondStatus" ADD VALUE IF NOT EXISTS 'SOLD';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PolishedPacketMovementType" ADD VALUE IF NOT EXISTS 'SALE_OUT';
ALTER TYPE "PolishedPacketMovementType" ADD VALUE IF NOT EXISTS 'SALE_CANCEL_IN';
ALTER TYPE "PolishedPacketMovementType" ADD VALUE IF NOT EXISTS 'SALE_RETURN_IN';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'POLISHED_SALE_OUT';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'POLISHED_SALE_CANCEL_IN';
ALTER TYPE "StockMovementType" ADD VALUE IF NOT EXISTS 'POLISHED_SALE_RETURN_IN';

-- CreateTable
CREATE TABLE "diamond_sales" (
    "id" TEXT NOT NULL,
    "saleCode" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "saleDate" TIMESTAMP(3) NOT NULL,
    "gstTreatment" "GstTreatment" NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(14,2) NOT NULL,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL,
    "cogsTotal" DECIMAL(14,2) NOT NULL,
    "voucherId" TEXT NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'POSTED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "cancellationVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diamond_sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diamond_sale_lines" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "polishedDiamondId" TEXT,
    "packetId" TEXT,
    "description" TEXT NOT NULL,
    "pieces" INTEGER NOT NULL,
    "carat" DECIMAL(10,3) NOT NULL,
    "pricing" "DiamondSalePricing" NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "baseAmount" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "gstRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxType" "TaxType" NOT NULL DEFAULT 'EXCLUSIVE',
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "cogsAmount" DECIMAL(14,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "returnId" TEXT,

    CONSTRAINT "diamond_sale_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diamond_sale_returns" (
    "id" TEXT NOT NULL,
    "returnCode" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "returnDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "returnedTotal" DECIMAL(14,2) NOT NULL,
    "voucherId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diamond_sale_returns_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diamond_sales_saleCode_key" ON "diamond_sales"("saleCode");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_sales_voucherId_key" ON "diamond_sales"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_sales_cancellationVoucherId_key" ON "diamond_sales"("cancellationVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_sales_idempotencyKey_key" ON "diamond_sales"("idempotencyKey");

-- CreateIndex
CREATE INDEX "diamond_sales_customerId_idx" ON "diamond_sales"("customerId");

-- CreateIndex
CREATE INDEX "diamond_sales_saleDate_idx" ON "diamond_sales"("saleDate");

-- CreateIndex
CREATE INDEX "diamond_sale_lines_saleId_idx" ON "diamond_sale_lines"("saleId");

-- CreateIndex
CREATE INDEX "diamond_sale_lines_polishedDiamondId_idx" ON "diamond_sale_lines"("polishedDiamondId");

-- CreateIndex
CREATE INDEX "diamond_sale_lines_packetId_idx" ON "diamond_sale_lines"("packetId");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_sale_returns_returnCode_key" ON "diamond_sale_returns"("returnCode");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_sale_returns_voucherId_key" ON "diamond_sale_returns"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "diamond_sale_returns_idempotencyKey_key" ON "diamond_sale_returns"("idempotencyKey");

-- CreateIndex
CREATE INDEX "diamond_sale_returns_saleId_idx" ON "diamond_sale_returns"("saleId");

-- AddForeignKey
ALTER TABLE "diamond_sales" ADD CONSTRAINT "diamond_sales_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sales" ADD CONSTRAINT "diamond_sales_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sales" ADD CONSTRAINT "diamond_sales_cancellationVoucherId_fkey" FOREIGN KEY ("cancellationVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sales" ADD CONSTRAINT "diamond_sales_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sale_lines" ADD CONSTRAINT "diamond_sale_lines_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "diamond_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sale_lines" ADD CONSTRAINT "diamond_sale_lines_polishedDiamondId_fkey" FOREIGN KEY ("polishedDiamondId") REFERENCES "polished_diamonds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sale_lines" ADD CONSTRAINT "diamond_sale_lines_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "polished_packets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sale_lines" ADD CONSTRAINT "diamond_sale_lines_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "diamond_sale_returns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sale_returns" ADD CONSTRAINT "diamond_sale_returns_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "diamond_sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sale_returns" ADD CONSTRAINT "diamond_sale_returns_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_sale_returns" ADD CONSTRAINT "diamond_sale_returns_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A sale line is exactly one stone or part of exactly one packet, with a positive quantity.
ALTER TABLE "diamond_sale_lines" ADD CONSTRAINT "diamond_sale_lines_one_source" CHECK ((("polishedDiamondId" IS NULL) <> ("packetId" IS NULL)) AND "pieces" > 0 AND "carat" > 0);

-- System account (idempotent; the guard above has already refused any conflicting code).
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_5210_diamond_cogs', '5210', 'Polished Diamond Cost of Sales', 'EXPENSE', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
