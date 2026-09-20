/**
 * Production-grade notification domain — pure, DB-free rules (Session 18).
 *
 * One abstraction covers every transactional notice the product sends:
 * payment events, approvals, overdue notices, pauses, payment plans and
 * deliverable releases. Reminder-sequence mail (Session 12) keeps its own
 * policy engine but flows through the same reliability properties defined
 * here:
 *
 * - Idempotent: every queue operation carries a stable key
 *   (`notify:<kind>:<scope>:<dedupe>`). Repeats return the existing row with
 *   `duplicate: true` — the system can never accidentally send duplicate
 *   payment reminders.
 * - Paid-stop: `isPaymentSettled()` lists the milestone states that suppress
 *   any further payment/overdue/reminder mail. The overdue tick and the
 *   dispatch tick both consult it before queueing OR sending.
 * - Retry-safe: only `queued`/`failed` rows without `canceledAt`/`sentAt`
 *   are sendable; `attemptCount` + `lastError` + exponential `nextRetryAt`
 *   are pure functions here so routes and tests agree.
 * - Professional: every template speaks as the workflow
 *   ("Automated update from {workspaceName}"), carries a plain-text and an
 *   HTML part, footers the workspace identity + unsubscribe path, and passes
 *   `assertTransactionalCopy()` (no legal threats, no client labelling, no
 *   "Deposit" label, no outcome guarantees).
 * - Preference-aware: `shouldDeliver()` is the single gate for per-user
 *   channel preferences and client opt-outs.
 */

export const NOTIFICATION_TEMPLATE_VERSION = "v1";

