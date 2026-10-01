/**
 * Receipt-charge persistence — the exact production case of ZL-JJOB-2026-000003
 * on the disposable scratch database only (the shared guard refuses anything
 * else). Proves (1) the Owner's posting preview is exactly what Save posts and
 * leaves nothing behind, and (2) Making ₹41,886 posts once, to the piece and to
 * the Karigar's payable, with the Customer's 26.455 g fine at ₹0.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { createPolishedPurchase } from "@/lib/diamond/polishedPurchase";
import { postCustomerGoldTransfer, receiveCustomerGold } from "@/lib/jewellery/customerGold";
import { receiveWithCustomerGold, type ReceiveWithCustomerGoldInput } from "@/lib/jewellery/customerGoldJobReceipt";
import { loadPoolInTx, placeBalance } from "@/lib/jewellery/customerGoldLedger";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { createJewelleryJob, issueMaterialsToJewelleryJob } from "@/lib/jewellery/posting";
import { chargesEcho, dryRunReceiptPosting } from "@/lib/jewellery/receiptPostingPreview";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-01T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };
let ownerId: string;
let customer: string;
let karigar: string;
let p24: string;
let p14: string;
let jobId: string;
let packetId: string;
let seq = 0;
const key = (label: string) => `rcp-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}
const purity = async (displayName: string, finenessPercent: string) =>
  (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType: "GOLD", displayName } },
      create: { metalType: "GOLD", displayName, finenessPercent, createdByUserId: ownerId },
      update: { finenessPercent, isActive: true },
    })
  ).id;

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  process.env.SESSION_SECRET ??= "receipt-charge-test-secret-0123456789abcdef";
  await clearAll();
  const party = async (name: string, type: "CUSTOMER" | "KARIGAR" | "SUPPLIER") => (await prisma.party.create({ data: { name, type, createdByUserId: ownerId } })).id;
  customer = await party("RCP YOGESHBHAI SAHYOG", "CUSTOMER");
  karigar = await party("RCP AMULAY JAWE", "KARIGAR");
  const supplier = await party("RCP Supplier", "SUPPLIER");
  p24 = await purity("RCP 24K", "100.000");
  p14 = await purity("RCP 14K", "60.000");
  // 30.000 g fine of the Customer's 24K; 26.455 g issued to the Karigar.
  await prisma.$transaction((tx) => receiveCustomerGold(tx, { customerId: customer, intakeDate: DATE, purityId: p24, inputBasis: "GROSS", weight: "30", reason: "dagina mate", idempotencyKey: key("in"), actor: owner() }), TX);
  await prisma.$transaction(
    (tx) => postCustomerGoldTransfer(tx, { kind: "ISSUE_TO_KARIGAR", customerId: customer, purityId: p24, finenessPercent: "100.000", karigarId: karigar, fineWeight: "26.455", entryDate: DATE, reason: "Gold for the job", idempotencyKey: key("iss"), actor: owner() }),
    TX
  );
  // The diamond packet: 26 pcs / 13.269 ct at ₹60,807.78.
  const bought = await prisma.$transaction(
    (tx) =>
      createPolishedPurchase(tx, {
        ...FY, purchaseDate: DATE, supplierId: supplier, currencyCode: "INR", exchangeRate: 1, supplierAmount: "60807.78",
        gstTreatment: "NONE", brokerageTreatment: "NONE", idempotencyKey: key("pp"), createdByUserId: ownerId,
        lines: [{ shape: "ROUND", sizeLabel: "1.00-1.10", pieces: 26, carat: "13.269", rateBasis: "PER_CARAT", rate: "4582.68" }],
      }),
    TX
  );
  packetId = bought.packets[0].id;
  jobId = (await prisma.$transaction((tx) => createJewelleryJob(tx, { customerId: customer, jewelleryType: "BRACELET", designName: "ZL-BRC-005", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }), TX)).id;
  await prisma.$transaction(
    (tx) => issueMaterialsToJewelleryJob(tx, { ...FY, jobId, issueDate: DATE, metalLines: [], polishedDiamondIds: [], packetLines: [{ packetId, pieces: 26, carat: "13.269" }], otherMaterialLines: [], idempotencyKey: key("im"), createdByUserId: ownerId }),
    TX
  );
}, 90_000);

afterAll(async () => {
  await clearAll();
});

/** The receipt exactly as the form now submits it: Making ₹41,886 from state, section collapsed or not. */
function exactReceipt(over: Partial<ReceiveWithCustomerGoldInput> = {}): ReceiveWithCustomerGoldInput {
  return {
    ...FY,
    jobId,
    receiveDate: DATE,
    outputs: [{ jewelleryType: "BRACELET", quantity: 1, grossWeight: "46.880", netMetalWeight: "44.091", metalType: "GOLD", purityId: p14, diamondIds: [], qcStatus: "PASSED" }],
    diamondResolutions: [],
    packetResolutions: [{ packetId, resolution: "SET", pieces: 26, carat: "13.269", setInOutputIndex: 0 }],
    returnedMetalLines: [],
    scrapMetalLines: [],
    karigarAddedFineWeight: 0,
    karigarAddedCost: 0,
    alloy: { includedGrossWeight: "17.636" },
    labourCharge: "0",
    makingCharge: "41886",
    settingCharge: "0",
    platingCharge: "0",
    otherExpense: "0",
    markJobComplete: true,
    isAbnormalLoss: false,
    damagedLostByUserId: ownerId,
    idempotencyKey: key("rcv"),
    createdByUserId: ownerId,
    customerGoldSource: { purityId: p24, finenessPercent: "100.000" },
    actor: owner(),
    ...over,
  };
}
async function worldState() {
  const [entries, vouchers, journal, receipts, pieces, resolutions, packetMoves, sequences] = await Promise.all([
    prisma.customerGoldEntry.count(),
    prisma.voucher.count(),
    prisma.journalEntry.count(),
    prisma.jewelleryReceipt.count(),
    prisma.finishedJewellery.count(),
    prisma.jewelleryPacketResolution.count(),
    prisma.polishedPacketMovement.count(),
    prisma.jewellerySequence.findMany({ orderBy: { sequenceType: "asc" } }),
  ]);
  const job = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: jobId } });
  return { entries, vouchers, journal, receipts, pieces, resolutions, packetMoves, sequences: JSON.stringify(sequences.map((x) => [x.sequenceType, x.lastNumber])), job: [job.status, String(job.totalLabourCharge), String(job.remainingWipCost)] };
}
const EXPECTED_LINES = [
  { accountCode: "1340", debit: "102693.78", credit: "0.00" },
  { accountCode: "1320", debit: "0.00", credit: "60807.78" },
  { accountCode: "2000", debit: "0.00", credit: "41886.00" },
];

