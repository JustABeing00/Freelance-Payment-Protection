/**
 * Evidence timeline — "what actually happened with this project?" (Session 14).
 *
 * Pure + DB-free. The `events` table is the append-only source of truth
 * (guarded by the `no_update_events` trigger — history is never rewritten);
 * this module only *describes* rows for display: chronological ordering,
 * stable categories, plain-language headlines, client-safe labels, and
 * in-memory filtering for the API + UI layers.
 *
 * Design rules:
 * - Every important project event maps to a category + headline. Unknown
 *   future types stay visible under `system` (forward-compatible, never
 *   dropped) so the timeline can always reconstruct history.
 * - Client-safe projection never leaks internals: raw payloads are stripped
 *   to an allowlisted subset and freelancer-only rows (portal-link hashes,
 *   webhook internals, provider refs) are hidden from the portal view.
 * - Filtering is pure so freelancer UI, portal UI and tests share semantics.
 */

export const TIMELINE_CATEGORIES = [
  "project",
  "agreement",
  "milestone",
  "deliverable",
  "approval",
  "payment",
  "reminder",
  "payment_plan",
  "access",
  "dispute",
  "system",
] as const;
export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];

export const TIMELINE_DISCLAIMER =
  "Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent.";

export interface TimelineEventInput {
  readonly id: string;
  readonly type: string;
  readonly actorType: string;
  readonly actorId?: string | undefined;
  readonly milestoneId?: string | undefined;
  readonly occurredAt: Date;
  readonly payload?: Record<string, unknown> | undefined;
}

export interface DescribedEvent {
  readonly category: TimelineCategory;
  readonly label: string;
  readonly headline: string;
  readonly detail: string;
}

