"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";

import {
  discardCustomerGoldPhotoAction,
  exchangeOldGoldAction,
  postCustomerGoldTransferAction,
  previewCustomerGoldIntakeAction,
  previewCustomerGoldPurchaseAction,
  previewCustomerGoldPurchaseReversalAction,
  previewCustomerGoldTransferAction,
  previewOldGoldExchangeAction,
  purchaseCustomerGoldAction,
  receiveCustomerGoldAction,
  reverseCustomerGoldEntryAction,
  reverseCustomerGoldPurchaseAction,
} from "@/app/actions/customerGold";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { JewelleryPhotoUploadField } from "@/components/jewellery/PhotoUploadField";
import type { CustomerGoldPoolRow, CustomerGoldStatement } from "@/lib/jewellery/customerGoldReports";

/**
 * Customer Gold (CUSTOMER_GOLD_DESIGN.md). A Customer's own gold, held for
 * manufacturing — never Company stock. The Owner records it, moves it and can
 * buy it (a separate, approved purchase); Staff see weights only. Every money
 * figure on this screen is sent by the server only to the Owner.
 */

export type CustomerGoldTabData = {
  isOwner: boolean;
  customers: { id: string; name: string }[];
  selectedCustomerId: string;
  statement: CustomerGoldStatement | null;
  purities: { id: string; metalType: string; displayName: string; finenessPercent: string }[];
  karigars: { id: string; name: string }[];
  customerJobs: { id: string; jobCode: string; designName: string; karigarName: string; status: string }[];
  reports: {
    karigarWise: { karigarName: string; customerName: string; purityDisplayName: string; finenessPercent: string; fine: string; gross: string }[];
    jobWise: { jobId: string; jobCode: string; status: string; customerName: string; purityDisplayName: string; onJob: string; consumed: string; returned: string; scrap: string; loss: string }[];
    awaiting: { id: string; finishedCode: string; jobId: string; jobCode: string; jobStatus: string; customerName: string; netMetalWeight: string; customerGoldFineWeight: string; companyCost: string | null }[];
    exceptions: { kind: string; detail: string }[];
    totals: Record<string, string>;
  };
};

const today = () => new Date().toISOString().slice(0, 10);
const inputCls = "mt-1 h-11 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";
const cardCls = "rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5";
const g = (v: string) => `${v} g`;

