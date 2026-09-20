import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AI_ASSIST_DISCLAIMER,
  AI_ASSIST_MAX_SOURCE_CHARS,
  AI_ASSIST_REVIEW_NOTE,
  checkAgreementConsistency,
  draftPaymentReminder,
  extractCommunicationEvents,
  extractContractTerms,
  summarizeEvidenceTimeline,
} from "../domain/aiAssist.js";
import { describeEvent } from "../domain/timeline.js";
import { assertResourceInWorkspace, requireMembership } from "../lib/authz.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * AI-assisted payment-protection drafts (Session 17).
 *
 * Deliberately narrow: five workflow-scoped helpers, no chatbot, no
 * generative endpoint. Every route is read-only/draft-only —
 * - pasted-text extractors never touch stored rows;
 * - the reminder drafter builds text from live DB facts and never creates a
 *   Notification row, sends mail, or appends an event;
 * - the summarizer restates the existing event trail;
 * - the consistency check recomputes contradictions from live rows.
 *
 * Every response carries `reviewRequired: true`,
 * `financialRecordsChanged: false`, the engine label, and the disclaimer.
 * Recording anything (approval, payment, reminder send, agreement edit)
 * still requires the normal flows.
 */

const workspaceProjectParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});

const sourceTextBody = z.object({
  sourceText: z.string().min(1).max(AI_ASSIST_MAX_SOURCE_CHARS),
});

const draftReminderBody = z.object({
  milestoneId: uuidSchema,
  tone: z.enum(["friendly", "firm"]).optional(),
  portalUrl: z.string().url().max(2000).optional(),
});

const summarizeBody = z.object({
  maxEvents: z.number().int().min(1).max(200).optional(),
});

const consistencyQuery = z.object({
  agreementId: uuidSchema.optional(),
});

const REVIEW_ENVELOPE = {
  reviewRequired: true as const,
  financialRecordsChanged: false as const,
  note: AI_ASSIST_REVIEW_NOTE,
  disclaimer: AI_ASSIST_DISCLAIMER,
};

async function loadProjectScoped(
  deps: RouteDeps,
  userId: string,
  workspaceId: string,
  projectId: string,
) {
  const membership = requireMembership(await deps.store.findMembership(userId, workspaceId));
  const project = await deps.store.findProject(projectId);
  if (!project) {
    const { AppError } = await import("../lib/errors.js");
    throw AppError.notFound("Project not found");
  }
  assertResourceInWorkspace(workspaceId, membership, project);
  return { membership, project };
}

