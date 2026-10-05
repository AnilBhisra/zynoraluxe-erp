/**
 * Owner "Correct entry" framework — shared types.
 *
 * One framework, many type-specific handlers. A handler never offers a generic
 * "update any column": it declares exactly which fields of which record type it
 * can correct, which class the correction belongs to, what blocks it, and how to
 * apply and undo it. The service (./service.ts) owns everything common: Owner
 * check, reason, idempotency, fixed-order locks, the preview fingerprint,
 * newest-first reversal and history.
 */
import type { CorrectionEntityType, CorrectionMode } from "@/generated/prisma/enums";
import type { CorrectionPlan, Tx } from "@/lib/corrections/types";

/** What is being corrected. Each kind is served by exactly one handler. */
export type EntryKind = "METADATA" | "RETURNED_PIECES" | "RECEIPT_REVERSAL";

export type EntryEntityType = Extract<CorrectionEntityType, "DIAMOND_JOB" | "DIAMOND_RECEIPT" | "JEWELLERY_JOB" | "JEWELLERY_RECEIPT">;

export type EntryTarget = { entityType: EntryEntityType; entityId: string };

/** The three correction classes the Owner sees. */
export type EntryClass = "METADATA" | "QUANTITY" | "STOCK_ACCOUNTING";
export const ENTRY_CLASS_LABEL: Record<EntryClass, string> = {
  METADATA: "Details only — no stock, no voucher",
  QUANTITY: "Count only — no value, no voucher",
  STOCK_ACCOUNTING: "Stock and accounting — posts a correction voucher",
};

/** One editable field, exactly as the handler allows it. */
export type FieldSpec = {
  field: string;
  label: string;
  type: "text" | "textarea" | "date" | "integer";
  maxLength?: number;
  /** Current value as text ("" when empty; YYYY-MM-DD for dates). */
  current: string;
};

/** Something that stops a correction, named by the record's own code. */
export type Blocker = { code: string; message: string };

export type FieldChange = { field: string; label: string; before: string; after: string };

/** A stock effect line: count and weight for everyone; cost only for the Owner. */
export type StockLine = { label: string; pieces: number; carat: string; cost: string | null };

export type LedgerPreviewLine = { accountCode: string; accountName: string; party: string | null; debit: string; credit: string };

/** What the correction panel offers for one record. */
export type EntryOption = {
  kind: EntryKind;
  label: string;
  entryClass: EntryClass;
  fields: FieldSpec[];
  /** Non-empty = refused, with the exact codes the Owner must deal with first. */
  blockers: Blocker[];
  /** Plain-language note shown with the option (e.g. how to re-enter after a reversal). */
  note: string | null;
  /** Whether a posted correction of this kind can later be reversed in the app. */
  reversible: boolean;
};

export type EntryPreview = {
  kind: EntryKind;
  target: EntryTarget;
  entityLabel: string;
  entryClass: EntryClass;
  changes: FieldChange[];
  stock: StockLine[];
  ledger: LedgerPreviewLine[];
  /** Records this correction changes besides the corrected one (codes). */
  affected: string[];
  blockers: Blocker[];
  /** Must be sent back unchanged with Confirm; a changed world refuses it. */
  fingerprint: string;
};

/** What a handler hands the service: the engine plan plus what the Owner sees. */
export type HandlerPlan = {
  plan: CorrectionPlan;
  entityLabel: string;
  changes: FieldChange[];
  stock: StockLine[];
  ledger: LedgerPreviewLine[];
  affected: string[];
  blockers: Blocker[];
  /** Handler-private data for apply(), recomputed under the locks. */
  data: unknown;
};

export type PostedCorrection = {
  id: string;
  correctionCode: string;
  originalSnapshot: unknown;
  correctedSnapshot: unknown;
  entityId: string;
  approvedByUserId: string | null;
  correctionVoucherId: string | null;
};

export interface EntryHandler {
  kind: EntryKind;
  entityTypes: EntryEntityType[];
  mode: CorrectionMode;
  entryClass: EntryClass;
  reversible: boolean;
  /** Locks everything the correction reads or writes, in one fixed order. */
  lock(tx: Tx, target: EntryTarget): Promise<void>;
  /** null when this handler does not apply to the record at all. */
  option(tx: Tx, target: EntryTarget): Promise<EntryOption | null>;
  plan(tx: Tx, target: EntryTarget, values: Record<string, string>, reason: string): Promise<HandlerPlan>;
  apply(tx: Tx, built: HandlerPlan, correction: PostedCorrection): Promise<void>;
  /** Why this posted correction cannot be undone now (empty = it can). */
  reverseBlockers(tx: Tx, correction: PostedCorrection): Promise<Blocker[]>;
  undo(tx: Tx, correction: PostedCorrection, reversal: { code: string; actorId: string }): Promise<void>;
}

export const MIN_REASON = 10;
