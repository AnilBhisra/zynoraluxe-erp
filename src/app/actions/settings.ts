"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { requireOwner } from "@/lib/auth/dal";
import { hashPassword } from "@/lib/auth/password";
import {
  companySettingsSchema,
  createStaffSchema,
} from "@/lib/validation/settings";

export type SettingsFormState = { error?: string; success?: boolean } | undefined;

const COMPANY_SETTINGS_ID = "default";

export async function updateCompanySettings(
  _prevState: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  const owner = await requireOwner();

  const parsed = companySettingsSchema.safeParse({
    companyName: formData.get("companyName"),
    // The "More details" fields don't exist in the DOM at all while that
    // section is collapsed, so FormData.get() returns null rather than "" —
    // normalize to "" to match the schema's optional-string branch.
    address: formData.get("address") ?? "",
    phone: formData.get("phone") ?? "",
    email: formData.get("email") ?? "",
    gstNumber: formData.get("gstNumber") ?? "",
    companyStateCode: formData.get("companyStateCode") ?? "",
    defaultCurrency: formData.get("defaultCurrency"),
    financialYearStartMonth: formData.get("financialYearStartMonth"),
    financialYearStartDay: formData.get("financialYearStartDay"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const data = parsed.data;

  await prisma.companySettings.upsert({
    where: { id: COMPANY_SETTINGS_ID },
    create: {
      id: COMPANY_SETTINGS_ID,
      companyName: data.companyName,
      address: data.address || null,
      phone: data.phone || null,
      email: data.email || null,
      gstNumber: data.gstNumber || null,
      companyStateCode: data.companyStateCode || null,
      defaultCurrency: data.defaultCurrency,
      financialYearStartMonth: data.financialYearStartMonth,
      financialYearStartDay: data.financialYearStartDay,
      updatedByUserId: owner.id,
    },
    update: {
      companyName: data.companyName,
      address: data.address || null,
      phone: data.phone || null,
      email: data.email || null,
      gstNumber: data.gstNumber || null,
      companyStateCode: data.companyStateCode || null,
      defaultCurrency: data.defaultCurrency,
      financialYearStartMonth: data.financialYearStartMonth,
      financialYearStartDay: data.financialYearStartDay,
      updatedByUserId: owner.id,
    },
  });

  revalidatePath("/settings");
  return { success: true };
}

export async function createStaffAccount(
  _prevState: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  await requireOwner();

  const parsed = createStaffSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with this email already exists." };
  }

  const passwordHash = await hashPassword(password);

  await prisma.user.create({
    data: { name, email, passwordHash, role: "STAFF" },
  });

  revalidatePath("/settings");
  return { success: true };
}

export async function setStaffActive(formData: FormData): Promise<void> {
  await requireOwner();

  const userId = formData.get("userId");
  const nextActive = formData.get("nextActive") === "true";

  if (typeof userId !== "string" || !userId) {
    return;
  }

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target || target.role !== "STAFF") {
    return;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { isActive: nextActive },
  });

  revalidatePath("/settings");
}

export async function resetStaffPassword(
  _prevState: SettingsFormState,
  formData: FormData
): Promise<SettingsFormState> {
  await requireOwner();

  const userId = formData.get("userId");
  const newPassword = formData.get("newPassword");

  if (typeof userId !== "string" || !userId) {
    return { error: "Invalid user selection." };
  }

  if (typeof newPassword !== "string" || newPassword.length < 8) {
    return { error: "New password must be at least 8 characters long." };
  }

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target || target.role !== "STAFF") {
    return { error: "Staff account not found." };
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  revalidatePath("/settings");
  return { success: true };
}
