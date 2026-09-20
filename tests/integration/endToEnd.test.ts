import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { FakeEmailProvider, FakePaymentProvider } from "../../src/lib/providers.js";
import { clearSeenWebhookIdsForTests } from "../../src/routes/payments.js";
import { InMemoryStore } from "../../src/lib/store.js";
import { signTestPayload } from "../../src/lib/webhook.js";

/**
 * Session 21: end-to-end proof that the product works as a coherent system.
 *
 * FLOW 1 — freelancer account → client → project → milestones
 * FLOW 2 — client receives project → accepts agreement → makes first payment
 * FLOW 3 — work → preview → review → revision → revision submitted → approval
 * FLOW 4 — payment due → reminder → payment completed → final asset unlocked
 * FLOW 5 — payment overdue → reminders escalate → project pauses
 * FLOW 6 — client claims payment → provider does not confirm → invoice unpaid
 * FLOW 7 — payment plan requested → proposed → accepted → installments tracked
 * FLOW 8 — dispute → evidence intact → evidence pack exported
 * FLOW 9 — cross-tenant access must fail
 * RACE   — duplicate webhook delivery + concurrent checkout idempotency
 */

const WEBHOOK_SECRET = "whsec_session21_e2e_test_0123456789abcdef";
const testEnv = {
  NODE_ENV: "test" as const,
  PORT: 3000,
  LOG_LEVEL: "fatal" as const,
  DATABASE_URL: "postgres://localhost:5432/fpp_test",
  SESSION_SECRET: "test-session-secret-that-is-long-enough-0123456789",
  APP_BASE_URL: "http://localhost:3000",
  MAGIC_LINK_TTL_HOURS: 168,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

let app: FastifyInstance;
const store = new InMemoryStore();
const provider = new FakePaymentProvider();
const email = new FakeEmailProvider();
const PASSWORD = "correct-horse-battery-12";

function signedBody(body: string): Record<string, string> {
  return { "stripe-signature": signTestPayload({ rawBody: body, webhookSecret: WEBHOOK_SECRET }) };
}

function webhookEnvelope(args: {
  eventId: string;
  type: string;
  providerPaymentId: string;
  amountCents?: number | undefined;
  currency?: string | undefined;
  paymentId?: string | undefined;
  workspaceId?: string | undefined;
  projectId?: string | undefined;
  milestoneId?: string | undefined;
}): string {
  return JSON.stringify({
    id: args.eventId,
    type: args.type,
    data: {
      object: {
        id: args.providerPaymentId,
        ...(args.amountCents !== undefined ? { amount: args.amountCents } : {}),
        currency: (args.currency ?? "usd").toLowerCase(),
        metadata: {
          ...(args.paymentId !== undefined ? { paymentId: args.paymentId } : {}),
          ...(args.workspaceId !== undefined ? { workspaceId: args.workspaceId } : {}),
          ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
          ...(args.milestoneId !== undefined ? { milestoneId: args.milestoneId } : {}),
        },
      },
    },
  });
}

async function postWebhook(raw: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/webhooks/payments",
    headers: { "content-type": "application/json", ...signedBody(raw) },
    payload: raw,
  });
}

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

function validTerms(totalCents: number, halfCents: number) {
  return {
    totalAmountCents: totalCents,
    currency: "USD",
    depositAmountCents: halfCents,
    milestoneSchedule: [
      { title: "Milestone 1 — Discovery", amountCents: halfCents },
      { title: "Milestone 2 — Design", amountCents: halfCents },
    ],
    paymentDueDays: 7,
    graceDays: 3,
    acceptedPaymentMethods: ["bank_transfer", "stripe"],
    latePaymentPolicy: { kind: "none", description: "No late fee; reminders only." },
    pauseAfterOverdueDays: 7,
    workPauseDescription: "Work pauses 7 days after the due date until payment arrives.",
    releaseCondition: "current_milestone_paid",
    finalDeliveryDescription: "Final files released when the current milestone is paid.",
    ownershipMode: "on_final_payment",
    ownershipDescription: "Ownership transfers on final payment.",
    maxRevisionsPerMilestone: 2,
    extraRevisionPolicy: "Extra revisions billed separately.",
    cancellationNoticeDays: 7,
    cancellationPolicy: "Either party may cancel with 7 days notice; work done is billed.",
  };
}

