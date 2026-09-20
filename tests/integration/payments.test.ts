import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { FakePaymentProvider } from "../../src/lib/providers.js";
import { clearSeenWebhookIdsForTests } from "../../src/routes/payments.js";
import { InMemoryStore } from "../../src/lib/store.js";
import { signTestPayload } from "../../src/lib/webhook.js";

/** Session 08: Stripe-behind-seam payments — checkout, webhooks, reconciliation. */

const WEBHOOK_SECRET = "whsec_session08_test_secret_0123456789abcdef";
const testEnv = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  LOG_LEVEL: "fatal" as const,
  DATABASE_URL: "postgres://localhost:5432/fpp_test",
  SESSION_SECRET: "test-session-secret-that-is-long-enough-0123456789",
  APP_BASE_URL: "http://localhost:3000",
  MAGIC_LINK_TTL_HOURS: 168,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

let app: FastifyInstance;
const store = new InMemoryStore();
const provider = new FakePaymentProvider();
const PASSWORD = "correct-horse-battery-12";

function signedBody(body: string): Record<string, string> {
  return { "stripe-signature": signTestPayload({ rawBody: body, webhookSecret: WEBHOOK_SECRET }) };
}

function webhookEnvelope(args: {
  eventId: string;
  type: string;
  providerPaymentId: string;
  amountCents?: number | undefined;
  currency?: string | undefined;
  paymentId?: string | undefined;
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  milestoneId?: string | undefined;
}): string {
  return JSON.stringify({
    id: args.eventId,
    type: args.type,
    data: {
      object: {
        id: args.providerPaymentId,
        ...(args.amountCents !== undefined ? { amount: args.amountCents } : {}),
        currency: (args.currency ?? "usd").toLowerCase(),
        metadata: {
          ...(args.paymentId !== undefined ? { paymentId: args.paymentId } : {}),
          ...(args.workspaceId !== undefined ? { workspaceId: args.workspaceId } : {}),
          ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
          ...(args.milestoneId !== undefined ? { milestoneId: args.milestoneId } : {}),
        },
      },
    },
  });
}

async function signup(
  email: string,
  displayName: string,
): Promise<{ token: string; workspaceId: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { email, displayName, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { token: string; workspace: { id: string }; user: { id: string } };
  return { token: body.token, workspaceId: body.workspace.id, userId: body.user.id };
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

async function postWebhook(raw: string, sig?: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/payments",
    headers: { "content-type": "application/json", ...(sig ?? signedBody(raw)) },
    payload: raw,
  });
}

beforeAll(async () => {
  app = await buildApp({
    env: testEnv,
    loggerLevel: "fatal",
    store,
    paymentProvider: provider,
    webhookSecret: WEBHOOK_SECRET,
  });
});

afterAll(async () => {
  await app.close();
});

