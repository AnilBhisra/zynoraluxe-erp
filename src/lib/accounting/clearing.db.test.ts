/**
 * Clearing settlement — real-database acceptance on the disposable scratch
 * database only (shared guard; this suite truncates business tables).
 * Every amount is checked against the raw ledger to the paisa.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "", role: "OWNER" as "OWNER" | "STAFF", name: "Owner", email: "owner@test" } }));
vi.mock("@/lib/auth/dal", () => ({
  requireUser: async () => auth.user,
  requireOwner: async () => {
    if (auth.user.role !== "OWNER") throw new Error("REDIRECT:/unauthorized");
    return auth.user;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { listCashBookRows } from "@/lib/accounting/cashBankBook";
import { parseCashBookFilters } from "@/lib/accounting/cashBankBookFilters";
import {
  allocateSettlement,
  ClearingError,
  getClearingBalance,
  grossUpBlock,
  planGrossUp,
  planGrossUpWorkflow,
  planReclassify,
  planReserveMove,
  planSettlement,
  postGrossUpWorkflow,
  postReclassify,
  postReserveMove,
  postSettlement,
  reclassifyBlock,
  reverseAllocation,
  reverseClearingDocument,
  type GrossUpWorkflowInput,
  type SettlementInput,
} from "@/lib/accounting/clearing";
import { clearingReconciliation, getClearingReport, getProviderBalances } from "@/lib/accounting/clearingReports";
import { Decimal } from "@/lib/accounting/money";
import { cancelVoucher, postSale, VOUCHER_TRANSACTION_OPTIONS } from "@/lib/accounting/posting";
import { getProfitAndLoss, getReceivablePayableSummary } from "@/lib/accounting/reports";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { prisma } from "@/lib/db/prisma";
import { postFinishedJewellerySale, returnFinishedJewelleryItems } from "@/lib/jewellery/finishedSalesPosting";
import { createJewelleryJob, issueMaterialsToJewelleryJob, postOpeningMetalStock, receiveFinishedJewellery } from "@/lib/jewellery/posting";
import { cancelVoucherAction } from "@/app/actions/vouchers";
import { clearingBalanceAction, postGrossUpAction, postSettlementAction, previewGrossUpAction, previewSettlementAction, reverseClearingAction, setClearingPartyAction } from "@/app/actions/clearing";
import { GET as clearingCsv } from "@/app/(app)/accounting/clearing-report/export/route";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const TX = VOUCHER_TRANSACTION_OPTIONS;
const DATE = new Date("2026-10-05T00:00:00.000Z");
const at = (d: string) => new Date(`${d}T00:00:00.000Z`);
let ownerId: string;
let bank: string;
let cash: string;
let g22: string;
let seq = 0;
const key = (l: string) => `clr-${l}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

// ---- probes -----------------------------------------------------------------
async function ledger(code: string, partyId?: string): Promise<string> {
  const [r] = await prisma.$queryRawUnsafe<{ n: string | null }[]>(
    `select sum(j.debit - j.credit)::numeric(14,2)::text n from journal_entries j join accounts a on a.id = j."accountId" where a.code = $1 ${partyId ? `and j."partyId" = '${partyId}'` : ""}`,
    code
  );
  return new Decimal(r?.n ?? 0).toFixed(2);
}
async function payAcct(id: string) {
  const [r] = await prisma.$queryRawUnsafe<{ n: string | null }[]>(`select sum(j.debit - j.credit)::numeric(14,2)::text n from journal_entries j join payment_accounts pa on pa."accountId" = j."accountId" where pa.id = $1`, id);
  return new Decimal(r?.n ?? 0).toFixed(2);
}
async function lines(voucherNumber: string) {
  const v = await prisma.voucher.findUniqueOrThrow({ where: { voucherNumber }, include: { journalEntries: { include: { account: true } } } });
  return v.journalEntries
    .map((j) => `${j.account.code} ${new Decimal(j.debit).greaterThan(0) ? "Dr" : "Cr"} ${new Decimal(j.debit).plus(j.credit).toFixed(2)}`)
    .sort();
}
const bal = async (partyId: string, cur = "INR") => {
  const b = await prisma.$transaction((tx) => getClearingBalance(tx, partyId, cur), TX);
  return { a: b.available.fc.toFixed(2), ai: b.available.inr.toFixed(2), r: b.reserve.fc.toFixed(2), ri: b.reserve.inr.toFixed(2) };
};
async function unbalanced() {
  const [r] = await prisma.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int n from (select v.id from vouchers v left join journal_entries j on j."voucherId" = v.id group by v.id having coalesce(sum(j.debit),0) <> coalesce(sum(j.credit),0) or count(j.id) = 0) t`);
  return r.n;
}

// ---- builders ----------------------------------------------------------------
async function provider(name: string) {
  return (await prisma.party.create({ data: { name: `${name} ${++seq}`, type: "CUSTOMER", clearingEnabled: true, createdByUserId: ownerId } })).id;
}
const common = (date = DATE) => ({ date, ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId });
const line = (rate: string) => [{ description: "Piece", quantity: 1, unit: "PCS" as const, rate, gstRatePercent: 0, taxType: "EXCLUSIVE" as const }];
const sale = (partyId: string, inr: string, opts: { cur?: string; fc?: string; date?: Date; paymentAccountId?: string | null } = {}) =>
  prisma.$transaction(
    (tx) =>
      postSale(tx, {
        ...common(opts.date),
        partyId,
        paymentAccountId: opts.paymentAccountId ?? null,
        gstTreatment: "NONE",
        lines: line(inr),
        clearing: opts.cur ? { currencyCode: opts.cur, foreignAmount: opts.fc } : null,
      }),
    TX
  );
type S = Omit<SettlementInput, "partyId" | "documentDate" | "currencyCode"> & { currencyCode?: string; documentDate?: Date };
const settleInput = (partyId: string, s: S): SettlementInput => ({ currencyCode: "INR", documentDate: DATE, paymentAccountId: bank, ...s, partyId });
const preview = (partyId: string, s: S) => prisma.$transaction((tx) => planSettlement(tx, settleInput(partyId, s)), TX);
async function settle(partyId: string, s: S, k = key("s"), actor = owner()) {
  const plan = await preview(partyId, s);
  return prisma.$transaction((tx) => postSettlement(tx, { ...settleInput(partyId, s), idempotencyKey: k, expectedFingerprint: plan.fingerprint, actor, ...FY }), TX);
}
const reverse = (documentId: string, reason = "Entered against the wrong payout statement", k = key("rev")) =>
  prisma.$transaction((tx) => reverseClearingDocument(tx, { documentId, reason, idempotencyKey: k, actor: owner(), ...FY }), TX);

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  auth.user = { id: ownerId, role: "OWNER", name: "Owner", email: "owner@test" };
  bank = (await prisma.paymentAccount.findFirstOrThrow({ where: { account: { code: "1002" } } })).id;
  cash = (await prisma.paymentAccount.findFirstOrThrow({ where: { account: { code: "1001" } } })).id;
  g22 = (await prisma.metalPurity.upsert({ where: { metalType_displayName: { metalType: "GOLD", displayName: "CLR 22K" } }, create: { metalType: "GOLD", displayName: "CLR 22K", finenessPercent: "91.600", createdByUserId: ownerId }, update: {} })).id;
  await prisma.$transaction((tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g22, grossWeight: "100.000", costValue: "600000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }), TX);
}, 120_000);

afterAll(async () => {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  await prisma.$disconnect();
});

// =============================================================================
describe("Example A and B — pooled, unallocated settlement", () => {
  let p = "";
  it("1 & 4. 25 sales on several dates total ₹500; an unallocated ₹150 payout leaves ₹350; no sale is marked paid", async () => {
    p = await provider("CLR Etsy");
    for (let i = 0; i < 25; i++) await sale(p, "20", { date: at(`2026-0${(i % 5) + 5}-1${i % 9}`) });
    expect(await bal(p)).toMatchObject({ a: "500.00", ai: "500.00" });
    expect(await ledger("1150", p)).toBe("500.00");
    expect(await ledger("1100", p)).toBe("0.00"); // never Accounts Receivable
    const plan = await preview(p, { receivedInr: "150", lines: [] });
    expect(plan.warnings[0]).toMatch(/Unallocated pooled settlement/);
    expect(plan.after.available.fc.toFixed(2)).toBe("350.00");
    const r = await settle(p, { receivedInr: "150", lines: [] });
    expect(await lines(r.voucherNumber!)).toEqual(["1002 Dr 150.00", "1150 Cr 150.00"]);
    expect(await bal(p)).toMatchObject({ a: "350.00", ai: "350.00" });
    expect(await prisma.clearingAllocation.count()).toBe(0);
  });

  it("3. multiple partial payouts against the same provider", async () => {
    await settle(p, { receivedInr: "100", paymentAccountId: cash, lines: [] });
    await settle(p, { receivedInr: "50", lines: [] });
    expect(await bal(p)).toMatchObject({ a: "200.00" });
  });

  it("2. ₹200 settled as ₹150 Bank + ₹50 fee leaves ₹300 (Dr Bank 150, Dr fee 50, Cr clearing 200)", async () => {
    const q = await provider("CLR Example B");
    for (let i = 0; i < 25; i++) await sale(q, "20");
    const r = await settle(q, { receivedInr: "150", grossFc: "200", lines: [{ lineType: "COMMISSION", amount: "50" }] });
    expect(await lines(r.voucherNumber!)).toEqual(["1002 Dr 150.00", "1150 Cr 200.00", "5600 Dr 50.00"]);
    expect(await bal(q)).toMatchObject({ a: "300.00" });
  });

  it("5. an allocation supplied later records which sale was paid, without posting money", async () => {
    const doc = await prisma.clearingDocument.findFirstOrThrow({ where: { partyId: p, kind: "SETTLEMENT" }, orderBy: { createdAt: "asc" } });
    const firstSale = await prisma.clearingEntry.findFirstOrThrow({ where: { partyId: p, kind: "SALE" }, orderBy: { createdAt: "asc" } });
    const vouchers = await prisma.voucher.count();
    const lineCount = await prisma.journalEntry.count();
    const a = await prisma.$transaction((tx) => allocateSettlement(tx, { documentId: doc.id, saleVoucherId: firstSale.voucherId, amountFc: "20", reason: "Etsy payout statement 14 Oct", idempotencyKey: key("al"), actor: owner() }), TX);
    expect(await prisma.voucher.count()).toBe(vouchers);
    expect(await prisma.journalEntry.count()).toBe(lineCount);
    await expect(
      prisma.$transaction((tx) => allocateSettlement(tx, { documentId: doc.id, saleVoucherId: firstSale.voucherId, amountFc: "1", reason: "again the same sale", idempotencyKey: key("al"), actor: owner() }), TX)
    ).rejects.toThrow(/not yet allocated/);
    await prisma.$transaction((tx) => reverseAllocation(tx, { allocationId: a.allocation.id, reason: "Wrong order number on the statement", actor: owner() }), TX);
    expect((await prisma.clearingAllocation.findUniqueOrThrow({ where: { id: a.allocation.id } })).status).toBe("REVERSED");
  });
});

describe("Currencies and FX", () => {
  it("6. two providers and two currencies never mix", async () => {
    const a = await provider("CLR Amazon");
    const b = await provider("CLR PayPal");
    await sale(a, "8300", { cur: "USD", fc: "100" });
    await sale(a, "1000");
    await sale(b, "2000");
    await settle(a, { receivedInr: "500", lines: [] });
    expect(await bal(a, "USD")).toMatchObject({ a: "100.00", ai: "8300.00" });
    expect(await bal(a, "INR")).toMatchObject({ a: "500.00" });
    expect(await bal(b, "INR")).toMatchObject({ a: "2000.00" });
    await expect(preview(a, { currencyCode: "USD", receivedInr: "8300", receivedFc: "101", lines: [] })).rejects.toThrow(/only USD 100.00/);
  });

  it("7. USD sale at ₹83 and payout at ₹84: FX gain posts once; the sale's INR is untouched", async () => {
    const p = await provider("CLR USD gain");
    for (let i = 0; i < 5; i++) await sale(p, "8300", { cur: "USD", fc: "100" });
    const salesBefore = await ledger("4000");
    const r = await settle(p, { currencyCode: "USD", receivedInr: "8400", receivedFc: "100", lines: [] });
    expect(await lines(r.voucherNumber!)).toEqual(["1002 Dr 8400.00", "1150 Cr 8300.00", "4300 Cr 100.00"]);
    expect(await bal(p, "USD")).toMatchObject({ a: "400.00", ai: "33200.00" });
    expect(await ledger("4000")).toBe(salesBefore);
  });

  it("8. USD payout at ₹82 with a $10 fee: FX loss on the payout and the fee valued at the payout rate", async () => {
    const p = await provider("CLR USD loss");
    await sale(p, "8300", { cur: "USD", fc: "100" });
    const r = await settle(p, { currencyCode: "USD", receivedInr: "7380", receivedFc: "90", lines: [{ lineType: "COMMISSION", amount: "10" }] });
    // relieved $100 at carrying ₹8,300; worth 7,380 + 820 = 8,200 at ₹82 → loss ₹100
    expect(await lines(r.voucherNumber!)).toEqual(["1002 Dr 7380.00", "1150 Cr 8300.00", "5600 Dr 820.00", "5650 Dr 100.00"]);
    expect(await bal(p, "USD")).toMatchObject({ a: "0.00", ai: "0.00" });
  });
});

describe("Reserve, deductions, taxes", () => {
  it("9. reserve hold and release move between 1150 and 1160 only (no Bank, no revenue)", async () => {
    const p = await provider("CLR Reserve");
    await sale(p, "1000");
    const bankBefore = await payAcct(bank);
    const hold = await prisma.$transaction((tx) => planReserveMove(tx, { partyId: p, currencyCode: "INR", direction: "HOLD", amountFc: "300", documentDate: DATE, availableOn: at("2026-11-05") }), TX);
    const h = await prisma.$transaction((tx) => postReserveMove(tx, { partyId: p, currencyCode: "INR", direction: "HOLD", amountFc: "300", documentDate: DATE, availableOn: at("2026-11-05"), idempotencyKey: key("h"), expectedFingerprint: hold.fingerprint, actor: owner(), ...FY }), TX);
    expect(await lines(h.voucherNumber!)).toEqual(["1150 Cr 300.00", "1160 Dr 300.00"]);
    expect(await bal(p)).toMatchObject({ a: "700.00", r: "300.00" });
    // A payout that also releases the reserve: Bank 1,000 = 700 available + 300 reserve.
    const r = await settle(p, { receivedInr: "1000", lines: [{ lineType: "RESERVE_RELEASE", amount: "300" }] });
    expect(await lines(r.voucherNumber!)).toEqual(["1002 Dr 1000.00", "1150 Cr 700.00", "1160 Cr 300.00"]);
    expect(await bal(p)).toMatchObject({ a: "0.00", r: "0.00" });
    expect(new Decimal(await payAcct(bank)).minus(bankBefore).toFixed(2)).toBe("1000.00");
    const pb = (await getProviderBalances()).find((x) => x.partyId === p);
    expect(pb?.nextAvailableOn).toBe("2026-11-05");
  });

  it("10–11. ads, commission, processing, subscription to expense; TDS/TCS to 1170 (an asset), not expense", async () => {
    const p = await provider("CLR Deductions");
    await sale(p, "10000");
    const r = await settle(p, {
      receivedInr: "8500",
      lines: [
        { lineType: "COMMISSION", amount: "600" },
        { lineType: "ADVERTISING", amount: "400" },
        { lineType: "PROCESSING_FEE", amount: "300" },
        { lineType: "SUBSCRIPTION", amount: "100" },
        { lineType: "TAX_WITHHELD", amount: "100" },
      ],
    });
    expect(await lines(r.voucherNumber!)).toEqual(["1002 Dr 8500.00", "1150 Cr 10000.00", "1170 Dr 100.00", "5600 Dr 600.00", "5610 Dr 400.00", "5620 Dr 300.00", "5640 Dr 100.00"]);
    const t = await prisma.account.findUniqueOrThrow({ where: { code: "1170" } });
    expect(t.type).toBe("ASSET");
  });

  it("12. a finished-jewellery sale return on a clearing sale reduces clearing once (never AR)", async () => {
    const p = await provider("CLR Return");
    const karigar = (await prisma.party.create({ data: { name: `CLR Karigar ${++seq}`, type: "KARIGAR", createdByUserId: ownerId } })).id;
    const job = await prisma.$transaction((tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "CLR ring", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("j") }), TX);
    await prisma.$transaction((tx) => issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId: g22, grossWeight: "5" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("i"), createdByUserId: ownerId }), TX);
    const rcv = await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY, jobId: job.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: 5, metalType: "GOLD", purityId: g22, diamondIds: [], qcStatus: "PASSED" as const }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: "1000", makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0,
          markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("r"), createdByUserId: ownerId,
        }),
      TX
    );
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: rcv.receipt.id } });
    const s = await prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          customerId: p, saleDate: DATE, date: DATE, gstTreatment: "NONE", ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId, idempotencyKey: key("fs"),
          items: [{ finishedJewelleryId: piece.id, sellingPrice: "17590", gstRatePercent: "0", taxType: "EXCLUSIVE" }],
          clearing: { currencyCode: "USD", foreignAmount: "210" },
        }),
      TX
    );
    expect(await bal(p, "USD")).toMatchObject({ a: "210.00", ai: "17590.00" });
    const saleLine = await prisma.finishedJewellerySaleLine.findFirstOrThrow({ where: { saleId: s.sale.id } });
    await prisma.$transaction((tx) => returnFinishedJewelleryItems(tx, { saleId: s.sale.id, items: [{ saleLineId: saleLine.id, disposition: "SELLABLE" }], reason: "Buyer returned it", returnDate: DATE, createdByUserId: ownerId, idempotencyKey: key("ret"), ...FY }), TX);
    expect(await bal(p, "USD")).toMatchObject({ a: "0.00", ai: "0.00" });
    expect(await ledger("1100", p)).toBe("0.00");
  });
});

describe("Reversal, dependencies, idempotency, concurrency", () => {
  it("13–14. reversal restores Bank, fees, 1170, reserve, FX and allocations exactly; newest first", async () => {
    const p = await provider("CLR Reverse");
    await sale(p, "8300", { cur: "USD", fc: "100" });
    await sale(p, "8300", { cur: "USD", fc: "100" });
    const before = { bank: await payAcct(bank), fee: await ledger("5600"), tax: await ledger("1170"), res: await ledger("1160", p), fx: await ledger("4300"), c: await bal(p, "USD") };
    const first = await settle(p, { currencyCode: "USD", receivedInr: "7560", receivedFc: "90", lines: [{ lineType: "COMMISSION", amount: "5" }, { lineType: "TAX_WITHHELD", amount: "2" }, { lineType: "RESERVE_HOLD", amount: "3" }] });
    const sale1 = await prisma.clearingEntry.findFirstOrThrow({ where: { partyId: p, kind: "SALE" } });
    await prisma.$transaction((tx) => allocateSettlement(tx, { documentId: first.document.id, saleVoucherId: sale1.voucherId, amountFc: "50", reason: "Statement line 1", idempotencyKey: key("al"), actor: owner() }), TX);
    const second = await settle(p, { currencyCode: "USD", receivedInr: "840", receivedFc: "10", lines: [] });
    await expect(reverse(first.document.id)).rejects.toThrow(/Reverse the later .* first/);
    await reverse(second.document.id);
    const rev = await reverse(first.document.id);
    expect(rev.document.status).toBe("REVERSED");
    expect(await payAcct(bank)).toBe(before.bank);
    expect(await ledger("5600")).toBe(before.fee);
    expect(await ledger("1170")).toBe(before.tax);
    expect(await ledger("1160", p)).toBe(before.res);
    expect(await ledger("4300")).toBe(before.fx);
    expect(await bal(p, "USD")).toEqual(before.c);
    expect(await prisma.clearingAllocation.count({ where: { documentId: first.document.id, status: "ACTIVE" } })).toBe(0);
    await expect(reverse(first.document.id)).rejects.toThrow(/already reversed/);
    await expect(reverse(second.document.id, "short")).rejects.toThrow(/at least 10/);
  });

  it("15. a double-click (same key) posts once", async () => {
    const p = await provider("CLR Double");
    await sale(p, "500");
    const k = key("dbl");
    const a = await settle(p, { receivedInr: "100", lines: [] }, k);
    const b = await settle(p, { receivedInr: "100", lines: [] }, k).catch((e) => e);
    expect(b instanceof ClearingError ? "stale" : (b as { replayed: boolean }).replayed).toBe(true);
    expect(await prisma.clearingDocument.count({ where: { partyId: p } })).toBe(1);
    expect(a.replayed).toBe(false);
  });

  it("16. two simultaneous settlements cannot oversettle the same balance", async () => {
    const p = await provider("CLR Race");
    await sale(p, "1000");
    const plan = await preview(p, { receivedInr: "800", lines: [] });
    const go = (k: string) => prisma.$transaction((tx) => postSettlement(tx, { ...settleInput(p, { receivedInr: "800", lines: [] }), idempotencyKey: k, expectedFingerprint: plan.fingerprint, actor: owner(), ...FY }), TX);
    const results = await Promise.allSettled([go(key("r1")), go(key("r2")), go(key("r3"))]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(String(r.reason)).toMatch(/changed after this preview|only INR/);
    expect(await bal(p)).toMatchObject({ a: "200.00" });
  });

  it("17. a stale preview is refused (a sale arrived after the preview)", async () => {
    const p = await provider("CLR Stale");
    await sale(p, "1000");
    const plan = await preview(p, { receivedInr: "500", lines: [] });
    await sale(p, "10");
    await expect(prisma.$transaction((tx) => postSettlement(tx, { ...settleInput(p, { receivedInr: "500", lines: [] }), idempotencyKey: key("st"), expectedFingerprint: plan.fingerprint, actor: owner(), ...FY }), TX)).rejects.toThrow(/changed after this preview/);
  });

  it("18. invalid, negative, mismatched and oversettling settlements are refused; Staff cannot post", async () => {
    const p = await provider("CLR Invalid");
    await sale(p, "100");
    await expect(preview(p, { receivedInr: "-5", lines: [] })).rejects.toThrow(/positive number/);
    await expect(preview(p, { receivedInr: "150", lines: [] })).rejects.toThrow(/only INR 100.00/);
    await expect(preview(p, { receivedInr: "50", grossFc: "70", lines: [{ lineType: "COMMISSION", amount: "10" }] })).rejects.toThrow(/does not equal/);
    await expect(preview(p, { receivedInr: "0", paymentAccountId: null, lines: [] })).rejects.toThrow(/Nothing to settle/);
    await expect(preview(p, { receivedInr: "50", paymentAccountId: null, lines: [] })).rejects.toThrow(/payment account/);
    const plain = (await prisma.party.create({ data: { name: `CLR Plain ${++seq}`, type: "CUSTOMER", createdByUserId: ownerId } })).id;
    await expect(preview(plain, { receivedInr: "10", lines: [] })).rejects.toThrow(/not a clearing/);
    await expect(settle(p, { receivedInr: "10", lines: [] }, key("staff"), { id: ownerId, role: "STAFF" as never })).rejects.toThrow(/Only the Owner/);
    await expect(sale(p, "10", { paymentAccountId: bank })).rejects.toThrow(/settlement/);
  });
});

describe("Ordinary sales, Cash & Bank, totals", () => {
  it("19. ordinary cash, bank and credit sales are unchanged (no clearing rows)", async () => {
    const c = (await prisma.party.create({ data: { name: `CLR Ordinary ${++seq}`, type: "CUSTOMER", createdByUserId: ownerId } })).id;
    const entries = await prisma.clearingEntry.count();
    const credit = await sale(c, "500");
    const paid = await sale(c, "700", { paymentAccountId: cash });
    expect(await lines(credit.voucherNumber)).toEqual(["1100 Dr 500.00", "4000 Cr 500.00"]);
    expect(await lines(paid.voucherNumber)).toEqual(["1001 Dr 700.00", "1100 Cr 700.00", "1100 Dr 700.00", "4000 Cr 700.00"]);
    expect(await prisma.clearingEntry.count()).toBe(entries);
    await expect(sale(c, "10", { cur: "USD", fc: "1" })).rejects.toThrow(/Only a marketplace/);
  });

  it("20. Cash & Bank Book shows only the net amount that reached the bank", async () => {
    const p = await provider("CLR Bank book");
    await sale(p, "1000");
    const r = await settle(p, { receivedInr: "870", lines: [{ lineType: "COMMISSION", amount: "130" }] });
    const rows = await listCashBookRows(parseCashBookFilters({ account: bank }, { dateFrom: "2026-04-01", dateTo: "2027-03-31" }), { limit: null });
    const row = rows.find((x) => x.voucherNumber === r.voucherNumber)!;
    expect([row.received.toFixed(2), row.paid.toFixed(2), row.partyId]).toEqual(["870.00", "0.00", p]);
  });

  it("21. receivable/payable are not double-counted; trial balance zero; clearing sub-ledger = ledger", async () => {
    const rp = await getReceivablePayableSummary();
    const [ar] = await prisma.$queryRawUnsafe<{ n: string }[]>(`select coalesce(sum(j.debit-j.credit),0)::numeric(14,2)::text n from journal_entries j join accounts a on a.id=j."accountId" where a.code='1100'`);
    expect(rp.receivable.minus(rp.customerCredit).toFixed(2)).toBe(new Decimal(ar.n).toFixed(2)); // 1150 never inside it
    expect(await unbalanced()).toBe(0);
    const [tb] = await prisma.$queryRawUnsafe<{ d: string }[]>(`select (sum(debit)-sum(credit))::numeric(14,2)::text d from journal_entries`);
    expect(tb.d).toBe("0.00");
    expect(await clearingReconciliation()).toEqual([]);
    const report = await getClearingReport({ partyId: "", currencyCode: "", dateFrom: "2026-04-01", dateTo: "2027-03-31" });
    for (const row of report) {
      const [l] = await prisma.$queryRawUnsafe<{ n: string }[]>(`select coalesce(sum("inrAmount"),0)::numeric(14,2)::text n from clearing_entries where "partyId" = $1 and "currencyCode" = $2`, row.partyId, row.currencyCode);
      expect(row.closingInr.toFixed(2)).toBe(new Decimal(l.n).toFixed(2));
    }
  });

  it("22. the generic voucher Cancel refuses settlement vouchers", async () => {
    const doc = await prisma.clearingDocument.findFirstOrThrow({ where: { status: "POSTED", kind: "SETTLEMENT" } });
    const fd = new FormData();
    fd.set("voucherId", doc.voucherId);
    fd.set("cancellationReason", "trying the generic cancel");
    const r = await cancelVoucherAction(undefined, fd);
    expect(r?.error).toMatch(/Accounting → Settlements/);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: doc.voucherId } })).status).toBe("POSTED");
  });
});

describe("Historical direct-to-Bank marketplace sale (SAL/2026-27/0003 shape)", () => {
  it("23. ETSY ₹12,599 paid 'now' into Bank: reclassified to clearing without touching the sale; then settled", async () => {
    const etsy = (await prisma.party.create({ data: { name: `CLR ETSY ${++seq}`, type: "CUSTOMER", createdByUserId: ownerId } })).id;
    const s = await sale(etsy, "12599", { paymentAccountId: bank, date: at("2026-10-08") });
    const saleLinesBefore = await lines(s.voucherNumber);
    expect(saleLinesBefore).toEqual(["1002 Dr 12599.00", "1100 Cr 12599.00", "1100 Dr 12599.00", "4000 Cr 12599.00"]);
    expect(await prisma.$transaction((tx) => reclassifyBlock(tx, s.id), TX)).toMatch(/not a clearing party/);
    await prisma.party.update({ where: { id: etsy }, data: { clearingEnabled: true } });
    const bankBefore = await payAcct(bank);
    const plan = await prisma.$transaction((tx) => planReclassify(tx, { saleVoucherId: s.id, documentDate: at("2026-10-12") }), TX);
    expect(plan.journal.map((l) => `${l.accountCode} ${l.debit.greaterThan(0) ? "Dr" : "Cr"} ${l.debit.plus(l.credit).toFixed(2)}`)).toEqual(["1150 Dr 12599.00", "1002 Cr 12599.00"]);
    expect(plan.warnings[0]).toMatch(/is not touched/);
    const r = await prisma.$transaction((tx) => postReclassify(tx, { saleVoucherId: s.id, documentDate: at("2026-10-12"), idempotencyKey: key("rc"), expectedFingerprint: plan.fingerprint, actor: owner(), ...FY }), TX);
    expect(await lines(s.voucherNumber)).toEqual(saleLinesBefore); // the sale itself never changes
    expect(new Decimal(await payAcct(bank)).minus(bankBefore).toFixed(2)).toBe("-12599.00");
    expect(await bal(etsy)).toMatchObject({ a: "12599.00" });
    expect(await prisma.$transaction((tx) => reclassifyBlock(tx, s.id), TX)).toMatch(/already reclassified/);
    // The sale cannot now be cancelled on its own (Bank would be credited twice).
    await expect(prisma.$transaction((tx) => cancelVoucher(tx, { voucherId: s.id, cancelledByUserId: ownerId, cancellationReason: "x", ...FY }), TX)).rejects.toThrow(/Reverse the reclassification/);
    // The real payout against clearing.
    await settle(etsy, { receivedInr: "12599", lines: [] });
    expect(new Decimal(await payAcct(bank)).minus(bankBefore).toFixed(2)).toBe("0.00");
    expect(await bal(etsy)).toMatchObject({ a: "0.00" });
    expect(r.replayed).toBe(false);
  });
});

describe("Gross-up of a sale recorded net of marketplace fees (SAL/2026-27/0003 exact shape)", () => {
  async function finishedPiece() {
    const karigar = (await prisma.party.create({ data: { name: `CLR GU Karigar ${++seq}`, type: "KARIGAR", createdByUserId: ownerId } })).id;
    const job = await prisma.$transaction((tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "GU ring", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("j") }), TX);
    await prisma.$transaction((tx) => issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId: g22, grossWeight: "1" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("i"), createdByUserId: ownerId }), TX);
    const rcv = await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY, jobId: job.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: 1, metalType: "GOLD", purityId: g22, diamondIds: [], qcStatus: "PASSED" as const }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          labourCharge: "125", makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0,
          markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("r"), createdByUserId: ownerId,
        }),
      TX
    );
    return prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: rcv.receipt.id } });
  }
  /** ETSY-like finished sale: selling price 17,590, 4,991 entered as a discount, "Paid now" into Bank. */
  async function netOfFeesSale(partyId: string) {
    const piece = await finishedPiece();
    const s = await prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          customerId: partyId, saleDate: at("2026-10-08"), date: at("2026-10-08"), gstTreatment: "NONE", ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId, idempotencyKey: key("fs"),
          paymentAccountId: bank,
          items: [{ finishedJewelleryId: piece.id, sellingPrice: "17590", discountShare: "4991", gstRatePercent: "0", taxType: "EXCLUSIVE" }],
        }),
      TX
    );
    return { piece, sale: s.sale, voucherId: s.sale.voucherId };
  }
  const total = async () => {
    const [r] = await prisma.$queryRawUnsafe<{ n: string }[]>(`select coalesce(sum(debit - credit), 0)::numeric(14,2)::text n from journal_entries`);
    return r.n;
  };
  const voucherCredit = async (voucherIds: string[], code: string) => {
    const [r] = await prisma.$queryRawUnsafe<{ n: string | null }[]>(
      `select sum(j.credit - j.debit)::numeric(14,2)::text n from journal_entries j join accounts a on a.id = j."accountId" where a.code = $1 and j."voucherId" = any($2::text[])`,
      code,
      voucherIds
    );
    return new Decimal(r?.n ?? 0).toFixed(2);
  };
  const metalDiffs = async () => (await prisma.$transaction((tx) => reconcileMetalLedger(tx), TX)).lines.map((l) => `${l.accountCode} ${l.difference.toFixed(2)}`);
  const settlement = () => ({ paymentAccountId: bank, receivedInr: "12599", lines: [{ lineType: "COMMISSION" as const, amount: "2000", description: "Etsy fees" }, { lineType: "ADVERTISING" as const, amount: "2991", description: "Offsite ads" }] });
  const input = (saleVoucherId: string, extra: Partial<GrossUpWorkflowInput> = {}): GrossUpWorkflowInput => ({
    saleVoucherId,
    documentDate: at("2026-10-12"),
    grossSaleInr: "17590",
    taxMode: "NONE",
    taxConfirmation: "CA confirmed 12-10-2026: no GST on the Etsy gross-up",
    settlement: { ...settlement(), documentDate: at("2026-10-08") },
    ...extra,
  });
  const fmt = (j: { accountCode: string; debit: Decimal; credit: Decimal }[]) => j.map((l) => `${l.accountCode} ${l.debit.greaterThan(0) ? "Dr" : "Cr"} ${l.debit.plus(l.credit).toFixed(2)}`);

  it("25. preview shows reclass ₹12,599 + gross-up ₹4,991 + settlement ₹17,590; posting keeps Bank, profit, COGS, stock and the sale; revenue ₹17,590, expense ₹4,991, clearing 0", async () => {
    const etsy = (await prisma.party.create({ data: { name: `CLR GU ETSY ${++seq}`, type: "CUSTOMER", createdByUserId: ownerId } })).id;
    const { piece, sale: fjs, voucherId } = await netOfFeesSale(etsy);
    const sv = await prisma.voucher.findUniqueOrThrow({ where: { id: voucherId } });
    const saleLinesBefore = await lines(sv.voucherNumber);
    expect(saleLinesBefore).toEqual(expect.arrayContaining(["1002 Dr 12599.00", "4000 Cr 12599.00"]));
    expect(await prisma.$transaction((tx) => grossUpBlock(tx, voucherId), TX)).toMatch(/not a clearing party/);
    await prisma.party.update({ where: { id: etsy }, data: { clearingEnabled: true } });

    const before = {
      bank: await payAcct(bank),
      cogs: await ledger("5200"),
      fin: await ledger("1330"),
      fees: new Decimal(await ledger("5600")).plus(await ledger("5610")).toFixed(2),
      sales: await ledger("4000"),
      movements: await prisma.metalStockMovement.count(),
      piece: await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: piece.id } }),
      fjs: await prisma.finishedJewellerySale.findUniqueOrThrow({ where: { id: fjs.id } }),
      pl: await getProfitAndLoss(),
      metal: await metalDiffs(),
    };
    expect(before.metal.every((l) => l.endsWith(" 0.00"))).toBe(true);

    // The CA's GST decision is never guessed.
    await expect(prisma.$transaction((tx) => planGrossUpWorkflow(tx, input(voucherId, { taxMode: null })), TX)).rejects.toThrow(/GST treatment .* as the CA confirmed/);
    await expect(prisma.$transaction((tx) => planGrossUpWorkflow(tx, input(voucherId, { taxConfirmation: "ok" })), TX)).rejects.toThrow(/CA's GST confirmation/);
    await expect(prisma.$transaction((tx) => planGrossUpWorkflow(tx, input(voucherId, { grossSaleInr: "12599" })), TX)).rejects.toThrow(/must be more than/);
    // A gross-up on its own is refused while the receipt is still in Bank.
    await expect(prisma.$transaction((tx) => planGrossUp(tx, input(voucherId)), TX)).rejects.toThrow(/reclassify it to clearing first/);

    const plan = await prisma.$transaction((tx) => planGrossUpWorkflow(tx, input(voucherId)), TX);
    expect(fmt(plan.reclass!.journal)).toEqual(["1150 Dr 12599.00", "1002 Cr 12599.00"]);
    expect(fmt(plan.grossUp.journal)).toEqual(["1150 Dr 4991.00", "4000 Cr 4991.00"]);
    expect(fmt(plan.settlement!.journal)).toEqual(["1002 Dr 12599.00", "5600 Dr 2000.00", "5610 Dr 2991.00", "1150 Cr 17590.00"]);
    expect(plan.settlement!.before.available.inr.toFixed(2)).toBe("17590.00");
    expect(plan.effect.cashBankNet.toFixed(2)).toBe("0.00");
    expect(plan.effect.clearingAfterInr.toFixed(2)).toBe("0.00");
    expect(plan.effect.revenueAdded.toFixed(2)).toBe("4991.00");
    expect(plan.effect.taxAdded.toFixed(2)).toBe("0.00");
    expect(plan.effect.expenseAdded.toFixed(2)).toBe("4991.00");
    expect(plan.effect.profitChange.toFixed(2)).toBe("0.00");
    expect(plan.grossUp.warnings.join(" ")).toMatch(/is not edited.*COGS/);
    expect(await prisma.clearingDocument.count({ where: { partyId: etsy } })).toBe(0); // a preview saves nothing

    const k = key("gu");
    const post = () => prisma.$transaction((tx) => postGrossUpWorkflow(tx, { ...input(voucherId), idempotencyKey: k, expectedFingerprint: plan.fingerprint, actor: owner(), ...FY }), TX);
    const r = await post();
    expect(r.replayed).toBe(false);
    expect(r.voucherNumbers.map((n) => n.split("/")[0])).toEqual(["CLR-RCL", "CLR-GRS", "CLR"]);
    expect((await post()).replayed).toBe(true); // double-click
    expect(await prisma.clearingDocument.count({ where: { partyId: etsy } })).toBe(3);
    const doc = await prisma.clearingDocument.findFirstOrThrow({ where: { partyId: etsy, kind: "GROSS_UP" } });
    expect(doc.grossSaleInr?.toFixed(2)).toBe("17590.00");
    expect(doc.taxConfirmation).toMatch(/no GST/);
    const gv = await prisma.voucher.findUniqueOrThrow({ where: { id: doc.voucherId } });
    expect(gv.voucherType).toBe("CLEARING_GROSSUP");

    // Bank unchanged, clearing zero, revenue 17,590 for this order, expense 4,991, profit unchanged.
    expect(await payAcct(bank)).toBe(before.bank);
    expect(await bal(etsy)).toMatchObject({ a: "0.00", ai: "0.00", r: "0.00" });
    expect(await ledger("1150", etsy)).toBe("0.00");
    expect(await voucherCredit([voucherId, doc.voucherId], "4000")).toBe("17590.00");
    expect(new Decimal(await ledger("5600")).plus(await ledger("5610")).minus(before.fees).toFixed(2)).toBe("4991.00");
    expect(new Decimal(await ledger("4000")).minus(before.sales).toFixed(2)).toBe("-4991.00");
    const pl = await getProfitAndLoss();
    expect(pl.netProfit.toFixed(2)).toBe(before.pl.netProfit.toFixed(2));
    expect(pl.grossSales.minus(before.pl.grossSales).toFixed(2)).toBe("4991.00");
    expect(pl.otherExpensesTotal.minus(before.pl.otherExpensesTotal).toFixed(2)).toBe("4991.00");
    expect(pl.manualSalesAmount.toFixed(2)).toBe(before.pl.manualSalesAmount.toFixed(2)); // linked revenue, not a manual sale
    expect(pl.finishedJewelleryCogs.toFixed(2)).toBe(before.pl.finishedJewelleryCogs.toFixed(2));

    // Stock, piece status, COGS and the original sale voucher are untouched.
    expect(await ledger("5200")).toBe(before.cogs);
    expect(await ledger("1330")).toBe(before.fin);
    expect(await prisma.metalStockMovement.count()).toBe(before.movements);
    expect(await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: piece.id } })).toEqual(before.piece);
    expect(await prisma.finishedJewellerySale.findUniqueOrThrow({ where: { id: fjs.id } })).toEqual(before.fjs);
    expect(await lines(sv.voucherNumber)).toEqual(saleLinesBefore);
    expect((await prisma.voucher.findUniqueOrThrow({ where: { id: voucherId } })).status).toBe("POSTED");

    // Every ledger reconciles.
    expect(await total()).toBe("0.00");
    expect(await unbalanced()).toBe(0);
    expect(await clearingReconciliation()).toEqual([]);
    expect(await metalDiffs()).toEqual(before.metal);
    const [row] = await getClearingReport({ partyId: etsy, currencyCode: "", dateFrom: "2026-04-01", dateTo: "2027-03-31" });
    expect({ reclass: row.reclassifiedInr.toFixed(2), grossUp: row.grossUpInr.toFixed(2), payouts: row.payoutsInr.toFixed(2), fees: row.feesInr.toFixed(2), ads: row.marketingInr.toFixed(2), closing: row.closingInr.toFixed(2) }).toEqual({
      reclass: "12599.00", grossUp: "4991.00", payouts: "12599.00", fees: "2000.00", ads: "2991.00", closing: "0.00",
    });

    // One gross-up per sale; the sale cannot be cancelled underneath it; generic Cancel refuses CLR-GRS.
    expect(await prisma.$transaction((tx) => grossUpBlock(tx, voucherId), TX)).toMatch(/already grossed up/);
    await expect(prisma.$transaction((tx) => cancelVoucher(tx, { voucherId, cancelledByUserId: ownerId, cancellationReason: "x", ...FY }), TX)).rejects.toThrow(/Reverse the gross-up/);
    const cfd = new FormData();
    cfd.set("voucherId", doc.voucherId);
    cfd.set("cancellationReason", "Trying the generic cancel on a gross-up");
    expect((await cancelVoucherAction(undefined, cfd))?.error).toMatch(/Settlements/);

    // Reversal is newest first and restores everything exactly.
    const docs = await prisma.clearingDocument.findMany({ where: { partyId: etsy }, orderBy: { sequence: "asc" } });
    expect(docs.map((d) => d.kind)).toEqual(["RECLASSIFY", "GROSS_UP", "SETTLEMENT"]);
    await expect(reverse(docs[1].id)).rejects.toThrow(/Reverse the later CLR\//);
    for (const d of [...docs].reverse()) await reverse(d.id);
    expect(await payAcct(bank)).toBe(before.bank);
    expect(await ledger("4000")).toBe(before.sales);
    expect(new Decimal(await ledger("5600")).plus(await ledger("5610")).toFixed(2)).toBe(before.fees);
    expect((await getProfitAndLoss()).netProfit.toFixed(2)).toBe(before.pl.netProfit.toFixed(2));
    expect(await bal(etsy)).toMatchObject({ a: "0.00", ai: "0.00" });
    expect(await clearingReconciliation()).toEqual([]);
    expect(await total()).toBe("0.00");
    expect(await lines(sv.voucherNumber)).toEqual(saleLinesBefore);
    expect(await prisma.$transaction((tx) => grossUpBlock(tx, voucherId), TX)).toBeNull(); // can be redone
  });

  it("26. GST on the gross-up is configurable (exclusive IGST, inclusive CGST+SGST) and only as recorded", async () => {
    const p = await provider("CLR GU Tax");
    const s1 = await sale(p, "1000", { cur: "INR" }); // a clearing sale: receipt already in clearing, no reclass step
    const ex = await prisma.$transaction((tx) => planGrossUpWorkflow(tx, { saleVoucherId: s1.id, documentDate: DATE, grossSaleInr: "1500", taxMode: "EXCLUSIVE", gstTreatment: "IGST", gstRatePercent: "18", taxConfirmation: "CA: IGST 18% on top of the gross-up" }), TX);
    expect(ex.reclass).toBeNull();
    expect(ex.settlement).toBeNull();
    expect(fmt(ex.grossUp.journal)).toEqual(["1150 Dr 590.00", "4000 Cr 500.00", "7003 Cr 90.00"]);
    expect(ex.effect.taxAdded.toFixed(2)).toBe("90.00");
    expect(ex.effect.clearingAfterInr.toFixed(2)).toBe("1590.00");
    const inc = await prisma.$transaction((tx) => planGrossUpWorkflow(tx, { saleVoucherId: s1.id, documentDate: DATE, grossSaleInr: "1590", taxMode: "INCLUSIVE", gstTreatment: "CGST_SGST", gstRatePercent: "18", taxConfirmation: "CA: 18% CGST+SGST included in it" }), TX);
    expect(fmt(inc.grossUp.journal)).toEqual(["1150 Dr 590.00", "4000 Cr 500.00", "7001 Cr 45.00", "7002 Cr 45.00"]);
    await expect(prisma.$transaction((tx) => planGrossUpWorkflow(tx, { saleVoucherId: s1.id, documentDate: DATE, grossSaleInr: "1590", taxMode: "INCLUSIVE", taxConfirmation: "CA: 18% included in it" }), TX)).rejects.toThrow(/CGST \+ SGST or IGST/);
    // Post the exclusive one on its own and settle later through an ordinary settlement.
    const r = await prisma.$transaction((tx) => postGrossUpWorkflow(tx, { saleVoucherId: s1.id, documentDate: DATE, grossSaleInr: "1500", taxMode: "EXCLUSIVE", gstTreatment: "IGST", gstRatePercent: "18", taxConfirmation: "CA: IGST 18% on top of the gross-up", idempotencyKey: key("gx"), expectedFingerprint: ex.fingerprint, actor: owner(), ...FY }), TX);
    expect(r.voucherNumbers).toHaveLength(1);
    expect(await ledger("7003")).toBe("-90.00");
    expect(await bal(p)).toMatchObject({ a: "1590.00", ai: "1590.00" });
    expect(await clearingReconciliation()).toEqual([]);
    await settle(p, { receivedInr: "1000", lines: [{ lineType: "COMMISSION", amount: "500" }, { lineType: "TAX_REMITTED", amount: "90" }] });
    expect(await bal(p)).toMatchObject({ a: "0.00", ai: "0.00" });
  });

  it("27. refused for a returned or cancelled sale, a stale preview, a foreign-currency sale and Staff", async () => {
    const p = (await prisma.party.create({ data: { name: `CLR GU Block ${++seq}`, type: "CUSTOMER", createdByUserId: ownerId } })).id;
    const { sale: fjs, voucherId } = await netOfFeesSale(p);
    await prisma.party.update({ where: { id: p }, data: { clearingEnabled: true } });
    const saleLine = await prisma.finishedJewellerySaleLine.findFirstOrThrow({ where: { saleId: fjs.id } });
    const plan = await prisma.$transaction((tx) => planGrossUpWorkflow(tx, input(voucherId)), TX);
    // Stale: another sale of the same provider lands in clearing after the preview.
    await sale(p, "10", { cur: "INR" });
    await expect(prisma.$transaction((tx) => postGrossUpWorkflow(tx, { ...input(voucherId), idempotencyKey: key("st"), expectedFingerprint: plan.fingerprint, actor: owner(), ...FY }), TX)).rejects.toThrow(/changed after this preview/);
    expect(await prisma.clearingDocument.count({ where: { partyId: p } })).toBe(0); // all or nothing
    await expect(prisma.$transaction((tx) => postGrossUpWorkflow(tx, { ...input(voucherId), idempotencyKey: key("sf"), expectedFingerprint: plan.fingerprint, actor: { id: ownerId, role: "STAFF" }, ...FY }), TX)).rejects.toThrow(/Only the Owner/);
    await prisma.$transaction((tx) => returnFinishedJewelleryItems(tx, { saleId: fjs.id, items: [{ saleLineId: saleLine.id, disposition: "SELLABLE" }], reason: "Buyer returned it", returnDate: DATE, createdByUserId: ownerId, idempotencyKey: key("ret"), ...FY }), TX);
    expect(await prisma.$transaction((tx) => grossUpBlock(tx, voucherId), TX)).toMatch(/sale return/);
    const usd = await sale(p, "8300", { cur: "USD", fc: "100" });
    expect(await prisma.$transaction((tx) => grossUpBlock(tx, usd.id), TX)).toMatch(/only for INR/);
    const gone = await sale(p, "500", { cur: "INR" });
    await prisma.$transaction((tx) => cancelVoucher(tx, { voucherId: gone.id, cancelledByUserId: ownerId, cancellationReason: "Entered twice by mistake", ...FY }), TX);
    expect(await prisma.$transaction((tx) => grossUpBlock(tx, gone.id), TX)).toMatch(/cancelled/);
    const fd = new FormData();
    fd.set("saleVoucherId", voucherId);
    auth.user = { id: ownerId, role: "STAFF", name: "Staff", email: "staff@test" };
    try {
      await expect(previewGrossUpAction(undefined, fd)).rejects.toThrow(/unauthorized/);
      await expect(postGrossUpAction(undefined, fd)).rejects.toThrow(/unauthorized/);
    } finally {
      auth.user = { id: ownerId, role: "OWNER", name: "Owner", email: "owner@test" };
    }
  });
});

