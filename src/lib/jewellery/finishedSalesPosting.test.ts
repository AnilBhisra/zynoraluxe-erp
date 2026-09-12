import { describe, expect, it } from "vitest";

import { createFakeFinishedSalesTx, type FakeFinishedSalesTx } from "../../../test/fixtures/fakeFinishedSalesTx";
import {
  adjustFinishedJewelleryStock,
  cancelFinishedJewellerySale,
  getAuthoritativeInventoryCost,
  postFinishedJewellerySale,
  reconcileAvailabilityLedger,
  returnFinishedJewelleryItems,
} from "./finishedSalesPosting";
import { PostingError, postCustomerRefund } from "@/lib/accounting/posting";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal } from "@/lib/accounting/money";
import type { FinishedJewelleryStockMovementType } from "@/generated/prisma/enums";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-06-15T00:00:00.000Z");

function common(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    date: DATE,
    saleDate: DATE,
    ...FY,
    currencyCode: "INR",
    exchangeRate: 1,
    createdByUserId: "user-1",
    customerId: "customer-1",
    gstTreatment: "CGST_SGST" as const,
    ...overrides,
  };
}

function linesFor(fixture: FakeFinishedSalesTx, voucherId: string) {
  return fixture.state.journalEntries.filter((e) => e.voucherId === voucherId);
}

function sumBy<K extends string>(lines: Record<string, unknown>[], key: K) {
  return lines.reduce((sum, l) => sum + Number(l[key]), 0);
}

function codeOf(fixture: FakeFinishedSalesTx, accountId: unknown) {
  for (const [code, row] of fixture.state.accounts) {
    if (row.id === accountId) return code;
  }
  return undefined;
}

let itemCounter = 0;

/**
 * Seeds one AVAILABLE FinishedJewellery output, deliberately with
 * otherMaterialCost > 0 and totalCost !== metalCost+diamondCost+
 * labourAllocated — every test below that checks a posted COGS amount
 * therefore also proves otherMaterialCost was correctly EXCLUDED (the
 * central Phase 6 audit finding), never just coincidentally equal.
 */
async function seedItem(fixture: FakeFinishedSalesTx, overrides: Partial<Record<string, unknown>> = {}) {
  itemCounter += 1;
  const purity = fixture.seedMetalPurity({ metalType: "GOLD", displayName: "22K", finenessPercent: "91.6" });
  const jobId = `job-${itemCounter}`;
  fixture.state.jewelleryJobs.set(jobId, { id: jobId, jobCode: `ZL-JJOB-2026-${itemCounter}`, status: "COMPLETED" });
  const data: Record<string, unknown> = {
    finishedCode: `ZL-FJ-2026-${itemCounter}`,
    jobId,
    receiptId: `receipt-${itemCounter}`,
    jewelleryType: "RING",
    quantity: 1,
    netMetalWeight: "10.000",
    metalType: "GOLD",
    purityId: purity.id,
    finenessPercentSnapshot: "91.600",
    fineMetalWeight: "9.160",
    metalCost: "50000.00",
    diamondCost: "20000.00",
    otherMaterialCost: "5000.00", // display-only — must NEVER end up in COGS
    labourAllocated: "8000.00",
    totalCost: "83000.00", // = 50000+20000+5000+8000, includes otherMaterialCost
    createdByUserId: "user-1",
    ...overrides,
  };
  const item = await fixture.tx.finishedJewellery.create({ data });
  // Mirrors the real atomic PRODUCED_IN hook receiveFinishedJewellery
  // creates in production — every lifecycle-invariant test below relies
  // on this being present, exactly like a real item's ledger always is.
  await fixture.tx.finishedJewelleryStockMovement.create({
    data: {
      type: "PRODUCED_IN",
      finishedJewelleryId: item.id,
      pieces: 1,
      costValue: "78000.00",
      finishedCodeSnapshot: data.finishedCode,
      jewelleryTypeSnapshot: data.jewelleryType,
      metalTypeSnapshot: data.metalType,
      purityDisplayNameSnapshot: purity.displayName,
      netMetalWeightSnapshot: data.netMetalWeight,
      fineMetalWeightSnapshot: data.fineMetalWeight,
      jobCodeSnapshot: `ZL-JJOB-2026-${itemCounter}`,
      sourceDocument: `ZL-JREC-2026-${itemCounter}`,
      createdByUserId: "user-1",
    },
  });
  return item;
}

const AUTHORITATIVE_COST = 78000; // 50000 + 20000 + 8000 — deliberately excludes otherMaterialCost

