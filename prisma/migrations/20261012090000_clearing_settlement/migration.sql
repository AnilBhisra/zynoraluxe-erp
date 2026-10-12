-- Clearing settlement (CLEARING_SETTLEMENT_DESIGN.md). Additive only:
--  * 7 new enums and 3 new VoucherType values (not used inside this migration);
--  * parties."clearingEnabled" BOOLEAN NOT NULL DEFAULT false (every existing party stays false);
--  * 5 new tables (clearing_account_mappings, clearing_documents, clearing_document_lines,
--    clearing_entries, clearing_allocations), all empty except the 11 default line mappings;
--  * 11 system accounts inserted only if missing (1150, 1160, 1170, 1180, 4300, 5600–5650).
-- No existing row, column type, constraint, journal line or voucher is changed or backfilled.
-- Guard FIRST, before any change: each account code must be free, or already be exactly this
-- system account (same id, or same name and type). Anything else stops the migration here with
-- nothing changed — an existing code is never reused for a different purpose and never modified.
DO $guard$
DECLARE existing RECORD;
BEGIN
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '1150';
  IF FOUND AND NOT (existing.id = 'sysacct_1150_marketplace_clearing' OR (existing.name = 'Marketplace Clearing Receivable' AND existing.type = 'ASSET')) THEN
    RAISE EXCEPTION 'Account code 1150 already exists as "%" (%, id %). Clearing settlement needs 1150 for Marketplace Clearing Receivable; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_1150_marketplace_clearing' AND code <> '1150') THEN
    RAISE EXCEPTION 'Account id sysacct_1150_marketplace_clearing already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '1160';
  IF FOUND AND NOT (existing.id = 'sysacct_1160_marketplace_reserve' OR (existing.name = 'Marketplace Reserve / Held Funds' AND existing.type = 'ASSET')) THEN
    RAISE EXCEPTION 'Account code 1160 already exists as "%" (%, id %). Clearing settlement needs 1160 for Marketplace Reserve / Held Funds; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_1160_marketplace_reserve' AND code <> '1160') THEN
    RAISE EXCEPTION 'Account id sysacct_1160_marketplace_reserve already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '1170';
  IF FOUND AND NOT (existing.id = 'sysacct_1170_tax_withheld' OR (existing.name = 'TDS / TCS Withheld by Marketplace (Receivable)' AND existing.type = 'ASSET')) THEN
    RAISE EXCEPTION 'Account code 1170 already exists as "%" (%, id %). Clearing settlement needs 1170 for TDS / TCS Withheld by Marketplace (Receivable); refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_1170_tax_withheld' AND code <> '1170') THEN
    RAISE EXCEPTION 'Account id sysacct_1170_tax_withheld already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '1180';
  IF FOUND AND NOT (existing.id = 'sysacct_1180_settlement_suspense' OR (existing.name = 'Settlement Suspense (To Classify)' AND existing.type = 'ASSET')) THEN
    RAISE EXCEPTION 'Account code 1180 already exists as "%" (%, id %). Clearing settlement needs 1180 for Settlement Suspense (To Classify); refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_1180_settlement_suspense' AND code <> '1180') THEN
    RAISE EXCEPTION 'Account id sysacct_1180_settlement_suspense already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '4300';
  IF FOUND AND NOT (existing.id = 'sysacct_4300_fx_gain' OR (existing.name = 'Foreign Exchange Gain' AND existing.type = 'INCOME')) THEN
    RAISE EXCEPTION 'Account code 4300 already exists as "%" (%, id %). Clearing settlement needs 4300 for Foreign Exchange Gain; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_4300_fx_gain' AND code <> '4300') THEN
    RAISE EXCEPTION 'Account id sysacct_4300_fx_gain already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '5600';
  IF FOUND AND NOT (existing.id = 'sysacct_5600_marketplace_fees' OR (existing.name = 'Marketplace Commission & Platform Fees' AND existing.type = 'EXPENSE')) THEN
    RAISE EXCEPTION 'Account code 5600 already exists as "%" (%, id %). Clearing settlement needs 5600 for Marketplace Commission & Platform Fees; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_5600_marketplace_fees' AND code <> '5600') THEN
    RAISE EXCEPTION 'Account id sysacct_5600_marketplace_fees already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '5610';
  IF FOUND AND NOT (existing.id = 'sysacct_5610_advertising' OR (existing.name = 'Advertising & Marketing' AND existing.type = 'EXPENSE')) THEN
    RAISE EXCEPTION 'Account code 5610 already exists as "%" (%, id %). Clearing settlement needs 5610 for Advertising & Marketing; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_5610_advertising' AND code <> '5610') THEN
    RAISE EXCEPTION 'Account id sysacct_5610_advertising already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '5620';
  IF FOUND AND NOT (existing.id = 'sysacct_5620_processing_fees' OR (existing.name = 'Payment Processing Fees' AND existing.type = 'EXPENSE')) THEN
    RAISE EXCEPTION 'Account code 5620 already exists as "%" (%, id %). Clearing settlement needs 5620 for Payment Processing Fees; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_5620_processing_fees' AND code <> '5620') THEN
    RAISE EXCEPTION 'Account id sysacct_5620_processing_fees already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '5630';
  IF FOUND AND NOT (existing.id = 'sysacct_5630_shipping' OR (existing.name = 'Shipping & Courier Charges' AND existing.type = 'EXPENSE')) THEN
    RAISE EXCEPTION 'Account code 5630 already exists as "%" (%, id %). Clearing settlement needs 5630 for Shipping & Courier Charges; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_5630_shipping' AND code <> '5630') THEN
    RAISE EXCEPTION 'Account id sysacct_5630_shipping already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '5640';
  IF FOUND AND NOT (existing.id = 'sysacct_5640_subscription' OR (existing.name = 'Subscription & Listing Fees' AND existing.type = 'EXPENSE')) THEN
    RAISE EXCEPTION 'Account code 5640 already exists as "%" (%, id %). Clearing settlement needs 5640 for Subscription & Listing Fees; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_5640_subscription' AND code <> '5640') THEN
    RAISE EXCEPTION 'Account id sysacct_5640_subscription already exists under another code. Nothing was changed.';
  END IF;
  SELECT id, name, type::text AS type INTO existing FROM "accounts" WHERE code = '5650';
  IF FOUND AND NOT (existing.id = 'sysacct_5650_fx_loss' OR (existing.name = 'Foreign Exchange Loss' AND existing.type = 'EXPENSE')) THEN
    RAISE EXCEPTION 'Account code 5650 already exists as "%" (%, id %). Clearing settlement needs 5650 for Foreign Exchange Loss; refusing to reuse it. Nothing was changed.', existing.name, existing.type, existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM "accounts" WHERE id = 'sysacct_5650_fx_loss' AND code <> '5650') THEN
    RAISE EXCEPTION 'Account id sysacct_5650_fx_loss already exists under another code. Nothing was changed.';
  END IF;
