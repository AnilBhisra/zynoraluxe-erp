// @vitest-environment node
// See src/lib/auth/session.test.ts for why: jose needs the Node crypto path.
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import proxy from "./proxy";
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

  it("redirects an authenticated visitor away from /login to /dashboard", async () => {
    const response = await proxy(makeRequest("/login", await validToken()));
    expect(response.headers.get("location")).toContain("/dashboard");
  });

  it("lets an unauthenticated visitor reach /login", async () => {
    const response = await proxy(makeRequest("/login"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("treats a tampered session cookie as unauthenticated", async () => {
    const tampered = `${(await validToken()).slice(0, -2)}xx`;
    const response = await proxy(makeRequest("/dashboard", tampered));
    expect(response.headers.get("location")).toContain("/login");
  });
});
