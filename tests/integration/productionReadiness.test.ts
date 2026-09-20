import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 22 (production readiness): fail-closed providers, cache headers,
 * and baseline a11y/SEO markers on rendered pages.
 *
 * The app under test boots with NODE_ENV=production and NO Stripe key, so
 * the payment seam resolves to Noop — checkout/refund must fail closed
 * instead of fabricating payment rows.
 */

const prodEnv = {
  NODE_ENV: "production" as const,
  PORT: 3000,
  LOG_LEVEL: "fatal" as const,
  DATABASE_URL: "postgres://localhost:5432/fpp_test",
  SESSION_SECRET: "test-session-secret-that-is-long-enough-0123456789",
  APP_BASE_URL: "http://localhost:3000",
  MAGIC_LINK_TTL_HOURS: 168,
};

let app: FastifyInstance;
const store = new InMemoryStore();
const PASSWORD = "correct-horse-battery-12";

async function signup(
  email: string,
  displayName: string,
): Promise<{ token: string; workspaceId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { email, displayName, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { token: string; workspace: { id: string } };
  return { token: body.token, workspaceId: body.workspace.id };
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = await buildApp({ env: prodEnv, loggerLevel: "fatal", store });
});

afterAll(async () => {
  await app.close();
});

describe("production readiness (fail-closed + headers + page markers)", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";

  it("sets up a funded project fixture", async () => {
    ({ token, workspaceId } = await signup("fpp22-owner@example.com", "Fpp TwentyTwo"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme22@example.com" },
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
  });

  it("refuses checkout without a provider in production (no fake payment row)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/checkout`,
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe("PROVIDER_ERROR");
    const ledger = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments`,
      headers: auth(token),
    });
    expect(ledger.statusCode).toBe(200);
    expect((ledger.json() as { payments: unknown[] }).payments).toEqual([]);
  });

  it("refuses refunds without a provider in production", async () => {
    const seeded = await store.createPayment(workspaceId, {
      projectId,
      milestoneId,
      provider: "stripe",
      providerPaymentId: "pi_prodrefund_001",
      amountCents: 50000,
      currency: "USD",
      state: "paid",
      idempotencyKey: "prodrefund:seed:001",
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/${seeded.id}/refund`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(502);
    expect((res.json() as { error: { code: string } }).error.code).toBe("PROVIDER_ERROR");
    // The verified-paid row is untouched — no fake refund recorded.
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments/${seeded.id}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { payment: { state: string } }).payment.state).toBe("paid");
  });

  it("serves static assets with a short public cache header", async () => {
    for (const url of ["/app/styles.css", "/app/app.js", "/portal/app.js"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toContain("public");
    }
  });

  it("marks freelancer pages noindex with skip link + description", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/app/projects?workspaceId=${workspaceId}`,
      headers: { cookie: "", authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).toContain('name="description"');
    expect(html).toContain('href="#main-content"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain('aria-label="Workspace"');
  });

  it("marks the client portal noindex with a description", async () => {
    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    const portalToken = (issued.json() as { token: string }).token;
    const page = await app.inject({
      method: "GET",
      url: `/portal/${projectId}?token=${encodeURIComponent(portalToken)}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('name="robots" content="noindex, nofollow"');
    expect(page.body).toContain('name="description"');
    expect(page.body).toContain('id="main-content"');
  });
});
