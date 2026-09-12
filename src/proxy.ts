import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE_NAME, isValidSessionToken } from "@/lib/auth/session";

// Route-based, not role-based: this is an optimistic first line of defense
// only. Role checks (e.g. Settings being Owner-only) require a database
// lookup and are enforced authoritatively in each page via requireOwner()
// from src/lib/auth/dal.ts — see that file for why.
const PROTECTED_PREFIXES = [
  "/dashboard",
  "/accounting",
  "/diamond",
  "/jewellery-jobs",
  "/costing",
  "/settings",
];

const isProduction = process.env.NODE_ENV === "production";

/**
 * The only origin `img-src` needs beyond `'self'`: private diamond/
 * jewellery/costing media is served as signed URLs from this app's own
 * configured Supabase Storage project (see src/lib/storage/*Media.ts) —
 * never a wildcard `*.supabase.co`, which would let the page load images
 * from ANY Supabase project, not just this one. Storage is optional (see
 * .env.example) — when SUPABASE_URL isn't set, this is simply omitted and
 * no signed-media feature is in use anyway.
 */
function supabaseOrigin(): string | null {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function buildCsp(nonce: string): string {
  const supabase = supabaseOrigin();
  const imgSrc = ["'self'", "blob:", "data:", ...(supabase ? [supabase] : [])].join(" ");

  // 'unsafe-eval' is required by Turbopack's dev-mode HMR runtime and is
  // NEVER included in production. 'strict-dynamic' is required for Next's
  // CLIENT-SIDE (SPA) navigations: once the user is past the first full
  // page load, Next's router swaps in new route chunks via scripts
  // inserted by the already-nonce-validated bootstrap script, not via a
  // fresh server-rendered <script nonce=...> tag — 'strict-dynamic'
  // propagates trust from that already-validated script to whatever it
  // inserts, which a plain nonce allow-list can't express (a later
  // navigation's chunk would carry a stale nonce from whenever it was
  // fetched/prefetched, not the CURRENT document's). See the matcher's
  // prefetch exclusion below for the other half of what made this work
  // in a real production test.
  const scriptSrc = [
    "'self'",
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    ...(isProduction ? [] : ["'unsafe-eval'"]),
  ].join(" ");

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `img-src ${imgSrc}`,
    `font-src 'self'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(isProduction ? ["upgrade-insecure-requests"] : []),
  ];

  return directives.join("; ");
}

/** Applies the per-request CSP (with its nonce) to a response. The nonce
 * is also echoed onto the response's `x-nonce` header (mirroring the
 * request header set below) purely so it's visible to any response-level
 * inspection — the header Next.js actually reads to auto-nonce its own
 * framework scripts/styles is the request header, set before `next()`. */
function withSecurityHeaders(response: NextResponse, nonce: string): NextResponse {
  response.headers.set("Content-Security-Policy", buildCsp(nonce));
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const hasValidSession = await isValidSessionToken(token);

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (isProtected && !hasValidSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return withSecurityHeaders(NextResponse.redirect(loginUrl), nonce);
  }

  if (pathname === "/login" && hasValidSession) {
    return withSecurityHeaders(NextResponse.redirect(new URL("/dashboard", request.url)), nonce);
  }

  // Set on the REQUEST headers too (not just the response) — this is what
  // lets Next.js read `x-nonce`/the CSP back out during rendering and
  // automatically stamp its own inline scripts/styles with this exact
  // nonce, per Next's documented proxy-nonce pattern.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", buildCsp(nonce));

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  return withSecurityHeaders(response, nonce);
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)",
      // Excludes Next's own client-router prefetch requests — verified
      // live that WITHOUT this exclusion, a fresh nonce/CSP generated for
      // a background prefetch could end up mismatched against the
      // currently-active page's CSP by the time that prefetched chunk is
      // actually used, blocking real script loads on the very first page
      // load. This is Next's own documented matcher pattern for exactly
      // this reason (see the with-strict-csp example in their repo).
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
