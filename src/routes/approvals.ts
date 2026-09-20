import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { deriveApprovalEffect, type ApprovalDecision } from "../domain/approvals.js";
import { assertResourceInWorkspace } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import type { ApprovalRecord, Store } from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Formal client approval history (Session 11).
 *
 * Approvals are append-only decision events pinned to ONE version. These
 * read-only freelancer endpoints expose the full audit trail plus the
 * effective state, so "approved" is never ambiguous:
 *
 * - every row carries who (approverRef + actor), what (milestone +
 *   deliverable), which version (versionNo / versionRef), when (createdAt),
 *   the decision, and an optional note;
 * - `effective` derives whether the CURRENT version is approved from history
 *   (old-version approvals stay true for their version but never authorize a
 *   newer one);
 * - device metadata is hashed (ipHash/uaHash) — raw IPs never leave the DB,
 *   and these endpoints never return them to anyone except as presence flags.
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

function serializeApproval(a: ApprovalRecord): Record<string, unknown> {
  return {
    id: a.id,
    milestoneId: a.milestoneId,
    ...(a.deliverableId !== undefined ? { deliverableId: a.deliverableId } : {}),
    ...(a.deliverableVersionId !== undefined
      ? { deliverableVersionId: a.deliverableVersionId }
      : {}),
    ...(a.versionNo !== undefined ? { versionNo: a.versionNo } : {}),
    ...(a.versionRef !== undefined ? { versionRef: a.versionRef } : {}),
    decision: a.decision,
    ...(a.note !== undefined ? { note: a.note } : {}),
    approverRef: a.approverRef,
    actorType: a.actorType,
    ...(a.actorId !== undefined ? { actorId: a.actorId } : {}),
    createdAt: a.createdAt.toISOString(),
  };
}

function toEventHistory(rows: readonly ApprovalRecord[]): {
  id: string;
  decision: ApprovalDecision;
  versionNo?: number | undefined;
  versionRef?: string | undefined;
  createdAt: Date;
}[] {
  return rows.map((r) => ({
    id: r.id,
    decision: r.decision,
    ...(r.versionNo !== undefined ? { versionNo: r.versionNo } : {}),
    ...(r.versionRef !== undefined ? { versionRef: r.versionRef } : {}),
    createdAt: r.createdAt,
  }));
}

export function registerApprovalRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  // ---- Freelancer: full audit trail for one deliverable ----
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/deliverables/:deliverableId/approvals",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectDeliverableParam, request.params, "Invalid ids");
      const membership = await store.findMembership(user.id, params.workspaceId);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const deliverable = await store.findDeliverable(params.deliverableId);
      if (deliverable?.projectId !== params.projectId) {
        throw AppError.notFound("Deliverable not found");
      }
      assertResourceInWorkspace(params.workspaceId, membership, deliverable);
      const rows = await store.listApprovalsByDeliverable(deliverable.id);
      const effect = deriveApprovalEffect(toEventHistory(rows), {
        versionNo: deliverable.currentVersionNo,
      });
      return {
        approvals: rows.map(serializeApproval),
        effective: {
          currentVersionNo: deliverable.currentVersionNo,
          ...(deliverable.approvedVersionNo !== undefined
            ? { approvedVersionNo: deliverable.approvedVersionNo }
            : {}),
          isCurrent: effect.isCurrent,
          isApproved: effect.isApproved,
          reason: effect.reason,
          latest: effect.latest
            ? {
                decision: effect.latest.decision,
                ...(effect.latest.versionNo !== undefined
                  ? { versionNo: effect.latest.versionNo }
                  : {}),
                createdAt: effect.latest.createdAt.toISOString(),
              }
            : null,
        },
      };
    },
  );

  // ---- Freelancer: full audit trail for one milestone ----
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/approvals",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      const membership = await store.findMembership(user.id, params.workspaceId);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const milestone = await store.findMilestone(params.milestoneId);
      if (milestone?.projectId !== params.projectId) {
        throw AppError.notFound("Milestone not found");
      }
      assertResourceInWorkspace(params.workspaceId, membership, milestone);
      const rows = await store.listApprovalsByMilestone(milestone.id);
      const effect = deriveApprovalEffect(
        toEventHistory(rows),
        milestone.currentVersionId !== undefined
          ? { versionRef: milestone.currentVersionId }
          : { versionNo: 0 },
      );
      return {
        approvals: rows.map(serializeApproval),
        effective: {
          ...(milestone.currentVersionId !== undefined
            ? { currentVersionId: milestone.currentVersionId }
            : {}),
          ...(milestone.approvedVersionId !== undefined
            ? { approvedVersionId: milestone.approvedVersionId }
            : {}),
          isCurrent: effect.isCurrent,
          isApproved: effect.isApproved,
          reason: effect.reason,
        },
      };
    },
  );
}
