import { describe, expect, it } from "vitest";

import { createFakePolishedTx } from "../../../test/fixtures/fakePolishedTx";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { Decimal, ZERO } from "@/lib/accounting/money";
import { buildPacketMergeKey } from "@/lib/diamond/packets";
import {
  lineRateValue,
  cancelPolishedPurchase,
  computeBrokerageAmount,
  createPolishedPurchase,
  getPacketBalanceInTx,
  PostingError,
  type CreatePolishedPurchaseInput,
  type PolishedPurchaseLineInput,
} from "./polishedPurchase";

type Fixture = ReturnType<typeof createFakePolishedTx>;

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-16T00:00:00.000Z");

function line(overrides: Partial<PolishedPurchaseLineInput> = {}): PolishedPurchaseLineInput {
  return {
    shape: "ROUND",
    sizeLabel: "+2-4",
    pieces: 100,
    carat: 5,
    quality: "VS",
    colour: "DEF",
    lab: "IGI",
    rateBasis: "PER_CARAT",
    rate: 10000,
    ...overrides,
  };
}

function purchaseArgs(fixture: Fixture, overrides: Partial<CreatePolishedPurchaseInput> = {}): CreatePolishedPurchaseInput {
  const supplier = [...fixture.state.parties.values()].find((p) => p.type === "SUPPLIER");
  return {
    ...FY,
    purchaseDate: DATE,
    supplierId: (supplier?.id as string) ?? "supplier-1",
    currencyCode: "INR",
    exchangeRate: 1,
    supplierAmount: 50000,
    gstTreatment: "NONE",
    brokerageTreatment: "NONE",
    lines: [line()],
    createdByUserId: "user-1",
    ...overrides,
  };
}

function accountId(fixture: Fixture, code: string) {
  return fixture.state.accounts.get(code)!.id;
}

