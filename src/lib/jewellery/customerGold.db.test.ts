/**
 * Customer Gold — real-database proof on the disposable scratch database only
 * (the shared guard refuses anything else; these suites truncate business data).
 * CUSTOMER_GOLD_DESIGN.md is the specification.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import {
  approveCustomerGoldMix,
  customerGoldTransferFingerprint,
  planCustomerGoldTransfer,
  postCustomerGoldTransfer,
  receiveCustomerGold,
  reverseCustomerGoldEntry,
  type CustomerGoldTransferInput,
} from "@/lib/jewellery/customerGold";
import {
  customerGoldJobReceiptFingerprint,
  planCustomerGoldJobReceipt,
  receiveWithCustomerGold,
  type ReceiveWithCustomerGoldInput,
} from "@/lib/jewellery/customerGoldJobReceipt";
import { loadPoolInTx, placeBalance, type PoolKey } from "@/lib/jewellery/customerGoldLedger";
import { postCustodyOperation } from "@/lib/jewellery/karigarCustody";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { createJewelleryJob, postOpeningMetalStock, receiveFinishedJewellery } from "@/lib/jewellery/posting";
import { receiveWithCustodyAllocation } from "@/lib/jewellery/receiptCustody";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-30T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let staffId: string;
let custA: string;
let custB: string;
let karigar: string;
let g24: string; // 24K 99.9%
let g18: string; // 18K 75%
let seq = 0;
const key = (label: string) => `cg-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const staff = () => ({ id: staffId, role: "STAFF" as const });
const poolOf = (customerId: string, fineness = "99.900"): PoolKey => ({ customerId, metalType: "GOLD", purityId: g24, finenessPercentSnapshot: new Decimal(fineness) });

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}
async function upsertPurity(displayName: string, finenessPercent: string) {
  return (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType: "GOLD", displayName } },
      create: { metalType: "GOLD", displayName, finenessPercent, createdByUserId: ownerId },
      update: { finenessPercent, isActive: true },
    })
  ).id;
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  staffId = (await prisma.user.findFirstOrThrow({ where: { role: "STAFF" } })).id;
  process.env.SESSION_SECRET ??= "customer-gold-test-secret-0123456789abcdef";
  await clearAll();
  const party = async (name: string, type: "CUSTOMER" | "KARIGAR") => (await prisma.party.create({ data: { name, type, createdByUserId: ownerId } })).id;
  custA = await party("CG Customer A", "CUSTOMER");
  custB = await party("CG Customer B", "CUSTOMER");
  karigar = await party("CG Karigar", "KARIGAR");
  g24 = await upsertPurity("CG 24K", "99.900");
  g18 = await upsertPurity("CG 18K", "75.000");
  // Company stock, only for the Company-gold and mixed-job cases.
  await prisma.$transaction(
    (tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g24, grossWeight: "100.000", costValue: "700000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }),
    TX
  );
}, 90_000);

afterAll(async () => {
  await clearAll();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const intake = (customerId: string, fine: string, opts: { basis?: "GROSS" | "FINE"; deduction?: string; declared?: string } = {}) =>
  prisma.$transaction(
    (tx) =>
      receiveCustomerGold(tx, {
        customerId,
        intakeDate: DATE,
        purityId: g24,
        inputBasis: opts.basis ?? "FINE",
        weight: fine,
        deductionWeight: opts.deduction ?? null,
        reason: "Customer's own gold for their order",
        declaredValue: opts.declared ?? null,
        idempotencyKey: key("intake"),
        actor: owner(),
      }),
    TX
  );
const transfer = (input: Omit<CustomerGoldTransferInput, "purityId" | "finenessPercent" | "entryDate" | "reason"> & { reason?: string; fineness?: string }, actor: { id: string; role: "OWNER" | "STAFF" } = owner(), k = key("move")) =>
  prisma.$transaction(
    (tx) =>
      postCustomerGoldTransfer(tx, {
        purityId: g24,
        finenessPercent: input.fineness ?? "99.900",
        entryDate: DATE,
        reason: input.reason ?? "Customer gold movement",
        ...input,
        idempotencyKey: k,
        actor,
      }),
    TX
  );
const place = async (customerId: string, location: "SAFE" | "KARIGAR" | "JOB" | "FINISHED" | "RETURNED" | "SCRAP" | "LOSS" | "DELIVERED", scopeId: string | null = null) => {
  const pool = await prisma.$transaction((tx) => loadPoolInTx(tx, poolOf(customerId)), TX);
  return placeBalance(pool, { location, scopeId });
};
const fines = async (customerId: string, jobIds: string[] = []) => {
  const pool = await prisma.$transaction((tx) => loadPoolInTx(tx, poolOf(customerId)), TX);
  const f = (location: "SAFE" | "KARIGAR" | "JOB" | "FINISHED" | "RETURNED" | "SCRAP" | "LOSS" | "DELIVERED", scopeId: string | null = null) =>
    placeBalance(pool, { location, scopeId }).fine.toFixed(3);
  return { safe: f("SAFE"), karigar: f("KARIGAR", karigar), jobs: jobIds.map((j) => f("JOB", j)) };
};
async function makeJob(customerId: string | null, name: string) {
  return prisma.$transaction(
    (tx) => createJewelleryJob(tx, { customerId, jewelleryType: "RING", designName: name, karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
    TX
  );
}
type Piece = { net: string; purityId: string };
function rcv(jobId: string, pieces: Piece[], opts: Partial<ReceiveWithCustomerGoldInput> & { alloyIncluded?: string; making?: string; complete?: boolean; cg?: Partial<ReceiveWithCustomerGoldInput["customerGoldSource"]>; as?: "OWNER" | "STAFF" } = {}): ReceiveWithCustomerGoldInput {
  const { alloyIncluded, making, complete, cg, as, ...rest } = opts;
  const actor = as === "STAFF" ? staff() : owner();
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
    labourCharge: 0,
    makingCharge: making ?? 0,
    settingCharge: 0,
    platingCharge: 0,
    otherExpense: 0,
    markJobComplete: complete ?? false,
    isAbnormalLoss: false,
    damagedLostByUserId: actor.id,
    idempotencyKey: key("rcv"),
    createdByUserId: actor.id,
    customerGoldSource: { purityId: g24, finenessPercent: "99.900", ...cg },
    actor,
    ...rest,
  };
}
const receive = (i: ReceiveWithCustomerGoldInput) => prisma.$transaction((tx) => receiveWithCustomerGold(tx, i), TX);
const plan = (i: ReceiveWithCustomerGoldInput) => prisma.$transaction((tx) => planCustomerGoldJobReceipt(tx, i), TX);
async function companyLedger() {
  const r = await reconcileMetalLedger(prisma);
  return Object.fromEntries(r.lines.map((l) => [l.accountCode, { ledger: l.ledger.toFixed(2), difference: l.difference.toFixed(2) }]));
}
async function expectReconciled() {
  const r = await reconcileMetalLedger(prisma);
  for (const l of r.lines) expect({ account: l.accountCode, difference: l.difference.toFixed(2) }).toEqual({ account: l.accountCode, difference: "0.00" });
}
async function counts() {
  const [entries, vouchers, movements, stockMoves, receipts] = await Promise.all([
    prisma.customerGoldEntry.count(),
    prisma.voucher.count(),
    prisma.metalStockMovement.count(),
    prisma.finishedJewelleryStockMovement.count(),
    prisma.jewelleryReceipt.count(),
  ]);
  return { entries, vouchers, movements, stockMoves, receipts };
}

// ---------------------------------------------------------------------------
describe("Customer Gold — intake and the headline example", () => {
  it("intake: gross or fine basis, stone deduction, both weights stored; no voucher, no Company stock", async () => {
    const before = await counts();
    const byGross = await intake(custB, "5.200", { basis: "GROSS", deduction: "0.195" });
    expect([byGross.receipt.grossWeight, byGross.receipt.deductionWeight, byGross.receipt.netGrossWeight, byGross.receipt.fineWeight].map((d) => new Decimal(d).toFixed(3))).toEqual([
      "5.200",
      "0.195",
      "5.005",
      "5.000",
    ]);
    expect(byGross.receipt.receiptCode).toMatch(/^ZL-CGR-\d{4}-\d{6}$/);
    const after = await counts();
    expect([after.vouchers, after.movements]).toEqual([before.vouchers, before.movements]);
    expect(after.entries).toBe(before.entries + 1);
    expect((await fines(custB)).safe).toBe("5.000");
  });

  it("10.000 g fine received; Job A uses 3.000 g (4.000 g net 18K), Job B 2.000 g (2.002 g net 24K); 5.000 g remains — Company accounts untouched", async () => {
    const ledgerBefore = await companyLedger();
    const movementsBefore = await prisma.metalStockMovement.count();
    const stockMovesBefore = await prisma.finishedJewelleryStockMovement.count();
    const got = await intake(custA, "10");
    expect([new Decimal(got.receipt.netGrossWeight).toFixed(3), new Decimal(got.receipt.fineWeight).toFixed(3)]).toEqual(["10.010", "10.000"]);
    await transfer({ kind: "ISSUE_TO_KARIGAR", customerId: custA, karigarId: karigar, all: true });
    expect(await fines(custA)).toMatchObject({ safe: "0.000", karigar: "10.000" });

    const jobA = await makeJob(custA, "Customer ring A");
    const jobB = await makeJob(custA, "Customer ring B");
    const pA = await plan(rcv(jobA.id, [{ net: "4.000", purityId: g18 }], { alloyIncluded: "0.997", making: "1000.00" }));
    expect([pA.outputFine.toFixed(3), pA.customerFineForOutputs.toFixed(3), pA.fromKarigar.fine.toFixed(3), pA.fromKarigar.gross.toFixed(3), pA.karigarAfter.fine.toFixed(3)]).toEqual([
      "3.000",
      "3.000",
      "3.000",
      "3.003",
      "7.000",
    ]);
    const rA = await receive({ ...rcv(jobA.id, [{ net: "4.000", purityId: g18 }], { alloyIncluded: "0.997", making: "1000.00" }), expectedFingerprint: customerGoldJobReceiptFingerprint(pA) });
    const rB = await receive(rcv(jobB.id, [{ net: "2.002", purityId: g24 }]));
    expect(await fines(custA, [jobA.id, jobB.id])).toEqual({ safe: "0.000", karigar: "5.000", jobs: ["0.000", "0.000"] });

    const pieceA = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: rA.receipt.id } });
    const pieceB = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: rB.receipt.id } });
    expect([pieceA.ownership, pieceA.status, pieceA.customerId, pieceA.customerGoldFineWeight.toFixed(3), pieceA.fineMetalWeight.toFixed(3), pieceA.metalCost.toFixed(2), pieceA.labourAllocated.toFixed(2)]).toEqual([
      "CUSTOMER",
      "CUSTOMER_AWAITING_DELIVERY",
      custA,
      "3.000",
      "3.000",
      "0.00",
      "1000.00",
    ]);
    expect([pieceB.customerGoldFineWeight.toFixed(3), pieceB.metalCost.toFixed(2)]).toEqual(["2.000", "0.00"]);
    expect((await place(custA, "FINISHED", pieceA.id)).fine.toFixed(3)).toBe("3.000");
    expect((await place(custA, "FINISHED", pieceB.id)).fine.toFixed(3)).toBe("2.000");

    // Company metal, WIP and Finished Stock never moved: no Company metal movement, no stock-ledger entry.
    expect(await prisma.metalStockMovement.count()).toBe(movementsBefore);
    expect(await prisma.finishedJewelleryStockMovement.count()).toBe(stockMovesBefore);
    const ledgerAfter = await companyLedger();
    for (const code of ["1300", "1310", "1320", "1330"]) expect(ledgerAfter[code]).toEqual(ledgerBefore[code]);
    // Only the Company's own making charge sits in 1340 (and is owed to the Karigar).
    expect(ledgerAfter["1340"]).toEqual({ ledger: "1000.00", difference: "0.00" });
    const receiptVoucher = await prisma.journalEntry.findMany({ where: { voucherId: rA.receipt.postingVoucherId! }, include: { account: true } });
    expect(receiptVoucher.map((l) => [l.account.code, new Decimal(l.debit).toFixed(2), new Decimal(l.credit).toFixed(2)]).sort()).toEqual([
      ["1340", "1000.00", "0.00"],
      ["2000", "0.00", "1000.00"],
    ]);
    expect(new Decimal(rA.receipt.customerGoldFineWeight).toFixed(3)).toBe("3.000");
    // Jobs stay open until explicitly completed; the Karigar's other 5.000 g untouched.
    expect((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: jobA.id } })).status).toBe("PARTIALLY_RECEIVED");
    await expectReconciled();
  });
});

describe("Customer Gold — separation, partial receipts, returns, scrap, loss", () => {
  it("two Customers with the same Karigar never cross-use each other's gold", async () => {
    await transfer({ kind: "ISSUE_TO_KARIGAR", customerId: custB, karigarId: karigar, all: true }); // B's 5.000 g with the same Karigar
    const jobB = await makeJob(custB, "B's bangle");
    // B's job needs 6.000 g fine; A has 5.000 g with the same Karigar, B only 5.000 g — refused, nothing written.
    const before = await counts();
    await expect(receive(rcv(jobB.id, [{ net: "6.006", purityId: g24 }]))).rejects.toThrow(/CG Customer B has only 5\.000 g fine with CG Karigar and 0\.000 g fine in the safe/);
    expect(await counts()).toEqual(before);
    // A's gold can never be allocated to B's job, even by the Owner.
    await expect(transfer({ kind: "ALLOCATE_TO_JOB", customerId: custA, jobId: jobB.id, fineWeight: "1" })).rejects.toThrow(/belongs to CG Customer B/);
    // B's own receipt takes only B's gold.
    await receive(rcv(jobB.id, [{ net: "1.001", purityId: g24 }]));
    expect((await fines(custA)).karigar).toBe("5.000");
    expect((await fines(custB)).karigar).toBe("4.000");
    // A job with no Customer cannot take Customer gold at all.
    const plain = await makeJob(null, "Company-only ring");
    await expect(transfer({ kind: "ALLOCATE_TO_JOB", customerId: custA, jobId: plain.id, fineWeight: "1" })).rejects.toThrow(/has no Customer/);
  });

  it("partial receipt with two pieces, then completion with explicit return, scrap and authorised loss; never inferred", async () => {
    const job = await makeJob(custA, "Customer set");
    await transfer({ kind: "ALLOCATE_TO_JOB", customerId: custA, jobId: job.id, fineWeight: "3" }); // 3.000 g with job's Karigar -> job
    expect((await fines(custA, [job.id])).jobs[0]).toBe("3.000");
    expect((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("MATERIALS_ISSUED");

    // Receipt 1 (partial): 18K 1.000 g net (0.750 fine) + 24K 0.500 g net (0.500 fine) = 1.250 g; no shortfall taken.
    const r1 = await receive(rcv(job.id, [{ net: "1.000", purityId: g18 }, { net: "0.500", purityId: g24 }], { alloyIncluded: "0.249" }));
    const pieces = await prisma.finishedJewellery.findMany({ where: { receiptId: r1.receipt.id }, orderBy: { finishedCode: "asc" } });
    expect(pieces.map((p) => p.customerGoldFineWeight.toFixed(3))).toEqual(["0.750", "0.500"]);
    expect((await fines(custA, [job.id])).jobs[0]).toBe("1.750");
    expect((await fines(custA)).karigar).toBe("2.000"); // untouched: the job already held enough

    // Completing while 1.750 g is unexplained is refused — nothing is written off automatically.
    await expect(receive(rcv(job.id, [], { complete: true, cg: { returnGross: "0.500" } }))).rejects.toThrow(/would leave 1\.250 g fine .* never written off automatically/);
    // Staff may not record authorised loss.
    await expect(receive(rcv(job.id, [], { complete: true, as: "STAFF", cg: { returnGross: "0.500", scrapGross: "0.300", lossFine: "0.951", lossReason: "Filing loss" } }))).rejects.toThrow(/Only the Owner can record authorised process loss/);
    // Owner: 0.500 g returned (0.500 fine), 0.300 g scrap (0.300 fine), 0.950 g fine authorised loss = 1.750 g.
    const r2 = await receive(rcv(job.id, [], { complete: true, cg: { returnGross: "0.500", scrapGross: "0.300", lossFine: "0.950", lossReason: "Filing and polishing loss" } }));
    expect(await fines(custA, [job.id])).toMatchObject({ jobs: ["0.000"] });
    expect((await place(custA, "SCRAP")).fine.toFixed(3)).toBe("0.300");
    expect((await place(custA, "LOSS")).fine.toFixed(3)).toBe("0.950");
    expect((await place(custA, "SAFE")).fine.toFixed(3)).toBe("0.500");
    expect((await place(custA, "JOB", job.id)).gross.toFixed(3)).toBe("0.000"); // closes exactly in gross too
    expect((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("COMPLETED");
    const entries = await prisma.customerGoldEntry.findMany({ where: { jewelleryReceiptId: r2.receipt.id } });
    expect(entries.map((e) => [e.kind, new Decimal(e.fineWeight).toFixed(3)]).sort()).toEqual([
      ["JOB_LOSS", "0.950"],
      ["JOB_RETURN", "0.500"],
      ["JOB_SCRAP", "0.300"],
    ]);
    // Unused gold goes back to the Customer separately from the Karigar's return; scrap too.
    await transfer({ kind: "RETURN_TO_CUSTOMER", customerId: custA, all: true, reason: "Unused gold handed back" });
    await transfer({ kind: "SCRAP_RETURN_TO_CUSTOMER", customerId: custA, all: true, reason: "Scrap handed back" });
    expect((await place(custA, "RETURNED")).fine.toFixed(3)).toBe("0.800");
    await expectReconciled();
  });

  it("the Customer's received gold always equals the sum of every place", async () => {
    for (const c of [custA, custB]) {
      const pool = await prisma.$transaction((tx) => loadPoolInTx(tx, poolOf(c)), TX);
      const received = placeBalance(pool, { location: "CUSTOMER", scopeId: null }).fine.negated();
      const sum = [...pool!.places.values()].filter((p) => p.location !== "CUSTOMER").reduce((s, p) => s.plus(p.fine), new Decimal(0));
      expect(sum.toFixed(3)).toBe(received.toFixed(3));
      expect([...pool!.places.values()].every((p) => p.location === "CUSTOMER" || !p.fine.isNegative())).toBe(true);
    }
  });
});

describe("Customer Gold — refusals, stale preview, duplicates, concurrency, rollback", () => {
  it("stale preview, double submit, concurrent receipts and a failure inside the receipt all leave nothing half-written", async () => {
    await intake(custA, "4");
    await transfer({ kind: "ISSUE_TO_KARIGAR", customerId: custA, karigarId: karigar, fineWeight: "4" }); // Karigar now 9.000 g of A's gold
    const job = await makeJob(custA, "Race ring");

    const i = rcv(job.id, [{ net: "1.001", purityId: g24 }]);
    const fp = customerGoldJobReceiptFingerprint(await plan(i));
    await transfer({ kind: "RETURN_FROM_KARIGAR", customerId: custA, karigarId: karigar, fineWeight: "0.5" }); // balance moved
    const before = await counts();
    await expect(receive({ ...i, expectedFingerprint: fp })).rejects.toThrow(/changed after this preview/);
    expect(await counts()).toEqual(before);

    const once = rcv(job.id, [{ net: "1.001", purityId: g24 }]);
    const both = await Promise.allSettled([receive(once), receive(once)]);
    expect(both.some((b) => b.status === "fulfilled")).toBe(true);
    expect((await receive(once)).replayed).toBe(true);
    expect(await prisma.jewelleryReceipt.count({ where: { jobId: job.id } })).toBe(1);

    // Two receipts that together need more than the Karigar + safe hold: exactly one posts.
    const k = await place(custA, "KARIGAR", karigar);
    const s = await place(custA, "SAFE");
    const each = k.fine.plus(s.fine).times("0.6").dividedBy("0.999").toDecimalPlaces(3).toFixed(3);
    const [j1, j2] = [await makeJob(custA, "Race 1"), await makeJob(custA, "Race 2")];
    const race = await Promise.allSettled([receive(rcv(j1.id, [{ net: each, purityId: g24 }])), receive(rcv(j2.id, [{ net: each, purityId: g24 }]))]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(Number((await place(custA, "KARIGAR", karigar)).fine)).toBeGreaterThanOrEqual(0);

    // A failure after the allocation (wrong alloy split) rolls the allocation back too.
    const j3 = await makeJob(custA, "Rollback ring");
    const mid = await counts();
    await expect(receive(rcv(j3.id, [{ net: "1.000", purityId: g18 }], { alloyIncluded: "0.100" }))).rejects.toThrow(/Alloy/);
    expect(await counts()).toEqual(mid);
    expect((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: j3.id } })).status).toBe("DRAFT");
    await expectReconciled();
  });

  it("Staff can receive (recorded as Staff) but cannot move, take in or reverse Customer gold", async () => {
    const job = await makeJob(custA, "Staff-received ring");
    const r = await receive(rcv(job.id, [{ net: "0.501", purityId: g24 }], { as: "STAFF" }));
    expect(r.receipt.createdByUserId).toBe(staffId);
    const entries = await prisma.customerGoldEntry.findMany({ where: { jewelleryReceiptId: r.receipt.id } });
    expect(entries.every((e) => e.createdByUserId === staffId)).toBe(true);
    await expect(transfer({ kind: "ISSUE_TO_KARIGAR", customerId: custA, karigarId: karigar, fineWeight: "0.1" }, staff())).rejects.toThrow(/Only the Owner/);
    await expect(
      prisma.$transaction(
        (tx) => receiveCustomerGold(tx, { customerId: custA, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: "1", reason: "Staff try", idempotencyKey: key("x"), actor: staff() }),
        TX
      )
    ).rejects.toThrow(/Only the Owner/);
    const anyEntry = await prisma.customerGoldEntry.findFirstOrThrow({ where: { kind: "ISSUE_TO_KARIGAR" } });
    await expect(prisma.$transaction((tx) => reverseCustomerGoldEntry(tx, { entryId: anyEntry.id, reason: "Staff trying to reverse", actor: staff() }), TX)).rejects.toThrow(/Only the Owner/);
  });

  it("reversal: newest first, blocked while later entries depend on it, never of receipt entries", async () => {
    const c = (await prisma.party.create({ data: { name: "CG Customer C", type: "CUSTOMER", createdByUserId: ownerId } })).id;
    const got = await prisma.$transaction(
      (tx) => receiveCustomerGold(tx, { customerId: c, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: "2", reason: "C's gold", idempotencyKey: key("c"), actor: owner() }),
      TX
    );
    const moved = await transfer({ kind: "ISSUE_TO_KARIGAR", customerId: c, karigarId: karigar, fineWeight: "1.5" });
    const intakeEntry = await prisma.customerGoldEntry.findFirstOrThrow({ where: { customerGoldReceiptId: got.receipt.id } });
    await expect(prisma.$transaction((tx) => reverseCustomerGoldEntry(tx, { entryId: intakeEntry.id, reason: "Entered for the wrong customer", actor: owner() }), TX)).rejects.toThrow(
      /later entries depend on it .*Reverse newest first/
    );
    await prisma.$transaction((tx) => reverseCustomerGoldEntry(tx, { entryId: moved.entry.id, reason: "Issued by mistake, gold still in safe", actor: owner() }), TX);
    await prisma.$transaction((tx) => reverseCustomerGoldEntry(tx, { entryId: intakeEntry.id, reason: "Entered for the wrong customer", actor: owner() }), TX);
    const pool = await prisma.$transaction((tx) => loadPoolInTx(tx, poolOf(c)), TX);
    expect([...pool!.places.values()].every((p) => p.fine.isZero() && p.gross.isZero())).toBe(true);
    await expect(prisma.$transaction((tx) => reverseCustomerGoldEntry(tx, { entryId: intakeEntry.id, reason: "Entered for the wrong customer", actor: owner() }), TX)).rejects.toThrow(/already reversed/);
    const receiptEntry = await prisma.customerGoldEntry.findFirstOrThrow({ where: { kind: "CONSUME_TO_FINISHED" } });
    await expect(prisma.$transaction((tx) => reverseCustomerGoldEntry(tx, { entryId: receiptEntry.id, reason: "Trying to undo a receipt line", actor: owner() }), TX)).rejects.toThrow(
      /part of a jewellery receipt/
    );
  });

  it("the Owner's transfer preview is stale-checked too", async () => {
    const input = { kind: "ISSUE_TO_KARIGAR" as const, customerId: custA, purityId: g24, finenessPercent: "99.900", karigarId: karigar, fineWeight: "0.1", entryDate: DATE, reason: "Preview then move" };
    const fp = customerGoldTransferFingerprint(await prisma.$transaction((tx) => planCustomerGoldTransfer(tx, input), TX));
    await transfer({ kind: "ISSUE_TO_KARIGAR", customerId: custA, karigarId: karigar, fineWeight: "0.1" });
    await expect(prisma.$transaction((tx) => postCustomerGoldTransfer(tx, { ...input, expectedFingerprint: fp, idempotencyKey: key("fp"), actor: owner() }), TX)).rejects.toThrow(/changed after this preview/);
  });
});

describe("Customer Gold — Company jobs unchanged, mixed jobs only with approval", () => {
  it("an ordinary Company custody job still receives exactly as before; a Company receipt on a Customer-gold job is refused", async () => {
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: karigar, purityId: g24, fineWeight: "5", entryDate: DATE, reason: "Company gold", idempotencyKey: key("ci"), owner: owner(), ...FY }),
      TX
    );
    const job = await makeJob(null, "Company ring");
    const r = await prisma.$transaction(
      (tx) =>
        receiveWithCustodyAllocation(tx, {
          ...FY, jobId: job.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "4.000", metalType: "GOLD", purityId: g18, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          alloy: { includedGrossWeight: "0.997" }, labourCharge: 0, makingCharge: "500.00", settingCharge: 0, platingCharge: 0, otherExpense: 0,
          markJobComplete: false, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("co"), createdByUserId: ownerId,
          sourcePurityId: g24, actor: owner(),
        }),
      TX
    );
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r.receipt.id } });
    expect([piece.ownership, piece.status, piece.customerGoldFineWeight.toFixed(3), piece.metalCost.toFixed(2)]).toEqual(["COMPANY", "AVAILABLE", "0.000", "21021.00"]);
    expect(await prisma.finishedJewelleryStockMovement.count({ where: { finishedJewelleryId: piece.id, type: "PRODUCED_IN" } })).toBe(1);

    const cJob = await makeJob(custA, "Customer ring, Company receipt attempt");
    await transfer({ kind: "ALLOCATE_TO_JOB", customerId: custA, jobId: cJob.id, fineWeight: "0.5" });
    await expect(
      prisma.$transaction(
        (tx) =>
          receiveFinishedJewellery(tx, {
            ...FY, jobId: cJob.id, receiveDate: DATE,
            outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "0.500", metalType: "GOLD", purityId: g24, diamondIds: [], qcStatus: "PASSED" }],
            diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
            labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0, markJobComplete: false, isAbnormalLoss: false,
            damagedLostByUserId: ownerId, idempotencyKey: key("bad"), createdByUserId: ownerId,
          }),
        TX
      )
    ).rejects.toThrow(/holds Customer-owned gold/);
    // Company gold onto it needs the Owner's mix approval.
    await expect(
      prisma.$transaction(
        (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: karigar, purityId: g24, jobId: cJob.id, fineWeight: "0.5", entryDate: DATE, reason: "Top up", idempotencyKey: key("mix0"), owner: owner(), ...FY }),
        TX
      )
    ).rejects.toThrow(/needs the Owner's approval/);
    await expectReconciled();
  });

  it("mixed job with explicit Owner approval: each source separate, only the Company's gold carries Company cost", async () => {
    const job = await makeJob(custA, "Mixed ring");
    await intake(custA, "2");
    await transfer({ kind: "ISSUE_TO_KARIGAR", customerId: custA, karigarId: karigar, fineWeight: "2" });
    await prisma.$transaction((tx) => approveCustomerGoldMix(tx, { jobId: job.id, reason: "Customer asked us to add our gold", actor: owner() }), TX);
    await transfer({ kind: "ALLOCATE_TO_JOB", customerId: custA, jobId: job.id, fineWeight: "1" });
    const custody = await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: karigar, purityId: g24, jobId: job.id, fineWeight: "1", entryDate: DATE, reason: "Company share", idempotencyKey: key("mix"), owner: owner(), ...FY }),
      TX
    );
    // 2.002 g net 24K = 2.000 g fine: the Owner says 1.000 g is the Customer's.
    await expect(receive(rcv(job.id, [{ net: "2.002", purityId: g24 }]))).rejects.toThrow(/enter how much of the finished pieces' fine gold is the Customer's/);
    const r = await receive(rcv(job.id, [{ net: "2.002", purityId: g24 }], { complete: true, cg: { customerFineForOutputs: "1.000" } }));
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r.receipt.id } });
    expect([piece.ownership, piece.customerGoldFineWeight.toFixed(3), piece.metalCost.toFixed(2)]).toEqual(["CUSTOMER", "1.000", new Decimal(custody.entry.costValue).toFixed(2)]);
    expect((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("COMPLETED");
    await expectReconciled();
  });
});