describe("receipt charges: exact production case ZL-JJOB-2026-000003", () => {
  it("charges echo: the Making ₹41,886 the form sent, every category and the total", () => {
    expect(chargesEcho({ labourCharge: "0", makingCharge: "41886", settingCharge: "", platingCharge: undefined, otherExpense: "0" })).toEqual({
      labour: "0.00", making: "41886.00", setting: "0.00", plating: "0.00", other: "0.00", total: "41886.00",
    });
  });

  it("the Owner's posting preview is exactly the expected entry and writes NOTHING (dry run rolled back)", async () => {
    const before = await worldState();
    const preview = await dryRunReceiptPosting(prisma, (tx) => receiveWithCustomerGold(tx, exactReceipt({ expectedFingerprint: null })));
    expect(preview.lines.map((l) => ({ accountCode: l.accountCode, debit: l.debit, credit: l.credit }))).toEqual(EXPECTED_LINES);
    expect(preview.lines.find((l) => l.accountCode === "2000")?.party).toBe("RCP AMULAY JAWE");
    expect([preview.materials, preview.charges, preview.customerGoldCost, preview.customerGoldFine, preview.totalCompanyCost, preview.balanced]).toEqual([
      "60807.78", "41886.00", "0.00", "26.455", "102693.78", true,
    ]);
    expect(await worldState()).toEqual(before);
  });

  it("Save posts Making ₹41,886 once: piece ₹1,02,693.78, Dr 1340 / Cr 1320 / Cr 2000, balanced; Customer gold 26.455 g at ₹0", async () => {
    const r = await prisma.$transaction((tx) => receiveWithCustomerGold(tx, exactReceipt()), TX);
    const receipt = await prisma.jewelleryReceipt.findUniqueOrThrow({ where: { id: r.receipt.id } });
    expect([receipt.labourCharge, receipt.makingCharge, receipt.settingCharge, receipt.platingCharge, receipt.otherExpense].map((d) => new Decimal(d).toFixed(2))).toEqual([
      "0.00", "41886.00", "0.00", "0.00", "0.00",
    ]);
    const lines = await prisma.journalEntry.findMany({ where: { voucherId: receipt.postingVoucherId! }, include: { account: true, party: true } });
    const shaped = lines
      .filter((l) => !new Decimal(l.debit).isZero() || !new Decimal(l.credit).isZero())
      .map((l) => ({ accountCode: l.account.code, debit: new Decimal(l.debit).toFixed(2), credit: new Decimal(l.credit).toFixed(2) }));
    expect(shaped.sort((a, b) => a.accountCode.localeCompare(b.accountCode))).toEqual([...EXPECTED_LINES].sort((a, b) => a.accountCode.localeCompare(b.accountCode)));
    expect(lines.reduce((s, l) => s.plus(l.debit), new Decimal(0)).toFixed(2)).toBe(lines.reduce((s, l) => s.plus(l.credit), new Decimal(0)).toFixed(2));
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: receipt.id } });
    expect([piece.fineMetalWeight, piece.customerGoldFineWeight, piece.metalCost, piece.diamondCost, piece.labourAllocated, piece.totalCost].map(String)).toEqual([
      "26.455", "26.455", "0", "60807.78", "41886", "102693.78",
    ]);
    const job = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: jobId } });
    expect([job.status, new Decimal(job.totalLabourCharge).toFixed(2), new Decimal(job.issuedPacketDiamondCost).toFixed(2)]).toEqual(["COMPLETED", "41886.00", "60807.78"]);
    const pool = await prisma.$transaction((tx) => loadPoolInTx(tx, { customerId: customer, metalType: "GOLD", purityId: p24, finenessPercentSnapshot: new Decimal("100.000") }), TX);
    expect([placeBalance(pool, { location: "KARIGAR", scopeId: karigar }).fine.toFixed(3), placeBalance(pool, { location: "SAFE", scopeId: null }).fine.toFixed(3)]).toEqual(["0.000", "3.545"]);
    expect(await prisma.metalStockMovement.count({ where: { jewelleryJobId: jobId } })).toBe(0);
    const rec = await reconcileMetalLedger(prisma);
    for (const l of rec.lines) expect({ account: l.accountCode, difference: l.difference.toFixed(2) }).toEqual({ account: l.accountCode, difference: "0.00" });
  });

  it("a genuinely blank charge section still saves ₹0 (dry run shows no Karigar payable)", async () => {
    const preview = await dryRunReceiptPosting(prisma, async () => ({ receipt: { postingVoucherId: null }, outputs: [] }));
    expect([preview.lines, preview.totalCompanyCost]).toEqual([[], "0.00"]);
    expect(chargesEcho({ labourCharge: "0", makingCharge: "0", settingCharge: "0", platingCharge: "0", otherExpense: "0" }).total).toBe("0.00");
  });

  it("a failure inside the dry run is reported, never swallowed, and still writes nothing", async () => {
    const before = await worldState();
    await expect(dryRunReceiptPosting(prisma, async () => Promise.reject(new Error("boom inside preview")))).rejects.toThrow("boom inside preview");
    expect(await worldState()).toEqual(before);
  });
});
