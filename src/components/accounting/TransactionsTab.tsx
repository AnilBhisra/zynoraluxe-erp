"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  createExpense,
  createPaymentGiven,
  createPaymentReceived,
  createPurchase,
  createSale,
} from "@/app/actions/vouchers";
import { InvoiceVoucherForm } from "@/components/accounting/InvoiceVoucherForm";
import { CashVoucherForm } from "@/components/accounting/CashVoucherForm";
import { VoucherList, type SerializedVoucherRow } from "@/components/accounting/VoucherList";
import { Button } from "@/components/ui/Button";
import type { PartyOption } from "@/components/accounting/PartySelect";

type EntryKind = "PURCHASE" | "SALE" | "PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "EXPENSE";

const ENTRY_BUTTONS: { kind: EntryKind; label: string }[] = [
  { kind: "PURCHASE", label: "New Purchase" },
  { kind: "SALE", label: "New Sale" },
  { kind: "PAYMENT_GIVEN", label: "Payment Given" },
  { kind: "PAYMENT_RECEIVED", label: "Payment Received" },
  { kind: "EXPENSE", label: "New Expense" },
];

export function TransactionsTab({
  parties,
  paymentAccounts,
  gstRates,
  companyStateCode,
  vouchers,
  canCancel,
  initialOpen,
}: {
  parties: PartyOption[];
  paymentAccounts: { id: string; name: string; method: string }[];
  gstRates: { id: string; label: string; ratePercent: string }[];
  companyStateCode: string | null;
  vouchers: SerializedVoucherRow[];
  canCancel: boolean;
  initialOpen?: EntryKind | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<EntryKind | null>(initialOpen ?? null);

  // Deliberately does NOT close the form on success — closing immediately
  // would unmount the form (and its "Saved as ..." confirmation) before the
  // user has a chance to read it. The list below still refreshes with the
  // new entry; the user closes the form themselves (click the same button
  // again) when they're done reading the confirmation.
  function handleSaved() {
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        {ENTRY_BUTTONS.map((btn) => (
          <Button
            key={btn.kind}
            type="button"
            variant={open === btn.kind ? "primary" : "secondary"}
            size="md"
            onClick={() => setOpen(open === btn.kind ? null : btn.kind)}
          >
            {btn.label}
          </Button>
        ))}
      </div>

      {open === "PURCHASE" ? (
        <InvoiceVoucherForm
          voucherType="PURCHASE"
          action={createPurchase}
          parties={parties}
          paymentAccounts={paymentAccounts}
          gstRates={gstRates}
          companyStateCode={companyStateCode}
          onDone={handleSaved}
        />
      ) : null}
      {open === "SALE" ? (
        <InvoiceVoucherForm
          voucherType="SALE"
          action={createSale}
          parties={parties}
          paymentAccounts={paymentAccounts}
          gstRates={gstRates}
          companyStateCode={companyStateCode}
          onDone={handleSaved}
        />
      ) : null}
      {open === "PAYMENT_GIVEN" ? (
        <CashVoucherForm
          voucherType="PAYMENT_GIVEN"
          action={createPaymentGiven}
          parties={parties}
          paymentAccounts={paymentAccounts}
          onDone={handleSaved}
        />
      ) : null}
      {open === "PAYMENT_RECEIVED" ? (
        <CashVoucherForm
          voucherType="PAYMENT_RECEIVED"
          action={createPaymentReceived}
          parties={parties}
          paymentAccounts={paymentAccounts}
          onDone={handleSaved}
        />
      ) : null}
      {open === "EXPENSE" ? (
        <CashVoucherForm
          voucherType="EXPENSE"
          action={createExpense}
          parties={parties}
          paymentAccounts={paymentAccounts}
          onDone={handleSaved}
        />
      ) : null}

      <div>
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">
          Recent transactions
        </h3>
        <VoucherList vouchers={vouchers} canCancel={canCancel} />
      </div>
    </div>
  );
}
