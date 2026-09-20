/**
 * Reminder + escalation engine — pure, DB-free rules (Session 12).
 *
 * There is NO universal hard-coded schedule. Every project resolves an
 * explicit, configurable {@link ReminderPolicy}:
 *
 *   workspace defaults → project override → DEFAULT_REMINDER_POLICY fallback
 *
 * The default policy mirrors the task example (T-3 friendly, T+0 due, T+3
 * first overdue, T+7 firmer, T+14 escalation, T+21 work-paused / manual).
 * Freelancers may reorder, retime, disable steps, or add their own — the
 * engine only ever schedules what the resolved policy says.
 *
 * ## Safety properties (enforced with the routes layer)
 * - Auditable: every schedule/send/deliver/fail/retry/cancel appends a
 *   `Reminder*` project event carrying `{ notificationId, stepKey,
 *   template, templateVersion, idempotencyKey }`.
 * - Idempotent: schedule keys (`reminder:{milestone}:{step}:{day}`) and send
 *   keys (`reminder-send:{notificationId}`) dedupe repeats to the same row.
 * - Retry-safe: only `queued`/`failed` rows with no `canceledAt` and no
 *   `sentAt` are sendable; `attemptCount` + `lastError` are recorded.
 * - Cancelable: `canceledAt` marks a row cancelled without deleting history.
 * - Configurable: policies + message templates are validated data, editable
 *   per workspace / project.
 * - No auto legal threats: steps flagged `requiresManual` (escalation and
 *   work-paused in the default policy) are NEVER sent by the scheduler tick —
 *   they need an explicit manual send with a jurisdiction acknowledgement.
 *   Legal language is jurisdiction-aware and carefully framed (see
 *   {@link JURISDICTION_NOTICE}); the engine never sends it automatically.
 *
 * ## Voice
 * Every default template speaks as the system ("Automated reminder from
 * {workspaceName}"), never as the freelancer begging. The freelancer UX reads
 * "The system is handling this."
 */

export const REMINDER_TEMPLATE_VERSION = "v1";

export const JURISDICTION_NOTICE =
  "Enforcement of any agreement terms depends on your jurisdiction and the actual agreement with your client. " +
  "This message is an informational workflow reminder, not a legal claim or legal advice. " +
  "Consider independent legal review before taking further action.";

export type ReminderTone = "friendly" | "neutral" | "firm" | "escalation" | "work_paused";

export interface ReminderStep {
  /** Stable key, e.g. "upcoming", "due", "overdue_3d", "escalation". */
  readonly key: string;
  /** Days relative to the milestone due date. Negative = before due. */
  readonly offsetDays: number;
  readonly label: string;
  readonly tone: ReminderTone;
  /** Template key rendered when this step fires. */
  readonly templateKey: string;
  /** Manual-only steps never fire from the scheduler tick. */
  readonly requiresManual?: boolean | undefined;
  readonly enabled?: boolean | undefined;
}

export interface ReminderPolicy {
  readonly version: number;
  readonly channel: string;
  readonly enabled: boolean;
  readonly steps: readonly ReminderStep[];
  /** Max automatic sends per 7-day window per milestone (1–14). */
  readonly maxPerWeek?: number | undefined;
}

export interface ReminderTemplate {
  readonly key: string;
  readonly version: string;
  readonly tone: ReminderTone;
  readonly subject: string;
  readonly body: string;
  /** Manual-only templates refuse automatic sends. */
  readonly requiresManual: boolean;
  /** Short freelancer-facing description shown in the template editor. */
  readonly description: string;
}

export class ReminderPolicyError extends Error {
  readonly code: "INVALID_POLICY" | "INVALID_TEMPLATE";
  constructor(code: ReminderPolicyError["code"], message: string) {
    super(message);
    this.name = "ReminderPolicyError";
    this.code = code;
  }
}

