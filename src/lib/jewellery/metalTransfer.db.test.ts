/**
 * Real-database acceptance for job-to-job metal transfer and the job-status
 * fix. Disposable scratch database only — the shared guard refuses anything
 * else, because this suite truncates business tables.
 *
 * Headline example: Job A holds 10g fine of one purity. 3g transfers to Job
 * B, 3g to Job C, leaving A with 4g — each then receives its own finished
 * piece, separately, with the metal transfer's cost carried exactly.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import {
  planJobMetalTransfer,
  postJobMetalTransfer,
  reverseJobMetalTransfer,
  transferPlanFingerprint,
} from "@/lib/jewellery/metalTransfer";
import { getMetalTransferPanel } from "@/lib/jewellery/metalTransferPanels";
import {
  assessJobReconciliation,
  cancelJewelleryJob,
  completeReconciledJob,
  createJewelleryJob,
  issueMaterialsToJewelleryJob,
  pendingFineWeightOf,
  postOpeningMetalStock,
  receiveFinishedJewellery,
  recomputeInconsistentJobStatus,
  setJewelleryJobNeedsCorrection,
} from "@/lib/jewellery/posting";
import { createRoughLotWithPieces, issueRoughToKarigar, receivePolishedDiamonds } from "@/lib/diamond/posting";
import { getJewelleryJobDetail } from "@/lib/jewellery/reports";
import { planOpeningStockRevaluation } from "@/lib/corrections/openingStockCorrection";
import { postCorrection } from "@/lib/corrections/engine";
import { postReceiptChargeCorrection } from "@/lib/jewellery/receiptChargeCorrection";
import { CORRECTION_TRANSACTION_OPTIONS } from "@/lib/corrections/types";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-30T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let karigarId: string;
let purityId: string;
let seq = 0;
const key = (label: string) => `mt-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>(
    "select current_database() db, current_user usr, inet_server_port() port"
  );
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearAll();

  karigarId = (await prisma.party.create({ data: { name: "Transfer Test Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
  purityId = (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType: "GOLD", displayName: "Transfer Test Karat" } },
      create: { metalType: "GOLD", displayName: "Transfer Test Karat", finenessPercent: "91.600", createdByUserId: ownerId },
      update: { finenessPercent: "91.600" },
    })
  ).id;
  await prisma.$transaction(
    (tx) =>
      postOpeningMetalStock(tx, {
        metalType: "GOLD",
        purityId,
        grossWeight: "5000.000",
        costValue: "5000000.00",
        idempotencyKey: key("opening"),
        ...FY,
        createdByUserId: ownerId,
      }),
    TX
  );
}, 90_000);

afterAll(async () => {
  await clearAll();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function balance(code: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  const t = await prisma.journalEntry.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } });
  return new Decimal(t._sum.debit ?? 0).minus(t._sum.credit ?? 0);
}
async function unbalancedVouchers(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`
  );
  return rows[0].n;
}
/** Total open-job Jewellery WIP must equal 1210's ledger balance — a transfer only ever reshuffles it between jobs. */
async function reconcileWip() {
  const jobs = await prisma.jewelleryJob.findMany({ where: { status: { notIn: ["CANCELLED"] } } });
  const sum = jobs.reduce((s, j) => s.plus(j.remainingWipCost).plus(j.remainingAlloyWipCost), ZERO);
  expect((await balance("1320")).toFixed(2)).toBe(sum.toFixed(2));
  expect(await unbalancedVouchers()).toBe(0);
}

async function makeJob(name: string, fineGrams: number, opts: { statusOnly?: boolean } = {}): Promise<{ id: string; jobCode: string }> {
  const job = await prisma.$transaction(
    (tx) =>
      createJewelleryJob(tx, {
        jewelleryType: "RING",
        designName: name,
        karigarId,
        issueDate: DATE,
        quantity: 1,
        createdByUserId: ownerId,
        idempotencyKey: key("job"),
      }),
    TX
  );
  if (!opts.statusOnly && fineGrams > 0) {
    await prisma.$transaction(
      (tx) =>
        issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true,
          ...FY,
          jobId: job.id,
          issueDate: DATE,
          metalLines: [{ metalType: "GOLD", purityId, grossWeight: String((fineGrams / 0.916).toFixed(3)) }],
          polishedDiamondIds: [],
          otherMaterialLines: [],
          idempotencyKey: key("issue"),
          createdByUserId: ownerId,
        }),
      TX
    );
  }
  return { id: job.id, jobCode: job.jobCode };
}

const transfer = (sourceJobId: string, destinationJobId: string, fineWeight: string, opts: { reason?: string; k?: string; fingerprint?: string | null } = {}) =>
  prisma.$transaction(
    (tx) =>
      postJobMetalTransfer(tx, {
        sourceJobId,
        destinationJobId,
        fineWeight,
        reason: opts.reason ?? "The Karigar is working on this metal under a different job number",
        idempotencyKey: opts.k ?? key("xfer"),
        expectedFingerprint: opts.fingerprint ?? null,
        owner: owner(),
        ...FY,
      }),
    TX
  );
const reverse = (correctionId: string, reason = "Entered against the wrong destination job") =>
  prisma.$transaction((tx) => reverseJobMetalTransfer(tx, { correctionId, reason, owner: owner(), ...FY }), TX);

