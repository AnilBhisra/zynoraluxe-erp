-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('CUSTOMER', 'SUPPLIER', 'KARIGAR');

-- CreateEnum
CREATE TYPE "OpeningBalanceType" AS ENUM ('RECEIVABLE', 'PAYABLE');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK', 'UPI', 'OTHER');

-- CreateEnum
CREATE TYPE "VoucherType" AS ENUM ('PURCHASE', 'SALE', 'PAYMENT_GIVEN', 'PAYMENT_RECEIVED', 'EXPENSE', 'OPENING', 'REVERSAL');

-- CreateEnum
CREATE TYPE "VoucherStatus" AS ENUM ('POSTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GstTreatment" AS ENUM ('NONE', 'CGST_SGST', 'IGST');

-- CreateEnum
CREATE TYPE "InvoiceUnit" AS ENUM ('PCS', 'CT', 'GRAM', 'OTHER');

-- CreateEnum
CREATE TYPE "TaxType" AS ENUM ('EXCLUSIVE', 'INCLUSIVE');

-- AlterTable
ALTER TABLE "company_settings" ADD COLUMN     "companyStateCode" TEXT;

-- CreateTable
CREATE TABLE "parties" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PartyType" NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "gstin" TEXT,
    "address" TEXT,
    "state" TEXT,
    "stateCode" TEXT,
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "openingBalanceType" "OpeningBalanceType" NOT NULL DEFAULT 'RECEIVABLE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "accountId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gst_rates" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "ratePercent" DECIMAL(5,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gst_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voucher_sequences" (
    "id" TEXT NOT NULL,
    "voucherType" "VoucherType" NOT NULL,
    "financialYearLabel" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voucher_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vouchers" (
    "id" TEXT NOT NULL,
    "voucherNumber" TEXT NOT NULL,
    "voucherType" "VoucherType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "financialYearLabel" TEXT NOT NULL,
    "partyId" TEXT,
    "paymentAccountId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "exchangeRate" DECIMAL(10,4) NOT NULL DEFAULT 1,
    "referenceNumber" TEXT,
    "note" TEXT,
    "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'NONE',
    "status" "VoucherStatus" NOT NULL DEFAULT 'POSTED',
    "reversalOfVoucherId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledByUserId" TEXT,
    "cancellationReason" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_entries" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "partyId" TEXT,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "voucherId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "hsnSac" TEXT,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" "InvoiceUnit" NOT NULL DEFAULT 'PCS',
    "rate" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gstRateId" TEXT,
    "gstRatePercent" DECIMAL(5,2) NOT NULL,
    "taxType" "TaxType" NOT NULL DEFAULT 'EXCLUSIVE',
    "taxableValue" DECIMAL(14,2) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "lineTotal" DECIMAL(14,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "parties_type_idx" ON "parties"("type");

-- CreateIndex
CREATE INDEX "parties_name_idx" ON "parties"("name");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_code_key" ON "accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "payment_accounts_accountId_key" ON "payment_accounts"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "voucher_sequences_voucherType_financialYearLabel_key" ON "voucher_sequences"("voucherType", "financialYearLabel");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_voucherNumber_key" ON "vouchers"("voucherNumber");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_reversalOfVoucherId_key" ON "vouchers"("reversalOfVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "vouchers_idempotencyKey_key" ON "vouchers"("idempotencyKey");

-- CreateIndex
CREATE INDEX "vouchers_voucherType_idx" ON "vouchers"("voucherType");

-- CreateIndex
CREATE INDEX "vouchers_partyId_idx" ON "vouchers"("partyId");

-- CreateIndex
CREATE INDEX "vouchers_date_idx" ON "vouchers"("date");

-- CreateIndex
CREATE INDEX "vouchers_status_idx" ON "vouchers"("status");

-- CreateIndex
CREATE INDEX "vouchers_financialYearLabel_idx" ON "vouchers"("financialYearLabel");

-- CreateIndex
CREATE INDEX "journal_entries_accountId_idx" ON "journal_entries"("accountId");

-- CreateIndex
CREATE INDEX "journal_entries_partyId_idx" ON "journal_entries"("partyId");

-- CreateIndex
CREATE INDEX "journal_entries_voucherId_idx" ON "journal_entries"("voucherId");

-- CreateIndex
CREATE INDEX "invoice_lines_voucherId_idx" ON "invoice_lines"("voucherId");

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parties" ADD CONSTRAINT "parties_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_accounts" ADD CONSTRAINT "payment_accounts_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "payment_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_reversalOfVoucherId_fkey" FOREIGN KEY ("reversalOfVoucherId") REFERENCES "vouchers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_voucherId_fkey" FOREIGN KEY ("voucherId") REFERENCES "vouchers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_gstRateId_fkey" FOREIGN KEY ("gstRateId") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CheckConstraint: hand-added defense-in-depth, not expressible in schema.prisma.
-- A journal line is exactly one side of a posting: never both debit and
-- credit, never neither, never negative.
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_single_side_nonnegative_chk"
  CHECK ("debit" >= 0 AND "credit" >= 0 AND NOT ("debit" > 0 AND "credit" > 0) AND ("debit" > 0 OR "credit" > 0));

-- A posted voucher's headline amount can never be zero or negative.
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_amount_positive_chk" CHECK ("amount" > 0);

-- Opening balance is a magnitude; direction comes from openingBalanceType.
ALTER TABLE "parties" ADD CONSTRAINT "parties_opening_balance_nonnegative_chk" CHECK ("openingBalance" >= 0);

ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_quantity_positive_chk" CHECK ("quantity" > 0);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_rate_nonnegative_chk" CHECK ("rate" >= 0);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_discount_nonnegative_chk" CHECK ("discount" >= 0);
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_gst_rate_percent_nonnegative_chk" CHECK ("gstRatePercent" >= 0);

ALTER TABLE "gst_rates" ADD CONSTRAINT "gst_rates_rate_percent_nonnegative_chk" CHECK ("ratePercent" >= 0);

ALTER TABLE "voucher_sequences" ADD CONSTRAINT "voucher_sequences_last_number_nonnegative_chk" CHECK ("lastNumber" >= 0);

