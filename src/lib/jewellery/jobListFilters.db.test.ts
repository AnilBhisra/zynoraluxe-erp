/**
 * Jewellery Jobs list — Customer / Karigar / Gold-source filters and labels,
 * proven on the disposable scratch database only (shared guard; this suite
 * truncates business tables). Every filter returns an exact expected id set.
 */
import "dotenv/config";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Count every SQL statement the list issues (N+1 check): the app's client is
// replaced by an identical one with query events.
const sql = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/db/prisma", async () => {
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("@/generated/prisma/client");
  const client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }), log: [{ emit: "event", level: "query" }] });
  (client as unknown as { $on: (e: "query", cb: () => void) => void }).$on("query", () => {
    sql.count++;
  });
  return { prisma: client };
});

import { prisma } from "@/lib/db/prisma";
import { approveCustomerGoldMix, postCustomerGoldTransfer, receiveCustomerGold, reverseCustomerGoldEntry } from "@/lib/jewellery/customerGold";
import { receiveWithCustomerGold, type ReceiveWithCustomerGoldInput } from "@/lib/jewellery/customerGoldJobReceipt";
import { reverseCustomerGoldJobReceipt } from "@/lib/jewellery/customerGoldReceiptReversal";
import { goldSourcesForJobs } from "@/lib/jewellery/jobGoldSource";
import { postCustodyOperation } from "@/lib/jewellery/karigarCustody";
import { reconcileMetalLedger } from "@/lib/jewellery/karigarCustodyReports";
import { cancelJewelleryJob, createJewelleryJob, issueMaterialsToJewelleryJob, postOpeningMetalStock } from "@/lib/jewellery/posting";
import { receiveWithCustodyAllocation } from "@/lib/jewellery/receiptCustody";
import { listJewelleryJobsPage, type JewelleryJobFilters } from "@/lib/jewellery/reports";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = new Date("2026-10-10T00:00:00.000Z");
const TX = { timeout: 30_000, maxWait: 15_000 };
let ownerId: string;
let g24: string;
let g18: string;
let seq = 0;
const key = (l: string) => `jlf-${l}-${Date.now()}-${++seq}`;
const owner = () => ({ id: ownerId, role: "OWNER" as const });

const P: Record<string, string> = {};
const J: Record<string, string> = {};
let fingerprintBefore = "";

async function businessFingerprint() {
  const [r] = await prisma.$queryRawUnsafe<{ fp: string }[]>(`select md5(
      (select coalesce(string_agg(id || status::text || coalesce("customerId",'') || "karigarId", ',' order by id), '') from jewellery_jobs) ||
      (select coalesce(string_agg(id, ',' order by id), '') from customer_gold_entries) ||
      (select coalesce(string_agg(id || "costValue"::text, ',' order by id), '') from jewellery_metal_issue_lines) ||
      (select count(*)::text || coalesce(sum(debit)::text, '') from journal_entries)) fp`);
  return r.fp;
}
const ids = async (f: JewelleryJobFilters) => (await listJewelleryJobsPage(f)).rows.map((r) => r.id).sort();
const set = (...names: string[]) => names.map((n) => J[n]).sort();

function cgReceipt(jobId: string, net: string, opts: { complete?: boolean; customerFine?: string } = {}): ReceiveWithCustomerGoldInput {
  return {
    ...FY, jobId, receiveDate: DATE,
    outputs: [{ jewelleryType: "RING", quantity: 1, netMetalWeight: net, metalType: "GOLD", purityId: g24, diamondIds: [], qcStatus: "PASSED" }],
    diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
    alloy: { includedGrossWeight: "0" }, labourCharge: 0, makingCharge: 0, settingCharge: 0, platingCharge: 0, otherExpense: 0,
    markJobComplete: opts.complete ?? false, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("rcv"), createdByUserId: ownerId,
    customerGoldSource: { purityId: g24, finenessPercent: "99.900", ...(opts.customerFine ? { customerFineForOutputs: opts.customerFine } : {}) },
    actor: owner(),
  };
}
const transfer = (input: Record<string, unknown>) =>
  prisma.$transaction(
    (tx) => postCustomerGoldTransfer(tx, { purityId: g24, finenessPercent: "99.900", entryDate: DATE, reason: "Customer gold movement", idempotencyKey: key("mv"), actor: owner(), ...input } as Parameters<typeof postCustomerGoldTransfer>[1]),
    TX
  );
