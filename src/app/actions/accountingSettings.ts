"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { requireOwner } from "@/lib/auth/dal";
import { gstRateSchema, paymentAccountSchema } from "@/lib/validation/accounting";

export type SettingsFormState = { error?: string; success?: boolean } | undefined;

export async function createPaymentAccount(
  _prevState: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const user = await requireOwner();

  const parsed = paymentAccountSchema.safeParse({
    name: formData.get("name"),
    method: formData.get("method"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const { name, method } = parsed.data;

  try {
    await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: { code: `PA-${randomUUID()}`, name, type: "ASSET" },
      });
      await tx.paymentAccount.create({
        data: { name, method, accountId: account.id, createdByUserId: user.id },
      });
    });
  } catch (error) {
    console.error("createPaymentAccount failed:", error);
    return { error: "Could not create this payment account. Please try again." };
  }

  revalidatePath("/accounting");
  return { success: true };
}

export async function setPaymentAccountActive(formData: FormData): Promise<void> {
  await requireOwner();

  const id = formData.get("paymentAccountId");
  const nextActive = formData.get("nextActive") === "true";
  if (typeof id !== "string" || !id) return;

  await prisma.paymentAccount.update({ where: { id }, data: { isActive: nextActive } });
  revalidatePath("/accounting");
}

export async function createGstRate(
  _prevState: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  await requireOwner();

  const parsed = gstRateSchema.safeParse({
    label: formData.get("label"),
    ratePercent: formData.get("ratePercent"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  try {
    await prisma.gstRate.create({
      data: { label: parsed.data.label, ratePercent: parsed.data.ratePercent.toFixed(2) },
    });
  } catch (error) {
    console.error("createGstRate failed:", error);
    return { error: "Could not create this GST rate. Please try again." };
  }

  revalidatePath("/accounting");
  return { success: true };
}

export async function setGstRateActive(formData: FormData): Promise<void> {
  await requireOwner();

  const id = formData.get("gstRateId");
  const nextActive = formData.get("nextActive") === "true";
  if (typeof id !== "string" || !id) return;

  await prisma.gstRate.update({ where: { id }, data: { isActive: nextActive } });
  revalidatePath("/accounting");
}
