import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import type { DiamondSalePricing, GstTreatment, UserRole } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { clearingAccountIds, recordClearingEntry } from "@/lib/accounting/clearingLedger";
import { computeInvoiceLineTotals, splitGstAmount } from "@/lib/accounting/gst";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import { cancelVoucher, createVoucherHeader, insertBalancedJournalLines, postSale, PostingError, type InvoiceLineInput, type JournalLineInput } from "@/lib/accounting/posting";
import { round3 } from "@/lib/diamond/allocation";
import { nextDiamondCode } from "@/lib/diamond/numbering";
import { checkPacketQuantity } from "@/lib/diamond/packets";
import { getPacketBalanceInTx, lockPacketInTx } from "@/lib/diamond/polishedPurchase";
import { shapeLabel } from "@/lib/diamond/shapes";

/**
 * Diamond-only Sale (JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §13): available
 * polished stones, whole packets or part of a packet sold straight to a
 * Customer, with no Jewellery Job.
 *
 *   Revenue / GST / receipt: postSale (Credit → 1100, paid now → Cash/Bank,
 *     clearing-enabled Customer → 1150), Cr 4000 Sales + output GST.
 *   Cost: Dr 5210 Polished Diamond Cost of Sales / Cr 1220 at the saved
 *     carrying cost — a stone's allocatedCost; a packet's carat share, the
 *     line that empties the packet taking the exact remainder.
 *
 * A stone is claimed AVAILABLE → SOLD by one conditional UPDATE and a packet
 * is row-locked before its balance is read, so the same stock can never be
 * sold twice, even by simultaneous requests. Cancel / return are Owner-only
 * and put back exactly the pieces, carat and cost that left.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

export class DiamondSaleError extends PostingError {}

export type DiamondSaleLineInput = {
  kind: "STONE" | "PACKET";
  polishedDiamondId?: string | null;
  packetId?: string | null;
  /** PACKET only (a stone is always 1 piece of its own carat). */
  pieces?: number | string | null;
  carat?: DecimalInput | null;
  pricing: DiamondSalePricing;
  /** ₹ per carat, ₹ per piece, or the fixed line amount. */
  rate: DecimalInput;
  discount?: DecimalInput | null;
  gstRatePercent?: DecimalInput | null;
  taxType?: "EXCLUSIVE" | "INCLUSIVE";
};

export type DiamondSaleInput = {
  customerId: string;
  saleDate: Date;
  gstTreatment: GstTreatment;
  paymentAccountId?: string | null;
  clearing?: { currencyCode: string; foreignAmount?: DecimalInput | null } | null;
  reference?: string | null;
  notes?: string | null;
  lines: DiamondSaleLineInput[];
};

const money2 = (label: string, v: DecimalInput | null | undefined, opts: { allowZero?: boolean } = {}) => {
  const t = String(v ?? "").trim();
  if (t === "" && opts.allowZero) return new Decimal(0);
  if (!/^\d+(\.\d+)?$/.test(t)) throw new DiamondSaleError(`${label}: enter an amount.`);
  const d = new Decimal(t);
  if (d.decimalPlaces() > 4) throw new DiamondSaleError(`${label}: at most 4 decimals.`);
  if (!opts.allowZero && !d.greaterThan(0)) throw new DiamondSaleError(`${label} must be more than zero.`);
  return d;
};

type PlannedLine = {
  source: { kind: "STONE"; id: string; code: string } | { kind: "PACKET"; id: string; code: string; emptiesPacket: boolean };
  description: string;
  pieces: number;
  carat: Decimal;
  pricing: DiamondSalePricing;
  rate: Decimal;
  invoice: InvoiceLineInput;
  baseAmount: Decimal;
  discount: Decimal;
  taxableValue: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
  gstRatePercent: Decimal;
  taxType: "EXCLUSIVE" | "INCLUSIVE";
  cogsAmount: Decimal;
  /** "2.500 CT × ₹20,000.00/CT = ₹50,000.00" */
  formula: string;
};

