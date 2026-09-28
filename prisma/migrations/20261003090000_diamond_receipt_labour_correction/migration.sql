-- Audited Manufacturer receipt labour correction — additive only.
--
-- Lets an Owner raise a Manufacturer (diamond) receipt's labour after it was
-- posted (e.g. re-priced per issued carat), through the corrections
-- framework: two new enum values and one new table. No existing row, receipt
-- or voucher changes, so the previous release keeps working on this schema.

-- AlterEnum
ALTER TYPE "CorrectionEntityType" ADD VALUE 'DIAMOND_RECEIPT';

-- AlterEnum
ALTER TYPE "CorrectionMode" ADD VALUE 'ADD_MANUFACTURER_LABOUR';

-- CreateTable
CREATE TABLE "diamond_receipt_labour_corrections" (
    "id" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "previousLabour" DECIMAL(14,2) NOT NULL,
    "addedLabour" DECIMAL(14,2) NOT NULL,
    "correctedLabour" DECIMAL(14,2) NOT NULL,
    "lines" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diamond_receipt_labour_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diamond_receipt_labour_corrections_correctionId_key" ON "diamond_receipt_labour_corrections"("correctionId");

-- CreateIndex
CREATE INDEX "diamond_receipt_labour_corrections_receiptId_idx" ON "diamond_receipt_labour_corrections"("receiptId");

-- CreateIndex
CREATE INDEX "diamond_receipt_labour_corrections_jobId_idx" ON "diamond_receipt_labour_corrections"("jobId");

-- AddForeignKey
ALTER TABLE "diamond_receipt_labour_corrections" ADD CONSTRAINT "diamond_receipt_labour_corrections_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_receipt_labour_corrections" ADD CONSTRAINT "diamond_receipt_labour_corrections_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "polished_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_receipt_labour_corrections" ADD CONSTRAINT "diamond_receipt_labour_corrections_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "diamond_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

