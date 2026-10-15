/**
 * Other Material as purchased stock — real-database proof on the disposable
 * scratch database only (shared guard; truncates business tables).
 * Every amount is checked against the ledger to the paisa.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { postCustomerGoldTransfer, receiveCustomerGold } from "@/lib/jewellery/customerGold";
import { receiveWithCustomerGold } from "@/lib/jewellery/customerGoldJobReceipt";
import { reverseCustomerGoldJobReceipt } from "@/lib/jewellery/customerGoldReceiptReversal";
import { postFinishedJewellerySale } from "@/lib/jewellery/finishedSalesPosting";
import { postCustodyOperation } from "@/lib/jewellery/karigarCustody";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import {
  cancelOtherMaterialPurchase,
  createOtherMaterialItem,
  getJobMaterialPanel,
  issueOtherMaterialToJob,
  jobHoldings,
  legacyOtherMaterialLines,
  listOtherMaterialStock,
  otherMaterialPurchaseCancelBlock,
  planOtherMaterialPurchase,
  postOtherMaterialPurchase,
  returnOtherMaterialFromJob,
  reverseOtherMaterialJobDocument,
  stockForItems,
  type OtherMaterialPurchaseInput,
} from "@/lib/jewellery/otherMaterial";
import { cancelJewelleryJob, createJewelleryJob, issueMaterialsToJewelleryJob, postOpeningMetalStock } from "@/lib/jewellery/posting";
import { receiveWithCustodyAllocation } from "@/lib/jewellery/receiptCustody";
import { seedLegacyOtherMaterial } from "../../../test/fixtures/legacyOtherMaterial";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-12T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };
let ownerId: string;
let staffId: string;
let supplier: string;
let karigar: string;
let customer: string;
let g24: string;
let seq = 0;
const key = (l: string) => `om-${l}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const staff = () => ({ id: staffId, role: "STAFF" as const });
const d2 = (v: unknown) => new Decimal(String(v ?? 0)).toFixed(2);

async function ledger(code: string, partyId?: string) {
  const [r] = await prisma.$queryRawUnsafe<{ n: string | null }[]>(
    `select sum(j.debit - j.credit)::numeric(14,2)::text n from journal_entries j join accounts a on a.id = j."accountId" where a.code = $1 ${partyId ? `and j."partyId" = '${partyId}'` : ""}`,
    code
  );
  return d2(r?.n);
}
async function voucherLines(voucherId: string) {
  const rows = await prisma.journalEntry.findMany({ where: { voucherId }, include: { account: true } });
  return rows.map((j) => `${j.account.code} ${new Decimal(j.debit).greaterThan(0) ? "Dr" : "Cr"} ${d2(new Decimal(j.debit).plus(j.credit))}`).sort();
}
async function reconciled() {
  for (const l of (await reconcileMetalLedger(prisma)).lines) expect([l.accountCode, l.difference.toFixed(2)]).toEqual([l.accountCode, "0.00"]);
  const [r] = await prisma.$queryRawUnsafe<{ tb: string; unbalanced: number }[]>(
    `select (select coalesce(sum(debit - credit), 0)::numeric(14,2)::text from journal_entries) tb,
            (select count(*)::int from (select v.id from vouchers v left join journal_entries j on j."voucherId" = v.id group by v.id having coalesce(sum(j.debit),0) <> coalesce(sum(j.credit),0) or count(j.id) = 0) t) unbalanced`
  );
  expect(r).toEqual({ tb: "0.00", unbalanced: 0 });
  // The job pool equals what the movement ledger says the jobs hold.
  const [p] = await prisma.$queryRawUnsafe<{ pool: string }[]>(`select coalesce(sum("stockMaterialWipCost"), 0)::numeric(14,2)::text pool from jewellery_jobs`);
  const jobs = await prisma.jewelleryJob.findMany({ select: { id: true } });
  let held = new Decimal(0);
  for (const j of jobs) for (const h of (await jobHoldings(prisma, j.id)).values()) held = held.plus(h.cost);
  expect(p.pool).toBe(held.toFixed(2));
}
const item = (name: string, unit: "PCS" | "CT" | "GRAM") => prisma.$transaction((tx) => createOtherMaterialItem(tx, { name: `${name} ${++seq}`, unit, actor: staff() }), TX);
const purchaseInput = (lines: OtherMaterialPurchaseInput["lines"], gst: OtherMaterialPurchaseInput["gstTreatment"] = "NONE"): OtherMaterialPurchaseInput => ({ supplierId: supplier, purchaseDate: DATE, reference: "INV-77", gstTreatment: gst, lines });
async function buy(lines: OtherMaterialPurchaseInput["lines"], gst: OtherMaterialPurchaseInput["gstTreatment"] = "NONE", actor = staff()) {
  const input = purchaseInput(lines, gst);
  const plan = await prisma.$transaction((tx) => planOtherMaterialPurchase(tx, input), TX);
  return prisma.$transaction((tx) => postOtherMaterialPurchase(tx, { ...input, idempotencyKey: key("p"), expectedFingerprint: plan.fingerprint, actor, ...FY }), TX);
}
const stockOf = async (itemId: string) => {
  const s = (await stockForItems(prisma, [itemId])).get(itemId);
  return [s?.quantity.toFixed(3) ?? "0.000", s?.cost.toFixed(2) ?? "0.00"];
};
const issue = (jobId: string, lines: { itemId: string; quantity: string }[], k = key("i")) =>
  prisma.$transaction((tx) => issueOtherMaterialToJob(tx, { jobId, lines, issueDate: DATE, idempotencyKey: k, createdByUserId: staffId, ...FY }), TX);
const giveBack = (jobId: string, lines: { itemId: string; quantity: string }[]) =>
  prisma.$transaction((tx) => returnOtherMaterialFromJob(tx, { jobId, lines, returnDate: DATE, reason: "Not used", idempotencyKey: key("r"), createdByUserId: staffId, ...FY }), TX);
const newJob = async (name: string, customerId: string | null = null) =>
  (await prisma.$transaction((tx) => createJewelleryJob(tx, { customerId, jewelleryType: "RING", designName: name, karigarId: karigar, issueDate: DATE, quantity: 2, createdByUserId: ownerId, idempotencyKey: key("job") }), TX)).id;
/** A Company-gold receipt through Karigar Metal: `pieces` outputs of `net` g 24K each. */
const receive = (jobId: string, opts: { pieces?: number; net?: string; complete?: boolean; otherExpense?: string; karigarMaterialLines?: { description: string; quantity: string; unit: "PCS" | "CT" | "GRAM"; charge: string }[] } = {}) =>
  prisma.$transaction(
    (tx) =>
      receiveWithCustodyAllocation(tx, {
        ...FY, jobId, receiveDate: DATE,
        outputs: Array.from({ length: opts.pieces ?? 1 }, () => ({ jewelleryType: "RING" as const, quantity: 1, netMetalWeight: opts.net ?? "1.001", metalType: "GOLD" as const, purityId: g24, diamondIds: [], qcStatus: "PASSED" as const })),
        diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
        alloy: { includedGrossWeight: "0" }, labourCharge: "100.00", makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: opts.otherExpense ?? 0,
        karigarMaterialLines: opts.karigarMaterialLines,
        markJobComplete: opts.complete ?? true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
        sourcePurityId: g24, actor: owner(),
      }),
    TX
  );

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  process.env.SESSION_SECRET ??= "other-material-test-secret-0123456789abcdef";
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  staffId = (await prisma.user.findFirstOrThrow({ where: { role: "STAFF" } })).id;
  const party = async (name: string, type: "CUSTOMER" | "KARIGAR" | "SUPPLIER") => (await prisma.party.create({ data: { name, type, createdByUserId: ownerId } })).id;
  supplier = await party("OM Supplier", "SUPPLIER");
  karigar = await party("OM Karigar", "KARIGAR");
  customer = await party("OM Customer", "CUSTOMER");
  g24 = (await prisma.metalPurity.upsert({ where: { metalType_displayName: { metalType: "GOLD", displayName: "OM 24K" } }, create: { metalType: "GOLD", displayName: "OM 24K", finenessPercent: "99.900", createdByUserId: ownerId }, update: {} })).id;
  await prisma.$transaction((tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g24, grossWeight: "100.000", costValue: "700000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }), TX);
  await prisma.$transaction((tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: karigar, purityId: g24, fineWeight: "30", entryDate: DATE, reason: "Company gold", idempotencyKey: key("ci"), owner: owner(), ...FY }), TX);
}, 120_000);

