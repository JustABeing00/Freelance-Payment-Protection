import type {
  ActorType,
  DeliveryState,
  DomainEvent,
  MilestoneProjection,
  PaymentState,
  WorkState,
} from "./types.js";

/**
 * Event-sourced projection: reduce(events) → { work, payment, delivery }.
 * Stored status columns (if any) are caches; this reducer is authority.
 * Unknown future event types are ignored for state but preserved in history.
 */
export function reduceMilestone(events: readonly DomainEvent[]): MilestoneProjection {
  const ordered = [...events].sort((a, b) => {
    const t = a.occurredAt.getTime() - b.occurredAt.getTime();
    if (t !== 0) return t;
    return a.recordedAt.getTime() - b.recordedAt.getTime();
  });

  let work: WorkState = "draft";
  let payment: PaymentState = "unpaid";
  let delivery: DeliveryState = "locked";

  for (const e of ordered) {
    switch (e.type) {
      case "MilestoneSubmitted":
      case "RevisionSubmitted":
        if (work !== "disputed") work = "submitted";
        break;
      case "MilestoneViewed":
        if (work === "submitted") work = "viewed";
        break;
      case "RevisionRequested":
        if (work !== "disputed") work = "revision_requested";
        break;
      case "MilestoneApproved":
        if (work !== "disputed") work = "approved";
        break;
      case "ApprovalRejected":
        // A rejection is a decision, not work progress: the work stays where
        // it was (submitted/viewed) so the freelancer can revise and resubmit.
        break;
      case "ApprovalDisputed":
        work = "disputed";
        payment = "disputed";
        break;
      case "PaymentRequested":
        if (payment === "unpaid") payment = "requested";
        break;
      case "PaymentClaimed":
        // INVARIANT: client claims never mark paid (PRD FR-19).
        if (payment === "unpaid" || payment === "requested" || payment === "overdue") {
          payment = "claimed_unverified";
        }
        break;
      case "PaymentReceived":
      case "PaymentPartial":
        // Whether fully paid is decided by money math; receipt moves state forward.
        // The paid-vs-partial distinction is resolved by sum(received) >= amount
        // in the query layer; here we record confirmation happened.
        if (payment !== "refunded" && payment !== "disputed") payment = "paid";
        break;
      case "PaymentOverdue":
        if (payment !== "paid" && payment !== "refunded") payment = "overdue";
        break;
      case "PaymentPlanAccepted":
        if (payment !== "paid") payment = "plan_active";
        break;
      case "PaymentPlanOffered":
      case "PaymentPlanModified":
      case "PaymentPlanInstallmentPaid":
      case "PaymentPlanInstallmentMissed":
      case "PaymentPlanReminderSent":
        break;
      case "PaymentPlanCompleted":
        if (payment !== "refunded" && payment !== "disputed") payment = "paid";
        break;
      case "PaymentPlanDefaulted":
        payment = "overdue";
        break;
      case "PaymentRefunded":
        payment = "refunded";
        break;
      case "PaymentDisputed":
      case "DisputeFlagged":
        work = "disputed";
        payment = "disputed";
        break;
      case "DeliverableLocked":
        if (delivery !== "released") delivery = "locked";
        break;
      case "DeliverablePreviewShared":
        if (delivery === "locked") delivery = "preview_shared";
        break;
      case "DeliverableUnlockReady":
        if (delivery !== "released") delivery = "unlocked_ready";
        break;
      case "DeliverableReleased":
      case "ManualReleaseOverride":
        delivery = "released";
        break;
      default:
        // Forward-compatible: unknown types (Agreement*, Reminder*, pause, trust…)
        // do not affect milestone projection but remain in the export timeline.
        break;
    }
  }

  return { work, payment, delivery };
}

export function actorOf(event: Pick<DomainEvent, "actorType" | "actorId">): ActorType {
  return event.actorType;
}

export function isTerminalDelivery(state: DeliveryState): boolean {
  return state === "released";
}
