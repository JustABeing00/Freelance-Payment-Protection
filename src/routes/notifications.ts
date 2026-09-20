import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CATEGORY_BY_KIND,
  isKnownCategory,
  MAX_DELIVERY_ATTEMPTS,
  maySendOverdue,
  NOTIFICATION_CATEGORIES,
  utcDay,
  type NotificationKind,
} from "../domain/notifications.js";
import { formatAmount, formatDueDate } from "../domain/reminders.js";
import {
  assertResourceInWorkspace,
  normalizeEmail,
  requireMembership,
  requireWriteAccess,
} from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import { NotificationService } from "../lib/notify.js";
import type { NotificationRecord, Store } from "../lib/store.js";
import { verifyUnsubscribeToken } from "../lib/unsubscribe.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Production-grade notification center (Session 18).
 *
 * One reliable abstraction for every transactional notice — payments,
 * approvals, overdue, pauses, payment plans, deliverable releases — over
 * email + in-app:
 * - Idempotent queueing (`notify:<kind>:<scope>:<dedupe>` UNIQUE): repeats
 *   return `duplicate: true`, never a second send.
 * - Paid-stop: overdue/payment mail is never queued or sent for settled
 *   milestones (`paid`/`funded`/`refunded`); disputes pause it too.
 * - Retry-safe: attempts, last error and exponential next-retry are recorded
 *   per row; the outbox tick (`dispatch-due`) only attempts rows that are due.
 * - Preference-aware: per-user category×channel prefs + client opt-outs
 *   (signed unsubscribe tokens, no login required) gate every send.
 * - Auditable: queue/send/fail/retry/cancel/read each carry delivery status;
 *   lifecycle hooks append a `NotificationQueued` project event.
 */

const workspaceParam = z.object({ workspaceId: uuidSchema });
const workspaceNotificationParam = z.object({
  workspaceId: uuidSchema,
  notificationId: uuidSchema,
});
const workspaceProjectParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});

