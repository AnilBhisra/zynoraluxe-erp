import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteDiamondAsset,
  getDiamondAssetSignedUrl,
  isDiamondStorageConfigured,
  resolveDiamondAssetUrl,
  StorageError,
  StorageNotConfiguredError,
  uploadDiamondAsset,
} from "./diamondMedia";

const ORIGINAL_ENV = { ...process.env };

function setConfigured() {
  process.env.SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_value_never_a_real_key";
  process.env.SUPABASE_DIAMOND_BUCKET = "diamond-media";
}
function clearConfig() {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_DIAMOND_BUCKET;
}

// Real magic-byte signatures, so tests exercise the actual content-sniffing
// logic rather than only the declared MIME string.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const GARBAGE_BYTES = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

function file(bytes: Uint8Array, type: string, name = "upload") {
  return new File([Buffer.from(bytes)], name, { type });
}

function mockFetchOnce(response: Partial<Response> & { ok: boolean }) {
  const fn = vi.fn().mockResolvedValue(response as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  setConfigured();
});
afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("isDiamondStorageConfigured", () => {
  it("is true once both SUPABASE_URL and SUPABASE_SECRET_KEY are set", () => {
    expect(isDiamondStorageConfigured()).toBe(true);
  });

  it("is false when either is missing", () => {
    delete process.env.SUPABASE_SECRET_KEY;
    expect(isDiamondStorageConfigured()).toBe(false);
    setConfigured();
    delete process.env.SUPABASE_URL;
    expect(isDiamondStorageConfigured()).toBe(false);
  });
});

describe("uploadDiamondAsset — allowed types", () => {
  it("accepts a real JPEG", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    const result = await uploadDiamondAsset("rough-piece", file(JPEG_BYTES, "image/jpeg"));
    expect(result.assetId).toMatch(/^rough-piece\/[0-9a-f-]{36}\.jpg$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a real PNG", async () => {
    mockFetchOnce({ ok: true });
    const result = await uploadDiamondAsset("rough-lot", file(PNG_BYTES, "image/png"));
    expect(result.assetId).toMatch(/^rough-lot\/[0-9a-f-]{36}\.png$/);
  });

  it("accepts a real WebP", async () => {
    mockFetchOnce({ ok: true });
    const result = await uploadDiamondAsset("polished-diamond", file(WEBP_BYTES, "image/webp"));
    expect(result.assetId).toMatch(/^polished-diamond\/[0-9a-f-]{36}\.webp$/);
  });

  it("accepts a real PDF certificate", async () => {
    mockFetchOnce({ ok: true });
    const result = await uploadDiamondAsset("certificate", file(PDF_BYTES, "application/pdf"));
    expect(result.assetId).toMatch(/^certificate\/[0-9a-f-]{36}\.pdf$/);
  });
});

describe("uploadDiamondAsset — rejections", () => {
  it("rejects a disallowed MIME type before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await expect(
      uploadDiamondAsset("rough-piece", file(GARBAGE_BYTES, "text/plain"))
    ).rejects.toThrow(StorageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG_BYTES); // valid signature — size limit must reject first regardless
    await expect(uploadDiamondAsset("rough-piece", file(big, "image/jpeg"))).rejects.toThrow(
      StorageError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty file before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await expect(
      uploadDiamondAsset("rough-piece", file(new Uint8Array(0), "image/jpeg"))
    ).rejects.toThrow(StorageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a corrupt/mislabeled file whose bytes don't match its declared type", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    // Declares image/png but the bytes are neither PNG nor anything else recognized.
    await expect(
      uploadDiamondAsset("rough-piece", file(GARBAGE_BYTES, "image/png"))
    ).rejects.toThrow(StorageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a file whose real signature doesn't match its claimed type (MIME spoofing)", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    // Real PDF bytes, but claiming to be a PNG — a spoofing attempt.
    await expect(
      uploadDiamondAsset("certificate", file(PDF_BYTES, "image/png"))
    ).rejects.toThrow(StorageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws StorageNotConfiguredError when storage env vars are unset, without calling fetch", async () => {
    clearConfig();
    const fetchMock = mockFetchOnce({ ok: true });
    await expect(uploadDiamondAsset("rough-piece", file(JPEG_BYTES, "image/jpeg"))).rejects.toThrow(
      StorageNotConfiguredError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a clear error when the Storage API itself rejects the upload", async () => {
    mockFetchOnce({ ok: false, status: 500 } as Response);
    await expect(uploadDiamondAsset("rough-piece", file(JPEG_BYTES, "image/jpeg"))).rejects.toThrow(
      StorageError
    );
  });
});

describe("uploadDiamondAsset — object paths and request shape", () => {
  it("generates random, non-guessable, non-filename object paths on every call", async () => {
    mockFetchOnce({ ok: true });
    const first = await uploadDiamondAsset("rough-piece", file(JPEG_BYTES, "image/jpeg", "my-diamond.jpg"));
    mockFetchOnce({ ok: true });
    const second = await uploadDiamondAsset("rough-piece", file(JPEG_BYTES, "image/jpeg", "my-diamond.jpg"));

    expect(first.assetId).not.toBe(second.assetId);
    expect(first.assetId).not.toContain("my-diamond");
    expect(first.assetId).not.toMatch(/ZL-/); // never the human-readable diamond code either
  });

  it("never uploads through the public object endpoint", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await uploadDiamondAsset("rough-piece", file(JPEG_BYTES, "image/jpeg"));
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).not.toContain("/object/public/");
  });

  it("sends the secret key via the `apikey` header only — the current sb_secret key is not a JWT and is never sent as an Authorization: Bearer token", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await uploadDiamondAsset("rough-piece", file(JPEG_BYTES, "image/jpeg"));
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(process.env.SUPABASE_SECRET_KEY);
    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers)).not.toContain("Authorization");
  });
});

