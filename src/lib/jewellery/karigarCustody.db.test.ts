/**
 * Real-database acceptance for Karigar metal custody. Disposable scratch
 * database only — the shared guard refuses anything else, because this suite
 * truncates business tables.
 *
 * Headline example: give the Karigar 10 g, allocate 4 g to Job A, 3 g to B and
 * 2 g to C, leaving 1 g unallocated (10 g still with him before any receipt);
 * receive each job separately, then return the 1 g without touching the
 * finished pieces. The stock is priced at an awkward rate so every partial
 * share rounds, and the four shares must still add back to the paisa.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal, ZERO } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import {
  custodyPlanFingerprint,
  custodyReversalBlock,
  getCustodyBalanceInTx,
  planCustodyOperation,
  postCustodyOperation,
  reverseCustodyEntry,
  type CustodyOperationInput,
} from "@/lib/jewellery/karigarCustody";
import { getKarigarMetalAccount, reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import {
  assessJobReconciliation,
  cancelJewelleryJob,
  completeReconciledJob,
  createJewelleryJob,
  getMetalStockBalanceInTx,
  issueMaterialsToJewelleryJob,
  pendingFineWeightOf,
  postOpeningMetalStock,
  receiveFinishedJewellery,
} from "@/lib/jewellery/posting";
import { postFinishedJewellerySale } from "@/lib/jewellery/finishedSalesPosting";
import { planOpeningStockRevaluation } from "@/lib/corrections/openingStockCorrection";
import { postCorrection } from "@/lib/corrections/engine";
import { CORRECTION_TRANSACTION_OPTIONS } from "@/lib/corrections/types";
import { carryingJobCosts } from "@/lib/jewellery/carryingCost";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-28T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let staffId: string;
let karigarId: string;
let otherKarigarId: string;
let purityId: string; // 99.9% gold, awkward rate
let silverPurityId: string;
let seq = 0;
const key = (label: string) => `kmc-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}

async function upsertPurity(metalType: "GOLD" | "SILVER" | "ALLOY", displayName: string, finenessPercent: string) {
  return (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType, displayName } },
      create: { metalType, displayName, finenessPercent, createdByUserId: ownerId },
      update: { finenessPercent, isActive: true },
    })
  ).id;
}

async function opening(pid: string, metalType: "GOLD" | "SILVER" | "ALLOY", gross: string, cost: string) {
  return prisma.$transaction(
    (tx) => postOpeningMetalStock(tx, { metalType, purityId: pid, grossWeight: gross, costValue: cost, idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }),
    TX
  );
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>(
    "select current_database() db, current_user usr, inet_server_port() port"
  );
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  const staff = await prisma.user.findFirst({ where: { role: "STAFF" } });
  staffId = staff?.id ?? ownerId;
  await clearAll();

  karigarId = (await prisma.party.create({ data: { name: "Custody Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
  otherKarigarId = (await prisma.party.create({ data: { name: "Other Custody Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
  purityId = await upsertPurity("GOLD", "Custody Test 24K", "99.900");
  silverPurityId = await upsertPurity("SILVER", "Custody Test Silver", "92.500");
  // ₹7,123.45678 per gross gram: every partial share rounds.
  await opening(purityId, "GOLD", "1000.000", "7123456.78");
  await opening(silverPurityId, "SILVER", "500.000", "45000.00");
}, 90_000);

afterAll(async () => {
  await clearAll();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function balance(code: string): Promise<Decimal> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code } });
  // Every line counts: a cancelled voucher keeps its lines and gains a mirror REVERSAL voucher.
  const t = await prisma.journalEntry.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } });
  return new Decimal(t._sum.debit ?? 0).minus(t._sum.credit ?? 0);
}

const op = (input: Partial<CustodyOperationInput> & { kind: CustodyOperationInput["kind"] }, k = key("op"), fingerprint: string | null = null) =>
  prisma.$transaction(
    (tx) =>
      postCustodyOperation(tx, {
        karigarId,
        entryDate: DATE,
        reason: input.kind === "RELEASE_FROM_JOB" ? "Karigar is holding this metal for the next job" : "Custody test",
        ...input,
        idempotencyKey: k,
        expectedFingerprint: fingerprint,
        owner: owner(),
        ...FY,
      }),
    TX
  );

const reverse = (entryId: string, reason = "Entered by mistake — reversing it") =>
  prisma.$transaction((tx) => reverseCustodyEntry(tx, { entryId, reason, owner: owner(), ...FY }), TX);

const custody = (k = karigarId, pid = purityId) => prisma.$transaction((tx) => getCustodyBalanceInTx(tx, k, "GOLD", pid), TX);
const stock = (pid = purityId, metalType: "GOLD" | "SILVER" = "GOLD") => prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, metalType, pid), TX);
const jobRow = (id: string) => prisma.jewelleryJob.findUniqueOrThrow({ where: { id } });

async function makeJob(name: string, k = karigarId) {
  return prisma.$transaction(
    (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: name, karigarId: k, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
    TX
  );
}

function receive(jobId: string, netGross: string, opts: { pid?: string; markComplete?: boolean; labour?: string } = {}) {
  return prisma.$transaction(
    (tx) =>
      receiveFinishedJewellery(tx, {
        ...FY,
        jobId,
        receiveDate: DATE,
        outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: netGross, metalType: "GOLD", purityId: opts.pid ?? purityId, diamondIds: [], qcStatus: "PASSED" }],
        diamondResolutions: [],
        returnedMetalLines: [],
        scrapMetalLines: [],
        karigarAddedFineWeight: 0,
        karigarAddedCost: 0,
        labourCharge: opts.labour ?? 0,
        makingCharge: 0,
        settingCharge: 0,
        platingCharge: 0,
        otherExpense: 0,
        markJobComplete: opts.markComplete ?? true,
        isAbnormalLoss: false,
        damagedLostByUserId: ownerId,
        idempotencyKey: key("rcv"),
        createdByUserId: ownerId,
      }),
    TX
  );
}

async function unbalancedVouchers(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`
  );
  return rows[0].n;
}

/** Ledger = warehouse stock + unallocated custody + job WIP + finished stock, all at once. */
async function expectReconciled() {
  const r = await reconcileMetalLedger(prisma);
  for (const line of r.lines) expect({ account: line.accountCode, difference: line.difference.toFixed(2) }).toEqual({ account: line.accountCode, difference: "0.00" });
  expect(await unbalancedVouchers()).toBe(0);
}

