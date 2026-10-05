/**
 * Owner "Correct entry" service — the one path every entry correction takes.
 *
 *   options  -> what may be corrected on a record, and what blocks it;
 *   preview  -> before / after, stock, journal lines, affected records, blockers,
 *               and a fingerprint of all of it;
 *   post     -> Owner only, reason >= 10 characters, idempotency key; locks in a
 *               fixed order, replays a duplicate key, re-plans UNDER the locks,
 *               refuses if anything blocks or the fingerprint moved, then posts the
 *               Correction (+ impacts, + voucher only for stock/accounting) and lets
 *               the handler apply its effect — all in the caller's transaction;
 *   reverse  -> Owner only, newest-first per record, handler re-checks it is safe.
 *
 * A posted record is never overwritten blindly: every change is a CorrectionImpact
 * with its before and after, the original snapshot is kept on the Correction, and a
 * stock or ledger effect is always a NEW movement or voucher.
 */
import { createHash } from "crypto";

import type { UserRole } from "@/generated/prisma/enums";
import { postCorrection, reverseCorrection } from "@/lib/corrections/engine";
import { CorrectionError, fingerprintPlan, type Tx } from "@/lib/corrections/types";
import { nextJewelleryCode } from "@/lib/jewellery/numbering";

import { metadataHandler } from "./handlers/metadata";
import { processedRoughPiecesHandler } from "./handlers/processedRoughPieces";
import { processedRoughReversalHandler } from "./handlers/processedRoughReversal";
import { MIN_REASON, type Blocker, type EntryHandler, type EntryKind, type EntryOption, type EntryPreview, type EntryTarget, type HandlerPlan } from "./types";

export const ENTRY_HANDLERS: EntryHandler[] = [processedRoughPiecesHandler, metadataHandler, processedRoughReversalHandler];
const ENTRY_MODES = ["ENTRY_METADATA", "ENTRY_QUANTITY", "REVERSE_REPOST"] as const;

export function handlerFor(kind: EntryKind, target: EntryTarget): EntryHandler {
  const h = ENTRY_HANDLERS.find((x) => x.kind === kind && x.entityTypes.includes(target.entityType));
  if (!h) throw new CorrectionError("This kind of correction is not available for this record.");
  return h;
}

function handlerOfCorrection(c: { mode: string; entityType: string; correctedSnapshot: unknown }): EntryHandler | null {
  const kind = (c.correctedSnapshot as { entryKind?: EntryKind } | null)?.entryKind;
  if (!kind) return null;
  return ENTRY_HANDLERS.find((x) => x.kind === kind && x.mode === c.mode && (x.entityTypes as string[]).includes(c.entityType)) ?? null;
}

/** Stable fingerprint of everything the Owner was shown. */
export function previewFingerprint(kind: EntryKind, target: EntryTarget, built: HandlerPlan): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind,
        target,
        changes: built.changes,
        stock: built.stock,
        ledger: fingerprintPlan(built.plan).ledger,
        impacts: fingerprintPlan(built.plan).impacts,
        blockers: built.blockers.map((b) => b.code),
      })
    )
    .digest("hex");
}

function requireOwner(role: UserRole, what: string) {
  if (role !== "OWNER") throw new CorrectionError(`Only the Owner can ${what}.`);
}

function blockedMessage(label: string, blockers: Blocker[]): string {
  return `${label} cannot be corrected now: ${blockers.map((b) => `${b.code} — ${b.message}`).join(" ")}`;
}

/** Everything that can be corrected on a record (Owner only — the action enforces it). */
export async function entryCorrectionOptions(tx: Tx, target: EntryTarget): Promise<EntryOption[]> {
  const out: EntryOption[] = [];
  for (const h of ENTRY_HANDLERS) {
    if (!h.entityTypes.includes(target.entityType)) continue;
    const o = await h.option(tx, target);
    if (o) out.push(o);
  }
  return out;
}

export async function previewEntryCorrection(
  tx: Tx,
  input: { target: EntryTarget; kind: EntryKind; values: Record<string, string>; reason: string }
): Promise<EntryPreview> {
  const h = handlerFor(input.kind, input.target);
  const built = await h.plan(tx, input.target, input.values, input.reason.trim() || "(preview)");
  return {
    kind: input.kind,
    target: input.target,
    entityLabel: built.entityLabel,
    entryClass: h.entryClass,
    changes: built.changes,
    stock: built.stock,
    ledger: built.ledger,
    affected: built.affected,
    blockers: built.blockers,
    fingerprint: previewFingerprint(input.kind, input.target, built),
  };
}

