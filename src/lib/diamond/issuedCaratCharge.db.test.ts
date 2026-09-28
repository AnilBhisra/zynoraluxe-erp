/**
 * Real-database acceptance for the "per issued carat" Manufacturer charge.
 *
 * Runs against the isolated test database only (refuses anything else).
 * Reproduces the reported Polishing job — 10.190 ct issued, 6 stones /
 * 5.091 ct received as a parcel, ₹850/ct — under both bases, then partial
 * receipts with unused rough returned, and a rough-returning process.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { createRoughLotWithPieces, issueRoughToKarigar, receivePolishedDiamonds, receiveProcessedRough } from "./posting";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-28T00:00:00.000Z");
const TX = { timeout: 20_000, maxWait: 15_000 };

let ownerId: string;
let supplierId: string;
let manufacturerId: string;
let polishingId: string;
let hphtId: string;

async function clearDiamondData() {
  const [lots, jobs, receipts] = await Promise.all([
    prisma.roughLot.findMany({ select: { voucherId: true } }),
    prisma.diamondJob.findMany({ select: { wipVoucherId: true } }),
    prisma.polishedReceipt.findMany({ select: { postingVoucherId: true } }),
  ]);
  const voucherIds = [...lots.map((l) => l.voucherId), ...jobs.map((j) => j.wipVoucherId), ...receipts.map((r) => r.postingVoucherId)].filter(
    (id): id is string => !!id
  );
  const reversals = voucherIds.length ? await prisma.voucher.findMany({ where: { reversalOfVoucherId: { in: voucherIds } }, select: { id: true } }) : [];
  const all = [...voucherIds, ...reversals.map((r) => r.id)];
  await prisma.polishedPacketMovement.deleteMany({ where: { packet: { sourceDiamondJobId: { not: null } } } });
  await prisma.polishedPacket.deleteMany({ where: { sourceDiamondJobId: { not: null } } });
  await prisma.stockMovement.deleteMany({ where: { OR: [{ roughPieceId: { not: null } }, { polishedDiamondId: { not: null } }, { diamondJobId: { not: null } }] } });
  await prisma.polishedDiamond.deleteMany();
  await prisma.diamondJobPiece.deleteMany();
  await prisma.roughPiece.deleteMany();
  await prisma.polishedReceipt.deleteMany();
  await prisma.diamondJob.deleteMany();
  await prisma.roughLot.deleteMany();
  if (all.length) {
    await prisma.journalEntry.deleteMany({ where: { voucherId: { in: all } } });
    await prisma.voucher.deleteMany({ where: { id: { in: reversals.map((r) => r.id) } } });
    await prisma.voucher.deleteMany({ where: { id: { in: voucherIds } } });
  }
}

async function payable(partyId: string): Promise<string> {
  const account = await prisma.account.findUniqueOrThrow({ where: { code: "2000" } });
  const t = await prisma.journalEntry.aggregate({ where: { accountId: account.id, partyId }, _sum: { debit: true, credit: true } });
  return new Decimal(t._sum.credit ?? 0).minus(t._sum.debit ?? 0).toFixed(2);
}

/** One rough stone of `carat` at total `cost`, straight to the manufacturer under a process + basis. */
async function stoneToJob(carat: string, cost: string, processId: string, basis: "PER_CARAT" | "PER_ISSUED_CARAT", rate: number, key: string) {
  const lot = await prisma.$transaction(
    (tx) =>
      createRoughLotWithPieces(tx, {
        ...FY, purchaseDate: DATE, supplierId, purchaseRate: 1, rateBasis: "FIXED_TOTAL", currencyCode: "INR", exchangeRate: 1,
        totalPurchaseCost: cost, gstTreatment: "NONE", idempotencyKey: `${key}-buy`, createdByUserId: ownerId,
        pieces: [{ carat }],
      }),
    TX
  );
  const piece = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
  return prisma.$transaction(
    (tx) =>
      issueRoughToKarigar(tx, {
        ...FY, karigarId: manufacturerId, roughPieceIds: [piece.id], requiredShape: "ELONGATED_CUSHION", issueDate: DATE,
        processId, chargeRateBasis: basis, chargeRate: rate, idempotencyKey: `${key}-issue`, createdByUserId: ownerId,
      }),
    TX
  );
}