interface EventDescriptor {
  readonly category: TimelineCategory;
  readonly label: string;
  /** Client may see this row in the portal timeline. */
  readonly clientSafe: boolean;
  readonly headline: (ctx: { milestone?: string; payload: Record<string, unknown> }) => string;
  readonly detail: (ctx: { milestone?: string; payload: Record<string, unknown> }) => string;
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function moneyOf(payload: Record<string, unknown>): string | undefined {
  const cents = payload.amountCents;
  const currency = payload.currency;
  if (typeof cents === "number" && Number.isInteger(cents) && typeof currency === "string") {
    return `${currency.toUpperCase()} ${(cents / 100).toFixed(2)}`;
  }
  if (typeof cents === "number" && Number.isInteger(cents)) {
    return (cents / 100).toFixed(2);
  }
  return undefined;
}

function milestoneName(milestone: string | undefined): string {
  return milestone ?? "a milestone";
}

const DESCRIPTORS: Record<string, EventDescriptor> = {
  ProjectCreated: {
    category: "project",
    label: "Project created",
    clientSafe: false,
    headline: ({ payload }) =>
      `Project created${str(payload, "title") ? ` — ${str(payload, "title")}` : ""}`,
    detail: () => "The project record was opened. This starts the evidence trail.",
  },
  ProjectPaused: {
    category: "project",
    label: "Work paused",
    clientSafe: true,
    headline: () => "Work paused",
    detail: ({ payload }) =>
      str(payload, "reason") ?? "Work was paused. Delivery resumes when unpaused.",
  },
  ProjectUnpaused: {
    category: "project",
    label: "Work resumed",
    clientSafe: true,
    headline: () => "Work resumed",
    detail: () => "Work resumed after a pause.",
  },
  AgreementCreated: {
    category: "agreement",
    label: "Agreement created",
    clientSafe: true,
    headline: ({ payload }) => {
      const version = payload.version;
      const label =
        typeof version === "number" || typeof version === "string" ? String(version) : "?";
      return `Agreement draft v${label} created`;
    },
    detail: () => "Payment terms were drafted. Corrections are new versions, never edits.",
  },
  AgreementSent: {
    category: "agreement",
    label: "Agreement sent",
    clientSafe: true,
    headline: () => "Agreement sent for acceptance",
    detail: () => "The agreement is awaiting client acceptance.",
  },
  AgreementAccepted: {
    category: "agreement",
    label: "Agreement accepted",
    clientSafe: true,
    headline: () => "Agreement accepted",
    detail: () => "Acceptance was recorded with a hash-pinned copy of the terms.",
  },
  AgreementSuperseded: {
    category: "agreement",
    label: "Agreement superseded",
    clientSafe: true,
    headline: () => "Agreement superseded by a newer version",
    detail: () => "An older version was replaced. Its bytes are preserved in history.",
  },
  AgreementVoided: {
    category: "agreement",
    label: "Agreement voided",
    clientSafe: true,
    headline: () => "Agreement voided",
    detail: () => "The version was withdrawn before acceptance.",
  },
  MilestoneCreated: {
    category: "milestone",
    label: "Milestone created",
    clientSafe: true,
    headline: ({ milestone, payload }) =>
      `Milestone created — ${str(payload, "title") ?? milestoneName(milestone)}${moneyOf(payload) ? ` (${moneyOf(payload)})` : ""}`,
    detail: () => "The milestone was added to the project schedule.",
  },
  MilestoneAmountChanged: {
    category: "milestone",
    label: "Milestone amount changed",
    clientSafe: true,
    headline: ({ milestone }) => `Amount changed on ${milestoneName(milestone)}`,
    detail: () => "The invoiced amount changed with an audit note. Prior amounts stay in history.",
  },
  MilestoneWorkStarted: {
    category: "milestone",
    label: "Work started",
    clientSafe: true,
    headline: ({ milestone }) => `Work started on ${milestoneName(milestone)}`,
    detail: () => "The freelancer started work on this milestone.",
  },
  MilestoneSubmitted: {
    category: "milestone",
    label: "Submitted for review",
    clientSafe: true,
    headline: ({ milestone }) => `${milestoneName(milestone)} submitted for review`,
    detail: () => "Work was submitted. The client was asked to review the preview.",
  },
  MilestoneViewed: {
    category: "milestone",
    label: "Preview viewed",
    clientSafe: false,
    headline: ({ milestone }) => `${milestoneName(milestone)} preview viewed`,
    detail: () => "The preview was opened. Viewing is review only — finals stay locked.",
  },
  RevisionRequested: {
    category: "approval",
    label: "Revision requested",
    clientSafe: true,
    headline: ({ milestone, payload }) =>
      `Revision requested on ${milestoneName(milestone)}${str(payload, "note") ? ` — ${str(payload, "note")}` : ""}`,
    detail: () => "The client asked for changes. The note explains what to fix.",
  },
  RevisionSubmitted: {
    category: "milestone",
    label: "Revision submitted",
    clientSafe: true,
    headline: ({ milestone }) => `Revision submitted for ${milestoneName(milestone)}`,
    detail: () =>
      "A new version was submitted. Earlier approvals stay true for their version only.",
  },
  MilestoneApproved: {
    category: "approval",
    label: "Milestone approved",
    clientSafe: true,
    headline: ({ milestone }) => `${milestoneName(milestone)} approved`,
    detail: () =>
      "Approval was recorded against the current version. Payment completes the milestone.",
  },
  MilestoneApprovalRejected: {
    category: "approval",
    label: "Approval rejected",
    clientSafe: true,
    headline: ({ milestone }) => `${milestoneName(milestone)} was not approved`,
    detail: () => "The submission was declined. A revision or dispute follows.",
  },
  ApprovalRejected: {
    category: "approval",
    label: "Approval rejected",
    clientSafe: true,
    headline: ({ milestone }) => `${milestoneName(milestone)} was not approved`,
    detail: () => "A formal rejection decision was recorded against the pinned version.",
  },
  ApprovalDisputed: {
    category: "dispute",
    label: "Approval disputed",
    clientSafe: true,
    headline: ({ milestone }) => `A question was raised on ${milestoneName(milestone)}`,
    detail: () => "The approval is disputed. Work and payment freeze until resolved.",
  },
  PaymentRequested: {
    category: "payment",
    label: "Payment requested",
    clientSafe: true,
    headline: ({ milestone, payload }) =>
      `Payment requested for ${milestoneName(milestone)}${moneyOf(payload) ? ` — ${moneyOf(payload)}` : ""}`,
    detail: () => "A payment request was sent. Only verified provider receipts count as paid.",
  },
  PaymentCreated: {
    category: "payment",
    label: "Checkout created",
    clientSafe: false,
    headline: ({ milestone }) => `Checkout created for ${milestoneName(milestone)}`,
    detail: () => "A hosted checkout was started. This proves nothing until the provider confirms.",
  },
  PaymentPending: {
    category: "payment",
    label: "Payment pending",
    clientSafe: true,
    headline: ({ milestone }) => `Payment in progress for ${milestoneName(milestone)}`,
    detail: () => "The provider is processing. The milestone counts it only on confirmation.",
  },
  PaymentClaimed: {
    category: "payment",
    label: "Payment claimed (unverified)",
    clientSafe: true,
    headline: ({ milestone }) => `Client says they paid ${milestoneName(milestone)} — NOT verified`,
    detail: () =>
      "A client assertion only. Nothing counts toward totals until a provider receipt arrives.",
  },
  PaymentReceived: {
    category: "payment",
    label: "Payment received",
    clientSafe: true,
    headline: ({ milestone, payload }) =>
      `Payment received for ${milestoneName(milestone)}${moneyOf(payload) ? ` — ${moneyOf(payload)}` : ""}`,
    detail: () => "A verified provider receipt confirmed the money.",
  },
  PaymentPartial: {
    category: "payment",
    label: "Partial payment",
    clientSafe: true,
    headline: ({ milestone }) => `Partial payment for ${milestoneName(milestone)}`,
    detail: () => "Part of the milestone amount arrived. The remainder is still due.",
  },
  PaymentOverdue: {
    category: "payment",
    label: "Payment overdue",
    clientSafe: true,
    headline: ({ milestone }) => `Payment for ${milestoneName(milestone)} is overdue`,
    detail: () => "The due date passed without verified payment. A calm reminder is appropriate.",
  },
  PaymentPlanOffered: {
    category: "payment_plan",
    label: "Payment plan proposed",
    clientSafe: true,
    headline: ({ milestone }) => `Payment plan proposed for ${milestoneName(milestone)}`,
    detail: () =>
      "A restructured installment schedule was offered. It is binding only once accepted.",
  },
  PaymentPlanAccepted: {
    category: "payment_plan",
    label: "Payment plan accepted",
    clientSafe: true,
    headline: ({ milestone }) => `Payment plan accepted for ${milestoneName(milestone)}`,
    detail: () => "Both sides agreed to the installment schedule.",
  },
  PaymentPlanModified: {
    category: "payment_plan",
    label: "Payment plan modified",
    clientSafe: true,
    headline: ({ milestone }) => `Payment plan modified for ${milestoneName(milestone)}`,
    detail: () => "The schedule was replaced by a new version. The old version stays in history.",
  },
  PaymentPlanInstallmentPaid: {
    category: "payment_plan",
    label: "Installment paid",
    clientSafe: true,
    headline: ({ milestone }) => `Plan installment paid for ${milestoneName(milestone)}`,
    detail: () => "A verified receipt covered one installment of the plan.",
  },
  PaymentPlanInstallmentMissed: {
    category: "payment_plan",
    label: "Installment missed",
    clientSafe: true,
    headline: ({ milestone }) => `Plan installment missed for ${milestoneName(milestone)}`,
    detail: () => "An installment passed its due date unpaid.",
  },
  PaymentPlanReminderSent: {
    category: "reminder",
    label: "Plan reminder sent",
    clientSafe: false,
    headline: ({ milestone }) => `Plan reminder sent for ${milestoneName(milestone)}`,
    detail: () => "An automatic system-voiced installment reminder was sent.",
  },
  PaymentPlanCompleted: {
    category: "payment_plan",
    label: "Payment plan completed",
    clientSafe: true,
    headline: ({ milestone }) => `Payment plan completed for ${milestoneName(milestone)}`,
    detail: () => "Every installment settled. The milestone is paid.",
  },
  PaymentPlanDefaulted: {
    category: "payment_plan",
    label: "Payment plan defaulted",
    clientSafe: true,
    headline: ({ milestone }) => `Payment plan defaulted for ${milestoneName(milestone)}`,
    detail: () => "The plan defaulted. The outstanding obligation stands.",
  },
  PaymentRefunded: {
    category: "payment",
    label: "Payment refunded",
    clientSafe: true,
    headline: ({ milestone }) => `Refund confirmed for ${milestoneName(milestone)}`,
    detail: () => "The provider returned the funds. Delivery history stays as it happened.",
  },
  PaymentDisputed: {
    category: "dispute",
    label: "Payment disputed",
    clientSafe: true,
    headline: ({ milestone }) => `Payment dispute on ${milestoneName(milestone)}`,
    detail: () => "Funds may be reversed. Do not release finals until this clears.",
  },
  PaymentCancelled: {
    category: "payment",
    label: "Payment cancelled",
    clientSafe: true,
    headline: ({ milestone }) => `Payment cancelled for ${milestoneName(milestone)}`,
    detail: () => "The attempt was cancelled. No money moved.",
  },
  PaymentReconciled: {
    category: "payment",
    label: "Reconciliation check",
    clientSafe: false,
    headline: ({ milestone }) => `Reconciliation checked ${milestoneName(milestone)}`,
    detail: () =>
      "A server-to-server read-back compared local state with the provider. No history rewritten.",
  },
  PaymentAmountMismatched: {
    category: "payment",
    label: "Needs review",
    clientSafe: false,
    headline: ({ milestone }) => `Needs review for ${milestoneName(milestone)}`,
    detail: ({ payload }) =>
      str(payload, "reason") ??
      "A provider event disagreed with local state. Kept local state for review.",
  },
  DisputeFlagged: {
    category: "dispute",
    label: "Dispute flagged",
    clientSafe: true,
    headline: ({ milestone }) => `Dispute flagged on ${milestoneName(milestone)}`,
    detail: () => "Work and payment freeze until the dispute is resolved.",
  },
  DeliverableLocked: {
    category: "deliverable",
    label: "Deliverable locked",
    clientSafe: false,
    headline: ({ milestone }) => `Deliverable locked for ${milestoneName(milestone)}`,
    detail: () => "Final files are locked until payment and approval conditions are met.",
  },
  DeliverableVersionCreated: {
    category: "deliverable",
    label: "Deliverable uploaded",
    clientSafe: false,
    headline: ({ milestone, payload }) => {
      const no = payload.versionNo;
      const suffix = typeof no === "number" || typeof no === "string" ? ` (v${String(no)})` : "";
      return `Deliverable uploaded for ${milestoneName(milestone)}${suffix}`;
    },
    detail: () =>
      "A new deliverable version was stored. Review happens on previews, never raw finals.",
  },
  DeliverableSubmitted: {
    category: "deliverable",
    label: "Deliverable submitted",
    clientSafe: true,
    headline: ({ milestone }) => `Deliverable submitted for ${milestoneName(milestone)}`,
    detail: () => "The deliverable was submitted for client review.",
  },
  DeliverablePreviewShared: {
    category: "deliverable",
    label: "Preview shared",
    clientSafe: true,
    headline: ({ milestone }) => `Preview shared for ${milestoneName(milestone)}`,
    detail: () => "A time-boxed preview is available. Previews are a review aid, not DRM.",
  },
  DeliverableViewed: {
    category: "deliverable",
    label: "Preview viewed",
    clientSafe: false,
    headline: ({ milestone }) => `Preview viewed for ${milestoneName(milestone)}`,
    detail: () => "The preview was opened by the client.",
  },
  DeliverableUnlockReady: {
    category: "deliverable",
    label: "Finals ready",
    clientSafe: true,
    headline: ({ milestone }) => `Final files ready for ${milestoneName(milestone)}`,
    detail: () => "Finals are staged and will unlock once payment is verified.",
  },
  DeliverableReleased: {
    category: "deliverable",
    label: "Final asset unlocked",
    clientSafe: true,
    headline: ({ milestone }) => `Final files released for ${milestoneName(milestone)}`,
    detail: () => "Approval plus verified payment unlocked the final asset.",
  },
  ManualReleaseOverride: {
    category: "deliverable",
    label: "Manual release",
    clientSafe: false,
    headline: ({ milestone }) => `Finals manually released for ${milestoneName(milestone)}`,
    detail: () => "A flagged manual override released the finals with a recorded reason.",
  },
  DeliverableStagingPublished: {
    category: "deliverable",
    label: "Staging published",
    clientSafe: true,
    headline: ({ milestone }) => `Staging site published for ${milestoneName(milestone)}`,
    detail: () => "A reviewable staging URL is live. Production transfer still requires release.",
  },
  DeliverableStagingTransferRequested: {
    category: "deliverable",
    label: "Transfer requested",
    clientSafe: false,
    headline: ({ milestone }) => `Production transfer requested for ${milestoneName(milestone)}`,
    detail: () => "Handoff of the production site was requested.",
  },
  DeliverableStagingTransferred: {
    category: "deliverable",
    label: "Transfer completed",
    clientSafe: true,
    headline: ({ milestone }) => `Production transfer completed for ${milestoneName(milestone)}`,
    detail: () => "The production handoff completed after release.",
  },
  ReminderScheduled: {
    category: "reminder",
    label: "Reminder scheduled",
    clientSafe: false,
    headline: ({ milestone }) => `Reminder scheduled for ${milestoneName(milestone)}`,
    detail: () => "An automatic reminder was queued. Manual escalation steps stay manual-only.",
  },
  ReminderSent: {
    category: "reminder",
    label: "Reminder sent",
    clientSafe: false,
    headline: ({ milestone }) => `Reminder sent for ${milestoneName(milestone)}`,
    detail: () => "A system-voiced payment reminder was sent to the client.",
  },
  ReminderDelivered: {
    category: "reminder",
    label: "Reminder delivered",
    clientSafe: false,
    headline: ({ milestone }) => `Reminder delivered for ${milestoneName(milestone)}`,
    detail: () => "The provider confirmed delivery of the reminder.",
  },
  ReminderFailed: {
    category: "reminder",
    label: "Reminder failed",
    clientSafe: false,
    headline: ({ milestone }) => `Reminder failed for ${milestoneName(milestone)}`,
    detail: () => "Sending failed. Safe to retry — the attempt is recorded.",
  },
  ReminderCancelled: {
    category: "reminder",
    label: "Reminder cancelled",
    clientSafe: false,
    headline: ({ milestone }) => `Reminder cancelled for ${milestoneName(milestone)}`,
    detail: () => "A queued reminder was cancelled. History is preserved.",
  },
  NotificationQueued: {
    category: "reminder",
    label: "Notification queued",
    clientSafe: false,
    headline: ({ milestone, payload }) => {
      const kind = str(payload, "kind");
      return kind
        ? `Notification queued (${kind}) for ${milestoneName(milestone)}`
        : `Notification queued for ${milestoneName(milestone)}`;
    },
    detail: ({ payload }) => {
      const category = str(payload, "category");
      return category
        ? `A transactional ${category} notice was queued (email + in-app). Delivery status lives in the notification center.`
        : "A transactional notice was queued (email + in-app). Delivery status lives in the notification center.";
    },
  },
  PortalLinkIssued: {
    category: "access",
    label: "Portal link issued",
    clientSafe: false,
    headline: () => "Client portal link issued",
    detail: () => "A magic link was issued. Only its hash is stored; the raw token was shown once.",
  },
  PortalLinkRevoked: {
    category: "access",
    label: "Portal link revoked",
    clientSafe: false,
    headline: () => "Client portal link revoked",
    detail: () => "A magic link was revoked. It can no longer be used.",
  },
  TrustTierChanged: {
    category: "system",
    label: "Trust tier changed",
    clientSafe: false,
    headline: () => "Trust tier changed",
    detail: () => "The client trust tier changed, adjusting workflow guardrails.",
  },
  EvidencePackGenerated: {
    category: "system",
    label: "Evidence pack exported",
    clientSafe: false,
    headline: () => "Evidence pack exported",
    detail: () => "A hash-pinned snapshot of agreements plus the event range was generated.",
  },
  WebhookReceived: {
    category: "system",
    label: "Provider webhook",
    clientSafe: false,
    headline: () => "Provider webhook received",
    detail: () => "A raw provider event arrived. Money moves only after verification.",
  },
};

function fallbackDescriptor(type: string): EventDescriptor {
  return {
    category: "system",
    label: humanize(type),
    clientSafe: false,
    headline: () => humanize(type),
    detail: () => "Recorded for audit. No display mapping yet — the raw event is preserved.",
  };
}

export function humanize(type: string): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function eventCategory(type: string): TimelineCategory {
  return (DESCRIPTORS[type] ?? fallbackDescriptor(type)).category;
}

export function eventLabel(type: string): string {
  return (DESCRIPTORS[type] ?? fallbackDescriptor(type)).label;
}

export function isClientSafeEvent(type: string): boolean {
  return (DESCRIPTORS[type] ?? fallbackDescriptor(type)).clientSafe;
}

/** Full plain-language description of one row. Never throws on unknown types. */
export function describeEvent(input: {
  type: string;
  milestoneTitle?: string | undefined;
  payload?: Record<string, unknown> | undefined;
}): DescribedEvent {
  const d = DESCRIPTORS[input.type] ?? fallbackDescriptor(input.type);
  const ctx = {
    ...(input.milestoneTitle !== undefined ? { milestone: input.milestoneTitle } : {}),
    payload: input.payload ?? {},
  };
  return {
    category: d.category,
    label: d.label,
    headline: d.headline(ctx),
    detail: d.detail(ctx),
  };
}

export interface TimelineFilter {
  readonly types?: readonly string[] | undefined;
  readonly categories?: readonly TimelineCategory[] | undefined;
  readonly actorTypes?: readonly string[] | undefined;
  readonly milestoneId?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly search?: string | undefined;
}

/** Chronological (oldest-first) filter over already-scoped rows. Pure. */
export function filterTimeline<T extends TimelineEventInput>(
  events: readonly T[],
  filter: TimelineFilter = {},
): T[] {
  const search = filter.search?.trim().toLowerCase();
  return [...events]
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    .filter((e) => {
      if (filter.types && filter.types.length > 0 && !filter.types.includes(e.type)) return false;
      if (
        filter.categories &&
        filter.categories.length > 0 &&
        !filter.categories.includes(eventCategory(e.type))
      ) {
        return false;
      }
      if (
        filter.actorTypes &&
        filter.actorTypes.length > 0 &&
        !filter.actorTypes.includes(e.actorType)
      ) {
        return false;
      }
      if (filter.milestoneId !== undefined) {
        if (e.milestoneId !== filter.milestoneId) return false;
      }
      if (filter.from !== undefined && e.occurredAt < filter.from) return false;
      if (filter.to !== undefined && e.occurredAt > filter.to) return false;
      if (search) {
        const hay =
          `${e.type} ${e.actorType} ${e.milestoneId ?? ""} ${JSON.stringify(e.payload ?? {})}`.toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });
}

/**
 * Client-safe projection of a payload: allowlisted scalar facts only.
 * Hashes, tokens, provider refs, device fingerprints and raw internals never
 * leave the server through the portal timeline.
 */
const CLIENT_SAFE_PAYLOAD_KEYS = new Set([
  "title",
  "version",
  "amountCents",
  "currency",
  "note",
  "reason",
  "dueDate",
  "milestoneTitle",
]);

export function toClientSafePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!CLIENT_SAFE_PAYLOAD_KEYS.has(k)) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

export function summarizeTimeline(events: readonly TimelineEventInput[]): {
  totalCount: number;
  byCategory: Record<string, number>;
  byActor: Record<string, number>;
  oldestAt?: string | undefined;
  newestAt?: string | undefined;
} {
  const byCategory: Record<string, number> = {};
  const byActor: Record<string, number> = {};
  for (const e of events) {
    const c = eventCategory(e.type);
    byCategory[c] = (byCategory[c] ?? 0) + 1;
    byActor[e.actorType] = (byActor[e.actorType] ?? 0) + 1;
  }
  const ordered = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  return {
    totalCount: events.length,
    byCategory,
    byActor,
    ...(ordered[0] ? { oldestAt: ordered[0].occurredAt.toISOString() } : {}),
    ...(ordered[ordered.length - 1]
      ? { newestAt: ordered[ordered.length - 1]?.occurredAt.toISOString() }
      : {}),
  };
}
