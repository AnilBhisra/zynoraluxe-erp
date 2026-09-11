import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db/prisma";
import { readSessionCookie } from "@/lib/auth/session";
import type { UserRole } from "@/generated/prisma/enums";

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
};

/**
 * Authoritative session check. Re-reads the user from the database on every
 * call (memoized per request via React's cache) so a role change or account
 * deactivation takes effect immediately, not just when the session cookie
 * expires. Returns null when there is no valid, active session.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await readSessionCookie();
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });

  if (!user || !user.isActive) return null;

  return { id: user.id, email: user.email, name: user.name, role: user.role };
});

/** Requires any authenticated, active user. Redirects to /login otherwise. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

/** Requires an authenticated Owner. Redirects Staff to /unauthorized. */
export async function requireOwner(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "OWNER") {
    redirect("/unauthorized");
  }
  return user;
}
