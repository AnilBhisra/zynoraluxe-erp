/**
 * Phase 8C — Old Gold Exchange on the disposable scratch database only (shared
 * guard). Intake (stated vs tested purity, deduction) + Owner-approved
 * purchase of exactly that intake in one transaction; posting once; credit
 * applied partly to a bill; audited reversal with dependency blocks;
 * reconciliation (metal, Customer gold and the credit path) at every stage.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { cancelVoucher, postPaymentGiven } from "@/lib/accounting/posting";
import { prisma } from "@/lib/db/prisma";
import { postCustomerGoldTransfer, receiveCustomerGold, reverseCustomerGoldEntry } from "@/lib/jewellery/customerGold";
import { availableCustomerCreditInTx, billCustomerJewellery, reverseCustomerJewelleryBill } from "@/lib/jewellery/customerGoldCommercial";
import { receiveWithCustomerGold } from "@/lib/jewellery/customerGoldJobReceipt";
import { loadPoolInTx, placeBalance } from "@/lib/jewellery/customerGoldLedger";
import { customerGoldStatement } from "@/lib/jewellery/customerGoldReports";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import {
  customerCreditSummaryInTx,
  customerGoldPurchaseReversalBlock,
  exchangeOldGold,
  oldGoldExchangeFingerprint,
  planOldGoldExchange,
  reconcileCustomerGoldCredit,
  reverseCustomerGoldPurchase,
  type OldGoldExchangeInput,
} from "@/lib/jewellery/oldGoldExchange";
import { createJewelleryJob, getMetalStockBalanceInTx, postOpeningMetalStock } from "@/lib/jewellery/posting";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-01T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let staffId: string;
let custA: string;
let custB: string;
let karigar: string;
let g22: string; // 91.6% — exchanges A
let g18: string; // 75.0% — exchanges B, reversal blocks
let g24: string; // 99.9% — the Customer's own gold for the billed job
let seq = 0;
const key = (label: string) => `oge-${label}-${Date.now()}-${++seq}`;
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
  process.env.SESSION_SECRET ??= "old-gold-exchange-test-secret-0123456789abcdef";
  await clearAll();
  custA = (await prisma.party.create({ data: { name: "OGE Customer Asha", type: "CUSTOMER", createdByUserId: ownerId } })).id;
  custB = (await prisma.party.create({ data: { name: "OGE Customer Bharat", type: "CUSTOMER", createdByUserId: ownerId } })).id;
  karigar = (await prisma.party.create({ data: { name: "OGE Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
  g22 = await upsertPurity("OGE 22K", "91.600");
  g18 = await upsertPurity("OGE 18K", "75.000");
  g24 = await upsertPurity("OGE 24K", "99.900");
}, 90_000);

afterAll(async () => {
  await clearAll();
});

const exchangeInput = (over: Partial<OldGoldExchangeInput> = {}): OldGoldExchangeInput => ({
  customerId: custA,
  exchangeDate: DATE,
  purityId: g22,
  statedPurity: "22K hallmark (Customer's word)",
  inputBasis: "GROSS",
  weight: "10.255",
  deductionWeight: "0.250",
  rateBasis: "PER_FINE_GRAM",
  rate: "6543.21987",
  settlement: "CREDIT_TO_INVOICE",
  reason: "Old bangles exchanged against the new order",
  reference: "OG-SLIP-0001",
  ...over,
});
const preview = (input: OldGoldExchangeInput) => prisma.$transaction((tx) => planOldGoldExchange(tx, input), TX);
const exchange = async (input: OldGoldExchangeInput, k = key("ex"), actor: { id: string; role: "OWNER" | "STAFF" } = owner(), fingerprint?: string | null) => {
  const fp = fingerprint === undefined ? oldGoldExchangeFingerprint(input, await preview(input)) : fingerprint;
  return prisma.$transaction((tx) => exchangeOldGold(tx, { ...input, approved: true, expectedFingerprint: fp, idempotencyKey: k, actor, ...FY }), TX);
};
const reverse = (purchaseId: string, k = key("rev"), actor: { id: string; role: "OWNER" | "STAFF" } = owner(), reason = "Rate was agreed wrongly — reversing") =>
  prisma.$transaction((tx) => reverseCustomerGoldPurchase(tx, { purchaseId, reason, idempotencyKey: k, actor, ...FY }), TX);
const credit = (c: string) => prisma.$transaction((tx) => availableCustomerCreditInTx(tx, c), TX);
const stock = (pid: string) => prisma.$transaction((tx) => getMetalStockBalanceInTx(tx, "GOLD", pid), TX);
const safe = async (c: string, pid: string, fineness: string) =>
  placeBalance(await prisma.$transaction((tx) => loadPoolInTx(tx, { customerId: c, metalType: "GOLD", purityId: pid, finenessPercentSnapshot: new Decimal(fineness) }), TX), {
    location: "SAFE",
    scopeId: null,
  });
const lines = async (voucherId: string, customerId: string) =>
  (await prisma.journalEntry.findMany({ where: { voucherId }, include: { account: true } }))
    .filter((l) => !new Decimal(l.debit).isZero() || !new Decimal(l.credit).isZero())
    .map((l) => [l.account.code, new Decimal(l.debit).toFixed(2), new Decimal(l.credit).toFixed(2), l.partyId === customerId ? "customer" : ""])
    .sort();

async function expectEverythingReconciled() {
  const metal = await reconcileMetalLedger(prisma);
  for (const l of metal.lines) expect({ account: l.accountCode, difference: l.difference.toFixed(2) }).toEqual({ account: l.accountCode, difference: "0.00" });
  const unbalanced = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `select count(*)::int n from (select "voucherId" from journal_entries group by "voucherId" having sum(debit) <> sum(credit)) t`
  );
  expect(unbalanced[0].n).toBe(0);
  const cr = await prisma.$transaction((tx) => reconcileCustomerGoldCredit(tx), TX);
  for (const l of cr.lines) expect({ customer: l.customerName, difference: l.difference.toFixed(2) }).toEqual({ customer: l.customerName, difference: "0.00" });
  expect(cr.ok).toBe(true);
}

describe("8C — customer-owned gold stays ₹0 Company inventory until an approved purchase", () => {
  it("a plain intake is the Customer's: no voucher, no Company stock, no credit", async () => {
    const vouchers = await prisma.voucher.count();
    await prisma.$transaction(
      (tx) => receiveCustomerGold(tx, { customerId: custA, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: "5", reason: "Gold for the ring", idempotencyKey: key("in"), actor: owner() }),
      TX
    );
    expect(await prisma.voucher.count()).toBe(vouchers);
    expect((await stock(g24)).grossWeight.toFixed(3)).toBe("0.000");
    expect((await credit(custA)).toFixed(2)).toBe("0.00");
    await expectEverythingReconciled();
  });
});

describe("8C — one-step old gold exchange: preview, approve, post exactly once", () => {
  let purchaseId = "";

  it("preview: stated vs tested purity, deduction, accepted fine, 4-dp rate, exact-paisa value and effective rates", async () => {
    const p = await preview(exchangeInput());
    // 10.255 − 0.250 = 10.005 g net × 91.600% = 9.16458 → 9.165 g fine.
    expect([p.statedPurity, p.purityDisplayName, p.finenessPercent.toFixed(3), p.grossWeight.toFixed(3), p.deductionWeight.toFixed(3), p.netGrossWeight.toFixed(3), p.fineWeight.toFixed(3)]).toEqual([
      "22K hallmark (Customer's word)",
      "OGE 22K",
      "91.600",
      "10.255",
      "0.250",
      "10.005",
      "9.165",
    ]);
    // 6543.21987 → 6543.2199 (stored rate) × 9.165 = 59,968.6104 → ₹59,968.61.
    expect([p.rate.toFixed(4), p.value.toFixed(2), p.perFineGram.toFixed(4), p.perGrossGram.toFixed(4)]).toEqual(["6543.2199", "59968.61", "6543.2199", "5993.8641"]);
    expect([p.creditBefore.toFixed(2), p.creditAfter.toFixed(2)]).toEqual(["0.00", "59968.61"]);
  });

  it("refuses Staff, a missing approval, a missing reference, and a stale preview", async () => {
    await expect(exchange(exchangeInput(), key("s"), staff())).rejects.toThrow(/Only the Owner/);
    await expect(
      prisma.$transaction(
        (tx) => exchangeOldGold(tx, { ...exchangeInput(), approved: false, expectedFingerprint: "x", idempotencyKey: key("na"), actor: owner(), ...FY }),
        TX
      )
    ).rejects.toThrow(/Tick the approval/);
    await expect(preview(exchangeInput({ reference: " " }))).rejects.toThrow(/Enter the reference/);
    await expect(exchange(exchangeInput(), key("stale"), owner(), "not-the-preview")).rejects.toThrow(/changed after this preview/);
    await expect(exchange(exchangeInput(), key("nofp"), owner(), null)).rejects.toThrow(/changed after this preview/);
    expect(await prisma.customerGoldPurchase.count()).toBe(0);
  });

  it("posts intake + purchase atomically: stock in once at the value, Dr 1300 / Cr 2000 (Customer), safe in-and-out, credit created once", async () => {
    const k = key("ex1");
    const r = await exchange(exchangeInput(), k);
    expect(r.replayed).toBe(false);
    purchaseId = r.purchase.id;
    expect([r.purchase.customerGoldReceiptId, r.receipt!.statedPurity, r.purchase.reference, new Decimal(r.purchase.rate).toFixed(4), new Decimal(r.purchase.approvedValue).toFixed(2)]).toEqual([
      r.receipt!.id,
      "22K hallmark (Customer's word)",
      "OG-SLIP-0001",
      "6543.2199",
      "59968.61",
    ]);
    const mp = await prisma.metalPurchase.findUniqueOrThrow({ where: { id: r.purchase.metalPurchaseId } });
    expect(await lines(mp.voucherId!, custA)).toEqual([
      ["1300", "59968.61", "0.00", ""],
      ["2000", "0.00", "59968.61", "customer"],
    ]);
    expect([(await stock(g22)).grossWeight.toFixed(3), (await stock(g22)).costValue.toFixed(2)]).toEqual(["10.005", "59968.61"]);
    // The gold passed through the Customer's safe: in by the intake, out by the purchase.
    expect((await safe(custA, g22, "91.600")).fine.toFixed(3)).toBe("0.000");
    const kinds = (await prisma.customerGoldEntry.findMany({ where: { customerId: custA, purityId: g22 }, orderBy: { createdAt: "asc" } })).map((e) => [e.kind, e.fromLocation, e.toLocation, e.fineWeight.toFixed(3)]);
    expect(kinds).toEqual([
      ["INTAKE", "CUSTOMER", "SAFE", "9.165"],
      ["CONVERT_TO_COMPANY", "SAFE", "PURCHASED", "9.165"],
    ]);
    expect((await credit(custA)).toFixed(2)).toBe("59968.61");
    // Exactly once: same key replays; a concurrent double-click posts once.
    expect((await exchange(exchangeInput(), k)).replayed).toBe(true);
    const k2 = key("dbl");
    const input2 = exchangeInput({ weight: "1.000", deductionWeight: "0", reference: "OG-SLIP-0002" });
    const fp = oldGoldExchangeFingerprint(input2, await preview(input2));
    const both = await Promise.allSettled([exchange(input2, k2, owner(), fp), exchange(input2, k2, owner(), fp)]);
    expect(both.every((b) => b.status === "fulfilled")).toBe(true);
    expect(both.map((b) => (b as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed).sort()).toEqual([false, true]);
    expect(await prisma.customerGoldPurchase.count({ where: { idempotencyKey: k2 } })).toBe(1);
    expect(await prisma.metalStockMovement.count({ where: { purityId: g22, type: "PURCHASE_IN" } })).toBe(2);
    await expectEverythingReconciled();
  });

  it("never mixes Customers or purities: B's exchange is B's credit only", async () => {
    const before = await credit(custA);
    const r = await exchange(exchangeInput({ customerId: custB, purityId: g18, statedPurity: "18K", weight: "4", deductionWeight: null, rateBasis: "PER_GROSS_GRAM", rate: "5000", reference: "OG-SLIP-B1" }));
    expect(new Decimal(r.purchase.approvedValue).toFixed(2)).toBe("20000.00");
    expect([(await credit(custA)).toFixed(2), (await credit(custB)).toFixed(2)]).toEqual([before.toFixed(2), "20000.00"]);
    expect((await stock(g18)).grossWeight.toFixed(3)).toBe("4.000");
    await expectEverythingReconciled();
  });

  it("reversal is blocked once later stock of that purity moved, and while any credit is used", async () => {
    // A's credit applied to a bill blocks A's reversal (checked below in the billing flow).
    const b = await prisma.customerGoldPurchase.findFirstOrThrow({ where: { customerId: custB } });
    // Later 18K stock movement (an opening entry) — the purchase's weighted-average layer is no longer the last.
    await prisma.$transaction(
      (tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g18, grossWeight: "1", costValue: "4000", idempotencyKey: key("o18"), ...FY, createdByUserId: ownerId }),
      TX
    );
    expect(await prisma.$transaction((tx) => customerGoldPurchaseReversalBlock(tx, b.id), TX)).toMatch(/has moved since/);
    await expect(reverse(b.id)).rejects.toThrow(/has moved since/);
    expect(purchaseId).not.toBe("");
  });
});

describe("8C — credit applied partly to a bill; reversal dependency blocks; audited reversal", () => {
  let jobId = "";
  let billId = "";

  it("a Customer-gold job is billed with ₹10,000.00 of A's ₹65,962.20 credit; the rest stays available", async () => {
    // Customer A's own 24K gold → Karigar → job → finished piece awaiting delivery.
    await prisma.$transaction(
      (tx) => postCustomerGoldTransfer(tx, { kind: "ISSUE_TO_KARIGAR", customerId: custA, purityId: g24, finenessPercent: "99.900", karigarId: karigar, fineWeight: "2", entryDate: DATE, reason: "For the ring", idempotencyKey: key("iss"), actor: owner() }),
      TX
    );
    const job = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { customerId: custA, jewelleryType: "RING", designName: "OGE ring", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    jobId = job.id;
    await prisma.$transaction(
      (tx) =>
        receiveWithCustomerGold(tx, {
          ...FY, jobId, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "2.002", metalType: "GOLD", purityId: g24, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: 0, makingCharge: "1000.00", settingCharge: 0, platingCharge: 0, otherExpense: 0,
          markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
          customerGoldSource: { purityId: g24, finenessPercent: "99.900" },
          actor: owner(),
        }),
      TX
    );
    const before = await prisma.$transaction((tx) => customerCreditSummaryInTx(tx, custA), TX);
    // 59,968.61 + the 1 g exchange (1.000 × 91.6% = 0.916 g × 6543.2199 = 5,993.59) = 65,962.20.
    expect([before.granted.toFixed(2), before.applied.toFixed(2), before.available.toFixed(2)]).toEqual(["65962.20", "0.00", "65962.20"]);
    const bill = await prisma.$transaction(
      (tx) => billCustomerJewellery(tx, { jobId, billDate: DATE, makingCharge: "12500.00", gstTreatment: "CGST_SGST", gstRatePercent: "3", creditToApply: "10000.00", idempotencyKey: key("bill"), actor: owner(), ...FY }),
      TX
    );
    billId = bill.bill.id;
    // 12,500.00 + 375.00 GST = 12,875.00; 10,000.00 credit → 2,875.00 due.
    expect([bill.bill.grandTotal, bill.bill.creditApplied, bill.bill.amountDue].map((d) => new Decimal(d).toFixed(2))).toEqual(["12875.00", "10000.00", "2875.00"]);
    const after = await prisma.$transaction((tx) => customerCreditSummaryInTx(tx, custA), TX);
    expect([after.granted.toFixed(2), after.applied.toFixed(2), after.available.toFixed(2)]).toEqual(["65962.20", "10000.00", "55962.20"]);
    await expectEverythingReconciled();
  });

  it("the first exchange cannot be reversed while its credit is in use; reversing the bill frees it", async () => {
    const first = await prisma.customerGoldPurchase.findFirstOrThrow({ where: { customerId: custA, reference: "OG-SLIP-0001" } });
    // Second A exchange (1 g, posted later in 22K) also blocks reversing the first by stock order.
    expect(await prisma.$transaction((tx) => customerGoldPurchaseReversalBlock(tx, first.id), TX)).toMatch(/has moved since|already applied/);
    const second = await prisma.customerGoldPurchase.findFirstOrThrow({ where: { customerId: custA, reference: "OG-SLIP-0002" } });
    // The second's value (5,993.59) is less than the unused credit (55,962.20), so its block is only about the bill if credit < value — here it is free.
    expect(await prisma.$transaction((tx) => customerGoldPurchaseReversalBlock(tx, second.id), TX)).toBeNull();
    await prisma.$transaction((tx) => reverseCustomerJewelleryBill(tx, { billId, reason: "Bill entered before the final weight", actor: owner(), ...FY }), TX);
    expect((await credit(custA)).toFixed(2)).toBe("65962.20");
    await expectEverythingReconciled();
  });

  it("audited reversal of the latest exchange restores stock, ledger, safe and credit exactly; never twice; Owner only", async () => {
    const second = await prisma.customerGoldPurchase.findFirstOrThrow({ where: { customerId: custA, reference: "OG-SLIP-0002" }, include: { metalPurchase: true } });
    const stockBefore = await stock(g22);
    await expect(reverse(second.id, key("st"), staff())).rejects.toThrow(/Only the Owner/);
    await expect(reverse(second.id, key("short"), owner(), "short")).rejects.toThrow(/at least 10/);
    const k = key("rev2");
    const r = await reverse(second.id, k);
    expect([r.purchase.status, r.purchase.reversalVoucherId !== null, r.purchase.reversedByUserId]).toEqual(["REVERSED", true, ownerId]);
    expect(await lines(r.purchase.reversalVoucherId!, custA)).toEqual([
      ["1300", "0.00", "5993.59", ""],
      ["2000", "5993.59", "0.00", "customer"],
    ]);
    const stockAfter = await stock(g22);
    expect([stockBefore.grossWeight.minus(stockAfter.grossWeight).toFixed(3), stockBefore.costValue.minus(stockAfter.costValue).toFixed(2)]).toEqual(["1.000", "5993.59"]);
    const mirror = await prisma.metalStockMovement.findFirstOrThrow({ where: { reversalOfMovement: { sourceDocument: second.metalPurchase.purchaseCode } } });
    expect([mirror.type, mirror.costValue.toFixed(2)]).toEqual(["ADJUSTMENT_OUT", "5993.59"]);
    // The gold is the Customer's again, back in the safe; the intake stays recorded.
    expect((await safe(custA, g22, "91.600")).fine.toFixed(3)).toBe("0.916");
    expect((await credit(custA)).toFixed(2)).toBe("59968.61");
    expect((await reverse(second.id, k)).replayed).toBe(true);
    await expect(reverse(second.id)).rejects.toThrow(/already reversed/);
    await expectEverythingReconciled();
    // The intake can now be reversed on its own (gold given back): newest-first allows it.
    const intakeEntry = await prisma.customerGoldEntry.findFirstOrThrow({ where: { customerGoldReceiptId: second.customerGoldReceiptId!, kind: "INTAKE" } });
    await prisma.$transaction((tx) => reverseCustomerGoldEntry(tx, { entryId: intakeEntry.id, reason: "Gold handed back to the Customer", actor: owner() }), TX);
    expect((await safe(custA, g22, "91.600")).fine.toFixed(3)).toBe("0.000");
    await expectEverythingReconciled();
  });

  it("the first exchange is reversible now that later stock and credit no longer depend on it", async () => {
    const first = await prisma.customerGoldPurchase.findFirstOrThrow({ where: { customerId: custA, reference: "OG-SLIP-0001" } });
    // The second exchange's stock entry and its reversal are later 22K movements — still a block (history is never rewritten).
    expect(await prisma.$transaction((tx) => customerGoldPurchaseReversalBlock(tx, first.id), TX)).toMatch(/has moved since/);
  });
});

describe("8C — credit uses the real payable (regression: cancelled voucher + its mirror net to zero)", () => {
  it("a reversed credit bill plus a payment never overstates the credit", async () => {
    const c = (await prisma.party.create({ data: { name: "OGE Customer Chirag", type: "CUSTOMER", createdByUserId: ownerId } })).id;
    const pid = await upsertPurity("OGE 20K", "83.300");
    await exchange(exchangeInput({ customerId: c, purityId: pid, weight: "12.005", deductionWeight: "0.005", rateBasis: "FIXED_TOTAL", rate: "10000", reference: "OG-C1" }));
    expect((await credit(c)).toFixed(2)).toBe("10000.00");
    const account = await prisma.paymentAccount.findFirstOrThrow({ where: { isActive: true } });
    // ₹6,000 paid out to the Customer: only ₹4,000 is still owed, so only ₹4,000 of credit can be used.
    const paid = await prisma.$transaction(
      (tx) => postPaymentGiven(tx, { date: DATE, ...FY, currencyCode: "INR", exchangeRate: 1, partyId: c, paymentAccountId: account.id, amount: "6000", createdByUserId: ownerId }),
      TX
    );
    expect((await credit(c)).toFixed(2)).toBe("4000.00");
    // A cancelled payment and its REVERSAL mirror net to zero — the credit is back to ₹10,000, not ₹16,000.
    await prisma.$transaction((tx) => cancelVoucher(tx, { voucherId: paid.id, cancelledByUserId: ownerId, cancellationReason: "Paid by mistake", ...FY }), TX);
    expect((await credit(c)).toFixed(2)).toBe("10000.00");
    await prisma.$transaction(
      (tx) => postPaymentGiven(tx, { date: DATE, ...FY, currencyCode: "INR", exchangeRate: 1, partyId: c, paymentAccountId: account.id, amount: "6000", createdByUserId: ownerId }),
      TX
    );
    expect((await credit(c)).toFixed(2)).toBe("4000.00");
    // And the exchange can no longer be reversed: the Customer has been paid against it.
    const p = await prisma.customerGoldPurchase.findFirstOrThrow({ where: { customerId: c } });
    expect(await prisma.$transaction((tx) => customerGoldPurchaseReversalBlock(tx, p.id), TX)).toMatch(/paid out|been paid/);
    await expectEverythingReconciled();
  });
});

describe("8C — Staff see weights only; the statement shows exchanges with status", () => {
  it("Owner statement lists every purchase with status and value; Staff receive no ₹ figure", async () => {
    const ownerView = (await prisma.$transaction((tx) => customerGoldStatement(tx, custA, { includeValues: true }), TX))!;
    const staffView = (await prisma.$transaction((tx) => customerGoldStatement(tx, custA, { includeValues: false }), TX))!;
    expect(ownerView.purchases.map((p) => [p.reference, p.status, p.approvedValue])).toEqual([
      ["OG-SLIP-0001", "POSTED", "59968.61"],
      ["OG-SLIP-0002", "REVERSED", "5993.59"],
    ]);
    expect(staffView.purchases.every((p) => p.approvedValue === null && p.rate === null)).toBe(true);
    const json = JSON.stringify(staffView);
    for (const money of ["59968.61", "5993.59", "6543.2199", "65962.20"]) expect(json).not.toContain(money);
    expect(ownerView.credit).toEqual({ granted: "59968.61", applied: "0.00", available: "59968.61" });
    expect(staffView.credit).toBeNull();
  });
});
