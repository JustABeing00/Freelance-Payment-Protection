import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { eventTypeForDecision, validateApprovalInput } from "../domain/approvals.js";
import {
  FINAL_URL_TTL_SECONDS,
  HONEST_LIMITS,
  PREVIEW_URL_TTL_SECONDS,
  approveDeliverable,
  canClientReceiveFinal,
  canClientReview,
  checkRelease,
  completeStagingTransfer,
  finalLockReason,
  markClientReview,
  markPaid,
  markPaymentPending,
  publishStaging,
  releaseDeliverable,
  requestStagingTransfer,
  sharePreview,
  stagingForClient,
  submitDeliverable,
  type DeliverableStatus,
  type StagingTransferState,
} from "../domain/deliverables.js";
import {
  ArtifactError,
  clampFinalTtl,
  clampPreviewTtl,
  mintObjectKey,
  validateVersionContent,
} from "../lib/artifacts.js";
import { assertResourceInWorkspace, requireMembership, requireWriteAccess } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import { hashToken, verifyMagicLink } from "../lib/magicLink.js";
import { FakeStorageProvider, NoopStorageProvider } from "../lib/providers.js";
import type { DeliverableRecord, DeliverableVersionRecord, Store } from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { notifyLifecycle } from "./notifications.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Controlled delivery (Session 10).
 *
 * Two audiences, one invariant:
 * - CLIENT CAN REVIEW (previews, staging, restricted downloads) is available
 *   early — watermarked/low-res/staging reduce premature delivery but the API
 *   never claims DRM (see HONEST_LIMITS: screenshots cannot be prevented).
 * - CLIENT OWNS/RECEIVES FINAL ASSET (source files, production credentials,
 *   final archives) ONLY after release. Finals are served via short-lived
 *   signed URLs (expiry + access checks + release conditions).
 *
 * Freelancer routes use session auth + membership + write-role + IDOR guards.
 * Client routes use single-project magic links (scope + expiry + revocation).
 */

const workspaceProjectMilestoneParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  milestoneId: uuidSchema,
});
const workspaceProjectDeliverableParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  deliverableId: uuidSchema,
});
const portalProjectParam = z.object({ projectId: uuidSchema });
const portalDeliverableParam = z.object({ projectId: uuidSchema, deliverableId: uuidSchema });

const createDeliverableSchema = z.object({
  title: z.string().trim().min(1, "required").max(160),
  description: z.string().trim().max(5000).optional(),
});

const fileSchema = z.object({
  filename: z.string().min(1).max(180),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().optional(),
  visibility: z.enum(["review", "final"]),
});

const createVersionSchema = z.object({
  description: z.string().trim().max(5000).optional(),
  files: z.array(fileSchema).max(10).optional(),
  links: z.array(z.string().max(2000)).max(20).optional(),
  previewText: z.string().max(20000).optional(),
  stagingUrl: z.string().max(2000).optional(),
});

const releaseSchema = z.object({
  manualOverrideReason: z.string().max(1000).optional(),
});

const stagingSchema = z.object({
  stagingUrl: z.string().min(1, "required").max(2000),
});

const versionQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
  file: z.string().max(300).optional(),
  expiresInSeconds: z.coerce.number().int().positive().optional(),
});

const portalListQuerySchema = z.object({ token: z.string().min(1, "required") });
const portalPreviewQuerySchema = z.object({
  token: z.string().min(1, "required"),
  version: z.coerce.number().int().positive().optional(),
  file: z.string().max(300).optional(),
});
const portalApproveSchema = z.object({
  token: z.string().min(1, "required"),
  versionNo: z.number().int().positive(),
  note: z.string().trim().max(2000).optional(),
});
const portalDecisionSchema = z.object({
  token: z.string().min(1, "required"),
  versionNo: z.number().int().positive(),
  note: z.string().trim().min(3, "Please add a short note (at least 3 characters)").max(2000),
});

const PORTAL_LINK_INVALID =
  "This link is invalid or has expired. Ask your studio for a fresh link.";

function storageOf(deps: RouteDeps) {
  return (
    deps.storageProvider ??
    (process.env.NODE_ENV === "test" ? new FakeStorageProvider() : new NoopStorageProvider())
  );
}

function toStatus(value: string): DeliverableStatus {
  if (
    value === "draft" ||
    value === "submitted" ||
    value === "preview_available" ||
    value === "client_review" ||
    value === "approved" ||
    value === "payment_pending" ||
    value === "paid" ||
    value === "released"
  ) {
    return value;
  }
  throw AppError.internal("Unknown deliverable status");
}

function milestoneSyncFor(status: DeliverableStatus): string {
  if (status === "released") return "released";
  if (status === "approved" || status === "payment_pending" || status === "paid") {
    return "unlocked_ready";
  }
  if (status === "preview_available" || status === "client_review") return "preview_shared";
  return "locked";
}

