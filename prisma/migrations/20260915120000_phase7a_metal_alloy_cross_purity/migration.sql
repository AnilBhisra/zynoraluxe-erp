-- Phase 7 (tier P0) — Copper/Alloy metal stock, 24K → lower-karat
-- finished outputs, and receipt cost fields. Forward-only and purely
-- additive: one enum value, and new columns that are either nullable or
-- NOT NULL with DEFAULT 0, so every existing row keeps its current values.
-- No DROP / TRUNCATE / DELETE / ALTER COLUMN / RENAME.
--
-- Generated with `prisma migrate diff --from-schema <HEAD schema>
-- --to-schema prisma/schema.prisma --script` and reviewed by hand.

-- AlterEnum
ALTER TYPE "MetalType" ADD VALUE 'ALLOY';

-- AlterTable
ALTER TABLE "jewellery_jobs" ADD COLUMN     "consumedAlloyGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "issuedAlloyCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "issuedAlloyGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "remainingAlloyWipCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "returnedAlloyGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "jewellery_receipts" ADD COLUMN     "alloyLossGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "companyAlloyCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "companyAlloyGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "includedAlloyGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "karigarAlloyCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "karigarAlloyGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "returnedAlloyGrossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "unabsorbedCost" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "finished_jewellery" ADD COLUMN     "alloyAddedWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "alloyCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "sourceFinenessPercentSnapshot" DECIMAL(6,3),
ADD COLUMN     "sourcePurityDisplayNameSnapshot" TEXT;
