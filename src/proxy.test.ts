// @vitest-environment node
// See src/lib/auth/session.test.ts for why: jose needs the Node crypto path.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import proxy, { config } from "./proxy";
import { SESSION_COOKIE_NAME, encryptSession } from "@/lib/auth/session";

function makeRequest(path: string, cookieValue?: string) {
  const url = `https://example.com${path}`;
  const headers = new Headers();
  if (cookieValue) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${cookieValue}`);
  }
  return new NextRequest(url, { headers });
}

async function validToken() {
  return encryptSession({ userId: "user-1", expiresAt: Date.now() + 60_000 });
}

function parseCsp(response: Response): Record<string, string> {
  const raw = response.headers.get("Content-Security-Policy");
  expect(raw).toBeTruthy();
  const directives: Record<string, string> = {};
  for (const part of raw!.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...rest] = trimmed.split(" ");
    directives[name] = rest.join(" ");
  }
  return directives;
}

describe("proxy", () => {
  it("redirects an unauthenticated visitor away from a protected route to /login", async () => {
    const response = await proxy(makeRequest("/dashboard"));
    expect(response.headers.get("location")).toContain("/login");
  });

  it("redirects an unauthenticated visitor away from /settings to /login", async () => {
    const response = await proxy(makeRequest("/settings"));
    expect(response.headers.get("location")).toContain("/login");
  });

  it("lets an authenticated visitor reach a protected route", async () => {
    const response = await proxy(makeRequest("/dashboard", await validToken()));
    expect(response.headers.get("location")).toBeNull();
  });

  // The proxy deliberately does NOT redirect a valid-JWT visitor away from
  // /login — see the comment above that check in proxy.ts. It cannot tell
  // an active session from a deactivated user's still-unexpired cookie
  // (that requires the DB lookup only src/app/login/page.tsx's
  // getCurrentUser() can do), and previously redirecting on the JWT signal
  // alone produced a real, live-reproduced bug: a deactivated Staff
  // account's cookie bounced /login -> /dashboard here, then
  // requireUser()'s authoritative DB check bounced /dashboard -> /login,
  // forever, until the browser gave up with ERR_TOO_MANY_REDIRECTS.
  it("does NOT redirect a valid-JWT visitor away from /login — that authoritative decision belongs to the login page's own getCurrentUser() check", async () => {
    const response = await proxy(makeRequest("/login", await validToken()));
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets an unauthenticated visitor reach /login", async () => {
    const response = await proxy(makeRequest("/login"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("never bounces /login -> /dashboard -> /login for the same request in a way that could loop (regression: a deactivated account's still-valid JWT used to loop between these two routes until the browser aborted with ERR_TOO_MANY_REDIRECTS)", async () => {
    const token = await validToken();
    const fromLogin = await proxy(makeRequest("/login", token));
    const fromDashboard = await proxy(makeRequest("/dashboard", token));
    // Neither hop redirects at the proxy layer on a bare valid JWT — the
    // only place account-active-ness (and therefore this redirect
    // decision) can be resolved is a page's own DB-backed check.
    expect(fromLogin.headers.get("location")).toBeNull();
    expect(fromDashboard.headers.get("location")).toBeNull();
  });

  it("treats a tampered session cookie as unauthenticated", async () => {
    const tampered = `${(await validToken()).slice(0, -2)}xx`;
    const response = await proxy(makeRequest("/dashboard", tampered));
    expect(response.headers.get("location")).toContain("/login");
  });
});

describe("proxy — security headers", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSupabaseUrl = process.env.SUPABASE_URL;

  afterEach(() => {
    // @ts-expect-error -- test-only reset of a normally-readonly-typed env var
    process.env.NODE_ENV = originalNodeEnv;
    if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalSupabaseUrl;
  });

  it("sets X-Frame-Options and a Content-Security-Policy on an unauthenticated public route", async () => {
    const response = await proxy(makeRequest("/login"));
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("sets a CSP with every required directive", async () => {
    const response = await proxy(makeRequest("/login"));
    const csp = parseCsp(response);
    expect(csp).toHaveProperty("default-src");
    expect(csp).toHaveProperty("script-src");
    expect(csp).toHaveProperty("style-src");
    expect(csp).toHaveProperty("img-src");
    expect(csp).toHaveProperty("font-src");
    expect(csp["object-src"]).toBe("'none'");
    expect(csp["base-uri"]).toBe("'self'");
    expect(csp["form-action"]).toBe("'self'");
    expect(csp["frame-ancestors"]).toBe("'none'");
  });

  it("generates a fresh, different nonce on every call, embedded consistently in both script-src and style-src", async () => {
    const csp1 = parseCsp(await proxy(makeRequest("/login")));
    const csp2 = parseCsp(await proxy(makeRequest("/login")));

    const nonce1 = csp1["script-src"].match(/'nonce-([^']+)'/)?.[1];
    const nonce2 = csp2["script-src"].match(/'nonce-([^']+)'/)?.[1];
    expect(nonce1).toBeTruthy();
    expect(nonce2).toBeTruthy();
    expect(nonce1).not.toBe(nonce2);
    expect(csp1["style-src"]).toContain(`'nonce-${nonce1}'`);
  });

  it("also stamps the SAME nonce onto the request headers (x-nonce) — what lets Next.js auto-nonce its own inline scripts/styles", async () => {
    const response = await proxy(makeRequest("/login"));
    const csp = parseCsp(response);
    const nonce = csp["script-src"].match(/'nonce-([^']+)'/)?.[1];
    // NextResponse.next({ request: { headers } }) surfaces the rewritten
    // request headers back on the response under x-middleware-request-*.
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
  });

  it("includes 'unsafe-eval' only outside production, and upgrade-insecure-requests only in production", async () => {
    // proxy.ts captures `isProduction` once at module load time (correct
    // for the real app — one process, one NODE_ENV, for its whole
    // lifetime), so exercising both branches here means reloading the
    // module fresh under each value rather than mutating the env var
    // after it's already been imported.
    vi.resetModules();
    // @ts-expect-error -- test-only override
    process.env.NODE_ENV = "development";
    const { default: devProxy } = await import("./proxy");
    const dev = parseCsp(await devProxy(makeRequest("/login")));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(Object.keys(dev)).not.toContain("upgrade-insecure-requests");

    vi.resetModules();
    // @ts-expect-error -- test-only override
    process.env.NODE_ENV = "production";
    const { default: prodProxy } = await import("./proxy");
    const responseProd = await prodProxy(makeRequest("/login"));
    const prod = parseCsp(responseProd);
    expect(prod["script-src"]).not.toContain("'unsafe-eval'");
    expect(responseProd.headers.get("Content-Security-Policy")).toContain("upgrade-insecure-requests");
  });

  it("scopes img-src to the configured Supabase project origin, never a wildcard, and omits it entirely when unset", async () => {
    process.env.SUPABASE_URL = "https://my-real-project.supabase.co/";
    const withStorage = parseCsp(await proxy(makeRequest("/login")));
    expect(withStorage["img-src"]).toContain("https://my-real-project.supabase.co");
    expect(withStorage["img-src"]).not.toContain("*.supabase.co");

    delete process.env.SUPABASE_URL;
    const withoutStorage = parseCsp(await proxy(makeRequest("/login")));
    expect(withoutStorage["img-src"]).not.toContain("supabase.co");
    expect(withoutStorage["img-src"]).toContain("'self'");
  });

  it("never leaks a Supabase secret key or the database URL into any response header", async () => {
    process.env.SUPABASE_URL = "https://my-real-project.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "sb_secret_should_never_appear_anywhere";
    process.env.DATABASE_URL = "postgresql://user:should_never_appear@host:5432/db";

    const response = await proxy(makeRequest("/login"));
    const allHeaders = JSON.stringify(Object.fromEntries(response.headers.entries()));
    expect(allHeaders).not.toContain("sb_secret_should_never_appear_anywhere");
    expect(allHeaders).not.toContain("should_never_appear");

    delete process.env.SUPABASE_SECRET_KEY;
  });

  it("sets the full header set on a redirect response for an unauthenticated protected route", async () => {
    const response = await proxy(makeRequest("/dashboard"));
    expect(response.headers.get("location")).toContain("/login");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });

  it("still sets the full security header set on /login even for an authenticated visitor (no redirect happens here — see the dedicated proxy describe block above)", async () => {
    const response = await proxy(makeRequest("/login", await validToken()));
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("Content-Security-Policy")).toBeTruthy();
  });
});

describe("proxy — matcher config", () => {
  it("excludes Next's own prefetch requests — the documented pattern that fixed a real nonce-mismatch bug found via live production testing", () => {
    const entry = config.matcher[0];
    expect(typeof entry).toBe("object");
    if (typeof entry === "object") {
      expect(entry.missing).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "next-router-prefetch" }),
          expect.objectContaining({ key: "purpose", value: "prefetch" }),
        ])
      );
    }
  });
});