const makeJob = (name: string, customerId: string | null, karigarId: string, type: "RING" | "PENDANT" = "RING") =>
  prisma.$transaction(
    (tx) => createJewelleryJob(tx, { customerId, jewelleryType: type, designName: name, karigarId, issueDate: DATE, quantity: 1, createdByUserId: ownerId, idempotencyKey: key("job") }),
    TX
  );

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>("select current_database() db, current_user usr, inet_server_port() port");
  assertDisposableTestDb(who);
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  const party = async (name: string, type: "CUSTOMER" | "KARIGAR") => (await prisma.party.create({ data: { name, type, createdByUserId: ownerId } })).id;
  P.rutvik = await party("RUTVIK DOBARIYA", "CUSTOMER");
  P.anil = await party("Anil Bhungaliya", "CUSTOMER");
  P.bhargav = await party("BHARGAV JEWELLERY MAKING", "KARIGAR");
  P.amulay = await party("AMULAY JAWE", "KARIGAR");
  const purity = async (displayName: string, finenessPercent: string) =>
    (await prisma.metalPurity.upsert({ where: { metalType_displayName: { metalType: "GOLD", displayName } }, create: { metalType: "GOLD", displayName, finenessPercent, createdByUserId: ownerId }, update: {} })).id;
  g24 = await purity("JLF 24K", "99.900");
  g18 = await purity("JLF 18K", "75.000");
  await prisma.$transaction((tx) => postOpeningMetalStock(tx, { metalType: "GOLD", purityId: g24, grossWeight: "100.000", costValue: "700000.00", idempotencyKey: key("open"), ...FY, createdByUserId: ownerId }), TX);

  // Customer gold: RUTVIK's 10 g with BHARGAV.
  await prisma.$transaction((tx) => receiveCustomerGold(tx, { customerId: P.rutvik, intakeDate: DATE, purityId: g24, inputBasis: "FINE", weight: "10", deductionWeight: null, reason: "Customer's own gold", declaredValue: null, idempotencyKey: key("in"), actor: owner() }), TX);
  await transfer({ kind: "ISSUE_TO_KARIGAR", customerId: P.rutvik, karigarId: P.bhargav, all: true });
  // Company gold with BHARGAV's custody.
  await prisma.$transaction((tx) => postCustodyOperation(tx, { kind: "ISSUE_TO_KARIGAR", karigarId: P.bhargav, purityId: g24, fineWeight: "10", entryDate: DATE, reason: "Company gold", idempotencyKey: key("ci"), owner: owner(), ...FY }), TX);

  // 1. Pure Customer gold, partial then completing receipt (two receipts).
  J.customer = (await makeJob("Customer solitaire", P.rutvik, P.bhargav)).id;
  await prisma.$transaction((tx) => receiveWithCustomerGold(tx, cgReceipt(J.customer, "1.001")), TX);
  await prisma.$transaction((tx) => receiveWithCustomerGold(tx, cgReceipt(J.customer, "1.001", { complete: true })), TX);
  // 2. Pure Company gold (Karigar Metal allocated at receipt) for a named Customer.
  J.company = (await makeJob("Company bangle for Anil", P.anil, P.bhargav, "PENDANT")).id;
  await prisma.$transaction(
    (tx) =>
      receiveWithCustodyAllocation(tx, {
        ...FY, jobId: J.company, receiveDate: DATE,
        outputs: [{ jewelleryType: "PENDANT", quantity: 1, netMetalWeight: "4.000", metalType: "GOLD", purityId: g18, diamondIds: [], qcStatus: "PASSED" }],
        diamondResolutions: [], returnedMetalLines: [], scrapMetalLines: [], karigarAddedFineWeight: 0, karigarAddedCost: 0,
        alloy: { includedGrossWeight: "0.997" }, labourCharge: 0, makingCharge: "500.00", settingCharge: 0, platingCharge: 0, otherExpense: 0,
        markJobComplete: true, isAbnormalLoss: false, damagedLostByUserId: ownerId, idempotencyKey: key("co"), createdByUserId: ownerId,
        sourcePurityId: g24, actor: owner(),
      }),
    TX
  );
  // 3. Mixed (Owner-approved), completed.
  J.mixed = (await makeJob("Mixed ring", P.rutvik, P.bhargav)).id;
  await prisma.$transaction((tx) => approveCustomerGoldMix(tx, { jobId: J.mixed, reason: "Customer asked us to add our gold", actor: owner() }), TX);
  await transfer({ kind: "ALLOCATE_TO_JOB", customerId: P.rutvik, jobId: J.mixed, fineWeight: "1" });
  await prisma.$transaction((tx) => postCustodyOperation(tx, { kind: "ALLOCATE_TO_JOB", karigarId: P.bhargav, purityId: g24, jobId: J.mixed, fineWeight: "1", entryDate: DATE, reason: "Company share", idempotencyKey: key("mx"), owner: owner(), ...FY }), TX);
  await prisma.$transaction((tx) => receiveWithCustomerGold(tx, cgReceipt(J.mixed, "2.002", { complete: true, customerFine: "1.000" })), TX);
  // 4. No gold yet (AMULAY, no customer).
  J.none = (await makeJob("Plain draft", null, P.amulay)).id;
  // 5. Customer gold allocated, then the allocation reversed: nothing active.
  J.reversed = (await makeJob("Allocated then reversed", P.rutvik, P.bhargav)).id;
  await transfer({ kind: "ALLOCATE_TO_JOB", customerId: P.rutvik, jobId: J.reversed, fineWeight: "0.5" });
  const alloc = await prisma.customerGoldEntry.findFirstOrThrow({ where: { jobId: J.reversed, kind: "ALLOCATE_TO_JOB" } });
  await prisma.$transaction((tx) => reverseCustomerGoldEntry(tx, { entryId: alloc.id, reason: "Allocated to the wrong job", actor: owner() }), TX);
  // 6. Company gold issued directly, then the job cancelled.
  J.cancelled = (await makeJob("Cancelled ring", P.anil, P.amulay)).id;
  await prisma.$transaction((tx) => issueMaterialsToJewelleryJob(tx, { legacyDirectGoldIssue: true, ...FY, jobId: J.cancelled, issueDate: DATE, metalLines: [{ metalType: "GOLD", purityId: g24, grossWeight: "1" }], polishedDiamondIds: [], otherMaterialLines: [], idempotencyKey: key("is"), createdByUserId: ownerId }), TX);
  await prisma.$transaction((tx) => cancelJewelleryJob(tx, { jobId: J.cancelled, cancelledByUserId: ownerId, cancellationReason: "Customer cancelled the order", ...FY }), TX);
  // 7. Historical ambiguity: a Customer-owned piece whose gold movements are not on record.
  J.review = (await makeJob("Historical customer piece", P.rutvik, P.bhargav)).id;
  await prisma.$transaction((tx) => receiveWithCustomerGold(tx, cgReceipt(J.review, "0.500", { complete: true })), TX);
  await prisma.$executeRawUnsafe(`delete from customer_gold_entries where "jobId" = $1`, J.review); // simulated pre-ledger history (scratch DB only)

  // Archived parties stay filterable.
  await prisma.party.updateMany({ where: { id: { in: [P.anil, P.amulay] } }, data: { isActive: false } });
  fingerprintBefore = await businessFingerprint();
}, 240_000);

