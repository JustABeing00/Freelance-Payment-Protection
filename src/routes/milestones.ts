import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  approveWork,
  confirmFunding,
  confirmPayout,
  createMilestone as buildMilestone,
  deriveUnlockStates,
  disputeMilestone,
  markClaimed,
  markOverdue,
  markUnlockReady,
  markViewed,
  changeMilestoneAmount,
  refundMilestone,
  releaseDeliverable,
  reorderMilestones,
  requestFunding,
  requestPayout,
  requestRevision,
  rejectWork,
  sharePreview,
  startWork,
  submitWork,
  MilestoneTransitionError,
  type MilestoneState,
} from "../domain/milestone.js";
import { assertResourceInWorkspace, requireMembership, requireWriteAccess } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import {
  changeAmountSchema,
  createMilestoneSchema,
  reorderSchema,
  transitionSchema,
  updateMilestoneSchema,
} from "../lib/milestones.js";
import type { MilestoneRecord, Store, UpdateMilestoneInput } from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Milestone engine routes (Session 05).
 * Every handler enforces the tenant gates (auth → membership → write role →
 * IDOR) and every mutation flows through `domain/milestone.ts` — the route
 * never sets state columns directly, it persists what the transition
 * function returns. Unlock states are recomputed across siblings after each
 * mutation so future milestones cannot be unlocked accidentally.
 */

const workspaceProjectParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});
const workspaceProjectMilestoneParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  milestoneId: uuidSchema,
});

