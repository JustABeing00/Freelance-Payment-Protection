import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 17: AI-assisted payment-protection drafts.
 * - Five workflow-scoped helpers, no chatbot.
 * - Every response is review-required; financial records never change.
 * - Tenant isolation + AI drafts page.
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

describe("ai assist routes", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  const BANNED = ["scammer", "fraudulent", "lawsuit", "guaranteed to win"];

  it("sets up a project with a milestone", async () => {
    ({ token, workspaceId } = await signup("ai17-owner@example.com", "Ai Seventeen"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme17@example.com" },
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
      payload: {
        title: "Milestone 1",
        amountCents: 50000,
        currency: "USD",
        dueDate: new Date("2026-08-01T12:00:00Z").toISOString(),
      },
    });
    expect(milestone.statusCode).toBe(201);
    milestoneId = (milestone.json() as { milestone: { id: string } }).milestone.id;
  });

  it("extracts contract terms as a review-required draft", async () => {
    const sourceText =
      "Payment terms: Net 15, payable by bank transfer. " +
      "Milestone 1 — Design ($500) due 2026-10-01. " +
      "Final delivery upon final payment.";
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/ai/extract-terms`,
      headers: auth(token),
      payload: { sourceText },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reviewRequired: boolean;
      financialRecordsChanged: boolean;
      fields: { field: string; found: boolean; quotes: string[] }[];
      disclaimer: string;
    };
    expect(body.reviewRequired).toBe(true);
    expect(body.financialRecordsChanged).toBe(false);
    expect(body.disclaimer).toMatch(/not legal advice/i);
    const byField = new Map(body.fields.map((f) => [f.field, f] as const));
    expect(byField.get("payment_terms")?.found).toBe(true);
    expect(byField.get("late_fee")?.found).toBe(false);
    for (const field of body.fields) {
      for (const quote of field.quotes) {
        expect(sourceText).toContain(quote);
      }
    }
    const blob = JSON.stringify(body).toLowerCase();
    for (const word of BANNED) expect(blob).not.toContain(word);
  });

  it("extracts communication events without recording anything", async () => {
    const before = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline`,
      headers: auth(token),
    });
    const beforeCount = (before.json() as { events: unknown[] }).events.length;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/ai/extract-communications`,
      headers: auth(token),
      payload: { sourceText: "Approved — looks good. I will pay by 2026-10-05." },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reviewRequired: boolean;
      financialRecordsChanged: boolean;
      events: { kind: string; quote: string }[];
    };
    expect(body.reviewRequired).toBe(true);
    expect(body.financialRecordsChanged).toBe(false);
    expect(body.events.length).toBeGreaterThan(0);

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline`,
      headers: auth(token),
    });
    expect((after.json() as { events: unknown[] }).events.length).toBe(beforeCount);
  });

  it("drafts a reminder from live facts without sending anything", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/ai/draft-reminder`,
      headers: auth(token),
      payload: { milestoneId, tone: "friendly" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reviewRequired: boolean;
      financialRecordsChanged: boolean;
      subject: string;
      body: string;
      milestoneId: string;
      disclaimer: string;
    };
    expect(body.reviewRequired).toBe(true);
    expect(body.financialRecordsChanged).toBe(false);
    expect(body.milestoneId).toBe(milestoneId);
    expect(body.body).toContain("Milestone 1");
    expect(body.body).toContain("$500.00");
    expect(body.disclaimer).toMatch(/not legal advice/i);
    const blob = JSON.stringify(body).toLowerCase();
    for (const word of BANNED) expect(blob).not.toContain(word);

    const reminders = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/reminders`,
      headers: auth(token),
    });
    expect(reminders.statusCode).toBe(200);
    expect((reminders.json() as { reminders: unknown[] }).reminders).toHaveLength(0);
  });

  it("summarizes the evidence trail as a reading aid", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/ai/summarize`,
      headers: auth(token),
      payload: { maxEvents: 50 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reviewRequired: boolean;
      financialRecordsChanged: boolean;
      eventCount: number;
      bullets: string[];
      disclaimer: string;
    };
    expect(body.reviewRequired).toBe(true);
    expect(body.financialRecordsChanged).toBe(false);
    expect(body.eventCount).toBeGreaterThan(0);
    expect(body.bullets.length).toBe(body.eventCount);
    expect(body.disclaimer).toMatch(/not legal advice/i);
  });

  it("checks agreement consistency read-only", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/ai/consistency`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reviewRequired: boolean;
      financialRecordsChanged: boolean;
      findings: { code: string; severity: string }[];
      disclaimer: string;
    };
    expect(body.reviewRequired).toBe(true);
    expect(body.financialRecordsChanged).toBe(false);
    expect(body.findings.length).toBeGreaterThan(0);
    expect(body.findings.map((f) => f.code)).toContain("no_agreement_for_consistency");
    expect(body.disclaimer).toMatch(/not legal advice/i);
  });

  it("renders the AI drafts page and links it from the project page", async () => {
    const signin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signin",
      payload: { email: "ai17-owner@example.com", password: PASSWORD },
    });
    const setCookie = signin.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const sessionCookie = cookie?.split(";")[0] ?? "";

    const page = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/ai?workspaceId=${workspaceId}`,
      headers: { cookie: sessionCookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("AI drafts");
    expect(page.body).toContain("Contract/terms extraction");

    const projectPage = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}?workspaceId=${workspaceId}`,
      headers: { cookie: sessionCookie },
    });
    expect(projectPage.statusCode).toBe(200);
    expect(projectPage.body).toContain(`/app/projects/${projectId}/ai`);
  });

  it("enforces auth and tenant isolation", async () => {
    const anon = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/ai/extract-terms`,
      payload: { sourceText: "Payment terms: Net 15." },
    });
    expect(anon.statusCode).toBe(401);

    const other = await signup("ai17-other@example.com", "Ai Other");
    const cross = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${other.workspaceId}/projects/${projectId}/ai/consistency`,
      headers: auth(other.token),
    });
    expect([403, 404]).toContain(cross.statusCode);

    const badMilestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/ai/draft-reminder`,
      headers: auth(token),
      payload: { milestoneId: "00000000-0000-4000-8000-000000000000" },
    });
    expect([403, 404]).toContain(badMilestone.statusCode);
  });
});