// ---------------------------------------------------------------------------
// 1. The 10 g -> 4 + 3 + 2 (+1 unallocated) example
// ---------------------------------------------------------------------------
describe("Karigar custody — give 10 g, allocate 4/3/2, receive each, return 1 g", () => {
  const jobs: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };
  let issuedCost: Decimal;
  const allocCost: Record<"A" | "B" | "C", Decimal> = { A: ZERO, B: ZERO, C: ZERO };
  let stockValueBefore: Decimal;
  let ledger1300Before: Decimal;
  let ledger1320Before: Decimal;

  it("issues 10 g to the Karigar with no job: stock falls once, value moves to Jewellery WIP once", async () => {
    stockValueBefore = (await stock()).costValue;
    ledger1300Before = await balance("1300");
    ledger1320Before = await balance("1320");

    const preview = await prisma.$transaction((tx) => planCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId, purityId, grossWeight: "10", entryDate: DATE, reason: "Gold for the next three rings" }), TX);
    expect(preview.fineWeight.toFixed(3)).toBe("9.990");
    expect(preview.costValue.toFixed(2)).toBe("71234.57"); // 10 × 7,123.45678, to the paisa

    const posted = await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "10", reason: "Gold for the next three rings" }, key("issue"), custodyPlanFingerprint(preview));
    issuedCost = new Decimal(posted.entry.costValue);
    expect(posted.entry.voucherId).not.toBeNull();

    const c = await custody();
    expect([c.grossWeight.toFixed(3), c.fineWeight.toFixed(3), c.costValue.toFixed(2)]).toEqual(["10.000", "9.990", "71234.57"]);
    expect((await stock()).costValue.toFixed(2)).toBe(stockValueBefore.minus(issuedCost).toFixed(2));
    expect((await balance("1300")).toFixed(2)).toBe(ledger1300Before.minus(issuedCost).toFixed(2));
    expect((await balance("1320")).toFixed(2)).toBe(ledger1320Before.plus(issuedCost).toFixed(2));
    await expectReconciled();
  });

  it("allocates 4 g, 3 g, 2 g to three jobs of the same Karigar — no voucher, weight and value carried exactly", async () => {
    jobs.A = (await makeJob("Custody Ring A")).id;
    jobs.B = (await makeJob("Custody Ring B")).id;
    jobs.C = (await makeJob("Custody Ring C")).id;
    const vouchersBefore = await prisma.voucher.count();

    for (const [name, grams] of [["A", "4"], ["B", "3"], ["C", "2"]] as const) {
      const r = await op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: jobs[name], grossWeight: grams });
      allocCost[name] = new Decimal(r.entry.costValue);
      expect(r.entry.voucherId).toBeNull();
    }
    expect(await prisma.voucher.count()).toBe(vouchersBefore); // allocation is not consumption, and posts nothing

    // Paisa-exact shares of 71,234.57 by fine weight: 3.996 / 2.997 / 1.998 of 9.990.
    expect(allocCost.A.toFixed(2)).toBe("28493.83");
    expect(allocCost.B.toFixed(2)).toBe("21370.37");
    expect(allocCost.C.toFixed(2)).toBe("14246.91");

    const c = await custody();
    expect([c.grossWeight.toFixed(3), c.fineWeight.toFixed(3), c.costValue.toFixed(2)]).toEqual(["1.000", "0.999", "7123.46"]);
    expect(allocCost.A.plus(allocCost.B).plus(allocCost.C).plus(c.costValue).toFixed(2)).toBe(issuedCost.toFixed(2));

    for (const [name, fine] of [["A", "3.996"], ["B", "2.997"], ["C", "1.998"]] as const) {
      const j = await jobRow(jobs[name]);
      expect(j.status).toBe("MATERIALS_ISSUED");
      expect(pendingFineWeightOf(j).toFixed(3)).toBe(fine);
      expect(new Decimal(j.remainingWipCost).toFixed(2)).toBe(allocCost[name].toFixed(2));
    }

    // Total with the Karigar: 10 g, never double-counted.
    const account = await getKarigarMetalAccount(karigarId, { includeCost: true });
    const gold = account.byPurity.find((p) => p.purityId === purityId)!;
    expect(gold.unallocatedGross).toBe("1.000");
    expect(gold.allocatedPendingFine).toBe("8.991");
    expect(gold.totalWithKarigarFine).toBe("9.990");
    expect(gold.totalWithKarigarGross).toBe("10.000");
    expect((await balance("1320")).toFixed(2)).toBe(ledger1320Before.plus(issuedCost).toFixed(2)); // unchanged by allocation
    await expectReconciled();
  });

  it("receives each job separately; each finished piece carries exactly its allocated cost", async () => {
    for (const [name, grams] of [["A", "4.000"], ["B", "3.000"], ["C", "2.000"]] as const) {
      await receive(jobs[name], grams);
      const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: jobs[name] } });
      expect(new Decimal(piece.metalCost).toFixed(2)).toBe(allocCost[name].toFixed(2));
      expect((await jobRow(jobs[name])).status).toBe("COMPLETED");
    }
    expect((await balance("1330")).toFixed(2)).toBe(allocCost.A.plus(allocCost.B).plus(allocCost.C).toFixed(2));
    const c = await custody();
    expect(c.grossWeight.toFixed(3)).toBe("1.000"); // untouched by the receipts
    await expectReconciled();
  });

  it("returns the unallocated 1 g to stock without affecting the finished pieces", async () => {
    const piecesBefore = await prisma.finishedJewellery.findMany({ where: { jobId: { in: Object.values(jobs) } }, orderBy: { id: "asc" } });
    const stockBefore = await stock();
    const r = await op({ kind: "RETURN_TO_STOCK", purityId, all: true, reason: "Karigar returned the unused gold" });
    expect(new Decimal(r.entry.costValue).toFixed(2)).toBe("7123.46"); // the exact remaining value
    const c = await custody();
    expect([c.grossWeight.toFixed(3), c.fineWeight.toFixed(3), c.costValue.toFixed(2)]).toEqual(["0.000", "0.000", "0.00"]);
    const s = await stock();
    expect(s.grossWeight.toFixed(3)).toBe(stockBefore.grossWeight.plus(1).toFixed(3));
    expect(s.costValue.toFixed(2)).toBe(stockBefore.costValue.plus("7123.46").toFixed(2));
    const piecesAfter = await prisma.finishedJewellery.findMany({ where: { jobId: { in: Object.values(jobs) } }, orderBy: { id: "asc" } });
    expect(piecesAfter.map((p) => p.metalCost.toFixed(2))).toEqual(piecesBefore.map((p) => p.metalCost.toFixed(2)));
    // Net: stock gave 10 g and got 1 g back; 9 g sit in the three pieces.
    expect((await balance("1300")).toFixed(2)).toBe(ledger1300Before.minus(issuedCost).plus("7123.46").toFixed(2));
    await expectReconciled();
  });

  it("the statement lists every entry in order with who/when/why and links", async () => {
    const account = await getKarigarMetalAccount(karigarId, { includeCost: true });
    const kinds = account.statement.map((s) => s.kind);
    expect(kinds).toEqual(["ISSUE_TO_KARIGAR", "ALLOCATE_TO_JOB", "ALLOCATE_TO_JOB", "ALLOCATE_TO_JOB", "RETURN_TO_STOCK"]);
    expect(account.statement.every((s) => s.createdByName && s.reason && s.entryCode.startsWith("ZL-KMC-"))).toBe(true);
    expect(account.statement.filter((s) => s.jobId).map((s) => s.jobCode)).toHaveLength(3);
    expect(account.statement.at(-1)!.unallocatedGrossAfter).toBe("0.000");
    // Staff view carries no cost at all.
    const staffView = await getKarigarMetalAccount(karigarId, { includeCost: false });
    expect(JSON.stringify(staffView)).not.toMatch(/7123\.46|71234\.57|28493\.83/);
    expect(staffView.statement.every((s) => s.costValue === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1b. The same example entered as FINE gold: 24K (99.9%) in, 18K jewellery out
// ---------------------------------------------------------------------------
describe("Karigar custody — fine-gold basis: 10 g fine of 24K in, 18K jewellery out", () => {
  let fine24: string;
  let k18: string;
  const jobs: Record<"A" | "B" | "C", string> = { A: "", B: "", C: "" };
  const fineKarigar = () => prisma.party.findFirstOrThrow({ where: { name: "Fine Basis Karigar" } });

  it("issues 10.000 g FINE: stored as gross 10.010 g / fine 10.000 g, costed on the gross weighed out", async () => {
    fine24 = await upsertPurity("GOLD", "Custody Fine 24K", "99.900");
    k18 = await upsertPurity("GOLD", "Custody Test 18K", "75.000");
    await opening(fine24, "GOLD", "1000.000", "7123456.78");
    const k = await prisma.party.create({ data: { name: "Fine Basis Karigar", type: "KARIGAR", createdByUserId: ownerId } });
    const r = await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: k.id, purityId: fine24, fineWeight: "10", entryDate: DATE, reason: "10 g fine for three rings", idempotencyKey: key("fine-issue"), owner: owner(), ...FY }),
      TX
    );
    expect([r.entry.grossWeight.toFixed(3), r.entry.fineWeight.toFixed(3), r.entry.costValue.toFixed(2), r.entry.enteredWeightBasis]).toEqual(["10.010", "10.000", "71305.80", "FINE"]);
    // Entering both units at once is refused; so is neither.
    await expect(
      prisma.$transaction((tx) => planCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: k.id, purityId: fine24, grossWeight: "1", fineWeight: "1", entryDate: DATE, reason: "both" }), TX)
    ).rejects.toThrow(/not both/);
  });

  it("allocates 4 / 3 / 2 g FINE: each job gets exactly that fine weight, gross derived, value split by fine to the paisa", async () => {
    const k = await fineKarigar();
    for (const [name, fine, gross, cost] of [["A", "4", "4.004", "28522.32"], ["B", "3", "3.003", "21391.74"], ["C", "2", "2.002", "14261.16"]] as const) {
      const job = await makeJob(`Fine ring ${name}`, k.id);
      jobs[name] = job.id;
      const r = await prisma.$transaction(
        (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: k.id, purityId: fine24, jobId: job.id, fineWeight: fine, entryDate: DATE, reason: `Allocate ${name}`, idempotencyKey: key("fine-alloc"), owner: owner(), ...FY }),
        TX
      );
      expect([r.entry.fineWeight.toFixed(3), r.entry.grossWeight.toFixed(3), r.entry.costValue.toFixed(2)]).toEqual([Number(fine).toFixed(3), gross, cost]);
      const j = await jobRow(job.id);
      expect(pendingFineWeightOf(j).toFixed(3)).toBe(Number(fine).toFixed(3)); // jobs reconcile on FINE
    }
    const c = await custody(k.id, fine24);
    expect([c.grossWeight.toFixed(3), c.fineWeight.toFixed(3), c.costValue.toFixed(2)]).toEqual(["1.001", "1.000", "7130.58"]);
    const account = await getKarigarMetalAccount(k.id, { includeCost: true });
    const p = account.byPurity.find((b) => b.purityId === fine24)!;
    expect([p.unallocatedFine, p.allocatedPendingFine, p.totalWithKarigarFine]).toEqual(["1.000", "9.000", "10.000"]);
    expect([p.unallocatedGross, p.allocatedPendingGross, p.totalWithKarigarGross]).toEqual(["1.001", "9.009", "10.010"]);
    expect(account.statement.every((s) => s.enteredAs === "fine")).toBe(true);
  });

  it("receives 18K jewellery from each 24K job: fine is what reconciles; the alloy the Karigar added is gross only", async () => {
    for (const [name, net, fine, alloy, cost] of [
      ["A", "5.333", "4.000", "1.329", "28522.32"],
      ["B", "4.000", "3.000", "0.997", "21391.74"],
      ["C", "2.667", "2.000", "0.665", "14261.16"],
    ] as const) {
      await prisma.$transaction(
        (tx) =>
          receiveFinishedJewellery(tx, {
            ...FY,
            jobId: jobs[name],
            receiveDate: DATE,
            outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: net, metalType: "GOLD", purityId: k18, diamondIds: [], qcStatus: "PASSED" }],
            diamondResolutions: [],
            returnedMetalLines: [],
            scrapMetalLines: [],
            karigarAddedFineWeight: 0,
            karigarAddedCost: 0,
            alloy: { includedGrossWeight: alloy },
            labourCharge: 0,
            makingCharge: 0,
            settingCharge: 0,
            platingCharge: 0,
            otherExpense: 0,
            markJobComplete: true,
            isAbnormalLoss: false,
            damagedLostByUserId: ownerId,
            idempotencyKey: key("fine-rcv"),
            createdByUserId: ownerId,
          }),
        TX
      );
      const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: jobs[name] } });
      expect([piece.netMetalWeight.toFixed(3), piece.fineMetalWeight.toFixed(3), piece.alloyAddedWeight.toFixed(3), piece.metalCost.toFixed(2)]).toEqual([net, fine, alloy, cost]);
      const j = await jobRow(jobs[name]);
      expect([j.status, pendingFineWeightOf(j).toFixed(3)]).toEqual(["COMPLETED", "0.000"]); // no loss: 18K fine = allocated fine
    }
    // Nothing is ever posted against the 18K pool: the source stays 24K.
    expect(await prisma.metalStockMovement.count({ where: { purityId: k18 } })).toBe(0);
  });

  it("returns the 1.000 g fine (1.001 g gross) to stock at its exact remaining value; totals reconcile", async () => {
    const k = await fineKarigar();
    const before = await stock(fine24);
    const r = await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "RETURN_TO_STOCK", karigarId: k.id, purityId: fine24, all: true, entryDate: DATE, reason: "Unused gold back", idempotencyKey: key("fine-ret"), owner: owner(), ...FY }),
      TX
    );
    expect([r.entry.grossWeight.toFixed(3), r.entry.fineWeight.toFixed(3), r.entry.costValue.toFixed(2)]).toEqual(["1.001", "1.000", "7130.58"]);
    const after = await stock(fine24);
    expect(after.grossWeight.minus(before.grossWeight).toFixed(3)).toBe("1.001");
    // Net out of stock: 10.010 − 1.001 = 9.009 g gross = 9.000 g fine, now inside three 18K pieces.
    expect(new Decimal("1000").minus(after.grossWeight).toFixed(3)).toBe("9.009");
    await expectReconciled();
  });
});

