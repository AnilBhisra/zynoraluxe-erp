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
import { FinishedJewellerySaleForm } from "@/components/accounting/FinishedJewellerySaleForm";
import { VoucherList, type SerializedVoucherRow } from "@/components/accounting/VoucherList";
import { Button } from "@/components/ui/Button";
import type { PartyOption } from "@/components/accounting/PartySelect";
import type { SerializedFinishedStockRow } from "@/components/jewellery/FinishedStockTab";

type EntryKind = "PURCHASE" | "SALE" | "PAYMENT_GIVEN" | "PAYMENT_RECEIVED" | "EXPENSE";

const ENTRY_BUTTONS: { kind: EntryKind; label: string }[] = [
  { kind: "PURCHASE", label: "New Purchase" },
  { kind: "SALE", label: "New Sale" },
  { kind: "PAYMENT_GIVEN", label: "Payment Given" },
  { kind: "PAYMENT_RECEIVED", label: "Payment Received" },
  { kind: "EXPENSE", label: "New Expense" },
];

type SaleMode = "CHOOSE" | "FINISHED" | "MANUAL";
type PurchaseMode = "CHOOSE" | "OTHER";

// Stock purchases must be recorded where their stock lives, so the stock
// movements post in the same transaction as the voucher. Plain links, not
// client navigation, per the existing same-page navigation rule.
const STOCK_PURCHASE_LINKS: { href: string; title: string; description: string }[] = [
  { href: "/diamond?tab=rough", title: "Rough Diamond", description: "Rough lots and pieces — Diamond → Rough Diamond → New purchase." },
  { href: "/diamond?tab=polished", title: "Polished Diamond", description: "Packets with Party / Supplier and Dalal / Broker — Diamond → Polished Diamond." },
  { href: "/jewellery-jobs?tab=metal", title: "Metal", description: "Gold, silver, platinum or Copper/Alloy — Jewellery Jobs → Metal Stock." },
];

export function TransactionsTab({
  parties,
  paymentAccounts,
  gstRates,
  companyStateCode,
  vouchers,
  canCancel,
  initialOpen,
  availableFinishedItems,
}: {
  parties: PartyOption[];
  paymentAccounts: { id: string; name: string; method: string }[];
  gstRates: { id: string; label: string; ratePercent: string }[];
  companyStateCode: string | null;
  vouchers: SerializedVoucherRow[];
  canCancel: boolean;
  initialOpen?: EntryKind | null;
  availableFinishedItems: SerializedFinishedStockRow[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<EntryKind | null>(initialOpen ?? null);
  const [saleMode, setSaleMode] = useState<SaleMode>("CHOOSE");
  const [purchaseMode, setPurchaseMode] = useState<PurchaseMode>("CHOOSE");
  const [manualConfirmed, setManualConfirmed] = useState(false);
  const customers = parties.filter((p) => p.type === "CUSTOMER");

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
            onClick={() => {
              setOpen(open === btn.kind ? null : btn.kind);
              if (btn.kind === "PURCHASE") setPurchaseMode("CHOOSE");
              if (btn.kind === "SALE") {
                setSaleMode("CHOOSE");
                setManualConfirmed(false);
              }
            }}
          >
            {btn.label}
          </Button>
        ))}
      </div>

      {open === "PURCHASE" && purchaseMode === "CHOOSE" ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">What are you buying?</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {STOCK_PURCHASE_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-left hover:border-zinc-400 dark:hover:border-zinc-500"
              >
                <p className="font-medium text-zinc-900 dark:text-zinc-50">{link.title}</p>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{link.description}</p>
              </a>
            ))}
            <button
              type="button"
              onClick={() => setPurchaseMode("OTHER")}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-left hover:border-zinc-400 dark:hover:border-zinc-500"
            >
              <p className="font-medium text-zinc-900 dark:text-zinc-50">Other purchase</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Anything that is not diamond or metal stock — accounting only.</p>
            </button>
          </div>
        </div>
      ) : null}
      {open === "PURCHASE" && purchaseMode === "OTHER" ? (
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
      {open === "SALE" && saleMode === "CHOOSE" ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300">What are you selling?</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => setSaleMode("FINISHED")}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-left hover:border-zinc-400 dark:hover:border-zinc-500"
            >
              <p className="font-medium text-zinc-900 dark:text-zinc-50">Sell Finished Jewellery</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                Pick one or more Available pieces from stock. Updates stock, revenue, GST and COGS together.
              </p>
            </button>
            <button
              type="button"
              onClick={() => setSaleMode("MANUAL")}
              className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-4 text-left hover:border-zinc-400 dark:hover:border-zinc-500"
            >
              <p className="font-medium text-zinc-900 dark:text-zinc-50">Other / Accounting-only Sale</p>
              <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                A manual invoice line that does not touch Finished Jewellery stock or cost of goods sold.
              </p>
            </button>
          </div>
        </div>
      ) : null}
      {open === "SALE" && saleMode === "FINISHED" ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setSaleMode("CHOOSE")}
            className="self-start text-xs font-medium text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ← Change sale type
          </button>
          <FinishedJewellerySaleForm
            customers={customers}
            availableItems={availableFinishedItems}
            paymentAccounts={paymentAccounts}
            gstRates={gstRates}
            companyStateCode={companyStateCode}
            onDone={handleSaved}
          />
        </div>
      ) : null}
      {open === "SALE" && saleMode === "MANUAL" ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setSaleMode("CHOOSE")}
            className="self-start text-xs font-medium text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            ← Change sale type
          </button>
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
            <p className="font-medium">This is an accounting-only sale.</p>
            <p className="mt-1 text-xs">
              No Finished Jewellery stock or cost of goods sold will be affected. It appears in reports clearly
              marked as a manual sale with no linked stock/COGS.
            </p>
            <label className="mt-3 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={manualConfirmed}
                onChange={(e) => setManualConfirmed(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-amber-400"
              />
              I understand — continue with a manual sale
            </label>
          </div>
          {manualConfirmed ? (
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
        </div>
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