describe("getAuthoritativeInventoryCost", () => {
  it("excludes otherMaterialCost — never totalCost", () => {
    const cost = getAuthoritativeInventoryCost({
      metalCost: "50000.00",
      diamondCost: "20000.00",
      labourAllocated: "8000.00",
    });
    expect(cost.toFixed(2)).toBe("78000.00");
  });
});

describe("postFinishedJewellerySale", () => {
  it("posts a balanced single-item sale, moves cost from inventory to COGS at the authoritative amount (not totalCost), and marks the item Sold", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);

    const { sale, voucher } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [
        {
          finishedJewelleryId: item.id as string,
          sellingPrice: 120000,
          gstRatePercent: 3,
          taxType: "EXCLUSIVE",
        },
      ],
    });

    const lines = linesFor(fixture, voucher.id as string);
    expect(sumBy(lines, "debit")).toBeCloseTo(sumBy(lines, "credit"), 5);

    const salesLine = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.SALES_INCOME);
    expect(Number(salesLine?.credit)).toBe(120000);

    const cogsDebit = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS);
    const inventoryCredit = lines.find(
      (l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY
    );
    expect(Number(cogsDebit?.debit)).toBe(AUTHORITATIVE_COST);
    expect(Number(inventoryCredit?.credit)).toBe(AUTHORITATIVE_COST);

    expect(Number(sale.cogsTotal)).toBe(AUTHORITATIVE_COST);

    const updatedItem = fixture.state.finishedJewelleryRows.get(item.id as string);
    expect(updatedItem?.status).toBe("SOLD");

    const movements = [...fixture.state.finishedJewelleryStockMovements.values()].filter(
      (m) => m.finishedJewelleryId === item.id
    );
    const soldOut = movements.find((m) => m.type === "SOLD_OUT");
    expect(soldOut).toBeTruthy();
    expect(Number(soldOut?.costValue)).toBe(AUTHORITATIVE_COST);

    const saleLine = [...fixture.state.finishedJewellerySaleLines.values()].find((l) => l.saleId === sale.id);
    expect(Number(saleLine?.cogsAmount)).toBe(AUTHORITATIVE_COST);
  });

  it("posts an IGST sale correctly", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);

    const { voucher } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common({ gstTreatment: "IGST" }),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });

    const lines = linesFor(fixture, voucher.id as string);
    const igst = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.OUTPUT_IGST);
    expect(Number(igst?.credit)).toBe(3000);
    const cgst = lines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.OUTPUT_CGST);
    expect(cgst).toBeUndefined();
  });

  it("allocates exact line-level values and a correct grand total across a multi-item sale with a discount", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item1 = await seedItem(fixture);
    const item2 = await seedItem(fixture);

    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [
        { finishedJewelleryId: item1.id as string, sellingPrice: 100000, discountShare: 2000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
        { finishedJewelleryId: item2.id as string, sellingPrice: 50000, discountShare: 1000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
      ],
    });

    const saleLines = [...fixture.state.finishedJewellerySaleLines.values()].filter((l) => l.saleId === sale.id);
    expect(saleLines).toHaveLength(2);
    const totalTaxable = saleLines.reduce((sum, l) => sum + Number(l.taxableValue), 0);
    expect(totalTaxable).toBe(147000); // (100000-2000)+(50000-1000)
    expect(Number(sale.discountTotal)).toBe(3000);
    expect(Number(sale.cogsTotal)).toBe(AUTHORITATIVE_COST * 2);
    // Every item claimed exactly once, each with its own COGS.
    for (const l of saleLines) {
      expect(Number(l.cogsAmount)).toBe(AUTHORITATIVE_COST);
    }
  });

  it("rejects selecting the same item twice in one request", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);

    await expect(
      postFinishedJewellerySale(fixture.tx as never, {
        ...common(),
        items: [
          { finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
          { finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
        ],
      })
    ).rejects.toThrow(PostingError);
  });

  it("database-enforced double-sale prevention: a second sale of an already-Sold item is rejected, and no partial journal rows are created for the failed attempt", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);

    await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const journalCountAfterFirst = fixture.state.journalEntries.length;

    await expect(
      postFinishedJewellerySale(fixture.tx as never, {
        ...common(),
        items: [{ finishedJewelleryId: item.id as string, sellingPrice: 90000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
      })
    ).rejects.toThrow(PostingError);

    // The failed second attempt claimed nothing and posted nothing further.
    expect(fixture.state.journalEntries.length).toBe(journalCountAfterFirst);
    const soldOutMovements = [...fixture.state.finishedJewelleryStockMovements.values()].filter(
      (m) => m.finishedJewelleryId === item.id && m.type === "SOLD_OUT"
    );
    expect(soldOutMovements).toHaveLength(1);
  });

  it("rejects selling an item that is not Available (e.g. already Returned-Damaged)", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture, { status: "RETURNED_DAMAGED" });

    await expect(
      postFinishedJewellerySale(fixture.tx as never, {
        ...common(),
        items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
      })
    ).rejects.toThrow(PostingError);
  });

  it("rejects an empty item list", async () => {
    const fixture = createFakeFinishedSalesTx();
    await expect(postFinishedJewellerySale(fixture.tx as never, { ...common(), items: [] })).rejects.toThrow(
      PostingError
    );
  });
});

