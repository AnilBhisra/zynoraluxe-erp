import Link from "next/link";

import { setPartyActive } from "@/app/actions/parties";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { classifyPartyBalance, type PartyBalanceKind } from "@/lib/accounting/partyBalance";
import type { PartyBalanceRow } from "@/lib/accounting/reports";

const BADGE_TONE: Record<PartyBalanceKind, string> = {
  SETTLED: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  RECEIVABLE: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  PAYABLE: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  ADVANCE_PAID: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  CUSTOMER_CREDIT: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
};

function BalanceBadge({ type, balance }: { type: PartyBalanceRow["type"]; balance: PartyBalanceRow["balance"] }) {
  const classified = classifyPartyBalance(type, balance.toFixed(2));
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-medium ${BADGE_TONE[classified.kind]}`}
      title={classified.explanation}
      data-testid="party-balance-badge"
    >
      {classified.label}
    </span>
  );
}

export function PartyList({
  parties,
  search,
  role,
}: {
  parties: PartyBalanceRow[];
  search: string;
  role: "OWNER" | "STAFF";
}) {
  const isOwner = role === "OWNER";
  if (parties.length === 0) {
    return (
      <EmptyState
        title={search ? "No parties match your search" : "No parties yet"}
        description={
          search
            ? "Try a different name, or clear the search."
            : "Add your first Customer, Supplier or Karigar below."
        }
      />
    );
  }

  return (
    <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
      {parties.map((party) => (
        <li
          key={party.partyId}
          className="flex flex-col gap-3 bg-[var(--surface)] p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">
                {party.name}
              </p>
              <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                {party.type}
              </span>
              {!party.isActive ? (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  Inactive
                </span>
              ) : null}
            </div>
            <div className="mt-1">
              <BalanceBadge type={party.type} balance={party.balance} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href={`/accounting?tab=ledger&partyId=${party.partyId}`}
              className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
            >
              View ledger
            </Link>
            {isOwner || party.isActive ? (
              // A plain <a>, not next/link: a client-side soft navigation
              // that only changes searchParams on this same dynamic route
              // was observed (via live browser testing) to sometimes
              // briefly render the previous view — harmless for read-only
              // navigation, but this leads into a stateful edit form where
              // that could look like lost input. A full navigation here is
              // the reliable choice; matches the plain <a> already used for
              // the tab links on this same page (see TabLink in page.tsx).
              <a
                href={`/accounting?tab=parties&editPartyId=${party.partyId}`}
                className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
              >
                Edit
              </a>
            ) : null}
            {isOwner ? (
              <form action={setPartyActive}>
                <input type="hidden" name="partyId" value={party.partyId} />
                <input type="hidden" name="nextActive" value={(!party.isActive).toString()} />
                <Button type="submit" variant="secondary" size="md">
                  {party.isActive ? "Archive" : "Reactivate"}
                </Button>
              </form>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
