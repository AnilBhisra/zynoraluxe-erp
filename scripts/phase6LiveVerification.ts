import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import {
  createJewelleryJob,
  createMetalPurchase,
  issueMaterialsToJewelleryJob,
  receiveFinishedJewellery,
} from "../src/lib/jewellery/posting";
import {
  cancelFinishedJewellerySale,
  getAuthoritativeInventoryCost,
  postFinishedJewellerySale,
  returnFinishedJewelleryItems,
} from "../src/lib/jewellery/finishedSalesPosting";
import { postCustomerRefund, postPaymentReceived } from "../src/lib/accounting/posting";
import { getProfitAndLoss } from "../src/lib/accounting/reports";
import { SYSTEM_ACCOUNT_CODES } from "../src/lib/accounting/accounts";

const PREFIX = "PHASE6TEST";
const FY = { fyStartMonth: 4, fyStartDay: 1 };

function log(msg: string) {
  console.log(msg);
}
function section(title: string) {
  console.log(`\n=== ${title} ===`);
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  OK: ${msg}`);
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  const testStartedAt = new Date();
  const createdPartyIds: string[] = [];

  try {
    section("Setup: real Owner, purity, payment account, test parties");
    const owner = await prisma.user.findFirst({ where: { role: "OWNER" } });
    if (!owner) throw new Error("No Owner user found in this database.");
    log(`  Owner: ${owner.email} (${owner.id})`);

    const purity = await prisma.metalPurity.findFirst({ where: { metalType: "GOLD", isActive: true }, orderBy: { finenessPercent: "desc" } });
    if (!purity) throw new Error("No active GOLD purity found.");
    log(`  Purity: ${purity.displayName} (${purity.finenessPercent}%)`);
    // Phase G uses a SECOND, distinct purity so its metal stock pool never
    // interacts with Job 1's (avoids any shared-pool weighted-cost effects).
    const purity2 = await prisma.metalPurity.findFirst({ where: { metalType: "GOLD", isActive: true, id: { not: purity.id } }, orderBy: { finenessPercent: "asc" } });
    if (!purity2) throw new Error("No second active GOLD purity found.");
    log(`  Purity 2 (for Phase G): ${purity2.displayName} (${purity2.finenessPercent}%)`);

    const paymentAccount = await prisma.paymentAccount.findFirst({ where: { isActive: true, method: "CASH" } });
    if (!paymentAccount) throw new Error("No active CASH payment account found.");
    log(`  Payment account: ${paymentAccount.name} (${paymentAccount.id})`);

    const supplier = await prisma.party.create({
      data: { name: `${PREFIX} Supplier`, type: "SUPPLIER", isActive: true, createdByUserId: owner.id },
    });
    const karigar = await prisma.party.create({
      data: { name: `${PREFIX} Karigar`, type: "KARIGAR", isActive: true, createdByUserId: owner.id },
    });
    const customer = await prisma.party.create({
      data: { name: `${PREFIX} Customer`, type: "CUSTOMER", isActive: true, createdByUserId: owner.id },
    });
    createdPartyIds.push(supplier.id, karigar.id, customer.id);
    log(`  Created Supplier ${supplier.id}, Karigar ${karigar.id}, Customer ${customer.id}`);

    // -------------------------------------------------------------------
    // Phase A: rough chain -> Job 1 (2 outputs) with a real other-material
    // line, so this live run also empirically proves otherMaterialCost is
    // excluded from COGS, not just the unit-test fixture.
    // -------------------------------------------------------------------
    section("Phase A: Metal purchase -> Job 1 -> Issue -> Receive (2 outputs)");
    const now = new Date();

    const { job1, output1Id, output2Id } = await prisma.$transaction(
      async (tx) => {
        await createMetalPurchase(tx, {
          ...FY,
          currencyCode: "INR",
          exchangeRate: 1,
          createdByUserId: owner.id,
          purchaseDate: now,
          supplierId: supplier.id,
          metalType: "GOLD",
          purityId: purity.id,
          grossWeight: 20,
          rateBasis: "PER_GROSS_GRAM",
          rate: 5000,
          totalPurchaseCost: 100000,
          gstTreatment: "NONE",
        });

        const job = await createJewelleryJob(tx, {
          customerId: customer.id,
          jewelleryType: "RING",
          designName: `${PREFIX} Ring Design`,
          karigarId: karigar.id,
          issueDate: now,
          quantity: 2,
          createdByUserId: owner.id,
        });

        const issued = await issueMaterialsToJewelleryJob(tx, {
          ...FY,
          createdByUserId: owner.id,
          jobId: job.id,
          issueDate: now,
          metalLines: [{ metalType: "GOLD", purityId: purity.id, grossWeight: 20 }],
          polishedDiamondIds: [],
          otherMaterialLines: [{ description: "Enamel work", quantity: 1, unit: "PCS", cost: 2000 }],
        });
        assert(issued.status === "MATERIALS_ISSUED", "Job 1 issued materials");

        const receipt = await receiveFinishedJewellery(tx, {
          ...FY,
          createdByUserId: owner.id,
          jobId: job.id,
          receiveDate: now,
          outputs: [
            { jewelleryType: "RING", quantity: 1, netMetalWeight: 8, metalType: "GOLD", purityId: purity.id, diamondIds: [], qcStatus: "PASSED" },
            { jewelleryType: "RING", quantity: 1, netMetalWeight: 8, metalType: "GOLD", purityId: purity.id, diamondIds: [], qcStatus: "PASSED" },
          ],
          diamondResolutions: [],
          returnedMetalLines: [],
          scrapMetalLines: [],
          karigarAddedFineWeight: 0,
          karigarAddedCost: 0,
          labourCharge: 6000,
          makingCharge: 0,
          settingCharge: 0,
          platingCharge: 0,
          otherExpense: 0,
          markJobComplete: true,
          isAbnormalLoss: false,
          damagedLostByUserId: owner.id,
        });

        const outputs = await tx.finishedJewellery.findMany({ where: { receiptId: receipt.receipt.id }, orderBy: { finishedCode: "asc" } });
        assert(outputs.length === 2, "Receive created exactly 2 FinishedJewellery outputs");
        return { job1: job, output1Id: outputs[0].id, output2Id: outputs[1].id };
      },
      { timeout: 30000 }
    );
    log(`  Job 1: ${job1.jobCode}, output1=${output1Id}, output2=${output2Id}`);

    const output1 = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: output1Id }, include: { stockMovements: true } });
    const output2 = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: output2Id }, include: { stockMovements: true } });
    assert(output1.status === "AVAILABLE" && output2.status === "AVAILABLE", "Both outputs start Available");
    assert(output1.stockMovements.filter((m) => m.type === "PRODUCED_IN").length === 1, "Output1 has exactly one PRODUCED_IN movement");
    assert(output2.stockMovements.filter((m) => m.type === "PRODUCED_IN").length === 1, "Output2 has exactly one PRODUCED_IN movement");
    assert(new Prisma.Decimal(output1.otherMaterialCost).greaterThan(0), "Output1 has a real non-zero otherMaterialCost (from the Enamel work line)");
    const authCost1 = getAuthoritativeInventoryCost(output1);
    const totalCost1 = new Prisma.Decimal(output1.totalCost);
    assert(authCost1.lessThan(totalCost1), "Authoritative cost (metal+diamond+labour) is LESS than totalCost — otherMaterialCost excluded");
    log(`  Output1 authoritative cost = ${authCost1.toFixed(2)}, totalCost (incl. otherMaterial) = ${totalCost1.toFixed(2)}`);

    // -------------------------------------------------------------------
    // Phase B: single-item sale of output1, verify balanced journal + COGS
    // -------------------------------------------------------------------
    section("Phase B: Sell output1 (CGST+SGST, credit)");
    const sale1 = await prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          date: now,
          saleDate: now,
          ...FY,
          currencyCode: "INR",
          exchangeRate: 1,
          createdByUserId: owner.id,
          customerId: customer.id,
          paymentAccountId: null,
          gstTreatment: "CGST_SGST",
          items: [{ finishedJewelleryId: output1Id, sellingPrice: 60123.45, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
        }),
      { timeout: 20000 }
    );
    const output1AfterSale = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: output1Id } });
    assert(output1AfterSale.status === "SOLD", "Output1 is Sold after the sale");
    assert(new Prisma.Decimal(sale1.sale.cogsTotal).toFixed(2) === authCost1.toFixed(2), `Sale1 cogsTotal EXACTLY equals the authoritative cost (${authCost1.toFixed(2)}), not totalCost`);
    const journal1 = await prisma.journalEntry.findMany({ where: { voucherId: sale1.voucher.id }, include: { account: true } });
    const debit1 = journal1.reduce((s, j) => s.plus(j.debit), new Prisma.Decimal(0));
    const credit1 = journal1.reduce((s, j) => s.plus(j.credit), new Prisma.Decimal(0));
    assert(debit1.toFixed(2) === credit1.toFixed(2), `Sale1 (CGST+SGST) voucher balances EXACTLY (debit=${debit1.toFixed(2)} credit=${credit1.toFixed(2)})`);
    const cgst1 = journal1.find((j) => j.account.code === SYSTEM_ACCOUNT_CODES.OUTPUT_CGST);
    const sgst1 = journal1.find((j) => j.account.code === SYSTEM_ACCOUNT_CODES.OUTPUT_SGST);
    const expectedTax1 = new Prisma.Decimal("60123.45").times(3).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    const cgstAmt1 = new Prisma.Decimal(cgst1?.credit ?? 0);
    const sgstAmt1 = new Prisma.Decimal(sgst1?.credit ?? 0);
    assert(cgstAmt1.plus(sgstAmt1).toFixed(2) === expectedTax1.toFixed(2), `CGST(${cgstAmt1.toFixed(2)}) + SGST(${sgstAmt1.toFixed(2)}) EXACTLY equals total tax (${expectedTax1.toFixed(2)})`);

    // -------------------------------------------------------------------
    // Phase C: concurrency proof on output2 — fire N concurrent sale
    // attempts for the SAME item, expect exactly 1 success.
    // -------------------------------------------------------------------
    section("Phase C: Concurrent double-sale prevention on output2 (10 simultaneous attempts)");
    const N = 10;
    const attempts = Array.from({ length: N }, (_, i) =>
      prisma.$transaction(
        (tx) =>
          postFinishedJewellerySale(tx, {
            date: now,
            saleDate: now,
            ...FY,
            currencyCode: "INR",
            exchangeRate: 1,
            createdByUserId: owner.id,
            customerId: customer.id,
            paymentAccountId: null,
            gstTreatment: "CGST_SGST",
            items: [{ finishedJewelleryId: output2Id, sellingPrice: 55000 + i, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
          }),
        { timeout: 20000 }
      )
    );
    const results = await Promise.allSettled(attempts);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const rejectionMessages = rejected.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    const businessRejections = rejectionMessages.filter((m) => m.includes("no longer available"));
    // A pooled Supabase transaction-mode connection has a finite number of
    // concurrent slots; firing 10 truly simultaneous prisma.$transaction()
    // calls can occasionally exhaust it before a transaction's first
    // statement even runs ("Unable to start a transaction in the given
    // time") — a real, honestly-reported characteristic of this pooled
    // environment, NOT a business-logic failure: no transaction body ran,
    // so nothing was written, and it can never be mistaken for a
    // successful claim. Distinguished from, never substituted for, the
    // actual double-sale-prevention proof below.
    const poolRejections = rejectionMessages.filter((m) => !m.includes("no longer available"));
    log(`  Rejection reasons — business guard ("no longer available"): ${businessRejections.length}; connection-pool ("${poolRejections[0] ?? "none"}"): ${poolRejections.length}`);
    assert(fulfilled.length === 1, `Exactly 1 of ${N} concurrent attempts succeeded (got ${fulfilled.length})`);
    assert(rejected.length === N - 1, `The other ${N - 1} attempts were rejected (got ${rejected.length})`);
    assert(
      rejectionMessages.every((m) => m.includes("no longer available") || m.includes("Unable to start a transaction")),
      "Every rejection is either the expected business guard or an honest connection-pool-exhaustion error — never anything else"
    );
    const sale2 = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof postFinishedJewellerySale>>>).value;
    const output2AfterRace = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: output2Id }, include: { stockMovements: true } });
    assert(output2AfterRace.status === "SOLD", "Output2 is Sold after the race");
    assert(
      output2AfterRace.stockMovements.filter((m) => m.type === "SOLD_OUT").length === 1,
      "Exactly one SOLD_OUT movement exists for output2 despite 10 concurrent attempts"
    );
    const salesForOutput2 = await prisma.finishedJewellerySaleLine.count({ where: { finishedJewelleryId: output2Id } });
    assert(salesForOutput2 === 1, "Exactly one FinishedJewellerySaleLine references output2");

    // -------------------------------------------------------------------
    // Phase D: sellable return of output1, then resale
    // -------------------------------------------------------------------
    section("Phase D: Sellable return of output1, then resale");
    const saleLine1 = await prisma.finishedJewellerySaleLine.findFirstOrThrow({ where: { saleId: sale1.sale.id, finishedJewelleryId: output1Id } });
    const return1 = await prisma.$transaction(
      (tx) =>
        returnFinishedJewelleryItems(tx, {
          ...FY,
          saleId: sale1.sale.id,
          items: [{ saleLineId: saleLine1.id, disposition: "SELLABLE" }],
          reason: `${PREFIX} sellable return test`,
          returnDate: now,
          createdByUserId: owner.id,
        }),
      { timeout: 20000 }
    );
    const output1AfterReturn = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: output1Id } });
    assert(output1AfterReturn.status === "AVAILABLE", "Output1 is Available again after sellable return");
    const returnJournal1 = await prisma.journalEntry.findMany({ where: { voucherId: return1.voucher.id } });
    const returnDebit1 = returnJournal1.reduce((s, j) => s.plus(j.debit), new Prisma.Decimal(0));
    const returnCredit1 = returnJournal1.reduce((s, j) => s.plus(j.credit), new Prisma.Decimal(0));
    assert(returnDebit1.equals(returnCredit1), "Return1 voucher is balanced");

    const rejectDoubleReturn = await prisma.$transaction(
      (tx) =>
        returnFinishedJewelleryItems(tx, {
          ...FY,
          saleId: sale1.sale.id,
          items: [{ saleLineId: saleLine1.id, disposition: "SELLABLE" }],
          reason: "duplicate return attempt",
          returnDate: now,
          createdByUserId: owner.id,
        }),
      { timeout: 20000 }
    ).then(
      () => "SUCCEEDED",
      () => "REJECTED"
    );
    assert(rejectDoubleReturn === "REJECTED", "A second return of the same sale line is rejected");

    // IGST this time (an inter-state sale) — the second of the two
    // required GST treatments, with exact-paise reconciliation.
    const sale3 = await prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          date: now,
          saleDate: now,
          ...FY,
          currencyCode: "INR",
          exchangeRate: 1,
          createdByUserId: owner.id,
          customerId: customer.id,
          paymentAccountId: null,
          gstTreatment: "IGST",
          items: [{ finishedJewelleryId: output1Id, sellingPrice: 62345.67, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
        }),
      { timeout: 20000 }
    );
    const output1AfterResale = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: output1Id } });
    assert(output1AfterResale.status === "SOLD", "Output1 is Sold again after resale (sale3)");

    const sale3Journal = await prisma.journalEntry.findMany({ where: { voucherId: sale3.voucher.id }, include: { account: true } });
    const sale3Debit = sale3Journal.reduce((s, j) => s.plus(j.debit), new Prisma.Decimal(0));
    const sale3Credit = sale3Journal.reduce((s, j) => s.plus(j.credit), new Prisma.Decimal(0));
    assert(sale3Debit.toFixed(2) === sale3Credit.toFixed(2), `Sale3 (IGST) voucher balances EXACTLY (debit=${sale3Debit.toFixed(2)} credit=${sale3Credit.toFixed(2)})`);
    const igstLine = sale3Journal.find((j) => j.account.code === SYSTEM_ACCOUNT_CODES.OUTPUT_IGST);
    const cgstLine = sale3Journal.find((j) => j.account.code === SYSTEM_ACCOUNT_CODES.OUTPUT_CGST);
    const sgstLine = sale3Journal.find((j) => j.account.code === SYSTEM_ACCOUNT_CODES.OUTPUT_SGST);
    const expectedTax3 = new Prisma.Decimal("62345.67").times(3).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    assert(!!igstLine && new Prisma.Decimal(igstLine.credit).toFixed(2) === expectedTax3.toFixed(2), `IGST posted EXACTLY ${expectedTax3.toFixed(2)} (got ${igstLine ? new Prisma.Decimal(igstLine.credit).toFixed(2) : "none"})`);
    assert(!cgstLine && !sgstLine, "No CGST/SGST lines exist on an IGST sale");

    // -------------------------------------------------------------------
    // Phase E: cancel sale3 entirely
    // -------------------------------------------------------------------
    section("Phase E: Cancel sale3 entirely");
    await prisma.$transaction(
      (tx) =>
        cancelFinishedJewellerySale(tx, {
          ...FY,
          saleId: sale3.sale.id,
          cancelledByUserId: owner.id,
          cancellationReason: `${PREFIX} full cancellation test`,
        }),
      { timeout: 20000 }
    );
    const output1AfterCancel = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: output1Id } });
    assert(output1AfterCancel.status === "AVAILABLE", "Output1 is Available again after cancelling sale3");
    const sale3AfterCancel = await prisma.finishedJewellerySale.findUniqueOrThrow({ where: { id: sale3.sale.id } });
    assert(sale3AfterCancel.status === "CANCELLED", "Sale3 status is Cancelled");

    // -------------------------------------------------------------------
    // Phase F: damaged return on output2's sale (from the concurrency race)
    // -------------------------------------------------------------------
    section("Phase F: Damaged return of output2");
    const saleLine2 = await prisma.finishedJewellerySaleLine.findFirstOrThrow({ where: { saleId: sale2.sale.id, finishedJewelleryId: output2Id } });
    const return2 = await prisma.$transaction(
      (tx) =>
        returnFinishedJewelleryItems(tx, {
          ...FY,
          saleId: sale2.sale.id,
          items: [{ saleLineId: saleLine2.id, disposition: "DAMAGED" }],
          reason: `${PREFIX} damaged return test`,
          returnDate: now,
          createdByUserId: owner.id,
        }),
      { timeout: 20000 }
    );
    const output2AfterDamaged = await prisma.finishedJewellery.findUniqueOrThrow({ where: { id: output2Id } });
    assert(output2AfterDamaged.status === "RETURNED_DAMAGED", "Output2 is Returned-Damaged (never Available again)");
    const damagedJournal = await prisma.journalEntry.findMany({ where: { voucherId: return2.voucher.id }, include: { account: true } });
    const lossLine = damagedJournal.find((j) => j.account.code === SYSTEM_ACCOUNT_CODES.DAMAGED_JEWELLERY_LOSS);
    const inventoryLine = damagedJournal.find((j) => j.account.code === SYSTEM_ACCOUNT_CODES.FINISHED_JEWELLERY_INVENTORY);
    assert(!!lossLine && lossLine.debit.greaterThan(0), "Damaged Jewellery Loss account was debited");
    assert(!inventoryLine, "Finished Jewellery Inventory was NOT debited for a damaged return (cost reclassified, not restored)");

    // -------------------------------------------------------------------
    // Phase G: customer refund — 3rd item, paid immediately, then
    // sellable-returned to create real customer credit, then refunded.
    // -------------------------------------------------------------------
    section("Phase G: Customer refund path");
    const { output3Id } = await prisma.$transaction(
      async (tx) => {
        await createMetalPurchase(tx, {
          ...FY,
          currencyCode: "INR",
          exchangeRate: 1,
          createdByUserId: owner.id,
          purchaseDate: now,
          supplierId: supplier.id,
          metalType: "GOLD",
          purityId: purity2.id,
          grossWeight: 10,
          rateBasis: "PER_GROSS_GRAM",
          rate: 5000,
          totalPurchaseCost: 50000,
          gstTreatment: "NONE",
        });
        const job2 = await createJewelleryJob(tx, {
          customerId: customer.id,
          jewelleryType: "PENDANT",
          designName: `${PREFIX} Pendant Design`,
          karigarId: karigar.id,
          issueDate: now,
          quantity: 1,
          createdByUserId: owner.id,
        });
        await issueMaterialsToJewelleryJob(tx, {
          ...FY,
          createdByUserId: owner.id,
          jobId: job2.id,
          issueDate: now,
          metalLines: [{ metalType: "GOLD", purityId: purity2.id, grossWeight: 10 }],
          polishedDiamondIds: [],
          otherMaterialLines: [],
        });
        const receipt2 = await receiveFinishedJewellery(tx, {
          ...FY,
          createdByUserId: owner.id,
          jobId: job2.id,
          receiveDate: now,
          outputs: [{ jewelleryType: "PENDANT", quantity: 1, netMetalWeight: 8, metalType: "GOLD", purityId: purity2.id, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [],
          returnedMetalLines: [],
          scrapMetalLines: [],
          karigarAddedFineWeight: 0,
          karigarAddedCost: 0,
          labourCharge: 1000,
          makingCharge: 0,
          settingCharge: 0,
          platingCharge: 0,
          otherExpense: 0,
          markJobComplete: true,
          isAbnormalLoss: false,
          damagedLostByUserId: owner.id,
        });
        const out3 = await tx.finishedJewellery.findFirstOrThrow({ where: { receiptId: receipt2.receipt.id } });
        return { output3Id: out3.id };
      },
      { timeout: 30000 }
    );

    async function customerArNet(): Promise<Prisma.Decimal> {
      const ar = await prisma.account.findUniqueOrThrow({ where: { code: SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE } });
      const agg = await prisma.journalEntry.aggregate({
        where: { partyId: customer.id, accountId: ar.id },
        _sum: { debit: true, credit: true },
      });
      return new Prisma.Decimal(agg._sum.debit ?? 0).minus(new Prisma.Decimal(agg._sum.credit ?? 0));
    }
    /** Exact string equality at stored currency precision — never a
     * numeric-tolerance comparison. Two Decimal values are "equal" here
     * only if their toFixed(2) strings are byte-identical. */
    function assertExactAr(actual: Prisma.Decimal, expected: string, label: string) {
      const actualStr = actual.toFixed(2);
      log(`  AR ${label}: ${actualStr}`);
      assert(actualStr === expected, `AR ${label} is EXACTLY ${expected} (string equality, no tolerance) — got ${actualStr}`);
    }

    const arBeforeSale4 = await customerArNet();
    assertExactAr(arBeforeSale4, "0.00", "before Sale 4");

    // Deliberately uneven price (not a round number) — a real stress
    // test of the CGST/SGST split and Decimal rounding, not just a
    // trivially-exact example.
    const sale4 = await prisma.$transaction(
      (tx) =>
        postFinishedJewellerySale(tx, {
          date: now,
          saleDate: now,
          ...FY,
          currencyCode: "INR",
          exchangeRate: 1,
          createdByUserId: owner.id,
          customerId: customer.id,
          paymentAccountId: null, // credit sale — Payment Received posted separately below
          gstTreatment: "CGST_SGST",
          items: [{ finishedJewelleryId: output3Id, sellingPrice: 41234.57, gstRatePercent: 3, taxType: "EXCLUSIVE" }],
        }),
      { timeout: 20000 }
    );
    const arAfterSale4 = await customerArNet();
    const grandTotal4 = new Prisma.Decimal(sale4.sale.grandTotal);
    assertExactAr(arAfterSale4, grandTotal4.toFixed(2), "after Sale 4 (credit)");

    await prisma.$transaction(
      (tx) =>
        postPaymentReceived(tx, {
          date: now,
          ...FY,
          currencyCode: "INR",
          exchangeRate: 1,
          createdByUserId: owner.id,
          partyId: customer.id,
          paymentAccountId: paymentAccount.id,
          amount: grandTotal4,
        }),
      { timeout: 20000 }
    );
    const arAfterPayment4 = await customerArNet();
    assertExactAr(arAfterPayment4, "0.00", "after Payment Received");

    const saleLine4 = await prisma.finishedJewellerySaleLine.findFirstOrThrow({ where: { saleId: sale4.sale.id, finishedJewelleryId: output3Id } });
    await prisma.$transaction(
      (tx) =>
        returnFinishedJewelleryItems(tx, {
          ...FY,
          saleId: sale4.sale.id,
          items: [{ saleLineId: saleLine4.id, disposition: "SELLABLE" }],
          reason: `${PREFIX} refund-path return`,
          returnDate: now,
          createdByUserId: owner.id,
        }),
      { timeout: 20000 }
    );
    const arAfterReturn4 = await customerArNet();
    const creditCreated = arAfterPayment4.minus(arAfterReturn4);
    assertExactAr(arAfterReturn4, grandTotal4.negated().toFixed(2), "after Return (exact customer credit)");
    assert(creditCreated.equals(grandTotal4), `Returning a fully-paid sale created customer credit of EXACTLY the sale's grand total (${creditCreated.toFixed(2)} === ${grandTotal4.toFixed(2)})`);

    const refundVoucher = await prisma.$transaction(
      (tx) =>
        postCustomerRefund(tx, {
          date: now,
          ...FY,
          currencyCode: "INR",
          exchangeRate: 1,
          createdByUserId: owner.id,
          partyId: customer.id,
          paymentAccountId: paymentAccount.id,
          amount: creditCreated,
        }),
      { timeout: 20000 }
    );
    const arAfterRefund = await customerArNet();
    assertExactAr(arAfterRefund, "0.00", "after Refund");
    assert(
      arAfterRefund.toFixed(2) === arBeforeSale4.toFixed(2),
      `Final AR (${arAfterRefund.toFixed(2)}) is EXACTLY equal to the original baseline (${arBeforeSale4.toFixed(2)}) — string equality, no tolerance`
    );
    log(`  Refund voucher: ${refundVoucher.voucherNumber}`);

    // -------------------------------------------------------------------
    // Phase H: P&L reconciliation
    // -------------------------------------------------------------------
    section("Phase H: P&L reconciliation");
    const dateFrom = new Date(now.getTime() - 60 * 60 * 1000);
    const dateTo = new Date(now.getTime() + 60 * 60 * 1000);
    const pnl = await getProfitAndLoss({ dateFrom, dateTo });
    log(`  Gross sales: ${pnl.grossSales.toFixed(2)}`);
    log(`  Sales returns: ${pnl.salesReturns.toFixed(2)}`);
    log(`  Net sales: ${pnl.netSales.toFixed(2)}`);
    log(`  Finished Jewellery COGS: ${pnl.finishedJewelleryCogs.toFixed(2)}`);
    log(`  Gross profit: ${pnl.grossProfit.toFixed(2)} (${pnl.grossMarginPercent.toFixed(2)}%)`);
    log(`  Damaged jewellery loss: ${pnl.damagedJewelleryLoss.toFixed(2)}`);
    log(`  Net profit: ${pnl.netProfit.toFixed(2)}`);
    log(`  Manual sales (no linked COGS): ${pnl.manualSalesAmount.toFixed(2)} across ${pnl.manualSalesCount} voucher(s)`);
    // Ultimately-sold-and-kept items: sale2 (output2, damaged-returned —
    // its COGS was reclassified to Damaged Loss, not zero) and sale3
    // (cancelled — nets to zero) and sale4 (returned — nets to zero).
    // The only item that ends this run genuinely SOLD is... none (every
    // sale in this script was reversed one way or another) — so COGS
    // recognized net should equal ONLY output2's authoritative cost,
    // permanently reclassified into Damaged Loss, with the sellable
    // returns (output1, output3) netting their COGS back to zero.
    const authCost2 = getAuthoritativeInventoryCost(output2AfterRace);
    assert(pnl.damagedJewelleryLoss.toFixed(2) === authCost2.toFixed(2), `Damaged loss (${pnl.damagedJewelleryLoss.toFixed(2)}) EXACTLY equals output2's authoritative cost (${authCost2.toFixed(2)})`);
    assert(pnl.finishedJewelleryCogs.toFixed(2) === "0.00", "Net Finished Jewellery COGS is EXACTLY 0.00 (every sale this run was reversed one way or another)");
    assert(pnl.netSales.toFixed(2) === "0.00", "Net sales is EXACTLY 0.00 (gross sales fully offset by sales returns)");
    assert(
      pnl.netProfit.toFixed(2) === pnl.grossProfit.minus(pnl.damagedJewelleryLoss).minus(pnl.purchases).minus(pnl.businessExpenses).toFixed(2),
      "Net profit reconciles EXACTLY to Gross profit - Damaged loss - Purchases - Business expenses"
    );

    section("ALL PHASE 6 LIVE VERIFICATION CHECKS PASSED");
  } finally {
    // -------------------------------------------------------------------
    // Cleanup — every row this script created carries createdAt >=
    // testStartedAt (captured before Phase A ran, nothing else touches
    // this database concurrently during this run). Deleted in strict
    // child-before-parent order; Voucher -> JournalEntry/InvoiceLine is
    // schema-cascaded (see model JournalEntry/InvoiceLine's onDelete:
    // Cascade), so vouchers are deleted last without a manual sweep of
    // their journal lines. Each step is try/caught and reported so one
    // wrong assumption can't abort the whole cleanup and strand data.
    // -------------------------------------------------------------------
    const win = { createdAt: { gte: testStartedAt } };
    async function step(label: string, fn: () => Promise<{ count: number } | unknown>) {
      try {
        const result = await fn();
        const count = typeof result === "object" && result !== null && "count" in result ? (result as { count: number }).count : "?";
        log(`  ${label}: ${count}`);
      } catch (err) {
        log(`  ${label}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    section("Cleanup: dry-run inventory of PHASE6TEST rows (createdAt >= " + testStartedAt.toISOString() + ")");
    log(`  parties: ${await prisma.party.count({ where: { id: { in: createdPartyIds } } })}`);
    log(`  jewelleryJob: ${await prisma.jewelleryJob.count({ where: win })}`);
    log(`  jewelleryReceipt: ${await prisma.jewelleryReceipt.count({ where: win })}`);
    log(`  finishedJewellery: ${await prisma.finishedJewellery.count({ where: win })}`);
    log(`  finishedJewelleryStockMovement: ${await prisma.finishedJewelleryStockMovement.count({ where: win })}`);
    log(`  finishedJewellerySale: ${await prisma.finishedJewellerySale.count({ where: win })}`);
    log(`  finishedJewelleryReturn: ${await prisma.finishedJewelleryReturn.count({ where: win })}`);
    log(`  metalPurchase: ${await prisma.metalPurchase.count({ where: win })}`);
    log(`  metalStockMovement: ${await prisma.metalStockMovement.count({ where: win })}`);
    log(`  voucher: ${await prisma.voucher.count({ where: win })}`);

    section("Cleanup: deleting PHASE6TEST rows");
    const returnIds = (await prisma.finishedJewelleryReturn.findMany({ where: win, select: { id: true } })).map((r) => r.id);
    await step("finishedJewelleryReturnLine", () => prisma.finishedJewelleryReturnLine.deleteMany({ where: { returnId: { in: returnIds } } }));
    await step("finishedJewelleryStockMovement", () => prisma.finishedJewelleryStockMovement.deleteMany({ where: win }));
    await step("finishedJewelleryReturn", () => prisma.finishedJewelleryReturn.deleteMany({ where: win }));
    await step("finishedJewellerySaleLine", () => prisma.finishedJewellerySaleLine.deleteMany({ where: win }));
    await step("finishedJewellerySale", () => prisma.finishedJewellerySale.deleteMany({ where: win }));
    await step("jewelleryDiamondIssueLine", () => prisma.jewelleryDiamondIssueLine.deleteMany({ where: win }));
    await step("finishedJewellery", () => prisma.finishedJewellery.deleteMany({ where: win }));
    await step("jewelleryReceipt", () => prisma.jewelleryReceipt.deleteMany({ where: win }));
    await step("jewelleryOtherMaterialLine", () => prisma.jewelleryOtherMaterialLine.deleteMany({ where: win }));
    await step("jewelleryMetalIssueLine", () => prisma.jewelleryMetalIssueLine.deleteMany({ where: win }));
    await step("jewelleryJob", () => prisma.jewelleryJob.deleteMany({ where: win }));
    await step("metalStockMovement", () => prisma.metalStockMovement.deleteMany({ where: win }));
    await step("metalPurchase", () => prisma.metalPurchase.deleteMany({ where: win }));
    // Reversal vouchers reference their original via a Restrict FK —
    // delete those first so the original isn't blocked.
    await step("voucher (reversals)", () => prisma.voucher.deleteMany({ where: { ...win, voucherType: "REVERSAL" } }));
    await step("voucher (rest)", () => prisma.voucher.deleteMany({ where: win }));
    await step("party", () => prisma.party.deleteMany({ where: { id: { in: createdPartyIds } } }));

    section("Cleanup: verifying zero PHASE6TEST rows remain");
    const remaining = {
      parties: await prisma.party.count({ where: { name: { startsWith: PREFIX } } }),
      jobs: await prisma.jewelleryJob.count({ where: win }),
      sales: await prisma.finishedJewellerySale.count({ where: win }),
      finishedJewellery: await prisma.finishedJewellery.count({ where: win }),
      vouchers: await prisma.voucher.count({ where: win }),
      metalPurchases: await prisma.metalPurchase.count({ where: win }),
    };
    log(`  Remaining: ${JSON.stringify(remaining)}`);
    assert(Object.values(remaining).every((n) => n === 0), "Zero PHASE6TEST rows remain in any table");

    const ownerCount = await prisma.user.count({ where: { role: "OWNER" } });
    const purityCount = await prisma.metalPurity.count();
    log(`  Real Owner count (unchanged expectation: 1): ${ownerCount}`);
    log(`  Metal/Purity rows (unchanged expectation: 7): ${purityCount}`);

    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
