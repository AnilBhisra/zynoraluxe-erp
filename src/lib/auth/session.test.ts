// @vitest-environment node
//
// jose's browser/WebCrypto build (picked up under jsdom) hits a cross-realm
// Uint8Array mismatch in this Vite/jsdom setup; the Node environment makes
// it use Node's crypto module instead, which this pure logic doesn't
// otherwise need a DOM for anyway.
import { describe, expect, it } from "vitest";

import { decryptSession, encryptSession, isValidSessionToken } from "./session";

describe("session token encrypt/decrypt", () => {
  it("round-trips a payload signed with the session secret", async () => {
    const expiresAt = Date.now() + 60_000;
    const token = await encryptSession({ userId: "user-1", expiresAt });

    const decoded = await decryptSession(token);

    expect(decoded).not.toBeNull();
    expect(decoded?.userId).toBe("user-1");
  });

  it("rejects a tampered token", async () => {
    const expiresAt = Date.now() + 60_000;
    const token = await encryptSession({ userId: "user-1", expiresAt });
    const tampered = `${token.slice(0, -2)}xx`;

    const decoded = await decryptSession(tampered);

    expect(decoded).toBeNull();
  });

  it("rejects an already-expired token", async () => {
    const expiresAt = Date.now() - 60_000;
    const token = await encryptSession({ userId: "user-1", expiresAt });

    const decoded = await decryptSession(token);

    expect(decoded).toBeNull();
  });

  it("rejects undefined/empty input", async () => {
    expect(await decryptSession(undefined)).toBeNull();
    expect(await isValidSessionToken(undefined)).toBe(false);
  });

  it("isValidSessionToken mirrors decryptSession for a valid token", async () => {
    const expiresAt = Date.now() + 60_000;
    const token = await encryptSession({ userId: "user-2", expiresAt });

    expect(await isValidSessionToken(token)).toBe(true);
  });
});
