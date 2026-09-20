import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { FakeEmailProvider } from "../../src/lib/providers.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 18: production-grade notifications.
 * - Email + in-app fan-out with stable idempotency (no duplicate payment
 *   reminders: a repeated overdue tick is a duplicate, never a resend).
 * - Paid-stop: settled milestones never queue or send overdue mail.
 * - Retry handling (fail → failed + next_retry_at → retry → sent),
 *   delivery status per row, failure handling, cancel.
 * - Per-user preferences + client opt-outs (signed unsubscribe, no login).
 * - Lifecycle hooks: pause/unpause fan-out covered here; payments, approvals,
 *   plans and releases share the same helper.
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
const email = new FakeEmailProvider();
const PASSWORD = "correct-horse-battery-12";
const PAST_DUE = "2026-08-01T00:00:00.000Z";
const TICK_NOW = "2026-09-10T00:00:00.000Z";

async function signup(
  emailAddr: string,
  displayName: string,
): Promise<{ token: string; workspaceId: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { email: emailAddr, displayName, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { token: string; workspace: { id: string }; user: { id: string } };
  return { token: body.token, workspaceId: body.workspace.id, userId: body.user.id };
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  app = await buildApp({ env: testEnv, loggerLevel: "fatal", store, emailProvider: email });
});

afterAll(async () => {
  await app.close();
});

