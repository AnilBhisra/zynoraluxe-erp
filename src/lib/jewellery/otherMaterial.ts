import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@/generated/prisma/client";
import type { GstTreatment, OtherMaterialCategory, OtherMaterialMovementType, UserRole } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { splitGstAmount } from "@/lib/accounting/gst";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";
import { cancelVoucher, createVoucherHeader, insertBalancedJournalLines, PostingError, type JournalLineInput } from "@/lib/accounting/posting";
import { allocateProportionally, round3 } from "@/lib/diamond/allocation";
import { nextJewelleryCode } from "@/lib/jewellery/numbering";
import { purchaseLineAmounts, QTY_DP, type UnitCode } from "@/lib/jewellery/otherMaterialAmounts";

/**
 * Other Material as real purchased stock (JEWELLERY_JOB_LIST_FILTERS_AND_LABELS.md §12).
 *
 *   Purchase   Dr 1230 Other Material Inventory (+ input GST) / Cr 2000 supplier — the only payable
 *   Issue      Dr 1320 Jewellery WIP / Cr 1230   (no payable; its own voucher, never the job's WIP voucher)
 *   Return     Dr 1230 / Cr 1320                 (unused material back at its carrying cost on the job)
 *   Receipt    the job's material WIP drains into the pieces' materialCost (→ 1330 / 1340)
 *
 * Stock is valued at its weighted carrying cost; the movement that empties an
 * item (or the job's holding of it) takes the exact remainder, so no paisa is
 * ever stranded. Item rows are locked before any stock is read, so two
 * simultaneous issues can never both take the last unit.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

export class OtherMaterialError extends PostingError {}

/** Effect of each movement type on stock and on the job's holding (inverted for a reversal row). */
export const MOVEMENT_EFFECT: Record<OtherMaterialMovementType, { stock: -1 | 0 | 1; job: -1 | 0 | 1 }> = {
  PURCHASE_IN: { stock: 1, job: 0 },
  PURCHASE_CANCEL_OUT: { stock: -1, job: 0 },
  JOB_ISSUE_OUT: { stock: -1, job: 1 },
  JOB_RETURN_IN: { stock: 1, job: -1 },
  JOB_CONSUMED: { stock: 0, job: -1 },
};

export const OPEN_JOB_STATUSES = ["DRAFT", "MATERIALS_ISSUED", "IN_PROGRESS", "PARTIALLY_RECEIVED", "NEEDS_CORRECTION"] as const;