// ---------------------------------------------------------------------------
// 1c. Rollback guards: writes a pre-custody release would make are refused
// ---------------------------------------------------------------------------
describe("Karigar custody — database rollback guards", () => {
  it("usable stock can never go below zero, whatever code writes the movement (metal with a Karigar is not in stock)", async () => {
    const pid = await upsertPurity("GOLD", "Guard Test 24K", "99.900");
    await opening(pid, "GOLD", "5.000", "50000.00");
    const k = await prisma.party.create({ data: { name: "Guard Karigar", type: "KARIGAR", createdByUserId: ownerId } });
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: k.id, purityId: pid, grossWeight: "4", entryDate: DATE, reason: "Guard test", idempotencyKey: key("guard-issue"), owner: owner(), ...FY }),
      TX
    );
    // What old code would do: it does not see KARIGAR_ISSUE_OUT, believes 5 g are in stock, and issues 3 g.
    const job = await makeJob("Old-code issue", k.id);
    await expect(
      prisma.metalStockMovement.create({
        data: { type: "ISSUE_OUT", metalType: "GOLD", purityId: pid, grossWeight: "3.000", fineWeight: "2.997", costValue: "30000.00", sourceDocument: "OLD-CODE", jewelleryJobId: job.id, createdByUserId: ownerId },
      })
    ).rejects.toThrow(/ZL_STOCK_GUARD/);
    // Taking the 1 g actually there is fine.
    await prisma.metalStockMovement.create({
      data: { type: "ADJUSTMENT_OUT", metalType: "GOLD", purityId: pid, grossWeight: "1.000", fineWeight: "0.999", costValue: "10000.00", sourceDocument: "GUARD-OK", createdByUserId: ownerId },
    });
    await prisma.metalStockMovement.deleteMany({ where: { sourceDocument: "GUARD-OK" } }); // test-only tidy
  });

  it("a job holding custody metal cannot be received, returned, transferred or cancelled by code that does not declare custody awareness", async () => {
    const k = await prisma.party.findFirstOrThrow({ where: { name: "Guard Karigar" } });
    const pid = (await prisma.metalPurity.findFirstOrThrow({ where: { displayName: "Guard Test 24K" } })).id;
    const job = await makeJob("Guarded job", k.id);
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: k.id, purityId: pid, jobId: job.id, grossWeight: "2", entryDate: DATE, reason: "Guard test", idempotencyKey: key("guard-alloc"), owner: owner(), ...FY }),
      TX
    );
    // Old code writing directly (no marker):
    await expect(prisma.jewelleryJob.update({ where: { id: job.id }, data: { receivedFineWeight: "1.000" } })).rejects.toThrow(/ZL_CUSTODY_GUARD/);
    await expect(prisma.jewelleryJob.update({ where: { id: job.id }, data: { status: "CANCELLED" } })).rejects.toThrow(/ZL_CUSTODY_GUARD/);
    await expect(prisma.jewelleryJob.update({ where: { id: job.id }, data: { transferredOutFineWeight: "0.500" } })).rejects.toThrow(/ZL_CUSTODY_GUARD/);
    // Harmless fields stay editable by anyone (notes, status label changes).
    await prisma.jewelleryJob.update({ where: { id: job.id }, data: { notes: "old code may still edit notes" } });
    // Current code declares awareness and receives normally.
    await receive(job.id, "2.000");
    expect((await jobRow(job.id)).status).toBe("COMPLETED");
    // A job with NO custody metal is untouched by the guard.
    const plain = await makeJob("Plain job", k.id);
    await prisma.jewelleryJob.update({ where: { id: plain.id }, data: { status: "CANCELLED" } });
  });
});