function strField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function toDomain(r: MilestoneRecord): MilestoneState {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    ...(r.description !== undefined ? { description: r.description } : {}),
    amountCents: r.amountCents,
    currency: r.currency,
    orderIndex: r.orderIndex,
    ...(r.dueDate !== undefined ? { dueDate: r.dueDate } : {}),
    work: r.workState as MilestoneState["work"],
    payment: r.paymentState as MilestoneState["payment"],
    approval: r.approvalState as MilestoneState["approval"],
    deliverable: r.deliverableState as MilestoneState["deliverable"],
    unlock: r.unlockState as MilestoneState["unlock"],
    appliedPaymentIds: [...r.appliedPaymentIds],
    amountHistory: r.amountHistory.map((h) => ({
      milestoneId: strField(h.milestoneId, r.id),
      oldAmountCents: numField(h.oldAmountCents, 0),
      newAmountCents: numField(h.newAmountCents, 0),
      reason: strField(h.reason, ""),
      actorId: strField(h.actorId, ""),
      changedAt:
        h.changedAt instanceof Date
          ? h.changedAt
          : new Date(strField(h.changedAt, new Date().toISOString())),
    })),
    ...(r.approvedVersionId !== undefined
      ? { approvedVersionId: r.approvedVersionId }
      : { approvedVersionId: null }),
    ...(r.currentVersionId !== undefined
      ? { currentVersionId: r.currentVersionId }
      : { currentVersionId: null }),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toPatch(m: MilestoneState): UpdateMilestoneInput {
  return {
    workState: m.work,
    paymentState: m.payment,
    approvalState: m.approval,
    deliverableState: m.deliverable,
    unlockState: m.unlock,
    appliedPaymentIds: [...m.appliedPaymentIds],
    amountHistory: m.amountHistory.map((h) => ({
      milestoneId: h.milestoneId,
      oldAmountCents: h.oldAmountCents,
      newAmountCents: h.newAmountCents,
      reason: h.reason,
      actorId: h.actorId,
      changedAt: h.changedAt.toISOString(),
    })),
    ...(m.approvedVersionId !== null
      ? { approvedVersionId: m.approvedVersionId }
      : { approvedVersionId: null }),
    ...(m.currentVersionId !== null
      ? { currentVersionId: m.currentVersionId }
      : { currentVersionId: null }),
  };
}

function serialize(r: MilestoneRecord): Record<string, unknown> {
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    projectId: r.projectId,
    title: r.title,
    ...(r.description !== undefined ? { description: r.description } : {}),
    amountCents: r.amountCents,
    currency: r.currency,
    orderIndex: r.orderIndex,
    ...(r.dueDate ? { dueDate: r.dueDate.toISOString() } : {}),
    work: r.workState,
    payment: r.paymentState,
    approval: r.approvalState,
    deliverable: r.deliverableState,
    unlock: r.unlockState,
    appliedPaymentIds: [...r.appliedPaymentIds],
    amountHistory: r.amountHistory,
    ...(r.approvedVersionId !== undefined ? { approvedVersionId: r.approvedVersionId } : {}),
    ...(r.currentVersionId !== undefined ? { currentVersionId: r.currentVersionId } : {}),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function asAppError(err: unknown): never {
  if (err instanceof MilestoneTransitionError) {
    if (err.code === "DUPLICATE_PAYMENT") throw AppError.conflict(err.message);
    if (err.code === "SEQUENCE_VIOLATION") throw AppError.unprocessable(err.message);
    if (err.code === "AUDIT_REQUIRED") throw AppError.unprocessable(err.message);
    throw AppError.unprocessable(err.message);
  }
  throw err;
}

const EVENT_BY_ACTION: Record<string, string> = {
  request_funding: "PaymentRequested",
  mark_claimed: "PaymentClaimed",
  confirm_funding: "PaymentReceived",
  start_work: "MilestoneWorkStarted",
  submit: "MilestoneSubmitted",
  mark_viewed: "MilestoneViewed",
  request_revision: "RevisionRequested",
  approve: "MilestoneApproved",
  reject: "MilestoneApprovalRejected",
  request_payout: "PaymentRequested",
  confirm_payout: "PaymentReceived",
  mark_overdue: "PaymentOverdue",
  refund: "PaymentRefunded",
  dispute: "DisputeFlagged",
  share_preview: "DeliverablePreviewShared",
  mark_unlock_ready: "DeliverableUnlockReady",
  release: "DeliverableReleased",
};

export function registerMilestoneRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  async function loadProject(workspaceId: string, projectId: string, userId: string) {
    const membership = await store.findMembership(userId, workspaceId);
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(workspaceId, membership, project);
    return { membership, project };
  }

  async function refreshUnlocks(projectId: string): Promise<void> {
    const rows = await store.listMilestones(projectId);
    const derived = deriveUnlockStates(rows.map(toDomain));
    for (const d of derived) {
      const current = rows.find((r) => r.id === d.id);
      if (current?.unlockState !== d.unlock) {
        await store.updateMilestone(d.id, { unlockState: d.unlock });
      }
    }
  }

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const { project } = await loadProject(params.workspaceId, params.projectId, user.id);
      requireMembership(await store.findMembership(user.id, params.workspaceId));
      const membership = await store.findMembership(user.id, params.workspaceId);
      if (membership) requireWriteAccess(membership);
      const body = parseOrThrow(createMilestoneSchema, request.body, "Invalid milestone");
      if (body.currency && body.currency !== project.currency) {
        throw AppError.unprocessable("Milestone currency must match the project currency");
      }
      const siblings = await store.listMilestones(params.projectId);
      const orderIndex =
        body.orderIndex ??
        (siblings.length === 0 ? 0 : Math.max(...siblings.map((s) => s.orderIndex)) + 1);
      let domain: MilestoneState;
      try {
        domain = buildMilestone({
          projectId: params.projectId,
          title: body.title,
          ...(body.description !== undefined ? { description: body.description } : {}),
          amountCents: body.amountCents,
          currency: body.currency ?? project.currency,
          orderIndex,
          ...(body.dueDate !== undefined ? { dueDate: body.dueDate } : {}),
          ...(body.currentVersionId !== undefined
            ? { currentVersionId: body.currentVersionId }
            : {}),
        });
      } catch (err: unknown) {
        asAppError(err);
      }
      const created = await store.createMilestone(params.workspaceId, params.projectId, {
        title: domain.title,
        ...(domain.description !== undefined ? { description: domain.description } : {}),
        amountCents: domain.amountCents,
        currency: domain.currency,
        ...(domain.dueDate !== undefined ? { dueDate: domain.dueDate } : {}),
        orderIndex: domain.orderIndex,
        workState: "draft",
        paymentState: "unpaid",
        approvalState: "none",
        deliverableState: "locked",
        unlockState: domain.unlock,
        ...(domain.currentVersionId !== null ? { currentVersionId: domain.currentVersionId } : {}),
      });
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        milestoneId: created.id,
        type: "MilestoneCreated",
        actorType: "freelancer",
        actorId: user.id,
        payload: { title: created.title, amountCents: created.amountCents },
      });
      await refreshUnlocks(params.projectId);
      const fresh = (await store.findMilestone(created.id)) ?? created;
      return reply.status(201).send({ milestone: serialize(fresh) });
    },
  );

  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/milestones", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    await loadProject(params.workspaceId, params.projectId, user.id);
    const rows = await store.listMilestones(params.projectId);
    return { milestones: rows.map(serialize) };
  });

  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      await loadProject(params.workspaceId, params.projectId, user.id);
      const row = await store.findMilestone(params.milestoneId);
      if (row?.projectId !== params.projectId) throw AppError.notFound("Milestone not found");
      assertResourceInWorkspace(
        params.workspaceId,
        { userId: user.id, workspaceId: params.workspaceId, role: "owner" },
        row,
      );
      return { milestone: serialize(row) };
    },
  );

  app.patch(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      await loadProject(params.workspaceId, params.projectId, user.id);
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const row = await store.findMilestone(params.milestoneId);
      if (row?.projectId !== params.projectId) throw AppError.notFound("Milestone not found");
      assertResourceInWorkspace(params.workspaceId, membership, row);
      const body = parseOrThrow(updateMilestoneSchema, request.body, "Invalid milestone");
      // Version linkage stays editable after funding (deliverables evolve);
      // descriptive fields freeze so funded work cannot be silently re-described.
      const wantsFrozenFields =
        body.title !== undefined || body.description !== undefined || body.dueDate !== undefined;
      if ((row.paymentState === "paid" || row.paymentState === "funded") && wantsFrozenFields) {
        throw AppError.unprocessable(
          "Milestone details are frozen after funding — use the amount route with an audit reason",
        );
      }
      if (body.title !== undefined) {
        try {
          buildMilestone({
            projectId: params.projectId,
            title: body.title,
            amountCents: row.amountCents,
            currency: row.currency,
            orderIndex: row.orderIndex,
          });
        } catch (err: unknown) {
          asAppError(err);
        }
      }
      const updated = await store.updateMilestone(row.id, {
        ...(body.title !== undefined ? { title: body.title.trim() } : {}),
        ...(body.description !== undefined
          ? body.description === null
            ? { description: null }
            : { description: body.description }
          : {}),
        ...(body.dueDate !== undefined
          ? body.dueDate === null
            ? { dueDate: null }
            : { dueDate: body.dueDate }
          : {}),
        ...(body.currentVersionId !== undefined
          ? body.currentVersionId === null
            ? { currentVersionId: null }
            : { currentVersionId: body.currentVersionId }
          : {}),
        // A new version never inherits the old approval: when the freelancer
        // points the milestone at a version the client has not approved, the
        // approval dimension returns to `pending` so the database never says
        // "approved" for an undecided version. History is preserved.
        ...(body.currentVersionId !== undefined &&
        body.currentVersionId !== null &&
        body.currentVersionId !== row.currentVersionId &&
        body.currentVersionId !== row.approvedVersionId
          ? { approvalState: "pending" }
          : {}),
      });
      if (
        body.currentVersionId !== undefined &&
        body.currentVersionId !== null &&
        body.currentVersionId !== row.currentVersionId &&
        body.currentVersionId !== row.approvedVersionId
      ) {
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: row.id,
          type: "RevisionSubmitted",
          actorType: "freelancer",
          actorId: user.id,
          payload: {
            currentVersionId: body.currentVersionId,
            supersedesApprovedVersionId: row.approvedVersionId ?? null,
            note: "New version uploaded — previous approval stays true for its version only; a fresh client decision is required.",
          },
        });
      }
      return { milestone: serialize(updated) };
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/amount",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      await loadProject(params.workspaceId, params.projectId, user.id);
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const row = await store.findMilestone(params.milestoneId);
      if (row?.projectId !== params.projectId) throw AppError.notFound("Milestone not found");
      assertResourceInWorkspace(params.workspaceId, membership, row);
      const body = parseOrThrow(changeAmountSchema, request.body, "Invalid amount change");
      let next: MilestoneState;
      let auditId: string | null = null;
      try {
        const result = changeMilestoneAmount(
          toDomain(row),
          body.newAmountCents,
          body.reason ? { reason: body.reason, actorId: user.id } : null,
        );
        next = result.milestone;
        auditId = result.auditRecord ? "audited" : null;
      } catch (err: unknown) {
        asAppError(err);
      }
      const updated = await store.updateMilestone(row.id, {
        amountCents: next.amountCents,
        amountHistory: next.amountHistory.map((h) => ({
          milestoneId: h.milestoneId,
          oldAmountCents: h.oldAmountCents,
          newAmountCents: h.newAmountCents,
          reason: h.reason,
          actorId: h.actorId,
          changedAt: h.changedAt.toISOString(),
        })),
      });
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        milestoneId: row.id,
        type: "MilestoneAmountChanged",
        actorType: "freelancer",
        actorId: user.id,
        payload: {
          oldAmountCents: row.amountCents,
          newAmountCents: body.newAmountCents,
          ...(auditId ? { audited: true } : {}),
        },
      });
      return { milestone: serialize(updated) };
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/transitions",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      await loadProject(params.workspaceId, params.projectId, user.id);
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const row = await store.findMilestone(params.milestoneId);
      if (row?.projectId !== params.projectId) throw AppError.notFound("Milestone not found");
      assertResourceInWorkspace(params.workspaceId, membership, row);
      const body = parseOrThrow(transitionSchema, request.body, "Invalid transition");
      let next: MilestoneState;
      try {
        const current = toDomain(row);
        switch (body.action) {
          case "request_funding":
            next = requestFunding(current);
            break;
          case "mark_claimed":
            next = markClaimed(current);
            break;
          case "confirm_funding":
            if (!body.paymentId) throw AppError.unprocessable("paymentId is required");
            next = confirmFunding(current, body.paymentId, body.receivedCents);
            break;
          case "start_work":
            next = startWork(current);
            break;
          case "submit":
            next = submitWork(current);
            break;
          case "mark_viewed":
            next = markViewed(current);
            break;
          case "request_revision":
            next = requestRevision(current, body.note);
            break;
          case "approve": {
            const approved = body.approvedVersionId ?? row.currentVersionId ?? null;
            const live = body.currentVersionId ?? row.currentVersionId ?? "";
            if (!live) throw AppError.unprocessable("currentVersionId is required to approve");
            next = approveWork(current, { approvedVersionId: approved, currentVersionId: live });
            break;
          }
          case "reject":
            next = rejectWork(current);
            break;
          case "request_payout":
            next = requestPayout(current);
            break;
          case "confirm_payout":
            if (!body.paymentId) throw AppError.unprocessable("paymentId is required");
            next = confirmPayout(current, body.paymentId);
            break;
          case "mark_overdue":
            next = markOverdue(current);
            break;
          case "refund":
            next = refundMilestone(current);
            break;
          case "dispute":
            next = disputeMilestone(current);
            break;
          case "share_preview":
            next = sharePreview(current);
            break;
          case "mark_unlock_ready":
            next = markUnlockReady(current);
            break;
          case "release":
            next = releaseDeliverable(current);
            break;
          default:
            throw AppError.unprocessable("Unknown action");
        }
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        asAppError(err);
      }
      const updated = await store.updateMilestone(row.id, toPatch(next));
      const eventType = EVENT_BY_ACTION[body.action] ?? body.action;
      try {
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          milestoneId: row.id,
          type: eventType,
          actorType: "freelancer",
          actorId: user.id,
          ...(body.paymentId ? { idempotencyKey: `${row.id}:${body.paymentId}` } : {}),
          payload: { action: body.action },
        });
      } catch (err: unknown) {
        if (err instanceof AppError && err.code === "CONFLICT") throw err;
        throw err;
      }
      await refreshUnlocks(params.projectId);
      const fresh = (await store.findMilestone(row.id)) ?? updated;
      return { milestone: serialize(fresh) };
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/reorder",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      await loadProject(params.workspaceId, params.projectId, user.id);
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const body = parseOrThrow(reorderSchema, request.body, "Invalid reorder");
      const rows = await store.listMilestones(params.projectId);
      let reordered: MilestoneState[];
      try {
        reordered = reorderMilestones(
          rows.map(toDomain),
          body.order,
          body.reason ? { reason: body.reason, actorId: user.id } : null,
        );
      } catch (err: unknown) {
        asAppError(err);
      }
      for (const ms of reordered) {
        const current = rows.find((r) => r.id === ms.id);
        if (current && current.orderIndex !== ms.orderIndex) {
          await store.updateMilestone(ms.id, { orderIndex: ms.orderIndex });
        }
      }
      await refreshUnlocks(params.projectId);
      const fresh = await store.listMilestones(params.projectId);
      return { milestones: fresh.map(serialize) };
    },
  );
}
