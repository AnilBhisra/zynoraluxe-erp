/**
 * Phase 8 Tier 8A — real-database acceptance for the correction framework.
 *
 * Runs against the isolated test database only (the wrapper that supplies
 * DATABASE_URL verifies current_database() before spawning, and this file
 * refuses to touch anything else). Nothing here ever reaches production.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  adjustMetalStock,
  getMetalStockBalanceInTx,
  postOpeningMetalStock,
  reverseMetalStockAdjustment,
} from "@/lib/jewellery/posting";
import {
  approveCorrectionDraft,
  ensureCorrectionBatch,
  postCorrection,
  reverseCorrection,
  reverseCorrectionBatch,
  saveCorrectionDraft,
} from "./engine";
import { listCorrections } from "./history";
import {
  planOpeningStockLedgerBackfill,
  planOpeningStockRevaluation,
} from "./openingStockCorrection";
import { CorrectionError } from "./types";
import {
  carryingValues,
  planCorrectionBatchRollback,
  reconcileMetalInventory,
  reconcileVoucherBalances,
  verifyCorrection,
  verifyCorrectionBatch,
} from "./verify";

const FY = { fyStartMonth: 4, fyStartDay: 1 };

let ownerId: string;
const purityIdByName = new Map<string, string>();

async function clearBusinessData() {
  await prisma.correctionImpact.deleteMany();
  await prisma.metalRevaluation.deleteMany();
  await prisma.correction.deleteMany();
  await prisma.correctionBatch.deleteMany();
  await prisma.journalEntry.deleteMany();
  await prisma.metalStockMovement.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.voucherSequence.deleteMany();
}

beforeAll(async () => {
  const [{ db }] = await prisma.$queryRawUnsafe<{ db: string }[]>("select current_database() as db");
  if (db !== "zynoraluxe_phase7_test") {
    throw new Error(`refusing to run against ${db}; the isolated test database is required`);
  }
  const owner = await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } });
  ownerId = owner.id;
  for (const p of await prisma.metalPurity.findMany()) purityIdByName.set(p.displayName, p.id);
  await clearBusinessData();
}, 60_000);

afterAll(async () => {
  await clearBusinessData();
});

describe("opening metal stock posts its own balanced voucher (defect D-2)", () => {
  const key = "phase8-opening-24k";

  it("writes Dr 1300 / Cr 3000 for the saved value, linked to the movement", async () => {
    const movement = await prisma.$transaction((tx) =>
      postOpeningMetalStock(tx, {
        metalType: "GOLD",
        purityId: purityIdByName.get("24K")!,
        grossWeight: "22.001",
        costValue: "160000.00",
        idempotencyKey: key,
        ...FY,
        createdByUserId: ownerId,
      })
    );

    expect(movement.voucherId).not.toBeNull();
    const voucher = await prisma.voucher.findUniqueOrThrow({
      where: { id: movement.voucherId! },
      include: { journalEntries: { include: { account: true } } },
    });
    expect(voucher.voucherType).toBe("OPENING_STOCK");
    expect(voucher.amount.toFixed(2)).toBe("160000.00");
    expect(voucher.voucherNumber).toMatch(/^OPEN-STK\//);

    const byCode = Object.fromEntries(
      voucher.journalEntries.map((e) => [e.account.code, { debit: e.debit.toFixed(2), credit: e.credit.toFixed(2) }])
    );
    expect(byCode["1300"]).toEqual({ debit: "160000.00", credit: "0.00" });
    expect(byCode["3000"]).toEqual({ debit: "0.00", credit: "160000.00" });
  }, 30_000);

  it("keeps the fineness snapshot of the purity at the moment it was saved", async () => {
    const movement = await prisma.metalStockMovement.findFirstOrThrow({ where: { idempotencyKey: key } });
    // 24K is 99.900% in this database: 22.001 x 0.999 = 21.979.
    expect(movement.fineWeight.toFixed(3)).toBe("21.979");
  });

  it("makes 1300 Metal Inventory agree with the metal stock value", async () => {
    const checks = await reconcileMetalInventory(prisma);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("never creates a second movement or voucher for a retried submission", async () => {
    await expect(
      prisma.$transaction((tx) =>
        postOpeningMetalStock(tx, {
          metalType: "GOLD",
          purityId: purityIdByName.get("24K")!,
          grossWeight: "22.001",
          costValue: "160000.00",
          idempotencyKey: key,
          ...FY,
          createdByUserId: ownerId,
        })
      )
    ).rejects.toThrow();

    expect(await prisma.metalStockMovement.count({ where: { idempotencyKey: key } })).toBe(1);
    expect(await prisma.voucher.count({ where: { voucherType: "OPENING_STOCK" } })).toBe(1);
  }, 30_000);
});

describe("R1 — bringing a pre-Phase-8 opening entry on to the books", () => {
  let legacyMovementId: string;

  beforeAll(async () => {
    // Exactly what production holds: a movement with no voucher at all.
    const legacy = await prisma.metalStockMovement.create({
      data: {
        type: "OPENING_IN",
        metalType: "GOLD",
        purityId: purityIdByName.get("22K")!,
        grossWeight: "10.000",
        fineWeight: "9.160",
        costValue: "100000.00",
        sourceDocument: "Opening stock",
        createdByUserId: ownerId,
      },
    });
    legacyMovementId = legacy.id;
  });

  it("plans Dr 1300 / Cr 3000 at the value the movement carries", async () => {
    const plan = await planOpeningStockLedgerBackfill(prisma, {
      movementId: legacyMovementId,
      reason: "Opening stock was never posted to the ledger (Phase 8 defect D-2).",
    });
    expect(plan.mode).toBe("REVERSE_REPOST");
    expect(plan.amount).toBe("100000.00");
    expect(plan.ledgerLines).toHaveLength(2);
    expect(plan.ledgerLines[0]).toMatchObject({ accountCode: "1300", debit: "100000.00" });
    expect(plan.ledgerLines[1]).toMatchObject({ accountCode: "3000", credit: "100000.00" });
  });

  it("posts it, leaves the movement untouched, and verifies clean", async () => {
    const plan = await planOpeningStockLedgerBackfill(prisma, {
      movementId: legacyMovementId,
      reason: "Opening stock was never posted to the ledger (Phase 8 defect D-2).",
    });
    const correction = await prisma.$transaction((tx) =>
      postCorrection(tx, {
        plan,
        preparedByUserId: ownerId,
        approvedByUserId: ownerId,
        approverRole: "OWNER",
        idempotencyKey: "phase8-r1",
        ...FY,
      })
    );

    expect(correction.state).toBe("POSTED");
    expect(correction.correctionCode).toMatch(/^CORR\//);

    const movement = await prisma.metalStockMovement.findUniqueOrThrow({ where: { id: legacyMovementId } });
    expect(movement.costValue.toFixed(2)).toBe("100000.00");
    expect(movement.fineWeight.toFixed(3)).toBe("9.160");
    expect(movement.voucherId).toBeNull();

    const checks = await verifyCorrection(prisma, correction.id);
    expect(checks.every((c) => c.ok)).toBe(true);
    expect((await reconcileVoucherBalances(prisma)).ok).toBe(true);
  }, 30_000);

  it("refuses to post it twice", async () => {
    await expect(
      planOpeningStockLedgerBackfill(prisma, { movementId: legacyMovementId, reason: "again" })
    ).rejects.toThrow(CorrectionError);
  });
});

describe("R2 — revaluing the opening layer", () => {
  let movementId: string;

  beforeAll(async () => {
    const opening = await prisma.$transaction((tx) =>
      postOpeningMetalStock(tx, {
        metalType: "GOLD",
        purityId: purityIdByName.get("18K")!,
        grossWeight: "20.000",
        costValue: "100000.00",
        idempotencyKey: "phase8-reval-open",
        ...FY,
        createdByUserId: ownerId,
      })
    );
    movementId = opening.id;
  });

  it("plans the uplift against the pool and ties it to the entry", async () => {
    const plan = await planOpeningStockRevaluation(prisma, {
      movementId,
      newCostValue: "250000.00",
      reason: "Opening gold was valued at half the actual purchase rate.",
    });
    expect(plan.mode).toBe("REVALUE");
    expect(plan.amount).toBe("150000.00");
    expect(plan.revaluations).toHaveLength(1);
    expect(plan.revaluations[0]).toMatchObject({
      target: "USABLE_POOL",
      oldCostValue: "100000.00",
      newCostValue: "250000.00",
      deltaCostValue: "150000.00",
    });
    // Original weights are carried for evidence but never restated.
    expect(plan.correctedSnapshot.grossWeight).toBe(plan.originalSnapshot.grossWeight);
    expect(plan.correctedSnapshot.finenessPercentSnapshot).toBe(
      plan.originalSnapshot.finenessPercentSnapshot
    );
  });

  it("posts, keeps the original movement byte-identical, and reconciles", async () => {
    const before = await prisma.metalStockMovement.findUniqueOrThrow({ where: { id: movementId } });
    const plan = await planOpeningStockRevaluation(prisma, {
      movementId,
      newCostValue: "250000.00",
      reason: "Opening gold was valued at half the actual purchase rate.",
    });
    const correction = await prisma.$transaction((tx) =>
      postCorrection(tx, {
        plan,
        preparedByUserId: ownerId,
        approvedByUserId: ownerId,
        approverRole: "OWNER",
        idempotencyKey: "phase8-r2",
        ...FY,
      })
    );

    const after = await prisma.metalStockMovement.findUniqueOrThrow({ where: { id: movementId } });
    expect(after.costValue.toFixed(2)).toBe(before.costValue.toFixed(2));
    expect(after.grossWeight.toFixed(3)).toBe(before.grossWeight.toFixed(3));
    expect(after.fineWeight.toFixed(3)).toBe(before.fineWeight.toFixed(3));

    const checks = await verifyCorrection(prisma, correction.id);
    expect(checks.every((c) => c.ok)).toBe(true);

    const reconciliation = await reconcileMetalInventory(prisma);
    expect(reconciliation.every((c) => c.ok)).toBe(true);
    expect((await reconcileVoucherBalances(prisma)).ok).toBe(true);
  }, 30_000);

  it("records the audit trail: who, why, original and corrected value", async () => {
    const correction = await prisma.correction.findFirstOrThrow({
      where: { entityId: movementId, state: "POSTED" },
      include: { impacts: true, revaluations: true, preparedBy: true, approvedBy: true },
    });
    expect(correction.reason).toContain("half the actual purchase rate");
    expect(correction.approvedBy?.id).toBe(ownerId);
    expect(correction.postedAt).not.toBeNull();
    expect((correction.originalSnapshot as Record<string, string>).costValue).toBe("100000.00");
    expect((correction.correctedSnapshot as Record<string, string>).costValue).toBe("250000.00");
    expect(correction.impacts.length).toBeGreaterThan(0);
    expect(correction.revaluations).toHaveLength(1);
  });

  it("refuses a correction that changes nothing", async () => {
    await expect(
      planOpeningStockRevaluation(prisma, {
        movementId,
        newCostValue: "100000.00",
        reason: "no change",
      })
    ).rejects.toThrow(CorrectionError);
  });
});

describe("permissions and approval safety", () => {
  let movementId: string;

  beforeAll(async () => {
    const opening = await prisma.$transaction((tx) =>
      postOpeningMetalStock(tx, {
        metalType: "SILVER",
        purityId: purityIdByName.get("925 Silver")!,
        grossWeight: "100.000",
        costValue: "50000.00",
        idempotencyKey: "phase8-perm-open",
        ...FY,
        createdByUserId: ownerId,
      })
    );
    movementId = opening.id;
  });

  it("refuses to post when the approver is Staff", async () => {
    const plan = await planOpeningStockRevaluation(prisma, {
      movementId,
      newCostValue: "60000.00",
      reason: "Staff must not be able to post this.",
    });
    await expect(
      prisma.$transaction((tx) =>
        postCorrection(tx, {
          plan,
          preparedByUserId: ownerId,
          approvedByUserId: ownerId,
          approverRole: "STAFF",
          ...FY,
        })
      )
    ).rejects.toThrow(/Only the Owner/);
    expect(await prisma.correction.count({ where: { entityId: movementId } })).toBe(0);
  }, 30_000);

  it("lets Staff prepare a draft that posts nothing", async () => {
    const plan = await planOpeningStockRevaluation(prisma, {
      movementId,
      newCostValue: "60000.00",
      reason: "Prepared by Staff for the Owner to review.",
    });
    const draft = await prisma.$transaction((tx) =>
      saveCorrectionDraft(tx, { plan, preparedByUserId: ownerId, submitForApproval: true })
    );
    expect(draft.state).toBe("AWAITING_APPROVAL");
    expect(draft.postedAt).toBeNull();
    expect(draft.correctionVoucherId).toBeNull();
    expect(await prisma.voucher.count({ where: { voucherType: "CORRECTION", note: { contains: "925 Silver" } } })).toBe(0);
  }, 30_000);

  it("refuses to approve a draft whose figures have since moved", async () => {
    const draft = await prisma.correction.findFirstOrThrow({
      where: { entityId: movementId, state: "AWAITING_APPROVAL" },
    });

    // The world moves: more silver arrives, so the preview is now stale.
    await prisma.$transaction((tx) =>
      postOpeningMetalStock(tx, {
        metalType: "SILVER",
        purityId: purityIdByName.get("925 Silver")!,
        grossWeight: "10.000",
        costValue: "6000.00",
        idempotencyKey: "phase8-perm-open-2",
        ...FY,
        createdByUserId: ownerId,
      })
    );

    const freshPlan = await planOpeningStockRevaluation(prisma, {
      movementId,
      newCostValue: "60000.00",
      reason: "Prepared by Staff for the Owner to review.",
    });

    await expect(
      prisma.$transaction((tx) =>
        approveCorrectionDraft(tx, {
          correctionId: draft.id,
          freshPlan,
          approvedByUserId: ownerId,
          approverRole: "OWNER",
          ...FY,
        })
      )
    ).rejects.toThrow(/changed after this correction was prepared/);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// R1 + R2 as ONE cumulative correction batch
// ---------------------------------------------------------------------------

// One suite, so its setup runs after the suites above have finished with
// the shared test database rather than before all of them.
describe("R1 and R2 as one cumulative production correction batch", () => {
  const BATCH_CODE = "TEST-OPENING-BATCH";

  let purity24kId: string;
  let purity18kId: string;
  let batchMovementId: string;
  let batchId: string;
  let r1Id: string;
  let r2Id: string;
  let job68Id: string;
  let fj86Id: string;
  let fj87Id: string;

  /** Values as they stand before any correction — production's exact figures. */
  const BEFORE = {
    pool: "102657.40",
    job68Wip: "42425.96",
    fj86Metal: "30298.01",
    fj87Metal: "15668.63",
    acc1300: "-57342.60",
    acc1320: "42425.96",
    acc1330: "86594.68",
  };
  /** The approved post-correction figures from PHASE_8_REVALUATION_PREVIEW.md. */
  const AFTER = {
    pool: "193361.21",
    job68Wip: "93248.01",
    fj86Metal: "66592.00",
    fj87Metal: "29512.78",
    acc1300: "193361.21",
    acc1320: "93248.01",
    acc1330: "136732.82",
  };

  async function accountBalance(code: string): Promise<string> {
    const account = await prisma.account.findUniqueOrThrow({ where: { code } });
    const totals = await prisma.journalEntry.aggregate({
      where: { accountId: account.id },
      _sum: { debit: true, credit: true },
    });
    return (Number(totals._sum.debit ?? 0) - Number(totals._sum.credit ?? 0)).toFixed(2);
  }

  async function snapshot() {
    return carryingValues(prisma, { jobIds: [job68Id], finishedJewelleryIds: [fj86Id, fj87Id] });
  }

  beforeAll(async () => {
    // Starts from a clean ledger so the batch's account balances are its own.
    await clearBusinessData();
    await prisma.finishedJewellery.deleteMany();
    await prisma.jewelleryReceipt.deleteMany();
    await prisma.jewelleryJob.deleteMany();
    await prisma.party.deleteMany();

    purity24kId = (await prisma.metalPurity.findFirstOrThrow({ where: { displayName: "24K" } })).id;
    purity18kId = (await prisma.metalPurity.findFirstOrThrow({ where: { displayName: "18K" } })).id;

    const karigar = await prisma.party.create({
      data: { name: "Test Karigar", type: "KARIGAR", createdByUserId: ownerId },
    });

    // ---- Production's shape: two jobs, two receipts, two finished pieces ----
    const job68 = await prisma.jewelleryJob.create({
      data: {
        jobCode: "ZL-JJOB-2026-000068",
        jewelleryType: "RING",
        designName: "ZL-R-BND-015",
        karigarId: karigar.id,
        issueDate: new Date("2026-09-01"),
        status: "PARTIALLY_RECEIVED",
        issuedMetalFineWeight: "9.990",
        issuedMetalCost: "72723.97",
        issuedPacketDiamondCost: "20102.04",
        receivedFineWeight: "4.162",
        remainingWipCost: BEFORE.job68Wip,
        createdByUserId: ownerId,
      },
    });
    job68Id = job68.id;
    const receipt52 = await prisma.jewelleryReceipt.create({
      data: {
        receiptCode: "ZL-JREC-2026-000052",
        jobId: job68.id,
        receiveDate: new Date("2026-09-17"),
        labourCharge: "6571.00",
        createdByUserId: ownerId,
      },
    });
    const fj86 = await prisma.finishedJewellery.create({
      data: {
        finishedCode: "ZL-FJ-2026-000086",
        receiptId: receipt52.id,
        jobId: job68.id,
        jewelleryType: "RING",
        grossWeight: "5.980",
        netMetalWeight: "5.476",
        metalType: "GOLD",
        purityId: purity18kId,
        finenessPercentSnapshot: "76.000",
        fineMetalWeight: "4.162",
        metalCost: BEFORE.fj86Metal,
        diamondCost: "20102.04",
        labourAllocated: "6571.00",
        totalCost: "56971.05",
        createdByUserId: ownerId,
      },
    });
    fj86Id = fj86.id;

    const job69 = await prisma.jewelleryJob.create({
      data: {
        jobCode: "ZL-JJOB-2026-000069",
        jewelleryType: "RING",
        designName: "ZL-R-OV-001",
        karigarId: karigar.id,
        issueDate: new Date("2026-09-19"),
        status: "COMPLETED",
        issuedMetalFineWeight: "2.000",
        issuedMetalCost: "16902.51",
        issuedPacketDiamondCost: "11880.00",
        receivedFineWeight: "1.854",
        returnedMetalFineWeight: "0.146",
        remainingWipCost: "0.00",
        createdByUserId: ownerId,
      },
    });
    const receipt53 = await prisma.jewelleryReceipt.create({
      data: {
        receiptCode: "ZL-JREC-2026-000053",
        jobId: job69.id,
        receiveDate: new Date("2026-09-19"),
        returnedMetalGrossWeight: "0.146",
        returnedMetalFineWeight: "0.146",
        makingCharge: "2075.00",
        createdByUserId: ownerId,
      },
    });
    const fj87 = await prisma.finishedJewellery.create({
      data: {
        finishedCode: "ZL-FJ-2026-000087",
        receiptId: receipt53.id,
        jobId: job69.id,
        jewelleryType: "RING",
        grossWeight: "2.700",
        netMetalWeight: "2.440",
        metalType: "GOLD",
        purityId: purity18kId,
        finenessPercentSnapshot: "76.000",
        fineMetalWeight: "1.854",
        metalCost: BEFORE.fj87Metal,
        diamondCost: "11880.00",
        labourAllocated: "2075.00",
        totalCost: "29623.63",
        createdByUserId: ownerId,
      },
    });
    fj87Id = fj87.id;

    // ---- The 24K metal ledger, exactly as production holds it ----
    const movement = async (
      type: "OPENING_IN" | "PURCHASE_IN" | "ISSUE_OUT" | "RETURN_IN" | "CONSUMED_OUT",
      gross: string,
      fine: string,
      cost: string,
      sourceDocument: string,
      jewelleryJobId: string | null
    ) =>
      prisma.metalStockMovement.create({
        data: {
          type,
          metalType: "GOLD",
          purityId: purity24kId,
          grossWeight: gross,
          fineWeight: fine,
          costValue: cost,
          sourceDocument,
          jewelleryJobId,
          createdByUserId: ownerId,
        },
      });

    const opening = await movement("OPENING_IN", "22.001", "21.979", "160000.00", "Opening stock", null);
    batchMovementId = opening.id;
    await movement("ISSUE_OUT", "10.000", "9.990", "72723.97", "ZL-JJOB-2026-000068", job68.id);
    await movement("CONSUMED_OUT", "0.000", "4.162", "30298.01", "ZL-JREC-2026-000052", job68.id);
    await movement("PURCHASE_IN", "2.000", "2.000", "31050.00", "ZL-MP-2026-000057", null);
    await movement("ISSUE_OUT", "2.000", "2.000", "16902.51", "ZL-JJOB-2026-000069", job69.id);
    await movement("RETURN_IN", "0.146", "0.146", "1233.88", "ZL-JREC-2026-000053", job69.id);
    await movement("CONSUMED_OUT", "0.000", "1.854", "15668.63", "ZL-JREC-2026-000053", job69.id);

    // ---- The vouchers those movements posted, so the trial balance starts
    // where production's does: 1300 negative because opening never posted ----
    const accountId = async (code: string) =>
      (await prisma.account.findUniqueOrThrow({ where: { code } })).id;
    const postVoucher = async (
      voucherNumber: string,
      voucherType: "PURCHASE" | "JEWELLERY_ISSUE" | "JEWELLERY_RECEIPT",
      amount: string,
      lines: { code: string; debit?: string; credit?: string }[]
    ) => {
      const voucher = await prisma.voucher.create({
        data: {
          voucherNumber,
          voucherType,
          date: new Date("2026-09-19"),
          financialYearLabel: "2026-27",
          amount,
          createdByUserId: ownerId,
        },
      });
      for (const line of lines) {
        await prisma.journalEntry.create({
          data: {
            voucherId: voucher.id,
            accountId: await accountId(line.code),
            debit: line.debit ?? "0.00",
            credit: line.credit ?? "0.00",
          },
        });
      }
    };

    await postVoucher("JWL-ISS/2026-27/0055", "JEWELLERY_ISSUE", "92826.01", [
      { code: "1320", debit: "92826.01" },
      { code: "1300", credit: "72723.97" },
      { code: "1220", credit: "20102.04" },
    ]);
    await postVoucher("JWL-REC/2026-27/0052", "JEWELLERY_RECEIPT", "56971.05", [
      { code: "1330", debit: "56971.05" },
      { code: "1320", credit: "50400.05" },
      { code: "2000", credit: "6571.00" },
    ]);
    await postVoucher("PUR/2026-27/0115", "PURCHASE", "31050.00", [
      { code: "1300", debit: "31050.00" },
      { code: "2000", credit: "31050.00" },
    ]);
    await postVoucher("JWL-ISS/2026-27/0056", "JEWELLERY_ISSUE", "28782.51", [
      { code: "1320", debit: "28782.51" },
      { code: "1300", credit: "16902.51" },
      { code: "1220", credit: "11880.00" },
    ]);
    await postVoucher("JWL-REC/2026-27/0053", "JEWELLERY_RECEIPT", "30857.51", [
      { code: "1330", debit: "29623.63" },
      { code: "1300", debit: "1233.88" },
      { code: "1320", credit: "28782.51" },
      { code: "2000", credit: "2075.00" },
    ]);
  }, 120_000);

  it("reproduces production's starting state, including the negative 1300", async () => {
    expect(await accountBalance("1300")).toBe(BEFORE.acc1300);
    expect(await accountBalance("1320")).toBe(BEFORE.acc1320);
    expect(await accountBalance("1330")).toBe(BEFORE.acc1330);

    const before = await snapshot();
    expect(before.usablePool).toBe(BEFORE.pool);
    expect(before.jobWip[job68Id]).toBe(BEFORE.job68Wip);
    expect(before.finishedPieces[fj86Id]).toBe(BEFORE.fj86Metal);
    expect(before.finishedPieces[fj87Id]).toBe(BEFORE.fj87Metal);

    const checks = await reconcileMetalInventory(prisma);
    expect(checks[0].ok).toBe(false);
  }, 60_000);

  it("posts R1 as step 1 and leaves the batch open", async () => {
    const result = await prisma.$transaction(async (tx) => {
      const batch = await ensureCorrectionBatch(tx, {
        batchCode: BATCH_CODE,
        purpose: "Opening gold: post to the ledger, then revalue.",
        requiredSteps: 2,
        createdByUserId: ownerId,
      });
      const plan = await planOpeningStockLedgerBackfill(tx, {
        movementId: batchMovementId,
        reason: "Opening metal stock was never posted to the ledger (defect D-2).",
      });
      const correction = await postCorrection(tx, {
        plan,
        preparedByUserId: ownerId,
        approvedByUserId: ownerId,
        approverRole: "OWNER",
        idempotencyKey: "test-batch-r1",
        batch: { batchId: batch.id, step: 1 },
        ...FY,
      });
      return { batchId: batch.id, correctionId: correction.id };
    });
    batchId = result.batchId;
    r1Id = result.correctionId;

    const batch = await prisma.correctionBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.state).toBe("OPEN");
    // R1 alone makes 1300 agree with the stock at the OLD basis.
    expect(await accountBalance("1300")).toBe(BEFORE.pool);
  }, 60_000);

  it("posts R2 as step 2, completes the batch, and lands the approved figures", async () => {
    const correction = await prisma.$transaction(async (tx) => {
      const plan = await planOpeningStockRevaluation(tx, {
        movementId: batchMovementId,
        newCostValue: "351664.00",
        reason: "Opening gold was valued at half the actual purchase rate.",
      });
      // The approved split, before anything is written.
      expect(plan.amount).toBe("191664.00");
      return postCorrection(tx, {
        plan,
        preparedByUserId: ownerId,
        approvedByUserId: ownerId,
        approverRole: "OWNER",
        idempotencyKey: "test-batch-r2",
        batch: { batchId, step: 2 },
        ...FY,
      });
    });
    r2Id = correction.id;

    const batch = await prisma.correctionBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.state).toBe("COMPLETE");
    expect(batch.completedAt).not.toBeNull();

    expect(await accountBalance("1300")).toBe(AFTER.acc1300);
    expect(await accountBalance("1320")).toBe(AFTER.acc1320);
    expect(await accountBalance("1330")).toBe(AFTER.acc1330);
    expect(await accountBalance("3000")).toBe("-351664.00");

    const after = await snapshot();
    expect(after.usablePool).toBe(AFTER.pool);
    expect(after.jobWip[job68Id]).toBe(AFTER.job68Wip);
    expect(after.finishedPieces[fj86Id]).toBe(AFTER.fj86Metal);
    expect(after.finishedPieces[fj87Id]).toBe(AFTER.fj87Metal);
  }, 60_000);

  it("makes the NEXT issue or adjustment use the corrected average, not the old one", async () => {
    // The whole point of the phase: a correction that moves the ledger but
    // leaves the posting engine costing at the old basis would recreate the
    // defect on the very next movement.
    const pool = await getMetalStockBalanceInTx(prisma, "GOLD", purity24kId);
    expect(pool.costValue.toFixed(2)).toBe(AFTER.pool);
    expect(pool.costValue.dividedBy(pool.grossWeight).toFixed(4)).toBe("15918.4334");

    const beforeAdjustment = await prisma.metalStockMovement.count();
    const adjustment = await prisma.$transaction((tx) =>
      adjustMetalStock(tx, {
        metalType: "GOLD",
        purityId: purity24kId,
        mode: "IN",
        grossWeight: "1.000",
        reason: "Quantity-only count correction after the revaluation",
        ...FY,
        createdByUserId: ownerId,
      })
    );
    expect(adjustment.costValue.toFixed(2)).toBe("15918.43");
    expect(await prisma.metalStockMovement.count()).toBe(beforeAdjustment + 1);

    // Undo it so the later rollback assertions start from the posted state.
    await prisma.$transaction((tx) =>
      reverseMetalStockAdjustment(tx, {
        movementId: adjustment.id,
        reason: "Undoing the probe adjustment",
        ...FY,
        createdByUserId: ownerId,
      })
    );
  }, 60_000);

  it("keeps BOTH corrections posted and active — neither replaces the other", async () => {
    const [r1, r2] = await Promise.all([
      prisma.correction.findUniqueOrThrow({ where: { id: r1Id } }),
      prisma.correction.findUniqueOrThrow({ where: { id: r2Id } }),
    ]);

    expect(r1.state).toBe("POSTED");
    expect(r2.state).toBe("POSTED");
    // The supersede link is what would mark R1 replaced; a batch must not use it.
    expect(r1.supersedesCorrectionId).toBeNull();
    expect(r2.supersedesCorrectionId).toBeNull();
    expect(await prisma.correction.count({ where: { supersedesCorrectionId: r1Id } })).toBe(0);
    expect(r1.rejectionReason).toBeNull();
    expect(r1.batchStep).toBe(1);
    expect(r2.batchStep).toBe(2);
  });

  it("is cumulative: neither step alone produces this ledger", async () => {
    expect(await accountBalance("1300")).not.toBe(BEFORE.pool);
    expect(await accountBalance("1300")).not.toBe("191664.00");
  }, 30_000);

  it("verifies the batch as one correction made of two required steps", async () => {
    const checks = await verifyCorrectionBatch(prisma, batchId);
    expect(checks.filter((c) => !c.ok).map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
  }, 30_000);

  it("verifies each step on its own and reconciles the metal ledger", async () => {
    for (const id of [r1Id, r2Id]) {
      expect((await verifyCorrection(prisma, id)).filter((c) => !c.ok)).toEqual([]);
    }
    expect((await reconcileMetalInventory(prisma)).every((c) => c.ok)).toBe(true);
    expect((await reconcileVoucherBalances(prisma)).ok).toBe(true);
  }, 30_000);

  it("refuses a second posting into a step that is already taken", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const plan = await planOpeningStockRevaluation(tx, {
          movementId: batchMovementId,
          newCostValue: "400000.00",
          reason: "Trying to reuse step 2.",
        });
        return postCorrection(tx, {
          plan,
          preparedByUserId: ownerId,
          approvedByUserId: ownerId,
          approverRole: "OWNER",
          batch: { batchId, step: 2 },
          ...FY,
        });
      })
    ).rejects.toThrow(/already posted/);
  }, 30_000);

  it("refuses to mix a batch step with a supersede link", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const plan = await planOpeningStockRevaluation(tx, {
          movementId: batchMovementId,
          newCostValue: "400000.00",
          reason: "Trying both link kinds at once.",
        });
        return postCorrection(tx, {
          plan,
          preparedByUserId: ownerId,
          approvedByUserId: ownerId,
          approverRole: "OWNER",
          batch: { batchId, step: 1 },
          supersedesCorrectionId: r1Id,
          ...FY,
        });
      })
    ).rejects.toThrow(/cannot both replace another correction and be a cumulative step/);
  }, 30_000);

  it("refuses a step outside the batch", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const plan = await planOpeningStockRevaluation(tx, {
          movementId: batchMovementId,
          newCostValue: "400000.00",
          reason: "Step three of a two-step batch.",
        });
        return postCorrection(tx, {
          plan,
          preparedByUserId: ownerId,
          approvedByUserId: ownerId,
          approverRole: "OWNER",
          batch: { batchId, step: 3 },
          ...FY,
        });
      })
    ).rejects.toThrow(/outside batch/);
  }, 30_000);

  it("refuses to reopen the same batch code with a different number of steps", async () => {
    await expect(
      prisma.$transaction((tx) =>
        ensureCorrectionBatch(tx, {
          batchCode: BATCH_CODE,
          purpose: "same code, different shape",
          requiredSteps: 3,
          createdByUserId: ownerId,
        })
      )
    ).rejects.toThrow(CorrectionError);
  }, 30_000);

  it("lists both steps in history as POSTED parts of one batch", async () => {
    const rows = await listCorrections();
    const r1 = rows.find((r) => r.id === r1Id);
    const r2 = rows.find((r) => r.id === r2Id);
    for (const row of [r1, r2]) {
      expect(row?.state).toBe("POSTED");
      expect(row?.batchCode).toBe(BATCH_CODE);
      expect(row?.batchRequiredSteps).toBe(2);
      expect(row?.batchState).toBe("COMPLETE");
      expect(row?.rejectionReason).toBeNull();
    }
    expect(r1?.batchStep).toBe(1);
    expect(r2?.batchStep).toBe(2);
    expect(r1?.originalValue).toBe("160000.00");
    expect(r2?.correctedValue).toBe("351664.00");
  }, 30_000);

  it("reports the batch as rollback-ready, newest step first", async () => {
    const plan = await planCorrectionBatchRollback(prisma, batchId);
    expect(plan.ready).toBe(true);
    expect(plan.steps.map((s) => s.step)).toEqual([2, 1]);
    expect(plan.steps[0].amount).toBe("191664.00");
    expect(plan.steps[1].amount).toBe("160000.00");
  }, 30_000);

  it("refuses to let Staff reverse the batch", async () => {
    await expect(
      prisma.$transaction((tx) =>
        reverseCorrectionBatch(tx, {
          batchId,
          reason: "Staff attempt",
          approverRole: "STAFF",
          approvedByUserId: ownerId,
          ...FY,
        })
      )
    ).rejects.toThrow(/Only the Owner/);
  }, 30_000);

  it("rolls the whole batch back to the EXACT pre-correction values", async () => {
    const reversals = await prisma.$transaction((tx) =>
      reverseCorrectionBatch(tx, {
        batchId,
        reason: "Owner asked for the whole correction to be undone",
        approverRole: "OWNER",
        approvedByUserId: ownerId,
        ...FY,
      })
    );
    expect(reversals).toHaveLength(2);

    // 1. Ledger accounts.
    expect(await accountBalance("1300")).toBe(BEFORE.acc1300);
    expect(await accountBalance("1320")).toBe(BEFORE.acc1320);
    expect(await accountBalance("1330")).toBe(BEFORE.acc1330);
    expect(await accountBalance("3000")).toBe("0.00");

    // 2. The four carrying values named in the rollback requirement.
    const restored = await snapshot();
    expect(restored.usablePool).toBe(BEFORE.pool);
    expect(restored.jobWip[job68Id]).toBe(BEFORE.job68Wip);
    expect(restored.finishedPieces[fj86Id]).toBe(BEFORE.fj86Metal);
    expect(restored.finishedPieces[fj87Id]).toBe(BEFORE.fj87Metal);

    // 3. Every voucher still balances, including the new reversals.
    expect((await reconcileVoucherBalances(prisma)).ok).toBe(true);
  }, 120_000);

  it("records the rollback as audited reversing corrections, deleting nothing", async () => {
    const rows = await listCorrections();

    const r1 = rows.find((r) => r.id === r1Id);
    const r2 = rows.find((r) => r.id === r2Id);
    // The originals survive, and neither can be mistaken for still applying.
    expect(r1?.state).toBe("REVERSED");
    expect(r2?.state).toBe("REVERSED");

    const [r1Row, r2Row] = await Promise.all([
      prisma.correction.findUniqueOrThrow({ where: { id: r1Id }, include: { reversedBy: true } }),
      prisma.correction.findUniqueOrThrow({ where: { id: r2Id }, include: { reversedBy: true } }),
    ]);
    for (const row of [r1Row, r2Row]) {
      expect(row.reversedByCorrectionId).not.toBeNull();
      expect(row.reversedBy?.mode).toBe("REVERSAL");
      expect(row.reversedBy?.state).toBe("POSTED");
      expect(row.reversedBy?.reason).toContain("undone");
    }

    // Each reversal posted a real voucher of its own, and the original
    // correction vouchers are marked CANCELLED rather than removed.
    // Only the two that reversed the batch's own correction vouchers; the
    // adjustment probe earlier in this suite reversed one of its own.
    const reversalVouchers = await prisma.voucher.findMany({
      where: { voucherType: "REVERSAL", reversalOfVoucher: { is: { voucherType: "CORRECTION" } } },
    });
    expect(reversalVouchers).toHaveLength(2);
    const cancelled = await prisma.voucher.findMany({
      where: { voucherType: "CORRECTION", status: "CANCELLED" },
    });
    expect(cancelled).toHaveLength(2);

    // Nothing about the corrected record ever moved.
    const movement = await prisma.metalStockMovement.findUniqueOrThrow({ where: { id: batchMovementId } });
    expect(movement.costValue.toFixed(2)).toBe("160000.00");
    expect(movement.fineWeight.toFixed(3)).toBe("21.979");
  }, 60_000);

  it("reopens the batch and reports it as no longer rollback-ready", async () => {
    const batch = await prisma.correctionBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.state).toBe("OPEN");

    const plan = await planCorrectionBatchRollback(prisma, batchId);
    expect(plan.ready).toBe(false);

    const checks = await verifyCorrectionBatch(prisma, batchId);
    const stillActive = checks.find((c) => c.name === "every step is still POSTED and active");
    expect(stillActive?.ok).toBe(false);
    expect(stillActive?.detail).toContain("REVERSED");
  }, 30_000);

  it("refuses to reverse a correction twice", async () => {
    await expect(
      prisma.$transaction((tx) =>
        reverseCorrection(tx, {
          correctionId: r2Id,
          reason: "Trying again",
          approverRole: "OWNER",
          approvedByUserId: ownerId,
          ...FY,
        })
      )
    ).rejects.toThrow(/already been reversed/);
  }, 30_000);
});
