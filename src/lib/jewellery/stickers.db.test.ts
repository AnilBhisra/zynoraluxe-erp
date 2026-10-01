/**
 * Finished-piece stickers on the disposable scratch database only (shared
 * guard): every piece state a sticker can meet, built through the real
 * posting functions, and proof that loading / printing / reprinting stickers
 * writes nothing at all.
 */
import "dotenv/config";

import jsQR from "jsqr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db/prisma";
import { createPolishedPurchase } from "@/lib/diamond/polishedPurchase";
import { postCustomerGoldTransfer, receiveCustomerGold } from "@/lib/jewellery/customerGold";
import { deliverCustomerJewellery } from "@/lib/jewellery/customerGoldCommercial";
import { receiveWithCustomerGold } from "@/lib/jewellery/customerGoldJobReceipt";
import { reverseCustomerGoldJobReceipt } from "@/lib/jewellery/customerGoldReceiptReversal";
import { postFinishedJewellerySale, returnFinishedJewelleryItems } from "@/lib/jewellery/finishedSalesPosting";
import { createJewelleryJob, issueMaterialsToJewelleryJob, postOpeningMetalStock, receiveFinishedJewellery } from "@/lib/jewellery/posting";
import { loadPieceSticker, loadPieceStickers, qrMatrix, type PieceSticker } from "@/lib/jewellery/stickers";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-01T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };
let ownerId: string;
let karigar: string;
let customer: string;
let gold: string;
let p24: string;
let p14: string;
let seq = 0;
const key = (label: string) => `stk-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const codes: Record<string, string> = {};

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

/** Every business table's row count and content hash — the "nothing changed" proof. */
async function worldFingerprint(): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ line: string }[]>(
    `select table_name || '|' || (xpath('/row/c/text()', x))[1]::text || '|' || (xpath('/row/h/text()', x))[1]::text as line
     from (select table_name, query_to_xml(format('select count(*) as c, md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) as h from public.%I t', table_name), false, true, '') as x
           from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE') z order by 1`
  );
  return rows.map((r) => r.line).join("\n");
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  process.env.SESSION_SECRET ??= "sticker-test-secret-0123456789abcdef";
  await clearAll();
  const party = async (name: string, type: "CUSTOMER" | "KARIGAR" | "SUPPLIER") => (await prisma.party.create({ data: { name, type, createdByUserId: ownerId } })).id;
  karigar = await party("STK AMULAY JAWE", "KARIGAR");
  customer = await party("STK YOGESHBHAI SAHYOG", "CUSTOMER");
  const buyer = await party("STK Walk-in Buyer", "CUSTOMER");
  const supplier = await party("STK Supplier", "SUPPLIER");
  gold = await purity("STK 22K", "91.600");
  p24 = await purity("STK 24K", "100.000");
  p14 = await purity("STK 14K", "60.000");

  // Company job: one receipt with TWO pieces (one gross weight recorded, one not).
  await prisma.$transaction((tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: gold, grossWeight: "50", costValue: "300000", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }), TX);
  const job = await prisma.$transaction(
    (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "STK Twin rings", karigarId: karigar, issueDate: DATE, quantity: 2, createdByUserId: ownerId, idempotencyKey: key("job") }),
    TX
  );
  await prisma.$transaction(
    (tx) =>
      issueMaterialsToJewelleryJob(tx, {
        legacyDirectGoldIssue: true, jobId: job.id, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId: gold, grossWeight: "10" }],
        polishedDiamondIds: [], otherMaterialLines: [], ...FY, createdByUserId: ownerId, idempotencyKey: key("issue"),
      }),
    TX
  );
  const rcv = await prisma.$transaction(
    (tx) =>
      receiveFinishedJewellery(tx, {
        ...FY, jobId: job.id, receiveDate: DATE,
        outputs: [
          { jewelleryType: "RING", quantity: 1, grossWeight: "5.210", netMetalWeight: "5.000", metalType: "GOLD", purityId: gold, diamondIds: [], qcStatus: "PASSED" },
          { jewelleryType: "RING", quantity: 1, netMetalWeight: "5.000", metalType: "GOLD", purityId: gold, diamondIds: [], qcStatus: "PASSED" },
        ],
        diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
        labourCharge: "1000", makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0,
        markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
      }),
    TX
  );
  codes.companyReceipt = rcv.receipt.receiptCode;
  const [ringA, ringB] = await prisma.finishedJewellery.findMany({ where: { receiptId: rcv.receipt.id }, orderBy: { finishedCode: "asc" } });
  codes.ringA = ringA.finishedCode;
  codes.ringB = ringB.finishedCode;

  // Customer Gold job with a diamond packet: received, reversed, received again, then a second Customer piece delivered.
  await prisma.$transaction((tx) => receiveCustomerGold(tx, { customerId: customer, intakeDate: DATE, purityId: p24, inputBasis: "GROSS", weight: "60", reason: "dagina mate", idempotencyKey: key("in"), actor: owner() }), TX);
  await prisma.$transaction(
    (tx) => postCustomerGoldTransfer(tx, { kind: "ISSUE_TO_KARIGAR", customerId: customer, purityId: p24, finenessPercent: "100.000", karigarId: karigar, fineWeight: "55", entryDate: DATE, reason: "Gold for the jobs", idempotencyKey: key("iss"), actor: owner() }),
    TX
  );
  const bought = await prisma.$transaction(
    (tx) =>
      createPolishedPurchase(tx, {
        ...FY, purchaseDate: DATE, supplierId: supplier, currencyCode: "INR", exchangeRate: 1, supplierAmount: "60807.78",
        gstTreatment: "NONE", brokerageTreatment: "NONE", idempotencyKey: key("pp"), createdByUserId: ownerId,
        lines: [{ shape: "ROUND", sizeLabel: "1.00-1.10", pieces: 26, carat: "13.269", rateBasis: "PER_CARAT", rate: "4582.68" }],
      }),
    TX
  );
  const packetId = bought.packets[0].id;
  const cgJob = await prisma.$transaction(
    (tx) => createJewelleryJob(tx, { customerId: customer, jewelleryType: "BRACELET", designName: "ZL-BRC-005", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("cgjob") }),
    TX
  );
  await prisma.$transaction(
    (tx) => issueMaterialsToJewelleryJob(tx, { ...FY, jobId: cgJob.id, issueDate: DATE, metalLines: [], polishedDiamondIds: [], packetLines: [{ packetId, pieces: 26, carat: "13.269" }], otherMaterialLines: [], idempotencyKey: key("im"), createdByUserId: ownerId }),
    TX
  );
  const cgReceive = (grossWeight?: string) =>
    prisma.$transaction(
      (tx) =>
        receiveWithCustomerGold(tx, {
          ...FY, jobId: cgJob.id, receiveDate: DATE,
          outputs: [{ jewelleryType: "BRACELET", quantity: 1, ...(grossWeight ? { grossWeight } : {}), netMetalWeight: "44.091", metalType: "GOLD", purityId: p14, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [], packetResolutions: [{ packetId, resolution: "SET", pieces: 26, carat: "13.269", setInOutputIndex: 0 }],
          returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0, alloy: { includedGrossWeight: "17.636" },
          labourCharge: "0", makingCharge: "41886", settingCharge: "0", platingCharge: "0", otherExpense: "0",
          markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("cgrcv"), createdByUserId: ownerId,
          customerGoldSource: { purityId: p24, finenessPercent: "100.000" }, actor: owner(),
        }),
      TX
    );
  const first = await cgReceive("46.880");
  codes.reversedPiece = (await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: first.receipt.id } })).finishedCode;
  await prisma.$transaction((tx) => reverseCustomerGoldJobReceipt(tx, { receiptId: first.receipt.id, reason: "Making charge was not saved", idempotencyKey: key("rev"), actor: owner(), ...FY }), TX);
  const second = await cgReceive();
  codes.cgReceipt = second.receipt.receiptCode;
  codes.awaitingPiece = (await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: second.receipt.id } })).finishedCode;

  // A second Customer job, delivered.
  const delJob = await prisma.$transaction(
    (tx) => createJewelleryJob(tx, { customerId: customer, jewelleryType: "RING", designName: "STK delivered ring", karigarId: karigar, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("deljob") }),
    TX
  );
  const delRcv = await prisma.$transaction(
    (tx) =>
      receiveWithCustomerGold(tx, {
        ...FY, jobId: delJob.id, receiveDate: DATE,
        outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "4.000", metalType: "GOLD", purityId: p24, diamondIds: [], qcStatus: "PASSED" }],
        diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
        labourCharge: 0, makingCharge: "500", settingCharge: 0, platingCharge: 0, otherExpense: 0,
        markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("delrcv"), createdByUserId: ownerId,
        customerGoldSource: { purityId: p24, finenessPercent: "100.000" }, actor: owner(),
      }),
    TX
  );
  codes.deliveredPiece = (await prisma.finishedJewellery.findFirstOrThrow({ where: { receiptId: delRcv.receipt.id } })).finishedCode;
  await prisma.$transaction((tx) => deliverCustomerJewellery(tx, { jobId: delJob.id, deliveryDate: DATE, receivedByName: "Customer", idempotencyKey: key("dlv"), actor: owner(), ...FY }), TX);

  // Ring A sold; ring B sold and returned damaged.
  const sale = (finishedJewelleryId: string) =>
    prisma.$transaction((tx) =>
      postFinishedJewellerySale(tx, {
        date: DATE, saleDate: DATE, ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: ownerId, customerId: buyer, gstTreatment: "NONE",
        idempotencyKey: key("sale"), items: [{ finishedJewelleryId, sellingPrice: "50000.00", gstRatePercent: 0, taxType: "EXCLUSIVE" }],
      })
    );
  await sale(ringA.id);
  const sold = await sale(ringB.id);
  const line = await prisma.finishedJewellerySaleLine.findFirstOrThrow({ where: { saleId: sold.sale.id } });
  await prisma.$transaction((tx) =>
    returnFinishedJewelleryItems(tx, { ...FY, saleId: sold.sale.id, items: [{ saleLineId: line.id, disposition: "DAMAGED" }], reason: "Stone fell out", returnDate: DATE, createdByUserId: ownerId, idempotencyKey: key("ret") })
  );
}, 180_000);