async function jobRow(id: string) {
  return prisma.jewelleryJob.findUniqueOrThrow({ where: { id } });
}

// ---------------------------------------------------------------------------
// 1. Headline example: 10g -> A keeps 4g, B gets 3g, C gets 3g
// ---------------------------------------------------------------------------
describe("job-to-job metal transfer — the 10g / 4g+3g+3g example", () => {
  let a: { id: string; jobCode: string };
  let b: { id: string; jobCode: string };
  let c: { id: string; jobCode: string };

  it("posts two transfers with exact cost conservation: no voucher, 1210 total unchanged, gross/fine both labelled", async () => {
    a = await makeJob("Job A", 10);
    b = await makeJob("Job B", 0, { statusOnly: true }); // DRAFT — no fake warehouse issue
    c = await makeJob("Job C", 0, { statusOnly: true });

    const wipBefore = await balance("1320");
    const aBefore = await jobRow(a.id);
    expect(new Decimal(aBefore.issuedMetalFineWeight).toFixed(3)).toBe("10.000");
    expect(new Decimal(aBefore.remainingWipCost).toFixed(2)).toBe(aBefore.issuedMetalCost.toFixed(2));

    const t1 = await transfer(a.id, b.id, "3.000");
    if (!t1.built) throw new Error("expected a fresh transfer");
    expect(t1.built.grossWeightEquivalent.toFixed(3)).not.toBe("0.000"); // gross clearly labelled, distinct from fine
    expect(t1.built.fineWeight.toFixed(3)).toBe("3.000");
    const t2 = await transfer(a.id, c.id, "3.000");
    if (!t2.built) throw new Error("expected a fresh transfer");

    const [aAfter, bAfter, cAfter] = await Promise.all([jobRow(a.id), jobRow(b.id), jobRow(c.id)]);
    expect(new Decimal(aAfter.remainingWipCost).toFixed(2)).toBe(
      new Decimal(aBefore.issuedMetalCost).minus(t1.built.costValue).minus(t2.built.costValue).toFixed(2)
    );
    expect(new Decimal(aAfter.transferredOutFineWeight).toFixed(3)).toBe("6.000");
    expect(new Decimal(bAfter.remainingWipCost).toFixed(2)).toBe(t1.built.costValue.toFixed(2));
    expect(new Decimal(cAfter.remainingWipCost).toFixed(2)).toBe(t2.built.costValue.toFixed(2));
    expect(bAfter.status).toBe("MATERIALS_ISSUED"); // DRAFT -> MATERIALS_ISSUED, no warehouse issue
    expect(cAfter.status).toBe("MATERIALS_ISSUED");

    // Exact conservation: A's fall equals B's + C's rise, to the paisa.
    const fell = new Decimal(aBefore.issuedMetalCost).minus(aAfter.remainingWipCost);
    expect(fell.toFixed(2)).toBe(new Decimal(bAfter.remainingWipCost).plus(cAfter.remainingWipCost).toFixed(2));
    expect((await balance("1320")).toFixed(2)).toBe(wipBefore.toFixed(2)); // no voucher at all
    await reconcileWip();

    // No warehouse stock movement — the pool total is untouched.
    const usable = await prisma.metalStockMovement.findMany({ where: { metalType: "GOLD", purityId } });
    const poolMoved = usable.filter((m) => m.type === "JOB_TRANSFER_OUT" || m.type === "JOB_TRANSFER_IN");
    expect(poolMoved).toHaveLength(4); // 2 transfers x (OUT + IN)
  });

  it("gives each job its own receipt, its own pending balance and correct piece cost — separately", async () => {
    // `weight` is the FINE grams intended; netMetalWeight is GROSS, so convert
    // the same way makeJob's own issue does — the exact rounding is what the
    // "final receipt takes the whole remaining pool" rule then absorbs.
    const receive = (jobId: string, weight: number, k: string) =>
      prisma.$transaction(
        (tx) =>
          receiveFinishedJewellery(tx, {
            ...FY,
            jobId,
            receiveDate: DATE,
            outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: Number((weight / 0.916).toFixed(3)), metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
            diamondResolutions: [],
            returnedMetalLines: [],
            scrapMetalLines: [],
            karigarAddedFineWeight: 0,
            karigarAddedCost: 0,
            labourCharge: 0,
            makingCharge: 0,
            settingCharge: 0,
            platingCharge: 0,
            otherExpense: 0,
            markJobComplete: true,
            isAbnormalLoss: false,
            damagedLostByUserId: ownerId,
            idempotencyKey: k,
            createdByUserId: ownerId,
          }),
        TX
      );

    const bBefore = await jobRow(b.id);
    const receivedB = await receive(b.id, 3, key("rcv-b"));
    const pieceB = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: b.id } });
    expect(pieceB.metalCost.toFixed(2)).toBe(bBefore.remainingWipCost.toFixed(2)); // sole receipt takes the whole transferred pool
    expect((await jobRow(b.id)).status).toBe("COMPLETED");

    const cBefore = await jobRow(c.id);
    await receive(c.id, 3, key("rcv-c"));
    const pieceC = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: c.id } });
    expect(pieceC.metalCost.toFixed(2)).toBe(cBefore.remainingWipCost.toFixed(2));

    const aBefore = await jobRow(a.id);
    await receive(a.id, 4, key("rcv-a"));
    const pieceA = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: a.id } });
    expect(pieceA.metalCost.toFixed(2)).toBe(aBefore.remainingWipCost.toFixed(2));

    // Every gram of the original 10g landed in exactly one piece, at cost.
    const total = pieceA.metalCost.plus(pieceB.metalCost).plus(pieceC.metalCost);
    const [detailA] = await Promise.all([getJewelleryJobDetail(a.id)]);
    expect(detailA!.issuedMetalFineWeight.toFixed(3)).toBe("10.000");
    expect(new Decimal(pieceA.fineMetalWeight).plus(pieceB.fineMetalWeight).plus(pieceC.fineMetalWeight).toFixed(3)).toBe("10.000");
    expect(receivedB.receipt.postingVoucherId).not.toBeNull();
    void total;
    await reconcileWip();
  });
});