afterAll(async () => {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  await prisma.$disconnect();
});

describe("Purchase: stock and supplier payable, once", () => {
  it("200 CT × ₹50/CT = ₹10,000.00 → Dr 1230 / Cr supplier; stock 200 CT at ₹10,000.00", async () => {
    const m = await item("Moissanite", "CT");
    const ap0 = await ledger("2000", supplier);
    const r = await buy([{ itemId: m.id, quantity: "200", rate: "50" }]);
    expect([d2(r.purchase.subtotal), d2(r.purchase.grandTotal)]).toEqual(["10000.00", "10000.00"]);
    expect(await voucherLines(r.purchase.voucherId)).toEqual(["1230 Dr 10000.00", "2000 Cr 10000.00"]);
    expect(new Decimal(await ledger("2000", supplier)).minus(ap0).toFixed(2)).toBe("-10000.00");
    expect(await stockOf(m.id)).toEqual(["200.000", "10000.00"]);
    await reconciled();
  });

  it("GRAM and PCS lines with discount and GST: the server computes every amount from quantity × rate", async () => {
    const f = await item("Findings", "GRAM");
    const e = await item("Enamel set", "PCS");
    const input = purchaseInput(
      [
        { itemId: f.id, quantity: "12.345", rate: "99.9999", discount: "4.50", gstRatePercent: "3" },
        { itemId: e.id, quantity: "3", rate: "1180", gstRatePercent: "18", taxType: "INCLUSIVE" },
      ],
      "CGST_SGST"
    );
    const plan = await prisma.$transaction((tx) => planOtherMaterialPurchase(tx, input), TX);
    expect(plan.lines.map((l) => [l.baseAmount.toFixed(2), l.taxableValue.toFixed(2), l.taxAmount.toFixed(2), l.lineTotal.toFixed(2)])).toEqual([
      ["1234.50", "1230.00", "36.90", "1266.90"],
      ["3540.00", "3000.00", "540.00", "3540.00"],
    ]);
    // A tampered amount in the request is not an input at all: only quantity and rate are read.
    const tampered = { ...input, lines: input.lines.map((l) => ({ ...l, baseAmount: "1.00", lineTotal: "1.00" })) } as OtherMaterialPurchaseInput;
    const r = await prisma.$transaction((tx) => postOtherMaterialPurchase(tx, { ...tampered, idempotencyKey: key("t"), expectedFingerprint: plan.fingerprint, actor: staff(), ...FY }), TX);
    expect(d2(r.purchase.grandTotal)).toBe("4806.90");
    expect(await voucherLines(r.purchase.voucherId)).toEqual(["1230 Dr 4230.00", "2000 Cr 4806.90", "6001 Dr 288.45", "6002 Dr 288.45"]);
    await expect(prisma.$transaction((tx) => postOtherMaterialPurchase(tx, { ...purchaseInput([{ itemId: f.id, quantity: "1", rate: "2" }]), idempotencyKey: key("s"), expectedFingerprint: plan.fingerprint, actor: staff(), ...FY }), TX)).rejects.toThrow(/changed after the preview/);
    for (const bad of [{ quantity: "0", rate: "1" }, { quantity: "1.0001", rate: "1" }, { quantity: "1", rate: "-1" }, { quantity: "x", rate: "1" }]) {
      await expect(prisma.$transaction((tx) => planOtherMaterialPurchase(tx, purchaseInput([{ itemId: f.id, ...bad }])), TX)).rejects.toThrow();
    }
    await reconciled();
  });
});