function serializeDeliverable(
  d: DeliverableRecord,
  versions: readonly DeliverableVersionRecord[],
): Record<string, unknown> {
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    projectId: d.projectId,
    milestoneId: d.milestoneId,
    title: d.title,
    ...(d.description !== undefined ? { description: d.description } : {}),
    status: d.status,
    deliveryState: d.deliveryState,
    ...(d.stagingUrl !== undefined ? { stagingUrl: d.stagingUrl } : {}),
    stagingTransferState: d.stagingTransferState,
    currentVersionNo: d.currentVersionNo,
    ...(d.approvedVersionNo !== undefined ? { approvedVersionNo: d.approvedVersionNo } : {}),
    canClientReview: canClientReview(toStatus(d.status)),
    canClientReceiveFinal: canClientReceiveFinal(toStatus(d.status)),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    versions: versions.map((v) => ({
      versionNo: v.versionNo,
      ...(v.description !== undefined ? { description: v.description } : {}),
      files: v.files.map((f) => ({
        filename: f.filename,
        contentType: f.contentType,
        sizeBytes: f.sizeBytes,
        visibility: f.visibility,
      })),
      links: [...v.links],
      ...(v.previewText !== undefined ? { previewText: v.previewText } : {}),
      ...(v.stagingUrl !== undefined ? { stagingUrl: v.stagingUrl } : {}),
      createdBy: v.createdBy,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

/** Client-safe projection: review files only, final keys never leak pre-release. */
function serializeForClient(
  d: DeliverableRecord,
  versions: readonly DeliverableVersionRecord[],
): Record<string, unknown> {
  const status = toStatus(d.status);
  const released = canClientReceiveFinal(status);
  const reviewable = canClientReview(status);
  const staging = stagingForClient({
    id: d.id,
    title: d.title,
    status,
    currentVersionNo: d.currentVersionNo,
    approvedVersionNo: d.approvedVersionNo ?? null,
    stagingTransfer: d.stagingTransferState as StagingTransferState,
    stagingUrl: d.stagingUrl ?? null,
  });
  return {
    id: d.id,
    title: d.title,
    ...(d.description !== undefined ? { description: d.description } : {}),
    status: d.status,
    statusLabel: released
      ? "Released — final files available"
      : reviewable
        ? "Ready for your review"
        : "In preparation",
    canReview: reviewable,
    canReceiveFinal: released,
    lockReason: released ? undefined : finalLockReason(status),
    currentVersionNo: d.currentVersionNo,
    ...(d.approvedVersionNo !== undefined ? { approvedVersionNo: d.approvedVersionNo } : {}),
    stagingUrl: staging.stagingUrl,
    stagingTransferState: staging.transferState,
    stagingNote: staging.transferNote,
    limitsNotice: HONEST_LIMITS,
    versions: versions.map((v) => ({
      versionNo: v.versionNo,
      ...(v.description !== undefined ? { description: v.description } : {}),
      // Review-safe: filenames + preview text + links + staging only.
      // Final object keys are NEVER included here; finals go through the
      // signed final endpoint after release.
      files: v.files
        .filter((f) => f.visibility === "review" || released)
        .map((f) => ({ filename: f.filename, visibility: f.visibility })),
      finalFileCount: v.files.filter((f) => f.visibility === "final").length,
      links: reviewable ? [...v.links] : [],
      ...(v.previewText !== undefined && reviewable ? { previewText: v.previewText } : {}),
      ...(v.stagingUrl !== undefined && reviewable ? { stagingUrl: v.stagingUrl } : {}),
    })),
  };
}

async function authorizePortal(
  store: Store,
  sessionSecret: string,
  projectId: string,
  rawToken: unknown,
) {
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    throw AppError.unauthorized(PORTAL_LINK_INVALID);
  }
  try {
    verifyMagicLink({ token: rawToken, expectedProjectId: projectId, sessionSecret });
  } catch {
    throw AppError.unauthorized(PORTAL_LINK_INVALID);
  }
  const link = await store.findPortalLinkByTokenHash(hashToken(rawToken));
  if (link?.projectId !== projectId) throw AppError.unauthorized(PORTAL_LINK_INVALID);
  if (link.revokedAt) throw AppError.unauthorized(PORTAL_LINK_INVALID);
  if (link.expiresAt.getTime() <= Date.now()) throw AppError.unauthorized(PORTAL_LINK_INVALID);
  const project = await store.findProject(projectId);
  if (!project) throw AppError.notFound("Not found");
  if (link.workspaceId !== project.workspaceId) throw AppError.unauthorized(PORTAL_LINK_INVALID);
  return { project, linkId: link.id };
}

function hashRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex");
}

/** Hashed device metadata only — raw IPs / user-agents are never persisted. */
function deviceHashes(request: { headers: Record<string, unknown>; ip: string }): {
  ipHash?: string | undefined;
  uaHash?: string | undefined;
} {
  const forwarded = request.headers["x-forwarded-for"];
  const ip =
    Array.isArray(forwarded) && typeof forwarded[0] === "string"
      ? forwarded[0]
      : typeof forwarded === "string"
        ? forwarded
        : request.ip;
  const ua = request.headers["user-agent"];
  const out: { ipHash?: string | undefined; uaHash?: string | undefined } = {};
  const ipHash = hashRef(ip);
  if (ipHash) out.ipHash = ipHash;
  if (typeof ua === "string") {
    const uaHash = hashRef(ua);
    if (uaHash) out.uaHash = uaHash;
  }
  return out;
}

async function verifiedPaidForMilestone(
  store: Store,
  projectId: string,
  milestoneId: string,
  amountCents: number,
): Promise<boolean> {
  const payments = await store.listPayments(projectId);
  let sum = 0;
  for (const p of payments) {
    if (
      p.milestoneId === milestoneId &&
      (p.state === "paid" || p.state === "received" || p.state === "partial")
    ) {
      sum += p.amountCents;
    }
  }
  return sum >= amountCents;
}

async function syncMilestoneDelivery(
  store: Store,
  milestoneId: string,
  status: DeliverableStatus,
): Promise<void> {
  const row = await store.findMilestone(milestoneId);
  if (!row) return;
  const next = milestoneSyncFor(status);
  if (row.deliverableState !== next) {
    await store.updateMilestone(milestoneId, { deliverableState: next });
  }
}

export function registerDeliverableRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  async function loadScoped(
    workspaceId: string,
    projectId: string,
    milestoneId: string,
    userId: string,
  ) {
    const membership = await store.findMembership(userId, workspaceId);
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(workspaceId, membership, project);
    const milestone = await store.findMilestone(milestoneId);
    if (milestone?.projectId !== projectId) throw AppError.notFound("Milestone not found");
    assertResourceInWorkspace(workspaceId, membership, milestone);
    return { membership, project, milestone };
  }

  async function loadDeliverable(
    workspaceId: string,
    projectId: string,
    deliverableId: string,
    userId: string,
  ) {
    const membership = await store.findMembership(userId, workspaceId);
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(workspaceId, membership, project);
    const deliverable = await store.findDeliverable(deliverableId);
    if (deliverable?.projectId !== projectId) throw AppError.notFound("Deliverable not found");
    assertResourceInWorkspace(workspaceId, membership, deliverable);
    return { membership, project, deliverable };
  }

  // ---- Freelancer: create a deliverable shell for a milestone ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/deliverables",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      const { membership } = await loadScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        user.id,
      );
      if (membership) requireWriteAccess(requireMembership(membership));
      const body = parseOrThrow(createDeliverableSchema, request.body, "Invalid deliverable");
      const created = await store.createDeliverable(params.workspaceId, {
        projectId: params.projectId,
        milestoneId: params.milestoneId,
        title: body.title.trim(),
        ...(body.description !== undefined ? { description: body.description } : {}),
      });
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        milestoneId: params.milestoneId,
        type: "DeliverableLocked",
        actorType: "freelancer",
        actorId: user.id,
        payload: { deliverableId: created.id, title: created.title },
      });
      const versions = await store.listDeliverableVersions(created.id);
      return reply.status(201).send({ deliverable: serializeDeliverable(created, versions) });
    },
  );

  // ---- Freelancer: list + detail ----
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/deliverables",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      await loadScoped(params.workspaceId, params.projectId, params.milestoneId, user.id);
      const rows = await store.listDeliverablesByMilestone(params.milestoneId);
      const out = [];
      for (const d of rows) {
        out.push(serializeDeliverable(d, await store.listDeliverableVersions(d.id)));
      }
      return { deliverables: out, limitsNotice: HONEST_LIMITS };
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const { deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      const versions = await store.listDeliverableVersions(deliverable.id);
      return { deliverable: serializeDeliverable(deliverable, versions) };
    },
  );

  // ---- Freelancer: submit files / links / previews / descriptions (versions) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/versions",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const { membership, deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      if (membership) requireWriteAccess(requireMembership(membership));
      const body = parseOrThrow(createVersionSchema, request.body ?? {}, "Invalid version");
      let content;
      try {
        content = validateVersionContent({
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.files !== undefined ? { files: body.files } : {}),
          ...(body.links !== undefined ? { links: body.links } : {}),
          ...(body.previewText !== undefined ? { previewText: body.previewText } : {}),
          ...(body.stagingUrl !== undefined ? { stagingUrl: body.stagingUrl } : {}),
        });
      } catch (err: unknown) {
        if (err instanceof ArtifactError) throw AppError.unprocessable(err.message);
        throw err;
      }
      const storage = storageOf(deps);
      const nextVersionNo = deliverable.currentVersionNo + 1;
      const storedFiles = [];
      for (const f of content.files) {
        const key = mintObjectKey(deliverable.id, nextVersionNo);
        await storage.putObject({ key, contentType: f.contentType, sizeBytes: f.sizeBytes });
        storedFiles.push({ ...f, key });
      }
      const firstReview = storedFiles.find((f) => f.visibility === "review");
      const firstFinal = storedFiles.find((f) => f.visibility === "final");
      const version = await store.createDeliverableVersion(deliverable.id, {
        ...(content.description !== undefined ? { description: content.description } : {}),
        files: storedFiles,
        links: content.links,
        ...(content.previewText !== undefined ? { previewText: content.previewText } : {}),
        ...(content.stagingUrl !== undefined ? { stagingUrl: content.stagingUrl } : {}),
        ...(firstReview ? { previewArtifactRef: firstReview.key } : {}),
        ...(firstFinal ? { finalArtifactRef: firstFinal.key } : {}),
        createdBy: user.id,
      });
      if (content.stagingUrl && deliverable.status !== "draft") {
        await store.updateDeliverable(deliverable.id, {
          stagingUrl: content.stagingUrl,
          stagingTransferState: "staging_live",
        });
      } else if (content.stagingUrl) {
        await store.updateDeliverable(deliverable.id, { stagingUrl: content.stagingUrl });
      }
      // A new version never inherits the old approval: if the deliverable was
      // sitting in an approval-backed state, move it back to `submitted` so
      // the database never says "approved" for a version the client has not
      // approved. History is preserved (approvedVersionNo keeps pointing at
      // the old approved version; the Approval rows stay untouched).
      const STALE_RESET = new Set(["approved", "payment_pending", "paid", "released"]);
      if (STALE_RESET.has(deliverable.status)) {
        await store.updateDeliverable(deliverable.id, { status: "submitted" });
        await syncMilestoneDelivery(store, deliverable.milestoneId, "submitted");
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: deliverable.milestoneId,
          type: "RevisionSubmitted",
          actorType: "freelancer",
          actorId: user.id,
          payload: {
            deliverableId: deliverable.id,
            versionNo: version.versionNo,
            supersedesApprovedVersionNo: deliverable.approvedVersionNo ?? null,
            note: "New version uploaded — previous approval stays true for its version only; a fresh client decision is required.",
          },
        });
      }
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        milestoneId: deliverable.milestoneId,
        type: "DeliverableVersionCreated",
        actorType: "freelancer",
        actorId: user.id,
        payload: {
          deliverableId: deliverable.id,
          versionNo: version.versionNo,
          fileCount: storedFiles.length,
          linkCount: content.links.length,
        },
      });
      const fresh = (await store.findDeliverable(deliverable.id)) ?? deliverable;
      const versions = await store.listDeliverableVersions(deliverable.id);
      return reply.status(201).send({ deliverable: serializeDeliverable(fresh, versions) });
    },
  );

  // ---- Freelancer: lifecycle transitions ----
  // ---- Freelancer: lifecycle transitions (explicit endpoints below) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/submit",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const { deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      if (deliverable.currentVersionNo < 1) {
        throw AppError.unprocessable("Add at least one version before submitting.");
      }
      try {
        const next = submitDeliverable({
          id: deliverable.id,
          title: deliverable.title,
          status: toStatus(deliverable.status),
          currentVersionNo: deliverable.currentVersionNo,
          approvedVersionNo: deliverable.approvedVersionNo ?? null,
          stagingTransfer: deliverable.stagingTransferState as StagingTransferState,
          stagingUrl: deliverable.stagingUrl ?? null,
        });
        const updated = await store.updateDeliverable(deliverable.id, { status: next.status });
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: deliverable.milestoneId,
          type: "DeliverableSubmitted",
          actorType: "freelancer",
          actorId: user.id,
          payload: { deliverableId: deliverable.id, versionNo: deliverable.currentVersionNo },
        });
        return {
          deliverable: serializeDeliverable(
            updated,
            await store.listDeliverableVersions(deliverable.id),
          ),
        };
      } catch {
        throw AppError.unprocessable(`Deliverable cannot be submitted from ${deliverable.status}.`);
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/share-preview",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const { deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      try {
        const next = sharePreview({
          id: deliverable.id,
          title: deliverable.title,
          status: toStatus(deliverable.status),
          currentVersionNo: deliverable.currentVersionNo,
          approvedVersionNo: deliverable.approvedVersionNo ?? null,
          stagingTransfer: deliverable.stagingTransferState as StagingTransferState,
          stagingUrl: deliverable.stagingUrl ?? null,
        });
        const updated = await store.updateDeliverable(deliverable.id, {
          status: next.status,
          deliveryState: milestoneSyncFor(next.status),
        });
        await syncMilestoneDelivery(store, deliverable.milestoneId, next.status);
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: deliverable.milestoneId,
          type: "DeliverablePreviewShared",
          actorType: "freelancer",
          actorId: user.id,
          payload: {
            deliverableId: deliverable.id,
            versionNo: deliverable.currentVersionNo,
            notice: HONEST_LIMITS,
          },
        });
        return {
          deliverable: serializeDeliverable(
            updated,
            await store.listDeliverableVersions(deliverable.id),
          ),
        };
      } catch {
        throw AppError.unprocessable(
          `Preview cannot be shared from ${deliverable.status}. Submit first.`,
        );
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/mark-review",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const { deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      try {
        const next = markClientReview({
          id: deliverable.id,
          title: deliverable.title,
          status: toStatus(deliverable.status),
          currentVersionNo: deliverable.currentVersionNo,
          approvedVersionNo: deliverable.approvedVersionNo ?? null,
          stagingTransfer: deliverable.stagingTransferState as StagingTransferState,
          stagingUrl: deliverable.stagingUrl ?? null,
        });
        const updated = await store.updateDeliverable(deliverable.id, { status: next.status });
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: deliverable.milestoneId,
          type: "DeliverableViewed",
          actorType: "freelancer",
          actorId: user.id,
          payload: { deliverableId: deliverable.id },
        });
        return {
          deliverable: serializeDeliverable(
            updated,
            await store.listDeliverableVersions(deliverable.id),
          ),
        };
      } catch {
        throw AppError.unprocessable(`Deliverable cannot enter review from ${deliverable.status}.`);
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/mark-payment-pending",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const { deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      try {
        const next = markPaymentPending({
          id: deliverable.id,
          title: deliverable.title,
          status: toStatus(deliverable.status),
          currentVersionNo: deliverable.currentVersionNo,
          approvedVersionNo: deliverable.approvedVersionNo ?? null,
          stagingTransfer: deliverable.stagingTransferState as StagingTransferState,
          stagingUrl: deliverable.stagingUrl ?? null,
        });
        const updated = await store.updateDeliverable(deliverable.id, { status: next.status });
        return {
          deliverable: serializeDeliverable(
            updated,
            await store.listDeliverableVersions(deliverable.id),
          ),
        };
      } catch {
        throw AppError.unprocessable(
          `Deliverable cannot move to payment_pending from ${deliverable.status}. Approve first.`,
        );
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/mark-paid",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const { project, deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      const milestone = await store.findMilestone(deliverable.milestoneId);
      if (!milestone) throw AppError.notFound("Milestone not found");
      const verified = await verifiedPaidForMilestone(
        store,
        project.id,
        milestone.id,
        milestone.amountCents,
      );
      if (!verified) {
        throw AppError.unprocessable(
          "Verified payment is required before marking paid (claims never count).",
        );
      }
      try {
        const next = markPaid({
          id: deliverable.id,
          title: deliverable.title,
          status: toStatus(deliverable.status),
          currentVersionNo: deliverable.currentVersionNo,
          approvedVersionNo: deliverable.approvedVersionNo ?? null,
          stagingTransfer: deliverable.stagingTransferState as StagingTransferState,
          stagingUrl: deliverable.stagingUrl ?? null,
        });
        const updated = await store.updateDeliverable(deliverable.id, { status: next.status });
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: deliverable.milestoneId,
          type: "PaymentReceived",
          actorType: "system",
          actorId: user.id,
          payload: { deliverableId: deliverable.id, verified: true },
        });
        return {
          deliverable: serializeDeliverable(
            updated,
            await store.listDeliverableVersions(deliverable.id),
          ),
        };
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        throw AppError.unprocessable(
          `Deliverable cannot be marked paid from ${deliverable.status}.`,
        );
      }
    },
  );

  // ---- Freelancer: release finals (gated) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/release",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const { project, deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      const body = parseOrThrow(releaseSchema, request.body ?? {}, "Invalid release");
      const milestone = await store.findMilestone(deliverable.milestoneId);
      if (!milestone) throw AppError.notFound("Milestone not found");
      const verified = await verifiedPaidForMilestone(
        store,
        project.id,
        milestone.id,
        milestone.amountCents,
      );
      const override =
        body.manualOverrideReason !== undefined ? body.manualOverrideReason.trim() : undefined;
      const decision = checkRelease({
        status: toStatus(deliverable.status),
        approvedVersionNo: deliverable.approvedVersionNo ?? null,
        currentVersionNo: deliverable.currentVersionNo,
        verifiedPaid: verified,
        ...(override !== undefined ? { manualOverrideReason: override } : {}),
      });
      if (!decision.allowed) {
        throw AppError.unprocessable(`Final release is locked: ${decision.reasons.join(" ")}`);
      }
      try {
        const next = releaseDeliverable(
          {
            id: deliverable.id,
            title: deliverable.title,
            status: toStatus(deliverable.status),
            currentVersionNo: deliverable.currentVersionNo,
            approvedVersionNo: deliverable.approvedVersionNo ?? null,
            stagingTransfer: deliverable.stagingTransferState as StagingTransferState,
            stagingUrl: deliverable.stagingUrl ?? null,
          },
          {
            status: toStatus(deliverable.status),
            approvedVersionNo: deliverable.approvedVersionNo ?? null,
            currentVersionNo: deliverable.currentVersionNo,
            verifiedPaid: verified,
            ...(override !== undefined ? { manualOverrideReason: override } : {}),
          },
        );
        const updated = await store.updateDeliverable(deliverable.id, {
          status: next.status,
          deliveryState: "released",
        });
        await syncMilestoneDelivery(store, deliverable.milestoneId, next.status);
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: deliverable.milestoneId,
          type: decision.overridden ? "ManualReleaseOverride" : "DeliverableReleased",
          actorType: "freelancer",
          actorId: user.id,
          payload: {
            deliverableId: deliverable.id,
            versionNo: deliverable.currentVersionNo,
            ...(decision.overridden && override ? { reason: override } : {}),
          },
        });
        await notifyLifecycle(deps, {
          workspaceId: params.workspaceId,
          projectId: params.projectId,
          milestoneId: deliverable.milestoneId,
          kind: "deliverable_released",
          dedupe: `release:${deliverable.id}:${deliverable.currentVersionNo}`,
          detail: `${deliverable.title} (version ${deliverable.currentVersionNo})${decision.overridden && override ? ` — ${override.slice(0, 300)}` : ""}`,
          actorId: user.id,
        });
        return {
          deliverable: serializeDeliverable(
            updated,
            await store.listDeliverableVersions(deliverable.id),
          ),
          overridden: decision.overridden,
          reasons: decision.reasons,
        };
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        throw AppError.unprocessable("Release failed for this deliverable.");
      }
    },
  );

  // ---- Freelancer: staging publish / transfer ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/staging",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const { deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      const body = parseOrThrow(stagingSchema, request.body, "Invalid staging URL");
      try {
        const next = publishStaging(
          {
            id: deliverable.id,
            title: deliverable.title,
            status: toStatus(deliverable.status),
            currentVersionNo: deliverable.currentVersionNo,
            approvedVersionNo: deliverable.approvedVersionNo ?? null,
            stagingTransfer: deliverable.stagingTransferState as StagingTransferState,
            stagingUrl: deliverable.stagingUrl ?? null,
          },
          body.stagingUrl.trim(),
        );
        const updated = await store.updateDeliverable(deliverable.id, {
          stagingUrl: next.stagingUrl ?? undefined,
          stagingTransferState: next.stagingTransfer,
        });
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: deliverable.milestoneId,
          type: "DeliverableStagingPublished",
          actorType: "freelancer",
          actorId: user.id,
          payload: { deliverableId: deliverable.id, stagingUrl: body.stagingUrl.trim() },
        });
        return {
          deliverable: serializeDeliverable(
            updated,
            await store.listDeliverableVersions(deliverable.id),
          ),
        };
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        throw AppError.unprocessable("Staging URL cannot be published in this state.");
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/staging/transfer-request",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const { deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      try {
        const next = requestStagingTransfer({
          id: deliverable.id,
          title: deliverable.title,
          status: toStatus(deliverable.status),
          currentVersionNo: deliverable.currentVersionNo,
          approvedVersionNo: deliverable.approvedVersionNo ?? null,
          stagingTransfer: deliverable.stagingTransferState as StagingTransferState,
          stagingUrl: deliverable.stagingUrl ?? null,
        });
        const updated = await store.updateDeliverable(deliverable.id, {
          stagingTransferState: next.stagingTransfer,
        });
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: deliverable.milestoneId,
          type: "DeliverableStagingTransferRequested",
          actorType: "freelancer",
          actorId: user.id,
          payload: { deliverableId: deliverable.id },
        });
        return {
          deliverable: serializeDeliverable(
            updated,
            await store.listDeliverableVersions(deliverable.id),
          ),
        };
      } catch {
        throw AppError.unprocessable(
          "Transfer requires a live staging URL and a released deliverable.",
        );
      }
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/staging/transfer-complete",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const { deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      try {
        const next = completeStagingTransfer({
          id: deliverable.id,
          title: deliverable.title,
          status: toStatus(deliverable.status),
          currentVersionNo: deliverable.currentVersionNo,
          approvedVersionNo: deliverable.approvedVersionNo ?? null,
          stagingTransfer: deliverable.stagingTransferState as StagingTransferState,
          stagingUrl: deliverable.stagingUrl ?? null,
        });
        const updated = await store.updateDeliverable(deliverable.id, {
          stagingTransferState: next.stagingTransfer,
        });
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: deliverable.milestoneId,
          type: "DeliverableStagingTransferred",
          actorType: "freelancer",
          actorId: user.id,
          payload: { deliverableId: deliverable.id },
        });
        return {
          deliverable: serializeDeliverable(
            updated,
            await store.listDeliverableVersions(deliverable.id),
          ),
        };
      } catch {
        throw AppError.unprocessable("Transfer must be requested before it can be completed.");
      }
    },
  );

  // ---- Freelancer: signed downloads (preview open after review; final only released) ----
  async function signedDownload(
    deliverable: DeliverableRecord,
    versionNo: number | undefined,
    fileKey: string | undefined,
    kind: "preview" | "final",
    expiresInSeconds: number | undefined,
  ) {
    const versions = await store.listDeliverableVersions(deliverable.id);
    const targetNo = versionNo ?? deliverable.currentVersionNo;
    const version = versions.find((v) => v.versionNo === targetNo);
    if (!version) throw AppError.notFound("Version not found");
    const status = toStatus(deliverable.status);
    const storage = storageOf(deps);
    if (kind === "preview") {
      if (!canClientReview(status)) {
        throw AppError.unprocessable("No preview is available for this deliverable yet.");
      }
      const candidates = version.files.filter((f) => f.visibility === "review");
      if (candidates.length === 0) {
        // Links / preview text / staging act as the preview when no review file exists.
        return {
          preview: {
            links: [...version.links],
            ...(version.previewText !== undefined ? { previewText: version.previewText } : {}),
            ...(version.stagingUrl !== undefined ? { stagingUrl: version.stagingUrl } : {}),
          },
          expiresInSeconds: clampPreviewTtl(expiresInSeconds ?? PREVIEW_URL_TTL_SECONDS),
          limitsNotice: HONEST_LIMITS,
        };
      }
      const picked =
        (fileKey
          ? candidates.find((f) => f.key === fileKey || f.filename === fileKey)
          : undefined) ?? candidates[0];
      if (!picked) throw AppError.notFound("Preview file not found");
      const ttl = clampPreviewTtl(expiresInSeconds ?? PREVIEW_URL_TTL_SECONDS);
      const signed = await storage.signedUrl({ key: picked.key, expiresInSeconds: ttl });
      return {
        url: signed.url,
        filename: picked.filename,
        contentType: picked.contentType,
        expiresInSeconds: ttl,
        limitsNotice: HONEST_LIMITS,
      };
    }
    if (!canClientReceiveFinal(status)) {
      const err = AppError.unprocessable(`Final files are locked: ${finalLockReason(status)}`);
      (err as unknown as { statusCode?: number }).statusCode = 423;
      throw err;
    }
    // Finals only: even with `?file=` an attacker must not be able to pull a
    // review-visibility object through the final endpoint (post-release the
    // client is entitled to finals, not to a confusing mix of both).
    const finals = version.files.filter((f) => f.visibility === "final");
    const candidates =
      fileKey !== undefined
        ? finals.filter((f) => f.key === fileKey || f.filename === fileKey)
        : finals;
    const picked = candidates[0];
    if (!picked) throw AppError.notFound("Final file not found");
    const ttl = clampFinalTtl(expiresInSeconds ?? FINAL_URL_TTL_SECONDS);
    const signed = await storage.signedUrl({ key: picked.key, expiresInSeconds: ttl });
    return {
      url: signed.url,
      filename: picked.filename,
      contentType: picked.contentType,
      expiresInSeconds: ttl,
    };
  }

  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/files/preview",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const query = parseOrThrow(versionQuerySchema, request.query, "Invalid query");
      const { deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      return signedDownload(
        deliverable,
        query.version,
        query.file,
        "preview",
        query.expiresInSeconds,
      );
    },
  );

  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/files/final",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const query = parseOrThrow(versionQuerySchema, request.query, "Invalid query");
      const { project, deliverable } = await loadDeliverable(
        params.workspaceId,
        params.projectId,
        params.deliverableId,
        user.id,
      );
      try {
        const result = await signedDownload(
          deliverable,
          query.version,
          query.file,
          "final",
          query.expiresInSeconds,
        );
        await store.appendProjectEvent(params.workspaceId, project.id, {
          milestoneId: deliverable.milestoneId,
          type: "DeliverableViewed",
          actorType: "freelancer",
          actorId: user.id,
          payload: { deliverableId: deliverable.id, kind: "final" },
        });
        return result;
      } catch (err: unknown) {
        if (err instanceof AppError && err.code === "UNPROCESSABLE") {
          return reply.status(423).send({
            error: {
              code: "LOCKED",
              message: err.message,
              requestId: request.id,
              limitsNotice: HONEST_LIMITS,
            },
          });
        }
        throw err;
      }
    },
  );

  // ---- Client: safe list + detail (review-safe only) ----
  app.get("/api/v1/portal/:projectId/deliverables", async (request) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const query = parseOrThrow(
      portalListQuerySchema,
      request.query,
      "A valid portal link is required",
    );
    const { project } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      query.token,
    );
    const rows = await store.listDeliverablesByProject(project.id);
    const out = [];
    for (const d of rows) {
      out.push(serializeForClient(d, await store.listDeliverableVersions(d.id)));
    }
    return { deliverables: out, limitsNotice: HONEST_LIMITS };
  });

  app.get("/api/v1/portal/:projectId/deliverables/:deliverableId", async (request) => {
    const params = parseOrThrow(portalDeliverableParam, request.params, "Invalid ids");
    const query = parseOrThrow(
      portalListQuerySchema,
      request.query,
      "A valid portal link is required",
    );
    const { project } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      query.token,
    );
    const d = await store.findDeliverable(params.deliverableId);
    if (d?.projectId !== project.id) throw AppError.notFound("Not found");
    return {
      deliverable: serializeForClient(d, await store.listDeliverableVersions(d.id)),
    };
  });

  // ---- Client: preview download (review-safe files only) ----
  app.get("/api/v1/portal/:projectId/deliverables/:deliverableId/preview", async (request) => {
    const params = parseOrThrow(portalDeliverableParam, request.params, "Invalid ids");
    const query = parseOrThrow(
      portalPreviewQuerySchema,
      request.query,
      "A valid portal link is required",
    );
    const { project } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      query.token,
    );
    const d = await store.findDeliverable(params.deliverableId);
    if (d?.projectId !== project.id) throw AppError.notFound("Not found");
    if (!canClientReview(toStatus(d.status))) {
      throw AppError.unprocessable("No preview is available for this deliverable yet.");
    }
    const versions = await store.listDeliverableVersions(d.id);
    const targetNo = query.version ?? d.currentVersionNo;
    const version = versions.find((v) => v.versionNo === targetNo);
    if (!version) throw AppError.notFound("Not found");
    const reviewFiles = version.files.filter((f) => f.visibility === "review");
    if (reviewFiles.length === 0) {
      return {
        preview: {
          links: [...version.links],
          ...(version.previewText !== undefined ? { previewText: version.previewText } : {}),
          ...(version.stagingUrl !== undefined ? { stagingUrl: version.stagingUrl } : {}),
          ...(d.stagingUrl ? { projectStagingUrl: d.stagingUrl } : {}),
        },
        limitsNotice: HONEST_LIMITS,
      };
    }
    const picked =
      (query.file ? reviewFiles.find((f) => f.filename === query.file) : undefined) ??
      reviewFiles[0];
    if (!picked) throw AppError.notFound("Not found");
    const storage = storageOf(deps);
    const signed = await storage.signedUrl({
      key: picked.key,
      expiresInSeconds: PREVIEW_URL_TTL_SECONDS,
    });
    try {
      await store.appendProjectEvent(project.workspaceId, project.id, {
        milestoneId: d.milestoneId,
        type: "DeliverableViewed",
        actorType: "client",
        payload: { deliverableId: d.id, versionNo: version.versionNo, kind: "preview" },
      });
    } catch {
      // View logging is best-effort; the signed URL is still the response.
    }
    return {
      url: signed.url,
      filename: picked.filename,
      expiresInSeconds: PREVIEW_URL_TTL_SECONDS,
      limitsNotice: HONEST_LIMITS,
    };
  });

  // ---- Client: final download (released ONLY, else 423 with lock reason) ----
  app.get("/api/v1/portal/:projectId/deliverables/:deliverableId/final", async (request, reply) => {
    const params = parseOrThrow(portalDeliverableParam, request.params, "Invalid ids");
    const query = parseOrThrow(
      portalPreviewQuerySchema,
      request.query,
      "A valid portal link is required",
    );
    const { project } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      query.token,
    );
    const d = await store.findDeliverable(params.deliverableId);
    if (d?.projectId !== project.id) throw AppError.notFound("Not found");
    if (!canClientReceiveFinal(toStatus(d.status))) {
      return reply.status(423).send({
        error: {
          code: "LOCKED",
          message: `Final files are locked: ${finalLockReason(toStatus(d.status))}`,
          requestId: request.id,
          limitsNotice: HONEST_LIMITS,
        },
      });
    }
    const versions = await store.listDeliverableVersions(d.id);
    const targetNo = query.version ?? d.currentVersionNo;
    const version = versions.find((v) => v.versionNo === targetNo);
    if (!version) throw AppError.notFound("Not found");
    // Finals only (mirrors the freelancer endpoint): a `?file=` naming a
    // review-visibility object must not resolve through the final endpoint,
    // and a released version with no final files yields 404 — never a review
    // file served as if it were the final asset.
    const finals = version.files.filter((f) => f.visibility === "final");
    const picked =
      (query.file ? finals.find((f) => f.filename === query.file) : undefined) ?? finals[0];
    if (!picked) throw AppError.notFound("Not found");
    const storage = storageOf(deps);
    const signed = await storage.signedUrl({
      key: picked.key,
      expiresInSeconds: FINAL_URL_TTL_SECONDS,
    });
    try {
      await store.appendProjectEvent(project.workspaceId, project.id, {
        milestoneId: d.milestoneId,
        type: "DeliverableViewed",
        actorType: "client",
        payload: { deliverableId: d.id, versionNo: version.versionNo, kind: "final" },
      });
    } catch {
      // best-effort
    }
    return {
      url: signed.url,
      filename: picked.filename,
      expiresInSeconds: FINAL_URL_TTL_SECONDS,
    };
  });

  // ---- Client: approve the current version ----
  // Formal approval: append-only, pinned to versionNo, with approver identity
  // (portal link), timestamp, and hashed device metadata. Idempotent per
  // (deliverable, version): repeats return the original row.
  app.post("/api/v1/portal/:projectId/deliverables/:deliverableId/approve", async (request) => {
    const params = parseOrThrow(portalDeliverableParam, request.params, "Invalid ids");
    const body = parseOrThrow(portalApproveSchema, request.body, "Invalid approval");
    const { project, linkId } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const d = await store.findDeliverable(params.deliverableId);
    if (d?.projectId !== project.id) throw AppError.notFound("Not found");
    if (body.versionNo !== d.currentVersionNo) {
      throw AppError.unprocessable("Approval must pin the current version.");
    }
    const note = body.note?.trim();
    try {
      validateApprovalInput({
        versionNo: body.versionNo,
        decision: "approved",
        ...(note ? { note } : {}),
      });
    } catch {
      throw AppError.unprocessable("This deliverable cannot be approved in its current state.");
    }
    const approverRef = `portal:${linkId}`;
    // Idempotent repeat: when the LATEST decision is already this approval,
    // return the original row instead of recording a duplicate or failing the
    // lifecycle transition (the version is already approved).
    const priorRows = await store.listApprovalsByDeliverable(d.id);
    const priorLatest = priorRows.length > 0 ? priorRows[priorRows.length - 1] : undefined;
    if (
      priorLatest?.decision === "approved" &&
      priorLatest.versionNo === body.versionNo &&
      priorLatest.approverRef === approverRef
    ) {
      try {
        await store.appendProjectEvent(project.workspaceId, project.id, {
          milestoneId: d.milestoneId,
          type: eventTypeForDecision("approved"),
          actorType: "client",
          idempotencyKey: `portal-deliverable-approve:${d.id}:${body.versionNo}`,
          payload: {
            deliverableId: d.id,
            approvedVersionNo: body.versionNo,
            decision: "approved",
            approvalId: priorLatest.id,
            approverRef,
          },
        });
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
      }
      return {
        message: `${d.title} (v${body.versionNo}) is approved — thank you. Final files unlock after verified payment.`,
        deliverable: serializeForClient(d, await store.listDeliverableVersions(d.id)),
        approval: {
          id: priorLatest.id,
          decision: "approved",
          versionNo: body.versionNo,
          createdAt: priorLatest.createdAt.toISOString(),
          duplicate: true,
        },
      };
    }
    try {
      const next = approveDeliverable(
        {
          id: d.id,
          title: d.title,
          status: toStatus(d.status),
          currentVersionNo: d.currentVersionNo,
          approvedVersionNo: d.approvedVersionNo ?? null,
          stagingTransfer: d.stagingTransferState as StagingTransferState,
          stagingUrl: d.stagingUrl ?? null,
        },
        body.versionNo,
      );
      const updated = await store.updateDeliverable(d.id, {
        status: next.status,
        approvedVersionNo: next.approvedVersionNo ?? undefined,
        deliveryState: milestoneSyncFor(next.status),
      });
      await syncMilestoneDelivery(store, d.milestoneId, next.status);
      const versionRow = await store.findDeliverableVersion(d.id, body.versionNo);
      const device = deviceHashes(request);
      const approval = await store.createApproval(project.workspaceId, {
        projectId: project.id,
        milestoneId: d.milestoneId,
        deliverableId: d.id,
        ...(versionRow ? { deliverableVersionId: versionRow.id } : {}),
        versionNo: body.versionNo,
        decision: "approved",
        approverRef,
        ...(note ? { note } : {}),
        actorType: "client",
        ...(device.ipHash ? { ipHash: device.ipHash } : {}),
        ...(device.uaHash ? { uaHash: device.uaHash } : {}),
      });
      try {
        await store.appendProjectEvent(project.workspaceId, project.id, {
          milestoneId: d.milestoneId,
          type: eventTypeForDecision("approved"),
          actorType: "client",
          idempotencyKey: `portal-deliverable-approve:${d.id}:${body.versionNo}`,
          payload: {
            deliverableId: d.id,
            approvedVersionNo: body.versionNo,
            decision: "approved",
            approvalId: approval.id,
            approverRef,
          },
        });
      } catch (err: unknown) {
        if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
      }
      await notifyLifecycle(deps, {
        workspaceId: project.workspaceId,
        projectId: project.id,
        milestoneId: d.milestoneId,
        kind: "deliverable_approved",
        dedupe: `portal-deliverable-approve:${approval.id}`,
        detail: `${d.title} (version ${body.versionNo})`,
      });
      return {
        message: `${updated.title} (v${body.versionNo}) is approved — thank you. Final files unlock after verified payment.`,
        deliverable: serializeForClient(updated, await store.listDeliverableVersions(d.id)),
        approval: {
          id: approval.id,
          decision: "approved",
          versionNo: body.versionNo,
          createdAt: approval.createdAt.toISOString(),
        },
      };
    } catch (err: unknown) {
      if (err instanceof AppError) throw err;
      throw AppError.unprocessable("This deliverable cannot be approved in its current state.");
    }
  });

  // ---- Client: request changes on the current version ----
  app.post("/api/v1/portal/:projectId/deliverables/:deliverableId/revision", async (request) => {
    const params = parseOrThrow(portalDeliverableParam, request.params, "Invalid ids");
    const body = parseOrThrow(portalDecisionSchema, request.body, "Invalid revision request");
    const { project, linkId } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const d = await store.findDeliverable(params.deliverableId);
    if (d?.projectId !== project.id) throw AppError.notFound("Not found");
    if (body.versionNo !== d.currentVersionNo) {
      throw AppError.unprocessable("Revision requests must pin the current version.");
    }
    try {
      validateApprovalInput({
        versionNo: body.versionNo,
        decision: "revision_requested",
        note: body.note,
      });
    } catch {
      throw AppError.unprocessable("This deliverable cannot take a revision request right now.");
    }
    const status = toStatus(d.status);
    // Move back exactly one review step so the freelancer knows rework is
    // due; paid/released versions are too late for revision (dispute instead).
    let backTo: "submitted" | "client_review" | "approved";
    if (status === "approved") backTo = "client_review";
    else if (status === "payment_pending") backTo = "approved";
    else if (status === "preview_available" || status === "client_review") backTo = "submitted";
    else {
      throw AppError.unprocessable(
        "This deliverable cannot take a revision request in its current state.",
      );
    }
    const updated = await store.updateDeliverable(d.id, { status: backTo });
    await syncMilestoneDelivery(store, d.milestoneId, backTo);
    const versionRow = await store.findDeliverableVersion(d.id, body.versionNo);
    const approverRef = `portal:${linkId}`;
    const device = deviceHashes(request);
    const approval = await store.createApproval(project.workspaceId, {
      projectId: project.id,
      milestoneId: d.milestoneId,
      deliverableId: d.id,
      ...(versionRow ? { deliverableVersionId: versionRow.id } : {}),
      versionNo: body.versionNo,
      decision: "revision_requested",
      approverRef,
      note: body.note.slice(0, 2000),
      actorType: "client",
      ...(device.ipHash ? { ipHash: device.ipHash } : {}),
      ...(device.uaHash ? { uaHash: device.uaHash } : {}),
    });
    await store.appendProjectEvent(project.workspaceId, project.id, {
      milestoneId: d.milestoneId,
      type: eventTypeForDecision("revision_requested"),
      actorType: "client",
      payload: {
        deliverableId: d.id,
        versionNo: body.versionNo,
        decision: "revision_requested",
        note: body.note.slice(0, 2000),
        approvalId: approval.id,
        approverRef,
      },
    });
    return {
      message: `Thanks — your feedback on ${updated.title} (v${body.versionNo}) was shared with your studio.`,
      deliverable: serializeForClient(updated, await store.listDeliverableVersions(d.id)),
      approval: {
        id: approval.id,
        decision: "revision_requested",
        versionNo: body.versionNo,
        createdAt: approval.createdAt.toISOString(),
      },
    };
  });

  // ---- Client: reject the current version ----
  app.post("/api/v1/portal/:projectId/deliverables/:deliverableId/reject", async (request) => {
    const params = parseOrThrow(portalDeliverableParam, request.params, "Invalid ids");
    const body = parseOrThrow(portalDecisionSchema, request.body, "Invalid rejection");
    const { project, linkId } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const d = await store.findDeliverable(params.deliverableId);
    if (d?.projectId !== project.id) throw AppError.notFound("Not found");
    if (body.versionNo !== d.currentVersionNo) {
      throw AppError.unprocessable("Rejections must pin the current version.");
    }
    const status = toStatus(d.status);
    if (!canClientReview(status)) {
      throw AppError.unprocessable("This deliverable cannot be rejected in its current state.");
    }
    try {
      validateApprovalInput({ versionNo: body.versionNo, decision: "rejected", note: body.note });
    } catch {
      throw AppError.unprocessable("This deliverable cannot be rejected in its current state.");
    }
    const versionRow = await store.findDeliverableVersion(d.id, body.versionNo);
    const approverRef = `portal:${linkId}`;
    const device = deviceHashes(request);
    const approval = await store.createApproval(project.workspaceId, {
      projectId: project.id,
      milestoneId: d.milestoneId,
      deliverableId: d.id,
      ...(versionRow ? { deliverableVersionId: versionRow.id } : {}),
      versionNo: body.versionNo,
      decision: "rejected",
      approverRef,
      note: body.note.slice(0, 2000),
      actorType: "client",
      ...(device.ipHash ? { ipHash: device.ipHash } : {}),
      ...(device.uaHash ? { uaHash: device.uaHash } : {}),
    });
    await store.appendProjectEvent(project.workspaceId, project.id, {
      milestoneId: d.milestoneId,
      type: eventTypeForDecision("rejected"),
      actorType: "client",
      payload: {
        deliverableId: d.id,
        versionNo: body.versionNo,
        decision: "rejected",
        note: body.note.slice(0, 2000),
        approvalId: approval.id,
        approverRef,
      },
    });
    return {
      message: `Noted — ${d.title} (v${body.versionNo}) was marked as not approved. Your studio will follow up.`,
      approval: {
        id: approval.id,
        decision: "rejected",
        versionNo: body.versionNo,
        createdAt: approval.createdAt.toISOString(),
      },
    };
  });

  // ---- Client: dispute the current version ----
  app.post("/api/v1/portal/:projectId/deliverables/:deliverableId/dispute", async (request) => {
    const params = parseOrThrow(portalDeliverableParam, request.params, "Invalid ids");
    const body = parseOrThrow(portalDecisionSchema, request.body, "Invalid dispute");
    const { project, linkId } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      body.token,
    );
    const d = await store.findDeliverable(params.deliverableId);
    if (d?.projectId !== project.id) throw AppError.notFound("Not found");
    if (body.versionNo !== d.currentVersionNo) {
      throw AppError.unprocessable("Disputes must pin the current version.");
    }
    try {
      validateApprovalInput({ versionNo: body.versionNo, decision: "disputed", note: body.note });
    } catch {
      throw AppError.unprocessable("This deliverable cannot be disputed in its current state.");
    }
    const versionRow = await store.findDeliverableVersion(d.id, body.versionNo);
    const approverRef = `portal:${linkId}`;
    const device = deviceHashes(request);
    const approval = await store.createApproval(project.workspaceId, {
      projectId: project.id,
      milestoneId: d.milestoneId,
      deliverableId: d.id,
      ...(versionRow ? { deliverableVersionId: versionRow.id } : {}),
      versionNo: body.versionNo,
      decision: "disputed",
      approverRef,
      note: body.note.slice(0, 2000),
      actorType: "client",
      ...(device.ipHash ? { ipHash: device.ipHash } : {}),
      ...(device.uaHash ? { uaHash: device.uaHash } : {}),
    });
    await store.appendProjectEvent(project.workspaceId, project.id, {
      milestoneId: d.milestoneId,
      type: eventTypeForDecision("disputed"),
      actorType: "client",
      payload: {
        deliverableId: d.id,
        versionNo: body.versionNo,
        decision: "disputed",
        note: body.note.slice(0, 2000),
        approvalId: approval.id,
        approverRef,
      },
    });
    return {
      message: `Noted — a question was recorded on ${d.title} (v${body.versionNo}). Your studio will follow up.`,
      approval: {
        id: approval.id,
        decision: "disputed",
        versionNo: body.versionNo,
        createdAt: approval.createdAt.toISOString(),
      },
    };
  });

  // ---- Client: review-safe approval history for one deliverable ----
  app.get("/api/v1/portal/:projectId/deliverables/:deliverableId/approvals", async (request) => {
    const params = parseOrThrow(portalDeliverableParam, request.params, "Invalid ids");
    const query = parseOrThrow(
      portalListQuerySchema,
      request.query,
      "A valid portal link is required",
    );
    const { project } = await authorizePortal(
      store,
      deps.sessionSecret,
      params.projectId,
      query.token,
    );
    const d = await store.findDeliverable(params.deliverableId);
    if (d?.projectId !== project.id) throw AppError.notFound("Not found");
    const rows = await store.listApprovalsByDeliverable(d.id);
    return {
      approvals: rows.map((a) => ({
        decision: a.decision,
        versionNo: a.versionNo,
        ...(a.note !== undefined ? { note: a.note } : {}),
        createdAt: a.createdAt.toISOString(),
      })),
      currentVersionNo: d.currentVersionNo,
      ...(d.approvedVersionNo !== undefined ? { approvedVersionNo: d.approvedVersionNo } : {}),
    };
  });
}
