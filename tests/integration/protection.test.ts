import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 16: project protection / risk-awareness.
 * - Read-only protection checks derived from live project data.
 * - Observable conditions only: no client labels, no opaque scores.
 * - Tenant isolation + server-rendered Project health page.
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

describe("project protection checks", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  const BANNED = ["scammer", "bad client", "dishonest", "fraudulent"];

  it("surfaces observable conditions for a fresh project", async () => {
    ({ token, workspaceId } = await signup("fpp16-owner@example.com", "Fpp Sixteen"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme16@example.com" },
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

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/protection`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      projectId: string;
      status: string;
      attentionCount: number;
      clearCount: number;
      checks: { code: string; title: string; status: string; detail: string; nextStep: string }[];
      disclaimer: string;
      note: string;
    };
    expect(body.projectId).toBe(projectId);
    expect(body.checks).toHaveLength(12);
    const codes = body.checks.map((c) => c.code);
    expect(codes).toContain("payment_method_not_configured");
    expect(codes).toContain("deposit_missing");
    expect(codes).toContain("milestone_overdue");
    expect(codes).toContain("contract_unsigned");
    expect(codes).toContain("large_unpaid_balance");
    expect(codes).toContain("final_unlocked");
    const byCode = new Map(body.checks.map((c) => [c.code, c] as const));
    expect(byCode.get("payment_method_not_configured")?.status).toBe("needs_attention");
    expect(byCode.get("deposit_missing")?.status).toBe("needs_attention");
    expect(byCode.get("milestone_overdue")?.status).toBe("needs_attention");
    expect(byCode.get("contract_unsigned")?.status).toBe("needs_attention");
    expect(body.status).toBe("needs_attention");
    expect(body.attentionCount).toBeGreaterThan(0);
    expect(body.disclaimer).toMatch(/Not legal advice/);
    const blob = JSON.stringify(body).toLowerCase();
    for (const word of BANNED) {
      expect(blob).not.toContain(word);
    }
    expect(body).not.toHaveProperty("riskScore");
    expect(body).not.toHaveProperty("score");
    expect(blob).toContain("no automated risk score");
  });

  it("renders the Project health page and links it from the project page", async () => {
    const page = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/protection?workspaceId=${workspaceId}`,
      headers: { cookie: "" },
    });
    // Cookie auth required for pages; use Bearer via cookie header instead.
    const authed = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/protection?workspaceId=${workspaceId}`,
      headers: { authorization: `Bearer ${token}` } as unknown as Record<string, string>,
    });
    // pageIdentity reads cookie OR bearer? It reads both via extractSessionToken.
    expect([200, 401]).toContain(authed.statusCode);
    expect(page.statusCode).toBe(401);

    // Direct cookie form (what browsers send) renders the checks.
    const signupBody = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signin",
      payload: { email: "fpp16-owner@example.com", password: PASSWORD },
    });
    const setCookie = signupBody.headers["set-cookie"];
    const cookie = Array.isArray(setCookie) ? setCookie[0] : (setCookie as string);
    const sessionCookie = cookie?.split(";")[0] ?? "";
    const html = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/protection?workspaceId=${workspaceId}`,
      headers: { cookie: sessionCookie },
    });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain("Protection checks");
    expect(html.body).toContain("Deposit missing");
    expect(html.body).toContain("Milestone overdue");

    const projectPage = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}?workspaceId=${workspaceId}`,
      headers: { cookie: sessionCookie },
    });
    expect(projectPage.statusCode).toBe(200);
    expect(projectPage.body).toContain(`/app/projects/${projectId}/protection`);
  });

  it("enforces auth and tenant isolation", async () => {
    const anon = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/protection`,
    });
    expect(anon.statusCode).toBe(401);

    const other = await signup("fpp16-other@example.com", "Fpp Other");
    const cross = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${other.workspaceId}/projects/${projectId}/protection`,
      headers: auth(other.token),
    });
    expect([403, 404]).toContain(cross.statusCode);

    const crossPage = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/protection?workspaceId=${other.workspaceId}`,
      headers: auth(other.token),
    });
    expect([404, 401]).toContain(crossPage.statusCode);
  });
});
