-- Polished parcels: partial issue to Jewellery Jobs through the packet ledger.
--
-- Additive only (no DROP, DELETE, UPDATE, RENAME, TRUNCATE, SET NOT NULL, and
-- no existing row is touched). A manufacturing receipt can now record a
-- parcel of many stones as a PolishedPacket (which the packet ledger already
-- lets a Jewellery Job take in part), with lineage back to the Manufacturer
-- job and receipt. An Owner can also convert, with a recorded reason, an
-- existing single-stone row that really is a parcel; that row is retired
-- (status CONVERTED_TO_PARCEL) and is never converted implicitly.

-- AlterEnum
ALTER TYPE "PolishedDiamondStatus" ADD VALUE 'CONVERTED_TO_PARCEL';
ALTER TYPE "StockMovementType" ADD VALUE 'POLISHED_CONVERTED_OUT';
ALTER TYPE "PolishedPacketMovementType" ADD VALUE 'MANUFACTURE_IN';
ALTER TYPE "PolishedPacketMovementType" ADD VALUE 'CONVERSION_IN';

-- AlterTable
ALTER TABLE "polished_diamonds"
  ADD COLUMN "convertedAt" TIMESTAMP(3),
  ADD COLUMN "convertedByUserId" TEXT,
  ADD COLUMN "convertedReason" TEXT;

-- AlterTable
ALTER TABLE "polished_packets"
  ADD COLUMN "sourceDiamondJobId" TEXT,
  ADD COLUMN "sourceReceiptId" TEXT,
  ADD COLUMN "convertedFromPolishedDiamondId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "polished_packets_convertedFromPolishedDiamondId_key" ON "polished_packets"("convertedFromPolishedDiamondId");
CREATE INDEX "polished_packets_sourceDiamondJobId_idx" ON "polished_packets"("sourceDiamondJobId");
CREATE INDEX "polished_packets_sourceReceiptId_idx" ON "polished_packets"("sourceReceiptId");

-- AddForeignKey
ALTER TABLE "polished_diamonds" ADD CONSTRAINT "polished_diamonds_convertedByUserId_fkey" FOREIGN KEY ("convertedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "polished_packets" ADD CONSTRAINT "polished_packets_sourceDiamondJobId_fkey" FOREIGN KEY ("sourceDiamondJobId") REFERENCES "diamond_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "polished_packets" ADD CONSTRAINT "polished_packets_sourceReceiptId_fkey" FOREIGN KEY ("sourceReceiptId") REFERENCES "polished_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "polished_packets" ADD CONSTRAINT "polished_packets_convertedFromPolishedDiamondId_fkey" FOREIGN KEY ("convertedFromPolishedDiamondId") REFERENCES "polished_diamonds"("id") ON DELETE SET NULL ON UPDATE CASCADE;
