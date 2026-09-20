import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/config/app.js";
import { clearFeedbackInbox, feedbackInbox } from "../../src/routes/site.js";

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

beforeAll(async () => {
  app = await buildApp({ env: testEnv, loggerLevel: "fatal", store: "memory" });
});

afterAll(async () => {
  await app.close();
});

/** Unsupported launch claims: must never appear in public copy. */
const BANNED = [
  "guaranteed payment",
  "legally enforceable everywhere",
  "stops fraud",
  "clients cannot scam you",
];

async function signup(): Promise<{ token: string; workspaceId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: {
      email: `launch${Date.now()}${Math.random().toString(16).slice(2)}@example.com`,
      displayName: "Launch Tester",
      password: "launch-test-password-1",
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { token: string; workspace: { id: string } };
  return { token: body.token, workspaceId: body.workspace.id };
}

describe("launch site (Session 24)", () => {
  it("GET / negotiates: HTML homepage for browsers, JSON for API clients", async () => {
    clearFeedbackInbox();
    const html = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain("Get started");
    expect(html.body).toContain("Not legal advice");

    const json = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "application/json" },
    });
    expect(json.statusCode).toBe(200);
    expect(json.json()).toMatchObject({
      name: "FreelancePaymentProtection API",
      version: "0.19.0",
    });
  });

  it("public pages render with honest copy (no unsupported claims)", async () => {
    for (const url of ["/pricing", "/faq", "/privacy", "/terms", "/contact", "/onboarding"]) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      const lower = res.body.toLowerCase();
      for (const banned of BANNED) {
        expect(lower).not.toContain(banned);
      }
    }
    const home = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    for (const banned of BANNED) {
      expect(home.body.toLowerCase()).not.toContain(banned);
    }
    // Honest limits are stated explicitly.
    expect(home.body).toContain("does not promise payment");
    expect(home.body).toContain("/pricing");
    expect(home.body).toContain("/faq");
    const faq = await app.inject({ method: "GET", url: "/faq" });
    expect(faq.body).toContain("Does this promise I will get paid?");
    const pricing = await app.inject({ method: "GET", url: "/pricing" });
    expect(pricing.body).toContain("Funds are never held");
  });

  it("feedback mechanism accepts valid notes and rejects invalid ones", async () => {
    clearFeedbackInbox();
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/feedback",
      payload: {
        category: "feedback",
        message: "The onboarding checklist helped a lot, thanks!",
        page: "/onboarding",
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ message: expect.stringContaining("received") });
    expect(feedbackInbox.length).toBe(1);

    const contact = await app.inject({
      method: "POST",
      url: "/api/v1/feedback",
      payload: {
        category: "contact",
        name: "Sam",
        email: "sam@example.com",
        message: "What does early-access pricing look like for one workspace?",
      },
    });
    expect(contact.statusCode).toBe(201);
    expect(feedbackInbox.length).toBe(2);

    const short = await app.inject({
      method: "POST",
      url: "/api/v1/feedback",
      payload: { message: "hi" },
    });
    expect(short.statusCode).toBe(422);

    const badEmail = await app.inject({
      method: "POST",
      url: "/api/v1/feedback",
      payload: { message: "This message is long enough to pass.", email: "not-an-email" },
    });
    expect(badEmail.statusCode).toBe(422);
    expect(feedbackInbox.length).toBe(2);
    clearFeedbackInbox();
  });

  it("authenticated onboarding checklist reads the workspace live", async () => {
    const anon = await app.inject({ method: "GET", url: "/app/onboarding" });
    expect(anon.statusCode).toBe(401);

    const { token, workspaceId } = await signup();
    const empty = await app.inject({
      method: "GET",
      url: `/app/onboarding?workspaceId=${workspaceId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.body).toContain("Your setup checklist");

    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name: "Acme", email: "acme@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        clientId: (client.json() as { client: { id: string } }).client.id,
        title: "Launch site",
        currency: "USD",
        totalValueCents: 100000,
      },
    });
    expect(project.statusCode).toBe(201);

    const after = await app.inject({
      method: "GET",
      url: `/app/onboarding?workspaceId=${workspaceId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(200);
    expect(after.body).toContain("✓");
  });
});