afterAll(async () => {
  await clearAll();
});

const one = async (code: string) => (await prisma.$transaction((tx) => loadPieceSticker(tx, code), TX))!;

describe("stickers — one per saved piece, status from the saved record", () => {
  it("a multi-piece receipt gives exactly one sticker per piece, in code order", async () => {
    const s = await prisma.$transaction((tx) => loadPieceStickers(tx, { receiptCode: codes.companyReceipt }), TX);
    expect(s.map((x) => x.finishedCode)).toEqual([codes.ringA, codes.ringB]);
    expect(s.every((x) => x.receiptCode === codes.companyReceipt && x.jobCode.startsWith("ZL-JJOB-"))).toBe(true);
  });

  it("company pieces: gross printed when recorded, 'not recorded' (null) when not; sold and returned-damaged are not active", async () => {
    const [a, b] = [await one(codes.ringA), await one(codes.ringB)];
    expect([a.grossWeight, a.netWeight, a.fineWeight, a.metalLabel, a.category, a.designName]).toEqual(["5.210", "5.000", "4.580", "Gold STK 22K (91.600%)", "Ring", "STK Twin rings"]);
    expect(b.grossWeight).toBeNull();
    expect([a.statusLabel, a.active]).toEqual(["SOLD — NOT IN STOCK", false]);
    expect([b.statusLabel, b.active]).toEqual(["RETURNED DAMAGED — NOT IN STOCK", false]);
    expect([a.customerName, a.karigarName]).toEqual([null, "STK AMULAY JAWE"]);
  });

  it("Customer Gold piece awaiting delivery: labelled, Customer named, packet stones counted (26 pcs / 13.269 ct)", async () => {
    const s = await one(codes.awaitingPiece);
    expect([s.statusLabel, s.active, s.customerName, s.stonePieces, s.stoneCarat, s.grossWeight]).toEqual([
      "CUSTOMER GOLD — AWAITING DELIVERY",
      true,
      "STK YOGESHBHAI SAHYOG",
      26,
      "13.269",
      null,
    ]);
    const viaReceipt = await prisma.$transaction((tx) => loadPieceStickers(tx, { receiptCode: codes.cgReceipt }), TX);
    expect(viaReceipt.map((x) => x.finishedCode)).toEqual([codes.awaitingPiece]);
  });

  it("a reversed receipt's piece prints as RECEIPT REVERSED — NOT ACTIVE (its stones went back to the job)", async () => {
    const s = await one(codes.reversedPiece);
    expect([s.statusLabel, s.active, s.stonePieces, s.grossWeight]).toEqual(["RECEIPT REVERSED — NOT ACTIVE", false, 0, "46.880"]);
  });

  it("a delivered Customer piece prints as DELIVERED", async () => {
    const s = await one(codes.deliveredPiece);
    expect([s.statusLabel, s.active]).toEqual(["DELIVERED", false]);
  });

  it("piece codes may be listed directly; unknown codes are ignored", async () => {
    const s = await prisma.$transaction((tx) => loadPieceStickers(tx, { pieceCodes: [codes.ringB, "ZL-FJ-NOPE", codes.ringA, codes.ringA] }), TX);
    expect(s.map((x) => x.finishedCode)).toEqual([codes.ringA, codes.ringB]);
  });
});