describe("cancelFinishedJewellerySale", () => {
  async function sellOne(fixture: FakeFinishedSalesTx) {
    const item = await seedItem(fixture);
    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 120000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    return { item, sale };
  }

  it("reverses revenue, GST, receivable and COGS/inventory, restores the item to Available, and records a Sale Reversed movement", async () => {
    const fixture = createFakeFinishedSalesTx();
    const { item, sale } = await sellOne(fixture);

    const { reversal } = await cancelFinishedJewellerySale(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "Customer changed mind",
    });

    const reversalLines = linesFor(fixture, reversal.id as string);
    expect(sumBy(reversalLines, "debit")).toBeCloseTo(sumBy(reversalLines, "credit"), 5);

    const salesDebit = reversalLines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.SALES_INCOME);
    expect(Number(salesDebit?.debit)).toBe(120000);
    const inventoryDebit = reversalLines.find(
      (l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY
    );
    const cogsCredit = reversalLines.find(
      (l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS
    );
    expect(Number(inventoryDebit?.debit)).toBe(AUTHORITATIVE_COST);
    expect(Number(cogsCredit?.credit)).toBe(AUTHORITATIVE_COST);

    const updatedItem = fixture.state.finishedJewelleryRows.get(item.id as string);
    expect(updatedItem?.status).toBe("AVAILABLE");

    const cancelledMovement = [...fixture.state.finishedJewelleryStockMovements.values()].find(
      (m) => m.finishedJewelleryId === item.id && m.type === "SALE_CANCELLED_IN"
    );
    expect(cancelledMovement).toBeTruthy();

    const updatedSale = fixture.state.finishedJewellerySales.get(sale.id as string);
    expect(updatedSale?.status).toBe("CANCELLED");
  });

  it("rejects cancelling an already-cancelled sale", async () => {
    const fixture = createFakeFinishedSalesTx();
    const { sale } = await sellOne(fixture);
    await cancelFinishedJewellerySale(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "First cancel",
    });
    await expect(
      cancelFinishedJewellerySale(fixture.tx as never, {
        ...FY,
        saleId: sale.id as string,
        cancelledByUserId: "owner-1",
        cancellationReason: "Second cancel",
      })
    ).rejects.toThrow(PostingError);
  });

  it("lets the item be sold again after a full cancellation", async () => {
    const fixture = createFakeFinishedSalesTx();
    const { item, sale } = await sellOne(fixture);
    await cancelFinishedJewellerySale(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "Cancelled",
    });

    const { sale: secondSale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 130000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    expect(secondSale.id).not.toBe(sale.id);
    const updatedItem = fixture.state.finishedJewelleryRows.get(item.id as string);
    expect(updatedItem?.status).toBe("SOLD");
  });
});