// ---------------------------------------------------------------------------
// 2. Preview / validation / refusals
// ---------------------------------------------------------------------------
describe("job-to-job metal transfer — preview and refusals", () => {
  it("refuses: over-transfer, zero, same job, different Karigar, mixed-purity source, already-received destination, not the Owner", async () => {
    const a = await makeJob("Refuse A", 10);
    const b = await makeJob("Refuse B", 0, { statusOnly: true });
    await expect(transfer(a.id, b.id, "10.001")).rejects.toThrow(/only has 10\.000g/);
    await expect(transfer(a.id, b.id, "0")).rejects.toThrow(/above zero/);
    await expect(transfer(a.id, a.id, "1")).rejects.toThrow(/two different jobs/);

    const otherKarigar = (await prisma.party.create({ data: { name: "Other Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
    const foreign = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "Foreign job", karigarId: otherKarigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    await expect(transfer(a.id, foreign.id, "1")).rejects.toThrow(/different Karigar/);

    const receivedDest = await makeJob("Received dest", 5);
    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY, jobId: receivedDest.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: 5, metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0, markJobComplete: true, isAbnormalLoss: false,
          damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
        }),
      TX
    );
    const anotherSource = await makeJob("Another source", 5);
    await expect(transfer(anotherSource.id, receivedDest.id, "1")).rejects.toThrow(/is completed/);

    await expect(
      prisma.$transaction(
        (tx) => postJobMetalTransfer(tx, { sourceJobId: a.id, destinationJobId: b.id, fineWeight: "1", reason: "long enough reason here", idempotencyKey: key("staff"), owner: { id: ownerId, role: "STAFF" }, ...FY }),
        TX
      )
    ).rejects.toThrow(/Only the Owner/);
  });

  it("a stale preview is refused: if the pending amount changed after the Owner saw the preview, nothing posts", async () => {
    const a = await makeJob("Stale A", 10);
    const b = await makeJob("Stale B", 0, { statusOnly: true });
    const c = await makeJob("Stale C", 0, { statusOnly: true });
    const built = await prisma.$transaction((tx) => planJobMetalTransfer(tx, { sourceJobId: a.id, destinationJobId: b.id, fineWeight: "5", reason: "Preview then a second transfer lands first" }), TX);
    const fp = transferPlanFingerprint(built.plan);
    await transfer(a.id, c.id, "2"); // changes A's pending after the preview
    await expect(transfer(a.id, b.id, "5", { fingerprint: fp })).rejects.toThrow(/changed after this preview/);
    expect((await jobRow(a.id)).transferredOutFineWeight.toFixed(3)).toBe("2.000");
  });
});

// ---------------------------------------------------------------------------
// 3. Duplicate submission and concurrency
// ---------------------------------------------------------------------------
describe("job-to-job metal transfer — duplicate submission and concurrency", () => {
  it("the same submission key posts ONCE", async () => {
    const a = await makeJob("Dup A", 10);
    const b = await makeJob("Dup B", 0, { statusOnly: true });
    const k = key("dup");
    const first = await transfer(a.id, b.id, "4", { k });
    const second = await transfer(a.id, b.id, "4", { k });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.correction.id).toBe(first.correction.id);
    expect((await jobRow(a.id)).transferredOutFineWeight.toFixed(3)).toBe("4.000");
  });

  it("two simultaneous transfers OUT of the same 10g source (6g + 6g): exactly one wins, never over-transferred", async () => {
    const a = await makeJob("Race source", 10);
    const b = await makeJob("Race dest B", 0, { statusOnly: true });
    const c = await makeJob("Race dest C", 0, { statusOnly: true });
    const results = await Promise.allSettled([transfer(a.id, b.id, "6"), transfer(a.id, c.id, "6")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const aAfter = await jobRow(a.id);
    expect(aAfter.transferredOutFineWeight.toFixed(3)).toBe("6.000");
    expect(new Decimal(aAfter.remainingWipCost).greaterThanOrEqualTo(0)).toBe(true);
    await reconcileWip();
  }, 60_000);

  it("a transfer racing a receipt on the SAME source job: exactly one succeeds against the true remaining pending, never both", async () => {
    const a = await makeJob("Race vs receipt", 10);
    const b = await makeJob("Race vs receipt dest", 0, { statusOnly: true });
    const receiveAll = () =>
      prisma.$transaction(
        (tx) =>
          receiveFinishedJewellery(tx, {
            ...FY, jobId: a.id, receiveDate: DATE,
            outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: 10, metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
            diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
            labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0, markJobComplete: true, isAbnormalLoss: false,
            damagedLostByUserId: ownerId, idempotencyKey: key("rcv-race"), createdByUserId: ownerId,
          }),
        TX
      );
    const results = await Promise.allSettled([transfer(a.id, b.id, "7"), receiveAll()]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    expect(okCount).toBe(1); // whichever ran first consumes the pool; the other sees it's gone
    await reconcileWip();
  }, 60_000);

  it("regression: a job funded ENTIRELY by transfer-in, received in full WITHOUT explicitly marking it complete, still gets the WHOLE pool — not half. A prior bug double-counted transferredInFineWeight into pendingFineWeightOf, so an exact, auto-detected completion (gap reaches zero on its own) silently split the cost 50/50", async () => {
    const a = await makeJob("Regression A", 10);
    const b = await makeJob("Regression B", 0, { statusOnly: true });
    const t = await transfer(a.id, b.id, "6");
    if (!t.built) throw new Error("expected a fresh transfer");
    const bBefore = await jobRow(b.id);
    expect(bBefore.transferredInFineWeight.toFixed(3)).toBe("6.000"); // tracked as audit info...
    expect(pendingFineWeightOf(bBefore).toFixed(3)).toBe("6.000"); // ...but NOT double-counted into pending

    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY, jobId: b.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: Number((6 / 0.916).toFixed(3)), metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0,
          markJobComplete: false, // exactly the unchecked-checkbox case — the server must still auto-detect gap==0
          isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("regression-rcv"), createdByUserId: ownerId,
        }),
      TX
    );
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: b.id } });
    expect(piece.metalCost.toFixed(2)).toBe(bBefore.remainingWipCost.toFixed(2)); // the WHOLE pool, not half
    const bAfter = await jobRow(b.id);
    expect(bAfter.remainingWipCost.toFixed(2)).toBe("0.00");
    expect(bAfter.status).toBe("COMPLETED");
    await reconcileWip();
  });
});

