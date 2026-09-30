-- Customer Gold (CUSTOMER_GOLD_DESIGN.md). Additive only: new enums, new enum
-- values, six new tables, defaulted/nullable columns on jewellery_jobs,
-- finished_jewellery and jewellery_receipts, and one idempotent insert of the
-- system account 1340. No existing row, column type or constraint is changed and
-- nothing is backfilled: every existing piece stays ownership COMPANY.
-- Guard FIRST, before any change: account code 1340 must be free, or already be
-- exactly this system account (same id, or same name and type). Anything else
-- is a conflict and the migration stops here with nothing changed — an
-- existing 1340 is never reused for a different purpose and never modified.
DO $guard$
DECLARE existing RECORD;
BEGIN
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '1340';
  IF FOUND AND NOT (existing.id = 'sysacct_1340_customer_jewellery' OR (existing.name = 'Customer Jewellery Work Awaiting Delivery' AND existing.type = 'ASSET')) THEN
    RAISE EXCEPTION 'Account code 1340 already exists as "%" (%, id %). Customer Gold needs 1340 for Customer Jewellery Work Awaiting Delivery; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_1340_customer_jewellery' AND code <> '1340') THEN
    RAISE EXCEPTION 'Account id sysacct_1340_customer_jewellery already exists under another code. Nothing was changed.';
  END IF;
END
$guard$;

-- CreateEnum
CREATE TYPE "CustomerGoldLocation" AS ENUM ('CUSTOMER', 'SAFE', 'KARIGAR', 'JOB', 'FINISHED', 'DELIVERED', 'RETURNED', 'LOSS', 'SCRAP', 'PURCHASED');

-- CreateEnum
CREATE TYPE "CustomerGoldEntryKind" AS ENUM ('INTAKE', 'ISSUE_TO_KARIGAR', 'RETURN_FROM_KARIGAR', 'ALLOCATE_TO_JOB', 'RELEASE_FROM_JOB', 'CONSUME_TO_FINISHED', 'JOB_RETURN', 'JOB_SCRAP', 'JOB_LOSS', 'RETURN_TO_CUSTOMER', 'SCRAP_RETURN_TO_CUSTOMER', 'DELIVER', 'CONVERT_TO_COMPANY');

-- CreateEnum
CREATE TYPE "CustomerGoldInputBasis" AS ENUM ('GROSS', 'FINE');

-- CreateEnum
CREATE TYPE "CustomerGoldSettlement" AS ENUM ('PAY_CUSTOMER', 'CREDIT_TO_INVOICE');

