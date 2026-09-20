import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Ownership-boundary tests (session 03 contract):
 * identity → workspace/business → clients → projects, with server-side
 * authorization on every protected handler and IDOR probes that swap IDs.
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

interface SignupResult {
  token: string;
  userId: string;
  workspaceId: string;
  cookie: string | undefined;
}

async function signup(
  email: string,
  displayName: string,
  password = PASSWORD,
): Promise<SignupResult> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { email, displayName, password },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as {
    token: string;
    user: { id: string };
    workspace: { id: string };
  };
  return {
    token: body.token,
    userId: body.user.id,
    workspaceId: body.workspace.id,
    cookie: res.headers["set-cookie"] as string | undefined,
  };
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

describe("identity: signup / signin / signout / account", () => {
  it("signs up alice with a default workspace and session cookie", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      payload: { email: "alice@example.com", displayName: "Alice", password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      token: string;
      user: { email: string };
      workspace: { id: string };
    };
    expect(typeof body.token).toBe("string");
    expect(body.user.email).toBe("alice@example.com");
    expect(typeof body.workspace.id).toBe("string");
    expect(String(res.headers["set-cookie"] ?? "")).toContain("session=");
    expect(String(res.headers["set-cookie"] ?? "")).toContain("HttpOnly");
  });

  it("rejects duplicate signup with 409 and weak passwords with 422", async () => {
    const dup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      payload: { email: "alice@example.com", displayName: "Alice 2", password: PASSWORD },
    });
    expect(dup.statusCode).toBe(409);
    const weak = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signup",
      payload: { email: "weak@example.com", displayName: "Weak", password: "short" },
    });
    expect(weak.statusCode).toBe(422);
  });

  it("signs in with valid credentials; generic 401 otherwise (no oracle)", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signin",
      payload: { email: "alice@example.com", password: PASSWORD },
    });
    expect(ok.statusCode).toBe(200);

    const wrong = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signin",
      payload: { email: "alice@example.com", password: "wrong-password-000" },
    });
    expect(wrong.statusCode).toBe(401);
    const unknown = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signin",
      payload: { email: "nobody@example.com", password: "wrong-password-000" },
    });
    expect(unknown.statusCode).toBe(401);
    // Same generic message for both cases.
    expect((wrong.json() as { error: { message: string } }).error.message).toBe(
      (unknown.json() as { error: { message: string } }).error.message,
    );
  });

  it("requires auth on protected routes (401 without a session)", async () => {
    for (const target of [
      { method: "GET", url: "/api/v1/me" },
      { method: "GET", url: "/api/v1/workspaces" },
      { method: "POST", url: "/api/v1/auth/signout" },
    ] as const) {
      const res = await app.inject({ method: target.method, url: target.url });
      expect(res.statusCode).toBe(401);
    }
  });

  it("serves /me over Bearer and over cookie, and updates account settings", async () => {
    const bob = await signup("bob-owner@example.com", "Bob Owner");
    const viaBearer = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: auth(bob.token),
    });
    expect(viaBearer.statusCode).toBe(200);
    const cookieValue = String(bob.cookie ?? "").split(";")[0] ?? "";
    const viaCookie = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { cookie: cookieValue },
    });
    expect(viaCookie.statusCode).toBe(200);

    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: auth(bob.token),
      payload: { displayName: "Bobby Owner" },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { user: { displayName: string } }).user.displayName).toBe(
      "Bobby Owner",
    );
  });

  it("rotates passwords only with the current password, then honors the new one", async () => {
    const carol = await signup("carol-pw@example.com", "Carol Pw");
    const wrongCurrent = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: auth(carol.token),
      payload: { currentPassword: "not-the-password-00", newPassword: "brand-new-password-99" },
    });
    expect(wrongCurrent.statusCode).toBe(401);

    const rotated = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: auth(carol.token),
      payload: { currentPassword: PASSWORD, newPassword: "brand-new-password-99" },
    });
    expect(rotated.statusCode).toBe(200);

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signin",
      payload: { email: "carol-pw@example.com", password: PASSWORD },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signin",
      payload: { email: "carol-pw@example.com", password: "brand-new-password-99" },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("signs out with session clear; signed-out token is still stateless-ok but cookie clears", async () => {
    const dave = await signup("dave-out@example.com", "Dave Out");
    const out = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signout",
      headers: auth(dave.token),
    });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["set-cookie"] ?? "")).toContain("Max-Age=0");
  });
});