describe("getDiamondAssetSignedUrl", () => {
  it("returns null when storage isn't configured, without calling fetch", async () => {
    clearConfig();
    const fetchMock = mockFetchOnce({ ok: true });
    expect(await getDiamondAssetSignedUrl("rough-piece/abc.jpg")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests the sign endpoint using the apikey header only, never Authorization, and composes the returned signed URL", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: async () => ({ signedURL: "/object/sign/diamond-media/rough-piece/abc.jpg?token=xyz" }),
    } as unknown as Response);

    const url = await getDiamondAssetSignedUrl("rough-piece/abc.jpg");

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain("/object/sign/");
    expect(String(calledUrl)).not.toContain("/object/public/");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(process.env.SUPABASE_SECRET_KEY);
    expect(headers.Authorization).toBeUndefined();
    // The signed download URL itself carries its own short-lived token —
    // a completely separate, unrelated mechanism from the apikey header
    // used to request it, and unaffected by this fix.
    expect(url).toBe(
      "https://test-project.supabase.co/storage/v1/object/sign/diamond-media/rough-piece/abc.jpg?token=xyz"
    );
  });

  it("defaults the signed URL's expiry to a short-lived 300 seconds", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ signedURL: "/x" }) } as unknown as Response);
    await getDiamondAssetSignedUrl("rough-piece/abc.jpg");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ expiresIn: 300 });
  });

  it("honors a custom expiry when given one", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ signedURL: "/x" }) } as unknown as Response);
    await getDiamondAssetSignedUrl("rough-piece/abc.jpg", 60);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ expiresIn: 60 });
  });

  it("returns null when the Storage API call fails", async () => {
    mockFetchOnce({ ok: false, status: 404 } as Response);
    expect(await getDiamondAssetSignedUrl("missing/x.jpg")).toBeNull();
  });

  it("returns null when the response has no signedURL", async () => {
    mockFetchOnce({ ok: true, json: async () => ({}) } as unknown as Response);
    expect(await getDiamondAssetSignedUrl("rough-piece/abc.jpg")).toBeNull();
  });
});

describe("resolveDiamondAssetUrl", () => {
  it("returns null for a null asset id without calling fetch", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    expect(await resolveDiamondAssetUrl(null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delegates to getDiamondAssetSignedUrl for a real asset id", async () => {
    mockFetchOnce({ ok: true, json: async () => ({ signedURL: "/x" }) } as unknown as Response);
    expect(await resolveDiamondAssetUrl("rough-piece/abc.jpg")).toBe(
      "https://test-project.supabase.co/storage/v1/x"
    );
  });
});

describe("deleteDiamondAsset — temporary object cleanup", () => {
  it("returns false when storage isn't configured, without calling fetch", async () => {
    clearConfig();
    const fetchMock = mockFetchOnce({ ok: true });
    expect(await deleteDiamondAsset("rough-piece/abc.jpg")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issues a DELETE against the object endpoint with the apikey header only, returning true on success", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    const result = await deleteDiamondAsset("rough-piece/abc.jpg");
    expect(result).toBe(true);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe(
      "https://test-project.supabase.co/storage/v1/object/diamond-media/rough-piece/abc.jpg"
    );
    expect(init.method).toBe("DELETE");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(process.env.SUPABASE_SECRET_KEY);
    expect(headers.Authorization).toBeUndefined();
  });

  it("returns false (never throws) when the delete call fails", async () => {
    mockFetchOnce({ ok: false, status: 404 } as Response);
    expect(await deleteDiamondAsset("already-gone/x.jpg")).toBe(false);
  });
});

describe("apikey-only compatibility (sb_secret is not a JWT)", () => {
  /**
   * Supabase's current `sb_secret_...` key format is not a JWT, so it is
   * not valid to send as an `Authorization: Bearer` token — only the
   * `apikey` header is correct for Storage Management/Object API calls.
   * This single guard exercises every exported function that talks to
   * Storage and asserts NONE of them ever set an Authorization header,
   * regardless of which one a future edit touches.
   */
  it("never sets an Authorization header on any Storage Management/Object API request", async () => {
    const uploadFetch = mockFetchOnce({ ok: true } as Response);
    await uploadDiamondAsset("rough-piece", file(JPEG_BYTES, "image/jpeg"));

    const signFetch = mockFetchOnce({ ok: true, json: async () => ({ signedURL: "/x" }) } as unknown as Response);
    await getDiamondAssetSignedUrl("rough-piece/abc.jpg");

    const deleteFetch = mockFetchOnce({ ok: true } as Response);
    await deleteDiamondAsset("rough-piece/abc.jpg");

    for (const mockFn of [uploadFetch, signFetch, deleteFetch]) {
      expect(mockFn).toHaveBeenCalledTimes(1);
      const [, init] = mockFn.mock.calls[0];
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers).not.toHaveProperty("Authorization");
      expect(headers.apikey).toBe(process.env.SUPABASE_SECRET_KEY);
    }
  });
});
