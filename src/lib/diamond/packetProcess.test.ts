import { describe, expect, it, vi } from "vitest";

// packetProcess.ts → polishedPurchase.ts is server-only but Prisma-free; the
// jewellery fixture underneath imports nothing that needs a live client.
vi.mock("@/lib/db/prisma", () => ({ prisma: {} }));

import { createFakePacketProcessTx } from "../../../test/fixtures/fakePacketProcessTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, ZERO } from "@/lib/accounting/money";
import { cancelJewelleryJob, createJewelleryJob, createMetalPurchase, issueMaterialsToJewelleryJob } from "@/lib/jewellery/posting";
import { cancelPacketProcessJob, createPacketProcessJob, receivePacketProcessReturn } from "./packetProcess";
import { getPacketBalanceInTx } from "./polishedPurchase";

// Phase 7 P2 — Job Manufacturer (bulk polished packets out for a process).

type Fixture = ReturnType<typeof createFakePacketProcessTx>;
const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-17T00:00:00.000Z");

function voucherLine(f: Fixture, voucherId: string | null, code: string, side: "debit" | "credit"): string {
  const id = f.state.accounts.get(code)!.id;
  return f.state.journalEntries
    .filter((e) => e.voucherId === voucherId && e.accountId === id)
    .reduce((sum, e) => sum.plus(new Decimal(e[side] as string)), ZERO)
    .toFixed(2);
}

function expectBalanced(f: Fixture) {
  for (const voucherId of f.state.vouchers.keys()) {
    const lines = f.state.journalEntries.filter((e) => e.voucherId === voucherId);
    const debit = lines.reduce((s, e) => s.plus(new Decimal(e.debit as string)), ZERO);
    const credit = lines.reduce((s, e) => s.plus(new Decimal(e.credit as string)), ZERO);
    expect(debit.toFixed(2)).toBe(credit.toFixed(2));
  }
}

function setup(chargeRateBasis: "FIXED" | "PER_CARAT" | "PER_PIECE" = "PER_CARAT", chargeRate = 0) {
  const f = createFakePacketProcessTx();
  const manufacturer = f.seedParty({ name: "Shree Manufacturers", type: "MANUFACTURER" });
  const process = f.seedDiamondProcess({ name: "Polishing", outputKind: "POLISHED" });
  const packetA = f.seedPolishedPacket({ packetCode: "ZL-PKT-A", pieces: 100, carat: "10.000", costValue: "100000.00", sizeLabel: "1.00-1.20MM" });
  const packetB = f.seedPolishedPacket({ packetCode: "ZL-PKT-B", pieces: 50, carat: "5.000", costValue: "40000.00", sizeLabel: "1.50MM" });
  const issue = (lines: { packetId: string; pieces: number; carat: number }[], overrides: Record<string, unknown> = {}) =>
    createPacketProcessJob(f.tx as never, {
      ...FY,
      manufacturerId: manufacturer.id,
      processId: process.id,
      issueDate: DATE,
      lines,
      chargeRateBasis,
      chargeRate,
      createdByUserId: "user-1",
      ...overrides,
    });
  const receive = (jobId: string, rows: Record<string, unknown>[], overrides: Record<string, unknown> = {}) =>
    receivePacketProcessReturn(f.tx as never, {
      ...FY,
      jobId,
      receiveDate: DATE,
      rows: rows as never,
      markJobComplete: false,
      isAbnormalLoss: false,
      createdByUserId: "user-1",
      ...overrides,
    });
  const lineFor = (jobId: string, packetId: string) =>
    [...f.state.packetProcessJobLines.values()].find((l) => l.jobId === jobId && l.packetId === packetId)!;
  return { f, manufacturer, process, packetA, packetB, issue, receive, lineFor };
}

