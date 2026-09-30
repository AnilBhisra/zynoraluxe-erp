/**
 * Customer Gold jewellery receipt reversal / correction and the mixed
 * Customer + Company gold workflow — real-database proof on the disposable
 * scratch database only (the shared guard refuses anything else).
 * CUSTOMER_GOLD_DESIGN.md §2.3 (mixed) and §2.6 (reversal).
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { createPolishedPurchase, getPacketBalanceInTx } from "@/lib/diamond/polishedPurchase";
import { createRoughLotWithPieces, issueRoughToKarigar, receivePolishedDiamonds } from "@/lib/diamond/posting";
import { approveCustomerGoldMix, postCustomerGoldTransfer, receiveCustomerGold, type CustomerGoldTransferInput } from "@/lib/jewellery/customerGold";
import { billCustomerJewellery, deliverCustomerJewellery, reverseCustomerJewelleryBill, reverseCustomerJewelleryDelivery } from "@/lib/jewellery/customerGoldCommercial";
import { planCustomerGoldJobReceipt, receiveWithCustomerGold, type ReceiveWithCustomerGoldInput } from "@/lib/jewellery/customerGoldJobReceipt";
import { loadPoolInTx, placeBalance } from "@/lib/jewellery/customerGoldLedger";
import { planCustomerGoldReceiptReversal, reverseCustomerGoldJobReceipt } from "@/lib/jewellery/customerGoldReceiptReversal";
import { postCustodyOperation } from "@/lib/jewellery/karigarCustody";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { createJewelleryJob, issueMaterialsToJewelleryJob, postOpeningMetalStock } from "@/lib/jewellery/posting";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-30T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let staffId: string;
let karigar: string;
let supplier: string;
let manufacturer: string;
let g24: string; // 99.9%
let g18: string; // 75%
let seq = 0;
const key = (label: string) => `cgr-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const staff = () => ({ id: staffId, role: "STAFF" as const });

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
  const party = async (name: string, type: "CUSTOMER" | "KARIGAR" | "SUPPLIER" | "MANUFACTURER") => (await prisma.party.create({ data: { name, type, createdByUserId: ownerId } })).id;
  karigar = await party("CGR Karigar", "KARIGAR");
  supplier = await party("CGR Supplier", "SUPPLIER");
  manufacturer = await party("CGR Manufacturer", "MANUFACTURER");
  g24 = await upsertPurity("CGR 24K", "99.900");
  g18 = await upsertPurity("CGR 18K", "75.000");
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
const customer = async (name: string) => (await prisma.party.create({ data: { name, type: "CUSTOMER", createdByUserId: ownerId } })).id;
const intake = (customerId: string, fine: string) =>
  prisma.$transaction(
    (tx) => receiveCustomerGold(tx, { customerId, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: fine, reason: "Customer's own gold", idempotencyKey: key("in"), actor: owner() }),
    TX
  );
const move = (input: Omit<CustomerGoldTransferInput, "purityId" | "finenessPercent" | "entryDate" | "reason">) =>
  prisma.$transaction((tx) => postCustomerGoldTransfer(tx, { purityId: g24, finenessPercent: "99.900", entryDate: DATE, reason: "Customer gold movement", ...input, idempotencyKey: key("mv"), actor: owner() }), TX);
const makeJob = (customerId: string, name: string) =>
  prisma.$transaction((tx) => createJewelleryJob(tx, { customerId, jewelleryType: "RING", designName: name, karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }), TX);

async function companyDiamond() {
  const lot = await prisma.$transaction(
    (tx) => createRoughLotWithPieces(tx, { ...FY, purchaseDate: DATE, supplierId: supplier, purchaseRate: 800, rateBasis: "PER_CARAT", currencyCode: "INR", exchangeRate: 1, totalPurchaseCost: "8000.00", gstTreatment: "NONE", idempotencyKey: key("rough"), createdByUserId: ownerId, pieces: [{ carat: "2.000" }] }),
    TX
  );
  const rough = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
  const dj = await prisma.$transaction(
    (tx) => issueRoughToKarigar(tx, { ...FY, karigarId: manufacturer, roughPieceIds: [rough.id], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key("ri"), createdByUserId: ownerId }),
    TX
  );
  await prisma.$transaction(
    (tx) => receivePolishedDiamonds(tx, { ...FY, jobId: dj.id, receiveDate: DATE, returnedRoughCarat: 0, labourCharge: 500, shape: "ROUND", markJobComplete: true, idempotencyKey: key("pd"), createdByUserId: ownerId, outputs: [{ shape: "ROUND", carat: "1.500" }] }),
    TX
  );
  return prisma.polishedDiamond.findFirstOrThrow({ where: { jobId: dj.id } });
}
async function companyPacket(pieces: number, carat: string) {
  const bought = await prisma.$transaction(
    (tx) =>
      createPolishedPurchase(tx, {
        ...FY, purchaseDate: DATE, supplierId: supplier, currencyCode: "INR", exchangeRate: 1, supplierAmount: new Decimal(8000).times(carat).toFixed(2),
        gstTreatment: "NONE", brokerageTreatment: "NONE", idempotencyKey: key("pp"), createdByUserId: ownerId,
        lines: [{ shape: "ROUND", sizeLabel: "1.00-1.10", pieces, carat, rateBasis: "PER_CARAT", rate: "8000" }],
      }),
    TX
  );
  return bought.packets[0];
}
const issueStones = (jobId: string, diamondIds: string[], packetLines: { packetId: string; pieces: number; carat: string }[]) =>
  prisma.$transaction(
    (tx) => issueMaterialsToJewelleryJob(tx, { ...FY, jobId, issueDate: DATE, metalLines: [], polishedDiamondIds: diamondIds, packetLines, otherMaterialLines: [], idempotencyKey: key("im"), createdByUserId: ownerId }),
    TX
  );

type Piece = { net: string; purityId: string; diamondIds?: string[] };
function rcv(
  jobId: string,
  pieces: Piece[],
  opts: Partial<ReceiveWithCustomerGoldInput> & { complete?: boolean; share?: string; cgReturn?: string; labour?: string; making?: string; as?: "OWNER" | "STAFF"; alloyIncluded?: string } = {}
): ReceiveWithCustomerGoldInput {
  const { complete, share, cgReturn, labour, making, as, alloyIncluded, ...rest } = opts;
  const actor = as === "STAFF" ? staff() : owner();
  const diamondIds = pieces.flatMap((p) => p.diamondIds ?? []);
  return {
    ...FY,
    jobId,
    receiveDate: DATE,
    outputs: pieces.map((p) => ({ jewelleryType: "RING", quantity: 1, netMetalWeight: p.net, metalType: "GOLD" as const, purityId: p.purityId, diamondIds: p.diamondIds ?? [], qcStatus: "PASSED" as const })),
    diamondResolutions: diamondIds.map((id) => ({ polishedDiamondId: id, resolution: "SET" as const })),
    returnedMetalLines: [],
    scrapMetalLines: [],
    karigarAddedFineWeight: 0,
    karigarAddedCost: 0,
    alloy: { includedGrossWeight: alloyIncluded ?? "0" },
    labourCharge: labour ?? 0,
    makingCharge: making ?? 0,
    settingCharge: 0,
    platingCharge: 0,
    otherExpense: 0,
    markJobComplete: complete ?? false,
    isAbnormalLoss: false,
    damagedLostByUserId: actor.id,
    idempotencyKey: key("rcv"),
    createdByUserId: actor.id,
    customerGoldSource: { purityId: g24, finenessPercent: "99.900", customerFineForOutputs: share ?? null, returnGross: cgReturn ?? null },
    actor,
    ...rest,
  };
}
const receive = (i: ReceiveWithCustomerGoldInput) => prisma.$transaction((tx) => receiveWithCustomerGold(tx, i), TX);
const reverse = (receiptId: string, opts: { k?: string; actor?: ReturnType<typeof owner> | ReturnType<typeof staff>; reason?: string } = {}) =>
  prisma.$transaction(
    (tx) => reverseCustomerGoldJobReceipt(tx, { receiptId, reason: opts.reason ?? "Wrong figures were entered at receipt", idempotencyKey: opts.k ?? key("rev"), actor: opts.actor ?? owner(), ...FY }),
    TX
  );
const planReversal = (receiptId: string) => prisma.$transaction((tx) => planCustomerGoldReceiptReversal(tx, receiptId), TX);

async function goldAt(customerId: string, location: "SAFE" | "KARIGAR" | "JOB" | "FINISHED" | "SCRAP" | "RETURNED", scopeId: string | null = null) {
  const pool = await prisma.$transaction((tx) => loadPoolInTx(tx, { customerId, metalType: "GOLD", purityId: g24, finenessPercentSnapshot: new Decimal("99.900") }), TX);
  return placeBalance(pool, { location, scopeId }).fine.toFixed(3);
}
const JOB_FIELDS = ["receivedFineWeight", "returnedMetalFineWeight", "scrapFineWeight", "karigarAddedFineWeight", "karigarAddedCost", "consumedAlloyGrossWeight", "returnedAlloyGrossWeight", "remainingAlloyWipCost", "totalLabourCharge", "remainingWipCost", "status"] as const;
async function jobState(jobId: string) {
  const j = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: jobId } });
  return Object.fromEntries(JOB_FIELDS.map((f) => [f, String(j[f])]));
}
async function karigarPayable() {
  const a = await prisma.journalEntry.aggregate({ where: { partyId: karigar, account: { code: "2000" } }, _sum: { credit: true, debit: true } });
  return new Decimal(a._sum.credit ?? 0).minus(a._sum.debit ?? 0).toFixed(2);
}
async function ledger(code: string) {
  const r = await reconcileMetalLedger(prisma);
  return r.lines.find((l) => l.accountCode === code)!.ledger.toFixed(2);
}
async function expectEverythingBalanced() {
  const r = await reconcileMetalLedger(prisma);
  for (const l of r.lines) expect({ account: l.accountCode, difference: l.difference.toFixed(2) }).toEqual({ account: l.accountCode, difference: "0.00" });
  const vouchers = await prisma.voucher.findMany({ include: { journalEntries: true } });
  for (const v of vouchers) {
    const dr = v.journalEntries.reduce((s, j) => s.plus(j.debit), new Decimal(0));
    const cr = v.journalEntries.reduce((s, j) => s.plus(j.credit), new Decimal(0));
    expect({ voucher: v.voucherNumber, dr: dr.toFixed(2) }).toEqual({ voucher: v.voucherNumber, dr: cr.toFixed(2) });
  }
}
async function worldCounts() {
  const [entries, vouchers, metalMoves, stoneMoves, packetMoves, receiptsReversed] = await Promise.all([
    prisma.customerGoldEntry.count(),
    prisma.voucher.count(),
    prisma.metalStockMovement.count(),
    prisma.stockMovement.count(),
    prisma.polishedPacketMovement.count(),
    prisma.jewelleryReceipt.count({ where: { reversedAt: { not: null } } }),
  ]);
  return { entries, vouchers, metalMoves, stoneMoves, packetMoves, receiptsReversed };
}

// ---------------------------------------------------------------------------
// 1. Correction = audited reversal + a new, correct receipt
// ---------------------------------------------------------------------------
describe("Owner reversal of a Customer Gold receipt, then the correct receipt", () => {
  let cust: string;
  let jobId: string;
  let diamondId: string;
  let packetId: string;
  let wrongReceiptId: string;
  const before: Record<string, unknown> = {};

  it("setup: 10.000 g of the Customer's gold with the Karigar; a Company diamond and 10 packet stones on the job", async () => {
    cust = await customer("CGR Customer One");
    await intake(cust, "10");
    await move({ kind: "ISSUE_TO_KARIGAR", customerId: cust, karigarId: karigar, fineWeight: "10" });
    jobId = (await makeJob(cust, "Ring with stones")).id;
    diamondId = (await companyDiamond()).id;
    packetId = (await companyPacket(10, "1.000")).id;
    await issueStones(jobId, [diamondId], [{ packetId, pieces: 10, carat: "1.000" }]);
    Object.assign(before, {
      job: await jobState(jobId),
      karigarGold: await goldAt(cust, "KARIGAR", karigar),
      payable: await karigarPayable(),
      l1340: await ledger("1340"),
      l1320: await ledger("1320"),
      packet: await prisma.$transaction((tx) => getPacketBalanceInTx(tx, packetId), TX),
    });
    expect(before.karigarGold).toBe("10.000");
  });

  it("wrong weight + charges + stones: 4.000 g net recorded instead of 3.000 g, ₹300 labour + ₹1,000 making, diamond set, 6 stones set / 4 returned", async () => {
    const r = await receive(
      rcv(jobId, [{ net: "4.000", purityId: g24, diamondIds: [diamondId] }], {
        labour: "300",
        making: "1000",
        packetResolutions: [
          { packetId, resolution: "SET", pieces: 6, carat: "0.600", setInOutputIndex: 0 },
          { packetId, resolution: "RETURNED", pieces: 4, carat: "0.400" },
        ],
      })
    );
    wrongReceiptId = r.receipt.id;
    expect(await goldAt(cust, "KARIGAR", karigar)).toBe("6.004");
    expect(new Decimal(await karigarPayable()).minus(before.payable as string).toFixed(2)).toBe("1300.00");
    expect(r.receipt.reversalSnapshot).not.toBeNull();
    await expectEverythingBalanced();
  });

  it("Staff cannot reverse; a reason is required; the Owner's preview lists exactly what goes back", async () => {
    await expect(reverse(wrongReceiptId, { actor: staff() })).rejects.toThrow(/Only the Owner can reverse/);
    await expect(reverse(wrongReceiptId, { reason: "typo" })).rejects.toThrow(/at least 10 characters/);
    const plan = await planReversal(wrongReceiptId);
    expect(plan.blockers).toEqual([]);
    expect(plan.pieces.map((p) => p.customerGoldFineWeight)).toEqual(["3.996"]);
    expect(plan.goldBack.find((g) => g.label === "With Karigar")?.fine).toBe("3.996");
    expect(plan.diamondsBack.length).toBe(1);
    expect(plan.packetStonesBack.map((p) => `${p.disposition} ${p.pieces}`).sort()).toEqual(["RETURNED 4", "SET 6"]);
    expect(plan.jobStatusAfter).toBe((before.job as Record<string, string>).status);
  });

  it("reversal restores everything exactly: gold, pieces, stones, packets, payable, 1340 / 1320, job — and never deletes the receipt", async () => {
    const k = key("rev1");
    const res = await reverse(wrongReceiptId, { k });
    expect(res.replayed).toBe(false);
    const receipt = await prisma.jewelleryReceipt.findUniqueOrThrow({ where: { id: wrongReceiptId }, include: { outputs: true, postingVoucher: true } });
    expect([receipt.reversedByUserId, receipt.reversalReason, receipt.reversalVoucherId !== null, receipt.postingVoucher?.status]).toEqual([ownerId, "Wrong figures were entered at receipt", true, "CANCELLED"]);
    expect(receipt.outputs.map((o) => o.status)).toEqual(["RECEIPT_REVERSED"]);
    expect(await goldAt(cust, "KARIGAR", karigar)).toBe("10.000");
    expect(await goldAt(cust, "JOB", jobId)).toBe("0.000");
    expect(await goldAt(cust, "FINISHED", receipt.outputs[0].id)).toBe("0.000");
    expect(await jobState(jobId)).toEqual(before.job);
    expect(await karigarPayable()).toBe(before.payable);
    expect([await ledger("1340"), await ledger("1320")]).toEqual([before.l1340, before.l1320]);
    const d = await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: diamondId } });
    const line = await prisma.jewelleryDiamondIssueLine.findFirstOrThrow({ where: { jobId, polishedDiamondId: diamondId } });
    expect([d.status, line.resolvedAs, line.setInFinishedJewelleryId]).toEqual(["ISSUED_TO_JEWELLERY", null, null]);
    const pl = await prisma.jewelleryPacketIssueLine.findFirstOrThrow({ where: { jobId, packetId } });
    expect([pl.setPieces, pl.returnedPieces, pl.setCarat.toFixed(3), pl.returnedCarat.toFixed(3)]).toEqual([0, 0, "0.000", "0.000"]);
    const packetNow = await prisma.$transaction((tx) => getPacketBalanceInTx(tx, packetId), TX);
    const packetBefore = before.packet as { pieces: number; carat: Decimal };
    expect([packetNow.pieces, packetNow.carat.toFixed(3)]).toEqual([packetBefore.pieces, packetBefore.carat.toFixed(3)]);
    expect(await prisma.jewelleryPacketResolution.count({ where: { receiptId: wrongReceiptId, reversedAt: null } })).toBe(0);
    await expectEverythingBalanced();

    // Duplicate: same key replays, any other attempt is refused.
    expect((await reverse(wrongReceiptId, { k })).replayed).toBe(true);
    await expect(reverse(wrongReceiptId)).rejects.toThrow(/already reversed/);
  });

  it("the correct receipt is then recorded normally (3.000 g net = 2.997 g fine; all 10 stones set)", async () => {
    const r = await receive(
      rcv(jobId, [{ net: "3.000", purityId: g24, diamondIds: [diamondId] }], {
        labour: "300",
        making: "1000",
        complete: true,
        packetResolutions: [{ packetId, resolution: "SET", pieces: 10, carat: "1.000", setInOutputIndex: 0 }],
      })
    );
    const piece = r.outputs![0];
    expect([piece.customerGoldFineWeight.toFixed(3), piece.status]).toEqual(["2.997", "CUSTOMER_AWAITING_DELIVERY"]);
    expect(await goldAt(cust, "KARIGAR", karigar)).toBe("7.003");
    expect((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("COMPLETED");
    await expectEverythingBalanced();
  });
});

// ---------------------------------------------------------------------------
// 2. Wrong purity, several outputs, partial receipts — newest first
// ---------------------------------------------------------------------------
describe("wrong purity, two outputs, partial receipts: newest first", () => {
  let cust: string;
  let jobId: string;
  let r1: string;
  let r2: string;
  let jobBefore: Record<string, string>;

  it("R1 records two 18K pieces by mistake; R2 a third piece; R1 cannot be reversed while R2 stands", async () => {
    cust = await customer("CGR Customer Two");
    await intake(cust, "10");
    await move({ kind: "ISSUE_TO_KARIGAR", customerId: cust, karigarId: karigar, fineWeight: "10" });
    jobId = (await makeJob(cust, "Earrings")).id;
    jobBefore = await jobState(jobId);
    r1 = (await receive(rcv(jobId, [{ net: "2.000", purityId: g18 }, { net: "2.000", purityId: g18 }], { alloyIncluded: "0.996" }))).receipt.id;
    r2 = (await receive(rcv(jobId, [{ net: "1.000", purityId: g24 }]))).receipt.id;
    expect(await goldAt(cust, "KARIGAR", karigar)).toBe("6.001");
    const plan = await planReversal(r1);
    const r2Code = (await prisma.jewelleryReceipt.findUniqueOrThrow({ where: { id: r2 } })).receiptCode;
    expect(plan.blockers.join(" ")).toContain(`${r2Code} was recorded on`);
    await expect(reverse(r1)).rejects.toThrow(/reverse it first \(newest first\)/);
  });

  it("R2 then R1 are reversed; the job and the Customer's gold are exactly as before; the right purity is then received", async () => {
    await reverse(r2);
    await reverse(r1);
    expect(await jobState(jobId)).toEqual(jobBefore);
    expect(await goldAt(cust, "KARIGAR", karigar)).toBe("10.000");
    const again = await receive(rcv(jobId, [{ net: "2.000", purityId: g24 }, { net: "2.000", purityId: g24 }], { complete: false }));
    expect(again.outputs!.map((o) => o.customerGoldFineWeight.toFixed(3))).toEqual(["1.998", "1.998"]);
    await expectEverythingBalanced();
  });
});

// ---------------------------------------------------------------------------
// 3. Every dependency blocks, and each refusal names it
// ---------------------------------------------------------------------------
describe("reversal is blocked by anything that depends on the receipt", () => {
  it("delivered → names the delivery; billed → names the bill; both reversed → the receipt reverses", async () => {
    const cust = await customer("CGR Customer Three");
    await intake(cust, "5");
    await move({ kind: "ISSUE_TO_KARIGAR", customerId: cust, karigarId: karigar, fineWeight: "5" });
    const job = await makeJob(cust, "Pendant");
    const r = await receive(rcv(job.id, [{ net: "2.000", purityId: g24 }], { complete: true, making: "800" }));
    const d = await prisma.$transaction((tx) => deliverCustomerJewellery(tx, { jobId: job.id, deliveryDate: DATE, receivedByName: "Customer", idempotencyKey: key("d"), actor: owner(), ...FY }), TX);
    await expect(reverse(r.receipt.id)).rejects.toThrow(new RegExp(`delivered to the Customer in ${d.delivery.deliveryCode}`));
    const b = await prisma.$transaction((tx) => billCustomerJewellery(tx, { jobId: job.id, billDate: DATE, makingCharge: "1000", gstTreatment: "NONE", idempotencyKey: key("b"), actor: owner(), ...FY }), TX);
    await prisma.$transaction((tx) => reverseCustomerJewelleryDelivery(tx, { deliveryId: d.delivery.id, reason: "Recorded on the wrong job", actor: owner(), ...FY }), TX);
    await expect(reverse(r.receipt.id)).rejects.toThrow(new RegExp(`Bill ${b.bill.billCode} is posted`));
    await prisma.$transaction((tx) => reverseCustomerJewelleryBill(tx, { billId: b.bill.id, reason: "Bill for the wrong receipt", actor: owner(), ...FY }), TX);
    await reverse(r.receipt.id);
    expect(await goldAt(cust, "KARIGAR", karigar)).toBe("5.000");
    // Back to exactly its state before the receipt: Draft (the receipt-time allocation had moved it on).
    expect((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("DRAFT");
    await expectEverythingBalanced();
  });

  it("returned Customer gold already handed back to the Customer → names that entry", async () => {
    const cust = await customer("CGR Customer Four");
    await intake(cust, "3");
    await move({ kind: "ISSUE_TO_KARIGAR", customerId: cust, karigarId: karigar, fineWeight: "3" });
    const job = await makeJob(cust, "Chain");
    // 2.000 g fine used, 1.001 g gross (1.000 g fine) returned to the safe, job complete.
    const r = await receive(rcv(job.id, [{ net: "2.002", purityId: g24 }], { complete: true, cgReturn: "1.001" }));
    expect(await goldAt(cust, "SAFE")).toBe("1.000");
    const back = await move({ kind: "RETURN_TO_CUSTOMER", customerId: cust, all: true });
    await expect(reverse(r.receipt.id)).rejects.toThrow(new RegExp(`used after .* by ${back.entry.entryCode}`));
    // Nothing was written by the refused attempt.
    expect(await prisma.customerGoldEntry.count({ where: { reversalOfEntryId: { not: null }, jewelleryReceiptId: r.receipt.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Concurrency and full rollback
// ---------------------------------------------------------------------------
describe("concurrent reversals and a failure after every write roll back completely", () => {
  it("two Owners reversing the same receipt at once: exactly one wins, no double mirror", async () => {
    const cust = await customer("CGR Customer Five");
    await intake(cust, "4");
    await move({ kind: "ISSUE_TO_KARIGAR", customerId: cust, karigarId: karigar, fineWeight: "4" });
    const job = await makeJob(cust, "Bangle");
    const r = await receive(rcv(job.id, [{ net: "1.000", purityId: g24 }], { making: "200" }));
    const results = await Promise.allSettled([reverse(r.receipt.id), reverse(r.receipt.id)]);
    expect(results.filter((x) => x.status === "fulfilled").length).toBe(1);
    const rejected = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason?.message ?? rejected.reason)).toMatch(/already reversed|could not serialize|deadlock|already been cancelled/);
    const originals = await prisma.customerGoldEntry.count({ where: { jewelleryReceiptId: r.receipt.id, reversalOfEntryId: null } });
    const mirrors = await prisma.customerGoldEntry.count({ where: { jewelleryReceiptId: r.receipt.id, reversalOfEntryId: { not: null } } });
    expect(mirrors).toBe(originals + 1); // + the receipt-time allocation entry
    expect(await goldAt(cust, "KARIGAR", karigar)).toBe("4.000");
    await expectEverythingBalanced();
  });

  it("a failure after the reversal wrote everything leaves nothing behind", async () => {
    const cust = await customer("CGR Customer Six");
    await intake(cust, "4");
    await move({ kind: "ISSUE_TO_KARIGAR", customerId: cust, karigarId: karigar, fineWeight: "4" });
    const job = await makeJob(cust, "Ring six");
    const diamond = await companyDiamond();
    await issueStones(job.id, [diamond.id], []);
    const r = await receive(rcv(job.id, [{ net: "1.500", purityId: g24, diamondIds: [diamond.id] }], { making: "500" }));
    const countsBefore = await worldCounts();
    const stateBefore = await jobState(job.id);
    await expect(
      prisma.$transaction(async (tx) => {
        await reverseCustomerGoldJobReceipt(tx, { receiptId: r.receipt.id, reason: "Injected failure after writing", idempotencyKey: key("inj"), actor: owner(), ...FY });
        throw new Error("injected failure");
      }, TX)
    ).rejects.toThrow("injected failure");
    expect(await worldCounts()).toEqual(countsBefore);
    expect(await jobState(job.id)).toEqual(stateBefore);
    const receipt = await prisma.jewelleryReceipt.findUniqueOrThrow({ where: { id: r.receipt.id }, include: { outputs: true } });
    expect([receipt.reversedAt, receipt.outputs[0].status]).toEqual([null, "CUSTOMER_AWAITING_DELIVERY"]);
    expect((await prisma.polishedDiamond.findUniqueOrThrow({ where: { id: diamond.id } })).status).toBe("SET_IN_JEWELLERY");
    await expectEverythingBalanced();
  });
});

// ---------------------------------------------------------------------------
// 5. Mixed Customer + Company gold: the supported workflow
// ---------------------------------------------------------------------------
describe("mixed Customer + Company gold: Company gold allocated first, Owner decides the share, both reconcile", () => {
  let cust: string;
  let jobId: string;
  let companyCost: string;
  let mixedReceiptId: string;

  it("setup: Owner approval, 2.000 g Company gold allocated from Karigar Metal, 3.000 g of the Customer's gold with the Karigar", async () => {
    cust = await customer("CGR Mixed Customer");
    await intake(cust, "3");
    await move({ kind: "ISSUE_TO_KARIGAR", customerId: cust, karigarId: karigar, fineWeight: "3" });
    jobId = (await makeJob(cust, "Mixed bangle")).id;
    await prisma.$transaction(
      (tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: karigar, purityId: g24, fineWeight: "2", entryDate: DATE, reason: "Company gold for the mixed job", idempotencyKey: key("ci"), owner: owner(), ...FY }),
      TX
    );
    // Company gold onto a Customer's job needs the Owner's approval first.
    await expect(
      prisma.$transaction(
        (tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: karigar, purityId: g24, jobId, fineWeight: "2", entryDate: DATE, reason: "Company share", idempotencyKey: key("ca0"), owner: owner(), ...FY }),
        TX
      )
    ).resolves.toBeTruthy(); // no Customer gold on the job yet: an ordinary Company allocation
    await prisma.$transaction((tx) => approveCustomerGoldMix(tx, { jobId, reason: "Customer asked us to add 2 g of our gold", actor: owner() }), TX);
    const job = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: jobId } });
    companyCost = new Decimal(job.remainingWipCost).toFixed(2);
    expect(new Decimal(job.issuedMetalFineWeight ?? 0).toFixed(3)).toBeDefined();
  });

  it("Staff can neither preview-save nor post a mixed receipt; the Owner must enter the share", async () => {
    await expect(receive(rcv(jobId, [{ net: "4.004", purityId: g24 }], { as: "STAFF", share: "2.000" }))).rejects.toThrow(/Only the Owner can record a mixed receipt/);
    await expect(receive(rcv(jobId, [{ net: "4.004", purityId: g24 }]))).rejects.toThrow(/enter how much of the finished pieces' fine gold is the Customer's/);
  });

  it("Owner preview shows both sources separately; the Company gold's exact cost is carried once, the Customer's at ₹0", async () => {
    const input = rcv(jobId, [{ net: "4.004", purityId: g24 }], { share: "2.000", complete: true });
    const plan = await prisma.$transaction((tx) => planCustomerGoldJobReceipt(tx, input), TX);
    expect([plan.mixed, plan.outputFine.toFixed(3), plan.customerFineForOutputs.toFixed(3), plan.companyFineForOutputs.toFixed(3)]).toEqual([true, "4.000", "2.000", "2.000"]);
    expect([plan.fromKarigar.fine.toFixed(3), plan.karigarAfter.fine.toFixed(3)]).toEqual(["2.000", "1.000"]);
    expect([plan.company.pendingBefore.toFixed(3), plan.company.finishedFine.toFixed(3), plan.company.processLossFine.toFixed(3), plan.company.pendingAfter.toFixed(3)]).toEqual(["2.000", "2.000", "0.000", "0.000"]);
    expect(plan.company.costMoved.toFixed(2)).toBe(companyCost);

    const before1320 = await ledger("1320");
    const before1340 = await ledger("1340");
    const r = await receive(input);
    mixedReceiptId = r.receipt.id;
    const piece = r.outputs![0];
    expect([piece.ownership, piece.customerGoldFineWeight.toFixed(3), piece.fineMetalWeight.toFixed(3), piece.metalCost.toFixed(2)]).toEqual(["CUSTOMER", "2.000", "4.000", companyCost]);
    // WIP gives up exactly the Company gold's cost; 1340 carries it once; the Customer's gold adds nothing.
    expect(new Decimal(before1320).minus(await ledger("1320")).toFixed(2)).toBe(companyCost);
    expect(new Decimal(await ledger("1340")).minus(before1340).toFixed(2)).toBe(companyCost);
    const consumed = await prisma.metalStockMovement.findMany({ where: { sourceDocument: r.receipt.receiptCode, type: "CONSUMED_OUT" } });
    expect(consumed.reduce((s, m) => s.plus(m.fineWeight), new Decimal(0)).toFixed(3)).toBe("2.000");
    const cgUsed = await prisma.customerGoldEntry.findMany({ where: { jewelleryReceiptId: r.receipt.id, kind: "CONSUME_TO_FINISHED" } });
    expect(cgUsed.reduce((s, e) => s.plus(e.fineWeight), new Decimal(0)).toFixed(3)).toBe("2.000");
    // Combined: 2.000 Customer + 2.000 Company = 4.000 g fine in the piece; both sides closed.
    expect(await goldAt(cust, "JOB", jobId)).toBe("0.000");
    const job = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: jobId } });
    expect([job.status, job.remainingWipCost.toFixed(2)]).toEqual(["COMPLETED", "0.00"]);
    await expectEverythingBalanced();
  });

  it("the mixed receipt (Company gold consumed only) reverses cleanly: both sides go back exactly", async () => {
    const before1340 = await ledger("1340");
    await reverse(mixedReceiptId);
    expect(await goldAt(cust, "KARIGAR", karigar)).toBe("3.000");
    const job = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: jobId } });
    expect([job.status, job.remainingWipCost.toFixed(2), job.receivedFineWeight.toFixed(3)]).toEqual(["MATERIALS_ISSUED", companyCost, "0.000"]);
    expect(new Decimal(before1340).minus(await ledger("1340")).toFixed(2)).toBe(companyCost);
    await expectEverythingBalanced();
  });

  it("a mixed receipt that returned Company gold to stock cannot be reversed, and says why", async () => {
    // 1.001 g gross Company gold returned to stock, 1.000 g Company + 1.000 g Customer in the piece.
    const r = await receive(
      rcv(jobId, [{ net: "2.002", purityId: g24 }], { share: "1.000", complete: true, returnedMetalLines: [{ purityId: g24, grossWeight: "1.001" }] })
    );
    const plan = await planReversal(r.receipt.id);
    expect(plan.blockers.join(" ")).toMatch(/returned 1\.001 g CGR 24K Company metal to stock/);
    await expect(reverse(r.receipt.id)).rejects.toThrow(/not reversible; correct the Company side through Corrections/);
    await expectEverythingBalanced();
  });
});
