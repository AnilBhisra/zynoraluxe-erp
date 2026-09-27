import "server-only";

/**
 * Storage abstraction for Jewellery-module photos (design image, finished
 * photo). Deliberately a SEPARATE module from src/lib/storage/
 * diamondMedia.ts, not a shared/generalized one — Phase 3's storage code
 * is already committed and live-verified, and duplicating this small,
 * security-critical module avoids any risk of regressing it while Phase 4
 * is built. Every security property is identical and reused verbatim:
 * apikey-only auth (Supabase's current sb_secret key is not a JWT, so it
 * is never sent as an Authorization: Bearer token), magic-byte signature
 * validation (never trusts the browser-supplied MIME string alone),
 * random non-guessable object paths, a 10 MB cap, and short-lived signed
 * URLs for viewing — nothing is ever served from a public bucket URL.
 *
 * Bucket: reuses the same private bucket as the Diamond module by
 * default (`SUPABASE_DIAMOND_BUCKET`, itself defaulting to
 * "diamond-media") under jewellery-specific path prefixes — "a clearly
 * separated private path under an appropriate existing private bucket."
 * Set SUPABASE_JEWELLERY_BUCKET explicitly to use a dedicated bucket
 * (e.g. "jewellery-media") instead.
 *
 * Configuration is optional: SUPABASE_URL / SUPABASE_SECRET_KEY (and
 * optionally SUPABASE_JEWELLERY_BUCKET) in .env. When unset, upload calls
 * throw StorageNotConfiguredError, which callers turn into a plain "photo
 * upload is not available yet" form message — every other Jewellery
 * feature works fully without this configured.
 */

export class JewelleryStorageNotConfiguredError extends Error {
  constructor() {
    super(
      "Jewellery media storage is not configured. Set SUPABASE_URL and " +
        "SUPABASE_SECRET_KEY in .env to enable photo uploads."
    );
  }
}

export class JewelleryStorageError extends Error {}

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// Node's global fetch has no default timeout, so without one, a stalled
// connection to Supabase Storage (seen in practice on a slower/flakier
// "laptop" network, not just a down service) would hang the calling
// Server Action — and with it the browser's own spinner — forever, with
// no error ever shown. See src/lib/client/uploadTimeout.ts for the
// matching client-side backstop.
const UPLOAD_TIMEOUT_MS = 30_000; // uploads can carry up to 10 MB
const REQUEST_TIMEOUT_MS = 10_000; // sign/delete are small metadata calls

/** Bounds one outbound call to Supabase Storage. Converts a timeout
 * specifically into JewelleryStorageError so callers get a clear,
 * retry-safe message rather than an unbounded hang — retrying is always
 * safe here since a timed-out call never returns an assetId for anything
 * to reference. */
async function fetchStorage(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new JewelleryStorageError(
        "Storage did not respond in time. Please check your connection and try again."
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// "costing-estimate" added in Phase 5 (design photo on an Estimate
// costing) — reuses this exact module rather than duplicating it, since
// Costing's image needs (private bucket, signed URLs, magic-byte
// validation) are identical, not a new security surface.
export type JewelleryAssetCategory = "jewellery-design" | "jewellery-finished" | "costing-estimate";

function getConfig() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const bucket =
    process.env.SUPABASE_JEWELLERY_BUCKET || process.env.SUPABASE_DIAMOND_BUCKET || "diamond-media";
  if (!url || !secretKey) return null;
  return { url: url.replace(/\/+$/, ""), secretKey, bucket };
}

export function isJewelleryStorageConfigured(): boolean {
  return getConfig() !== null;
}

/** Random, non-guessable object path — never the human-readable job/
 * finished-jewellery code, and never derived from user-supplied filenames. */
function buildObjectPath(category: JewelleryAssetCategory, extension: string): string {
  const random = crypto.randomUUID();
  return `${category}/${random}${extension}`;
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    default:
      return "";
  }
}

