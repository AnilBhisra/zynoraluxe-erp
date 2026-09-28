"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState, useTransition } from "react";

import { postCustodyAction, previewCustodyAction, reverseCustodyAction, type CustodyPreview } from "@/app/actions/karigarCustody";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import type { KarigarMetalAccount, KarigarStatementRow } from "@/lib/jewellery/karigarCustodyReports";

export type CustodyKind = "ISSUE_TO_KARIGAR" | "RETURN_TO_STOCK" | "ALLOCATE_TO_JOB" | "RELEASE_FROM_JOB";
export type IssuePurityOption = { id: string; label: string; stockGross: string };

const OP_TITLE: Record<CustodyKind, string> = {
  ISSUE_TO_KARIGAR: "Issue metal to Karigar",
  ALLOCATE_TO_JOB: "Allocate to a job",
  RETURN_TO_STOCK: "Return unused metal to stock",
  RELEASE_FROM_JOB: "Release unused metal from a job",
};
const OP_HELP: Record<CustodyKind, string> = {
  ISSUE_TO_KARIGAR: "Company metal leaves stock and is held by this Karigar, not yet on any job. It is not a purchase and not customer gold.",
  ALLOCATE_TO_JOB: "Moves part or all of the Karigar's unallocated metal onto one of the Karigar's own jobs. Allocation is not consumption — the job still has to be received.",
  RETURN_TO_STOCK: "The Karigar physically hands back unallocated metal. It goes back into company stock at its carrying value.",
  RELEASE_FROM_JOB:
    "Moves a job's unused, unresolved metal back to the Karigar's unallocated balance. The metal does NOT come back to stock — it stays with the Karigar. Received, returned and consumed metal is never touched.",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  MATERIALS_ISSUED: "Materials Issued",
  IN_PROGRESS: "In Progress",
  PARTIALLY_RECEIVED: "Partially Received",
  NEEDS_CORRECTION: "Needs Correction",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN");

export function KarigarMetalAccountView({
  account,
  isOwner,
  issuePurities,
  initialOp = null,
  initialJobId = null,
}: {
  account: KarigarMetalAccount;
  isOwner: boolean;
  /** Owner only; empty for Staff. */
  issuePurities: IssuePurityOption[];
  initialOp?: CustodyKind | null;
  initialJobId?: string | null;
}) {
  const router = useRouter();
  const [op, setOp] = useState<{ kind: CustodyKind; jobId: string | null; nonce: number } | null>(
    isOwner && initialOp ? { kind: initialOp, jobId: initialJobId, nonce: 0 } : null
  );
  const open = (kind: CustodyKind, jobId: string | null = null) => setOp((cur) => ({ kind, jobId, nonce: (cur?.nonce ?? 0) + 1 }));
  const hasUnallocated = account.byPurity.some((p) => Number(p.unallocatedGross) > 0);
  const releasable = account.jobs.filter((j) => j.canRelease);
  const allocatable = account.jobs.filter((j) => j.canAllocate);

  return (
    <div className="flex flex-col gap-5" data-testid="karigar-metal-account">
      <a href="/jewellery-jobs?tab=karigar" className="text-sm font-medium text-zinc-700 underline underline-offset-4 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100">
        ← All Karigars
      </a>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          {account.karigarName} — metal account{!account.karigarActive ? " (inactive)" : ""}
        </h2>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Company metal with this Karigar. Gold is reconciled on fine weight; each purity is kept separately and never converted.
        </p>

        {account.byPurity.length === 0 ? (
          <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">This Karigar holds no company metal right now.</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            {account.byPurity.map((p) => (
              <div key={p.purityId} className="rounded-xl border border-[var(--border)] bg-[var(--surface-muted)] p-3" data-testid={`custody-purity-${p.purityDisplayName}`}>
                <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
                  {p.purityDisplayName}
                  {p.finenessPercent ? <span className="ml-1 text-xs font-normal text-zinc-500 dark:text-zinc-400">({p.finenessPercent}% saved fineness)</span> : null}
                </p>
                <dl className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
                  <Figure label="Unallocated (not on any job)" value={`Gross ${p.unallocatedGross} g`} sub={`Fine ${p.unallocatedFine} g${p.unallocatedCost !== null ? ` · ${money(p.unallocatedCost)}` : ""}`} testId="unallocated" />
                  <Figure label="Allocated, pending on jobs" value={`Fine ${p.allocatedPendingFine} g`} sub={`Gross ≈ ${p.allocatedPendingGross} g (jobs reconcile on fine)`} testId="allocated" />
                  <Figure label="Total with Karigar" value={`Fine ${p.totalWithKarigarFine} g`} sub={`Gross ≈ ${p.totalWithKarigarGross} g`} testId="total" strong />
                </dl>
              </div>
            ))}
          </div>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-5">
          <Figure label="Received in finished pieces" value={`${account.outcomes.receivedFinishedFine}g fine`} />
          <Figure label="Usable metal returned (receipts)" value={`${account.outcomes.returnedUsableFine}g fine`} />
          <Figure label="Scrap returned" value={`${account.outcomes.scrapFine}g fine`} />
          <Figure label="Confirmed loss (normal)" value={`${account.outcomes.confirmedNormalLossFine}g fine`} />
          <Figure label="Confirmed loss (abnormal)" value={`${account.outcomes.confirmedAbnormalLossFine}g fine`} />
          {isOwner && account.labourCharged !== null ? <Figure label="Labour / charges on receipts" value={money(account.labourCharged)} /> : null}
          {isOwner && account.payableBalance !== null ? <Figure label="Payable to Karigar (ledger)" value={money(account.payableBalance)} /> : null}
        </dl>
      </div>

      {isOwner ? (
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
          <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Owner actions</h3>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="md" variant={op?.kind === "ISSUE_TO_KARIGAR" ? "primary" : "secondary"} onClick={() => open("ISSUE_TO_KARIGAR")} disabled={!account.karigarActive}>
              Issue metal to Karigar
            </Button>
            <Button type="button" size="md" variant={op?.kind === "ALLOCATE_TO_JOB" ? "primary" : "secondary"} onClick={() => open("ALLOCATE_TO_JOB")} disabled={!hasUnallocated || allocatable.length === 0}>
              Allocate to job
            </Button>
            <Button type="button" size="md" variant={op?.kind === "RETURN_TO_STOCK" ? "primary" : "secondary"} onClick={() => open("RETURN_TO_STOCK")} disabled={!hasUnallocated}>
              Return to stock
            </Button>
            <Button type="button" size="md" variant={op?.kind === "RELEASE_FROM_JOB" ? "primary" : "secondary"} onClick={() => open("RELEASE_FROM_JOB")} disabled={releasable.length === 0}>
              Release from job
            </Button>
          </div>
          {hasUnallocated && allocatable.length === 0 ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">No open job of this Karigar can take metal — create a Jewellery Job for this Karigar first.</p>
          ) : null}
          {op ? (
            <CustodyForm
              key={`${op.kind}-${op.nonce}`}
              kind={op.kind}
              account={account}
              issuePurities={issuePurities}
              initialJobId={op.jobId}
              onClose={() => setOp(null)}
              onDone={() => router.refresh()}
            />
          ) : null}
        </div>
      ) : null}

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Jobs of this Karigar</h3>
        {account.jobs.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No open jobs.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {account.jobs.map((j) => (
              <li key={j.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs text-zinc-700 dark:text-zinc-300" data-testid={`custody-job-${j.jobCode}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p>
                    <a href={`/jewellery-jobs?jobId=${j.id}`} className="font-semibold text-zinc-900 underline underline-offset-4 dark:text-zinc-50">
                      {j.jobCode}
                    </a>{" "}
                    · {j.designName} · {STATUS_LABELS[j.status] ?? j.status}
                  </p>
                  {isOwner ? (
                    <div className="flex flex-wrap gap-2">
                      {j.canAllocate && hasUnallocated ? (
                        <Button type="button" size="md" variant="secondary" onClick={() => open("ALLOCATE_TO_JOB", j.id)}>
                          Allocate here
                        </Button>
                      ) : null}
                      {j.canRelease ? (
                        <Button type="button" size="md" variant="ghost" onClick={() => open("RELEASE_FROM_JOB", j.id)}>
                          Release unused
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <p className="mt-1">
                  {j.purityDisplayName ?? "No metal yet"} · pending {j.pendingFine}g fine{j.pendingGross ? ` (≈${j.pendingGross}g gross)` : ""}
                  {isOwner && j.remainingWipCost !== null ? ` · WIP ₹${j.remainingWipCost}` : ""}
                </p>
                {j.allocatedFromCustodyFine !== "0.000" || j.releasedToCustodyFine !== "0.000" ? (
                  <p className="text-zinc-500 dark:text-zinc-400">
                    From Karigar balance: {j.allocatedFromCustodyFine}g fine · released back: {j.releasedToCustodyFine}g fine
                  </p>
                ) : null}
                {j.canIssueMaterials && j.status !== "DRAFT" ? (
                  <p className="text-zinc-500 dark:text-zinc-400">Diamonds and other material can still be issued to this job from its page.</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-6">
        <h3 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-300">Statement (unallocated metal)</h3>
        {account.statement.length === 0 ? (
          <p className="text-sm text-zinc-600 dark:text-zinc-400">No custody entries yet.</p>
        ) : (
          <ol className="flex flex-col gap-2" data-testid="custody-statement">
            {[...account.statement].reverse().map((s) => (
              <StatementRow key={s.id} row={s} isOwner={isOwner} onDone={() => router.refresh()} />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function money(value: string): string {
  return /^-?\d/.test(value) ? `₹${value}` : value;
}

function Figure({ label, value, sub, strong, testId }: { label: string; value: string; sub?: string; strong?: boolean; testId?: string }) {
  return (
    <div data-testid={testId}>
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className={`${strong ? "font-semibold text-zinc-900 dark:text-zinc-50" : "font-medium text-zinc-800 dark:text-zinc-200"} text-sm`}>{value}</dd>
      {sub ? <dd className="text-zinc-500 dark:text-zinc-400">{sub}</dd> : null}
    </div>
  );
}

function CustodyForm({
  kind,
  account,
  issuePurities,
  initialJobId,
  onClose,
  onDone,
}: {
  kind: CustodyKind;
  account: KarigarMetalAccount;
  issuePurities: IssuePurityOption[];
  initialJobId: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [previewState, previewAction, previewPending] = useActionState(previewCustodyAction, undefined);
  const [postState, postAction, postPending] = useActionState(postCustodyAction, undefined);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const custodyPurities = account.byPurity.filter((p) => Number(p.unallocatedGross) > 0);
  const jobChoices = kind === "ALLOCATE_TO_JOB" ? account.jobs.filter((j) => j.canAllocate) : kind === "RELEASE_FROM_JOB" ? account.jobs.filter((j) => j.canRelease) : [];
  const purityChoices = kind === "ISSUE_TO_KARIGAR" ? issuePurities.map((p) => ({ id: p.id, label: `${p.label} — ${p.stockGross}g in stock` })) : custodyPurities.map((p) => ({ id: p.purityId, label: `${p.purityDisplayName} — ${p.unallocatedGross}g unallocated` }));

  const [purityId, setPurityId] = useState(purityChoices[0]?.id ?? "");
  const [jobId, setJobId] = useState(initialJobId ?? jobChoices[0]?.id ?? "");
  const [weight, setWeight] = useState("");
  const [weightBasis, setWeightBasis] = useState<"GROSS" | "FINE">("GROSS");
  const [all, setAll] = useState(false);
  const [entryDate, setEntryDate] = useState(today());
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [previewedInputs, setPreviewedInputs] = useState("");
  const current = JSON.stringify({ purityId, jobId, weight, weightBasis, all, entryDate, reason, reference });
  const preview = previewState?.preview;
  const fresh = Boolean(preview) && previewedInputs === current;
  const needsPurity = kind !== "RELEASE_FROM_JOB";
  const needsJob = kind === "ALLOCATE_TO_JOB" || kind === "RELEASE_FROM_JOB";
  const allowAll = kind !== "ISSUE_TO_KARIGAR";
  const minReason = kind === "RELEASE_FROM_JOB" ? 10 : 3;
  const ready = (!needsPurity || purityId) && (!needsJob || jobId) && (all || Number(weight) > 0) && reason.trim().length >= minReason && entryDate;

  useEffect(() => {
    if (postState?.success) onDone();
  }, [postState?.success, onDone]);

  const selectedJob = useMemo(() => account.jobs.find((j) => j.id === jobId), [account.jobs, jobId]);
  const [, startTransition] = useTransition();

  // Both actions are dispatched with a payload built from React state, never
  // by submitting the <form>: React resets a form after its action returns,
  // which snapped the selects back to another job while the preview on screen
  // still described the first one (the fingerprint check refused the post).
  const payload = (fingerprint: string) => {
    const fd = new FormData();
    fd.set("kind", kind);
    fd.set("karigarId", account.karigarId);
    fd.set("idempotencyKey", idempotencyKey);
    fd.set("previewFingerprint", fingerprint);
    fd.set("all", all ? "1" : "");
    if (needsPurity) fd.set("purityId", purityId);
    if (needsJob) fd.set("jobId", jobId);
    fd.set("weightBasis", weightBasis);
    if (!all) fd.set("weight", weight);
    fd.set("entryDate", entryDate);
    fd.set("reason", reason);
    fd.set("reference", reference);
    return fd;
  };

  if (postState?.success) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <Alert tone="success">
          {postState.replayed ? "This entry was already posted" : "Posted"} — {postState.code}.
        </Alert>
        <Button type="button" size="md" variant="ghost" onClick={onClose} className="self-start">
          Close
        </Button>
      </div>
    );
  }

  return (
    <form className="mt-4 flex flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4" data-testid="custody-form" onSubmit={(e) => e.preventDefault()}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{OP_TITLE[kind]}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{OP_HELP[kind]}</p>
        </div>
        <Button type="button" size="md" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {previewState?.error ? <Alert tone="error">{previewState.error}</Alert> : null}
      {postState?.error ? <Alert tone="error">{postState.error}</Alert> : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {needsPurity ? (
          <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Metal and purity
            <select name="purityId" value={purityId} onChange={(e) => setPurityId(e.target.value)} className="mt-1 h-11 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100">
              {purityChoices.length === 0 ? <option value="">Nothing available</option> : null}
              {purityChoices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {needsJob ? (
          <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Job (this Karigar only)
            <select name="jobId" value={jobId} onChange={(e) => setJobId(e.target.value)} className="mt-1 h-11 w-full rounded-lg border border-zinc-300 bg-white px-2 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100">
              {jobChoices.length === 0 ? <option value="">No eligible job</option> : null}
              {jobChoices.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.jobCode} — {j.designName}
                  {kind === "RELEASE_FROM_JOB" ? ` (${j.pendingFine}g fine pending)` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <fieldset className="flex flex-col gap-1.5" disabled={all}>
          <legend className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Weight entered as</legend>
          <div className="flex flex-wrap gap-4 text-sm text-zinc-700 dark:text-zinc-300">
            <label className="flex items-center gap-2">
              <input type="radio" name="weightBasis" value="GROSS" checked={weightBasis === "GROSS"} onChange={() => setWeightBasis("GROSS")} className="h-4 w-4" />
              Gross grams (as weighed)
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="weightBasis" value="FINE" checked={weightBasis === "FINE"} onChange={() => setWeightBasis("FINE")} className="h-4 w-4" />
              Fine grams (pure metal)
            </label>
          </div>
        </fieldset>
        <Field
          label={weightBasis === "FINE" ? "Fine weight (g, pure metal)" : "Gross weight (g, as weighed)"}
          name="weight"
          type="number"
          step="0.001"
          min="0"
          inputMode="decimal"
          value={all ? "" : weight}
          onChange={(e) => setWeight(e.target.value)}
          disabled={all}
          hint={
            kind === "RELEASE_FROM_JOB" && selectedJob
              ? `Pending on this job: fine ${selectedJob.pendingFine} g${selectedJob.pendingGross ? ` (gross ≈ ${selectedJob.pendingGross} g)` : ""}`
              : "The other unit is worked out from the saved fineness and shown in the preview."
          }
        />
        {allowAll ? (
          <label className="flex items-center gap-2 self-end pb-3 text-sm text-zinc-700 dark:text-zinc-300">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} className="h-4 w-4" />
            All of it (carries the exact remaining value)
          </label>
        ) : null}
        <Field label="Date" name="entryDate" type="date" value={entryDate} max={today()} onChange={(e) => setEntryDate(e.target.value)} required />
        <Field label="Reference (optional)" name="reference" value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} placeholder="e.g. slip no." />
      </div>
      <Field
        label={`Reason (required, at least ${minReason} characters)`}
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        minLength={minReason}
        maxLength={500}
      />

      {preview && fresh ? <PreviewBox preview={preview} kind={kind} /> : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          size="md"
          disabled={previewPending || postPending || !ready}
          onClick={() => {
            setPreviewedInputs(current);
            startTransition(() => previewAction(payload("")));
          }}
        >
          {previewPending ? "Preparing…" : "Preview"}
        </Button>
        {preview && fresh ? (
          <Button
            type="button"
            size="md"
            disabled={postPending || previewPending}
            onClick={() => {
              if (!window.confirm(`${preview.kindLabel}: gross ${preview.grossWeight} g / fine ${preview.fineWeight} g of ${preview.purityDisplayName}${preview.jobCode ? ` — ${preview.jobCode}` : ""}.\n\nPost this entry?`)) {
                return;
              }
              startTransition(() => postAction(payload(preview.fingerprint)));
            }}
          >
            {postPending ? "Posting…" : "Confirm and post"}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function PreviewBox({ preview, kind }: { preview: CustodyPreview; kind: CustodyKind }) {
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30" data-testid="custody-preview">
      <p className="font-medium text-zinc-900 dark:text-zinc-50">
        Preview — nothing is saved yet. {preview.kindLabel}: gross {preview.grossWeight} g / fine {preview.fineWeight} g of {preview.purityDisplayName} ({preview.finenessPercent}% saved fineness)
        {preview.jobCode ? ` — ${preview.jobCode}` : ""}, carrying ₹{preview.costValue}
        {preview.isFull ? " (the exact remaining value)" : ""}.
      </p>
      <ul className="mt-2 list-disc pl-5 text-xs text-zinc-700 dark:text-zinc-300">
        <li data-testid="custody-preview-basis">
          {preview.enteredWeightBasis === "FINE"
            ? `You entered FINE ${preview.fineWeight} g; gross ${preview.grossWeight} g is worked out at ${preview.finenessPercent}%.`
            : preview.enteredWeightBasis === "GROSS"
              ? `You entered GROSS ${preview.grossWeight} g; fine ${preview.fineWeight} g is worked out at ${preview.finenessPercent}%.`
              : `The whole balance: gross ${preview.grossWeight} g / fine ${preview.fineWeight} g.`}
        </li>
        <li>
          {preview.karigarName}&apos;s unallocated {preview.purityDisplayName}: {preview.custodyBefore.gross}g → {preview.custodyAfter.gross}g gross ({preview.custodyBefore.fine}g → {preview.custodyAfter.fine}g fine; ₹{preview.custodyBefore.cost} → ₹{preview.custodyAfter.cost})
        </li>
        {preview.stockBefore && preview.stockAfter ? (
          <li>
            Company stock: {preview.stockBefore.gross}g → {preview.stockAfter.gross}g (₹{preview.stockBefore.cost} → ₹{preview.stockAfter.cost})
          </li>
        ) : null}
        {preview.jobBefore && preview.jobAfter ? (
          <li>
            {preview.jobCode}: pending {preview.jobBefore.pendingFine}g → {preview.jobAfter.pendingFine}g fine; WIP ₹{preview.jobBefore.wip} → ₹{preview.jobAfter.wip}
          </li>
        ) : null}
        <li>
          {preview.postsVoucher
            ? kind === "ISSUE_TO_KARIGAR"
              ? "Posts one voucher: Dr Jewellery WIP / Cr Metal Inventory."
              : "Posts one voucher: Dr Metal Inventory / Cr Jewellery WIP."
            : "No voucher — the value stays in Jewellery WIP; only who holds it for which job changes."}
        </li>
      </ul>
    </div>
  );
}

function StatementRow({ row, isOwner, onDone }: { row: KarigarStatementRow; isOwner: boolean; onDone: () => void }) {
  const [state, action, pending] = useActionState(reverseCustodyAction, undefined);
  const [openReverse, setOpenReverse] = useState(false);
  const [reason, setReason] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (state?.success) onDone();
  }, [state?.success, onDone]);

  const sign = row.direction === 1 ? "+" : "−";
  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] p-3 text-xs text-zinc-700 dark:text-zinc-300" data-testid={`custody-entry-${row.entryCode}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium text-zinc-900 dark:text-zinc-50">
          {fmtDate(row.entryDate)} · {row.entryCode} · {row.kindLabel}
          {row.jobCode ? (
            <>
              {" "}
              ·{" "}
              <a href={`/jewellery-jobs?jobId=${row.jobId}`} className="underline underline-offset-4">
                {row.jobCode}
              </a>
            </>
          ) : null}
        </p>
        <p className="font-semibold">
          {sign}
          gross {row.grossWeight} g / {sign}fine {row.fineWeight} g {row.purityDisplayName}
        </p>
      </div>
      <p className="mt-1">
        Unallocated after: gross {row.unallocatedGrossAfter} g / fine {row.unallocatedFineAfter} g{row.enteredAs ? ` · entered as ${row.enteredAs}` : ""}
        {isOwner && row.costValue !== null ? ` · ₹${row.costValue}` : ""}
        {isOwner && row.voucherNumber ? ` · voucher ${row.voucherNumber}` : ""}
      </p>
      <p className="text-zinc-500 dark:text-zinc-400">
        By {row.createdByName} on {new Date(row.createdAt).toLocaleString("en-IN")} — {row.reason}
        {row.reference ? ` (ref ${row.reference})` : ""}
        {row.reversalOfCode ? ` — reverses ${row.reversalOfCode}` : ""}
        {row.reversedByCode ? ` — reversed by ${row.reversedByCode}` : ""}
      </p>
      {isOwner && !row.isReversal && !row.reversedByCode ? (
        state?.success ? (
          <Alert tone="success">Reversed — {state.code}.</Alert>
        ) : row.canReverse ? (
          openReverse ? (
            <form
              action={action}
              className="mt-2 flex flex-col gap-2"
              onSubmit={(e) => {
                if (!window.confirm(`Reverse ${row.entryCode}? Every balance it moved goes back exactly; the original stays on record.`)) e.preventDefault();
              }}
            >
              <input type="hidden" name="entryId" value={row.id} />
              <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
              {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
              <Field label="Reason for reversing (at least 10 characters)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} maxLength={500} />
              <div className="flex gap-2">
                <Button type="submit" variant="danger" size="md" disabled={pending || reason.trim().length < 10}>
                  {pending ? "Reversing…" : "Confirm reversal"}
                </Button>
                <Button type="button" variant="ghost" size="md" onClick={() => setOpenReverse(false)}>
                  Back
                </Button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => setOpenReverse(true)} className="mt-1 font-medium text-red-700 underline underline-offset-4 dark:text-red-400">
              Reverse this entry
            </button>
          )
        ) : row.reverseBlockedReason ? (
          <p className="mt-1 text-amber-700 dark:text-amber-400">Cannot be reversed now: {row.reverseBlockedReason}</p>
        ) : null
      ) : null}
    </li>
  );
}
