"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { requireUser } from "@/lib/auth/dal";
import { entryCorrectionOptions, postEntryCorrection, previewEntryCorrection, reverseEntryCorrection } from "@/lib/corrections/entry/service";
import type { EntryKind, EntryOption, EntryPreview, EntryTarget } from "@/lib/corrections/entry/types";
import { CORRECTION_TRANSACTION_OPTIONS, CorrectionError } from "@/lib/corrections/types";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";

/**
 * Owner "Correct entry" actions. Every action refuses Staff on the server and
 * returns only a refusal message to them, so no Staff response ever carries a
 * correction preview, cost, voucher or rupee figure.
 */

const TIMEOUT_MESSAGE = "This took longer than the database allows, so it was rolled back and nothing was saved. Check the record before trying again.";
const OWNER_ONLY = "Only the Owner can correct a posted entry.";

const targetSchema = z.object({
  entityType: z.enum(["DIAMOND_JOB", "DIAMOND_RECEIPT", "JEWELLERY_JOB", "JEWELLERY_RECEIPT"]),
  entityId: z.string().trim().min(1).max(64),
});
const kindSchema = z.enum(["METADATA", "RETURNED_PIECES", "RECEIPT_REVERSAL"]);
const valuesSchema = z.record(z.string().max(64), z.string().max(2000)).refine((v) => Object.keys(v).length <= 10, "Too many fields.");

export type EntryResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function ownerOrRefuse() {
  const user = await requireUser();
  return user.role === "OWNER" ? user : null;
}

function message(operation: string, error: unknown): string {
  if (error instanceof CorrectionError) return error.message;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028") return TIMEOUT_MESSAGE;
  console.error("entry correction failed", { operation, name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message.slice(0, 300) : undefined });
  return "The correction could not be completed. Nothing was saved.";
}

function revalidateAll() {
  for (const p of ["/diamond", "/jewellery-jobs", "/corrections", "/accounting", "/dashboard"]) revalidatePath(p);
}

/** What can be corrected on a record, with exact blocking codes. Owner only. */
export async function entryCorrectionOptionsAction(rawTarget: EntryTarget): Promise<EntryResult<EntryOption[]>> {
  if (!(await ownerOrRefuse())) return { ok: false, error: OWNER_ONLY };
  const target = targetSchema.safeParse(rawTarget);
  if (!target.success) return { ok: false, error: "Unknown record." };
  try {
    return { ok: true, data: await prisma.$transaction((tx) => entryCorrectionOptions(tx, target.data), CORRECTION_TRANSACTION_OPTIONS) };
  } catch (e) {
    return { ok: false, error: message("options", e) };
  }
}

/** Shows exactly what would change, writing nothing. Owner only. */
export async function previewEntryCorrectionAction(input: { target: EntryTarget; kind: EntryKind; values: Record<string, string>; reason: string }): Promise<EntryResult<EntryPreview>> {
  if (!(await ownerOrRefuse())) return { ok: false, error: OWNER_ONLY };
  const target = targetSchema.safeParse(input.target);
  const kind = kindSchema.safeParse(input.kind);
  const values = valuesSchema.safeParse(input.values ?? {});
  if (!target.success || !kind.success || !values.success) return { ok: false, error: "Please check the correction." };
  try {
    const preview = await prisma.$transaction(
      (tx) => previewEntryCorrection(tx, { target: target.data, kind: kind.data, values: values.data, reason: String(input.reason ?? "") }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    return { ok: true, data: preview };
  } catch (e) {
    return { ok: false, error: message("preview", e) };
  }
}

/** Posts the previewed correction. Owner only; idempotent; refused if the preview is stale. */
export async function postEntryCorrectionAction(input: {
  target: EntryTarget;
  kind: EntryKind;
  values: Record<string, string>;
  reason: string;
  idempotencyKey: string;
  fingerprint: string;
}): Promise<EntryResult<{ code: string; replayed: boolean }>> {
  const user = await ownerOrRefuse();
  if (!user) return { ok: false, error: OWNER_ONLY };
  const target = targetSchema.safeParse(input.target);
  const kind = kindSchema.safeParse(input.kind);
  const values = valuesSchema.safeParse(input.values ?? {});
  const key = z.string().trim().min(8).max(100).safeParse(input.idempotencyKey);
  if (!target.success || !kind.success || !values.success || !key.success) return { ok: false, error: "Please check the correction." };
  const fy = await getCompanyFySettings();
  try {
    const res = await prisma.$transaction(
      (tx) =>
        postEntryCorrection(tx, {
          target: target.data,
          kind: kind.data,
          values: values.data,
          reason: String(input.reason ?? ""),
          idempotencyKey: key.data,
          expectedFingerprint: String(input.fingerprint ?? ""),
          owner: { id: user.id, role: user.role },
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
        }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    revalidateAll();
    return { ok: true, data: { code: res.correction.correctionCode, replayed: res.replayed } };
  } catch (e) {
    if (isIdempotencyConflict(e)) {
      const existing = await prisma.correction.findUnique({ where: { idempotencyKey: key.data } });
      if (existing) return { ok: true, data: { code: existing.correctionCode, replayed: true } };
    }
    return { ok: false, error: message("post", e) };
  }
}

/** Reverses a posted entry correction (newest first). Owner only. */
export async function reverseEntryCorrectionAction(input: { correctionId: string; reason: string }): Promise<EntryResult<{ code: string }>> {
  const user = await ownerOrRefuse();
  if (!user) return { ok: false, error: "Only the Owner can reverse a correction." };
  const id = z.string().trim().min(1).max(64).safeParse(input.correctionId);
  if (!id.success) return { ok: false, error: "Unknown correction." };
  const fy = await getCompanyFySettings();
  try {
    const res = await prisma.$transaction(
      (tx) => reverseEntryCorrection(tx, { correctionId: id.data, reason: String(input.reason ?? ""), owner: { id: user.id, role: user.role }, fyStartMonth: fy.fyStartMonth, fyStartDay: fy.fyStartDay }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    revalidateAll();
    return { ok: true, data: { code: res.reversal.correctionCode } };
  } catch (e) {
    return { ok: false, error: message("reverse", e) };
  }
}
