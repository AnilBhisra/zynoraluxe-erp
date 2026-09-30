/**
 * Real-database proof that a Jewellery Job's displayed manufacturing cost is
 * materials + Karigar-supplied + charges, each counted exactly once, and that
 * it agrees with finished inventory, what is still in WIP, the Karigar payable
 * and the job list. Disposable scratch database only (the shared guard refuses
 * anything else; these suites truncate business tables).
 *
 * Reported defect: the job screen's "Total manufacturing cost" showed only the
 * materials subtotal (ZL-JJOB-2026-000001 showed 73,345.25 for 78,511.25;
 * ZL-JJOB-2026-000002 86,693.17 for 96,714.17) -- charges were left out.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Decimal } from "@/lib/accounting/money";
import { prisma } from "@/lib/db/prisma";
import { isUnavailable, type CarryingAmount } from "@/lib/jewellery/carryingCost";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { computeOutputMetal, formatThousandths } from "@/lib/jewellery/metalMath";
import { createJewelleryJob, issueMaterialsToJewelleryJob, postOpeningMetalStock, receiveFinishedJewellery } from "@/lib/jewellery/posting";
import { postReceiptChargeCorrection, reverseReceiptChargeCorrection } from "@/lib/jewellery/receiptChargeCorrection";
import { getJewelleryJobDetail, listJewelleryJobs } from "@/lib/jewellery/reports";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-09-30T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };

let ownerId: string;
let karigarId: string;
let gold24: string;
let gold18: string;
let copper: string;
let seq = 0;
const key = (label: string) => `jmc-${label}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });
const amount = (v: CarryingAmount) => {
  if (isUnavailable(v)) throw new Error("expected a figure, got the unavailable sentinel");
  return v;
};

async function clearAll() {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
}
async function upsertPurity(metalType: "GOLD" | "ALLOY", displayName: string, finenessPercent: string) {
  return (
    await prisma.metalPurity.upsert({
      where: { metalType_displayName: { metalType, displayName } },
      create: { metalType, displayName, finenessPercent, createdByUserId: ownerId },
      update: { finenessPercent, isActive: true },
    })
  ).id;
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  await clearAll();
  karigarId = (await prisma.party.create({ data: { name: "Job Cost Karigar", type: "KARIGAR", createdByUserId: ownerId } })).id;
  gold24 = await upsertPurity("GOLD", "JMC 24K", "99.900");
  gold18 = await upsertPurity("GOLD", "JMC 18K", "75.000");
  copper = await upsertPurity("ALLOY", "JMC Copper", "0.000");
  for (const [metalType, purityId, grossWeight, costValue] of [
    ["GOLD", gold24, "100.000", "700000.00"], // Rs 7,000 / g gross
    ["ALLOY", copper, "100.000", "1000.00"], // Rs 10 / g
  ] as const) {
    await prisma.$transaction(
      (tx) => postOpeningMetalStock(tx, { metalType, purityId, grossWeight, costValue, idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }),
      TX
    );
  }
}, 90_000);

afterAll(async () => {
  await clearAll();
});

/** From the job's own figures: materials + Karigar-supplied + charges, and where that cost sits now. */
async function costPicture(jobId: string) {
  const d = (await getJewelleryJobDetail(jobId))!;
  const pieces = await prisma.finishedJewellery.findMany({ where: { jobId } });
  const piecesTotal = pieces.reduce((s, p) => s.plus(p.totalCost), new Decimal(0));
  const inWip = amount(d.remainingWipCost).plus(d.remainingAlloyWipCost);
  // This Karigar exists only in this suite: their net Accounts Payable (2000)
  // balance is exactly what receipts and charge corrections owe them.
  const lines = await prisma.journalEntry.findMany({ where: { partyId: karigarId, account: { code: "2000" } } });
  const payable = lines.reduce((s, l) => s.plus(l.credit).minus(l.debit), new Decimal(0));
  return { d, piecesTotal, inWip, payable };
}