// ---------------------------------------------------------------------------
// 2. Refusals, preview staleness, idempotency, concurrency
// ---------------------------------------------------------------------------
describe("Karigar custody — controls", () => {
  it("refuses over-issue, over-allocation, a job of another Karigar, another purity, alloy, a future date and a non-Owner", async () => {
    const s = await stock();
    await expect(op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: s.grossWeight.plus(1).toFixed(3) })).rejects.toThrow(/Not enough/);
    await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "5" });
    const job = await makeJob("Refusal job");
    await expect(op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: job.id, grossWeight: "5.001" })).rejects.toThrow(/holds only 5\.000 g gross \/ 4\.995 g fine/);
    const foreign = await makeJob("Foreign job", otherKarigarId);
    await expect(op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: foreign.id, grossWeight: "1" })).rejects.toThrow(/different Karigar/);

    // A job already holding silver cannot take gold.
    const silverJob = await makeJob("Silver job");
    await prisma.$transaction(
      (tx) => issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: silverJob.id, issueDate: DATE, metalLines: [{ metalType: "SILVER", purityId: silverPurityId, grossWeight: "10" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("issue"), createdByUserId: ownerId }),
      TX
    );
    await expect(op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: silverJob.id, grossWeight: "1" })).rejects.toThrow(/never mixed/);

    const alloyPurity = await upsertPurity("ALLOY", "Custody Test Copper", "0.000");
    await opening(alloyPurity, "ALLOY", "100.000", "1000.00");
    await expect(op({ kind: "ISSUE_TO_KARIGAR", purityId: alloyPurity, grossWeight: "1" })).rejects.toThrow(/Copper\/Alloy/);

    await expect(op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "1", entryDate: new Date(Date.now() + 3 * 86400000) })).rejects.toThrow(/future/);
    await expect(
      prisma.$transaction((tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId, purityId, grossWeight: "1", entryDate: DATE, reason: "Staff try", idempotencyKey: key("staff"), owner: { id: staffId, role: "STAFF" }, ...FY }), TX)
    ).rejects.toThrow(/Only the Owner/);

    // Tidy: return the 5 g so later tests start clean.
    await op({ kind: "RETURN_TO_STOCK", purityId, all: true });
  });

  it("refuses to mix two fineness snapshots in one Karigar balance", async () => {
    await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "2" });
    await prisma.metalPurity.update({ where: { id: purityId }, data: { finenessPercent: "99.500" } });
    try {
      await expect(op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "1" })).rejects.toThrow(/recorded at 99\.900%/);
    } finally {
      await prisma.metalPurity.update({ where: { id: purityId }, data: { finenessPercent: "99.900" } });
    }
    await op({ kind: "RETURN_TO_STOCK", purityId, all: true });
  });

  it("a fresh preview's fingerprint is accepted for every kind of entry", async () => {
    const job = await makeJob("Fingerprint job");
    const flow: (Partial<CustodyOperationInput> & { kind: CustodyOperationInput["kind"] })[] = [
      { kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "3" },
      { kind: "ALLOCATE_TO_JOB", purityId, jobId: job.id, grossWeight: "2" },
      { kind: "RELEASE_FROM_JOB", jobId: job.id, grossWeight: "1", reason: "Karigar keeps part of it for later" },
      { kind: "RETURN_TO_STOCK", purityId, all: true },
    ];
    for (const step of flow) {
      const input = { karigarId, entryDate: DATE, reason: "Custody test", ...step } as CustodyOperationInput;
      const preview = await planCustodyOperation(prisma, input); // outside any transaction, like the preview action
      const posted = await op(step, key("fp"), custodyPlanFingerprint(preview));
      expect(posted.replayed).toBe(false);
    }
    await op({ kind: "RELEASE_FROM_JOB", jobId: job.id, all: true });
    await op({ kind: "RETURN_TO_STOCK", purityId, all: true });
  });

  it("a stale preview is refused; a repeated submission key posts once", async () => {
    const preview = await prisma.$transaction((tx) => planCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId, purityId, grossWeight: "3", entryDate: DATE, reason: "Custody test" }), TX);
    await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "1" }); // balance moves after the preview
    await expect(op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "3" }, key("stale"), custodyPlanFingerprint(preview))).rejects.toThrow(/changed after this preview/);

    const k = key("dup");
    const first = await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "1" }, k);
    const second = await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "1" }, k);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect((await custody()).grossWeight.toFixed(3)).toBe("2.000");
    await op({ kind: "RETURN_TO_STOCK", purityId, all: true });
  });

  it("two concurrent allocations that together exceed the balance: exactly one wins, nothing goes negative", async () => {
    await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "3" });
    const j1 = await makeJob("Race 1");
    const j2 = await makeJob("Race 2");
    const results = await Promise.allSettled([
      op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: j1.id, grossWeight: "2" }),
      op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: j2.id, grossWeight: "2" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const c = await custody();
    expect(c.grossWeight.toFixed(3)).toBe("1.000");
    expect(c.costValue.isNegative()).toBe(false);

    // Two concurrent posts with ONE submission key -> one entry.
    const k = key("race-dup");
    const dup = await Promise.allSettled([op({ kind: "RETURN_TO_STOCK", purityId, grossWeight: "0.5" }, k), op({ kind: "RETURN_TO_STOCK", purityId, grossWeight: "0.5" }, k)]);
    expect(dup.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.karigarMetalCustodyEntry.count({ where: { idempotencyKey: k } })).toBe(1);
    expect((await custody()).grossWeight.toFixed(3)).toBe("0.500");
    await expectReconciled();
  });
});

