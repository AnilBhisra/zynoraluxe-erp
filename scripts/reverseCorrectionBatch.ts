import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { CORRECTION_TRANSACTION_OPTIONS } from "../src/lib/corrections/types";

/**
 * The correction engine reaches the posting engine, which starts with
 * `import "server-only"` — a module that deliberately throws outside Next's
 * bundler. Neutralising just that one import lets this operations script reuse
 * the exact posting code the app runs, rather than a second copy of it.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- deliberate: these
   modules must be loaded only after the `server-only` guard is neutralised,
   which a static import cannot express. */
function loadCorrectionEngine() {
  const nodeModule = require("node:module") as { _load: (...args: unknown[]) => unknown };
  const original = nodeModule._load;
  nodeModule._load = function patched(this: unknown, request: unknown, ...rest: unknown[]) {
    if (request === "server-only") return {};
    return original.call(this, request, ...rest);
  } as typeof nodeModule._load;
  try {
    return {
      ...(require("../src/lib/corrections/engine") as typeof import("../src/lib/corrections/engine")),
      ...(require("../src/lib/corrections/verify") as typeof import("../src/lib/corrections/verify")),
    };
  } finally {
    nodeModule._load = original;
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Owner rollback tool for a posted correction batch.
 *
 *   npx tsx scripts/reverseCorrectionBatch.ts <BATCH_CODE> "<reason>" --confirm
 *
 * Reverses every posted step, newest first. Each reversal posts a REVERSAL
 * voucher and records an audited reversing correction; the original is marked
 * REVERSED and linked to it. Nothing is ever deleted.
 *
 * Without --confirm it only prints what it would do.
 */
async function main() {
  const [batchCode, reason] = process.argv.slice(2);
  const confirmed = process.argv.includes("--confirm");
  if (!batchCode || !reason) {
    throw new Error('usage: reverseCorrectionBatch.ts <BATCH_CODE> "<reason>" [--confirm]');
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");

  const { reverseCorrectionBatch, planCorrectionBatchRollback, verifyCorrectionBatch } = loadCorrectionEngine();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const batch = await prisma.correctionBatch.findUnique({ where: { batchCode } });
    if (!batch) throw new Error(`No correction batch named ${batchCode}.`);

    const plan = await planCorrectionBatchRollback(prisma, batch.id);
    console.log(`batch ${plan.batchCode}: ${plan.detail}`);
    for (const step of plan.steps) {
      console.log(`  step ${step.step}  ${step.correctionCode}  ${step.voucherNumber ?? "-"}  ${step.amount}  ${step.voucherStatus}`);
    }
    if (!plan.ready) throw new Error("This batch is not in a state that can be rolled back.");
    if (!confirmed) {
      console.log("\nDry run — pass --confirm to reverse it.");
      return;
    }

    const owner = await prisma.user.findFirstOrThrow({ where: { role: "OWNER" }, orderBy: { createdAt: "asc" } });
    const settings = await prisma.companySettings.findUnique({ where: { id: "default" } });

    const reversals = await prisma.$transaction(
      (tx) =>
        reverseCorrectionBatch(tx, {
          batchId: batch.id,
          reason,
          approverRole: "OWNER",
          approvedByUserId: owner.id,
          fyStartMonth: settings?.financialYearStartMonth ?? 4,
          fyStartDay: settings?.financialYearStartDay ?? 1,
        }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    console.log(`\nreversed ${reversals.length} step(s): ${reversals.map((r) => r.correctionCode).join(", ")}`);

    for (const check of await verifyCorrectionBatch(prisma, batch.id)) {
      console.log(`  ${check.ok ? "ok  " : "NOTE"} ${check.name} — ${check.detail}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
