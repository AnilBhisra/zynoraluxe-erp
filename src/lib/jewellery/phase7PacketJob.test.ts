import { describe, expect, it, vi } from "vitest";

// reports.ts creates the Prisma client at module scope — same mock as
// src/lib/jewellery/reports.test.ts.
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { createFakeJewelleryTx } from "../../../test/fixtures/fakeJewelleryTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, ZERO } from "@/lib/accounting/money";
import { getPacketBalanceInTx } from "@/lib/diamond/polishedPurchase";
import {
  cancelJewelleryJob,
  createJewelleryJob,
  createMetalPurchase,
  issueMaterialsToJewelleryJob,
  PostingError,
  receiveFinishedJewellery,
} from "./posting";

// Phase 7 P1 — bulk polished PACKETS consumed by a Jewellery Job.
// Every issued quantity must resolve exactly once; a partial resolution
// leaves the rest PENDING and is never auto-written-off as loss; the packet
// ledger stays immutable; every voucher posts exact debit = credit.

type Fixture = ReturnType<typeof createFakeJewelleryTx>;
type ReceiveInput = Parameters<typeof receiveFinishedJewellery>[1];
type PacketLine = { packetId: string; pieces: number; carat: number };

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-16T00:00:00.000Z");

function accountId(fixture: Fixture, code: string) {
  return fixture.state.accounts.get(code)!.id;
}

/** Exact debit/credit line amount for one account inside one voucher. */
function voucherLine(fixture: Fixture, voucherId: string, code: string, side: "debit" | "credit"): string {
  const id = accountId(fixture, code);
  return fixture.state.journalEntries
    .filter((e) => e.voucherId === voucherId && e.accountId === id)
    .reduce((sum, e) => sum.plus(new Decimal(e[side] as string)), ZERO)
    .toFixed(2);
}

function expectEveryVoucherBalanced(fixture: Fixture) {
  for (const voucherId of fixture.state.vouchers.keys()) {
    const lines = fixture.state.journalEntries.filter((e) => e.voucherId === voucherId);
    const debit = lines.reduce((sum, e) => sum.plus(new Decimal(e.debit as string)), ZERO);
    const credit = lines.reduce((sum, e) => sum.plus(new Decimal(e.credit as string)), ZERO);
    expect(debit.toFixed(2)).toBe(credit.toFixed(2));
  }
}

/** A fixture with 24K gold in stock and a job that has NOT been issued yet. */
async function newJob(grossWeight = 10) {
  const f = createFakeJewelleryTx();
  const purity = f.seedMetalPurity({ metalType: "GOLD", displayName: "24K", finenessPercent: "99.900" });
  await createMetalPurchase(f.tx as never, {
    ...FY,
    currencyCode: "INR",
    exchangeRate: 1,
    createdByUserId: "user-1",
    purchaseDate: DATE,
    supplierId: "supplier-1",
    metalType: "GOLD",
    purityId: purity.id as string,
    grossWeight: 100,
    rateBasis: "PER_GROSS_GRAM",
    rate: 7000,
    totalPurchaseCost: 700000,
    gstTreatment: "NONE",
  });
  const job = await createJewelleryJob(f.tx as never, {
    karigarId: "karigar-1",
    jewelleryType: "RING",
    designName: "Packet ring",
    issueDate: DATE,
    quantity: 1,
    createdByUserId: "user-1",
  });
  const issue = (packetLines: PacketLine[]) =>
    issueMaterialsToJewelleryJob(f.tx as never, {
      ...FY,
      jobId: job.id as string,
      issueDate: DATE,
      metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight }],
      polishedDiamondIds: [],
      packetLines,
      otherMaterialLines: [],
      createdByUserId: "user-1",
    });
  return { f, purity, job, issue };
}

function receiveArgs(jobId: string, overrides: Partial<ReceiveInput> = {}): ReceiveInput {
  return {
    ...FY,
    jobId,
    receiveDate: DATE,
    outputs: [],
    diamondResolutions: [],
    returnedMetalLines: [],
    scrapMetalLines: [],
    karigarAddedFineWeight: 0,
    karigarAddedCost: 0,
    labourCharge: 0,
    makingCharge: 0,
    settingCharge: 0,
    platingCharge: 0,
    otherExpense: 0,
    markJobComplete: false,
    isAbnormalLoss: false,
    damagedLostByUserId: "user-1",
    createdByUserId: "user-1",
    ...overrides,
  };
}

