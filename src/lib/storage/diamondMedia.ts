import "server-only";

/**
 * Storage abstraction for Diamond-module photos/reference images/
 * certificate files. Talks to Supabase Storage's REST API directly (no
 * extra SDK dependency) using the project's **secret** API key (Supabase's
 * current server-only key type, the successor to the legacy
 * `service_role` key — same full-access, server-only semantics, never
 * shipped to the browser) — so every call in this file MUST stay
 * server-only.
 *
 * The secret key is sent via the `apikey` header ONLY. Unlike the legacy
 * JWT-format `service_role` key, Supabase's current `sb_secret_...` key
 * is not a JWT — it is not valid as an `Authorization: Bearer` token, so
 * no request in this file sends it there; `apikey` is Supabase Storage's
 * own auth header and is sufficient on its own. Signed-URL download
 * tokens are a separate, unrelated mechanism (short-lived, scoped to one
 * object, returned by Supabase itself) and are unaffected by this.
 *
 * Configuration is optional: SUPABASE_URL / SUPABASE_SECRET_KEY /
 * SUPABASE_DIAMOND_BUCKET in .env (see .env.example). When unset, upload
 * calls throw StorageNotConfiguredError, which callers turn into a plain
 * "photo upload is not available yet" form message — every other Diamond
 * feature (stock, jobs, receipts, costing, accounting) works fully
 * without this configured. This is deliberate per the master plan's rule:
 * never fake an "upload" with an impermanent local directory and call it
 * production-ready.
 *
 * Objects are stored under random, non-guessable paths (never the
 * human-readable Rough/Job/Polished code) in a PRIVATE bucket. Viewing a
 * file always goes through a short-lived signed URL — nothing here is
 * ever served from a public bucket URL.
 */

export class StorageNotConfiguredError extends Error {
  constructor() {
    super(
      "Diamond media storage is not configured. Set SUPABASE_URL and " +
        "SUPABASE_SECRET_KEY in .env to enable photo/certificate uploads."
    );
  }
}

export class StorageError extends Error {}

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export type DiamondAssetCategory =
  | "rough-piece"
  | "rough-lot"
  | "custom-shape-reference"
  | "polished-diamond"
  | "certificate";

function getConfig() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const bucket = process.env.SUPABASE_DIAMOND_BUCKET || "diamond-media";
  if (!url || !secretKey) return null;
  return { url: url.replace(/\/+$/, ""), secretKey, bucket };
}

export function isDiamondStorageConfigured(): boolean {
  return getConfig() !== null;
}

/** Random, non-guessable object path — never the human-readable diamond
 * code, and never derived from user-supplied filenames. */
function buildObjectPath(category: DiamondAssetCategory, extension: string): string {
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
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

/**
 * Sniffs the real file signature (magic bytes) and returns which allowed
 * MIME type it actually matches, or null if it matches none — used so an
 * upload is validated against its real bytes, never just the
 * browser-supplied (spoofable) `file.type` string. Also naturally rejects
 * an empty or corrupt file: neither has a valid signature to match.
 */
function detectSignatureMime(bytes: Uint8Array): string | null {
  const has = (offset: number, sequence: number[]) =>
    sequence.every((b, i) => bytes[offset + i] === b);

  if (has(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (has(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (has(0, [0x52, 0x49, 0x46, 0x46]) && has(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp"; // "RIFF"...."WEBP"
  if (has(0, [0x25, 0x50, 0x44, 0x46])) return "application/pdf"; // "%PDF"
  return null;
}

/**
 * Uploads a file's bytes server-side and returns the opaque object path to
 * store as `photoAssetId`/`certFileAssetId` etc. Never call from a Client
 * Component — this file's exports must only ever run on the server.
 */
export async function uploadDiamondAsset(
  category: DiamondAssetCategory,
  file: File
): Promise<{ assetId: string }> {
  const config = getConfig();
  if (!config) throw new StorageNotConfiguredError();

  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    throw new StorageError(`File type "${file.type}" is not allowed for upload.`);
  }
  if (file.size === 0) {
    throw new StorageError("File is empty.");
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new StorageError("File is too large (maximum 10 MB).");
  }

  const bytes = await file.arrayBuffer();
  const signatureMime = detectSignatureMime(new Uint8Array(bytes));
  if (!signatureMime || signatureMime !== file.type) {
    throw new StorageError(
      "File content does not match its declared type (empty, corrupt, or mislabeled file)."
    );
  }

  const objectPath = buildObjectPath(category, extensionForMime(file.type));

  const response = await fetch(
    `${config.url}/storage/v1/object/${config.bucket}/${objectPath}`,
    {
      method: "POST",
      headers: {
        apikey: config.secretKey,
        "Content-Type": file.type,
        "x-upsert": "false",
      },
      body: bytes,
    }
  );

  if (!response.ok) {
    throw new StorageError(`Upload failed (${response.status}). Please try again.`);
  }

  return { assetId: objectPath };
}

/** Short-lived signed URL for viewing a stored asset. Returns null if
 * storage isn't configured (callers should render "photo not available"
 * rather than a broken image, never fall back to a public URL). */
export async function getDiamondAssetSignedUrl(
  assetId: string,
  expiresInSeconds = 300
): Promise<string | null> {
  const config = getConfig();
  if (!config) return null;

  const response = await fetch(
    `${config.url}/storage/v1/object/sign/${config.bucket}/${assetId}`,
    {
      method: "POST",
      headers: {
        apikey: config.secretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    }
  );

  if (!response.ok) return null;
  const data = (await response.json()) as { signedURL?: string };
  if (!data.signedURL) return null;
  return `${config.url}/storage/v1${data.signedURL}`;
}

/** Null-safe convenience wrapper for the common "resolve this optional
 * stored asset id into a signed URL, or nothing" case used throughout the
 * Diamond pages. */
export async function resolveDiamondAssetUrl(assetId: string | null): Promise<string | null> {
  if (!assetId) return null;
  return getDiamondAssetSignedUrl(assetId);
}

/** Permanently deletes a stored asset (e.g. when a user replaces or
 * removes a photo before submitting a form, or an Owner corrects a
 * mis-attached file). Returns false rather than throwing when storage
 * isn't configured or the delete otherwise fails, since a failed cleanup
 * of an already-orphaned object should never block the calling action. */
export async function deleteDiamondAsset(assetId: string): Promise<boolean> {
  const config = getConfig();
  if (!config) return false;

  const response = await fetch(`${config.url}/storage/v1/object/${config.bucket}/${assetId}`, {
    method: "DELETE",
    headers: {
      apikey: config.secretKey,
    },
  });
  return response.ok;
}
