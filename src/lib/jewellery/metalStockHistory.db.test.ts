/**
 * Phase 8B — real-database acceptance for Metal Stock rate clarity and the
 * complete, searchable history. Disposable scratch database only: the shared
 * guard refuses anything else, because this suite truncates business tables.
 *
 * Builds every kind of Company metal entry (opening stock with a rate basis,
 * purchases on each basis, Karigar issue/return, job allocation/release, job
 * issue/cancel, consumption, an adjustment and its reversal, and a posted
 * revaluation) and proves the history lists, filters, links and masks them.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { postCorrection } from "@/lib/corrections/engine";
import { planOpeningStockRevaluation } from "@/lib/corrections/openingStockCorrection";
import { CORRECTION_TRANSACTION_OPTIONS } from "@/lib/corrections/types";
import { listMetalStockHistory, type HistoryCategory } from "@/lib/jewellery/adjustmentHistory";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { postCustodyOperation, reverseCustodyEntry, type CustodyOperationInput } from "@/lib/jewellery/karigarCustody";
import {
  adjustMetalStock,
  cancelJewelleryJob,
  createJewelleryJob,
  createMetalPurchase,
  getMetalStockBalanceInTx,
  issueMaterialsToJewelleryJob,
  postOpeningMetalStock,
  PostingError,
  receiveFinishedJewellery,
  reverseMetalStockAdjustment,
} from "@/lib/jewellery/posting";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-01T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let karigarId: string;
let supplierId: string;
let goldId: string; // 91.7% — so gross and fine rates differ visibly
let silverId: string; // revalued; never handed to a Karigar
let seq = 0;
const key = (label: string) => `mh-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}

async function upsertPurity(metalType: "GOLD" | "SILVER", displayName: string, finenessPercent: string) {
  return (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType, displayName } },
      create: { metalType, displayName, finenessPercent, createdByUserId: ownerId },
      update: { finenessPercent, isActive: true },
    })
  ).id;
}

const custody = (input: Partial<CustodyOperationInput> & { kind: CustodyOperationInput["kind"] }) =>
  prisma.$transaction(
    (tx) =>
      postCustodyOperation(tx, {
        karigarId,
        entryDate: DATE,
        reason: "History test custody step",
        ...input,
        idempotencyKey: key("custody"),
        expectedFingerprint: null,
        owner: owner(),
        ...FY,
      }),
    TX
  );

const purchase = (input: { basis: "PER_GROSS_GRAM" | "PER_FINE_GRAM" | "FIXED_TOTAL"; rate: string; gross: string; total: string; manual?: boolean }) =>
  prisma.$transaction(
    (tx) =>
      createMetalPurchase(tx, {
        ...FY,
        purchaseDate: DATE,
        supplierId,
        metalType: "GOLD",
        purityId: goldId,
        grossWeight: input.gross,
        rateBasis: input.basis,
        rate: input.rate,
        currencyCode: "INR",
        exchangeRate: 1,
        totalPurchaseCost: input.total,
        gstTreatment: "NONE",
        idempotencyKey: key("purchase"),
        createdByUserId: ownerId,
        totalManuallyEdited: input.manual ?? false,
      }),
    TX
  );

async function unbalancedVouchers(): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`
  );
  return rows[0].n;
}

async function expectReconciled() {
  const r = await reconcileMetalLedger(prisma);
  for (const line of r.lines) expect({ account: line.accountCode, difference: line.difference.toFixed(2) }).toEqual({ account: line.accountCode, difference: "0.00" });
  expect(await unbalancedVouchers()).toBe(0);
}

const ids: Record<string, string> = {};

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>(
    "select current_database() db, current_user usr, inet_server_port() port"
  );
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearAll();
  karigarId = (await prisma.party.create({ data: { name: "History Karigar Ramesh", type: "KARIGAR", createdByUserId: ownerId } })).id;
  supplierId = (await prisma.party.create({ data: { name: "History Bullion Supplier", type: "SUPPLIER", createdByUserId: ownerId } })).id;
  goldId = await upsertPurity("GOLD", "History 22K", "91.700");
  silverId = await upsertPurity("SILVER", "History Silver", "92.500");
}, 90_000);

afterAll(async () => {
  await clearAll();
});

describe("8B — rate basis is re-derived on the server, never reinterpreted", () => {
  it("opening stock on a FINE-gram rate: total = rate × fine weight to the paisa, basis written into the entry", async () => {
    // 100 g gross of 91.7% = 91.700 g fine; ₹6,543.21 per FINE gram = ₹6,00,012.36 (not ₹6,54,321 on gross).
    const m = await prisma.$transaction(
      (tx) =>
        postOpeningMetalStock(tx, {
          metalType: "GOLD",
          purityId: goldId,
          grossWeight: "100",
          costValue: "600012.36",
          rateBasis: "PER_FINE_GRAM",
          rate: "6543.21",
          costManuallyEdited: false,
          note: "Safe count",
          idempotencyKey: key("open"),
          ...FY,
          createdByUserId: ownerId,
        }),
      TX
    );
    ids.opening = m.id;
    expect(m.fineWeight.toFixed(3)).toBe("91.700");
    expect(m.costValue.toFixed(2)).toBe("600012.36");
    expect(m.sourceDocument).toBe("Opening stock (rate basis: per fine gram): Safe count");
    // The ₹ rate is kept only on the Owner-only voucher, never on the movement Staff can see.
    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: m.voucherId! } });
    expect(voucher.note).toBe("Opening stock (rate basis: per fine gram): Safe count (₹6543.2100 per fine gram) — History 22K 100.000g");
  });

  it("refuses a total that matches the OTHER basis (gross rate typed as if fine) — nothing saved", async () => {
    const before = await prisma.metalStockMovement.count();
    await expect(
      prisma.$transaction(
        (tx) =>
          postOpeningMetalStock(tx, {
            metalType: "GOLD",
            purityId: goldId,
            grossWeight: "100",
            costValue: "654321.00", // = rate × GROSS, but the basis says fine
            rateBasis: "PER_FINE_GRAM",
            rate: "6543.21",
            costManuallyEdited: false,
            idempotencyKey: key("open-bad"),
            ...FY,
            createdByUserId: ownerId,
          }),
        TX
      )
    ).rejects.toThrow(/does not match the rate/);
    expect(await prisma.metalStockMovement.count()).toBe(before);
  });

  it("purchases: gross and fine bases each post exactly their own total; a manual total is accepted only when flagged", async () => {
    const gross = await purchase({ basis: "PER_GROSS_GRAM", rate: "6000.005", gross: "10.001", total: "60006.05" }); // 6000.0050 × 10.001 = 60006.050005
    expect(gross.totalPurchaseCost.toFixed(2)).toBe("60006.05");
    expect(gross.rateBasis).toBe("PER_GROSS_GRAM");
    const fine = await purchase({ basis: "PER_FINE_GRAM", rate: "6500", gross: "10", total: "59605.00" }); // 9.170 g fine × 6500
    expect([fine.fineWeight.toFixed(3), fine.totalPurchaseCost.toFixed(2), fine.rateBasis]).toEqual(["9.170", "59605.00", "PER_FINE_GRAM"]);
    ids.purchase = fine.purchaseCode;

    await expect(purchase({ basis: "PER_FINE_GRAM", rate: "6500", gross: "10", total: "65000.00" })).rejects.toBeInstanceOf(PostingError);
    const manual = await purchase({ basis: "PER_FINE_GRAM", rate: "6500", gross: "10", total: "59600.00", manual: true });
    expect(manual.totalPurchaseCost.toFixed(2)).toBe("59600.00");
    await expectReconciled();
  });

  it("a purity master edit is future-only (D8): posted movements keep their fine weight; the pool is never re-derived", async () => {
    const before = await prisma.metalStockMovement.findUniqueOrThrow({ where: { id: ids.opening } });
    const poolBefore = await prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, "GOLD", goldId), TX);
    await prisma.metalPurity.update({ where: { id: goldId }, data: { finenessPercent: "99.900" } });
    try {
      const after = await prisma.metalStockMovement.findUniqueOrThrow({ where: { id: ids.opening } });
      expect(after.fineWeight.toFixed(3)).toBe(before.fineWeight.toFixed(3));
      const purchaseRow = await prisma.metalPurchase.findUniqueOrThrow({ where: { purchaseCode: ids.purchase } });
      expect([purchaseRow.finenessPercentSnapshot.toFixed(3), purchaseRow.fineWeight.toFixed(3)]).toEqual(["91.700", "9.170"]);
      const poolAfter = await prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, "GOLD", goldId), TX);
      expect(poolAfter.fineWeight.toFixed(3)).toBe(poolBefore.fineWeight.toFixed(3));
      const history = await listMetalStockHistory({ isOwner: true, category: "OPENING" });
      expect(history.rows.find((r) => r.id === ids.opening)!.fineWeight).toBe("91.700");
    } finally {
      await prisma.metalPurity.update({ where: { id: goldId }, data: { finenessPercent: "91.700" } });
    }
  });
});

describe("8B — the history lists, filters, links and masks every Company metal entry", () => {
  let correctionCode = "";

  it("builds one of every kind of entry", async () => {
    // Silver: opening, revalued by a posted Owner correction (R2), then an adjustment and its reversal.
    const silverOpening = await prisma.$transaction(
      (tx) => postOpeningMetalStock(tx, { metalType: "SILVER", purityId: silverId, grossWeight: "50", costValue: "4000.00", idempotencyKey: key("sopen"), ...FY, createdByUserId: ownerId }),
      TX
    );
    ids.silverOpening = silverOpening.id;
    const plan = await planOpeningStockRevaluation(prisma, { movementId: silverOpening.id, newCostValue: "4500.00", reason: "History test — silver opening valued too low" });
    const correction = await prisma.$transaction(
      (tx) => postCorrection(tx, { plan, preparedByUserId: ownerId, approvedByUserId: ownerId, approverRole: "OWNER", ...FY, idempotencyKey: key("reval") }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    correctionCode = correction.correctionCode;

    const adj = await prisma.$transaction(
      (tx) =>
        adjustMetalStock(tx, {
          metalType: "SILVER",
          purityId: silverId,
          mode: "IN",
          grossWeight: "2",
          costValue: null,
          reason: "History test count difference",
          confirmedValue: false,
          idempotencyKey: key("adj"),
          ...FY,
          createdByUserId: ownerId,
        }),
      TX
    );
    ids.adjustment = adj.id;
    const rev = await prisma.$transaction(
      (tx) => reverseMetalStockAdjustment(tx, { movementId: adj.id, reason: "History test — counted twice", ...FY, createdByUserId: ownerId }),
      TX
    );
    ids.adjustmentReversal = rev.id;

    // Gold: Karigar custody — issue, allocate to a job, release part back, return the rest; then reverse the last return.
    const job = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "History Ring", karigarId, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    ids.job = job.id;
    ids.jobCode = job.jobCode;
    await custody({ kind: "ISSUE_TO_KARIGAR", purityId: goldId, grossWeight: "12" });
    await custody({ kind: "ALLOCATE_TO_JOB", purityId: goldId, jobId: job.id, grossWeight: "6" });
    await custody({ kind: "RELEASE_FROM_JOB", jobId: job.id, grossWeight: "1", reason: "Karigar keeps 1 g for the next ring" });
    const ret = await custody({ kind: "RETURN_TO_STOCK", purityId: goldId, grossWeight: "2", reason: "Returned unused" });
    await prisma.$transaction((tx) => reverseCustodyEntry(tx, { entryId: ret.entry.id, reason: "Return was entered twice — reversing", owner: owner(), ...FY }), TX);

    // The job is received: the 5 g allocated to it is used in the finished piece.
    await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY,
          jobId: job.id,
          receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "5.000", metalType: "GOLD", purityId: goldId, diamondIds: [], qcStatus: "PASSED" }],
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
          idempotencyKey: key("rcv"),
          createdByUserId: ownerId,
        }),
      TX
    );

    // A legacy direct issue to a second job, then that job is cancelled (issue cancelled back to stock).
    const job2 = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "History Ring 2", karigarId, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job2") }),
      TX
    );
    await prisma.$transaction(
      (tx) =>
        issueMaterialsToJewelleryJob(tx, {
          legacyDirectGoldIssue: true,
          jobId: job2.id,
          issueDate: DATE,
          metalLines: [{ metalType: "GOLD", purityId: goldId, grossWeight: "3" }],
          polishedDiamondIds: [],
          otherMaterialLines: [],
          ...FY,
          createdByUserId: ownerId,
          idempotencyKey: key("issue"),
        }),
      TX
    );
    await prisma.$transaction((tx) => cancelJewelleryJob(tx, { jobId: job2.id, cancelledByUserId: ownerId, cancellationReason: "History test — design cancelled", ...FY }), TX);
    await expectReconciled();
  }, 120_000);

  const typesOf = async (category: HistoryCategory, extra: { search?: string; isOwner?: boolean } = {}) =>
    (await listMetalStockHistory({ isOwner: extra.isOwner ?? true, category, search: extra.search, pageSize: 100 })).rows.map((r) => r.type);

  it("every category returns exactly its own kinds of entry", async () => {
    expect(new Set(await typesOf("OPENING"))).toEqual(new Set(["OPENING_IN"]));
    expect(new Set(await typesOf("PURCHASE"))).toEqual(new Set(["PURCHASE_IN"]));
    expect(new Set(await typesOf("KARIGAR"))).toEqual(new Set(["KARIGAR_ISSUE_OUT", "KARIGAR_RETURN_IN"]));
    expect(new Set(await typesOf("JOB_ALLOCATION"))).toEqual(new Set(["CUSTODY_TO_JOB", "JOB_TO_CUSTODY"]));
    expect(new Set(await typesOf("JOB"))).toEqual(new Set(["CONSUMED_OUT", "ISSUE_OUT", "ISSUE_CANCEL_IN"]));
    expect(new Set(await typesOf("ADJUSTMENT"))).toEqual(new Set(["ADJUSTMENT_IN", "ADJUSTMENT_OUT"]));
    expect(await typesOf("REVALUATION")).toEqual(["REVALUATION_USABLE_POOL"]);
  });

  it("'Everything' is complete: every movement in the database plus every posted revaluation, newest first", async () => {
    const all = await listMetalStockHistory({ isOwner: true, category: "ALL", pageSize: 100 });
    const movementCount = await prisma.metalStockMovement.count();
    const revaluationCount = await prisma.metalRevaluation.count({ where: { correction: { state: "POSTED" } } });
    expect(all.rows).toHaveLength(movementCount + revaluationCount);
    const times = all.rows.map((r) => r.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("links a reversal to its original both ways, and lists both under Cancellations and reversals", async () => {
    const rows = (await listMetalStockHistory({ isOwner: true, category: "REVERSAL", pageSize: 100 })).rows;
    const original = rows.find((r) => r.id === ids.adjustment)!;
    const reversal = rows.find((r) => r.id === ids.adjustmentReversal)!;
    expect(original.reversedBy?.id).toBe(ids.adjustmentReversal);
    expect(reversal.reversalOf?.id).toBe(ids.adjustment);
    expect(reversal.label).toMatch(/^Reversal — /);
    expect([original.canReverse, reversal.canReverse]).toEqual([false, false]);
    // The reversed custody return and the cancelled job issue are there too.
    expect(rows.some((r) => r.type === "KARIGAR_RETURN_IN" && r.reversedBy)).toBe(true);
    expect(rows.some((r) => r.type === "ISSUE_CANCEL_IN")).toBe(true);
  });

  it("links the revalued opening entry to its correction, and finds it by the correction code alone", async () => {
    const opening = (await listMetalStockHistory({ isOwner: true, category: "OPENING", pageSize: 100 })).rows.find((r) => r.id === ids.silverOpening)!;
    expect(opening.corrections).toEqual([{ correctionCode, state: "POSTED", batchCode: null }]);
    const reval = (await listMetalStockHistory({ isOwner: true, category: "REVALUATION" })).rows[0];
    expect([reval.revaluedMovementId, reval.costValue, reval.usableEffect]).toEqual([ids.silverOpening, "500.00", 0]);
    const found = await listMetalStockHistory({ isOwner: true, search: correctionCode, pageSize: 100 });
    expect(found.rows.map((r) => r.id)).toEqual(expect.arrayContaining([ids.silverOpening, reval.id]));
  });

  it("searches by Karigar name, job code and purity in the database", async () => {
    expect((await typesOf("ALL", { search: "ramesh" })).length).toBeGreaterThanOrEqual(5);
    expect(new Set(await typesOf("ALL", { search: ids.jobCode }))).toEqual(new Set(["CUSTODY_TO_JOB", "JOB_TO_CUSTODY", "CONSUMED_OUT"]));
    expect((await typesOf("ALL", { search: "History Silver" })).every((t) => !t.startsWith("KARIGAR"))).toBe(true);
  });

  it("pages without gaps or repeats", async () => {
    const all = (await listMetalStockHistory({ isOwner: true, pageSize: 100 })).rows.map((r) => r.id);
    const paged: string[] = [];
    for (let page = 1; page < 20; page++) {
      const p = await listMetalStockHistory({ isOwner: true, page, pageSize: 5 });
      paged.push(...p.rows.map((r) => r.id));
      if (!p.hasNextPage) break;
    }
    expect(paged).toEqual(all);
  });

  it("Staff receive the same rows with no ₹ figure, voucher number or correction code anywhere in the payload", async () => {
    const ownerRows = (await listMetalStockHistory({ isOwner: true, pageSize: 100 })).rows;
    const staff = await listMetalStockHistory({ isOwner: false, pageSize: 100 });
    expect(staff.rows.map((r) => r.id)).toEqual(ownerRows.map((r) => r.id));
    expect(staff.rows.every((r) => r.costValue === null && r.voucherNumber === null && r.corrections.length === 0 && !r.canReverse)).toBe(true);
    const payload = JSON.stringify(staff);
    for (const secret of ["600012.36", "59605.00", "4500.00", "500.00", "6543.21", correctionCode]) expect(payload).not.toContain(secret);
    expect(staff.rows.every((r) => r.ratePerGrossGram === null && r.ratePerFineGram === null)).toBe(true);
    expect(payload).not.toMatch(/₹\d/);
    // A correction-code search reveals nothing to Staff.
    expect((await listMetalStockHistory({ isOwner: false, search: correctionCode })).rows.every((r) => r.corrections.length === 0)).toBe(true);
  });
});
