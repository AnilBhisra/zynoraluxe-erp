import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";

import { Prisma, PrismaClient } from "../src/generated/prisma/client";
import { pendingPacketQuantity, sumPacketMovements } from "../src/lib/diamond/packets";

// READ-ONLY reconciliation for Phase 7 diamond stock. It writes nothing and
// exits non-zero when something does not tie out, so it can gate a
// verification run:
//
//   1. Every voucher: total debit = total credit, exactly.
//   2. Every packet: live balance (from its immutable ledger) is never
//      negative, pieces and carat empty together, and status matches.
//   3. 1220 Polished Diamond Inventory = single stones still carried in it
//      (Available + Recut, which has no voucher) + every packet balance.
//   4. 1210 Diamond WIP = open Diamond Jobs' + open Job Manufacturer jobs'
//      remaining WIP cost.
//   5. Job Manufacturer lines never resolve more than was issued.

const D = Prisma.Decimal;
type Dec = Prisma.Decimal;
const ACCOUNT_DIAMOND_WIP = "1210";
const ACCOUNT_POLISHED_INVENTORY = "1220";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  const problems: string[] = [];

  // ---- 1. Voucher balance ----
  const perVoucher = await prisma.journalEntry.groupBy({ by: ["voucherId"], _sum: { debit: true, credit: true } });
  let unbalanced = 0;
  for (const v of perVoucher) {
    const debit = new D(v._sum.debit ?? 0);
    const credit = new D(v._sum.credit ?? 0);
    if (!debit.equals(credit)) {
      unbalanced += 1;
      problems.push(`voucher ${v.voucherId}: debit ${debit.toFixed(2)} ≠ credit ${credit.toFixed(2)}`);
    }
  }
  console.log(`Vouchers checked: ${perVoucher.length}, unbalanced: ${unbalanced}`);

  // ---- 2. Packet ledgers ----
  const packets = await prisma.polishedPacket.findMany({
    include: { movements: { select: { type: true, pieces: true, carat: true, costValue: true } } },
    orderBy: { packetCode: "asc" },
  });
  let packetCost: Dec = new D(0);
  for (const p of packets) {
    const b = sumPacketMovements(p.movements.map((m) => ({ type: m.type, pieces: m.pieces, carat: m.carat.toFixed(3), costValue: m.costValue.toFixed(2) })));
    const carat = new D(b.carat);
    const cost = new D(b.costValue);
    packetCost = packetCost.plus(cost);
    if (b.pieces < 0 || carat.isNegative() || cost.isNegative()) problems.push(`packet ${p.packetCode}: negative balance ${b.pieces} pcs / ${b.carat}ct / ${b.costValue}`);
    if ((b.pieces === 0) !== carat.isZero()) problems.push(`packet ${p.packetCode}: pieces and carat not empty together (${b.pieces} pcs / ${b.carat}ct)`);
    if (b.pieces === 0 && carat.isZero() && !cost.isZero()) problems.push(`packet ${p.packetCode}: empty but carries cost ${b.costValue}`);
    const empty = b.pieces === 0 && carat.isZero();
    if (p.status === "ACTIVE" && empty) problems.push(`packet ${p.packetCode}: ACTIVE but empty`);
    if (p.status === "EMPTY" && !empty) problems.push(`packet ${p.packetCode}: EMPTY but holds ${b.pieces} pcs / ${b.carat}ct`);
  }
  console.log(`Packets checked: ${packets.length}, total packet cost ${packetCost.toFixed(2)}`);

  // ---- GL balances ----
  const ledger = async (code: string) => {
    const account = await prisma.account.findUnique({ where: { code } });
    if (!account) return new D(0);
    const sum = await prisma.journalEntry.aggregate({ where: { accountId: account.id }, _sum: { debit: true, credit: true } });
    return new D(sum._sum.debit ?? 0).minus(sum._sum.credit ?? 0);
  };

  // ---- 3. 1220 Polished Diamond Inventory ----
  const stones = await prisma.polishedDiamond.aggregate({ where: { status: { in: ["AVAILABLE", "RECUT"] } }, _sum: { allocatedCost: true } });
  const stoneCost = new D(stones._sum.allocatedCost ?? 0);
  const gl1220 = await ledger(ACCOUNT_POLISHED_INVENTORY);
  const expected1220 = stoneCost.plus(packetCost);
  console.log(`1220 GL ${gl1220.toFixed(2)} | stones ${stoneCost.toFixed(2)} + packets ${packetCost.toFixed(2)} = ${expected1220.toFixed(2)}`);
  if (!gl1220.equals(expected1220)) problems.push(`1220 differs from stock by ${gl1220.minus(expected1220).toFixed(2)}`);

  // ---- 4. 1210 Diamond WIP ----
  const openStatuses = { notIn: ["CANCELLED" as const] };
  const [diamondWip, packetWip] = await Promise.all([
    prisma.diamondJob.aggregate({ where: { status: openStatuses }, _sum: { remainingWipCost: true } }),
    prisma.packetProcessJob.aggregate({ where: { status: openStatuses }, _sum: { remainingWipCost: true } }),
  ]);
  const expected1210 = new D(diamondWip._sum.remainingWipCost ?? 0).plus(packetWip._sum.remainingWipCost ?? 0);
  const gl1210 = await ledger(ACCOUNT_DIAMOND_WIP);
  console.log(`1210 GL ${gl1210.toFixed(2)} | Diamond Jobs + Job Manufacturer remaining WIP = ${expected1210.toFixed(2)}`);
  if (!gl1210.equals(expected1210)) problems.push(`1210 differs from open job WIP by ${gl1210.minus(expected1210).toFixed(2)}`);

  // ---- 5. Job Manufacturer lines ----
  const lines = await prisma.packetProcessJobLine.findMany({ include: { job: { select: { jobCode: true, status: true } } } });
  for (const l of lines) {
    const pending = pendingPacketQuantity({
      piecesAtIssue: l.piecesAtIssue,
      caratAtIssue: l.caratAtIssue.toFixed(3),
      resolved: [{ pieces: l.resolvedPieces, carat: l.resolvedCarat.plus(l.lossCarat).toFixed(3) }],
    });
    if (pending.pieces < 0 || new D(pending.carat).isNegative()) problems.push(`job ${l.job.jobCode}: a line resolved more than was issued`);
    if (l.job.status === "COMPLETED" && (!l.isClosed || pending.pieces !== 0 || !new D(pending.carat).isZero())) {
      problems.push(`job ${l.job.jobCode}: completed but a line is still open (${pending.pieces} pcs / ${pending.carat}ct)`);
    }
  }
  console.log(`Job Manufacturer lines checked: ${lines.length}`);

  await prisma.$disconnect();
  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log("\nDiamond reconciliation: everything ties out.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
