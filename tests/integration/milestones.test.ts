import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/** Session 05: milestone engine over HTTP — sequencing, guards, idempotency. */

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

describe("milestone engine API", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  const milestoneIds: string[] = [];

  async function transition(id: string, action: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${id}/transitions`,
      headers: auth(token),
      payload: { action, ...extra },
    });
  }

  it("creates a project and four sequenced milestones", async () => {
    ({ token, workspaceId } = await signup("fpp05-owner@example.com", "Fpp Five"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme05@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: { clientId, title: "Brand site", currency: "USD", totalValueCents: 400000 },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    const specs = [
      { title: "Discovery", amountCents: 50000 },
      { title: "Design", amountCents: 100000 },
      { title: "Development", amountCents: 150000 },
      { title: "Launch", amountCents: 100000 },
    ];
    for (const spec of specs) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
        headers: auth(token),
        payload: spec,
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { milestone: { id: string; orderIndex: number; unlock: string } };
      milestoneIds.push(body.milestone.id);
    }
    expect(milestoneIds).toHaveLength(4);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
    });
    const body = list.json() as { milestones: { title: string; unlock: string }[] };
    expect(body.milestones.map((m) => m.title)).toEqual([
      "Discovery",
      "Design",
      "Development",
      "Launch",
    ]);
    expect(body.milestones[0]?.unlock).toBe("available");
    expect(body.milestones[1]?.unlock).toBe("locked");
  });

  it("rejects the Deposit label and currency mismatches", async () => {
    const deposit = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "50% Deposit", amountCents: 1000 },
    });
    expect(deposit.statusCode).toBe(422);
    const currency = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Extra", amountCents: 1000, currency: "EUR" },
    });
    expect(currency.statusCode).toBe(422);
  });

  it("runs milestone 1 through funding → approval → payout → release", async () => {
    const first = milestoneIds[0] as string;
    // Work cannot start before funding.
    expect((await transition(first, "start_work")).statusCode).toBe(422);
    expect((await transition(first, "request_funding")).statusCode).toBe(200);
    expect((await transition(first, "confirm_funding", { paymentId: "fund_1" })).statusCode).toBe(
      200,
    );
    // Double-funding the same receipt is a conflict.
    expect((await transition(first, "confirm_funding", { paymentId: "fund_1" })).statusCode).toBe(
      409,
    );
    expect((await transition(first, "start_work")).statusCode).toBe(200);
    expect((await transition(first, "submit")).statusCode).toBe(200);
    // Approval without a current version is rejected.
    expect((await transition(first, "approve")).statusCode).toBe(422);
    // Pin a version first, then approve.
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${first}`,
      headers: auth(token),
      payload: { currentVersionId: "v1" },
    });
    expect(patched.statusCode).toBe(200);
    expect((await transition(first, "approve", { approvedVersionId: "v1" })).statusCode).toBe(200);
    expect((await transition(first, "share_preview")).statusCode).toBe(200);
    expect((await transition(first, "mark_unlock_ready")).statusCode).toBe(200);
    expect((await transition(first, "request_payout")).statusCode).toBe(200);
    expect((await transition(first, "confirm_payout", { paymentId: "pay_1" })).statusCode).toBe(
      200,
    );
    // Paying twice is a conflict.
    expect((await transition(first, "confirm_payout", { paymentId: "pay_1" })).statusCode).toBe(
      409,
    );
    expect((await transition(first, "release")).statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${first}`,
      headers: auth(token),
    });
    const body = detail.json() as { milestone: { payment: string; unlock: string } };
    expect(body.milestone.payment).toBe("paid");
    expect(body.milestone.unlock).toBe("unlocked");

    // Milestone 2 is now available; milestone 3 is still locked.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
    });
    const miles = (list.json() as { milestones: { title: string; unlock: string }[] }).milestones;
    expect(miles[1]?.unlock).toBe("available");
    expect(miles[2]?.unlock).toBe("locked");
  });

  it("prevents skipping ahead to a locked milestone", async () => {
    const third = milestoneIds[2] as string;
    expect((await transition(third, "request_funding")).statusCode).toBe(200);
    expect((await transition(third, "confirm_funding", { paymentId: "fund_3" })).statusCode).toBe(
      200,
    );
    expect((await transition(third, "start_work")).statusCode).toBe(422);
  });

  it("requires an audit reason to change amounts after funding", async () => {
    const second = milestoneIds[1] as string;
    expect((await transition(second, "request_funding")).statusCode).toBe(200);
    expect((await transition(second, "confirm_funding", { paymentId: "fund_2" })).statusCode).toBe(
      200,
    );
    const noReason = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${second}/amount`,
      headers: auth(token),
      payload: { newAmountCents: 120000 },
    });
    expect(noReason.statusCode).toBe(422);
    const audited = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${second}/amount`,
      headers: auth(token),
      payload: { newAmountCents: 120000, reason: "Client added an extra page" },
    });
    expect(audited.statusCode).toBe(200);
    expect(
      (audited.json() as { milestone: { amountCents: number; amountHistory: unknown[] } }).milestone
        .amountCents,
    ).toBe(120000);
  });

  it("freezes order after funding and keeps cross-tenant isolation", async () => {
    const frozen = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/reorder`,
      headers: auth(token),
      payload: { order: [...milestoneIds].reverse() },
    });
    expect(frozen.statusCode).toBe(422);

    const other = await signup("fpp05-intruder@example.com", "Intruder");
    const probe = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(other.token),
    });
    expect(probe.statusCode).toBe(403);
    const write = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(other.token),
      payload: { title: "Hijack", amountCents: 100 },
    });
    expect(write.statusCode).toBe(403);
  });
});