describe("stickers — privacy and QR", () => {
  it("the sticker payload has no cost, value, price or ₹ — the same for Owner and Staff", async () => {
    const all = await prisma.$transaction((tx) => loadPieceStickers(tx, { pieceCodes: Object.values(codes).filter((c) => c.startsWith("ZL-FJ-")) }), TX);
    const keys: (keyof PieceSticker)[] = [
      "finishedCode", "jobCode", "receiptCode", "category", "designName", "metalLabel", "netWeight", "grossWeight", "fineWeight",
      "stonePieces", "stoneCarat", "customerName", "karigarName", "receiptDate", "statusLabel", "active", "lookupPath",
    ];
    for (const s of all) expect(Object.keys(s).sort()).toEqual([...keys].sort());
    const json = JSON.stringify(all);
    expect(json).not.toMatch(/cost|price|value|₹|41886|60807|50000/i);
  });

  it("the QR decodes to the authenticated piece page by code — no id, no token", async () => {
    const s = await one(codes.awaitingPiece);
    const row = await prisma.finishedJewellery.findUniqueOrThrow({ where: { finishedCode: codes.awaitingPiece }, select: { id: true } });
    const url = `https://erp.example.test${s.lookupPath}`;
    const m = qrMatrix(url);
    const scale = 4;
    const quiet = 4;
    const side = (m.size + 2 * quiet) * scale;
    const px = new Uint8ClampedArray(side * side * 4).fill(255);
    for (let y = 0; y < m.size; y++)
      for (let x = 0; x < m.size; x++)
        if (m.dark[y * m.size + x])
          for (let dy = 0; dy < scale; dy++)
            for (let dx = 0; dx < scale; dx++) {
              const i = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4;
              px[i] = px[i + 1] = px[i + 2] = 0;
            }
    expect(jsQR(px, side, side)?.data).toBe(`https://erp.example.test/p/${codes.awaitingPiece}`);
    expect(url).not.toContain(row.id);
    expect(url).not.toMatch(/token|session|secret/i);
  });
});

describe("stickers — printing and reprinting change nothing", () => {
  it("loading every sticker (print and reprint) leaves every table byte-identical", async () => {
    const before = await worldFingerprint();
    for (let i = 0; i < 2; i++) {
      await prisma.$transaction((tx) => loadPieceStickers(tx, { receiptCode: codes.companyReceipt }), TX);
      await prisma.$transaction((tx) => loadPieceStickers(tx, { receiptCode: codes.cgReceipt }), TX);
      for (const c of Object.values(codes).filter((x) => x.startsWith("ZL-FJ-"))) await one(c);
    }
    expect(await worldFingerprint()).toBe(before);
  });
});
