import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 15: evidence pack export.
 * - Generates a factual pack covering parties/project/agreement/milestones/
 *   payments/deliverables/approvals/revisions/reminders/plans/timeline.
 * - Pins a sha256 + agreement hashes + event count; detail reports drift.
 * - Emits EvidencePackGenerated into the timeline; tenant-isolated UI pages.
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

describe("evidence pack export", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  let packId = "";
  let packSha = "";

  it("builds a rich overdue project: agreement, deliverable, approval, revision, claim, reminders, plan", async () => {
    ({ token, workspaceId } = await signup("fpp15-owner@example.com", "Fpp Fifteen"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme15@example.com", company: "Acme Inc" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: {
        clientId,
        title: "Disputed brand site",
        currency: "USD",
        totalValueCents: 400000,
        paymentTerms: "Milestone 1 on approval, balance on delivery",
      },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: {
        title: "Milestone 1 — Discovery",
        amountCents: 240000,
        dueDate: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(milestone.statusCode).toBe(201);
    milestoneId = (milestone.json() as { milestone: { id: string } }).milestone.id;

    const agreement = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements`,
      headers: auth(token),
      payload: validTerms(),
    });
    expect(agreement.statusCode).toBe(201);
    const agreementId = (agreement.json() as { agreement: { id: string } }).agreement.id;
    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${agreementId}/send`,
      headers: auth(token),
    });
    expect(sent.statusCode).toBe(200);
    const accepted = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/agreements/${agreementId}/accept`,
      headers: auth(token),
      payload: { acceptedBy: "Alex Client" },
    });
    expect(accepted.statusCode).toBe(200);

    const funding = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/transitions`,
      headers: auth(token),
      payload: { action: "request_funding" },
    });
    expect(funding.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/deliverables`,
      headers: auth(token),
      payload: { title: "Discovery deck" },
    });
    expect(created.statusCode).toBe(201);
    const deliverableId = (created.json() as { deliverable: { id: string } }).deliverable.id;

    const version = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/versions`,
      headers: auth(token),
      payload: {
        description: "First cut.",
        files: [
          {
            filename: "preview.png",
            contentType: "image/png",
            sizeBytes: 1024,
            visibility: "review",
          },
        ],
      },
    });
    expect(version.statusCode).toBe(201);

    for (const action of ["submit", "share-preview", "mark-review"] as const) {
      const walked = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/${action}`,
        headers: auth(token),
      });
      expect(walked.statusCode).toBe(200);
    }

    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    const portalToken = (issued.json() as { token: string }).token;

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/approve`,
      payload: { token: portalToken, versionNo: 1 },
    });
    expect(approved.statusCode).toBe(200);

    const revised = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/revision`,
      payload: { token: portalToken, versionNo: 1, note: "Please adjust the hero spacing" },
    });
    expect(revised.statusCode).toBe(200);

    const claimed = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/claim`,
      headers: auth(token),
      payload: {},
    });
    expect([200, 201, 422]).toContain(claimed.statusCode);

    const scheduled = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/reminders/schedule`,
      headers: auth(token),
      payload: {},
    });
    expect([201, 422]).toContain(scheduled.statusCode);

    const plan = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/payment-plans`,
      headers: auth(token),
      payload: {
        installments: [
          { amountCents: 120000, dueDate: "2026-10-01T00:00:00.000Z" },
          { amountCents: 120000, dueDate: "2026-11-01T00:00:00.000Z" },
        ],
      },
    });
    expect(plan.statusCode).toBe(201);
  });

  it("generates a factual pack covering every required section", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/evidence-packs`,
      headers: auth(token),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as {
      pack: {
        id: string;
        sha256: string;
        agreementVersionHashes: string[];
        eventSeqTo: number;
        artifactRef: string;
      };
      snapshot: {
        parties: { clientName: string; clientEmail: string };
        project: { title: string; paymentTerms: string };
        agreement: { currentVersion: number; versions: { hash: string }[] };
        milestones: { title: string }[];
        financialSummary: { verifiedPaidCents: number; outstandingCents: number };
        payments: { verified: boolean }[];
        deliverables: { title: string }[];
        approvals: { statement: string }[];
        revisions: { statement: string }[];
        reminders: unknown[];
        paymentPlans: { state: string }[];
        timeline: { type: string; headline: string }[];
        disclaimer: string;
        noGuarantee: string;
      };
      snapshotSha256: string;
      disclaimer: string;
      noGuarantee: string;
    };
    packId = body.pack.id;
    packSha = body.pack.sha256;
    expect(body.pack.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.snapshotSha256).toBe(body.pack.sha256);
    expect(body.pack.agreementVersionHashes).toHaveLength(1);
    expect(body.pack.eventSeqTo).toBeGreaterThan(5);

    expect(body.snapshot.parties.clientName).toBe("Acme");
    expect(body.snapshot.project.title).toBe("Disputed brand site");
    expect(body.snapshot.project.paymentTerms).toContain("Milestone 1");
    expect(body.snapshot.agreement.currentVersion).toBe(1);
    expect(body.snapshot.milestones.map((m) => m.title)).toContain("Milestone 1 — Discovery");
    // Claim-only money is never counted as paid.
    expect(body.snapshot.financialSummary.verifiedPaidCents).toBe(0);
    expect(body.snapshot.financialSummary.outstandingCents).toBe(240000);
    for (const p of body.snapshot.payments) expect(p.verified).toBe(false);
    expect(body.snapshot.deliverables.map((d) => d.title)).toContain("Discovery deck");
    expect(body.snapshot.approvals.length).toBeGreaterThanOrEqual(1);
    expect(body.snapshot.approvals[0]?.statement).toMatch(
      /^On \d{4}-\d{2}-\d{2}, the client approved/,
    );
    expect(body.snapshot.revisions.length).toBeGreaterThanOrEqual(1);
    expect(body.snapshot.paymentPlans.map((p) => p.state)).toContain("offered");
    const types = body.snapshot.timeline.map((e) => e.type);
    expect(types[0]).toBe("ProjectCreated");
    expect(types).toContain("AgreementAccepted");
    expect(types).toContain("MilestoneApproved");
    expect(types).toContain("RevisionRequested");

    // Factual throughout: no legal conclusions, no outcome promises.
    expect(body.disclaimer).toMatch(/Not legal advice/);
    expect(body.noGuarantee).toMatch(/does not predict or guarantee/);
    expect(body.snapshot.disclaimer).toMatch(/Not legal advice/);
    const raw = JSON.stringify(body.snapshot).toLowerCase();
    for (const banned of ["fraud", "guilty", "liable", "guarantee success", "see you in court"]) {
      expect(raw).not.toContain(banned);
    }
  });

  it("lists packs and shows a matching generation on detail", async () => {
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/evidence-packs`,
      headers: auth(token),
    });
    expect(listed.statusCode).toBe(200);
    const packs = (listed.json() as { packs: { id: string }[] }).packs;
    expect(packs.map((p) => p.id)).toContain(packId);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/evidence-packs/${packId}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      pack: { sha256: string };
      consistency: { matchesGeneration: boolean; reasons: string[] };
    };
    expect(body.pack.sha256).toBe(packSha);
    // The pack's own generation event is excluded from the comparison, so a
    // fresh read matches its pins exactly.
    expect(body.consistency.matchesGeneration).toBe(true);
    expect(body.consistency.reasons).toEqual([]);
  });

  it("reports later project activity as factual drift, not an error", async () => {
    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/pause`,
      headers: auth(token),
      payload: { reason: "Waiting on the overdue balance" },
    });
    expect(paused.statusCode).toBe(200);

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/evidence-packs/${packId}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      consistency: { matchesGeneration: boolean; reasons: string[] };
    };
    expect(body.consistency.matchesGeneration).toBe(false);
    expect(body.consistency.reasons.join(" ")).toMatch(/new project event/);
  });

  it("serves a clean printable export for records and review", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/evidence-packs/${packId}?format=html`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Disputed brand site");
    expect(res.body).toContain("Not legal advice");
    expect(res.body).toContain("Save as PDF");
    expect(res.body).toContain(packSha.slice(0, 16));
    expect(res.body.toLowerCase()).not.toContain("fraud");
  });

  it("records the generation in the project timeline", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/timeline?types=EvidencePackGenerated`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { events: { type: string }[] }).events.map((e) => e.type)).toContain(
      "EvidencePackGenerated",
    );
  });

  it("renders the evidence pages as calm HTML", async () => {
    const list = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/evidence?workspaceId=${workspaceId}`,
      headers: auth(token),
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).toContain("Evidence pack");
    expect(list.body).toContain("Generate evidence pack");

    const detail = await app.inject({
      method: "GET",
      url: `/app/projects/${projectId}/evidence/${packId}?workspaceId=${workspaceId}`,
      headers: auth(token),
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).toContain("Canonical sha256");
    expect(detail.body).toContain("Save as PDF");
  });

  it("isolates tenants and requires auth", async () => {
    const other = await signup("fpp15-intruder@example.com", "Fpp Intruder");
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/evidence-packs`,
      headers: auth(other.token),
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${other.workspaceId}/projects/${projectId}/evidence-packs`,
      headers: auth(other.token),
    });
    expect([403, 404]).toContain(missing.statusCode);

    const anon = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/evidence-packs`,
    });
    expect(anon.statusCode).toBe(401);
  });
});
