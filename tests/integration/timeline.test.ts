import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 14: evidence timeline.
 * - Chronological freelancer view with metadata + filtering + detail.
 * - History is immutable (405 on write-shaped requests, no PUT/PATCH/DELETE).
 * - Portal view is client-safe (no hashes, tokens, provider refs, webhooks).
 * - Tenant isolation + server-rendered UI pages.
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

describe("evidence timeline", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  let portalToken = "";
  let firstEventId = "";

  it("records project creation as the first timeline event", async () => {
    ({ token, workspaceId } = await signup("fpp14-owner@example.com", "Fpp Fourteen"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme14@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: { clientId, title: "Brand site", currency: "USD", totalValueCents: 100000 },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 1 — Build", amountCents: 100000 },
    });
    expect(milestone.statusCode).toBe(201);
    milestoneId = (milestone.json() as { milestone: { id: string } }).milestone.id;

    // Move the story forward: payment requested + work paused.
    const transition = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/transitions`,
      headers: auth(token),
      payload: { action: "request_funding" },
    });
    expect(transition.statusCode).toBe(200);

    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/pause`,
      headers: auth(token),
      payload: { reason: "Waiting on overdue payment" },
    });
    expect(paused.statusCode).toBe(200);
  });

  it("lists the full chronological trail with metadata and a summary", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      projectId: string;
      events: {
        id: string;
        type: string;
        category: string;
        label: string;
        headline: string;
        detail: string;
        actorType: string;
        occurredAt: string;
        metadata: Record<string, unknown>;
        immutable: boolean;
      }[];
      summary: { totalCount: number; byCategory: Record<string, number> };
      immutable: boolean;
      disclaimer: string;
      categories: string[];
    };
    expect(body.projectId).toBe(projectId);
    expect(body.immutable).toBe(true);
    expect(body.disclaimer).toMatch(/Not legal advice/);
    const types = body.events.map((e) => e.type);
    // Chronological: project birth first, pause then its queued notice last.
    expect(types[0]).toBe("ProjectCreated");
    expect(types).toContain("MilestoneCreated");
    expect(types).toContain("PaymentRequested");
    expect(types).toContain("ProjectPaused");
    expect(types[types.length - 2]).toBe("ProjectPaused");
    expect(types[types.length - 1]).toBe("NotificationQueued");
    for (const e of body.events) {
      expect(e.category.length).toBeGreaterThan(0);
      expect(e.headline.length).toBeGreaterThan(3);
      expect(e.detail.length).toBeGreaterThan(3);
      expect(e.immutable).toBe(true);
    }
    expect(body.summary.totalCount).toBe(body.events.length);
    expect(body.summary.byCategory.project).toBeGreaterThanOrEqual(2);
    firstEventId = body.events[0]?.id as string;
  });

  it("filters by category and actor", async () => {
    const payment = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline?category=payment`,
      headers: auth(token),
    });
    expect(payment.statusCode).toBe(200);
    const paymentTypes = (payment.json() as { events: { type: string }[] }).events.map(
      (e) => e.type,
    );
    expect(paymentTypes).toContain("PaymentRequested");
    expect(paymentTypes).not.toContain("ProjectCreated");

    const actor = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline?actorType=freelancer`,
      headers: auth(token),
    });
    expect(actor.statusCode).toBe(200);
    expect((actor.json() as { events: unknown[] }).events.length).toBeGreaterThan(0);
  });

  it("shows one event with neighbours and prev/next links", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline/${firstEventId}`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      event: {
        id: string;
        type: string;
        headline: string;
        nextEventId: string;
        immutable: boolean;
      };
      immutable: boolean;
    };
    expect(body.event.id).toBe(firstEventId);
    expect(body.event.type).toBe("ProjectCreated");
    expect(body.event.nextEventId).toBeDefined();
    expect(body.event.immutable).toBe(true);
    expect(body.immutable).toBe(true);
  });

  it("refuses to rewrite history with an explicit immutable error", async () => {
    for (const method of ["POST", "PATCH", "DELETE"] as const) {
      const res = await app.inject({
        method,
        url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline`,
        headers: auth(token),
        payload: { type: "PaymentReceived" },
      });
      expect(res.statusCode).toBe(405);
      expect((res.json() as { error: { code: string } }).error.code).toBe("IMMUTABLE_HISTORY");
    }
    const single = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline/${firstEventId}`,
      headers: auth(token),
    });
    expect(single.statusCode).toBe(405);
  });

  it("unpauses through an event, not an edit", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/unpause`,
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const timeline = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline?types=ProjectUnpaused`,
      headers: auth(token),
    });
    expect((timeline.json() as { events: { type: string }[] }).events.map((e) => e.type)).toContain(
      "ProjectUnpaused",
    );
  });

  it("serves a client-safe portal timeline without internals", async () => {
    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    portalToken = (issued.json() as { token: string }).token;

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/timeline?token=${encodeURIComponent(portalToken)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      events: { type: string; headline: string; metadata: Record<string, unknown> }[];
      immutable: boolean;
    };
    expect(body.immutable).toBe(true);
    const types = body.events.map((e) => e.type);
    expect(types).toContain("MilestoneCreated");
    expect(types).toContain("PaymentRequested");
    // Freelancer-only rows stay hidden from the client.
    expect(types).not.toContain("PortalLinkIssued");
    expect(types).not.toContain("ProjectCreated");
    const raw = JSON.stringify(body.events);
    expect(raw).not.toContain("tokenHash");
    expect(raw).not.toContain("providerPaymentId");

    // Tampered tokens fail closed.
    const bad = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/timeline?token=${encodeURIComponent(`${portalToken}0`)}`,
    });
    expect(bad.statusCode).toBe(401);
  });

  it("renders the timeline and event pages as calm HTML", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/timeline?workspaceId=${workspaceId}`,
      headers: { ...auth(token), cookie: "" },
    });
    expect(list.statusCode).toBe(200);
    expect(list.headers["content-type"]).toContain("text/html");
    expect(list.body).toContain("Evidence timeline");
    expect(list.body).toContain("Project created");

    const detail = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/timeline/${firstEventId}?workspaceId=${workspaceId}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("append-only");
  });

  it("isolates tenants on timeline routes", async () => {
    const other = await signup("fpp14-intruder@example.com", "Fpp Intruder");
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline`,
      headers: auth(other.token),
    });
    expect(forbidden.statusCode).toBe(403);
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${other.workspaceId}/projects/${projectId}/timeline`,
      headers: auth(other.token),
    });
    expect([403, 404]).toContain(missing.statusCode);
  });
});
