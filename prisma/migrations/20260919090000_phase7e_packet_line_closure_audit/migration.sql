-- Phase 7 (Owner decision 2026-09-17) — audit trail for closing a Job
-- Manufacturer packet line. A line closes only when every issued piece is
-- resolved and the carat matches or closure was explicitly confirmed; a closed
-- line accepts no further receipts. Forward-only and purely additive: nullable
-- columns, foreign keys and a CHECK that existing rows (isClosed = false,
-- closedAt NULL) already satisfy. No DROP / TRUNCATE / DELETE / ALTER COLUMN /
-- RENAME.
--
-- Generated with `prisma migrate diff --from-schema <previous schema>
-- --to-schema prisma/schema.prisma --script` and reviewed by hand.

-- AlterTable
ALTER TABLE "packet_process_job_lines" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "closedByUserId" TEXT,
ADD COLUMN     "closingReceiptId" TEXT;

-- AddForeignKey
ALTER TABLE "packet_process_job_lines" ADD CONSTRAINT "packet_process_job_lines_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "packet_process_job_lines" ADD CONSTRAINT "packet_process_job_lines_closingReceiptId_fkey" FOREIGN KEY ("closingReceiptId") REFERENCES "packet_process_receipts"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---- Hand-added integrity check ----
ALTER TABLE "packet_process_job_lines" ADD CONSTRAINT "packet_process_job_lines_closure_chk"
  CHECK ("isClosed" = ("closedAt" IS NOT NULL));