function receive(jobId: string, opts: { outputs: { carat: string; pieceCount?: number }[]; returned?: string; complete: boolean; key: string }) {
  return prisma.$transaction(
    (tx) =>
      receivePolishedDiamonds(tx, {
        ...FY, jobId, receiveDate: DATE, returnedRoughCarat: opts.returned ?? 0, labourCharge: 0, shape: "ELONGATED_CUSHION",
        markJobComplete: opts.complete, idempotencyKey: opts.key, createdByUserId: ownerId,
        outputs: opts.outputs.map((o) =>
          o.pieceCount ? { kind: "PARCEL" as const, pieceCount: o.pieceCount, shape: "ELONGATED_CUSHION" as const, carat: o.carat } : { shape: "ELONGATED_CUSHION" as const, carat: o.carat }
        ),
      }),
    TX
  );
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>(
    "select current_database() db, current_user usr, inet_server_port() port"
  );
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearDiamondData();
  const party = async (id: string, name: string, type: "SUPPLIER" | "MANUFACTURER") =>
    (await prisma.party.upsert({ where: { id }, create: { id, name, type, createdByUserId: ownerId }, update: {} })).id;
  supplierId = await party("ic-supplier", "Issued-Carat Supplier", "SUPPLIER");
  manufacturerId = await party("ic-manufacturer", "Issued-Carat Manufacturer", "MANUFACTURER");
  polishingId = (await prisma.diamondProcess.findFirstOrThrow({ where: { outputKind: "POLISHED", isActive: true } })).id;
  hphtId = (await prisma.diamondProcess.findFirstOrThrow({ where: { outputKind: "ROUGH", isActive: true } })).id;
}, 60_000);

afterAll(async () => {
  await clearDiamondData();
});

describe("the reported Polishing job: 10.190 ct issued -> 6 stones / 5.091 ct @ ₹850", () => {
  it("per ISSUED carat charges 10.190 × 850 = ₹8,661.50 and the parcel carries it", async () => {
    const job = await stoneToJob("10.190", "16299.75", polishingId, "PER_ISSUED_CARAT", 850, "ic-reported");
    const payableBefore = await payable(manufacturerId);
    const { receipt } = await receive(job.id, { outputs: [{ carat: "5.091", pieceCount: 6 }], complete: true, key: "ic-reported-rec" });
    expect(new Decimal(receipt.labourCharge).toFixed(2)).toBe("8661.50");
    expect(new Decimal(receipt.weightLossCarat).toFixed(3)).toBe("5.099");
    const packet = await prisma.polishedPacket.findFirstOrThrow({ where: { sourceReceiptId: receipt.id }, include: { movements: true } });
    expect(packet.movements).toHaveLength(1);
    expect(new Decimal(packet.movements[0].costValue).toFixed(2)).toBe("24961.25"); // 16,299.75 + 8,661.50
    expect(new Decimal(await payable(manufacturerId)).minus(payableBefore).toFixed(2)).toBe("8661.50");
    const done = await prisma.diamondJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(new Decimal(done.totalLabourCharge).toFixed(2)).toBe("8661.50");
    expect(done.chargeRateBasis).toBe("PER_ISSUED_CARAT");
  });

  it("per RECEIVED carat is unchanged: 5.091 × 850 = ₹4,327.35 (what production posted)", async () => {
    const job = await stoneToJob("10.190", "16299.75", polishingId, "PER_CARAT", 850, "ic-old");
    const { receipt } = await receive(job.id, { outputs: [{ carat: "5.091", pieceCount: 6 }], complete: true, key: "ic-old-rec" });
    expect(new Decimal(receipt.labourCharge).toFixed(2)).toBe("4327.35");
    const packet = await prisma.polishedPacket.findFirstOrThrow({ where: { sourceReceiptId: receipt.id }, include: { movements: true } });
    expect(new Decimal(packet.movements[0].costValue).toFixed(2)).toBe("20627.10");
  });
});

describe("per issued carat over several receipts", () => {
  it("partial receipt charges what came back; the closing one adds the loss; unused rough returned is never charged", async () => {
    const job = await stoneToJob("10.000", "10000", polishingId, "PER_ISSUED_CARAT", 100, "ic-partial");
    const { receipt: r1 } = await receive(job.id, { outputs: [{ carat: "2.000" }], complete: false, key: "ic-partial-1" });
    expect(new Decimal(r1.labourCharge).toFixed(2)).toBe("200.00");
    // pending 8.000: 2.500 polished + 1.000 rough returned unused + 4.500 loss
    const { receipt: r2 } = await receive(job.id, { outputs: [{ carat: "2.500" }], returned: "1.000", complete: true, key: "ic-partial-2" });
    expect(new Decimal(r2.weightLossCarat).toFixed(3)).toBe("4.500");
    expect(new Decimal(r2.labourCharge).toFixed(2)).toBe("700.00"); // (2.5 + 4.5) × 100
    const done = await prisma.diamondJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(new Decimal(done.totalLabourCharge).toFixed(2)).toBe("900.00"); // (10 issued − 1 returned unused) × 100
  });

  it("a rough-returning process (e.g. 4P / HPHT) charges the whole issued carat including loss", async () => {
    const job = await stoneToJob("19.980", "11988", hphtId, "PER_ISSUED_CARAT", 325, "ic-rough");
    const { receipt } = await prisma.$transaction(
      (tx) =>
        receiveProcessedRough(tx, {
          ...FY, jobId: job.id, receiveDate: DATE, pieces: [{ carat: "10.190" }], markJobComplete: true,
          idempotencyKey: "ic-rough-rec", createdByUserId: ownerId,
        }),
      TX
    );
    expect(new Decimal(receipt.labourCharge).toFixed(2)).toBe("6493.50"); // 19.980 × 325
  });
});
