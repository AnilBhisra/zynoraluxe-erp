import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientTimeoutError, withClientTimeout } from "./uploadTimeout";

describe("withClientTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the inner promise's value when it settles before the timeout", async () => {
    const inner = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 1_000));
    const raced = withClientTimeout(inner, 5_000, "timed out");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(raced).resolves.toBe("ok");
  });

  it("rejects with the inner promise's own error when it rejects before the timeout", async () => {
    const inner = new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("boom")), 1_000));
    const raced = withClientTimeout(inner, 5_000, "timed out");
    // Attach the assertion (and thus a rejection handler) BEFORE advancing
    // the fake timer, so `raced` is never briefly unhandled at the exact
    // instant it rejects.
    const assertion = expect(raced).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("rejects with ClientTimeoutError once the bound elapses, even though the inner promise never settles", async () => {
    const inner = new Promise<string>(() => {}); // never settles — simulates a hung fetch
    const raced = withClientTimeout(inner, 5_000, "Upload timed out. Check your connection and try again.");
    const assertion = expect(raced).rejects.toBeInstanceOf(ClientTimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });

  it("does not fire the timeout once the inner promise has already resolved", async () => {
    const inner = Promise.resolve("fast");
    const raced = withClientTimeout(inner, 5_000, "timed out");
    await expect(raced).resolves.toBe("fast");
    // Advancing well past the timeout afterwards must not throw/reject anything unhandled.
    await vi.advanceTimersByTimeAsync(10_000);
  });
});
