import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  verifyPassword: vi.fn(),
  hashPassword: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  checkLoginRateLimit: vi.fn(),
  recordLoginFailure: vi.fn(),
  resetLoginRateLimitOnSuccess: vi.fn(),
  cleanupExpiredLoginRateLimits: vi.fn(),
}));

vi.mock("@/lib/db/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique } },
}));

vi.mock("@/lib/auth/password", () => ({
  verifyPassword: mocks.verifyPassword,
  hashPassword: mocks.hashPassword,
}));

vi.mock("@/lib/auth/session", () => ({
  createSession: mocks.createSession,
  deleteSession: mocks.deleteSession,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

vi.mock("@/lib/auth/rateLimit", () => ({
  checkLoginRateLimit: mocks.checkLoginRateLimit,
  recordLoginFailure: mocks.recordLoginFailure,
  resetLoginRateLimitOnSuccess: mocks.resetLoginRateLimitOnSuccess,
  cleanupExpiredLoginRateLimits: mocks.cleanupExpiredLoginRateLimits,
}));

import { login } from "./auth";

function formData(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

const VALID_FORM = { email: "someone@example.com", password: "correct-password" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkLoginRateLimit.mockResolvedValue({ blocked: false });
  mocks.hashPassword.mockResolvedValue("dummy-hash-for-timing-safety");
  mocks.recordLoginFailure.mockResolvedValue([]);
  mocks.resetLoginRateLimitOnSuccess.mockResolvedValue(undefined);
  mocks.cleanupExpiredLoginRateLimits.mockResolvedValue(0);
  vi.spyOn(Math, "random").mockReturnValue(0.5); // above the 1% cleanup trigger by default
});

describe("login — existing vs nonexistent accounts", () => {
  it("returns the generic error for a nonexistent account, but still performs real bcrypt work against a dummy hash (timing-safety)", async () => {
    mocks.findUnique.mockResolvedValue(null);
    mocks.verifyPassword.mockResolvedValue(false);

    const result = await login(undefined, formData(VALID_FORM));

    expect(result?.error).toBe("Incorrect email or password.");
    expect(mocks.verifyPassword).toHaveBeenCalledTimes(1);
    expect(mocks.verifyPassword).toHaveBeenCalledWith(VALID_FORM.password, "dummy-hash-for-timing-safety");
    expect(mocks.hashPassword).toHaveBeenCalledWith(expect.any(String));
    expect(mocks.recordLoginFailure).toHaveBeenCalledWith(VALID_FORM.email);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("returns the generic error for a wrong password on an existing, active account (same message as a nonexistent account)", async () => {
    mocks.findUnique.mockResolvedValue({ id: "u1", passwordHash: "real-hash", isActive: true });
    mocks.verifyPassword.mockResolvedValue(false);

    const result = await login(undefined, formData(VALID_FORM));

    expect(result?.error).toBe("Incorrect email or password.");
    expect(mocks.verifyPassword).toHaveBeenCalledWith(VALID_FORM.password, "real-hash");
    // The dummy hash must never be computed/used when a real hash exists.
    expect(mocks.hashPassword).not.toHaveBeenCalled();
    expect(mocks.recordLoginFailure).toHaveBeenCalledWith(VALID_FORM.email);
  });

  it("returns the SAME generic error for a correct password on an inactive account — never reveals the account is disabled", async () => {
    mocks.findUnique.mockResolvedValue({ id: "u1", passwordHash: "real-hash", isActive: false });
    mocks.verifyPassword.mockResolvedValue(true);

    const result = await login(undefined, formData(VALID_FORM));

    expect(result?.error).toBe("Incorrect email or password.");
    expect(mocks.recordLoginFailure).toHaveBeenCalledWith(VALID_FORM.email);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("logs in successfully for a correct password on an active account, resets rate-limit state, and redirects", async () => {
    mocks.findUnique.mockResolvedValue({ id: "u1", passwordHash: "real-hash", isActive: true });
    mocks.verifyPassword.mockResolvedValue(true);

    await expect(login(undefined, formData(VALID_FORM))).rejects.toThrow("REDIRECT:/dashboard");

    expect(mocks.resetLoginRateLimitOnSuccess).toHaveBeenCalledWith(VALID_FORM.email);
    expect(mocks.recordLoginFailure).not.toHaveBeenCalled();
    expect(mocks.createSession).toHaveBeenCalledWith("u1");
  });
});

describe("login — rate limiting", () => {
  it("returns a generic, non-enumerating 'too many attempts' message and never touches the database when already blocked", async () => {
    mocks.checkLoginRateLimit.mockResolvedValue({ blocked: true, retryAfterSeconds: 125 });

    const result = await login(undefined, formData(VALID_FORM));

    expect(result?.error).toMatch(/too many attempts/i);
    expect(result?.error).toMatch(/minute/i);
    expect(result?.error).not.toMatch(/example\.com/); // never echoes the email back
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(mocks.verifyPassword).not.toHaveBeenCalled();
    expect(mocks.recordLoginFailure).not.toHaveBeenCalled();
  });

  it("rounds the retry-after time up to whole minutes, minimum 1", async () => {
    mocks.checkLoginRateLimit.mockResolvedValue({ blocked: true, retryAfterSeconds: 5 });
    const result = await login(undefined, formData(VALID_FORM));
    expect(result?.error).toMatch(/1 minute\b/);
  });

  it("triggers the opportunistic cleanup sweep only on the low-probability branch, and only after a successful login", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.001); // below the 1% threshold
    mocks.findUnique.mockResolvedValue({ id: "u1", passwordHash: "real-hash", isActive: true });
    mocks.verifyPassword.mockResolvedValue(true);

    await expect(login(undefined, formData(VALID_FORM))).rejects.toThrow("REDIRECT:/dashboard");

    expect(mocks.cleanupExpiredLoginRateLimits).toHaveBeenCalledTimes(1);
  });

  it("does not run cleanup on a failed login attempt even on the low-probability branch", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.001);
    mocks.findUnique.mockResolvedValue(null);
    mocks.verifyPassword.mockResolvedValue(false);

    await login(undefined, formData(VALID_FORM));

    expect(mocks.cleanupExpiredLoginRateLimits).not.toHaveBeenCalled();
  });
});

describe("login — validation", () => {
  it("rejects a malformed email before ever checking the rate limiter", async () => {
    const result = await login(undefined, formData({ email: "not-an-email", password: "x" }));
    expect(result?.error).toBeTruthy();
    expect(mocks.checkLoginRateLimit).not.toHaveBeenCalled();
  });
});