END
$guard$;

-- AlterEnum (idempotent)
ALTER TYPE "VoucherType" ADD VALUE IF NOT EXISTS 'CLEARING_SETTLEMENT';
ALTER TYPE "VoucherType" ADD VALUE IF NOT EXISTS 'CLEARING_RESERVE';
ALTER TYPE "VoucherType" ADD VALUE IF NOT EXISTS 'CLEARING_RECLASS';

-- CreateEnum
CREATE TYPE "ClearingLineType" AS ENUM ('COMMISSION', 'PROCESSING_FEE', 'ADVERTISING', 'SHIPPING', 'REFUND', 'TAX_WITHHELD', 'TAX_REMITTED', 'RESERVE_HOLD', 'RESERVE_RELEASE', 'SUBSCRIPTION', 'OTHER', 'FX_GAIN', 'FX_LOSS');

-- CreateEnum
CREATE TYPE "ClearingLineDirection" AS ENUM ('DEDUCTION', 'ADDITION');

-- CreateEnum
CREATE TYPE "ClearingBucket" AS ENUM ('AVAILABLE', 'RESERVE');

-- CreateEnum
CREATE TYPE "ClearingEntryKind" AS ENUM ('SALE', 'SALE_RETURN', 'SETTLEMENT', 'RESERVE_HOLD', 'RESERVE_RELEASE', 'RECLASSIFY', 'MIRROR');

