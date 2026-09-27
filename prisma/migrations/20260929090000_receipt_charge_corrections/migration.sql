-- Additive only: one new enum value and two new tables. No existing row or column is touched.

-- AlterEnum
ALTER TYPE "CorrectionMode" ADD VALUE 'ADD_CHARGES';

-- CreateTable
CREATE TABLE "jewellery_receipt_charge_corrections" (
    "id" TEXT NOT NULL,
    "correctionId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "labourCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "makingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "settingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherExpense" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCharge" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jewellery_receipt_charge_corrections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_receipt_charge_correction_lines" (
    "id" TEXT NOT NULL,
    "chargeCorrectionId" TEXT NOT NULL,
    "finishedJewelleryId" TEXT NOT NULL,
    "labourCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "makingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "settingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "platingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherExpense" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalCharge" DECIMAL(14,2) NOT NULL,
    "oldLabourAllocated" DECIMAL(14,2) NOT NULL,
    "newLabourAllocated" DECIMAL(14,2) NOT NULL,
    "oldTotalCost" DECIMAL(14,2) NOT NULL,
    "newTotalCost" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "jewellery_receipt_charge_correction_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_receipt_charge_corrections_correctionId_key" ON "jewellery_receipt_charge_corrections"("correctionId");

-- CreateIndex
CREATE INDEX "jewellery_receipt_charge_corrections_receiptId_idx" ON "jewellery_receipt_charge_corrections"("receiptId");

-- CreateIndex
CREATE INDEX "jewellery_receipt_charge_corrections_jobId_idx" ON "jewellery_receipt_charge_corrections"("jobId");

-- CreateIndex
CREATE INDEX "jrccl_chargeCorrectionId_idx" ON "jewellery_receipt_charge_correction_lines"("chargeCorrectionId");

-- CreateIndex
CREATE INDEX "jrccl_finishedJewelleryId_idx" ON "jewellery_receipt_charge_correction_lines"("finishedJewelleryId");

-- AddForeignKey
ALTER TABLE "jewellery_receipt_charge_corrections" ADD CONSTRAINT "jewellery_receipt_charge_corrections_correctionId_fkey" FOREIGN KEY ("correctionId") REFERENCES "corrections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_receipt_charge_corrections" ADD CONSTRAINT "jewellery_receipt_charge_corrections_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "jewellery_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_receipt_charge_corrections" ADD CONSTRAINT "jewellery_receipt_charge_corrections_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_receipt_charge_correction_lines" ADD CONSTRAINT "jrccl_chargeCorrectionId_fkey" FOREIGN KEY ("chargeCorrectionId") REFERENCES "jewellery_receipt_charge_corrections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_receipt_charge_correction_lines" ADD CONSTRAINT "jrccl_finishedJewelleryId_fkey" FOREIGN KEY ("finishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