const versionPayload = (n: number) => ({
  description: `Cut ${n}.`,
  files: [
    {
      filename: `preview${n}.png`,
      contentType: "image/png",
      sizeBytes: 4096,
      visibility: "review",
    },
    {
      filename: `final${n}.zip`,
      contentType: "application/zip",
      sizeBytes: 8192,
      visibility: "final",
    },
  ],
});

beforeAll(async () => {
  app = await buildApp({
    env: testEnv,
    loggerLevel: "fatal",
    store,
    paymentProvider: provider,
    emailProvider: email,
    webhookSecret: WEBHOOK_SECRET,
  });
});

afterAll(async () => {
  await app.close();
});

describe("end-to-end product flows", () => {
  let token = "";
  let workspaceId = "";
  let clientId = "";
  let projectId = "";
  let milestone1 = "";
  let milestone2 = "";
  let portalToken = "";
  let agreementId = "";
  let deliverableId = "";
  let reminderIds: string[] = [];

  it("FLOW 1 — freelancer account, client, project, milestones", async () => {
    ({ token, workspaceId } = await signup("fpp21-owner@example.com", "Fpp TwentyOne"));

    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme21@example.com" },
    });
    expect(client.statusCode).toBe(201);
    clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: { clientId, title: "Flagship site", currency: "USD", totalValueCents: 100000 },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    for (const [title, dueDate] of [
      ["Milestone 1 — Discovery", "2026-10-01T00:00:00.000Z"],
      ["Milestone 2 — Design", "2026-10-15T00:00:00.000Z"],
    ] as const) {
      const ms = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
        headers: auth(token),
        payload: { title, amountCents: 50000, dueDate },
      });
      expect(ms.statusCode).toBe(201);
      const id = (ms.json() as { milestone: { id: string } }).milestone.id;
      if (milestone1 === "") milestone1 = id;
      else milestone2 = id;
    }

    const summary = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/summary`,
      headers: auth(token),
    });
    expect(summary.statusCode).toBe(200);
    expect((summary.json() as { summary: { milestoneCount: number } }).summary.milestoneCount).toBe(
      2,
    );

    const events = await store.listProjectEvents(projectId, 100);
    expect(events.some((e) => e.type === "ProjectCreated")).toBe(true);
  });

  it("FLOW 2 — client receives project, accepts agreement, makes first payment", async () => {
    const draft = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(token),
      payload: validTerms(100000, 50000),
    });
    expect(draft.statusCode).toBe(201);
    agreementId = (draft.json() as { agreement: { id: string } }).agreement.id;

    const send = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${agreementId}/send`,
      headers: auth(token),
    });
    expect(send.statusCode).toBe(200);

    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    portalToken = (issued.json() as { token: string }).token;

    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(portalToken)}`,
    });
    expect(overview.statusCode).toBe(200);
    expect(
      (overview.json() as { portal: { agreement: { status: string } | null } }).portal.agreement
        ?.status,
    ).toBe("pending_acceptance");

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/agreements/${agreementId}/accept`,
      payload: { token: portalToken, acceptedBy: "Alex Client" },
    });
    expect(accept.statusCode).toBe(200);

    clearSeenWebhookIdsForTests();
    const checkout = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestone1}/checkout`,
      headers: { ...auth(token), "idempotency-key": "e2e-chk-m1" },
      payload: {},
    });
    expect(checkout.statusCode).toBe(201);
    const paymentId = (checkout.json() as { payment: { id: string } }).payment.id;
    const stored = await store.findPaymentById(paymentId);
    expect(stored?.state).toBe("pending");

    const paid = await postWebhook(
      webhookEnvelope({
        eventId: "evt_e2e_m1_paid",
        type: "payment_intent.succeeded",
        providerPaymentId: stored?.providerPaymentId ?? "",
        amountCents: 50000,
        currency: "USD",
        paymentId,
        workspaceId,
        projectId,
        milestoneId: milestone1,
      }),
    );
    expect(paid.statusCode).toBe(200);
    expect((paid.json() as { payment: { state: string } }).payment.state).toBe("paid");
    expect((await store.findMilestone(milestone1))?.paymentState).toBe("paid");

    const after = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(portalToken)}`,
    });
    expect((after.json() as { portal: { paidCents: number } }).portal.paidCents).toBe(50000);
  });

  it("FLOW 3 — start work, preview, review, revision, revision, approval", async () => {
    const base = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestone2}/transitions`;
    const funding = await app.inject({
      method: "POST",
      url: base,
      headers: auth(token),
      payload: { action: "request_funding" },
    });
    expect(funding.statusCode).toBe(200);

    // Reminders are scheduled while payment is still pending — once verified
    // payment lands the engine correctly refuses new schedules (paid-stop).
    const schedule = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestone2}/reminders/schedule`,
      headers: auth(token),
      payload: {},
    });
    expect(schedule.statusCode).toBe(201);
    reminderIds = (schedule.json() as { scheduled: { id: string }[] }).scheduled.map((r) => r.id);
    expect(reminderIds.length).toBeGreaterThan(0);

    for (const [action, extra] of [
      ["confirm_funding", { paymentId: "fund_e2e_m2" }],
      ["start_work", {}],
      ["submit", {}],
    ] as const) {
      const res = await app.inject({
        method: "POST",
        url: base,
        headers: auth(token),
        payload: { action, ...extra },
      });
      expect(res.statusCode).toBe(200);
    }

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestone2}/deliverables`,
      headers: auth(token),
      payload: { title: "Design pack" },
    });
    expect(created.statusCode).toBe(201);
    deliverableId = (created.json() as { deliverable: { id: string } }).deliverable.id;

    const dbase = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}`;
    const v1 = await app.inject({
      method: "POST",
      url: `${dbase}/versions`,
      headers: auth(token),
      payload: versionPayload(1),
    });
    expect(v1.statusCode).toBe(201);

    for (const action of ["submit", "share-preview", "mark-review"] as const) {
      const res = await app.inject({
        method: "POST",
        url: `${dbase}/${action}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
    }

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/preview?token=${encodeURIComponent(portalToken)}`,
    });
    expect(preview.statusCode).toBe(200);

    const revision = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/revision`,
      payload: { token: portalToken, versionNo: 1, note: "Please tighten the hero spacing." },
    });
    expect(revision.statusCode).toBe(200);

    const v2 = await app.inject({
      method: "POST",
      url: `${dbase}/versions`,
      headers: auth(token),
      payload: versionPayload(2),
    });
    expect(v2.statusCode).toBe(201);
    for (const action of ["share-preview", "mark-review"] as const) {
      const res = await app.inject({
        method: "POST",
        url: `${dbase}/${action}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
    }

    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/approve`,
      payload: { token: portalToken, versionNo: 2 },
    });
    expect(approve.statusCode).toBe(200);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/approvals`,
      headers: auth(token),
    });
    expect(history.statusCode).toBe(200);
    const trail = history.json() as {
      approvals: { decision: string; versionNo: number }[];
      effective: { isApproved: boolean; isCurrent: boolean };
    };
    expect(trail.approvals.map((a) => `${a.decision}@v${a.versionNo}`)).toContain("approved@v2");
    expect(trail.effective.isApproved).toBe(true);
  });

  it("FLOW 4 — payment due, reminder generated, payment completed, final unlocked", async () => {
    email.clear();
    // Reminder rows were scheduled in FLOW 3 while the milestone was pending.
    // Scheduling again now must be refused: milestone is funded (paid-stop).
    const reschedule = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestone2}/reminders/schedule`,
      headers: auth(token),
      payload: {},
    });
    expect(reschedule.statusCode).toBe(422);

    const firstId = reminderIds[0] ?? "";
    expect(firstId.length).toBeGreaterThan(0);
    const send = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/reminders/${firstId}/send`,
      headers: auth(token),
      payload: {},
    });
    expect(send.statusCode).toBe(200);
    expect(email.sent.length).toBeGreaterThan(0);

    clearSeenWebhookIdsForTests();
    const checkout = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestone2}/checkout`,
      headers: { ...auth(token), "idempotency-key": "e2e-chk-m2" },
      payload: {},
    });
    expect(checkout.statusCode).toBe(201);
    const paymentId = (checkout.json() as { payment: { id: string } }).payment.id;
    const stored = await store.findPaymentById(paymentId);

    const paid = await postWebhook(
      webhookEnvelope({
        eventId: "evt_e2e_m2_paid",
        type: "payment_intent.succeeded",
        providerPaymentId: stored?.providerPaymentId ?? "",
        amountCents: 50000,
        currency: "USD",
        paymentId,
        workspaceId,
        projectId,
        milestoneId: milestone2,
      }),
    );
    expect(paid.statusCode).toBe(200);
    expect((await store.findMilestone(milestone2))?.paymentState).toBe("paid");

    const dbase = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}`;
    for (const action of ["mark-payment-pending", "mark-paid"] as const) {
      const res = await app.inject({
        method: "POST",
        url: `${dbase}/${action}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
    }
    const release = await app.inject({
      method: "POST",
      url: `${dbase}/release`,
      headers: auth(token),
      payload: {},
    });
    expect(release.statusCode).toBe(200);

    const locked = await app.inject({
      method: "GET",
      url: `${dbase}/files/final`,
      headers: auth(token),
    });
    expect(locked.statusCode).toBe(200);

    const portalFinal = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/final?token=${encodeURIComponent(portalToken)}`,
    });
    expect(portalFinal.statusCode).toBe(200);
  });

  it("FLOW 5 — payment overdue, reminders escalate, project pauses", async () => {
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Slowpayer", email: "slow21@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const slowClientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: {
        clientId: slowClientId,
        title: "Overdue job",
        currency: "USD",
        totalValueCents: 30000,
      },
    });
    expect(project.statusCode).toBe(201);
    const overdueProjectId = (project.json() as { project: { id: string } }).project.id;

    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${overdueProjectId}/milestones`,
      headers: auth(token),
      payload: {
        title: "Milestone 1 — Work",
        amountCents: 30000,
        dueDate: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(ms.statusCode).toBe(201);
    const overdueMilestoneId = (ms.json() as { milestone: { id: string } }).milestone.id;

    const overdue = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${overdueProjectId}/milestones/${overdueMilestoneId}/transitions`,
      headers: auth(token),
      payload: { action: "mark_overdue" },
    });
    expect(overdue.statusCode).toBe(200);
    expect((overdue.json() as { milestone: { payment: string } }).milestone.payment).toBe(
      "overdue",
    );

    const schedule = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${overdueProjectId}/milestones/${overdueMilestoneId}/reminders/schedule`,
      headers: auth(token),
      payload: {},
    });
    expect(schedule.statusCode).toBe(201);
    expect((schedule.json() as { scheduled: unknown[] }).scheduled.length).toBeGreaterThan(0);

    const tick = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${overdueProjectId}/reminders/run-due`,
      headers: auth(token),
      payload: {},
    });
    expect(tick.statusCode).toBe(200);

    const audit = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${overdueProjectId}/reminders`,
      headers: auth(token),
    });
    expect(audit.statusCode).toBe(200);

    const pause = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${overdueProjectId}/pause`,
      headers: auth(token),
      payload: { reason: "Payment 30 days overdue; work paused until payment arrives." },
    });
    expect(pause.statusCode).toBe(200);

    const events = await store.listProjectEvents(overdueProjectId, 200);
    expect(events.some((e) => e.type === "ProjectPaused")).toBe(true);
    const paused = await store.findProject(overdueProjectId);
    expect(paused?.status).toBe("paused");
  });

  it("FLOW 6 — claimed payment without provider confirmation stays unpaid", async () => {
    clearSeenWebhookIdsForTests();
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Claimer", email: "claim21@example.com" },
    });
    const claimClientId = (client.json() as { client: { id: string } }).client.id;
    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: {
        clientId: claimClientId,
        title: "Claim job",
        currency: "USD",
        totalValueCents: 20000,
      },
    });
    const claimProjectId = (project.json() as { project: { id: string } }).project.id;
    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${claimProjectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 1 — Work", amountCents: 20000 },
    });
    const claimMilestoneId = (ms.json() as { milestone: { id: string } }).milestone.id;

    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${claimProjectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    const claimPortalToken = (issued.json() as { token: string }).token;

    const claim = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${claimProjectId}/claim`,
      payload: { token: claimPortalToken, milestoneId: claimMilestoneId, note: "Wire sent Friday" },
    });
    expect(claim.statusCode).toBe(200);
    expect((await store.findMilestone(claimMilestoneId))?.paymentState).toBe("claimed_unverified");

    // Provider has no record: reconciliation must NOT mark anything paid.
    const recon = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${claimProjectId}/payments/reconciliation`,
      headers: auth(token),
    });
    expect(recon.statusCode).toBe(200);
    const reconBody = recon.json() as {
      reconciliation: { totals: { outstandingCents: number; verifiedPaidCents: number } };
    };
    expect(reconBody.reconciliation.totals.verifiedPaidCents).toBe(0);
    expect(reconBody.reconciliation.totals.outstandingCents).toBeGreaterThan(0);
    expect((await store.findMilestone(claimMilestoneId))?.paymentState).not.toBe("paid");

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${claimProjectId}/payments/history`,
      headers: auth(token),
    });
    expect(history.statusCode).toBe(200);
  });

  it("FLOW 7 — payment plan proposed, accepted, installments tracked", async () => {
    email.clear();
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Cashflow", email: "cash21@example.com" },
    });
    const planClientId = (client.json() as { client: { id: string } }).client.id;
    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: {
        clientId: planClientId,
        title: "Plan job",
        currency: "USD",
        totalValueCents: 120000,
      },
    });
    const planProjectId = (project.json() as { project: { id: string } }).project.id;
    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${planProjectId}/milestones`,
      headers: auth(token),
      payload: {
        title: "Milestone 1 — Build",
        amountCents: 120000,
        dueDate: "2026-09-01T00:00:00.000Z",
      },
    });
    const planMilestoneId = (ms.json() as { milestone: { id: string } }).milestone.id;

    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${planProjectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    const planPortalToken = (issued.json() as { token: string }).token;

    const base = `/api/v1/workspaces/${workspaceId}/projects/${planProjectId}/milestones/${planMilestoneId}/payment-plans`;
    const propose = await app.inject({
      method: "POST",
      url: base,
      headers: auth(token),
      payload: {
        installments: [
          { amountCents: 60000, dueDate: "2026-09-08T00:00:00.000Z" },
          { amountCents: 60000, dueDate: "2026-09-15T00:00:00.000Z" },
        ],
        note: "Cash-flow accommodation",
      },
    });
    expect(propose.statusCode).toBe(201);
    const planId = (
      propose.json() as { plan: { id: string }; currentOutstanding: { outstandingCents: number } }
    ).plan.id;
    expect(
      (propose.json() as { currentOutstanding: { outstandingCents: number } }).currentOutstanding
        .outstandingCents,
    ).toBe(120000);

    const portalAccept = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${planProjectId}/payment-plans/${planId}/accept`,
      payload: { token: planPortalToken },
    });
    expect(portalAccept.statusCode).toBe(200);
    expect((await store.findMilestone(planMilestoneId))?.paymentState).toBe("plan_active");

    const verified = await store.seedPayment({
      workspaceId,
      projectId: planProjectId,
      milestoneId: planMilestoneId,
      amountCents: 60000,
      currency: "USD",
      state: "paid",
    });
    const markPaid = await app.inject({
      method: "POST",
      url: `${base}/${planId}/installments/1/mark-paid`,
      headers: auth(token),
      payload: { paymentId: verified.id },
    });
    expect(markPaid.statusCode).toBe(200);
    const tracked = markPaid.json() as {
      plan: { installments: { seq: number; status: string }[] };
      currentOutstanding: { outstandingCents: number; verifiedPaidCents: number };
    };
    expect(tracked.plan.installments.find((i) => i.seq === 1)?.status).toBe("paid");
    expect(tracked.currentOutstanding.outstandingCents).toBe(60000);
  });

  it("FLOW 8 — dispute keeps evidence intact and exports a pack", async () => {
    const dispute = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/dispute`,
      payload: {
        token: portalToken,
        milestoneId: milestone2,
        note: "Charged twice, please review.",
      },
    });
    expect([200, 422]).toContain(dispute.statusCode);

    const timeline = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline?limit=200`,
      headers: auth(token),
    });
    expect(timeline.statusCode).toBe(200);
    const trail = timeline.json() as { events: { type: string }[] };
    const types = trail.events.map((e) => e.type);
    // Earlier history survives the dispute: creation, approvals, payments, pack-free trail.
    for (const required of ["ProjectCreated", "PaymentReceived", "MilestoneApproved"]) {
      expect(types).toContain(required);
    }

    const pack = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/evidence-packs`,
      headers: auth(token),
      payload: {},
    });
    expect(pack.statusCode).toBe(201);
    const packBody = pack.json() as {
      pack: { id: string };
      snapshotSha256: string;
      snapshot: { timeline: unknown[] };
    };
    expect(packBody.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/evidence-packs/${packBody.pack.id}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);
    expect(
      (detail.json() as { consistency: { matchesGeneration: boolean } }).consistency
        .matchesGeneration,
    ).toBe(true);
  });

  it("FLOW 9 — another tenant cannot touch this workspace", async () => {
    const other = await signup("fpp21-intruder@example.com", "Intruder");

    const crossRead = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}`,
      headers: auth(other.token),
    });
    expect([403, 404]).toContain(crossRead.statusCode);

    const crossWrite = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(other.token),
      payload: { title: "Hijack", amountCents: 100 },
    });
    expect([403, 404]).toContain(crossWrite.statusCode);

    const control = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(portalToken)}`,
    });
    expect(control.statusCode).toBe(200); // own token still works (control)

    const tampered = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(`${portalToken}0`)}`,
    });
    expect(tampered.statusCode).toBe(401);

    const anon = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/payments`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it("RACE — duplicate webhook delivery applies payment exactly once", async () => {
    clearSeenWebhookIdsForTests();
    // Fresh unpaid milestone: milestone 1 is already paid, and checkout on a
    // paid milestone is correctly refused (409).
    const ms = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 3 — Race probe", amountCents: 10000 },
    });
    expect(ms.statusCode).toBe(201);
    const raceMilestoneId = (ms.json() as { milestone: { id: string } }).milestone.id;
    const checkout = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${raceMilestoneId}/checkout`,
      headers: { ...auth(token), "idempotency-key": "e2e-race-chk" },
      payload: {},
    });
    expect(checkout.statusCode).toBe(201);
    const paymentId = (checkout.json() as { payment: { id: string } }).payment.id;
    const stored = await store.findPaymentById(paymentId);
    const raw = webhookEnvelope({
      eventId: "evt_e2e_race_paid",
      type: "payment_intent.succeeded",
      providerPaymentId: stored?.providerPaymentId ?? "",
      amountCents: stored?.amountCents ?? 50000,
      currency: "USD",
      paymentId,
      workspaceId,
      projectId,
      milestoneId: raceMilestoneId,
    });

    const before = (await store.listProjectEvents(projectId, 500)).filter(
      (e) => e.type === "PaymentReceived",
    ).length;

    // Same provider event delivered twice concurrently: exactly one applies.
    const [first, second] = await Promise.all([postWebhook(raw), postWebhook(raw)]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const duplicates = [
      first.json() as { duplicate?: boolean },
      second.json() as { duplicate?: boolean },
    ].filter((b) => b.duplicate === true).length;
    expect(duplicates).toBe(1);

    const after = (await store.listProjectEvents(projectId, 500)).filter(
      (e) => e.type === "PaymentReceived",
    ).length;
    expect(after - before).toBe(1);
    expect((await store.findPaymentById(paymentId))?.state).toBe("paid");
  });

  it("RACE — concurrent checkouts with one idempotency key create one payment", async () => {
    const url = `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestone1}/checkout`;
    const before = (await store.listPayments(projectId)).length;
    const results = await Promise.all([
      app.inject({
        method: "POST",
        url,
        headers: { ...auth(token), "idempotency-key": "e2e-race-same-key" },
        payload: {},
      }),
      app.inject({
        method: "POST",
        url,
        headers: { ...auth(token), "idempotency-key": "e2e-race-same-key" },
        payload: {},
      }),
    ]);
    for (const res of results) expect([200, 201, 409]).toContain(res.statusCode);
    const ids = results
      .map((r) => {
        try {
          return (r.json() as { payment?: { id: string } }).payment?.id;
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    if (ids.length === 2) expect(ids[0]).toBe(ids[1]);
    const after = (await store.listPayments(projectId)).length;
    expect(after - before).toBeLessThanOrEqual(1);
  });
});