// ---------------------------------------------------------------------------
// 4. Reversal
// ---------------------------------------------------------------------------
describe("job-to-job metal transfer — reversal", () => {
  it("removes the effect exactly once, restores DRAFT if the destination held nothing else, and refuses a repeat reversal", async () => {
    const a = await makeJob("Rev A", 10);
    const b = await makeJob("Rev B", 0, { statusOnly: true });
    const aBefore = await jobRow(a.id);
    const t = await transfer(a.id, b.id, "5");
    expect((await jobRow(b.id)).status).toBe("MATERIALS_ISSUED");

    const [r1, r2] = await Promise.allSettled([reverse(t.correction.id), reverse(t.correction.id)]);
    expect([r1.status, r2.status].sort()).toEqual(["fulfilled", "rejected"]);
    const loser = (r1.status === "rejected" ? r1 : r2) as PromiseRejectedResult;
    expect(String(loser.reason.message)).toMatch(/already been reversed/);

    const [aAfter, bAfter] = await Promise.all([jobRow(a.id), jobRow(b.id)]);
    expect(aAfter.remainingWipCost.toFixed(2)).toBe(aBefore.issuedMetalCost.toFixed(2));
    expect(aAfter.transferredOutFineWeight.toFixed(3)).toBe("0.000");
    expect(bAfter.status).toBe("DRAFT"); // reverted — it held nothing else
    expect(bAfter.issuedMetalFineWeight.toFixed(3)).toBe("0.000");
    expect(bAfter.remainingWipCost.toFixed(2)).toBe("0.00");
    await reconcileWip();

    const original = await prisma.correction.findUniqueOrThrow({ where: { id: t.correction.id } });
    expect(original.state).toBe("REVERSED");
  }, 60_000);

  it("is refused once the destination has received a receipt, or transferred the metal onward — with a clear reason, nothing changes", async () => {
    const a = await makeJob("Rev refuse A", 10);
    const b = await makeJob("Rev refuse B", 0, { statusOnly: true });
    const t = await transfer(a.id, b.id, "5");
    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY, jobId: b.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: 5, metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0, markJobComplete: true, isAbnormalLoss: false,
          damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
        }),
      TX
    );
    await expect(reverse(t.correction.id)).rejects.toThrow(/already received a receipt/);

    const a2 = await makeJob("Rev onward A", 10);
    const b2 = await makeJob("Rev onward B", 0, { statusOnly: true });
    const c2 = await makeJob("Rev onward C", 0, { statusOnly: true });
    const t2 = await transfer(a2.id, b2.id, "5");
    await transfer(b2.id, c2.id, "2"); // b2 onward-transferred part of it
    await expect(reverse(t2.correction.id)).rejects.toThrow(/transferred this metal onward/);
    await reconcileWip();
  });

  it("the panel view shows Active/Reversed state and the reverse-blocked reason", async () => {
    const a = await makeJob("Panel A", 10);
    const b = await makeJob("Panel B", 0, { statusOnly: true });
    await transfer(a.id, b.id, "5");
    const panel = await getMetalTransferPanel(a.id);
    expect(panel.transfersOut).toHaveLength(1);
    expect(panel.transfersOut[0].state).toBe("POSTED");
    expect(panel.transfersOut[0].reverseBlockedReason).toBeNull();
    expect(panel.sourceOptions[0]?.pendingFineWeight).toBe("5.000");
  });
});