describe("ownership boundaries: user → workspace → clients → projects", () => {
  let alice: SignupResult;
  let mallory: SignupResult;
  let aliceClientId = "";
  let aliceProjectId = "";

  it("sets up two isolated freelancers with a client + project each side", async () => {
    alice = await signup("alice-tenant@example.com", "Alice Tenant");
    mallory = await signup("mallory-tenant@example.com", "Mallory Tenant");

    const clientRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${alice.workspaceId}/clients`,
      headers: auth(alice.token),
      payload: { name: "Acme Corp", email: "contact@acme.example" },
    });
    expect(clientRes.statusCode).toBe(201);
    aliceClientId = (clientRes.json() as { client: { id: string } }).client.id;

    const projectRes = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${alice.workspaceId}/projects`,
      headers: auth(alice.token),
      payload: {
        clientId: aliceClientId,
        title: "Website rebuild",
        currency: "usd",
        totalValueCents: 500000,
      },
    });
    expect(projectRes.statusCode).toBe(201);
    aliceProjectId = (projectRes.json() as { project: { id: string } }).project.id;
  });

  it("blocks cross-workspace reads with generic 403 (no oracle leak)", async () => {
    const cases: { method: "GET" | "POST"; url: string }[] = [
      { method: "GET", url: `/api/v1/workspaces/${alice.workspaceId}` },
      { method: "GET", url: `/api/v1/workspaces/${alice.workspaceId}/members` },
      { method: "GET", url: `/api/v1/workspaces/${alice.workspaceId}/clients` },
      { method: "GET", url: `/api/v1/workspaces/${alice.workspaceId}/projects` },
    ];
    for (const target of cases) {
      const res = await app.inject({
        method: target.method,
        url: target.url,
        headers: auth(mallory.token),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    }
  });

  it("prevents IDOR: another user's row is never reachable by swapping IDs", async () => {
    // Direct row id inside the victim workspace path.
    for (const url of [
      `/api/v1/workspaces/${alice.workspaceId}/clients/${aliceClientId}`,
      `/api/v1/workspaces/${alice.workspaceId}/projects/${aliceProjectId}`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth(mallory.token) });
      expect(res.statusCode).toBe(403);
    }
    // Victim row id smuggled under the attacker's own workspace path.
    for (const url of [
      `/api/v1/workspaces/${mallory.workspaceId}/clients/${aliceClientId}`,
      `/api/v1/workspaces/${mallory.workspaceId}/projects/${aliceProjectId}`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth(mallory.token) });
      expect(res.statusCode).toBe(403);
    }
    // Writes into the victim workspace are denied server-side, not just hidden in UI.
    const writeClient = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${alice.workspaceId}/clients`,
      headers: auth(mallory.token),
      payload: { name: "Intruder", email: "intruder@example.com" },
    });
    expect(writeClient.statusCode).toBe(403);
    const writeProject = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${alice.workspaceId}/projects`,
      headers: auth(mallory.token),
      payload: {
        clientId: aliceClientId,
        title: "Hijack",
        currency: "USD",
        totalValueCents: 100,
      },
    });
    expect(writeProject.statusCode).toBe(403);
  });

  it("rejects cross-workspace client linkage when creating a project", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${mallory.workspaceId}/projects`,
      headers: auth(mallory.token),
      payload: {
        clientId: aliceClientId,
        title: "Cross-tenant project",
        currency: "USD",
        totalValueCents: 1000,
      },
    });
    expect([404, 422]).toContain(res.statusCode);
    // And nothing was created in the victim workspace.
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${alice.workspaceId}/projects`,
      headers: auth(alice.token),
    });
    expect((list.json() as { projects: { id: string }[] }).projects.map((p) => p.id)).toContain(
      aliceProjectId,
    );
  });

  it("lets the owner read their own rows (control case)", async () => {
    const client = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${alice.workspaceId}/clients/${aliceClientId}`,
      headers: auth(alice.token),
    });
    expect(client.statusCode).toBe(200);
    const project = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${alice.workspaceId}/projects/${aliceProjectId}`,
      headers: auth(alice.token),
    });
    expect(project.statusCode).toBe(200);
  });

  it("supports multiple brands/workspaces per freelancer", async () => {
    const second = await app.inject({
      method: "POST",
      url: "/api/v1/workspaces",
      headers: auth(alice.token),
      payload: { name: "Second Brand" },
    });
    expect(second.statusCode).toBe(201);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: auth(alice.token),
    });
    const ids = (list.json() as { workspaces: { id: string }[] }).workspaces.map((w) => w.id);
    expect(ids).toContain(alice.workspaceId);
    expect(ids).toContain((second.json() as { workspace: { id: string } }).workspace.id);
    // Mallory still sees only her own workspace.
    const malloryList = await app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
      headers: auth(mallory.token),
    });
    expect(
      (malloryList.json() as { workspaces: { id: string }[] }).workspaces.map((w) => w.id),
    ).toEqual([mallory.workspaceId]);
  });
});

