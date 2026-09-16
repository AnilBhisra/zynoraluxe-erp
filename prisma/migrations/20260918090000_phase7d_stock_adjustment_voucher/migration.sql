-- Phase 7 (tier P2) — voucher type for Owner-authorized polished packet
-- adjustments. Forward-only and purely additive: one new enum value. No DROP /
-- TRUNCATE / DELETE / ALTER COLUMN / RENAME. (Postgres cannot remove an enum
-- value; an unused value is harmless.)

-- AlterEnum
ALTER TYPE "VoucherType" ADD VALUE 'STOCK_ADJUSTMENT';