// ---------------------------------------------------------------------------
// 3. Reversals and their dependencies
// ---------------------------------------------------------------------------
describe("Karigar custody — audited reversals", () => {
  it("reverses newest-first only, restores every balance exactly, and nets the vouchers to zero", async () => {
    const start = await custody();
    const ledger1300 = await balance("1300");
    const issue = await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "3.333" });
    const job = await makeJob("Reversal job");
    const alloc = await op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: job.id, grossWeight: "1.111" });

    // The issue cannot go while the allocation after it stands.
    expect(await prisma.$transaction((tx) => custodyReversalBlock(tx, issue.entry.id), TX)).toMatch(/Later entries.*depend on it/);
    await expect(reverse(issue.entry.id)).rejects.toThrow(/Later entries/);

    await reverse(alloc.entry.id);
    const j = await jobRow(job.id);
    expect(j.status).toBe("DRAFT"); // its only material came from this allocation
    expect(new Decimal(j.remainingWipCost).toFixed(2)).toBe("0.00");
    expect(await prisma.jewelleryMetalIssueLine.count({ where: { jobId: job.id } })).toBe(0);
    await expect(reverse(alloc.entry.id)).rejects.toThrow(/Already reversed/);

    await reverse(issue.entry.id);
    const end = await custody();
    expect([end.grossWeight.toFixed(3), end.costValue.toFixed(2)]).toEqual([start.grossWeight.toFixed(3), start.costValue.toFixed(2)]);
    expect((await balance("1300")).toFixed(2)).toBe(ledger1300.toFixed(2));
    // The originals are untouched: their own voucher still stands, with its mirror beside it.
    const original = await prisma.karigarMetalCustodyEntry.findUniqueOrThrow({ where: { id: issue.entry.id }, include: { voucher: true, reversedBy: { include: { voucher: true } } } });
    expect(original.voucher?.status).toBe("POSTED");
    expect(original.reversedBy?.voucher?.amount.toFixed(2)).toBe(original.voucher?.amount.toFixed(2));
    await expectReconciled();
  });

  it("an allocation that a receipt has used cannot be reversed", async () => {
    await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "2" });
    const job = await makeJob("Used allocation");
    const alloc = await op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: job.id, all: true });
    await receive(job.id, "2.000");
    await expect(reverse(alloc.entry.id)).rejects.toThrow(/COMPLETED|received/i);
    await expectReconciled();
  });

  it("a return whose metal has since been issued elsewhere cannot be reversed", async () => {
    await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "1" });
    const ret = await op({ kind: "RETURN_TO_STOCK", purityId, all: true });
    const s = await stock();
    // Drain the warehouse pool of this purity into another Karigar's custody.
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: otherKarigarId, purityId, grossWeight: s.grossWeight.toFixed(3), entryDate: DATE, reason: "Drain for the test", idempotencyKey: key("drain"), owner: owner(), ...FY }),
      TX
    );
    await expect(reverse(ret.entry.id)).rejects.toThrow(/in stock now/);
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "RETURN_TO_STOCK", karigarId: otherKarigarId, purityId, all: true, entryDate: DATE, reason: "Undo drain", idempotencyKey: key("undrain"), owner: owner(), ...FY }),
      TX
    );
    await expectReconciled();
  });
});

