import { z } from "zod";

// Loose GSTIN shape check (15 characters, standard alphanumeric layout).
// Not a checksum validator — good enough to catch obvious typos in Phase 1.
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const companySettingsSchema = z.object({
  companyName: z
    .string()
    .trim()
    .min(2, "Company name must be at least 2 characters.")
    .max(200),
  address: z.string().trim().max(500).optional().or(z.literal("")),
  phone: z
    .string()
    .trim()
    .max(20)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || /^[0-9+\-()\s]{6,20}$/.test(v), {
      message: "Enter a valid phone number.",
    }),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || z.string().email().safeParse(v).success, {
      message: "Enter a valid email address.",
    }),
  gstNumber: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || GSTIN_PATTERN.test(v), {
      message: "GST number should look like a 15-character GSTIN.",
    }),
  companyStateCode: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || /^[0-9]{2}$/.test(v), {
      message: "State code should be 2 digits, e.g. 24.",
    }),
  defaultCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter code, e.g. INR."),
  financialYearStartMonth: z.coerce.number().int().min(1).max(12),
  financialYearStartDay: z.coerce.number().int().min(1).max(31),
});

export type CompanySettingsInput = z.infer<typeof companySettingsSchema>;

export const createStaffSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(100),
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters.")
    .max(72, "Password must be at most 72 characters."),
});

export type CreateStaffInput = z.infer<typeof createStaffSchema>;