describe("workspace membership model and roles", () => {
  let owner: SignupResult;
  let assistant: SignupResult;
  let accountant: SignupResult;
  let outsider: SignupResult;

  it("owner invites assistant (member) and accountant (read-only)", async () => {
    owner = await signup("owner-roles@example.com", "Owner Roles");
    assistant = await signup("assistant-roles@example.com", "Assistant");
    accountant = await signup("accountant-roles@example.com", "Accountant");
    outsider = await signup("outsider-roles@example.com", "Outsider");

    for (const invite of [
      { email: "assistant-roles@example.com", role: "member" },
      { email: "accountant-roles@example.com", role: "accountant_readonly" },
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${owner.workspaceId}/members`,
        headers: auth(owner.token),
        payload: invite,
      });
      expect(res.statusCode).toBe(201);
    }

    const members = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${owner.workspaceId}/members`,
      headers: auth(owner.token),
    });
    expect(members.statusCode).toBe(200);
    expect(
      (members.json() as { members: { role: string }[] }).members.map((m) => m.role).sort(),
    ).toEqual(["accountant_readonly", "member", "owner"]);
  });

  it("member can write clients/projects but cannot manage members", async () => {
    const createClient = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${owner.workspaceId}/clients`,
      headers: auth(assistant.token),
      payload: { name: "Member Client", email: "member-client@example.com" },
    });
    expect(createClient.statusCode).toBe(201);
    const clientId = (createClient.json() as { client: { id: string } }).client.id;
    const createProject = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${owner.workspaceId}/projects`,
      headers: auth(assistant.token),
      payload: { clientId, title: "Member project", currency: "USD", totalValueCents: 2000 },
    });
    expect(createProject.statusCode).toBe(201);

    const invite = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${owner.workspaceId}/members`,
      headers: auth(assistant.token),
      payload: { email: "outsider-roles@example.com", role: "member" },
    });
    expect(invite.statusCode).toBe(403);
  });

  it("accountant_readonly can read but cannot write anything", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${owner.workspaceId}/clients`,
      headers: auth(accountant.token),
    });
    expect(list.statusCode).toBe(200);
    const writeClient = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${owner.workspaceId}/clients`,
      headers: auth(accountant.token),
      payload: { name: "Blocked", email: "blocked@example.com" },
    });
    expect(writeClient.statusCode).toBe(403);
    const writeProject = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${owner.workspaceId}/projects`,
      headers: auth(accountant.token),
      payload: {
        clientId: "00000000-0000-4000-8000-000000000000",
        title: "Blocked",
        currency: "USD",
        totalValueCents: 100,
      },
    });
    expect(writeProject.statusCode).toBe(403);
    const invite = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${owner.workspaceId}/members`,
      headers: auth(accountant.token),
      payload: { email: "outsider-roles@example.com", role: "member" },
    });
    expect(invite.statusCode).toBe(403);
  });

  it("outsiders cannot manage members; duplicates conflict; unknown users 404", async () => {
    const outsiderInvite = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${owner.workspaceId}/members`,
      headers: auth(outsider.token),
      payload: { email: "outsider-roles@example.com", role: "member" },
    });
    expect(outsiderInvite.statusCode).toBe(403);

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${owner.workspaceId}/members`,
      headers: auth(owner.token),
      payload: { email: "assistant-roles@example.com", role: "member" },
    });
    expect(duplicate.statusCode).toBe(409);

    const unknown = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${owner.workspaceId}/members`,
      headers: auth(owner.token),
      payload: { email: "ghost-unknown@example.com", role: "member" },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