// ---------------------------------------------------------------------------
// 4. Existing jobs: explicit release, cancellation and completion guards
// ---------------------------------------------------------------------------
describe("Karigar custody — releasing unused metal from an existing job", () => {
  it("releases part of an old-style job's pending metal to the Karigar balance; the original issue is untouched", async () => {
    const job = await makeJob("Old style job");
    await prisma.$transaction(
      (tx) => issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId, grossWeight: "6" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("issue"), createdByUserId: ownerId }),
      TX
    );
    const before = await jobRow(job.id);
    const issueLine = await prisma.jewelleryMetalIssueLine.findFirstOrThrow({ where: { jobId: job.id } });
    const issueVoucher = await prisma.voucher.findUniqueOrThrow({ where: { id: before.wipVoucherId! } });
    const stockBefore = await stock();
    const custodyBefore = await custody();
    const vouchersBefore = await prisma.voucher.count();

    await expect(op({ kind: "RELEASE_FROM_JOB", jobId: job.id, grossWeight: "2", reason: "short" })).rejects.toThrow(/at least 10/);
    const rel = await op({ kind: "RELEASE_FROM_JOB", jobId: job.id, grossWeight: "2" });
    expect(rel.entry.voucherId).toBeNull();
    expect(await prisma.voucher.count()).toBe(vouchersBefore);
    // Not a physical return: the warehouse is unchanged.
    const stockAfter = await stock();
    expect(stockAfter.grossWeight.toFixed(3)).toBe(stockBefore.grossWeight.toFixed(3));
    expect(stockAfter.costValue.toFixed(2)).toBe(stockBefore.costValue.toFixed(2));

    const after = await jobRow(job.id);
    expect(pendingFineWeightOf(after).toFixed(3)).toBe(pendingFineWeightOf(before).minus("1.998").toFixed(3));
    expect(new Decimal(after.remainingWipCost).plus(rel.entry.costValue).toFixed(2)).toBe(new Decimal(before.remainingWipCost).toFixed(2));
    expect(new Decimal(after.issuedMetalFineWeight).toFixed(3)).toBe(new Decimal(before.issuedMetalFineWeight).toFixed(3)); // history kept
    expect(await prisma.jewelleryMetalIssueLine.findUniqueOrThrow({ where: { id: issueLine.id } })).toEqual(issueLine);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: issueVoucher.id } })).status).toBe("POSTED");
    const c = await custody();
    expect(c.grossWeight.toFixed(3)).toBe(custodyBefore.grossWeight.plus(2).toFixed(3));

    // Cancellation is refused while the release stands, with the reason.
    await expect(
      prisma.$transaction((tx) => cancelJewelleryJob(tx, { ...FY, jobId: job.id, cancelledByUserId: ownerId, cancellationReason: "no longer needed" }), TX)
    ).rejects.toThrow(/holds Karigar custody metal .*cannot be cancelled/);
    // Completion without a receipt is refused while metal is pending.
    expect((await prisma.$transaction((tx) => assessJobReconciliation(tx, job.id), TX)).ok).toBe(false);

    // Release the rest, then the job can be completed with nothing unresolved.
    await op({ kind: "RELEASE_FROM_JOB", jobId: job.id, all: true });
    const emptied = await jobRow(job.id);
    expect(pendingFineWeightOf(emptied).toFixed(3)).toBe("0.000");
    expect(new Decimal(emptied.remainingWipCost).toFixed(2)).toBe("0.00");
    await prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: job.id, reason: "All metal released back to the Karigar balance", userId: ownerId }), TX);
    expect((await jobRow(job.id)).status).toBe("COMPLETED");

    // The released metal is now allocatable to another job.
    const next = await makeJob("Takes released metal");
    await op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: next.id, all: true });
    await expectReconciled();
  });

  it("a job funded from custody can still take its own Issue Materials (e.g. more metal) once, adding to what it holds", async () => {
    await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "2" });
    const job = await makeJob("Allocate then issue");
    await op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: job.id, all: true });
    const before = await jobRow(job.id);
    await prisma.$transaction(
      (tx) => issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId, grossWeight: "1" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("issue"), createdByUserId: ownerId }),
      TX
    );
    const after = await jobRow(job.id);
    expect(new Decimal(after.issuedMetalFineWeight).toFixed(3)).toBe(new Decimal(before.issuedMetalFineWeight).plus("0.999").toFixed(3));
    expect(new Decimal(after.remainingWipCost).greaterThan(before.remainingWipCost)).toBe(true);
    await expect(
      prisma.$transaction(
        (tx) => issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId, grossWeight: "1" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("issue"), createdByUserId: ownerId }),
        TX
      )
    ).rejects.toThrow(/already been issued/);
    await receive(job.id, "3.000");
    await expectReconciled();
  });
});

