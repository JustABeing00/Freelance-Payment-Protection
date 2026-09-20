import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Unsubscribe tokens (Session 18). Every transactional email footers a
 * manage-preferences link; the token proves ownership of the address without
 * requiring a login (clients have no accounts — only magic links).
 *
 * Format: base64url(payload).base64url(sig) where payload is
 * `{w:<workspaceId>,e:<email>,c:<category>,x:<expiryMs>}` and sig is
 * HMAC-SHA256 over the payload with the session secret. 1-year TTL;
 * constant-time verify; generic errors (no oracle).
 */

const TOKEN_TTL_MS = 365 * 86_400_000;

function b64urlEncode(raw: string): string {
  return Buffer.from(raw, "utf8").toString("base64url");
}

function b64urlDecode(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}

export function signUnsubscribeToken(args: {
  workspaceId: string;
  email: string;
  category: string;
  secret: string;
  expiresAtMs?: number;
}): string {
  const payload = JSON.stringify({
    w: args.workspaceId,
    e: args.email.trim().toLowerCase(),
    c: args.category,
    x: args.expiresAtMs ?? Date.now() + TOKEN_TTL_MS,
  });
  const encoded = b64urlEncode(payload);
  const sig = createHmac("sha256", args.secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

export function verifyUnsubscribeToken(args: { token: string; secret: string }): {
  workspaceId: string;
  email: string;
  category: string;
} {
  const parts = args.token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("invalid token");
  const [encoded, sig] = parts as [string, string];
  const expected = createHmac("sha256", args.secret).update(encoded).digest("base64url");
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("invalid token");
  let payload: { w?: unknown; e?: unknown; c?: unknown; x?: unknown };
  try {
    payload = JSON.parse(b64urlDecode(encoded)) as typeof payload;
  } catch {
    throw new Error("invalid token");
  }
  if (
    typeof payload.w !== "string" ||
    typeof payload.e !== "string" ||
    typeof payload.c !== "string" ||
    typeof payload.x !== "number" ||
    payload.x < Date.now()
  ) {
    throw new Error("invalid token");
  }
  return { workspaceId: payload.w, email: payload.e, category: payload.c };
}