-- CreateEnum
CREATE TYPE "ClearingDocumentKind" AS ENUM ('SETTLEMENT', 'RESERVE_HOLD', 'RESERVE_RELEASE', 'RECLASSIFY');

-- CreateEnum
CREATE TYPE "ClearingDocumentStatus" AS ENUM ('POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ClearingAllocationStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- AlterTable
ALTER TABLE "parties" ADD COLUMN     "clearingEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "clearing_account_mappings" (
    "lineType" "ClearingLineType" NOT NULL,
    "accountId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clearing_account_mappings_pkey" PRIMARY KEY ("lineType")
);

-- CreateTable
CREATE TABLE "clearing_documents" (
    "id" TEXT NOT NULL,
    "kind" "ClearingDocumentKind" NOT NULL,
    "partyId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "documentDate" TIMESTAMP(3) NOT NULL,
    "paymentAccountId" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "receivedInr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "receivedFc" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "payoutRate" DECIMAL(18,8) NOT NULL DEFAULT 1,
    "availableFc" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "availableInr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "reserveFc" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "reserveInr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fxDifferenceInr" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "availableOn" TIMESTAMP(3),
    "sourceVoucherId" TEXT,
    "previewFingerprint" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "status" "ClearingDocumentStatus" NOT NULL DEFAULT 'POSTED',
    "reversalVoucherId" TEXT,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "reversalReason" TEXT,
    "reversalIdempotencyKey" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clearing_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clearing_document_lines" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineType" "ClearingLineType" NOT NULL,
    "direction" "ClearingLineDirection" NOT NULL,
    "accountId" TEXT NOT NULL,
    "fcAmount" DECIMAL(18,4) NOT NULL,
    "inrAmount" DECIMAL(14,2) NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "clearing_document_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clearing_entries" (
    "id" TEXT NOT NULL,
    "partyId" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "bucket" "ClearingBucket" NOT NULL,
    "kind" "ClearingEntryKind" NOT NULL,
    "fcAmount" DECIMAL(18,4) NOT NULL,
    "inrAmount" DECIMAL(14,2) NOT NULL,
    "voucherId" TEXT NOT NULL,
    "documentId" TEXT,
    "reversalOfEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clearing_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clearing_allocations" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "saleVoucherId" TEXT NOT NULL,
    "fcAmount" DECIMAL(18,4) NOT NULL,
    "status" "ClearingAllocationStatus" NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedByUserId" TEXT,
    "reversalReason" TEXT,

    CONSTRAINT "clearing_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "clearing_documents_sourceVoucherId_key" ON "clearing_documents"("sourceVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "clearing_documents_voucherId_key" ON "clearing_documents"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "clearing_documents_reversalVoucherId_key" ON "clearing_documents"("reversalVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "clearing_documents_reversalIdempotencyKey_key" ON "clearing_documents"("reversalIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "clearing_documents_idempotencyKey_key" ON "clearing_documents"("idempotencyKey");

-- CreateIndex
CREATE INDEX "clearing_documents_partyId_currencyCode_createdAt_idx" ON "clearing_documents"("partyId", "currencyCode", "createdAt");

-- CreateIndex
CREATE INDEX "clearing_documents_status_idx" ON "clearing_documents"("status");

-- CreateIndex
CREATE INDEX "clearing_document_lines_documentId_idx" ON "clearing_document_lines"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "clearing_entries_reversalOfEntryId_key" ON "clearing_entries"("reversalOfEntryId");

-- CreateIndex
CREATE INDEX "clearing_entries_partyId_currencyCode_bucket_idx" ON "clearing_entries"("partyId", "currencyCode", "bucket");

-- CreateIndex
CREATE INDEX "clearing_entries_voucherId_idx" ON "clearing_entries"("voucherId");

-- CreateIndex
CREATE UNIQUE INDEX "clearing_allocations_idempotencyKey_key" ON "clearing_allocations"("idempotencyKey");

-- CreateIndex
CREATE INDEX "clearing_allocations_documentId_idx" ON "clearing_allocations"("documentId");

-- CreateIndex
CREATE INDEX "clearing_allocations_saleVoucherId_idx" ON "clearing_allocations"("saleVoucherId");

-- AddForeignKey
ALTER TABLE "clearing_account_mappings" ADD CONSTRAINT "clearing_account_mappings_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_account_mappings" ADD CONSTRAINT "clearing_account_mappings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_documents" ADD CONSTRAINT "clearing_documents_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_documents" ADD CONSTRAINT "clearing_documents_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_documents" ADD CONSTRAINT "clearing_documents_sourceVoucherId_fkey" FOREIGN KEY ("sourceVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_documents" ADD CONSTRAINT "clearing_documents_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_documents" ADD CONSTRAINT "clearing_documents_reversalVoucherId_fkey" FOREIGN KEY ("reversalVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_documents" ADD CONSTRAINT "clearing_documents_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_documents" ADD CONSTRAINT "clearing_documents_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_document_lines" ADD CONSTRAINT "clearing_document_lines_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "clearing_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_document_lines" ADD CONSTRAINT "clearing_document_lines_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_entries" ADD CONSTRAINT "clearing_entries_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_entries" ADD CONSTRAINT "clearing_entries_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_entries" ADD CONSTRAINT "clearing_entries_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "clearing_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_entries" ADD CONSTRAINT "clearing_entries_reversalOfEntryId_fkey" FOREIGN KEY ("reversalOfEntryId") REFERENCES "clearing_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_allocations" ADD CONSTRAINT "clearing_allocations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "clearing_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_allocations" ADD CONSTRAINT "clearing_allocations_saleVoucherId_fkey" FOREIGN KEY ("saleVoucherId") REFERENCES "vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_allocations" ADD CONSTRAINT "clearing_allocations_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clearing_allocations" ADD CONSTRAINT "clearing_allocations_reversedByUserId_fkey" FOREIGN KEY ("reversedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- System accounts (idempotent; the guard above has already refused any conflicting code).
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_1150_marketplace_clearing', '1150', 'Marketplace Clearing Receivable', 'ASSET', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_1160_marketplace_reserve', '1160', 'Marketplace Reserve / Held Funds', 'ASSET', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_1170_tax_withheld', '1170', 'TDS / TCS Withheld by Marketplace (Receivable)', 'ASSET', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_1180_settlement_suspense', '1180', 'Settlement Suspense (To Classify)', 'ASSET', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_4300_fx_gain', '4300', 'Foreign Exchange Gain', 'INCOME', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_5600_marketplace_fees', '5600', 'Marketplace Commission & Platform Fees', 'EXPENSE', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_5610_advertising', '5610', 'Advertising & Marketing', 'EXPENSE', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_5620_processing_fees', '5620', 'Payment Processing Fees', 'EXPENSE', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_5630_shipping', '5630', 'Shipping & Courier Charges', 'EXPENSE', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_5640_subscription', '5640', 'Subscription & Listing Fees', 'EXPENSE', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "accounts" ("id", "code", "name", "type", "isSystem", "isActive", "createdAt", "updatedAt")
VALUES ('sysacct_5650_fx_loss', '5650', 'Foreign Exchange Loss', 'EXPENSE', true, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Default line-type → account mappings (Owner-editable; CA to confirm, see CLEARING_SETTLEMENT_DESIGN.md §6).
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'COMMISSION', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '5600'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'PROCESSING_FEE', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '5620'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'ADVERTISING', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '5610'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'SHIPPING', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '5630'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'REFUND', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '4100'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'TAX_WITHHELD', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '1170'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'TAX_REMITTED', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '1180'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'RESERVE_HOLD', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '1160'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'RESERVE_RELEASE', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '1160'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'SUBSCRIPTION', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '5640'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'OTHER', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '1180'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'FX_GAIN', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '4300'
ON CONFLICT ("lineType") DO NOTHING;
INSERT INTO "clearing_account_mappings" ("lineType", "accountId", "updatedAt")
SELECT 'FX_LOSS', id, CURRENT_TIMESTAMP FROM "accounts" WHERE code = '5650'
ON CONFLICT ("lineType") DO NOTHING;
