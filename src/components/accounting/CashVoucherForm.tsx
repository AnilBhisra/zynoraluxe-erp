"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import type { VoucherFormState } from "@/app/actions/vouchers";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { PartySelect, type PartyOption } from "@/components/accounting/PartySelect";
import { indiaToday } from "@/lib/accounting/financialYear";
import { classifyPartyBalance, formatRupees, fromPaise, paymentEffect, toPaise } from "@/lib/accounting/partyBalance";
import { useFieldId } from "@/lib/utils/useFieldId";

/** `balance` is the account's ledger balance — only sent to the Owner (null/absent for Staff). */
export type PaymentAccountOption = { id: string; name: string; method: string; balance?: string | null };

const LABELS: Record<"PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "EXPENSE", string> = {
  PAYMENT_GIVEN: "Payment Given",
  PAYMENT_RECEIVED: "Payment Received",
  EXPENSE: "Expense",
};

function newSubmissionKey() {
  return crypto.randomUUID();
}

export function CashVoucherForm({
  voucherType,
  action,
  parties,
  paymentAccounts,
  onDone,
}: {
  voucherType: "PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "EXPENSE";
  action: (state: VoucherFormState, formData: FormData) => Promise<VoucherFormState>;
  parties: PartyOption[];
  paymentAccounts: PaymentAccountOption[];
  onDone?: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, undefined);
  const [showMore, setShowMore] = useState(false);
  const [confirmOutsideFy, setConfirmOutsideFy] = useState(false);
  // One key per entry. A double-click or retry of the SAME entry re-sends it
  // and is answered with the voucher it already saved; once an entry is saved
  // the form starts a new key, so the next payment typed into this still-open
  // form posts as its own voucher (it used to be swallowed as a "repeat").
  const [idempotencyKey, setIdempotencyKey] = useState(newSubmissionKey);
  const [partyId, setPartyId] = useState("");
  const [paymentAccountId, setPaymentAccountId] = useState("");
  const [amount, setAmount] = useState("");
  const partyRequired = voucherType !== "EXPENSE";
  const label = LABELS[voucherType];
  const paymentAccountFieldId = useFieldId();

  // Each saved result is handled exactly once. `onDone` is a new function on
  // every parent render, so depending on it would re-run this after every
  // refresh it triggers — an endless refresh loop.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });
  const handled = useRef<VoucherFormState>(undefined);
  useEffect(() => {
    if (!state?.success || handled.current === state) return;
    handled.current = state;
    setIdempotencyKey(newSubmissionKey());
    setAmount("");
    onDoneRef.current?.();
  }, [state]);

  const party = parties.find((p) => p.id === partyId);
  const account = paymentAccounts.find((p) => p.id === paymentAccountId);
  const effect =
    voucherType !== "EXPENSE" && party?.balance != null && amount
      ? paymentEffect(voucherType, party.type, party.balance, amount)
      : null;

  function confirmBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    const formData = new FormData(event.currentTarget);
    const amountValue = formData.get("amount");
    const outcome = effect ? `\n${effect.outcomeLabel}.` : "";
    if (!window.confirm(`Save this ${label.toLowerCase()} of ₹${amountValue}?${outcome}`)) {
      event.preventDefault();
    }
  }

  return (
    <form
      action={formAction}
      onSubmit={confirmBeforeSubmit}
      className="flex min-w-0 flex-col gap-5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6"
      noValidate
      data-testid={`cash-voucher-form-${voucherType}`}
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="currencyCode" value="INR" />
      <input type="hidden" name="exchangeRate" value="1" />
      <input type="hidden" name="confirmOutsideFy" value={confirmOutsideFy ? "true" : "false"} />

      {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
      {state?.success ? (
        <Alert tone="success">
          {state.replayed
            ? `${label} was already saved as ${state.voucherNumber} — the repeated submit was ignored.`
            : `${label} saved as ${state.voucherNumber}. Balances below are updated — you can enter the next one.`}
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Date" name="date" type="date" defaultValue={indiaToday()} required />
        <Field
          label="Amount"
          name="amount"
          type="number"
          step="0.01"
          min="0.01"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <PartySelect name="partyId" parties={parties} required={partyRequired} onChange={setPartyId} />
        <div className="flex min-w-0 flex-col gap-1.5">
          <label
            htmlFor={paymentAccountFieldId}
            className="text-sm font-medium text-zinc-800 dark:text-zinc-200"
          >
            Payment account <span className="text-red-600 dark:text-red-400">*</span>
          </label>
          <select
            id={paymentAccountFieldId}
            name="paymentAccountId"
            required
            value={paymentAccountId}
            onChange={(e) => setPaymentAccountId(e.target.value)}
            className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-900 dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100"
          >
            <option value="" disabled>
              Choose an account…
            </option>
            {paymentAccounts.map((pa) => (
              <option key={pa.id} value={pa.id}>
                {pa.name}
              </option>
            ))}
          </select>
          {account?.balance != null ? (
            <p className="text-xs text-zinc-500 dark:text-zinc-400" data-testid="payment-account-balance">
              {account.name} balance now {formatRupees(account.balance)}
              {amount && safePaise(amount) > 0
                ? ` → after this ${formatRupees(
                    fromPaise(
                      voucherType === "PAYMENT_RECEIVED"
                        ? toPaise(account.balance) + safePaise(amount)
                        : toPaise(account.balance) - safePaise(amount)
                    )
                  )}`
                : ""}
            </p>
          ) : null}
        </div>
      </div>

      {voucherType !== "EXPENSE" && party?.balance != null ? (
        <div
          className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm"
          data-testid="party-balance-preview"
          aria-live="polite"
        >
          <p className="text-zinc-700 dark:text-zinc-300">
            <span className="font-medium">{party.name}</span> now:{" "}
            <span data-testid="party-balance-now">{classifyPartyBalance(party.type, party.balance).label}</span>
          </p>
          {effect ? (
            <>
              <p className="mt-1 text-zinc-700 dark:text-zinc-300">
                After this payment: <span className="font-semibold" data-testid="party-balance-after">{effect.after.label}</span>
              </p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400" data-testid="payment-outcome">
                {effect.outcomeLabel}.
                {effect.after.kind === "ADVANCE_PAID" || effect.after.kind === "CUSTOMER_CREDIT" ? ` ${effect.after.explanation}` : ""}
              </p>
            </>
          ) : null}
        </div>
      ) : null}

      <div>
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
        >
          {showMore ? "Hide advanced details" : "More details (reference, note)"}
        </button>
      </div>

      {showMore ? (
        <div className="grid grid-cols-1 gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 sm:grid-cols-2">
          <Field label="Bill/reference number" name="referenceNumber" />
          <Field label="Note" name="note" />
          <label className="col-span-full flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <input
              type="checkbox"
              checked={confirmOutsideFy}
              onChange={(e) => setConfirmOutsideFy(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-zinc-300"
            />
            This date is outside the current financial year and I confirm that&apos;s intentional
          </label>
        </div>
      ) : null}

      <Button type="submit" size="lg" disabled={pending} className="self-start">
        {pending ? "Saving…" : `Save ${label.toLowerCase()}`}
      </Button>
    </form>
  );
}

function safePaise(value: string): number {
  try {
    return toPaise(value);
  } catch {
    return 0;
  }
}
