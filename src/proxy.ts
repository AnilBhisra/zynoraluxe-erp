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

export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const hasValidSession = await isValidSessionToken(token);

  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (isProtected && !hasValidSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname === "/login" && hasValidSession) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$).*)",
  ],
};
