-- Other Material purchased stock (JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §12). Additive only:
--  * 3 new JewellerySequenceType values (ADD VALUE IF NOT EXISTS, unused in this migration);
--  * 2 new enums; 6 new empty tables (items, purchases, purchase lines, job issue/return
--    documents, the movement ledger, Karigar-supplied material lines on receipts);
--  * jewellery_jobs."stockMaterialWipCost" and finished_jewellery."materialCost",
--    both NOT NULL DEFAULT 0 (every existing row stays 0 — nothing is backfilled);
--  * system account 1230 Other Material Inventory, inserted only if missing.
-- Legacy free-text other-material lines (jewellery_other_material_lines) are not touched.
-- Guard FIRST: account code 1230 must be free or already be exactly this system account.
DO $guard$
DECLARE existing RECORD;
BEGIN
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '1230';
  IF FOUND AND NOT (existing.id = 'sysacct_1230_other_material' OR (existing.name = 'Other Material Inventory' AND existing.type = 'ASSET')) THEN
    RAISE EXCEPTION 'Account code 1230 already exists as "%" (%, id %). Other Material needs 1230 for Other Material Inventory; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_1230_other_material' AND code <> '1230') THEN
    RAISE EXCEPTION 'Account id sysacct_1230_other_material already exists under another code. Nothing was changed.';
  END IF;
END
$guard$;

-- CreateEnum
CREATE TYPE "OtherMaterialJobDocumentKind" AS ENUM ('ISSUE', 'RETURN');