/** Sniffs the real file signature (magic bytes) — never trusts the
 * browser-supplied (spoofable) `file.type` string alone. Also naturally
 * rejects an empty or corrupt file: neither has a valid signature. */
function detectSignatureMime(bytes: Uint8Array): string | null {
  const has = (offset: number, sequence: number[]) =>
    sequence.every((b, i) => bytes[offset + i] === b);

  if (has(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (has(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (has(0, [0x52, 0x49, 0x46, 0x46]) && has(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

/**
 * Uploads a file's bytes server-side and returns the opaque object path
 * to store as `designImageAssetId`/`photoAssetId`. Never call from a
 * Client Component — this file's exports must only ever run on the server.
 */
export async function uploadJewelleryAsset(
  category: JewelleryAssetCategory,
  file: File
): Promise<{ assetId: string }> {
  const config = getConfig();
  if (!config) throw new JewelleryStorageNotConfiguredError();

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new JewelleryStorageError(`File type "${file.type}" is not allowed for upload.`);
  }
  if (file.size === 0) {
    throw new JewelleryStorageError("File is empty.");
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new JewelleryStorageError("File is too large (maximum 10 MB).");
  }

  const bytes = await file.arrayBuffer();
  const signatureMime = detectSignatureMime(new Uint8Array(bytes));
  if (!signatureMime || signatureMime !== file.type) {
    throw new JewelleryStorageError(
      "File content does not match its declared type (empty, corrupt, or mislabeled file)."
    );
  }

  const objectPath = buildObjectPath(category, extensionForMime(file.type));

  const response = await fetchStorage(
    `${config.url}/storage/v1/object/${config.bucket}/${objectPath}`,
    {
      method: "POST",
      headers: {
        apikey: config.secretKey,
        "Content-Type": file.type,
        "x-upsert": "false",
      },
      body: bytes,
    },
    UPLOAD_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new JewelleryStorageError(`Upload failed (${response.status}). Please try again.`);
  }

  return { assetId: objectPath };
}

/** Short-lived signed URL for viewing a stored asset. Returns null if
 * storage isn't configured (callers should render "photo not available"
 * rather than a broken image, never fall back to a public URL). */
export async function getJewelleryAssetSignedUrl(
  assetId: string,
  expiresInSeconds = 300
): Promise<string | null> {
  const config = getConfig();
  if (!config) return null;

  let response: Response;
  try {
    response = await fetchStorage(
      `${config.url}/storage/v1/object/sign/${config.bucket}/${assetId}`,
      {
        method: "POST",
        headers: {
          apikey: config.secretKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      },
      REQUEST_TIMEOUT_MS
    );
  } catch {
    return null; // a timed-out sign request is "not available", same as any other failure
  }

  if (!response.ok) return null;
  const data = (await response.json()) as { signedURL?: string };
  if (!data.signedURL) return null;
  return `${config.url}/storage/v1${data.signedURL}`;
}

/** Null-safe convenience wrapper for the common "resolve this optional
 * stored asset id into a signed URL, or nothing" case. */
export async function resolveJewelleryAssetUrl(assetId: string | null): Promise<string | null> {
  if (!assetId) return null;
  return getJewelleryAssetSignedUrl(assetId);
}

/** Permanently deletes a stored asset (e.g. a user replaces or removes a
 * photo before submitting a form). Returns false rather than throwing
 * when storage isn't configured or the delete otherwise fails — a
 * failed cleanup of an already-orphaned object should never block the
 * calling action. */
export async function deleteJewelleryAsset(assetId: string): Promise<boolean> {
  const config = getConfig();
  if (!config) return false;

  try {
    const response = await fetchStorage(
      `${config.url}/storage/v1/object/${config.bucket}/${assetId}`,
      {
        method: "DELETE",
        headers: {
          apikey: config.secretKey,
        },
      },
      REQUEST_TIMEOUT_MS
    );
    return response.ok;
  } catch {
    return false; // a timed-out cleanup delete should never throw — see doc comment above
  }
}
