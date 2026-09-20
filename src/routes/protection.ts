import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PROTECTION_DISCLAIMER, buildProtectionChecks } from "../domain/protection.js";
import { assertResourceInWorkspace, requireMembership } from "../lib/authz.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Project protection / risk-awareness (Session 16).
 *
 * Read-only by design: every check is recomputed from live project data
 * (milestones, verified payments, agreements, deliverables, approvals,
 * events, payment plans) and carries its own evidence. No scores, no
 * client labels — only observable workflow conditions under
 * "Protection checks" / "Project health".
 */

const workspaceProjectParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});

export function registerProtectionRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store = deps.store;

  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/protection", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    const project = await store.findProject(params.projectId);
    if (!project) {
      const { AppError } = await import("../lib/errors.js");
      throw AppError.notFound("Project not found");
    }
    assertResourceInWorkspace(params.workspaceId, membership, project);

    const [milestones, payments, agreements, deliverables, approvals, events, plans] =
      await Promise.all([
        store.listMilestones(project.id),
        store.listPayments(project.id),
        store.listAgreements(project.id),
        store.listDeliverablesByProject(project.id),
        store.listApprovalsByProject(project.id),
        store.listProjectEvents(project.id, 500),
        store.listPaymentPlansByProject(project.id),
      ]);

    const report = buildProtectionChecks({
      project: {
        id: project.id,
        title: project.title,
        currency: project.currency,
        totalValueCents: project.totalValueCents,
        ...(project.paymentTerms !== undefined ? { paymentTerms: project.paymentTerms } : {}),
      },
      milestones: milestones.map((m) => ({
        id: m.id,
        title: m.title,
        amountCents: m.amountCents,
        ...(m.dueDate !== undefined ? { dueDate: m.dueDate } : {}),
        paymentState: m.paymentState,
        approvalState: m.approvalState,
        deliverableState: m.deliverableState,
        orderIndex: m.orderIndex,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
        amountCents: p.amountCents,
        state: p.state,
      })),
      agreements: agreements.map((a) => ({
        id: a.id,
        version: a.version,
        status: a.status,
        acceptedPaymentMethods: [...a.acceptedPaymentMethods],
      })),
      deliverables: deliverables.map((d) => ({
        id: d.id,
        milestoneId: d.milestoneId,
        title: d.title,
        status: d.status,
      })),
      approvals: approvals.map((a) => ({
        milestoneId: a.milestoneId,
        ...(a.deliverableId !== undefined ? { deliverableId: a.deliverableId } : {}),
        decision: a.decision,
      })),
      events: events.map((e) => ({
        id: e.id,
        type: e.type,
        actorType: e.actorType,
        occurredAt: e.occurredAt,
        ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
      })),
      paymentPlans: plans.map((p) => ({
        id: p.id,
        milestoneId: p.milestoneId,
        state: p.state,
        installments: p.installments.map((i) => ({
          seq: i.seq,
          amountCents: i.amountCents,
          dueDate: i.dueDate,
          status: i.status,
        })),
      })),
    });

    return {
      ...report,
      disclaimer: PROTECTION_DISCLAIMER,
      note: "Each check cites the project data behind it. There is no automated risk score.",
    };
  });
}
