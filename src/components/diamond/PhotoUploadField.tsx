"use client";

import { useState } from "react";

import { deleteDiamondPhotoAction, uploadDiamondPhotoAction } from "@/app/actions/diamond";
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

  async function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("file", file);
    formData.set("category", category);
    const result = await uploadDiamondPhotoAction(undefined, formData);
    setPending(false);

    if (result?.success && result.assetId) {
      // Replacing an existing upload — the superseded object is never
      // referenced by anything (the parent form hasn't been submitted
      // yet), so clean it up rather than orphaning it in storage.
      if (assetId) fireAndForgetDelete(assetId);
      onUploaded(result.assetId);
    } else {
      setError(result?.error ?? "Upload failed.");
    }
  }

  function handleRemove() {
    if (assetId) fireAndForgetDelete(assetId);
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