const qty3 = (label: string, v: DecimalInput) => {
  const t = String(v ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new OtherMaterialError(`${label}: enter a quantity more than zero.`);
  const d = new Decimal(t);
  if (d.decimalPlaces() > QTY_DP) throw new OtherMaterialError(`${label}: at most ${QTY_DP} decimals.`);
  if (!d.greaterThan(0)) throw new OtherMaterialError(`${label}: enter a quantity more than zero.`);
  return d;
};
const fingerprintOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export type Holding = { quantity: Decimal; cost: Decimal };

const SIGNED = (col: "stock" | "job") => {
  const cases = (Object.entries(MOVEMENT_EFFECT) as [OtherMaterialMovementType, { stock: number; job: number }][])
    .filter(([, e]) => e[col] !== 0)
    .map(([t, e]) => `when '${t}' then ${e[col]}`)
    .join(" ");
  return `(case m.type::text ${cases} else 0 end) * (case when m."reversalOfMovementId" is null then 1 else -1 end)`;
};

/** Stock on hand (quantity, carrying cost) of many items. */
export async function stockForItems(tx: Pick<Tx, "$queryRawUnsafe">, itemIds?: string[]): Promise<Map<string, Holding>> {
  const rows = await tx.$queryRawUnsafe<{ item_id: string; qty: Prisma.Decimal; cost: Prisma.Decimal }[]>(
    `select m."itemId" item_id, coalesce(sum(m.quantity * ${SIGNED("stock")}), 0) qty, coalesce(sum(m."costValue" * ${SIGNED("stock")}), 0) cost
       from other_material_movements m ${itemIds ? `where m."itemId" = any($1::text[])` : ""} group by 1`,
    ...(itemIds ? [itemIds] : [])
  );
  return new Map(rows.map((r) => [r.item_id, { quantity: round3(r.qty), cost: round2(r.cost) }]));
}

/** What a job still holds of each item (issued − returned − consumed). */
export async function jobHoldings(tx: Pick<Tx, "$queryRawUnsafe">, jobId: string): Promise<Map<string, Holding>> {
  const rows = await tx.$queryRawUnsafe<{ item_id: string; qty: Prisma.Decimal; cost: Prisma.Decimal }[]>(
    `select m."itemId" item_id, coalesce(sum(m.quantity * ${SIGNED("job")}), 0) qty, coalesce(sum(m."costValue" * ${SIGNED("job")}), 0) cost
       from other_material_movements m where m."jobId" = $1 group by 1`,
    jobId
  );
  return new Map(rows.filter((r) => !new Decimal(r.qty).isZero() || !new Decimal(r.cost).isZero()).map((r) => [r.item_id, { quantity: round3(r.qty), cost: round2(r.cost) }]));
}

async function lockItems(tx: Tx, itemIds: string[]) {
  for (const id of [...new Set(itemIds)].sort()) await tx.$queryRawUnsafe(`SELECT id FROM "other_material_items" WHERE id = $1 FOR UPDATE`, id);
}
async function lockJob(tx: Tx, jobId: string) {
  await tx.$queryRawUnsafe(`SELECT id FROM "jewellery_jobs" WHERE id = $1 FOR UPDATE`, jobId);
}

/** Cost of taking `quantity` out of a holding: its share, or exactly all of it when it empties. */
export function shareOfHolding(quantity: Decimal, h: Holding): Decimal {
  if (quantity.equals(h.quantity)) return h.cost;
  return round2(h.cost.times(quantity).dividedBy(h.quantity));
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function createOtherMaterialItem(tx: Tx, input: { name: string; category?: OtherMaterialCategory | null; unit: UnitCode; description?: string | null; actor: Actor }) {
  const name = input.name?.trim() ?? "";
  if (name.length < 2 || name.length > 120) throw new OtherMaterialError("Enter the material name (2–120 characters).");
  if (!["PCS", "CT", "GRAM", "OTHER"].includes(input.unit)) throw new OtherMaterialError("Choose the unit (PCS, CT or GRAM).");
  const dup = await tx.otherMaterialItem.findFirst({ where: { isActive: true, unit: input.unit, name: { equals: name, mode: "insensitive" } } });
  if (dup) throw new OtherMaterialError(`${dup.code} ${dup.name} (${dup.unit}) already exists.`);
  const code = await nextJewelleryCode(tx, "OTHER_MATERIAL_ITEM");
  return tx.otherMaterialItem.create({ data: { code, name, category: input.category ?? "OTHER", unit: input.unit, description: input.description?.trim() || null, createdByUserId: input.actor.id } });
}

// ---------------------------------------------------------------------------
// Purchase (stock + supplier payable, once)
// ---------------------------------------------------------------------------

export type OtherMaterialPurchaseLineInput = {
  itemId: string;
  quantity: DecimalInput;
  rate: DecimalInput;
  discount?: DecimalInput | null;
  gstRatePercent?: DecimalInput | null;
  taxType?: "EXCLUSIVE" | "INCLUSIVE";
};
export type OtherMaterialPurchaseInput = {
  supplierId: string;
  purchaseDate: Date;
  reference?: string | null;
  notes?: string | null;
  gstTreatment: GstTreatment;
  lines: OtherMaterialPurchaseLineInput[];
};

export async function planOtherMaterialPurchase(tx: Tx, input: OtherMaterialPurchaseInput) {
  const supplier = await tx.party.findUnique({ where: { id: input.supplierId }, select: { id: true, name: true, type: true, isActive: true } });
  if (!supplier) throw new OtherMaterialError("Choose the supplier.");
  if (supplier.type !== "SUPPLIER") throw new OtherMaterialError(`${supplier.name} is not a supplier.`);
  if (!["NONE", "CGST_SGST", "IGST"].includes(input.gstTreatment)) throw new OtherMaterialError("Choose the GST treatment.");
  if (!input.lines.length) throw new OtherMaterialError("Add at least one material line.");
  if (input.lines.length > 50) throw new OtherMaterialError("At most 50 lines per purchase.");
  const items = await tx.otherMaterialItem.findMany({ where: { id: { in: input.lines.map((l) => l.itemId) } } });
  const lines = input.lines.map((l, i) => {
    const item = items.find((x) => x.id === l.itemId);
    if (!item) throw new OtherMaterialError(`Line ${i + 1}: choose a material.`);
    if (!item.isActive) throw new OtherMaterialError(`Line ${i + 1}: ${item.name} is archived.`);
    const gst = input.gstTreatment === "NONE" ? "0" : String(l.gstRatePercent ?? "0");
    if (input.gstTreatment === "NONE" && l.gstRatePercent && !new Decimal(String(l.gstRatePercent) || 0).isZero()) throw new OtherMaterialError(`Line ${i + 1}: GST % must be 0 for a purchase without GST.`);
    const r = purchaseLineAmounts({ quantity: String(l.quantity ?? ""), unit: item.unit, rate: String(l.rate ?? ""), discount: l.discount == null ? null : String(l.discount), gstRatePercent: gst, taxType: l.taxType ?? "EXCLUSIVE" });
    if (!r.ok) throw new OtherMaterialError(`Line ${i + 1} (${item.name}): ${r.error}`);
    const a = r.amounts;
    if (new Decimal(a.taxableValue).isZero()) throw new OtherMaterialError(`Line ${i + 1}: the line has no value after discount.`);
    return {
      item,
      quantity: new Decimal(String(l.quantity).trim()),
      rate: new Decimal(String(l.rate).trim()),
      gstRatePercent: new Decimal(gst),
      taxType: l.taxType ?? "EXCLUSIVE",
      baseAmount: new Decimal(a.baseAmount),
      discount: new Decimal(a.discount),
      taxableValue: new Decimal(a.taxableValue),
      taxAmount: new Decimal(a.taxAmount),
      lineTotal: new Decimal(a.lineTotal),
      formula: a.formula,
    };
  });
  const sum = (k: "baseAmount" | "discount" | "taxableValue" | "taxAmount" | "lineTotal") => round2(lines.reduce((s, l) => s.plus(l[k]), ZERO));
  const totals = { subtotal: sum("baseAmount"), discountTotal: sum("discount"), taxableTotal: sum("taxableValue"), taxTotal: sum("taxAmount"), grandTotal: sum("lineTotal") };
  const gst = splitGstAmount(totals.taxTotal, input.gstTreatment);
  const journal: JournalLineInput[] = [
    { accountCode: SYSTEM_ACCOUNT_CODES.OTHER_MATERIAL_INVENTORY, debit: totals.taxableTotal, description: "Other material purchase" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_CGST, debit: gst.cgst, description: "Input CGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_SGST, debit: gst.sgst, description: "Input SGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.INPUT_IGST, debit: gst.igst, description: "Input IGST" },
    { accountCode: SYSTEM_ACCOUNT_CODES.ACCOUNTS_PAYABLE, partyId: supplier.id, credit: totals.grandTotal, description: `Payable to ${supplier.name}` },
  ].filter((l) => !new Decimal(l.debit ?? 0).isZero() || !new Decimal(l.credit ?? 0).isZero());
  const fingerprint = fingerprintOf([supplier.id, input.purchaseDate.toISOString().slice(0, 10), input.gstTreatment, lines.map((l) => [l.item.id, l.quantity.toFixed(3), l.rate.toFixed(4), l.discount.toFixed(2), l.gstRatePercent.toFixed(2), l.taxType, l.lineTotal.toFixed(2)])]);
  return { supplier, lines, totals, journal, fingerprint };
}

export async function postOtherMaterialPurchase(tx: Tx, input: OtherMaterialPurchaseInput & { idempotencyKey: string; expectedFingerprint?: string | null; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  if (!input.idempotencyKey?.trim()) throw new OtherMaterialError("Missing submission key — reload the page and try again.");
  const replay = await tx.otherMaterialPurchase.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) return { purchase: replay, replayed: true as const };
  await lockItems(tx, input.lines.map((l) => l.itemId));
  const plan = await planOtherMaterialPurchase(tx, input);
  if (input.expectedFingerprint !== undefined && input.expectedFingerprint !== null && input.expectedFingerprint !== plan.fingerprint) {
    throw new OtherMaterialError("The purchase changed after the preview. Preview again and confirm. Nothing was saved.");
  }
  const purchaseCode = await nextJewelleryCode(tx, "OTHER_MATERIAL_PURCHASE");
  const voucher = await createVoucherHeader(
    tx,
    { date: input.purchaseDate, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay, currencyCode: "INR", exchangeRate: 1, referenceNumber: input.reference?.trim() || purchaseCode, note: `Other material purchase ${purchaseCode} from ${plan.supplier.name}`, createdByUserId: input.actor.id },
    "PURCHASE",
    { amount: plan.totals.grandTotal, partyId: plan.supplier.id, gstTreatment: input.gstTreatment }
  );
  await insertBalancedJournalLines(tx, voucher.id, plan.journal.map((l) => ({ ...l, description: `${l.description} ${purchaseCode}` })));
  const purchase = await tx.otherMaterialPurchase.create({
    data: {
      purchaseCode,
      supplierId: plan.supplier.id,
      purchaseDate: input.purchaseDate,
      reference: input.reference?.trim() || null,
      notes: input.notes?.trim() || null,
      gstTreatment: input.gstTreatment,
      subtotal: plan.totals.subtotal.toFixed(2),
      discountTotal: plan.totals.discountTotal.toFixed(2),
      taxableTotal: plan.totals.taxableTotal.toFixed(2),
      taxTotal: plan.totals.taxTotal.toFixed(2),
      grandTotal: plan.totals.grandTotal.toFixed(2),
      voucherId: voucher.id,
      idempotencyKey: input.idempotencyKey,
      createdByUserId: input.actor.id,
    },
  });
  for (const [i, l] of plan.lines.entries()) {
    const line = await tx.otherMaterialPurchaseLine.create({
      data: {
        purchaseId: purchase.id,
        itemId: l.item.id,
        quantity: l.quantity.toFixed(3),
        unit: l.item.unit,
        rate: l.rate.toFixed(4),
        baseAmount: l.baseAmount.toFixed(2),
        discount: l.discount.toFixed(2),
        taxableValue: l.taxableValue.toFixed(2),
        gstRatePercent: l.gstRatePercent.toFixed(2),
        taxType: l.taxType,
        taxAmount: l.taxAmount.toFixed(2),
        lineTotal: l.lineTotal.toFixed(2),
        sortOrder: i,
      },
    });
    await tx.otherMaterialMovement.create({
      data: { itemId: l.item.id, type: "PURCHASE_IN", quantity: l.quantity.toFixed(3), costValue: l.taxableValue.toFixed(2), movementDate: input.purchaseDate, purchaseLineId: line.id, createdByUserId: input.actor.id },
    });
  }
  return { purchase, replayed: false as const, plan };
}

/** Why this purchase cannot be cancelled (exact dependency), or null. */
export async function otherMaterialPurchaseCancelBlock(tx: Tx, purchaseId: string): Promise<string | null> {
  const p = await tx.otherMaterialPurchase.findUnique({ where: { id: purchaseId }, include: { lines: { include: { movements: true, item: true } } } });
  if (!p) return "Purchase not found.";
  if (p.status !== "POSTED") return `${p.purchaseCode} is already cancelled.`;
  for (const l of p.lines) {
    const inMove = l.movements.find((m) => m.type === "PURCHASE_IN");
    if (!inMove) continue;
    const later = await tx.otherMaterialMovement.findFirst({
      // Live stock taken out since this purchase: an issue that was not reversed, or another purchase's cancellation.
      where: { itemId: l.itemId, sequence: { gt: inMove.sequence }, OR: [{ type: "JOB_ISSUE_OUT", reversalOfMovementId: null, reversedBy: null }, { type: "PURCHASE_CANCEL_OUT" }] },
      orderBy: { sequence: "asc" },
      include: { document: { select: { documentCode: true } }, job: { select: { jobCode: true } } },
    });
    if (later) {
      const where = later.document ? `${later.job?.jobCode ?? ""} (${later.document.documentCode})` : "another stock movement";
      return `${p.purchaseCode} cannot be cancelled: ${l.item.code} ${l.item.name} was used after this purchase — ${where}. Reverse that first (newest first).`;
    }
  }
  return null;
}

export async function cancelOtherMaterialPurchase(tx: Tx, input: { purchaseId: string; reason: string; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  if (input.actor.role !== "OWNER") throw new OtherMaterialError("Only the Owner can cancel a purchase.");
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10) throw new OtherMaterialError("Give the reason for cancelling (at least 10 characters).");
  const p0 = await tx.otherMaterialPurchase.findUnique({ where: { id: input.purchaseId }, include: { lines: true } });
  if (!p0) throw new OtherMaterialError("Purchase not found.");
  await lockItems(tx, p0.lines.map((l) => l.itemId));
  const block = await otherMaterialPurchaseCancelBlock(tx, p0.id);
  if (block) throw new OtherMaterialError(block);
  const reversal = await cancelVoucher(tx, { voucherId: p0.voucherId, cancelledByUserId: input.actor.id, cancellationReason: reason, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay });
  for (const l of p0.lines) {
    await tx.otherMaterialMovement.create({
      data: { itemId: l.itemId, type: "PURCHASE_CANCEL_OUT", quantity: new Decimal(l.quantity).toFixed(3), costValue: new Decimal(l.taxableValue).toFixed(2), movementDate: new Date(), purchaseLineId: l.id, createdByUserId: input.actor.id },
    });
  }
  const stock = await stockForItems(tx, p0.lines.map((l) => l.itemId));
  for (const [itemId, h] of stock) if (h.quantity.isNegative() || h.cost.isNegative()) throw new OtherMaterialError(`Internal check failed: stock of ${itemId} would go negative. Nothing was saved.`);
  return tx.otherMaterialPurchase.update({ where: { id: p0.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledByUserId: input.actor.id, cancellationReason: reason, cancellationVoucherId: reversal.id } });
}

// ---------------------------------------------------------------------------
// Job issue / return / reversal (own vouchers)
// ---------------------------------------------------------------------------

export type JobMaterialLineInput = { itemId: string; quantity: DecimalInput };

function mergeLines(lines: JobMaterialLineInput[]) {
  if (!lines.length) throw new OtherMaterialError("Choose at least one purchased material and its quantity.");
  const byItem = new Map<string, Decimal>();
  for (const [i, l] of lines.entries()) {
    if (!l.itemId) throw new OtherMaterialError(`Line ${i + 1}: choose a purchased material from stock (free-text material can no longer be issued — purchase it first).`);
    byItem.set(l.itemId, (byItem.get(l.itemId) ?? ZERO).plus(qty3(`Line ${i + 1}`, l.quantity)));
  }
  return byItem;
}

async function postJobDocument(
  tx: Tx,
  input: { kind: "ISSUE" | "RETURN"; job: { id: string; jobCode: string }; byItem: Map<string, Decimal>; date: Date; reason?: string | null; idempotencyKey?: string | null; createdByUserId: string; fyStartMonth: number; fyStartDay: number }
) {
  const itemIds = [...input.byItem.keys()];
  await lockItems(tx, itemIds);
  const items = await tx.otherMaterialItem.findMany({ where: { id: { in: itemIds } } });
  const source = input.kind === "ISSUE" ? await stockForItems(tx, itemIds) : await jobHoldings(tx, input.job.id);
  const lines = itemIds.map((itemId) => {
    const item = items.find((x) => x.id === itemId);
    if (!item) throw new OtherMaterialError("Choose a purchased material.");
    const quantity = round3(input.byItem.get(itemId)!);
    const have = source.get(itemId) ?? { quantity: ZERO, cost: ZERO };
    if (quantity.greaterThan(have.quantity)) {
      throw new OtherMaterialError(
        input.kind === "ISSUE"
          ? `Only ${have.quantity.toFixed(3)} ${item.unit} of ${item.code} ${item.name} is in stock (purchase it first).`
          : `${input.job.jobCode} holds only ${have.quantity.toFixed(3)} ${item.unit} of ${item.code} ${item.name}.`
      );
    }
    if (input.kind === "ISSUE" && item.isActive === false) throw new OtherMaterialError(`${item.name} is archived.`);
    const cost = shareOfHolding(quantity, have);
    if (!cost.greaterThan(0)) throw new OtherMaterialError(`${quantity.toFixed(3)} ${item.unit} of ${item.name} is too small to carry a cost.`);
    return { item, quantity, cost };
  });
  const total = round2(lines.reduce((s, l) => s.plus(l.cost), ZERO));
  const documentCode = await nextJewelleryCode(tx, "OTHER_MATERIAL_JOB_DOCUMENT");
  const issue = input.kind === "ISSUE";
  const voucher = await createVoucherHeader(
    tx,
    { date: input.date, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay, currencyCode: "INR", exchangeRate: 1, referenceNumber: documentCode, note: `${issue ? "Other material issued to" : "Unused other material returned from"} ${input.job.jobCode} (${documentCode})`, createdByUserId: input.createdByUserId },
    "JEWELLERY_ISSUE",
    { amount: total }
  );
  await insertBalancedJournalLines(tx, voucher.id, [
    { accountCode: issue ? SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP : SYSTEM_ACCOUNT_CODES.OTHER_MATERIAL_INVENTORY, debit: total, description: `${documentCode} ${input.job.jobCode}` },
    { accountCode: issue ? SYSTEM_ACCOUNT_CODES.OTHER_MATERIAL_INVENTORY : SYSTEM_ACCOUNT_CODES.JEWELLERY_WIP, credit: total, description: `${documentCode} ${input.job.jobCode}` },
  ]);
  const document = await tx.otherMaterialJobDocument.create({
    data: { documentCode, kind: input.kind, jobId: input.job.id, documentDate: input.date, reason: input.reason?.trim() || null, totalCost: total.toFixed(2), voucherId: voucher.id, idempotencyKey: input.idempotencyKey || null, createdByUserId: input.createdByUserId },
  });
  for (const l of lines) {
    await tx.otherMaterialMovement.create({
      data: { itemId: l.item.id, type: issue ? "JOB_ISSUE_OUT" : "JOB_RETURN_IN", quantity: l.quantity.toFixed(3), costValue: l.cost.toFixed(2), movementDate: input.date, jobId: input.job.id, documentId: document.id, createdByUserId: input.createdByUserId },
    });
  }
  const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: input.job.id }, select: { stockMaterialWipCost: true } });
  const after = round2(new Decimal(job.stockMaterialWipCost)[issue ? "plus" : "minus"](total));
  if (after.isNegative()) throw new OtherMaterialError("Internal check failed: the job's material cost would go negative. Nothing was saved.");
  await tx.jewelleryJob.update({ where: { id: input.job.id }, data: { stockMaterialWipCost: after.toFixed(2) } });
  return { document, lines, total };
}

