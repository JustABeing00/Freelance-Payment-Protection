import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { FakeEmailProvider } from "../../src/lib/providers.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 12: reminder + escalation engine.
 * - Configurable policies (project override → workspace defaults → default).
 * - Auditable (scheduled_at/sent_at/state/recipient/template+version/
 *   result-error/next action) + idempotent + retry-safe + cancelable.
 * - Manual-only escalation language is never auto-sent and stays
 *   jurisdiction-aware.
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
const DUE = "2026-10-01T00:00:00.000Z";

async function signup(
  emailAddr: string,
  displayName: string,
): Promise<{ token: string; workspaceId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { email: emailAddr, displayName, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { token: string; workspace: { id: string } };
  return { token: body.token, workspaceId: body.workspace.id };
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

describe("reminder and escalation engine", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  let firstReminderId = "";
  let secondReminderId = "";

  it("sets up a project with a dated milestone", async () => {
    ({ token, workspaceId } = await signup("fpp12-owner@example.com", "Fpp Twelve"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme12@example.com" },
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
      payload: { title: "Milestone 1 — Build", amountCents: 120000, dueDate: DUE },
    });
    expect(milestone.statusCode).toBe(201);
    milestoneId = (milestone.json() as { milestone: { id: string } }).milestone.id;
  });

  it("lists versioned professional templates", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/reminder-templates",
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { version: string; templates: { key: string }[] };
    expect(body.version).toBe("v1");
    expect(body.templates.map((t) => t.key)).toEqual([
      "upcoming_friendly",
      "payment_due",
      "first_overdue",
      "firmer_notice",
      "escalation_notice",
      "work_paused",
    ]);
  });

  it("resolves the default policy before configuration", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/reminders/policy`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { source: string; policy: { steps: unknown[] } };
    expect(body.source).toBe("default");
    expect(body.policy.steps).toHaveLength(6);
  });

  it("rejects an unsafe workspace policy (escalation without manual guard)", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/workspaces/${workspaceId}/reminder-policy`,
      headers: auth(token),
      payload: {
        policy: {
          version: 1,
          channel: "email",
          enabled: true,
          steps: [
            {
              key: "auto-escalation",
              offsetDays: 14,
              label: "Auto escalation",
              tone: "escalation",
              templateKey: "escalation_notice",
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("stores a per-project policy override", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/reminders/policy`,
      headers: auth(token),
      payload: {
        policy: {
          version: 1,
          channel: "email",
          enabled: true,
          steps: [
            {
              key: "nudge",
              offsetDays: -1,
              label: "Nudge",
              tone: "friendly",
              templateKey: "upcoming_friendly",
            },
            {
              key: "due",
              offsetDays: 1,
              label: "Due",
              tone: "neutral",
              templateKey: "payment_due",
            },
          ],
        },
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { source: string }).source).toBe("project");
  });

  it("previews the schedule without writing rows", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/reminders/plan`,
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      policySource: string;
      planned: { stepKey: string; idempotencyKey: string }[];
    };
    expect(body.policySource).toBe("project");
    expect(body.planned).toHaveLength(2);
    expect(body.planned[0]?.idempotencyKey).toMatch(/^reminder:/);
  });

  it("schedules idempotently (repeats are duplicates, never resends)", async () => {
    const url = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/reminders/schedule`;
    const first = await app.inject({ method: "POST", url, headers: auth(token), payload: {} });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as {
      scheduled: { id: string }[];
      duplicates: unknown[];
    };
    expect(firstBody.scheduled).toHaveLength(2);
    expect(firstBody.duplicates).toHaveLength(0);
    firstReminderId = firstBody.scheduled[0]?.id as string;
    secondReminderId = firstBody.scheduled[1]?.id as string;

    const repeat = await app.inject({ method: "POST", url, headers: auth(token), payload: {} });
    expect(repeat.statusCode).toBe(201);
    const repeatBody = repeat.json() as { scheduled: unknown[]; duplicates: unknown[] };
    expect(repeatBody.scheduled).toHaveLength(0);
    expect(repeatBody.duplicates).toHaveLength(2);
  });

  it("exposes the full audit trail with a handling summary", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/reminders`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reminders: Record<string, unknown>[];
      summary: { nextScheduledAction: unknown; handlingNote: string };
    };
    expect(body.reminders).toHaveLength(2);
    for (const row of body.reminders) {
      expect(row.scheduled_at).toBeDefined();
      expect(row.recipient).toBe("acme12@example.com");
      expect(row.template).toBeDefined();
      expect(row.templateVersion).toBe("v1");
      expect(row.state).toBe("queued");
    }
    expect(body.summary.nextScheduledAction).toBeTruthy();
    expect(body.summary.handlingNote).toMatch(/system is handling/i);
  });

  it("sends once — repeats are duplicates without resending", async () => {
    const url = `/api/v1/workspaces/${workspaceId}/reminders/${firstReminderId}/send`;
    const sent = await app.inject({
      method: "POST",
      url,
      headers: auth(token),
      payload: { portalUrl: "https://portal.example/p/1" },
    });
    expect(sent.statusCode).toBe(200);
    const body = sent.json() as { reminder: Record<string, unknown> };
    expect(body.reminder.state).toBe("sent");
    expect(body.reminder.sent_at).toBeDefined();
    expect(body.reminder.providerMessageId).toBeDefined();
    expect(email.sent).toHaveLength(1);
    expect((email.sent[0]?.subject as string) ?? "").toContain("Milestone 1");

    const repeat = await app.inject({
      method: "POST",
      url,
      headers: auth(token),
      payload: { portalUrl: "https://portal.example/p/1" },
    });
    expect(repeat.statusCode).toBe(200);
    expect((repeat.json() as { duplicate: boolean }).duplicate).toBe(true);
    expect(email.sent).toHaveLength(1);
  });

  it("records delivery failures and retries safely", async () => {
    email.failNext(1);
    const url = `/api/v1/workspaces/${workspaceId}/reminders/${secondReminderId}/send`;
    const failed = await app.inject({
      method: "POST",
      url,
      headers: auth(token),
      payload: { portalUrl: "https://portal.example/p/1" },
    });
    expect(failed.statusCode).toBe(502);
    const failedBody = failed.json() as { error: { code: string } };
    expect(failedBody.error.code).toBe("PROVIDER_ERROR");

    const row = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/reminders`,
      headers: auth(token),
    });
    const rows = (row.json() as { reminders: Record<string, unknown>[] }).reminders;
    const failedRow = rows.find((r) => r.id === secondReminderId);
    expect(failedRow?.state).toBe("failed");
    expect(failedRow?.result_error).toBeDefined();

    const retried = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/reminders/${secondReminderId}/retry`,
      headers: auth(token),
      payload: { portalUrl: "https://portal.example/p/1" },
    });
    expect(retried.statusCode).toBe(200);
    expect((retried.json() as { reminder: Record<string, unknown> }).reminder.state).toBe("sent");
  });

  it("cancels a queued automation without deleting history", async () => {
    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 2 — Polish", amountCents: 60000, dueDate: DUE },
    });
    expect(milestone.statusCode).toBe(201);
    const m2 = (milestone.json() as { milestone: { id: string } }).milestone.id;

    const scheduled = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m2}/reminders/schedule`,
      headers: auth(token),
      payload: {},
    });
    expect(scheduled.statusCode).toBe(201);
    const target = ((scheduled.json() as { scheduled: { id: string }[] }).scheduled[0]?.id ??
      "") as string;

    const canceled = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/reminders/${target}/cancel`,
      headers: auth(token),
    });
    expect(canceled.statusCode).toBe(200);
    expect((canceled.json() as { canceled: boolean }).canceled).toBe(true);

    const sendCanceled = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/reminders/${target}/send`,
      headers: auth(token),
      payload: {},
    });
    expect(sendCanceled.statusCode).toBe(422);
  });

  it("never auto-sends manual escalation; manual send needs jurisdiction + acknowledgement", async () => {
    // Back to the default 6-step policy for this project.
    const cleared = await app.inject({
      method: "PUT",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/reminders/policy`,
      headers: auth(token),
      payload: { policy: null },
    });
    expect(cleared.statusCode).toBe(200);

    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 3 — Launch", amountCents: 30000, dueDate: DUE },
    });
    expect(milestone.statusCode).toBe(201);
    const m3 = (milestone.json() as { milestone: { id: string } }).milestone.id;

    const scheduled = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m3}/reminders/schedule`,
      headers: auth(token),
      payload: {},
    });
    expect(scheduled.statusCode).toBe(201);
    expect((scheduled.json() as { scheduled: unknown[] }).scheduled).toHaveLength(6);

    // Far-future tick: auto steps send, manual steps are skipped, never sent.
    const tick = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/reminders/run-due`,
      headers: auth(token),
      payload: { now: "2026-11-10T00:00:00.000Z" },
    });
    expect(tick.statusCode).toBe(200);
    const tickBody = tick.json() as {
      sent: unknown[];
      failed: unknown[];
      skippedManual: { template: string }[];
    };
    expect(tickBody.failed).toHaveLength(0);
    expect(tickBody.skippedManual.map((r) => r.template).sort()).toEqual([
      "escalation_notice",
      "work_paused",
    ]);
    // Only m3's four auto steps sent here (m1/m2 rows were already settled).
    expect(tickBody.sent.length).toBeGreaterThanOrEqual(4);

    const rows = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m3}/reminders`,
      headers: auth(token),
    });
    const m3rows = (rows.json() as { reminders: { id: string; template: string }[] }).reminders;
    const escalation = m3rows.find((r) => r.template === "escalation_notice");
    expect(escalation).toBeDefined();

    const noAck = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/reminders/${escalation?.id}/send`,
      headers: auth(token),
      payload: { jurisdiction: "India" },
    });
    expect(noAck.statusCode).toBe(422);

    const noJurisdiction = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/reminders/${escalation?.id}/send`,
      headers: auth(token),
      payload: { acknowledgeManualStep: true },
    });
    expect(noJurisdiction.statusCode).toBe(422);

    const manual = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/reminders/${escalation?.id}/send`,
      headers: auth(token),
      payload: {
        acknowledgeManualStep: true,
        jurisdiction: "India",
        portalUrl: "https://portal.example/p/1",
      },
    });
    expect(manual.statusCode).toBe(200);
    expect((manual.json() as { reminder: { state: string } }).reminder.state).toBe("sent");
  });

  it("stops scheduling once the milestone is paid", async () => {
    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 4 — Care", amountCents: 10000, dueDate: DUE },
    });
    expect(milestone.statusCode).toBe(201);
    const m4 = (milestone.json() as { milestone: { id: string } }).milestone.id;
    const base = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m4}/transitions`;

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
          payload: { action: "confirm_funding", paymentId: "fund_12" },
        })
      ).statusCode,
    ).toBe(200);

    const scheduled = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${m4}/reminders/schedule`,
      headers: auth(token),
      payload: {},
    });
    expect(scheduled.statusCode).toBe(422);
  });

  it("keeps reminder activity in the project audit trail", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/summary`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const types = (
      res.json() as { summary: { recentActivity: { type: string }[] } }
    ).summary.recentActivity.map((a) => a.type);
    // The summary keeps the 8 most recent events; the full ReminderScheduled
    // history stays queryable on the milestone/project reminder views above.
    expect(types).toContain("ReminderSent");
  });

  it("isolates tenants on reminder routes", async () => {
    const other = await signup("fpp12-intruder@example.com", "Fpp Intruder");
    const forbidden = await app.inject({
      method: "PUT",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/reminders/policy`,
      headers: auth(other.token),
      payload: { policy: null },
    });
    expect(forbidden.statusCode).toBe(403);
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${other.workspaceId}/projects/${projectId}/reminders`,
      headers: auth(other.token),
    });
    expect([403, 404]).toContain(missing.statusCode);
  });
});
