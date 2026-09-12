import { z } from "zod";

const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");

export const finishedSaleItemSchema = z.object({
  finishedJewelleryId: z.string().trim().min(1),
  sellingPrice: z.coerce.number().positive("Each item's selling price must be greater than zero."),
  discountShare: z.coerce.number().min(0, "Discount cannot be negative.").default(0),
  gstRateId: z.string().trim().optional().or(z.literal("")),
  gstRatePercent: z.coerce.number().min(0).max(100),
  taxType: z.enum(["EXCLUSIVE", "INCLUSIVE"]).default("EXCLUSIVE"),
});

export const createFinishedJewellerySaleSchema = z.object({
  customerId: z.string().trim().min(1, "Choose a customer."),
  saleDate: DATE_ONLY,
  gstTreatment: z.enum(["NONE", "CGST_SGST", "IGST"]).default("NONE"),
  paymentAccountId: z.string().trim().optional().or(z.literal("")),
  referenceNumber: z.string().trim().max(500).optional().or(z.literal("")),
  note: z.string().trim().max(500).optional().or(z.literal("")),
  items: z.array(finishedSaleItemSchema).min(1, "Select at least one finished piece."),
  idempotencyKey: z.string().trim().max(100).optional(),
});
export type CreateFinishedJewellerySaleInput = z.infer<typeof createFinishedJewellerySaleSchema>;

export const cancelFinishedJewellerySaleSchema = z.object({
  saleId: z.string().trim().min(1),
  cancellationReason: z.string().trim().min(3, "Give a short reason for cancelling.").max(300),
});

export const returnFinishedJewelleryItemsSchema = z.object({
  saleId: z.string().trim().min(1),
  returnDate: DATE_ONLY,
  reason: z.string().trim().min(3, "Give a short reason for this return.").max(300),
  items: z
    .array(
      z.object({
        saleLineId: z.string().trim().min(1),
        disposition: z.enum(["SELLABLE", "DAMAGED"]),
      })
    )
    .min(1, "Select at least one item to return."),
  idempotencyKey: z.string().trim().max(100).optional(),
});

export const customerRefundSchema = z.object({
  partyId: z.string().trim().min(1, "Choose a customer."),
  paymentAccountId: z.string().trim().min(1, "Choose a payment account."),
  amount: z.coerce.number().positive("Amount must be greater than zero."),
  date: DATE_ONLY,
  note: z.string().trim().max(500).optional().or(z.literal("")),
  idempotencyKey: z.string().trim().max(100).optional(),
});

export const adjustFinishedJewelleryStockSchema = z.object({
  finishedJewelleryId: z.string().trim().min(1),
  direction: z.enum(["IN", "OUT"]),
  reason: z.string().trim().min(5, "Give a specific reason (at least 5 characters).").max(300),
});
