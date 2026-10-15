-- Customer bill piece lines (JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §10). Additive only:
-- one new empty table; no existing row, column or constraint is changed or backfilled.
-- A bill posted before this migration has no piece lines and keeps covering its whole job.

-- CreateTable
CREATE TABLE "customer_jewellery_bill_pieces" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "finishedJewelleryId" TEXT NOT NULL,
    "activeFinishedJewelleryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_jewellery_bill_pieces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_jewellery_bill_pieces_activeFinishedJewelleryId_key" ON "customer_jewellery_bill_pieces"("activeFinishedJewelleryId");

-- CreateIndex
CREATE INDEX "customer_jewellery_bill_pieces_billId_idx" ON "customer_jewellery_bill_pieces"("billId");

-- CreateIndex
CREATE INDEX "customer_jewellery_bill_pieces_finishedJewelleryId_idx" ON "customer_jewellery_bill_pieces"("finishedJewelleryId");

-- AddForeignKey
ALTER TABLE "customer_jewellery_bill_pieces" ADD CONSTRAINT "customer_jewellery_bill_pieces_billId_fkey" FOREIGN KEY ("billId") REFERENCES "customer_jewellery_bills"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_jewellery_bill_pieces" ADD CONSTRAINT "customer_jewellery_bill_pieces_finishedJewelleryId_fkey" FOREIGN KEY ("finishedJewelleryId") REFERENCES "finished_jewellery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A live line may only lock its own piece (cleared to NULL when the bill is reversed).
ALTER TABLE "customer_jewellery_bill_pieces" ADD CONSTRAINT "customer_jewellery_bill_pieces_active_is_own_piece"
  CHECK ("activeFinishedJewelleryId" IS NULL OR "activeFinishedJewelleryId" = "finishedJewelleryId");
