"use client";

import { useRef, useState } from "react";

import { uploadCostingPhotoAction, deleteCostingPhotoAction } from "@/app/actions/costing";
import { describeUploadFailure, ImagePrepError, newUploadRef, prepareImageForUpload, type PreparedImage } from "@/lib/client/prepareImage";
import { ClientTimeoutError, UPLOAD_CLIENT_TIMEOUT_MS, withClientTimeout } from "@/lib/client/uploadTimeout";
import { useLocalPreview } from "@/lib/client/useLocalPreview";

function fireAndForgetDelete(assetId: string) {
  const formData = new FormData();
  formData.set("assetId", assetId);
  void deleteCostingPhotoAction(formData);
}

/** Same pattern as src/components/jewellery/PhotoUploadField.tsx, but
 * calling Costing's OWN Owner-gated upload/delete actions rather than
 * the Jewellery module's requireUser()-gated ones — every Costing action
 * independently enforces Owner-only, including image uploads. */
export function CostingPhotoUploadField({
  label,
  assetId,
  onUploaded,
}: {
  label: string;
  assetId: string | null;
  onUploaded: (assetId: string | null) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every new attempt so a late-arriving result from an earlier,
  // already-timed-out attempt can never clobber a newer attempt's state
  // (re-enable a stale spinner, or apply a stale success/error) — see
  // src/lib/client/uploadTimeout.ts.
  const attemptRef = useRef(0);
  const [previewUrl, setPreview] = useLocalPreview();

  async function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const attempt = ++attemptRef.current;
    const ref = newUploadRef();
    setPending(true);
    setError(null);

    // Large laptop/phone photos are scaled down first — see src/lib/client/prepareImage.ts.
    let prepared: PreparedImage;
    try {
      prepared = await prepareImageForUpload(file);
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setPending(false);
      setError(err instanceof ImagePrepError ? err.message : `This photo could not be read. Choose it again. (ref ${ref})`);
      return;
    }
    if (attempt !== attemptRef.current) return; // superseded while preparing — never send it

    const formData = new FormData();
    formData.set("file", prepared.file);
    formData.set("uploadRef", ref);

    try {
      const result = await withClientTimeout(
        uploadCostingPhotoAction(undefined, formData),
        UPLOAD_CLIENT_TIMEOUT_MS,
        `Upload timed out. Check your connection and try again. (ref ${ref})`
      );
      if (attempt !== attemptRef.current) {
        if (result?.success && result.assetId) fireAndForgetDelete(result.assetId);
        return;
      }
      setPending(false);
      if (result?.success && result.assetId) {
        if (assetId) fireAndForgetDelete(assetId);
        setPreview(prepared.file);
        onUploaded(result.assetId);
      } else {
        setError(result?.error ?? `Upload failed. (ref ${ref})`);
      }
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setPending(false);
      setError(err instanceof ClientTimeoutError ? err.message : describeUploadFailure(err, prepared.sentBytes, ref));
    }
  }

  function handleRemove() {
    if (assetId) fireAndForgetDelete(assetId);
    setPreview(null);
    onUploaded(null);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{label}</span>
      <div className="flex items-center gap-2">
        <label className="inline-flex h-9 cursor-pointer items-center rounded-lg border border-zinc-300 px-3 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">
          {pending ? "Uploading…" : assetId ? "Replace photo" : "Upload photo"}
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleChange} disabled={pending} className="hidden" />
        </label>
        {assetId ? (
          <>
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- local object URL preview of the file just uploaded
              <img src={previewUrl} alt={`${label} preview`} className="h-12 w-12 rounded-lg border border-zinc-200 object-cover dark:border-zinc-700" data-testid="upload-preview" />
            ) : null}
            <span className="text-xs text-emerald-700 dark:text-emerald-400">Uploaded</span>
            <button type="button" onClick={handleRemove} className="text-xs font-medium text-red-600 hover:underline dark:text-red-400">
              Remove
            </button>
          </>
        ) : null}
      </div>
      {error ? <p className="text-xs font-medium text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
