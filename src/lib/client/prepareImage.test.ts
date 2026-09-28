import { describe, expect, it, vi } from "vitest";

import {
  describeUploadFailure,
  ImagePrepError,
  newUploadRef,
  prepareImageForUpload,
  RESIZE_ABOVE_BYTES,
  UPLOAD_SEND_LIMIT_BYTES,
  type ResizeFn,
} from "./prepareImage";

const MB = 1024 * 1024;
function fileOf(bytes: number, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type });
}
const resizeTo = (bytes: number): ResizeFn => vi.fn(async () => new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));

describe("prepareImageForUpload", () => {
  it("sends a small photo unchanged, without decoding it", async () => {
    const resize = resizeTo(1);
    const f = fileOf(900 * 1024, "ring.jpg", "image/jpeg");
    const out = await prepareImageForUpload(f, { resize });
    expect(out).toMatchObject({ file: f, resized: false, sentBytes: 900 * 1024 });
    expect(resize).not.toHaveBeenCalled();
  });

  it("scales a large laptop photo down to a JPEG under the resize threshold", async () => {
    const resize = resizeTo(700 * 1024);
    const out = await prepareImageForUpload(fileOf(5 * MB, "IMG_2041.png", "image/png"), { resize });
    expect(out.resized).toBe(true);
    expect(out.file.type).toBe("image/jpeg");
    expect(out.file.name).toBe("IMG_2041.jpg");
    expect(out.sentBytes).toBe(700 * 1024);
    expect(out.originalBytes).toBe(5 * MB);
    expect(resize).toHaveBeenCalledWith(expect.any(File), 2560, 0.85);
  });

  it("tries lower quality, then a smaller size, keeping the smallest result", async () => {
    const sizes = [3 * MB, 2.6 * MB, 2.2 * MB, 1.4 * MB];
    const calls: [number, number][] = [];
    const resize: ResizeFn = async (_f, edge, q) => {
      calls.push([edge, q]);
      return new Blob([new Uint8Array(Math.floor(sizes[calls.length - 1] ?? 1))]);
    };
    const out = await prepareImageForUpload(fileOf(8 * MB, "a.jpg", "image/jpeg"), { resize });
    expect(calls).toEqual([[2560, 0.85], [2560, 0.75], [2560, 0.65], [1600, 0.85]]);
    expect(out.sentBytes).toBe(Math.floor(1.4 * MB));
  });

  it("refuses HEIC with what to do instead", async () => {
    await expect(prepareImageForUpload(fileOf(2 * MB, "IMG_0001.HEIC", ""))).rejects.toThrow(/HEIC photos .* export the photo as JPEG/);
    await expect(prepareImageForUpload(fileOf(2 * MB, "x", "image/heic"))).rejects.toBeInstanceOf(ImagePrepError);
  });

  it("refuses other types, naming the type; allows PDF only where asked", async () => {
    await expect(prepareImageForUpload(fileOf(10, "notes.txt", "text/plain"))).rejects.toThrow(/only JPEG, PNG or WebP photos can be uploaded — this file is text\/plain/i);
    await expect(prepareImageForUpload(fileOf(10, "cert.pdf", "application/pdf"))).rejects.toThrow(/this file is application\/pdf/);
    const pdf = fileOf(2 * MB, "cert.pdf", "application/pdf");
    expect((await prepareImageForUpload(pdf, { allowPdf: true })).file).toBe(pdf);
    await expect(prepareImageForUpload(fileOf(4 * MB, "big.pdf", "application/pdf"), { allowPdf: true })).rejects.toThrow(/This PDF is 4.0 MB; the limit is 3.5 MB/);
  });

  it("refuses an empty file", async () => {
    await expect(prepareImageForUpload(fileOf(0, "a.jpg", "image/jpeg"))).rejects.toThrow(/empty/);
  });

  it("when the browser cannot decode: sends as-is if small enough, otherwise refuses with the size", async () => {
    const failing: ResizeFn = async () => {
      throw new Error("decode failed");
    };
    const mid = fileOf(2 * MB, "a.webp", "image/webp");
    expect((await prepareImageForUpload(mid, { resize: failing })).file).toBe(mid);
    await expect(prepareImageForUpload(fileOf(6 * MB, "a.webp", "image/webp"), { resize: failing })).rejects.toThrow(/This photo is 6.0 MB/);
  });

  it("refuses when even the smallest resize stays over the send limit", async () => {
    await expect(prepareImageForUpload(fileOf(9 * MB, "a.jpg", "image/jpeg"), { resize: resizeTo(UPLOAD_SEND_LIMIT_BYTES + 1) })).rejects.toThrow(/could not be made smaller/);
  });

  it("limits sit under the 4 MB action limit, with the resize threshold below the send limit", () => {
    expect(UPLOAD_SEND_LIMIT_BYTES).toBeLessThan(4 * MB - 64 * 1024);
    expect(RESIZE_ABOVE_BYTES).toBeLessThan(UPLOAD_SEND_LIMIT_BYTES);
  });
});

describe("upload refs and failure wording", () => {
  it("makes 8-hex-character refs", () => {
    expect(newUploadRef()).toMatch(/^[a-f0-9]{8}$/);
    expect(newUploadRef()).not.toBe(newUploadRef());
  });

  it("explains a stale page after a new deployment", () => {
    expect(describeUploadFailure(new Error("Failed to find Server Action \"abc\""), MB, "a1b2c3d4")).toMatch(/app was updated.*Reload the page.*(ref a1b2c3d4)/);
  });

  it("explains a too-large body with the size", () => {
    expect(describeUploadFailure(new Error("Body exceeded 1 MB limit"), 1.9 * MB, "a1b2c3d4")).toMatch(/\(1.9 MB\) is larger than the server accepts/);
  });

  it("otherwise says it could not be sent, keeps entries, and gives the ref", () => {
    expect(describeUploadFailure(new Error("An unexpected response was received from the server."), 0.8 * MB, "a1b2c3d4")).toMatch(
      /could not be sent to the server\..*your other entries are kept\. \(ref a1b2c3d4\)/
    );
  });
});
