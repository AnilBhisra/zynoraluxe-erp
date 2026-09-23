/**
 * Phase 8 Tier 8A — real-database acceptance for the correction framework.
 *
 * Runs against the isolated test database only (the wrapper that supplies
 * DATABASE_URL verifies current_database() before spawning, and this file
 * refuses to touch anything else). Nothing here ever reaches production.
 */
import "dotenv/config";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/db/prisma";
import {
  adjustMetalStock,
  getMetalStockBalanceInTx,
  postOpeningMetalStock,
  reverseMetalStockAdjustment,
} from "@/lib/jewellery/posting";
import { getJewelleryJobDetail, listFinishedJewelleryStock, listJewelleryJobs } from "@/lib/jewellery/reports";
import { CARRYING_COST_UNAVAILABLE, isUnavailable } from "@/lib/jewellery/carryingCost";
import { serializeJobCostSummary } from "@/lib/jewellery/jobDetailSerializers";
import { replayPurityAtCurrentValues } from "./jobCostReplay";
import type { Decimal } from "@/lib/accounting/money";
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
import { CORRECTION_TRANSACTION_OPTIONS, CorrectionError } from "./types";
import {
  carryingValues,
  planCorrectionBatchRollback,
  reconcileMetalInventory,
  reconcileVoucherBalances,
  verifyCorrection,
  verifyCorrectionBatch,
} from "./verify";

/** Every carrying-cost figure in this suite is a real Decimal, never the
 * fail-closed sentinel — narrows the type for `.toFixed()`. */
