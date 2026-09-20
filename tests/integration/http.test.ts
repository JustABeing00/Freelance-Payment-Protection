import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import type { FastifyInstance } from "fastify";

const testEnv = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  LOG_LEVEL: "fatal" as const,
  DATABASE_URL: "postgres://localhost:5432/fpp_test",
  SESSION_SECRET: "test-session-secret-that-is-long-enough-0123456789",
  APP_BASE_URL: "http://localhost:3000",
  MAGIC_LINK_TTL_HOURS: 168,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("http foundation (health, headers, error envelope)", () => {
  it("GET /health returns ok + version without leaking internals", async () => {
    app = await buildApp({ env: testEnv, loggerLevel: "fatal" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["version"]).toBe("0.19.0");
    expect(JSON.stringify(body)).not.toMatch(/secret|password|DATABASE_URL/i);
  });

  it("unknown routes use the stable error envelope with a request id", async () => {
    app = await buildApp({ env: testEnv, loggerLevel: "fatal" });
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(typeof body.error.requestId).toBe("string");
  });

  it("security headers are present (helmet: CSP, nosniff, frame-deny)", async () => {
    app = await buildApp({ env: testEnv, loggerLevel: "fatal" });
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
  });

  it("disclaimer endpoint carries the legal-boundary copy", async () => {
    app = await buildApp({ env: testEnv, loggerLevel: "fatal" });
    const res = await app.inject({ method: "GET", url: "/api/v1/disclaimer" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      disclaimer: expect.stringContaining("Not legal advice"),
    });
  });
});
