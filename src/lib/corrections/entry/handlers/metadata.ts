/**
 * Correct entry — METADATA (details only: no stock, no voucher).
 *
 * Each record type lists exactly which descriptive fields may be corrected after
 * posting; nothing outside the list can be reached. Before -> After is kept as
 * CorrectionImpact rows and the original values on the Correction; reversal
 * restores them, but only while each field still holds the corrected value.
 */
import { CorrectionError, type PlannedImpact, type Tx } from "@/lib/corrections/types";

import type { EntryEntityType, EntryHandler, EntryTarget, FieldSpec, HandlerPlan, PostedCorrection } from "../types";
import { type LockableTable, lockIds } from "./diamondShared";

type FieldDef = { field: string; label: string; type: FieldSpec["type"]; maxLength?: number };
type Spec = { table: LockableTable; fields: FieldDef[] };

const NOTES: FieldDef = { field: "notes", label: "Notes", type: "textarea", maxLength: 1000 };
const SPECS: Record<EntryEntityType, Spec> = {
  DIAMOND_JOB: {
    table: "diamond_jobs",
    fields: [
      NOTES,
      { field: "dueDate", label: "Due date", type: "date" },
      { field: "customShapeInstruction", label: "Cutting instruction", type: "textarea", maxLength: 500 },
      { field: "customShapeMeasurements", label: "Required measurements", type: "text", maxLength: 200 },
    ],
  },
  DIAMOND_RECEIPT: { table: "polished_receipts", fields: [NOTES] },
  JEWELLERY_JOB: {
    table: "jewellery_jobs",
    fields: [
      NOTES,
      { field: "specialInstructions", label: "Special instructions", type: "textarea", maxLength: 1000 },
      { field: "expectedDeliveryDate", label: "Expected delivery date", type: "date" },
      { field: "customerReference", label: "Customer reference", type: "text", maxLength: 120 },
    ],
  },
  JEWELLERY_RECEIPT: { table: "jewellery_receipts", fields: [NOTES] },
};

type Row = { id: string; code: string; values: Record<string, unknown> };

async function loadRow(tx: Tx, target: EntryTarget): Promise<Row | null> {
  switch (target.entityType) {
    case "DIAMOND_JOB": {
      const r = await tx.diamondJob.findUnique({ where: { id: target.entityId } });
      return r && { id: r.id, code: r.jobCode, values: r };
    }
    case "DIAMOND_RECEIPT": {
      const r = await tx.polishedReceipt.findUnique({ where: { id: target.entityId } });
      return r && { id: r.id, code: r.receiptCode, values: r };
    }
    case "JEWELLERY_JOB": {
      const r = await tx.jewelleryJob.findUnique({ where: { id: target.entityId } });
      return r && { id: r.id, code: r.jobCode, values: r };
    }
    case "JEWELLERY_RECEIPT": {
      const r = await tx.jewelleryReceipt.findUnique({ where: { id: target.entityId } });
      return r && { id: r.id, code: r.receiptCode, values: r };
    }
  }
}

async function writeRow(tx: Tx, target: EntryTarget, data: Record<string, string | Date | null>) {
  switch (target.entityType) {
    case "DIAMOND_JOB":
      await tx.diamondJob.update({ where: { id: target.entityId }, data });
      return;
    case "DIAMOND_RECEIPT":
      await tx.polishedReceipt.update({ where: { id: target.entityId }, data });
      return;
    case "JEWELLERY_JOB":
      await tx.jewelleryJob.update({ where: { id: target.entityId }, data });
      return;
    case "JEWELLERY_RECEIPT":
      await tx.jewelleryReceipt.update({ where: { id: target.entityId }, data });
      return;
  }
}