export const NOTIFICATION_CATEGORIES = [
  "payments",
  "approvals",
  "reminders",
  "overdue",
  "pauses",
  "plans",
  "deliverables",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_KINDS = [
  "payment_received",
  "payment_failed",
  "payment_refunded",
  "payment_disputed",
  "approval_received",
  "approval_revision_requested",
  "approval_rejected",
  "approval_disputed",
  "milestone_overdue",
  "project_paused",
  "project_unpaused",
  "plan_proposed",
  "plan_accepted",
  "plan_missed",
  "plan_completed",
  "plan_defaulted",
  "deliverable_released",
  "deliverable_approved",
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const CATEGORY_BY_KIND: Record<NotificationKind, NotificationCategory> = {
  payment_received: "payments",
  payment_failed: "payments",
  payment_refunded: "payments",
  payment_disputed: "payments",
  approval_received: "approvals",
  approval_revision_requested: "approvals",
  approval_rejected: "approvals",
  approval_disputed: "approvals",
  milestone_overdue: "overdue",
  project_paused: "pauses",
  project_unpaused: "pauses",
  plan_proposed: "plans",
  plan_accepted: "plans",
  plan_missed: "plans",
  plan_completed: "plans",
  plan_defaulted: "plans",
  deliverable_released: "deliverables",
  deliverable_approved: "deliverables",
};

export type NotificationChannel = "email" | "inapp";

/** Milestone payment states that stop ALL payment/overdue mail. */
const SETTLED_PAYMENT_STATES = new Set(["paid", "funded", "refunded"]);

/**
 * Central anti-duplicate guard: when true, no payment reminder, overdue
 * notice or "payment due" mail may be queued or sent for the milestone.
 * Verified money is a fact — the notice layer never overrules it.
 */
export function isPaymentSettled(paymentState: string): boolean {
  return SETTLED_PAYMENT_STATES.has(paymentState);
}

/** Overdue mail is only meaningful while the balance is genuinely open. */
export function maySendOverdue(paymentState: string): boolean {
  if (isPaymentSettled(paymentState)) return false;
  if (paymentState === "disputed") return false;
  return true;
}

export interface TransactionalVars {
  workspaceName: string;
  clientName: string;
  projectTitle: string;
  milestoneTitle: string;
  amount: string;
  currency: string;
  dueDate: string;
  daysOverdue: string;
  portalUrl: string;
  freelancerName: string;
  detail: string;
  unsubscribeUrl: string;
}

export interface TransactionalTemplate {
  readonly kind: NotificationKind;
  readonly category: NotificationCategory;
  readonly subject: string;
  readonly body: string;
}

const FOOTER = [
  "",
  "—",
  "Sent by the {{workspaceName}} workflow (informational record, not legal advice).",
  "Manage email preferences: {{unsubscribeUrl}}",
].join("\n");

function withFooter(body: string): string {
  return `${body}\n${FOOTER}`;
}

/** Professional transactional catalogue (v1). System voice throughout. */
export const TRANSACTIONAL_TEMPLATES: readonly TransactionalTemplate[] = [
  {
    kind: "payment_received",
    category: "payments",
    subject: "Payment received — {{milestoneTitle}} ({{amount}} {{currency}})",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "The {{workspaceName}} workflow has verified receipt of {{amount}} {{currency}} for {{milestoneTitle}} ({{projectTitle}}).",
        "",
        "No further action is needed for this milestone. {{detail}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "payment_failed",
    category: "payments",
    subject: "Payment needs attention — {{milestoneTitle}} ({{amount}} {{currency}})",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "The {{workspaceName}} workflow could not confirm payment of {{amount}} {{currency}} for {{milestoneTitle}} ({{projectTitle}}). No amount has been marked paid.",
        "",
        "You can retry here when ready: {{portalUrl}} {{detail}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "payment_refunded",
    category: "payments",
    subject: "Refund recorded — {{milestoneTitle}} ({{amount}} {{currency}})",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "The {{workspaceName}} workflow has recorded a refund of {{amount}} {{currency}} for {{milestoneTitle}} ({{projectTitle}}). {{detail}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "payment_disputed",
    category: "payments",
    subject: "Payment flagged for review — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "The {{workspaceName}} workflow has flagged the payment for {{milestoneTitle}} ({{projectTitle}}) for review. Work records are unchanged while this is reviewed. {{detail}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "approval_received",
    category: "approvals",
    subject: "Approved — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "Thank you — your approval of {{milestoneTitle}} ({{projectTitle}}) has been recorded by the {{workspaceName}} workflow. {{detail}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "approval_revision_requested",
    category: "approvals",
    subject: "Revision requested — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "Your revision notes for {{milestoneTitle}} ({{projectTitle}}) have been recorded: {{detail}}",
        "",
        "The workflow has notified your freelancer, who will follow up with a revised version.",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "approval_rejected",
    category: "approvals",
    subject: "Update on {{milestoneTitle}} — not approved",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "Your feedback on {{milestoneTitle}} ({{projectTitle}}) has been recorded: {{detail}}",
        "",
        "Your freelancer will review and follow up. No payment state changed because of this decision.",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "approval_disputed",
    category: "approvals",
    subject: "Under review — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "{{milestoneTitle}} ({{projectTitle}}) has been marked as under review: {{detail}}",
        "",
        "Work and payment records are preserved while this is reviewed. Your freelancer will confirm next steps with you.",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "milestone_overdue",
    category: "overdue",
    subject: "Overdue by {{daysOverdue}} days — {{milestoneTitle}} ({{amount}} {{currency}})",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "Automated notice from the {{workspaceName}} workflow: {{milestoneTitle}} ({{projectTitle}}) of {{amount}} {{currency}} was due on {{dueDate}} and is now {{daysOverdue}} days overdue.",
        "",
        "If payment is already on its way, no need to reply — the workflow confirms verified payments automatically. Otherwise you can complete it here: {{portalUrl}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "project_paused",
    category: "pauses",
    subject: "Work paused — {{projectTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "The {{workspaceName}} workflow has paused {{projectTitle}}. {{detail}}",
        "",
        "Pausing is a reversible workflow state that protects both sides while payment is resolved — no penalty is applied automatically.",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "project_unpaused",
    category: "pauses",
    subject: "Work resumed — {{projectTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "Good news — the {{workspaceName}} workflow has resumed {{projectTitle}}. {{detail}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "plan_proposed",
    category: "plans",
    subject: "Payment plan proposed — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "The {{workspaceName}} workflow has prepared a payment schedule for {{milestoneTitle}} ({{projectTitle}}): {{detail}}",
        "",
        "Review it here: {{portalUrl}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "plan_accepted",
    category: "plans",
    subject: "Payment plan active — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "The payment schedule for {{milestoneTitle}} ({{projectTitle}}) is now active. {{detail}}",
        "",
        "The workflow will confirm each verified instalment automatically: {{portalUrl}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "plan_missed",
    category: "plans",
    subject: "Instalment date passed — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "A scheduled date for {{milestoneTitle}} ({{projectTitle}}) has passed: {{detail}}",
        "",
        "If payment is already on its way, no need to reply. Otherwise you can catch up here: {{portalUrl}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "plan_completed",
    category: "plans",
    subject: "Payment plan complete — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "All scheduled instalments for {{milestoneTitle}} ({{projectTitle}}) are now verified. {{detail}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "plan_defaulted",
    category: "plans",
    subject: "Payment plan needs review — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "The payment schedule for {{milestoneTitle}} ({{projectTitle}}) needs review: {{detail}}",
        "",
        "Your freelancer will confirm next steps with you. The outstanding balance stands as recorded.",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "deliverable_released",
    category: "deliverables",
    subject: "Files ready — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "Your final files for {{milestoneTitle}} ({{projectTitle}}) are now available. {{detail}}",
        "",
        "Download them here: {{portalUrl}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
  {
    kind: "deliverable_approved",
    category: "deliverables",
    subject: "Approval recorded — {{milestoneTitle}}",
    body: withFooter(
      [
        "Hello {{clientName}},",
        "",
        "Your approval for {{milestoneTitle}} ({{projectTitle}}) has been recorded. {{detail}}",
        "",
        "Thank you,",
        "{{freelancerName}} (via the {{workspaceName}} workflow)",
      ].join("\n"),
    ),
  },
];

const BANNED_COPY = [
  /\bsue\b/i,
  /lawsuit/i,
  /legal action/i,
  /\bcourt\b/i,
  /attorney/i,
  /lawyer/i,
  /collections? agency/i,
  /\blien\b/i,
  /scam/i,
  /fraud/i,
  /cheat/i,
  /dishonest/i,
  /guarantee[sd]? (outcome|payment|success)/i,
  /you (will|must) be (sued|reported|blacklisted)/i,
  /\bdeposit\b/i,
];

/** Reject threatening, labelling or guarantee copy before it can be queued. */
export function assertTransactionalCopy(subject: string, body: string): void {
  for (const phrase of BANNED_COPY) {
    if (phrase.test(subject) || phrase.test(body)) {
      throw new NotificationError(
        `transactional copy contains banned phrasing (${phrase}): stays professional, never threats/labels/guarantees`,
      );
    }
  }
}

export class NotificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotificationError";
  }
}

export function getTransactionalTemplate(kind: NotificationKind): TransactionalTemplate {
  const found = TRANSACTIONAL_TEMPLATES.find((t) => t.kind === kind);
  if (!found) throw new NotificationError(`unknown notification kind: ${kind}`);
  return found;
}

const VAR_RE = /\{\{(\w+)\}\}/g;

export function renderTransactional(
  template: Pick<TransactionalTemplate, "subject" | "body">,
  vars: Partial<TransactionalVars>,
): { subject: string; body: string; html: string } {
  const lookup = new Map<string, string>(
    Object.entries({
      workspaceName: "",
      clientName: "there",
      projectTitle: "Project",
      milestoneTitle: "Milestone",
      amount: "",
      currency: "",
      dueDate: "",
      daysOverdue: "0",
      portalUrl: "your client portal link",
      freelancerName: "",
      detail: "",
      unsubscribeUrl: "",
      ...vars,
    } as Record<string, string>),
  );
  if ((lookup.get("freelancerName") ?? "").trim().length === 0) {
    lookup.set("freelancerName", lookup.get("workspaceName") ?? "");
  }
  const render = (text: string): string =>
    text.replace(VAR_RE, (match, name: string) => lookup.get(name) ?? match);
  const subject = render(template.subject);
  const body = render(template.body);
  assertTransactionalCopy(subject, body);
  const html = `<p>${escapeHtml(body).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br />")}</p>`;
  return { subject, body, html };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Stable idempotency key. Same (kind, scope, dedupe) always yields the same
 * key across retries, reboots and double-clicks — the store UNIQUE turns a
 * repeat into a safe `duplicate: true` instead of a second email.
 */
export function notificationIdempotencyKey(args: {
  kind: NotificationKind;
  scopeId: string;
  dedupe: string;
}): string {
  const dedupe = args.dedupe.trim().length > 0 ? args.dedupe.trim().slice(0, 120) : "once";
  return `notify:${args.kind}:${args.scopeId}:${dedupe}`;
}

/** Canonical per-day dedupe segment (UTC day) for once-per-day notices. */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Retry schedule: exponential backoff 2^attempt minutes, capped at 4h. */
export function nextRetryAt(attemptCount: number, from: Date): Date {
  const minutes = Math.min(240, 2 ** Math.max(0, attemptCount));
  return new Date(from.getTime() + minutes * 60_000);
}

export const MAX_DELIVERY_ATTEMPTS = 5;

export function canAttemptDelivery(state: string, attemptCount: number): boolean {
  if (state !== "queued" && state !== "failed") return false;
  return attemptCount < MAX_DELIVERY_ATTEMPTS;
}

export interface DeliveryGate {
  readonly categoryEnabled: boolean;
  readonly channelEnabled: boolean;
  readonly optedOut: boolean;
}

/**
 * Single preference/opt-out gate. Email requires the category AND the email
 * channel to be on, plus no client opt-out. In-app requires the inapp
 * channel. Suppressed sends never touch the provider.
 */
export function shouldDeliver(gate: DeliveryGate): { deliver: boolean; reason: string } {
  if (!gate.categoryEnabled) return { deliver: false, reason: "category disabled in preferences" };
  if (!gate.channelEnabled) return { deliver: false, reason: "channel disabled in preferences" };
  if (gate.optedOut) return { deliver: false, reason: "recipient opted out" };
  return { deliver: true, reason: "ok" };
}

export function defaultPreferences(): {
  category: NotificationCategory;
  email: boolean;
  inapp: boolean;
}[] {
  return NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    email: true,
    inapp: true,
  }));
}

export function isKnownCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export function isKnownKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}
