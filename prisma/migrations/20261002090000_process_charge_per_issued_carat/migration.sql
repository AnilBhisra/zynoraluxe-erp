-- Manufacturer process charge "per issued carat" — additive only.
--
-- A new charge basis alongside FIXED / PER_CARAT / PER_PIECE: rate x the
-- issued carat each receipt uses up, normal weight loss included (e.g.
-- Polishing 10.190 ct issued -> 5.091 ct polished charges 10.190 ct). One new
-- enum value; no existing row, job, receipt or process changes, so the
-- previous release keeps working on this schema.

-- AlterEnum
ALTER TYPE "ProcessChargeRateBasis" ADD VALUE 'PER_ISSUED_CARAT';