describe("Job Manufacturer — issue", () => {
  it("moves the issued carat's cost from Polished Inventory into Diamond WIP, size-wise per packet", async () => {
    const { f, packetA, packetB, issue } = setup();
    const job = await issue([
      { packetId: packetA.id, pieces: 40, carat: 4 },
      { packetId: packetB.id, pieces: 50, carat: 5 },
    ]);
    // 4/10 of 100000.00 + all of 40000.00
    expect(job.issuedCostValue).toBe("80000.00");
    expect(job.issuedPieces).toBe(90);
    expect(voucherLine(f, job.wipVoucherId as string, SYSTEM_ACCOUNT_CODES.DIAMOND_WIP, "debit")).toBe("80000.00");
    expect(voucherLine(f, job.wipVoucherId as string, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, "credit")).toBe("80000.00");
    expect((await getPacketBalanceInTx(f.tx as never, packetA.id)).costValue.toFixed(2)).toBe("60000.00");
    expect(f.state.polishedPackets.get(packetB.id)!.status).toBe("EMPTY");
    expectBalanced(f);
  });

  it("refuses a party that is not a Manufacturer or Karigar, and an inactive process", async () => {
    const { f, packetA, issue } = setup();
    const broker = f.seedParty({ name: "Dalal", type: "BROKER" });
    await expect(issue([{ packetId: packetA.id, pieces: 1, carat: 0.1 }], { manufacturerId: broker.id })).rejects.toThrow(/Manufacturer/);
    const inactive = f.seedDiamondProcess({ name: "Old process", outputKind: "POLISHED", isActive: false });
    await expect(issue([{ packetId: packetA.id, pieces: 1, carat: 0.1 }], { processId: inactive.id })).rejects.toThrow(/inactive/);
  });

  it("cancels before any return: reversal voucher and stones back in their packets; refused after a return", async () => {
    const { f, packetA, packetB, issue, receive, lineFor } = setup();
    const job = await issue([{ packetId: packetB.id, pieces: 50, carat: 5 }]);
    await cancelPacketProcessJob(f.tx as never, { ...FY, jobId: job.id as string, cancelledByUserId: "owner-1", cancellationReason: "Wrong packet" });
    const balance = await getPacketBalanceInTx(f.tx as never, packetB.id);
    expect(balance.pieces).toBe(50);
    expect(balance.costValue.toFixed(2)).toBe("40000.00");
    expect(f.state.polishedPackets.get(packetB.id)!.status).toBe("ACTIVE");
    expectBalanced(f);

    const second = await issue([{ packetId: packetA.id, pieces: 10, carat: 1 }]);
    await receive(second.id as string, [
      { jobLineId: lineFor(second.id as string, packetA.id).id, disposition: "RETURNED_TO_STOCK", pieces: 5, carat: 0.5 },
    ]);
    await expect(
      cancelPacketProcessJob(f.tx as never, { ...FY, jobId: second.id as string, cancelledByUserId: "owner-1", cancellationReason: "Too late" })
    ).rejects.toThrow(/no longer be cancelled/);
  });
});

