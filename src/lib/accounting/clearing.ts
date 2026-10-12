import "server-only";

import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import type { ClearingBucket, ClearingDocumentKind, ClearingEntryKind, ClearingLineDirection, ClearingLineType, UserRole } from "@/generated/prisma/enums";
import { SYSTEM_ACCOUNT_CODES } from "@/lib/accounting/accounts";
import { cancelVoucher, createVoucherHeader, insertBalancedJournalLines, PostingError, type JournalLineInput } from "@/lib/accounting/posting";
import { splitGstAmount } from "@/lib/accounting/gst";
import { Decimal, type DecimalInput, round2, ZERO } from "@/lib/accounting/money";

/**
 * Clearing settlement — see CLEARING_SETTLEMENT_DESIGN.md.
 *
 * A clearing-enabled party (marketplace, payment provider, COD courier,
 * dealer …) collects for many sales and pays out in batches after deducting
 * fees. Its sales debit 1150 Marketplace Clearing; its payouts are posted here
 * against its TOTAL clearing balance per currency — never guessed onto orders.
 *
 * Every movement is written twice and the two always agree:
 *  - the general ledger in INR (1150 available, 1160 reserve, by partyId);
 *  - clearing_entries in the clearing currency (fc) AND INR, by party,
 *    currency and bucket — Σ inr per party/bucket = that party's 1150 / 1160.
 * INR leaves clearing at its CARRYING value (average of what is still there);
 * the difference from what the payout is worth at its own rate is FX gain/loss,
 * posted once, so a sale's INR value is never rewritten.
 */

type Tx = Prisma.TransactionClient;
type Actor = { id: string; role: UserRole };

export class ClearingError extends PostingError {}

export const CLEARING_USER_LINE_TYPES = [
  "COMMISSION",
  "PROCESSING_FEE",
  "ADVERTISING",
  "SHIPPING",
  "SUBSCRIPTION",
  "REFUND",
  "TAX_WITHHELD",
  "TAX_REMITTED",
  "RESERVE_HOLD",
  "RESERVE_RELEASE",
  "OTHER",
] as const satisfies readonly ClearingLineType[];

export const CLEARING_LINE_LABELS: Record<ClearingLineType, string> = {
  COMMISSION: "Commission / platform fee",
  PROCESSING_FEE: "Payment-processing fee",
  ADVERTISING: "Advertising / marketing",
  SHIPPING: "Shipping / courier deduction",
  SUBSCRIPTION: "Subscription / listing fee",
  REFUND: "Refund not recorded as a Sale Return",
  TAX_WITHHELD: "Tax withheld (TDS / TCS)",
  TAX_REMITTED: "Tax collected / remitted by marketplace",
  RESERVE_HOLD: "Moved to reserve / hold",
  RESERVE_RELEASE: "Released from reserve",
  OTHER: "Other adjustment",
  FX_GAIN: "FX gain",
  FX_LOSS: "FX loss",
  GROSS_UP_REVENUE: "Gross-up: sales revenue left out of the sale",
  GROSS_UP_TAX: "Gross-up: output GST (as confirmed by the CA)",
};

const RESERVE_LINES = new Set<ClearingLineType>(["RESERVE_HOLD", "RESERVE_RELEASE"]);

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

const r4 = (v: DecimalInput) => new Decimal(v).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

function money(value: DecimalInput | null | undefined, label: string, dp: 2 | 4, opts: { allowZero?: boolean } = {}): Decimal {
  const text = value === null || value === undefined ? "" : String(value).trim();
  if (text === "") {
    if (opts.allowZero) return new Decimal(0);
    throw new ClearingError(`Enter ${label}.`);
  }
  if (!/^\d+(\.\d+)?$/.test(text)) throw new ClearingError(`${label} must be a positive number.`);
  const d = new Decimal(text);
  if (d.decimalPlaces() > dp) throw new ClearingError(`${label} can have at most ${dp} decimals.`);
  if (d.isZero() && !opts.allowZero) throw new ClearingError(`${label} must be more than zero.`);
  return d;
}

