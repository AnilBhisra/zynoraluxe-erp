"use server";

import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db/prisma";
import { requireOwner, requireUser } from "@/lib/auth/dal";
import { partySchema } from "@/lib/validation/parties";
import { postOpeningBalance } from "@/lib/accounting/posting";
import { getCompanyFySettings } from "@/lib/accounting/company";

export type PartyFormState = { error?: string; success?: boolean } | undefined;

export async function createParty(
  _prevState: PartyFormState,
  formData: FormData
): Promise<PartyFormState> {
  const user = await requireUser();

  const parsed = partySchema.safeParse({
    name: formData.get("name"),
    type: formData.get("type"),
    phone: formData.get("phone") ?? "",
    email: formData.get("email") ?? "",
    gstin: formData.get("gstin") ?? "",
    address: formData.get("address") ?? "",
    state: formData.get("state") ?? "",
    stateCode: formData.get("stateCode") ?? "",
    openingBalance: formData.get("openingBalance") || "0",
    openingBalanceType: formData.get("openingBalanceType") || "RECEIVABLE",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const data = parsed.data;

  try {
    await prisma.$transaction(async (tx) => {
      const party = await tx.party.create({
        data: {
          name: data.name,
          type: data.type,
          phone: data.phone || null,
          email: data.email || null,
          gstin: data.gstin || null,
          address: data.address || null,
          state: data.state || null,
          stateCode: data.stateCode || null,
          openingBalance: data.openingBalance.toFixed(2),
          openingBalanceType: data.openingBalanceType,
          createdByUserId: user.id,
          updatedByUserId: user.id,
        },
      });

      if (data.openingBalance > 0) {
        const fy = await getCompanyFySettings();
        const today = new Date();
        await postOpeningBalance(tx, {
          date: today,
          fyStartMonth: fy.fyStartMonth,
          fyStartDay: fy.fyStartDay,
          currencyCode: fy.defaultCurrency,
          exchangeRate: 1,
          createdByUserId: user.id,
          partyId: party.id,
          amount: data.openingBalance,
          openingBalanceType: data.openingBalanceType,
          note: "Opening balance at party creation",
        });
      }
    });
  } catch (error) {
    console.error("createParty failed:", error);
    return { error: "Could not save this party. Please try again." };
  }

  revalidatePath("/accounting");
  revalidatePath("/dashboard");
  return { success: true };
}

/**
 * Editing a Party never touches Voucher/JournalEntry/InvoiceLine rows —
 * those only ever reference `partyId`, never a party's name/type/GSTIN/
 * state directly, and a voucher's own `gstTreatment`/amounts are a
 * snapshot taken at posting time (see src/lib/accounting/posting.ts). So
 * by construction, editing a party here can never rewrite historical
 * accounting — there is nothing in this function that could.
 *
 * Field-level authorization (enforced here, not just by which inputs the
 * form renders): Owner may change every field below, including party type
 * (guarded separately when the party already has vouchers) and
 * active/inactive status. Staff may only change phone/email/address — an
 * attempt to change anything else is rejected outright, and Staff cannot
 * touch an archived party at all. Opening balance is never accepted here
 * at any role — see partySchema.omit(...) below; the only way to correct
 * a wrong opening balance is to cancel the original OPENING voucher
 * (Owner-only reversal, from the Transactions tab), which posts a
 * balanced, audited correction instead of silently overwriting a number.
 */
export async function updateParty(
  _prevState: PartyFormState,
  formData: FormData
): Promise<PartyFormState> {
  const user = await requireUser();
  const isOwner = user.role === "OWNER";

  const partyId = formData.get("partyId");
  if (typeof partyId !== "string" || !partyId) {
    return { error: "Party not found." };
  }

  const existing = await prisma.party.findUnique({ where: { id: partyId } });
  if (!existing) {
    return { error: "Party not found." };
  }

  if (!isOwner && !existing.isActive) {
    return { error: "This party is archived. Ask the Owner to make changes." };
  }

  const parsed = partySchema.omit({ openingBalance: true, openingBalanceType: true }).safeParse({
    name: formData.get("name"),
    type: formData.get("type"),
    phone: formData.get("phone") ?? "",
    email: formData.get("email") ?? "",
    gstin: formData.get("gstin") ?? "",
    address: formData.get("address") ?? "",
    state: formData.get("state") ?? "",
    stateCode: formData.get("stateCode") ?? "",
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check the form." };
  }

  const data = parsed.data;

  if (!isOwner) {
    const restrictedFieldChanged =
      data.name !== existing.name ||
      data.type !== existing.type ||
      (data.gstin || null) !== existing.gstin ||
      (data.state || null) !== existing.state ||
      (data.stateCode || null) !== existing.stateCode;
    if (restrictedFieldChanged) {
      return { error: "Only the Owner can change name, party type, GSTIN, or state details." };
    }
  }

  if (isOwner && data.type !== existing.type) {
    const voucherCount = await prisma.voucher.count({ where: { partyId } });
    if (voucherCount > 0 && formData.get("confirmTypeChange") !== "true") {
      return {
        error: `This party has ${voucherCount} existing transaction(s). Confirm the type change to continue — past transactions will not be altered.`,
      };
    }
  }

  let nextIsActive = existing.isActive;
  if (isOwner) {
    const submittedIsActive = formData.get("isActive");
    if (submittedIsActive !== null) {
      nextIsActive = submittedIsActive === "true";
    }
  }

  try {
    await prisma.party.update({
      where: { id: partyId },
      data: {
        name: data.name,
        type: data.type,
        phone: data.phone || null,
        email: data.email || null,
        gstin: data.gstin || null,
        address: data.address || null,
        state: data.state || null,
        stateCode: data.stateCode || null,
        isActive: nextIsActive,
        updatedByUserId: user.id,
      },
    });
  } catch (error) {
    console.error("updateParty failed:", error);
    return { error: "Could not update this party. Please try again." };
  }

  revalidatePath("/accounting");
  revalidatePath("/dashboard");
  return { success: true };
}

/** Archive/reactivate — Owner-only (same reasoning as the active-status
 * field in updateParty above). Parties with transactions are never
 * permanently deleted, matching the master plan's rule. */
export async function setPartyActive(formData: FormData): Promise<void> {
  const user = await requireOwner();

  const partyId = formData.get("partyId");
  const nextActive = formData.get("nextActive") === "true";
  if (typeof partyId !== "string" || !partyId) return;

  await prisma.party.update({
    where: { id: partyId },
    data: { isActive: nextActive, updatedByUserId: user.id },
  });

  revalidatePath("/accounting");
}
