import { z } from "zod";

// Loose GSTIN shape check (15 characters, standard alphanumeric layout).
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PHONE_PATTERN = /^[0-9+\-()\s]{6,20}$/;
const STATE_CODE_PATTERN = /^[0-9]{2}$/;

export const partySchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters.").max(200),
  type: z.enum(["CUSTOMER", "SUPPLIER", "KARIGAR", "BROKER", "MANUFACTURER"]),
  phone: z
    .string()
    .trim()
    .max(20)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || PHONE_PATTERN.test(v), { message: "Enter a valid phone number." }),
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
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .max(15)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || GSTIN_PATTERN.test(v), {
      message: "GSTIN should look like a 15-character GSTIN.",
    }),
  address: z.string().trim().max(500).optional().or(z.literal("")),
  state: z.string().trim().max(100).optional().or(z.literal("")),
  stateCode: z
    .string()
    .trim()
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || STATE_CODE_PATTERN.test(v), {
      message: "State code should be 2 digits, e.g. 24.",
    }),
  openingBalance: z.coerce.number().min(0, "Opening balance cannot be negative.").default(0),
  openingBalanceType: z.enum(["RECEIVABLE", "PAYABLE"]).default("RECEIVABLE"),
});

export type PartyInput = z.infer<typeof partySchema>;
