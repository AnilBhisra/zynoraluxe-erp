// @vitest-environment node
// See session.test.ts for why: jose needs the Node crypto path here.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSession, SESSION_COOKIE_NAME } from "@/lib/auth/session";

const mockFindUnique = vi.fn();
const mockRedirect = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});
let mockCookieValue: string | undefined;

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE_NAME && mockCookieValue ? { value: mockCookieValue } : undefined,
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { user: { findUnique: mockFindUnique } },
}));

async function loadDal() {
  // Fresh module per test so React's per-request `cache()` memoization
  // inside getCurrentUser can't leak a result from one test into another.
  return import("./dal");
}

beforeEach(() => {
  vi.resetModules();
  mockFindUnique.mockReset();
  mockRedirect.mockClear();
  mockCookieValue = undefined;
});

describe("getCurrentUser", () => {
  it("returns null when there is no session cookie", async () => {
    const { getCurrentUser } = await loadDal();
    expect(await getCurrentUser()).toBeNull();
  });

  it("returns null when the account has been deactivated", async () => {
    mockCookieValue = await encryptSession({ userId: "u1", expiresAt: Date.now() + 60_000 });
    mockFindUnique.mockResolvedValue({
      id: "u1",
      email: "a@b.com",
      name: "A",
      role: "STAFF",
      isActive: false,
    });

    const { getCurrentUser } = await loadDal();
    expect(await getCurrentUser()).toBeNull();
  });

  it("returns the user for a valid session and active account", async () => {
    mockCookieValue = await encryptSession({ userId: "u1", expiresAt: Date.now() + 60_000 });
    mockFindUnique.mockResolvedValue({
      id: "u1",
      email: "a@b.com",
      name: "A",
      role: "OWNER",
      isActive: true,
    });

    const { getCurrentUser } = await loadDal();
    expect(await getCurrentUser()).toEqual({
      id: "u1",
      email: "a@b.com",
      name: "A",
      role: "OWNER",
    });
  });
});

describe("requireUser", () => {
  it("redirects to /login when there is no valid session", async () => {
    const { requireUser } = await loadDal();
    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
  });
});

describe("requireOwner", () => {
  it("redirects Staff to /unauthorized", async () => {
    mockCookieValue = await encryptSession({ userId: "u1", expiresAt: Date.now() + 60_000 });
    mockFindUnique.mockResolvedValue({
      id: "u1",
      email: "a@b.com",
      name: "A",
      role: "STAFF",
      isActive: true,
    });

    const { requireOwner } = await loadDal();
    await expect(requireOwner()).rejects.toThrow("REDIRECT:/unauthorized");
  });

  it("succeeds for an active Owner", async () => {
    mockCookieValue = await encryptSession({ userId: "u1", expiresAt: Date.now() + 60_000 });
    mockFindUnique.mockResolvedValue({
      id: "u1",
      email: "a@b.com",
      name: "A",
      role: "OWNER",
      isActive: true,
    });

    const { requireOwner } = await loadDal();
    const user = await requireOwner();
    expect(user.role).toBe("OWNER");
  });
});
