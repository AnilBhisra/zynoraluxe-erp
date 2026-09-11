import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { DEFAULT_PAYMENT_ACCOUNTS, SYSTEM_ACCOUNT_CODES } from "../src/lib/accounting/accounts";

// Not importing src/lib/auth/password.ts here: it starts with `import
// "server-only"`, which throws when required outside Next's own bundler
// (which special-cases that marker). This script is a standalone CLI tool,
// not a Server/Client Component, so the same salt-rounds constant is
// duplicated here rather than fighting that boundary.
const SALT_ROUNDS = 12;

type AccountSeed = {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
};

const SYSTEM_ACCOUNTS: AccountSeed[] = [
  { code: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, name: "Accounts Receivable", type: "ASSET" },
  { code: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, name: "Accounts Payable", type: "LIABILITY" },
  {
    code: SYSTEM_ACCOUNT_CODES.OPENING_BALANCE_EQUITY,
    name: "Opening Balance Equity",
    type: "EQUITY",
  },
  { code: SYSTEM_ACCOUNT_CODES.SALES_INCOME, name: "Sales Income", type: "INCOME" },
  { code: SYSTEM_ACCOUNT_CODES.PURCHASES, name: "Purchases", type: "EXPENSE" },
  { code: SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, name: "Business Expenses", type: "EXPENSE" },
  { code: SYSTEM_ACCOUNT_CODES.INPUT_CGST, name: "Input CGST", type: "ASSET" },
  { code: SYSTEM_ACCOUNT_CODES.INPUT_SGST, name: "Input SGST", type: "ASSET" },
  { code: SYSTEM_ACCOUNT_CODES.INPUT_IGST, name: "Input IGST", type: "ASSET" },
  { code: SYSTEM_ACCOUNT_CODES.OUTPUT_CGST, name: "Output CGST", type: "LIABILITY" },
  { code: SYSTEM_ACCOUNT_CODES.OUTPUT_SGST, name: "Output SGST", type: "LIABILITY" },
  { code: SYSTEM_ACCOUNT_CODES.OUTPUT_IGST, name: "Output IGST", type: "LIABILITY" },
  { code: SYSTEM_ACCOUNT_CODES.ROUND_OFF, name: "Round Off", type: "EXPENSE" },
  {
    code: SYSTEM_ACCOUNT_CODES.ROUGH_DIAMOND_INVENTORY,
    name: "Rough Diamond Inventory",
    type: "ASSET",
  },
  { code: SYSTEM_ACCOUNT_CODES.DIAMOND_WIP, name: "Diamond WIP (Cutting-Polishing)", type: "ASSET" },
  {
    code: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY,
    name: "Polished Diamond Inventory",
    type: "ASSET",
  },
];

// Starter GST rate choices, editable/extendable by the Owner. These are
// common examples seen in the Indian jewellery trade, NOT a legal
// determination of what rate applies to any given transaction — see
// src/lib/accounting/gst.ts and the master plan's "do not hardcode
// jewellery tax rates as legal facts" rule.
const STARTER_GST_RATES: { label: string; ratePercent: string }[] = [
  { label: "No GST (0%)", ratePercent: "0.00" },
  { label: "0.25% — example: rough diamonds", ratePercent: "0.25" },
  { label: "1.5% — example: job work/making charges", ratePercent: "1.50" },
  { label: "3% — example: gold/silver jewellery", ratePercent: "3.00" },
  { label: "5%", ratePercent: "5.00" },
  { label: "18%", ratePercent: "18.00" },
];

async function seedAccountingMaster(prisma: PrismaClient) {
  for (const account of SYSTEM_ACCOUNTS) {
    await prisma.account.upsert({
      where: { code: account.code },
      update: { name: account.name, type: account.type, isSystem: true },
      create: { ...account, isSystem: true },
    });
  }
  console.log(`Chart of Accounts ready: ${SYSTEM_ACCOUNTS.length} system accounts.`);

  for (const paymentAccount of DEFAULT_PAYMENT_ACCOUNTS) {
    const account = await prisma.account.upsert({
      where: { code: paymentAccount.code },
      update: { name: paymentAccount.name, type: "ASSET", isSystem: true },
      create: {
        code: paymentAccount.code,
        name: paymentAccount.name,
        type: "ASSET",
        isSystem: true,
      },
    });
    await prisma.paymentAccount.upsert({
      where: { accountId: account.id },
      update: { name: paymentAccount.name, method: paymentAccount.method },
      create: { name: paymentAccount.name, method: paymentAccount.method, accountId: account.id },
    });
  }
  console.log(`Default payment accounts ready: ${DEFAULT_PAYMENT_ACCOUNTS.length}.`);

  for (const rate of STARTER_GST_RATES) {
    const existing = await prisma.gstRate.findFirst({ where: { label: rate.label } });
    if (existing) {
      await prisma.gstRate.update({
        where: { id: existing.id },
        data: { ratePercent: rate.ratePercent, isSystem: true },
      });
    } else {
      await prisma.gstRate.create({
        data: { label: rate.label, ratePercent: rate.ratePercent, isSystem: true },
      });
    }
  }
  console.log(`Starter GST rates ready: ${STARTER_GST_RATES.length}.`);
}

async function main() {
  const email = process.env.OWNER_EMAIL;
  const name = process.env.OWNER_NAME;
  const password = process.env.OWNER_PASSWORD;

  if (!email || !name || !password) {
    throw new Error(
      "OWNER_EMAIL, OWNER_NAME and OWNER_PASSWORD must be set in .env before seeding."
    );
  }
  if (password.length < 8) {
    throw new Error("OWNER_PASSWORD must be at least 8 characters.");
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set.");
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const owner = await prisma.user.upsert({
    where: { email },
    update: { name, passwordHash, role: "OWNER", isActive: true },
    create: { email, name, passwordHash, role: "OWNER" },
  });

  console.log(`Owner account ready: ${owner.email} (id: ${owner.id})`);

  await seedAccountingMaster(prisma);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