-- CreateEnum
CREATE TYPE "OtherMaterialMovementType" AS ENUM ('PURCHASE_IN', 'PURCHASE_CANCEL_OUT', 'JOB_ISSUE_OUT', 'JOB_RETURN_IN', 'JOB_CONSUMED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JewellerySequenceType" ADD VALUE IF NOT EXISTS 'OTHER_MATERIAL_ITEM';
ALTER TYPE "JewellerySequenceType" ADD VALUE IF NOT EXISTS 'OTHER_MATERIAL_PURCHASE';
ALTER TYPE "JewellerySequenceType" ADD VALUE IF NOT EXISTS 'OTHER_MATERIAL_JOB_DOCUMENT';

-- AlterTable
ALTER TABLE "finished_jewellery" ADD COLUMN     "materialCost" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "jewellery_jobs" ADD COLUMN     "stockMaterialWipCost" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "other_material_items" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "OtherMaterialCategory" NOT NULL DEFAULT 'OTHER',
    "unit" "InvoiceUnit" NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "other_material_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "other_material_purchases" (
    "id" TEXT NOT NULL,
    "purchaseCode" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "gstTreatment" "GstTreatment" NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discountTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableTotal" DECIMAL(14,2) NOT NULL,
    "taxTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(14,2) NOT NULL,
    "voucherId" TEXT NOT NULL,
    "status" "VoucherStatus" NOT NULL DEFAULT 'POSTED',
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "cancellationVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "other_material_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "other_material_purchase_lines" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" "InvoiceUnit" NOT NULL,
    "rate" DECIMAL(14,4) NOT NULL,
    "baseAmount" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "gstRatePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxType" "TaxType" NOT NULL DEFAULT 'EXCLUSIVE',
    "taxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "other_material_purchase_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "other_material_job_documents" (
    "id" TEXT NOT NULL,
    "documentCode" TEXT NOT NULL,
    "kind" "OtherMaterialJobDocumentKind" NOT NULL,
    "jobId" TEXT NOT NULL,
    "documentDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "totalCost" DECIMAL(14,2) NOT NULL,
    "voucherId" TEXT NOT NULL,
    "status" "CustomerJewelleryDocStatus" NOT NULL DEFAULT 'POSTED',
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "reversalReason" TEXT,
    "reversalVoucherId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" SERIAL NOT NULL,

    CONSTRAINT "other_material_job_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "other_material_movements" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "type" "OtherMaterialMovementType" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "costValue" DECIMAL(14,2) NOT NULL,
    "movementDate" TIMESTAMP(3) NOT NULL,
    "purchaseLineId" TEXT,
    "jobId" TEXT,
    "documentId" TEXT,
    "receiptId" TEXT,
    "reversalOfMovementId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" SERIAL NOT NULL,

    CONSTRAINT "other_material_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jewellery_receipt_karigar_material_lines" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" "InvoiceUnit" NOT NULL,
    "charge" DECIMAL(14,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "jewellery_receipt_karigar_material_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "other_material_items_code_key" ON "other_material_items"("code");

-- CreateIndex
CREATE INDEX "other_material_items_isActive_name_idx" ON "other_material_items"("isActive", "name");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_purchases_purchaseCode_key" ON "other_material_purchases"("purchaseCode");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_purchases_voucherId_key" ON "other_material_purchases"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_purchases_cancellationVoucherId_key" ON "other_material_purchases"("cancellationVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_purchases_idempotencyKey_key" ON "other_material_purchases"("idempotencyKey");

-- CreateIndex
CREATE INDEX "other_material_purchases_supplierId_idx" ON "other_material_purchases"("supplierId");

-- CreateIndex
CREATE INDEX "other_material_purchase_lines_purchaseId_idx" ON "other_material_purchase_lines"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_job_documents_documentCode_key" ON "other_material_job_documents"("documentCode");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_job_documents_voucherId_key" ON "other_material_job_documents"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_job_documents_reversalVoucherId_key" ON "other_material_job_documents"("reversalVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_job_documents_idempotencyKey_key" ON "other_material_job_documents"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_job_documents_sequence_key" ON "other_material_job_documents"("sequence");

-- CreateIndex
CREATE INDEX "other_material_job_documents_jobId_idx" ON "other_material_job_documents"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_movements_reversalOfMovementId_key" ON "other_material_movements"("reversalOfMovementId");

-- CreateIndex
CREATE UNIQUE INDEX "other_material_movements_sequence_key" ON "other_material_movements"("sequence");

-- CreateIndex
CREATE INDEX "other_material_movements_itemId_idx" ON "other_material_movements"("itemId");

-- CreateIndex
CREATE INDEX "other_material_movements_jobId_itemId_idx" ON "other_material_movements"("jobId", "itemId");

-- CreateIndex
CREATE INDEX "other_material_movements_receiptId_idx" ON "other_material_movements"("receiptId");

-- CreateIndex
CREATE INDEX "jewellery_receipt_karigar_material_lines_receiptId_idx" ON "jewellery_receipt_karigar_material_lines"("receiptId");

-- AddForeignKey
ALTER TABLE "other_material_items" ADD CONSTRAINT "other_material_items_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_purchases" ADD CONSTRAINT "other_material_purchases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_purchases" ADD CONSTRAINT "other_material_purchases_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_purchases" ADD CONSTRAINT "other_material_purchases_cancellationVoucherId_fkey" FOREIGN KEY ("cancellationVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_purchases" ADD CONSTRAINT "other_material_purchases_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_purchase_lines" ADD CONSTRAINT "other_material_purchase_lines_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "other_material_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_purchase_lines" ADD CONSTRAINT "other_material_purchase_lines_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "other_material_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_job_documents" ADD CONSTRAINT "other_material_job_documents_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_job_documents" ADD CONSTRAINT "other_material_job_documents_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_job_documents" ADD CONSTRAINT "other_material_job_documents_reversalVoucherId_fkey" FOREIGN KEY ("reversalVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_job_documents" ADD CONSTRAINT "other_material_job_documents_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_movements" ADD CONSTRAINT "other_material_movements_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "other_material_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_movements" ADD CONSTRAINT "other_material_movements_purchaseLineId_fkey" FOREIGN KEY ("purchaseLineId") REFERENCES "other_material_purchase_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_movements" ADD CONSTRAINT "other_material_movements_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jewellery_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_movements" ADD CONSTRAINT "other_material_movements_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "other_material_job_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_movements" ADD CONSTRAINT "other_material_movements_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "jewellery_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_material_movements" ADD CONSTRAINT "other_material_movements_reversalOfMovementId_fkey" FOREIGN KEY ("reversalOfMovementId") REFERENCES "other_material_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jewellery_receipt_karigar_material_lines" ADD CONSTRAINT "jewellery_receipt_karigar_material_lines_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "jewellery_receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Quantities and costs are positive magnitudes (the type gives the direction).
ALTER TABLE "other_material_movements" ADD CONSTRAINT "other_material_movements_positive" CHECK ("quantity" >= 0 AND "costValue" >= 0);
ALTER TABLE "other_material_purchase_lines" ADD CONSTRAINT "other_material_purchase_lines_positive" CHECK ("quantity" > 0 AND "rate" >= 0 AND "baseAmount" >= 0);

-- System account (idempotent; the guard above has already refused any conflicting code).
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_1230_other_material', '1230', 'Other Material Inventory', 'ASSET', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
