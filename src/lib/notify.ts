import {
  canAttemptDelivery,
  CATEGORY_BY_KIND,
  getTransactionalTemplate,
  isPaymentSettled,
  MAX_DELIVERY_ATTEMPTS,
  nextRetryAt,
  notificationIdempotencyKey,
  renderTransactional,
  shouldDeliver,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationKind,
  type TransactionalVars,
} from "../domain/notifications.js";
import { AppError } from "./errors.js";
import type { EmailProvider } from "./providers.js";
import type { NotificationRecord, Store } from "./store.js";
import { signUnsubscribeToken } from "./unsubscribe.js";

/**
 * Reliable notification abstraction (Session 18). Every transactional send —
 * payments, approvals, overdue, pauses, plans, deliverables — flows through
 * this service so retry handling, delivery status, failure handling,
 * idempotency, preferences and opt-outs behave identically:
 *
 * - `queue()`: idempotent create. Same idempotency key returns the existing
 *   row with `duplicate: true` — never a second send.
 * - `dispatchEmail()`: preference + opt-out + paid-stop gates, then one
 *   provider attempt. Success → `sent` (+ deliveredAt, snapshot, message id).
 *   Failure → `failed` + attemptCount/lastError/nextRetryAt. Repeats on a
 *   sent row are `duplicate: true` without touching the provider.
 * - `publishInApp()`: instant, provider-free delivery honouring per-user
 *   preferences (suppressed members get no row, reported as suppressed).
 * - `queueForScope()`: fan-out helper used by lifecycle hooks — one email to
 *   the client address + one in-app row per workspace member.
 */

export interface QueueArgs {
  workspaceId: string;
  projectId?: string | undefined;
  milestoneId?: string | undefined;
  kind: NotificationKind;
  channel: NotificationChannel;
  recipient: string;
  recipientName?: string | undefined;
  scheduledFor?: Date | undefined;
  dedupe?: string | undefined;
  trigger?: string | undefined;
  templateOverride?: string | undefined;
  vars: Partial<TransactionalVars>;
}

export interface QueueResult {
  record: NotificationRecord;
  duplicate: boolean;
  suppressed?: string | undefined;
}

export interface ScopeFanout {
  workspaceId: string;
  clientEmail?: string | undefined;
  clientName?: string | undefined;
  memberUserIds: string[];
  projectId?: string | undefined;
  milestoneId?: string | undefined;
  kind: NotificationKind;
  dedupe?: string | undefined;
  trigger?: string | undefined;
  vars: Partial<TransactionalVars>;
}

export class NotificationService {
  constructor(
    private readonly store: Store,
    private readonly email: EmailProvider | undefined,
    private readonly opts: { sessionSecret: string; baseUrl?: string },
  ) {}

  private unsubscribeUrl(workspaceId: string, email: string, category: string): string {
    const token = signUnsubscribeToken({
      workspaceId,
      email,
      category,
      secret: this.opts.sessionSecret,
    });
    const base = (this.opts.baseUrl ?? "").replace(/\/$/, "");
    return `${base}/api/v1/notifications/unsubscribe?token=${encodeURIComponent(token)}`;
  }

  private render(
    kind: NotificationKind,
    workspaceId: string,
    recipientEmail: string,
    category: NotificationCategory,
    vars: Partial<TransactionalVars>,
  ): { subject: string; body: string; html: string } {
    const template = getTransactionalTemplate(kind);
    return renderTransactional(
      { subject: template.subject, body: template.body },
      {
        ...vars,
        unsubscribeUrl: this.unsubscribeUrl(workspaceId, recipientEmail, category),
      },
    );
  }