// ---------------------------------------------------------------------------
// 5. Cancellation integration
// ---------------------------------------------------------------------------
describe("job-to-job metal transfer — cancellation integration", () => {
  it("refuses to cancel the SOURCE while an active outgoing transfer exists, and the DESTINATION while it holds transferred-in metal", async () => {
    const a = await makeJob("Cancel A", 10);
    const b = await makeJob("Cancel B", 0, { statusOnly: true });
    await transfer(a.id, b.id, "4");
    await expect(
      prisma.$transaction((tx) => cancelJewelleryJob(tx, { ...FY, jobId: a.id, cancelledByUserId: ownerId, cancellationReason: "test" }), TX)
    ).rejects.toThrow(/transferred metal out/);
    await expect(
      prisma.$transaction((tx) => cancelJewelleryJob(tx, { ...FY, jobId: b.id, cancelledByUserId: ownerId, cancellationReason: "test" }), TX)
    ).rejects.toThrow(/transferred in from another job/);
  });

  it("cancelling the SOURCE succeeds once its remaining (never-transferred) metal is untouched — reverses only its own issue, never the transferred share twice", async () => {
    const a = await makeJob("Cancel clean A", 10);
    const b = await makeJob("Cancel clean B", 0, { statusOnly: true });
    const t = await transfer(a.id, b.id, "4");
    await reverse(t.correction.id); // give it back so A is cancellable again
    await prisma.$transaction((tx) => cancelJewelleryJob(tx, { ...FY, jobId: a.id, cancelledByUserId: ownerId, cancellationReason: "no longer needed" }), TX);
    expect((await jobRow(a.id)).status).toBe("CANCELLED");
    await reconcileWip();
  });
});

