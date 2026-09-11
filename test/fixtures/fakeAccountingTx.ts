import { SYSTEM_ACCOUNT_CODES, DEFAULT_PAYMENT_ACCOUNTS } from "@/lib/accounting/accounts";

/**
 * A minimal in-memory stand-in for Prisma's transaction client, covering
 * only what src/lib/accounting/posting.ts actually calls. This lets the
 * posting engine's tests assert exact, real balanced-debit/credit behaviour
 * without touching a database — while still exercising the real posting.ts
 * code path (findUnique/create/createMany/update/upsert), not a mock of the
 * posting functions themselves.
 */

type Row = Record<string, unknown>;

export function createFakeAccountingTx() {
  const accounts = new Map<string, Row>(); // keyed by code
  const paymentAccounts = new Map<string, Row>(); // keyed by id
  const vouchers = new Map<string, Row>(); // keyed by id
  const journalEntries: Row[] = [];
  const invoiceLines: Row[] = [];
  const sequences = new Map<string, Row>(); // keyed by `${type}::${fy}`

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${++counter}`;

  function seedAccount(code: string, name: string, type: string) {
    const row = { id: nextId("acct"), code, name, type, isSystem: true, isActive: true };
    accounts.set(code, row);
    return row;
  }

  // Seed the same Chart of Accounts prisma/seed.ts creates in the real DB.
  for (const [key, code] of Object.entries(SYSTEM_ACCOUNT_CODES)) {
    seedAccount(code, key, "ASSET");
  }
  const paymentAccountIdByMethod = new Map<string, string>();
  for (const pa of DEFAULT_PAYMENT_ACCOUNTS) {
    const account = seedAccount(pa.code, pa.name, "ASSET");
    const paymentAccountRow = {
      id: nextId("pay"),
      name: pa.name,
      method: pa.method,
      accountId: account.id,
      account: { code: account.code },
      isActive: true,
    };
    paymentAccounts.set(paymentAccountRow.id, paymentAccountRow);
    paymentAccountIdByMethod.set(pa.method, paymentAccountRow.id);
  }

  const tx = {
    account: {
      findUnique: async ({ where }: { where: { code: string } }) =>
        accounts.get(where.code) ?? null,
    },
    paymentAccount: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        paymentAccounts.get(where.id) ?? null,
    },
    voucherSequence: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { voucherType_financialYearLabel: { voucherType: string; financialYearLabel: string } };
        create: Row;
        update: { lastNumber: { increment: number } };
      }) => {
        const { voucherType, financialYearLabel } = where.voucherType_financialYearLabel;
        const key = `${voucherType}::${financialYearLabel}`;
        const existing = sequences.get(key);
        if (existing) {
          existing.lastNumber = (existing.lastNumber as number) + update.lastNumber.increment;
          return existing;
        }
        const row = { id: nextId("seq"), voucherType, financialYearLabel, ...create };
        sequences.set(key, row);
        return row;
      },
    },
    voucher: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: nextId("v"), status: "POSTED", ...data };
        vouchers.set(row.id as string, row);
        return row;
      },
      findUnique: async ({
        where,
        include,
      }: {
        where: { id: string };
        include?: { journalEntries?: boolean };
      }) => {
        const row = vouchers.get(where.id);
        if (!row) return null;
        if (include?.journalEntries) {
          return { ...row, journalEntries: journalEntries.filter((e) => e.voucherId === where.id) };
        }
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const row = vouchers.get(where.id);
        if (!row) throw new Error("voucher not found");
        Object.assign(row, data);
        return row;
      },
    },
    journalEntry: {
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) journalEntries.push({ id: nextId("je"), ...d });
        return { count: data.length };
      },
    },
    invoiceLine: {
      createMany: async ({ data }: { data: Row[] }) => {
        for (const d of data) invoiceLines.push({ id: nextId("il"), ...d });
        return { count: data.length };
      },
    },
  };

  return {
    tx,
    state: { accounts, paymentAccounts, vouchers, journalEntries, invoiceLines, sequences },
    paymentAccountIdByMethod,
  };
}

export type FakeAccountingTx = ReturnType<typeof createFakeAccountingTx>;
