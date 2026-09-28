-- Rough stone -> parcel conversion audit trail — additive only.
--
-- An Owner can reclassify a rough row that was bought as a single STONE but is
-- really a parcel of many stones, so it can be issued in part. The SAME row
-- becomes a PARCEL in place; its carat, cost, lot, purchase voucher and
-- purchase movement are untouched. These three nullable columns record who
-- converted it, when and why. No DROP, DELETE, UPDATE, RENAME, TRUNCATE or
-- SET NOT NULL; no existing row is touched, so the previous release keeps
-- working on this schema.

-- AlterTable
ALTER TABLE "rough_pieces" ADD COLUMN     "convertedToParcelAt" TIMESTAMP(3),
ADD COLUMN     "convertedToParcelByUserId" TEXT,
ADD COLUMN     "convertedToParcelReason" TEXT;

-- AddForeignKey
ALTER TABLE "rough_pieces" ADD CONSTRAINT "rough_pieces_convertedToParcelByUserId_fkey" FOREIGN KEY ("convertedToParcelByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