describe("returnFinishedJewelleryItems", () => {
  async function sellTwo(fixture: FakeFinishedSalesTx) {
    const item1 = await seedItem(fixture);
    const item2 = await seedItem(fixture);
    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [
        { finishedJewelleryId: item1.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
        { finishedJewelleryId: item2.id as string, sellingPrice: 90000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
      ],
    });
    const lines = [...fixture.state.finishedJewellerySaleLines.values()].filter((l) => l.saleId === sale.id);
    const lineFor = (itemId: string) => lines.find((l) => l.finishedJewelleryId === itemId)!;
    return { item1, item2, sale, lineFor };
  }

  it("sellable return: reverses tax/revenue using the ORIGINAL snapshot, moves cost back to Inventory from COGS, and makes the item Available again", async () => {
    const fixture = createFakeFinishedSalesTx();
    const { item1, sale, lineFor } = await sellTwo(fixture);
    const line1 = lineFor(item1.id as string);

    const { return: ret, voucher } = await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line1.id as string, disposition: "SELLABLE" }],
      reason: "Customer changed size",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });

    const revLines = linesFor(fixture, voucher.id as string);
    expect(sumBy(revLines, "debit")).toBeCloseTo(sumBy(revLines, "credit"), 5);

    const returnsDebit = revLines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.SALES_RETURNS);
    expect(Number(returnsDebit?.debit)).toBe(Number(line1.taxableValue));

    const inventoryDebit = revLines.find(
      (l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY
    );
    expect(Number(inventoryDebit?.debit)).toBe(AUTHORITATIVE_COST);

    const updatedItem = fixture.state.finishedJewelleryRows.get(item1.id as string);
    expect(updatedItem?.status).toBe("AVAILABLE");

    const updatedLine = fixture.state.finishedJewellerySaleLines.get(line1.id as string);
    expect(updatedLine?.returnStatus).toBe("RETURNED_SELLABLE");

    const returnLine = [...fixture.state.finishedJewelleryReturnLines.values()].find((l) => l.returnId === ret.id);
    expect(Number(returnLine?.reversedCogsAmount)).toBe(AUTHORITATIVE_COST);
  });

  it("damaged return: reclassifies cost into Damaged Jewellery Loss (not back to Inventory) and never makes the item Available again", async () => {
    const fixture = createFakeFinishedSalesTx();
    const { item1, sale, lineFor } = await sellTwo(fixture);
    const line1 = lineFor(item1.id as string);

    const { voucher } = await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line1.id as string, disposition: "DAMAGED" }],
      reason: "Found cracked stone on inspection",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });

    const revLines = linesFor(fixture, voucher.id as string);
    const lossDebit = revLines.find((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.DAMAGED_JEWELLERY_LOSS);
    const inventoryDebit = revLines.find(
      (l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY
    );
    expect(Number(lossDebit?.debit)).toBe(AUTHORITATIVE_COST);
    expect(inventoryDebit).toBeUndefined();

    const updatedItem = fixture.state.finishedJewelleryRows.get(item1.id as string);
    expect(updatedItem?.status).toBe("RETURNED_DAMAGED");
  });

  it("allows a partial return — the untouched line stays Sold and un-returned", async () => {
    const fixture = createFakeFinishedSalesTx();
    const { item1, item2, sale, lineFor } = await sellTwo(fixture);
    const line1 = lineFor(item1.id as string);

    await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line1.id as string, disposition: "SELLABLE" }],
      reason: "One item only",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });

    const item2Row = fixture.state.finishedJewelleryRows.get(item2.id as string);
    expect(item2Row?.status).toBe("SOLD");
    const line2 = lineFor(item2.id as string);
    const line2Row = fixture.state.finishedJewellerySaleLines.get(line2.id as string);
    expect(line2Row?.returnStatus).toBe("NONE");
  });

  it("rejects returning the same sale line twice", async () => {
    const fixture = createFakeFinishedSalesTx();
    const { item1, sale, lineFor } = await sellTwo(fixture);
    const line1 = lineFor(item1.id as string);

    await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line1.id as string, disposition: "SELLABLE" }],
      reason: "First return",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });

    await expect(
      returnFinishedJewelleryItems(fixture.tx as never, {
        ...FY,
        saleId: sale.id as string,
        items: [{ saleLineId: line1.id as string, disposition: "SELLABLE" }],
        reason: "Second return attempt",
        returnDate: DATE,
        createdByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });

  it("lets a sellable-returned item be resold, correctly claimed again", async () => {
    const fixture = createFakeFinishedSalesTx();
    const { item1, sale, lineFor } = await sellTwo(fixture);
    const line1 = lineFor(item1.id as string);

    await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line1.id as string, disposition: "SELLABLE" }],
      reason: "Resale test",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });

    const { sale: secondSale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item1.id as string, sellingPrice: 105000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const updatedItem = fixture.state.finishedJewelleryRows.get(item1.id as string);
    expect(updatedItem?.status).toBe("SOLD");
    expect(secondSale.id).not.toBe(sale.id);
  });

  it("rejects an empty reason", async () => {
    const fixture = createFakeFinishedSalesTx();
    const { sale, lineFor, item1 } = await sellTwo(fixture);
    const line1 = lineFor(item1.id as string);
    await expect(
      returnFinishedJewelleryItems(fixture.tx as never, {
        ...FY,
        saleId: sale.id as string,
        items: [{ saleLineId: line1.id as string, disposition: "SELLABLE" }],
        reason: "",
        returnDate: DATE,
        createdByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("adjustFinishedJewelleryStock", () => {
  it("OUT: moves an Available item to Sold with an audited reason and an OWNER_ADJUSTMENT_OUT movement", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);

    await adjustFinishedJewelleryStock(fixture.tx as never, {
      finishedJewelleryId: item.id as string,
      direction: "OUT",
      reason: "Sent for exhibition, not a sale",
      createdByUserId: "owner-1",
    });

    const updated = fixture.state.finishedJewelleryRows.get(item.id as string);
    expect(updated?.status).toBe("SOLD");
    const movement = [...fixture.state.finishedJewelleryStockMovements.values()].find(
      (m) => m.finishedJewelleryId === item.id && m.type === "OWNER_ADJUSTMENT_OUT"
    );
    expect(movement?.type).toBe("OWNER_ADJUSTMENT_OUT");
    expect(Number(movement?.costValue)).toBe(AUTHORITATIVE_COST);
  });

  it("IN: moves a Sold item back to Available with an OWNER_ADJUSTMENT_IN movement", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture, { status: "SOLD" });

    await adjustFinishedJewelleryStock(fixture.tx as never, {
      finishedJewelleryId: item.id as string,
      direction: "IN",
      reason: "Exhibition item returned unsold",
      createdByUserId: "owner-1",
    });

    const updated = fixture.state.finishedJewelleryRows.get(item.id as string);
    expect(updated?.status).toBe("AVAILABLE");
  });

  it("rejects a reason shorter than 5 characters", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);
    await expect(
      adjustFinishedJewelleryStock(fixture.tx as never, {
        finishedJewelleryId: item.id as string,
        direction: "OUT",
        reason: "x",
        createdByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });

  it("never allows adjusting a Returned-Damaged item (permanent terminal state)", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture, { status: "RETURNED_DAMAGED" });
    await expect(
      adjustFinishedJewelleryStock(fixture.tx as never, {
        finishedJewelleryId: item.id as string,
        direction: "IN",
        reason: "Trying to un-damage it",
        createdByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });
});

describe("historical snapshot invariance", () => {
  it("a sale line's frozen price/tax/COGS survive a later change to the underlying FinishedJewellery cost fields", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);

    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 120000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const saleLineBefore = { ...[...fixture.state.finishedJewellerySaleLines.values()].find((l) => l.saleId === sale.id)! };

    // Simulate a master-data-style correction to the underlying output's
    // cost fields AFTER the sale has posted (e.g. an admin fixing a data
    // entry mistake on an old, already-sold record).
    const record = fixture.state.finishedJewelleryRows.get(item.id as string)!;
    record.metalCost = "999999.00";
    record.diamondCost = "999999.00";
    record.labourAllocated = "999999.00";
    record.totalCost = "2999997.00";

    const saleLineAfter = [...fixture.state.finishedJewellerySaleLines.values()].find((l) => l.saleId === sale.id)!;
    expect(saleLineAfter.sellingPrice).toBe(saleLineBefore.sellingPrice);
    expect(saleLineAfter.taxableValue).toBe(saleLineBefore.taxableValue);
    expect(saleLineAfter.taxAmount).toBe(saleLineBefore.taxAmount);
    expect(saleLineAfter.cogsAmount).toBe(saleLineBefore.cogsAmount);
    expect(Number(saleLineAfter.cogsAmount)).toBe(AUTHORITATIVE_COST);

    // A later return must reverse using the frozen snapshot, never the
    // now-corrupted current cost fields.
    const { return: ret } = await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: saleLineAfter.id as string, disposition: "SELLABLE" }],
      reason: "Snapshot invariance check",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });
    const returnLine = [...fixture.state.finishedJewelleryReturnLines.values()].find((l) => l.returnId === ret.id);
    expect(Number(returnLine?.reversedCogsAmount)).toBe(AUTHORITATIVE_COST);
  });
});

