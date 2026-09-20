import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  daysOverdue,
  DEFAULT_REMINDER_POLICY,
  formatAmount,
  formatDueDate,
  getTemplate,
  listTemplates,
  parseReminderPolicy,
  planReminderSchedule,
  ReminderPolicyError,
  renderTemplate,
  resolvePolicy,
  scheduleIdempotencyKey,
  sendIdempotencyKey,
  type ReminderPolicy,
} from "../domain/reminders.js";
import { assertResourceInWorkspace, requireMembership, requireWriteAccess } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import type { MembershipRecord, NotificationRecord, Store } from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Reminder + escalation engine routes (Session 12).
 *
 * No universal schedule is hard-coded: every milestone resolves an explicit
 * configurable policy (project override → workspace defaults → built-in
 * default) and the engine only schedules what that policy says.
 *
 * Safety properties (mirroring the domain module):
 * - Auditable: schedule/send/deliver/fail/retry/cancel each append a
 *   `Reminder*` project event with notification/step/template/idempotency refs.
 * - Idempotent: schedule keys are stable (`reminder:{milestone}:{step}:{day}`);
 *   repeats return the existing row with `duplicate: true`, never a resend.
 * - Retry-safe: only `queued`/`failed` rows without `canceledAt`/`sentAt` can
 *   send; every attempt bumps `attemptCount` and records `lastError`.
 * - Cancelable: `canceledAt` stops future sends without deleting history.
 * - No auto legal threats: `requiresManual` steps (escalation, work-paused)
 *   are skipped by the scheduler tick and need an explicit manual send with
 *   a jurisdiction acknowledgement. Legal language stays jurisdiction-aware
 *   and carefully framed (domain JURISDICTION_NOTICE).
 */

const workspaceParam = z.object({ workspaceId: uuidSchema });
const workspaceProjectParam = z.object({ workspaceId: uuidSchema, projectId: uuidSchema });
const workspaceProjectMilestoneParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  milestoneId: uuidSchema,
});
const workspaceReminderParam = z.object({ workspaceId: uuidSchema, reminderId: uuidSchema });

