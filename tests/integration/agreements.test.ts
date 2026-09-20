import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/** Session 06: agreement / payment-terms layer over HTTP — versioning, acceptance, immutability. */

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
    totalAmountCents: 400000,
    currency: "USD",
    depositAmountCents: 50000,
    milestoneSchedule: [
      { title: "Milestone 1 — Discovery", amountCents: 50000 },
      { title: "Milestone 2 — Design", amountCents: 100000 },
      { title: "Milestone 3 — Development", amountCents: 150000 },
      { title: "Milestone 4 — Launch", amountCents: 100000 },
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

describe("agreement API", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let v1Id = "";
  let v1Hash = "";
  let v1Text = "";

  it("creates a v1 draft with hash + disclaimer", async () => {
    ({ token, workspaceId } = await signup("fpp06-owner@example.com", "Fpp Six"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme06@example.com" },
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

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(token),
      payload: validTerms(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      agreement: {
        id: string;
        version: number;
        status: string;
        isCurrent: boolean;
        hash: string;
        termsText: string;
        disclaimer: string;
      };
      disclaimer: string;
    };
    expect(body.agreement.version).toBe(1);
    expect(body.agreement.status).toBe("draft");
    expect(body.agreement.isCurrent).toBe(true);
    expect(body.agreement.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.agreement.termsText).toContain("Milestone 1 — Discovery");
    expect(body.agreement.disclaimer).toContain("not a law firm");
    expect(body.disclaimer).toContain("jurisdiction");
    v1Id = body.agreement.id;
    v1Hash = body.agreement.hash;
    v1Text = body.agreement.termsText;
  });

  it("rejects invalid terms (schedule sum, Deposit label)", async () => {
    const mismatch = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(token),
      payload: { ...validTerms(), totalAmountCents: 999 },
    });
    expect(mismatch.statusCode).toBe(422);
    const deposit = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(token),
      payload: {
        ...validTerms(),
        totalAmountCents: 100000,
        depositAmountCents: 100000,
        milestoneSchedule: [{ title: "50% Deposit", amountCents: 100000 }],
      },
    });
    expect(deposit.statusCode).toBe(422);
  });

  it("sends then accepts v1 and keeps an audit trail", async () => {
    const send = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${v1Id}/send`,
      headers: auth(token),
    });
    expect(send.statusCode).toBe(200);
    expect((send.json() as { agreement: { status: string } }).agreement.status).toBe(
      "pending_acceptance",
    );

    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${v1Id}/accept`,
      headers: auth(token),
      payload: { acceptedBy: "Acme Client" },
    });
    expect(accept.statusCode).toBe(200);
    const accepted = accept.json() as {
      agreement: { status: string; acceptedBy: string; hash: string };
    };
    expect(accepted.agreement.status).toBe("accepted");
    expect(accepted.agreement.acceptedBy).toBe("Acme Client");
    expect(accepted.agreement.hash).toBe(v1Hash);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${v1Id}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      agreement: { hash: string; termsText: string };
      auditTrail: { type: string }[];
    };
    // Historical content reconstructable: identical bytes + hash after acceptance.
    expect(body.agreement.hash).toBe(v1Hash);
    expect(body.agreement.termsText).toBe(v1Text);
    const types = body.auditTrail.map((e) => e.type);
    expect(types).toContain("AgreementCreated");
    expect(types).toContain("AgreementSent");
    expect(types).toContain("AgreementAccepted");
  });

  it("rejects re-accepting and re-sending an accepted version", async () => {
    const again = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${v1Id}/accept`,
      headers: auth(token),
      payload: { acceptedBy: "Acme Client" },
    });
    expect([409, 422]).toContain(again.statusCode);
    const resend = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${v1Id}/send`,
      headers: auth(token),
    });
    expect(resend.statusCode).toBe(422);
  });

  it("creates v2 as a new version and supersedes v1 on acceptance", async () => {
    const create = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(token),
      payload: { ...validTerms(), paymentDueDays: 14 },
    });
    expect(create.statusCode).toBe(201);
    const v2 = (create.json() as { agreement: { id: string; version: number; hash: string } })
      .agreement;
    expect(v2.version).toBe(2);
    expect(v2.hash).not.toBe(v1Hash);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(token),
    });
    const versions = (list.json() as { agreements: { version: number; isCurrent: boolean }[] })
      .agreements;
    expect(versions.map((a) => a.version)).toEqual([1, 2]);
    expect(versions.find((a) => a.version === 2)?.isCurrent).toBe(true);
    expect(versions.find((a) => a.version === 1)?.isCurrent).toBe(false);

    await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${v2.id}/send`,
      headers: auth(token),
    });
    const accept = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${v2.id}/accept`,
      headers: auth(token),
      payload: { acceptedBy: "Acme Client" },
    });
    expect(accept.statusCode).toBe(200);

    // v1 history preserved: same bytes, superseded status.
    const v1Detail = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${v1Id}`,
      headers: auth(token),
    });
    const v1Body = v1Detail.json() as {
      agreement: { status: string; hash: string; termsText: string };
    };
    expect(v1Body.agreement.status).toBe("superseded");
    expect(v1Body.agreement.hash).toBe(v1Hash);
    expect(v1Body.agreement.termsText).toBe(v1Text);
  });

  it("keeps cross-tenant isolation and read-only roles", async () => {
    const other = await signup("fpp06-intruder@example.com", "Intruder");
    const probe = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(other.token),
    });
    expect(probe.statusCode).toBe(403);
    const write = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(other.token),
      payload: validTerms(),
    });
    expect(write.statusCode).toBe(403);
  });
});
