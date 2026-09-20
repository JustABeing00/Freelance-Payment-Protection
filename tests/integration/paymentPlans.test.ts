import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { FakeEmailProvider } from "../../src/lib/providers.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 13: payment-plan support.
 * - Freelancer proposes a schedule covering the outstanding balance exactly.
 * - Client accepts via the magic-link portal (milestone → plan_active).
 * - run-due flags missed installments + sends automatic system-voiced
 *   reminders (idempotent per installment per day).
 * - Verified receipts settle installments; completion pays the milestone.
 * - Modified schedules are new versions — the original row stays intact.
 * - Every view shows original obligation + agreed modification + current
 *   outstanding + a timeline of what changed and when.
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

describe("payment plans for late payers", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  let planA = "";
  let planB = "";
  let portalToken = "";

  const base = (wid: string, pid: string, mid: string): string =>
    `/api/v1/workspaces/${wid}/projects/${pid}/milestones/${mid}/payment-plans`;

  it("sets up a $2,400 milestone with nothing paid", async () => {
    ({ token, workspaceId } = await signup("fpp13-owner@example.com", "Fpp Thirteen"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Cashflow Client", email: "cashflow13@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: {
        clientId,
        title: "Late invoice project",
        currency: "USD",
        totalValueCents: 240000,
      },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: {
        title: "Milestone 1 — Build",
        amountCents: 240000,
        dueDate: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(milestone.statusCode).toBe(201);
    milestoneId = (milestone.json() as { milestone: { id: string } }).milestone.id;
  });

  it("proposes 4 weekly payments of $600 against the $2,400 outstanding", async () => {
    const res = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId),
      headers: auth(token),
      payload: {
        installments: [8, 15, 22, 29].map((day) => ({
          amountCents: 60000,
          dueDate: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
        })),
        note: "Client cash-flow accommodation",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      plan: { id: string; state: string; version: number; installments: { seq: number }[] };
      originalObligation: { amountCents: number };
      agreedModification: { installments: unknown[] };
      currentOutstanding: { outstandingCents: number; verifiedPaidCents: number };
      timeline: { type: string }[];
      message: string;
    };
    planA = body.plan.id;
    expect(body.plan.state).toBe("offered");
    expect(body.plan.version).toBe(1);
    expect(body.plan.installments.map((i) => i.seq)).toEqual([1, 2, 3, 4]);
    expect(body.originalObligation.amountCents).toBe(240000);
    expect(body.agreedModification.installments).toHaveLength(4);
    expect(body.currentOutstanding).toMatchObject({
      outstandingCents: 240000,
      verifiedPaidCents: 0,
    });
    expect(body.timeline.map((t) => t.type)).toContain("PaymentPlanOffered");
  });

  it("rejects a schedule that does not cover the balance exactly", async () => {
    const res = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId),
      headers: auth(token),
      payload: {
        installments: [
          { amountCents: 100000, dueDate: "2026-09-08T00:00:00.000Z" },
          { amountCents: 70000, dueDate: "2026-10-01T00:00:00.000Z" },
        ],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it("client accepts the plan in the portal — milestone goes plan_active", async () => {
    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    portalToken = (issued.json() as { token: string }).token;

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/payment-plans?token=${encodeURIComponent(portalToken)}`,
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { plans: unknown[] }).plans.length).toBeGreaterThanOrEqual(1);

    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/payment-plans/${planA}/accept`,
      payload: { token: portalToken },
    });
    expect(accepted.statusCode).toBe(200);
    const body = accepted.json() as {
      plan: { state: string };
      timeline: { type: string; actorType: string }[];
      message: string;
    };
    expect(body.plan.state).toBe("active");
    expect(body.timeline.map((t) => t.type)).toContain("PaymentPlanAccepted");

    const milestone = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}`,
      headers: auth(token),
    });
    expect(milestone.statusCode).toBe(200);
    expect((milestone.json() as { milestone: { payment: string } }).milestone.payment).toBe(
      "plan_active",
    );
  });

  it("refuses a second live plan without agreeing a modified schedule", async () => {
    const res = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId),
      headers: auth(token),
      payload: {
        installments: [
          { amountCents: 100000, dueDate: "2026-09-08T00:00:00.000Z" },
          { amountCents: 70000, dueDate: "2026-10-01T00:00:00.000Z" },
          { amountCents: 70000, dueDate: "2026-11-01T00:00:00.000Z" },
        ],
      },
    });
    // Plan A is active now: a fresh proposal must name it via supersedesPlanId.
    expect(res.statusCode).toBe(409);
  });

  it("refuses a second acceptance of the same plan", async () => {
    const res = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId) + `/${planA}/accept`,
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });

  it("run-due flags missed installments and sends automatic reminders", async () => {
    email.clear();
    const res = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId) + `/${planA}/run-due`,
      headers: auth(token),
      payload: { now: "2026-12-01T00:00:00.000Z" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plan: { installments: { status: string }[]; summary: { missedCount: number } };
      missed: { seq: number }[];
      remindersSent: { seq: number }[];
      timeline: { type: string }[];
    };
    expect(body.missed.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    expect(body.plan.summary.missedCount).toBe(4);
    expect(body.remindersSent).toHaveLength(4);
    expect(email.sent).toHaveLength(4);
    const firstSent = email.sent[0];
    expect(firstSent?.subject).toContain("installment 1 of 4");
    const types = body.timeline.map((t) => t.type);
    expect(types).toContain("PaymentPlanInstallmentMissed");
    expect(types).toContain("PaymentPlanReminderSent");
  });

  it("run-due repeats are idempotent — no duplicate reminders", async () => {
    const before = email.sent.length;
    const res = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId) + `/${planA}/run-due`,
      headers: auth(token),
      payload: { now: "2026-12-01T00:00:00.000Z" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      missed: unknown[];
      remindersSent: unknown[];
      remindersSkipped: { duplicate: boolean }[];
    };
    expect(body.missed).toHaveLength(0);
    expect(body.remindersSent).toHaveLength(0);
    expect(body.remindersSkipped.length).toBeGreaterThan(0);
    expect(email.sent.length).toBe(before);
  });

  it("unverified payments never settle an installment", async () => {
    const checkout = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/checkout`,
      headers: auth(token),
      payload: {},
    });
    expect(checkout.statusCode).toBe(201);
    const paymentId = (checkout.json() as { payment: { id: string } }).payment.id;
    const res = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId) + `/${planA}/installments/1/mark-paid`,
      headers: auth(token),
      payload: { paymentId },
    });
    expect(res.statusCode).toBe(422);
  });

  it("a verified receipt settles the first installment", async () => {
    const seeded = await store.seedPayment({
      workspaceId,
      projectId,
      milestoneId,
      amountCents: 60000,
      currency: "USD",
      state: "paid",
    });
    const res = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId) + `/${planA}/installments/1/mark-paid`,
      headers: auth(token),
      payload: { paymentId: seeded.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      plan: { installments: { seq: number; status: string }[] };
      currentOutstanding: { outstandingCents: number; verifiedPaidCents: number };
      timeline: { type: string }[];
    };
    expect(body.plan.installments.find((i) => i.seq === 1)?.status).toBe("paid");
    expect(body.currentOutstanding).toMatchObject({
      outstandingCents: 180000,
      verifiedPaidCents: 60000,
    });
    expect(body.timeline.map((t) => t.type)).toContain("PaymentPlanInstallmentPaid");
  });

  it("agrees a modified schedule as a new version — the original is preserved", async () => {
    const res = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId),
      headers: auth(token),
      payload: {
        installments: [1, 2, 3].map((n) => ({
          amountCents: 60000,
          dueDate: `2027-0${n}-01T00:00:00.000Z`,
        })),
        supersedesPlanId: planA,
        note: " stretched after December miss",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { plan: { id: string; version: number; state: string } };
    planB = body.plan.id;
    expect(body.plan.version).toBe(2);
    expect(body.plan.state).toBe("offered");

    const oldDetail = await app.inject({
      method: "GET",
      url: base(workspaceId, projectId, milestoneId) + `/${planA}`,
      headers: auth(token),
    });
    expect(oldDetail.statusCode).toBe(200);
    const oldBody = oldDetail.json() as {
      plan: { state: string; installments: { status: string }[] };
      originalObligation: { amountCents: number };
      timeline: { type: string }[];
    };
    // Original debt snapshot untouched; open rows canceled, paid row kept.
    expect(oldBody.plan.state).toBe("superseded");
    expect(oldBody.originalObligation.amountCents).toBe(240000);
    expect(oldBody.plan.installments.map((i) => i.status)).toEqual([
      "paid",
      "canceled",
      "canceled",
      "canceled",
    ]);
    expect(oldBody.timeline.map((t) => t.type)).toEqual(
      expect.arrayContaining(["PaymentPlanOffered", "PaymentPlanAccepted", "PaymentPlanModified"]),
    );
  });

  it("accepts the modified plan and settles it to completion", async () => {
    const accepted = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId) + `/${planB}/accept`,
      headers: auth(token),
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);

    for (const seq of [1, 2, 3]) {
      const seeded = await store.seedPayment({
        workspaceId,
        projectId,
        milestoneId,
        amountCents: 60000,
        currency: "USD",
        state: "paid",
      });
      const res = await app.inject({
        method: "POST",
        url: base(workspaceId, projectId, milestoneId) + `/${planB}/installments/${seq}/mark-paid`,
        headers: auth(token),
        payload: { paymentId: seeded.id },
      });
      expect(res.statusCode).toBe(200);
      if (seq === 3) {
        const body = res.json() as {
          plan: { state: string };
          currentOutstanding: { outstandingCents: number };
          timeline: { type: string }[];
        };
        expect(body.plan.state).toBe("completed");
        expect(body.currentOutstanding.outstandingCents).toBe(0);
        expect(body.timeline.map((t) => t.type)).toContain("PaymentPlanCompleted");
      }
    }

    const milestone = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}`,
      headers: auth(token),
    });
    expect((milestone.json() as { milestone: { payment: string } }).milestone.payment).toBe("paid");
  });

  it("rejects defaulting a completed plan and re-paying a settled installment", async () => {
    const seeded = await store.seedPayment({
      workspaceId,
      projectId,
      milestoneId,
      amountCents: 60000,
      currency: "USD",
      state: "paid",
    });
    const repay = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId) + `/${planB}/installments/1/mark-paid`,
      headers: auth(token),
      payload: { paymentId: seeded.id },
    });
    expect(repay.statusCode).toBe(422);

    const def = await app.inject({
      method: "POST",
      url: base(workspaceId, projectId, milestoneId) + `/${planB}/default`,
      headers: auth(token),
      payload: { reason: "client stopped paying entirely" },
    });
    expect(def.statusCode).toBe(422);
  });

  it("keeps full plan history at the project level", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payment-plans`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    const plans = (res.json() as { plans: { plan: { version: number; state: string } }[] }).plans;
    const states = new Map(plans.map((p) => [p.plan.version, p.plan.state]));
    expect(states.get(1)).toBe("superseded");
    expect(states.get(2)).toBe("completed");
  });

  it("enforces tenant isolation and portal token integrity", async () => {
    const outsider = await signup("fpp13-outsider@example.com", "Fpp Outsider");
    const res = await app.inject({
      method: "GET",
      url: base(workspaceId, projectId, milestoneId) + `/${planB}`,
      headers: auth(outsider.token),
    });
    expect(res.statusCode).toBe(403);

    const tampered = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/payment-plans/${planB}/accept`,
      payload: { token: `${portalToken}x` },
    });
    expect(tampered.statusCode).toBe(401);
  });
});
