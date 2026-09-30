/**
 * Customer Gold — purchase/exchange, billing, delivery and their reversals, on
 * the disposable scratch database only (shared guard). CUSTOMER_GOLD_DESIGN.md §2.5, §3.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { createRoughLotWithPieces, issueRoughToKarigar, receivePolishedDiamonds } from "@/lib/diamond/posting";
import { postCustomerGoldTransfer, receiveCustomerGold } from "@/lib/jewellery/customerGold";
import {
  availableCustomerCreditInTx,
  billCustomerJewellery,
  customerGoldPurchaseFingerprint,
  deliverCustomerJewellery,
  planCustomerGoldPurchase,
  purchaseCustomerGold,
  reverseCustomerJewelleryBill,
  reverseCustomerJewelleryDelivery,
  type CustomerGoldPurchaseInput,
} from "@/lib/jewellery/customerGoldCommercial";
import { receiveWithCustomerGold } from "@/lib/jewellery/customerGoldJobReceipt";
import { loadPoolInTx, placeBalance } from "@/lib/jewellery/customerGoldLedger";
import { postFinishedJewellerySale } from "@/lib/jewellery/finishedSalesPosting";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { createJewelleryJob, getMetalStockBalanceInTx, issueMaterialsToJewelleryJob, postOpeningMetalStock } from "@/lib/jewellery/posting";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-30T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let staffId: string;
let cust: string;
let karigar: string;
let g24: string;
let seq = 0;
const key = (label: string) => `cgc-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const staff = () => ({ id: staffId, role: "STAFF" as const });

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  staffId = (await prisma.user.findFirstOrThrow({ where: { role: "STAFF" } })).id;
  process.env.SESSION_SECRET ??= "customer-gold-test-secret-0123456789abcdef";
  await clearAll();
  cust = (await prisma.party.create({ data: { name: "CGC Customer", type: "CUSTOMER", createdByUserId: ownerId } })).id;
  karigar = (await prisma.party.create({ data: { name: "CGC Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
  g24 = (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType: "GOLD", displayName: "CGC 24K" } },
      create: { metalType: "GOLD", displayName: "CGC 24K", finenessPercent: "99.900", createdByUserId: ownerId },
      update: { finenessPercent: "99.900", isActive: true },
    })
  ).id;
  await prisma.$transaction(
    (tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g24, grossWeight: "10.000", costValue: "70000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }),
    TX
  );
}, 90_000);

afterAll(async () => {
  await clearAll();
});

const pool = () => prisma.$transaction((tx) => loadPoolInTx(tx, { customerId: cust, metalType: "GOLD", purityId: g24, finenessPercentSnapshot: new Decimal("99.900") }), TX);
const at = async (location: "SAFE" | "FINISHED" | "DELIVERED" | "PURCHASED" | "KARIGAR", scopeId: string | null = null) => placeBalance(await pool(), { location, scopeId }).fine.toFixed(3);
const ledger = async (code: string) => {
  const r = await reconcileMetalLedger(prisma);
  const l = r.lines.find((x) => x.accountCode === code)!;
  return { ledger: l.ledger.toFixed(2), difference: l.difference.toFixed(2) };
};
async function expectEverythingBalanced() {
  const r = await reconcileMetalLedger(prisma);
  for (const l of r.lines) expect({ account: l.accountCode, difference: l.difference.toFixed(2) }).toEqual({ account: l.accountCode, difference: "0.00" });
  const vouchers = await prisma.voucher.findMany({ include: { journalEntries: true } });
  for (const v of vouchers) {
    const dr = v.journalEntries.reduce((s, j) => s.plus(j.debit), new Decimal(0));
    const cr = v.journalEntries.reduce((s, j) => s.plus(j.credit), new Decimal(0));
    expect({ voucher: v.voucherNumber, dr: dr.toFixed(2) }).toEqual({ voucher: v.voucherNumber, dr: cr.toFixed(2) });
  }
  // Customer custody: received = every place.
  const p = await pool();
  if (p) {
    const received = placeBalance(p, { location: "CUSTOMER", scopeId: null }).fine.negated();
    const sum = [...p.places.values()].filter((x) => x.location !== "CUSTOMER").reduce((s, x) => s.plus(x.fine), new Decimal(0));
    expect(sum.toFixed(3)).toBe(received.toFixed(3));
  }
}
const lines = async (voucherId: string) =>
  (await prisma.journalEntry.findMany({ where: { voucherId }, include: { account: true } }))
    .map((l) => [l.account.code, new Decimal(l.debit).toFixed(2), new Decimal(l.credit).toFixed(2), l.partyId === cust ? "customer" : ""])
    .sort();

const purchaseInput = (over: Partial<CustomerGoldPurchaseInput>): CustomerGoldPurchaseInput => ({
  customerId: cust,
  purchaseDate: DATE,
  purityId: g24,
  source: "DIRECT",
  grossWeight: "2.002",
  rateBasis: "PER_FINE_GRAM",
  rate: "7000",
  settlement: "CREDIT_TO_INVOICE",
  reason: "Customer exchanged old gold against the new order",
  approved: true,
  ...over,
});
const purchase = (input: CustomerGoldPurchaseInput, actor: { id: string; role: "OWNER" | "STAFF" } = owner(), k = key("buy")) =>
  prisma.$transaction((tx) => purchaseCustomerGold(tx, { ...input, idempotencyKey: k, actor, ...FY }), TX);

describe("Purchase / exchange of a Customer's gold — Owner-approved, posted once", () => {
  it("DIRECT: 2.002 g gross (2.000 g fine) at ₹7,000 per fine gram = ₹14,000.00 into Company stock; Customer credit ₹14,000.00", async () => {
    const stockBefore = await prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, "GOLD", g24), TX);
    const k = key("direct");
    const r = await purchase(purchaseInput({}), owner(), k);
    expect([r.purchase.purchaseCode, new Decimal(r.purchase.fineWeight).toFixed(3), new Decimal(r.purchase.approvedValue).toFixed(2), r.purchase.fromCustody]).toEqual([
      expect.stringMatching(/^ZL-CGP-\d{4}-\d{6}$/),
      "2.000",
      "14000.00",
      false,
    ]);
    const mp = await prisma.metalPurchase.findUniqueOrThrow({ where: { id: r.purchase.metalPurchaseId } });
    expect(await lines(mp.voucherId!)).toEqual([
      ["1300", "14000.00", "0.00", ""],
      ["2000", "0.00", "14000.00", "customer"],
      ["6001", "0.00", "0.00", ""],
      ["6002", "0.00", "0.00", ""],
      ["6003", "0.00", "0.00", ""],
    ].filter((l) => l[1] !== "0.00" || l[2] !== "0.00").sort());
    const stockAfter = await prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, "GOLD", g24), TX);
    expect([stockAfter.grossWeight.minus(stockBefore.grossWeight).toFixed(3), stockAfter.costValue.minus(stockBefore.costValue).toFixed(2)]).toEqual(["2.002", "14000.00"]);
    // Exactly once: the same key replays, a second PURCHASE_IN never appears.
    expect((await purchase(purchaseInput({}), owner(), k)).replayed).toBe(true);
    expect(await prisma.metalStockMovement.count({ where: { sourceDocument: mp.purchaseCode } })).toBe(1);
    expect((await prisma.$transaction((tx) => availableCustomerCreditInTx(tx, cust), TX)).toFixed(2)).toBe("14000.00");
    await expectEverythingBalanced();
  });

  it("CUSTODY: buying part of the Customer's safe balance moves it SAFE → PURCHASED; never silently, never at another fineness", async () => {
    await prisma.$transaction(
      (tx) => receiveCustomerGold(tx, { customerId: cust, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: "5", reason: "Gold for the order", idempotencyKey: key("in"), actor: owner() }),
      TX
    );
    const input = purchaseInput({ source: "CUSTODY", grossWeight: null, fineWeight: "1", finenessPercent: "99.900", rate: "7100", settlement: "PAY_CUSTOMER" });
    await expect(purchase({ ...input, approved: false })).rejects.toThrow(/Tick the approval/);
    await expect(purchase(input, staff())).rejects.toThrow(/Only the Owner/);
    const fp = customerGoldPurchaseFingerprint(input, await prisma.$transaction((tx) => planCustomerGoldPurchase(tx, input), TX));
    const r = await prisma.$transaction((tx) => purchaseCustomerGold(tx, { ...input, expectedFingerprint: fp, idempotencyKey: key("cust"), actor: owner(), ...FY }), TX);
    expect([new Decimal(r.purchase.approvedValue).toFixed(2), r.purchase.fromCustody]).toEqual(["7100.00", true]);
    expect([await at("SAFE"), await at("PURCHASED")]).toEqual(["4.000", "1.000"]);
    // A changed purity master fineness is refused, never re-tested silently.
    await prisma.metalPurity.update({ where: { id: g24 }, data: { finenessPercent: "99.500" } });
    await expect(purchase(purchaseInput({ source: "CUSTODY", grossWeight: null, fineWeight: "1", finenessPercent: "99.900" }))).rejects.toThrow(/held at 99\.900% but Company CGC 24K stock is 99\.500%/);
    await prisma.metalPurity.update({ where: { id: g24 }, data: { finenessPercent: "99.900" } });
    // PAY_CUSTOMER does not add bill credit.
    expect((await prisma.$transaction((tx) => availableCustomerCreditInTx(tx, cust), TX)).toFixed(2)).toBe("14000.00");
    await expectEverythingBalanced();
  });
});

describe("Company stones and charges: costed at receipt, billed once, moved to COGS on delivery", () => {
  let jobId: string;
  let pieceId: string;
  let diamondCost: string;

  it("a Customer-gold ring with a Company diamond and ₹1,000 making: piece cost = diamond + making, all in 1340; gold ₹0", async () => {
    // A Company polished diamond.
    const supplier = await prisma.party.create({ data: { name: "CGC Supplier", type: "SUPPLIER", createdByUserId: ownerId } });
    const manufacturer = await prisma.party.create({ data: { name: "CGC Manufacturer", type: "MANUFACTURER", createdByUserId: ownerId } });
    const lot = await prisma.$transaction(
      (tx) =>
        createRoughLotWithPieces(tx, { ...FY, purchaseDate: DATE, supplierId: supplier.id, purchaseRate: 800, rateBasis: "PER_CARAT", currencyCode: "INR", exchangeRate: 1, totalPurchaseCost: "8000.00", gstTreatment: "NONE", idempotencyKey: key("rough"), createdByUserId: ownerId, pieces: [{ carat: "2.000" }] }),
      TX
    );
    const rough = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
    const dj = await prisma.$transaction(
      (tx) => issueRoughToKarigar(tx, { ...FY, karigarId: manufacturer.id, roughPieceIds: [rough.id], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key("ri"), createdByUserId: ownerId }),
      TX
    );
    await prisma.$transaction(
      (tx) => receivePolishedDiamonds(tx, { ...FY, jobId: dj.id, receiveDate: DATE, returnedRoughCarat: 0, labourCharge: 500, shape: "ROUND", markJobComplete: true, idempotencyKey: key("pd"), createdByUserId: ownerId, outputs: [{ shape: "ROUND", carat: "1.500" }] }),
      TX
    );
    const diamond = await prisma.polishedDiamond.findFirstOrThrow({ where: { jobId: dj.id } });

    const job = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { customerId: cust, jewelleryType: "RING", designName: "Customer diamond ring", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    jobId = job.id;
    await prisma.$transaction(
      (tx) => issueMaterialsToJewelleryJob(tx, { ...FY, jobId, issueDate: DATE, metalLines: [], polishedDiamondIds: [diamond.id], otherMaterialLines: [], idempotencyKey: key("im"), createdByUserId: ownerId }),
      TX
    );
    // What the job carries for the stone: its cost at issue.
    diamondCost = new Decimal((await prisma.jewelleryDiamondIssueLine.findFirstOrThrow({ where: { jobId } })).costAtIssue).toFixed(2);
    await prisma.$transaction(
      (tx) => postCustomerGoldTransfer(tx, { kind: "ISSUE_TO_KARIGAR", customerId: cust, purityId: g24, finenessPercent: "99.900", karigarId: karigar, fineWeight: "2", entryDate: DATE, reason: "For the ring", idempotencyKey: key("iss"), actor: owner() }),
      TX
    );
    // Delivery is refused while the job is not reconciled (nothing received yet).
    await expect(prisma.$transaction((tx) => deliverCustomerJewellery(tx, { jobId, deliveryDate: DATE, receivedByName: "Customer", idempotencyKey: key("d0"), actor: owner(), ...FY }), TX)).rejects.toThrow(
      /Nothing is awaiting delivery|not completed/
    );
    const before1340 = await ledger("1340");
    const r = await prisma.$transaction(
      (tx) =>
        receiveWithCustomerGold(tx, {
          ...FY, jobId, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "2.002", metalType: "GOLD", purityId: g24, diamondIds: [diamond.id], qcStatus: "PASSED" }],
          diamondResolutions: [{ polishedDiamondId: diamond.id, resolution: "SET" }],
          returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: "1000.00", settingCharge: 0, platingCharge: 0, otherExpense: 0,
          markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
          customerGoldSource: { purityId: g24, finenessPercent: "99.900" },
          actor: owner(),
        }),
      TX
    );
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r.receipt.id } });
    pieceId = piece.id;
    expect([piece.metalCost.toFixed(2), piece.diamondCost.toFixed(2), piece.labourAllocated.toFixed(2), piece.customerGoldFineWeight.toFixed(3), piece.status]).toEqual([
      "0.00",
      diamondCost,
      "1000.00",
      "2.000",
      "CUSTOMER_AWAITING_DELIVERY",
    ]);
    const expected1340 = new Decimal(before1340.ledger).plus(diamondCost).plus(1000).toFixed(2);
    expect(await ledger("1340")).toEqual({ ledger: expected1340, difference: "0.00" });
    expect(await lines(r.receipt.postingVoucherId!)).toEqual(
      [
        ["1320", "0.00", diamondCost, ""],
        ["1340", new Decimal(diamondCost).plus(1000).toFixed(2), "0.00", ""],
        ["2000", "0.00", "1000.00", ""],
      ].sort()
    );
    // It can never be sold as Company stock.
    await expect(
      prisma.$transaction(
        (tx) =>
          postFinishedJewellerySale(tx, {
            ...FY, customerId: cust, saleDate: DATE, gstTreatment: "NONE", idempotencyKey: key("sale"), createdByUserId: ownerId,
            items: [{ finishedJewelleryId: pieceId, sellingPrice: "50000", discount: "0", gstRatePercent: "0" }],
          } as never),
        TX
      )
    ).rejects.toThrow(/Customer-owned jewellery/);
    await expectEverythingBalanced();
  });

  it("bill: making + diamond + GST, ₹5,000 of the gold-purchase credit applied in the same voucher; the Customer's gold is not a line", async () => {
    await expect(
      prisma.$transaction((tx) => billCustomerJewellery(tx, { jobId, billDate: DATE, makingCharge: "1200", gstTreatment: "NONE", idempotencyKey: key("sb"), actor: staff(), ...FY }), TX)
    ).rejects.toThrow(/Only the Owner can bill/);
    await expect(
      prisma.$transaction((tx) => billCustomerJewellery(tx, { jobId, billDate: DATE, makingCharge: "1200", gstTreatment: "NONE", creditToApply: "20000", idempotencyKey: key("b0"), actor: owner(), ...FY }), TX)
    ).rejects.toThrow(/has only ₹14000\.00 of gold-purchase credit/);
    const b = await prisma.$transaction(
      (tx) =>
        billCustomerJewellery(tx, {
          jobId, billDate: DATE, makingCharge: "1200.00", diamondCharge: "9000.00", gstTreatment: "CGST_SGST", gstRatePercent: "3", creditToApply: "5000.00",
          idempotencyKey: key("bill"), actor: owner(), ...FY,
        }),
      TX
    );
    // 10,200.00 taxable + 306.00 GST = 10,506.00; 5,000.00 credit → 5,506.00 due.
    expect([b.bill.taxableValue, b.bill.taxAmount, b.bill.grandTotal, b.bill.creditApplied, b.bill.amountDue].map((d) => new Decimal(d).toFixed(2))).toEqual([
      "10200.00",
      "306.00",
      "10506.00",
      "5000.00",
      "5506.00",
    ]);
    expect(await lines(b.bill.voucherId)).toEqual(
      [
        ["1100", "10506.00", "0.00", "customer"],
        ["1100", "0.00", "5000.00", "customer"],
        ["2000", "5000.00", "0.00", "customer"],
        ["4000", "0.00", "10200.00", ""],
        ["7001", "0.00", "153.00", ""],
        ["7002", "0.00", "153.00", ""],
        ["7003", "0.00", "0.00", ""],
      ]
        .filter((l) => l[1] !== "0.00" || l[2] !== "0.00")
        .sort()
    );
    expect((await prisma.$transaction((tx) => availableCustomerCreditInTx(tx, cust), TX)).toFixed(2)).toBe("9000.00");
    await expectEverythingBalanced();
  });

  it("delivery (Staff may do it, recorded as Staff): FINISHED → DELIVERED, Dr 5200 / Cr 1340 at the Company's cost; then an audited reversal restores everything", async () => {
    const before1340 = await ledger("1340");
    const k = key("deliver");
    const d = await prisma.$transaction(
      (tx) => deliverCustomerJewellery(tx, { jobId, deliveryDate: DATE, receivedByName: "Mr. Customer", reference: "Collected in person", idempotencyKey: k, actor: staff(), ...FY }),
      TX
    );
    expect(d.delivery.deliveredByUserId).toBe(staffId);
    const cost = new Decimal(diamondCost).plus(1000).toFixed(2);
    expect(new Decimal(d.delivery.companyCostTotal).toFixed(2)).toBe(cost);
    expect(await lines(d.delivery.cogsVoucherId!)).toEqual([
      ["1340", "0.00", cost, ""],
      ["5200", cost, "0.00", ""],
    ]);
    expect(await ledger("1340")).toEqual({ ledger: new Decimal(before1340.ledger).minus(cost).toFixed(2), difference: "0.00" });
    expect([await at("FINISHED", pieceId), await at("DELIVERED")]).toEqual(["0.000", "2.000"]);
    expect((await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: pieceId } })).status).toBe("DELIVERED_TO_CUSTOMER");
    expect((await prisma.$transaction((tx) => deliverCustomerJewellery(tx, { jobId, deliveryDate: DATE, receivedByName: "Mr. Customer", idempotencyKey: k, actor: staff(), ...FY }), TX)).replayed).toBe(true);
    await expectEverythingBalanced();

    await expect(
      prisma.$transaction((tx) => reverseCustomerJewelleryDelivery(tx, { deliveryId: d.delivery.id, reason: "Handed to the wrong person", actor: staff(), ...FY }), TX)
    ).rejects.toThrow(/Only the Owner/);
    await prisma.$transaction((tx) => reverseCustomerJewelleryDelivery(tx, { deliveryId: d.delivery.id, reason: "Recorded before the customer arrived", actor: owner(), ...FY }), TX);
    expect([await at("FINISHED", pieceId), await at("DELIVERED")]).toEqual(["2.000", "0.000"]);
    expect((await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: pieceId } })).status).toBe("CUSTOMER_AWAITING_DELIVERY");
    expect(await ledger("1340")).toEqual(before1340);
    await expect(
      prisma.$transaction((tx) => reverseCustomerJewelleryDelivery(tx, { deliveryId: d.delivery.id, reason: "Trying to reverse twice", actor: owner(), ...FY }), TX)
    ).rejects.toThrow(/already reversed/);
    // Deliver again for real.
    await prisma.$transaction((tx) => deliverCustomerJewellery(tx, { jobId, deliveryDate: DATE, receivedByName: "Mr. Customer", idempotencyKey: key("d2"), actor: owner(), ...FY }), TX);
    expect(await at("DELIVERED")).toBe("2.000");
    await expectEverythingBalanced();
  });

  it("bill reversal is an audited mirror and gives the credit back", async () => {
    const bill = await prisma.customerJewelleryBill.findFirstOrThrow({ where: { jobId, status: "POSTED" } });
    await prisma.$transaction((tx) => reverseCustomerJewelleryBill(tx, { billId: bill.id, reason: "Wrong making charge entered", actor: owner(), ...FY }), TX);
    const reversed = await prisma.customerJewelleryBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect([reversed.status, reversed.reversalVoucherId !== null]).toEqual(["REVERSED", true]);
    expect((await prisma.$transaction((tx) => availableCustomerCreditInTx(tx, cust), TX)).toFixed(2)).toBe("14000.00");
    await expectEverythingBalanced();
  });
});

describe("Reports — statement, reconciliation, exceptions; Staff get weights only", () => {
  it("statement: the Owner sees values, Staff none; every pool reconciles; a delivered-but-unbilled job is flagged", async () => {
    const { customerGoldStatement, customerGoldReconciliation, customerGoldExceptions, customerJewelleryAwaitingDelivery } = await import("@/lib/jewellery/customerGoldReports");
    const ownerView = (await prisma.$transaction((tx) => customerGoldStatement(tx, cust, { includeValues: true }), TX))!;
    const staffView = (await prisma.$transaction((tx) => customerGoldStatement(tx, cust, { includeValues: false }), TX))!;
    expect(ownerView.purchases.map((p) => p.approvedValue)).toEqual(["14000.00", "7100.00"]);
    expect(ownerView.bills?.length).toBe(1);
    expect(ownerView.pieces[0].companyCost).not.toBeNull();
    // Staff: the same weights, and not one money figure.
    expect(staffView.pools).toEqual(ownerView.pools);
    expect(staffView.bills).toBeNull();
    expect(staffView.purchases.every((p) => p.approvedValue === null)).toBe(true);
    expect(staffView.pieces.every((p) => p.companyCost === null)).toBe(true);
    expect(staffView.intakeReceipts.every((r) => r.declaredValue === null)).toBe(true);
    expect(staffView.entries.every((e) => !e.canReverse)).toBe(true);
    const staffJson = JSON.stringify(staffView);
    for (const money of ["14000", "7100", "10506", "5506", ownerView.pieces[0].companyCost!]) expect(staffJson).not.toContain(money);

    const pool = ownerView.pools[0];
    // 5.000 received; 1.000 bought by the Company; 2.000 with the Karigar → job → finished → delivered; 2.000 in the safe.
    expect([pool.received, pool.safe, pool.withKarigar, pool.onJobs, pool.finishedAwaitingDelivery, pool.delivered, pool.boughtByCompany, pool.remaining, pool.difference]).toEqual([
      "5.000",
      "2.000",
      "0.000",
      "0.000",
      "0.000",
      "2.000",
      "1.000",
      "2.000",
      "0.000",
    ]);
    const rec = await prisma.$transaction((tx) => customerGoldReconciliation(tx), TX);
    expect(rec.totals.difference).toBe("0.000");
    expect(await prisma.$transaction((tx) => customerJewelleryAwaitingDelivery(tx, { includeValues: false }), TX)).toEqual([]);
    // The bill was reversed above, so the delivered job is now unbilled.
    const exceptions = await prisma.$transaction((tx) => customerGoldExceptions(tx), TX);
    expect(exceptions.some((x) => x.kind === "UNBILLED")).toBe(true);
  });

  it("job page panel: the gold source and pieces for everyone; piece cost, bills, credit and delivery cost only for the Owner", async () => {
    const { getJobCustomerGoldPanel } = await import("@/lib/jewellery/customerGoldJobPanel");
    const job = await prisma.jewelleryJob.findFirstOrThrow({ where: { designName: "Customer diamond ring" } });
    const ownerView = (await prisma.$transaction((tx) => getJobCustomerGoldPanel(tx, job.id, { includeValues: true }), TX))!;
    const staffView = (await prisma.$transaction((tx) => getJobCustomerGoldPanel(tx, job.id, { includeValues: false }), TX))!;
    expect(ownerView.panel.sources.label).toBe("Customer-owned gold");
    expect(ownerView.panel.sources.customerGoldConsumedFine).toBe("2.000");
    expect(ownerView.panel.pieces[0].companyCost).not.toBeNull();
    expect(ownerView.panel.bills?.length).toBe(1);
    expect(ownerView.panel.creditAvailable).toBe("14000.00");
    // A delivered, completed job offers no receipt source and no delivery.
    expect(ownerView.receiveSources).toEqual([]);
    expect(staffView.panel.pieces.map((p) => [p.finishedCode, p.customerGoldFineWeight, p.companyCost])).toEqual(ownerView.panel.pieces.map((p) => [p.finishedCode, p.customerGoldFineWeight, null]));
    expect([staffView.panel.bills, staffView.panel.creditAvailable]).toEqual([null, null]);
    expect(staffView.panel.deliveries.every((d) => !d.canReverse)).toBe(true);
    const staffJson = JSON.stringify(staffView);
    for (const money of ["14000", "10506", "5506", ownerView.panel.pieces[0].companyCost!]) expect(staffJson).not.toContain(money);
  });
});