afterAll(async () => {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  await prisma.$disconnect();
});

describe("gold source from the movement records", () => {
  it("Customer / Company / Mixed / No gold / reversed / cancelled / review", async () => {
    const m = await goldSourcesForJobs(prisma, Object.values(J));
    expect(Object.fromEntries(Object.entries(J).map(([n, id]) => [n, m.get(id)]))).toEqual({
      customer: "CUSTOMER",
      company: "COMPANY",
      mixed: "MIXED",
      none: "NONE",
      reversed: "NONE",
      cancelled: "NONE",
      review: "REVIEW",
    });
  });

});

describe("filters return exactly the expected jobs", () => {
  const ALL = undefined;
  it("Customer filter (including a Company-gold job for that Customer)", async () => {
    expect(await ids({ status: ALL, customerId: P.rutvik })).toEqual(set("customer", "mixed", "reversed", "review"));
    expect(await ids({ status: ALL, customerId: P.anil })).toEqual(set("company", "cancelled")); // archived customer
  });
  it("Karigar filter (archived Karigar too)", async () => {
    expect(await ids({ status: ALL, karigarId: P.amulay })).toEqual(set("none", "cancelled"));
    expect(await ids({ status: ALL, karigarId: P.bhargav })).toEqual(set("customer", "company", "mixed", "reversed", "review"));
  });
  it("Gold source filter", async () => {
    expect(await ids({ status: ALL, goldSource: "CUSTOMER" })).toEqual(set("customer"));
    expect(await ids({ status: ALL, goldSource: "COMPANY" })).toEqual(set("company"));
    expect(await ids({ status: ALL, goldSource: "MIXED" })).toEqual(set("mixed"));
    expect(await ids({ status: ALL, goldSource: "NONE" })).toEqual(set("none", "reversed", "cancelled"));
    expect(await ids({ status: ALL, goldSource: "REVIEW" })).toEqual(set("review"));
  });
  it("status views", async () => {
    expect(await ids({ status: ["COMPLETED"] })).toEqual(set("customer", "company", "mixed", "review"));
    expect(await ids({ status: ["CANCELLED"] })).toEqual(set("cancelled"));
    expect(await ids({ status: ["DRAFT", "MATERIALS_ISSUED"] })).toEqual(set("none", "reversed"));
  });
  it("search: job code, design, item type, Customer, Karigar, piece code, receipt code", async () => {
    const job = await prisma.jewelleryJob.findUniqueOrThrow({ where: { id: J.customer } });
    const receipt = await prisma.jewelleryReceipt.findFirstOrThrow({ where: { jobId: J.customer } });
    const piece = await prisma.finishedJewellery.findFirstOrThrow({ where: { jobId: J.company } });
    expect(await ids({ search: job.jobCode })).toEqual(set("customer"));
    expect(await ids({ search: "solitaire" })).toEqual(set("customer"));
    expect(await ids({ search: "pendant" })).toEqual(set("company"));
    expect(await ids({ search: "rutvik" })).toEqual(set("customer", "mixed", "reversed", "review"));
    expect(await ids({ search: "amulay" })).toEqual(set("none", "cancelled"));
    expect(await ids({ search: receipt.receiptCode })).toEqual(set("customer"));
    expect(await ids({ search: piece.finishedCode })).toEqual(set("company"));
  });
  it("Customer + Karigar + Gold source + Status + Search together", async () => {
    expect(await ids({ status: ["COMPLETED"], customerId: P.rutvik, karigarId: P.bhargav, goldSource: "CUSTOMER", search: "solitaire" })).toEqual(set("customer"));
    expect(await ids({ status: ["COMPLETED"], customerId: P.rutvik, goldSource: "COMPANY" })).toEqual([]);
    expect(await ids({ status: ["COMPLETED"], customerId: P.anil, goldSource: "COMPANY" })).toEqual(set("company"));
  });
  it("the total uses the same definition as the rows", async () => {
    for (const f of [{ goldSource: "NONE" as const }, { customerId: P.rutvik }, { status: ["COMPLETED" as const], goldSource: "CUSTOMER" as const }]) {
      const page = await listJewelleryJobsPage(f);
      expect(page.total).toBe(page.rows.length);
    }
  });
  it("rows carry the labels", async () => {
    const [row] = (await listJewelleryJobsPage({ search: "Mixed ring" })).rows;
    expect([row.customerName, row.karigarName, row.goldSource, row.status]).toEqual(["RUTVIK DOBARIYA", "BHARGAV JEWELLERY MAKING", "MIXED", "COMPLETED"]);
  });
});

