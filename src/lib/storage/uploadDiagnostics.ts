import "server-only";

/**
 * Correlation and wording for photo uploads — no storage-security logic (that
 * stays duplicated per module in *Media.ts on purpose), so this one file is
 * shared by the Jewellery, Diamond and Costing upload actions.
 *
 * Every attempt carries a short `uploadRef` generated in the browser
 * (src/lib/client/prepareImage.ts). The user sees it in any error, and the
 * server writes exactly one structured log line per attempt with it, so a
 * reported failure can be found in the hosting logs. Never logs secrets,
 * file names or bytes — only size, type, outcome and timing.
 */

export type UploadSurface = "jewellery" | "diamond" | "costing";

export function readUploadRef(value: FormDataEntryValue | null): string {
  return typeof value === "string" && /^[a-f0-9]{8}$/.test(value) ? value : "none";
}

export function logUploadAttempt(entry: {
  ref: string;
  surface: UploadSurface;
  category: string;
  bytes: number;
  type: string;
  outcome: "ok" | "refused" | "failed";
  ms: number;
  detail?: string;
}): void {
  const line = JSON.stringify({ event: "photo-upload", ...entry, detail: entry.detail?.slice(0, 200) });
  if (entry.outcome === "ok") console.info(line);
  else console.warn(line);
}

/** Turns a storage/validation error into a message the user can act on, tagged with the ref. */
export function friendlyUploadError(error: unknown, ref: string): string {
  const raw = error instanceof Error ? error.message : "";
  const status = /Upload failed \((\d{3})\)/.exec(raw)?.[1];
  let message: string;
  if (status) {
    const code = Number(status);
    if (code === 401 || code === 403) {
      message = "Photo storage refused the upload (access denied). This is a server setting — tell the Owner.";
    } else if (code === 413) {
      message = "Photo storage says this file is too large. Choose a smaller photo.";
    } else if (code === 400 || code === 404) {
      message = `Photo storage rejected the upload (${code}). This is usually a storage setting — tell the Owner.`;
    } else if (code >= 500) {
      message = "Photo storage is temporarily unavailable. Wait a minute and try again.";
    } else {
      message = `Photo storage rejected the upload (${code}). Try again.`;
    }
  } else if (raw) {
    // Validation (type, empty, size, content mismatch), timeouts and "not configured"
    // are already written for the user.
    message = raw;
  } else {
    message = "Upload failed. Try again.";
  }
  return `${message} (ref ${ref})`;
}