const inr = (d: Decimal) => {
  const [i, f] = d.toFixed(2).split(".");
  const head = i.length > 3 ? `${i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${i.slice(-3)}` : i;
  return `₹${head}.${f}`;
};

/** Amounts, availability and carrying cost for each line (nothing written). */
export async function planDiamondSale(tx: Tx, input: DiamondSaleInput) {
  const customer = await tx.party.findUnique({ where: { id: input.customerId }, select: { id: true, name: true, type: true, clearingEnabled: true } });
  if (!customer) throw new DiamondSaleError("Choose the Customer.");
  if (customer.type !== "CUSTOMER") throw new DiamondSaleError(`${customer.name} is not a Customer.`);
  if (!["NONE", "CGST_SGST", "IGST"].includes(input.gstTreatment)) throw new DiamondSaleError("Choose the GST treatment.");
  if (!input.lines.length) throw new DiamondSaleError("Choose at least one stone or packet.");
  if (input.lines.length > 50) throw new DiamondSaleError("At most 50 lines per sale.");
  const sources = input.lines.map((l) => (l.kind === "STONE" ? `S:${l.polishedDiamondId}` : `P:${l.packetId}`));
  if (new Set(sources).size !== sources.length) throw new DiamondSaleError("The same stone or packet was chosen twice — use one line per stone / packet.");

  const lines: PlannedLine[] = [];
  for (const [i, l] of input.lines.entries()) {
    const label = `Line ${i + 1}`;
    if (!["PER_CARAT", "PER_PIECE", "FIXED"].includes(l.pricing)) throw new DiamondSaleError(`${label}: choose per carat, per piece or fixed total.`);
    const rate = money2(`${label} rate`, l.rate);
    const discount = round2(money2(`${label} discount`, l.discount ?? "", { allowZero: true }));
    const gstRatePercent = input.gstTreatment === "NONE" ? new Decimal(0) : money2(`${label} GST %`, l.gstRatePercent ?? "0", { allowZero: true });
    if (gstRatePercent.greaterThan(100)) throw new DiamondSaleError(`${label}: GST % must be at most 100.`);
    const taxType = l.taxType === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE";

    let source: PlannedLine["source"];
    let pieces: number;
    let carat: Decimal;
    let description: string;
    let cogsAmount: Decimal;
    if (l.kind === "STONE") {
      const s = await tx.polishedDiamond.findUnique({ where: { id: l.polishedDiamondId ?? "" } });
      if (!s) throw new DiamondSaleError(`${label}: stone not found.`);
      if (s.status !== "AVAILABLE") throw new DiamondSaleError(`${s.polishedCode} is not available (${s.status.toLowerCase().replace(/_/g, " ")}) — it cannot be sold.`);
      source = { kind: "STONE", id: s.id, code: s.polishedCode };
      pieces = 1;
      carat = new Decimal(s.carat);
      description = `${s.polishedCode} — ${shapeLabel(s.shape)} ${carat.toFixed(3)} ct${s.clarity ? ` ${s.clarity}` : ""}`;
      cogsAmount = round2(s.allocatedCost);
    } else {
      const p = await tx.polishedPacket.findUnique({ where: { id: l.packetId ?? "" } });
      if (!p) throw new DiamondSaleError(`${label}: packet not found.`);
      if (p.status !== "ACTIVE") throw new DiamondSaleError(`${p.packetCode} is ${p.status.toLowerCase()} — nothing in it can be sold.`);
      const balance = await getPacketBalanceInTx(tx, p.id);
      pieces = Number(l.pieces ?? 0);
      if (!Number.isInteger(pieces) || pieces <= 0) throw new DiamondSaleError(`${label} (${p.packetCode}): enter the pieces sold.`);
      const caratText = String(l.carat ?? "").trim();
      if (!/^\d+(\.\d{1,3})?$/.test(caratText) || !new Decimal(caratText).greaterThan(0)) throw new DiamondSaleError(`${label} (${p.packetCode}): enter the actual carat sold (at most 3 decimals).`);
      carat = new Decimal(caratText);
      const q = checkPacketQuantity(
        { pieces, caratThousandths: BigInt(carat.times(1000).toFixed(0)) },
        { pieces: balance.pieces, caratThousandths: BigInt(balance.carat.times(1000).toFixed(0)) }
      );
      if (!q.ok) throw new DiamondSaleError(`${p.packetCode}: ${q.reason}`);
      const emptiesPacket = carat.equals(balance.carat);
      cogsAmount = emptiesPacket ? balance.costValue : round2(balance.costValue.times(carat).dividedBy(balance.carat));
      source = { kind: "PACKET", id: p.id, code: p.packetCode, emptiesPacket };
      description = `${p.packetCode} — ${shapeLabel(p.shape)} ${p.sizeLabel} · ${pieces} pcs / ${round3(carat).toFixed(3)} ct`;
    }

    const quantity = l.pricing === "PER_CARAT" ? carat : l.pricing === "PER_PIECE" ? new Decimal(pieces) : new Decimal(1);
    const unit = l.pricing === "PER_CARAT" ? "CT" : "PCS";
    const baseAmount = round2(quantity.times(rate));
    if (discount.greaterThan(baseAmount)) throw new DiamondSaleError(`${label}: discount cannot be more than the base amount.`);
    const invoice: InvoiceLineInput = { description, hsnSac: null, quantity: quantity.toString(), unit, rate: rate.toString(), discount: discount.toFixed(2), gstRatePercent: gstRatePercent.toString(), taxType };
    const totals = computeInvoiceLineTotals({ quantity: invoice.quantity, rate: invoice.rate, discount: invoice.discount, gstRatePercent: invoice.gstRatePercent, taxType });
    if (!totals.taxableValue.greaterThan(0)) throw new DiamondSaleError(`${label}: the line has no value.`);
    const formula =
      l.pricing === "PER_CARAT"
        ? `${round3(carat).toFixed(3)} CT × ${inr(rate)}/CT = ${inr(baseAmount)}`
        : l.pricing === "PER_PIECE"
          ? `${pieces} PCS × ${inr(rate)}/PCS = ${inr(baseAmount)}`
          : `Fixed total ${inr(baseAmount)}`;
    lines.push({ source, description, pieces, carat: round3(carat), pricing: l.pricing, rate, invoice, baseAmount, discount, taxableValue: totals.taxableValue, taxAmount: totals.taxAmount, lineTotal: totals.lineTotal, gstRatePercent, taxType, cogsAmount, formula });
  }
  const sum = (k: "baseAmount" | "discount" | "taxableValue" | "taxAmount" | "lineTotal" | "cogsAmount") => round2(lines.reduce((s, l) => s.plus(l[k]), ZERO));
  const totals = { subtotal: sum("baseAmount"), discountTotal: sum("discount"), taxableTotal: sum("taxableValue"), taxTotal: sum("taxAmount"), grandTotal: sum("lineTotal"), cogsTotal: sum("cogsAmount") };
  // Customer-facing figures and the stock chosen — the carrying cost is not part of it (Staff never see it).
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([customer.id, input.saleDate.toISOString().slice(0, 10), input.gstTreatment, input.paymentAccountId ?? null, input.clearing ?? null, lines.map((l) => [l.source.kind, l.source.id, l.pieces, l.carat.toFixed(3), l.pricing, l.rate.toFixed(4), l.discount.toFixed(2), l.gstRatePercent.toFixed(2), l.taxType, l.lineTotal.toFixed(2)])]))
    .digest("hex")
    .slice(0, 32);
  return { customer, lines, totals, fingerprint };
}