/** Issue purchased material to an open job (Owner or Staff). Called inside Issue Materials too. */
export async function issueOtherMaterialToJob(
  tx: Tx,
  input: { jobId: string; lines: JobMaterialLineInput[]; issueDate: Date; idempotencyKey?: string | null; createdByUserId: string; fyStartMonth: number; fyStartDay: number }
) {
  if (input.idempotencyKey) {
    const replay = await tx.otherMaterialJobDocument.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (replay) return { document: replay, replayed: true as const };
  }
  await lockJob(tx, input.jobId);
  const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, select: { id: true, jobCode: true, status: true } });
  if (!job) throw new OtherMaterialError("Job not found.");
  if (!(OPEN_JOB_STATUSES as readonly string[]).includes(job.status)) throw new OtherMaterialError(`${job.jobCode} is ${job.status.toLowerCase().replace(/_/g, " ")} — material can no longer be issued to it.`);
  const r = await postJobDocument(tx, { kind: "ISSUE", job, byItem: mergeLines(input.lines), date: input.issueDate, idempotencyKey: input.idempotencyKey, createdByUserId: input.createdByUserId, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay });
  return { ...r, replayed: false as const };
}

/** Return unused material from a job to stock at its carrying cost on the job (Owner or Staff). */
export async function returnOtherMaterialFromJob(
  tx: Tx,
  input: { jobId: string; lines: JobMaterialLineInput[]; returnDate: Date; reason: string; idempotencyKey?: string | null; createdByUserId: string; fyStartMonth: number; fyStartDay: number }
) {
  if (input.idempotencyKey) {
    const replay = await tx.otherMaterialJobDocument.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (replay) return { document: replay, replayed: true as const };
  }
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) throw new OtherMaterialError("Say why the material comes back (e.g. not used).");
  await lockJob(tx, input.jobId);
  const job = await tx.jewelleryJob.findUnique({ where: { id: input.jobId }, select: { id: true, jobCode: true, status: true } });
  if (!job) throw new OtherMaterialError("Job not found.");
  const r = await postJobDocument(tx, { kind: "RETURN", job, byItem: mergeLines(input.lines), date: input.returnDate, reason, idempotencyKey: input.idempotencyKey, createdByUserId: input.createdByUserId, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay });
  return { ...r, replayed: false as const };
}