// ---------------------------------------------------------------------------
// 6. Prior revaluation + missing-charges integration
// ---------------------------------------------------------------------------
describe("job-to-job metal transfer — integration with a prior revaluation and with missing charges", () => {
  it("a transfer AFTER a revaluation replays correctly on BOTH jobs, and a destination funded only by transfer is included in replay", async () => {
    const revalPurityId = (
      await prisma.metalPurity.upsert({
        where: { metalType_displayName: { metalType: "GOLD", displayName: "Transfer Reval Karat" } },
        create: { metalType: "GOLD", displayName: "Transfer Reval Karat", finenessPercent: "91.600", createdByUserId: ownerId },
        update: {},
      })
    ).id;
    const opening = await prisma.$transaction(
      (tx) =>
        postOpeningMetalStock(tx, { metalType: "GOLD", purityId: revalPurityId, grossWeight: "1000.000", costValue: "1000000.00", idempotencyKey: key("reval-open"), ...FY, createdByUserId: ownerId }),
      TX
    );
    const a = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "Reval A", karigarId, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    await prisma.$transaction(
      (tx) =>
        issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: a.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId: revalPurityId, grossWeight: "10.917" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("issue"), createdByUserId: ownerId }),
      TX
    );
    // Revalue the opening entry from 1,000/gram to 1,200/gram.
    const plan = await prisma.$transaction((tx) => planOpeningStockRevaluation(tx, { movementId: opening.id, newCostValue: "1200000.00", reason: "Owner corrected the opening rate for this purity" }), TX);
    await prisma.$transaction((tx) => postCorrection(tx, { plan, preparedByUserId: ownerId, approvedByUserId: ownerId, approverRole: "OWNER", ...FY, idempotencyKey: key("reval-post") }), CORRECTION_TRANSACTION_OPTIONS);

    const b = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "Reval B (transfer-only)", karigarId, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    const t = await prisma.$transaction(
      (tx) =>
        postJobMetalTransfer(tx, { sourceJobId: a.id, destinationJobId: b.id, fineWeight: "4", reason: "Split for the revalued-purity replay test", idempotencyKey: key("reval-xfer"), owner: owner(), ...FY }),
      TX
    );
    expect(t.replayed).toBe(false);

    // Both jobs replay at the REVALUED pool rate (₹1,200/gross gram, up from
    // the ₹1,000/gross gram this fixture nominally posted at) — never the
    // stale nominal figure, and never a proportional-of-the-original-cost
    // guess. Job A's issue (10.917g gross) replays to 10.917 * 1200 =
    // ₹13,100.40 before any transfer; the 4g-of-10g-pending transfer then
    // takes exactly 4/10 of THAT replayed value, leaving A with the rest.
    const asDecimal = (v: unknown): Decimal => {
      if (v === "UNAVAILABLE") throw new Error("carrying cost unexpectedly unavailable");
      return v as Decimal;
    };
    const [detailA, detailB] = await Promise.all([getJewelleryJobDetail(a.id), getJewelleryJobDetail(b.id)]);
    expect(asDecimal(detailA!.issuedMetalCost).toFixed(2)).not.toBe("10917.00"); // replayed, not the stale nominal figure
    const replayedIssuedCost = new Decimal("10.917").times("1200"); // 13,100.40
    const transferredShare = replayedIssuedCost.times("4").dividedBy("10"); // 4g of 10g pending
    expect(asDecimal(detailA!.issuedMetalCost).toFixed(2)).toBe(replayedIssuedCost.toFixed(2));
    expect(asDecimal(detailA!.remainingWipCost).toFixed(2)).toBe(replayedIssuedCost.minus(transferredShare).toFixed(2));
    expect(asDecimal(detailB!.remainingWipCost).toFixed(2)).toBe(transferredShare.toFixed(2)); // transfer-funded only, no ISSUE_OUT of its own
  }, 60_000);

  it("metal transferred into a job, received, then given missing charges: the piece cost includes both, exactly once", async () => {
    const a = await makeJob("Combo A", 10);
    const b = await makeJob("Combo B", 0, { statusOnly: true });
    await transfer(a.id, b.id, "6");
    const received = await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY, jobId: b.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: Number((6 / 0.916).toFixed(3)), metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0, markJobComplete: true, isAbnormalLoss: false,
          damagedLostByUserId: ownerId, idempotencyKey: key("combo-rcv"), createdByUserId: ownerId,
        }),
      TX
    );
    const before = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: b.id } });
    await prisma.$transaction(
      (tx) => postReceiptChargeCorrection(tx, { receiptId: received.receipt.id, charges: { labourCharge: "500.00" }, reason: "Labour was left out on this transferred piece", idempotencyKey: key("combo-charge"), owner: owner(), ...FY }),
      TX
    );
    const after = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.labourAllocated.toFixed(2)).toBe("500.00");
    expect(after.totalCost.minus(before.totalCost).toFixed(2)).toBe("500.00");
    // Not reconcileWip() here: a prior test in this file posted a real
    // revaluation, and reconcileWip's raw-column sum is only ever valid
    // pre-revaluation — display reads go through the replay path instead
    // (proven directly above and in the previous test), never the stored
    // column, so this is expected and not a gap.
    expect(await unbalancedVouchers()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Job status fix
// ---------------------------------------------------------------------------
describe("job status: Needs Correction restores the real prior status, and the audited repair", () => {
  it("clearing Needs Correction restores PARTIALLY_RECEIVED (not IN_PROGRESS) for a job that already received a piece", async () => {
    const job = await makeJob("Status A", 10);
    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY, jobId: job.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: 3, metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0, markJobComplete: false, isAbnormalLoss: false,
          damagedLostByUserId: ownerId, idempotencyKey: key("status-rcv"), createdByUserId: ownerId,
        }),
      TX
    );
    expect((await jobRow(job.id)).status).toBe("PARTIALLY_RECEIVED");
    await prisma.$transaction((tx) => setJewelleryJobNeedsCorrection(tx, job.id, true), TX);
    expect((await jobRow(job.id)).status).toBe("NEEDS_CORRECTION");
    await prisma.$transaction((tx) => setJewelleryJobNeedsCorrection(tx, job.id, false), TX);
    expect((await jobRow(job.id)).status).toBe("PARTIALLY_RECEIVED"); // restored exactly, not regressed to IN_PROGRESS
  });

  it("falls back correctly (no stored prior status) for a legacy row, and refuses to flag an already-flagged job", async () => {
    const job = await makeJob("Status legacy", 10);
    await prisma.jewelleryJob.update({ where: { id: job.id }, data: { status: "NEEDS_CORRECTION", statusBeforeNeedsCorrection: null } });
    await prisma.$transaction((tx) => setJewelleryJobNeedsCorrection(tx, job.id, false), TX);
    expect((await jobRow(job.id)).status).toBe("MATERIALS_ISSUED"); // no receipt yet -> falls back to MATERIALS_ISSUED

    await prisma.$transaction((tx) => setJewelleryJobNeedsCorrection(tx, job.id, true), TX);
    await expect(prisma.$transaction((tx) => setJewelleryJobNeedsCorrection(tx, job.id, true), TX)).rejects.toThrow(/already marked Needs Correction/);
  });

  it("recomputeInconsistentJobStatus fixes a job stuck at an early status despite an existing receipt, refuses otherwise, and touches nothing else", async () => {
    const job = await makeJob("Repair A", 10);
    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY, jobId: job.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: 3, metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0, markJobComplete: false, isAbnormalLoss: false,
          damagedLostByUserId: ownerId, idempotencyKey: key("repair-rcv"), createdByUserId: ownerId,
        }),
      TX
    );
    // Simulate the pre-fix bug directly: force the job back to an early status despite its receipt.
    await prisma.jewelleryJob.update({ where: { id: job.id }, data: { status: "IN_PROGRESS" } });
    const before = await jobRow(job.id);

    await expect(
      prisma.$transaction((tx) => recomputeInconsistentJobStatus(tx, { jobId: job.id, reason: "short", userId: ownerId }), TX)
    ).rejects.toThrow(/at least 10 characters/);

    await prisma.$transaction(
      (tx) => recomputeInconsistentJobStatus(tx, { jobId: job.id, reason: "This job shows In Progress despite an existing receipt", userId: ownerId }),
      TX
    );
    const after = await jobRow(job.id);
    expect(after.status).toBe("PARTIALLY_RECEIVED");
    expect(after.notes).toMatch(/Status corrected by Owner/);
    expect(after.remainingWipCost.toFixed(2)).toBe(before.remainingWipCost.toFixed(2));
    expect(after.receivedFineWeight.toFixed(3)).toBe(before.receivedFineWeight.toFixed(3));

    // Refused: this job's status now matches its data.
    await expect(
      prisma.$transaction((tx) => recomputeInconsistentJobStatus(tx, { jobId: job.id, reason: "trying again for no reason", userId: ownerId }), TX)
    ).rejects.toThrow(/not one of the early statuses/);

    const freshJob = await makeJob("Repair no receipt", 5);
    await expect(
      prisma.$transaction((tx) => recomputeInconsistentJobStatus(tx, { jobId: freshJob.id, reason: "trying on a job with no receipt at all", userId: ownerId }), TX)
    ).rejects.toThrow(/already matches its data/);
  });
});