function amount(v: Decimal | "UNAVAILABLE"): Decimal {
  if (typeof v === "string") throw new Error("expected a Decimal, got the unavailable sentinel");
  return v;
}

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
  let job69Id: string;
  let job68IssueOutId: string;
  let job69IssueOutId: string;
  let job69ReturnInId: string;
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
    job69Id = job69.id;
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
    job68IssueOutId = (await movement("ISSUE_OUT", "10.000", "9.990", "72723.97", "ZL-JJOB-2026-000068", job68.id)).id;
    await movement("CONSUMED_OUT", "0.000", "4.162", "30298.01", "ZL-JREC-2026-000052", job68.id);
    await movement("PURCHASE_IN", "2.000", "2.000", "31050.00", "ZL-MP-2026-000057", null);
    job69IssueOutId = (await movement("ISSUE_OUT", "2.000", "2.000", "16902.51", "ZL-JJOB-2026-000069", job69.id)).id;
    job69ReturnInId = (await movement("RETURN_IN", "0.146", "0.146", "1233.88", "ZL-JREC-2026-000053", job69.id)).id;
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

  // ---------------------------------------------------------------------------
  // Phase 8B — the Owner-facing display defect: Job 68 and Job 69 kept
  // showing their ORIGINAL snapshot costs after R1+R2 posted, even though the
  // ledger, WIP and Finished Stock were already correct. This proves every
  // Owner-facing read path now shows the replayed, current figure — and that
  // replaying it repeatedly, or through different entry points (job detail,
  // job list, finished stock), never produces two different numbers for the
  // same fact (the "no double counting" requirement).
  // ---------------------------------------------------------------------------
  it("Job 68's read model shows the corrected figures, matching across detail, list and finished stock", async () => {
    // The whole 22.001g opening layer was issued to job 68 in one line, so
    // its own ISSUE_OUT movement replays to the exact corrected total.
    const purityOutcome = await replayPurityAtCurrentValues(prisma, "GOLD", purity24kId);
    expect(purityOutcome.ok).toBe(true);
    if (purityOutcome.ok) {
      expect(purityOutcome.movements.get(job68IssueOutId)!.newValue.toFixed(2)).toBe("159840.01");
    }

    const detail = (await getJewelleryJobDetail(job68Id))!;
    expect(isUnavailable(detail.issuedMetalCost)).toBe(false);
    expect(amount(detail.issuedMetalCost).toFixed(2)).toBe("159840.01");
    expect(amount(detail.remainingWipCost).toFixed(2)).toBe("93248.01");
    const owner = serializeJobCostSummary(detail, true);
    expect(owner.issuedMetalCost).toBe("159840.01");
    expect(owner.issuedDiamondCost).toBe("20102.04"); // unchanged — diamonds never revalued
    expect(owner.totalIssuedCost).toBe("179942.05");
    const staff = serializeJobCostSummary(detail, false);
    expect(staff.issuedMetalCost).toBeNull();
    expect(staff.totalIssuedCost).toBeNull();

    const fj86Output = detail.finishedOutputs.find((o) => o.id === fj86Id)!;
    expect(fj86Output.totalCost.toFixed(2)).toBe("56971.05"); // original, unchanged — for OverrideAllocationForm
    expect(isUnavailable(fj86Output.totalCostCurrent)).toBe(false);
    expect(amount(fj86Output.totalCostCurrent).toFixed(2)).toBe("93265.04"); // 66592.00 + 20102.04 + 6571.00

    // The job list must show the exact same total as the detail page.
    const rows = await listJewelleryJobs({ search: "ZL-JJOB-2026-000068" });
    const listRow = rows.find((r) => r.id === job68Id)!;
    expect(isUnavailable(listRow.totalIssuedCost)).toBe(false);
    expect(amount(listRow.totalIssuedCost).toFixed(2)).toBe("179942.05");

    // The finished-stock list must show the same carrying cost as the job
    // detail's own finished-output line for the same piece.
    const stockRows = await listFinishedJewelleryStock({ search: "ZL-FJ-2026-000086", includeCost: true });
    const stockRow = stockRows.find((r) => r.id === fj86Id)!;
    expect(isUnavailable(stockRow.inventoryCost!)).toBe(false);
    expect(amount(stockRow.inventoryCost!).toFixed(2)).toBe(
      amount(fj86Output.totalCostCurrent).toFixed(2)
    );

    // Calling it again must give the exact same figure — nothing accumulates.
    const secondRead = (await getJewelleryJobDetail(job68Id))!;
    expect(amount(secondRead.issuedMetalCost).toFixed(2)).toBe("159840.01");
  }, 30_000);

  it("Job 69's read model matches the documented replay math — including the returned-metal split", async () => {
    const detail = (await getJewelleryJobDetail(job69Id))!;
    expect(isUnavailable(detail.issuedMetalCost)).toBe(false);
    // PHASE_8_REVALUATION_PREVIEW.md: 2.000g x Rs 15,918.4337/g = Rs 31,836.87.
    expect(amount(detail.issuedMetalCost).toFixed(2)).toBe("31836.87");
    expect(amount(detail.remainingWipCost).toFixed(2)).toBe("0.00");
    const owner = serializeJobCostSummary(detail, true);
    expect(owner.issuedMetalCost).toBe("31836.87");
    expect(owner.issuedDiamondCost).toBe("11880.00"); // unchanged
    expect(owner.totalIssuedCost).toBe("43716.87");

    const fj87Output = detail.finishedOutputs.find((o) => o.id === fj87Id)!;
    expect(fj87Output.totalCost.toFixed(2)).toBe("29623.63"); // original, unchanged
    expect(amount(fj87Output.totalCostCurrent).toFixed(2)).toBe("43467.78"); // 29512.78 + 11880.00 + 2075.00

    // The returned 0.146g is revalued too, at the same corrected pool rate —
    // and that value is what feeds the usable pool's own +90,703.81 uplift,
    // never counted a second time as part of what job 69 "kept".
    const outcome = await replayPurityAtCurrentValues(prisma, "GOLD", purity24kId);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.movements.get(job69IssueOutId)!.newValue.toFixed(2)).toBe("31836.87");
      expect(outcome.movements.get(job69ReturnInId)!.newValue.toFixed(2)).toBe("2324.09");
    }

    const rows = await listJewelleryJobs({ search: "ZL-JJOB-2026-000069" });
    const listRow = rows.find((r) => r.id === job69Id)!;
    expect(amount(listRow.totalIssuedCost).toFixed(2)).toBe("43716.87");
  }, 30_000);

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

  it("completes a correction transaction that runs past Prisma's old 5-second default", async () => {
    // The production revaluation was rolled back because the posting
    // transaction exceeded Prisma's interactive default against a remote
    // database. With the shared options it survives a deliberately slow run.
    const before = await prisma.correction.count();
    const started = Date.now();
    const posted = await prisma.$transaction(async (tx) => {
      const plan = await planOpeningStockRevaluation(tx, {
        movementId: batchMovementId,
        newCostValue: "351665.00",
        reason: "Deliberately slow transaction, to prove the timeout is raised.",
      });
      // Longer than the 5,000 ms default, comfortably inside the new 30,000.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      return postCorrection(tx, {
        plan,
        preparedByUserId: ownerId,
        approvedByUserId: ownerId,
        approverRole: "OWNER",
        idempotencyKey: "test-slow-transaction",
        ...FY,
      });
    }, CORRECTION_TRANSACTION_OPTIONS);

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThan(5_000);
    expect(posted.state).toBe("POSTED");
    expect(await prisma.correction.count()).toBe(before + 1);

    // Undo it so the batch assertions below start from the posted state.
    await prisma.$transaction(
      (tx) =>
        reverseCorrection(tx, {
          correctionId: posted.id,
          reason: "Undoing the slow-transaction probe",
          approverRole: "OWNER",
          approvedByUserId: ownerId,
          ...FY,
        }),
      CORRECTION_TRANSACTION_OPTIONS
    );
  }, 90_000);

  it("leaves nothing behind when a correction transaction fails part-way", async () => {
    const before = {
      corrections: await prisma.correction.count(),
      vouchers: await prisma.voucher.count(),
      journalEntries: await prisma.journalEntry.count(),
      impacts: await prisma.correctionImpact.count(),
      revaluations: await prisma.metalRevaluation.count(),
      sequence: (await prisma.voucherSequence.findFirst({ where: { voucherType: "CORRECTION" } }))?.lastNumber ?? 0,
    };

    await expect(
      prisma.$transaction(async (tx) => {
        const plan = await planOpeningStockRevaluation(tx, {
          movementId: batchMovementId,
          newCostValue: "360000.00",
          reason: "This transaction is about to fail on purpose.",
        });
        await postCorrection(tx, {
          plan,
          preparedByUserId: ownerId,
          approvedByUserId: ownerId,
          approverRole: "OWNER",
          ...FY,
        });
        // Everything above is written; this abandons all of it.
        throw new Error("deliberate failure after the writes");
      }, CORRECTION_TRANSACTION_OPTIONS)
    ).rejects.toThrow(/deliberate failure/);

    expect(await prisma.correction.count()).toBe(before.corrections);
    expect(await prisma.voucher.count()).toBe(before.vouchers);
    expect(await prisma.journalEntry.count()).toBe(before.journalEntries);
    expect(await prisma.correctionImpact.count()).toBe(before.impacts);
    expect(await prisma.metalRevaluation.count()).toBe(before.revaluations);
    // Not even the voucher number is consumed.
    const sequence = await prisma.voucherSequence.findFirst({ where: { voucherType: "CORRECTION" } });
    expect(sequence?.lastNumber ?? 0).toBe(before.sequence);
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

  it("the Owner-facing read model immediately shows the ORIGINAL figures again after rollback", async () => {
    const job68Detail = (await getJewelleryJobDetail(job68Id))!;
    expect(amount(job68Detail.issuedMetalCost).toFixed(2)).toBe("72723.97");
    expect(amount(job68Detail.remainingWipCost).toFixed(2)).toBe(BEFORE.job68Wip);
    const fj86Output = job68Detail.finishedOutputs.find((o) => o.id === fj86Id)!;
    expect(amount(fj86Output.totalCostCurrent).toFixed(2)).toBe("56971.05"); // back to the original totalCost

    const job69Detail = (await getJewelleryJobDetail(job69Id))!;
    expect(amount(job69Detail.issuedMetalCost).toFixed(2)).toBe("16902.51");
    const fj87Output = job69Detail.finishedOutputs.find((o) => o.id === fj87Id)!;
    expect(amount(fj87Output.totalCostCurrent).toFixed(2)).toBe("29623.63");

    const rows = await listJewelleryJobs({ search: "ZL-JJOB-2026" });
    expect(amount(rows.find((r) => r.id === job68Id)!.totalIssuedCost).toFixed(2)).toBe("92826.01");
    expect(amount(rows.find((r) => r.id === job69Id)!.totalIssuedCost).toFixed(2)).toBe("28782.51");
  }, 30_000);

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
    // Scoped to this batch: other probes in this suite reverse corrections of
    // their own, and those are not what this assertion is about.
    const batchReversals = await prisma.correction.findMany({
      where: { mode: "REVERSAL", reverses: { batchId } },
      include: { correctionVoucher: { select: { voucherNumber: true, voucherType: true } } },
    });
    expect(batchReversals).toHaveLength(2);
    for (const reversal of batchReversals) {
      expect(reversal.correctionVoucher?.voucherType).toBe("REVERSAL");
    }
    // Again scoped to this batch: each step's own voucher is CANCELLED, not
    // removed. Probes elsewhere in this suite cancel vouchers of their own.
    const stepVouchers = await prisma.voucher.findMany({
      where: { correction: { batchId } },
      select: { voucherNumber: true, voucherType: true, status: true },
    });
    expect(stepVouchers).toHaveLength(2);
    for (const voucher of stepVouchers) {
      expect(voucher.voucherType).toBe("CORRECTION");
      expect(voucher.status).toBe("CANCELLED");
    }

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

// ---------------------------------------------------------------------------
// Phase 8B — a purity whose ledger cannot be replayed cleanly (here: an
// ISSUE_CANCEL_IN, which metalReplay.ts explicitly refuses) must fail closed
// on every Owner-facing read path, never fall back to a stored/delta
// approximation, and stay invisible to Staff exactly as any other cost does.
// ---------------------------------------------------------------------------
describe("carrying cost fails closed when a revalued purity cannot be replayed", () => {
  let purityId: string;
  let jobId: string;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    purityId = (
      await prisma.metalPurity.upsert({
        where: { metalType_displayName: { metalType: "GOLD", displayName: "Phase8B Replay Failure Karat" } },
        create: { metalType: "GOLD", displayName: "Phase8B Replay Failure Karat", finenessPercent: "91.600", createdByUserId: ownerId },
        update: { finenessPercent: "91.600" },
      })
    ).id;

    const karigar = await prisma.party.upsert({
      where: { id: "phase8b-replay-failure-karigar" },
      create: { id: "phase8b-replay-failure-karigar", name: "Phase8B Replay Failure Karigar", type: "KARIGAR", createdByUserId: ownerId },
      update: {},
    });
    const job = await prisma.jewelleryJob.create({
      data: {
        jobCode: `ZL-JJOB-REPLAYFAIL-${Date.now()}`,
        jewelleryType: "RING",
        designName: "Replay failure fixture",
        karigarId: karigar.id,
        issueDate: new Date("2026-09-01"),
        status: "MATERIALS_ISSUED",
        issuedMetalFineWeight: "5.000",
        issuedMetalCost: "50000.00",
        remainingWipCost: "50000.00",
        createdByUserId: ownerId,
      },
    });
    jobId = job.id;

    const opening = await prisma.$transaction((tx) =>
      postOpeningMetalStock(tx, {
        metalType: "GOLD",
        purityId,
        grossWeight: "10.000",
        costValue: "100000.00",
        idempotencyKey: `phase8b-replay-failure-opening-${job.id}`,
        ...FY,
        createdByUserId: ownerId,
      })
    );
    await prisma.metalStockMovement.create({
      data: {
        type: "ISSUE_OUT",
        metalType: "GOLD",
        purityId,
        grossWeight: "5.000",
        fineWeight: "4.580",
        costValue: "50000.00",
        sourceDocument: job.jobCode,
        jewelleryJobId: job.id,
        createdByUserId: ownerId,
      },
    });

    // Give this purity an active POSTED revaluation, the same way R2 does —
    // authored BEFORE the ledger is poisoned below, exactly like production:
    // the correction posted cleanly in the past; only a later, unrelated
    // event makes today's replay impossible.
    const plan = await planOpeningStockRevaluation(prisma, {
      movementId: opening.id,
      newCostValue: "150000.00",
      reason: "Phase8B replay-failure regression fixture",
    });
    await prisma.$transaction((tx) =>
      postCorrection(tx, {
        plan,
        preparedByUserId: ownerId,
        approvedByUserId: ownerId,
        approverRole: "OWNER",
        idempotencyKey: `phase8b-replay-failure-revaluation-${job.id}`,
        ...FY,
      })
    );

    // NOW poison the ledger — the shape metalReplay.ts explicitly refuses.
    await prisma.metalStockMovement.create({
      data: {
        type: "ISSUE_CANCEL_IN",
        metalType: "GOLD",
        purityId,
        grossWeight: "1.000",
        fineWeight: "0.916",
        costValue: "10000.00",
        sourceDocument: "cancelled issue fixture",
        createdByUserId: ownerId,
      },
    });
  }, 60_000);

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("fails closed rather than showing a stored or delta-approximated number", async () => {
    const outcome = await replayPurityAtCurrentValues(prisma, "GOLD", purityId);
    expect(outcome.ok).toBe(false);

    const detail = (await getJewelleryJobDetail(jobId))!;
    expect(isUnavailable(detail.issuedMetalCost)).toBe(true);
    expect(detail.issuedMetalCost).toBe(CARRYING_COST_UNAVAILABLE);
    expect(isUnavailable(detail.remainingWipCost)).toBe(true);
    expect(isUnavailable(detail.totalIssuedCost)).toBe(true);

    const rows = await listJewelleryJobs({ search: "ZL-JJOB-REPLAYFAIL" });
    const listRow = rows.find((r) => r.id === jobId)!;
    expect(isUnavailable(listRow.totalIssuedCost)).toBe(true);

    // A sanitized diagnostic was logged (identifiers and a reason only).
    expect(consoleErrorSpy).toHaveBeenCalled();
    const logged = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(logged).not.toMatch(/postgres(ql)?:\/\//i);
    expect(logged.toLowerCase()).not.toContain("password");
  }, 30_000);

  it("shows the Owner a clear message and shows Staff nothing at all", async () => {
    const detail = (await getJewelleryJobDetail(jobId))!;
    const owner = serializeJobCostSummary(detail, true);
    expect(owner.issuedMetalCost).toBe("Current cost unavailable — reconciliation required");
    expect(owner.totalIssuedCost).toBe("Current cost unavailable — reconciliation required");

    const staff = serializeJobCostSummary(detail, false);
    expect(staff.issuedMetalCost).toBeNull();
    expect(staff.totalIssuedCost).toBeNull();
  });
});