describe("Phase 7 — issuing polished packets to a Jewellery Job", () => {
  it("takes the issued carat's cost share out of the packet and into Jewellery WIP", async () => {
    const { f, issue, job } = await newJob();
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-1", pieces: 100, carat: "10.000", costValue: "50000.00" });

    const updated = await issue([{ packetId: packet.id, pieces: 20, carat: 2 }]);

    // 2 of 10 carat → 10000.00 of the packet's 50000.00.
    expect(new Decimal(updated.issuedPacketDiamondCost).toFixed(2)).toBe("10000.00");
    const balance = await getPacketBalanceInTx(f.tx as never, packet.id);
    expect(balance.pieces).toBe(80);
    expect(balance.carat.toFixed(3)).toBe("8.000");
    expect(balance.costValue.toFixed(2)).toBe("40000.00");
    expect(f.state.polishedPackets.get(packet.id)!.status).toBe("ACTIVE");

    const voucherId = updated.wipVoucherId as string;
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, "credit")).toBe("10000.00");
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, "debit")).toBe("80000.00");
    expectEveryVoucherBalanced(f);
    void job;
  });

  it("issuing every piece and carat drains the packet to exactly zero and marks it EMPTY", async () => {
    const { f, issue } = await newJob(5);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-2", pieces: 3, carat: "1.000", costValue: "3333.33" });

    const updated = await issue([{ packetId: packet.id, pieces: 3, carat: 1 }]);

    expect(new Decimal(updated.issuedPacketDiamondCost).toFixed(2)).toBe("3333.33");
    const balance = await getPacketBalanceInTx(f.tx as never, packet.id);
    expect(balance.pieces).toBe(0);
    expect(balance.carat.toFixed(3)).toBe("0.000");
    expect(balance.costValue.toFixed(2)).toBe("0.00");
    expect(f.state.polishedPackets.get(packet.id)!.status).toBe("EMPTY");
  });

  it("refuses more carat than the packet still holds", async () => {
    const { f, issue } = await newJob(5);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-3", pieces: 10, carat: "1.000", costValue: "1000.00" });
    await expect(issue([{ packetId: packet.id, pieces: 5, carat: 2 }])).rejects.toThrow(PostingError);
  });

  it("refuses to take every carat while leaving pieces behind", async () => {
    const { f, issue } = await newJob(5);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-4", pieces: 10, carat: "1.000", costValue: "1000.00" });
    await expect(issue([{ packetId: packet.id, pieces: 5, carat: 1 }])).rejects.toThrow(/every carat/i);
  });

  it("refuses to issue from a packet that is no longer active (row lock re-checks status)", async () => {
    const { f, issue } = await newJob(5);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-X", pieces: 10, carat: "1.000", costValue: "1000.00" });
    f.state.polishedPackets.get(packet.id)!.status = "CANCELLED";
    await expect(issue([{ packetId: packet.id, pieces: 1, carat: 0.1 }])).rejects.toThrow(/no longer active/);
  });

  it("refuses the same packet twice in one issue", async () => {
    const { f, issue } = await newJob(5);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-5", pieces: 10, carat: "2.000", costValue: "2000.00" });
    await expect(
      issue([
        { packetId: packet.id, pieces: 2, carat: 0.4 },
        { packetId: packet.id, pieces: 3, carat: 0.6 },
      ])
    ).rejects.toThrow(/more than once/i);
  });

  it("cancelling the job returns the packet stones and re-activates an emptied packet", async () => {
    const { f, issue, job } = await newJob(5);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-6", pieces: 8, carat: "2.000", costValue: "8000.00" });
    await issue([{ packetId: packet.id, pieces: 8, carat: 2 }]);
    expect(f.state.polishedPackets.get(packet.id)!.status).toBe("EMPTY");

    await cancelJewelleryJob(f.tx as never, {
      ...FY,
      jobId: job.id as string,
      cancelledByUserId: "user-1",
      cancellationReason: "Karigar unavailable",
    });

    const balance = await getPacketBalanceInTx(f.tx as never, packet.id);
    expect(balance.pieces).toBe(8);
    expect(balance.carat.toFixed(3)).toBe("2.000");
    expect(balance.costValue.toFixed(2)).toBe("8000.00");
    expect(f.state.polishedPackets.get(packet.id)!.status).toBe("ACTIVE");
    // The issue movement is never edited away — the reversal is its own row.
    const movements = [...f.state.polishedPacketMovements.values()].filter((m) => m.packetId === packet.id);
    expect(movements.map((m) => m.type).sort()).toEqual(["JEWELLERY_ISSUE_CANCEL_IN", "JEWELLERY_ISSUE_OUT", "PURCHASE_IN"]);
    expectEveryVoucherBalanced(f);
  });
});

