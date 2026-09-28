"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { getCompanyFySettings } from "@/lib/accounting/company";
import { requireOwner } from "@/lib/auth/dal";
import { CORRECTION_TRANSACTION_OPTIONS } from "@/lib/corrections/types";
import { prisma } from "@/lib/db/prisma";
import { isIdempotencyConflict } from "@/lib/db/uniqueConflict";
import { PostingError } from "@/lib/jewellery/posting";
import {
  CustodyError,
  custodyPlanFingerprint,
  KIND_LABEL,
  planCustodyOperation,
  postCustodyOperation,
  reverseCustodyEntry,
  type CustodyOperationInput,
} from "@/lib/jewellery/karigarCustody";

const TRANSACTION_TIMEOUT_CODE = "P2028";
const TIMEOUT_MESSAGE = "This took longer than the database allows, so it was rolled back and nothing was saved. Check the Karigar balance before trying again.";

export type CustodyPreview = {
  kindLabel: string;
  karigarName: string;
  jobCode: string | null;
  purityDisplayName: string;
  finenessPercent: string;
  grossWeight: string;
  fineWeight: string;
  costValue: string;
  isFull: boolean;
  custodyBefore: { gross: string; fine: string; cost: string };
  custodyAfter: { gross: string; fine: string; cost: string };
  stockBefore: { gross: string; cost: string } | null;
  stockAfter: { gross: string; cost: string } | null;
  jobBefore: { pendingFine: string; wip: string } | null;
  jobAfter: { pendingFine: string; wip: string } | null;
  postsVoucher: boolean;
  fingerprint: string;
};

export type CustodyFormState = { error?: string; success?: boolean; code?: string; replayed?: boolean; preview?: CustodyPreview } | undefined;

function logFailure(operation: string, error: unknown): string | undefined {
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
  console.error("karigar custody failed", {
    operation,
    errorName: error instanceof Error ? error.name : typeof error,
    prismaCode: prismaCode ?? null,
    message: error instanceof Error ? error.message.slice(0, 300) : undefined,
  });
  return prismaCode;
}

const formSchema = z.object({
  kind: z.enum(["ISSUE_TO_KARIGAR", "RETURN_TO_STOCK", "ALLOCATE_TO_JOB", "RELEASE_FROM_JOB"]),
  karigarId: z.string().trim().min(1, "Choose a Karigar."),
  purityId: z.string().trim().optional(),
  jobId: z.string().trim().optional(),
  grossWeight: z.string().trim().max(20).optional(),
  all: z.boolean(),
  entryDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date."),
  reason: z.string().trim().min(3, "Give the reason.").max(500),
  reference: z.string().trim().max(120).optional(),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
  previewFingerprint: z.string().max(4000).optional(),
});