function currency(code: string): string {
  const c = (code ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) throw new ClearingError("Choose a 3-letter currency code (e.g. INR, USD).");
  return c;
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export type BucketBalance = { fc: Decimal; inr: Decimal };
export type ClearingBalance = { available: BucketBalance; reserve: BucketBalance; entryCount: number };

export async function getClearingBalance(tx: Tx, partyId: string, currencyCode: string): Promise<ClearingBalance> {
  const rows = await tx.clearingEntry.groupBy({
    by: ["bucket"],
    where: { partyId, currencyCode },
    _sum: { fcAmount: true, inrAmount: true },
    _count: { _all: true },
  });
  const pick = (b: ClearingBucket): BucketBalance => {
    const r = rows.find((x) => x.bucket === b);
    return { fc: r4(r?._sum.fcAmount ?? 0), inr: round2(r?._sum.inrAmount ?? 0) };
  };
  return { available: pick("AVAILABLE"), reserve: pick("RESERVE"), entryCount: rows.reduce((s, r) => s + r._count._all, 0) };
}

/** INR carrying value of `fc` taken out of a bucket: all of it when the bucket empties, otherwise its average rate. */
export function carryingInr(fc: Decimal, bucket: BucketBalance): Decimal {
  if (fc.isZero()) return new Decimal(0);
  if (fc.equals(bucket.fc)) return bucket.inr;
  if (bucket.fc.isZero()) throw new ClearingError("Nothing is left in this clearing balance.");
  return round2(fc.times(bucket.inr).dividedBy(bucket.fc));
}

async function lockParty(tx: Tx, partyId: string) {
  await tx.$queryRawUnsafe(`SELECT id FROM "parties" WHERE id = $1 FOR UPDATE`, partyId);
}

async function clearingParty(tx: Tx, partyId: string) {
  const party = await tx.party.findUnique({ where: { id: partyId }, select: { id: true, name: true, isActive: true, clearingEnabled: true } });
  if (!party) throw new ClearingError("Party not found.");
  if (!party.clearingEnabled) throw new ClearingError(`${party.name} is not a clearing (marketplace / provider) party. Mark it as one first.`);
  return party;
}

async function accountByCode(tx: Tx, code: string) {
  const a = await tx.account.findUnique({ where: { code }, select: { id: true, code: true, name: true } });
  if (!a) throw new ClearingError(`System account ${code} is missing — the clearing migration has not been applied.`);
  return a;
}

export async function getLineMappings(tx: Tx) {
  const rows = await tx.clearingAccountMapping.findMany({ include: { account: { select: { id: true, code: true, name: true, type: true } } } });
  return new Map(rows.map((r) => [r.lineType, r.account]));
}

function fingerprintOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

const balanceKey = (b: ClearingBalance) => [b.available.fc.toFixed(4), b.available.inr.toFixed(2), b.reserve.fc.toFixed(4), b.reserve.inr.toFixed(2), b.entryCount];

export type PlannedLine = {
  lineType: ClearingLineType;
  direction: ClearingLineDirection;
  accountId: string;
  accountCode: string;
  accountName: string;
  fc: Decimal;
  inr: Decimal;
  description: string | null;
};

export type PlannedJournalLine = { accountCode: string; accountName: string; party: string | null; debit: Decimal; credit: Decimal; description: string };

type PlannedEntry = { bucket: ClearingBucket; kind: ClearingEntryKind; fc: Decimal; inr: Decimal };

export type ClearingPlan = {
  kind: ClearingDocumentKind;
  party: { id: string; name: string };
  currencyCode: string;
  documentDate: Date;
  paymentAccount: { id: string; name: string; code: string } | null;
  reference: string | null;
  notes: string | null;
  receivedInr: Decimal;
  receivedFc: Decimal;
  payoutRate: Decimal;
  lines: PlannedLine[];
  /** Available clearing relieved (+) / added (−). */
  availableFc: Decimal;
  availableInr: Decimal;
  /** Reserve moved in (+) / released (−). */
  reserveFc: Decimal;
  reserveInr: Decimal;
  fxDifferenceInr: Decimal;
  availableOn: Date | null;
  sourceVoucherId: string | null;
  /** GROSS_UP only. */
  grossSaleInr?: Decimal | null;
  taxConfirmation?: string | null;
  before: ClearingBalance;
  after: { available: BucketBalance; reserve: BucketBalance };
  journal: PlannedJournalLine[];
  entries: PlannedEntry[];
  allocationsSupplied: false;
  warnings: string[];
  fingerprint: string;
};

function journalFrom(lines: (JournalLineInput & { accountName: string; partyName: string | null })[]): PlannedJournalLine[] {
  return lines
    .map((l) => ({
      accountCode: l.accountCode,
      accountName: l.accountName,
      party: l.partyName,
      debit: round2(l.debit ?? 0),
      credit: round2(l.credit ?? 0),
      description: l.description ?? "",
    }))
    .filter((l) => !l.debit.isZero() || !l.credit.isZero());
}

// ---------------------------------------------------------------------------
// Settlement (payout with deductions)
// ---------------------------------------------------------------------------

export type SettlementLineInput = {
  lineType: ClearingLineType;
  amount: DecimalInput;
  /** Only OTHER may be an ADDITION (money the provider added to the payout). */
  direction?: ClearingLineDirection;
  description?: string | null;
};

export type SettlementInput = {
  partyId: string;
  currencyCode: string;
  documentDate: Date;
  paymentAccountId?: string | null;
  reference?: string | null;
  notes?: string | null;
  /** What actually entered the payment account (INR). */
  receivedInr: DecimalInput;
  /** The same payout in the clearing currency (required when it is not INR and something was received). */
  receivedFc?: DecimalInput | null;
  /** INR per 1 unit of the clearing currency — only needed when nothing was received (fees only). */
  payoutRate?: DecimalInput | null;
  /** Optional: the gross clearing amount the statement says was settled; must match. */
  grossFc?: DecimalInput | null;
  lines: SettlementLineInput[];
};

export async function planSettlement(tx: Tx, input: SettlementInput, opts: { assumedBefore?: ClearingBalance } = {}): Promise<ClearingPlan> {
  const party = await clearingParty(tx, input.partyId);
  const cur = currency(input.currencyCode);
  const isInr = cur === "INR";
  const receivedInr = money(input.receivedInr, "Amount received", 2, { allowZero: true });

  let paymentAccount: ClearingPlan["paymentAccount"] = null;
  if (input.paymentAccountId) {
    const pa = await tx.paymentAccount.findUnique({ where: { id: input.paymentAccountId }, include: { account: { select: { code: true } } } });
    if (!pa) throw new ClearingError("Payment account not found.");
    if (!pa.isActive) throw new ClearingError("That payment account is archived. Choose another account.");
    paymentAccount = { id: pa.id, name: pa.name, code: pa.account.code };
  }
  if (receivedInr.greaterThan(0) && !paymentAccount) throw new ClearingError("Choose the payment account the money arrived in.");

  let receivedFc: Decimal;
  let rate: Decimal;
  if (isInr) {
    receivedFc = receivedInr;
    if (input.receivedFc !== null && input.receivedFc !== undefined && String(input.receivedFc).trim() !== "" && !new Decimal(String(input.receivedFc)).equals(receivedInr)) {
      throw new ClearingError("For an INR clearing balance the payout in INR and in the clearing currency are the same amount.");
    }
    rate = new Decimal(1);
  } else {
    receivedFc = money(input.receivedFc, `Payout in ${cur}`, 4, { allowZero: true });
    if (receivedFc.greaterThan(0) !== receivedInr.greaterThan(0)) throw new ClearingError(`Enter the payout both in ${cur} and in INR (or neither).`);
    if (receivedFc.greaterThan(0)) rate = receivedInr.dividedBy(receivedFc).toDecimalPlaces(8, Decimal.ROUND_HALF_UP);
    else rate = money(input.payoutRate, `FX rate (INR per 1 ${cur})`, 4);
  }

  const mappings = await getLineMappings(tx);
  const reserveAccount = await accountByCode(tx, SYSTEM_ACCOUNT_CODES.MARKETPLACE_RESERVE);
  const clearingAccount = await accountByCode(tx, SYSTEM_ACCOUNT_CODES.MARKETPLACE_CLEARING);
  const before = opts.assumedBefore ?? (await getClearingBalance(tx, party.id, cur));

  if (input.lines.length > 20) throw new ClearingError("At most 20 deduction / adjustment lines.");
  const lines: PlannedLine[] = [];
  let holdFc = new Decimal(0);
  let releaseFc = new Decimal(0);
  let dedFc = new Decimal(0);
  let addFc = new Decimal(0);
  input.lines.forEach((l, i) => {
    if (!(CLEARING_USER_LINE_TYPES as readonly string[]).includes(l.lineType)) throw new ClearingError(`Line ${i + 1}: choose what the deduction is.`);
    const fc = money(l.amount, `Line ${i + 1} amount`, 4);
    const direction: ClearingLineDirection = l.lineType === "RESERVE_RELEASE" ? "ADDITION" : l.lineType === "OTHER" && l.direction === "ADDITION" ? "ADDITION" : "DEDUCTION";
    const account = RESERVE_LINES.has(l.lineType) ? reserveAccount : mappings.get(l.lineType);
    if (!account) throw new ClearingError(`No account is mapped for "${CLEARING_LINE_LABELS[l.lineType]}". Set it under Settlements → Account mapping.`);
    if (l.lineType === "RESERVE_HOLD") holdFc = holdFc.plus(fc);
    else if (l.lineType === "RESERVE_RELEASE") releaseFc = releaseFc.plus(fc);
    else if (direction === "ADDITION") addFc = addFc.plus(fc);
    else dedFc = dedFc.plus(fc);
    lines.push({
      lineType: l.lineType,
      direction,
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      fc: r4(fc),
      inr: RESERVE_LINES.has(l.lineType) ? new Decimal(0) : isInr ? round2(fc) : round2(fc.times(rate)),
      description: l.description?.trim() || null,
    });
  });

  const availableFc = r4(receivedFc.plus(dedFc).plus(holdFc).minus(releaseFc).minus(addFc));
  if (availableFc.isNegative()) throw new ClearingError("The reserve release and additions are more than the payout plus deductions. Use a reserve release on its own instead.");
  if (availableFc.isZero() && releaseFc.isZero()) throw new ClearingError("Nothing to settle: enter the amount received and / or the deductions.");
  if (availableFc.greaterThan(before.available.fc)) {
    throw new ClearingError(`This settles ${cur} ${availableFc.toFixed(2)} but only ${cur} ${before.available.fc.toFixed(2)} is in ${party.name}'s available clearing balance. Nothing was saved.`);
  }
  if (releaseFc.greaterThan(before.reserve.fc)) throw new ClearingError(`Only ${cur} ${before.reserve.fc.toFixed(2)} is in ${party.name}'s reserve.`);
  if (input.grossFc !== null && input.grossFc !== undefined && String(input.grossFc).trim() !== "") {
    const gross = money(input.grossFc, "Gross amount settled", 4, { allowZero: true });
    if (!gross.equals(availableFc)) throw new ClearingError(`The gross amount settled (${gross.toFixed(2)}) does not equal payout + deductions − additions (${availableFc.toFixed(2)}). Check the lines.`);
  }

  // INR: clearing and reserve leave at carrying value; deductions at the payout rate; FX takes the rest.
  const availableInr = carryingInr(availableFc, before.available);
  const holdInr = holdFc.isZero() ? new Decimal(0) : holdFc.equals(availableFc) ? availableInr : carryingInr(holdFc, before.available);
  const releaseInr = carryingInr(releaseFc, before.reserve);
  for (const l of lines) {
    if (l.lineType === "RESERVE_HOLD") l.inr = holdFc.isZero() ? l.inr : round2(l.fc.times(holdInr).dividedBy(holdFc));
    if (l.lineType === "RESERVE_RELEASE") l.inr = releaseFc.isZero() ? l.inr : round2(l.fc.times(releaseInr).dividedBy(releaseFc));
  }
  // Reserve lines split across several rows: put any paisa remainder on the last one.
  const fixRemainder = (type: ClearingLineType, total: Decimal) => {
    const rows = lines.filter((l) => l.lineType === type);
    if (rows.length === 0) return;
    const sum = rows.reduce((s, l) => s.plus(l.inr), ZERO);
    rows[rows.length - 1].inr = round2(rows[rows.length - 1].inr.plus(total.minus(sum)));
  };
  fixRemainder("RESERVE_HOLD", holdInr);
  fixRemainder("RESERVE_RELEASE", releaseInr);

  const debits = lines.filter((l) => l.direction === "DEDUCTION").reduce((s, l) => s.plus(l.inr), receivedInr);
  const credits = lines.filter((l) => l.direction === "ADDITION").reduce((s, l) => s.plus(l.inr), availableInr);
  const diff = round2(credits.minus(debits)); // > 0: more clearing value left than the payout is worth → loss
  if (isInr && !diff.isZero()) throw new ClearingError("An INR settlement must balance exactly. Check the amounts.");
  if (!diff.isZero()) {
    const fxType: ClearingLineType = diff.greaterThan(0) ? "FX_LOSS" : "FX_GAIN";
    const fxAccount = mappings.get(fxType) ?? (await accountByCode(tx, fxType === "FX_LOSS" ? SYSTEM_ACCOUNT_CODES.FX_LOSS : SYSTEM_ACCOUNT_CODES.FX_GAIN));
    lines.push({
      lineType: fxType,
      direction: fxType === "FX_LOSS" ? "DEDUCTION" : "ADDITION",
      accountId: fxAccount.id,
      accountCode: fxAccount.code,
      accountName: fxAccount.name,
      fc: new Decimal(0),
      inr: diff.abs(),
      description: `Payout rate ${rate.toFixed(4)} vs carrying value`,
    });
  }

  const journal: (JournalLineInput & { accountName: string; partyName: string | null })[] = [];
  if (paymentAccount) journal.push({ accountCode: paymentAccount.code, accountName: paymentAccount.name, partyName: null, debit: receivedInr, description: "Payout received" });
  for (const l of lines) {
    const onClearing = RESERVE_LINES.has(l.lineType);
    journal.push({
      accountCode: l.accountCode,
      accountName: l.accountName,
      partyId: onClearing ? party.id : null,
      partyName: onClearing ? party.name : null,
      debit: l.direction === "DEDUCTION" ? l.inr : undefined,
      credit: l.direction === "ADDITION" ? l.inr : undefined,
      description: CLEARING_LINE_LABELS[l.lineType] + (l.description ? ` — ${l.description}` : ""),
    });
  }
  journal.push({ accountCode: clearingAccount.code, accountName: clearingAccount.name, partyId: party.id, partyName: party.name, credit: availableInr, description: `Clearing settled (${cur} ${availableFc.toFixed(2)})` });

  const entries: PlannedEntry[] = [];
  if (!availableFc.isZero()) entries.push({ bucket: "AVAILABLE", kind: "SETTLEMENT", fc: availableFc.negated(), inr: availableInr.negated() });
  if (!holdFc.isZero()) entries.push({ bucket: "RESERVE", kind: "RESERVE_HOLD", fc: holdFc, inr: holdInr });
  if (!releaseFc.isZero()) entries.push({ bucket: "RESERVE", kind: "RESERVE_RELEASE", fc: releaseFc.negated(), inr: releaseInr.negated() });

  const warnings = [
    "Unallocated pooled settlement: no order allocations are supplied. Only the provider's total clearing balance is reduced; no individual sale is marked paid.",
  ];
  if (!isInr) warnings.push(`Foreign currency: clearing leaves at its carrying value (${before.available.fc.isZero() ? "—" : before.available.inr.dividedBy(before.available.fc).toFixed(4)} INR per ${cur}); the payout rate is ${rate.toFixed(4)}. The difference is FX, posted once.`);
  if (lines.some((l) => l.lineType === "REFUND")) warnings.push("A refund line is only for a refund NOT already recorded as a Sale Return (a Sale Return already reduced clearing).");
  if (lines.some((l) => l.accountCode === SYSTEM_ACCOUNT_CODES.SETTLEMENT_SUSPENSE)) warnings.push("Some lines post to 1180 Settlement Suspense — ask the CA how to classify them.");

  const plan: Omit<ClearingPlan, "fingerprint"> = {
    kind: "SETTLEMENT",
    party: { id: party.id, name: party.name },
    currencyCode: cur,
    documentDate: input.documentDate,
    paymentAccount,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
    receivedInr,
    receivedFc: r4(receivedFc),
    payoutRate: rate,
    lines,
    availableFc,
    availableInr,
    reserveFc: r4(holdFc.minus(releaseFc)),
    reserveInr: round2(holdInr.minus(releaseInr)),
    fxDifferenceInr: diff.negated(),
    availableOn: null,
    sourceVoucherId: null,
    before,
    after: {
      available: { fc: r4(before.available.fc.minus(availableFc)), inr: round2(before.available.inr.minus(availableInr)) },
      reserve: { fc: r4(before.reserve.fc.plus(holdFc).minus(releaseFc)), inr: round2(before.reserve.inr.plus(holdInr).minus(releaseInr)) },
    },
    journal: journalFrom(journal),
    entries,
    allocationsSupplied: false,
    warnings,
  };
  return { ...plan, fingerprint: planFingerprint(plan) };
}

function planFingerprint(plan: Omit<ClearingPlan, "fingerprint">, extra: string | null = null): string {
  return fingerprintOf({
    x: extra,
    k: plan.kind,
    p: plan.party.id,
    c: plan.currencyCode,
    d: plan.documentDate.toISOString(),
    pa: plan.paymentAccount?.id ?? null,
    b: balanceKey(plan.before),
    j: plan.journal.map((l) => [l.accountCode, l.party, l.debit.toFixed(2), l.credit.toFixed(2)]),
    s: plan.sourceVoucherId,
    a: plan.availableOn?.toISOString() ?? null,
  });
}

// ---------------------------------------------------------------------------
// Reserve hold / release (no Bank, no revenue)
// ---------------------------------------------------------------------------

export type ReserveInput = {
  partyId: string;
  currencyCode: string;
  direction: "HOLD" | "RELEASE";
  amountFc: DecimalInput;
  documentDate: Date;
  availableOn?: Date | null;
  reference?: string | null;
  notes?: string | null;
};

export async function planReserveMove(tx: Tx, input: ReserveInput): Promise<ClearingPlan> {
  const party = await clearingParty(tx, input.partyId);
  const cur = currency(input.currencyCode);
  const fc = r4(money(input.amountFc, "Amount", 4));
  const before = await getClearingBalance(tx, party.id, cur);
  const clearingAccount = await accountByCode(tx, SYSTEM_ACCOUNT_CODES.MARKETPLACE_CLEARING);
  const reserveAccount = await accountByCode(tx, SYSTEM_ACCOUNT_CODES.MARKETPLACE_RESERVE);
  const hold = input.direction === "HOLD";
  const from = hold ? before.available : before.reserve;
  if (fc.greaterThan(from.fc)) throw new ClearingError(`Only ${cur} ${from.fc.toFixed(2)} is ${hold ? "available" : "in reserve"} for ${party.name}.`);
  const inr = carryingInr(fc, from);
  const journal = journalFrom([
    { accountCode: reserveAccount.code, accountName: reserveAccount.name, partyId: party.id, partyName: party.name, debit: hold ? inr : undefined, credit: hold ? undefined : inr, description: hold ? "Moved to reserve" : "Released from reserve" },
    { accountCode: clearingAccount.code, accountName: clearingAccount.name, partyId: party.id, partyName: party.name, debit: hold ? undefined : inr, credit: hold ? inr : undefined, description: hold ? "Moved to reserve" : "Released from reserve" },
  ]);
  const plan: Omit<ClearingPlan, "fingerprint"> = {
    kind: hold ? "RESERVE_HOLD" : "RESERVE_RELEASE",
    party: { id: party.id, name: party.name },
    currencyCode: cur,
    documentDate: input.documentDate,
    paymentAccount: null,
    reference: input.reference?.trim() || null,
    notes: input.notes?.trim() || null,
    receivedInr: new Decimal(0),
    receivedFc: new Decimal(0),
    payoutRate: new Decimal(1),
    lines: [],
    availableFc: hold ? fc : fc.negated(),
    availableInr: hold ? inr : inr.negated(),
    reserveFc: hold ? fc : fc.negated(),
    reserveInr: hold ? inr : inr.negated(),
    fxDifferenceInr: new Decimal(0),
    availableOn: hold ? input.availableOn ?? null : null,
    sourceVoucherId: null,
    before,
    after: {
      available: { fc: r4(hold ? before.available.fc.minus(fc) : before.available.fc.plus(fc)), inr: round2(hold ? before.available.inr.minus(inr) : before.available.inr.plus(inr)) },
      reserve: { fc: r4(hold ? before.reserve.fc.plus(fc) : before.reserve.fc.minus(fc)), inr: round2(hold ? before.reserve.inr.plus(inr) : before.reserve.inr.minus(inr)) },
    },
    journal,
    entries: hold
      ? [
          { bucket: "AVAILABLE", kind: "RESERVE_HOLD", fc: fc.negated(), inr: inr.negated() },
          { bucket: "RESERVE", kind: "RESERVE_HOLD", fc, inr },
        ]
      : [
          { bucket: "RESERVE", kind: "RESERVE_RELEASE", fc: fc.negated(), inr: inr.negated() },
          { bucket: "AVAILABLE", kind: "RESERVE_RELEASE", fc, inr },
        ],
    allocationsSupplied: false,
    warnings: ["A reserve is still the Company's money held by the provider: no Bank, revenue or expense line is posted."],
  };
  return { ...plan, fingerprint: planFingerprint(plan) };
}

// ---------------------------------------------------------------------------
// Reclassify a sale receipt wrongly debited to Cash/Bank → clearing
// ---------------------------------------------------------------------------

export type ReclassifyInput = {
  saleVoucherId: string;
  documentDate: Date;
  /** The clearing currency of this receipt (default INR) and its amount in it. */
  currencyCode?: string | null;
  amountFc?: DecimalInput | null;
  reference?: string | null;
  notes?: string | null;
};

/** Why this sale's receipt cannot be reclassified, or null. Checked again inside the posting transaction. */
export async function reclassifyBlock(tx: Tx, saleVoucherId: string): Promise<string | null> {
  const v = await tx.voucher.findUnique({
    where: { id: saleVoucherId },
    include: { party: true, journalEntries: { include: { account: { select: { code: true } } } }, reversedByVoucher: { select: { voucherNumber: true } }, clearingDocumentsSourced: { where: { kind: "RECLASSIFY", status: "POSTED" }, select: { voucherId: true } } },
  });
  if (!v) return "Sale not found.";
  if (v.voucherType !== "SALE") return `${v.voucherNumber} is not a sale.`;
  if (v.status !== "POSTED") return `${v.voucherNumber} is cancelled${v.reversedByVoucher ? ` (${v.reversedByVoucher.voucherNumber})` : ""}.`;
  if (!v.party?.clearingEnabled) return `${v.party?.name ?? "The party"} is not a clearing party. Mark it as one first.`;
  if (v.clearingDocumentsSourced.length > 0) return `${v.voucherNumber} was already reclassified to clearing.`;
  if (!v.paymentAccountId) return `${v.voucherNumber} was not paid into Cash/Bank at sale time — nothing to reclassify.`;
  const pa = await tx.paymentAccount.findUnique({ where: { id: v.paymentAccountId }, select: { accountId: true } });
  if (!v.journalEntries.some((j) => j.accountId === pa?.accountId && new Decimal(j.debit).greaterThan(0))) return `${v.voucherNumber} has no Cash/Bank receipt line to reclassify.`;
  const sale = await tx.finishedJewellerySale.findUnique({ where: { voucherId: v.id }, include: { returns: { select: { returnCode: true } }, lines: { select: { returnStatus: true } } } });
  if (sale) {
    if (sale.status !== "POSTED") return `${sale.saleCode} is ${sale.status.toLowerCase()}.`;
    if (sale.returns.length) return `${sale.saleCode} has a sale return (${sale.returns[0].returnCode}) — the receipt can no longer be moved safely.`;
    if (sale.lines.some((l) => l.returnStatus !== "NONE")) return `${sale.saleCode} has returned lines.`;
  }
  const correction = await tx.correction.findFirst({ where: { OR: [{ correctionVoucherId: v.id }, { entityId: v.id }] }, select: { correctionCode: true } });
  if (correction) return `${v.voucherNumber} has correction ${correction.correctionCode}.`;
  return null;
}

export async function planReclassify(tx: Tx, input: ReclassifyInput): Promise<ClearingPlan> {
  const block = await reclassifyBlock(tx, input.saleVoucherId);
  if (block) throw new ClearingError(block);
  const v = await tx.voucher.findUniqueOrThrow({ where: { id: input.saleVoucherId }, include: { party: true, paymentAccount: { include: { account: true } }, journalEntries: true } });
  const pa = v.paymentAccount!;
  const amountInr = round2(v.journalEntries.filter((j) => j.accountId === pa.accountId).reduce((s, j) => s.plus(j.debit).minus(j.credit), ZERO));
  const cur = currency(input.currencyCode || "INR");
  const fc = cur === "INR" ? amountInr : r4(money(input.amountFc, `Amount in ${cur}`, 4));
  if (cur === "INR" && input.amountFc && !new Decimal(String(input.amountFc)).equals(amountInr)) throw new ClearingError("For INR the clearing amount is the receipt amount.");
  const clearingAccount = await accountByCode(tx, SYSTEM_ACCOUNT_CODES.MARKETPLACE_CLEARING);
  const before = await getClearingBalance(tx, v.partyId!, cur);
  const plan: Omit<ClearingPlan, "fingerprint"> = {
    kind: "RECLASSIFY",
    party: { id: v.partyId!, name: v.party!.name },
    currencyCode: cur,
    documentDate: input.documentDate,
    paymentAccount: { id: pa.id, name: pa.name, code: pa.account.code },
    reference: input.reference?.trim() || v.voucherNumber,
    notes: input.notes?.trim() || null,
    receivedInr: new Decimal(0),
    receivedFc: new Decimal(0),
    payoutRate: cur === "INR" ? new Decimal(1) : amountInr.dividedBy(fc).toDecimalPlaces(8, Decimal.ROUND_HALF_UP),
    lines: [],
    availableFc: fc.negated(),
    availableInr: amountInr.negated(),
    reserveFc: new Decimal(0),
    reserveInr: new Decimal(0),
    fxDifferenceInr: new Decimal(0),
    availableOn: null,
    sourceVoucherId: v.id,
    before,
    after: { available: { fc: r4(before.available.fc.plus(fc)), inr: round2(before.available.inr.plus(amountInr)) }, reserve: before.reserve },
    journal: journalFrom([
      { accountCode: clearingAccount.code, accountName: clearingAccount.name, partyId: v.partyId, partyName: v.party!.name, debit: amountInr, description: `Receipt of ${v.voucherNumber} reclassified to clearing` },
      { accountCode: pa.account.code, accountName: pa.name, partyName: null, credit: amountInr, description: `Receipt of ${v.voucherNumber} reclassified to clearing` },
    ]),
    entries: [{ bucket: "AVAILABLE", kind: "RECLASSIFY", fc, inr: amountInr }],
    allocationsSupplied: false,
    warnings: [
      `Only the receipt moves: ${pa.name} −${amountInr.toFixed(2)}, ${v.party!.name} clearing +${amountInr.toFixed(2)}. The sale ${v.voucherNumber} — its amount, GST, revenue, COGS, finished-piece status and stock — is not touched.`,
      "Afterwards, post the real payout (and any fees) as a settlement against this clearing balance.",
    ],
  };
  return { ...plan, fingerprint: planFingerprint(plan) };
}

// ---------------------------------------------------------------------------
// Gross-up a marketplace sale that was recorded net of the marketplace's fees
// ---------------------------------------------------------------------------

export const GROSS_UP_TAX_MODES = ["NONE", "INCLUSIVE", "EXCLUSIVE"] as const;
export type GrossUpTaxMode = (typeof GROSS_UP_TAX_MODES)[number];

export type GrossUpInput = {
  saleVoucherId: string;
  documentDate: Date;
  /** The gross amount the marketplace sold the order for (INR), as on its statement. */
  grossSaleInr: DecimalInput;
  /** GST on the gross-up amount, exactly as the CA confirmed — never defaulted. */
  taxMode: GrossUpTaxMode | "" | null | undefined;
  gstTreatment?: "CGST_SGST" | "IGST" | "" | null;
  gstRatePercent?: DecimalInput | null;
  /** The CA's confirmation in the Owner's words (who / when / what). Required. */
  taxConfirmation: string;
  reference?: string | null;
  notes?: string | null;
};

export type GrossUpSettlementInput = {
  paymentAccountId: string | null;
  receivedInr: DecimalInput;
  lines: SettlementLineInput[];
  documentDate?: Date | null;
  reference?: string | null;
  notes?: string | null;
};

export type GrossUpWorkflowInput = GrossUpInput & { settlement?: GrossUpSettlementInput | null };

type GrossUpSource = {
  voucherNumber: string;
  partyId: string;
  partyName: string;
  /** What the sale debited to its receipt (Cash/Bank or 1150) — the sale total. */
  recordedInr: Decimal;
  /** Sales revenue (4000) the sale itself credited. */
  recordedRevenueInr: Decimal;
  /** The receipt is still in Cash/Bank: a reclassification must come first. */
  needsReclass: boolean;
  discountInr: Decimal;
  saleCode: string | null;
};

/** Why this sale cannot be grossed up ({ block }), or where its receipt is. Checked again inside the posting transaction. */
async function grossUpSource(tx: Tx, saleVoucherId: string): Promise<{ block: string } | GrossUpSource> {
  const v = await tx.voucher.findUnique({
    where: { id: saleVoucherId },
    include: {
      party: true,
      journalEntries: { include: { account: { select: { code: true } } } },
      reversedByVoucher: { select: { voucherNumber: true } },
      clearingDocumentsSourced: { where: { status: "POSTED" }, select: { kind: true, currencyCode: true, availableInr: true } },
    },
  });
  if (!v) return { block: "Sale not found." };
  if (v.voucherType !== "SALE") return { block: `${v.voucherNumber} is not a sale.` };
  if (v.status !== "POSTED") return { block: `${v.voucherNumber} is cancelled${v.reversedByVoucher ? ` (${v.reversedByVoucher.voucherNumber})` : ""}.` };
  if (!v.party?.clearingEnabled) return { block: `${v.party?.name ?? "The party"} is not a clearing party. Mark it as one first.` };
  if (v.clearingDocumentsSourced.some((d) => d.kind === "GROSS_UP")) return { block: `${v.voucherNumber} was already grossed up.` };
  const sale = await tx.finishedJewellerySale.findUnique({ where: { voucherId: v.id }, include: { returns: { select: { returnCode: true } }, lines: { select: { returnStatus: true } } } });
  if (sale) {
    if (sale.status !== "POSTED") return { block: `${sale.saleCode} is ${sale.status.toLowerCase()}.` };
    if (sale.returns.length) return { block: `${sale.saleCode} has a sale return (${sale.returns[0].returnCode}) — it cannot be grossed up.` };
    if (sale.lines.some((l) => l.returnStatus !== "NONE")) return { block: `${sale.saleCode} has returned lines.` };
  }
  const correction = await tx.correction.findFirst({ where: { OR: [{ correctionVoucherId: v.id }, { entityId: v.id }] }, select: { correctionCode: true } });
  if (correction) return { block: `${v.voucherNumber} has correction ${correction.correctionCode}.` };

  const credit = (codes: string[]) => round2(v.journalEntries.filter((j) => codes.includes(j.account.code)).reduce((s, j) => s.plus(j.credit).minus(j.debit), ZERO));
  const recordedRevenueInr = credit([SYSTEM_ACCOUNT_CODES.SALES_INCOME]);
  const saleTotal = round2(recordedRevenueInr.plus(credit([SYSTEM_ACCOUNT_CODES.OUTPUT_CGST, SYSTEM_ACCOUNT_CODES.OUTPUT_SGST, SYSTEM_ACCOUNT_CODES.OUTPUT_IGST])));

  let recordedInr: Decimal;
  let needsReclass = false;
  const saleEntry = await tx.clearingEntry.findFirst({ where: { voucherId: v.id, kind: "SALE" }, select: { currencyCode: true, inrAmount: true } });
  const reclass = v.clearingDocumentsSourced.find((d) => d.kind === "RECLASSIFY");
  if (saleEntry) {
    if (saleEntry.currencyCode !== "INR") return { block: `${v.voucherNumber} is a ${saleEntry.currencyCode} clearing sale — gross-up is only for INR clearing balances.` };
    recordedInr = round2(saleEntry.inrAmount);
  } else if (reclass) {
    if (reclass.currencyCode !== "INR") return { block: `${v.voucherNumber} was reclassified into ${reclass.currencyCode} clearing — gross-up is only for INR clearing balances.` };
    recordedInr = round2(new Decimal(reclass.availableInr).abs());
  } else {
    const block = await reclassifyBlock(tx, v.id);
    if (block) return { block };
    const pa = await tx.paymentAccount.findUniqueOrThrow({ where: { id: v.paymentAccountId! }, select: { accountId: true } });
    recordedInr = round2(v.journalEntries.filter((j) => j.accountId === pa.accountId).reduce((s, j) => s.plus(j.debit).minus(j.credit), ZERO));
    needsReclass = true;
  }
  if (!recordedInr.equals(saleTotal)) {
    return { block: `${v.voucherNumber}: only ₹${recordedInr.toFixed(2)} of the ₹${saleTotal.toFixed(2)} sale is in the receipt / clearing (part on credit) — gross-up is not supported for it.` };
  }
  return {
    voucherNumber: v.voucherNumber,
    partyId: v.partyId!,
    partyName: v.party.name,
    recordedInr,
    recordedRevenueInr,
    needsReclass,
    discountInr: round2(sale?.discountTotal ?? 0),
    saleCode: sale?.saleCode ?? null,
  };
}

/** Why this sale cannot be grossed up, or null. */
export async function grossUpBlock(tx: Tx, saleVoucherId: string): Promise<string | null> {
  const src = await grossUpSource(tx, saleVoucherId);
  return "block" in src ? src.block : null;
}

const assumedAfter = (p: ClearingPlan): ClearingBalance => ({ available: p.after.available, reserve: p.after.reserve, entryCount: p.before.entryCount + p.entries.length });

/**
 * Dr 1150 (party) / Cr 4000 Sales [/ Cr output GST]: the part of the marketplace's
 * gross sale that the sale voucher left out. The sale voucher, its COGS, the
 * piece and stock are not touched; the fees come off clearing in the settlement.
 */
export async function planGrossUp(tx: Tx, input: GrossUpInput, opts: { assumedBefore?: ClearingBalance; pendingReclass?: boolean } = {}): Promise<ClearingPlan> {
  const src = await grossUpSource(tx, input.saleVoucherId);
  if ("block" in src) throw new ClearingError(src.block);
  if (src.needsReclass && !opts.pendingReclass) throw new ClearingError(`The receipt of ${src.voucherNumber} is still in Cash/Bank — reclassify it to clearing first.`);
  const gross = round2(money(input.grossSaleInr, "Gross sale amount", 2));
  if (!gross.greaterThan(src.recordedInr)) throw new ClearingError(`The gross sale amount must be more than the ₹${src.recordedInr.toFixed(2)} already recorded on ${src.voucherNumber}.`);
  const confirmation = (input.taxConfirmation ?? "").trim();
  if (confirmation.length < 10) throw new ClearingError("Record the CA's GST confirmation for this gross-up (at least 10 characters: who confirmed, when, what). The app does not guess tax.");
  const mode = input.taxMode;
  if (!mode || !(GROSS_UP_TAX_MODES as readonly string[]).includes(mode)) throw new ClearingError("Choose the GST treatment of the gross-up exactly as the CA confirmed it.");

  const missing = round2(gross.minus(src.recordedInr));
  let revenue = missing;
  let tax = new Decimal(0);
  let treatment: "CGST_SGST" | "IGST" | null = null;
  let rate = new Decimal(0);
  if (mode !== "NONE") {
    if (input.gstTreatment !== "CGST_SGST" && input.gstTreatment !== "IGST") throw new ClearingError("Choose CGST + SGST or IGST, as the CA confirmed.");
    treatment = input.gstTreatment;
    rate = money(input.gstRatePercent, "GST rate %", 2);
    if (rate.greaterThan(100)) throw new ClearingError("GST rate % must be at most 100.");
    if (mode === "EXCLUSIVE") tax = round2(missing.times(rate).dividedBy(100));
    else {
      tax = round2(missing.times(rate).dividedBy(rate.plus(100)));
      revenue = round2(missing.minus(tax));
    }
  }
  const clearingInr = round2(revenue.plus(tax));

  const clearingAccount = await accountByCode(tx, SYSTEM_ACCOUNT_CODES.MARKETPLACE_CLEARING);
  const salesAccount = await accountByCode(tx, SYSTEM_ACCOUNT_CODES.SALES_INCOME);
  const before = opts.assumedBefore ?? (await getClearingBalance(tx, src.partyId, "INR"));
  const lines: PlannedLine[] = [
    { lineType: "GROSS_UP_REVENUE", direction: "ADDITION", accountId: salesAccount.id, accountCode: salesAccount.code, accountName: salesAccount.name, fc: revenue, inr: revenue, description: `Gross-up of ${src.voucherNumber}` },
  ];
  if (treatment) {
    const split = splitGstAmount(tax, treatment);
    for (const [code, amount] of [
      [SYSTEM_ACCOUNT_CODES.OUTPUT_CGST, split.cgst],
      [SYSTEM_ACCOUNT_CODES.OUTPUT_SGST, split.sgst],
      [SYSTEM_ACCOUNT_CODES.OUTPUT_IGST, split.igst],
    ] as const) {
      if (amount.isZero()) continue;
      const a = await accountByCode(tx, code);
      lines.push({ lineType: "GROSS_UP_TAX", direction: "ADDITION", accountId: a.id, accountCode: a.code, accountName: a.name, fc: amount, inr: amount, description: `${mode === "INCLUSIVE" ? "Included" : "Added"} GST ${rate.toFixed(2)}% on the gross-up` });
    }
  }
  const label = `Gross-up of ${src.voucherNumber} to ₹${gross.toFixed(2)}`;
  const journal = journalFrom([
    { accountCode: clearingAccount.code, accountName: clearingAccount.name, partyId: src.partyId, partyName: src.partyName, debit: clearingInr, description: label },
    ...lines.map((l) => ({ accountCode: l.accountCode, accountName: l.accountName, partyName: null, credit: l.inr, description: `${CLEARING_LINE_LABELS[l.lineType]} — ${l.description}` })),
  ]);

  const warnings = [
    `The sale ${src.voucherNumber}${src.saleCode ? ` (${src.saleCode})` : ""} is not edited: its amount, GST, COGS, finished-piece status and stock stay as posted. This separate voucher adds the ₹${missing.toFixed(2)} it left out.`,
    `Sales revenue for this order becomes ₹${round2(src.recordedRevenueInr.plus(revenue)).toFixed(2)} (₹${src.recordedRevenueInr.toFixed(2)} + ₹${revenue.toFixed(2)}).`,
    mode === "NONE"
      ? "GST: none on the gross-up, as recorded from the CA's confirmation."
      : `GST: ₹${tax.toFixed(2)} ${treatment === "IGST" ? "IGST" : "CGST + SGST"} at ${rate.toFixed(2)}% ${mode === "INCLUSIVE" ? "included in" : "added to"} the gross-up, as recorded from the CA's confirmation. The original sale's GST is not changed.`,
    "Profit stays unchanged only when the settlement books the same amount as fees / expenses.",
  ];
  if (!src.discountInr.isZero()) warnings.push(`${src.saleCode} recorded a discount of ₹${src.discountInr.toFixed(2)}; it stays on the sale record (history is not rewritten).`);
  if (mode === "EXCLUSIVE") warnings.push(`Clearing grows by ₹${clearingInr.toFixed(2)} (gross-up + GST): the settlement must account for the GST part too.`);

  const plan: Omit<ClearingPlan, "fingerprint"> = {
    kind: "GROSS_UP",
    party: { id: src.partyId, name: src.partyName },
    currencyCode: "INR",
    documentDate: input.documentDate,
    paymentAccount: null,
    reference: input.reference?.trim() || src.voucherNumber,
    notes: input.notes?.trim() || null,
    receivedInr: new Decimal(0),
    receivedFc: new Decimal(0),
    payoutRate: new Decimal(1),
    lines,
    availableFc: clearingInr.negated(),
    availableInr: clearingInr.negated(),
    reserveFc: new Decimal(0),
    reserveInr: new Decimal(0),
    fxDifferenceInr: new Decimal(0),
    availableOn: null,
    sourceVoucherId: input.saleVoucherId,
    grossSaleInr: gross,
    taxConfirmation: confirmation,
    before,
    after: { available: { fc: r4(before.available.fc.plus(clearingInr)), inr: round2(before.available.inr.plus(clearingInr)) }, reserve: before.reserve },
    journal,
    entries: [{ bucket: "AVAILABLE", kind: "GROSS_UP", fc: clearingInr, inr: clearingInr }],
    allocationsSupplied: false,
    warnings,
  };
  return { ...plan, fingerprint: planFingerprint(plan, `${gross.toFixed(2)}|${mode}|${treatment ?? ""}|${rate.toFixed(2)}|${confirmation}`) };
}

export type GrossUpEffectRow = { accountCode: string; accountName: string; accountType: string; net: Decimal };

export type GrossUpWorkflowPlan = {
  sale: { voucherId: string; voucherNumber: string; recordedInr: Decimal; recordedRevenueInr: Decimal };
  reclass: ClearingPlan | null;
  grossUp: ClearingPlan;
  settlement: ClearingPlan | null;
  effect: {
    /** Net Dr − Cr of every account the workflow touches. */
    byAccount: GrossUpEffectRow[];
    cashBankNet: Decimal;
    clearingAfterInr: Decimal;
    revenueAdded: Decimal;
    taxAdded: Decimal;
    expenseAdded: Decimal;
    /** Income credited − expense debited by the workflow (0 = profit unchanged). */
    profitChange: Decimal;
  };
  fingerprint: string;
};

const reclassInputOf = (input: GrossUpInput): ReclassifyInput => ({ saleVoucherId: input.saleVoucherId, documentDate: input.documentDate, currencyCode: "INR", reference: input.reference, notes: input.notes });
const settlementInputOf = (input: GrossUpWorkflowInput, partyId: string): SettlementInput => ({
  partyId,
  currencyCode: "INR",
  documentDate: input.settlement?.documentDate ?? input.documentDate,
  paymentAccountId: input.settlement?.paymentAccountId ?? null,
  reference: input.settlement?.reference ?? input.reference,
  notes: input.settlement?.notes ?? null,
  receivedInr: input.settlement?.receivedInr ?? "0",
  lines: input.settlement?.lines ?? [],
});

/**
 * Preview of the whole correction, each step planned on the balance the previous
 * one leaves: (1) receipt Cash/Bank → clearing, if still needed; (2) gross-up;
 * (3) optional settlement of the gross (Bank + fees). Nothing is saved.
 */
export async function planGrossUpWorkflow(tx: Tx, input: GrossUpWorkflowInput): Promise<GrossUpWorkflowPlan> {
  const src = await grossUpSource(tx, input.saleVoucherId);
  if ("block" in src) throw new ClearingError(src.block);
  const reclass = src.needsReclass ? await planReclassify(tx, reclassInputOf(input)) : null;
  const grossUp = await planGrossUp(tx, input, { assumedBefore: reclass ? assumedAfter(reclass) : undefined, pendingReclass: !!reclass });
  const settlement = input.settlement ? await planSettlement(tx, settlementInputOf(input, src.partyId), { assumedBefore: assumedAfter(grossUp) }) : null;

  const steps = [reclass, grossUp, settlement].filter((p): p is ClearingPlan => !!p);
  const nets = new Map<string, Decimal>();
  for (const l of steps.flatMap((p) => p.journal)) nets.set(l.accountCode, round2((nets.get(l.accountCode) ?? ZERO).plus(l.debit).minus(l.credit)));
  const accounts = await tx.account.findMany({ where: { code: { in: [...nets.keys()] } }, select: { id: true, code: true, name: true, type: true } });
  const paymentAccountIds = new Set((await tx.paymentAccount.findMany({ select: { accountId: true } })).map((p) => p.accountId));
  const byAccount = accounts
    .map((a) => ({ accountCode: a.code, accountName: a.name, accountType: a.type, net: nets.get(a.code)!, isPayment: paymentAccountIds.has(a.id) }))
    .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
  const sum = (pred: (r: (typeof byAccount)[number]) => boolean) => round2(byAccount.filter(pred).reduce((s, r) => s.plus(r.net), ZERO));
  const taxCodes = new Set<string>([SYSTEM_ACCOUNT_CODES.OUTPUT_CGST, SYSTEM_ACCOUNT_CODES.OUTPUT_SGST, SYSTEM_ACCOUNT_CODES.OUTPUT_IGST]);
  const last = steps[steps.length - 1];
  return {
    sale: { voucherId: input.saleVoucherId, voucherNumber: src.voucherNumber, recordedInr: src.recordedInr, recordedRevenueInr: src.recordedRevenueInr },
    reclass,
    grossUp,
    settlement,
    effect: {
      byAccount: byAccount.map(({ accountCode, accountName, accountType, net }) => ({ accountCode, accountName, accountType, net })),
      cashBankNet: sum((r) => r.isPayment),
      clearingAfterInr: last.after.available.inr,
      revenueAdded: sum((r) => r.accountCode === SYSTEM_ACCOUNT_CODES.SALES_INCOME).negated(),
      taxAdded: sum((r) => taxCodes.has(r.accountCode)).negated(),
      expenseAdded: sum((r) => r.accountType === "EXPENSE"),
      profitChange: sum((r) => r.accountType === "INCOME" || r.accountType === "EXPENSE").negated(),
    },
    fingerprint: fingerprintOf(steps.map((p) => p.fingerprint)),
  };
}

// ---------------------------------------------------------------------------
// Posting (one transaction, party locked, fresh preview required)
// ---------------------------------------------------------------------------

const VOUCHER_TYPE: Record<ClearingDocumentKind, "CLEARING_SETTLEMENT" | "CLEARING_RESERVE" | "CLEARING_RECLASS" | "CLEARING_GROSSUP"> = {
  SETTLEMENT: "CLEARING_SETTLEMENT",
  RESERVE_HOLD: "CLEARING_RESERVE",
  RESERVE_RELEASE: "CLEARING_RESERVE",
  RECLASSIFY: "CLEARING_RECLASS",
  GROSS_UP: "CLEARING_GROSSUP",
};

type PostCommon = { idempotencyKey: string; expectedFingerprint: string; actor: Actor; fyStartMonth: number; fyStartDay: number };

function requireOwner(actor: Actor) {
  if (actor.role !== "OWNER") throw new ClearingError("Only the Owner can post or reverse clearing settlements.");
}

async function postPlan(tx: Tx, partyId: string, build: () => Promise<ClearingPlan>, c: PostCommon) {
  requireOwner(c.actor);
  if (!c.idempotencyKey?.trim()) throw new ClearingError("Missing submission key — reload the page and try again.");
  await lockParty(tx, partyId);
  const existing = await tx.clearingDocument.findUnique({ where: { idempotencyKey: c.idempotencyKey } });
  if (existing) {
    if (existing.partyId !== partyId) throw new ClearingError("This submission key was already used for another party.");
    return { document: existing, replayed: true as const };
  }
  const plan = await build();
  if (plan.fingerprint !== c.expectedFingerprint) {
    throw new ClearingError("The balances or amounts changed after this preview. Review the new preview and confirm again. Nothing was saved.");
  }
  const amount = plan.kind === "SETTLEMENT" ? plan.availableInr.plus(plan.reserveInr.isNegative() ? plan.reserveInr.abs() : 0) : plan.availableInr.abs();
  // Kinds that correct a sale: one live document of each kind per sale (checked again under the party lock).
  if (plan.sourceVoucherId && (plan.kind === "RECLASSIFY" || plan.kind === "GROSS_UP")) {
    const live = await tx.clearingDocument.findFirst({ where: { sourceVoucherId: plan.sourceVoucherId, kind: plan.kind, status: "POSTED" }, select: { id: true } });
    if (live) throw new ClearingError(plan.kind === "RECLASSIFY" ? "This sale was already reclassified to clearing." : "This sale was already grossed up.");
  }
  const voucher = await createVoucherHeader(
    tx,
    {
      date: plan.documentDate,
      fyStartMonth: c.fyStartMonth,
      fyStartDay: c.fyStartDay,
      currencyCode: plan.currencyCode,
      exchangeRate: plan.payoutRate.toDecimalPlaces(4, Decimal.ROUND_HALF_UP),
      referenceNumber: plan.reference,
      note: plan.notes,
      createdByUserId: c.actor.id,
    },
    VOUCHER_TYPE[plan.kind],
    { amount: round2(amount), partyId: plan.party.id, paymentAccountId: plan.paymentAccount?.id ?? null }
  );
  await insertBalancedJournalLines(
    tx,
    voucher.id,
    plan.journal.map((l) => ({
      accountCode: l.accountCode,
      partyId: l.party ? plan.party.id : null,
      debit: l.debit,
      credit: l.credit,
      description: l.description,
    }))
  );
  const document = await tx.clearingDocument.create({
    data: {
      kind: plan.kind,
      partyId: plan.party.id,
      currencyCode: plan.currencyCode,
      documentDate: plan.documentDate,
      paymentAccountId: plan.paymentAccount?.id ?? null,
      reference: plan.reference,
      notes: plan.notes,
      receivedInr: plan.receivedInr.toFixed(2),
      receivedFc: plan.receivedFc.toFixed(4),
      payoutRate: plan.payoutRate.toFixed(8),
      availableFc: plan.availableFc.toFixed(4),
      availableInr: plan.availableInr.toFixed(2),
      reserveFc: plan.reserveFc.toFixed(4),
      reserveInr: plan.reserveInr.toFixed(2),
      fxDifferenceInr: plan.fxDifferenceInr.toFixed(2),
      availableOn: plan.availableOn,
      sourceVoucherId: plan.sourceVoucherId,
      grossSaleInr: plan.grossSaleInr ? plan.grossSaleInr.toFixed(2) : null,
      taxConfirmation: plan.taxConfirmation ?? null,
      previewFingerprint: plan.fingerprint,
      voucherId: voucher.id,
      idempotencyKey: c.idempotencyKey,
      createdByUserId: c.actor.id,
      lines: {
        create: plan.lines.map((l, i) => ({
          lineType: l.lineType,
          direction: l.direction,
          accountId: l.accountId,
          fcAmount: l.fc.toFixed(4),
          inrAmount: l.inr.toFixed(2),
          description: l.description,
          sortOrder: i,
        })),
      },
    },
  });
  await tx.clearingEntry.createMany({
    data: plan.entries.map((e) => ({
      partyId: plan.party.id,
      currencyCode: plan.currencyCode,
      bucket: e.bucket,
      kind: e.kind,
      fcAmount: e.fc.toFixed(4),
      inrAmount: e.inr.toFixed(2),
      voucherId: voucher.id,
      documentId: document.id,
    })),
  });
  // Belt and braces: the sub-ledger must still match the ledger for this party.
  await assertPartyClearingReconciles(tx, plan.party.id);
  return { document, voucherNumber: voucher.voucherNumber, replayed: false as const };
}

export const postSettlement = (tx: Tx, input: SettlementInput & PostCommon) => postPlan(tx, input.partyId, () => planSettlement(tx, input), input);
export const postReserveMove = (tx: Tx, input: ReserveInput & PostCommon) => postPlan(tx, input.partyId, () => planReserveMove(tx, input), input);
export async function postReclassify(tx: Tx, input: ReclassifyInput & PostCommon) {
  const v = await tx.voucher.findUnique({ where: { id: input.saleVoucherId }, select: { partyId: true } });
  if (!v?.partyId) throw new ClearingError("Sale not found.");
  return postPlan(tx, v.partyId, () => planReclassify(tx, input), input);
}

/**
 * Posts the previewed gross-up workflow in ONE transaction (all or nothing):
 * reclassification (if needed), gross-up, settlement (if given) — each through
 * postPlan with its own fingerprint and a derived idempotency key.
 */
export async function postGrossUpWorkflow(tx: Tx, input: GrossUpWorkflowInput & PostCommon) {
  requireOwner(input.actor);
  if (!input.idempotencyKey?.trim()) throw new ClearingError("Missing submission key — reload the page and try again.");
  const v = await tx.voucher.findUnique({ where: { id: input.saleVoucherId }, select: { partyId: true } });
  if (!v?.partyId) throw new ClearingError("Sale not found.");
  await lockParty(tx, v.partyId);
  const replay = await tx.clearingDocument.findUnique({ where: { idempotencyKey: `${input.idempotencyKey}:g` } });
  if (replay) {
    if (replay.sourceVoucherId !== input.saleVoucherId) throw new ClearingError("This submission key was already used for another sale.");
    return { replayed: true as const, voucherNumbers: [] as string[] };
  }
  const plan = await planGrossUpWorkflow(tx, input);
  if (plan.fingerprint !== input.expectedFingerprint) {
    throw new ClearingError("The balances or amounts changed after this preview. Review the new preview and confirm again. Nothing was saved.");
  }
  const common = { actor: input.actor, fyStartMonth: input.fyStartMonth, fyStartDay: input.fyStartDay };
  const voucherNumbers: string[] = [];
  const keep = (r: Awaited<ReturnType<typeof postPlan>>) => {
    if (!r.replayed) voucherNumbers.push(r.voucherNumber);
  };
  if (plan.reclass) {
    keep(await postPlan(tx, v.partyId, () => planReclassify(tx, reclassInputOf(input)), { ...common, idempotencyKey: `${input.idempotencyKey}:r`, expectedFingerprint: plan.reclass.fingerprint }));
  }
  keep(await postPlan(tx, v.partyId, () => planGrossUp(tx, input), { ...common, idempotencyKey: `${input.idempotencyKey}:g`, expectedFingerprint: plan.grossUp.fingerprint }));
  if (plan.settlement) {
    keep(await postPlan(tx, v.partyId, () => planSettlement(tx, settlementInputOf(input, v.partyId!)), { ...common, idempotencyKey: `${input.idempotencyKey}:s`, expectedFingerprint: plan.settlement.fingerprint }));
  }
  return { replayed: false as const, voucherNumbers };
}

/** Σ sub-ledger INR per bucket = the party's 1150 / 1160 ledger. */
export async function assertPartyClearingReconciles(tx: Tx, partyId: string) {
  const [r] = await tx.$queryRawUnsafe<{ ledger_a: string; ledger_r: string; sub_a: string; sub_r: string }[]>(
    `select
       coalesce((select sum(j.debit - j.credit) from journal_entries j join accounts a on a.id = j."accountId" where a.code = '1150' and j."partyId" = $1), 0)::numeric(14,2)::text ledger_a,
       coalesce((select sum(j.debit - j.credit) from journal_entries j join accounts a on a.id = j."accountId" where a.code = '1160' and j."partyId" = $1), 0)::numeric(14,2)::text ledger_r,
       coalesce((select sum("inrAmount") from clearing_entries where "partyId" = $1 and bucket = 'AVAILABLE'), 0)::numeric(14,2)::text sub_a,
       coalesce((select sum("inrAmount") from clearing_entries where "partyId" = $1 and bucket = 'RESERVE'), 0)::numeric(14,2)::text sub_r`,
    partyId
  );
  if (r.ledger_a !== r.sub_a || r.ledger_r !== r.sub_r) {
    throw new ClearingError(`Clearing sub-ledger would not match the ledger (1150 ${r.ledger_a} vs ${r.sub_a}; 1160 ${r.ledger_r} vs ${r.sub_r}). Nothing was saved.`);
  }
}

// ---------------------------------------------------------------------------
// Reversal (newest first, mirror voucher, allocations undone)
// ---------------------------------------------------------------------------

export async function clearingReversalBlock(tx: Tx, documentId: string): Promise<string | null> {
  const doc = await tx.clearingDocument.findUnique({ where: { id: documentId }, include: { voucher: { select: { voucherNumber: true } } } });
  if (!doc) return "Settlement not found.";
  if (doc.status !== "POSTED") return `${doc.voucher.voucherNumber} is already reversed.`;
  const later = await tx.clearingDocument.findFirst({
    where: { partyId: doc.partyId, currencyCode: doc.currencyCode, status: "POSTED", sequence: { gt: doc.sequence } },
    orderBy: { sequence: "desc" },
    include: { voucher: { select: { voucherNumber: true } } },
  });
  if (later) return `Reverse the later ${later.voucher.voucherNumber} first (newest first).`;
  const bal = await getClearingBalance(tx, doc.partyId, doc.currencyCode);
  const afterAvailable = bal.available.fc.plus(doc.availableFc);
  const afterReserve = bal.reserve.fc.minus(doc.reserveFc);
  if (afterAvailable.isNegative()) return `Reversing would leave ${doc.currencyCode} ${afterAvailable.toFixed(2)} in available clearing (a sale return or cancellation reduced it since).`;
  if (afterReserve.isNegative()) return `Reversing would leave a negative reserve (${doc.currencyCode} ${afterReserve.toFixed(2)}).`;
  return null;
}

export async function reverseClearingDocument(
  tx: Tx,
  input: { documentId: string; reason: string; idempotencyKey: string; actor: Actor; fyStartMonth: number; fyStartDay: number }
) {
  requireOwner(input.actor);
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10) throw new ClearingError("Give a reason of at least 10 characters.");
  if (!input.idempotencyKey?.trim()) throw new ClearingError("Missing submission key — reload the page and try again.");
  const doc0 = await tx.clearingDocument.findUnique({ where: { id: input.documentId }, select: { partyId: true } });
  if (!doc0) throw new ClearingError("Settlement not found.");
  await lockParty(tx, doc0.partyId);
  const replay = await tx.clearingDocument.findUnique({ where: { reversalIdempotencyKey: input.idempotencyKey } });
  if (replay) {
    if (replay.id !== input.documentId) throw new ClearingError("This submission key was already used for another reversal.");
    return { document: replay, replayed: true as const };
  }
  const block = await clearingReversalBlock(tx, input.documentId);
  if (block) throw new ClearingError(block);
  const doc = await tx.clearingDocument.findUniqueOrThrow({ where: { id: input.documentId } });
  const reversal = await cancelVoucher(tx, {
    voucherId: doc.voucherId,
    cancelledByUserId: input.actor.id,
    cancellationReason: reason,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
  });
  await tx.clearingAllocation.updateMany({
    where: { documentId: doc.id, status: "ACTIVE" },
    data: { status: "REVERSED", reversedAt: new Date(), reversedByUserId: input.actor.id, reversalReason: `Settlement reversed: ${reason}` },
  });
  const updated = await tx.clearingDocument.update({
    where: { id: doc.id },
    data: { status: "REVERSED", reversalVoucherId: reversal.id, reversedAt: new Date(), reversedByUserId: input.actor.id, reversalReason: reason, reversalIdempotencyKey: input.idempotencyKey },
  });
  await assertPartyClearingReconciles(tx, doc.partyId);
  return { document: updated, reversalVoucherNumber: reversal.voucherNumber, replayed: false as const };
}

