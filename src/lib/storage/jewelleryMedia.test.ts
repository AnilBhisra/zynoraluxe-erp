import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteJewelleryAsset,
  getJewelleryAssetSignedUrl,
  isJewelleryStorageConfigured,
  JewelleryStorageError,
  JewelleryStorageNotConfiguredError,
  resolveJewelleryAssetUrl,
  uploadJewelleryAsset,
} from "./jewelleryMedia";

const ORIGINAL_ENV = { ...process.env };

function setConfigured() {
  process.env.SUPABASE_URL = "https://test-project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test_value_never_a_real_key";
  delete process.env.SUPABASE_JEWELLERY_BUCKET;
  delete process.env.SUPABASE_DIAMOND_BUCKET;
}
function clearConfig() {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_JEWELLERY_BUCKET;
  delete process.env.SUPABASE_DIAMOND_BUCKET;
}

// Real magic-byte signatures, so tests exercise the actual content-sniffing
// logic rather than only the declared MIME string.
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
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

describe("isJewelleryStorageConfigured", () => {
  it("is true once both SUPABASE_URL and SUPABASE_SECRET_KEY are set", () => {
    expect(isJewelleryStorageConfigured()).toBe(true);
  });

  it("is false when either is missing", () => {
    delete process.env.SUPABASE_SECRET_KEY;
    expect(isJewelleryStorageConfigured()).toBe(false);
    setConfigured();
    delete process.env.SUPABASE_URL;
    expect(isJewelleryStorageConfigured()).toBe(false);
  });
});

describe("uploadJewelleryAsset — allowed types", () => {
  it("accepts a real JPEG under the jewellery-design category", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    const result = await uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg"));
    expect(result.assetId).toMatch(/^jewellery-design\/[0-9a-f-]{36}\.jpg$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a real JPEG under Phase 5's costing-estimate category — same security path, just a new path prefix", async () => {
    mockFetchOnce({ ok: true });
    const result = await uploadJewelleryAsset("costing-estimate", file(JPEG_BYTES, "image/jpeg"));
    expect(result.assetId).toMatch(/^costing-estimate\/[0-9a-f-]{36}\.jpg$/);
  });

  it("accepts a real PNG under the jewellery-finished category", async () => {
    mockFetchOnce({ ok: true });
    const result = await uploadJewelleryAsset("jewellery-finished", file(PNG_BYTES, "image/png"));
    expect(result.assetId).toMatch(/^jewellery-finished\/[0-9a-f-]{36}\.png$/);
  });

  it("accepts a real WebP", async () => {
    mockFetchOnce({ ok: true });
    const result = await uploadJewelleryAsset("jewellery-design", file(WEBP_BYTES, "image/webp"));
    expect(result.assetId).toMatch(/^jewellery-design\/[0-9a-f-]{36}\.webp$/);
  });
});

describe("uploadJewelleryAsset — rejections", () => {
  it("rejects a disallowed MIME type before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await expect(uploadJewelleryAsset("jewellery-design", file(GARBAGE_BYTES, "text/plain"))).rejects.toThrow(
      JewelleryStorageError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a PDF — Jewellery photos are images only, unlike Diamond's certificate category", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await expect(uploadJewelleryAsset("jewellery-design", file(PDF_BYTES, "application/pdf"))).rejects.toThrow(
      JewelleryStorageError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized file before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(JPEG_BYTES);
    await expect(uploadJewelleryAsset("jewellery-design", file(big, "image/jpeg"))).rejects.toThrow(JewelleryStorageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty file before ever calling fetch", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await expect(uploadJewelleryAsset("jewellery-design", file(new Uint8Array(0), "image/jpeg"))).rejects.toThrow(
      JewelleryStorageError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a file whose real signature doesn't match its claimed type (MIME spoofing)", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await expect(uploadJewelleryAsset("jewellery-design", file(PDF_BYTES, "image/png"))).rejects.toThrow(
      JewelleryStorageError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws JewelleryStorageNotConfiguredError when storage env vars are unset, without calling fetch", async () => {
    clearConfig();
    const fetchMock = mockFetchOnce({ ok: true });
    await expect(uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg"))).rejects.toThrow(
      JewelleryStorageNotConfiguredError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a clear error when the Storage API itself rejects the upload", async () => {
    mockFetchOnce({ ok: false, status: 500 } as Response);
    await expect(uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg"))).rejects.toThrow(
      JewelleryStorageError
    );
  });
});

describe("uploadJewelleryAsset — bucket resolution", () => {
  it("defaults to the Diamond module's bucket (a clearly separated path prefix, not a separate bucket) when SUPABASE_JEWELLERY_BUCKET is unset", async () => {
    process.env.SUPABASE_DIAMOND_BUCKET = "diamond-media";
    const fetchMock = mockFetchOnce({ ok: true });
    await uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg"));
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain("/object/diamond-media/jewellery-design/");
  });

  it("uses a dedicated bucket when SUPABASE_JEWELLERY_BUCKET is explicitly set", async () => {
    process.env.SUPABASE_JEWELLERY_BUCKET = "jewellery-media";
    const fetchMock = mockFetchOnce({ ok: true });
    await uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg"));
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain("/object/jewellery-media/jewellery-design/");
  });
});

describe("uploadJewelleryAsset — object paths and request shape", () => {
  it("generates random, non-guessable, non-filename object paths on every call", async () => {
    mockFetchOnce({ ok: true });
    const first = await uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg", "my-ring.jpg"));
    mockFetchOnce({ ok: true });
    const second = await uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg", "my-ring.jpg"));

    expect(first.assetId).not.toBe(second.assetId);
    expect(first.assetId).not.toContain("my-ring");
    expect(first.assetId).not.toMatch(/ZL-/); // never the human-readable job/finished code either
  });

  it("never uploads through the public object endpoint", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg"));
    const [calledUrl] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).not.toContain("/object/public/");
  });

  it("sends the secret key via the `apikey` header only — never as an Authorization: Bearer token", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    await uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg"));
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(process.env.SUPABASE_SECRET_KEY);
    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers)).not.toContain("Authorization");
  });
});

