import { z } from "zod";

const DATE_ONLY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.");
const OPTIONAL_STRING = z.string().trim().max(500).optional().or(z.literal(""));

export const invoiceLineSchema = z.object({
  description: z.string().trim().min(1, "Description is required.").max(300),
  hsnSac: z.string().trim().max(20).optional().or(z.literal("")),
  quantity: z.coerce.number().positive("Quantity must be greater than zero."),
  unit: z.enum(["PCS", "CT", "GRAM", "OTHER"]),
  rate: z.coerce.number().min(0, "Rate cannot be negative."),
  discount: z.coerce.number().min(0, "Discount cannot be negative.").default(0),
  gstRateId: z.string().trim().min(1, "Choose a GST rate."),
  taxType: z.enum(["EXCLUSIVE", "INCLUSIVE"]).default("EXCLUSIVE"),
});

export type InvoiceLineFormInput = z.infer<typeof invoiceLineSchema>;

const invoiceVoucherBase = z.object({
  date: DATE_ONLY,
  partyId: z.string().trim().min(1, "Choose a party."),
  paymentAccountId: z.string().trim().optional().or(z.literal("")),
  gstTreatment: z.enum(["NONE", "CGST_SGST", "IGST"]).default("NONE"),
  referenceNumber: OPTIONAL_STRING,
  note: OPTIONAL_STRING,
  currencyCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code, e.g. INR.")
    .default("INR"),
  exchangeRate: z.coerce.number().positive("Exchange rate must be greater than zero.").default(1),
  idempotencyKey: z.string().trim().max(100).optional(),
  lines: z.array(invoiceLineSchema).min(1, "Add at least one item line."),
});

export const purchaseSchema = invoiceVoucherBase;
export const saleSchema = invoiceVoucherBase;
export type PurchaseSaleInput = z.infer<typeof purchaseSchema>;

const cashVoucherBase = z.object({
  date: DATE_ONLY,
  paymentAccountId: z.string().trim().min(1, "Choose a payment account."),
  amount: z.coerce.number().positive("Amount must be greater than zero."),
  referenceNumber: OPTIONAL_STRING,
  note: OPTIONAL_STRING,
  currencyCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code, e.g. INR.")
    .default("INR"),
  exchangeRate: z.coerce.number().positive("Exchange rate must be greater than zero.").default(1),
  idempotencyKey: z.string().trim().max(100).optional(),
});

export const paymentGivenSchema = cashVoucherBase.extend({
  partyId: z.string().trim().min(1, "Choose a party."),
});
export type PaymentGivenInput = z.infer<typeof paymentGivenSchema>;

export const paymentReceivedSchema = cashVoucherBase.extend({
  partyId: z.string().trim().min(1, "Choose a party."),
});
export type PaymentReceivedInput = z.infer<typeof paymentReceivedSchema>;

export const expenseSchema = cashVoucherBase.extend({
  partyId: z.string().trim().optional().or(z.literal("")),
});
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const cancelVoucherSchema = z.object({
  voucherId: z.string().trim().min(1),
  cancellationReason: z
    .string()
    .trim()
    .min(3, "Give a short reason for cancelling.")
    .max(300),
});
export type CancelVoucherInput = z.infer<typeof cancelVoucherSchema>;

export const paymentAccountSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  method: z.enum(["CASH", "BANK", "UPI", "OTHER"]),
});
export type PaymentAccountInput = z.infer<typeof paymentAccountSchema>;

export const gstRateSchema = z.object({
  label: z.string().trim().min(2, "Label must be at least 2 characters.").max(100),
  ratePercent: z.coerce
    .number()
    .min(0, "Rate cannot be negative.")
    .max(100, "Rate cannot exceed 100%."),
});
export type GstRateInput = z.infer<typeof gstRateSchema>;