// ---------------------------------------------------------------------------
// Optional allocation (statement only — never moves money)
// ---------------------------------------------------------------------------

/** A clearing sale's amount in its clearing currency, less returns and live allocations. */
export async function saleOpenForAllocation(tx: Tx, saleVoucherId: string) {
  const sale = await tx.clearingEntry.findFirst({ where: { voucherId: saleVoucherId, kind: "SALE" } });
  if (!sale) return null;
  const fjs = await tx.finishedJewellerySale.findUnique({ where: { voucherId: saleVoucherId }, include: { returns: { select: { voucherId: true } } } });
  const returnVoucherIds = (fjs?.returns ?? []).map((r) => r.voucherId).filter((x): x is string => !!x);
  const [returned, allocated, voucher] = await Promise.all([
    returnVoucherIds.length ? tx.clearingEntry.aggregate({ where: { voucherId: { in: returnVoucherIds } }, _sum: { fcAmount: true } }) : Promise.resolve({ _sum: { fcAmount: null } }),
    tx.clearingAllocation.aggregate({ where: { saleVoucherId, status: "ACTIVE" }, _sum: { fcAmount: true } }),
    tx.voucher.findUnique({ where: { id: saleVoucherId }, select: { status: true, voucherNumber: true } }),
  ]);
  const saleFc = new Decimal(sale.fcAmount);
  const open = r4(saleFc.plus(returned._sum.fcAmount ?? 0).minus(allocated._sum.fcAmount ?? 0));
  return { partyId: sale.partyId, currencyCode: sale.currencyCode, saleFc, open, status: voucher?.status ?? "POSTED", voucherNumber: voucher?.voucherNumber ?? "" };
}

