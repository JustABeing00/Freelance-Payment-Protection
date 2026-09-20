import { z } from "zod";

/**
 * Typed domain boundaries. These branded types + enums are the single source
 * of truth for the 3-dimension state model (PRD §7, domain-model §1):
 * WORK ≠ PAYMENT ≠ DELIVERY. Never collapse to one `status`.
 */

export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type Uuid = Brand<string, "Uuid">;
export type Cents = Brand<number, "Cents">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type ProjectId = Brand<string, "ProjectId">;
export type MilestoneId = Brand<string, "MilestoneId">;

export const uuidSchema = z
  .string()
  .uuid()
  .transform((s): Uuid => s as Uuid);

export const centsSchema = z
  .number()
  .int("amount must be integer minor units (cents), never float")
  .min(0, "amount cannot be negative (use reversing rows for corrections)")
  .transform((n): Cents => n as Cents);

export const currencySchema = z
  .string()
  .length(3, "currency must be ISO-4217 (3 letters)")
  .transform((s) => s.toUpperCase());

export type Currency = Brand<string, "Currency">;

export const WORK_STATES = [
  "draft",
  "submitted",
  "viewed",
  "revision_requested",
  "approved",
  "disputed",
] as const;
export type WorkState = (typeof WORK_STATES)[number];

export const PAYMENT_STATES = [
  "unpaid",
  "requested",
  "claimed_unverified",
  "paid",
  "overdue",
  "plan_active",
  "refunded",
  "disputed",
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

export const DELIVERY_STATES = ["locked", "preview_shared", "unlocked_ready", "released"] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const TRUST_TIERS = ["low", "standard", "high"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export const ACTOR_TYPES = ["freelancer", "client", "system", "provider"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const RELEASE_CONDITIONS = [
  "current_milestone_paid",
  "all_milestones_paid",
  "manual_release",
] as const;
export type ReleaseCondition = (typeof RELEASE_CONDITIONS)[number];

/** Canonical event vocabulary (domain-model §3). Forward-compatible: unknown types preserved. */
export const EVENT_TYPES = [
  "AgreementCreated",
  "AgreementAccepted",
  "AgreementSuperseded",
  "MilestoneCreated",
  "MilestoneSubmitted",
  "MilestoneViewed",
  "RevisionRequested",
  "RevisionSubmitted",
  "MilestoneApproved",
  "ApprovalRejected",
  "ApprovalDisputed",
  "PaymentRequested",
  "PaymentClaimed",
  "PaymentReceived",
  "PaymentPartial",
  "PaymentOverdue",
  "PaymentPlanOffered",
  "PaymentPlanAccepted",
  "PaymentPlanModified",
  "PaymentPlanInstallmentPaid",
  "PaymentPlanInstallmentMissed",
  "PaymentPlanReminderSent",
  "PaymentPlanCompleted",
  "PaymentPlanDefaulted",
  "PaymentRefunded",
  "PaymentDisputed",
  "DeliverableLocked",
  "DeliverablePreviewShared",
  "DeliverableViewed",
  "DeliverableUnlockReady",
  "DeliverableReleased",
  "ManualReleaseOverride",
  "ReminderScheduled",
  "ReminderSent",
  "ReminderDelivered",
  "ReminderFailed",
  "ReminderCancelled",
  "ProjectPaused",
  "ProjectUnpaused",
  "TrustTierChanged",
  "DisputeFlagged",
  "EvidencePackGenerated",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const eventTypeSchema = z.string().refine(
  (s): s is EventType => (EVENT_TYPES as readonly string[]).includes(s),
  (s) => ({ message: `unknown event type (forward-compatible, preserved raw): ${s}` }),
);

export interface DomainEvent {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly milestoneId?: string;
  readonly deliverableId?: string;
  /** Raw string so future/unknown types survive projection (domain-model §3). */
  readonly type: string;
  readonly actorType: ActorType;
  readonly actorId?: string;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly idempotencyKey?: string;
}

export interface MilestoneProjection {
  work: WorkState;
  payment: PaymentState;
  delivery: DeliveryState;
}
