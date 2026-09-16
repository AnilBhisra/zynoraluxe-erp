-- Phase 7 (tier P1) — Direct Polished Diamond Purchase, Dalal/Broker and
-- polished packet stock. Forward-only and purely additive: new enum values,
-- new enums, new tables, and new columns that are nullable or NOT NULL with
-- DEFAULT. No DROP / TRUNCATE / DELETE / ALTER COLUMN / RENAME.
--
-- Generated with `prisma migrate diff --from-schema <previous schema>
-- --to-schema prisma/schema.prisma --script` and reviewed by hand.

-- CreateEnum
CREATE TYPE "PolishedRateBasis" AS ENUM ('PER_CARAT', 'PER_PIECE', 'FIXED_TOTAL');

-- CreateEnum
CREATE TYPE "BrokerageMethod" AS ENUM ('PER_CARAT', 'PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "BrokerageTreatment" AS ENUM ('NONE', 'INCLUDED_IN_SUPPLIER_COST', 'CAPITALISED_PAYABLE_TO_BROKER', 'EXPENSED_PAYABLE_TO_BROKER');

-- CreateEnum
CREATE TYPE "PolishedProvenance" AS ENUM ('PURCHASED', 'MANUFACTURED_FROM_ROUGH', 'RETURNED_FROM_JOB', 'ADJUSTMENT', 'UNKNOWN_LEGACY');

-- CreateEnum
CREATE TYPE "PolishedPacketStatus" AS ENUM ('ACTIVE', 'EMPTY', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PolishedPacketMovementType" AS ENUM ('PURCHASE_IN', 'PURCHASE_CANCEL_OUT', 'PROCESS_ISSUE_OUT', 'PROCESS_ISSUE_CANCEL_IN', 'PROCESS_RETURN_IN', 'JEWELLERY_ISSUE_OUT', 'JEWELLERY_ISSUE_CANCEL_IN', 'JEWELLERY_RETURN_IN', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PartyType" ADD VALUE 'BROKER';
ALTER TYPE "PartyType" ADD VALUE 'MANUFACTURER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DiamondSequenceType" ADD VALUE 'POLISHED_PURCHASE';
ALTER TYPE "DiamondSequenceType" ADD VALUE 'POLISHED_PACKET';

-- AlterTable
ALTER TABLE "jewellery_jobs" ADD COLUMN     "issuedPacketDiamondCost" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "polished_purchases" (
    "id" TEXT NOT NULL,
    "purchaseCode" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "supplierId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "exchangeRate" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "supplierAmount" DECIMAL(14,2) NOT NULL,
    "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'NONE',
    "gstRateId" TEXT,
    "gstRatePercent" DECIMAL(5,2),
    "brokerPartyId" TEXT,
    "brokerNameSnapshot" TEXT,
    "brokerageMethod" "BrokerageMethod",
    "brokerageRate" DECIMAL(14,4),
    "brokerageAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "brokerageTreatment" "BrokerageTreatment" NOT NULL DEFAULT 'NONE',
    "landedCost" DECIMAL(14,2) NOT NULL,
    "paymentAccountId" TEXT,
    "referenceNumber" TEXT,
    "notes" TEXT,
    "voucherId" TEXT,
    "status" "VoucherStatus" NOT NULL DEFAULT 'POSTED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "cancellationVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "polished_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polished_purchase_lines" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "shape" "DiamondShape" NOT NULL,
    "customShapeName" TEXT,
    "sizeLabel" TEXT NOT NULL,
    "measurements" TEXT,
    "pieces" INTEGER NOT NULL,
    "carat" DECIMAL(10,3) NOT NULL,
    "quality" TEXT,
    "colour" TEXT,
    "lab" TEXT,
    "certificateStatus" "CertificateStatus" NOT NULL DEFAULT 'NOT_CERTIFIED',
    "certNumber" TEXT,
    "certFileAssetId" TEXT,
    "photoAssetId" TEXT,
    "rateBasis" "PolishedRateBasis" NOT NULL DEFAULT 'PER_CARAT',
    "rate" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "landedCost" DECIMAL(14,2) NOT NULL,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "polished_purchase_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polished_packets" (
    "id" TEXT NOT NULL,
    "packetCode" TEXT NOT NULL,
    "provenance" "PolishedProvenance" NOT NULL,
    "mergeKey" TEXT NOT NULL,
    "shape" "DiamondShape" NOT NULL,
    "customShapeName" TEXT,
    "sizeLabel" TEXT NOT NULL,
    "measurements" TEXT,
    "quality" TEXT,
    "colour" TEXT,
    "lab" TEXT,
    "certificateStatus" "CertificateStatus" NOT NULL DEFAULT 'NOT_CERTIFIED',
    "certNumber" TEXT,
    "certFileAssetId" TEXT,
    "photoAssetId" TEXT,
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "purchaseLineId" TEXT,
    "parentPacketId" TEXT,
    "status" "PolishedPacketStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "polished_packets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "polished_packet_movements" (
    "id" TEXT NOT NULL,
    "type" "PolishedPacketMovementType" NOT NULL,
    "packetId" TEXT NOT NULL,
    "pieces" INTEGER NOT NULL,
    "carat" DECIMAL(10,3) NOT NULL,
    "costValue" DECIMAL(14,2) NOT NULL,
    "sourceDocument" TEXT NOT NULL,
    "jewelleryJobId" TEXT,
    "reversalOfMovementId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "polished_packet_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_packet_issue_lines" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "packetId" TEXT NOT NULL,
    "piecesAtIssue" INTEGER NOT NULL,
    "caratAtIssue" DECIMAL(10,3) NOT NULL,
    "costAtIssue" DECIMAL(14,2) NOT NULL,
    "setPieces" INTEGER NOT NULL DEFAULT 0,
    "setCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "setCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "returnedPieces" INTEGER NOT NULL DEFAULT 0,
    "returnedCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "returnedCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "damagedPieces" INTEGER NOT NULL DEFAULT 0,
    "damagedCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "damagedCost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jewellery_packet_issue_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_packet_resolutions" (
    "id" TEXT NOT NULL,
    "issueLineId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "disposition" "JewelleryDiamondResolution" NOT NULL,
    "pieces" INTEGER NOT NULL,
    "carat" DECIMAL(10,3) NOT NULL,
    "costValue" DECIMAL(14,2) NOT NULL,
    "setInFinishedJewelleryId" TEXT,
    "resultPacketId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jewellery_packet_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "polished_purchases_purchaseCode_key" ON "polished_purchases"("purchaseCode");

-- CreateIndex
CREATE UNIQUE INDEX "polished_purchases_voucherId_key" ON "polished_purchases"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "polished_purchases_cancellationVoucherId_key" ON "polished_purchases"("cancellationVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "polished_purchases_idempotencyKey_key" ON "polished_purchases"("idempotencyKey");

-- CreateIndex
CREATE INDEX "polished_purchases_supplierId_idx" ON "polished_purchases"("supplierId");

-- CreateIndex
CREATE INDEX "polished_purchases_brokerPartyId_idx" ON "polished_purchases"("brokerPartyId");

-- CreateIndex
CREATE INDEX "polished_purchases_purchaseDate_idx" ON "polished_purchases"("purchaseDate");

-- CreateIndex
CREATE INDEX "polished_purchase_lines_purchaseId_idx" ON "polished_purchase_lines"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "polished_packets_packetCode_key" ON "polished_packets"("packetCode");

-- CreateIndex
CREATE UNIQUE INDEX "polished_packets_purchaseLineId_key" ON "polished_packets"("purchaseLineId");

-- CreateIndex
CREATE INDEX "polished_packets_mergeKey_idx" ON "polished_packets"("mergeKey");

-- CreateIndex
CREATE INDEX "polished_packets_status_idx" ON "polished_packets"("status");

-- CreateIndex
CREATE INDEX "polished_packets_provenance_idx" ON "polished_packets"("provenance");

-- CreateIndex
CREATE UNIQUE INDEX "polished_packet_movements_reversalOfMovementId_key" ON "polished_packet_movements"("reversalOfMovementId");

-- CreateIndex
CREATE INDEX "polished_packet_movements_packetId_idx" ON "polished_packet_movements"("packetId");

-- CreateIndex
CREATE INDEX "polished_packet_movements_type_idx" ON "polished_packet_movements"("type");

-- CreateIndex
CREATE INDEX "polished_packet_movements_jewelleryJobId_idx" ON "polished_packet_movements"("jewelleryJobId");

-- CreateIndex
CREATE INDEX "jewellery_packet_issue_lines_jobId_idx" ON "jewellery_packet_issue_lines"("jobId");

-- CreateIndex
CREATE INDEX "jewellery_packet_issue_lines_packetId_idx" ON "jewellery_packet_issue_lines"("packetId");

-- CreateIndex
CREATE UNIQUE INDEX "jewellery_packet_issue_lines_jobId_packetId_key" ON "jewellery_packet_issue_lines"("jobId", "packetId");

-- CreateIndex
CREATE INDEX "jewellery_packet_resolutions_issueLineId_idx" ON "jewellery_packet_resolutions"("issueLineId");

-- CreateIndex
CREATE INDEX "jewellery_packet_resolutions_receiptId_idx" ON "jewellery_packet_resolutions"("receiptId");

-- AddForeignKey
ALTER TABLE "polished_purchases" ADD CONSTRAINT "polished_purchases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_purchases" ADD CONSTRAINT "polished_purchases_gstRateId_fkey" FOREIGN KEY ("gstRateId") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_purchases" ADD CONSTRAINT "polished_purchases_brokerPartyId_fkey" FOREIGN KEY ("brokerPartyId") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_purchases" ADD CONSTRAINT "polished_purchases_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_purchases" ADD CONSTRAINT "polished_purchases_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_purchases" ADD CONSTRAINT "polished_purchases_cancellationVoucherId_fkey" FOREIGN KEY ("cancellationVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_purchases" ADD CONSTRAINT "polished_purchases_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_purchase_lines" ADD CONSTRAINT "polished_purchase_lines_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "polished_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_packets" ADD CONSTRAINT "polished_packets_purchaseLineId_fkey" FOREIGN KEY ("purchaseLineId") REFERENCES "polished_purchase_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_packets" ADD CONSTRAINT "polished_packets_parentPacketId_fkey" FOREIGN KEY ("parentPacketId") REFERENCES "polished_packets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_packets" ADD CONSTRAINT "polished_packets_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_packet_movements" ADD CONSTRAINT "polished_packet_movements_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "polished_packets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_packet_movements" ADD CONSTRAINT "polished_packet_movements_jewelleryJobId_fkey" FOREIGN KEY ("jewelleryJobId") REFERENCES "jewellery_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_packet_movements" ADD CONSTRAINT "polished_packet_movements_reversalOfMovementId_fkey" FOREIGN KEY ("reversalOfMovementId") REFERENCES "polished_packet_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "polished_packet_movements" ADD CONSTRAINT "polished_packet_movements_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_packet_issue_lines" ADD CONSTRAINT "jewellery_packet_issue_lines_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_packet_issue_lines" ADD CONSTRAINT "jewellery_packet_issue_lines_packetId_fkey" FOREIGN KEY ("packetId") REFERENCES "polished_packets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_packet_resolutions" ADD CONSTRAINT "jewellery_packet_resolutions_issueLineId_fkey" FOREIGN KEY ("issueLineId") REFERENCES "jewellery_packet_issue_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_packet_resolutions" ADD CONSTRAINT "jewellery_packet_resolutions_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "jewellery_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_packet_resolutions" ADD CONSTRAINT "jewellery_packet_resolutions_setInFinishedJewelleryId_fkey" FOREIGN KEY ("setInFinishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-added integrity constraints (not expressible in schema.prisma) —
-- same defence-in-depth pattern as the Phase 2 journal-line CHECK.
ALTER TABLE "polished_purchases" ADD CONSTRAINT "polished_purchases_amounts_chk"
  CHECK ("supplierAmount" > 0 AND "landedCost" > 0 AND "brokerageAmount" >= 0);

ALTER TABLE "polished_purchase_lines" ADD CONSTRAINT "polished_purchase_lines_quantities_chk"
  CHECK ("pieces" > 0 AND "carat" > 0 AND "landedCost" >= 0 AND "rate" >= 0);

ALTER TABLE "polished_packet_movements" ADD CONSTRAINT "polished_packet_movements_magnitudes_chk"
  CHECK ("pieces" >= 0 AND "carat" >= 0 AND "costValue" >= 0 AND ("pieces" > 0 OR "carat" > 0));

ALTER TABLE "jewellery_packet_issue_lines" ADD CONSTRAINT "jewellery_packet_issue_lines_quantities_chk"
  CHECK ("piecesAtIssue" > 0 AND "caratAtIssue" > 0 AND "costAtIssue" >= 0
     AND "setPieces" >= 0 AND "returnedPieces" >= 0 AND "damagedPieces" >= 0
     AND "setCarat" >= 0 AND "returnedCarat" >= 0 AND "damagedCarat" >= 0);

ALTER TABLE "jewellery_packet_resolutions" ADD CONSTRAINT "jewellery_packet_resolutions_magnitudes_chk"
  CHECK ("pieces" >= 0 AND "carat" >= 0 AND "costValue" >= 0 AND ("pieces" > 0 OR "carat" > 0));
