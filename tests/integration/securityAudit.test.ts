import type { FastifyInstance } from "fastify";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";
import { clearSeenWebhookIdsForTests } from "../../src/routes/payments.js";

/**
 * Session 19 — hostile security regression tests.
 *
 * Each test replays an exploit attempt from `docs/security-audit.md` and pins
 * the fixed behaviour. VULN-001 (checkout idempotency-key cross-tenant read)
 * failed before the fix (200 + victim row); all others document invariants
 * that already held and must keep holding.
 */

const testEnv = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  LOG_LEVEL: "fatal" as const,
  DATABASE_URL: "postgres://localhost:5432/fpp_test",
  SESSION_SECRET: "test-session-secret-that-is-long-enough-0123456789",
  APP_BASE_URL: "http://localhost:3000",
  MAGIC_LINK_TTL_HOURS: 168,
};
const WEBHOOK_SECRET = "whsec_audit_secret_long_enough_0123456789";

let app: FastifyInstance;
const store = new InMemoryStore();
const PASSWORD = "correct-horse-battery-12";

async function signup(email: string, displayName: string) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { email, displayName, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { token: string; workspace: { id: string }; user: { id: string } };
  return { token: body.token, workspaceId: body.workspace.id, userId: body.user.id };
}
function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}
async function setupProject(a: { token: string; workspaceId: string }, total: number) {
  const suffix = Math.random().toString(36).slice(2);
  const client = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${a.workspaceId}/clients`,
        headers: auth(a.token),
        payload: { name: "C", email: `c-${suffix}@example.com` },
      })
    ).json() as { client: { id: string } }
  ).client.id;
  const project = (
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${a.workspaceId}/projects`,
        headers: auth(a.token),
        payload: { clientId: client, title: "P", currency: "USD", totalValueCents: total },
      })
    ).json() as { project: { id: string } }
  ).project.id;
  const ms = await store.seedMilestone({
    workspaceId: a.workspaceId,
    projectId: project,
    title: "M1",
    amountCents: total,
  });
  return { project, milestone: ms.id };
}
function signWebhook(rawBody: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${rawBody}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

beforeAll(async () => {
  app = await buildApp({
    env: testEnv,
    loggerLevel: "fatal",
    store,
    webhookSecret: WEBHOOK_SECRET,
  });
});

afterAll(async () => {
  await app.close();
});

describe("security audit regressions (session 19)", () => {
  it("VULN-001: checkout idempotency-key reuse across tenants leaks nothing", async () => {
    const victim = await signup("audit-victim@example.com", "Audit Victim");
    const attacker = await signup("audit-attacker@example.com", "Audit Attacker");
    const v = await setupProject(victim, 77700);
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${victim.workspaceId}/projects/${v.project}/milestones/${v.milestone}/checkout`,
      headers: auth(victim.token),
      payload: { idempotencyKey: "audit-predictable-key-001" },
    });
    expect(first.statusCode).toBe(201);

    const a = await setupProject(attacker, 100);
    const replay = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${attacker.workspaceId}/projects/${a.project}/milestones/${a.milestone}/checkout`,
      headers: auth(attacker.token),
      payload: { idempotencyKey: "audit-predictable-key-001" },
    });
    // Bare 409: no victim workspace/project/milestone/provider ids, no amounts.
    expect(replay.statusCode).toBe(409);
    expect(replay.body).not.toContain("77700");
    expect(replay.body).not.toContain(v.project);
    expect(replay.body).not.toContain(v.milestone);
  });

  it("checkout rejects non-http(s) redirect targets", async () => {
    const u = await signup("audit-urls@example.com", "Audit Urls");
    const s = await setupProject(u, 5000);
    const bad = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${u.workspaceId}/projects/${s.project}/milestones/${s.milestone}/checkout`,
      headers: auth(u.token),
      payload: { successUrl: "javascript:alert(1)", idempotencyKey: "audit-js-url" },
    });
    expect(bad.statusCode).toBe(422);
    const bad2 = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${u.workspaceId}/projects/${s.project}/milestones/${s.milestone}/checkout`,
      headers: auth(u.token),
      payload: { cancelUrl: "data:text/html,<h1>x</h1>", idempotencyKey: "audit-data-url" },
    });
    expect(bad2.statusCode).toBe(422);
    const good = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${u.workspaceId}/projects/${s.project}/milestones/${s.milestone}/checkout`,
      headers: auth(u.token),
      payload: {
        successUrl: "https://studio.example/success",
        cancelUrl: "http://localhost:3000/cancel",
        idempotencyKey: "audit-https-url",
      },
    });
    expect(good.statusCode).toBe(201);
  });

  it("unsigned webhook is rejected; signed replay is a safe duplicate", async () => {
    clearSeenWebhookIdsForTests();
    const u = await signup("audit-webhook@example.com", "Audit Webhook");
    const s = await setupProject(u, 9000);
    const co = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${u.workspaceId}/projects/${s.project}/milestones/${s.milestone}/checkout`,
      headers: auth(u.token),
      payload: { idempotencyKey: "audit-webhook-key" },
    });
    expect(co.statusCode).toBe(201);
    const payment = (co.json() as { payment: { id: string; providerPaymentId: string } }).payment;
    const raw = JSON.stringify({
      id: "evt_audit_replay",
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: payment.providerPaymentId,
          amount: 9000,
          currency: "usd",
          metadata: { paymentId: payment.id },
        },
      },
    });
    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/payments",
      headers: {
        "stripe-signature": "t=9999999999,v1=deadbeef",
        "content-type": "application/json",
      },
      payload: raw,
    });
    expect(forged.statusCode).toBe(400);

    const sig = signWebhook(raw);
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/payments",
      headers: { "stripe-signature": sig, "content-type": "application/json" },
      payload: raw,
    });
    expect(first.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/api/v1/webhooks/payments",
      headers: { "stripe-signature": sig, "content-type": "application/json" },
      payload: raw,
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as { duplicate?: boolean }).duplicate).toBe(true);
    const stored = await store.findPaymentById(payment.id);
    expect(stored?.state).toBe("paid");
  });

  it("client claim and success page never mark paid", async () => {
    const u = await signup("audit-claim@example.com", "Audit Claim");
    const s = await setupProject(u, 4000);
    const link = (
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${u.workspaceId}/projects/${s.project}/portal-links`,
          headers: auth(u.token),
          payload: {},
        })
      ).json() as { token: string }
    ).token;
    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${s.project}/claim`,
      payload: { token: link, milestoneId: s.milestone },
    });
    expect(claim.statusCode).toBe(200);
    expect((await store.findMilestone(s.milestone))?.paymentState).toBe("claimed_unverified");
    await app.inject({
      method: "GET",
      url: `/portal/${s.project}/success?token=${encodeURIComponent(link)}&paymentId=00000000-0000-4000-8000-000000000000`,
    });
    expect((await store.findMilestone(s.milestone))?.paymentState).toBe("claimed_unverified");
  });

  it("portal token is single-project scoped", async () => {
    const u = await signup("audit-scope@example.com", "Audit Scope");
    const p1 = await setupProject(u, 4000);
    const p2 = await setupProject(u, 4000);
    const link = (
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${u.workspaceId}/projects/${p1.project}/portal-links`,
          headers: auth(u.token),
          payload: {},
        })
      ).json() as { token: string }
    ).token;
    const cross = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${p2.project}/overview?token=${encodeURIComponent(link)}`,
    });
    expect(cross.statusCode).toBe(401);
    const crossTimeline = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${p2.project}/timeline?token=${encodeURIComponent(link)}`,
    });
    expect(crossTimeline.statusCode).toBe(401);
  });

  it("unpaid finals stay locked (423) for freelancer and client", async () => {
    const u = await signup("audit-final@example.com", "Audit Final");
    const s = await setupProject(u, 6000);
    const dv = await store.createDeliverable(u.workspaceId, {
      projectId: s.project,
      milestoneId: s.milestone,
      title: "D",
    });
    await store.createDeliverableVersion(dv.id, {
      files: [
        {
          filename: "preview.png",
          contentType: "image/png",
          sizeBytes: 10,
          visibility: "review",
          key: "audit-k-review",
        },
        {
          filename: "final.zip",
          contentType: "application/zip",
          sizeBytes: 10,
          visibility: "final",
          key: "audit-k-final",
        },
      ],
      links: [],
      createdBy: u.userId,
    });
    await store.updateDeliverable(dv.id, { status: "paid" });
    const freelancerFinal = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${u.workspaceId}/projects/${s.project}/deliverables/${dv.id}/files/final`,
      headers: auth(u.token),
    });
    expect(freelancerFinal.statusCode).toBe(423);
    // The final endpoint never resolves a review-visibility file, even by name.
    const freelancerNamed = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${u.workspaceId}/projects/${s.project}/deliverables/${dv.id}/files/final?file=preview.png`,
      headers: auth(u.token),
    });
    expect([404, 423]).toContain(freelancerNamed.statusCode);
    expect(freelancerNamed.body).not.toContain("audit-k-review");

    const link = (
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/workspaces/${u.workspaceId}/projects/${s.project}/portal-links`,
          headers: auth(u.token),
          payload: {},
        })
      ).json() as { token: string }
    ).token;
    const portalFinal = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${s.project}/deliverables/${dv.id}/final?token=${encodeURIComponent(link)}`,
    });
    expect(portalFinal.statusCode).toBe(423);
    const portalNamed = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${s.project}/deliverables/${dv.id}/final?token=${encodeURIComponent(link)}&file=preview.png`,
    });
    expect(portalNamed.statusCode).toBe(423);
  });

  it("history is immutable and tenants are isolated", async () => {
    const u = await signup("audit-tenant@example.com", "Audit Tenant");
    const other = await signup("audit-tenant-other@example.com", "Audit Tenant Other");
    const s = await setupProject(u, 6000);
    for (const method of ["POST", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `/api/v1/workspaces/${u.workspaceId}/projects/${s.project}/timeline`,
        headers: auth(u.token),
        payload: {},
      });
      expect(res.statusCode).toBe(405);
    }
    const crossProject = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${other.workspaceId}/projects/${s.project}`,
      headers: auth(other.token),
    });
    expect(crossProject.statusCode).toBe(403);
    const crossPayment = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${other.workspaceId}/projects/${s.project}/payments`,
      headers: auth(other.token),
    });
    expect(crossPayment.statusCode).toBe(403);
  });
});
