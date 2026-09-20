import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/**
 * Session 11: formal client approval — decisions are append-only events pinned
 * to ONE version. Old approvals stay historically true but never authorize a
 * newer version; the database never says "approved" for an undecided version.
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

describe("formal client approval", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  let deliverableId = "";
  let portalToken = "";

  async function walkToReview(): Promise<void> {
    for (const action of ["submit", "share-preview", "mark-review"] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/${action}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
    }
  }

  // After a version reset the deliverable is already `submitted`, so review
  // resumes at share-preview (submit-from-submitted is correctly rejected).
  async function shareAndReview(): Promise<void> {
    for (const action of ["share-preview", "mark-review"] as const) {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/${action}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
    }
  }

  it("sets up a deliverable at client review with a portal link", async () => {
    ({ token, workspaceId } = await signup("fpp11-owner@example.com", "Fpp Eleven"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme11@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: { clientId, title: "Approval audit", currency: "USD", totalValueCents: 50000 },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 1 — Screens", amountCents: 50000 },
    });
    expect(milestone.statusCode).toBe(201);
    milestoneId = (milestone.json() as { milestone: { id: string } }).milestone.id;

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/deliverables`,
      headers: auth(token),
      payload: { title: "Homepage" },
    });
    expect(created.statusCode).toBe(201);
    deliverableId = (created.json() as { deliverable: { id: string } }).deliverable.id;

    const v1 = await app.inject({
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
    expect(v1.statusCode).toBe(201);
    await walkToReview();

    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    portalToken = (issued.json() as { token: string }).token;
  });

  it("records a formal approval event (who / what / which version / when)", async () => {
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/approve`,
      payload: { token: portalToken, versionNo: 1 },
    });
    expect(approve.statusCode).toBe(200);
    const body = approve.json() as {
      approval: { id: string; decision: string; versionNo: number; createdAt: string };
    };
    expect(body.approval.decision).toBe("approved");
    expect(body.approval.versionNo).toBe(1);
    expect(typeof body.approval.id).toBe("string");
    expect(Number.isNaN(Date.parse(body.approval.createdAt))).toBe(false);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/approvals`,
      headers: auth(token),
    });
    expect(history.statusCode).toBe(200);
    const trail = history.json() as {
      approvals: {
        id: string;
        decision: string;
        versionNo: number;
        approverRef: string;
        actorType: string;
        createdAt: string;
      }[];
      effective: { isApproved: boolean; isCurrent: boolean; currentVersionNo: number };
    };
    expect(trail.approvals).toHaveLength(1);
    expect(trail.approvals[0]?.decision).toBe("approved");
    expect(trail.approvals[0]?.versionNo).toBe(1);
    expect(trail.approvals[0]?.approverRef).toContain("portal:");
    expect(trail.approvals[0]?.actorType).toBe("client");
    expect(trail.effective.isApproved).toBe(true);
    expect(trail.effective.isCurrent).toBe(true);
    // Hashed device metadata is never exposed; raw values never stored.
    expect(history.body).not.toContain("ipHash");
    expect(history.body).not.toContain("uaHash");

    // The decision is also in the event timeline with its audit payload.
    const events = await store.listProjectEvents(projectId, 50);
    const recorded = events.find(
      (e) =>
        e.type === "MilestoneApproved" && (e.payload.approvalId as string) === body.approval.id,
    );
    expect(recorded?.actorType).toBe("client");
    expect(recorded?.payload.decision).toBe("approved");
    expect(recorded?.payload.approvedVersionNo).toBe(1);
  });

  it("rejects approval that does not pin the current version", async () => {
    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/approve`,
      payload: { token: portalToken, versionNo: 99 },
    });
    expect(stale.statusCode).toBe(422);
  });

  it("keeps the old approval historically true but resets status on a new version", async () => {
    const v2 = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/versions`,
      headers: auth(token),
      payload: {
        description: "Second cut.",
        files: [
          {
            filename: "preview2.png",
            contentType: "image/png",
            sizeBytes: 1024,
            visibility: "review",
          },
        ],
      },
    });
    expect(v2.statusCode).toBe(201);
    const fresh = v2.json() as { deliverable: { status: string; currentVersionNo: number } };
    // THE core invariant: the DB no longer says "approved" for v2.
    expect(fresh.deliverable.currentVersionNo).toBe(2);
    expect(fresh.deliverable.status).toBe("submitted");
    expect(fresh.deliverable.status).not.toBe("approved");

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/approvals`,
      headers: auth(token),
    });
    const trail = history.json() as {
      approvals: { decision: string; versionNo: number }[];
      effective: { isApproved: boolean; isCurrent: boolean; reason: string };
    };
    // v1's approval is still there (historically true) …
    expect(trail.approvals).toHaveLength(1);
    expect(trail.approvals[0]).toMatchObject({ decision: "approved", versionNo: 1 });
    // … but it no longer authorizes the deliverable.
    expect(trail.effective.isApproved).toBe(false);
    expect(trail.effective.isCurrent).toBe(false);
    expect(trail.effective.reason).toContain("fresh decision");
  });

  it("requires a fresh approval for the new version before release thinking", async () => {
    await shareAndReview();
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
    const trail = history.json() as {
      approvals: { decision: string; versionNo: number }[];
      effective: { isApproved: boolean };
    };
    expect(trail.approvals).toHaveLength(2);
    expect(trail.effective.isApproved).toBe(true);

    // Client-safe history shows both decisions without internals.
    const portalHistory = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/approvals?token=${encodeURIComponent(portalToken)}`,
    });
    expect(portalHistory.statusCode).toBe(200);
    expect(
      (portalHistory.json() as { approvals: { decision: string }[] }).approvals.map(
        (a) => a.decision,
      ),
    ).toEqual(["approved", "approved"]);
    expect(portalHistory.body).not.toContain("ipHash");
  });

  it("supports revision_requested / rejected / disputed with actionable notes", async () => {
    const noNote = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/revision`,
      payload: { token: portalToken, versionNo: 2 },
    });
    expect(noNote.statusCode).toBe(422);

    const revision = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/revision`,
      payload: { token: portalToken, versionNo: 2, note: "Please tighten the spacing." },
    });
    expect(revision.statusCode).toBe(200);
    expect((revision.json() as { approval: { decision: string } }).approval.decision).toBe(
      "revision_requested",
    );

    // After revision the deliverable is back in review and no longer approved.
    const history = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/approvals`,
      headers: auth(token),
    });
    const trail = history.json() as {
      effective: { isApproved: boolean };
      approvals: { decision: string }[];
    };
    expect(trail.effective.isApproved).toBe(false);
    expect(trail.approvals.map((a) => a.decision)).toEqual([
      "approved",
      "approved",
      "revision_requested",
    ]);

    // Rejected and disputed decisions are recorded with their events.
    await walkToReview();
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/reject`,
      payload: { token: portalToken, versionNo: 2, note: "Not the right direction." },
    });
    expect(rejected.statusCode).toBe(200);

    const disputed = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/dispute`,
      payload: { token: portalToken, versionNo: 2, note: "We disagree on scope here." },
    });
    expect(disputed.statusCode).toBe(200);

    const events = await store.listProjectEvents(projectId, 100);
    expect(events.some((e) => e.type === "ApprovalRejected")).toBe(true);
    expect(events.some((e) => e.type === "DisputeFlagged")).toBe(true);
  });

  it("records milestone decisions (approve / revision / reject / dispute)", async () => {
    const seeded = await store.seedMilestone({
      workspaceId,
      projectId,
      title: "Milestone 2 — Review",
      amountCents: 20000,
      orderIndex: 1,
      workState: "submitted",
      paymentState: "unpaid",
      currentVersionId: "ms-v1",
    });
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/approve`,
      payload: { token: portalToken, milestoneId: seeded.id },
    });
    expect(approve.statusCode).toBe(200);
    expect((approve.json() as { approval: { decision: string } }).approval.decision).toBe(
      "approved",
    );

    // Idempotent repeat: no duplicate audit row.
    const repeat = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/approve`,
      payload: { token: portalToken, milestoneId: seeded.id },
    });
    expect(repeat.statusCode).toBe(200);
    const rows = await store.listApprovalsByMilestone(seeded.id);
    expect(rows.filter((r) => r.decision === "approved")).toHaveLength(1);

    const history = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${seeded.id}/approvals`,
      headers: auth(token),
    });
    expect(history.statusCode).toBe(200);
    expect(
      (history.json() as { approvals: { decision: string }[] }).approvals.map((a) => a.decision),
    ).toEqual(["approved"]);

    // Revision / rejection / dispute each require a note and append history.
    const seeded2 = await store.seedMilestone({
      workspaceId,
      projectId,
      title: "Milestone 3 — Polish",
      amountCents: 10000,
      orderIndex: 2,
      workState: "submitted",
      paymentState: "unpaid",
      currentVersionId: "ms-v2",
    });
    const bareRevision = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/request-revision`,
      payload: { token: portalToken, milestoneId: seeded2.id, note: "x" },
    });
    expect(bareRevision.statusCode).toBe(422);
    const revision = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/request-revision`,
      payload: { token: portalToken, milestoneId: seeded2.id, note: "First section needs work." },
    });
    expect(revision.statusCode).toBe(200);
    expect((revision.json() as { approval: { decision: string } }).approval.decision).toBe(
      "revision_requested",
    );

    const seeded3 = await store.seedMilestone({
      workspaceId,
      projectId,
      title: "Milestone 4 — Handoff",
      amountCents: 10000,
      orderIndex: 3,
      workState: "submitted",
      paymentState: "unpaid",
      currentVersionId: "ms-v3",
    });
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/reject`,
      payload: { token: portalToken, milestoneId: seeded3.id, note: "Not what we agreed." },
    });
    expect(rejected.statusCode).toBe(200);

    const seeded4 = await store.seedMilestone({
      workspaceId,
      projectId,
      title: "Milestone 5 — Close",
      amountCents: 10000,
      orderIndex: 4,
      workState: "submitted",
      paymentState: "unpaid",
      currentVersionId: "ms-v4",
    });
    const disputed = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/dispute`,
      payload: { token: portalToken, milestoneId: seeded4.id, note: "Billing question here." },
    });
    expect(disputed.statusCode).toBe(200);
    const disputedRow = await store.findMilestone(seeded4.id);
    expect(disputedRow?.workState).toBe("disputed");
  });

  it("enforces tenant and portal boundaries on approval history", async () => {
    const other = await signup("fpp11-other@example.com", "Other Eleven");
    const probe = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/approvals`,
      headers: auth(other.token),
    });
    expect(probe.statusCode).toBe(403);

    const tampered = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/approvals?token=${encodeURIComponent(`${portalToken}0`)}`,
    });
    expect(tampered.statusCode).toBe(401);

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/approvals`,
    });
    expect(missing.statusCode).toBe(422);
  });
});
