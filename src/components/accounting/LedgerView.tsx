import { EmptyState } from "@/components/ui/EmptyState";
import type { PartyLedgerRow } from "@/lib/accounting/reports";
import { useFieldId } from "@/lib/utils/useFieldId";

function formatMoney(value: { toFixed: (n: number) => string }) {
  return `₹${Number(value.toFixed(2)).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function LedgerPartyPicker({
  parties,
  selectedPartyId,
}: {
  parties: { id: string; name: string }[];
  selectedPartyId: string;
}) {
  const ledgerPartyId = useFieldId();
  return (
    <form method="GET" action="/accounting" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="tab" value="ledger" />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={ledgerPartyId} className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
          Party
        </label>
        <select
          id={ledgerPartyId}
          name="partyId"
          defaultValue={selectedPartyId}
          className="h-11 w-64 rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
        >
          <option value="">Choose a party…</option>
          {parties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        View
      </button>
    </form>
  );
}

export function LedgerTable({ rows }: { rows: PartyLedgerRow[] }) {
  if (rows.length === 0) {
    return <EmptyState title="No ledger entries" description="This party has no postings yet." />;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="bg-[var(--surface-muted)] text-left text-xs font-medium text-zinc-500 dark:text-zinc-400">
          <tr>
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Description</th>
            <th className="px-4 py-3 text-right">Debit</th>
            <th className="px-4 py-3 text-right">Credit</th>
            <th className="px-4 py-3 text-right">Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border)] bg-[var(--surface)]">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="whitespace-nowrap px-4 py-3 text-zinc-700 dark:text-zinc-300">
                {row.date.toISOString().slice(0, 10)}
              </td>
              <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                {row.voucherNumber} — {row.description}
              </td>
              <td className="px-4 py-3 text-right text-zinc-700 dark:text-zinc-300">
                {row.debit.toNumber() > 0 ? formatMoney(row.debit) : "—"}
              </td>
              <td className="px-4 py-3 text-right text-zinc-700 dark:text-zinc-300">
                {row.credit.toNumber() > 0 ? formatMoney(row.credit) : "—"}
              </td>
              <td className="px-4 py-3 text-right font-medium text-zinc-900 dark:text-zinc-50">
                {formatMoney(row.runningBalance)}
                {row.runningBalance.toNumber() < 0 ? " (we owe)" : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
