import { describe, expect, it } from "vitest";
import {
  IdempotencyStore,
  signTestPayload,
  verifyWebhookSignature,
} from "../../src/lib/webhook.js";

const SECRET = "whsec_test_secret_for_foundation_checks";

describe("webhook verification + idempotency (provider events are truth)", () => {
  it("accepts a correctly signed payload within tolerance", () => {
    const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
    const header = signTestPayload({ rawBody: body, webhookSecret: SECRET });
    expect(() =>
      verifyWebhookSignature({ rawBody: body, signatureHeader: header, webhookSecret: SECRET }),
    ).not.toThrow();
  });

  it("rejects tampered bodies, stale timestamps, and missing headers", () => {
    const body = JSON.stringify({ id: "evt_1" });
    const header = signTestPayload({ rawBody: body, webhookSecret: SECRET });
    expect(() =>
      verifyWebhookSignature({
        rawBody: `${body} `,
        signatureHeader: header,
        webhookSecret: SECRET,
      }),
    ).toThrow(/signature/i);

    const stale = signTestPayload({
      rawBody: body,
      webhookSecret: SECRET,
      timestampUnix: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(() =>
      verifyWebhookSignature({ rawBody: body, signatureHeader: stale, webhookSecret: SECRET }),
    ).toThrow(/tolerance/);

    expect(() =>
      verifyWebhookSignature({ rawBody: body, signatureHeader: undefined, webhookSecret: SECRET }),
    ).toThrow(/missing/i);
  });

  it("duplicate delivery consumes once (replay → single PaymentReceived)", () => {
    const store = new IdempotencyStore();
    expect(store.consume("evt_1")).toBe(false); // first: process
    expect(store.consume("evt_1")).toBe(true); // replay: skip side effects
    expect(store.consume("evt_2")).toBe(false);
  });
});
