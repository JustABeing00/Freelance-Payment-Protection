import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 04: full client + project domain — validation, editing,
 * filtering, command-center summary, and calm server-rendered pages.
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
  app = await buildApp({ env: testEnv, loggerLevel: "fatal", store });
});

afterAll(async () => {
  await app.close();
});

describe("client + project domain", () => {
  let token = "";
  let workspaceId = "";
  let clientId = "";
  let projectId = "";

  it("creates a client with the full contact/billing profile", async () => {
    ({ token, workspaceId } = await signup("fpp04-owner@example.com", "Fpp Four"));
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: {
        name: "Acme Corp",
        email: " accounts@acme.example ",
        company: "Acme Corp",
        phone: "+1-555-0100",
        billingEmail: "billing@acme.example",
        billingAddress: "1 Main St, Springfield",
        timezone: "America/New_York",
        country: "us",
        notes: "Prefers email. Net 7.",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { client: Record<string, unknown> };
    clientId = body.client.id as string;
    expect(body.client.email).toBe("accounts@acme.example");
    expect(body.client.country).toBe("US");
    expect(body.client.timezone).toBe("America/New_York");
    expect(body.client.status).toBe("active");
  });

  it("rejects bad country codes and bad emails", async () => {
    const badCountry = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Bad", email: "bad-country@example.com", country: "USA" },
    });
    expect(badCountry.statusCode).toBe(422);
    const badEmail = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Bad", email: "not-an-email" },
    });
    expect(badEmail.statusCode).toBe(422);
  });

  it("edits a client (PATCH) and filters the list", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/clients/${clientId}`,
      headers: auth(token),
      payload: { phone: "+1-555-0200", notes: "Updated notes" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { client: { phone: string } }).client.phone).toBe("+1-555-0200");

    const filtered = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/clients?search=acme`,
      headers: auth(token),
    });
    expect(filtered.statusCode).toBe(200);
    expect((filtered.json() as { clients: unknown[] }).clients).toHaveLength(1);
    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/clients?search=zzz-no-match`,
      headers: auth(token),
    });
    expect((empty.json() as { clients: unknown[] }).clients).toHaveLength(0);
  });

  it("creates a project with scheduling + terms, rejects backward dates", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: {
        clientId,
        title: "Website rebuild",
        description: "Marketing site + CMS",
        currency: "usd",
        totalValueCents: 500000,
        startDate: "2026-09-01T00:00:00.000Z",
        expectedCompletion: "2026-10-01T00:00:00.000Z",
        paymentTerms: "Milestone 1 on approval, balance on delivery",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { project: { id: string; currency: string; status: string } };
    projectId = body.project.id;
    expect(body.project.currency).toBe("USD");
    expect(body.project.status).toBe("active");

    const badDates = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: {
        clientId,
        title: "Bad dates",
        currency: "USD",
        totalValueCents: 1000,
        startDate: "2026-10-01T00:00:00.000Z",
        expectedCompletion: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(badDates.statusCode).toBe(422);
  });

  it("edits a project and serves the command-center summary", async () => {
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}`,
      headers: auth(token),
      payload: { paymentTerms: "Updated terms" },
    });
    expect(patch.statusCode).toBe(200);

    // Seed one milestone + one verified payment + one event via the test seam.
    await store.seedMilestone({
      workspaceId,
      projectId,
      title: "Milestone 1 — Discovery",
      amountCents: 100000,
      workState: "approved",
      paymentState: "requested",
      orderIndex: 0,
    });
    await store.seedPayment({
      workspaceId,
      projectId,
      amountCents: 40000,
      state: "received",
    });
    await store.seedEvent({
      workspaceId,
      projectId,
      type: "PaymentRequested",
      actorType: "freelancer",
      occurredAt: new Date("2026-09-05T00:00:00Z"),
      payload: {},
    });

    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/summary`,
      headers: auth(token),
    });
    expect(summary.statusCode).toBe(200);
    const body = summary.json() as {
      summary: {
        totalValueCents: number;
        amountPaidCents: number;
        outstandingCents: number;
        paymentStatus: string;
        currentMilestone: { title: string } | null;
        nextAction: string;
        recentActivity: { label: string }[];
      };
    };
    expect(body.summary.totalValueCents).toBe(500000);
    expect(body.summary.amountPaidCents).toBe(40000);
    expect(body.summary.outstandingCents).toBe(60000);
    expect(body.summary.paymentStatus).toBe("partial");
    expect(body.summary.currentMilestone?.title).toContain("Milestone 1");
    expect(body.summary.nextAction.length).toBeGreaterThan(10);
    const labels = body.summary.recentActivity.map((a) => a.label);
    expect(labels).toContain("Payment requested");
    // Session 14: project creation itself opens the evidence trail.
    expect(labels).toContain("Project created");
  });

  it("serves calm HTML pages for lists + command-center detail", async () => {
    for (const url of [
      `/app/clients?workspaceId=${workspaceId}`,
      `/app/clients/${clientId}?workspaceId=${workspaceId}`,
      `/app/projects?workspaceId=${workspaceId}`,
      `/app/projects/${projectId}?workspaceId=${workspaceId}`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth(token) });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    }
    const detail = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}?workspaceId=${workspaceId}`,
      headers: auth(token),
    });
    const html = detail.body;
    for (const marker of [
      "Total project value",
      "Amount paid",
      "Amount outstanding",
      "Current milestone",
      "Next action",
      "Recent activity",
    ]) {
      expect(html).toContain(marker);
    }
    // No generic admin-dashboard chrome.
    expect(html).not.toMatch(/dashboard/i);
  });

  it("keeps cross-tenant isolation on the new write + summary routes", async () => {
    const other = await signup("fpp04-intruder@example.com", "Intruder");
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/clients/${clientId}`,
      headers: auth(other.token),
      payload: { notes: "hijack" },
    });
    expect(patch.statusCode).toBe(403);
    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/summary`,
      headers: auth(other.token),
    });
    expect(summary.statusCode).toBe(403);
    const page = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}?workspaceId=${workspaceId}`,
      headers: auth(other.token),
    });
    expect([401, 403, 404]).toContain(page.statusCode);
  });
});
