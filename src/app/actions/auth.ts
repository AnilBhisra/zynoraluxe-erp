"use server";

import { redirect } from "next/navigation";

import { prisma } from "@/lib/db/prisma";
import { verifyPassword, hashPassword } from "@/lib/auth/password";
import { createSession, deleteSession } from "@/lib/auth/session";
import { loginSchema } from "@/lib/validation/auth";
import {
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginRateLimitOnSuccess,
  cleanupExpiredLoginRateLimits,
} from "@/lib/auth/rateLimit";

export type LoginFormState = { error: string } | undefined;

const GENERIC_LOGIN_ERROR = "Incorrect email or password.";

function tooManyAttemptsMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

// Computed once per server process, never logged: a real bcrypt hash of a
// fixed, meaningless string. Comparing against this for a nonexistent
// account keeps verifyPassword's runtime close to the real-account path,
// so measuring response time can't reveal whether an email is registered.
let dummyPasswordHash: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHash) {
    dummyPasswordHash = hashPassword("zynoraluxe-timing-safety-placeholder");
  }
  return dummyPasswordHash;
}

export async function login(
  _prevState: LoginFormState,
  formData: FormData
): Promise<LoginFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Please check your details." };
  }

  const { email, password } = parsed.data;

  const rateLimitStatus = await checkLoginRateLimit(email);
  if (rateLimitStatus.blocked) {
    return { error: tooManyAttemptsMessage(rateLimitStatus.retryAfterSeconds) };
  }

  const user = await prisma.user.findUnique({ where: { email } });

  // Always do real bcrypt work, win or lose, so a nonexistent account
  // takes statistically the same time to reject as a wrong password on a
  // real one — see getDummyPasswordHash().
  const passwordMatches = await verifyPassword(password, user?.passwordHash ?? (await getDummyPasswordHash()));

  if (!user || !user.isActive || !passwordMatches) {
    await recordLoginFailure(email);
    return { error: GENERIC_LOGIN_ERROR };
  }

  await resetLoginRateLimitOnSuccess(email);

  // Cheap, unscheduled maintenance: no cron/queue infra for a single
  // small-business deployment, so a low-probability sweep on successful
  // logins keeps the table bounded without ever blocking a real request
  // on it. See scripts/cleanupLoginRateLimits.ts for the manual/cron path.
  if (Math.random() < 0.01) {
    cleanupExpiredLoginRateLimits().catch((err) => {
      console.error("[login-rate-limit] opportunistic cleanup failed", err);
    });
  }

  await createSession(user.id);
  redirect("/dashboard");
}

export async function logout(): Promise<void> {
  await deleteSession();
  redirect("/login");
}
