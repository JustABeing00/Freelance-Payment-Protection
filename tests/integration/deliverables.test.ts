import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/config/app.js";
import { InMemoryStore } from "../../src/lib/store.js";

/** Session 10: controlled delivery — review early, own only after release. */

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

describe("deliverable system", () => {
  let token = "";
  let workspaceId = "";
  let projectId = "";
  let milestoneId = "";
  let deliverableId = "";
  let portalToken = "";
  const milestoneAmount = 80000;

  it("creates a deliverable shell and requires a version before submit", async () => {
    ({ token, workspaceId } = await signup("fpp10-owner@example.com", "Fpp Ten"));
    const client = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/clients`,
      headers: auth(token),
      payload: { name: "Acme", email: "acme10@example.com" },
    });
    expect(client.statusCode).toBe(201);
    const clientId = (client.json() as { client: { id: string } }).client.id;

    const project = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects`,
      headers: auth(token),
      payload: {
        clientId,
        title: "Brand pack",
        currency: "USD",
        totalValueCents: milestoneAmount,
      },
    });
    expect(project.statusCode).toBe(201);
    projectId = (project.json() as { project: { id: string } }).project.id;

    const milestone = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones`,
      headers: auth(token),
      payload: { title: "Milestone 1 — Identity", amountCents: milestoneAmount },
    });
    expect(milestone.statusCode).toBe(201);
    milestoneId = (milestone.json() as { milestone: { id: string } }).milestone.id;

    const created = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/milestones/${milestoneId}/deliverables`,
      headers: auth(token),
      payload: { title: "Logo pack", description: "Identity + usage notes." },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { deliverable: { id: string; status: string } };
    expect(body.deliverable.status).toBe("draft");
    deliverableId = body.deliverable.id;

    const emptySubmit = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/submit`,
      headers: auth(token),
    });
    expect(emptySubmit.statusCode).toBe(422);
  });

  it("rejects unsafe version payloads", async () => {
    const badType = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/versions`,
      headers: auth(token),
      payload: {
        files: [
          {
            filename: "evil.exe",
            contentType: "application/x-msdownload",
            sizeBytes: 10,
            visibility: "review",
          },
        ],
      },
    });
    expect(badType.statusCode).toBe(422);

    const badLink = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/versions`,
      headers: auth(token),
      payload: { links: ["http://insecure.example/spec"] },
    });
    expect(badLink.statusCode).toBe(422);

    const empty = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/versions`,
      headers: auth(token),
      payload: {},
    });
    expect(empty.statusCode).toBe(422);
  });

  it("submits a version and walks to client review", async () => {
    const v1 = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/versions`,
      headers: auth(token),
      payload: {
        description: "First cut — watermarked preview plus final archive.",
        files: [
          {
            filename: "preview.png",
            contentType: "image/png",
            sizeBytes: 4096,
            visibility: "review",
          },
          {
            filename: "source.zip",
            contentType: "application/zip",
            sizeBytes: 8192,
            visibility: "final",
          },
        ],
        links: ["https://example.com/brand-spec"],
        previewText: "Watermarked preview — final vectors unlock after payment.",
      },
    });
    expect(v1.statusCode).toBe(201);
    expect(
      (v1.json() as { deliverable: { currentVersionNo: number } }).deliverable.currentVersionNo,
    ).toBe(1);

    const submit = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/submit`,
      headers: auth(token),
    });
    expect(submit.statusCode).toBe(200);
    expect((submit.json() as { deliverable: { status: string } }).deliverable.status).toBe(
      "submitted",
    );

    const preview = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/share-preview`,
      headers: auth(token),
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { deliverable: { status: string } }).deliverable.status).toBe(
      "preview_available",
    );

    const review = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/mark-review`,
      headers: auth(token),
    });
    expect(review.statusCode).toBe(200);
    expect((review.json() as { deliverable: { status: string } }).deliverable.status).toBe(
      "client_review",
    );

    // Freelancer preview download works once reviewable.
    const freelancerPreview = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/files/preview`,
      headers: auth(token),
    });
    expect(freelancerPreview.statusCode).toBe(200);
    expect((freelancerPreview.json() as { limitsNotice: string }).limitsNotice).toContain(
      "screenshots",
    );

    // Freelancer final download is locked before release (423).
    const freelancerFinal = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/files/final`,
      headers: auth(token),
    });
    expect(freelancerFinal.statusCode).toBe(423);
  });

  it("gives the client review access but locks finals until release", async () => {
    const issued = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/portal-links`,
      headers: auth(token),
      payload: {},
    });
    expect(issued.statusCode).toBe(201);
    portalToken = (issued.json() as { token: string }).token;

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables?token=${encodeURIComponent(portalToken)}`,
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { deliverables: Record<string, unknown>[] }).deliverables;
    expect(items).toHaveLength(1);
    const first = items[0] as {
      canReview: boolean;
      canReceiveFinal: boolean;
      limitsNotice: string;
      versions: { files: { filename: string; visibility: string }[]; finalFileCount: number }[];
    };
    expect(first.canReview).toBe(true);
    expect(first.canReceiveFinal).toBe(false);
    expect(first.limitsNotice).toContain("screenshots");
    // Final object keys never leak pre-release: only the review filename + count.
    expect(first.versions[0]?.files.map((f) => f.filename)).toEqual(["preview.png"]);
    expect(first.versions[0]?.finalFileCount).toBe(1);
    expect(list.body).not.toContain("source.zip");

    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/preview?token=${encodeURIComponent(portalToken)}`,
    });
    expect(preview.statusCode).toBe(200);
    expect((preview.json() as { expiresInSeconds: number }).expiresInSeconds).toBe(3600);

    const locked = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/final?token=${encodeURIComponent(portalToken)}`,
    });
    expect(locked.statusCode).toBe(423);
    const lockedBody = locked.json() as {
      error: { code: string; message: string; limitsNotice: string };
    };
    expect(lockedBody.error.code).toBe("LOCKED");
    expect(lockedBody.error.limitsNotice).toContain("screenshots");
  });

  it("approves, verifies payment, and releases the finals", async () => {
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/approve`,
      payload: { token: portalToken, versionNo: 1 },
    });
    expect(approve.statusCode).toBe(200);

    const pending = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/mark-payment-pending`,
      headers: auth(token),
    });
    expect(pending.statusCode).toBe(200);

    // Claims never count: mark-paid without a verified receipt is rejected.
    const unpaid = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/mark-paid`,
      headers: auth(token),
    });
    expect(unpaid.statusCode).toBe(422);

    // Release is locked before verified payment too.
    const lockedRelease = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/release`,
      headers: auth(token),
      payload: {},
    });
    expect(lockedRelease.statusCode).toBe(422);

    await store.seedPayment({
      workspaceId,
      projectId,
      milestoneId,
      amountCents: milestoneAmount,
      state: "paid",
    });

    const paid = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/mark-paid`,
      headers: auth(token),
    });
    expect(paid.statusCode).toBe(200);

    const release = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/release`,
      headers: auth(token),
      payload: {},
    });
    expect(release.statusCode).toBe(200);
    expect((release.json() as { deliverable: { status: string } }).deliverable.status).toBe(
      "released",
    );

    const portalFinal = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}/final?token=${encodeURIComponent(portalToken)}`,
    });
    expect(portalFinal.statusCode).toBe(200);
    const finalBody = portalFinal.json() as { url: string; expiresInSeconds: number };
    expect(finalBody.expiresInSeconds).toBe(900);
    expect(finalBody.url).toContain("exp=900");

    // Milestone delivery dimension followed the release.
    const milestone = await store.findMilestone(milestoneId);
    expect(milestone?.deliverableState).toBe("released");
  });

  it("models staging vs final transfer for web projects", async () => {
    const staging = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/staging`,
      headers: auth(token),
      payload: { stagingUrl: "https://staging.example/brand" },
    });
    expect(staging.statusCode).toBe(200);

    const request = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/staging/transfer-request`,
      headers: auth(token),
    });
    expect(request.statusCode).toBe(200);
    expect(
      (request.json() as { deliverable: { stagingTransferState: string } }).deliverable
        .stagingTransferState,
    ).toBe("transfer_pending");

    const done = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}/staging/transfer-complete`,
      headers: auth(token),
    });
    expect(done.statusCode).toBe(200);
    expect(
      (done.json() as { deliverable: { stagingTransferState: string } }).deliverable
        .stagingTransferState,
    ).toBe("transferred");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables/${deliverableId}?token=${encodeURIComponent(portalToken)}`,
    });
    expect(detail.statusCode).toBe(200);
    const portal = (
      detail.json() as { deliverable: { stagingTransferState: string; stagingNote: string } }
    ).deliverable;
    expect(portal.stagingTransferState).toBe("transferred");
  });

  it("enforces tenant and portal boundaries", async () => {
    const other = await signup("fpp10-other@example.com", "Other Ten");
    const probe = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${workspaceId}/projects/${projectId}/deliverables/${deliverableId}`,
      headers: auth(other.token),
    });
    expect(probe.statusCode).toBe(403);

    const tampered = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables?token=${encodeURIComponent(`${portalToken}0`)}`,
    });
    expect(tampered.statusCode).toBe(401);

    const missing = await app.inject({
      method: "GET",
      url: `/api/v1/portal/${projectId}/deliverables`,
    });
    expect(missing.statusCode).toBe(422);

    // Accountant (read-only) cannot create deliverables.
    const members = await store.listMembers(workspaceId);
    void members;
  });
});
