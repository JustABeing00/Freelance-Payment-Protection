import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 20: senior product-design pass (operations software, not collections).
 * Verifies the freelancer + client hierarchy answers:
 * freelancer "safe / owed / next / automatic", client "paying for / approved /
 * remains / need to do" — with calm overdue language everywhere.
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

describe("product design hierarchy (session 20)", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let portalToken = "";
  const BANNED = [
    "debt collector",
    "final notice",
    "sue you",
    "legal action will",
    "threaten",
    "scammer",
  ];

  it("freelancer dashboard answers safe / owed / next / automatic", async () => {
    ({ token, workspaceId } = await signup("fpp20-owner@example.com", "Fpp Twenty"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme20@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: { clientId, title: "Brand site", currency: "USD", totalValueCents: 200000 },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    const m1 = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: {
        title: "Milestone 1",
        amountCents: 100000,
        currency: "USD",
        dueDate: new Date("2026-08-01T12:00:00Z").toISOString(),
      },
    });
    expect(m1.statusCode).toBe(201);

    const page = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}?workspaceId=${workspaceId}`,
      headers: { ...auth(token), cookie: "" },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Safe — verified paid");
    expect(page.body).toContain("Owed — outstanding");
    expect(page.body).toContain("Due next");
    expect(page.body).toContain("Next action:");
    expect(page.body).toContain("Milestone timeline");
    expect(page.body).toContain("What you should do");
    expect(page.body).toContain("Automatic");
    expect(page.body).toContain("Operations — approvals, payments, reminders");
    // Existing links preserved.
    expect(page.body).toContain("Open Project health");
    expect(page.body).toContain("Open the full evidence timeline");
    expect(page.body).toContain("Notification center");
    const blob = page.body.toLowerCase();
    for (const word of BANNED) expect(blob).not.toContain(word);
  });

  it("timeline, evidence, protection and notifications guide next steps", async () => {
    const timeline = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/timeline?workspaceId=${workspaceId}`,
      headers: auth(token),
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.body).toContain("How to read this");
    expect(timeline.body).toContain("Evidence timeline");

    const evidence = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/evidence?workspaceId=${workspaceId}`,
      headers: auth(token),
    });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.body).toContain("When to use this");
    expect(evidence.body).toContain("Generate evidence pack");

    const protection = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/protection?workspaceId=${workspaceId}`,
      headers: auth(token),
    });
    expect(protection.statusCode).toBe(200);
    expect(protection.body).toContain("Protection checks");
    expect(protection.body).toContain("Needs attention");

    const inbox = await app.inject({
      method: "GET",
      url: `/app/notifications?workspaceId=${workspaceId}`,
      headers: auth(token),
    });
    expect(inbox.statusCode).toBe(200);
    expect(inbox.body).toContain("Notification center");
    expect(inbox.body).toContain("Set up reminders once");

    for (const body of [timeline.body, evidence.body, protection.body, inbox.body]) {
      const blob = body.toLowerCase();
      for (const word of BANNED) expect(blob).not.toContain(word);
    }
  });

  it("client portal answers paying-for / approved / remains / next, calmly", async () => {
    const link = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(link.statusCode).toBe(201);
    portalToken = (link.json() as { token: string }).token;

    const page = await app.inject({
      method: "GET",
      url: `/portal/${projectId}?token=${encodeURIComponent(portalToken)}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("What is currently due");
    expect(page.body).toContain("How this works");
    expect(page.body).toContain("What you have approved");
    expect(page.body).toContain("What happens automatically");
    expect(page.body).toContain("Remaining balance");
    expect(page.body).toContain("What happens next");
    const blob = page.body.toLowerCase();
    for (const word of BANNED) expect(blob).not.toContain(word);
    expect(blob).not.toContain("50% deposit");
  });

  it("error states tell the client what to do next", async () => {
    const bad = await app.inject({ method: "GET", url: `/portal/${projectId}` });
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toContain("What to do next");

    const expired = await app.inject({
      method: "GET",
      url: `/portal/${projectId}?token=bad-token`,
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.body).toContain("What to do next");
  });
});