export async function postDiamondSale(tx: Tx, input: DiamondSaleInput & { idempotencyKey: string; expectedFingerprint?: string | null; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  if (input.actor.role !== "OWNER" && input.actor.role !== "STAFF") throw new DiamondSaleError("You are not allowed to sell diamonds.");
  if (!input.idempotencyKey?.trim()) throw new DiamondSaleError("Missing submission key — reload the page and try again.");
  const replay = await tx.diamondSale.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) return { sale: replay, replayed: true as const };

  // Lock every packet first (fixed order), then plan on the locked balances.
  for (const id of [...new Set(input.lines.filter((l) => l.kind === "PACKET").map((l) => l.packetId ?? ""))].sort()) {
    if (!(await lockPacketInTx(tx, id))) throw new DiamondSaleError("A chosen packet is no longer available. Refresh and try again.");
  }
  const plan = await planDiamondSale(tx, input);
  if (input.expectedFingerprint !== undefined && input.expectedFingerprint !== null && input.expectedFingerprint !== plan.fingerprint) {
    throw new DiamondSaleError("The stock or the amounts changed after the preview. Preview again and confirm. Nothing was saved.");
  }
  // Claim every stone: AVAILABLE → SOLD exactly once (a concurrent sale claims nothing and rolls back).
  for (const l of plan.lines) {
    if (l.source.kind !== "STONE") continue;
    const claim = await tx.polishedDiamond.updateMany({ where: { id: l.source.id, status: "AVAILABLE" }, data: { status: "SOLD" } });
    if (claim.count !== 1) throw new DiamondSaleError(`${l.source.code} was just sold or issued by someone else. Refresh and try again.`);
  }

  const saleCode = await nextDiamondCode(tx, "DIAMOND_SALE");
  const voucher = await postSale(tx, {
    date: input.saleDate,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    currencyCode: "INR",
    exchangeRate: 1,
    referenceNumber: input.reference?.trim() || saleCode,
    note: `Diamond sale ${saleCode}${input.notes?.trim() ? ` — ${input.notes.trim()}` : ""}`,
    createdByUserId: input.actor.id,
    partyId: plan.customer.id,
    paymentAccountId: input.paymentAccountId ?? null,
    gstTreatment: input.gstTreatment,
    lines: plan.lines.map((l) => l.invoice),
    additionalLines: [
      { accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_COGS, debit: plan.totals.cogsTotal, description: `Diamond cost of sales ${saleCode}` },
      { accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, credit: plan.totals.cogsTotal, description: `Diamond cost of sales ${saleCode}` },
    ],
    clearing: input.clearing ?? null,
  });
  const sale = await tx.diamondSale.create({
    data: {
      saleCode,
      customerId: plan.customer.id,
      saleDate: input.saleDate,
      gstTreatment: input.gstTreatment,
      subtotal: plan.totals.subtotal.toFixed(2),
      discountTotal: plan.totals.discountTotal.toFixed(2),
      taxableTotal: plan.totals.taxableTotal.toFixed(2),
      taxTotal: plan.totals.taxTotal.toFixed(2),
      grandTotal: plan.totals.grandTotal.toFixed(2),
      cogsTotal: plan.totals.cogsTotal.toFixed(2),
      voucherId: voucher.id,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.actor.id,
    },
  });
  for (const [i, l] of plan.lines.entries()) {
    await tx.diamondSaleLine.create({
      data: {
        saleId: sale.id,
        polishedDiamondId: l.source.kind === "STONE" ? l.source.id : null,
        packetId: l.source.kind === "PACKET" ? l.source.id : null,
        description: l.description,
        pieces: l.pieces,
        carat: l.carat.toFixed(3),
        pricing: l.pricing,
        rate: l.rate.toFixed(4),
        baseAmount: l.baseAmount.toFixed(2),
        discount: l.discount.toFixed(2),
        taxableValue: l.taxableValue.toFixed(2),
        gstRatePercent: l.gstRatePercent.toFixed(2),
        taxType: l.taxType,
        taxAmount: l.taxAmount.toFixed(2),
        lineTotal: l.lineTotal.toFixed(2),
        cogsAmount: l.cogsAmount.toFixed(2),
        sortOrder: i,
      },
    });
    if (l.source.kind === "STONE") {
      await tx.stockMovement.create({
        data: { type: "POLISHED_SALE_OUT", polishedDiamondId: l.source.id, pieces: 1, carat: l.carat.toFixed(3), costValue: l.cogsAmount.toFixed(2), sourceDocument: saleCode, createdByUserId: input.actor.id },
      });
    } else {
      await tx.polishedPacketMovement.create({
        data: { type: "SALE_OUT", packetId: l.source.id, pieces: l.pieces, carat: l.carat.toFixed(3), costValue: l.cogsAmount.toFixed(2), sourceDocument: saleCode, createdByUserId: input.actor.id },
      });
      if (l.source.emptiesPacket) await tx.polishedPacket.update({ where: { id: l.source.id }, data: { status: "EMPTY" } });
    }
  }
  return { sale, voucher, replayed: false as const };
}

