import "server-only";

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const SESSION_COOKIE_NAME = "zynoraluxe_session";
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getSecretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "SESSION_SECRET is not set. Copy .env.example to .env and generate one with `openssl rand -base64 32`."
    );
  }
  return new TextEncoder().encode(secret);
}

type SessionPayload = {
  userId: string;
  expiresAt: number;
};

export async function encryptSession(payload: SessionPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(payload.expiresAt / 1000))
    .sign(getSecretKey());
}

export async function decryptSession(
  token: string | undefined
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), {
      algorithms: ["HS256"],
    });
    if (typeof payload.userId !== "string" || typeof payload.expiresAt !== "number") {
      return null;
    }
    return { userId: payload.userId, expiresAt: payload.expiresAt };
  } catch {
    return null;
  }
}

/** Creates a signed session cookie for the given user. Called only after
 * credentials have been verified against the database. */
export async function createSession(userId: string): Promise<void> {
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const session = await encryptSession({ userId, expiresAt });
  const cookieStore = await cookies();

  cookieStore.set(SESSION_COOKIE_NAME, session, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    expires: new Date(expiresAt),
    sameSite: "lax",
    path: "/",
  });
}

export async function deleteSession(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

/** Reads and verifies the session cookie for the current request. Returns
 * only the user id — callers must look up the user in the database to get
 * an authoritative, up-to-date role and active status. */
export async function readSessionCookie(): Promise<{ userId: string } | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const session = await decryptSession(token);
  if (!session) return null;
  return { userId: session.userId };
}

/** Signature/expiry-only check for a raw cookie value, for use in Proxy
 * where `next/headers` cookies() is unavailable. This is an optimistic
 * check — it does not confirm the user still exists or is active. */
export async function isValidSessionToken(token: string | undefined): Promise<boolean> {
  const session = await decryptSession(token);
  return session !== null;
}

export { SESSION_COOKIE_NAME };
