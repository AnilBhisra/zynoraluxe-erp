-- Customer Gold: two voucher types (bill to the Customer; Company cost to COGS on
-- delivery). Additive only; IF NOT EXISTS so a re-run is harmless.
ALTER TYPE "VoucherType" ADD VALUE IF NOT EXISTS 'CUSTOMER_JEWELLERY_BILL';
ALTER TYPE "VoucherType" ADD VALUE IF NOT EXISTS 'CUSTOMER_JEWELLERY_DELIVERY';