describe("Issue only from purchased stock; payable never again", () => {
  it("free text, an unpurchased item and more than the stock are refused; issue is Dr 1320 / Cr 1230 at carrying cost with no payable", async () => {
    const m = await item("Stone", "PCS");
    const job = await newJob("Material ring");
    await expect(prisma.$transaction((tx) => issueMaterialsToJewelleryJob(tx, { ...FY, jobId: job, issueDate: DATE, metalLines: [], polishedDiamondIds: [], otherMaterialLines: [{ description: "Enamel", quantity: 1, unit: "PCS", cost: 100 }] as never, createdByUserId: staffId }), TX)).rejects.toThrow(/choose a purchased material from stock/);
    await expect(issue(job, [{ itemId: m.id, quantity: "1" }])).rejects.toThrow(/Only 0\.000 PCS .* is in stock/);
    await buy([{ itemId: m.id, quantity: "10", rate: "33.33" }]); // ₹333.30
    await expect(issue(job, [{ itemId: m.id, quantity: "10.001" }])).rejects.toThrow(/Only 10\.000 PCS/);
    const apBefore = await ledger("2000");
    const r = await issue(job, [{ itemId: m.id, quantity: "3" }]);
    expect(await voucherLines(r.document.voucherId)).toEqual(["1230 Cr 99.99", "1320 Dr 99.99"]); // 333.30 × 3/10, at carrying cost
    expect(await ledger("2000")).toBe(apBefore);
    expect(await stockOf(m.id)).toEqual(["7.000", "233.31"]);
    expect(d2((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job } })).stockMaterialWipCost)).toBe("99.99");
    // The last units take the exact remainder: nothing stranded.
    const job2 = await newJob("Takes the rest");
    await issue(job2, [{ itemId: m.id, quantity: "7" }]);
    expect(await stockOf(m.id)).toEqual(["0.000", "0.00"]);
    await reconciled();
  });

  it("two simultaneous issues of the last stock: exactly one wins, stock never negative; a double-click posts once", async () => {
    const m = await item("Race stone", "CT");
    await buy([{ itemId: m.id, quantity: "5", rate: "100" }]);
    const [a, b] = [await newJob("Race A"), await newJob("Race B")];
    const race = await Promise.allSettled([issue(a, [{ itemId: m.id, quantity: "4" }]), issue(b, [{ itemId: m.id, quantity: "4" }])]);
    expect(race.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(await stockOf(m.id)).toEqual(["1.000", "100.00"]);
    const k = key("dbl");
    await Promise.allSettled([issue(a, [{ itemId: m.id, quantity: "1" }], k), issue(a, [{ itemId: m.id, quantity: "1" }], k)]);
    expect(await prisma.otherMaterialJobDocument.count({ where: { idempotencyKey: k } })).toBe(1);
    expect(await stockOf(m.id)).toEqual(["0.000", "0.00"]);
    await reconciled();
  });

  it("weighted carrying cost across two purchases at different rates", async () => {
    const m = await item("Weighted", "GRAM");
    await buy([{ itemId: m.id, quantity: "10", rate: "10" }]); // 100.00
    await buy([{ itemId: m.id, quantity: "10", rate: "20" }]); // 200.00
    const job = await newJob("Weighted ring");
    const r = await issue(job, [{ itemId: m.id, quantity: "5" }]);
    expect(d2(r.document.totalCost)).toBe("75.00"); // 300 × 5/20
    expect(await stockOf(m.id)).toEqual(["15.000", "225.00"]);
    await reconciled();
  });
});

