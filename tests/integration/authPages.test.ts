import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/config/app.js";

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

function uniqueEmail(prefix: string): string {
  return `${prefix}${Date.now()}${Math.random().toString(16).slice(2)}@example.com`;
}

async function signupApi(email: string): Promise<{ cookie: string; workspaceId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { email, displayName: "Front Door", password: "front-door-password-1" },
  });
  expect(res.statusCode).toBe(201);
  const setCookie = res.headers["set-cookie"];
  const raw = Array.isArray(setCookie) ? setCookie.join("; ") : String(setCookie ?? "");
  expect(raw).toContain("session=");
  const cookie = raw
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("session="));
  expect(cookie).toBeTruthy();
  const body = res.json() as { workspace: { id: string } };
  return { cookie: cookie as string, workspaceId: body.workspace.id };
}

describe("browser auth front door", () => {
  it("GET /signup renders a CSP-safe signup form with no-store caching", async () => {
    const res = await app.inject({ method: "GET", url: "/signup" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toContain('data-auth="signup"');
    expect(res.body).toContain('action="/api/v1/auth/signup"');
    expect(res.body).toContain('name="displayName"');
    expect(res.body).toContain('name="email"');
    expect(res.body).toContain('name="password"');
    expect(res.body).toContain("12+ characters");
    expect(res.body).not.toContain("POST /api/v1/auth/signup");
  });

  it("GET /signin renders a CSP-safe signin form with no-store caching", async () => {
    const res = await app.inject({ method: "GET", url: "/signin" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.body).toContain('data-auth="signin"');
    expect(res.body).toContain('action="/api/v1/auth/signin"');
    expect(res.body).toContain('href="/signup"');
  });

  it("signup cookie opens workspace pages (full browser-equivalent flow)", async () => {
    const { cookie, workspaceId } = await signupApi(uniqueEmail("door"));
    const projects = await app.inject({
      method: "GET",
      url: `/app/projects?workspaceId=${workspaceId}`,
      headers: { cookie },
    });
    expect(projects.statusCode).toBe(200);
    expect(projects.body).toContain("Projects");
  });

  it("signed-in visitors bounce from /signup and /signin to /app", async () => {
    const { cookie } = await signupApi(uniqueEmail("bounce"));
    for (const url of ["/signup", "/signin"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/app");
    }
  });

  it("GET /app smart-redirects signed-in users straight into their workspace", async () => {
    const anon = await app.inject({ method: "GET", url: "/app" });
    expect(anon.statusCode).toBe(200);

    const { cookie, workspaceId } = await signupApi(uniqueEmail("smart"));
    const smart = await app.inject({ method: "GET", url: "/app", headers: { cookie } });
    expect(smart.statusCode).toBe(302);
    expect(smart.headers.location).toBe(`/app/projects?workspaceId=${workspaceId}`);
  });

  it("signin + workspaces chain resolves the landing workspace", async () => {
    const email = uniqueEmail("chain");
    const created = await signupApi(email);
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signin",
      payload: { email, password: "front-door-password-1" },
    });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: { authorization: `Bearer ${(res.json() as { token: string }).token}` },
    });
    expect(list.statusCode).toBe(200);
    const ids = (list.json() as { workspaces: { id: string }[] }).workspaces.map((w) => w.id);
    expect(ids).toContain(created.workspaceId);
  });

  it("nav and homepage point at the new front door", async () => {
    const home = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    expect(home.body).toContain('href="/signup"');
    expect(home.body).toContain('href="/signin"');
    expect(home.body).not.toContain('href="/onboarding">Get started');
  });
});