describe("Phase 7 — resolving packet stones at receipt", () => {
  const output = (purityId: string, netMetalWeight: number) => ({
    jewelleryType: "RING" as const,
    quantity: 1,
    netMetalWeight,
    metalType: "GOLD" as const,
    purityId,
    diamondIds: [],
    qcStatus: "PASSED" as const,
  });

  it("SET stones move into the finished piece's cost and out of WIP", async () => {
    const { f, issue, job, purity } = await newJob(10);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-7", pieces: 40, carat: "4.000", costValue: "20000.00" });
    await issue([{ packetId: packet.id, pieces: 40, carat: 4 }]);

    const result = await receiveFinishedJewellery(
      f.tx as never,
      receiveArgs(job.id as string, {
        outputs: [output(purity.id as string, 9.5)],
        packetResolutions: [{ packetId: packet.id, resolution: "SET", pieces: 40, carat: 4 }],
        markJobComplete: true,
      })
    );

    const voucherId = result.receipt.postingVoucherId as string;
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, "debit")).toBe("0.00");
    // 70000.00 metal + 20000.00 packet stones, all into finished inventory.
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "debit")).toBe("90000.00");
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, "credit")).toBe("90000.00");
    expect(new Decimal(result.outputs[0].diamondCost).toFixed(2)).toBe("20000.00");
    expect(new Decimal(result.outputs[0].totalCost).toFixed(2)).toBe("90000.00");
    // Phase 6 COGS reads this PRODUCED_IN cost, so packet stones reach COGS on sale.
    const produced = [...f.state.finishedJewelleryStockMovements.values()].find((m) => m.finishedJewelleryId === result.outputs[0].id)!;
    expect(produced.type).toBe("PRODUCED_IN");
    expect(new Decimal(produced.costValue as string).toFixed(2)).toBe("90000.00");
    expect(produced.totalCaratSnapshot).toBe("4.000");
    expect(result.job.status).toBe("COMPLETED");
    expectEveryVoucherBalanced(f);
  });

  it("RETURNED stones go back into their own packet through the ledger", async () => {
    const { f, issue, job, purity } = await newJob(10);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-8", pieces: 40, carat: "4.000", costValue: "20000.00" });
    await issue([{ packetId: packet.id, pieces: 40, carat: 4 }]);

    const result = await receiveFinishedJewellery(
      f.tx as never,
      receiveArgs(job.id as string, {
        outputs: [output(purity.id as string, 9.5)],
        packetResolutions: [
          { packetId: packet.id, resolution: "SET", pieces: 30, carat: 3 },
          { packetId: packet.id, resolution: "RETURNED", pieces: 10, carat: 1 },
        ],
        markJobComplete: true,
      })
    );

    const voucherId = result.receipt.postingVoucherId as string;
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, "debit")).toBe("5000.00");
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY, "debit")).toBe("85000.00");
    const balance = await getPacketBalanceInTx(f.tx as never, packet.id);
    expect(balance.pieces).toBe(10);
    expect(balance.carat.toFixed(3)).toBe("1.000");
    expect(balance.costValue.toFixed(2)).toBe("5000.00");
    expect(f.state.polishedPackets.get(packet.id)!.status).toBe("ACTIVE");
    expect(result.job.status).toBe("COMPLETED");
    expectEveryVoucherBalanced(f);
  });

  it("DAMAGED_LOST stones are expensed, never returned to stock, and need a reason", async () => {
    const { f, issue, job, purity } = await newJob(10);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-9", pieces: 40, carat: "4.000", costValue: "20000.00" });
    await issue([{ packetId: packet.id, pieces: 40, carat: 4 }]);

    await expect(
      receiveFinishedJewellery(
        f.tx as never,
        receiveArgs(job.id as string, {
          outputs: [output(purity.id as string, 9.5)],
          packetResolutions: [{ packetId: packet.id, resolution: "DAMAGED_LOST", pieces: 40, carat: 4 }],
          markJobComplete: true,
        })
      )
    ).rejects.toThrow(/reason/i);

    const result = await receiveFinishedJewellery(
      f.tx as never,
      receiveArgs(job.id as string, {
        outputs: [output(purity.id as string, 9.5)],
        packetResolutions: [
          { packetId: packet.id, resolution: "DAMAGED_LOST", pieces: 40, carat: 4, damagedLostReason: "Broken while setting" },
        ],
        markJobComplete: true,
      })
    );

    const voucherId = result.receipt.postingVoucherId as string;
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, "debit")).toBe("20000.00");
    expect(voucherLine(f, voucherId, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, "debit")).toBe("0.00");
    const balance = await getPacketBalanceInTx(f.tx as never, packet.id);
    expect(balance.pieces).toBe(0);
    expect(balance.carat.toFixed(3)).toBe("0.000");
    expectEveryVoucherBalanced(f);
  });
});