describe("Return, receipt, sale and reversal", () => {
  it("return puts exact quantity and value back; a receipt carries the rest into the piece; COGS includes it", async () => {
    const m = await item("Lifecycle", "PCS");
    await buy([{ itemId: m.id, quantity: "10", rate: "50" }]); // 500.00
    const job = await newJob("Lifecycle ring");
    await issue(job, [{ itemId: m.id, quantity: "6" }]); // 300.00
    const back = await giveBack(job, [{ itemId: m.id, quantity: "2" }]); // 100.00
    expect(await voucherLines(back.document.voucherId)).toEqual(["1230 Dr 100.00", "1320 Cr 100.00"]);
    expect(await stockOf(m.id)).toEqual(["6.000", "300.00"]);
    await expect(giveBack(job, [{ itemId: m.id, quantity: "4.001" }])).rejects.toThrow(/holds only 4\.000 PCS/);
    const before1330 = await ledger("1330");
    const r = await receive(job);
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r.receipt.id } });
    expect(d2(piece.materialCost)).toBe("200.00");
    expect(new Decimal(await ledger("1330")).minus(before1330).toFixed(2)).toBe(d2(new Decimal(piece.metalCost).plus(piece.diamondCost).plus(piece.labourAllocated).plus(piece.materialCost)));
    expect(d2((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job } })).stockMaterialWipCost)).toBe("0.00");
    expect((await jobHoldings(prisma, job)).size).toBe(0);
    await reconciled();
    const sale = await prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          customerId: customer, saleDate: DATE, date: DATE, gstTreatment: "NONE", ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId, idempotencyKey: key("sale"),
          items: [{ finishedJewelleryId: piece.id, sellingPrice: "30000", gstRatePercent: "0", taxType: "EXCLUSIVE" }],
        }),
      TX
    );
    expect(d2(sale.sale.cogsTotal)).toBe(d2(new Decimal(piece.metalCost).plus(piece.diamondCost).plus(piece.labourAllocated).plus(piece.materialCost)));
    await reconciled();
  });

  it("partial receipts drain the material by fine weight; the final receipt takes the exact rest", async () => {
    const m = await item("Partial", "PCS");
    await buy([{ itemId: m.id, quantity: "3", rate: "100.01" }]); // 300.03
    const job = await newJob("Two receipts");
    await prisma.$transaction((tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: karigar, purityId: g24, jobId: job, fineWeight: "3", entryDate: DATE, reason: "Gold for the job", idempotencyKey: key("al"), owner: owner(), ...FY }), TX);
    await issue(job, [{ itemId: m.id, quantity: "3" }]);
    const r1 = await receive(job, { net: "1.001", complete: false }); // 1 of 3 g fine
    const p1 = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r1.receipt.id } });
    expect(d2(p1.materialCost)).toBe("100.01");
    const r2 = await receive(job, { net: "2.002", complete: true });
    const p2 = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r2.receipt.id } });
    expect(new Decimal(p1.materialCost).plus(p2.materialCost).toFixed(2)).toBe("300.03");
    expect(d2((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job } })).stockMaterialWipCost)).toBe("0.00");
    await reconciled();
  });

  it("reversal is newest first, refused once a receipt consumed it; purchase cancel refused after use, mirror before", async () => {
    const m = await item("Reverse", "PCS");
    const p = await buy([{ itemId: m.id, quantity: "4", rate: "25" }]);
    const unused = await buy([{ itemId: m.id, quantity: "1", rate: "25" }]);
    const job = await newJob("Reverse ring");
    const i1 = await issue(job, [{ itemId: m.id, quantity: "2" }]);
    const ret = await giveBack(job, [{ itemId: m.id, quantity: "1" }]);
    await expect(prisma.$transaction((tx) => reverseOtherMaterialJobDocument(tx, { documentId: i1.document.id, reason: "Issued the wrong quantity", actor: owner(), ...FY }), TX)).rejects.toThrow(/Reverse the later .* first/);
    await expect(prisma.$transaction((tx) => reverseOtherMaterialJobDocument(tx, { documentId: ret.document.id, reason: "Returned by mistake here", actor: staff(), ...FY }), TX)).rejects.toThrow(/Only the Owner/);
    await prisma.$transaction((tx) => reverseOtherMaterialJobDocument(tx, { documentId: ret.document.id, reason: "Returned by mistake here", actor: owner(), ...FY }), TX);
    await prisma.$transaction((tx) => reverseOtherMaterialJobDocument(tx, { documentId: i1.document.id, reason: "Issued the wrong quantity", actor: owner(), ...FY }), TX);
    expect(d2((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job } })).stockMaterialWipCost)).toBe("0.00");
    expect(await stockOf(m.id)).toEqual(["5.000", "125.00"]);
    // Used after purchase → refused with the exact document; the later, unused purchase cancels.
    const i2 = await issue(job, [{ itemId: m.id, quantity: "1" }]);
    expect(await prisma.$transaction((tx) => otherMaterialPurchaseCancelBlock(tx, p.purchase.id), TX)).toContain(i2.document.documentCode);
    await expect(prisma.$transaction((tx) => cancelOtherMaterialPurchase(tx, { purchaseId: unused.purchase.id, reason: "Entered against the wrong supplier", actor: owner(), ...FY }), TX)).rejects.toThrow(/was used after this purchase/);
    await prisma.$transaction((tx) => reverseOtherMaterialJobDocument(tx, { documentId: i2.document.id, reason: "Not needed after all", actor: owner(), ...FY }), TX);
    const c = await prisma.$transaction((tx) => cancelOtherMaterialPurchase(tx, { purchaseId: unused.purchase.id, reason: "Entered against the wrong supplier", actor: owner(), ...FY }), TX);
    expect(c.status).toBe("CANCELLED");
    expect(await stockOf(m.id)).toEqual(["4.000", "100.00"]);
    // A receipt consumed it → the issue can no longer be reversed.
    const i3 = await issue(job, [{ itemId: m.id, quantity: "1" }]);
    await receive(job);
    await expect(prisma.$transaction((tx) => reverseOtherMaterialJobDocument(tx, { documentId: i3.document.id, reason: "Too late to undo this", actor: owner(), ...FY }), TX)).rejects.toThrow(/already carried this material into its pieces/);
    await reconciled();
  });

  it("a job holding material cannot be cancelled until it is returned", async () => {
    const m = await item("Cancel", "PCS");
    await buy([{ itemId: m.id, quantity: "2", rate: "10" }]);
    const job = await newJob("To cancel");
    await issue(job, [{ itemId: m.id, quantity: "2" }]);
    await expect(prisma.$transaction((tx) => cancelJewelleryJob(tx, { jobId: job, cancelledByUserId: ownerId, cancellationReason: "Customer cancelled", ...FY }), TX)).rejects.toThrow(/still holds issued Other Material/);
    await giveBack(job, [{ itemId: m.id, quantity: "2" }]);
    await expect(prisma.$transaction((tx) => cancelJewelleryJob(tx, { jobId: job, cancelledByUserId: ownerId, cancellationReason: "Customer cancelled", ...FY }), TX)).resolves.toBeTruthy();
    await reconciled();
  });
});

