/**
 * Real-database proof for the "Polished stock shows 0.000 ct" defect: a
 * direct Polished Diamond Purchase always creates a PolishedPacket, never a
 * PolishedDiamond stone (see createPolishedPurchase's own doc comment) — so
 * getPolishedStockSummary(), which used to read only `polishedDiamond`,
 * showed zero for every purchase-only or manufactured-packet-only shop,
 * even with real, unissued stock and a real supplier payable sitting in
 * Polished Diamond Inventory.
 *
 * Disposable scratch database only — the shared guard refuses anything else.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { createPolishedPurchase } from "@/lib/diamond/polishedPurchase";
import { createRoughLotWithPieces, issueRoughToKarigar, receivePolishedDiamonds } from "@/lib/diamond/posting";
import { getPolishedStockSummary } from "@/lib/diamond/reports";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-01T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let supplierId: string;
let seq = 0;
const key = (label: string) => `pss-${label}-${Date.now()}-${++seq}`;

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>(
    "select current_database() db, current_user usr, inet_server_port() port"
  );
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearAll();
  supplierId = (await prisma.party.create({ data: { name: "Polished Stock Summary Supplier", type: "SUPPLIER", createdByUserId: ownerId } })).id;
}, 60_000);

afterAll(async () => {
  await clearAll();
});

async function buyPacket(pieces: number, carat: string, rate: string) {
  return prisma.$transaction(
    (tx) =>
      createPolishedPurchase(tx, {
        ...FY,
        purchaseDate: DATE,
        supplierId,
        currencyCode: "INR",
        exchangeRate: 1,
        supplierAmount: new Decimal(rate).times(carat).toFixed(2),
        gstTreatment: "NONE",
        brokerageTreatment: "NONE",
        idempotencyKey: key("purchase"),
        createdByUserId: ownerId,
        lines: [{ shape: "ROUND", sizeLabel: "1.00-1.10", pieces, carat, rateBasis: "PER_CARAT", rate }],
      }),
    TX
  );
}

describe("getPolishedStockSummary includes packets, not only individual stones", () => {
  it("a direct purchase (which is ALWAYS a packet — see createPolishedPurchase) is counted: pieces, carat and cost all show", async () => {
    const before = await getPolishedStockSummary();
    await buyPacket(406, "2.570", "8000");
    const after = await getPolishedStockSummary();
    expect(after.totalCarat.minus(before.totalCarat).toFixed(3)).toBe("2.570");
    expect(after.totalCost.minus(before.totalCost).toFixed(2)).toBe("20560.00");
    expect(after.pieceCount - before.pieceCount).toBe(406);
  });

  it("a fully-issued (EMPTY) packet contributes zero, and a CANCELLED purchase's packet is excluded entirely", async () => {
    const before = await getPolishedStockSummary();
    const bought = await buyPacket(10, "1.000", "5000");
    const packet = bought.packets[0];
    // Drain it to EMPTY directly at the ledger level (issuing it out is
    // already proven elsewhere; here only the summary's own zero-net
    // behaviour for an EMPTY packet is under test).
    await prisma.polishedPacketMovement.create({
      data: { type: "JEWELLERY_ISSUE_OUT", packetId: packet.id, pieces: 10, carat: "1.000", costValue: "5000.00", sourceDocument: "test-drain", createdByUserId: ownerId },
    });
    await prisma.polishedPacket.update({ where: { id: packet.id }, data: { status: "EMPTY" } });
    const afterEmpty = await getPolishedStockSummary();
    expect(afterEmpty.totalCarat.toFixed(3)).toBe(before.totalCarat.toFixed(3));
    expect(afterEmpty.totalCost.toFixed(2)).toBe(before.totalCost.toFixed(2));
    expect(afterEmpty.pieceCount).toBe(before.pieceCount);

    const cancelled = await buyPacket(20, "3.000", "1000");
    const cancelledPacket = cancelled.packets[0];
    await prisma.polishedPacket.update({ where: { id: cancelledPacket.id }, data: { status: "CANCELLED" } });
    const afterCancelled = await getPolishedStockSummary();
    expect(afterCancelled.totalCarat.toFixed(3)).toBe(before.totalCarat.toFixed(3));
    expect(afterCancelled.pieceCount).toBe(before.pieceCount);
  });

  it("a single manufactured stone (PolishedDiamond) and a purchased packet are BOTH counted together, matching the real mixed scenario", async () => {
    const before = await getPolishedStockSummary();

    await buyPacket(50, "4.000", "2000"); // ₹8,000.00, 50 pcs, 4.000ct — direct purchase, a packet

    // One manufactured stone, through the real rough -> Karigar -> receive
    // pipeline (the same one polishedParcel.db.test.ts uses) so it is a
    // genuine PolishedDiamond row, not a fabricated one.
    const manufacturerId = (await prisma.party.create({ data: { name: "Polished Stock Summary Manufacturer", type: "MANUFACTURER", createdByUserId: ownerId } })).id;
    const lot = await prisma.$transaction(
      (tx) => createRoughLotWithPieces(tx, { ...FY, purchaseDate: DATE, supplierId, purchaseRate: 800, rateBasis: "PER_CARAT", currencyCode: "INR", exchangeRate: 1, totalPurchaseCost: "8000.00", gstTreatment: "NONE", idempotencyKey: key("rough"), createdByUserId: ownerId, pieces: [{ carat: "2.000" }] }),
      TX
    );
    const piece = await prisma.roughPiece.findFirstOrThrow({ where: { lotId: lot.id } });
    const job = await prisma.$transaction(
      (tx) => issueRoughToKarigar(tx, { ...FY, karigarId: manufacturerId, roughPieceIds: [piece.id], requiredShape: "ROUND", issueDate: DATE, idempotencyKey: key("rough-issue"), createdByUserId: ownerId }),
      TX
    );
    const received = await prisma.$transaction(
      (tx) => receivePolishedDiamonds(tx, { ...FY, jobId: job.id, receiveDate: DATE, returnedRoughCarat: 0, labourCharge: 7000, shape: "ROUND", markJobComplete: true, idempotencyKey: key("polished"), createdByUserId: ownerId, outputs: [{ shape: "ROUND", carat: "1.250" }] }),
      TX
    );
    expect(received.outputs[0].allocatedCost.toFixed(2)).toBe("15000.00"); // 8,000 rough + 7,000 labour

    const after = await getPolishedStockSummary();
    expect(after.totalCarat.minus(before.totalCarat).toFixed(3)).toBe("5.250"); // 4.000 (packet) + 1.250 (stone)
    expect(after.totalCost.minus(before.totalCost).toFixed(2)).toBe("23000.00"); // 8,000 + 15,000
    expect(after.pieceCount - before.pieceCount).toBe(51); // 50 (packet) + 1 (stone)
  });
});