describe("stock ledger availability-delta invariant (Available balance = Produced + Sale-cancelled-in + Sellable-return-in + Owner-adjustment-in - Sold-out - Owner-adjustment-out)", () => {
  function movementsFor(fixture: FakeFinishedSalesTx, itemId: string) {
    return [...fixture.state.finishedJewelleryStockMovements.values()]
      .filter((m) => m.finishedJewelleryId === itemId)
      .sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()) as {
      type: FinishedJewelleryStockMovementType;
      createdAt: Date;
    }[];
  }

  /** Every running total along the way must stay within [0, 1] — a
   * unique physical item can never be "more than fully available" or
   * "negatively available" at any point in its history. */
  function assertNeverOutOfBounds(runningTotals: number[]) {
    for (const t of runningTotals) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
  }

  it("Produced -> Sold: ledger sums to 0 (unavailable), matching status", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);
    await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const { finalTotal, runningTotals } = reconcileAvailabilityLedger(movementsFor(fixture, item.id as string));
    expect(finalTotal).toBe(0);
    assertNeverOutOfBounds(runningTotals);
  });

  it("Produced -> Sold -> Sellable Return: ledger sums to 1 (available again)", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);
    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const line = await fixture.tx.finishedJewellerySaleLine.findMany({ where: { saleId: sale.id, finishedJewelleryId: item.id } });
    await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line[0].id as string, disposition: "SELLABLE" }],
      reason: "Lifecycle test: sellable return",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });
    const { finalTotal, runningTotals } = reconcileAvailabilityLedger(movementsFor(fixture, item.id as string));
    expect(finalTotal).toBe(1);
    assertNeverOutOfBounds(runningTotals);
    const updated = fixture.state.finishedJewelleryRows.get(item.id as string);
    expect(updated?.status).toBe("AVAILABLE");
  });

  it("Produced -> Sold -> Sellable Return -> Resold: ledger sums to 0 again", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);
    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const line = await fixture.tx.finishedJewellerySaleLine.findMany({ where: { saleId: sale.id, finishedJewelleryId: item.id } });
    await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line[0].id as string, disposition: "SELLABLE" }],
      reason: "Lifecycle test: resale",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });
    await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 105000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const { finalTotal, runningTotals } = reconcileAvailabilityLedger(movementsFor(fixture, item.id as string));
    expect(finalTotal).toBe(0);
    assertNeverOutOfBounds(runningTotals);
  });

  it("Produced -> Sold -> Sellable Return -> Resold: no duplicate stock movement, and COGS is booked exactly once net (never doubled)", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);
    const cost = getAuthoritativeInventoryCost(item as never);
    const { sale: sale1, voucher: voucher1 } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const line = await fixture.tx.finishedJewellerySaleLine.findMany({ where: { saleId: sale1.id, finishedJewelleryId: item.id } });
    const { voucher: returnVoucher } = await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale1.id as string,
      items: [{ saleLineId: line[0].id as string, disposition: "SELLABLE" }],
      reason: "Lifecycle test: no double COGS / no duplicate movement",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });
    const { voucher: voucher2 } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 105000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });

    // No duplicate stock movement: exactly the 4 expected events, in order,
    // each occurring once — never two consecutive SOLD_OUT (which would
    // mean the second sale claimed an item the first sale never released)
    // and never a repeated RETURNED_SELLABLE_IN.
    const movementTypes = movementsFor(fixture, item.id as string).map((m) => m.type);
    expect(movementTypes).toEqual(["PRODUCED_IN", "SOLD_OUT", "RETURNED_SELLABLE_IN", "SOLD_OUT"]);

    // No double COGS: sale1 debits FINISHED_JEWELLERY_COGS by `cost`, the
    // sellable return fully reverses it (credits `cost` back), and sale2
    // debits `cost` again — net across all three vouchers must equal
    // exactly ONE unit's cost, not two, proving the first sale's COGS was
    // never left standing alongside the second's.
    const allCogsLines = [voucher1.id, returnVoucher.id, voucher2.id]
      .flatMap((voucherId) => linesFor(fixture, voucherId as string))
      .filter((l) => codeOf(fixture, l.accountId) === SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_COGS);
    const netCogs = sumBy(allCogsLines, "debit") - sumBy(allCogsLines, "credit");
    expect(netCogs.toFixed(2)).toBe(cost.toFixed(2));
  });

  it("Produced -> Sold -> Damaged Return: ledger sums to 0 (RETURNED_DAMAGED_OUT has ZERO delta, not -1)", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);
    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const line = await fixture.tx.finishedJewellerySaleLine.findMany({ where: { saleId: sale.id, finishedJewelleryId: item.id } });
    await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line[0].id as string, disposition: "DAMAGED" }],
      reason: "Lifecycle test: damaged return",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });
    const movements = movementsFor(fixture, item.id as string);
    expect(movements.map((m) => m.type)).toEqual(["PRODUCED_IN", "SOLD_OUT", "RETURNED_DAMAGED_OUT"]);
    const { finalTotal, runningTotals } = reconcileAvailabilityLedger(movements);
    // PRODUCED_IN(+1) + SOLD_OUT(-1) + RETURNED_DAMAGED_OUT(0) = 0 — if
    // RETURNED_DAMAGED_OUT wrongly carried a -1 delta this would be -1,
    // violating the never-negative invariant below.
    expect(finalTotal).toBe(0);
    assertNeverOutOfBounds(runningTotals);
    const updated = fixture.state.finishedJewelleryRows.get(item.id as string);
    expect(updated?.status).toBe("RETURNED_DAMAGED");
  });

  it("Produced -> Sold -> Cancelled: ledger sums to 1 (available again)", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);
    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    await cancelFinishedJewellerySale(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      cancelledByUserId: "owner-1",
      cancellationReason: "Lifecycle test: cancellation",
    });
    const { finalTotal, runningTotals } = reconcileAvailabilityLedger(movementsFor(fixture, item.id as string));
    expect(finalTotal).toBe(1);
    assertNeverOutOfBounds(runningTotals);
  });

  it("Partial multi-item return: each item's own ledger reconciles independently", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item1 = await seedItem(fixture);
    const item2 = await seedItem(fixture);
    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [
        { finishedJewelleryId: item1.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
        { finishedJewelleryId: item2.id as string, sellingPrice: 90000, gstRatePercent: 3, taxType: "EXCLUSIVE" },
      ],
    });
    const lines = await fixture.tx.finishedJewellerySaleLine.findMany({ where: { saleId: sale.id } });
    const line1 = lines.find((l) => l.finishedJewelleryId === item1.id)!;
    await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line1.id as string, disposition: "SELLABLE" }],
      reason: "Lifecycle test: partial return",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });
    const r1 = reconcileAvailabilityLedger(movementsFor(fixture, item1.id as string));
    const r2 = reconcileAvailabilityLedger(movementsFor(fixture, item2.id as string));
    expect(r1.finalTotal).toBe(1); // returned -> Available
    expect(r2.finalTotal).toBe(0); // untouched -> still Sold
    assertNeverOutOfBounds(r1.runningTotals);
    assertNeverOutOfBounds(r2.runningTotals);
  });

  it("Owner adjustment boundaries: OUT then IN reconciles to 1, and a second OUT without a matching IN never drops below 0", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);
    await adjustFinishedJewelleryStock(fixture.tx as never, {
      finishedJewelleryId: item.id as string,
      direction: "OUT",
      reason: "Lifecycle test: adjustment out",
      createdByUserId: "owner-1",
    });
    const afterOut = reconcileAvailabilityLedger(movementsFor(fixture, item.id as string));
    expect(afterOut.finalTotal).toBe(0);
    assertNeverOutOfBounds(afterOut.runningTotals);

    await adjustFinishedJewelleryStock(fixture.tx as never, {
      finishedJewelleryId: item.id as string,
      direction: "IN",
      reason: "Lifecycle test: adjustment back in",
      createdByUserId: "owner-1",
    });
    const afterIn = reconcileAvailabilityLedger(movementsFor(fixture, item.id as string));
    expect(afterIn.finalTotal).toBe(1);
    assertNeverOutOfBounds(afterIn.runningTotals);

    // A second OUT adjustment attempt (already Available -> OUT is the
    // only valid direction from here) must not be rejected structurally,
    // but the DB-enforced status guard prevents any sequence from ever
    // going below the single-item bound in the first place.
    await adjustFinishedJewelleryStock(fixture.tx as never, {
      finishedJewelleryId: item.id as string,
      direction: "OUT",
      reason: "Lifecycle test: adjustment out again",
      createdByUserId: "owner-1",
    });
    const afterSecondOut = reconcileAvailabilityLedger(movementsFor(fixture, item.id as string));
    expect(afterSecondOut.finalTotal).toBe(0);
    assertNeverOutOfBounds(afterSecondOut.runningTotals);

    // A third, unmatched OUT must be REJECTED by the status guard (the
    // item is already not-Available) — proving the ledger can never be
    // pushed negative even by a determined sequence of adjustments.
    await expect(
      adjustFinishedJewelleryStock(fixture.tx as never, {
        finishedJewelleryId: item.id as string,
        direction: "OUT",
        reason: "Lifecycle test: rejected extra out",
        createdByUserId: "owner-1",
      })
    ).rejects.toThrow(PostingError);
  });

  it("RETURNED_DAMAGED_OUT never appears without a preceding SOLD_OUT for the same item", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item = await seedItem(fixture);
    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      items: [{ finishedJewelleryId: item.id as string, sellingPrice: 100000, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
    });
    const line = await fixture.tx.finishedJewellerySaleLine.findMany({ where: { saleId: sale.id, finishedJewelleryId: item.id } });
    await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: [{ saleLineId: line[0].id as string, disposition: "DAMAGED" }],
      reason: "Lifecycle test: ordering check",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });
    const movements = movementsFor(fixture, item.id as string);
    const damagedIndex = movements.findIndex((m) => m.type === "RETURNED_DAMAGED_OUT");
    const soldOutIndex = movements.findIndex((m) => m.type === "SOLD_OUT");
    expect(damagedIndex).toBeGreaterThan(soldOutIndex);
    expect(soldOutIndex).toBeGreaterThanOrEqual(0);
  });
});