describe("getJewelleryAssetSignedUrl", () => {
  it("returns null when storage isn't configured, without calling fetch", async () => {
    clearConfig();
    const fetchMock = mockFetchOnce({ ok: true });
    expect(await getJewelleryAssetSignedUrl("jewellery-design/abc.jpg")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests the sign endpoint using the apikey header only, never Authorization, and composes the returned signed URL", async () => {
    const fetchMock = mockFetchOnce({
      ok: true,
      json: async () => ({ signedURL: "/object/sign/diamond-media/jewellery-design/abc.jpg?token=xyz" }),
    } as unknown as Response);

    const url = await getJewelleryAssetSignedUrl("jewellery-design/abc.jpg");

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toContain("/object/sign/");
    expect(String(calledUrl)).not.toContain("/object/public/");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(process.env.SUPABASE_SECRET_KEY);
    expect(headers.Authorization).toBeUndefined();
    expect(url).toBe(
      "https://test-project.supabase.co/storage/v1/object/sign/diamond-media/jewellery-design/abc.jpg?token=xyz"
    );
  });

  it("defaults the signed URL's expiry to a short-lived 300 seconds", async () => {
    const fetchMock = mockFetchOnce({ ok: true, json: async () => ({ signedURL: "/x" }) } as unknown as Response);
    await getJewelleryAssetSignedUrl("jewellery-design/abc.jpg");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({ expiresIn: 300 });
  });

  it("returns null when the Storage API call fails", async () => {
    mockFetchOnce({ ok: false, status: 404 } as Response);
    expect(await getJewelleryAssetSignedUrl("missing/x.jpg")).toBeNull();
  });

  it("returns null when the response has no signedURL", async () => {
    mockFetchOnce({ ok: true, json: async () => ({}) } as unknown as Response);
    expect(await getJewelleryAssetSignedUrl("jewellery-design/abc.jpg")).toBeNull();
  });
});

describe("resolveJewelleryAssetUrl", () => {
  it("returns null for a null asset id without calling fetch", async () => {
    const fetchMock = mockFetchOnce({ ok: true });
    expect(await resolveJewelleryAssetUrl(null)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delegates to getJewelleryAssetSignedUrl for a real asset id", async () => {
    mockFetchOnce({ ok: true, json: async () => ({ signedURL: "/x" }) } as unknown as Response);
    expect(await resolveJewelleryAssetUrl("jewellery-design/abc.jpg")).toBe(
      "https://test-project.supabase.co/storage/v1/x"
    );
  });
});

describe("deleteJewelleryAsset — temporary object cleanup", () => {
  it("returns false when storage isn't configured, without calling fetch", async () => {
    clearConfig();
    const fetchMock = mockFetchOnce({ ok: true });
    expect(await deleteJewelleryAsset("jewellery-design/abc.jpg")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("issues a DELETE against the object endpoint with the apikey header only, returning true on success", async () => {
    process.env.SUPABASE_DIAMOND_BUCKET = "diamond-media";
    const fetchMock = mockFetchOnce({ ok: true });
    const result = await deleteJewelleryAsset("jewellery-design/abc.jpg");
    expect(result).toBe(true);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe(
      "https://test-project.supabase.co/storage/v1/object/diamond-media/jewellery-design/abc.jpg"
    );
    expect(init.method).toBe("DELETE");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe(process.env.SUPABASE_SECRET_KEY);
    expect(headers.Authorization).toBeUndefined();
  });

  it("returns false (never throws) when the delete call fails", async () => {
    mockFetchOnce({ ok: false, status: 404 } as Response);
    expect(await deleteJewelleryAsset("already-gone/x.jpg")).toBe(false);
  });
});

describe("apikey-only compatibility (sb_secret is not a JWT)", () => {
  it("never sets an Authorization header on any Storage Management/Object API request", async () => {
    const uploadFetch = mockFetchOnce({ ok: true } as Response);
    await uploadJewelleryAsset("jewellery-design", file(JPEG_BYTES, "image/jpeg"));

    const signFetch = mockFetchOnce({ ok: true, json: async () => ({ signedURL: "/x" }) } as unknown as Response);
    await getJewelleryAssetSignedUrl("jewellery-design/abc.jpg");

    const deleteFetch = mockFetchOnce({ ok: true } as Response);
    await deleteJewelleryAsset("jewellery-design/abc.jpg");

    for (const mockFn of [uploadFetch, signFetch, deleteFetch]) {
      expect(mockFn).toHaveBeenCalledTimes(1);
      const [, init] = mockFn.mock.calls[0];
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers).not.toHaveProperty("Authorization");
      expect(headers.apikey).toBe(process.env.SUPABASE_SECRET_KEY);
    }
  });
});