describe("Jewellery Job manufacturing cost — one shared figure, each part once", () => {
  it("materials (metal incl. Company copper, other material) + Karigar-supplied + charges = total; = pieces + WIP; payable = supplied + charges; list = detail; a later charge moves it once", async () => {
    const job = await prisma.$transaction(
      (tx) => createJewelleryJob(tx, { jewelleryType: "RING", designName: "Job cost ring", karigarId, issueDate: DATE, quantity: 2, createdByUserId: ownerId, idempotencyKey: key("job") }),
      TX
    );
    // 10.000 g 24K (Rs 70,000) + 2.000 g Company copper (Rs 20) + enamel (Rs 100).
    await prisma.$transaction(
      (tx) =>
        issueMaterialsToJewelleryJob(tx, {
          legacyDirectGoldIssue: true,
          ...FY,
          jobId: job.id,
          issueDate: DATE,
          metalLines: [
            { metalType: "GOLD", purityId: gold24, grossWeight: "10" },
            { metalType: "ALLOY", purityId: copper, grossWeight: "2" },
          ],
          polishedDiamondIds: [],
          otherMaterialLines: [{ description: "Enamel", quantity: 1, unit: "PCS", cost: "100.00" }],
          idempotencyKey: key("issue"),
          createdByUserId: ownerId,
        }),
      TX
    );
    const issued = await costPicture(job.id);
    // Company copper is already inside issuedMetalCost (70,020.00) -- never added a second time.
    expect([amount(issued.d.issuedMetalCost).toFixed(2), issued.d.issuedAlloyCost.toFixed(2), amount(issued.d.materialsSubtotal).toFixed(2)]).toEqual(["70020.00", "20.00", "70120.00"]);
    expect(amount(issued.d.totalManufacturingCost).toFixed(2)).toBe("70120.00");

    // Partial receipt: 8.000 g 18K; its alloy from Company copper (1.000 g), the Karigar (0.500 g
    // at Rs 300) and the rest included; Karigar-added 0.100 g fine at Rs 700; making 500 + other 200.
    const metal = computeOutputMetal({ netWeight: "8.000", outputFinenessPercent: "75.000", sourceFinenessPercent: "99.900", samePurity: false });
    const included = formatThousandths(metal.alloyAdded - BigInt(1500));
    const r = await prisma.$transaction(
      (tx) =>
        receiveFinishedJewellery(tx, {
          ...FY,
          jobId: job.id,
          receiveDate: DATE,
          outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: "8.000", metalType: "GOLD", purityId: gold18, diamondIds: [], qcStatus: "PASSED" }],
          diamondResolutions: [],
          returnedMetalLines: [],
          scrapMetalLines: [],
          karigarAddedFineWeight: "0.100",
          karigarAddedCost: "700.00",
          alloy: { companyGrossWeight: "1.000", karigarGrossWeight: "0.500", karigarCost: "300.00", includedGrossWeight: included },
          labourCharge: 0,
          makingCharge: "500.00",
          settingCharge: 0,
          platingCharge: 0,
          otherExpense: "200.00",
          markJobComplete: false,
          isAbnormalLoss: false,
          damagedLostByUserId: ownerId,
          idempotencyKey: key("rcv"),
          createdByUserId: ownerId,
        }),
      TX
    );
    const after = await costPicture(job.id);
    expect([
      amount(after.d.materialsSubtotal).toFixed(2),
      after.d.karigarSuppliedCost.toFixed(2), // 700 Karigar-added + 300 Karigar alloy
      after.d.totalLabourCharge.toFixed(2), // 500 making + 200 other
      amount(after.d.totalManufacturingCost).toFixed(2),
    ]).toEqual(["70120.00", "1000.00", "700.00", "71820.00"]);
    // Where that cost sits: the finished piece + what is still in WIP (fine metal and copper).
    expect(amount(after.d.totalManufacturingCost).toFixed(2)).toBe(after.piecesTotal.plus(after.inWip).toFixed(2));
    // The Karigar is owed exactly the Karigar-supplied cost + charges, once.
    expect(after.payable.toFixed(2)).toBe("1700.00");
    // The job list shows the same figure as the detail.
    const row = (await listJewelleryJobs({ search: job.jobCode })).find((x) => x.id === job.id)!;
    expect(amount(row.totalManufacturingCost).toFixed(2)).toBe("71820.00");

    // A charge added later moves the total, the piece and the payable by exactly that amount.
    const added = await prisma.$transaction(
      (tx) =>
        postReceiptChargeCorrection(tx, {
          receiptId: r.receipt.id,
          charges: { settingCharge: "250.00" },
          reason: "Setting charge was not entered at receipt",
          idempotencyKey: key("add"),
          expectedFingerprint: null,
          owner: owner(),
          ...FY,
        }),
      TX
    );
    const later = await costPicture(job.id);
    expect([later.d.totalLabourCharge.toFixed(2), amount(later.d.totalManufacturingCost).toFixed(2), later.payable.toFixed(2)]).toEqual(["950.00", "72070.00", "1950.00"]);
    expect(amount(later.d.totalManufacturingCost).toFixed(2)).toBe(later.piecesTotal.plus(later.inWip).toFixed(2));
    expect(amount((await listJewelleryJobs({ search: job.jobCode })).find((x) => x.id === job.id)!.totalManufacturingCost).toFixed(2)).toBe("72070.00");

    // Reversing it restores every figure exactly.
    await prisma.$transaction(
      (tx) => reverseReceiptChargeCorrection(tx, { correctionId: added.correction.id, reason: "Entered on the wrong receipt by mistake", owner: owner(), ...FY }),
      TX
    );
    const reversed = await costPicture(job.id);
    expect([reversed.d.totalLabourCharge.toFixed(2), amount(reversed.d.totalManufacturingCost).toFixed(2), reversed.payable.toFixed(2)]).toEqual(["700.00", "71820.00", "1700.00"]);

    const recon = await reconcileMetalLedger(prisma);
    for (const l of recon.lines) expect({ account: l.accountCode, difference: l.difference.toFixed(2) }).toEqual({ account: l.accountCode, difference: "0.00" });
  });
});