function readForm(formData: FormData) {
  const opt = (name: string) => {
    const v = formData.get(name);
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  return formSchema.safeParse({
    kind: formData.get("kind"),
    karigarId: formData.get("karigarId"),
    purityId: opt("purityId"),
    jobId: opt("jobId"),
    grossWeight: opt("grossWeight"),
    all: formData.get("all") === "1",
    entryDate: formData.get("entryDate"),
    reason: formData.get("reason"),
    reference: opt("reference"),
    idempotencyKey: opt("idempotencyKey"),
    previewFingerprint: opt("previewFingerprint"),
  });
}

function toInput(data: z.infer<typeof formSchema>): CustodyOperationInput {
  return {
    kind: data.kind,
    karigarId: data.karigarId,
    purityId: data.purityId ?? null,
    jobId: data.jobId ?? null,
    grossWeight: data.grossWeight ?? null,
    all: data.all,
    entryDate: new Date(`${data.entryDate}T00:00:00.000Z`),
    reason: data.reason,
    reference: data.reference ?? null,
  };
}

function revalidateAll() {
  revalidatePath("/jewellery-jobs");
  revalidatePath("/accounting");
  revalidatePath("/dashboard");
}

const userMessage = (error: unknown) => (error instanceof CustodyError || error instanceof PostingError ? error.message : null);

/** Shows exactly what would change, writing nothing. Owner only. */
export async function previewCustodyAction(_prev: CustodyFormState, formData: FormData): Promise<CustodyFormState> {
  await requireOwner();
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  try {
    const plan = await planCustodyOperation(prisma, toInput(parsed.data));
    const w = (p: { gross: { toFixed: (n: number) => string }; fine: { toFixed: (n: number) => string }; cost: { toFixed: (n: number) => string } }) => ({
      gross: p.gross.toFixed(3),
      fine: p.fine.toFixed(3),
      cost: p.cost.toFixed(2),
    });
    return {
      preview: {
        kindLabel: KIND_LABEL[plan.kind],
        karigarName: plan.karigarName,
        jobCode: plan.jobCode,
        purityDisplayName: plan.purityDisplayName,
        finenessPercent: plan.finenessPercentSnapshot.toFixed(3),
        grossWeight: plan.grossWeight.toFixed(3),
        fineWeight: plan.fineWeight.toFixed(3),
        costValue: plan.costValue.toFixed(2),
        isFull: plan.isFull,
        custodyBefore: w(plan.custodyBefore),
        custodyAfter: w(plan.custodyAfter),
        stockBefore: plan.stockBefore ? { gross: plan.stockBefore.gross.toFixed(3), cost: plan.stockBefore.cost.toFixed(2) } : null,
        stockAfter: plan.stockAfter ? { gross: plan.stockAfter.gross.toFixed(3), cost: plan.stockAfter.cost.toFixed(2) } : null,
        jobBefore: plan.jobBefore ? { pendingFine: plan.jobBefore.pendingFine.toFixed(3), wip: plan.jobBefore.wip.toFixed(2) } : null,
        jobAfter: plan.jobAfter ? { pendingFine: plan.jobAfter.pendingFine.toFixed(3), wip: plan.jobAfter.wip.toFixed(2) } : null,
        postsVoucher: plan.postsVoucher,
        fingerprint: custodyPlanFingerprint(plan),
      },
    };
  } catch (error) {
    const message = userMessage(error);
    if (message) return { error: message };
    logFailure("preview", error);
    return { error: "Could not prepare the preview. Please try again." };
  }
}

/** Posts the operation. Owner only, atomic, duplicate-submit safe, refuses a stale preview. */
export async function postCustodyAction(_prev: CustodyFormState, formData: FormData): Promise<CustodyFormState> {
  const owner = await requireOwner();
  const parsed = readForm(formData);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  const { idempotencyKey, previewFingerprint } = parsed.data;
  if (!idempotencyKey) return { error: "Missing submission key — reload the page and try again." };
  if (!previewFingerprint) return { error: "Preview the entry first, then confirm it." };

  const fy = await getCompanyFySettings();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        postCustodyOperation(tx, {
          ...toInput(parsed.data),
          idempotencyKey,
          expectedFingerprint: previewFingerprint,
          owner: { id: owner.id, role: owner.role },
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
        }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    revalidateAll();
    return { success: true, code: result.entry.entryCode, replayed: result.replayed };
  } catch (error) {
    if (isIdempotencyConflict(error)) {
      const existing = await prisma.karigarMetalCustodyEntry.findUnique({ where: { idempotencyKey } });
      if (existing) return { success: true, code: existing.entryCode, replayed: true };
    }
    const message = userMessage(error);
    if (message) return { error: message };
    const code = logFailure("post", error);
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
    return { error: "Could not post this entry. Nothing was saved. Please try again." };
  }
}

const reverseSchema = z.object({
  entryId: z.string().trim().min(1),
  reason: z.string().trim().min(10, "Give the reason for reversing (at least 10 characters).").max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
});

/** Reverses one entry. Owner only; every dependency is re-checked inside the transaction. */
export async function reverseCustodyAction(_prev: CustodyFormState, formData: FormData): Promise<CustodyFormState> {
  const owner = await requireOwner();
  const parsed = reverseSchema.safeParse({
    entryId: formData.get("entryId"),
    reason: formData.get("reason"),
    idempotencyKey: formData.get("idempotencyKey") || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Please check the form." };

  const fy = await getCompanyFySettings();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        reverseCustodyEntry(tx, {
          entryId: parsed.data.entryId,
          reason: parsed.data.reason,
          idempotencyKey: parsed.data.idempotencyKey ?? null,
          owner: { id: owner.id, role: owner.role },
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
        }),
      CORRECTION_TRANSACTION_OPTIONS
    );
    revalidateAll();
    return { success: true, code: result.reversal.entryCode };
  } catch (error) {
    if (isIdempotencyConflict(error) || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
      const existing = await prisma.karigarMetalCustodyEntry.findUnique({ where: { reversalOfEntryId: parsed.data.entryId } });
      if (existing) return { success: true, code: existing.entryCode, replayed: true };
    }
    const message = userMessage(error);
    if (message) return { error: message };
    const code = logFailure("reverse", error);
    if (code === TRANSACTION_TIMEOUT_CODE) return { error: TIMEOUT_MESSAGE };
    return { error: "Could not reverse this entry. Nothing was changed. Please try again." };
  }
}