describe("Permissions (server-enforced)", () => {
  it("24. every clearing action and the CSV refuse Staff; the Owner preview carries no data for anyone else", async () => {
    const p = await provider("CLR Perm");
    await sale(p, "100");
    const fd = new FormData();
    fd.set("partyId", p);
    fd.set("currencyCode", "INR");
    fd.set("documentDate", "2026-10-05");
    fd.set("paymentAccountId", bank);
    fd.set("receivedInr", "40");
    fd.set("linesJson", "[]");
    auth.user = { id: ownerId, role: "STAFF", name: "Staff", email: "staff@test" };
    for (const call of [
      () => previewSettlementAction(undefined, fd),
      () => postSettlementAction(undefined, fd),
      () => reverseClearingAction(undefined, fd),
      () => setClearingPartyAction(undefined, fd),
      () => clearingBalanceAction(p, "INR"),
      () => clearingCsv(new Request("http://x/accounting/clearing-report/export")),
    ]) {
      await expect(call()).rejects.toThrow(/unauthorized/);
    }
    auth.user = { id: ownerId, role: "OWNER", name: "Owner", email: "owner@test" };
    const preview = await previewSettlementAction(undefined, fd);
    expect(preview?.preview?.after.availableFc).toBe("60.00");
    fd.set("idempotencyKey", key("act"));
    fd.set("fingerprint", preview!.preview!.fingerprint);
    const saved = await postSettlementAction(undefined, fd);
    expect(saved?.success).toMatch(/^CLR\//);
    const res = await clearingCsv(new Request("http://x/accounting/clearing-report/export?dateFrom=2026-04-01&dateTo=2027-03-31"));
    const body = await res.text();
    expect(body).toContain("CLR Perm");
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
  });
});
