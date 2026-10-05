-- Owner "Correct entry" framework (additive only). New enum VALUES, nothing else:
--  * CorrectionImpactKind RECORD: an impact on a record's own descriptive / count field;
--  * CorrectionMode ENTRY_METADATA / ENTRY_QUANTITY: corrections that post no voucher;
--  * JewellerySequenceType ENTRY_CORRECTION: their ZL-COR-YYYY-NNNNNN codes;
--  * StockMovementType ROUGH_COUNT_CORRECTION_IN/OUT (stone count only, carat 0, cost 0)
--    and ROUGH_RETURN_REVERSAL_OUT / ROUGH_CONSUMED_REVERSAL_IN (processed-rough receipt
--    reversal), so the stock ledger stays append-only.
-- No table, column, constraint or existing row is changed. PostgreSQL 12+ allows several
-- ADD VALUE statements in one migration; the new values are not used inside it.

-- AlterEnum
ALTER TYPE "CorrectionImpactKind" ADD VALUE 'RECORD';

-- AlterEnum
ALTER TYPE "CorrectionMode" ADD VALUE 'ENTRY_METADATA';
ALTER TYPE "CorrectionMode" ADD VALUE 'ENTRY_QUANTITY';

-- AlterEnum
ALTER TYPE "JewellerySequenceType" ADD VALUE 'ENTRY_CORRECTION';

-- AlterEnum
ALTER TYPE "StockMovementType" ADD VALUE 'ROUGH_COUNT_CORRECTION_IN';
ALTER TYPE "StockMovementType" ADD VALUE 'ROUGH_COUNT_CORRECTION_OUT';
ALTER TYPE "StockMovementType" ADD VALUE 'ROUGH_RETURN_REVERSAL_OUT';
ALTER TYPE "StockMovementType" ADD VALUE 'ROUGH_CONSUMED_REVERSAL_IN';