/** Why this issue / return cannot be reversed (newest first, nothing depending on it), or null. */
export async function otherMaterialDocumentReversalBlock(tx: Tx, documentId: string): Promise<string | null> {
  const doc = await tx.otherMaterialJobDocument.findUnique({ where: { id: documentId }, include: { movements: { include: { item: true } }, job: true } });
  if (!doc) return "Document not found.";
  if (doc.status !== "POSTED") return `${doc.documentCode} is already reversed.`;
  const last = Math.max(...doc.movements.map((m) => m.sequence));
  const laterDoc = await tx.otherMaterialJobDocument.findFirst({ where: { jobId: doc.jobId, status: "POSTED", sequence: { gt: doc.sequence } }, orderBy: { sequence: "desc" } });
  if (laterDoc) return `Reverse the later ${laterDoc.documentCode} on ${doc.job.jobCode} first (newest first).`;
  const consumed = await tx.otherMaterialMovement.findFirst({ where: { jobId: doc.jobId, type: "JOB_CONSUMED", reversalOfMovementId: null, reversedBy: null, sequence: { gt: last } }, include: { receipt: { select: { receiptCode: true } } } });
  if (consumed) return `${doc.job.jobCode}'s receipt ${consumed.receipt?.receiptCode ?? ""} already carried this material into its pieces — reverse that receipt first.`;
  if (doc.kind === "RETURN") {
    const stock = await stockForItems(tx, doc.movements.map((m) => m.itemId));
    for (const m of doc.movements) {
      if ((stock.get(m.itemId)?.quantity ?? ZERO).lessThan(m.quantity)) return `${m.item.code} ${m.item.name} returned by ${doc.documentCode} has since been issued again — it is no longer all in stock.`;
    }
  }
  return null;
}