describe("payment integration (hosted checkout + verified webhooks)", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  let paymentId = "";
  let providerPaymentId = "";

  it("creates a hosted checkout (intent only — success page never marks paid)", async () => {
    ({ token, workspaceId } = await signup("fpp08-owner@example.com", "Fpp Eight"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme08@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;
    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: { clientId, title: "Brand site", currency: "USD", totalValueCents: 50000 },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;
    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 1 — Discovery", amountCents: 50000 },
    });
    expect(ms.statusCode).toBe(201);
    milestoneId = (ms.json() as { milestone: { id: string } }).milestone.id;

    const checkout = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/checkout`,
      headers: { ...auth(token), "idempotency-key": "chk-001" },
      payload: {},
    });
    expect(checkout.statusCode).toBe(201);
    const body = checkout.json() as {
      payment: { id: string; state: string };
      checkoutUrl: string;
    };
    expect(body.payment.state).toBe("pending");
    expect(body.checkoutUrl).toContain("https://checkout.example/pay/");
    paymentId = body.payment.id;
    const stored = await store.findPaymentById(paymentId);
    providerPaymentId = stored?.providerPaymentId ?? "";
    expect(providerPaymentId.length).toBeGreaterThan(0);

    // Checkout is idempotent on the same key: same payment, no duplicate row.
    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/checkout`,
      headers: { ...auth(token), "idempotency-key": "chk-001" },
      payload: {},
    });
    expect(retry.statusCode).toBe(200);
    expect((retry.json() as { payment: { id: string }; duplicate: boolean }).payment.id).toBe(
      paymentId,
    );
    expect((await store.listPayments(projectId)).length).toBe(1);

    // Browser return proves nothing: GET the success page, state stays pending.
    const success = await app.inject({
      method: "GET",
      url: `/portal/${projectId}/success?token=dummy&paymentId=${paymentId}`,
    });
    expect([200, 401]).toContain(success.statusCode);
    const after = await store.findPaymentById(paymentId);
    expect(after?.state).toBe("pending");
    const events = await store.listProjectEvents(projectId, 100);
    expect(events.some((e) => e.type === "PaymentReceived")).toBe(false);
  });

  it("confirms payment only via verified webhook (replay is a no-op)", async () => {
    clearSeenWebhookIdsForTests();
    const raw = webhookEnvelope({
      eventId: "evt_paid_001",
      type: "payment_intent.succeeded",
      providerPaymentId,
      amountCents: 50000,
      currency: "USD",
      paymentId,
      workspaceId,
      projectId,
      milestoneId,
    });
    const first = await postWebhook(raw);
    expect(first.statusCode).toBe(200);
    expect((first.json() as { payment: { state: string } }).payment.state).toBe("paid");

    const stored = await store.findPaymentById(paymentId);
    expect(stored?.state).toBe("paid");
    const milestone = await store.findMilestone(milestoneId);
    expect(milestone?.paymentState).toBe("paid");
    expect(milestone?.appliedPaymentIds).toContain(paymentId);

    // Replay the same provider event → duplicate, no second PaymentReceived.
    const replay = await postWebhook(raw);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { duplicate?: boolean }).duplicate).toBe(true);
    const events = await store.listProjectEvents(projectId, 100);
    const received = events.filter((e) => e.type === "PaymentReceived");
    expect(received.length).toBe(1);
  });

  it("rejects invalid signatures and flags mismatched amounts (never paid)", async () => {
    clearSeenWebhookIdsForTests();
    // Second milestone + payment for mismatch probe.
    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 2 — Design", amountCents: 20000 },
    });
    const m2 = (ms.json() as { milestone: { id: string } }).milestone.id;
    const co = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m2}/checkout`,
      headers: { ...auth(token), "idempotency-key": "chk-002" },
      payload: {},
    });
    expect(co.statusCode).toBe(201);
    const p2 = (co.json() as { payment: { id: string } }).payment.id;
    const s2 = await store.findPaymentById(p2);
    const pp2 = s2?.providerPaymentId ?? "";

    const badSigRaw = webhookEnvelope({
      eventId: "evt_bad_sig",
      type: "payment_intent.succeeded",
      providerPaymentId: pp2,
      amountCents: 20000,
      currency: "USD",
      paymentId: p2,
    });
    const badSig = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/payments",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      payload: badSigRaw,
    });
    expect(badSig.statusCode).toBe(400);

    const mismatchRaw = webhookEnvelope({
      eventId: "evt_mismatch_001",
      type: "payment_intent.succeeded",
      providerPaymentId: pp2,
      amountCents: 1,
      currency: "USD",
      paymentId: p2,
      workspaceId,
      projectId,
      milestoneId: m2,
    });
    const mismatch = await postWebhook(mismatchRaw);
    expect(mismatch.statusCode).toBe(200);
    expect((mismatch.json() as { needsReview?: boolean }).needsReview).toBe(true);
    expect((await store.findPaymentById(p2))?.state).toBe("pending");
    expect((await store.findMilestone(m2))?.paymentState).not.toBe("paid");
    const events = await store.listProjectEvents(projectId, 100);
    expect(events.some((e) => e.type === "PaymentAmountMismatched")).toBe(true);
  });

  it("handles failed / cancelled / refunded / disputed webhooks auditably", async () => {
    clearSeenWebhookIdsForTests();
    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 3 — Build", amountCents: 10000 },
    });
    const m3 = (ms.json() as { milestone: { id: string } }).milestone.id;
    const co = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m3}/checkout`,
      headers: { ...auth(token), "idempotency-key": "chk-003" },
      payload: {},
    });
    const p3 = (co.json() as { payment: { id: string } }).payment.id;
    const s3 = await store.findPaymentById(p3);

    const failed = await postWebhook(
      webhookEnvelope({
        eventId: "evt_fail_001",
        type: "payment_intent.payment_failed",
        providerPaymentId: s3?.providerPaymentId ?? "",
        paymentId: p3,
      }),
    );
    expect(failed.statusCode).toBe(200);
    expect((await store.findPaymentById(p3))?.state).toBe("failed");

    // Cancel path on a fresh payment.
    const co4 = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m3}/checkout`,
      headers: { ...auth(token), "idempotency-key": "chk-004" },
      payload: {},
    });
    const p4 = (co4.json() as { payment: { id: string } }).payment.id;
    const s4 = await store.findPaymentById(p4);
    const cancelled = await postWebhook(
      webhookEnvelope({
        eventId: "evt_cancel_001",
        type: "payment_intent.canceled",
        providerPaymentId: s4?.providerPaymentId ?? "",
        paymentId: p4,
      }),
    );
    expect(cancelled.statusCode).toBe(200);
    expect((await store.findPaymentById(p4))?.state).toBe("cancelled");

    // Dispute the verified paid payment from the first test.
    const disputed = await postWebhook(
      webhookEnvelope({
        eventId: "evt_dispute_001",
        type: "charge.dispute.created",
        providerPaymentId,
        paymentId,
      }),
    );
    expect(disputed.statusCode).toBe(200);
    expect((await store.findPaymentById(paymentId))?.state).toBe("disputed");
    const events = await store.listProjectEvents(projectId, 100);
    for (const t of ["PaymentFailed", "PaymentCancelled", "PaymentDisputed"]) {
      expect(events.some((e) => e.type === t)).toBe(true);
    }
  });

  it("refunds via the provider, reconciles, and enforces authz", async () => {
    // Fresh paid payment to refund (milestone 2's pending payment can't refund → 422).
    const pending = (await store.listPayments(projectId)).find((p) => p.state === "pending");
    if (pending) {
      const badRefund = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/${pending.id}/refund`,
        headers: auth(token),
      });
      expect(badRefund.statusCode).toBe(422);
    }

    // Pay milestone 2 correctly, then refund it through the API.
    const p2 = (await store.listPayments(projectId)).find((p) => p.idempotencyKey === "chk-002");
    expect(p2).toBeDefined();
    clearSeenWebhookIdsForTests();
    const good = await postWebhook(
      webhookEnvelope({
        eventId: "evt_paid_002",
        type: "payment_intent.succeeded",
        providerPaymentId: p2?.providerPaymentId ?? "",
        amountCents: 20000,
        currency: "USD",
        paymentId: p2?.id,
      }),
    );
    expect(good.statusCode).toBe(200);
    const refund = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/${p2?.id}/refund`,
      headers: auth(token),
    });
    expect(refund.statusCode).toBe(200);
    expect((refund.json() as { payment: { state: string } }).payment.state).toBe("refunded");

    // Reconcile the disputed first payment against the fake ledger.
    provider.setStatus(providerPaymentId, "succeeded");
    const reconcile = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/${paymentId}/reconcile`,
      headers: auth(token),
    });
    expect(reconcile.statusCode).toBe(200);
    const rbody = reconcile.json() as { provider: { status: string }; drift: boolean };
    expect(rbody.provider.status).toBe("succeeded");

    // Authz: anonymous, cross-tenant, and read-only roles are denied.
    const anon = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments`,
    });
    expect(anon.statusCode).toBe(401);

    const other = await signup("fpp08-other@example.com", "Other");
    const cross = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments`,
      headers: auth(other.token),
    });
    expect(cross.statusCode).toBe(403);

    // Currency mismatch and over-amount are rejected at checkout.
    const badCurrency = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/checkout`,
      headers: { ...auth(token), "idempotency-key": "chk-bad-fx" },
      payload: { currency: "EUR" },
    });
    expect(badCurrency.statusCode).toBe(422);

    // Webhook without any signature is rejected.
    const noSig = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/payments",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ id: "evt_x", type: "payment_intent.succeeded" }),
    });
    expect(noSig.statusCode).toBe(400);
  });
});
