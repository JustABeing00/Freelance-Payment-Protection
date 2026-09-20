import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Payment-webhook security (security-principles §5):
 * - signature verification with timestamp tolerance (Stripe-style header)
 * - idempotency-key dedupe: persist provider event id BEFORE side effects
 * - amount validation happens in the handler (mismatch → needs_review, no release)
 *
 * Header format accepted: `t=<unix>,v1=<hex>` (Stripe-Signature compatible).
 */

export interface WebhookVerifyInput {
  rawBody: string | Buffer;
  signatureHeader: string | undefined;
  webhookSecret: string;
  toleranceSeconds?: number;
  nowUnix?: number;
}

export function verifyWebhookSignature(input: WebhookVerifyInput): { eventIdHint: string } {
  const { rawBody, signatureHeader, webhookSecret } = input;
  const tolerance = input.toleranceSeconds ?? 300;
  const nowUnix = input.nowUnix ?? Math.floor(Date.now() / 1000);

  if (!signatureHeader) throw new Error("Missing webhook signature header");
  if (!webhookSecret) throw new Error("Webhook secret not configured (fail-closed)");

  const pairs: [string, string][] = signatureHeader.split(",").map((kv) => {
    const eq = kv.indexOf("=");
    if (eq === -1) return [kv.trim(), ""];
    return [kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()];
  });
  const parts: Record<string, string> = Object.fromEntries(pairs);
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1) throw new Error("Malformed webhook signature header");
  if (Math.abs(nowUnix - t) > tolerance) throw new Error("Webhook timestamp outside tolerance");

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", webhookSecret).update(`${t}.${body}`, "utf8").digest("hex");
  const a = Buffer.from(v1, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid webhook signature");
  }
  return { eventIdHint: `${t}:${v1.slice(0, 12)}` };
}

/** Test helper: sign a payload the same way Stripe would. */
export function signTestPayload(args: {
  rawBody: string;
  webhookSecret: string;
  timestampUnix?: number;
}): string {
  const t = args.timestampUnix ?? Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", args.webhookSecret)
    .update(`${t}.${args.rawBody}`, "utf8")
    .digest("hex");
  return `t=${t},v1=${v1}`;
}

/**
 * In-memory idempotency store. Production uses a UNIQUE DB column
 * (payments.idempotency_key / events.idempotency_key); this class models the
 * same "first write wins" semantics for handlers and tests.
 */
export class IdempotencyStore {
  private readonly seen = new Map<string, unknown>();

  /** Returns true if this key was already processed (duplicate → skip side effects). */
  consume(key: string, value: unknown = true): boolean {
    if (this.seen.has(key)) return true;
    this.seen.set(key, value);
    return false;
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  clear(): void {
    this.seen.clear();
  }
}