describe("Karigar custody — receipts on a job funded from custody or by transfer", () => {
  it("accepts usable metal returned at receipt time (the per-purity pending check counts allocations and transfers in)", async () => {
    await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "2" });
    const job = await makeJob("Returns some metal");
    await op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: job.id, all: true });
    const stockBefore = await stock();
    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY,
          jobId: job.id,
          receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "1.400", metalType: "GOLD", purityId, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [],
          returnedMetalLines: [{ purityId, grossWeight: "0.600" }],
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
          idempotencyKey: key("rcv-return"),
          createdByUserId: ownerId,
        }),
      TX
    );
    expect((await stock()).grossWeight.toFixed(3)).toBe(stockBefore.grossWeight.plus("0.6").toFixed(3));

    // The same for a job whose metal came by job-to-job transfer.
    const { postJobMetalTransfer } = await import("@/lib/jewellery/metalTransfer");
    const src = await makeJob("Transfer source");
    await prisma.$transaction(
      (tx) => issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: src.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId, grossWeight: "2" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("issue"), createdByUserId: ownerId }),
      TX
    );
    const dst = await makeJob("Transfer destination");
    await prisma.$transaction(
      (tx) => postJobMetalTransfer(tx, { sourceJobId: src.id, destinationJobId: dst.id, fineWeight: "0.999", reason: "Karigar works it under the other job", idempotencyKey: key("xfer"), owner: owner(), ...FY }),
      TX
    );
    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY,
          jobId: dst.id,
          receiveDate: DATE,
          outputs: [],
          diamondResolutions: [],
          returnedMetalLines: [{ purityId, grossWeight: "1.000" }],
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
          idempotencyKey: key("rcv-xfer-return"),
          createdByUserId: ownerId,
        }),
      TX
    );
    await expectReconciled();
  });
});