describe("performance and safety", () => {
  it("the number of SQL statements does not grow with the number of jobs (no N+1)", async () => {
    const measure = async (f: JewelleryJobFilters) => {
      sql.count = 0;
      await listJewelleryJobsPage(f);
      return sql.count;
    };
    const small = { list: await measure({}), source: await measure({ goldSource: "CUSTOMER" }) };
    for (let i = 0; i < 12; i++) await makeJob(`Extra ${i}`, i % 2 ? P.rutvik : null, P.bhargav);
    const large = { list: await measure({}), source: await measure({ goldSource: "CUSTOMER" }) };
    expect(large).toEqual(small);
    await prisma.jewelleryJob.deleteMany({ where: { designName: { startsWith: "Extra " } } });
  });

  it("listing and filtering changes no business data; metal reconciliation still 0.00", async () => {
    await ids({ goldSource: "MIXED" });
    expect(await businessFingerprint()).toBe(fingerprintBefore);
    const r = await reconcileMetalLedger(prisma);
    for (const l of r.lines) expect([l.accountCode, l.difference.toFixed(2)]).toEqual([l.accountCode, "0.00"]);
  });
});

// Last: it adds a job, which the exact-set checks above must not see.
describe("receipt reversal", () => {
  it("a receipt reversal changes the classification back (the reversed consumption no longer counts)", async () => {
    const job = (await makeJob("Reversal check", P.rutvik, P.bhargav)).id;
    const r = await prisma.$transaction((tx) => receiveWithCustomerGold(tx, cgReceipt(job, "0.500", { complete: true })), TX);
    expect((await goldSourcesForJobs(prisma, [job])).get(job)).toBe("CUSTOMER");
    await prisma.$transaction(
      (tx) => reverseCustomerGoldJobReceipt(tx, { receiptId: r.receipt.id, reason: "Wrong figures were entered at receipt", idempotencyKey: key("rev"), actor: owner(), ...FY }),
      TX
    );
    // The allocation it made is still on the job (released separately): Customer gold, not consumed.
    const after = (await goldSourcesForJobs(prisma, [job])).get(job);
    const onJob = await prisma.customerGoldEntry.findMany({ where: { jobId: job } });
    const active = onJob.filter((e) => !e.reversalOfEntryId && !onJob.some((x) => x.reversalOfEntryId === e.id));
    expect(active.every((e) => e.kind !== "CONSUME_TO_FINISHED")).toBe(true);
    expect(after).toBe(active.length ? "CUSTOMER" : "NONE");
  });
});
