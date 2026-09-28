import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockUpload = vi.fn();
const mockDelete = vi.fn();

vi.mock("@/app/actions/jewellery", () => ({
  uploadJewelleryPhotoAction: (...args: unknown[]) => mockUpload(...args),
  deleteJewelleryPhotoAction: (...args: unknown[]) => mockDelete(...args),
}));

import { JewelleryPhotoUploadField } from "./PhotoUploadField";

function makeFile() {
  return new File(["fake-bytes"], "photo.jpg", { type: "image/jpeg" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("JewelleryPhotoUploadField", () => {
  beforeEach(() => {
    mockUpload.mockReset();
    mockDelete.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the spinner and shows a clear, retry-safe error when the upload never settles (bounded client timeout)", async () => {
    vi.useFakeTimers();
    mockUpload.mockReturnValue(new Promise(() => {})); // simulates a hung Server Action call — the exact reported symptom
    const onUploaded = vi.fn();
    const { container, getByText } = render(
      <JewelleryPhotoUploadField category="jewellery-design" label="Design photo" assetId={null} onUploaded={onUploaded} />
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [makeFile()] } });
    expect(getByText("Uploading…")).toBeInTheDocument();
    expect(input.disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000);
    });

    expect(getByText(/upload timed out/i)).toBeInTheDocument();
    expect(getByText("Upload photo")).toBeInTheDocument(); // spinner cleared, control re-enabled for retry
    expect(input.disabled).toBe(false);
    expect(onUploaded).not.toHaveBeenCalled();
  });

  it("ignores a late-arriving success from an abandoned attempt and cleans up its orphaned upload instead of clobbering newer state", async () => {
    const first = deferred<{ success: true; assetId: string }>();
    const second = deferred<{ success: true; assetId: string }>();
    mockUpload.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const onUploaded = vi.fn();
    const { container } = render(
      <JewelleryPhotoUploadField category="jewellery-design" label="Design photo" assetId={null} onUploaded={onUploaded} />
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [makeFile()] } }); // attempt 1 — sent, will resolve late
    await waitFor(() => expect(mockUpload).toHaveBeenCalledTimes(1)); // it really went out (e.g. then timed out)
    fireEvent.change(input, { target: { files: [makeFile()] } }); // attempt 2 — supersedes attempt 1

    second.resolve({ success: true, assetId: "asset-2" });
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("asset-2"));

    first.resolve({ success: true, assetId: "asset-1" }); // the abandoned attempt finally settles
    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    expect(mockDelete.mock.calls[0][0].get("assetId")).toBe("asset-1");
    expect(onUploaded).toHaveBeenCalledTimes(1); // never re-invoked for the stale attempt
  });

  it("an attempt superseded while its photo is still being prepared is never sent, so it can never orphan or delete anything", async () => {
    mockUpload.mockResolvedValue({ success: true, assetId: "asset-new" });
    const onUploaded = vi.fn();
    const { container } = render(
      <JewelleryPhotoUploadField category="jewellery-design" label="Design photo" assetId={null} onUploaded={onUploaded} />
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile()] } }); // attempt 1 — superseded before it is sent
    fireEvent.change(input, { target: { files: [makeFile()] } }); // attempt 2
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("asset-new"));
    expect(mockUpload).toHaveBeenCalledTimes(1);
    expect(mockDelete).not.toHaveBeenCalled();
    expect((mockUpload.mock.calls[0][1] as FormData).get("uploadRef")).toMatch(/^[a-f0-9]{8}$/);
  });

  it("clears the spinner and shows the server's own error on an ordinary (non-timeout) failure", async () => {
    mockUpload.mockResolvedValue({ error: "File is too large (maximum 10 MB)." });
    const onUploaded = vi.fn();
    const { container, getByText } = render(
      <JewelleryPhotoUploadField category="jewellery-design" label="Design photo" assetId={null} onUploaded={onUploaded} />
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    fireEvent.change(input, { target: { files: [makeFile()] } });
    await waitFor(() => expect(getByText("File is too large (maximum 10 MB).")).toBeInTheDocument());
    expect(getByText("Upload photo")).toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();
  });
});
