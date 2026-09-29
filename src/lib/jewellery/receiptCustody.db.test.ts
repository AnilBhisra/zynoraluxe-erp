/**
 * Real-database acceptance for receipt-time allocation from Karigar metal
 * custody. Disposable scratch database only (the shared guard refuses any
 * other); this suite truncates business tables.
 *
 * Headline: a Karigar holds 10.000 g FINE of 24K (99.9%). A job with NO
 * advance allocation receives 4.000 g net of 18K (75%): 3.000 g fine is
 * allocated and consumed at receipt, 7.000 g fine stays with the Karigar.
 * Stock is priced at an awkward rate so every share rounds.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { createRoughLotWithPieces, issueRoughToKarigar, receivePolishedDiamonds } from "@/lib/diamond/posting";
import { postFinishedJewellerySale } from "@/lib/jewellery/finishedSalesPosting";
import { getCustodyBalanceInTx, postCustodyOperation } from "@/lib/jewellery/karigarCustody";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import {
  completeReconciledJob,
  createJewelleryJob,
  getMetalStockBalanceInTx,
  issueMaterialsToJewelleryJob,
  pendingFineWeightOf,
  postOpeningMetalStock,
} from "@/lib/jewellery/posting";
import {
  listReceiptCustodySources,
  planReceiptCustody,
  receiptCustodyFingerprint,
  receiveWithCustodyAllocation,
  type ReceiveWithCustodyInput,
} from "@/lib/jewellery/receiptCustody";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-29T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let staffId: string;
let karigarId: string; // holds exactly 10.000 g fine: the headline example
let bigKarigarId: string; // a larger balance for everything else
let K: string; // the Karigar the helpers act for
let k24: string; // 24K 99.9%
let k18: string; // 18K 75%
let seq = 0;
const key = (label: string) => `rcc-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}
async function upsertPurity(metalType: "GOLD", displayName: string, finenessPercent: string) {
  return (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType, displayName } },
      create: { metalType, displayName, finenessPercent, createdByUserId: ownerId },
      update: { finenessPercent, isActive: true },
    })
  ).id;
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  staffId = (await prisma.user.findFirst({ where: { role: "STAFF" } }))?.id ?? ownerId;
  await clearAll();
  karigarId = (await prisma.party.create({ data: { name: "Receipt Custody Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
  k24 = await upsertPurity("GOLD", "RC 24K", "99.900");
  k18 = await upsertPurity("GOLD", "RC 18K", "75.000");
  await prisma.$transaction(
    (tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: k24, grossWeight: "1000.000", costValue: "7123456.78", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }),
    TX
  );
  // The Karigar receives 10.000 g FINE of 24K (gross 10.010 g, Rs 71,305.80).
  const issued = await prisma.$transaction(
    (tx) =>
      postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId, purityId: k24, fineWeight: "10", entryDate: DATE, reason: "Gold for the week's jobs", idempotencyKey: key("issue"), owner: owner(), ...FY }),
    TX
  );
  expect([issued.entry.grossWeight.toFixed(3), issued.entry.fineWeight.toFixed(3), issued.entry.costValue.toFixed(2)]).toEqual(["10.010", "10.000", "71305.80"]);
  bigKarigarId = (await prisma.party.create({ data: { name: "Receipt Custody Big Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
  await prisma.$transaction(
    (tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: bigKarigarId, purityId: k24, fineWeight: "60", entryDate: DATE, reason: "Larger balance", idempotencyKey: key("issue-big"), owner: owner(), ...FY }),
    TX
  );
  K = karigarId;
}, 90_000);

afterAll(async () => {
  await clearAll();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const custody = () => prisma.$transaction((tx) => getCustodyBalanceInTx(tx, K, "GOLD", k24), TX);
const jobRow = (id: string) => prisma.jewelleryJob.findUniqueOrThrow({ where: { id } });
async function makeJob(name: string) {
  return prisma.$transaction(
    (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: name, karigarId: K, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
    TX
  );
}
type Piece = { net: string; purityId: string };
function input(jobId: string, pieces: Piece[], options: Partial<ReceiveWithCustodyInput> & { alloyIncluded?: string; labour?: string } = {}): ReceiveWithCustodyInput {
  const { alloyIncluded, labour, ...opts } = options;
  return {
    ...FY,
    jobId,
    receiveDate: DATE,
    outputs: pieces.map((p) => ({ jewelleryType: "RING", quantity: 1, netMetalWeight: p.net, metalType: "GOLD" as const, purityId: p.purityId, diamondIds: [], qcStatus: "PASSED" as const })),
    diamondResolutions: [],
    returnedMetalLines: [],
    scrapMetalLines: [],
    karigarAddedFineWeight: 0,
    karigarAddedCost: 0,
    alloy: { includedGrossWeight: alloyIncluded ?? "0" },
    labourCharge: labour ?? 0,
    makingCharge: 0,
    settingCharge: 0,
    platingCharge: 0,
    otherExpense: 0,
    markJobComplete: false,
    isAbnormalLoss: false,
    damagedLostByUserId: ownerId,
    idempotencyKey: key("rcv"),
    createdByUserId: ownerId,
    sourcePurityId: k24,
    owner: owner(),
    ...opts,
  };
}
const receive = (i: ReceiveWithCustodyInput) => prisma.$transaction((tx) => receiveWithCustodyAllocation(tx, i), TX);
const plan = (i: ReceiveWithCustodyInput) => prisma.$transaction((tx) => planReceiptCustody(tx, { ...i, explicitLossFineWeight: i.explicitLossFineWeight ?? null }), TX);
async function counts() {
  const [receipts, entries, vouchers, movements] = await Promise.all([
    prisma.jewelleryReceipt.count(),
    prisma.karigarMetalCustodyEntry.count(),
    prisma.voucher.count(),
    prisma.metalStockMovement.count(),
  ]);
  return { receipts, entries, vouchers, movements };
}
async function expectReconciled() {
  const r = await reconcileMetalLedger(prisma);
  for (const l of r.lines) expect({ account: l.accountCode, difference: l.difference.toFixed(2) }).toEqual({ account: l.accountCode, difference: "0.00" });
}

// ---------------------------------------------------------------------------
describe("receipt-time allocation — the headline example", () => {
  it("a job with no advance allocation receives 4.000 g net of 18K: 3.000 g fine allocated and consumed, 7.000 g fine stays with the Karigar", async () => {
    const job = await makeJob("No-allocation ring");
    expect((await jobRow(job.id)).status).toBe("DRAFT");
    const stockBefore = await prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, "GOLD", k24), TX);
    const before = await counts();

    const i = input(job.id, [{ net: "4.000", purityId: k18 }], { alloyIncluded: "0.997" });
    const p = await plan(i);
    expect([p.outputFine.toFixed(3), p.jobPendingFine.toFixed(3), p.neededFine.toFixed(3)]).toEqual(["3.000", "0.000", "3.000"]);
    expect([p.allocation!.fineWeight.toFixed(3), p.allocation!.grossWeight.toFixed(3), p.allocation!.costValue.toFixed(2)]).toEqual(["3.000", "3.003", "21391.74"]);
    expect([p.custodyAfter.fine.toFixed(3), p.custodyAfter.gross.toFixed(3), p.custodyAfter.cost.toFixed(2)]).toEqual(["7.000", "7.007", "49914.06"]);

    const r = await receive({ ...i, expectedFingerprint: receiptCustodyFingerprint(p) });
    expect(r.replayed).toBe(false);
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: job.id } });
    expect([piece.netMetalWeight.toFixed(3), piece.fineMetalWeight.toFixed(3), piece.alloyAddedWeight.toFixed(3), piece.metalCost.toFixed(2)]).toEqual([
      "4.000",
      "3.000",
      "0.997",
      "21391.74",
    ]);
    const c = await custody();
    expect([c.fineWeight.toFixed(3), c.grossWeight.toFixed(3), c.costValue.toFixed(2)]).toEqual(["7.000", "7.007", "49914.06"]);
    const j = await jobRow(job.id);
    expect(j.status).toBe("PARTIALLY_RECEIVED"); // never auto-completed; more pieces may come
    expect(pendingFineWeightOf(j).toFixed(3)).toBe("0.000");

    // No second stock issue and no stock-issue voucher: only the receipt voucher is new.
    const after = await counts();
    expect(after.vouchers).toBe(before.vouchers + 1);
    expect(after.entries).toBe(before.entries + 1);
    const stockAfter = await prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, "GOLD", k24), TX);
    expect(stockAfter.grossWeight.toFixed(3)).toBe(stockBefore.grossWeight.toFixed(3));
    expect(stockAfter.costValue.toFixed(2)).toBe(stockBefore.costValue.toFixed(2));
    const alloc = await prisma.karigarMetalCustodyEntry.findFirstOrThrow({ where: { jobId: job.id } });
    expect([alloc.kind, alloc.voucherId, alloc.reference]).toEqual(["ALLOCATE_TO_JOB", null, r.receipt.receiptCode]);
    await expectReconciled();

    // The Owner closes the job later; the Karigar's 7.000 g is untouched.
    await prisma.$transaction((tx) => completeReconciledJob(tx, { jobId: job.id, reason: "All pieces for this order received", userId: ownerId }), TX);
    expect((await jobRow(job.id)).status).toBe("COMPLETED");
    expect((await custody()).fineWeight.toFixed(3)).toBe("7.000");
  });
});

describe("receipt-time allocation — several jobs, existing allocations, loss and returns", () => {
  beforeAll(() => {
    K = bigKarigarId;
  });
  it("separate jobs receive against the same Karigar balance; each takes exactly its own fine, value conserved", async () => {
    const start = await custody();
    const jobs = [await makeJob("Multi 1"), await makeJob("Multi 2")];
    const r1 = await receive(input(jobs[0].id, [{ net: "2.000", purityId: k18 }], { alloyIncluded: "0.498" })); // 1.500 fine
    const r2 = await receive(input(jobs[1].id, [{ net: "3.000", purityId: k24 }])); // 2.997 fine, same purity
    const a1 = await prisma.karigarMetalCustodyEntry.findFirstOrThrow({ where: { jobId: jobs[0].id } });
    const a2 = await prisma.karigarMetalCustodyEntry.findFirstOrThrow({ where: { jobId: jobs[1].id } });
    expect([a1.fineWeight.toFixed(3), a2.fineWeight.toFixed(3), a2.grossWeight.toFixed(3)]).toEqual(["1.500", "2.997", "3.000"]);
    const end = await custody();
    expect(end.fineWeight.toFixed(3)).toBe(start.fineWeight.minus("4.497").toFixed(3));
    expect(new Decimal(a1.costValue).plus(a2.costValue).plus(end.costValue).toFixed(2)).toBe(start.costValue.toFixed(2));
    for (const [r, a] of [[r1, a1], [r2, a2]] as const) {
      const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r.receipt.id } });
      expect(piece.metalCost.toFixed(2)).toBe(new Decimal(a.costValue).toFixed(2));
    }
    await expectReconciled();
  });

  it("metal already allocated to the job is used first; only the shortfall is allocated, never twice", async () => {
    // Covers ALL: 2.000 g fine allocated up front, a 24K piece of 2.000 g net needs 1.998 g fine.
    const full = await makeJob("Pre-allocated, covers all");
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: K, purityId: k24, jobId: full.id, fineWeight: "2", entryDate: DATE, reason: "Up front", idempotencyKey: key("pre1"), owner: owner(), ...FY }),
      TX
    );
    const p1 = await plan(input(full.id, [{ net: "2.000", purityId: k24 }]));
    expect(p1.allocation).toBeNull();
    await receive(input(full.id, [{ net: "2.000", purityId: k24 }]));
    expect(await prisma.karigarMetalCustodyEntry.count({ where: { jobId: full.id } })).toBe(1); // only the manual one
    expect(pendingFineWeightOf(await jobRow(full.id)).toFixed(3)).toBe("0.002"); // left on the job, not written off

    // Covers PART: 1.000 g fine up front, a 4.000 g 18K piece needs 3.000 g fine -> allocate 2.000 only.
    const part = await makeJob("Pre-allocated, covers part");
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: K, purityId: k24, jobId: part.id, fineWeight: "1", entryDate: DATE, reason: "Up front", idempotencyKey: key("pre2"), owner: owner(), ...FY }),
      TX
    );
    const p2 = await plan(input(part.id, [{ net: "4.000", purityId: k18 }], { alloyIncluded: "0.997" }));
    expect([p2.jobPendingFine.toFixed(3), p2.allocation!.fineWeight.toFixed(3)]).toEqual(["1.000", "2.000"]);
    await receive(input(part.id, [{ net: "4.000", purityId: k18 }], { alloyIncluded: "0.997" }));
    const entries = await prisma.karigarMetalCustodyEntry.findMany({ where: { jobId: part.id }, orderBy: { createdAt: "asc" } });
    expect(entries.map((e) => e.fineWeight.toFixed(3))).toEqual(["1.000", "2.000"]);
    expect(pendingFineWeightOf(await jobRow(part.id)).toFixed(3)).toBe("0.000");
    await expectReconciled();
  });

  it("the Owner's receipt form is offered the Karigar's pool for an empty job and for a job already holding that pool", async () => {
    const balance = await custody();
    const empty = await makeJob("Source list, empty");
    const sources = await listReceiptCustodySources(prisma, empty.id);
    expect(sources.map((s) => [s.purityId, s.finenessPercent, s.unallocatedFine, s.unallocatedGross])).toEqual([
      [k24, "99.900", balance.fineWeight.toFixed(3), balance.grossWeight.toFixed(3)],
    ]);
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: K, purityId: k24, jobId: empty.id, fineWeight: "0.5", entryDate: DATE, reason: "Up front", idempotencyKey: key("src"), owner: owner(), ...FY }),
      TX
    );
    const after = await listReceiptCustodySources(prisma, empty.id);
    expect(after.map((s) => [s.purityId, s.unallocatedFine])).toEqual([[k24, balance.fineWeight.minus("0.5").toFixed(3)]]);
  });

  it("completing a job needs every gram explained: unexplained metal is refused, an explicit loss is recorded, the Karigar's balance is untouched", async () => {
    const job = await makeJob("Completion rules");
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: K, purityId: k24, jobId: job.id, fineWeight: "2", entryDate: DATE, reason: "Up front", idempotencyKey: key("pre3"), owner: owner(), ...FY }),
      TX
    );
    const before = await counts();
    const custodyBefore = await custody();
    // 1.200 g net 24K = 1.199 g fine; completing would leave 0.801 g unexplained.
    await expect(receive(input(job.id, [{ net: "1.200", purityId: k24 }], { markJobComplete: true }))).rejects.toThrow(/leave 0\.801 g fine unexplained/);
    expect(await counts()).toEqual(before); // nothing saved
    // A loss only with completion.
    await expect(receive(input(job.id, [{ net: "1.200", purityId: k24 }], { explicitLossFineWeight: "0.801" }))).rejects.toThrow(/only when completing/);
    // Explicit loss of exactly the remainder: completes, loss recorded, no custody touched.
    const r = await receive(input(job.id, [{ net: "1.200", purityId: k24 }], { markJobComplete: true, explicitLossFineWeight: "0.801" }));
    expect(r.receipt.processLossFineWeight.toFixed(3)).toBe("0.801");
    expect((await jobRow(job.id)).status).toBe("COMPLETED");
    const custodyAfter = await custody();
    expect(custodyAfter.fineWeight.toFixed(3)).toBe(custodyBefore.fineWeight.toFixed(3));
    expect(await prisma.karigarMetalCustodyEntry.count({ where: { jobId: job.id } })).toBe(1);

    // A completing receipt on a job with NO allocation takes finished + loss from the Karigar, nothing more.
    const fresh = await makeJob("Complete with loss, no allocation");
    const cb = await custody();
    const r2 = await receive(input(fresh.id, [{ net: "3.000", purityId: k18 }], { alloyIncluded: "0.748", markJobComplete: true, explicitLossFineWeight: "0.050" }));
    const alloc = await prisma.karigarMetalCustodyEntry.findFirstOrThrow({ where: { jobId: fresh.id } });
    expect([alloc.fineWeight.toFixed(3), r2.receipt.processLossFineWeight.toFixed(3)]).toEqual(["2.300", "0.050"]); // 2.250 finished + 0.050 loss
    expect((await custody()).fineWeight.toFixed(3)).toBe(cb.fineWeight.minus("2.300").toFixed(3));
    await expectReconciled();
  });

  it("usable metal returned at receipt is allocated with the piece and goes back to company stock", async () => {
    const job = await makeJob("Receipt with a return");
    const stockBefore = await prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, "GOLD", k24), TX);
    const i = input(job.id, [{ net: "1.000", purityId: k24 }], { returnedMetalLines: [{ purityId: k24, grossWeight: "1.000" }] });
    const p = await plan(i);
    expect([p.outputFine.toFixed(3), p.returnedFine.toFixed(3), p.allocation!.fineWeight.toFixed(3)]).toEqual(["0.999", "0.999", "1.998"]);
    await receive(i);
    const stockAfter = await prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, "GOLD", k24), TX);
    expect(stockAfter.grossWeight.minus(stockBefore.grossWeight).toFixed(3)).toBe("1.000");
    await expectReconciled();
  });
});

describe("receipt-time allocation — refusals, idempotency, concurrency, rollback, permissions", () => {
  it("refuses an insufficient balance with nothing written", async () => {
    const job = await makeJob("Too big");
    const before = await counts();
    const have = (await custody()).fineWeight;
    const net = have.plus(1).toFixed(3); // 24K piece needs more fine than the Karigar holds
    await expect(receive(input(job.id, [{ net, purityId: k24 }]))).rejects.toThrow(/has only .* g fine .* unallocated/);
    expect(await counts()).toEqual(before);
  });

  it("refuses a stale preview", async () => {
    const job = await makeJob("Stale");
    const i = input(job.id, [{ net: "1.000", purityId: k24 }]);
    const p = await plan(i);
    // The balance moves after the preview.
    const other = await makeJob("Takes metal meanwhile");
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: K, purityId: k24, jobId: other.id, fineWeight: "0.5", entryDate: DATE, reason: "Meanwhile", idempotencyKey: key("mid"), owner: owner(), ...FY }),
      TX
    );
    const before = await counts();
    await expect(receive({ ...i, expectedFingerprint: receiptCustodyFingerprint(p) })).rejects.toThrow(/changed after this preview/);
    expect(await counts()).toEqual(before);
  });

  it("a double submit posts once; two concurrent submits with one key post once", async () => {
    const job = await makeJob("Double submit");
    const i = input(job.id, [{ net: "1.000", purityId: k24 }]);
    const first = await receive(i);
    const second = await receive(i);
    expect([first.replayed, second.replayed]).toEqual([false, true]);
    expect(await prisma.jewelleryReceipt.count({ where: { jobId: job.id } })).toBe(1);
    expect(await prisma.karigarMetalCustodyEntry.count({ where: { jobId: job.id } })).toBe(1);

    const job2 = await makeJob("Concurrent same key");
    const i2 = input(job2.id, [{ net: "1.000", purityId: k24 }]);
    const both = await Promise.allSettled([receive(i2), receive(i2)]);
    expect(both.some((b) => b.status === "fulfilled")).toBe(true);
    expect(await prisma.jewelleryReceipt.count({ where: { jobId: job2.id } })).toBe(1);
    expect(await prisma.karigarMetalCustodyEntry.count({ where: { jobId: job2.id } })).toBe(1);
  });

  it("two concurrent receipts that together need more than the balance: exactly one posts, nothing goes negative", async () => {
    const have = (await custody()).fineWeight; // fine left; each 24K piece below needs ~60%
    const net = have.times("0.6").dividedBy("0.999").toDecimalPlaces(3).toFixed(3);
    const a = await makeJob("Race A");
    const b = await makeJob("Race B");
    const results = await Promise.allSettled([receive(input(a.id, [{ net, purityId: k24 }])), receive(input(b.id, [{ net, purityId: k24 }]))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const left = await custody();
    expect(left.fineWeight.isNegative() || left.costValue.isNegative()).toBe(false);
    await expectReconciled();
  });

  it("a failure inside the receipt rolls the allocation back too", async () => {
    const job = await makeJob("Rollback");
    const before = await counts();
    const custodyBefore = await custody();
    // Wrong alloy split: the receipt refuses AFTER the allocation was posted in the same transaction.
    await expect(receive(input(job.id, [{ net: "2.000", purityId: k18 }], { alloyIncluded: "0.100" }))).rejects.toThrow(/Alloy/i);
    expect(await counts()).toEqual(before);
    expect((await custody()).fineWeight.toFixed(3)).toBe(custodyBefore.fineWeight.toFixed(3));
    const j = await jobRow(job.id);
    expect([j.status, pendingFineWeightOf(j).toFixed(3)]).toEqual(["DRAFT", "0.000"]);
  });

  it("only the Owner can take metal from a Karigar's balance at receipt", async () => {
    const job = await makeJob("Staff try");
    await expect(receive(input(job.id, [{ net: "1.000", purityId: k24 }], { owner: { id: staffId, role: "STAFF" } }))).rejects.toThrow(/Only the Owner/);
  });
});

describe("direct gold issue is refused; diamonds and other materials still issue", () => {
  it("Issue Materials refuses gold server-side but issues a diamond", async () => {
    const job = await makeJob("Direct gold try");
    await expect(
      prisma.$transaction(
        (tx) =>
          issueMaterialsToJewelleryJob(tx, { ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId: k24, grossWeight: "1" }], polishedDiamondIds: [], otherMaterialLines: [], createdByUserId: ownerId }),
        TX
      )
    ).rejects.toThrow(/Gold is not issued to a job directly/);

    const supplier = await prisma.party.create({ data: { name: "RC Supplier", type: "SUPPLIER", createdByUserId: ownerId } });
    const manufacturer = await prisma.party.create({ data: { name: "RC Manufacturer", type: "MANUFACTURER", createdByUserId: ownerId } });
    const lot = await prisma.$transaction(
      (tx) => createRoughLotWithPieces(tx, { ...FY, purchaseDate: DATE, supplierId: supplier.id, purchaseRate: 800, rateBasis: "PER_CARAT", currencyCode: "INR", exchangeRate: 1, totalPurchaseCost: "8000.00", gstTreatment: "NONE", idempotencyKey: key("rough"), createdByUserId: ownerId, pieces: [{ carat: "2.000" }] }),
      TX
    );
    const piece = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
    const dj = await prisma.$transaction(
      (tx) => issueRoughToKarigar(tx, { ...FY, karigarId: manufacturer.id, roughPieceIds: [piece.id], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key("rough-issue"), createdByUserId: ownerId }),
      TX
    );
    const polished = await prisma.$transaction(
      (tx) => receivePolishedDiamonds(tx, { ...FY, jobId: dj.id, receiveDate: DATE, returnedRoughCarat: 0, labourCharge: 500, shape: "ROUND", markJobComplete: true, idempotencyKey: key("polished"), createdByUserId: ownerId, outputs: [{ shape: "ROUND", carat: "1.500" }] }),
      TX
    );
    await prisma.$transaction(
      (tx) =>
        issueMaterialsToJewelleryJob(tx, { ...FY, jobId: job.id, issueDate: DATE, metalLines: [], polishedDiamondIds: [polished.outputs[0].id], otherMaterialLines: [{ description: "Findings", quantity: 2, unit: "PCS", cost: 150 }], createdByUserId: ownerId }),
      TX
    );
    const j = await jobRow(job.id);
    expect([j.status, j.issuedDiamondCost.greaterThan(0)]).toEqual(["MATERIALS_ISSUED", true]);
    expect(await prisma.jewelleryMetalIssueLine.count({ where: { jobId: job.id } })).toBe(0);

    // That job then takes its gold at receipt time, with the diamond set in the piece.
    const r = await receive({
      ...input(job.id, [{ net: "2.000", purityId: k24 }]),
      outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "2.000", metalType: "GOLD", purityId: k24, diamondIds: [polished.outputs[0].id], qcStatus: "PASSED" }],
      diamondResolutions: [{ polishedDiamondId: polished.outputs[0].id, resolution: "SET" }],
    });
    const fin = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r.receipt.id } });
    expect([fin.fineMetalWeight.toFixed(3), fin.diamondCost.greaterThan(0)]).toEqual(["1.998", true]);
    await expectReconciled();
  });

  it("the app never passes the legacy flag", async () => {
    const { readFileSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");
    const hits = execFileSync("git", ["grep", "-l", "legacyDirectGoldIssue", "--", "src", ":!*.test.ts"], { encoding: "utf8" }).trim().split("\n");
    expect(hits).toEqual(["src/lib/jewellery/posting.ts"]); // defined there, set nowhere
    expect(readFileSync("src/app/actions/jewellery.ts", "utf8")).not.toMatch(/legacyDirectGoldIssue/);
  });
});

describe("cost counted once: sale COGS and ledger", () => {
  it("a piece made from receipt-time allocation sells at exactly its allocated metal cost plus labour", async () => {
    const job = await makeJob("Sell me");
    const r = await receive(input(job.id, [{ net: "1.000", purityId: k24 }], { labour: "300" }));
    const alloc = await prisma.karigarMetalCustodyEntry.findFirstOrThrow({ where: { jobId: job.id } });
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r.receipt.id } });
    expect(piece.metalCost.toFixed(2)).toBe(new Decimal(alloc.costValue).toFixed(2));
    const customer = await prisma.party.create({ data: { name: "RC Customer", type: "CUSTOMER", createdByUserId: ownerId } });
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
        items: [{ finishedJewelleryId: piece.id, sellingPrice: "15000.00", gstRatePercent: 0, taxType: "EXCLUSIVE" }],
      })
    );
    expect(new Decimal(sale.cogsTotal).toFixed(2)).toBe(new Decimal(alloc.costValue).plus(300).toFixed(2));
    await expectReconciled();
  });
});
