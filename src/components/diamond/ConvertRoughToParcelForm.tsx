"use client";

import { useActionState, useState, useTransition } from "react";

import {
  convertRoughStoneToParcelAction,
  previewRoughStoneToParcelAction,
  type DiamondFormState,
  type SerializedRoughConversionPreview,
} from "@/app/actions/diamond";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";

function money(v: string) {
  return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const inputClass =
  "mt-1 h-9 w-full rounded-lg border border-zinc-300 bg-white px-2.5 text-sm dark:bg-zinc-900 dark:border-zinc-600 dark:text-zinc-100";

/**
 * Owner-only, audited: a rough row bought as a single stone that is really a
 * parcel of many stones becomes a parcel in place, so it can be issued in
 * part. Two steps — the Owner previews the real record (and what does NOT
 * change) before confirming; the confirm sends back the previewed carat/cost
 * so a change in between is refused rather than applied unseen.
 */
export function ConvertRoughToParcelForm({
  roughPieceId,
  roughCode,
  onDone,
}: {
  roughPieceId: string;
  roughCode: string;
  /** Called with the rough code once converted. The row re-renders as a parcel
   * (and this form unmounts), so the parent shows the lasting confirmation. */
  onDone?: (roughCode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pieceCount, setPieceCount] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<SerializedRoughConversionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, startPreview] = useTransition();
  // Notify the parent as the action resolves, not from an effect: the action's
  // revalidation re-renders this row as a parcel in the same commit, which
  // unmounts this form before any effect of it could run.
  const [state, formAction, pending] = useActionState(async (prev: DiamondFormState, formData: FormData) => {
    const result = await convertRoughStoneToParcelAction(prev, formData);
    if (result?.success) onDone?.(result.code ?? roughCode);
    return result;
  }, undefined);

  if (state?.success) {
    return <span className="text-xs font-medium text-emerald-700 dark:text-emerald-400">{roughCode} is now a parcel — it can be issued in part.</span>;
  }

  if (!open) {
    return (
      <Button type="button" variant="secondary" size="md" onClick={() => setOpen(true)}>
        Convert to parcel
      </Button>
    );
  }

  const countError = pieceCount !== "" && (!/^\d+$/.test(pieceCount) || Number(pieceCount) < 2) ? "A parcel holds at least 2 stones — or leave it blank." : null;
  const reasonTooShort = reason.trim().length < 10;

  function runPreview() {
    setPreviewError(null);
    startPreview(async () => {
      const result = await previewRoughStoneToParcelAction(roughPieceId);
      if (result.error || !result.preview) {
        setPreviewError(result.error ?? "Could not load the preview.");
        return;
      }
      setPreview(result.preview);
    });
  }

  return (
    <div className="flex w-full max-w-xl flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-left dark:border-amber-900 dark:bg-amber-950/30">
      {!preview ? (
        <>
          <p className="text-xs text-zinc-700 dark:text-zinc-300">
            Only use this if {roughCode} really is a parcel of many rough stones. Its carat, cost, purchase and supplier balance stay exactly as recorded.
          </p>
          <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Number of stones in the parcel (optional — leave blank if not counted)
            <input name="pieceCountDraft" inputMode="numeric" value={pieceCount} onChange={(e) => setPieceCount(e.target.value.trim())} className={inputClass} />
          </label>
          {countError ? <p className="text-xs text-red-600 dark:text-red-400">{countError}</p> : null}
          <label className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Reason (required, at least 10 characters)
            <input
              name="reasonDraft"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Saved as one stone by mistake; it is a parcel of many rough stones"
              className={inputClass}
            />
          </label>
          {previewError ? <Alert tone="error">{previewError}</Alert> : null}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" size="md" disabled={previewing || !!countError || reasonTooShort} onClick={runPreview}>
              {previewing ? "Loading preview…" : "Preview conversion"}
            </Button>
            <Button type="button" variant="ghost" size="md" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <form action={formAction} className="flex flex-col gap-2" data-testid="rough-conversion-preview">
          <input type="hidden" name="roughPieceId" value={roughPieceId} />
          <input type="hidden" name="pieceCount" value={pieceCount} />
          <input type="hidden" name="reason" value={reason} />
          <input type="hidden" name="expectedCarat" value={preview.carat} />
          <input type="hidden" name="expectedCost" value={preview.allocatedCost} />
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Preview — {preview.roughCode}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs text-zinc-700 dark:text-zinc-300">
            <dt className="text-zinc-500">Lot</dt>
            <dd>{preview.lotCode ?? "—"}{preview.purchaseDate ? ` · bought ${new Date(preview.purchaseDate).toLocaleDateString("en-IN")}` : ""}</dd>
            <dt className="text-zinc-500">Supplier</dt>
            <dd>{preview.supplierName ?? "—"}</dd>
            <dt className="text-zinc-500">Purchase voucher</dt>
            <dd>{preview.purchaseVoucherNumber ?? "—"} (unchanged)</dd>
            <dt className="text-zinc-500">Recorded as</dt>
            <dd>
              {preview.kind === "STONE" ? "Stone (issue whole)" : "Parcel"} → <strong>Parcel</strong>
              {pieceCount ? ` of ${pieceCount} stones` : " (stone count not recorded)"}
            </dd>
            <dt className="text-zinc-500">Carat</dt>
            <dd>{preview.carat}ct (unchanged)</dd>
            <dt className="text-zinc-500">Cost</dt>
            <dd>{money(preview.allocatedCost)} (unchanged; becomes the parcel&apos;s as-bought cost)</dd>
            <dt className="text-zinc-500">Issue history</dt>
            <dd>{preview.issueHistory.length ? preview.issueHistory.join(", ") : "Never issued"}</dd>
            <dt className="text-zinc-500">Reason</dt>
            <dd>{reason.trim()}</dd>
          </dl>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            No new purchase, voucher, journal entry, supplier payable or stock movement is created. The original purchase record stays as it is, and this conversion is recorded with your name, the date and the reason.
          </p>
          {preview.refusal ? <Alert tone="error">{preview.refusal}</Alert> : null}
          {state?.error ? <Alert tone="error">{state.error}</Alert> : null}
          <div className="flex gap-2">
            {!preview.refusal ? (
              <Button type="submit" variant="primary" size="md" disabled={pending}>
                {pending ? "Converting…" : "Confirm conversion"}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="md" disabled={pending} onClick={() => setPreview(null)}>
              Back
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