  async preferenceGate(
    workspaceId: string,
    userId: string | undefined,
    category: NotificationCategory,
    channel: NotificationChannel,
  ): Promise<{ categoryEnabled: boolean; channelEnabled: boolean }> {
    if (!userId) return { categoryEnabled: true, channelEnabled: true };
    const prefs = await this.store.getNotificationPreferences(workspaceId, userId);
    let categoryEnabled = true;
    let channelEnabled = true;
    for (const p of prefs) {
      if (p.category !== category || p.channel !== channel) continue;
      if (!p.enabled) {
        if (p.channel === channel) channelEnabled = false;
        categoryEnabled = false;
      }
    }
    return { categoryEnabled, channelEnabled };
  }

  async emailOptedOut(
    workspaceId: string,
    email: string,
    category: NotificationCategory,
  ): Promise<boolean> {
    const exact = await this.store.findNotificationOptOut(workspaceId, email, category);
    if (exact) return true;
    return false;
  }

  /**
   * Idempotent queue. When `idempotencyKey` collides the existing row is
   * returned as a duplicate; when preferences/opt-out suppress delivery the
   * row is still recorded as `canceled` (auditable) with the reason.
   */
  async queue(args: QueueArgs): Promise<QueueResult> {
    const category: NotificationCategory = CATEGORY_BY_KIND[args.kind];
    const dedupe = args.dedupe ?? "once";
    const scopeId = args.milestoneId ?? args.projectId ?? args.workspaceId;
    const key = notificationIdempotencyKey({ kind: args.kind, scopeId, dedupe });
    const existing = await this.store.findNotificationByIdempotencyKey(key);
    if (existing) return { record: existing, duplicate: true };

    const now = new Date();
    if (args.channel === "email") {
      const optedOut = await this.emailOptedOut(args.workspaceId, args.recipient, category);
      const gate = shouldDeliver({
        categoryEnabled: true,
        channelEnabled: true,
        optedOut,
      });
      if (!gate.deliver) {
        const record = await this.store.createNotification(args.workspaceId, {
          ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
          ...(args.milestoneId !== undefined ? { milestoneId: args.milestoneId } : {}),
          channel: "email",
          template: args.templateOverride ?? args.kind,
          templateVersion: "v1",
          recipient: args.recipient,
          ...(args.recipientName !== undefined ? { recipientName: args.recipientName } : {}),
          scheduledFor: args.scheduledFor ?? now,
          nextActionLabel: `Suppressed — ${gate.reason}`,
          trigger: args.trigger ?? "event",
          kind: args.kind,
          category,
          idempotencyKey: key,
        });
        const canceled = await this.store.updateNotification(record.id, {
          state: "queued",
          canceledAt: now,
          nextActionAt: null,
          nextActionLabel: `Suppressed — ${gate.reason}`,
        });
        return { record: canceled, duplicate: false, suppressed: gate.reason };
      }
      const rendered = this.render(
        args.kind,
        args.workspaceId,
        args.recipient,
        category,
        args.vars,
      );
      try {
        const record = await this.store.createNotification(args.workspaceId, {
          ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
          ...(args.milestoneId !== undefined ? { milestoneId: args.milestoneId } : {}),
          channel: "email",
          template: args.templateOverride ?? args.kind,
          templateVersion: "v1",
          subject: rendered.subject,
          bodySnapshot: rendered.body,
          recipient: args.recipient,
          ...(args.recipientName !== undefined ? { recipientName: args.recipientName } : {}),
          scheduledFor: args.scheduledFor ?? now,
          trigger: args.trigger ?? "event",
          kind: args.kind,
          category,
          idempotencyKey: key,
        });
        return { record, duplicate: false };
      } catch (err: unknown) {
        if (err instanceof AppError && err.code === "CONFLICT") {
          const raced = await this.store.findNotificationByIdempotencyKey(key);
          if (raced) return { record: raced, duplicate: true };
        }
        throw err;
      }
    }

    // In-app: instant rows (delivered at queue time) honouring per-user prefs.
    const gateVals = await this.preferenceGate(args.workspaceId, args.recipient, category, "inapp");
    const gate = shouldDeliver({
      categoryEnabled: gateVals.categoryEnabled,
      channelEnabled: gateVals.channelEnabled,
      optedOut: false,
    });
    if (!gate.deliver)
      return {
        record: undefined as unknown as NotificationRecord,
        duplicate: false,
        suppressed: gate.reason,
      };
    const rendered = this.render(args.kind, args.workspaceId, args.recipient, category, args.vars);
    try {
      const record = await this.store.createNotification(args.workspaceId, {
        ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
        ...(args.milestoneId !== undefined ? { milestoneId: args.milestoneId } : {}),
        channel: "inapp",
        template: args.templateOverride ?? args.kind,
        templateVersion: "v1",
        subject: rendered.subject,
        bodySnapshot: rendered.body,
        recipient: args.recipient,
        ...(args.recipientName !== undefined ? { recipientName: args.recipientName } : {}),
        scheduledFor: args.scheduledFor ?? now,
        trigger: args.trigger ?? "event",
        kind: args.kind,
        category,
        idempotencyKey: key,
      });
      const delivered = await this.store.updateNotification(record.id, {
        state: "delivered",
        sentAt: now,
        deliveredAt: now,
        nextActionLabel: "Delivered to notification center",
      });
      return { record: delivered, duplicate: false };
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === "CONFLICT") {
        const raced = await this.store.findNotificationByIdempotencyKey(key);
        if (raced) return { record: raced, duplicate: true };
      }
      throw err;
    }
  }

  /**
   * Fan-out for lifecycle hooks: one client email + one in-app row per
   * member (each honouring that member's preferences). Email and in-app use
   * distinct idempotency namespaces so a client duplicate never swallows a
   * freelancer notice and vice versa.
   */
  async queueForScope(fanout: ScopeFanout): Promise<{
    email: QueueResult | undefined;
    inapp: QueueResult[];
    suppressed: { userId: string; reason: string }[];
  }> {
    const category: NotificationCategory = CATEGORY_BY_KIND[fanout.kind];
    const workspaceId = fanout.workspaceId;
    let email: QueueResult | undefined;
    if (fanout.clientEmail) {
      email = await this.queue({
        workspaceId,
        ...(fanout.projectId !== undefined ? { projectId: fanout.projectId } : {}),
        ...(fanout.milestoneId !== undefined ? { milestoneId: fanout.milestoneId } : {}),
        kind: fanout.kind,
        channel: "email",
        recipient: fanout.clientEmail,
        ...(fanout.clientName !== undefined ? { recipientName: fanout.clientName } : {}),
        dedupe: `client:${fanout.dedupe ?? "once"}`,
        ...(fanout.trigger !== undefined ? { trigger: fanout.trigger } : {}),
        vars: fanout.vars,
      });
    }
    const inapp: QueueResult[] = [];
    const suppressed: { userId: string; reason: string }[] = [];
    for (const userId of fanout.memberUserIds) {
      const gateVals = await this.preferenceGate(workspaceId, userId, category, "inapp");
      const gate = shouldDeliver({
        categoryEnabled: gateVals.categoryEnabled,
        channelEnabled: gateVals.channelEnabled,
        optedOut: false,
      });
      if (!gate.deliver) {
        suppressed.push({ userId, reason: gate.reason });
        continue;
      }
      const key = notificationIdempotencyKey({
        kind: fanout.kind,
        scopeId: fanout.milestoneId ?? fanout.projectId ?? workspaceId,
        dedupe: `inapp:${userId}:${fanout.dedupe ?? "once"}`,
      });
      const existing = await this.store.findNotificationByIdempotencyKey(key);
      if (existing) {
        inapp.push({ record: existing, duplicate: true });
        continue;
      }
      const rendered = this.render(fanout.kind, workspaceId, userId, category, fanout.vars);
      const now = new Date();
      try {
        const record = await this.store.createNotification(workspaceId, {
          ...(fanout.projectId !== undefined ? { projectId: fanout.projectId } : {}),
          ...(fanout.milestoneId !== undefined ? { milestoneId: fanout.milestoneId } : {}),
          channel: "inapp",
          template: fanout.kind,
          templateVersion: "v1",
          subject: rendered.subject,
          bodySnapshot: rendered.body,
          recipient: userId,
          scheduledFor: now,
          trigger: fanout.trigger ?? "event",
          kind: fanout.kind,
          category,
          idempotencyKey: key,
        });
        const delivered = await this.store.updateNotification(record.id, {
          state: "delivered",
          sentAt: now,
          deliveredAt: now,
          nextActionLabel: "Delivered to notification center",
        });
        inapp.push({ record: delivered, duplicate: false });
      } catch (err: unknown) {
        if (err instanceof AppError && err.code === "CONFLICT") {
          const raced = await this.store.findNotificationByIdempotencyKey(key);
          if (raced) inapp.push({ record: raced, duplicate: true });
          continue;
        }
        throw err;
      }
    }
    return { email, inapp, suppressed };
  }

  /**
   * One provider attempt for a queued/failed email row. Paid-stop is enforced
   * here too: if the linked milestone settled since queue time, the row is
   * auto-canceled instead of sent — repeats can never become duplicates.
   */
  async dispatchEmail(
    record: NotificationRecord,
    opts?: { milestonePaymentState?: string | undefined; now?: Date | undefined },
  ): Promise<{ record: NotificationRecord; duplicate: boolean }> {
    const now = opts?.now ?? new Date();
    if (record.channel !== "email") throw AppError.unprocessable("Only email rows dispatch");
    if (record.canceledAt) {
      throw AppError.unprocessable("Notification was canceled — queue a new one to send again");
    }
    if (record.sentAt) return { record, duplicate: true };
    if (record.milestoneId && opts?.milestonePaymentState !== undefined) {
      if (isPaymentSettled(opts.milestonePaymentState)) {
        const canceled = await this.store.updateNotification(record.id, {
          canceledAt: now,
          nextActionAt: null,
          nextActionLabel: "Auto-canceled — milestone paid",
        });
        return { record: canceled, duplicate: false };
      }
    }
    if (!canAttemptDelivery(record.state, record.attemptCount)) {
      throw AppError.unprocessable(
        `Notification cannot be attempted (state=${record.state}, attempts=${record.attemptCount}/${MAX_DELIVERY_ATTEMPTS})`,
      );
    }
    if (!this.email) throw AppError.internal("Email provider is not configured");
    const attemptCount = record.attemptCount + 1;
    const subject =
      record.subject ??
      getTransactionalTemplate((record.kind ?? record.template) as NotificationKind).subject;
    const text = record.bodySnapshot ?? "";
    try {
      const sent = await this.email.send({
        to: record.recipient,
        subject,
        text,
        ...(record.bodySnapshot !== undefined
          ? { html: `<pre>${escapeHtmlBrief(record.bodySnapshot)}</pre>` }
          : {}),
      });
      const updated = await this.store.updateNotification(record.id, {
        state: "sent",
        providerMessageId: sent.providerMessageId,
        sentAt: now,
        deliveredAt: now,
        attemptCount,
        lastError: null,
        nextActionLabel: "Sent",
      });
      return { record: updated, duplicate: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "delivery failed";
      const exhausted = attemptCount >= MAX_DELIVERY_ATTEMPTS;
      const updated = await this.store.updateNotification(record.id, {
        state: "failed",
        attemptCount,
        lastError: message.slice(0, 500),
        nextActionAt: exhausted ? null : nextRetryAt(attemptCount, now),
        nextActionLabel: exhausted
          ? "Delivery failed — attempts exhausted, inspect and retry manually"
          : `Delivery failed — retry scheduled (attempt ${attemptCount}/${MAX_DELIVERY_ATTEMPTS})`,
      });
      throw new AppError(
        "PROVIDER_ERROR",
        `Notification delivery failed (attempt ${attemptCount}) — safe to retry`,
        { notificationId: updated.id },
      );
    }
  }
}

function escapeHtmlBrief(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
