import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { FakePaymentProvider } from "../../src/lib/providers.js";
import { clearSeenWebhookIdsForTests } from "../../src/routes/payments.js";
import { InMemoryStore } from "../../src/lib/store.js";
import { signTestPayload } from "../../src/lib/webhook.js";

/** Session 09: payment trust — reconciliation, history, diagnostics, claims. */

const WEBHOOK_SECRET = "whsec_session09_trust_test_0123456789abcdef";
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
}): string {
  return JSON.stringify({
    id: args.eventId,
    type: args.type,
    data: {
      object: {
        id: args.providerPaymentId,
        ...(args.amountCents !== undefined ? { amount: args.amountCents } : {}),
        currency: (args.currency ?? "usd").toLowerCase(),
        metadata: { ...(args.paymentId !== undefined ? { paymentId: args.paymentId } : {}) },
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

async function postWebhook(raw: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/payments",
    headers: { "content-type": "application/json", ...signedBody(raw) },
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

describe("payment trust: claims, reconciliation, history, diagnostics", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  let paymentId = "";
  let providerPaymentId = "";

  it("sets up a project with one milestone and one checkout", async () => {
    ({ token, workspaceId } = await signup("fpp09-owner@example.com", "Fpp Nine"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme09@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;
    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: { clientId, title: "Trust site", currency: "USD", totalValueCents: 50000 },
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
      headers: { ...auth(token), "idempotency-key": "trust-chk-001" },
      payload: {},
    });
    expect(checkout.statusCode).toBe(201);
    const body = checkout.json() as { payment: { id: string; state: string } };
    paymentId = body.payment.id;
    providerPaymentId = (await store.findPaymentById(paymentId))?.providerPaymentId ?? "";
    expect(providerPaymentId.length).toBeGreaterThan(0);
  });

  it("records a freelancer claim without marking paid (totals unchanged)", async () => {
    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/claim`,
      headers: auth(token),
      payload: { note: "Client says the wire went out" },
    });
    expect(claim.statusCode).toBe(201);
    expect((await store.findMilestone(milestoneId))?.paymentState).toBe("claimed_unverified");
    expect((await store.findPaymentById(paymentId))?.state).toBe("pending");

    const recon = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/reconciliation`,
      headers: auth(token),
    });
    expect(recon.statusCode).toBe(200);
    const rbody = recon.json() as {
      reconciliation: {
        totals: { verifiedPaidCents: number; outstandingCents: number };
        verification: { claimedMilestones: number };
      };
    };
    expect(rbody.reconciliation.totals.verifiedPaidCents).toBe(0);
    expect(rbody.reconciliation.totals.outstandingCents).toBe(50000);
    expect(rbody.reconciliation.verification.claimedMilestones).toBe(1);

    // Repeating the claim is idempotent, still not paid.
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/claim`,
      headers: auth(token),
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { duplicate: boolean }).duplicate).toBe(true);
  });

  it("serves human-readable history with the claim marked NOT-verified", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/history`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      history: { headline: string; tier: string; kind: string }[];
    };
    expect(body.history.length).toBeGreaterThan(0);
    const claim = body.history.find((h) => h.kind === "claimed");
    expect(claim).toBeDefined();
    expect(claim?.headline).toMatch(/NOT verified/);
    expect(claim?.tier).toBe("claimed");
    expect(body.history.some((h) => h.headline.startsWith("Provider confirmed"))).toBe(false);
  });

  it("exposes admin diagnostics grouped by severity", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/diagnostics`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      balanced: boolean;
      errors: { code: string }[];
      warnings: { code: string }[];
      info: { code: string }[];
      verification: Record<string, number>;
    };
    expect(body.verification.claimedMilestones).toBe(1);
    expect(body.warnings.some((w) => w.code === "claimed_without_payment")).toBe(true);
    expect(body.info.some((w) => w.code === "initiated_without_confirmation")).toBe(true);
  });

  it("lets the client file an 'I paid' claim that never marks paid", async () => {
    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    const portalToken = (issued.json() as { token: string }).token;

    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/claim`,
      payload: { token: portalToken, milestoneId },
    });
    expect(claim.statusCode).toBe(200);
    expect((await store.findMilestone(milestoneId))?.paymentState).toBe("claimed_unverified");
    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(portalToken)}`,
    });
    expect(overview.statusCode).toBe(200);
    expect((overview.json() as { portal: { paidCents: number } }).portal.paidCents).toBe(0);
  });

  it("treats webhook replay as a duplicate even after a restart", async () => {
    clearSeenWebhookIdsForTests();
    const raw = webhookEnvelope({
      eventId: "evt_trust_paid_001",
      type: "payment_intent.succeeded",
      providerPaymentId,
      amountCents: 50000,
      currency: "USD",
      paymentId,
    });
    const first = await postWebhook(raw);
    expect(first.statusCode).toBe(200);
    expect((await store.findPaymentById(paymentId))?.state).toBe("paid");

    // Simulate a process restart: memory guard cleared, DB marker remains.
    clearSeenWebhookIdsForTests();
    const replay = await postWebhook(raw);
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { duplicate?: boolean }).duplicate).toBe(true);
    const events = await store.listProjectEvents(projectId, 100);
    expect(events.filter((e) => e.type === "PaymentReceived").length).toBe(1);
  });

  it("survives out-of-order delivery: reversal before confirmation stays needs-review", async () => {
    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 2 — Design", amountCents: 10000 },
    });
    const m2 = (ms.json() as { milestone: { id: string } }).milestone.id;
    const co = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m2}/checkout`,
      headers: { ...auth(token), "idempotency-key": "trust-chk-002" },
      payload: {},
    });
    const p2 = (co.json() as { payment: { id: string } }).payment.id;
    const pp2 = (await store.findPaymentById(p2))?.providerPaymentId ?? "";

    clearSeenWebhookIdsForTests();
    const earlyRefund = await postWebhook(
      webhookEnvelope({
        eventId: "evt_trust_ooo_refund",
        type: "charge.refunded",
        providerPaymentId: pp2,
        paymentId: p2,
      }),
    );
    expect(earlyRefund.statusCode).toBe(200);
    // Local state kept: still pending, never forced to refunded.
    expect((await store.findPaymentById(p2))?.state).toBe("pending");

    const lateConfirm = await postWebhook(
      webhookEnvelope({
        eventId: "evt_trust_ooo_paid",
        type: "payment_intent.succeeded",
        providerPaymentId: pp2,
        amountCents: 10000,
        currency: "USD",
        paymentId: p2,
      }),
    );
    expect(lateConfirm.statusCode).toBe(200);
    expect((await store.findPaymentById(p2))?.state).toBe("paid");

    const diag = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/diagnostics`,
      headers: auth(token),
    });
    const dbody = diag.json() as { warnings: { code: string }[] };
    expect(dbody.warnings.some((w) => w.code === "out_of_order")).toBe(true);
  });

  it("reconciles partial payments until the milestone is covered", async () => {
    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 3 — Build", amountCents: 30000 },
    });
    const m3 = (ms.json() as { milestone: { id: string } }).milestone.id;
    const coA = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m3}/checkout`,
      headers: { ...auth(token), "idempotency-key": "trust-chk-003a" },
      payload: { amountCents: 10000 },
    });
    expect(coA.statusCode).toBe(201);
    const pa = (coA.json() as { payment: { id: string } }).payment.id;
    const ppa = (await store.findPaymentById(pa))?.providerPaymentId ?? "";

    clearSeenWebhookIdsForTests();
    await postWebhook(
      webhookEnvelope({
        eventId: "evt_trust_partial_a",
        type: "payment_intent.succeeded",
        providerPaymentId: ppa,
        amountCents: 10000,
        currency: "USD",
        paymentId: pa,
      }),
    );
    // Partial: verified but milestone not yet paid.
    let recon = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/reconciliation`,
      headers: auth(token),
    });
    let rbody = recon.json() as {
      reconciliation: { perMilestone: { milestoneId: string; status: string }[] };
    };
    expect(rbody.reconciliation.perMilestone.find((m) => m.milestoneId === m3)?.status).toBe(
      "partial",
    );

    const coB = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m3}/checkout`,
      headers: { ...auth(token), "idempotency-key": "trust-chk-003b" },
      payload: { amountCents: 20000 },
    });
    expect(coB.statusCode).toBe(201);
    const pb = (coB.json() as { payment: { id: string } }).payment.id;
    const ppb = (await store.findPaymentById(pb))?.providerPaymentId ?? "";
    await postWebhook(
      webhookEnvelope({
        eventId: "evt_trust_partial_b",
        type: "payment_intent.succeeded",
        providerPaymentId: ppb,
        amountCents: 20000,
        currency: "USD",
        paymentId: pb,
      }),
    );
    recon = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/reconciliation`,
      headers: auth(token),
    });
    rbody = recon.json() as {
      reconciliation: { perMilestone: { milestoneId: string; status: string }[] };
    };
    expect(rbody.reconciliation.perMilestone.find((m) => m.milestoneId === m3)?.status).toBe(
      "paid",
    );

    // No duplicate charge allowed once covered: full checkout now conflicts.
    const over = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m3}/checkout`,
      headers: { ...auth(token), "idempotency-key": "trust-chk-003c" },
      payload: {},
    });
    expect(over.statusCode).toBe(409);
  });

  it("runs project-wide reconciliation against the provider", async () => {
    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 4 — Launch", amountCents: 5000 },
    });
    const m4 = (ms.json() as { milestone: { id: string } }).milestone.id;
    const co = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m4}/checkout`,
      headers: { ...auth(token), "idempotency-key": "trust-chk-004" },
      payload: {},
    });
    const p4 = (co.json() as { payment: { id: string } }).payment.id;
    const pp4 = (await store.findPaymentById(p4))?.providerPaymentId ?? "";
    provider.setStatus(pp4, "succeeded");

    const run = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/reconciliation/run`,
      headers: auth(token),
    });
    expect(run.statusCode).toBe(200);
    const rbody = run.json() as {
      results: { paymentId: string; transitioned?: boolean }[];
      reconciliation: { verification: { confirmedPayments: number } };
    };
    expect(rbody.results.find((r) => r.paymentId === p4)?.transitioned).toBe(true);
    expect((await store.findPaymentById(p4))?.state).toBe("paid");
    expect(rbody.reconciliation.verification.confirmedPayments).toBeGreaterThan(0);
  });

  it("rejects claims on paid milestones and enforces authz", async () => {
    const paidClaim = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/claim`,
      headers: auth(token),
      payload: {},
    });
    expect(paidClaim.statusCode).toBe(422);

    const anon = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/reconciliation`,
    });
    expect(anon.statusCode).toBe(401);

    const other = await signup("fpp09-other@example.com", "Other Nine");
    const cross = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/diagnostics`,
      headers: auth(other.token),
    });
    expect(cross.statusCode).toBe(403);

    const runAnon = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/reconciliation/run`,
      headers: auth(other.token),
    });
    expect(runAnon.statusCode).toBe(403);
  });
});