export async function allocateSettlement(
  tx: Tx,
  input: { documentId: string; saleVoucherId: string; amountFc: DecimalInput; reason: string; idempotencyKey: string; actor: Actor }
) {
  requireOwner(input.actor);
  const reason = (input.reason ?? "").trim();
  if (reason.length < 5) throw new ClearingError("Say where the allocation comes from (at least 5 characters, e.g. the payout statement).");
  const fc = r4(money(input.amountFc, "Allocated amount", 4));
  const doc0 = await tx.clearingDocument.findUnique({ where: { id: input.documentId }, select: { partyId: true } });
  if (!doc0) throw new ClearingError("Settlement not found.");
  await lockParty(tx, doc0.partyId);
  const replay = await tx.clearingAllocation.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (replay) return { allocation: replay, replayed: true as const };
  const doc = await tx.clearingDocument.findUniqueOrThrow({ where: { id: input.documentId } });
  if (doc.kind !== "SETTLEMENT" || doc.status !== "POSTED") throw new ClearingError("Only a posted settlement can be allocated.");
  const sale = await saleOpenForAllocation(tx, input.saleVoucherId);
  if (!sale) throw new ClearingError("That is not a clearing sale.");
  if (sale.status !== "POSTED") throw new ClearingError(`${sale.voucherNumber} is cancelled.`);
  if (sale.partyId !== doc.partyId || sale.currencyCode !== doc.currencyCode) throw new ClearingError("The sale belongs to another provider or currency.");
  if (fc.greaterThan(sale.open)) throw new ClearingError(`Only ${doc.currencyCode} ${sale.open.toFixed(2)} of ${sale.voucherNumber} is not yet allocated.`);
  const used = await tx.clearingAllocation.aggregate({ where: { documentId: doc.id, status: "ACTIVE" }, _sum: { fcAmount: true } });
  const left = r4(new Decimal(doc.availableFc).minus(used._sum.fcAmount ?? 0));
  if (fc.greaterThan(left)) throw new ClearingError(`Only ${doc.currencyCode} ${left.toFixed(2)} of this settlement is not yet allocated.`);
  const allocation = await tx.clearingAllocation.create({
    data: { documentId: doc.id, saleVoucherId: input.saleVoucherId, fcAmount: fc.toFixed(4), reason, idempotencyKey: input.idempotencyKey, createdByUserId: input.actor.id },
  });
  return { allocation, replayed: false as const };
}

export async function reverseAllocation(tx: Tx, input: { allocationId: string; reason: string; actor: Actor }) {
  requireOwner(input.actor);
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10) throw new ClearingError("Give a reason of at least 10 characters.");
  const a = await tx.clearingAllocation.findUnique({ where: { id: input.allocationId }, include: { document: { select: { partyId: true } } } });
  if (!a) throw new ClearingError("Allocation not found.");
  await lockParty(tx, a.document.partyId);
  const n = await tx.clearingAllocation.updateMany({
    where: { id: a.id, status: "ACTIVE" },
    data: { status: "REVERSED", reversedAt: new Date(), reversedByUserId: input.actor.id, reversalReason: reason },
  });
  if (n.count === 0) throw new ClearingError("This allocation is already reversed.");
  return tx.clearingAllocation.findUniqueOrThrow({ where: { id: a.id } });
}
