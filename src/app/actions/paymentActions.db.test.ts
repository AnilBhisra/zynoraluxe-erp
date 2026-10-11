/**
 * Payment Given / Payment Received through the real Server Actions, on the
 * disposable scratch database only (shared guard). Only auth and Next's
 * revalidation are stubbed; posting, idempotency and the database are real.
 *
 * The first test is the reported defect: the payment forms stay open after a
 * save and reuse the same submission key, so a SECOND payment typed into the
 * still-open form was answered "saved as <the first voucher>" while nothing
 * was posted — the payable / receivable never moved.
 */
import "dotenv/config";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ user: { id: "", role: "OWNER" as "OWNER" | "STAFF", name: "Owner", email: "owner@test" } }));
vi.mock("@/lib/auth/dal", () => ({
  requireUser: async () => auth.user,
  requireOwner: async () => {
    if (auth.user.role !== "OWNER") throw new Error("REDIRECT:/unauthorized");
    return auth.user;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

import { Decimal } from "@/lib/accounting/money";
import { postPurchase, postSale } from "@/lib/accounting/posting";
import { prisma } from "@/lib/db/prisma";
import { cancelVoucherAction, createPaymentGiven, createPaymentReceived } from "./vouchers";
import { assertDisposableTestDb } from "../../../test/setup/dbGuard";

const FY = { fyStartMonth: 4, fyStartDay: 1 };
const DATE = "2026-10-05";
let ownerId: string;
let staffId: string;
let cashId: string;
let bankId: string;
let seq = 0;
const key = (label: string) => `pay-act-${label}-${Date.now()}-${++seq}`;

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function partyBalance(partyId: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ net: string | null }[]>(
    `select sum(j.debit - j.credit)::text net from journal_entries j join accounts a on a.id = j."accountId" where a.code in ('1100','2000') and j."partyId" = $1`,
    partyId
  );
  return new Decimal(rows[0]?.net ?? 0).toFixed(2);
}

async function accountBalance(paymentAccountId: string): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<{ net: string | null }[]>(
    `select sum(j.debit - j.credit)::text net from journal_entries j join payment_accounts pa on pa."accountId" = j."accountId" where pa.id = $1`,
    paymentAccountId
  );
  return new Decimal(rows[0]?.net ?? 0).toFixed(2);
}

async function newParty(name: string, type: "CUSTOMER" | "SUPPLIER" | "KARIGAR") {
  return (await prisma.party.create({ data: { name: `${name} ${Date.now()}-${++seq}`, type, createdByUserId: ownerId } })).id;
}

async function supplierWithPurchase(amount: string) {
  const partyId = await newParty("PA Supplier", "SUPPLIER");
  await prisma.$transaction((tx) =>
    postPurchase(tx, {
      date: new Date(`${DATE}T00:00:00.000Z`),
      ...FY,
      currencyCode: "INR",
      exchangeRate: 1,
      createdByUserId: ownerId,
      partyId,
      gstTreatment: "NONE",
      lines: [{ description: "Goods", quantity: 1, unit: "PCS", rate: amount, gstRatePercent: 0, taxType: "EXCLUSIVE" }],
    })
  );
  return partyId;
}

beforeAll(async () => {
  const [who] = await prisma.$queryRawUnsafe<{ db: string; usr: string; port: number }[]>(
    "select current_database() db, current_user usr, inet_server_port() port"
  );
  assertDisposableTestDb(who);
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  ownerId = (await prisma.user.findFirstOrThrow({ where: { role: "OWNER" } })).id;
  staffId = (await prisma.user.findFirstOrThrow({ where: { role: "STAFF" } })).id;
  cashId = (await prisma.paymentAccount.findFirstOrThrow({ where: { method: "CASH", isActive: true } })).id;
  bankId = (await prisma.paymentAccount.findFirstOrThrow({ where: { method: "BANK", isActive: true } })).id;
}, 90_000);

beforeEach(() => {
  auth.user = { id: ownerId, role: "OWNER", name: "Owner", email: "owner@test" };
});

afterAll(async () => {
  const { CLEAR_BUSINESS_DATA_SQL } = await import("../../../test/setup/businessTables");
  await prisma.$executeRawUnsafe(CLEAR_BUSINESS_DATA_SQL);
  await prisma.$disconnect();
});

describe("reported defect: a second payment in a still-open form", () => {
  it("is posted or clearly refused — never answered 'saved' while nothing changes", async () => {
    const supplier = await supplierWithPurchase("100000");
    const formKey = key("open-form");
    const first = await createPaymentGiven(undefined, fd({ date: DATE, partyId: supplier, paymentAccountId: cashId, amount: "40000", idempotencyKey: formKey }));
    expect(first?.success).toBe(true);
    expect(await partyBalance(supplier)).toBe("-60000.00");

    // Same form, same key (it was never reopened), a different payment.
    const second = await createPaymentGiven(undefined, fd({ date: DATE, partyId: supplier, paymentAccountId: cashId, amount: "60000", idempotencyKey: formKey }));
    const balanceAfter = await partyBalance(supplier);
    const silentlyDropped = second?.success === true && second.voucherNumber === first?.voucherNumber && balanceAfter === "-60000.00";
    expect(silentlyDropped).toBe(false);
    if (second?.success) {
      expect(balanceAfter).toBe("0.00");
    } else {
      expect(second?.error).toMatch(/nothing was saved/i);
      expect(balanceAfter).toBe("-60000.00");
    }
  });
});

describe("Payment Given / Received through the actions", () => {
  it("double-click: the identical submission twice posts one voucher", async () => {
    const supplier = await supplierWithPurchase("5000");
    const k = key("double");
    const form = { date: DATE, partyId: supplier, paymentAccountId: bankId, amount: "5000", idempotencyKey: k };
    const a = await createPaymentGiven(undefined, fd(form));
    const b = await createPaymentGiven(undefined, fd(form));
    expect(a?.success).toBe(true);
    expect(b?.success).toBe(true);
    expect(b?.voucherNumber).toBe(a?.voucherNumber);
    expect(await prisma.voucher.count({ where: { partyId: supplier, voucherType: "PAYMENT_GIVEN" } })).toBe(1);
    expect(await partyBalance(supplier)).toBe("0.00");
  });

  it("simultaneous: two identical submissions at once post exactly once, with no numbering gap", async () => {
    const customer = await newParty("PA Customer", "CUSTOMER");
    await prisma.$transaction((tx) =>
      postSale(tx, {
        date: new Date(`${DATE}T00:00:00.000Z`),
        ...FY,
        currencyCode: "INR",
        exchangeRate: 1,
        createdByUserId: ownerId,
        partyId: customer,
        gstTreatment: "NONE",
        lines: [{ description: "Ring", quantity: 1, unit: "PCS", rate: "8150", gstRatePercent: 0, taxType: "EXCLUSIVE" }],
      })
    );
    const before = await prisma.voucherSequence.findUnique({ where: { voucherType_financialYearLabel: { voucherType: "PAYMENT_RECEIVED", financialYearLabel: "2026-27" } } });
    const k = key("race");
    const form = { date: DATE, partyId: customer, paymentAccountId: bankId, amount: "8150", idempotencyKey: k };
    const [a, b] = await Promise.all([createPaymentReceived(undefined, fd(form)), createPaymentReceived(undefined, fd(form))]);
    expect(a?.success && b?.success).toBe(true);
    expect(a?.voucherNumber).toBe(b?.voucherNumber);
    expect(await prisma.voucher.count({ where: { partyId: customer, voucherType: "PAYMENT_RECEIVED" } })).toBe(1);
    const after = await prisma.voucherSequence.findUniqueOrThrow({ where: { voucherType_financialYearLabel: { voucherType: "PAYMENT_RECEIVED", financialYearLabel: "2026-27" } } });
    expect(after.lastNumber - (before?.lastNumber ?? 0)).toBe(1);
    expect(await partyBalance(customer)).toBe("0.00");
  });

  it("Staff can record payments; cancelling one is Owner-only and restores both balances", async () => {
    const supplier = await supplierWithPurchase("12000");
    const cashBefore = await accountBalance(cashId);
    auth.user = { id: staffId, role: "STAFF", name: "Staff", email: "staff@test" };
    const paid = await createPaymentGiven(undefined, fd({ date: DATE, partyId: supplier, paymentAccountId: cashId, amount: "12000", idempotencyKey: key("staff") }));
    expect(paid?.success).toBe(true);
    expect(await partyBalance(supplier)).toBe("0.00");
    expect(new Decimal(await accountBalance(cashId)).minus(cashBefore).toFixed(2)).toBe("-12000.00");
    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { voucherNumber: paid!.voucherNumber! } });
    await expect(cancelVoucherAction(undefined, fd({ voucherId: voucher.id, cancellationReason: "Entered twice" }))).rejects.toThrow(/unauthorized/);

    auth.user = { id: ownerId, role: "OWNER", name: "Owner", email: "owner@test" };
    const cancelled = await cancelVoucherAction(undefined, fd({ voucherId: voucher.id, cancellationReason: "Entered twice" }));
    expect(cancelled?.success).toBe(true);
    expect(await partyBalance(supplier)).toBe("-12000.00");
    expect(await accountBalance(cashId)).toBe(cashBefore);
    const again = await cancelVoucherAction(undefined, fd({ voucherId: voucher.id, cancellationReason: "Entered twice" }));
    expect(again?.error).toMatch(/already been cancelled/);
    expect(await prisma.voucher.count({ where: { reversalOfVoucherId: voucher.id } })).toBe(1);
  });
});