export async function reverseOtherMaterialJobDocument(tx: Tx, input: { documentId: string; reason: string; actor: Actor; fyStartMonth: number; fyStartDay: number }) {
  if (input.actor.role !== "OWNER") throw new OtherMaterialError("Only the Owner can reverse an Other Material issue or return.");
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 10) throw new OtherMaterialError("Give the reason for reversing (at least 10 characters).");
  const doc0 = await tx.otherMaterialJobDocument.findUnique({ where: { id: input.documentId }, include: { movements: true } });
  if (!doc0) throw new OtherMaterialError("Document not found.");
  await lockJob(tx, doc0.jobId);
  await lockItems(tx, doc0.movements.map((m) => m.itemId));
  const block = await otherMaterialDocumentReversalBlock(tx, doc0.id);
  if (block) throw new OtherMaterialError(block);
  const reversal = await cancelVoucher(tx, { voucherId: doc0.voucherId, cancelledByUserId: input.actor.id, cancellationReason: reason, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay });
  for (const m of doc0.movements) {
    await tx.otherMaterialMovement.create({
      data: { itemId: m.itemId, type: m.type, quantity: new Decimal(m.quantity).toFixed(3), costValue: new Decimal(m.costValue).toFixed(2), movementDate: new Date(), jobId: m.jobId, documentId: m.documentId, reversalOfMovementId: m.id, createdByUserId: input.actor.id },
    });
  }
  const job = await tx.jewelleryJob.findUniqueOrThrow({ where: { id: doc0.jobId }, select: { stockMaterialWipCost: true } });
  const after = round2(new Decimal(job.stockMaterialWipCost)[doc0.kind === "ISSUE" ? "minus" : "plus"](doc0.totalCost));
  if (after.isNegative()) throw new OtherMaterialError("Internal check failed: the job's material cost would go negative. Nothing was saved.");
  await tx.jewelleryJob.update({ where: { id: doc0.jobId }, data: { stockMaterialWipCost: after.toFixed(2) } });
  return tx.otherMaterialJobDocument.update({ where: { id: doc0.id }, data: { status: "REVERSED", reversedAt: new Date(), reversedByUserId: input.actor.id, reversalReason: reason, reversalVoucherId: reversal.id } });
}

