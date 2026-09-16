import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { createFakeJewelleryTx } from "../../../test/fixtures/fakeJewelleryTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, ZERO } from "@/lib/accounting/money";
import { adjustPacketStock } from "./packetAdjustment";
import { getPacketBalanceInTx } from "./polishedPurchase";

// Phase 7 — Owner packet count corrections post their accounting with the
// ledger movement, so 1220 keeps matching packet stock.

type Fixture = ReturnType<typeof createFakeJewelleryTx>;
const DATE = new Date("2026-09-18T00:00:00.000Z");

function ledger(f: Fixture, code: string) {
  const id = f.state.accounts.get(code)!.id;
  return f.state.journalEntries
    .filter((e) => e.accountId === id)
    .reduce((s, e) => s.plus(new Decimal(e.debit as string)).minus(new Decimal(e.credit as string)), ZERO)
    .toFixed(2);
}

function adjust(f: Fixture, packetId: string, overrides: Record<string, unknown>) {
  return adjustPacketStock(f.tx as never, {
    fyStartMonth: 4,
    fyStartDay: 1,
    packetId,
    direction: "OUT",
    pieces: 1,
    carat: 0.1,
    adjustmentDate: DATE,
    reason: "Physical count",
    createdByUserId: "owner-1",
    ...overrides,
  } as never);
}

describe("adjustPacketStock", () => {
  it("OUT removes stones at their carat share and expenses the cost", async () => {
    const f = createFakeJewelleryTx();
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-ADJ", pieces: 100, carat: "10.000", costValue: "30000.00" });
    await adjust(f, packet.id, { pieces: 3, carat: 0.3 });
    const balance = await getPacketBalanceInTx(f.tx as never, packet.id);
    expect(balance.pieces).toBe(97);
    expect(balance.costValue.toFixed(2)).toBe("29100.00");
    expect(ledger(f, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES)).toBe("900.00");
    expect(ledger(f, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)).toBe("-900.00");
    const voucher = [...f.state.vouchers.values()][0];
    expect(voucher.voucherType).toBe("STOCK_ADJUSTMENT");
  });

  it("OUT of everything takes the exact remainder and marks the packet EMPTY; IN brings it back", async () => {
    const f = createFakeJewelleryTx();
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-ADJ2", pieces: 3, carat: "1.000", costValue: "1000.00" });
    await adjust(f, packet.id, { pieces: 3, carat: 1 });
    expect(f.state.polishedPackets.get(packet.id)!.status).toBe("EMPTY");
    expect((await getPacketBalanceInTx(f.tx as never, packet.id)).costValue.toFixed(2)).toBe("0.00");

    await adjust(f, packet.id, { direction: "IN", pieces: 1, carat: 0.3, costValue: 250 });
    expect(f.state.polishedPackets.get(packet.id)!.status).toBe("ACTIVE");
    expect(ledger(f, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES)).toBe("750.00");
  });

  it("requires a reason, refuses more than the packet holds, and refuses a stranded residue", async () => {
    const f = createFakeJewelleryTx();
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-ADJ3", pieces: 10, carat: "1.000", costValue: "1000.00" });
    await expect(adjust(f, packet.id, { reason: "" })).rejects.toThrow(/reason/);
    await expect(adjust(f, packet.id, { pieces: 11, carat: 1.1 })).rejects.toThrow(/available/);
    await expect(adjust(f, packet.id, { pieces: 10, carat: 0.5 })).rejects.toThrow(/every piece/);
  });

  it("refuses a cancelled packet", async () => {
    const f = createFakeJewelleryTx();
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-ADJ4", pieces: 10, carat: "1.000", costValue: "1000.00" });
    f.state.polishedPackets.get(packet.id)!.status = "CANCELLED";
    await expect(adjust(f, packet.id, {})).rejects.toThrow(/cancelled/);
  });
});