/** Default policy: the task example, expressed as data (not hard-coded logic). */
export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  version: 1,
  channel: "email",
  enabled: true,
  maxPerWeek: 3,
  steps: [
    {
      key: "upcoming",
      offsetDays: -3,
      label: "Friendly reminder — 3 days before due",
      tone: "friendly",
      templateKey: "upcoming_friendly",
    },
    {
      key: "due",
      offsetDays: 0,
      label: "Payment due notice — due date",
      tone: "neutral",
      templateKey: "payment_due",
    },
    {
      key: "overdue_3d",
      offsetDays: 3,
      label: "First overdue notice — 3 days overdue",
      tone: "neutral",
      templateKey: "first_overdue",
    },
    {
      key: "overdue_7d",
      offsetDays: 7,
      label: "Firmer notice — 7 days overdue",
      tone: "firm",
      templateKey: "firmer_notice",
    },
    {
      key: "escalation",
      offsetDays: 14,
      label: "Escalation notice — 14 days overdue",
      tone: "escalation",
      templateKey: "escalation_notice",
      requiresManual: true,
    },
    {
      key: "work_paused",
      offsetDays: 21,
      label: "Work-paused state / manual escalation — further overdue",
      tone: "work_paused",
      templateKey: "work_paused",
      requiresManual: true,
    },
  ],
};

/**
 * Editable professional templates (v1). System voice throughout — the client
 * reads workflow automation, the freelancer never "begs again". No template
 * contains threatening legal claims; escalation / work-paused templates carry
 * the jurisdiction-aware framing and require a manual send.
 *
 * Placeholders: {{workspaceName}} {{clientName}} {{projectTitle}}
 * {{milestoneTitle}} {{amount}} {{currency}} {{dueDate}} {{daysOverdue}}
 * {{portalUrl}} {{jurisdiction}} {{freelancerName}}
 */
export const REMINDER_TEMPLATES: readonly ReminderTemplate[] = [
  {
    key: "upcoming_friendly",
    version: REMINDER_TEMPLATE_VERSION,
    tone: "friendly",
    requiresManual: false,
    description: "Friendly heads-up before the due date.",
    subject: "Upcoming payment — {{milestoneTitle}} due {{dueDate}}",
    body: [
      "Hello {{clientName}},",
      "",
      "A quick heads-up from the {{workspaceName}} workflow: {{milestoneTitle}} ({{projectTitle}}) of {{amount}} {{currency}} is due on {{dueDate}}.",
      "",
      "No action is needed yet — the system will confirm automatically once payment is verified. You can review progress here: {{portalUrl}}",
      "",
      "Thank you,",
      "{{freelancerName}} (via the {{workspaceName}} workflow)",
    ].join("\n"),
  },
  {
    key: "payment_due",
    version: REMINDER_TEMPLATE_VERSION,
    tone: "neutral",
    requiresManual: false,
    description: "Calm due-date notice.",
    subject: "Payment due today — {{milestoneTitle}} ({{amount}} {{currency}})",
    body: [
      "Hello {{clientName}},",
      "",
      "Automated reminder from the {{workspaceName}} workflow: {{milestoneTitle}} ({{projectTitle}}) of {{amount}} {{currency}} is due today ({{dueDate}}).",
      "",
      "Pay here when ready: {{portalUrl}} — the workflow confirms verified payments automatically, so you never need to chase a receipt.",
      "",
      "Thank you,",
      "{{freelancerName}} (via the {{workspaceName}} workflow)",
    ].join("\n"),
  },
  {
    key: "first_overdue",
    version: REMINDER_TEMPLATE_VERSION,
    tone: "neutral",
    requiresManual: false,
    description: "First overdue notice — still warm, still system-voiced.",
    subject: "Overdue by {{daysOverdue}} days — {{milestoneTitle}} ({{amount}} {{currency}})",
    body: [
      "Hello {{clientName}},",
      "",
      "Automated reminder from the {{workspaceName}} workflow: {{milestoneTitle}} ({{projectTitle}}) of {{amount}} {{currency}} was due on {{dueDate}} and is now {{daysOverdue}} days overdue.",
      "",
      "If payment is already on its way, no need to reply — the workflow marks it verified automatically. Otherwise you can complete it here: {{portalUrl}}",
      "",
      "Thank you,",
      "{{freelancerName}} (via the {{workspaceName}} workflow)",
    ].join("\n"),
  },
  {
    key: "firmer_notice",
    version: REMINDER_TEMPLATE_VERSION,
    tone: "firm",
    requiresManual: false,
    description: "Firmer 7-day notice — direct but professional, no threats.",
    subject: "Follow-up — {{milestoneTitle}} overdue by {{daysOverdue}} days",
    body: [
      "Hello {{clientName}},",
      "",
      "Automated follow-up from the {{workspaceName}} workflow: {{milestoneTitle}} ({{projectTitle}}) of {{amount}} {{currency}} (due {{dueDate}}) is {{daysOverdue}} days overdue.",
      "",
      "Please complete payment here: {{portalUrl}} — or reply with a timeline and the workflow will record it. Work on later milestones stays on schedule while this is resolved.",
      "",
      "Thank you,",
      "{{freelancerName}} (via the {{workspaceName}} workflow)",
    ].join("\n"),
  },
  {
    key: "escalation_notice",
    version: REMINDER_TEMPLATE_VERSION,
    tone: "escalation",
    requiresManual: true,
    description:
      "Manual escalation at 14 days — jurisdiction-aware, never automatic, never a legal threat.",
    subject: "Escalation review — {{milestoneTitle}} overdue by {{daysOverdue}} days",
    body: [
      "Hello {{clientName}},",
      "",
      "The {{workspaceName}} workflow is flagging {{milestoneTitle}} ({{projectTitle}}) of {{amount}} {{currency}} (due {{dueDate}}, {{daysOverdue}} days overdue) for freelancer review.",
      "",
      "Next step: your freelancer will personally review options with you — including a revised timeline or a payment plan: {{portalUrl}}",
      "",
      `Jurisdiction note{{jurisdiction}}: ${JURISDICTION_NOTICE}`,
      "",
      "Thank you,",
      "{{freelancerName}} (via the {{workspaceName}} workflow)",
    ].join("\n"),
  },
  {
    key: "work_paused",
    version: REMINDER_TEMPLATE_VERSION,
    tone: "work_paused",
    requiresManual: true,
    description:
      "Manual work-paused state — pauses are a workflow state, not a threat; never automatic.",
    subject: "Work-paused review — {{milestoneTitle}} ({{amount}} {{currency}})",
    body: [
      "Hello {{clientName}},",
      "",
      "The {{workspaceName}} workflow has marked {{projectTitle}} as ready for a work-paused review: {{milestoneTitle}} of {{amount}} {{currency}} (due {{dueDate}}) remains unpaid after {{daysOverdue}} days.",
      "",
      "Pausing is a reversible workflow state that protects both sides while payment is resolved — no penalty is applied automatically. Your freelancer will confirm next steps with you: {{portalUrl}}",
      "",
      `Jurisdiction note{{jurisdiction}}: ${JURISDICTION_NOTICE}`,
      "",
      "Thank you,",
      "{{freelancerName}} (via the {{workspaceName}} workflow)",
    ].join("\n"),
  },
];