async function restoreLineStock(tx: Tx, line: { polishedDiamondId: string | null; packetId: string | null; pieces: number; carat: Prisma.Decimal; cogsAmount: Prisma.Decimal; description: string }, kind: "CANCEL" | "RETURN", document: string, actorId: string) {
  if (line.polishedDiamondId) {
    const back = await tx.polishedDiamond.updateMany({ where: { id: line.polishedDiamondId, status: "SOLD" }, data: { status: "AVAILABLE" } });
    if (back.count !== 1) {
      const s = await tx.polishedDiamond.findUnique({ where: { id: line.polishedDiamondId }, select: { polishedCode: true, status: true } });
      throw new DiamondSaleError(`${s?.polishedCode ?? "The stone"} is now ${s?.status.toLowerCase().replace(/_/g, " ") ?? "missing"}, not sold — it cannot be put back by ${document}.`);
    }
    await tx.stockMovement.create({
      data: { type: kind === "CANCEL" ? "POLISHED_SALE_CANCEL_IN" : "POLISHED_SALE_RETURN_IN", polishedDiamondId: line.polishedDiamondId, pieces: 1, carat: new Decimal(line.carat).toFixed(3), costValue: new Decimal(line.cogsAmount).toFixed(2), sourceDocument: document, createdByUserId: actorId },
    });
  } else if (line.packetId) {
    const p = await tx.polishedPacket.findUnique({ where: { id: line.packetId }, select: { packetCode: true, status: true } });
    if (!p || p.status === "CANCELLED") throw new DiamondSaleError(`${p?.packetCode ?? "The packet"} was cancelled — its stones cannot be put back by ${document}.`);
    await lockPacketInTx(tx, line.packetId, ["ACTIVE", "EMPTY"]);
    await tx.polishedPacketMovement.create({
      data: { type: kind === "CANCEL" ? "SALE_CANCEL_IN" : "SALE_RETURN_IN", packetId: line.packetId, pieces: line.pieces, carat: new Decimal(line.carat).toFixed(3), costValue: new Decimal(line.cogsAmount).toFixed(2), sourceDocument: document, createdByUserId: actorId },
    });
    if (p.status === "EMPTY") await tx.polishedPacket.update({ where: { id: line.packetId }, data: { status: "ACTIVE" } });
  }
}

