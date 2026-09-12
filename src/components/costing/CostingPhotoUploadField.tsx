"use client";

import { useState } from "react";

import { uploadCostingPhotoAction, deleteCostingPhotoAction } from "@/app/actions/costing";

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

  async function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    setPending(true);
    setError(null);
    const formData = new FormData();
    formData.set("file", file);
    const result = await uploadCostingPhotoAction(undefined, formData);
    setPending(false);

    if (result?.success && result.assetId) {
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
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleChange} disabled={pending} className="hidden" />
        </label>
        {assetId ? (
          <>
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