describe("Karigar-supplied material, legacy entries, Customer-gold reversal, Staff privacy", () => {
  it("Karigar-supplied material is paid once through the Karigar payable and never enters Company stock", async () => {
    const job = await newJob("Karigar stones");
    const stockBefore = await prisma.otherMaterialMovement.count();
    const ap0 = await ledger("2000", karigar);
    const r = await receive(job, { otherExpense: "250.00", karigarMaterialLines: [{ description: "His own CZ stones", quantity: "12", unit: "PCS", charge: "250.00" }] });
    expect(await prisma.jewelleryReceiptKarigarMaterialLine.count({ where: { receiptId: r.receipt.id } })).toBe(1);
    expect(new Decimal(await ledger("2000", karigar)).minus(ap0).toFixed(2)).toBe("-350.00"); // labour 100 + material 250, once
    expect(await prisma.otherMaterialMovement.count()).toBe(stockBefore);
    await expect(receive(await newJob("Bad lines"), { otherExpense: "0", karigarMaterialLines: [{ description: "Stones", quantity: "1", unit: "PCS", charge: "10.00" }] })).rejects.toThrow(/must be part of the other expense/);
    await reconciled();
  });

  it("legacy free-text entries stay untouched and are listed as having no purchase / stock source", async () => {
    const job = await newJob("Legacy job");
    await seedLegacyOtherMaterial(prisma, { jobId: job, description: "Old enamel", quantity: 1, unit: "PCS", cost: "150.00", createdByUserId: ownerId });
    const before = await prisma.jewelleryOtherMaterialLine.findFirstOrThrow({ where: { jobId: job } });
    const list = await legacyOtherMaterialLines(prisma);
    expect(list.find((l) => l.id === before.id)).toMatchObject({ description: "Old enamel", cost: "150.00", source: "Manual (legacy) — no purchase / stock source" });
    expect(await prisma.jewelleryOtherMaterialLine.findUniqueOrThrow({ where: { id: before.id } })).toEqual(before);
  });

  it("reversing a Customer-gold receipt puts the consumed material back on the job", async () => {
    const m = await item("CG material", "PCS");
    await buy([{ itemId: m.id, quantity: "2", rate: "40" }]);
    await prisma.$transaction((tx) => receiveCustomerGold(tx, { customerId: customer, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: "1", deductionWeight: null, reason: "Customer's own gold", declaredValue: null, idempotencyKey: key("cg"), actor: owner() }), TX);
    await prisma.$transaction((tx) => postCustomerGoldTransfer(tx, { kind: "ISSUE_TO_KARIGAR", customerId: customer, karigarId: karigar, all: true, purityId: g24, finenessPercent: "99.900", entryDate: DATE, reason: "To Karigar", idempotencyKey: key("mv"), actor: owner() } as Parameters<typeof postCustomerGoldTransfer>[1]), TX);
    const job = await newJob("Customer ring with material", customer);
    await issue(job, [{ itemId: m.id, quantity: "2" }]); // 80.00
    const r = await prisma.$transaction(
      (tx) =>
        receiveWithCustomerGold(tx, {
          ...FY, jobId: job, receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "1.001", metalType: "GOLD", purityId: g24, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
          alloy: { includedGrossWeight: "0" }, labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0,
          markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("cgr"), createdByUserId: ownerId,
          customerGoldSource: { purityId: g24, finenessPercent: "99.900" }, actor: owner(),
        }),
      TX
    );
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: r.receipt.id } });
    expect([piece.ownership, d2(piece.materialCost)]).toEqual(["CUSTOMER", "80.00"]);
    await reconciled(); // 1340 includes the material
    await prisma.$transaction((tx) => reverseCustomerGoldJobReceipt(tx, { receiptId: r.receipt.id, reason: "Wrong weight entered at receipt", idempotencyKey: key("rev"), actor: owner(), ...FY }), TX);
    expect(d2((await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: job } })).stockMaterialWipCost)).toBe("80.00");
    expect((await jobHoldings(prisma, job)).get(m.id)?.quantity.toFixed(3)).toBe("2.000");
    await reconciled();
  });

  it("Staff data carries quantities only — no rate, cost or value", async () => {
    const stock = await listOtherMaterialStock(prisma, { includeCost: false });
    expect(stock.every((s) => s.stockValue === null && s.averageRate === null)).toBe(true);
    const job = (await prisma.otherMaterialJobDocument.findFirstOrThrow()).jobId;
    const panel = await getJobMaterialPanel(prisma, job, { includeCost: false });
    expect(panel!.totalCost).toBeNull();
    expect(panel!.holdings.every((h) => h.cost === null)).toBe(true);
    expect(panel!.documents.every((d) => d.total === null && d.lines.every((l) => l.cost === null) && !d.canReverse)).toBe(true);
  });
});
