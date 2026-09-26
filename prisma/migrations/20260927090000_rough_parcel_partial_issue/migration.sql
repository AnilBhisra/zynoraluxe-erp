-- Rough parcel partial issue — additive only.
--
-- A rough row is now either an individual STONE or a PARCEL of many stones.
-- Every existing row becomes STONE via the column default, so no historical
-- row is reinterpreted. A parcel can be issued in part: the issued portion is
-- split into a child row linked by "parentPieceId", and cancelling that issue
-- before any receipt merges it back. No DROP, DELETE, UPDATE, RENAME or
-- TRUNCATE; the one NOT NULL column ("kind") carries a constant default, which
-- PostgreSQL applies as metadata without rewriting or touching any row.

-- CreateEnum
CREATE TYPE "RoughPieceKind" AS ENUM ('STONE', 'PARCEL');

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'ROUGH_PARCEL_SPLIT_OUT';
ALTER TYPE "StockMovementType" ADD VALUE 'ROUGH_PARCEL_SPLIT_IN';
ALTER TYPE "StockMovementType" ADD VALUE 'ROUGH_PARCEL_MERGE_OUT';
ALTER TYPE "StockMovementType" ADD VALUE 'ROUGH_PARCEL_MERGE_IN';

-- AlterTable
ALTER TABLE "rough_pieces"
  ADD COLUMN "kind" "RoughPieceKind" NOT NULL DEFAULT 'STONE',
  ADD COLUMN "pieceCount" INTEGER,
  ADD COLUMN "originalCarat" DECIMAL(10,3),
  ADD COLUMN "originalPieceCount" INTEGER,
  ADD COLUMN "originalCost" DECIMAL(14,2),
  ADD COLUMN "parentPieceId" TEXT;

-- CreateIndex
CREATE INDEX "rough_pieces_parentPieceId_idx" ON "rough_pieces"("parentPieceId");

-- AddForeignKey
ALTER TABLE "rough_pieces" ADD CONSTRAINT "rough_pieces_parentPieceId_fkey" FOREIGN KEY ("parentPieceId") REFERENCES "rough_pieces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
