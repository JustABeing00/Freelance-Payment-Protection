import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Client-portal magic links (security-principles §3):
 * - CSPRNG ≥256-bit nonce, stored as sha256 hash (never the raw token)
 * - single-project scope (projectId bound into the signed payload)
 * - expiring (default 7d via MAGIC_LINK_TTL_HOURS, max 30d)
 * - rotation = issue a new nonce; verification is constant-time
 *
 * Token format: `v1.{projectId}.{expUnix}.{nonce}.{sig}`
 * where sig = HMAC-SHA256(sessionSecret, `v1.{projectId}.{expUnix}.{nonce}`).
 */

export interface MagicLinkClaims {
  projectId: string;
  expiresAt: Date;
  nonce: string;
}

const PREFIX = "v1";
const NONCE_BYTES = 32;

export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function issueMagicLink(args: {
  projectId: string;
  sessionSecret: string;
  now?: Date;
  ttlHours?: number;
}): { token: string; claims: MagicLinkClaims; tokenHash: string } {
  const { projectId, sessionSecret } = args;
  const now = args.now ?? new Date();
  const ttlHours = Math.min(Math.max(args.ttlHours ?? 168, 1), 720);
  if (!projectId) throw new Error("projectId is required");
  if (sessionSecret.length < 32) {
    throw new Error("sessionSecret must be at least 32 characters (fail-closed)");
  }
  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  const expUnix = Math.floor(now.getTime() / 1000) + ttlHours * 3600;
  const body = `${PREFIX}.${projectId}.${expUnix}.${nonce}`;
  const sig = createHmac("sha256", sessionSecret).update(body, "utf8").digest("hex");
  const token = `${body}.${sig}`;
  const claims: MagicLinkClaims = {
    projectId,
    expiresAt: new Date(expUnix * 1000),
    nonce,
  };
  return { token, claims, tokenHash: hashToken(token) };
}

export function verifyMagicLink(args: {
  token: string;
  expectedProjectId: string;
  sessionSecret: string;
  now?: Date;
}): MagicLinkClaims {
  const { token, expectedProjectId, sessionSecret } = args;
  const now = args.now ?? new Date();
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== PREFIX) {
    throw new Error("Invalid magic link format");
  }
  const [, projectId, expRaw, nonce, sig] = parts as [string, string, string, string, string];
  if (projectId !== expectedProjectId) {
    throw new Error("Magic link is not scoped to this project");
  }
  const expUnix = Number(expRaw);
  if (!Number.isInteger(expUnix) || expUnix * 1000 <= now.getTime()) {
    throw new Error("Magic link expired");
  }
  const body = `${PREFIX}.${projectId}.${expUnix}.${nonce}`;
  const expected = createHmac("sha256", sessionSecret).update(body, "utf8").digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid magic link signature");
  }
  return { projectId, expiresAt: new Date(expUnix * 1000), nonce };
}