/** Owner: undo a whole sale (mirror voucher; every stone / packet stone back exactly). Refused once anything was returned. */
export async function cancelDiamondSale(tx: Tx, input: { saleId: string; reason: string; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  if (input.actor.role !== "OWNER") throw new DiamondSaleError("Only the Owner can cancel a diamond sale.");
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10) throw new DiamondSaleError("Give the reason for cancelling (at least 10 characters).");
  await tx.$queryRawUnsafe(`SELECT id FROM "diamond_sales" WHERE id = $1 FOR UPDATE`, input.saleId);
  const sale = await tx.diamondSale.findUnique({ where: { id: input.saleId }, include: { lines: true, returns: { select: { returnCode: true } } } });
  if (!sale) throw new DiamondSaleError("Sale not found.");
  if (sale.status !== "POSTED") throw new DiamondSaleError(`${sale.saleCode} is already cancelled.`);
  if (sale.returns.length) throw new DiamondSaleError(`${sale.saleCode} has a return (${sale.returns[0].returnCode}) — it can no longer be cancelled as a whole.`);
  const reversal = await cancelVoucher(tx, { voucherId: sale.voucherId, cancelledByUserId: input.actor.id, cancellationReason: reason, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay });
  for (const l of sale.lines) await restoreLineStock(tx, l, "CANCEL", `${sale.saleCode} cancellation`, input.actor.id);
  return tx.diamondSale.update({ where: { id: sale.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: input.actor.id, cancellationReason: reason, cancellationVoucherId: reversal.id } });
}