export function CustomerGoldTab(props: CustomerGoldTabData) {
  const router = useRouter();
  const { isOwner, statement } = props;
  const refresh = () => router.refresh();
  const [panel, setPanel] = useState<"none" | "intake" | "move" | "buy">("none");

  return (
    <div className="flex flex-col gap-5" data-testid="customer-gold-tab">
      <div className={cardCls}>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[14rem] flex-1 text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Customer
            <select
              aria-label="Customer"
              value={props.selectedCustomerId}
              onChange={(e) => router.push(`/jewellery-jobs?tab=customer-gold${e.target.value ? `&customerId=${e.target.value}` : ""}`)}
              className={inputCls}
            >
              <option value="">Choose a Customer…</option>
              {props.customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {statement ? (
            <a href={`/customer-gold/statement/${statement.customer.id}`} target="_blank" rel="noreferrer" className="h-11 rounded-lg border border-zinc-300 px-4 text-sm font-medium leading-[2.75rem] text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-100 dark:hover:bg-zinc-800">
              Printable statement
            </a>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          A Customer&apos;s own gold stays theirs: it is never Company stock and never Company cost. Buying it is a separate, Owner-approved purchase.
        </p>
      </div>

      {statement && isOwner ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant={panel === "intake" ? "primary" : "secondary"} onClick={() => setPanel(panel === "intake" ? "none" : "intake")}>
            Receive gold from {statement.customer.name}
          </Button>
          <Button type="button" variant={panel === "move" ? "primary" : "secondary"} onClick={() => setPanel(panel === "move" ? "none" : "move")} disabled={statement.pools.length === 0}>
            Move Customer gold
          </Button>
          <Button type="button" variant={panel === "buy" ? "primary" : "secondary"} onClick={() => setPanel(panel === "buy" ? "none" : "buy")} disabled={!statement.pools.some((p) => Number(p.safe) > 0)}>
            Buy from safe balance
          </Button>
        </div>
      ) : null}

      {statement && isOwner && panel === "intake" ? (
        <IntakePanel customerId={statement.customer.id} customerName={statement.customer.name} purities={props.purities} onClose={() => setPanel("none")} onDone={refresh} />
      ) : null}
      {statement && isOwner && panel === "move" ? (
        <TransferForm statement={statement} karigars={props.karigars} jobs={props.customerJobs} onClose={() => setPanel("none")} onDone={refresh} />
      ) : null}
      {statement && isOwner && panel === "buy" ? (
        <PurchaseForm
          mode="CUSTODY"
          customerId={statement.customer.id}
          purities={props.purities}
          pools={statement.pools.filter((p) => Number(p.safe) > 0)}
          onClose={() => setPanel("none")}
          onDone={refresh}
        />
      ) : null}

      {statement ? <StatementView statement={statement} isOwner={isOwner} onDone={refresh} /> : null}

      <Reports reports={props.reports} isOwner={isOwner} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Intake: two explicit choices
// ---------------------------------------------------------------------------

function IntakePanel({
  customerId,
  customerName,
  purities,
  onClose,
  onDone,
}: {
  customerId: string;
  customerName: string;
  purities: CustomerGoldTabData["purities"];
  onClose: () => void;
  onDone: () => void;
}) {
  const [choice, setChoice] = useState<"" | "CUSTODY" | "PURCHASE">("");
  return (
    <div className={cardCls} data-testid="cg-intake">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Gold received from {customerName}</p>
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      <fieldset className="mt-3 flex flex-col gap-2">
        <legend className="text-sm font-medium text-zinc-800 dark:text-zinc-200">What is this gold? (required)</legend>
        <label className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-3 text-sm">
          <input type="radio" name="intakeChoice" checked={choice === "CUSTODY"} onChange={() => setChoice("CUSTODY")} className="mt-0.5 h-4 w-4" />
          <span>
            <span className="font-medium">Customer-owned gold — for manufacturing</span>
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">Stays the Customer&apos;s. Not added to Company stock, no payable, no cost.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-3 text-sm">
          <input type="radio" name="intakeChoice" checked={choice === "PURCHASE"} onChange={() => setChoice("PURCHASE")} className="mt-0.5 h-4 w-4" />
          <span>
            <span className="font-medium">Purchase/exchange gold from Customer</span>
            <span className="block text-xs text-zinc-500 dark:text-zinc-400">Old gold the Company buys at an agreed value (Owner approval). It becomes Company stock and, if you choose, the Customer&apos;s bill credit.</span>
          </span>
        </label>
      </fieldset>
      {choice === "CUSTODY" ? <IntakeForm customerId={customerId} purities={purities} onDone={onDone} /> : null}
      {choice === "PURCHASE" ? <ExchangeForm customerId={customerId} purities={purities} onDone={onDone} /> : null}
    </div>
  );
}

function IntakeForm({ customerId, purities, onDone }: { customerId: string; purities: CustomerGoldTabData["purities"]; onDone: () => void }) {
  const [previewState, previewAction, previewPending] = useActionState(previewCustomerGoldIntakeAction, undefined);
  const [postState, postAction, postPending] = useActionState(receiveCustomerGoldAction, undefined);
  const [, startTransition] = useTransition();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [purityId, setPurityId] = useState(purities[0]?.id ?? "");
  const [basis, setBasis] = useState<"GROSS" | "FINE">("GROSS");
  const [weight, setWeight] = useState("");
  const [deduction, setDeduction] = useState("");
  const [intakeDate, setIntakeDate] = useState(today());
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [declared, setDeclared] = useState("");
  const [photoAssetId, setPhotoAssetId] = useState<string | null>(null);
  const [previewed, setPreviewed] = useState("");
  const current = JSON.stringify({ purityId, basis, weight, deduction, intakeDate, reference, reason, declared });
  const preview = previewState?.preview && previewed === current ? previewState.preview : null;
  // A photo uploaded for an intake that is then abandoned (closed, another
  // choice, navigated away) or never saved is discarded — never left orphaned
  // in storage. The server refuses to discard anything a record points at.
  const photoRef = useRef<string | null>(null);
  const savedRef = useRef(false);
  useEffect(() => {
    photoRef.current = photoAssetId;
  }, [photoAssetId]);
  useEffect(() => {
    if (postState?.success) savedRef.current = true;
  }, [postState?.success]);
  useEffect(() => {
    const discard = () => {
      if (photoRef.current && !savedRef.current) {
        void discardCustomerGoldPhotoAction(photoRef.current);
        photoRef.current = null;
      }
    };
    window.addEventListener("pagehide", discard);
    return () => {
      window.removeEventListener("pagehide", discard);
      discard();
    };
  }, []);
  useEffect(() => {
    if (postState?.success) onDone();
  }, [postState?.success, onDone]);
  const payload = () => {
    const fd = new FormData();
    fd.set("customerId", customerId);
    fd.set("purityId", purityId);
    fd.set("inputBasis", basis);
    fd.set("weight", weight);
    fd.set("deductionWeight", deduction);
    fd.set("intakeDate", intakeDate);
    fd.set("reference", reference);
    fd.set("reason", reason);
    fd.set("declaredValue", declared);
    if (photoAssetId) fd.set("photoAssetId", photoAssetId);
    fd.set("idempotencyKey", idempotencyKey);
    return fd;
  };
  if (postState?.success) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <Alert tone="success">Recorded — {postState.code}. The gold is in the safe, in the Customer&apos;s name.</Alert>
        {postState.id ? (
          <a className="text-sm font-medium underline underline-offset-4" href={`/customer-gold/receipt/${postState.id}`} target="_blank" rel="noreferrer">
            Print the Customer&apos;s acknowledgment
          </a>
        ) : null}
      </div>
    );
  }
  return (
    <form className="mt-4 flex flex-col gap-3" data-testid="cg-intake-form" onSubmit={(e) => e.preventDefault()}>
      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Metal and purity
          <select aria-label="Metal and purity" value={purityId} onChange={(e) => setPurityId(e.target.value)} className={inputCls}>
            {purities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.metalType} {p.displayName} ({p.finenessPercent}%)
              </option>
            ))}
          </select>
        </label>
        <Field label="Date received" name="intakeDate" type="date" value={intakeDate} max={today()} onChange={(e) => setIntakeDate(e.target.value)} required />
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Weight entered as</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="cgBasis" checked={basis === "GROSS"} onChange={() => setBasis("GROSS")} className="h-4 w-4" /> Gross grams (as weighed)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="cgBasis" checked={basis === "FINE"} onChange={() => setBasis("FINE")} className="h-4 w-4" /> Fine grams (pure)
            </label>
          </div>
        </fieldset>
        <Field label={basis === "FINE" ? "Fine weight (g)" : "Gross weight (g, as weighed)"} name="weight" type="number" step="0.001" min="0" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
        <Field label="Stone / dust deduction (g, optional)" name="deductionWeight" type="number" step="0.001" min="0" inputMode="decimal" value={deduction} onChange={(e) => setDeduction(e.target.value)} />
        <Field label="Reference (optional)" name="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
        <Field
          label="Declared value (₹, optional — documentation/insurance only)"
          name="declaredValue"
          type="number"
          step="0.01"
          min="0"
          value={declared}
          onChange={(e) => setDeclared(e.target.value)}
          hint="Never Company inventory cost. Only the Owner sees it."
        />
      </div>
      <Field label="Reason / notes (required)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required />
      <JewelleryPhotoUploadField category="jewellery-finished" label="Photo of the gold (optional)" assetId={photoAssetId} onUploaded={setPhotoAssetId} />
      {preview ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="cg-intake-preview">
          <p className="font-medium">
            {preview.customerName}&apos;s {preview.purityDisplayName} ({preview.finenessPercent}%): gross {g(preview.grossWeight)} − deduction {g(preview.deductionWeight)} = net{" "}
            <strong>{g(preview.netGrossWeight)}</strong> = <strong>{g(preview.fineWeight)} fine</strong>.
          </p>
          <p className="mt-1 text-xs">Customer-owned: no voucher, not Company stock, no cost.</p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={previewPending || postPending || !purityId || !(Number(weight) > 0) || reason.trim().length < 3}
          onClick={() => {
            setPreviewed(current);
            startTransition(() => previewAction(payload()));
          }}
        >
          {previewPending ? "Checking…" : "Preview"}
        </Button>
        {preview ? (
          <Button type="button" disabled={postPending} onClick={() => startTransition(() => postAction(payload()))}>
            {postPending ? "Saving…" : "Record Customer gold"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Old Gold Exchange (Owner): one step — intake + approved purchase of exactly it
// ---------------------------------------------------------------------------

const RATE_LABEL: Record<string, string> = {
  PER_FINE_GRAM: "Rate per FINE gram (₹)",
  PER_GROSS_GRAM: "Rate per GROSS gram (₹)",
  FIXED_TOTAL: "Agreed total (₹)",
};
const BASIS_TEXT: Record<string, string> = { PER_FINE_GRAM: "per fine gram", PER_GROSS_GRAM: "per gross gram", FIXED_TOTAL: "fixed total" };

function ExchangeForm({ customerId, purities, onDone }: { customerId: string; purities: CustomerGoldTabData["purities"]; onDone: () => void }) {
  const [previewState, previewAction, previewPending] = useActionState(previewOldGoldExchangeAction, undefined);
  const [postState, postAction, postPending] = useActionState(exchangeOldGoldAction, undefined);
  const [, startTransition] = useTransition();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [exchangeDate, setExchangeDate] = useState(today());
  const [purityId, setPurityId] = useState(purities[0]?.id ?? "");
  const [statedPurity, setStatedPurity] = useState("");
  const [basis, setBasis] = useState<"GROSS" | "FINE">("GROSS");
  const [weight, setWeight] = useState("");
  const [deduction, setDeduction] = useState("");
  const [rateBasis, setRateBasis] = useState("PER_FINE_GRAM");
  const [rate, setRate] = useState("");
  const [settlement, setSettlement] = useState("CREDIT_TO_INVOICE");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [photoAssetId, setPhotoAssetId] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [previewed, setPreviewed] = useState("");
  const current = JSON.stringify({ exchangeDate, purityId, statedPurity, basis, weight, deduction, rateBasis, rate, settlement, reference, reason, photoAssetId });
  const preview = previewState?.preview && previewed === current ? previewState.preview : null;
  // Same rule as the intake form: a photo uploaded for an exchange that is then
  // abandoned or never saved is discarded, never left orphaned in storage.
  const photoRef = useRef<string | null>(null);
  const savedRef = useRef(false);
  useEffect(() => {
    photoRef.current = photoAssetId;
  }, [photoAssetId]);
  useEffect(() => {
    if (postState?.success) savedRef.current = true;
  }, [postState?.success]);
  useEffect(() => {
    const discard = () => {
      if (photoRef.current && !savedRef.current) {
        void discardCustomerGoldPhotoAction(photoRef.current);
        photoRef.current = null;
      }
    };
    window.addEventListener("pagehide", discard);
    return () => {
      window.removeEventListener("pagehide", discard);
      discard();
    };
  }, []);
  useEffect(() => {
    if (postState?.success) onDone();
  }, [postState?.success, onDone]);
  const payload = (fingerprint: string) => {
    const fd = new FormData();
    fd.set("customerId", customerId);
    fd.set("exchangeDate", exchangeDate);
    fd.set("purityId", purityId);
    fd.set("statedPurity", statedPurity);
    fd.set("inputBasis", basis);
    fd.set("weight", weight);
    fd.set("deductionWeight", deduction);
    fd.set("rateBasis", rateBasis);
    fd.set("rate", rate);
    fd.set("settlement", settlement);
    fd.set("reference", reference);
    fd.set("reason", reason);
    if (photoAssetId) fd.set("photoAssetId", photoAssetId);
    fd.set("approved", approved ? "1" : "");
    fd.set("idempotencyKey", idempotencyKey);
    fd.set("previewFingerprint", fingerprint);
    return fd;
  };
  if (postState?.success) {
    return (
      <div className="mt-3 flex flex-col gap-2" data-testid="cg-exchange-done">
        <Alert tone="success">Exchange posted — {postState.code}. The accepted gold is now Company stock.</Alert>
        {postState.id ? (
          <a className="text-sm font-medium underline underline-offset-4" href={`/customer-gold/purchase/${postState.id}`} target="_blank" rel="noreferrer">
            Print the exchange acknowledgment
          </a>
        ) : null}
      </div>
    );
  }
  return (
    <form className="mt-4 flex flex-col gap-3" data-testid="cg-exchange-form" onSubmit={(e) => e.preventDefault()}>
      <p className="text-xs text-amber-700 dark:text-amber-400">
        Old gold the Company BUYS (or takes in exchange) at an agreed value, with the Owner&apos;s approval. It is recorded as received from the Customer and, in the same step, becomes Company stock. / કંપની આ સોનું ખરીદે છે.
      </p>
      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Date" name="exchangeDate" type="date" value={exchangeDate} max={today()} onChange={(e) => setExchangeDate(e.target.value)} />
        <Field label="Stated purity (what the Customer says)" name="statedPurity" value={statedPurity} onChange={(e) => setStatedPurity(e.target.value)} maxLength={60} hint="Documentation only." />
        <label className="text-xs font-medium">
          Tested / approved purity
          <select aria-label="Tested purity" value={purityId} onChange={(e) => setPurityId(e.target.value)} className={inputCls}>
            {purities.map((p) => (
              <option key={p.id} value={p.id}>
                {p.metalType} {p.displayName} ({p.finenessPercent}%)
              </option>
            ))}
          </select>
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Weight entered as</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="cgExBasis" checked={basis === "GROSS"} onChange={() => setBasis("GROSS")} className="h-4 w-4" /> Gross grams (as weighed)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="cgExBasis" checked={basis === "FINE"} onChange={() => setBasis("FINE")} className="h-4 w-4" /> Accepted fine grams
            </label>
          </div>
        </fieldset>
        <Field label={basis === "FINE" ? "Accepted fine weight (g)" : "Gross weight (g, as weighed)"} name="weight" type="number" step="0.001" min="0" inputMode="decimal" value={weight} onChange={(e) => setWeight(e.target.value)} />
        <Field label="Allowed deduction — stone / dust (g)" name="deductionWeight" type="number" step="0.001" min="0" inputMode="decimal" value={deduction} onChange={(e) => setDeduction(e.target.value)} />
        <label className="text-xs font-medium">
          Valuation rate basis
          <select aria-label="Exchange rate basis" value={rateBasis} onChange={(e) => setRateBasis(e.target.value)} className={inputCls}>
            <option value="PER_FINE_GRAM">₹ per fine gram</option>
            <option value="PER_GROSS_GRAM">₹ per gross gram</option>
            <option value="FIXED_TOTAL">Fixed total ₹</option>
          </select>
        </label>
        <Field label={RATE_LABEL[rateBasis]} name="rate" type="number" step="0.0001" min="0" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        <label className="text-xs font-medium">
          Settlement
          <select aria-label="Exchange settlement" value={settlement} onChange={(e) => setSettlement(e.target.value)} className={inputCls}>
            <option value="CREDIT_TO_INVOICE">Credit against the Customer&apos;s jewellery bill</option>
            <option value="PAY_CUSTOMER">Pay the Customer (Payment Given)</option>
          </select>
        </label>
        <Field label="Reference (required — slip / register number)" name="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
      </div>
      <Field label="Reason / notes (required)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      <JewelleryPhotoUploadField category="jewellery-finished" label="Photo of the old gold (optional)" assetId={photoAssetId} onUploaded={setPhotoAssetId} />
      {preview ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30" data-testid="cg-exchange-preview">
          <p className="font-medium">
            {preview.customerName}&apos;s old gold — stated {preview.statedPurity ?? "—"}, tested {preview.purityDisplayName} ({preview.finenessPercent}%): gross {g(preview.grossWeight)} − deduction {g(preview.deductionWeight)} = net{" "}
            <strong>{g(preview.netGrossWeight)}</strong> = <strong>{g(preview.fineWeight)} fine</strong>.
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            <li data-testid="cg-exchange-value">
              Rate saved: ₹{preview.rate} {BASIS_TEXT[preview.rateBasis]} → value <strong>₹{preview.value}</strong> (= ₹{preview.perGrossGram} per gross gram / ₹{preview.perFineGram} per fine gram).
            </li>
            <li>Posts once: Dr Metal Inventory ₹{preview.value} / Cr Accounts Payable ({preview.customerName}) ₹{preview.value}; {g(preview.netGrossWeight)} enters Company stock at ₹{preview.value}.</li>
            <li data-testid="cg-exchange-credit">
              {preview.settlement === "CREDIT_TO_INVOICE"
                ? `Credit for the Customer's bill: ₹${preview.creditBefore} → ₹${preview.creditAfter}.`
                : "Settled by paying the Customer (Payment Given) — no bill credit."}
            </li>
          </ul>
          <label className="mt-2 flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="h-4 w-4" aria-label="I approve this exchange" /> I approve buying this gold from the Customer at this value.
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={previewPending || postPending || !purityId || !(Number(weight) > 0) || !(Number(rate) > 0) || reason.trim().length < 3 || reference.trim().length < 2}
          onClick={() => {
            setPreviewed(current);
            setApproved(false);
            startTransition(() => previewAction(payload("")));
          }}
        >
          {previewPending ? "Checking…" : "Preview exchange"}
        </Button>
        {preview ? (
          <Button type="button" disabled={postPending || !approved} onClick={() => startTransition(() => postAction(payload(preview.fingerprint)))}>
            {postPending ? "Posting…" : "Approve and post exchange"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// One approved purchase / exchange: acknowledgment and Owner reversal
// ---------------------------------------------------------------------------

function PurchaseRow({ p, isOwner, onDone }: { p: CustomerGoldStatement["purchases"][number]; isOwner: boolean; onDone: () => void }) {
  const [checkState, checkAction, checkPending] = useActionState(previewCustomerGoldPurchaseReversalAction, undefined);
  const [state, action, pending] = useActionState(reverseCustomerGoldPurchaseAction, undefined);
  const [, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);
  const reversed = p.status === "REVERSED";
  return (
    <li className="rounded-lg border border-[var(--border)] p-2" data-testid={`cg-purchase-${p.purchaseCode}`}>
      <p>
        <strong>{p.purchaseCode}</strong> · {new Date(p.date).toLocaleDateString("en-IN")} · {p.purityDisplayName} {p.fine} g fine ({p.gross} g gross) ·{" "}
        {p.intakeReceiptCode ? `exchange (intake ${p.intakeReceiptCode})` : p.fromCustody ? "from custody" : "handed over"} · {p.settlement === "CREDIT_TO_INVOICE" ? "credit to bill" : "pay Customer"}
        {p.reference ? ` · ref ${p.reference}` : ""}
        {p.approvedValue ? ` · ₹${p.approvedValue}` : ""}
        {p.rate && p.rateBasis ? ` (₹${p.rate} ${BASIS_TEXT[p.rateBasis]})` : ""}
        {reversed ? <span className="ml-1 font-semibold text-amber-700 dark:text-amber-300"> · REVERSED</span> : null}
      </p>
      {isOwner ? (
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <a className="underline underline-offset-2" href={`/customer-gold/purchase/${p.id}`} target="_blank" rel="noreferrer">
            Acknowledgment
          </a>
          {!reversed ? (
            <button
              type="button"
              className="underline underline-offset-2"
              disabled={checkPending}
              onClick={() => {
                const fd = new FormData();
                fd.set("purchaseId", p.id);
                startTransition(() => checkAction(fd));
              }}
            >
              {checkPending ? "Checking…" : `Reverse ${p.purchaseCode}`}
            </button>
          ) : null}
        </div>
      ) : null}
      {isOwner && !reversed && checkState && checkState.purchaseId === p.id ? (
        checkState.error ? (
          <Alert tone="error">{checkState.error}</Alert>
        ) : checkState.block ? (
          <p className="mt-1 text-amber-700 dark:text-amber-300" data-testid={`cg-purchase-block-${p.purchaseCode}`}>
            Cannot reverse now: {checkState.block}
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-2" data-testid={`cg-purchase-reverse-${p.purchaseCode}`}>
            <p>
              Reversing posts a mirror voucher (Dr Accounts Payable / Cr Metal Inventory), takes the same {p.gross} g out of Company stock at the same value
              {p.fromCustody ? ", and puts the gold back in the Customer's safe" : ""}. Nothing is deleted.
            </p>
            {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
            <Field label="Reason for reversing (at least 10 characters)" name={`reverseReason-${p.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
            <Button
              type="button"
              variant="danger"
              disabled={pending || reason.trim().length < 10}
              onClick={() => {
                const fd = new FormData();
                fd.set("purchaseId", p.id);
                fd.set("reason", reason);
                fd.set("idempotencyKey", idempotencyKey);
                startTransition(() => action(fd));
              }}
            >
              {pending ? "Reversing…" : `Confirm reversal of ${p.purchaseCode}`}
            </Button>
          </div>
        )
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Movements between places (Owner)
// ---------------------------------------------------------------------------

const TRANSFER_LABEL: Record<string, string> = {
  ISSUE_TO_KARIGAR: "Issue to Karigar",
  RETURN_FROM_KARIGAR: "Return from Karigar (to safe)",
  ALLOCATE_TO_JOB: "Allocate to this Customer's job",
  RELEASE_FROM_JOB: "Release from job (back to its Karigar)",
  RETURN_TO_CUSTOMER: "Return unused gold to the Customer",
  SCRAP_RETURN_TO_CUSTOMER: "Return scrap to the Customer",
};

function TransferForm({
  statement,
  karigars,
  jobs,
  onClose,
  onDone,
}: {
  statement: CustomerGoldStatement;
  karigars: CustomerGoldTabData["karigars"];
  jobs: CustomerGoldTabData["customerJobs"];
  onClose: () => void;
  onDone: () => void;
}) {
  const [previewState, previewAction, previewPending] = useActionState(previewCustomerGoldTransferAction, undefined);
  const [postState, postAction, postPending] = useActionState(postCustomerGoldTransferAction, undefined);
  const [, startTransition] = useTransition();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState("ISSUE_TO_KARIGAR");
  const [poolKey, setPoolKey] = useState(statement.pools[0] ? `${statement.pools[0].purityId}|${statement.pools[0].finenessPercent}` : "");
  const [karigarId, setKarigarId] = useState(karigars[0]?.id ?? "");
  const [jobId, setJobId] = useState(jobs[0]?.id ?? "");
  const [basis, setBasis] = useState<"GROSS" | "FINE">("FINE");
  const [weight, setWeight] = useState("");
  const [all, setAll] = useState(false);
  const [entryDate, setEntryDate] = useState(today());
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [previewed, setPreviewed] = useState("");
  const [purityId, fineness] = poolKey.split("|");
  const current = JSON.stringify({ kind, poolKey, karigarId, jobId, basis, weight, all, entryDate, reason, reference });
  const preview = previewState?.preview && previewed === current ? previewState.preview : null;
  const needsKarigar = kind === "ISSUE_TO_KARIGAR" || kind === "RETURN_FROM_KARIGAR";
  const needsJob = kind === "ALLOCATE_TO_JOB" || kind === "RELEASE_FROM_JOB";
  useEffect(() => {
    if (postState?.success) onDone();
  }, [postState?.success, onDone]);
  const payload = (fingerprint: string) => {
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("customerId", statement.customer.id);
    fd.set("purityId", purityId ?? "");
    fd.set("finenessPercent", fineness ?? "");
    if (needsKarigar) fd.set("karigarId", karigarId);
    if (needsJob) fd.set("jobId", jobId);
    fd.set("weightBasis", basis);
    if (!all) fd.set("weight", weight);
    fd.set("all", all ? "1" : "");
    fd.set("entryDate", entryDate);
    fd.set("reason", reason);
    fd.set("reference", reference);
    fd.set("idempotencyKey", idempotencyKey);
    fd.set("previewFingerprint", fingerprint);
    return fd;
  };
  if (postState?.success) {
    return (
      <div className={cardCls}>
        <Alert tone="success">Posted — {postState.code}.</Alert>
        <Button type="button" variant="ghost" onClick={onClose} className="mt-2">
          Close
        </Button>
      </div>
    );
  }
  return (
    <form className={`${cardCls} flex flex-col gap-3`} data-testid="cg-transfer-form" onSubmit={(e) => e.preventDefault()}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold">Move {statement.customer.name}&apos;s gold</p>
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          What to do
          <select aria-label="What to do" value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
            {Object.entries(TRANSFER_LABEL).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          Customer&apos;s gold
          <select aria-label="Customer's gold" value={poolKey} onChange={(e) => setPoolKey(e.target.value)} className={inputCls}>
            {statement.pools.map((p) => (
              <option key={`${p.purityId}|${p.finenessPercent}`} value={`${p.purityId}|${p.finenessPercent}`}>
                {p.purityDisplayName} ({p.finenessPercent}%) — {p.safe} g fine in safe
              </option>
            ))}
          </select>
        </label>
        {needsKarigar ? (
          <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Karigar
            <select aria-label="Karigar" value={karigarId} onChange={(e) => setKarigarId(e.target.value)} className={inputCls}>
              {karigars.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {needsJob ? (
          <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Job (this Customer&apos;s only)
            <select aria-label="Job" value={jobId} onChange={(e) => setJobId(e.target.value)} className={inputCls}>
              {jobs.length === 0 ? <option value="">No open job</option> : null}
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.jobCode} — {j.designName} ({j.karigarName})
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <fieldset className="flex flex-col gap-1.5" disabled={all}>
          <legend className="text-sm font-medium">Weight entered as</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="radio" name="cgMoveBasis" checked={basis === "GROSS"} onChange={() => setBasis("GROSS")} className="h-4 w-4" /> Gross grams
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="cgMoveBasis" checked={basis === "FINE"} onChange={() => setBasis("FINE")} className="h-4 w-4" /> Fine grams
            </label>
          </div>
        </fieldset>
        <Field label={basis === "FINE" ? "Fine weight (g)" : "Gross weight (g)"} name="weight" type="number" step="0.001" min="0" value={all ? "" : weight} disabled={all} onChange={(e) => setWeight(e.target.value)} />
        <label className="flex items-center gap-2 self-end pb-3 text-sm">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-4 w-4" /> All of it
        </label>
        <Field label="Date" name="entryDate" type="date" value={entryDate} max={today()} onChange={(e) => setEntryDate(e.target.value)} />
        <Field label="Reference (optional)" name="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
      </div>
      <Field label="Reason (required)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      {preview ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="cg-transfer-preview">
          <p className="font-medium">
            {preview.kindLabel}: <strong>{g(preview.movedFine)} fine</strong> ({g(preview.movedGross)} gross) of {preview.purityDisplayName} ({preview.finenessPercent}%)
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            <li>
              {preview.fromLabel}: {preview.fromBefore.fine} → {preview.fromAfter.fine} g fine
            </li>
            <li>
              {preview.toLabel}: {preview.toBefore.fine} → {preview.toAfter.fine} g fine
            </li>
            <li>Customer-owned: no voucher, no Company stock, no cost.</li>
          </ul>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={previewPending || postPending || !poolKey || reason.trim().length < 3 || (!all && !(Number(weight) > 0)) || (needsKarigar && !karigarId) || (needsJob && !jobId)}
          onClick={() => {
            setPreviewed(current);
            startTransition(() => previewAction(payload("")));
          }}
        >
          {previewPending ? "Checking…" : "Preview"}
        </Button>
        {preview ? (
          <Button type="button" disabled={postPending} onClick={() => startTransition(() => postAction(payload(preview.fingerprint)))}>
            {postPending ? "Posting…" : "Confirm and post"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Purchase / exchange (Owner-approved)
// ---------------------------------------------------------------------------

function PurchaseForm({
  mode,
  customerId,
  purities,
  pools,
  onClose,
  onDone,
  embedded,
}: {
  mode: "DIRECT" | "CUSTODY";
  customerId: string;
  purities: CustomerGoldTabData["purities"];
  pools: CustomerGoldPoolRow[];
  onClose: () => void;
  onDone: () => void;
  embedded?: boolean;
}) {
  const [previewState, previewAction, previewPending] = useActionState(previewCustomerGoldPurchaseAction, undefined);
  const [postState, postAction, postPending] = useActionState(purchaseCustomerGoldAction, undefined);
  const [, startTransition] = useTransition();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [poolKey, setPoolKey] = useState(pools[0] ? `${pools[0].purityId}|${pools[0].finenessPercent}` : "");
  const [purityId, setPurityId] = useState(mode === "CUSTODY" ? (pools[0]?.purityId ?? "") : (purities[0]?.id ?? ""));
  const [basis, setBasis] = useState<"GROSS" | "FINE">(mode === "CUSTODY" ? "FINE" : "GROSS");
  const [weight, setWeight] = useState("");
  const [all, setAll] = useState(false);
  const [rateBasis, setRateBasis] = useState("PER_FINE_GRAM");
  const [rate, setRate] = useState("");
  const [settlement, setSettlement] = useState("CREDIT_TO_INVOICE");
  const [purchaseDate, setPurchaseDate] = useState(today());
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [approved, setApproved] = useState(false);
  const [previewed, setPreviewed] = useState("");
  const current = JSON.stringify({ poolKey, purityId, basis, weight, all, rateBasis, rate, settlement, purchaseDate, reason, reference });
  const preview = previewState?.preview && previewed === current ? previewState.preview : null;
  useEffect(() => {
    if (postState?.success) onDone();
  }, [postState?.success, onDone]);
  const payload = (fingerprint: string) => {
    const fd = new FormData();
    fd.set("customerId", customerId);
    fd.set("source", mode);
    fd.set("purityId", mode === "CUSTODY" ? (poolKey.split("|")[0] ?? "") : purityId);
    if (mode === "CUSTODY") fd.set("finenessPercent", poolKey.split("|")[1] ?? "");
    fd.set("weightBasis", basis);
    if (!all) fd.set("weight", weight);
    fd.set("all", all ? "1" : "");
    fd.set("rateBasis", rateBasis);
    fd.set("rate", rate);
    fd.set("settlement", settlement);
    fd.set("purchaseDate", purchaseDate);
    fd.set("reason", reason);
    fd.set("reference", reference);
    fd.set("approved", approved ? "1" : "");
    fd.set("idempotencyKey", idempotencyKey);
    fd.set("previewFingerprint", fingerprint);
    return fd;
  };
  if (postState?.success) {
    return <Alert tone="success">Approved purchase posted — {postState.code}. The gold is now Company stock.</Alert>;
  }
  void mode;
  return (
    <form className={`${embedded ? "mt-4" : cardCls} flex flex-col gap-3`} data-testid="cg-purchase-form" onSubmit={(e) => e.preventDefault()}>
      {!embedded ? (
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold">Buy (part of) the Customer&apos;s safe balance</p>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-amber-700 dark:text-amber-400">
        A purchase/exchange is never automatic: the Company buys this gold from the Customer at the agreed value, with the Owner&apos;s approval. It becomes Company stock.
      </p>
      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {mode === "CUSTODY" ? (
          <label className="text-xs font-medium">
            Customer&apos;s gold in the safe
            <select aria-label="Customer's gold in the safe" value={poolKey} onChange={(e) => setPoolKey(e.target.value)} className={inputCls}>
              {pools.map((p) => (
                <option key={`${p.purityId}|${p.finenessPercent}`} value={`${p.purityId}|${p.finenessPercent}`}>
                  {p.purityDisplayName} ({p.finenessPercent}%) — {p.safe} g fine
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="text-xs font-medium">
            Company purity it is bought into
            <select aria-label="Company purity" value={purityId} onChange={(e) => setPurityId(e.target.value)} className={inputCls}>
              {purities.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.metalType} {p.displayName} ({p.finenessPercent}%)
                </option>
              ))}
            </select>
          </label>
        )}
        <Field label="Date" name="purchaseDate" type="date" value={purchaseDate} max={today()} onChange={(e) => setPurchaseDate(e.target.value)} />
        {mode === "CUSTODY" ? (
          <fieldset className="flex flex-col gap-1.5" disabled={all}>
            <legend className="text-sm font-medium">Weight entered as</legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" name="cgBuyBasis" checked={basis === "GROSS"} onChange={() => setBasis("GROSS")} className="h-4 w-4" /> Gross
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="cgBuyBasis" checked={basis === "FINE"} onChange={() => setBasis("FINE")} className="h-4 w-4" /> Fine
              </label>
            </div>
          </fieldset>
        ) : null}
        <Field
          label={mode === "CUSTODY" ? (basis === "FINE" ? "Fine weight bought (g)" : "Gross weight bought (g)") : "Gross weight bought (g)"}
          name="weight"
          type="number"
          step="0.001"
          min="0"
          value={all ? "" : weight}
          disabled={all}
          onChange={(e) => setWeight(e.target.value)}
        />
        {mode === "CUSTODY" ? (
          <label className="flex items-center gap-2 self-end pb-3 text-sm">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-4 w-4" /> All of the safe balance
          </label>
        ) : null}
        <label className="text-xs font-medium">
          Agreed rate
          <select aria-label="Rate basis" value={rateBasis} onChange={(e) => setRateBasis(e.target.value)} className={inputCls}>
            <option value="PER_FINE_GRAM">₹ per fine gram</option>
            <option value="PER_GROSS_GRAM">₹ per gross gram</option>
            <option value="FIXED_TOTAL">Fixed total ₹</option>
          </select>
        </label>
        <Field label={rateBasis === "FIXED_TOTAL" ? "Agreed total (₹)" : "Rate (₹)"} name="rate" type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} />
        <label className="text-xs font-medium">
          Settlement
          <select aria-label="Settlement" value={settlement} onChange={(e) => setSettlement(e.target.value)} className={inputCls}>
            <option value="CREDIT_TO_INVOICE">Credit against the Customer&apos;s jewellery bill</option>
            <option value="PAY_CUSTOMER">Pay the Customer (Payment Given)</option>
          </select>
        </label>
        <Field label="Reference (required — slip / register number)" name="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
      </div>
      <Field label="Reason (required)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      {preview ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/30" data-testid="cg-purchase-preview">
          <p className="font-medium">
            The Company buys <strong>{g(preview.fineWeight)} fine</strong> ({g(preview.grossWeight)} gross) of {preview.purityDisplayName} ({preview.finenessPercent}%) from {preview.customerName} for{" "}
            <strong>₹{preview.value}</strong>.
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            <li>Posts: Dr Metal Inventory ₹{preview.value} / Cr Accounts Payable ({preview.customerName}) ₹{preview.value}; the gold enters Company stock at ₹{preview.value}.</li>
            {preview.safeBefore && preview.safeAfter ? (
              <li>
                Customer&apos;s gold in the safe: {preview.safeBefore.fine} → {preview.safeAfter.fine} g fine
              </li>
            ) : null}
          </ul>
          <label className="mt-2 flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={approved} onChange={(e) => setApproved(e.target.checked)} className="h-4 w-4" aria-label="I approve this purchase" /> I approve buying this gold from the Customer at this value.
          </label>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          disabled={previewPending || postPending || reason.trim().length < 3 || reference.trim().length < 2 || !(Number(rate) > 0) || (!all && !(Number(weight) > 0))}
          onClick={() => {
            setPreviewed(current);
            setApproved(false);
            startTransition(() => previewAction(payload("")));
          }}
        >
          {previewPending ? "Checking…" : "Preview purchase"}
        </Button>
        {preview ? (
          <Button type="button" disabled={postPending || !approved} onClick={() => startTransition(() => postAction(payload(preview.fingerprint)))}>
            {postPending ? "Posting…" : "Approve and post purchase"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Statement (weights for all; money only when the server sent it)
// ---------------------------------------------------------------------------

function StatementView({ statement, isOwner, onDone }: { statement: CustomerGoldStatement; isOwner: boolean; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <div className={cardCls} data-testid="cg-pools">
        <p className="text-sm font-semibold">{statement.customer.name} — Customer gold balances (fine grams)</p>
        {statement.pools.length === 0 ? <p className="mt-2 text-sm text-zinc-500">No gold recorded for this Customer yet.</p> : null}
        {statement.pools.map((p) => (
          <div key={`${p.purityId}|${p.finenessPercent}`} className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-sm" data-testid={`cg-pool-${p.purityDisplayName}`}>
            <p className="font-medium">
              {p.metalType} {p.purityDisplayName} ({p.finenessPercent}%) — received {g(p.received)} fine ({g(p.receivedGross)} gross)
            </p>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              {(
                [
                  ["Unallocated (safe)", p.safe],
                  ["With Karigar", p.withKarigar],
                  ["On jobs", p.onJobs],
                  ["Finished, awaiting delivery", p.finishedAwaitingDelivery],
                  ["Delivered", p.delivered],
                  ["Returned to Customer", p.returnedToCustomer],
                  ["Authorised loss", p.authorisedLoss],
                  ["Scrap held", p.scrapHeld],
                  ["Bought by Company", p.boughtByCompany],
                  ["Remaining (Customer's, with us)", p.remaining],
                ] as const
              ).map(([label, v]) => (
                <div key={label} data-testid={`cg-${label}`}>
                  <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
                  <dd className="font-semibold">{g(v)}</dd>
                </div>
              ))}
            </dl>
            {p.byKarigar.length || p.byJob.length ? (
              <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">
                {p.byKarigar.map((k) => `${k.karigarName}: ${k.fine} g`).join(" · ")}
                {p.byKarigar.length && p.byJob.length ? " · " : ""}
                {p.byJob.map((j) => `${j.jobCode}: ${j.fine} g`).join(" · ")}
              </p>
            ) : null}
            {p.difference !== "0.000" ? <p className="mt-1 text-xs font-semibold text-red-600">Reconciliation difference: {p.difference} g</p> : null}
          </div>
        ))}
      </div>

      {statement.intakeReceipts.length ? (
        <div className={cardCls}>
          <p className="text-sm font-semibold">Gold received (acknowledgments)</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {statement.intakeReceipts.map((r) => (
              <li key={r.id}>
                <a className="font-medium underline underline-offset-2" href={`/customer-gold/receipt/${r.id}`} target="_blank" rel="noreferrer">
                  {r.receiptCode}
                </a>{" "}
                · {new Date(r.intakeDate).toLocaleDateString("en-IN")} · {r.statedPurity ? `stated ${r.statedPurity}, tested ` : ""}{r.purityDisplayName} ({r.finenessPercent}%) · gross {r.grossWeight} − {r.deductionWeight} = {r.netGrossWeight} g · fine {r.fineWeight} g
                {r.declaredValue ? ` · declared ₹${r.declaredValue} (not Company cost)` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={cardCls}>
        <p className="text-sm font-semibold">Customer gold statement</p>
        <ol className="mt-2 flex flex-col gap-2" data-testid="cg-statement">
          {statement.entries.map((e) => (
            <EntryRow key={e.id} entry={e} isOwner={isOwner} onDone={onDone} />
          ))}
        </ol>
      </div>

      {statement.pieces.length ? (
        <div className={cardCls}>
          <p className="text-sm font-semibold">Customer-owned jewellery</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="cg-pieces">
            {statement.pieces.map((p) => (
              <li key={p.id}>
                {p.finishedCode} ({p.jobCode}) · {p.status === "DELIVERED_TO_CUSTOMER" ? "Delivered" : p.status === "RECEIPT_REVERSED" ? "Receipt reversed" : "Awaiting delivery"} · net {p.netMetalWeight} g · Customer gold {p.customerGoldFineWeight} g fine
                {p.companyCost !== null ? ` · Company cost ₹${p.companyCost} (Customer gold ₹0 — excluded from Company material cost)` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {statement.credit ? (
        <div className={cardCls} data-testid="cg-credit">
          <p className="text-sm font-semibold">Gold-purchase credit (Owner)</p>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <div>
              <dt className="text-zinc-500 dark:text-zinc-400">Given by purchases / exchanges</dt>
              <dd className="font-semibold">₹{statement.credit.granted}</dd>
            </div>
            <div>
              <dt className="text-zinc-500 dark:text-zinc-400">Applied to bills</dt>
              <dd className="font-semibold">₹{statement.credit.applied}</dd>
            </div>
            <div>
              <dt className="text-zinc-500 dark:text-zinc-400">Still available</dt>
              <dd className="font-semibold" data-testid="cg-credit-available">
                ₹{statement.credit.available}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}

      {statement.purchases.length ? (
        <div className={cardCls}>
          <p className="text-sm font-semibold">Approved purchases / exchanges</p>
          <ul className="mt-2 flex flex-col gap-2 text-xs">
            {statement.purchases.map((p) => (
              <PurchaseRow key={p.purchaseCode} p={p} isOwner={isOwner} onDone={onDone} />
            ))}
          </ul>
        </div>
      ) : null}

      {statement.bills ? (
        <div className={cardCls}>
          <p className="text-sm font-semibold">Bills</p>
          {statement.bills.length === 0 ? <p className="mt-1 text-xs text-zinc-500">None yet (billed from the job page).</p> : null}
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {statement.bills.map((b) => (
              <li key={b.billCode}>
                {b.billCode} · {b.jobCode} · {b.status} · taxable ₹{b.taxableValue} + GST ₹{b.taxAmount} = ₹{b.grandTotal} · credit ₹{b.creditApplied} · due ₹{b.amountDue}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {statement.deliveries.length ? (
        <div className={cardCls}>
          <p className="text-sm font-semibold">Deliveries</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs">
            {statement.deliveries.map((d) => (
              <li key={d.deliveryCode}>
                {d.deliveryCode} · {new Date(d.date).toLocaleDateString("en-IN")} · {d.jobCode} · {d.status} · {d.pieces.join(", ")} · {d.customerGoldFine} g fine · received by {d.receivedByName} · by {d.deliveredBy}
                {d.reference ? ` · ${d.reference}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function EntryRow({ entry, isOwner, onDone }: { entry: CustomerGoldStatement["entries"][number]; isOwner: boolean; onDone: () => void }) {
  const [state, action, pending] = useActionState(reverseCustomerGoldEntryAction, undefined);
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs" data-testid={`cg-entry-${entry.entryCode}`}>
      <p>
        <span className="font-semibold">{entry.entryCode}</span> · {new Date(entry.date).toLocaleDateString("en-IN")} · {entry.kindLabel} · {entry.purityDisplayName} · <strong>{entry.fine} g fine</strong> ({entry.gross} g gross)
      </p>
      <p className="text-zinc-600 dark:text-zinc-400">
        {entry.fromLabel} → {entry.toLabel} · {entry.reason}
        {entry.reference ? ` · ${entry.reference}` : ""} · by {entry.actorName}
        {entry.reversedByCode ? ` · reversed by ${entry.reversedByCode}` : ""}
      </p>
      {isOwner && entry.canReverse ? (
        open ? (
          <div className="mt-2 flex flex-col gap-2">
            {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
            <Field label="Reason for reversing (at least 10 characters)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            <Button
              type="button"
              variant="danger"
              disabled={pending || reason.trim().length < 10}
              onClick={() => {
                const fd = new FormData();
                fd.set("entryId", entry.id);
                fd.set("reason", reason);
                fd.set("idempotencyKey", idempotencyKey);
                startTransition(() => action(fd));
              }}
            >
              {pending ? "Reversing…" : "Confirm reversal"}
            </Button>
          </div>
        ) : (
          <button type="button" className="mt-1 text-xs font-medium underline underline-offset-2" onClick={() => setOpen(true)}>
            Reverse this entry
          </button>
        )
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function Reports({ reports, isOwner }: { reports: CustomerGoldTabData["reports"]; isOwner: boolean }) {
  const t = reports.totals;
  return (
    <div className="flex flex-col gap-5">
      <div className={cardCls} data-testid="cg-reconciliation">
        <p className="text-sm font-semibold">All Customers — reconciliation (fine grams)</p>
        <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
          Received {t.received} = safe {t.safe} + with Karigars {t.withKarigar} + on jobs {t.onJobs} + finished awaiting delivery {t.finishedAwaitingDelivery} + delivered {t.delivered} + returned {t.returnedToCustomer} + authorised loss{" "}
          {t.authorisedLoss} + scrap held {t.scrapHeld} + bought by Company {t.boughtByCompany}
        </p>
        <p className={`mt-1 text-sm font-semibold ${t.difference === "0.000" ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}`} data-testid="cg-difference">
          Difference: {t.difference} g
        </p>
        <p className="mt-1 text-xs text-zinc-500">Company Metal Inventory, Jewellery WIP and Finished Stock are never changed by Customer gold (see Karigar Metal → Ledger reconciliation).</p>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div className={cardCls}>
          <p className="text-sm font-semibold">Customer gold with each Karigar</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="cg-karigar-wise">
            {reports.karigarWise.length === 0 ? <li className="text-zinc-500">None.</li> : null}
            {reports.karigarWise.map((r, i) => (
              <li key={i}>
                {r.karigarName} · {r.customerName} · {r.purityDisplayName} · {r.fine} g fine ({r.gross} g gross)
              </li>
            ))}
          </ul>
        </div>
        <div className={cardCls}>
          <p className="text-sm font-semibold">Job-wise Customer gold</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="cg-job-wise">
            {reports.jobWise.length === 0 ? <li className="text-zinc-500">None.</li> : null}
            {reports.jobWise.map((r) => (
              <li key={r.jobId}>
                <a className="underline underline-offset-2" href={`/jewellery-jobs?jobId=${r.jobId}`}>
                  {r.jobCode}
                </a>{" "}
                · {r.customerName} · on job {r.onJob} · used {r.consumed} · returned {r.returned} · scrap {r.scrap} · loss {r.loss} g fine
              </li>
            ))}
          </ul>
        </div>
        <div className={cardCls}>
          <p className="text-sm font-semibold">Customer jewellery awaiting delivery</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="cg-awaiting">
            {reports.awaiting.length === 0 ? <li className="text-zinc-500">None.</li> : null}
            {reports.awaiting.map((r) => (
              <li key={r.id}>
                {r.finishedCode} ·{" "}
                <a className="underline underline-offset-2" href={`/jewellery-jobs?jobId=${r.jobId}`}>
                  {r.jobCode}
                </a>{" "}
                · {r.customerName} · net {r.netMetalWeight} g · Customer gold {r.customerGoldFineWeight} g fine
                {isOwner && r.companyCost !== null ? ` · Company cost ₹${r.companyCost}` : ""}
              </li>
            ))}
          </ul>
        </div>
        <div className={cardCls}>
          <p className="text-sm font-semibold">Exceptions to resolve</p>
          <ul className="mt-2 flex flex-col gap-1 text-xs" data-testid="cg-exceptions">
            {reports.exceptions.length === 0 ? <li className="text-emerald-700 dark:text-emerald-400">None.</li> : null}
            {reports.exceptions.map((x, i) => (
              <li key={i}>{x.detail}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