const policySchema = z.object({
  version: z.number().int().min(1),
  channel: z.literal("email"),
  enabled: z.boolean(),
  maxPerWeek: z.number().int().min(1).max(14).optional(),
  steps: z
    .array(
      z.object({
        key: z.string().min(1).max(41),
        offsetDays: z.number().int().min(-30).max(90),
        label: z.string().min(1).max(120),
        tone: z.enum(["friendly", "neutral", "firm", "escalation", "work_paused"]),
        templateKey: z.string().min(1).max(41),
        requiresManual: z.boolean().optional(),
        enabled: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(12),
});

const workspacePolicyBody = z.object({ policy: policySchema });
const projectPolicyBody = z.object({ policy: policySchema.nullable() });

const planBody = z.object({
  anchorDate: z.string().datetime().optional(),
  portalUrl: z.string().url().max(2000).optional(),
});

const manualSendBody = z.object({
  jurisdiction: z.string().trim().min(2).max(80).optional(),
  acknowledgeManualStep: z.boolean().optional(),
  portalUrl: z.string().url().max(2000).optional(),
  freelancerName: z.string().trim().max(120).optional(),
});

const runDueBody = z.object({
  now: z.string().datetime().optional(),
});

const TERMINAL_PAYMENT_STATES = new Set(["paid", "funded", "refunded"]);
const PAUSED_PAYMENT_STATES = new Set(["disputed"]);

function toPolicy(input: z.infer<typeof policySchema>): ReminderPolicy {
  return {
    version: input.version,
    channel: input.channel,
    enabled: input.enabled,
    ...(input.maxPerWeek !== undefined ? { maxPerWeek: input.maxPerWeek } : {}),
    steps: input.steps.map((s) => ({ ...s })),
  };
}

function asAppError(err: unknown): never {
  if (err instanceof ReminderPolicyError) throw AppError.unprocessable(err.message);
  throw err;
}

function serialize(n: NotificationRecord): Record<string, unknown> {
  return {
    id: n.id,
    workspaceId: n.workspaceId,
    ...(n.projectId !== undefined ? { projectId: n.projectId } : {}),
    ...(n.milestoneId !== undefined ? { milestoneId: n.milestoneId } : {}),
    channel: n.channel,
    template: n.template,
    templateVersion: n.templateVersion,
    ...(n.subject !== undefined ? { subject: n.subject } : {}),
    recipient: n.recipient,
    ...(n.recipientName !== undefined ? { recipientName: n.recipientName } : {}),
    state: n.state,
    ...(n.providerMessageId !== undefined ? { providerMessageId: n.providerMessageId } : {}),
    scheduled_at: n.scheduledFor.toISOString(),
    ...(n.sentAt !== undefined ? { sent_at: n.sentAt.toISOString() } : {}),
    ...(n.deliveredAt !== undefined ? { deliveredAt: n.deliveredAt.toISOString() } : {}),
    ...(n.canceledAt !== undefined ? { canceledAt: n.canceledAt.toISOString() } : {}),
    attemptCount: n.attemptCount,
    ...(n.lastError !== undefined ? { result_error: n.lastError } : {}),
    ...(n.nextActionAt !== undefined
      ? { next_scheduled_action_at: n.nextActionAt.toISOString() }
      : {}),
    ...(n.nextActionLabel !== undefined ? { next_scheduled_action: n.nextActionLabel } : {}),
    trigger: n.trigger,
    ...(n.policyStep !== undefined ? { policyStep: n.policyStep } : {}),
    ...(n.policyVersion !== undefined ? { policyVersion: n.policyVersion } : {}),
    ...(n.idempotencyKey !== undefined ? { idempotencyKey: n.idempotencyKey } : {}),
    createdAt: n.createdAt.toISOString(),
  };
}

function summarize(rows: readonly NotificationRecord[]): Record<string, unknown> {
  const pending = rows.filter((r) => r.state === "queued" && !r.canceledAt && !r.sentAt);
  const upcoming = [...pending].sort(
    (a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime(),
  )[0];
  return {
    total: rows.length,
    pendingCount: pending.length,
    sentCount: rows.filter((r) => r.sentAt !== undefined).length,
    failedCount: rows.filter((r) => r.state === "failed").length,
    canceledCount: rows.filter((r) => r.canceledAt !== undefined).length,
    ...(upcoming
      ? {
          nextScheduledAction: {
            notificationId: upcoming.id,
            scheduled_at: upcoming.scheduledFor.toISOString(),
            template: upcoming.template,
            ...(upcoming.nextActionLabel !== undefined ? { label: upcoming.nextActionLabel } : {}),
          },
        }
      : { nextScheduledAction: null }),
    handlingNote:
      pending.length > 0
        ? "The system is handling this — the next reminder is scheduled."
        : "No pending reminders — the sequence is complete or paused for review.",
  };
}

export function registerReminderRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  async function loadProjectScoped(workspaceId: string, projectId: string, userId: string) {
    const membership = requireMembership(await store.findMembership(userId, workspaceId));
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(workspaceId, membership, project);
    return { membership, project };
  }

  async function loadMilestoneScoped(
    workspaceId: string,
    projectId: string,
    milestoneId: string,
    userId: string,
  ) {
    const { membership, project } = await loadProjectScoped(workspaceId, projectId, userId);
    const milestone = await store.findMilestone(milestoneId);
    if (milestone?.projectId !== projectId) {
      throw AppError.notFound("Milestone not found");
    }
    if (milestone.workspaceId !== workspaceId) throw AppError.forbidden();
    return { membership, project, milestone };
  }

  async function effectivePolicy(
    workspaceId: string,
    projectId: string,
  ): Promise<{
    policy: ReminderPolicy;
    source: "project" | "workspace" | "default";
  }> {
    const [workspace, project] = await Promise.all([
      store.findWorkspace(workspaceId),
      store.findProject(projectId),
    ]);
    const workspaceDefaults = workspace?.reminderDefaults;
    const projectOverride = project?.reminderPolicy;
    const hasProject = projectOverride !== undefined && Object.keys(projectOverride).length > 0;
    const hasWorkspace =
      workspaceDefaults !== undefined && Object.keys(workspaceDefaults).length > 0;
    try {
      const policy = resolvePolicy({
        workspaceDefaults: workspaceDefaults ?? {},
        projectOverride: projectOverride ?? {},
      });
      return { policy, source: hasProject ? "project" : hasWorkspace ? "workspace" : "default" };
    } catch (err: unknown) {
      asAppError(err);
    }
  }

  function resolveAnchor(
    milestone: { dueDate?: Date | undefined },
    body: { anchorDate?: string | undefined },
  ): Date {
    if (body.anchorDate !== undefined) return new Date(body.anchorDate);
    if (milestone.dueDate) return milestone.dueDate;
    throw AppError.unprocessable(
      "This milestone has no due date — pass anchorDate (ISO datetime) or set the milestone due date first",
    );
  }

  async function audit(
    workspaceId: string,
    projectId: string,
    type: string,
    milestoneId: string | undefined,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    actorId?: string,
  ): Promise<void> {
    try {
      await store.appendProjectEvent(workspaceId, projectId, {
        ...(milestoneId !== undefined ? { milestoneId } : {}),
        type,
        actorType: "system",
        ...(actorId !== undefined ? { actorId } : {}),
        payload,
        idempotencyKey,
      });
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === "CONFLICT") return;
      throw err;
    }
  }

  // Readable catalogue of editable professional templates (versioned).
  app.get("/api/v1/reminder-templates", async (request) => {
    await requireAuth(request, deps);
    return { version: "v1", templates: listTemplates() };
  });

  // Workspace-level configurable defaults.
  app.get("/api/v1/workspaces/:workspaceId/reminder-policy", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid ids");
    requireMembership(await store.findMembership(user.id, params.workspaceId));
    const workspace = await store.findWorkspace(params.workspaceId);
    if (!workspace) throw AppError.notFound("Workspace not found");
    try {
      const policy = parseReminderPolicy(workspace.reminderDefaults ?? {});
      return { policy, source: "workspace" };
    } catch (err: unknown) {
      asAppError(err);
    }
  });

  app.put("/api/v1/workspaces/:workspaceId/reminder-policy", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid ids");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    requireWriteAccess(membership);
    const body = parseOrThrow(workspacePolicyBody, request.body, "Invalid reminder policy");
    const policy = toPolicy(body.policy);
    try {
      parseReminderPolicy(policy);
    } catch (err: unknown) {
      asAppError(err);
    }
    const updated = await store.updateWorkspaceReminderDefaults(params.workspaceId, {
      policy: { ...policy, steps: policy.steps.map((s) => ({ ...s })) },
    });
    try {
      return { policy: parseReminderPolicy(updated.reminderDefaults ?? {}), source: "workspace" };
    } catch (err: unknown) {
      asAppError(err);
    }
  });

  // Per-project effective + override policy.
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/reminders/policy",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      await loadProjectScoped(params.workspaceId, params.projectId, user.id);
      return await effectivePolicy(params.workspaceId, params.projectId);
    },
  );

  app.put(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/reminders/policy",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const { membership } = await loadProjectScoped(params.workspaceId, params.projectId, user.id);
      requireWriteAccess(membership);
      const body = parseOrThrow(projectPolicyBody, request.body, "Invalid reminder policy");
      if (body.policy === null) {
        const updated = await store.updateProject(params.projectId, { reminderPolicy: {} });
        return {
          policy: { ...DEFAULT_REMINDER_POLICY },
          source: "default",
          cleared: true,
          updatedAt: updated.updatedAt.toISOString(),
        };
      }
      const policy = toPolicy(body.policy);
      try {
        parseReminderPolicy(policy);
      } catch (err: unknown) {
        asAppError(err);
      }
      const updated = await store.updateProject(params.projectId, {
        reminderPolicy: { ...policy, steps: policy.steps.map((s) => ({ ...s })) },
      });
      return {
        policy,
        source: "project",
        updatedAt: updated.updatedAt.toISOString(),
      };
    },
  );

  // Dry-run preview: what WOULD be scheduled (no rows written).
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/reminders/plan",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      const { milestone } = await loadMilestoneScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        user.id,
      );
      const body = parseOrThrow(planBody, request.body ?? {}, "Invalid plan input");
      const { policy, source } = await effectivePolicy(params.workspaceId, params.projectId);
      const anchor = resolveAnchor(milestone, body);
      const planned = planReminderSchedule({ dueDate: anchor, policy });
      return {
        policySource: source,
        policyVersion: policy.version,
        anchorDate: anchor.toISOString(),
        planned: planned.map((p) => ({
          stepKey: p.stepKey,
          offsetDays: p.offsetDays,
          label: p.label,
          tone: p.tone,
          templateKey: p.templateKey,
          requiresManual: p.requiresManual,
          scheduledAt: p.scheduledAt.toISOString(),
          idempotencyKey: scheduleIdempotencyKey({
            milestoneId: milestone.id,
            stepKey: p.stepKey,
            scheduledAt: p.scheduledAt,
          }),
        })),
      };
    },
  );

  // Schedule the resolved policy for one milestone (idempotent per step).
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/reminders/schedule",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      const { membership, project, milestone } = await loadMilestoneScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        user.id,
      );
      requireWriteAccess(membership);
      const body = parseOrThrow(planBody, request.body ?? {}, "Invalid schedule input");
      if (TERMINAL_PAYMENT_STATES.has(milestone.paymentState)) {
        throw AppError.unprocessable(
          `Milestone is ${milestone.paymentState} — reminders stop when verified payment lands`,
        );
      }
      if (PAUSED_PAYMENT_STATES.has(milestone.paymentState)) {
        throw AppError.unprocessable(
          "Milestone is disputed — resolve the dispute before scheduling reminders",
        );
      }
      const { policy, source } = await effectivePolicy(params.workspaceId, params.projectId);
      if (!policy.enabled) {
        throw AppError.unprocessable("Reminder policy is disabled for this project");
      }
      const anchor = resolveAnchor(milestone, body);
      const client = await store.findClient(project.clientId);
      const recipient = client?.billingEmail ?? client?.email ?? "";
      if (!recipient) throw AppError.unprocessable("Client has no email to remind");
      const planned = planReminderSchedule({ dueDate: anchor, policy });
      const scheduled: Record<string, unknown>[] = [];
      const duplicates: Record<string, unknown>[] = [];
      let previous: NotificationRecord | undefined;
      for (const step of planned) {
        const idempotencyKey = scheduleIdempotencyKey({
          milestoneId: milestone.id,
          stepKey: step.stepKey,
          scheduledAt: step.scheduledAt,
        });
        const existing = await store.findNotificationByIdempotencyKey(idempotencyKey);
        if (existing) {
          duplicates.push({ ...serialize(existing), duplicate: true });
          previous = existing;
          continue;
        }
        try {
          const created = await store.createNotification(params.workspaceId, {
            projectId: params.projectId,
            milestoneId: milestone.id,
            template: step.templateKey,
            templateVersion: "v1",
            recipient,
            ...(client?.name ? { recipientName: client.name } : {}),
            scheduledFor: step.scheduledAt,
            trigger: "schedule",
            policyStep: step.stepKey,
            policyVersion: policy.version,
            idempotencyKey,
          });
          // Chain the previous row forward so every row carries its next action.
          if (previous && !previous.nextActionAt) {
            await store.updateNotification(previous.id, {
              nextActionAt: created.scheduledFor,
              nextActionLabel: `Next: ${created.policyStep ?? created.template}`,
            });
          }
          previous = created;
          await audit(
            params.workspaceId,
            params.projectId,
            "ReminderScheduled",
            milestone.id,
            {
              notificationId: created.id,
              stepKey: step.stepKey,
              template: step.templateKey,
              templateVersion: "v1",
              scheduledFor: created.scheduledFor.toISOString(),
              recipient,
            },
            `reminder-schedule:${idempotencyKey}`,
            user.id,
          );
          scheduled.push(serialize(created));
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === "CONFLICT") {
            const raced = await store.findNotificationByIdempotencyKey(idempotencyKey);
            if (raced) duplicates.push({ ...serialize(raced), duplicate: true });
            continue;
          }
          throw err;
        }
      }
      // Point the final step at completion so the UX can say "sequence complete".
      if (scheduled.length > 0) {
        const lastItem = scheduled[scheduled.length - 1] as { id: string };
        const current = await store.findNotificationById(lastItem.id);
        if (current && !current.nextActionAt && !current.nextActionLabel) {
          const updated = await store.updateNotification(current.id, {
            nextActionLabel: "Last scheduled step — manual escalation follows if still unpaid",
          });
          scheduled[scheduled.length - 1] = serialize(updated);
        }
      }
      return await reply.status(201).send({
        policySource: source,
        policyVersion: policy.version,
        anchorDate: anchor.toISOString(),
        scheduled,
        duplicates,
      });
    },
  );

  async function deliver(
    notification: NotificationRecord,
    args: {
      workspaceName: string;
      projectTitle: string;
      milestoneTitle: string;
      amountCents: number;
      currency: string;
      dueDate: Date;
      now: Date;
      clientName: string;
      jurisdiction?: string | undefined;
      acknowledgeManualStep?: boolean | undefined;
      portalUrl?: string | undefined;
      freelancerName?: string | undefined;
      actorId?: string | undefined;
    },
  ): Promise<{ row: NotificationRecord; duplicate: boolean }> {
    if (notification.canceledAt) {
      throw AppError.unprocessable("Reminder was canceled — duplicate the schedule to send again");
    }
    if (notification.sentAt) {
      return { row: notification, duplicate: true };
    }
    const template = getTemplate(notification.template);
    if (template.requiresManual && args.acknowledgeManualStep !== true) {
      throw AppError.unprocessable(
        `Template "${template.key}" is manual-only (escalation language is never automatic) — resend with acknowledgeManualStep=true`,
      );
    }
    if (
      (template.tone === "escalation" || template.tone === "work_paused") &&
      (args.jurisdiction === undefined || args.jurisdiction.trim().length < 2)
    ) {
      throw AppError.unprocessable(
        "Escalation language is jurisdiction-aware — pass jurisdiction (e.g. client country/region) and acknowledgeManualStep=true to send manually",
      );
    }
    const rendered = renderTemplate(
      { subject: template.subject, body: template.body },
      {
        workspaceName: args.workspaceName,
        clientName: args.clientName,
        projectTitle: args.projectTitle,
        milestoneTitle: args.milestoneTitle,
        amount: formatAmount(args.amountCents),
        currency: args.currency.toUpperCase(),
        dueDate: formatDueDate(args.dueDate),
        daysOverdue: String(daysOverdue(args.dueDate, args.now)),
        portalUrl: args.portalUrl ?? "your client portal link",
        jurisdiction: args.jurisdiction?.trim() ?? "",
        freelancerName: args.freelancerName ?? args.workspaceName,
      },
    );
    const provider = deps.emailProvider;
    if (!provider) throw AppError.internal("Email provider is not configured");
    const attemptCount = notification.attemptCount + 1;
    try {
      const sent = await provider.send({
        to: notification.recipient,
        subject: rendered.subject,
        text: rendered.body,
      });
      const updated = await store.updateNotification(notification.id, {
        state: "sent",
        providerMessageId: sent.providerMessageId,
        sentAt: args.now,
        deliveredAt: args.now,
        attemptCount,
        lastError: null,
        subject: rendered.subject,
        bodySnapshot: rendered.body,
        nextActionLabel: "Sent — next step follows the policy schedule",
      });
      await audit(
        notification.workspaceId,
        notification.projectId ?? "",
        "ReminderSent",
        notification.milestoneId,
        {
          notificationId: notification.id,
          stepKey: notification.policyStep ?? notification.template,
          template: notification.template,
          templateVersion: notification.templateVersion,
          recipient: notification.recipient,
          providerMessageId: sent.providerMessageId,
        },
        sendIdempotencyKey(notification.id),
        args.actorId,
      );
      await audit(
        notification.workspaceId,
        notification.projectId ?? "",
        "ReminderDelivered",
        notification.milestoneId,
        {
          notificationId: notification.id,
          stepKey: notification.policyStep ?? notification.template,
          providerMessageId: sent.providerMessageId,
        },
        `reminder-delivered:${notification.id}`,
        args.actorId,
      );
      return { row: updated, duplicate: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "delivery failed";
      const updated = await store.updateNotification(notification.id, {
        state: "failed",
        attemptCount,
        lastError: message.slice(0, 500),
        nextActionLabel: "Delivery failed — safe to retry",
      });
      await audit(
        notification.workspaceId,
        notification.projectId ?? "",
        "ReminderFailed",
        notification.milestoneId,
        {
          notificationId: notification.id,
          stepKey: notification.policyStep ?? notification.template,
          template: notification.template,
          templateVersion: notification.templateVersion,
          error: message.slice(0, 500),
          attemptCount,
        },
        `reminder-failed:${notification.id}:${attemptCount}`,
        args.actorId,
      );
      throw new AppError(
        "PROVIDER_ERROR",
        `Reminder delivery failed (attempt ${attemptCount}) — safe to retry`,
        { notificationId: updated.id },
      );
    }
  }

  async function loadNotificationScoped(
    workspaceId: string,
    reminderId: string,
    userId: string,
  ): Promise<{ membership: MembershipRecord; notification: NotificationRecord }> {
    const membership = requireMembership(await store.findMembership(userId, workspaceId));
    const notification = await store.findNotificationById(reminderId);
    if (!notification) throw AppError.notFound("Reminder not found");
    assertResourceInWorkspace(workspaceId, membership, notification);
    return { membership, notification };
  }

  async function contextFor(
    notification: NotificationRecord,
    workspaceId: string,
  ): Promise<{
    workspaceName: string;
    projectTitle: string;
    milestoneTitle: string;
    amountCents: number;
    currency: string;
    dueDate: Date;
    clientName: string;
  }> {
    const workspace = await store.findWorkspace(workspaceId);
    const projectId = notification.projectId ?? "";
    const project = projectId ? await store.findProject(projectId) : undefined;
    const milestoneId = notification.milestoneId ?? "";
    const milestone = milestoneId ? await store.findMilestone(milestoneId) : undefined;
    const client = project ? await store.findClient(project.clientId) : undefined;
    return {
      workspaceName: workspace?.name ?? "Workspace",
      projectTitle: project?.title ?? "Project",
      milestoneTitle: milestone?.title ?? "Milestone",
      amountCents: milestone?.amountCents ?? 0,
      currency: milestone?.currency ?? project?.currency ?? "USD",
      dueDate: milestone?.dueDate ?? new Date(),
      clientName: client?.name ?? notification.recipientName ?? "there",
    };
  }

  // Milestone-scoped audit view: scheduled_at / sent_at / delivery / recipient
  // / template+version / result-error / next action, plus a handling summary.
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/reminders",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      await loadMilestoneScoped(params.workspaceId, params.projectId, params.milestoneId, user.id);
      const rows = await store.listNotificationsByMilestone(params.milestoneId);
      const scoped = rows.filter((r) => r.workspaceId === params.workspaceId);
      return { reminders: scoped.map(serialize), summary: summarize(scoped) };
    },
  );

  // Project command view: "the system is handling this" across milestones.
  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/reminders", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    await loadProjectScoped(params.workspaceId, params.projectId, user.id);
    const rows = await store.listNotificationsByProject(params.projectId);
    const scoped = rows.filter((r) => r.workspaceId === params.workspaceId);
    return { reminders: scoped.map(serialize), summary: summarize(scoped) };
  });

  // Manual send (also the only path for manual-only escalation steps).
  app.post("/api/v1/workspaces/:workspaceId/reminders/:reminderId/send", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceReminderParam, request.params, "Invalid ids");
    const { membership, notification } = await loadNotificationScoped(
      params.workspaceId,
      params.reminderId,
      user.id,
    );
    requireWriteAccess(membership);
    const body = parseOrThrow(manualSendBody, request.body ?? {}, "Invalid send input");
    const ctx = await contextFor(notification, params.workspaceId);
    const { row, duplicate } = await deliver(notification, {
      workspaceName: ctx.workspaceName,
      projectTitle: ctx.projectTitle,
      milestoneTitle: ctx.milestoneTitle,
      amountCents: ctx.amountCents,
      currency: ctx.currency,
      dueDate: ctx.dueDate,
      now: new Date(),
      clientName: ctx.clientName,
      ...(body.jurisdiction !== undefined ? { jurisdiction: body.jurisdiction } : {}),
      ...(body.acknowledgeManualStep !== undefined
        ? { acknowledgeManualStep: body.acknowledgeManualStep }
        : {}),
      ...(body.portalUrl !== undefined ? { portalUrl: body.portalUrl } : {}),
      ...(body.freelancerName !== undefined ? { freelancerName: body.freelancerName } : {}),
      actorId: user.id,
    });
    return { reminder: serialize(row), ...(duplicate ? { duplicate: true } : {}) };
  });

  // Retry-safe resend of a failed automation.
  app.post("/api/v1/workspaces/:workspaceId/reminders/:reminderId/retry", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceReminderParam, request.params, "Invalid ids");
    const { membership, notification } = await loadNotificationScoped(
      params.workspaceId,
      params.reminderId,
      user.id,
    );
    requireWriteAccess(membership);
    if (notification.sentAt) {
      return { reminder: serialize(notification), duplicate: true };
    }
    if (notification.state !== "failed") {
      throw AppError.unprocessable(
        "Only failed reminders can be retried — queued rows send via run-due",
      );
    }
    const body = parseOrThrow(manualSendBody, request.body ?? {}, "Invalid retry input");
    const ctx = await contextFor(notification, params.workspaceId);
    const { row } = await deliver(notification, {
      workspaceName: ctx.workspaceName,
      projectTitle: ctx.projectTitle,
      milestoneTitle: ctx.milestoneTitle,
      amountCents: ctx.amountCents,
      currency: ctx.currency,
      dueDate: ctx.dueDate,
      now: new Date(),
      clientName: ctx.clientName,
      ...(body.jurisdiction !== undefined ? { jurisdiction: body.jurisdiction } : {}),
      ...(body.acknowledgeManualStep !== undefined
        ? { acknowledgeManualStep: body.acknowledgeManualStep }
        : {}),
      ...(body.portalUrl !== undefined ? { portalUrl: body.portalUrl } : {}),
      ...(body.freelancerName !== undefined ? { freelancerName: body.freelancerName } : {}),
      actorId: user.id,
    });
    return { reminder: serialize(row), retried: true };
  });

  // Cancelable: stop future sends without deleting history.
  app.post("/api/v1/workspaces/:workspaceId/reminders/:reminderId/cancel", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceReminderParam, request.params, "Invalid ids");
    const { membership, notification } = await loadNotificationScoped(
      params.workspaceId,
      params.reminderId,
      user.id,
    );
    requireWriteAccess(membership);
    if (notification.sentAt) {
      throw AppError.unprocessable("Reminder already sent — it cannot be canceled");
    }
    if (notification.canceledAt) {
      return { reminder: serialize(notification), duplicate: true };
    }
    const updated = await store.updateNotification(notification.id, {
      canceledAt: new Date(),
      nextActionAt: null,
      nextActionLabel: "Canceled — no further automatic sends",
    });
    await audit(
      params.workspaceId,
      notification.projectId ?? "",
      "ReminderCancelled",
      notification.milestoneId,
      {
        notificationId: notification.id,
        stepKey: notification.policyStep ?? notification.template,
        template: notification.template,
      },
      `reminder-cancel:${notification.id}`,
      user.id,
    );
    return { reminder: serialize(updated), canceled: true };
  });

  // Scheduler tick: send what is due. Manual-only steps are NEVER auto-sent.
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/reminders/run-due",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const { membership } = await loadProjectScoped(params.workspaceId, params.projectId, user.id);
      requireWriteAccess(membership);
      const body = parseOrThrow(runDueBody, request.body ?? {}, "Invalid run input");
      const now = body.now !== undefined ? new Date(body.now) : new Date();
      const rows = await store.listNotificationsByProject(params.projectId);
      const scoped = rows.filter((r) => r.workspaceId === params.workspaceId);
      const sent: Record<string, unknown>[] = [];
      const failed: Record<string, unknown>[] = [];
      const skippedManual: Record<string, unknown>[] = [];
      const canceledStale: Record<string, unknown>[] = [];
      for (const row of scoped) {
        if (row.sentAt || row.canceledAt || row.state !== "queued") continue;
        if (row.scheduledFor.getTime() > now.getTime()) continue;
        let templateManual = false;
        try {
          templateManual = getTemplate(row.template).requiresManual;
        } catch {
          templateManual = false;
        }
        if (templateManual) {
          skippedManual.push({ ...serialize(row), reason: "manual-only step needs explicit send" });
          continue;
        }
        const milestone = row.milestoneId ? await store.findMilestone(row.milestoneId) : undefined;
        if (milestone && TERMINAL_PAYMENT_STATES.has(milestone.paymentState)) {
          const canceled = await store.updateNotification(row.id, {
            canceledAt: now,
            nextActionAt: null,
            nextActionLabel: "Auto-canceled — milestone paid",
          });
          await audit(
            params.workspaceId,
            params.projectId,
            "ReminderCancelled",
            row.milestoneId,
            {
              notificationId: row.id,
              stepKey: row.policyStep ?? row.template,
              reason: `milestone ${milestone.paymentState}`,
            },
            `reminder-cancel:${row.id}`,
            user.id,
          );
          canceledStale.push(serialize(canceled));
          continue;
        }
        const ctx = await contextFor(row, params.workspaceId);
        try {
          const { row: updated } = await deliver(row, {
            workspaceName: ctx.workspaceName,
            projectTitle: ctx.projectTitle,
            milestoneTitle: ctx.milestoneTitle,
            amountCents: ctx.amountCents,
            currency: ctx.currency,
            dueDate: ctx.dueDate,
            now,
            clientName: ctx.clientName,
            actorId: user.id,
          });
          sent.push(serialize(updated));
        } catch {
          const fresh = await store.findNotificationById(row.id);
          failed.push({
            ...(fresh ? serialize(fresh) : serialize(row)),
            reason: "delivery failed — safe to retry",
          });
        }
      }
      const remaining = await store.listNotificationsByProject(params.projectId);
      return {
        sent,
        failed,
        skippedManual,
        canceledStale,
        summary: summarize(remaining.filter((r) => r.workspaceId === params.workspaceId)),
      };
    },
  );
}