// ---------------------------------------------------------------------------
// 8. Timing
// ---------------------------------------------------------------------------
describe("timing", () => {
  it("posting and reversing a transfer finish far inside the correction transaction timeout", async () => {
    const a = await makeJob("Timing A", 10);
    const b = await makeJob("Timing B", 0, { statusOnly: true });
    const t0 = Date.now();
    const t = await transfer(a.id, b.id, "4");
    const postMs = Date.now() - t0;
    const t1 = Date.now();
    await reverse(t.correction.id);
    const reverseMs = Date.now() - t1;
    console.log(`Metal transfer timings — post: ${postMs}ms; reverse: ${reverseMs}ms`);
    expect(postMs).toBeLessThan(5_000);
    expect(reverseMs).toBeLessThan(5_000);
  });
});

// ---------------------------------------------------------------------------
// 9. Complete a fully-reconciled job with no new receipt
// ---------------------------------------------------------------------------
describe("complete a fully-reconciled job without a new receipt", () => {
  it("the exact real scenario: a job whose last metal left by transfer (not a receipt) can be marked Completed, touching nothing else", async () => {
    const a = await makeJob("Reconcile A", 10);
    const b = await makeJob("Reconcile B", 0, { statusOnly: true });
    // A receipt happens first (some of A's own metal), then the REMAINDER
    // leaves by transfer — mirrors the real case: a receipt already exists,
    // but the job never passed through Receive Finished Jewellery's own
    // completion gate because the LAST unresolved gram left by transfer.
    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY, jobId: a.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: Number((4 / 0.916).toFixed(3)), metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0, markJobComplete: false,
          isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("reconcile-rcv"), createdByUserId: ownerId,
        }),
      TX
    );
    expect((await jobRow(a.id)).status).toBe("PARTIALLY_RECEIVED");
    await transfer(a.id, b.id, "6"); // the rest leaves by transfer, not a receipt

    const before = await jobRow(a.id);
    expect(before.status).toBe("PARTIALLY_RECEIVED");
    expect(pendingFineWeightOf(before).toFixed(3)).toBe("0.000");
    expect(before.remainingWipCost.toFixed(2)).toBe("0.00");

    const check = await assessJobReconciliation(prisma, a.id);
    expect(check.ok).toBe(true);

    await expect(
      prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: a.id, reason: "short", userId: ownerId }), TX)
    ).rejects.toThrow(/at least 10 characters/);

    await prisma.$transaction(
      (tx) => completeReconciledJob(tx, { jobId: a.id, reason: "The remaining gold left by transfer to Job B, not a receipt", userId: ownerId }),
      TX
    );
    const after = await jobRow(a.id);
    expect(after.status).toBe("COMPLETED");
    expect(after.notes).toMatch(/Marked Completed by Owner without a new receipt/);
    // Nothing else moved: same quantities and cost as immediately before.
    for (const field of ["receivedFineWeight", "transferredOutFineWeight", "remainingWipCost", "issuedMetalCost", "totalLabourCharge"] as const) {
      expect(after[field].toString()).toBe(before[field].toString());
    }
    expect(await prisma.finishedJewellery.count({ where: { jobId: a.id } })).toBe(1); // no second receipt/piece created

    // Refused a second time — already completed.
    await expect(
      prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: a.id, reason: "trying again for no reason at all", userId: ownerId }), TX)
    ).rejects.toThrow(/already completed/);
  });

  it("refuses while metal is still pending, or WIP cost has not zeroed, naming the job", async () => {
    const a = await makeJob("Reconcile pending A", 10);
    const b = await makeJob("Reconcile pending B", 0, { statusOnly: true });
    await transfer(a.id, b.id, "4"); // only part — 6g fine still pending on A
    const check = await assessJobReconciliation(prisma, a.id);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/6\.000g fine metal pending/);
    await expect(
      prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: a.id, reason: "trying while metal is still pending here", userId: ownerId }), TX)
    ).rejects.toThrow(/still has 6\.000g fine metal pending/);
    expect((await jobRow(a.id)).status).not.toBe("COMPLETED");
  });

  it("refuses while a polished diamond issued to the job has no recorded outcome, and succeeds once it does", async () => {
    // A real polished diamond, reused via the same rough -> Karigar -> receive
    // pipeline the diamond module's own tests use — this test exercises
    // assessJobReconciliation's OWN check, not the diamond receipt flow
    // itself (already covered elsewhere), so the line's resolution is set
    // directly rather than through a full jewellery receipt with outputs.
    const supplierId = (await prisma.party.create({ data: { name: "Reconcile Diamond Supplier", type: "SUPPLIER", createdByUserId: ownerId } })).id;
    const manufacturerId = (await prisma.party.create({ data: { name: "Reconcile Diamond Manufacturer", type: "MANUFACTURER", createdByUserId: ownerId } })).id;
    const lot = await prisma.$transaction(
      (tx) => createRoughLotWithPieces(tx, { fyStartMonth: 4, fyStartDay: 1, purchaseDate: DATE, supplierId, purchaseRate: 800, rateBasis: "PER_CARAT", currencyCode: "INR", exchangeRate: 1, totalPurchaseCost: "8000.00", gstTreatment: "NONE", idempotencyKey: key("reconcile-rough"), createdByUserId: ownerId, pieces: [{ carat: "2.000" }] }),
      TX
    );
    const piece = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
    const diamondJob = await prisma.$transaction(
      (tx) => issueRoughToKarigar(tx, { fyStartMonth: 4, fyStartDay: 1, karigarId: manufacturerId, roughPieceIds: [piece.id], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key("reconcile-rough-issue"), createdByUserId: ownerId }),
      TX
    );
    const received = await prisma.$transaction(
      (tx) => receivePolishedDiamonds(tx, { fyStartMonth: 4, fyStartDay: 1, jobId: diamondJob.id, receiveDate: DATE, returnedRoughCarat: 0, labourCharge: 500, shape: "ROUND", markJobComplete: true, idempotencyKey: key("reconcile-polished"), createdByUserId: ownerId, outputs: [{ shape: "ROUND", carat: "1.500" }] }),
      TX
    );
    const stone = received.outputs[0];

    const a = await makeJob("Reconcile diamond A", 0, { statusOnly: true });
    const bJob = await makeJob("Reconcile diamond B", 0, { statusOnly: true });
    await prisma.$transaction(
      (tx) =>
        issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true,
          ...FY, jobId: a.id, issueDate: DATE,
          metalLines: [{ metalType: "GOLD", purityId, grossWeight: String((5 / 0.916).toFixed(3)) }],
          polishedDiamondIds: [stone.id], otherMaterialLines: [], idempotencyKey: key("reconcile-diamond-issue"), createdByUserId: ownerId,
        }),
      TX
    );
    await transfer(a.id, bJob.id, "5"); // zero out the metal side entirely

    const check1 = await assessJobReconciliation(prisma, a.id);
    expect(check1.ok).toBe(false);
    if (!check1.ok) expect(check1.reason).toMatch(/no outcome recorded/);
    await expect(
      prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: a.id, reason: "trying while the diamond is unresolved", userId: ownerId }), TX)
    ).rejects.toThrow(/no outcome recorded/);

    await prisma.jewelleryDiamondIssueLine.updateMany({ where: { jobId: a.id, polishedDiamondId: stone.id }, data: { resolvedAs: "RETURNED", resolvedAt: DATE } });
    const check2 = await assessJobReconciliation(prisma, a.id);
    expect(check2.ok).toBe(true);
    await prisma.$transaction(
      (tx) => completeReconciledJob(tx, { jobId: a.id, reason: "The diamond was returned and the metal transferred", userId: ownerId }),
      TX
    );
    expect((await jobRow(a.id)).status).toBe("COMPLETED");
  });

  it("refuses for a job already Completed, Cancelled, or still Draft, and two simultaneous completions leave exactly one winner", async () => {
    const completed = await makeJob("Reconcile already done", 3);
    await transfer(completed.id, (await makeJob("Reconcile sink", 0, { statusOnly: true })).id, "3");
    await prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: completed.id, reason: "Completing this job for the test fixture", userId: ownerId }), TX);
    await expect(
      prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: completed.id, reason: "trying again on an already-completed job", userId: ownerId }), TX)
    ).rejects.toThrow(/already completed/);

    const draft = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "Reconcile draft", karigarId, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("reconcile-draft") }),
      TX
    );
    await expect(
      prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: draft.id, reason: "trying on a job still in draft status", userId: ownerId }), TX)
    ).rejects.toThrow(/No materials have been issued/);

    const race = await makeJob("Reconcile race", 5);
    await transfer(race.id, (await makeJob("Reconcile race sink", 0, { statusOnly: true })).id, "5");
    const complete = (reason: string) => prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: race.id, reason, userId: ownerId }), TX);
    const results = await Promise.allSettled([complete("First simultaneous completion attempt"), complete("Second simultaneous completion attempt")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await jobRow(race.id)).status).toBe("COMPLETED");
  }, 30_000);
});

// silence unused-import checks for helpers only referenced conditionally above
