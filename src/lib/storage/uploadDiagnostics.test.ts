import { describe, expect, it, vi } from "vitest";

import { friendlyUploadError, logUploadAttempt, readUploadRef } from "./uploadDiagnostics";

describe("uploadDiagnostics", () => {
  it("accepts only an 8-hex ref from the browser", () => {
    expect(readUploadRef("a1b2c3d4")).toBe("a1b2c3d4");
    expect(readUploadRef("<script>")).toBe("none");
    expect(readUploadRef(null)).toBe("none");
  });

  it("turns storage statuses into actionable messages with the ref", () => {
    expect(friendlyUploadError(new Error("Upload failed (403). Please try again."), "r1")).toBe(
      "Photo storage refused the upload (access denied). This is a server setting — tell the Owner. (ref r1)"
    );
    expect(friendlyUploadError(new Error("Upload failed (404). Please try again."), "r1")).toMatch(/rejected the upload \(404\).*tell the Owner/);
    expect(friendlyUploadError(new Error("Upload failed (503). Please try again."), "r1")).toMatch(/temporarily unavailable/);
    expect(friendlyUploadError(new Error("Upload failed (413). Please try again."), "r1")).toMatch(/too large/);
  });

  it("keeps validation and timeout messages, adding the ref", () => {
    expect(friendlyUploadError(new Error('File type "text/plain" is not allowed for upload.'), "r2")).toBe('File type "text/plain" is not allowed for upload. (ref r2)');
    expect(friendlyUploadError(new Error("Storage did not respond in time. Please check your connection and try again."), "r2")).toMatch(/did not respond in time.*\(ref r2\)/);
  });

  it("logs one JSON line per attempt without file names or bytes", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logUploadAttempt({ ref: "r3", surface: "jewellery", category: "jewellery-design", bytes: 812345, type: "image/jpeg", outcome: "ok", ms: 420 });
    logUploadAttempt({ ref: "r4", surface: "costing", category: "costing-estimate", bytes: 5, type: "image/png", outcome: "failed", ms: 30, detail: "x".repeat(500) });
    expect(JSON.parse(info.mock.calls[0][0] as string)).toEqual({ event: "photo-upload", ref: "r3", surface: "jewellery", category: "jewellery-design", bytes: 812345, type: "image/jpeg", outcome: "ok", ms: 420 });
    expect(JSON.parse(warn.mock.calls[0][0] as string).detail).toHaveLength(200);
    info.mockRestore();
    warn.mockRestore();
  });
});
