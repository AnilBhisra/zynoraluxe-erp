import { EmptyState } from "@/components/ui/EmptyState";
import { CancelVoucherForm } from "@/components/accounting/CancelVoucherForm";
import type { VoucherListRow } from "@/lib/accounting/reports";

/**
 * Prisma's `Decimal` instances cannot cross the Server->Client Component
 * boundary (React Server Components can only serialize plain data) — this
 * component is rendered from the client-side TransactionsTab, so `amount`
 * must already be a plain string by the time it gets here. See
 * src/app/(app)/accounting/page.tsx, where listVouchers()'s real Decimal
 * values get converted before being handed to <TransactionsTab>.
 */
export type SerializedVoucherRow = Omit<VoucherListRow, "amount"> & { amount: string };

const TYPE_LABELS: Record<VoucherListRow["voucherType"], string> = {
  PURCHASE: "Purchase",
  SALE: "Sale",
  PAYMENT_GIVEN: "Payment Given",
  PAYMENT_RECEIVED: "Payment Received",
  EXPENSE: "Expense",
  OPENING: "Opening Balance",
  REVERSAL: "Reversal",
  DIAMOND_ISSUE: "Diamond Issue",
  DIAMOND_RECEIPT: "Diamond Receipt",
  JEWELLERY_ISSUE: "Jewellery Issue",
  JEWELLERY_RECEIPT: "Jewellery Receipt",
  SALE_RETURN: "Sale Return",
  CUSTOMER_REFUND: "Customer Refund",
};

function formatMoney(value: string) {
  return `₹${Number(value).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function StatusBadge({ status }: { status: VoucherListRow["status"] }) {
  if (status === "CANCELLED") {
    return (
      <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-400">
        Cancelled
      </span>
    );
  }
  return (
    <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
      Posted
    </span>
  );
}

export function VoucherList({
  vouchers,
  canCancel,
}: {
  vouchers: SerializedVoucherRow[];
  canCancel: boolean;
}) {
  if (vouchers.length === 0) {
    return (
      <EmptyState
        title="No transactions yet"
        description="Entries you save will show up here."
      />
    );
  }

  return (
    <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
      {vouchers.map((v) => (
        <li
          key={v.id}
          className="flex flex-col gap-2 bg-[var(--surface)] p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-zinc-900 dark:text-zinc-50">
                {TYPE_LABELS[v.voucherType]}
              </p>
              <StatusBadge status={v.status} />
            </div>
            <p className="mt-0.5 truncate text-sm text-zinc-500 dark:text-zinc-400">
              {v.voucherNumber} · {v.date.toISOString().slice(0, 10)}
              {v.partyName ? ` · ${v.partyName}` : ""}
              {v.paymentAccountName ? ` · ${v.paymentAccountName}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
              {formatMoney(v.amount)}
            </span>
            {canCancel && v.status === "POSTED" && v.voucherType !== "REVERSAL" ? (
              <CancelVoucherForm voucherId={v.id} voucherNumber={v.voucherNumber} />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
