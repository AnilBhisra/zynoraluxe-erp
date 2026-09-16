// Deliberately the plain `import "dotenv/config"` side-effect form — see
// the comment in src/lib/auth/rateLimit.test.ts for why an explicit
// `config({ quiet: true })` call (tried, to suppress dotenv's own console
// tip line) is unsafe here: ES module imports are hoisted, so a call
// placed after this line would actually run after any later sibling
// import's own top-level code, which can read env vars before dotenv
// populates them. Reverted for correctness.
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
  { code: SYSTEM_ACCOUNT_CODES.METAL_INVENTORY, name: "Metal Inventory", type: "ASSET" },
  { code: SYSTEM_ACCOUNT_CODES.SCRAP_METAL_INVENTORY, name: "Scrap Metal Inventory", type: "ASSET" },
  { code: SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, name: "Jewellery WIP", type: "ASSET" },
  {
    code: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY,
    name: "Finished Jewellery Inventory",
    type: "ASSET",
  },
  // Phase 6
  { code: SYSTEM_ACCOUNT_CODES.SALES_RETURNS, name: "Sales Returns", type: "INCOME" },
  // Phase 7
  { code: SYSTEM_ACCOUNT_CODES.BROKERAGE_EXPENSE, name: "Brokerage & Commission", type: "EXPENSE" },
  {
    code: SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS,
    name: "Finished Jewellery COGS",
    type: "EXPENSE",
  },
  {
    code: SYSTEM_ACCOUNT_CODES.DAMAGED_JEWELLERY_LOSS,
    name: "Damaged Jewellery Loss",
    type: "EXPENSE",
  },
];

// Starter Metal/Purity master — standard, widely-known fineness
// percentages offered as an editable STARTING POINT, never a hardcoded
// legal assumption baked into calculation code: every fine-weight
// calculation reads the percentage from this table (or a snapshot copied
// from it), and Owner can add/edit/deactivate rows freely from Settings.
const STARTER_METAL_PURITIES: { metalType: "GOLD" | "SILVER" | "PLATINUM"; displayName: string; finenessPercent: string }[] = [
  { metalType: "GOLD", displayName: "10K", finenessPercent: "41.700" },
  { metalType: "GOLD", displayName: "14K", finenessPercent: "58.500" },
  { metalType: "GOLD", displayName: "18K", finenessPercent: "75.000" },
  { metalType: "GOLD", displayName: "22K", finenessPercent: "91.600" },
  { metalType: "GOLD", displayName: "24K", finenessPercent: "99.900" },
  { metalType: "SILVER", displayName: "925 Silver", finenessPercent: "92.500" },
  { metalType: "PLATINUM", displayName: "950 Platinum", finenessPercent: "95.000" },
];

// Phase 7 additions. Created ONLY when missing and never updated, so an
// Owner edit (e.g. a corrected fineness) is never silently reverted by a
// re-run — unlike STARTER_METAL_PURITIES above, which upserts.
const PHASE7_METAL_PURITIES: { metalType: "GOLD" | "ALLOY"; displayName: string; finenessPercent: string }[] = [
  { metalType: "GOLD", displayName: "9K", finenessPercent: "37.500" },
  // Company-owned alloy stock: real weight and cost, zero precious metal.
  { metalType: "ALLOY", displayName: "Copper/Alloy", finenessPercent: "0.000" },
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

async function seedMetalPurityMaster(prisma: PrismaClient, ownerId: string) {
  for (const purity of STARTER_METAL_PURITIES) {
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType: purity.metalType, displayName: purity.displayName } },
      update: { finenessPercent: purity.finenessPercent },
      create: {
        metalType: purity.metalType,
        displayName: purity.displayName,
        finenessPercent: purity.finenessPercent,
        createdByUserId: ownerId,
      },
    });
  }
  console.log(`Metal/Purity master ready: ${STARTER_METAL_PURITIES.length} starter purities.`);

  let phase7Created = 0;
  for (const purity of PHASE7_METAL_PURITIES) {
    const existing = await prisma.metalPurity.findUnique({
      where: { metalType_displayName: { metalType: purity.metalType, displayName: purity.displayName } },
    });
    if (existing) continue;
    await prisma.metalPurity.create({
      data: {
        metalType: purity.metalType,
        displayName: purity.displayName,
        finenessPercent: purity.finenessPercent,
        createdByUserId: ownerId,
      },
    });
    phase7Created += 1;
  }
  console.log(`Phase 7 purities ready: ${phase7Created} created, ${PHASE7_METAL_PURITIES.length - phase7Created} already present.`);
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
  await seedMetalPurityMaster(prisma, owner.id);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