describe("production-grade notifications", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  let secondMilestoneId = "";
  let overdueEmailId = "";

  it("sets up a project with an overdue milestone", async () => {
    ({ token, workspaceId } = await signup("fpp18-owner@example.com", "Fpp Eighteen"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme18@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: { clientId, title: "Website", currency: "USD", totalValueCents: 120000 },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 1 — Build", amountCents: 120000, dueDate: PAST_DUE },
    });
    expect(milestone.statusCode).toBe(201);
    milestoneId = (milestone.json() as { milestone: { id: string } }).milestone.id;
  });

  it("starts with an empty inbox and all-enabled preferences", async () => {
    const inbox = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notifications`,
      headers: auth(token),
    });
    expect(inbox.statusCode).toBe(200);
    const inboxBody = inbox.json() as {
      notifications: unknown[];
      summary: { unreadInapp: number };
    };
    expect(inboxBody.notifications).toHaveLength(0);

    const prefs = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notification-preferences`,
      headers: auth(token),
    });
    expect(prefs.statusCode).toBe(200);
    const prefBody = prefs.json() as { preferences: { enabled: boolean }[] };
    expect(prefBody.preferences).toHaveLength(14);
    expect(prefBody.preferences.every((p) => p.enabled)).toBe(true);
  });

  it("runs the overdue tick: one professional email + in-app notice", async () => {
    const tick = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/notifications/check-overdue`,
      headers: auth(token),
      payload: { now: TICK_NOW, portalUrl: "https://portal.example/p/1" },
    });
    expect(tick.statusCode).toBe(200);
    const body = tick.json() as { queued: { milestoneId: string }[]; duplicates: unknown[] };
    expect(body.queued).toHaveLength(1);
    expect(body.queued[0]?.milestoneId).toBe(milestoneId);

    expect(email.sent).toHaveLength(1);
    const sent = email.sent[0];
    expect(sent?.to).toBe("acme18@example.com");
    expect(sent?.subject ?? "").toContain("Overdue");
    expect(sent?.subject ?? "").toContain("Milestone 1");
    expect(sent?.text ?? "").toContain("Automated notice");
    expect(sent?.text ?? "").toContain("informational record");
    expect(sent?.text ?? "").toContain("Manage email preferences");
    expect(sent?.text ?? "").toContain("/api/v1/notifications/unsubscribe?token=");
    for (const banned of ["sue", "lawsuit", "court", "scam", "fraud", "Deposit"]) {
      expect(sent?.text ?? "").not.toContain(banned);
    }

    const inbox = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notifications`,
      headers: auth(token),
    });
    const rows = (inbox.json() as { notifications: Record<string, unknown>[] }).notifications;
    const emailed = rows.find((r) => r.channel === "email");
    expect(emailed?.kind).toBe("milestone_overdue");
    expect(emailed?.category).toBe("overdue");
    expect(emailed?.state).toBe("sent");
    expect(emailed?.delivery).toMatchObject({ status: "sent" });
    overdueEmailId = emailed?.id as string;
    const inapp = rows.find((r) => r.channel === "inapp");
    expect(inapp?.kind).toBe("milestone_overdue");
    expect(inapp?.state).toBe("delivered");
  });

  it("never sends duplicate payment reminders on a repeated tick", async () => {
    const before = email.sent.length;
    const tick = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/notifications/check-overdue`,
      headers: auth(token),
      payload: { now: TICK_NOW, portalUrl: "https://portal.example/p/1" },
    });
    expect(tick.statusCode).toBe(200);
    const body = tick.json() as { queued: unknown[]; duplicates: unknown[] };
    expect(body.queued).toHaveLength(0);
    expect(body.duplicates).toHaveLength(1);
    expect(email.sent).toHaveLength(before);
  });

  it("marks in-app rows read (idempotent)", async () => {
    const inbox = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notifications?channel=inapp`,
      headers: auth(token),
    });
    const rows = (inbox.json() as { notifications: { id: string }[] }).notifications;
    expect(rows.length).toBeGreaterThan(0);
    const id = rows[0]?.id as string;
    const read = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/notifications/${id}/read`,
      headers: auth(token),
      payload: {},
    });
    expect(read.statusCode).toBe(200);
    expect((read.json() as { read: boolean }).read).toBe(true);
    const repeat = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/notifications/${id}/read`,
      headers: auth(token),
      payload: {},
    });
    expect((repeat.json() as { duplicate: boolean }).duplicate).toBe(true);
  });

  it("records failures with a retry schedule and retries safely", async () => {
    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 2 — Polish", amountCents: 60000, dueDate: PAST_DUE },
    });
    expect(milestone.statusCode).toBe(201);
    secondMilestoneId = (milestone.json() as { milestone: { id: string } }).milestone.id;

    email.failNext(1);
    const tick = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/notifications/check-overdue`,
      headers: auth(token),
      payload: { now: "2026-09-11T00:00:00.000Z" },
    });
    expect(tick.statusCode).toBe(200);

    // The first dispatch in tick order (milestone 1, new day) fails.
    const inbox = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notifications?category=overdue&state=failed`,
      headers: auth(token),
    });
    const failed = (inbox.json() as { notifications: Record<string, unknown>[] }).notifications;
    expect(failed.length).toBeGreaterThan(0);
    const target = failed[0];
    expect(target?.milestoneId).toBeDefined();
    expect(target?.result_error).toBeDefined();
    expect(target?.delivery).toMatchObject({ status: "failed_retry_scheduled", attemptsLeft: 4 });
    expect(target?.next_retry_at).toBeDefined();

    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/notifications/${target?.id as string}/retry`,
      headers: auth(token),
      payload: {},
    });
    expect(retried.statusCode).toBe(200);
    expect((retried.json() as { notification: { state: string } }).notification.state).toBe("sent");

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/notifications/${target?.id as string}/retry`,
      headers: auth(token),
      payload: {},
    });
    expect((duplicate.json() as { duplicate: boolean }).duplicate).toBe(true);
  });

  it("stops overdue mail once the milestone is paid (paid-stop)", async () => {
    const base = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/transitions`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: base,
          headers: auth(token),
          payload: { action: "request_funding" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: base,
          headers: auth(token),
          payload: { action: "confirm_funding", paymentId: "fund_18" },
        })
      ).statusCode,
    ).toBe(200);

    const before = email.sent.length;
    const tick = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/notifications/check-overdue`,
      headers: auth(token),
      payload: { now: "2026-09-12T00:00:00.000Z" },
    });
    expect(tick.statusCode).toBe(200);
    const body = tick.json() as {
      queued: { milestoneId: string }[];
      skippedPaid: { milestoneId: string }[];
    };
    // The paid milestone is skipped and never mailed again …
    expect(body.skippedPaid.map((s) => s.milestoneId)).toContain(milestoneId);
    expect(body.queued.map((q) => q.milestoneId)).not.toContain(milestoneId);
    // … while the still-open milestone 2 gets its new daily notice only.
    expect(body.queued.map((q) => q.milestoneId)).toEqual([secondMilestoneId]);
    expect(email.sent).toHaveLength(before + 1);
  });

  it("honours per-user preferences (in-app suppression, no row)", async () => {
    const put = await app.inject({
      method: "PUT",
      url: `/api/v1/workspaces/${workspaceId}/notification-preferences`,
      headers: auth(token),
      payload: { preferences: [{ category: "pauses", channel: "inapp", enabled: false }] },
    });
    expect(put.statusCode).toBe(200);

    const get = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notification-preferences`,
      headers: auth(token),
    });
    const prefs = (
      get.json() as { preferences: { category: string; channel: string; enabled: boolean }[] }
    ).preferences;
    expect(prefs.find((p) => p.category === "pauses" && p.channel === "inapp")?.enabled).toBe(
      false,
    );

    // Rejects unknown categories and duplicates.
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/workspaces/${workspaceId}/notification-preferences`,
          headers: auth(token),
          payload: { preferences: [{ category: "nope", channel: "email", enabled: false }] },
        })
      ).statusCode,
    ).toBe(422);
  });

  it("fans out pause notices (client email queued, member in-app suppressed by prefs)", async () => {
    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/pause`,
      headers: auth(token),
      payload: { reason: "Awaiting the overdue balance" },
    });
    expect(paused.statusCode).toBe(200);

    const inbox = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notifications?category=pauses`,
      headers: auth(token),
    });
    const rows = (inbox.json() as { notifications: Record<string, unknown>[] }).notifications;
    const emailed = rows.find((r) => r.channel === "email" && r.kind === "project_paused");
    expect(emailed).toBeDefined();
    expect(emailed?.state).toBe("queued");
    // Member in-app was suppressed by the preference above — no row.
    expect(rows.find((r) => r.channel === "inapp" && r.kind === "project_paused")).toBeUndefined();

    // The outbox tick delivers the queued client email.
    const before = email.sent.length;
    const dispatch = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/notifications/dispatch-due`,
      headers: auth(token),
      payload: {},
    });
    expect(dispatch.statusCode).toBe(200);
    expect((dispatch.json() as { sent: unknown[] }).sent.length).toBeGreaterThanOrEqual(1);
    expect(email.sent.length).toBeGreaterThan(before);
    expect(email.sent[email.sent.length - 1]?.subject ?? "").toContain("Work paused");

    const unpaused = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/unpause`,
      headers: auth(token),
      payload: {},
    });
    expect(unpaused.statusCode).toBe(200);
  });

  it("supports client unsubscribe (opt-out suppresses, token preview is public)", async () => {
    const added = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/notification-opt-outs`,
      headers: auth(token),
      payload: { email: "acme18@example.com", category: "overdue" },
    });
    expect(added.statusCode).toBe(201);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notification-opt-outs`,
      headers: auth(token),
    });
    expect(
      (listed.json() as { optOuts: { email: string }[] }).optOuts.map((o) => o.email),
    ).toContain("acme18@example.com");

    // New overdue milestone: client email suppressed, in-app still delivered.
    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 3 — Launch", amountCents: 10000, dueDate: PAST_DUE },
    });
    const m3 = (milestone.json() as { milestone: { id: string } }).milestone.id;
    const before = email.sent.length;
    const tick = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/notifications/check-overdue`,
      headers: auth(token),
      payload: { now: "2026-09-13T00:00:00.000Z" },
    });
    expect(tick.statusCode).toBe(200);
    const body = tick.json() as { skippedPaid: { milestoneId: string }[] };
    expect(body.skippedPaid.map((s) => s.milestoneId)).toContain(m3);
    expect(email.sent).toHaveLength(before);

    // Public token preview: extract the token from any earlier sent mail.
    const withToken = email.sent.find((s) => s.text.includes("unsubscribe?token="));
    expect(withToken).toBeDefined();
    const tokenMatch = /unsubscribe\?token=([A-Za-z0-9\-_%.]+)/.exec(withToken?.text ?? "");
    expect(tokenMatch?.[1]).toBeDefined();
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/notifications/unsubscribe?token=${encodeURIComponent(tokenMatch?.[1] as string)}`,
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { email: string }).email).toBe("ac***@example.com");

    const bad = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unsubscribe?token=tampered.token",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("confirms unsubscribe publicly and resubscribes via the API", async () => {
    const withToken = email.sent.find((s) => s.text.includes("unsubscribe?token="));
    const tokenMatch = /unsubscribe\?token=([A-Za-z0-9\-_%.]+)/.exec(withToken?.text ?? "");
    const confirm = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/unsubscribe",
      payload: { token: decodeURIComponent(tokenMatch?.[1] as string) },
    });
    expect(confirm.statusCode).toBe(200);
    expect((confirm.json() as { unsubscribed: boolean }).unsubscribed).toBe(true);

    const resub = await app.inject({
      method: "DELETE",
      url: `/api/v1/workspaces/${workspaceId}/notification-opt-outs`,
      headers: auth(token),
      payload: { email: "acme18@example.com", category: "overdue" },
    });
    expect(resub.statusCode).toBe(200);
    expect((resub.json() as { resubscribed: boolean }).resubscribed).toBe(true);
  });

  it("exposes delivery detail per notification and cancels queued rows", async () => {
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notifications/${overdueEmailId}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { notification: { kind: string } }).notification.kind).toBe(
      "milestone_overdue",
    );

    // Queue a fresh pausable notice, then cancel before dispatch.
    await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/pause`,
      headers: auth(token),
      payload: { reason: "Second review pause" },
    });
    const inbox = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notifications?category=pauses&state=queued`,
      headers: auth(token),
    });
    const queued = (inbox.json() as { notifications: { id: string }[] }).notifications;
    expect(queued.length).toBeGreaterThan(0);
    const canceled = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/notifications/${queued[0]?.id as string}/cancel`,
      headers: auth(token),
      payload: {},
    });
    expect((canceled.json() as { canceled: boolean }).canceled).toBe(true);
    await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/unpause`,
      headers: auth(token),
      payload: {},
    });
  });

  it("serves the notification center page and links it from the project", async () => {
    const signin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/signin",
      payload: { email: "fpp18-owner@example.com", password: PASSWORD },
    });
    expect(signin.statusCode).toBe(200);
    const setCookie = signin.headers["set-cookie"];
    const sessionCookie =
      (Array.isArray(setCookie) ? setCookie[0] : (setCookie as string))?.split(";")[0] ?? "";

    const page = await app.inject({
      method: "GET",
      url: `/app/notifications?workspaceId=${workspaceId}`,
      headers: { cookie: sessionCookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Notification center");
    expect(page.body).toContain("Your preferences");

    const projectPage = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}?workspaceId=${workspaceId}`,
      headers: { cookie: sessionCookie },
    });
    expect(projectPage.statusCode).toBe(200);
    expect(projectPage.body).toContain(`/app/notifications?workspaceId=${workspaceId}`);
  });

  it("isolates tenants on notification routes", async () => {
    const other = await signup("fpp18-intruder@example.com", "Fpp Intruder");
    const forbidden = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/notifications`,
      headers: auth(other.token),
    });
    expect(forbidden.statusCode).toBe(403);
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${other.workspaceId}/notifications/${overdueEmailId}`,
      headers: auth(other.token),
    });
    expect([403, 404]).toContain(missing.statusCode);
  });
});
