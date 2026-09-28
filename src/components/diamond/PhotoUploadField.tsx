"use client";

import { useRef, useState } from "react";

import { deleteDiamondPhotoAction, uploadDiamondPhotoAction } from "@/app/actions/diamond";
import { describeUploadFailure, ImagePrepError, newUploadRef, prepareImageForUpload, type PreparedImage } from "@/lib/client/prepareImage";
import { ClientTimeoutError, UPLOAD_CLIENT_TIMEOUT_MS, withClientTimeout } from "@/lib/client/uploadTimeout";
import { useLocalPreview } from "@/lib/client/useLocalPreview";
import type { DiamondAssetCategory } from "@/lib/storage/diamondMedia";

function fireAndForgetDelete(assetId: string) {
  const formData = new FormData();
  formData.set("assetId", assetId);
  void deleteDiamondPhotoAction(formData);
}

/**
 * A small, self-contained upload control. Calling a "use server" action
 * directly (not via a `<form action>`) is a supported Next.js pattern —
 * used here because these forms already manage their own multi-row local
 * state (pieces/outputs), so nesting another <form> would fight that.
 * On success, hands the opaque asset id up to the parent via `onUploaded`
 * — the parent stores it in its own draft state and includes it as a
 * plain hidden field on its real submit, exactly like every other field.
 */
export function PhotoUploadField({
  category,
  label,
  assetId,
  onUploaded,
}: {
  category: DiamondAssetCategory;
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
      prepared = await prepareImageForUpload(file, { allowPdf: true });
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      setPending(false);
      setError(err instanceof ImagePrepError ? err.message : `This photo could not be read. Choose it again. (ref ${ref})`);
      return;
    }
    if (attempt !== attemptRef.current) return; // superseded while preparing — never send it

    const formData = new FormData();
    formData.set("file", prepared.file);
    formData.set("category", category);
    formData.set("uploadRef", ref);

    try {
      const result = await withClientTimeout(
        uploadDiamondPhotoAction(undefined, formData),
        UPLOAD_CLIENT_TIMEOUT_MS,
        `Upload timed out. Check your connection and try again. (ref ${ref})`
      );
      if (attempt !== attemptRef.current) {
        // Superseded by a newer attempt — don't touch state, but don't
        // orphan a successful-but-abandoned upload in storage either.
        if (result?.success && result.assetId) fireAndForgetDelete(result.assetId);
        return;
      }
      setPending(false);
      if (result?.success && result.assetId) {
        // Replacing an existing upload — the superseded object is never
        // referenced by anything (the parent form hasn't been submitted
        // yet), so clean it up rather than orphaning it in storage.
        if (assetId) fireAndForgetDelete(assetId);
        setPreview(prepared.file.type.startsWith("image/") ? prepared.file : null);
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
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={handleChange}
            disabled={pending}
            className="hidden"
          />
        </label>
        {assetId ? (
          <>
            {previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- local object URL preview of the file just uploaded
              <img src={previewUrl} alt={`${label} preview`} className="h-12 w-12 rounded-lg border border-zinc-200 object-cover dark:border-zinc-700" data-testid="upload-preview" />
            ) : null}
            <span className="text-xs text-emerald-700 dark:text-emerald-400">Uploaded</span>
            <button
              type="button"
              onClick={handleRemove}
              className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
            >
              Remove
            </button>
          </>
        ) : null}
      </div>
      {error ? <p className="text-xs font-medium text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
