-- Phase 7 (tier P2) — Manufacturer processes (4P / Laser, HPHT / Grow,
-- Polishing, Rough Polish) on Diamond Jobs, and Job Manufacturer packet
-- process jobs. Forward-only and purely additive: new enum values, new
-- enums, new tables, and new nullable or defaulted columns. No DROP /
-- TRUNCATE / DELETE / ALTER COLUMN / RENAME. Process master rows are
-- seeded idempotently by prisma/seed.ts and scripts/seedPhase7Masters.ts,
-- never by this migration.
--
-- Generated with `prisma migrate diff --from-schema <previous schema>
-- --to-schema prisma/schema.prisma --script` and reviewed by hand.

-- CreateEnum
CREATE TYPE "DiamondProcessOutputKind" AS ENUM ('ROUGH', 'POLISHED');

-- CreateEnum
CREATE TYPE "ProcessChargeRateBasis" AS ENUM ('FIXED', 'PER_CARAT', 'PER_PIECE');

-- CreateEnum
CREATE TYPE "PacketProcessJobStatus" AS ENUM ('ISSUED', 'PARTIALLY_RETURNED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PacketReturnDisposition" AS ENUM ('RETURNED_TO_STOCK', 'USED_IN_JEWELLERY_JOB', 'DAMAGED_LOST');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DiamondSequenceType" ADD VALUE 'PACKET_PROCESS_JOB';
ALTER TYPE "DiamondSequenceType" ADD VALUE 'PACKET_PROCESS_RECEIPT';

-- AlterTable
ALTER TABLE "diamond_jobs" ADD COLUMN     "chargeRate" DECIMAL(14,4),
ADD COLUMN     "chargeRateBasis" "ProcessChargeRateBasis",
ADD COLUMN     "processId" TEXT,
ADD COLUMN     "processNameSnapshot" TEXT,
ADD COLUMN     "processOutputKindSnapshot" "DiamondProcessOutputKind";

-- AlterTable
ALTER TABLE "polished_packets" ADD COLUMN     "sourcePacketProcessJobId" TEXT;

-- AlterTable
ALTER TABLE "polished_packet_movements" ADD COLUMN     "packetProcessJobId" TEXT;

-- AlterTable
ALTER TABLE "jewellery_packet_issue_lines" ADD COLUMN     "sourcePacketProcessReceiptLineId" TEXT;

-- CreateTable
CREATE TABLE "diamond_processes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "outputKind" "DiamondProcessOutputKind" NOT NULL,
    "defaultRateBasis" "ProcessChargeRateBasis" NOT NULL DEFAULT 'PER_CARAT',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "diamond_processes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packet_process_jobs" (
    "id" TEXT NOT NULL,
    "jobCode" TEXT NOT NULL,
    "manufacturerId" TEXT NOT NULL,
    "processId" TEXT NOT NULL,
    "processNameSnapshot" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3),
    "notes" TEXT,
    "issuedPieces" INTEGER NOT NULL,
    "issuedCarat" DECIMAL(10,3) NOT NULL,
    "issuedCostValue" DECIMAL(14,2) NOT NULL,
    "returnedPieces" INTEGER NOT NULL DEFAULT 0,
    "returnedCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "usedPieces" INTEGER NOT NULL DEFAULT 0,
    "usedCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "damagedPieces" INTEGER NOT NULL DEFAULT 0,
    "damagedCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "lossCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "remainingWipCost" DECIMAL(14,2) NOT NULL,
    "chargeRateBasis" "ProcessChargeRateBasis" NOT NULL,
    "chargeRate" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "totalCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "PacketProcessJobStatus" NOT NULL DEFAULT 'ISSUED',
    "wipVoucherId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "packet_process_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packet_process_job_lines" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "packetId" TEXT NOT NULL,
    "piecesAtIssue" INTEGER NOT NULL,
    "caratAtIssue" DECIMAL(10,3) NOT NULL,
    "costAtIssue" DECIMAL(14,2) NOT NULL,
    "resolvedPieces" INTEGER NOT NULL DEFAULT 0,
    "resolvedCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "lossCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "resolvedCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "packet_process_job_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packet_process_receipts" (
    "id" TEXT NOT NULL,
    "receiptCode" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "receiveDate" TIMESTAMP(3) NOT NULL,
    "isFinal" BOOLEAN NOT NULL DEFAULT false,
    "lossCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "isAbnormalLoss" BOOLEAN NOT NULL DEFAULT false,
    "abnormalLossReason" TEXT,
    "processCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "postingVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "packet_process_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "packet_process_receipt_lines" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "jobLineId" TEXT NOT NULL,
    "disposition" "PacketReturnDisposition" NOT NULL,
    "pieces" INTEGER NOT NULL,
    "carat" DECIMAL(10,3) NOT NULL,
    "sizeLabel" TEXT NOT NULL,
    "costValue" DECIMAL(14,2) NOT NULL,
    "chargeShare" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "resultPacketId" TEXT,
    "jewelleryJobId" TEXT,
    "damagedLostReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "packet_process_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "diamond_processes_name_key" ON "diamond_processes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "packet_process_jobs_jobCode_key" ON "packet_process_jobs"("jobCode");

-- CreateIndex
CREATE UNIQUE INDEX "packet_process_jobs_wipVoucherId_key" ON "packet_process_jobs"("wipVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "packet_process_jobs_idempotencyKey_key" ON "packet_process_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "packet_process_jobs_manufacturerId_idx" ON "packet_process_jobs"("manufacturerId");

-- CreateIndex
CREATE INDEX "packet_process_jobs_status_idx" ON "packet_process_jobs"("status");

-- CreateIndex
CREATE INDEX "packet_process_job_lines_packetId_idx" ON "packet_process_job_lines"("packetId");

-- CreateIndex
CREATE UNIQUE INDEX "packet_process_job_lines_jobId_packetId_key" ON "packet_process_job_lines"("jobId", "packetId");

-- CreateIndex
CREATE UNIQUE INDEX "packet_process_receipts_receiptCode_key" ON "packet_process_receipts"("receiptCode");

-- CreateIndex
CREATE UNIQUE INDEX "packet_process_receipts_postingVoucherId_key" ON "packet_process_receipts"("postingVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "packet_process_receipts_idempotencyKey_key" ON "packet_process_receipts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "packet_process_receipts_jobId_idx" ON "packet_process_receipts"("jobId");

-- CreateIndex
CREATE INDEX "packet_process_receipt_lines_receiptId_idx" ON "packet_process_receipt_lines"("receiptId");

-- CreateIndex
CREATE INDEX "packet_process_receipt_lines_jobLineId_idx" ON "packet_process_receipt_lines"("jobLineId");

-- CreateIndex
CREATE INDEX "polished_packet_movements_packetProcessJobId_idx" ON "polished_packet_movements"("packetProcessJobId");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_packet_issue_lines_sourcePacketProcessReceiptLine_key" ON "jewellery_packet_issue_lines"("sourcePacketProcessReceiptLineId");

-- AddForeignKey
ALTER TABLE "diamond_jobs" ADD CONSTRAINT "diamond_jobs_processId_fkey" FOREIGN KEY ("processId") REFERENCES "diamond_processes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_packets" ADD CONSTRAINT "polished_packets_sourcePacketProcessJobId_fkey" FOREIGN KEY ("sourcePacketProcessJobId") REFERENCES "packet_process_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_packet_movements" ADD CONSTRAINT "polished_packet_movements_packetProcessJobId_fkey" FOREIGN KEY ("packetProcessJobId") REFERENCES "packet_process_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_packet_issue_lines" ADD CONSTRAINT "jewellery_packet_issue_lines_sourcePacketProcessReceiptLin_fkey" FOREIGN KEY ("sourcePacketProcessReceiptLineId") REFERENCES "packet_process_receipt_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diamond_processes" ADD CONSTRAINT "diamond_processes_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_jobs" ADD CONSTRAINT "packet_process_jobs_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_jobs" ADD CONSTRAINT "packet_process_jobs_processId_fkey" FOREIGN KEY ("processId") REFERENCES "diamond_processes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_jobs" ADD CONSTRAINT "packet_process_jobs_wipVoucherId_fkey" FOREIGN KEY ("wipVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_jobs" ADD CONSTRAINT "packet_process_jobs_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_jobs" ADD CONSTRAINT "packet_process_jobs_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_job_lines" ADD CONSTRAINT "packet_process_job_lines_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "packet_process_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_job_lines" ADD CONSTRAINT "packet_process_job_lines_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "polished_packets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_receipts" ADD CONSTRAINT "packet_process_receipts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "packet_process_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_receipts" ADD CONSTRAINT "packet_process_receipts_postingVoucherId_fkey" FOREIGN KEY ("postingVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_receipts" ADD CONSTRAINT "packet_process_receipts_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_receipt_lines" ADD CONSTRAINT "packet_process_receipt_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "packet_process_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_receipt_lines" ADD CONSTRAINT "packet_process_receipt_lines_jobLineId_fkey" FOREIGN KEY ("jobLineId") REFERENCES "packet_process_job_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_receipt_lines" ADD CONSTRAINT "packet_process_receipt_lines_jewelleryJobId_fkey" FOREIGN KEY ("jewelleryJobId") REFERENCES "jewellery_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---- Hand-added integrity checks (quantities are positive magnitudes) ----

ALTER TABLE "packet_process_jobs" ADD CONSTRAINT "packet_process_jobs_quantities_chk"
  CHECK ("issuedPieces" > 0 AND "issuedCarat" > 0 AND "issuedCostValue" >= 0
     AND "returnedPieces" >= 0 AND "usedPieces" >= 0 AND "damagedPieces" >= 0
     AND "returnedCarat" >= 0 AND "usedCarat" >= 0 AND "damagedCarat" >= 0 AND "lossCarat" >= 0
     AND "remainingWipCost" >= 0 AND "chargeRate" >= 0 AND "totalCharge" >= 0);

ALTER TABLE "packet_process_job_lines" ADD CONSTRAINT "packet_process_job_lines_quantities_chk"
  CHECK ("piecesAtIssue" > 0 AND "caratAtIssue" > 0 AND "costAtIssue" >= 0
     AND "resolvedPieces" >= 0 AND "resolvedPieces" <= "piecesAtIssue"
     AND "resolvedCarat" >= 0 AND "lossCarat" >= 0 AND "resolvedCarat" + "lossCarat" <= "caratAtIssue"
     AND "resolvedCost" >= 0 AND "resolvedCost" <= "costAtIssue");

ALTER TABLE "packet_process_receipt_lines" ADD CONSTRAINT "packet_process_receipt_lines_magnitudes_chk"
  CHECK ("pieces" >= 0 AND "carat" >= 0 AND "costValue" >= 0 AND "chargeShare" >= 0 AND ("pieces" > 0 OR "carat" > 0));

ALTER TABLE "diamond_jobs" ADD CONSTRAINT "diamond_jobs_charge_rate_chk"
  CHECK ("chargeRate" IS NULL OR "chargeRate" >= 0);
