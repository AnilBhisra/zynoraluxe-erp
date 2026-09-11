import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";

// Not importing src/lib/auth/password.ts here: it starts with `import
// "server-only"`, which throws when required outside Next's own bundler
// (which special-cases that marker). This script is a standalone CLI tool,
// not a Server/Client Component, so the same salt-rounds constant is
// duplicated here rather than fighting that boundary.
const SALT_ROUNDS = 12;

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

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
