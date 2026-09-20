import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Stateless session tokens (freelancer auth).
 *
 * Format: `s1.{userId}.{iatUnix}.{expUnix}.{nonce}.{sig}`
 * where sig = HMAC-SHA256(sessionSecret, `s1.{userId}.{iatUnix}.{expUnix}.{nonce}`).
 *
 * - No DB session table: horizontal scale without sticky sessions; sign-out is
 *   client-side discard + cookie clear. Server-side revocation (token denylist
 *   / version column) is a documented follow-up, not MVP.
 * - Constant-time signature compare; fail-closed on short secrets and expiry.
 * - Default TTL 7 days; callers may pass shorter TTLs for tests.
 */

const PREFIX = "s1";
const NONCE_BYTES = 16;

export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface SessionClaims {
  readonly userId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export function createSessionToken(args: {
  userId: string;
  sessionSecret: string;
  now?: Date;
  ttlSeconds?: number;
}): { token: string; claims: SessionClaims } {
  const { userId, sessionSecret } = args;
  const now = args.now ?? new Date();
  const ttl = args.ttlSeconds ?? SESSION_TTL_SECONDS;
  if (!userId) throw new Error("userId is required");
  if (sessionSecret.length < 32) {
    throw new Error("sessionSecret must be at least 32 characters (fail-closed)");
  }
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 30 * 24 * 3600) {
    throw new Error("ttlSeconds must be a positive integer (max 30 days)");
  }
  const iatUnix = Math.floor(now.getTime() / 1000);
  const expUnix = iatUnix + ttl;
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  const body = `${PREFIX}.${userId}.${iatUnix}.${expUnix}.${nonce}`;
  const sig = createHmac("sha256", sessionSecret).update(body, "utf8").digest("hex");
  const token = `${body}.${sig}`;
  return {
    token,
    claims: {
      userId,
      issuedAt: new Date(iatUnix * 1000),
      expiresAt: new Date(expUnix * 1000),
    },
  };
}

export function verifySessionToken(args: {
  token: string;
  sessionSecret: string;
  now?: Date;
}): SessionClaims {
  const { token, sessionSecret } = args;
  const now = args.now ?? new Date();
  if (sessionSecret.length < 32) {
    throw new Error("sessionSecret must be at least 32 characters (fail-closed)");
  }
  const parts = token.split(".");
  if (parts.length !== 6 || parts[0] !== PREFIX) {
    throw new Error("Invalid session format");
  }
  const [, userId, iatRaw, expRaw, nonce, sig] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!userId || !nonce) throw new Error("Invalid session format");
  const iatUnix = Number(iatRaw);
  const expUnix = Number(expRaw);
  if (!Number.isInteger(iatUnix) || !Number.isInteger(expUnix)) {
    throw new Error("Invalid session timestamps");
  }
  if (expUnix * 1000 <= now.getTime()) throw new Error("Session expired");
  if (iatUnix * 1000 > now.getTime() + 60_000) throw new Error("Session issued in the future");
  const body = `${PREFIX}.${userId}.${iatUnix}.${expUnix}.${nonce}`;
  const expected = createHmac("sha256", sessionSecret).update(body, "utf8").digest("hex");
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(sig, "hex");
    b = Buffer.from(expected, "hex");
  } catch {
    throw new Error("Invalid session signature");
  }
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid session signature");
  }
  return {
    userId,
    issuedAt: new Date(iatUnix * 1000),
    expiresAt: new Date(expUnix * 1000),
  };
}

/** Extract a session token from `Authorization: Bearer …` or the `session` cookie. */
export function extractSessionToken(headers: {
  authorization?: unknown;
  cookie?: unknown;
}): string | undefined {
  const auth = typeof headers.authorization === "string" ? headers.authorization : undefined;
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]) return match[1].trim();
  }
  const cookie = typeof headers.cookie === "string" ? headers.cookie : undefined;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (name === "session" && value) {
        try {
          return decodeURIComponent(value);
        } catch {
          return value;
        }
      }
    }
  }
  return undefined;
}

/** `Set-Cookie` value for the session cookie (HttpOnly, SameSite=Lax, Secure in prod). */
export function buildSessionCookie(token: string, isProduction: boolean): string {
  const parts = [
    `session=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (isProduction) parts.push("Secure");
  return parts.join("; ");
}

/** Expired cookie value used on sign-out. */
export function buildClearedSessionCookie(): string {
  return "session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0";
}