/** Owner: the Customer returns whole lines. Revenue and GST reverse (Sales Returns), stock and its cost come back. */
export async function returnDiamondSaleLines(tx: Tx, input: { saleId: string; lineIds: string[]; reason: string; returnDate: Date; idempotencyKey?: string | null; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  if (input.actor.role !== "OWNER") throw new DiamondSaleError("Only the Owner can record a diamond sale return.");
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) throw new DiamondSaleError("Give a short reason for this return.");
  if (input.idempotencyKey) {
    const replay = await tx.diamondSaleReturn.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (replay) return { saleReturn: replay, replayed: true as const };
  }
  const ids = [...new Set(input.lineIds)];
  if (!ids.length) throw new DiamondSaleError("Choose the lines the Customer returned.");
  await tx.$queryRawUnsafe(`SELECT id FROM "diamond_sales" WHERE id = $1 FOR UPDATE`, input.saleId);
  const sale = await tx.diamondSale.findUnique({ where: { id: input.saleId } });
  if (!sale) throw new DiamondSaleError("Sale not found.");
  if (sale.status !== "POSTED") throw new DiamondSaleError(`${sale.saleCode} is cancelled.`);
  const lines = await tx.diamondSaleLine.findMany({ where: { id: { in: ids }, saleId: sale.id } });
  if (lines.length !== ids.length) throw new DiamondSaleError("A chosen line does not belong to this sale.");
  const already = lines.find((l) => l.returnId);
  if (already) throw new DiamondSaleError(`${already.description} was already returned.`);

  const taxable = round2(lines.reduce((s, l) => s.plus(l.taxableValue), ZERO));
  const tax = round2(lines.reduce((s, l) => s.plus(l.taxAmount), ZERO));
  const total = round2(taxable.plus(tax));
  const cogs = round2(lines.reduce((s, l) => s.plus(l.cogsAmount), ZERO));
  const gst = splitGstAmount(tax, sale.gstTreatment);
  const returnCode = await nextDiamondCode(tx, "DIAMOND_SALE_RETURN");
  const voucher = await createVoucherHeader(
    tx,
    { date: input.returnDate, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay, currencyCode: "INR", exchangeRate: 1, note: `Diamond sale return ${returnCode} against ${sale.saleCode}`, idempotencyKey: input.idempotencyKey ?? null, createdByUserId: input.actor.id },
    "SALE_RETURN",
    { amount: total, partyId: sale.customerId }
  );
  const clearingIds = await clearingAccountIds(tx);
  const isClearingSale = clearingIds.available ? (await tx.journalEntry.count({ where: { voucherId: sale.voucherId, accountId: clearingIds.available } })) > 0 : false;
  const journal: JournalLineInput[] = [
    { accountCode: SYSTEM_ACCOUNT_CODES.SALES_RETURNS, debit: taxable, description: `Return ${returnCode}` },
    { accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_CGST, debit: gst.cgst, description: `Return ${returnCode}` },
    { accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_SGST, debit: gst.sgst, description: `Return ${returnCode}` },
    { accountCode: SYSTEM_ACCOUNT_CODES.OUTPUT_IGST, debit: gst.igst, description: `Return ${returnCode}` },
    { accountCode: isClearingSale ? SYSTEM_ACCOUNT_CODES.MARKETPLACE_CLEARING : SYSTEM_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, partyId: sale.customerId, credit: total, description: `Return ${returnCode}` },
    { accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_INVENTORY, debit: cogs, description: `Return ${returnCode} — back in stock` },
    { accountCode: SYSTEM_ACCOUNT_CODES.POLISHED_DIAMOND_COGS, credit: cogs, description: `Return ${returnCode} — back in stock` },
  ].filter((l) => !new Decimal(l.debit ?? 0).isZero() || !new Decimal(l.credit ?? 0).isZero());
  await insertBalancedJournalLines(tx, voucher.id, journal);
  if (isClearingSale) {
    const saleEntry = await tx.clearingEntry.findFirstOrThrow({ where: { voucherId: sale.voucherId, kind: "SALE" } });
    const saleInr = new Decimal(saleEntry.inrAmount);
    const saleFc = new Decimal(saleEntry.fcAmount);
    const fc = total.equals(saleInr) ? saleFc : saleFc.times(total).dividedBy(saleInr);
    await recordClearingEntry(tx, { partyId: sale.customerId, currencyCode: saleEntry.currencyCode, kind: "SALE_RETURN", fc: fc.negated(), inr: total.negated(), voucherId: voucher.id });
  }
  const saleReturn = await tx.diamondSaleReturn.create({
    data: { returnCode, saleId: sale.id, returnDate: input.returnDate, reason, returnedTotal: total.toFixed(2), voucherId: voucher.id, idempotencyKey: input.idempotencyKey ?? null, createdByUserId: input.actor.id },
  });
  for (const l of lines) {
    await restoreLineStock(tx, l, "RETURN", returnCode, input.actor.id);
    await tx.diamondSaleLine.update({ where: { id: l.id }, data: { returnId: saleReturn.id } });
  }
  return { saleReturn, replayed: false as const };
}