const STEP_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const TEMPLATE_KEY_RE = /^[a-z0-9][a-z0-9_]{0,40}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Banned phrasing: legal threats + the "Deposit" label (progress, not suspicion). */
const BANNED_TEMPLATE_PHRASES = [
  /\bsue\b/i,
  /lawsuit/i,
  /legal action/i,
  /\bcourt\b/i,
  /attorney/i,
  /lawyer/i,
  /collections? agency/i,
  /\blien\b/i,
  /deposit/i,
];

export function validateTemplateBody(key: string, subject: string, body: string): void {
  if (!TEMPLATE_KEY_RE.test(key)) {
    throw new ReminderPolicyError("INVALID_TEMPLATE", `template key is invalid: ${key}`);
  }
  if (subject.trim().length === 0 || subject.length > 200) {
    throw new ReminderPolicyError("INVALID_TEMPLATE", "template subject is required (≤ 200 chars)");
  }
  if (body.trim().length === 0 || body.length > 5000) {
    throw new ReminderPolicyError("INVALID_TEMPLATE", "template body is required (≤ 5000 chars)");
  }
  for (const phrase of BANNED_TEMPLATE_PHRASES) {
    if (phrase.test(subject) || phrase.test(body)) {
      throw new ReminderPolicyError(
        "INVALID_TEMPLATE",
        `template "${key}" contains banned phrasing (${phrase}). Templates must stay professional: no legal threats, no "Deposit" label.`,
      );
    }
  }
}

export function getTemplate(key: string): ReminderTemplate {
  const found = REMINDER_TEMPLATES.find((t) => t.key === key);
  if (!found) throw new ReminderPolicyError("INVALID_TEMPLATE", `unknown template: ${key}`);
  return found;
}

