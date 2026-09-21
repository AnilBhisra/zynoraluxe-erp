-- CreateEnum
CREATE TYPE "CorrectionBatchState" AS ENUM ('OPEN', 'COMPLETE');

-- AlterTable
ALTER TABLE "corrections" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "batchStep" INTEGER;

-- CreateTable
CREATE TABLE "correction_batches" (
    "id" TEXT NOT NULL,
    "batchCode" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "requiredSteps" INTEGER NOT NULL,
    "state" "CorrectionBatchState" NOT NULL DEFAULT 'OPEN',
    "completedAt" TIMESTAMP(3),
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "correction_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "correction_batches_batchCode_key" ON "correction_batches"("batchCode");

-- CreateIndex
CREATE UNIQUE INDEX "corrections_batchId_batchStep_key" ON "corrections"("batchId", "batchStep");

-- AddForeignKey
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "correction_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "correction_batches" ADD CONSTRAINT "correction_batches_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