export function registerAiAssistRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store = deps.store;
  const prefix = "/api/v1/workspaces/:workspaceId/projects/:projectId/ai";

  // 1. Contract/terms extraction from pasted text.
  app.post(`${prefix}/extract-terms`, async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    await loadProjectScoped(deps, user.id, params.workspaceId, params.projectId);
    const body = parseOrThrow(sourceTextBody, request.body, "Invalid source text");
    const result = extractContractTerms(body.sourceText);
    return { ...REVIEW_ENVELOPE, ...result };
  });

  // 2. Communication extraction from pasted text.
  app.post(`${prefix}/extract-communications`, async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    await loadProjectScoped(deps, user.id, params.workspaceId, params.projectId);
    const body = parseOrThrow(sourceTextBody, request.body, "Invalid source text");
    const result = extractCommunicationEvents(body.sourceText);
    return { ...REVIEW_ENVELOPE, ...result };
  });

  // 3. Reminder drafting from live project facts (amounts/dates from the DB).
  app.post(`${prefix}/draft-reminder`, async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    const { project } = await loadProjectScoped(
      deps,
      user.id,
      params.workspaceId,
      params.projectId,
    );
    const body = parseOrThrow(draftReminderBody, request.body, "Invalid draft request");

    const milestone = await store.findMilestone(body.milestoneId);
    const { AppError: MilestoneAppError } = await import("../lib/errors.js");
    if (milestone === undefined) {
      throw MilestoneAppError.notFound("Milestone not found");
    }
    if (milestone.projectId !== project.id || milestone.workspaceId !== params.workspaceId) {
      throw MilestoneAppError.notFound("Milestone not found");
    }
    const [client, payments, workspace] = await Promise.all([
      store.findClient(project.clientId),
      store.listPayments(project.id),
      store.findWorkspace(params.workspaceId),
    ]);
    const verified = payments
      .filter(
        (p) => p.milestoneId === milestone.id && ["paid", "received", "partial"].includes(p.state),
      )
      .reduce((s, p) => s + p.amountCents, 0);
    const now = new Date();
    const daysOverdue =
      milestone.dueDate && now.getTime() > milestone.dueDate.getTime()
        ? Math.floor((now.getTime() - milestone.dueDate.getTime()) / 86_400_000)
        : 0;
    const draft = draftPaymentReminder(
      {
        workspaceName: workspace?.name ?? "Freelance workflow",
        clientName: client?.name ?? "there",
        projectTitle: project.title,
        milestoneTitle: milestone.title,
        amountCents: milestone.amountCents,
        currency: milestone.currency,
        dueDateIso: milestone.dueDate
          ? milestone.dueDate.toISOString().slice(0, 10)
          : "no due date set",
        daysOverdue,
        outstandingCents: Math.max(0, milestone.amountCents - verified),
        ...(body.portalUrl !== undefined ? { portalUrl: body.portalUrl } : {}),
      },
      body.tone ?? "friendly",
    );
    return {
      ...REVIEW_ENVELOPE,
      ...draft,
      milestoneId: milestone.id,
      verifiedPaidCents: verified,
    };
  });

  // 4. Evidence summarization over the recorded trail (restatement only).
  app.post(`${prefix}/summarize`, async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    const { project } = await loadProjectScoped(
      deps,
      user.id,
      params.workspaceId,
      params.projectId,
    );
    const body = parseOrThrow(summarizeBody, request.body ?? {}, "Invalid summarize request");
    const maxEvents = body.maxEvents ?? 50;

    const milestones = await store.listMilestones(project.id);
    const titleById = new Map(milestones.map((m) => [m.id, m.title] as const));
    const events = await store.listProjectEvents(project.id, 500);
    const sliced = [...events]
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
      .slice(0, maxEvents);
    const summary = summarizeEvidenceTimeline(
      sliced.map((e) => {
        const milestoneTitle =
          e.milestoneId !== undefined ? titleById.get(e.milestoneId) : undefined;
        const described = describeEvent({
          type: e.type,
          ...(milestoneTitle !== undefined ? { milestoneTitle } : {}),
          payload: e.payload,
        });
        return {
          occurredAt: e.occurredAt,
          actorType: e.actorType,
          headline: described.headline,
          type: e.type,
        };
      }),
    );
    return {
      ...REVIEW_ENVELOPE,
      ...summary,
      truncated: events.length > sliced.length,
      totalTrailEvents: events.length,
    };
  });

  // 5. Agreement consistency check (read-only recomputation).
  app.get(`${prefix}/consistency`, async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    const { project } = await loadProjectScoped(
      deps,
      user.id,
      params.workspaceId,
      params.projectId,
    );
    const query = parseOrThrow(consistencyQuery, request.query ?? {}, "Invalid query");

    const [agreements, milestones] = await Promise.all([
      store.listAgreements(project.id),
      store.listMilestones(project.id),
    ]);
    const latest = [...agreements].sort((a, b) => b.version - a.version)[0];
    const agreement = query.agreementId
      ? (agreements.find((a) => a.id === query.agreementId) ?? null)
      : (latest ?? null);
    if (query.agreementId && !agreement) {
      const { AppError } = await import("../lib/errors.js");
      throw AppError.notFound("Agreement not found");
    }
    const report = checkAgreementConsistency({
      ...(agreement
        ? {
            agreement: {
              version: agreement.version,
              status: agreement.status,
              totalAmountCents: agreement.totalAmountCents,
              depositAmountCents: agreement.depositAmountCents,
              schedule: agreement.milestoneSchedule.map((s) => ({
                title: s.title,
                amountCents: s.amountCents,
              })),
              finalDeliveryDescription: agreement.finalDeliveryDescription,
              lateFeeKind:
                typeof agreement.latePaymentPolicy.kind === "string"
                  ? agreement.latePaymentPolicy.kind
                  : "none",
              maxRevisionsPerMilestone: agreement.maxRevisionsPerMilestone,
            },
          }
        : {}),
      milestones: milestones.map((m) => ({
        id: m.id,
        title: m.title,
        amountCents: m.amountCents,
        orderIndex: m.orderIndex,
        ...(m.dueDate !== undefined ? { dueDate: m.dueDate } : {}),
      })),
      projectTotalCents: project.totalValueCents,
    });
    return {
      ...REVIEW_ENVELOPE,
      ...report,
      ...(agreement ? { agreementId: agreement.id, agreementVersion: agreement.version } : {}),
    };
  });
}