// ---------------------------------------------------------------------------
// Receipt: the job's material goes into its pieces
// ---------------------------------------------------------------------------

/**
 * Records which items a receipt carried into its pieces: `amount` of the
 * job's material WIP, split over the items it holds by their carrying cost
 * (the whole holding when `final`). No stock or voucher effect here — the
 * receipt's own voucher moves the cost out of 1320.
 */
export async function consumeJobMaterialForReceipt(tx: Tx, input: { jobId: string; receiptId: string; amount: Decimal; final: boolean; date: Date; actorId: string }) {
  const holdings = await jobHoldings(tx, input.jobId);
  const items = [...holdings.entries()].filter(([, h]) => h.cost.greaterThan(0) || h.quantity.greaterThan(0));
  if (!items.length || (!input.final && !input.amount.greaterThan(0))) return;
  const totalHeld = round2(items.reduce((s, [, h]) => s.plus(h.cost), ZERO));
  if (input.amount.greaterThan(totalHeld)) throw new OtherMaterialError("Internal check failed: the receipt would consume more material than the job holds. Nothing was saved.");
  const split = input.final || input.amount.equals(totalHeld)
    ? items.map(([itemId, h]) => ({ key: itemId, amount: h.cost }))
    : allocateProportionally(input.amount, items.map(([itemId, h]) => ({ key: itemId, weight: h.cost })));
  for (const [itemId, h] of items) {
    const cost = split.find((s) => s.key === itemId)?.amount ?? ZERO;
    const quantity = input.final || cost.equals(h.cost) ? h.quantity : h.cost.isZero() ? ZERO : round3(h.quantity.times(cost).dividedBy(h.cost));
    if (cost.isZero() && quantity.isZero()) continue;
    await tx.otherMaterialMovement.create({
      data: { itemId, type: "JOB_CONSUMED", quantity: quantity.toFixed(3), costValue: cost.toFixed(2), movementDate: input.date, jobId: input.jobId, receiptId: input.receiptId, createdByUserId: input.actorId },
    });
  }
}