describe("Job Manufacturer — returns", () => {
  it("a partial return re-enters the original packet by carat share and recognises no loss", async () => {
    const { f, packetA, issue, receive, lineFor } = setup("PER_CARAT", 100);
    const job = await issue([{ packetId: packetA.id, pieces: 40, carat: 4 }]);
    const { receipt, job: after } = await receive(job.id as string, [
      { jobLineId: lineFor(job.id as string, packetA.id).id, disposition: "RETURNED_TO_STOCK", pieces: 10, carat: 1 },
    ]);
    expect(receipt.isFinal).toBe(false);
    expect(receipt.lossCarat).toBe("0.000");
    // 1 of 4ct → 10000.00 stone cost + 1ct × 100 charge.
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, "debit")).toBe("10100.00");
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.DIAMOND_WIP, "credit")).toBe("10000.00");
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, "credit")).toBe("100.00");
    expect(after.status).toBe("PARTIALLY_RETURNED");
    expect(after.remainingWipCost).toBe("30000.00");
    const balance = await getPacketBalanceInTx(f.tx as never, packetA.id);
    expect(balance.pieces).toBe(70);
    expect(balance.costValue.toFixed(2)).toBe("70100.00");
    expectBalanced(f);
  });

  it("closing with a different returned size creates a child packet, absorbs normal loss and drains WIP to zero", async () => {
    const { f, packetA, issue, receive, lineFor } = setup("PER_PIECE", 20);
    const job = await issue([{ packetId: packetA.id, pieces: 40, carat: 4 }]);
    const lineId = lineFor(job.id as string, packetA.id).id;
    const { receipt, job: after } = await receive(
      job.id as string,
      [
        { jobLineId: lineId, disposition: "RETURNED_TO_STOCK", pieces: 30, carat: 2.7, sizeLabel: "0.90-1.00MM" },
        { jobLineId: lineId, disposition: "RETURNED_TO_STOCK", pieces: 10, carat: 1.0, sizeLabel: "1.00-1.20MM" },
      ],
      { markJobComplete: true }
    );
    expect(receipt.isFinal).toBe(true);
    expect(receipt.lossCarat).toBe("0.300");
    expect(after.status).toBe("COMPLETED");
    expect(after.remainingWipCost).toBe("0.00");
    // 40000.00 stone cost absorbed by 3.7ct + 40 pcs × 20 charge.
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, "debit")).toBe("40800.00");
    const child = [...f.state.polishedPackets.values()].find((p) => p.parentPacketId === packetA.id)!;
    expect(child.provenance).toBe("RETURNED_FROM_JOB");
    expect(child.sizeLabel).toBe("0.90-1.00MM");
    const childBalance = await getPacketBalanceInTx(f.tx as never, child.id as string);
    const originalBalance = await getPacketBalanceInTx(f.tx as never, packetA.id);
    expect(childBalance.pieces).toBe(30);
    expect(childBalance.costValue.plus(originalBalance.costValue).toFixed(2)).toBe("100800.00");
    expectBalanced(f);
  });

  it("refuses to close while pieces are unaccounted for — pending stones are never loss", async () => {
    const { packetA, issue, receive, lineFor } = setup();
    const job = await issue([{ packetId: packetA.id, pieces: 40, carat: 4 }]);
    await expect(
      receive(
        job.id as string,
        [{ jobLineId: lineFor(job.id as string, packetA.id).id, disposition: "RETURNED_TO_STOCK", pieces: 39, carat: 3.9 }],
        { markJobComplete: true }
      )
    ).rejects.toThrow(/still unaccounted for/);
  });

  it("all pieces back with a carat shortfall does NOT close the line on piece count alone", async () => {
    const { f, packetA, packetB, issue, receive, lineFor } = setup();
    const job = await issue([
      { packetId: packetA.id, pieces: 40, carat: 4 },
      { packetId: packetB.id, pieces: 50, carat: 5 },
    ]);
    const { receipt, job: after } = await receive(job.id as string, [
      { jobLineId: lineFor(job.id as string, packetA.id).id, disposition: "RETURNED_TO_STOCK", pieces: 40, carat: 3.8 },
    ]);
    const lineA = lineFor(job.id as string, packetA.id);
    expect(receipt.isFinal).toBe(false);
    expect(receipt.lossCarat).toBe("0.000");
    expect(lineA.isClosed).toBe(false);
    expect(lineA.closedAt ?? null).toBeNull();
    // 3.8 of 4ct drained (38000.00); the 0.2ct share (2000.00) waits in WIP with line B's 40000.00.
    expect(after.remainingWipCost).toBe("42000.00");
    expectBalanced(f);

    // Rows against a line whose pieces are all back are refused — close it instead.
    await expect(
      receive(job.id as string, [{ jobLineId: lineA.id, disposition: "RETURNED_TO_STOCK", pieces: 1, carat: 0.1 }])
    ).rejects.toThrow(/confirm closing the line/);
  });

  it("an explicit confirmation closes that line alone, recognises line-level loss and records who closed it", async () => {
    const { f, packetA, packetB, issue, receive, lineFor } = setup();
    const job = await issue([
      { packetId: packetA.id, pieces: 40, carat: 4 },
      { packetId: packetB.id, pieces: 50, carat: 5 },
    ]);
    const lineAId = lineFor(job.id as string, packetA.id).id;
    await receive(job.id as string, [{ jobLineId: lineAId, disposition: "RETURNED_TO_STOCK", pieces: 40, carat: 3.8 }]);

    // Confirmation on a later receipt: the stones already went back to stock,
    // so the loss share cannot be absorbed into them and is expensed.
    const { receipt, job: after } = await receive(job.id as string, [], { closeLineIds: [lineAId], createdByUserId: "user-2" });
    const lineA = lineFor(job.id as string, packetA.id);
    expect(lineA.isClosed).toBe(true);
    expect(lineA.lossCarat).toBe("0.200");
    expect(lineA.closedByUserId).toBe("user-2");
    expect(lineA.closingReceiptId).toBe(receipt.id);
    expect(lineA.closedAt).toBeInstanceOf(Date);
    expect(lineFor(job.id as string, packetB.id).isClosed).toBe(false);
    expect(receipt.isFinal).toBe(false);
    expect(after.status).toBe("PARTIALLY_RETURNED");
    expect(after.remainingWipCost).toBe("40000.00");
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, "debit")).toBe("2000.00");
    expectBalanced(f);

    // A closed line accepts nothing further.
    await expect(
      receive(job.id as string, [{ jobLineId: lineAId, disposition: "RETURNED_TO_STOCK", pieces: 1, carat: 0.1 }])
    ).rejects.toThrow(/already closed/);
    await expect(receive(job.id as string, [], { closeLineIds: [lineAId] })).rejects.toThrow(/already closed/);
  });

  it("confirming in the same receipt absorbs the line's normal loss into the returned stones", async () => {
    const { f, packetA, packetB, issue, receive, lineFor } = setup();
    const job = await issue([
      { packetId: packetA.id, pieces: 40, carat: 4 },
      { packetId: packetB.id, pieces: 50, carat: 5 },
    ]);
    const lineAId = lineFor(job.id as string, packetA.id).id;
    const { receipt } = await receive(
      job.id as string,
      [{ jobLineId: lineAId, disposition: "RETURNED_TO_STOCK", pieces: 40, carat: 3.8 }],
      { closeLineIds: [lineAId] }
    );
    expect(receipt.lossCarat).toBe("0.200");
    expect(lineFor(job.id as string, packetA.id).isClosed).toBe(true);
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, "debit")).toBe("40000.00");
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, "debit")).toBe("0.00");
    expectBalanced(f);
  });

  it("refuses to confirm closing a line while any of its pieces are unaccounted for", async () => {
    const { packetA, issue, receive, lineFor } = setup();
    const job = await issue([{ packetId: packetA.id, pieces: 40, carat: 4 }]);
    const lineAId = lineFor(job.id as string, packetA.id).id;
    await expect(
      receive(job.id as string, [{ jobLineId: lineAId, disposition: "RETURNED_TO_STOCK", pieces: 39, carat: 3.9 }], {
        closeLineIds: [lineAId],
      })
    ).rejects.toThrow(/cannot close yet/);
  });

  it("an exact return of every piece and carat closes the line without confirmation (no loss to recognise)", async () => {
    const { packetA, packetB, issue, receive, lineFor } = setup();
    const job = await issue([
      { packetId: packetA.id, pieces: 40, carat: 4 },
      { packetId: packetB.id, pieces: 50, carat: 5 },
    ]);
    const { receipt } = await receive(job.id as string, [
      { jobLineId: lineFor(job.id as string, packetA.id).id, disposition: "RETURNED_TO_STOCK", pieces: 40, carat: 4 },
    ]);
    expect(receipt.lossCarat).toBe("0.000");
    expect(lineFor(job.id as string, packetA.id).isClosed).toBe(true);
    expect(receipt.isFinal).toBe(false);
  });

  it("damaged/lost stones and abnormal loss go to Business Expenses", async () => {
    const { f, packetA, issue, receive, lineFor } = setup();
    const job = await issue([{ packetId: packetA.id, pieces: 40, carat: 4 }]);
    const lineId = lineFor(job.id as string, packetA.id).id;
    await expect(
      receive(job.id as string, [{ jobLineId: lineId, disposition: "DAMAGED_LOST", pieces: 1, carat: 0.1 }])
    ).rejects.toThrow(/reason/);
    const { receipt } = await receive(
      job.id as string,
      [
        { jobLineId: lineId, disposition: "RETURNED_TO_STOCK", pieces: 38, carat: 3.4 },
        { jobLineId: lineId, disposition: "DAMAGED_LOST", pieces: 2, carat: 0.2, damagedLostReason: "Broken on the wheel" },
      ],
      { markJobComplete: true, isAbnormalLoss: true, abnormalLossReason: "Over-polished" }
    );
    // 4ct = 40000.00: abnormal loss 0.4ct → 4000.00; remaining 36000.00 split 3.4 : 0.2.
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.BUSINESS_EXPENSES, "debit")).toBe("6000.00");
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, "debit")).toBe("34000.00");
    expectBalanced(f);
  });

  it("stones used in an open Jewellery Job land on that job's WIP with their process cost", async () => {
    const { f, packetA, issue, receive, lineFor } = setup("PER_CARAT", 500);
    const purity = f.seedMetalPurity({ metalType: "GOLD", displayName: "24K", finenessPercent: "99.900" });
    await createMetalPurchase(f.tx as never, {
      ...FY, currencyCode: "INR", exchangeRate: 1, createdByUserId: "user-1", purchaseDate: DATE, supplierId: "supplier-1",
      metalType: "GOLD", purityId: purity.id as string, grossWeight: 10, rateBasis: "PER_GROSS_GRAM", rate: 7000,
      totalPurchaseCost: 70000, gstTreatment: "NONE",
    });
    const draftJob = await createJewelleryJob(f.tx as never, {
      karigarId: "karigar-1", jewelleryType: "RING", designName: "Pave ring", issueDate: DATE, quantity: 1, createdByUserId: "user-1",
    });
    const lineId = async () => {
      const job = await issue([{ packetId: packetA.id, pieces: 20, carat: 2 }]);
      return { job, id: lineFor(job.id as string, packetA.id).id };
    };
    const first = await lineId();
    await expect(
      receive(first.job.id as string, [
        { jobLineId: first.id, disposition: "USED_IN_JEWELLERY_JOB", pieces: 20, carat: 2, jewelleryJobId: draftJob.id },
      ])
    ).rejects.toThrow(/open Jewellery Job/);

    await issueMaterialsToJewelleryJob(f.tx as never, {
      ...FY, jobId: draftJob.id as string, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId: purity.id as string, grossWeight: 5 }],
      polishedDiamondIds: [], otherMaterialLines: [], createdByUserId: "user-1",
    });
    const { receipt } = await receive(first.job.id as string, [
      { jobLineId: first.id, disposition: "USED_IN_JEWELLERY_JOB", pieces: 20, carat: 2, jewelleryJobId: draftJob.id },
    ]);
    // 2ct = 20000.00 + 2ct × 500 charge.
    expect(voucherLine(f, receipt.postingVoucherId as string, SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, "debit")).toBe("21000.00");
    const issueLine = [...f.state.jewelleryPacketIssueLines.values()].find((l) => l.jobId === draftJob.id)!;
    expect(issueLine.costAtIssue).toBe("21000.00");
    expect(issueLine.sourcePacketProcessReceiptLineId).toBeTruthy();
    expect(f.state.jewelleryJobs.get(draftJob.id as string)!.issuedPacketDiamondCost).toBe("21000.00");
    expectBalanced(f);

    // Cancelling the Jewellery Job puts those stones back in stock at their
    // process cost, with the matching Dr 1220 / Cr 1320 — not only the
    // job's own metal issue reversal.
    const before = await getPacketBalanceInTx(f.tx as never, packetA.id);
    await cancelJewelleryJob(f.tx as never, {
      ...FY, jobId: draftJob.id as string, cancelledByUserId: "owner-1", cancellationReason: "Design changed",
    });
    const after = await getPacketBalanceInTx(f.tx as never, packetA.id);
    expect(after.pieces - before.pieces).toBe(20);
    expect(after.costValue.minus(before.costValue).toFixed(2)).toBe("21000.00");
    const wipId = f.state.accounts.get(SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP)!.id;
    const wip = f.state.journalEntries
      .filter((e) => e.accountId === wipId)
      .reduce((s, e) => s.plus(new Decimal(e.debit as string)).minus(new Decimal(e.credit as string)), ZERO);
    expect(wip.toFixed(2)).toBe("0.00");
    expectBalanced(f);
  });
});