// ---------------------------------------------------------------------------
// 5. Revaluation and COGS
// ---------------------------------------------------------------------------
describe("Karigar custody — revaluation and COGS count cost once", () => {
  it("refuses to revalue a purity while it sits unallocated with a Karigar, then replays custody-funded jobs after allocation", async () => {
    const revalPurity = await upsertPurity("GOLD", "Custody Reval 22K", "91.600");
    const openingMovement = await opening(revalPurity, "GOLD", "100.000", "600000.00");
    const k = await prisma.party.create({ data: { name: "Reval Karigar", type: "KARIGAR", createdByUserId: ownerId } });
    const postFor = (input: Partial<CustodyOperationInput> & { kind: CustodyOperationInput["kind"] }) =>
      prisma.$transaction((tx) => postCustodyOperation(tx, { karigarId: k.id, purityId: revalPurity, entryDate: DATE, reason: "Revaluation test", ...input, idempotencyKey: key("rv"), owner: owner(), ...FY }), TX);

    await postFor({ kind: "ISSUE_TO_KARIGAR", grossWeight: "10" });
    const planReval = () =>
      prisma.$transaction((tx) => planOpeningStockRevaluation(tx, { movementId: openingMovement.id, newCostValue: "720000.00", reason: "Owner corrected the opening rate" }), TX);
    await expect(planReval()).rejects.toThrow(/Karigar metal custody/);

    const job = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "Reval custody job", karigarId: k.id, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    await postFor({ kind: "ALLOCATE_TO_JOB", jobId: job.id, all: true });
    const plan = await planReval();
    await prisma.$transaction((tx) => postCorrection(tx, { plan, preparedByUserId: ownerId, approvedByUserId: ownerId, approverRole: "OWNER", ...FY, idempotencyKey: key("reval") }), CORRECTION_TRANSACTION_OPTIONS);

    // The custody-funded job replays at the revalued rate: 10 g × ₹7,200.
    const carrying = await carryingJobCosts(prisma, [{ id: job.id, issuedMetalCost: ZERO, remainingWipCost: ZERO }]);
    const c = carrying.get(job.id)!;
    expect(c.remainingWipCost).not.toBe("UNAVAILABLE");
    expect((c.remainingWipCost as Decimal).toFixed(2)).toBe("72000.00");
    expect((c.issuedMetalCost as Decimal).toFixed(2)).toBe("72000.00");
  }, 60_000);

  it("a finished piece from custody metal sells at exactly its cost — COGS counts it once", async () => {
    await op({ kind: "ISSUE_TO_KARIGAR", purityId, grossWeight: "1.5" });
    const job = await makeJob("Sold custody piece");
    const alloc = await op({ kind: "ALLOCATE_TO_JOB", purityId, jobId: job.id, all: true });
    await receive(job.id, "1.500", { labour: "500" });
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: job.id } });
    expect(new Decimal(piece.metalCost).toFixed(2)).toBe(new Decimal(alloc.entry.costValue).toFixed(2));
    const customer = await prisma.party.create({ data: { name: "Custody Customer", type: "CUSTOMER", createdByUserId: ownerId } });
    const { sale } = await prisma.$transaction((tx) =>
      postFinishedJewellerySale(tx, {
        date: DATE,
        saleDate: DATE,
        ...FY,
        currencyCode: "INR",
        exchangeRate: 1,
        createdByUserId: ownerId,
        customerId: customer.id,
        gstTreatment: "NONE",
        idempotencyKey: key("sale"),
        items: [{ finishedJewelleryId: piece.id, sellingPrice: "20000.00", gstRatePercent: 0, taxType: "EXCLUSIVE" }],
      })
    );
    expect(new Decimal(sale.cogsTotal).toFixed(2)).toBe(new Decimal(alloc.entry.costValue).plus(500).toFixed(2));
    await expectReconciled();
  });
});
