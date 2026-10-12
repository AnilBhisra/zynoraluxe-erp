"use client";

import { useState } from "react";

import type { PartyOption } from "@/components/accounting/PartySelect";

const CURRENCIES = ["INR", "USD", "EUR", "GBP", "AUD", "CAD", "AED", "SGD"];
const INPUT =
  "h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

/**
 * Shown only for a marketplace / clearing party (Etsy, Amazon, PayPal, COD
 * courier …): the sale posts to 1150 Marketplace Clearing and is paid later
 * through Accounting → Settlements. The INR prices above stay the booked
 * amounts; the marketplace amount keeps the original currency.
 */
export function ClearingSaleFields({ party }: { party: PartyOption | null }) {
  const [currency, setCurrency] = useState("INR");
  if (!party?.clearingEnabled) return null;
  return (
    <div className="col-span-full flex flex-col gap-3 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900 dark:border-sky-900 dark:bg-sky-950/30 dark:text-sky-200" data-testid="clearing-sale-fields">
      <p>
        <strong>{party.name}</strong> is a marketplace / clearing party: this sale is owed by {party.name} and is paid later by a payout (Accounting → Settlements). It is never &ldquo;Paid now&rdquo;.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-medium">
          Marketplace currency
          <select name="clearingCurrency" value={currency} onChange={(e) => setCurrency(e.target.value)} className={INPUT}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        {currency !== "INR" ? (
          <label className="flex flex-col gap-1 text-xs font-medium">
            Sale amount in {currency} (as the marketplace shows it)
            <input name="clearingAmount" inputMode="decimal" required className={INPUT} placeholder="0.00" />
          </label>
        ) : null}
      </div>
    </div>
  );
}