function ledger(fixture: Fixture, code: string, partyId?: string): string {
  const id = accountId(fixture, code);
  return fixture.state.journalEntries
    .filter((e) => e.accountId === id && (partyId === undefined || e.partyId === partyId))
    .reduce((sum, e) => sum.plus(new Decimal(e.debit as string)).minus(new Decimal(e.credit as string)), ZERO)
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

function setup() {
  const fixture = createFakePolishedTx();
  const supplier = fixture.seedParty({ name: "PHASE7 Supplier", type: "SUPPLIER" });
  const broker = fixture.seedParty({ name: "PHASE7 Dalal", type: "BROKER" });
  return { fixture, supplier, broker };
}

describe("computeBrokerageAmount", () => {
  it("computes per-carat, percent and fixed brokerage", () => {
    expect(computeBrokerageAmount({ method: "PER_CARAT", rate: 150, supplierAmount: 50000, totalCarat: 5 }).toFixed(2)).toBe("750.00");
    expect(computeBrokerageAmount({ method: "PERCENT", rate: 2, supplierAmount: 50000, totalCarat: 5 }).toFixed(2)).toBe("1000.00");
    expect(computeBrokerageAmount({ method: "FIXED", rate: 1250.5, supplierAmount: 50000, totalCarat: 5 }).toFixed(2)).toBe("1250.50");
  });

  it("never computes a percentage of an amount that already includes brokerage", () => {
    // 2% of the supplier's own 50,000 — not of 50,000 + brokerage.
    expect(computeBrokerageAmount({ method: "PERCENT", rate: 2, supplierAmount: 50000, totalCarat: 5 }).toFixed(2)).toBe("1000.00");
  });
});

describe("createPolishedPurchase", () => {
  it("buys a packet on credit: stock, provenance and a balanced voucher — with no invented rough parent", async () => {
    const { fixture, supplier } = setup();
    const { purchase, packets } = await createPolishedPurchase(fixture.tx as never, purchaseArgs(fixture, { supplierId: supplier.id as string }));

    expect(purchase.purchaseCode).toMatch(/^ZL-PP-\d{4}-\d{6}$/);
    expect(purchase.landedCost).toBe("50000.00");
    expect(packets).toHaveLength(1);
    expect(packets[0].packetCode).toMatch(/^ZL-PKT-\d{4}-\d{6}$/);
    expect(packets[0].provenance).toBe("PURCHASED");
    expect(packets[0].purchaseLineId).toBeTruthy();
    expect(packets[0].mergeKey).toBe(
      buildPacketMergeKey({
        shape: "ROUND",
        sizeLabel: "+2-4",
        quality: "VS",
        colour: "DEF",
        lab: "IGI",
        certificateStatus: "NOT_CERTIFIED",
        provenance: "PURCHASED",
        currencyCode: "INR",
      })
    );

    const balance = await getPacketBalanceInTx(fixture.tx as never, packets[0].id as string);
    expect(balance.pieces).toBe(100);
    expect(balance.carat.toFixed(3)).toBe("5.000");
    expect(balance.costValue.toFixed(2)).toBe("50000.00");

    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)).toBe("50000.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, supplier.id)).toBe("-50000.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("posts input GST on the supplier amount and settles immediately when paid", async () => {
    const { fixture, supplier } = setup();
    await createPolishedPurchase(
      fixture.tx as never,
      purchaseArgs(fixture, {
        supplierId: supplier.id as string,
        gstTreatment: "CGST_SGST",
        gstRatePercent: 3,
        paymentAccountId: fixture.paymentAccountIdByMethod.get("BANK"),
      })
    );
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.INPUT_CGST)).toBe("750.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.INPUT_SGST)).toBe("750.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, supplier.id)).toBe("0.00");
    expect(ledger(fixture, "1002")).toBe("-51500.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("splits landed cost across multiple packet lines, summing exactly", async () => {
    const { fixture } = setup();
    const { packets } = await createPolishedPurchase(
      fixture.tx as never,
      purchaseArgs(fixture, {
        supplierAmount: 10000,
        lines: [line({ carat: 1, pieces: 10 }), line({ carat: 1, pieces: 10, sizeLabel: "+4-6" }), line({ carat: 1, pieces: 10, sizeLabel: "+6-8" })],
      })
    );
    const costs = [];
    for (const packet of packets) {
      const balance = await getPacketBalanceInTx(fixture.tx as never, packet.id as string);
      costs.push(balance.costValue);
    }
    const total = costs.reduce((sum, c) => sum.plus(c), ZERO);
    expect(total.toFixed(2)).toBe("10000.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)).toBe("10000.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("splits landed cost by each line's own rate value, so a dearer size keeps its higher cost per carat", async () => {
    // Found in the Phase 7 browser run: two sizes at 5,000/ct and 8,000/ct were
    // split by carat, pricing both at 6,060/ct. By rate value they keep 5,050/ct
    // and 8,080/ct once 1% capitalised brokerage is added.
    const { fixture } = setup();
    const broker = fixture.seedParty({ name: "Dalal", type: "BROKER" });
    const { packets } = await createPolishedPurchase(
      fixture.tx as never,
      purchaseArgs(fixture, {
        supplierAmount: 90000,
        brokerPartyId: broker.id,
        brokerageMethod: "PERCENT",
        brokerageRate: 1,
        brokerageTreatment: "CAPITALISED_PAYABLE_TO_BROKER",
        lines: [
          line({ sizeLabel: "1.00-1.20MM", pieces: 100, carat: 10, rateBasis: "PER_CARAT", rate: 5000 }),
          line({ sizeLabel: "1.50MM", pieces: 50, carat: 5, rateBasis: "PER_CARAT", rate: 8000 }),
        ],
      })
    );
    const a = await getPacketBalanceInTx(fixture.tx as never, packets[0].id as string);
    const b = await getPacketBalanceInTx(fixture.tx as never, packets[1].id as string);
    expect(a.costValue.toFixed(2)).toBe("50500.00");
    expect(b.costValue.toFixed(2)).toBe("40400.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)).toBe("90900.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("falls back to carat only when some line has no rate value, and a per-piece rate counts pieces", async () => {
    expect(lineRateValue({ rateBasis: "PER_PIECE", rate: 25, carat: 1, pieces: 40 }).toFixed(2)).toBe("1000.00");
    expect(lineRateValue({ rateBasis: "FIXED_TOTAL", rate: 1234.5, carat: 1, pieces: 40 }).toFixed(2)).toBe("1234.50");
    const { fixture } = setup();
    const { packets } = await createPolishedPurchase(
      fixture.tx as never,
      purchaseArgs(fixture, {
        supplierAmount: 9000,
        lines: [line({ carat: 2, rate: 0 }), line({ carat: 1, sizeLabel: "+4-6", rate: 7000 })],
      })
    );
    const first = await getPacketBalanceInTx(fixture.tx as never, packets[0].id as string);
    expect(first.costValue.toFixed(2)).toBe("6000.00");
  });

  it("honours manual per-line costs only when they sum exactly to the landed cost", async () => {
    const { fixture } = setup();
    await expect(
      createPolishedPurchase(
        fixture.tx as never,
        purchaseArgs(fixture, {
          supplierAmount: 10000,
          lines: [line({ carat: 1, manualLandedCost: 6000 }), line({ carat: 1, sizeLabel: "+4-6", manualLandedCost: 3500 })],
        })
      )
    ).rejects.toThrow(/must exactly equal the purchase's landed cost/);

    const { packets } = await createPolishedPurchase(
      fixture.tx as never,
      purchaseArgs(fixture, {
        supplierAmount: 10000,
        lines: [line({ carat: 1, manualLandedCost: 6000 }), line({ carat: 1, sizeLabel: "+4-6", manualLandedCost: 4000 })],
      })
    );
    const first = await getPacketBalanceInTx(fixture.tx as never, packets[0].id as string);
    expect(first.costValue.toFixed(2)).toBe("6000.00");
  });
});

describe("Dalal / Broker brokerage", () => {
  it("INCLUDED_IN_SUPPLIER_COST records the brokerage but creates no second payable", async () => {
    const { fixture, supplier, broker } = setup();
    const { purchase } = await createPolishedPurchase(
      fixture.tx as never,
      purchaseArgs(fixture, {
        supplierId: supplier.id as string,
        brokerPartyId: broker.id as string,
        brokerageMethod: "PERCENT",
        brokerageRate: 2,
        brokerageTreatment: "INCLUDED_IN_SUPPLIER_COST",
      })
    );
    expect(purchase.brokerageAmount).toBe("1000.00");
    expect(purchase.brokerNameSnapshot).toBe("PHASE7 Dalal");
    expect(purchase.landedCost).toBe("50000.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)).toBe("50000.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, broker.id)).toBe("0.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.BROKERAGE_EXPENSE)).toBe("0.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("CAPITALISED_PAYABLE_TO_BROKER puts brokerage in stock value and owes the broker once", async () => {
    const { fixture, supplier, broker } = setup();
    const { purchase, packets } = await createPolishedPurchase(
      fixture.tx as never,
      purchaseArgs(fixture, {
        supplierId: supplier.id as string,
        brokerPartyId: broker.id as string,
        brokerageMethod: "PER_CARAT",
        brokerageRate: 150,
        brokerageTreatment: "CAPITALISED_PAYABLE_TO_BROKER",
      })
    );
    expect(purchase.brokerageAmount).toBe("750.00");
    expect(purchase.landedCost).toBe("50750.00");
    const balance = await getPacketBalanceInTx(fixture.tx as never, packets[0].id as string);
    expect(balance.costValue.toFixed(2)).toBe("50750.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)).toBe("50750.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, supplier.id)).toBe("-50000.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, broker.id)).toBe("-750.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.BROKERAGE_EXPENSE)).toBe("0.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("EXPENSED_PAYABLE_TO_BROKER keeps brokerage out of stock value and expenses it once", async () => {
    const { fixture, supplier, broker } = setup();
    const { purchase, packets } = await createPolishedPurchase(
      fixture.tx as never,
      purchaseArgs(fixture, {
        supplierId: supplier.id as string,
        brokerPartyId: broker.id as string,
        brokerageMethod: "FIXED",
        brokerageRate: 1200,
        brokerageTreatment: "EXPENSED_PAYABLE_TO_BROKER",
      })
    );
    expect(purchase.landedCost).toBe("50000.00");
    const balance = await getPacketBalanceInTx(fixture.tx as never, packets[0].id as string);
    expect(balance.costValue.toFixed(2)).toBe("50000.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.BROKERAGE_EXPENSE)).toBe("1200.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, broker.id)).toBe("-1200.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)).toBe("50000.00");
    expectEveryVoucherBalanced(fixture);
  });

  it("never posts brokerage twice — it is either in stock value or in expense, never both", async () => {
    for (const treatment of ["CAPITALISED_PAYABLE_TO_BROKER", "EXPENSED_PAYABLE_TO_BROKER"] as const) {
      const { fixture, supplier, broker } = setup();
      await createPolishedPurchase(
        fixture.tx as never,
        purchaseArgs(fixture, {
          supplierId: supplier.id as string,
          brokerPartyId: broker.id as string,
          brokerageMethod: "FIXED",
          brokerageRate: 900,
          brokerageTreatment: treatment,
        })
      );
      const inStock = new Decimal(ledger(fixture, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)).minus(50000);
      const inExpense = new Decimal(ledger(fixture, SYSTEM_ACCOUNT_CODES.BROKERAGE_EXPENSE));
      expect(inStock.plus(inExpense).toFixed(2)).toBe("900.00");
      expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, broker.id)).toBe("-900.00");
    }
  });

  it("requires a real Dalal / Broker party for any brokerage", async () => {
    const { fixture, supplier, broker } = setup();
    const notABroker = fixture.seedParty({ name: "PHASE7 Karigar", type: "KARIGAR" });

    await expect(
      createPolishedPurchase(
        fixture.tx as never,
        purchaseArgs(fixture, { brokerageTreatment: "EXPENSED_PAYABLE_TO_BROKER", brokerageMethod: "FIXED", brokerageRate: 100 })
      )
    ).rejects.toThrow(/Choose the Dalal \/ Broker/);

    await expect(
      createPolishedPurchase(
        fixture.tx as never,
        purchaseArgs(fixture, {
          brokerPartyId: notABroker.id as string,
          brokerageMethod: "FIXED",
          brokerageRate: 100,
          brokerageTreatment: "EXPENSED_PAYABLE_TO_BROKER",
        })
      )
    ).rejects.toThrow(/not a Dalal \/ Broker/);

    await expect(
      createPolishedPurchase(
        fixture.tx as never,
        purchaseArgs(fixture, {
          supplierId: supplier.id as string,
          brokerPartyId: broker.id as string,
          brokerageTreatment: "CAPITALISED_PAYABLE_TO_BROKER",
        })
      )
    ).rejects.toThrow(/how the brokerage is calculated/);
  });
});

describe("validation", () => {
  it("rejects an empty purchase, zero quantities, a missing size and an unnamed custom shape", async () => {
    const { fixture } = setup();
    await expect(createPolishedPurchase(fixture.tx as never, purchaseArgs(fixture, { lines: [] }))).rejects.toThrow(
      /at least one packet line/
    );
    await expect(
      createPolishedPurchase(fixture.tx as never, purchaseArgs(fixture, { lines: [line({ pieces: 0 })] }))
    ).rejects.toThrow(/whole number of pieces/);
    await expect(
      createPolishedPurchase(fixture.tx as never, purchaseArgs(fixture, { lines: [line({ carat: 0 })] }))
    ).rejects.toThrow(/carat must be greater than zero/);
    await expect(
      createPolishedPurchase(fixture.tx as never, purchaseArgs(fixture, { lines: [line({ sizeLabel: "  " })] }))
    ).rejects.toThrow(/size/);
    await expect(
      createPolishedPurchase(fixture.tx as never, purchaseArgs(fixture, { lines: [line({ shape: "CUSTOM" })] }))
    ).rejects.toThrow(/Name the custom shape/);
    await expect(createPolishedPurchase(fixture.tx as never, purchaseArgs(fixture, { supplierAmount: 0 }))).rejects.toThrow(
      /Supplier amount/
    );
    expect(fixture.state.polishedPackets.size).toBe(0);
  });
});

describe("cancelPolishedPurchase", () => {
  it("reverses the voucher and empties the packets while the stones are untouched", async () => {
    const { fixture, supplier, broker } = setup();
    const { purchase, packets } = await createPolishedPurchase(
      fixture.tx as never,
      purchaseArgs(fixture, {
        supplierId: supplier.id as string,
        brokerPartyId: broker.id as string,
        brokerageMethod: "FIXED",
        brokerageRate: 500,
        brokerageTreatment: "CAPITALISED_PAYABLE_TO_BROKER",
      })
    );

    const cancelled = await cancelPolishedPurchase(fixture.tx as never, {
      ...FY,
      purchaseId: purchase.id as string,
      cancelledByUserId: "user-1",
      cancellationReason: "Supplier sent the wrong sizes",
    });

    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancellationVoucherId).toBeTruthy();
    expect(fixture.state.polishedPackets.get(packets[0].id as string)!.status).toBe("CANCELLED");

    const balance = await getPacketBalanceInTx(fixture.tx as never, packets[0].id as string);
    expect(balance.pieces).toBe(0);
    expect(balance.carat.toFixed(3)).toBe("0.000");
    expect(balance.costValue.toFixed(2)).toBe("0.00");

    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY)).toBe("0.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, supplier.id)).toBe("0.00");
    expect(ledger(fixture, SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, broker.id)).toBe("0.00");
    expectEveryVoucherBalanced(fixture);

    const cancelMovement = [...fixture.state.polishedPacketMovements.values()].find((m) => m.type === "PURCHASE_CANCEL_OUT");
    expect(cancelMovement?.reversalOfMovementId).toBeTruthy();
  });

  it("refuses once any of the stones have moved, and refuses a second cancellation", async () => {
    const { fixture } = setup();
    const { purchase, packets } = await createPolishedPurchase(fixture.tx as never, purchaseArgs(fixture));

    await fixture.tx.polishedPacketMovement.create({
      data: {
        type: "JEWELLERY_ISSUE_OUT",
        packetId: packets[0].id,
        pieces: 10,
        carat: "0.500",
        costValue: "5000.00",
        sourceDocument: "ZL-JJOB-TEST",
        createdByUserId: "user-1",
      },
    });

    await expect(
      cancelPolishedPurchase(fixture.tx as never, {
        ...FY,
        purchaseId: purchase.id as string,
        cancelledByUserId: "user-1",
        cancellationReason: "Changed my mind",
      })
    ).rejects.toThrow(/already been used/);

    const clean = setup();
    const created = await createPolishedPurchase(clean.fixture.tx as never, purchaseArgs(clean.fixture));
    const args = {
      ...FY,
      purchaseId: created.purchase.id as string,
      cancelledByUserId: "user-1",
      cancellationReason: "Wrong parcel",
    };
    await cancelPolishedPurchase(clean.fixture.tx as never, args);
    await expect(cancelPolishedPurchase(clean.fixture.tx as never, args)).rejects.toThrow(/already been cancelled/);
  });

  it("requires a reason", async () => {
    const { fixture } = setup();
    const { purchase } = await createPolishedPurchase(fixture.tx as never, purchaseArgs(fixture));
    await expect(
      cancelPolishedPurchase(fixture.tx as never, {
        ...FY,
        purchaseId: purchase.id as string,
        cancelledByUserId: "user-1",
        cancellationReason: "x",
      })
    ).rejects.toThrow(PostingError);
  });
});
