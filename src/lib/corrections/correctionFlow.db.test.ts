/**
 * Phase 8 Tier 8A — real-database acceptance for the correction framework.
 *
 * Runs against the isolated test database only (the wrapper that supplies
 * DATABASE_URL verifies current_database() before spawning, and this file
 * refuses to touch anything else). Nothing here ever reaches production.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cancelVoucher } from "@/lib/accounting/posting";
import { prisma } from "@/lib/db/prisma";
import { postOpeningMetalStock } from "@/lib/jewellery/posting";
import {
  approveCorrectionDraft,
  ensureCorrectionBatch,
  postCorrection,
  saveCorrectionDraft,
} from "./engine";
import { listCorrections } from "./history";
import {
  planOpeningStockLedgerBackfill,
  planOpeningStockRevaluation,
} from "./openingStockCorrection";
import { CorrectionError } from "./types";
import {
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
  let batchMovementId: string;
  let batchId: string;
  let r1Id: string;
  let r2Id: string;

  async function accountBalance(code: string): Promise<string> {
    const account = await prisma.account.findUniqueOrThrow({ where: { code } });
    const totals = await prisma.journalEntry.aggregate({
      where: { accountId: account.id },
      _sum: { debit: true, credit: true },
    });
    const debit = Number(totals._sum.debit ?? 0);
    const credit = Number(totals._sum.credit ?? 0);
    return (debit - credit).toFixed(2);
  }

  beforeAll(async () => {
    // Starts from a clean ledger so the batch's account balances are its own.
    await clearBusinessData();
    purity24kId = (await prisma.metalPurity.findFirstOrThrow({ where: { displayName: "24K" } })).id;

    // A pre-Phase-8 opening entry: stock recorded, nothing posted to the ledger.
    const legacy = await prisma.metalStockMovement.create({
      data: {
        type: "OPENING_IN",
        metalType: "GOLD",
        purityId: purity24kId,
        grossWeight: "22.001",
        fineWeight: "21.979",
        costValue: "160000.00",
        sourceDocument: "Opening stock",
        createdByUserId: ownerId,
      },
    });
    batchMovementId = legacy.id;
  }, 60_000);

  describe("posting R1 and R2 as one cumulative batch", () => {
    it("starts with the ledger short of the stock, exactly as production is", async () => {
      expect(await accountBalance("1300")).toBe("0.00");
      const checks = await reconcileMetalInventory(prisma);
      expect(checks[0].ok).toBe(false);
    }, 30_000);

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
      expect(batch.completedAt).toBeNull();
      expect(await accountBalance("1300")).toBe("160000.00");
    }, 30_000);

    it("posts R2 as step 2 and completes the batch", async () => {
      const correction = await prisma.$transaction(async (tx) => {
        const plan = await planOpeningStockRevaluation(tx, {
          movementId: batchMovementId,
          newCostValue: "351664.00",
          reason: "Opening gold was valued at half the actual purchase rate.",
        });
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
    }, 30_000);

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

    it("is cumulative: the ledger carries R1 plus R2, not one of them", async () => {
      // This fixture has no jobs, so all 22.001g is still in stock and the whole
      // uplift lands there: 160,000 (R1) + 191,664 (R2) = 351,664 into 1300.
      // Production's split across stock/WIP/finished is locked separately by
      // metalReplay.test.ts against the real ledger.
      expect(await accountBalance("1300")).toBe("351664.00");
      expect(await accountBalance("3000")).toBe("-351664.00");
      // Neither step alone would produce this: R1 gives 160,000, R2 gives 191,664.
      expect(await accountBalance("1300")).not.toBe("160000.00");
      expect(await accountBalance("1300")).not.toBe("191664.00");
    }, 30_000);

    it("verifies the batch as one correction made of two required steps", async () => {
      const checks = await verifyCorrectionBatch(prisma, batchId);
      const failed = checks.filter((c) => !c.ok);
      expect(failed.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);
    }, 30_000);

    it("verifies each step on its own and reconciles the metal ledger", async () => {
      for (const id of [r1Id, r2Id]) {
        const checks = await verifyCorrection(prisma, id);
        expect(checks.filter((c) => !c.ok)).toEqual([]);
      }
      const reconciliation = await reconcileMetalInventory(prisma);
      expect(reconciliation.every((c) => c.ok)).toBe(true);
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
  });

  describe("history shows both steps as required parts of one batch", () => {
    it("lists R1 and R2 as POSTED, each naming its batch and step", async () => {
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
  });

  describe("rollback readiness and simulation", () => {
    it("reports both steps as cancellable, newest first", async () => {
      const plan = await planCorrectionBatchRollback(prisma, batchId);
      expect(plan.ready).toBe(true);
      expect(plan.steps.map((s) => s.step)).toEqual([2, 1]);
      expect(plan.steps.every((s) => s.voucherStatus === "POSTED")).toBe(true);
      expect(plan.steps[0].amount).toBe("191664.00");
      expect(plan.steps[1].amount).toBe("160000.00");
    }, 30_000);

    it("undoing the whole batch returns every balance to where it started", async () => {
      const plan = await planCorrectionBatchRollback(prisma, batchId);
      for (const step of plan.steps) {
        await prisma.$transaction((tx) =>
          cancelVoucher(tx, {
            voucherId: step.voucherId!,
            cancelledByUserId: ownerId,
            cancellationReason: `Rollback of batch ${plan.batchCode}`,
            ...FY,
          })
        );
      }

      expect(await accountBalance("1300")).toBe("0.00");
      expect(await accountBalance("1320")).toBe("0.00");
      expect(await accountBalance("1330")).toBe("0.00");
      expect(await accountBalance("3000")).toBe("0.00");
      expect((await reconcileVoucherBalances(prisma)).ok).toBe(true);

      // The audit trail survives the rollback: nothing is deleted.
      const rows = await listCorrections();
      expect(rows.filter((r) => r.batchCode === BATCH_CODE)).toHaveLength(2);
      const movement = await prisma.metalStockMovement.findUniqueOrThrow({ where: { id: batchMovementId } });
      expect(movement.costValue.toFixed(2)).toBe("160000.00");
      expect(movement.fineWeight.toFixed(3)).toBe("21.979");
    }, 60_000);

    it("reports the batch as no longer rollback-ready once its vouchers are cancelled", async () => {
      const plan = await planCorrectionBatchRollback(prisma, batchId);
      expect(plan.ready).toBe(false);
      expect(plan.detail).toContain("0 of 2");
    }, 30_000);
  });
});
