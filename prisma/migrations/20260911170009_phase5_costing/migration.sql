-- CreateEnum
CREATE TYPE "CostSheetMode" AS ENUM ('ACTUAL', 'ESTIMATE');

-- CreateEnum
CREATE TYPE "CostSheetStatus" AS ENUM ('DRAFT', 'FINALIZED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PricingMethod" AS ENUM ('MARKUP_ON_COST', 'MARGIN_ON_PRICE');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('NONE', 'PERCENT', 'FIXED');

-- CreateEnum
CREATE TYPE "ChargeMethod" AS ENUM ('FLAT', 'PER_GRAM', 'PER_CARAT', 'PER_PIECE', 'PERCENT_OF_MATERIAL_COST');

-- CreateEnum
CREATE TYPE "OtherMaterialCategory" AS ENUM ('MOISSANITE', 'COLOURED_STONE', 'SMALL_STONE', 'FINDINGS', 'ALLOY', 'ENAMEL', 'PLATING', 'PACKAGING', 'OTHER');

-- CreateEnum
CREATE TYPE "CostSheetEventType" AS ENUM ('CREATED', 'UPDATED', 'REFRESHED', 'FINALIZED', 'REVISED', 'ARCHIVED', 'UNARCHIVED', 'DRAFT_DELETED');

-- CreateTable
CREATE TABLE "costing_sequences" (
    "id" TEXT NOT NULL,
    "financialYearLabel" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "costing_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "costing_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "defaultPricingMethod" "PricingMethod" NOT NULL DEFAULT 'MARKUP_ON_COST',
    "defaultMarkupPercent" DECIMAL(8,3) NOT NULL DEFAULT 0,
    "defaultTargetMarginPercent" DECIMAL(8,3) NOT NULL DEFAULT 0,
    "defaultDiscountType" "DiscountType" NOT NULL DEFAULT 'NONE',
    "defaultDiscountValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "defaultGstTreatment" "GstTreatment" NOT NULL DEFAULT 'NONE',
    "defaultGstRateId" TEXT,
    "defaultPriceType" "TaxType" NOT NULL DEFAULT 'EXCLUSIVE',
    "defaultValidityDays" INTEGER NOT NULL DEFAULT 15,
    "defaultRoundingStep" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "defaultSellingExpenseFixed" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "defaultSellingExpensePercent" DECIMAL(8,3) NOT NULL DEFAULT 0,
    "quotationTerms" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "costing_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_sheets" (
    "id" TEXT NOT NULL,
    "costingNumber" TEXT NOT NULL,
    "mode" "CostSheetMode" NOT NULL,
    "status" "CostSheetStatus" NOT NULL DEFAULT 'DRAFT',
    "costingDate" TIMESTAMP(3) NOT NULL,
    "jewelleryType" "JewelleryType" NOT NULL,
    "itemName" TEXT NOT NULL,
    "referenceNumber" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sizeOrLength" TEXT,
    "designImageAssetId" TEXT,
    "notes" TEXT,
    "customerId" TEXT,
    "sourceFinishedJewelleryId" TEXT,
    "sourceJobCode" TEXT,
    "sourceReceiptCode" TEXT,
    "sourceFinishedCode" TEXT,
    "sourceVoucherNumber" TEXT,
    "sourceRefreshedAt" TIMESTAMP(3),
    "linkedEstimateId" TEXT,
    "pricingMethod" "PricingMethod" NOT NULL DEFAULT 'MARKUP_ON_COST',
    "markupPercent" DECIMAL(8,3) NOT NULL DEFAULT 0,
    "targetMarginPercent" DECIMAL(8,3) NOT NULL DEFAULT 0,
    "manualSellingPriceOverride" DECIMAL(14,2),
    "isManualOverride" BOOLEAN NOT NULL DEFAULT false,
    "discountType" "DiscountType" NOT NULL DEFAULT 'NONE',
    "discountValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gstTreatment" "GstTreatment" NOT NULL DEFAULT 'NONE',
    "gstRateId" TEXT,
    "gstRatePercentSnapshot" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "priceType" "TaxType" NOT NULL DEFAULT 'EXCLUSIVE',
    "roundingStep" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sellingExpenseFixed" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sellingExpensePercent" DECIMAL(8,3) NOT NULL DEFAULT 0,
    "quotationValidUntil" TIMESTAMP(3),
    "quotationTerms" TEXT,
    "revisionGroupId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL DEFAULT 1,
    "previousVersionId" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "finalizedByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedByUserId" TEXT,
    "idempotencyKey" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cost_sheets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_sheet_metal_lines" (
    "id" TEXT NOT NULL,
    "costSheetId" TEXT NOT NULL,
    "metalType" "MetalType" NOT NULL,
    "purityId" TEXT,
    "purityDisplayNameSnapshot" TEXT NOT NULL,
    "finenessPercentSnapshot" DECIMAL(6,3) NOT NULL,
    "grossWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "wastagePercent" DECIMAL(8,3) NOT NULL DEFAULT 0,
    "wastageWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "fineWeight" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "rateBasis" "MetalRateBasis" NOT NULL DEFAULT 'PER_GROSS_GRAM',
    "rate" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_sheet_metal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_sheet_diamond_lines" (
    "id" TEXT NOT NULL,
    "costSheetId" TEXT NOT NULL,
    "sourcePolishedDiamondId" TEXT,
    "polishedCodeSnapshot" TEXT,
    "diamondType" TEXT,
    "shape" "DiamondShape" NOT NULL DEFAULT 'ROUND',
    "customShapeName" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "totalCarat" DECIMAL(10,3) NOT NULL DEFAULT 0,
    "ratePerCarat" DECIMAL(14,2),
    "fixedAmount" DECIMAL(14,2),
    "certificateCharge" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_sheet_diamond_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_sheet_other_material_lines" (
    "id" TEXT NOT NULL,
    "costSheetId" TEXT NOT NULL,
    "category" "OtherMaterialCategory" NOT NULL DEFAULT 'OTHER',
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,3),
    "weight" DECIMAL(10,3),
    "rate" DECIMAL(14,2),
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_sheet_other_material_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_sheet_charge_lines" (
    "id" TEXT NOT NULL,
    "costSheetId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "method" "ChargeMethod" NOT NULL DEFAULT 'FLAT',
    "rate" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_sheet_charge_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_sheet_audit_events" (
    "id" TEXT NOT NULL,
    "costSheetId" TEXT NOT NULL,
    "eventType" "CostSheetEventType" NOT NULL,
    "note" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_sheet_audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "costing_sequences_financialYearLabel_key" ON "costing_sequences"("financialYearLabel");

-- CreateIndex
CREATE UNIQUE INDEX "cost_sheets_costingNumber_key" ON "cost_sheets"("costingNumber");

-- CreateIndex
CREATE UNIQUE INDEX "cost_sheets_previousVersionId_key" ON "cost_sheets"("previousVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "cost_sheets_idempotencyKey_key" ON "cost_sheets"("idempotencyKey");

-- CreateIndex
CREATE INDEX "cost_sheets_mode_idx" ON "cost_sheets"("mode");

-- CreateIndex
CREATE INDEX "cost_sheets_status_idx" ON "cost_sheets"("status");

-- CreateIndex
CREATE INDEX "cost_sheets_customerId_idx" ON "cost_sheets"("customerId");

-- CreateIndex
CREATE INDEX "cost_sheets_costingDate_idx" ON "cost_sheets"("costingDate");

-- CreateIndex
CREATE INDEX "cost_sheets_revisionGroupId_idx" ON "cost_sheets"("revisionGroupId");

-- CreateIndex
CREATE INDEX "cost_sheets_sourceFinishedJewelleryId_idx" ON "cost_sheets"("sourceFinishedJewelleryId");

-- CreateIndex
CREATE INDEX "cost_sheet_metal_lines_costSheetId_idx" ON "cost_sheet_metal_lines"("costSheetId");

-- CreateIndex
CREATE INDEX "cost_sheet_diamond_lines_costSheetId_idx" ON "cost_sheet_diamond_lines"("costSheetId");

-- CreateIndex
CREATE INDEX "cost_sheet_other_material_lines_costSheetId_idx" ON "cost_sheet_other_material_lines"("costSheetId");

-- CreateIndex
CREATE INDEX "cost_sheet_charge_lines_costSheetId_idx" ON "cost_sheet_charge_lines"("costSheetId");

-- CreateIndex
CREATE INDEX "cost_sheet_audit_events_costSheetId_idx" ON "cost_sheet_audit_events"("costSheetId");

-- AddForeignKey
ALTER TABLE "costing_settings" ADD CONSTRAINT "costing_settings_defaultGstRateId_fkey" FOREIGN KEY ("defaultGstRateId") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "costing_settings" ADD CONSTRAINT "costing_settings_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_sourceFinishedJewelleryId_fkey" FOREIGN KEY ("sourceFinishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_linkedEstimateId_fkey" FOREIGN KEY ("linkedEstimateId") REFERENCES "cost_sheets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_gstRateId_fkey" FOREIGN KEY ("gstRateId") REFERENCES "gst_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_previousVersionId_fkey" FOREIGN KEY ("previousVersionId") REFERENCES "cost_sheets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_finalizedByUserId_fkey" FOREIGN KEY ("finalizedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_archivedByUserId_fkey" FOREIGN KEY ("archivedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheets" ADD CONSTRAINT "cost_sheets_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheet_metal_lines" ADD CONSTRAINT "cost_sheet_metal_lines_costSheetId_fkey" FOREIGN KEY ("costSheetId") REFERENCES "cost_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheet_metal_lines" ADD CONSTRAINT "cost_sheet_metal_lines_purityId_fkey" FOREIGN KEY ("purityId") REFERENCES "metal_purities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheet_diamond_lines" ADD CONSTRAINT "cost_sheet_diamond_lines_costSheetId_fkey" FOREIGN KEY ("costSheetId") REFERENCES "cost_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheet_diamond_lines" ADD CONSTRAINT "cost_sheet_diamond_lines_sourcePolishedDiamondId_fkey" FOREIGN KEY ("sourcePolishedDiamondId") REFERENCES "polished_diamonds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheet_other_material_lines" ADD CONSTRAINT "cost_sheet_other_material_lines_costSheetId_fkey" FOREIGN KEY ("costSheetId") REFERENCES "cost_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheet_charge_lines" ADD CONSTRAINT "cost_sheet_charge_lines_costSheetId_fkey" FOREIGN KEY ("costSheetId") REFERENCES "cost_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheet_audit_events" ADD CONSTRAINT "cost_sheet_audit_events_costSheetId_fkey" FOREIGN KEY ("costSheetId") REFERENCES "cost_sheets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cost_sheet_audit_events" ADD CONSTRAINT "cost_sheet_audit_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