/** A stored value as the text the Owner sees and types ("" = empty). */
function asText(def: FieldDef, v: unknown): string {
  if (v == null) return "";
  if (def.type === "date") return (v as Date).toISOString().slice(0, 10);
  return String(v);
}
function toStored(def: FieldDef, text: string): string | Date | null {
  if (text === "") return null;
  if (def.type === "date") return new Date(`${text}T00:00:00.000Z`);
  return text;
}
function validate(def: FieldDef, raw: string): string {
  const text = def.type === "textarea" ? raw.replace(/\r\n/g, "\n").trim() : raw.trim();
  if (def.type === "date" && text !== "" && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`)))) {
    throw new CorrectionError(`${def.label} must be a date (YYYY-MM-DD) or empty.`);
  }
  if (def.maxLength && text.length > def.maxLength) throw new CorrectionError(`${def.label} can be at most ${def.maxLength} characters.`);
  return text;
}

type Snap = { entryKind: "METADATA"; table: string; fields: Record<string, string> };

export const metadataHandler: EntryHandler = {
  kind: "METADATA",
  entityTypes: ["DIAMOND_JOB", "DIAMOND_RECEIPT", "JEWELLERY_JOB", "JEWELLERY_RECEIPT"],
  mode: "ENTRY_METADATA",
  entryClass: "METADATA",
  reversible: true,

  async lock(tx, target) {
    await lockIds(tx, SPECS[target.entityType].table, [target.entityId]);
  },

  async option(tx, target) {
    const row = await loadRow(tx, target);
    if (!row) return null;
    return {
      kind: "METADATA",
      label: "Details (notes, instructions, references, dates)",
      entryClass: "METADATA",
      fields: SPECS[target.entityType].fields.map((d) => ({ ...d, current: asText(d, row.values[d.field]) })),
      blockers: [],
      note: "Changes only the written details. No stock, cost or voucher changes.",
      reversible: true,
    };
  },

  async plan(tx, target, values, reason): Promise<HandlerPlan> {
    const spec = SPECS[target.entityType];
    const row = await loadRow(tx, target);
    if (!row) throw new CorrectionError("Record not found.");
    for (const key of Object.keys(values)) {
      if (!spec.fields.some((d) => d.field === key)) throw new CorrectionError(`"${key}" cannot be corrected on this record.`);
    }
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    const impacts: PlannedImpact[] = [];
    const changes: HandlerPlan["changes"] = [];
    for (const def of spec.fields) {
      if (!(def.field in values)) continue;
      const old = asText(def, row.values[def.field]);
      const next = validate(def, String(values[def.field] ?? ""));
      if (next === old) continue;
      before[def.field] = old;
      after[def.field] = next;
      impacts.push({ kind: "RECORD", tableName: spec.table, recordId: row.id, recordLabel: row.code, field: def.field, oldValue: old, newValue: next });
      changes.push({ field: def.field, label: def.label, before: old || "(empty)", after: next || "(empty)" });
    }
    if (!changes.length) throw new CorrectionError("Nothing has changed — edit a field before previewing.");
    const original: Snap = { entryKind: "METADATA", table: spec.table, fields: before };
    const corrected: Snap = { entryKind: "METADATA", table: spec.table, fields: after };
    return {
      entityLabel: row.code,
      plan: {
        entityType: target.entityType,
        entityId: row.id,
        entityLabel: row.code,
        mode: "ENTRY_METADATA",
        reason,
        originalSnapshot: original,
        correctedSnapshot: corrected,
        downstream: [],
        impacts,
        ledgerLines: [],
        amount: "0.00",
        voucherNote: "",
        revaluations: [],
      },
      changes,
      stock: [],
      ledger: [],
      affected: [],
      blockers: [],
      data: after,
    };
  },

  async apply(tx, built) {
    const target = { entityType: built.plan.entityType as EntryEntityType, entityId: built.plan.entityId };
    const defs = SPECS[target.entityType].fields;
    const after = built.data as Record<string, string>;
    await writeRow(tx, target, Object.fromEntries(Object.entries(after).map(([f, v]) => [f, toStored(defs.find((d) => d.field === f)!, v)])));
  },

  async reverseBlockers(tx, correction: PostedCorrection) {
    const c = correction.correctedSnapshot as Snap;
    const type = (Object.keys(SPECS) as EntryEntityType[]).find((t) => SPECS[t].table === c.table)!;
    const row = await loadRow(tx, { entityType: type, entityId: correction.entityId });
    if (!row) return [{ code: "MISSING", message: "The record no longer exists." }];
    const out = [];
    for (const [f, v] of Object.entries(c.fields)) {
      const def = SPECS[type].fields.find((d) => d.field === f)!;
      if (asText(def, row.values[f]) !== v) out.push({ code: row.code, message: `${def.label} has been changed since this correction.` });
    }
    return out;
  },

  async undo(tx, correction) {
    const o = correction.originalSnapshot as Snap;
    const type = (Object.keys(SPECS) as EntryEntityType[]).find((t) => SPECS[t].table === o.table)!;
    const defs = SPECS[type].fields;
    await writeRow(tx, { entityType: type, entityId: correction.entityId }, Object.fromEntries(Object.entries(o.fields).map(([f, v]) => [f, toStored(defs.find((d) => d.field === f)!, v)])));
  },
};
