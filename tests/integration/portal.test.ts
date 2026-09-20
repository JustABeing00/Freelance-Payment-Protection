import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/** Session 07: client portal — invitation, safe overview, guarded actions. */

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

function validTerms() {
  return {
    totalAmountCents: 150000,
    currency: "USD",
    depositAmountCents: 50000,
    milestoneSchedule: [
      { title: "Milestone 1 — Discovery", amountCents: 50000 },
      { title: "Milestone 2 — Design", amountCents: 100000 },
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

async function signup(
  email: string,
  displayName: string,
): Promise<{ token: string; workspaceId: string; userId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/signup",
    payload: { email, displayName, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { token: string; workspace: { id: string }; user: { id: string } };
  return { token: body.token, workspaceId: body.workspace.id, userId: body.user.id };
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

describe("client portal", () => {
  let token = "";
  let workspaceId = "";
  let userId = "";
  let projectId = "";
  let milestone1 = "";
  let milestone2 = "";
  let portalToken = "";
  let agreementId = "";

  it("issues a portal link and answers the buyer questions safely", async () => {
    ({ token, workspaceId, userId } = await signup("fpp07-owner@example.com", "Fpp Seven"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: {
        name: "Acme",
        email: "acme07@example.com",
        company: "Acme Corp",
        phone: "+1-555-0100",
        billingEmail: "billing@acme.example",
        notes: "FREELANCER-ONLY prefers email",
      },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: { clientId, title: "Brand site", currency: "USD", totalValueCents: 150000 },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    const m1 = await store.seedMilestone({
      workspaceId,
      projectId,
      title: "Milestone 1 — Discovery",
      amountCents: 50000,
      workState: "submitted",
      paymentState: "unpaid",
      orderIndex: 0,
      approvalState: "pending",
      currentVersionId: "v1",
    });
    const m2 = await store.seedMilestone({
      workspaceId,
      projectId,
      title: "Milestone 2 — Design",
      amountCents: 100000,
      workState: "draft",
      paymentState: "unpaid",
      orderIndex: 1,
      unlockState: "locked",
    });
    milestone1 = m1.id;
    milestone2 = m2.id;

    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    const issuedBody = issued.json() as {
      token: string;
      portalUrl: string;
      portalLink: { id: string };
    };
    expect(issuedBody.token).toContain("v1.");
    expect(issuedBody.portalUrl).toContain(`/portal/${projectId}?token=`);
    portalToken = issuedBody.token;

    // Agreement draft + send so the portal has terms to show.
    const draft = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(token),
      payload: validTerms(),
    });
    expect(draft.statusCode).toBe(201);
    agreementId = (draft.json() as { agreement: { id: string } }).agreement.id;
    const send = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${agreementId}/send`,
      headers: auth(token),
    });
    expect(send.statusCode).toBe(200);

    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(portalToken)}`,
    });
    expect(overview.statusCode).toBe(200);
    const portal = (overview.json() as { portal: Record<string, unknown> }).portal as {
      projectTitle: string;
      totalCents: number;
      paidCents: number;
      focusHeadline: string;
      milestones: { title: string; lockReason?: string }[];
      agreement: { status: string } | null;
      nextSteps: string[];
      disclaimer: string;
    };
    expect(portal.projectTitle).toBe("Brand site");
    expect(portal.totalCents).toBe(150000);
    expect(portal.paidCents).toBe(0);
    expect(portal.focusHeadline).toContain("Milestone 1 — Discovery is ready for review");
    expect(portal.agreement?.status).toBe("pending_acceptance");
    expect(portal.nextSteps.join(" ")).toContain("Review");
    expect(portal.disclaimer).toContain("Not legal advice");
    const raw = overview.body;
    expect(raw).not.toContain("FREELANCER-ONLY");
    expect(raw).not.toContain("billing@acme.example");
    expect(raw).not.toContain("+1-555-0100");

    const page = await app.inject({
      method: "GET",
      url: `/portal/${projectId}?token=${encodeURIComponent(portalToken)}`,
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.body).toContain("Milestone 1 — Discovery is ready for review");
    expect(page.body).toContain("What is currently due");
    expect(page.body).not.toContain("FREELANCER-ONLY");
    expect(page.body).not.toContain("50% Deposit");
  });

  it("approves, requests revision, and records payment intent without marking paid", async () => {
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/approve`,
      payload: { token: portalToken, milestoneId: milestone1 },
    });
    expect(approve.statusCode).toBe(200);
    expect((approve.json() as { message: string }).message).toContain("is approved");

    // Approved milestone now asks for payment, not a second approval.
    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(portalToken)}`,
    });
    expect(
      (overview.json() as { portal: { focusHeadline: string } }).portal.focusHeadline,
    ).toContain("payment completes it");

    const pay = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/pay`,
      payload: { token: portalToken, milestoneId: milestone1 },
    });
    expect(pay.statusCode).toBe(200);
    expect((pay.json() as { amountCents: number }).amountCents).toBe(50000);

    // Client claim never marks paid: still outstanding.
    const after = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(portalToken)}`,
    });
    expect((after.json() as { portal: { paidCents: number } }).portal.paidCents).toBe(0);

    // Locked milestone cannot be paid ahead of sequence.
    const lockedPay = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/pay`,
      payload: { token: portalToken, milestoneId: milestone2 },
    });
    expect(lockedPay.statusCode).toBe(422);

    // Revision flow on a fresh submitted milestone.
    const m3 = await store.seedMilestone({
      workspaceId,
      projectId,
      title: "Milestone 3 — Copy",
      amountCents: 10000,
      workState: "submitted",
      paymentState: "unpaid",
      orderIndex: 2,
      approvalState: "pending",
      currentVersionId: "v3",
      unlockState: "available",
    });
    const rev = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/request-revision`,
      payload: { token: portalToken, milestoneId: m3.id, note: "Please use a warmer tone." },
    });
    expect(rev.statusCode).toBe(200);
    void userId;
  });

  it("accepts the agreement as the client and rejects forged ids", async () => {
    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/agreements/${agreementId}/accept`,
      payload: { token: portalToken, acceptedBy: "Acme Client" },
    });
    expect(accept.statusCode).toBe(200);
    expect((accept.json() as { message: string }).message).toContain("thank you");

    // Second project + milestone: portal token from project A cannot touch it.
    const other = await signup("fpp07-other@example.com", "Other");
    const oc = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${other.workspaceId}/clients`,
      headers: auth(other.token),
      payload: { name: "Other", email: "other07@example.com" },
    });
    const otherClientId = (oc.json() as { client: { id: string } }).client.id;
    const op = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${other.workspaceId}/projects`,
      headers: auth(other.token),
      payload: { clientId: otherClientId, title: "Other", currency: "USD", totalValueCents: 1000 },
    });
    const otherProjectId = (op.json() as { project: { id: string } }).project.id;
    const foreign = await store.seedMilestone({
      workspaceId: other.workspaceId,
      projectId: otherProjectId,
      title: "Foreign",
      amountCents: 1000,
      workState: "submitted",
      paymentState: "unpaid",
      orderIndex: 0,
      approvalState: "pending",
      currentVersionId: "vf",
    });
    const forged = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/approve`,
      payload: { token: portalToken, milestoneId: foreign.id },
    });
    expect(forged.statusCode).toBe(404);

    const tampered = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(`${portalToken}0`)}`,
    });
    expect(tampered.statusCode).toBe(401);

    // Freelancer cross-tenant issuance is denied.
    const probe = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(other.token),
      payload: {},
    });
    expect(probe.statusCode).toBe(403);
  });

  it("revokes links and rejects missing tokens", async () => {
    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: { ttlHours: 24 },
    });
    expect(issued.statusCode).toBe(201);
    const body = issued.json() as { token: string; portalLink: { id: string } };
    const revoke = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links/${body.portalLink.id}/revoke`,
      headers: auth(token),
    });
    expect(revoke.statusCode).toBe(200);
    const dead = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview?token=${encodeURIComponent(body.token)}`,
    });
    expect(dead.statusCode).toBe(401);
    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/overview`,
    });
    expect(missing.statusCode).toBe(422);
  });
});
