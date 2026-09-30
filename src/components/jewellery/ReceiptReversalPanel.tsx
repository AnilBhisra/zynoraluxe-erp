"use client";

import { useActionState, useEffect, useState, useTransition } from "react";

import { previewCustomerGoldReceiptReversalAction, reverseCustomerGoldReceiptAction } from "@/app/actions/customerGold";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";

/**
 * Owner-only reversal of a Customer Gold jewellery receipt. The preview lists
 * every dependency that blocks it, or exactly what goes back (Customer gold,
 * pieces, stones, the mirror voucher) before anything is saved.
 */
export function ReceiptReversalPanel({ receiptId, receiptCode, onDone }: { receiptId: string; receiptCode: string; onDone: () => void }) {
  const [previewState, previewAction, previewPending] = useActionState(previewCustomerGoldReceiptReversalAction, undefined);
  const [state, action, pending] = useActionState(reverseCustomerGoldReceiptAction, undefined);
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);
  const plan = previewState?.plan ?? null;

  if (state?.success) return <Alert tone="success">Reversed — {state.code}. Record the receipt again with the correct figures if needed.</Alert>;
  if (!open) {
    return (
      <button
        type="button"
        className="text-xs font-medium underline underline-offset-2"
        onClick={() => {
          setOpen(true);
          const fd = new FormData();
          fd.set("receiptId", receiptId);
          startTransition(() => previewAction(fd));
        }}
      >
        Reverse {receiptCode}
      </button>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50/40 p-3 text-xs dark:border-red-900 dark:bg-red-950/20" data-testid={`receipt-reversal-${receiptCode}`}>
      {previewPending ? <p>Checking what depends on {receiptCode}…</p> : null}
      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {plan && plan.blockers.length > 0 ? (
        <div data-testid="reversal-blockers">
          <p className="font-semibold">{receiptCode} cannot be reversed yet:</p>
          <ul className="mt-1 list-disc pl-5">
            {plan.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan && plan.blockers.length === 0 ? (
        <div className="flex flex-col gap-1" data-testid="reversal-effects">
          <p className="font-semibold">Reversing {receiptCode} will (nothing is deleted; every step is a new audited entry):</p>
          <ul className="list-disc pl-5">
            {plan.pieces.map((p) => (
              <li key={p.id}>
                mark {p.finishedCode} as reversed ({p.customerGoldFineWeight} g fine of the Customer&apos;s gold back on the job)
              </li>
            ))}
            {plan.goldBack.map((g) => (
              <li key={g.label}>
                Customer gold {g.label.toLowerCase()}: {g.fine} g fine ({g.gross} g gross)
              </li>
            ))}
            {plan.diamondsBack.length ? <li>diamonds back with the job: {plan.diamondsBack.join(", ")}</li> : null}
            {plan.packetStonesBack.map((p) => (
              <li key={p.packetCode + p.disposition}>
                packet {p.packetCode}: {p.pieces} pcs / {p.carat} ct ({p.disposition.toLowerCase()}) back with the job
              </li>
            ))}
            {plan.voucher ? (
              <li>
                mirror voucher for {plan.voucher.number}: {plan.voucher.lines.filter((l) => l.debit !== "0.00" || l.credit !== "0.00").map((l) => `${l.account} Dr ₹${l.debit} / Cr ₹${l.credit}`).join(" · ")}
              </li>
            ) : (
              <li>no voucher (the receipt posted no Company cost)</li>
            )}
            <li>
              {plan.jobCode} back to {plan.jobStatusAfter.replace(/_/g, " ").toLowerCase()} with {plan.jobPendingFineAfter} g fine of Company metal pending
            </li>
          </ul>
          {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
          <Field label="Reason for reversing (at least 10 characters)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          <Button
            type="button"
            variant="danger"
            disabled={pending || reason.trim().length < 10}
            className="self-start"
            onClick={() => {
              const fd = new FormData();
              fd.set("receiptId", receiptId);
              fd.set("reason", reason);
              fd.set("idempotencyKey", idempotencyKey);
              startTransition(() => action(fd));
            }}
          >
            {pending ? "Reversing…" : `Confirm reversal of ${receiptCode}`}
          </Button>
        </div>
      ) : null}
      <button type="button" className="self-start text-xs underline underline-offset-2" onClick={() => setOpen(false)}>
        Close
      </button>
    </div>
  );
}