export type PostEntryInput = {
  target: EntryTarget;
  kind: EntryKind;
  values: Record<string, string>;
  reason: string;
  idempotencyKey: string;
  expectedFingerprint: string;
  owner: { id: string; role: UserRole };
  fyStartMonth: number;
  fyStartDay: number;
};

export async function postEntryCorrection(tx: Tx, input: PostEntryInput) {
  requireOwner(input.owner.role, "correct a posted entry");
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON) throw new CorrectionError(`Give the reason for this correction (at least ${MIN_REASON} characters).`);
  if (!input.idempotencyKey?.trim()) throw new CorrectionError("Missing submission key — reload the page and try again.");
  if (!input.expectedFingerprint) throw new CorrectionError("Preview the correction first.");
  const h = handlerFor(input.kind, input.target);

  await h.lock(tx, input.target);
  // Duplicate submit (double click, retry, a second tab with the same key): what it produced.
  const existing = await tx.correction.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.entityId !== input.target.entityId || existing.mode !== h.mode) {
      throw new CorrectionError("This submission key was already used for a different correction.");
    }
    return { correction: existing, replayed: true as const };
  }

  // Re-plan under the locks: the preview is only an approval of THIS plan.
  const built = await h.plan(tx, input.target, input.values, reason);
  if (built.blockers.length) throw new CorrectionError(blockedMessage(built.entityLabel, built.blockers));
  if (previewFingerprint(input.kind, input.target, built) !== input.expectedFingerprint) {
    throw new CorrectionError("The record changed after this preview was shown (another correction, receipt or issue). Review the new preview and confirm again.");
  }

  const codeOverride = built.plan.ledgerLines.length ? undefined : await nextJewelleryCode(tx, "ENTRY_CORRECTION");
  const correction = await postCorrection(tx, {
    plan: built.plan,
    preparedByUserId: input.owner.id,
    approvedByUserId: input.owner.id,
    approverRole: input.owner.role,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    idempotencyKey: input.idempotencyKey,
    correctionCodeOverride: codeOverride,
  });
  await h.apply(tx, built, correction);
  return { correction, replayed: false as const };
}

/** POSTED entry corrections of one record, newest first. */
async function liveEntryCorrections(tx: Tx, entityId: string) {
  return tx.correction.findMany({
    where: { entityId, state: "POSTED", mode: { in: [...ENTRY_MODES] }, reversedByCorrectionId: null },
    orderBy: { createdAt: "desc" },
  });
}

/** Why a posted entry correction cannot be reversed right now (empty = it can). */
export async function entryReverseBlockers(tx: Tx, correctionId: string): Promise<Blocker[]> {
  const c = await tx.correction.findUnique({ where: { id: correctionId } });
  if (!c) return [{ code: "NOT FOUND", message: "Correction not found." }];
  const h = handlerOfCorrection(c);
  if (!h) return [{ code: c.correctionCode, message: "This is not a Correct-entry correction." }];
  if (c.state !== "POSTED" || c.reversedByCorrectionId) return [{ code: c.correctionCode, message: "It has already been reversed." }];
  // Not reversible by design: the handler says what to do instead.
  if (!h.reversible) return h.reverseBlockers(tx, c);
  const newer = (await liveEntryCorrections(tx, c.entityId)).find((x) => x.createdAt > c.createdAt);
  if (newer) return [{ code: newer.correctionCode, message: `${newer.correctionCode} was posted later on the same record — reverse it first (newest first).` }];
  return h.reverseBlockers(tx, c);
}