const inboxQuery = z.object({
  channel: z.enum(["email", "inapp"]).optional(),
  category: z.string().max(40).optional(),
  state: z.enum(["queued", "sent", "delivered", "failed", "bounced"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const preferencesBody = z.object({
  preferences: z
    .array(
      z.object({
        category: z.string().min(1).max(40),
        channel: z.enum(["email", "inapp"]),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(14),
});

const optOutBody = z.object({
  email: z.string().email("must be a valid email").max(254),
  category: z.string().min(1).max(40),
});

const optOutDeleteBody = z.object({
  email: z.string().email("must be a valid email").max(254),
  category: z.string().min(1).max(40),
});

const tickBody = z.object({
  now: z.string().datetime().optional(),
  portalUrl: z.string().url().max(2000).optional(),
  detail: z.string().trim().max(500).optional(),
});

const unsubscribeBody = z.object({ token: z.string().min(10).max(2000) });

function serialize(n: NotificationRecord): Record<string, unknown> {
  const attemptsLeft = Math.max(0, MAX_DELIVERY_ATTEMPTS - n.attemptCount);
  return {
    id: n.id,
    workspaceId: n.workspaceId,
    ...(n.projectId !== undefined ? { projectId: n.projectId } : {}),
    ...(n.milestoneId !== undefined ? { milestoneId: n.milestoneId } : {}),
    channel: n.channel,
    ...(n.kind !== undefined ? { kind: n.kind } : {}),
    ...(n.category !== undefined ? { category: n.category } : {}),
    template: n.template,
    templateVersion: n.templateVersion,
    ...(n.subject !== undefined ? { subject: n.subject } : {}),
    recipient: n.recipient,
    ...(n.recipientName !== undefined ? { recipientName: n.recipientName } : {}),
    state: n.state,
    ...(n.providerMessageId !== undefined ? { providerMessageId: n.providerMessageId } : {}),
    scheduled_for: n.scheduledFor.toISOString(),
    ...(n.sentAt !== undefined ? { sent_at: n.sentAt.toISOString() } : {}),
    ...(n.deliveredAt !== undefined ? { deliveredAt: n.deliveredAt.toISOString() } : {}),
    ...(n.canceledAt !== undefined ? { canceledAt: n.canceledAt.toISOString() } : {}),
    ...(n.readAt !== undefined ? { readAt: n.readAt.toISOString() } : {}),
    attemptCount: n.attemptCount,
    ...(n.lastError !== undefined ? { result_error: n.lastError } : {}),
    ...(n.nextActionAt !== undefined ? { next_retry_at: n.nextActionAt.toISOString() } : {}),
    ...(n.nextActionLabel !== undefined ? { next_action: n.nextActionLabel } : {}),
    trigger: n.trigger,
    ...(n.policyStep !== undefined ? { policyStep: n.policyStep } : {}),
    ...(n.policyVersion !== undefined ? { policyVersion: n.policyVersion } : {}),
    ...(n.idempotencyKey !== undefined ? { idempotencyKey: n.idempotencyKey } : {}),
    createdAt: n.createdAt.toISOString(),
    delivery: {
      status: n.canceledAt
        ? "canceled"
        : n.sentAt
          ? "sent"
          : n.state === "failed"
            ? attemptsLeft > 0
              ? "failed_retry_scheduled"
              : "failed_exhausted"
            : "queued",
      attemptsLeft,
      ...(n.nextActionAt !== undefined ? { nextRetryAt: n.nextActionAt.toISOString() } : {}),
    },
  };
}

function serviceFor(deps: RouteDeps): NotificationService {
  return new NotificationService(deps.store, deps.emailProvider, {
    sessionSecret: deps.sessionSecret,
    ...(process.env.APP_BASE_URL ? { baseUrl: process.env.APP_BASE_URL } : {}),
  });
}

/**
 * Lifecycle hook shared by payments / approvals / pause / plans /
 * deliverables routes. Best-effort: notification failures never break the
 * underlying workflow transition (the row + event are the audit trail).
 */
export async function notifyLifecycle(
  deps: RouteDeps,
  args: {
    workspaceId: string;
    projectId: string;
    milestoneId?: string | undefined;
    kind: NotificationKind;
    dedupe: string;
    detail?: string | undefined;
    portalUrl?: string | undefined;
    actorId?: string | undefined;
  },
): Promise<void> {
  const store: Store = deps.store;
  try {
    const [project, milestone, workspace] = await Promise.all([
      store.findProject(args.projectId),
      args.milestoneId ? store.findMilestone(args.milestoneId) : Promise.resolve(undefined),
      store.findWorkspace(args.workspaceId),
    ]);
    if (!project) return;
    if (project.workspaceId !== args.workspaceId) return;
    if (args.milestoneId && milestone?.projectId !== args.projectId) return;
    const client = await store.findClient(project.clientId).catch(() => undefined);
    const members = await store.listMembers(args.workspaceId).catch(() => []);
    const svc = serviceFor(deps);
    const now = new Date();
    const dueDate = milestone?.dueDate ?? project.expectedCompletion;
    const overdueDays =
      dueDate && dueDate.getTime() < now.getTime()
        ? Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000)
        : 0;
    const fanout = await svc.queueForScope({
      workspaceId: args.workspaceId,
      ...clientContact(client),
      ...(client?.name ? { clientName: client.name } : {}),
      memberUserIds: members.map((m) => m.userId),
      projectId: args.projectId,
      ...(args.milestoneId !== undefined ? { milestoneId: args.milestoneId } : {}),
      kind: args.kind,
      dedupe: args.dedupe,
      trigger: "event",
      vars: {
        workspaceName: workspace?.name ?? "Workspace",
        clientName: client?.name ?? "there",
        projectTitle: project.title,
        milestoneTitle: milestone?.title ?? project.title,
        amount: formatAmount(milestone?.amountCents ?? project.totalValueCents),
        currency: (milestone?.currency ?? project.currency).toUpperCase(),
        dueDate: dueDate ? formatDueDate(dueDate) : "",
        daysOverdue: String(overdueDays),
        portalUrl: args.portalUrl ?? "your client portal link",
        freelancerName: workspace?.name ?? "Workspace",
        detail: args.detail ?? "",
      },
    });
    try {
      await store.appendProjectEvent(args.workspaceId, args.projectId, {
        ...(args.milestoneId !== undefined ? { milestoneId: args.milestoneId } : {}),
        type: "NotificationQueued",
        actorType: "system",
        ...(args.actorId !== undefined ? { actorId: args.actorId } : {}),
        idempotencyKey: `notify-event:${args.kind}:${args.milestoneId ?? args.projectId}:${args.dedupe}`,
        payload: {
          kind: args.kind,
          category: CATEGORY_BY_KIND[args.kind],
          ...(fanout.email ? { emailNotificationId: fanout.email.record.id } : {}),
          inappNotificationIds: fanout.inapp.map((r) => r.record.id),
          suppressed: fanout.suppressed,
        },
      });
    } catch (err: unknown) {
      if (!(err instanceof AppError && err.code === "CONFLICT")) throw err;
    }
  } catch {
    // Notifications never break the underlying workflow.
  }
}

export function registerNotificationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  // ---- Workspace inbox: email audit + in-app center, newest first ----
  app.get("/api/v1/workspaces/:workspaceId/notifications", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid ids");
    requireMembership(await store.findMembership(user.id, params.workspaceId));
    const query = parseOrThrow(inboxQuery, request.query ?? {}, "Invalid filters");
    let rows = await store.listWorkspaceNotifications(params.workspaceId, query.limit);
    if (query.channel) rows = rows.filter((r) => r.channel === query.channel);
    if (query.category !== undefined) {
      if (!isKnownCategory(query.category) && query.category !== "reminders") {
        throw AppError.unprocessable(`Unknown category: ${query.category}`);
      }
      rows = rows.filter((r) => (r.category ?? "reminders") === query.category);
    }
    if (query.state) rows = rows.filter((r) => r.state === query.state);
    const unreadInapp = rows.filter(
      (r) => r.channel === "inapp" && r.recipient === user.id && !r.readAt && !r.canceledAt,
    ).length;
    return {
      notifications: rows.map(serialize),
      summary: {
        total: rows.length,
        unreadInapp,
        failedCount: rows.filter((r) => r.state === "failed").length,
        queuedCount: rows.filter((r) => r.state === "queued" && !r.canceledAt).length,
      },
    };
  });

  // ---- Single notification: full delivery status ----
  app.get("/api/v1/workspaces/:workspaceId/notifications/:notificationId", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceNotificationParam, request.params, "Invalid ids");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    const row = await store.findNotificationById(params.notificationId);
    if (!row) throw AppError.notFound("Notification not found");
    assertResourceInWorkspace(params.workspaceId, membership, row);
    return { notification: serialize(row) };
  });

  // ---- In-app read marker (idempotent) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/notifications/:notificationId/read",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceNotificationParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      const row = await store.findNotificationById(params.notificationId);
      if (!row) throw AppError.notFound("Notification not found");
      assertResourceInWorkspace(params.workspaceId, membership, row);
      if (row.channel !== "inapp")
        throw AppError.unprocessable("Only in-app rows can be marked read");
      if (row.readAt) return { notification: serialize(row), duplicate: true };
      const updated = await store.updateNotification(row.id, { readAt: new Date() });
      return { notification: serialize(updated), read: true };
    },
  );

  // ---- Retry a failed email (paid-stop aware, duplicate-safe) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/notifications/:notificationId/retry",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceNotificationParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const row = await store.findNotificationById(params.notificationId);
      if (!row) throw AppError.notFound("Notification not found");
      assertResourceInWorkspace(params.workspaceId, membership, row);
      if (row.sentAt) return { notification: serialize(row), duplicate: true };
      if (row.channel !== "email") throw AppError.unprocessable("Only email rows can be retried");
      if (row.state !== "failed") {
        throw AppError.unprocessable("Only failed notifications can be retried");
      }
      const svc = serviceFor(deps);
      let milestonePaymentState: string | undefined;
      if (row.milestoneId) {
        const milestone = await store.findMilestone(row.milestoneId);
        milestonePaymentState = milestone?.paymentState;
      }
      try {
        const { record } = await svc.dispatchEmail(row, {
          ...(milestonePaymentState !== undefined ? { milestonePaymentState } : {}),
        });
        return { notification: serialize(record), retried: true };
      } catch (err: unknown) {
        if (err instanceof AppError && err.code === "PROVIDER_ERROR") throw err;
        throw err;
      }
    },
  );

  // ---- Cancel a queued notification (auditable, history preserved) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/notifications/:notificationId/cancel",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceNotificationParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const row = await store.findNotificationById(params.notificationId);
      if (!row) throw AppError.notFound("Notification not found");
      assertResourceInWorkspace(params.workspaceId, membership, row);
      if (row.sentAt)
        throw AppError.unprocessable("Notification already sent — it cannot be canceled");
      if (row.canceledAt) return { notification: serialize(row), duplicate: true };
      const updated = await store.updateNotification(row.id, {
        canceledAt: new Date(),
        nextActionAt: null,
        nextActionLabel: "Canceled — no further sends",
      });
      return { notification: serialize(updated), canceled: true };
    },
  );

  // ---- Per-user preferences: read my effective set ----
  app.get("/api/v1/workspaces/:workspaceId/notification-preferences", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid ids");
    requireMembership(await store.findMembership(user.id, params.workspaceId));
    const stored = await store.getNotificationPreferences(params.workspaceId, user.id);
    const byKey = new Map(stored.map((p) => [`${p.category}:${p.channel}`, p.enabled] as const));
    const preferences = NOTIFICATION_CATEGORIES.flatMap((category) =>
      (["email", "inapp"] as const).map((channel) => ({
        category,
        channel,
        enabled: byKey.get(`${category}:${channel}`) ?? true,
      })),
    );
    return {
      preferences,
      note: "Absent rows default to enabled. Disabling a category stops that mail for you only — the audit trail is preserved.",
    };
  });

  // ---- Per-user preferences: update my set ----
  app.put("/api/v1/workspaces/:workspaceId/notification-preferences", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid ids");
    requireMembership(await store.findMembership(user.id, params.workspaceId));
    const body = parseOrThrow(preferencesBody, request.body, "Invalid preferences");
    const seen = new Set<string>();
    for (const p of body.preferences) {
      if (!isKnownCategory(p.category))
        throw AppError.unprocessable(`Unknown category: ${p.category}`);
      const key = `${p.category}:${p.channel}`;
      if (seen.has(key)) throw AppError.unprocessable(`Duplicate preference: ${key}`);
      seen.add(key);
    }
    const updated = [];
    for (const p of body.preferences) {
      const row = await store.setNotificationPreference(
        params.workspaceId,
        user.id,
        p.category,
        p.channel,
        p.enabled,
      );
      updated.push({
        category: row.category,
        channel: row.channel,
        enabled: row.enabled,
        updatedAt: row.updatedAt.toISOString(),
      });
    }
    return { preferences: updated };
  });

  // ---- Client opt-outs (freelancer-managed unsubscribe list) ----
  app.get("/api/v1/workspaces/:workspaceId/notification-opt-outs", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid ids");
    requireMembership(await store.findMembership(user.id, params.workspaceId));
    const rows = await store.listNotificationOptOuts(params.workspaceId);
    return {
      optOuts: rows.map((o) => ({
        email: o.email,
        category: o.category,
        createdAt: o.createdAt.toISOString(),
      })),
    };
  });

  app.post("/api/v1/workspaces/:workspaceId/notification-opt-outs", async (request, reply) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid ids");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    requireWriteAccess(membership);
    const body = parseOrThrow(optOutBody, request.body, "Invalid opt-out");
    if (body.category !== "all" && !isKnownCategory(body.category)) {
      throw AppError.unprocessable(`Unknown category: ${body.category}`);
    }
    const row = await store.addNotificationOptOut(
      params.workspaceId,
      normalizeEmail(body.email),
      body.category,
    );
    return reply.status(201).send({
      optOut: { email: row.email, category: row.category },
      note: "This address will no longer receive that category by email. In-app freelancer notices continue.",
    });
  });

  app.delete("/api/v1/workspaces/:workspaceId/notification-opt-outs", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid ids");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    requireWriteAccess(membership);
    const body = parseOrThrow(optOutDeleteBody, request.body ?? {}, "Invalid opt-out");
    await store.removeNotificationOptOut(
      params.workspaceId,
      normalizeEmail(body.email),
      body.category,
    );
    return { resubscribed: true, email: normalizeEmail(body.email), category: body.category };
  });

  // ---- Public unsubscribe: preview (no state change) ----
  app.get("/api/v1/notifications/unsubscribe", (request) => {
    const query = request.query as Record<string, unknown>;
    const token = typeof query.token === "string" ? query.token : "";
    if (!token) throw AppError.badRequest("Missing unsubscribe token");
    try {
      const { workspaceId, email, category } = verifyUnsubscribeToken({
        token,
        secret: deps.sessionSecret,
      });
      return {
        workspaceId,
        email: maskEmail(email),
        category,
        message: "Confirm to stop receiving this category by email. Nothing has changed yet.",
      };
    } catch {
      throw AppError.badRequest("Invalid or expired unsubscribe token");
    }
  });

  // ---- Public unsubscribe: confirm (idempotent) ----
  app.post("/api/v1/notifications/unsubscribe", async (request) => {
    const body = parseOrThrow(unsubscribeBody, request.body ?? {}, "Invalid unsubscribe");
    let decoded: { workspaceId: string; email: string; category: string };
    try {
      decoded = verifyUnsubscribeToken({ token: body.token, secret: deps.sessionSecret });
    } catch {
      throw AppError.badRequest("Invalid or expired unsubscribe token");
    }
    const workspace = await store.findWorkspace(decoded.workspaceId);
    if (!workspace) throw AppError.badRequest("Invalid or expired unsubscribe token");
    const category =
      decoded.category === "all" || isKnownCategory(decoded.category) ? decoded.category : "all";
    await store.addNotificationOptOut(decoded.workspaceId, decoded.email, category);
    return {
      unsubscribed: true,
      email: maskEmail(decoded.email),
      category,
      note: "You will no longer receive this category by email. Your freelancer can resubscribe you on request.",
    };
  });

  // ---- Outbox tick: send due email rows (paid-stop + opt-out re-checked) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/notifications/dispatch-due",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const body = parseOrThrow(tickBody, request.body ?? {}, "Invalid tick input");
      const now = body.now !== undefined ? new Date(body.now) : new Date();
      const svc = serviceFor(deps);
      const rows = await store.listNotificationsByProject(params.projectId);
      const scoped = rows.filter(
        (r) =>
          r.workspaceId === params.workspaceId &&
          r.channel === "email" &&
          !r.sentAt &&
          !r.canceledAt &&
          (r.state === "queued" || r.state === "failed") &&
          r.scheduledFor.getTime() <= now.getTime() &&
          (r.nextActionAt === undefined || r.nextActionAt.getTime() <= now.getTime()) &&
          r.attemptCount < MAX_DELIVERY_ATTEMPTS,
      );
      const sent: Record<string, unknown>[] = [];
      const failed: Record<string, unknown>[] = [];
      const canceledStale: Record<string, unknown>[] = [];
      for (const row of scoped) {
        // Paid-stop at send time: settling after queue time cancels, never sends.
        if (row.milestoneId) {
          const milestone = await store.findMilestone(row.milestoneId);
          if (milestone && !maySendForRow(row, milestone.paymentState)) {
            const canceled = await store.updateNotification(row.id, {
              canceledAt: now,
              nextActionAt: null,
              nextActionLabel: "Auto-canceled — milestone paid",
            });
            canceledStale.push(serialize(canceled));
            continue;
          }
        }
        // Opt-out re-check: a client who unsubscribed after queue time is skipped.
        if (row.category) {
          const optedOut = await store.findNotificationOptOut(
            params.workspaceId,
            row.recipient,
            row.category,
          );
          if (optedOut) {
            const canceled = await store.updateNotification(row.id, {
              canceledAt: now,
              nextActionAt: null,
              nextActionLabel: "Suppressed — recipient opted out",
            });
            canceledStale.push(serialize(canceled));
            continue;
          }
        }
        let milestonePaymentState: string | undefined;
        if (row.milestoneId) {
          milestonePaymentState = (await store.findMilestone(row.milestoneId))?.paymentState;
        }
        try {
          const { record } = await svc.dispatchEmail(row, {
            ...(milestonePaymentState !== undefined ? { milestonePaymentState } : {}),
            now,
          });
          sent.push(serialize(record));
        } catch {
          const fresh = await store.findNotificationById(row.id);
          failed.push({
            ...(fresh ? serialize(fresh) : serialize(row)),
            reason: "delivery failed — safe to retry",
          });
        }
      }
      return {
        sent,
        failed,
        canceledStale,
        summary: summarizeOutbox(scoped.length, sent.length, failed.length, canceledStale.length),
      };
    },
  );

  // ---- Overdue tick: one notice per open milestone per day (never duplicates) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/notifications/check-overdue",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const project = await store.findProject(params.projectId);
      if (!project) throw AppError.notFound("Project not found");
      assertResourceInWorkspace(params.workspaceId, membership, project);
      const body = parseOrThrow(tickBody, request.body ?? {}, "Invalid tick input");
      const now = body.now !== undefined ? new Date(body.now) : new Date();
      const day = utcDay(now);
      const [milestones, client, members, workspace] = await Promise.all([
        store.listMilestones(params.projectId),
        store.findClient(project.clientId),
        store.listMembers(params.workspaceId),
        store.findWorkspace(params.workspaceId),
      ]);
      const svc = serviceFor(deps);
      const queued: Record<string, unknown>[] = [];
      const duplicates: Record<string, unknown>[] = [];
      const skippedPaid: Record<string, unknown>[] = [];
      for (const milestone of milestones) {
        if (!milestone.dueDate || milestone.dueDate.getTime() >= now.getTime()) continue;
        if (!maySendOverdue(milestone.paymentState)) {
          skippedPaid.push({
            milestoneId: milestone.id,
            reason: `milestone ${milestone.paymentState}`,
          });
          continue;
        }
        const daysOverdue = Math.floor((now.getTime() - milestone.dueDate.getTime()) / 86_400_000);
        const fanout = await svc.queueForScope({
          workspaceId: params.workspaceId,
          ...clientContact(client),
          ...(client?.name ? { clientName: client.name } : {}),
          memberUserIds: members.map((m) => m.userId),
          projectId: params.projectId,
          milestoneId: milestone.id,
          kind: "milestone_overdue",
          dedupe: day,
          trigger: "overdue-tick",
          vars: {
            workspaceName: workspace?.name ?? "Workspace",
            clientName: client?.name ?? "there",
            projectTitle: project.title,
            milestoneTitle: milestone.title,
            amount: formatAmount(milestone.amountCents),
            currency: milestone.currency.toUpperCase(),
            dueDate: formatDueDate(milestone.dueDate),
            daysOverdue: String(daysOverdue),
            portalUrl: body.portalUrl ?? "your client portal link",
            freelancerName: workspace?.name ?? "Workspace",
            detail: body.detail ?? "",
          },
        });
        // Dispatch the client email immediately within the same tick; the
        // idempotency key makes a repeated tick a safe duplicate.
        if (fanout.email && !fanout.email.duplicate && !fanout.email.suppressed) {
          try {
            const { record } = await svc.dispatchEmail(fanout.email.record, {
              milestonePaymentState: milestone.paymentState,
              now,
            });
            queued.push({ ...serialize(record), milestoneId: milestone.id });
          } catch {
            const fresh = await store.findNotificationById(fanout.email.record.id);
            queued.push({
              ...(fresh ? serialize(fresh) : serialize(fanout.email.record)),
              milestoneId: milestone.id,
              deliveryDeferred: true,
            });
          }
        } else if (fanout.email?.duplicate) {
          duplicates.push({ milestoneId: milestone.id, reason: "already notified today" });
        } else if (fanout.email?.suppressed) {
          skippedPaid.push({ milestoneId: milestone.id, reason: fanout.email.suppressed });
        } else {
          // No client email on file: in-app rows still went out.
          queued.push(
            ...fanout.inapp.map((r) => ({ ...serialize(r.record), milestoneId: milestone.id })),
          );
        }
      }
      return { queued, duplicates, skippedPaid, day };
    },
  );
}

function maySendForRow(row: NotificationRecord, paymentState: string): boolean {
  // Reminder-sequence rows carry their own paid-stop in the reminder routes;
  // transactional overdue/payment rows stop on settle or dispute.
  const category = row.category ?? "reminders";
  if (category === "overdue" || category === "payments") return maySendOverdue(paymentState);
  if (category === "reminders") return !isKnownSettled(paymentState);
  return true;
}

function isKnownSettled(paymentState: string): boolean {
  return paymentState === "paid" || paymentState === "funded" || paymentState === "refunded";
}

function summarizeOutbox(
  considered: number,
  sent: number,
  failed: number,
  canceled: number,
): Record<string, unknown> {
  return {
    considered,
    sent,
    failed,
    canceledStale: canceled,
    note:
      sent + failed + canceled === 0
        ? "Outbox clear — nothing due."
        : "Tick complete — failures are safe to retry, paid milestones auto-cancel.",
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const head = (local ?? "").slice(0, 2);
  return `${head}***@${domain}`;
}

function clientContact(
  client: { billingEmail?: string | undefined; email: string } | undefined,
): { clientEmail: string } | Record<string, never> {
  const address = client?.billingEmail ?? client?.email;
  return address ? { clientEmail: address } : {};
}