/** Diamond sales for the list (Owner: cost / COGS / margin; Staff: none of it). */
export async function listDiamondSales(tx: Tx, opts: { includeCost: boolean; take?: number }) {
  const sales = await tx.diamondSale.findMany({
    orderBy: [{ saleDate: "desc" }, { createdAt: "desc" }],
    take: opts.take ?? 100,
    include: {
      customer: { select: { name: true } },
      voucher: { select: { voucherNumber: true } },
      createdBy: { select: { name: true } },
      lines: { orderBy: { sortOrder: "asc" }, include: { return: { select: { returnCode: true } } } },
      returns: { select: { returnCode: true, returnDate: true, returnedTotal: true } },
    },
  });
  return sales.map((s) => ({
    id: s.id,
    saleCode: s.saleCode,
    voucherId: s.voucherId,
    voucherNumber: s.voucher.voucherNumber,
    date: s.saleDate.toISOString().slice(0, 10),
    customerName: s.customer.name,
    status: s.status,
    createdBy: s.createdBy.name,
    taxableTotal: new Decimal(s.taxableTotal).toFixed(2),
    taxTotal: new Decimal(s.taxTotal).toFixed(2),
    grandTotal: new Decimal(s.grandTotal).toFixed(2),
    cogsTotal: opts.includeCost ? new Decimal(s.cogsTotal).toFixed(2) : null,
    grossProfit: opts.includeCost ? round2(new Decimal(s.taxableTotal).minus(s.cogsTotal)).toFixed(2) : null,
    lines: s.lines.map((l) => ({
      id: l.id,
      description: l.description,
      pieces: l.pieces,
      carat: new Decimal(l.carat).toFixed(3),
      lineTotal: new Decimal(l.lineTotal).toFixed(2),
      cogsAmount: opts.includeCost ? new Decimal(l.cogsAmount).toFixed(2) : null,
      returnCode: l.return?.returnCode ?? null,
    })),
    returns: s.returns.map((r) => ({ code: r.returnCode, date: r.returnDate.toISOString().slice(0, 10), total: new Decimal(r.returnedTotal).toFixed(2) })),
  }));
}
