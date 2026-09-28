/**
 * Browser-side preparation of a photo before it is sent to a Server Action.
 * Generic and free of storage-security logic (the server still validates the
 * real file type from its bytes), so — like uploadTimeout.ts — it is shared by
 * every photo upload field (Jewellery, Diamond, Costing).
 *
 * Why: Server Action requests are capped (next.config.ts, 4 MB, itself under
 * Vercel's 4.5 MB request limit). Laptop and phone photos are often 3–10 MB,
 * so a large photo is scaled down and re-encoded as JPEG here. A photo that
 * cannot be made small enough is refused with its size, never sent to fail.
 */

/** Largest file we send. Below the 4 MB action limit, leaving room for multipart overhead. */
export const UPLOAD_SEND_LIMIT_BYTES = Math.floor(3.5 * 1024 * 1024);
/** Photos above this are scaled down before sending. */
export const RESIZE_ABOVE_BYTES = Math.floor(1.5 * 1024 * 1024);
const MAX_EDGE_PX = 2560;
const FALLBACK_EDGE_PX = 1600;
const QUALITIES = [0.85, 0.75, 0.65];

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** A problem the user can act on (shown as-is). */
export class ImagePrepError extends Error {}

export type PreparedImage = {
  file: File;
  originalBytes: number;
  sentBytes: number;
  resized: boolean;
};

export function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Scales the image so its long edge is at most `maxEdge` and encodes it as JPEG. */
export type ResizeFn = (file: File, maxEdge: number, quality: number) => Promise<Blob>;

async function browserResize(file: File, maxEdge: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    // JPEG has no transparency: paint a white background under PNG/WebP alpha.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality)
    );
  } finally {
    bitmap.close?.();
  }
}

/**
 * Returns the file to send: the original when it is already small, otherwise
 * a scaled-down JPEG. Throws ImagePrepError with an actionable message when
 * the file cannot be uploaded at all.
 */
export async function prepareImageForUpload(
  file: File,
  options: { allowPdf?: boolean; resize?: ResizeFn } = {}
): Promise<PreparedImage> {
  const resize = options.resize ?? browserResize;
  const ext = extensionOf(file.name);
  const type = file.type.toLowerCase();
  if (options.allowPdf && type === "application/pdf") {
    // Certificates: sent as they are (never re-encoded), size-checked only.
    if (file.size === 0) throw new ImagePrepError("This file is empty. Choose it again.");
    if (file.size > UPLOAD_SEND_LIMIT_BYTES) {
      throw new ImagePrepError(`This PDF is ${formatMb(file.size)}; the limit is ${formatMb(UPLOAD_SEND_LIMIT_BYTES)}. Save a smaller copy and choose it again.`);
    }
    return { file, originalBytes: file.size, sentBytes: file.size, resized: false };
  }
  if (type === "image/heic" || type === "image/heif" || ext === "heic" || ext === "heif") {
    throw new ImagePrepError(
      "HEIC photos (from iPhone / Mac) can't be uploaded here. Save or export the photo as JPEG, then choose it again."
    );
  }
  if (!ACCEPTED_TYPES.has(type)) {
    throw new ImagePrepError(
      `Only JPEG, PNG or WebP photos${options.allowPdf ? " or PDF certificates" : ""} can be uploaded — this file is ${type || (ext ? `.${ext}` : "an unknown type")}.`
    );
  }
  if (file.size === 0) throw new ImagePrepError("This file is empty. Choose the photo again.");
  if (file.size <= RESIZE_ABOVE_BYTES) {
    return { file, originalBytes: file.size, sentBytes: file.size, resized: false };
  }

  let best: Blob | null = null;
  try {
    for (const edge of [MAX_EDGE_PX, FALLBACK_EDGE_PX]) {
      for (const quality of QUALITIES) {
        const blob = await resize(file, edge, quality);
        if (!best || blob.size < best.size) best = blob;
        if (blob.size <= RESIZE_ABOVE_BYTES) break;
      }
      if (best && best.size <= RESIZE_ABOVE_BYTES) break;
    }
  } catch {
    best = null; // this browser could not decode the file — fall through
  }

  if (best && best.size <= UPLOAD_SEND_LIMIT_BYTES) {
    const base = file.name.replace(/\.[^.]*$/, "") || "photo";
    const resizedFile = new File([best], `${base}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
    return { file: resizedFile, originalBytes: file.size, sentBytes: resizedFile.size, resized: true };
  }
  if (!best && file.size <= UPLOAD_SEND_LIMIT_BYTES) {
    // Could not resize here, but it is small enough to send as it is.
    return { file, originalBytes: file.size, sentBytes: file.size, resized: false };
  }
  throw new ImagePrepError(
    `This photo is ${formatMb(file.size)} and could not be made smaller than ${formatMb(UPLOAD_SEND_LIMIT_BYTES)} in this browser. Choose a smaller photo (for example a screenshot or an exported JPEG).`
  );
}

/** Short reference shown to the user and written to the server log for one upload attempt. */
export function newUploadRef(): string {
  const bytes = new Uint8Array(4);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The message for a Server Action call that failed in transit (not a server-returned error). */
export function describeUploadFailure(error: unknown, sentBytes: number, ref: string): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  if (/failed to find server action|server action .*not found/i.test(text)) {
    return `The app was updated while this page was open. Reload the page, then attach the photo again. (ref ${ref})`;
  }
  if (/body exceeded|payload too large|413/i.test(text)) {
    return `The photo (${formatMb(sentBytes)}) is larger than the server accepts. Choose a smaller photo. (ref ${ref})`;
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return `You appear to be offline — the photo was not sent. Reconnect and try again. (ref ${ref})`;
  }
  return `The photo (${formatMb(sentBytes)}) could not be sent to the server. Check the connection and try again; your other entries are kept. (ref ${ref})`;
}