/** A receipt reversal gives the material back to the job (mirror rows of its consumption). */
export async function reverseReceiptMaterialConsumption(tx: Tx, input: { receiptId: string; actorId: string }) {
  const consumed = await tx.otherMaterialMovement.findMany({ where: { receiptId: input.receiptId, type: "JOB_CONSUMED", reversalOfMovementId: null, reversedBy: null } });
  for (const m of consumed) {
    await tx.otherMaterialMovement.create({
      data: { itemId: m.itemId, type: "JOB_CONSUMED", quantity: new Decimal(m.quantity).toFixed(3), costValue: new Decimal(m.costValue).toFixed(2), movementDate: new Date(), jobId: m.jobId, receiptId: m.receiptId, reversalOfMovementId: m.id, createdByUserId: input.actorId },
    });
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** 1230 records: the carrying cost of all Other Material in stock. */
export async function otherMaterialStockValue(tx: Pick<Tx, "$queryRawUnsafe">): Promise<Decimal> {
  const [r] = await tx.$queryRawUnsafe<{ v: Prisma.Decimal | null }[]>(`select coalesce(sum(m."costValue" * ${SIGNED("stock")}), 0) v from other_material_movements m`);
  return round2(r?.v ?? 0);
}

/** Items with stock on hand. Cost / rate only when includeCost (the Owner). */
export async function listOtherMaterialStock(tx: Tx, opts: { includeCost: boolean; includeInactive?: boolean }) {
  const [items, stock] = await Promise.all([
    tx.otherMaterialItem.findMany({ where: opts.includeInactive ? {} : { isActive: true }, orderBy: { name: "asc" } }),
    stockForItems(tx),
  ]);
  return items.map((i) => {
    const s = stock.get(i.id) ?? { quantity: ZERO, cost: ZERO };
    return {
      id: i.id,
      code: i.code,
      name: i.name,
      category: i.category,
      unit: i.unit as UnitCode,
      isActive: i.isActive,
      available: s.quantity.toFixed(3),
      stockValue: opts.includeCost ? s.cost.toFixed(2) : null,
      averageRate: opts.includeCost ? (s.quantity.isZero() ? null : round2(s.cost.dividedBy(s.quantity)).toFixed(2)) : null,
    };
  });
}

/** Free-text Other Material entries made before purchased stock existed: no purchase or stock source. Owner audit. */
export async function legacyOtherMaterialLines(tx: Tx) {
  const rows = await tx.jewelleryOtherMaterialLine.findMany({ orderBy: { createdAt: "desc" }, include: { job: { select: { id: true, jobCode: true, status: true } } }, take: 500 });
  return rows.map((r) => ({
    id: r.id,
    jobId: r.job.id,
    jobCode: r.job.jobCode,
    jobStatus: r.job.status,
    description: r.description,
    quantity: new Decimal(r.quantity).toFixed(3),
    unit: r.unit,
    cost: new Decimal(r.cost).toFixed(2),
    date: r.createdAt.toISOString().slice(0, 10),
    source: "Manual (legacy) — no purchase / stock source" as const,
  }));
}

/** The job page's Other Material panel. Costs only when includeCost (the Owner). */
export async function getJobMaterialPanel(tx: Tx, jobId: string, opts: { includeCost: boolean }) {
  const [job, holdings, documents] = await Promise.all([
    tx.jewelleryJob.findUnique({ where: { id: jobId }, select: { status: true, stockMaterialWipCost: true } }),
    jobHoldings(tx, jobId),
    tx.otherMaterialJobDocument.findMany({
      where: { jobId },
      orderBy: { sequence: "desc" },
      include: { createdBy: { select: { name: true } }, movements: { where: { reversalOfMovementId: null }, include: { item: { select: { code: true, name: true, unit: true } } } } },
    }),
  ]);
  if (!job) return null;
  const items = holdings.size ? await tx.otherMaterialItem.findMany({ where: { id: { in: [...holdings.keys()] } } }) : [];
  const newestPosted = documents.find((d) => d.status === "POSTED")?.id ?? null;
  return {
    open: (OPEN_JOB_STATUSES as readonly string[]).includes(job.status),
    totalCost: opts.includeCost ? new Decimal(job.stockMaterialWipCost).toFixed(2) : null,
    holdings: [...holdings.entries()].map(([itemId, h]) => {
      const i = items.find((x) => x.id === itemId);
      return { itemId, code: i?.code ?? "", name: i?.name ?? "", unit: i?.unit ?? "", quantity: h.quantity.toFixed(3), cost: opts.includeCost ? h.cost.toFixed(2) : null };
    }),
    documents: documents.map((d) => ({
      id: d.id,
      code: d.documentCode,
      kind: d.kind,
      date: d.documentDate.toISOString().slice(0, 10),
      status: d.status,
      reason: d.reason,
      createdBy: d.createdBy.name,
      total: opts.includeCost ? new Decimal(d.totalCost).toFixed(2) : null,
      lines: d.movements.map((m) => ({ item: `${m.item.code} ${m.item.name}`, quantity: new Decimal(m.quantity).toFixed(3), unit: m.item.unit, cost: opts.includeCost ? new Decimal(m.costValue).toFixed(2) : null })),
      canReverse: opts.includeCost && d.id === newestPosted,
    })),
  };
}