describe("exact paise equality: Sale -> Payment -> Return -> Refund round-trips AR to EXACTLY its starting balance", () => {
  function arNet(fixture: FakeFinishedSalesTx, partyId: string): string {
    const ar = fixture.state.accounts.get(SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE)!;
    const lines = fixture.state.journalEntries.filter((e) => e.partyId === partyId && e.accountId === ar.id);
    const debit = lines.reduce((sum, l) => sum.plus(l.debit as string), new Decimal(0));
    const credit = lines.reduce((sum, l) => sum.plus(l.credit as string), new Decimal(0));
    return debit.minus(credit).toFixed(2);
  }

  it("a deliberately uneven multi-item CGST+SGST sale, fully paid then fully returned then fully refunded, reconciles to EXACTLY 0.00 — string equality, no tolerance", async () => {
    const fixture = createFakeFinishedSalesTx();
    const item1 = await seedItem(fixture);
    const item2 = await seedItem(fixture);
    const item3 = await seedItem(fixture);
    const bankId = fixture.paymentAccountIdByMethod.get("BANK")!;

    const arBefore = arNet(fixture, "customer-1");
    expect(arBefore).toBe("0.00");

    // Deliberately uneven amounts (not round numbers) so the CGST/SGST
    // 1-paise-remainder-to-SGST split (see splitGstAmount) is genuinely
    // exercised, not just trivially zero.
    const { sale } = await postFinishedJewellerySale(fixture.tx as never, {
      ...common(),
      paymentAccountId: bankId,
      items: [
        { finishedJewelleryId: item1.id as string, sellingPrice: 33333.33, discountShare: 0.01, gstRatePercent: 3, taxType: "EXCLUSIVE" },
        { finishedJewelleryId: item2.id as string, sellingPrice: 33333.33, discountShare: 0.01, gstRatePercent: 3, taxType: "EXCLUSIVE" },
        { finishedJewelleryId: item3.id as string, sellingPrice: 33333.34, discountShare: 0.01, gstRatePercent: 3, taxType: "EXCLUSIVE" },
      ],
    });

    // Fully paid at sale time -> AR must net to EXACTLY zero, not merely
    // close to zero.
    const arAfterSale = arNet(fixture, "customer-1");
    expect(arAfterSale).toBe("0.00");

    const lines = await fixture.tx.finishedJewellerySaleLine.findMany({ where: { saleId: sale.id } });
    const { voucher: returnVoucher } = await returnFinishedJewelleryItems(fixture.tx as never, {
      ...FY,
      saleId: sale.id as string,
      items: lines.map((l) => ({ saleLineId: l.id as string, disposition: "SELLABLE" as const })),
      reason: "Exact paise equality test — full return",
      returnDate: DATE,
      createdByUserId: "owner-1",
    });

    // The return posts Cr AR for the full original grand total — since
    // the sale had already been fully paid (AR was 0), AR must now be
    // EXACTLY negative that amount: real, exact customer credit.
    const arAccountId = fixture.state.accounts.get(SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE)!.id;
    const arCreditLine = fixture.state.journalEntries.find(
      (l) => l.voucherId === returnVoucher.id && l.accountId === arAccountId
    );
    expect(arCreditLine).toBeTruthy();
    const arAfterReturn = arNet(fixture, "customer-1");
    const availableCredit = new Decimal(arAfterReturn).abs().toFixed(2);
    expect(availableCredit).not.toBe("0.00");

    await postCustomerRefund(fixture.tx as never, {
      date: DATE,
      ...FY,
      currencyCode: "INR",
      exchangeRate: 1,
      createdByUserId: "owner-1",
      partyId: "customer-1",
      paymentAccountId: bankId,
      amount: availableCredit,
    });

    const arAfterRefund = arNet(fixture, "customer-1");
    // EXACT equality at stored currency precision — not "close to",
    // not "within 0.01". A single cent of drift here fails this test.
    expect(arAfterRefund).toBe(arBefore);
    expect(arAfterRefund).toBe("0.00");
  });
});