export async function reverseEntryCorrection(
  tx: Tx,
  input: { correctionId: string; reason: string; owner: { id: string; role: UserRole }; fyStartMonth: number; fyStartDay: number }
) {
  requireOwner(input.owner.role, "reverse a correction");
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON) throw new CorrectionError(`Give the reason for reversing this correction (at least ${MIN_REASON} characters).`);
  const first = await tx.correction.findUnique({ where: { id: input.correctionId } });
  if (!first) throw new CorrectionError("Correction not found.");
  const h = handlerOfCorrection(first);
  if (!h) throw new CorrectionError("This is not a Correct-entry correction.");
  await h.lock(tx, { entityType: first.entityType as EntryTarget["entityType"], entityId: first.entityId });
  await tx.$queryRawUnsafe(`SELECT id FROM "corrections" WHERE id = $1 FOR UPDATE`, first.id);

  const blockers = await entryReverseBlockers(tx, first.id);
  if (blockers.length) throw new CorrectionError(`${first.correctionCode} cannot be reversed: ${blockers.map((b) => `${b.code} — ${b.message}`).join(" ")}`);
  const c = await tx.correction.findUniqueOrThrow({ where: { id: first.id } });
  const reversalCode = c.correctionVoucherId ? undefined : await nextJewelleryCode(tx, "ENTRY_CORRECTION");
  const reversal = await reverseCorrection(tx, {
    correctionId: c.id,
    reason,
    approverRole: input.owner.role,
    approvedByUserId: input.owner.id,
    fyStartMonth: input.fyStartMonth,
    fyStartDay: input.fyStartDay,
    correctionCodeOverride: reversalCode,
  });
  await h.undo(tx, c, { code: reversal.correctionCode, actorId: input.owner.id });
  return { reversal };
}

// ---------------------------------------------------------------------------
// History (Owner and Staff; money only for the Owner)
// ---------------------------------------------------------------------------

export type EntryHistoryItem = {
  id: string;
  code: string;
  kind: EntryKind;
  entityLabel: string;
  state: "ACTIVE" | "REVERSED";
  reason: string;
  by: string;
  at: string;
  changes: { field: string; record: string; before: string; after: string }[];
  /** Owner only: the correction voucher and its amount (null for Staff and for voucher-less ones). */
  voucher: string | null;
  amount: string | null;
  reversal: { code: string; at: string; by: string; reason: string } | null;
  /** Owner only: whether "Reverse this correction" is offered, and if not, why. */
  canReverse: boolean;
  reverseBlockers: string[];
};

const MONEY_FIELDS = new Set(["allocatedCost", "remainingWipCost", "totalLabourCharge", "issuedCostValue", "originalCost", "costValue"]);

export async function listEntryCorrections(tx: Tx, entityIds: string[], opts: { includeMoney: boolean }): Promise<EntryHistoryItem[]> {
  if (entityIds.length === 0) return [];
  const rows = await tx.correction.findMany({
    where: { entityId: { in: entityIds }, mode: { in: [...ENTRY_MODES] }, NOT: { state: { in: ["DRAFT", "AWAITING_APPROVAL", "REJECTED"] } } },
    include: {
      impacts: { orderBy: { createdAt: "asc" } },
      approvedBy: { select: { name: true } },
      correctionVoucher: { select: { voucherNumber: true, amount: true } },
      reversedBy: { include: { approvedBy: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });
  const out: EntryHistoryItem[] = [];
  for (const c of rows) {
    const kind = (c.correctedSnapshot as { entryKind?: EntryKind } | null)?.entryKind;
    if (!kind) continue; // a REVERSE_REPOST that is not an entry correction
    const reversed = c.state === "REVERSED" || !!c.reversedByCorrectionId;
    const blockers = opts.includeMoney && !reversed ? await entryReverseBlockers(tx, c.id) : [];
    out.push({
      id: c.id,
      code: c.correctionCode,
      kind,
      entityLabel: c.entityLabel,
      state: reversed ? "REVERSED" : "ACTIVE",
      reason: c.reason,
      by: c.approvedBy?.name ?? "",
      at: (c.postedAt ?? c.createdAt).toISOString(),
      changes: c.impacts
        .filter((i) => opts.includeMoney || !MONEY_FIELDS.has(i.field))
        .map((i) => ({ field: i.field, record: i.recordLabel, before: i.oldValue, after: i.newValue })),
      voucher: opts.includeMoney ? (c.correctionVoucher?.voucherNumber ?? null) : null,
      amount: opts.includeMoney && c.correctionVoucher ? c.correctionVoucher.amount.toFixed(2) : null,
      reversal: c.reversedBy
        ? { code: c.reversedBy.correctionCode, at: (c.reversedBy.postedAt ?? c.reversedBy.createdAt).toISOString(), by: c.reversedBy.approvedBy?.name ?? "", reason: c.reversedBy.reason }
        : null,
      canReverse: opts.includeMoney && !reversed && blockers.length === 0,
      reverseBlockers: blockers.map((b) => `${b.code} — ${b.message}`),
    });
  }
  return out;
}