export function listTemplates(): ReminderTemplate[] {
  return REMINDER_TEMPLATES.map((t) => ({ ...t }));
}

export function validateReminderPolicy(policy: ReminderPolicy): void {
  if (!Number.isInteger(policy.version) || policy.version < 1) {
    throw new ReminderPolicyError("INVALID_POLICY", "policy.version must be an integer ≥ 1");
  }
  if (policy.channel !== "email") {
    throw new ReminderPolicyError("INVALID_POLICY", 'policy.channel must be "email" (MVP)');
  }
  if (typeof policy.enabled !== "boolean") {
    throw new ReminderPolicyError("INVALID_POLICY", "policy.enabled must be a boolean");
  }
  if (policy.maxPerWeek !== undefined) {
    if (!Number.isInteger(policy.maxPerWeek) || policy.maxPerWeek < 1 || policy.maxPerWeek > 14) {
      throw new ReminderPolicyError("INVALID_POLICY", "policy.maxPerWeek must be 1–14");
    }
  }
  if (policy.steps.length === 0 || policy.steps.length > 12) {
    throw new ReminderPolicyError("INVALID_POLICY", "policy.steps must list 1–12 steps");
  }
  const keys = new Set<string>();
  const offsets = new Set<number>();
  for (const step of policy.steps) {
    if (!STEP_KEY_RE.test(step.key)) {
      throw new ReminderPolicyError("INVALID_POLICY", `step key is invalid: ${step.key}`);
    }
    if (keys.has(step.key)) {
      throw new ReminderPolicyError("INVALID_POLICY", `duplicate step key: ${step.key}`);
    }
    keys.add(step.key);
    if (!Number.isInteger(step.offsetDays) || step.offsetDays < -30 || step.offsetDays > 90) {
      throw new ReminderPolicyError(
        "INVALID_POLICY",
        `step "${step.key}" offsetDays must be an integer in -30..90`,
      );
    }
    if (offsets.has(step.offsetDays)) {
      throw new ReminderPolicyError(
        "INVALID_POLICY",
        `duplicate offsetDays ${step.offsetDays} (each step needs its own day)`,
      );
    }
    offsets.add(step.offsetDays);
    if (step.label.trim().length === 0 || step.label.length > 120) {
      throw new ReminderPolicyError(
        "INVALID_POLICY",
        `step "${step.key}" label is required (≤ 120 chars)`,
      );
    }
    if (!["friendly", "neutral", "firm", "escalation", "work_paused"].includes(step.tone)) {
      throw new ReminderPolicyError("INVALID_POLICY", `step "${step.key}" tone is unknown`);
    }
    // Template must exist in the built-in catalogue (custom templates are
    // validated separately and merged by the route layer).
    getTemplate(step.templateKey);
    if (
      (step.tone === "escalation" || step.tone === "work_paused") &&
      step.requiresManual !== true
    ) {
      throw new ReminderPolicyError(
        "INVALID_POLICY",
        `step "${step.key}" with tone "${step.tone}" must set requiresManual=true (escalation language is never automatic)`,
      );
    }
  }
}

/** Parse an unknown JSON blob (workspace defaults / project override) into a policy. */
export function parseReminderPolicy(value: unknown): ReminderPolicy {
  if (value === undefined || value === null) return { ...DEFAULT_REMINDER_POLICY };
  if (!isPlainObject(value)) {
    throw new ReminderPolicyError("INVALID_POLICY", "reminder policy must be an object");
  }
  if (Array.isArray((value as { steps?: unknown }).steps)) {
    const policy = value as unknown as ReminderPolicy;
    validateReminderPolicy(policy);
    return {
      version: policy.version,
      channel: policy.channel,
      enabled: policy.enabled,
      ...(policy.maxPerWeek !== undefined ? { maxPerWeek: policy.maxPerWeek } : {}),
      steps: policy.steps.map((s) => ({ ...s })),
    };
  }
  // `{}` (the DB default) means "use the default policy".
  if (Object.keys(value).length === 0) return { ...DEFAULT_REMINDER_POLICY };
  throw new ReminderPolicyError(
    "INVALID_POLICY",
    "reminder policy must carry a steps array (or {} for defaults)",
  );
}

/**
 * Resolve the effective policy: project override wins, else workspace
 * defaults, else the built-in default. All inputs are raw JSON blobs.
 */