-- CreateEnum
CREATE TYPE "FinishedJewelleryOwnership" AS ENUM ('COMPANY', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "CustomerJewelleryDocStatus" AS ENUM ('POSTED', 'REVERSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FinishedJewelleryStockStatus" ADD VALUE IF NOT EXISTS 'CUSTOMER_AWAITING_DELIVERY';
ALTER TYPE "FinishedJewelleryStockStatus" ADD VALUE IF NOT EXISTS 'DELIVERED_TO_CUSTOMER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JewellerySequenceType" ADD VALUE IF NOT EXISTS 'CUSTOMER_GOLD_RECEIPT';
ALTER TYPE "JewellerySequenceType" ADD VALUE IF NOT EXISTS 'CUSTOMER_GOLD_ENTRY';
ALTER TYPE "JewellerySequenceType" ADD VALUE IF NOT EXISTS 'CUSTOMER_GOLD_PURCHASE';
ALTER TYPE "JewellerySequenceType" ADD VALUE IF NOT EXISTS 'CUSTOMER_JEWELLERY_BILL';
ALTER TYPE "JewellerySequenceType" ADD VALUE IF NOT EXISTS 'CUSTOMER_JEWELLERY_DELIVERY';

-- AlterTable
ALTER TABLE "finished_jewellery" ADD COLUMN     "customerGoldFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "ownership" "FinishedJewelleryOwnership" NOT NULL DEFAULT 'COMPANY';

-- AlterTable
ALTER TABLE "jewellery_jobs" ADD COLUMN     "customerGoldMixApprovedAt" TIMESTAMP(3),
ADD COLUMN     "customerGoldMixApprovedByUserId" TEXT,
ADD COLUMN     "customerGoldMixReason" TEXT;

-- AlterTable
ALTER TABLE "jewellery_receipts" ADD COLUMN     "customerGoldFineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "customer_gold_receipts" (
    "id" TEXT NOT NULL,
    "receiptCode" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "intakeDate" TIMESTAMP(3) NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "finenessPercentSnapshot" DECIMAL(6,3) NOT NULL,
    "inputBasis" "CustomerGoldInputBasis" NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL,
    "deductionWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "netGrossWeight" DECIMAL(10,3) NOT NULL,
    "fineWeight" DECIMAL(10,3) NOT NULL,
    "reference" TEXT,
    "reason" TEXT NOT NULL,
    "photoAssetId" TEXT,
    "declaredValue" DECIMAL(14,2),
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_gold_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_gold_entries" (
    "id" TEXT NOT NULL,
    "entryCode" TEXT NOT NULL,
    "kind" "CustomerGoldEntryKind" NOT NULL,
    "customerId" TEXT NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "finenessPercentSnapshot" DECIMAL(6,3) NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL,
    "fineWeight" DECIMAL(10,3) NOT NULL,
    "fromLocation" "CustomerGoldLocation" NOT NULL,
    "toLocation" "CustomerGoldLocation" NOT NULL,
    "karigarId" TEXT,
    "jobId" TEXT,
    "finishedJewelleryId" TEXT,
    "jewelleryReceiptId" TEXT,
    "customerGoldReceiptId" TEXT,
    "purchaseId" TEXT,
    "deliveryId" TEXT,
    "entryDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "reversalOfEntryId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_gold_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_gold_purchases" (
    "id" TEXT NOT NULL,
    "purchaseCode" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT NOT NULL,
    "finenessPercentSnapshot" DECIMAL(6,3) NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL,
    "fineWeight" DECIMAL(10,3) NOT NULL,
    "rateBasis" "MetalRateBasis" NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "approvedValue" DECIMAL(14,2) NOT NULL,
    "settlement" "CustomerGoldSettlement" NOT NULL,
    "fromCustody" BOOLEAN NOT NULL DEFAULT false,
    "metalPurchaseId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "reference" TEXT,
    "approvedByUserId" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_gold_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_jewellery_bills" (
    "id" TEXT NOT NULL,
    "billCode" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "billDate" TIMESTAMP(3) NOT NULL,
    "makingCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "diamondCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "materialCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "otherCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "gstTreatment" "GstTreatment" NOT NULL,
    "gstRatePercent" DECIMAL(5,2),
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL,
    "creditApplied" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amountDue" DECIMAL(14,2) NOT NULL,
    "description" TEXT,
    "voucherId" TEXT NOT NULL,
    "status" "CustomerJewelleryDocStatus" NOT NULL DEFAULT 'POSTED',
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "reversalReason" TEXT,
    "reversalVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_jewellery_bills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_jewellery_deliveries" (
    "id" TEXT NOT NULL,
    "deliveryCode" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "deliveryDate" TIMESTAMP(3) NOT NULL,
    "deliveredByUserId" TEXT NOT NULL,
    "receivedByName" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "companyCostTotal" DECIMAL(14,2) NOT NULL,
    "customerGoldFineTotal" DECIMAL(10,3) NOT NULL,
    "cogsVoucherId" TEXT,
    "status" "CustomerJewelleryDocStatus" NOT NULL DEFAULT 'POSTED',
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "reversalReason" TEXT,
    "reversalVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_jewellery_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_jewellery_delivery_items" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "finishedJewelleryId" TEXT NOT NULL,
    "companyCost" DECIMAL(14,2) NOT NULL,
    "customerGoldFineWeight" DECIMAL(10,3) NOT NULL,

    CONSTRAINT "customer_jewellery_delivery_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_receipts_receiptCode_key" ON "customer_gold_receipts"("receiptCode");

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_receipts_idempotencyKey_key" ON "customer_gold_receipts"("idempotencyKey");

-- CreateIndex
CREATE INDEX "customer_gold_receipts_customerId_idx" ON "customer_gold_receipts"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_entries_entryCode_key" ON "customer_gold_entries"("entryCode");

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_entries_reversalOfEntryId_key" ON "customer_gold_entries"("reversalOfEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_entries_idempotencyKey_key" ON "customer_gold_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "customer_gold_entries_customerId_purityId_idx" ON "customer_gold_entries"("customerId", "purityId");

-- CreateIndex
CREATE INDEX "customer_gold_entries_jobId_idx" ON "customer_gold_entries"("jobId");

-- CreateIndex
CREATE INDEX "customer_gold_entries_karigarId_idx" ON "customer_gold_entries"("karigarId");

-- CreateIndex
CREATE INDEX "customer_gold_entries_finishedJewelleryId_idx" ON "customer_gold_entries"("finishedJewelleryId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_purchases_purchaseCode_key" ON "customer_gold_purchases"("purchaseCode");

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_purchases_metalPurchaseId_key" ON "customer_gold_purchases"("metalPurchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_gold_purchases_idempotencyKey_key" ON "customer_gold_purchases"("idempotencyKey");

-- CreateIndex
CREATE INDEX "customer_gold_purchases_customerId_idx" ON "customer_gold_purchases"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_bills_billCode_key" ON "customer_jewellery_bills"("billCode");

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_bills_voucherId_key" ON "customer_jewellery_bills"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_bills_reversalVoucherId_key" ON "customer_jewellery_bills"("reversalVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_bills_idempotencyKey_key" ON "customer_jewellery_bills"("idempotencyKey");

-- CreateIndex
CREATE INDEX "customer_jewellery_bills_customerId_idx" ON "customer_jewellery_bills"("customerId");

-- CreateIndex
CREATE INDEX "customer_jewellery_bills_jobId_idx" ON "customer_jewellery_bills"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_deliveries_deliveryCode_key" ON "customer_jewellery_deliveries"("deliveryCode");

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_deliveries_cogsVoucherId_key" ON "customer_jewellery_deliveries"("cogsVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_deliveries_reversalVoucherId_key" ON "customer_jewellery_deliveries"("reversalVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_deliveries_idempotencyKey_key" ON "customer_jewellery_deliveries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "customer_jewellery_deliveries_customerId_idx" ON "customer_jewellery_deliveries"("customerId");

-- CreateIndex
CREATE INDEX "customer_jewellery_deliveries_jobId_idx" ON "customer_jewellery_deliveries"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_delivery_items_deliveryId_finishedJewell_key" ON "customer_jewellery_delivery_items"("deliveryId", "finishedJewelleryId");

-- CreateIndex
CREATE INDEX "finished_jewellery_ownership_customerId_idx" ON "finished_jewellery"("ownership", "customerId");

-- AddForeignKey
ALTER TABLE "jewellery_jobs" ADD CONSTRAINT "jewellery_jobs_customerGoldMixApprovedByUserId_fkey" FOREIGN KEY ("customerGoldMixApprovedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finished_jewellery" ADD CONSTRAINT "finished_jewellery_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_receipts" ADD CONSTRAINT "customer_gold_receipts_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_receipts" ADD CONSTRAINT "customer_gold_receipts_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_receipts" ADD CONSTRAINT "customer_gold_receipts_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_karigarId_fkey" FOREIGN KEY ("karigarId") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_finishedJewelleryId_fkey" FOREIGN KEY ("finishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_jewelleryReceiptId_fkey" FOREIGN KEY ("jewelleryReceiptId") REFERENCES "jewellery_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_customerGoldReceiptId_fkey" FOREIGN KEY ("customerGoldReceiptId") REFERENCES "customer_gold_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "customer_gold_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "customer_jewellery_deliveries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_reversalOfEntryId_fkey" FOREIGN KEY ("reversalOfEntryId") REFERENCES "customer_gold_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_entries" ADD CONSTRAINT "customer_gold_entries_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_purchases" ADD CONSTRAINT "customer_gold_purchases_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_purchases" ADD CONSTRAINT "customer_gold_purchases_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_purchases" ADD CONSTRAINT "customer_gold_purchases_metalPurchaseId_fkey" FOREIGN KEY ("metalPurchaseId") REFERENCES "metal_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_gold_purchases" ADD CONSTRAINT "customer_gold_purchases_approvedByUserId_fkey" FOREIGN KEY ("approvedByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_bills" ADD CONSTRAINT "customer_jewellery_bills_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_bills" ADD CONSTRAINT "customer_jewellery_bills_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_bills" ADD CONSTRAINT "customer_jewellery_bills_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_bills" ADD CONSTRAINT "customer_jewellery_bills_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_bills" ADD CONSTRAINT "customer_jewellery_bills_reversalVoucherId_fkey" FOREIGN KEY ("reversalVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_bills" ADD CONSTRAINT "customer_jewellery_bills_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_deliveries" ADD CONSTRAINT "customer_jewellery_deliveries_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_deliveries" ADD CONSTRAINT "customer_jewellery_deliveries_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_deliveries" ADD CONSTRAINT "customer_jewellery_deliveries_deliveredByUserId_fkey" FOREIGN KEY ("deliveredByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_deliveries" ADD CONSTRAINT "customer_jewellery_deliveries_cogsVoucherId_fkey" FOREIGN KEY ("cogsVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_deliveries" ADD CONSTRAINT "customer_jewellery_deliveries_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_deliveries" ADD CONSTRAINT "customer_jewellery_deliveries_reversalVoucherId_fkey" FOREIGN KEY ("reversalVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_delivery_items" ADD CONSTRAINT "customer_jewellery_delivery_items_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "customer_jewellery_deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_delivery_items" ADD CONSTRAINT "customer_jewellery_delivery_items_finishedJewelleryId_fkey" FOREIGN KEY ("finishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- System account for the Company's own cost in Customer-owned pieces awaiting
-- delivery. Created only if missing; the guard at the top of this file has already
-- refused any conflicting 1340, so an existing row here is this same account.
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_1340_customer_jewellery', '1340', 'Customer Jewellery Work Awaiting Delivery', 'ASSET', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