describe("Phase 7 — partial packet resolution never becomes silent loss", () => {
  const output = (purityId: string, netMetalWeight: number) => ({
    jewelleryType: "RING" as const,
    quantity: 1,
    netMetalWeight,
    metalType: "GOLD" as const,
    purityId,
    diamondIds: [],
    qcStatus: "PASSED" as const,
  });

  it("leaves the unresolved part pending and keeps the job open, then closes it on the next receipt", async () => {
    const { f, issue, job, purity } = await newJob(10);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-10", pieces: 40, carat: "4.000", costValue: "20000.00" });
    await issue([{ packetId: packet.id, pieces: 40, carat: 4 }]);

    // Receipt 1: only half the stones are accounted for. Even with
    // markJobComplete, the job must stay open — the rest is still with the
    // Karigar and is NOT written off.
    const first = await receiveFinishedJewellery(
      f.tx as never,
      receiveArgs(job.id as string, {
        outputs: [output(purity.id as string, 9.5)],
        packetResolutions: [{ packetId: packet.id, resolution: "SET", pieces: 20, carat: 2 }],
        markJobComplete: true,
      })
    );
    expect(first.job.status).toBe("PARTIALLY_RECEIVED");
    const line = [...f.state.jewelleryPacketIssueLines.values()][0];
    expect(line.setPieces).toBe(20);
    expect(new Decimal(line.setCarat as string).toFixed(3)).toBe("2.000");
    expect(new Decimal(line.setCost as string).toFixed(2)).toBe("10000.00");

    // Receipt 2: the remainder comes back. The last resolution takes the
    // exact cost remainder, so the line drains to zero with no residue.
    const second = await receiveFinishedJewellery(
      f.tx as never,
      receiveArgs(job.id as string, {
        packetResolutions: [{ packetId: packet.id, resolution: "RETURNED", pieces: 20, carat: 2 }],
        markJobComplete: true,
      })
    );
    expect(second.job.status).toBe("COMPLETED");
    const resolvedLine = [...f.state.jewelleryPacketIssueLines.values()][0];
    const resolvedCost = new Decimal(resolvedLine.setCost as string)
      .plus(resolvedLine.returnedCost as string)
      .plus(resolvedLine.damagedCost as string);
    expect(resolvedCost.toFixed(2)).toBe("20000.00");
    const balance = await getPacketBalanceInTx(f.tx as never, packet.id);
    expect(balance.costValue.toFixed(2)).toBe("10000.00");
    expectEveryVoucherBalanced(f);
  });

  it("refuses to resolve more than the job still holds", async () => {
    const { f, issue, job, purity } = await newJob(10);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-11", pieces: 40, carat: "4.000", costValue: "20000.00" });
    await issue([{ packetId: packet.id, pieces: 40, carat: 4 }]);

    await expect(
      receiveFinishedJewellery(
        f.tx as never,
        receiveArgs(job.id as string, {
          outputs: [output(purity.id as string, 9.5)],
          packetResolutions: [{ packetId: packet.id, resolution: "SET", pieces: 41, carat: 4.1 }],
        })
      )
    ).rejects.toThrow(PostingError);
  });

  it("refuses a resolution for a packet that was never issued to this job", async () => {
    const { f, issue, job, purity } = await newJob(10);
    const issued = f.seedPolishedPacket({ packetCode: "ZL-PKT-12", pieces: 10, carat: "1.000", costValue: "5000.00" });
    const other = f.seedPolishedPacket({ packetCode: "ZL-PKT-13", pieces: 10, carat: "1.000", costValue: "5000.00" });
    await issue([{ packetId: issued.id, pieces: 10, carat: 1 }]);

    await expect(
      receiveFinishedJewellery(
        f.tx as never,
        receiveArgs(job.id as string, {
          outputs: [output(purity.id as string, 9.5)],
          packetResolutions: [{ packetId: other.id, resolution: "SET", pieces: 10, carat: 1 }],
        })
      )
    ).rejects.toThrow(/not issued to this job/i);
  });

  it("refuses SET with no finished output to hold the stones", async () => {
    const { f, issue, job } = await newJob(10);
    const packet = f.seedPolishedPacket({ packetCode: "ZL-PKT-14", pieces: 10, carat: "1.000", costValue: "5000.00" });
    await issue([{ packetId: packet.id, pieces: 10, carat: 1 }]);

    await expect(
      receiveFinishedJewellery(
        f.tx as never,
        receiveArgs(job.id as string, {
          packetResolutions: [{ packetId: packet.id, resolution: "SET", pieces: 10, carat: 1 }],
        })
      )
    ).rejects.toThrow(/finished output/i);
  });
});