export function resolvePolicy(args: {
  workspaceDefaults?: unknown;
  projectOverride?: unknown;
}): ReminderPolicy {
  const hasProjectOverride =
    isPlainObject(args.projectOverride) && Object.keys(args.projectOverride).length > 0;
  if (hasProjectOverride) return parseReminderPolicy(args.projectOverride);
  const hasWorkspace =
    isPlainObject(args.workspaceDefaults) && Object.keys(args.workspaceDefaults).length > 0;
  if (hasWorkspace) {
    const maybe = args.workspaceDefaults as Record<string, unknown>;
    if (isPlainObject(maybe.policy)) return parseReminderPolicy(maybe.policy);
    // Allow the workspace blob itself to BE a policy (steps at top level).
    if (Array.isArray(maybe.steps)) return parseReminderPolicy(maybe);
  }
  return { ...DEFAULT_REMINDER_POLICY };
}

export interface PlannedReminder {
  readonly stepKey: string;
  readonly offsetDays: number;
  readonly label: string;
  readonly tone: ReminderTone;
  readonly templateKey: string;
  readonly requiresManual: boolean;
  readonly scheduledAt: Date;
}

/** Expand a policy into concrete send times anchored at the milestone due date. */
export function planReminderSchedule(args: {
  dueDate: Date;
  policy: ReminderPolicy;
}): PlannedReminder[] {
  const { dueDate, policy } = args;
  if (!policy.enabled) return [];
  const out: PlannedReminder[] = [];
  for (const step of [...policy.steps].sort((a, b) => a.offsetDays - b.offsetDays)) {
    if (step.enabled === false) continue;
    const scheduledAt = new Date(dueDate.getTime() + step.offsetDays * 86_400_000);
    out.push({
      stepKey: step.key,
      offsetDays: step.offsetDays,
      label: step.label,
      tone: step.tone,
      templateKey: step.templateKey,
      requiresManual: step.requiresManual === true,
      scheduledAt,
    });
  }
  return out;
}

export interface TemplateVars {
  workspaceName: string;
  clientName: string;
  projectTitle: string;
  milestoneTitle: string;
  amount: string;
  currency: string;
  dueDate: string;
  daysOverdue: string;
  portalUrl: string;
  jurisdiction: string;
  freelancerName: string;
}

const VAR_RE = /\{\{(\w+)\}\}/g;

/** Render subject/body by substituting {{vars}} (unknown vars left intact). */
export function renderTemplate(
  template: Pick<ReminderTemplate, "subject" | "body">,
  vars: Partial<TemplateVars>,
): { subject: string; body: string } {
  const lookup = new Map<string, string>(Object.entries(vars as Record<string, string>));
  // `{{jurisdiction}}` renders as "" or " (jurisdiction)" so the sentence
  // stays grammatical with or without a jurisdiction configured.
  if (!lookup.has("jurisdiction")) lookup.set("jurisdiction", "");
  const render = (text: string): string =>
    text.replace(VAR_RE, (match, name: string) => {
      if (name === "jurisdiction") {
        const trimmed = (lookup.get("jurisdiction") ?? "").trim();
        return trimmed.length === 0 ? "" : ` (${trimmed})`;
      }
      return lookup.get(name) ?? match;
    });
  return { subject: render(template.subject), body: render(template.body) };
}

/** Whole days overdue (0 when due today or in the future). */
export function daysOverdue(dueDate: Date, now: Date): number {
  const diff = Math.floor((now.getTime() - dueDate.getTime()) / 86_400_000);
  return diff > 0 ? diff : 0;
}

/** Format cents as "1,200.00" for template {{amount}}. */
export function formatAmount(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatDueDate(dueDate: Date): string {
  return dueDate.toISOString().slice(0, 10);
}

/** Idempotency key for scheduling one step (stable across retries/reboots). */
export function scheduleIdempotencyKey(args: {
  milestoneId: string;
  stepKey: string;
  scheduledAt: Date;
}): string {
  const day = args.scheduledAt.toISOString().slice(0, 10);
  return `reminder:${args.milestoneId}:${args.stepKey}:${day}`;
}

/** Idempotency key for the send attempt of one notification row. */
export function sendIdempotencyKey(notificationId: string): string {
  return `reminder-send:${notificationId}`;
}
