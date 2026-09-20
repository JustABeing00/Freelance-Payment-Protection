import { projectOutstandingCents } from "./money.js";
import type {
  AgreementRecord,
  ClientRecord,
  MilestoneRecord,
  PaymentRecord,
  ProjectEventRecord,
  ProjectRecord,
} from "../lib/store.js";

/**
 * Client-portal projection (Session 07).
 * Pure + DB-free. The caller passes rows; this module decides what a client
 * may see. Freelancer-only fields are NEVER accepted here — the input types
 * carry only the client-safe subset, so a route cannot accidentally leak
 * `client.notes`, billing contacts, IP/UA hashes, or internal audit trails
 * by spreading a full record.
 */

export interface PortalClientInput {
  readonly name: string;
  readonly company?: string | undefined;
}

export interface PortalMilestoneView {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly dueDate?: string | undefined;
  /** Calm one-line state, e.g. "Ready for review", "In progress", "Locked". */
  readonly stage: string;
  /** One-line headline answering "what needs my approval / payment?". */
  readonly headline: string;
  readonly detail: string;
  readonly needsAction: boolean;
  readonly canApprove: boolean;
  readonly canRequestRevision: boolean;
  readonly canPay: boolean;
  readonly paymentLabel: string;
  readonly deliveryLabel: string;
  readonly lockReason?: string | undefined;
}

export interface PortalPaymentView {
  readonly milestoneTitle: string;
  readonly amountCents: number;
  readonly stateLabel: string;
  readonly receivedAt?: string | undefined;
}

export interface PortalAgreementView {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly statusLabel: string;
  readonly totalAmountCents: number;
  readonly currency: string;
  readonly hash: string;
  readonly termsText: string;
  readonly whatItMeans: string;
  readonly acceptedAt?: string | undefined;
}

export interface PortalActivityItem {
  readonly label: string;
  readonly when: string;
  readonly actorLabel: string;
}

export interface ClientPortalView {
  readonly projectTitle: string;
  readonly projectDescription?: string | undefined;
  readonly currency: string;
  readonly clientName: string;
  readonly company?: string | undefined;
  readonly totalCents: number;
  readonly paidCents: number;
  readonly dueNowCents: number;
  readonly remainingCents: number;
  readonly progressPercent: number;
  readonly paymentStatus: "paid" | "partial" | "unpaid" | "overdue" | "disputed";
  readonly focusHeadline: string;
  readonly focusBody: string;
  readonly focusMilestoneId?: string | undefined;
  readonly milestones: readonly PortalMilestoneView[];
  readonly payments: readonly PortalPaymentView[];
  readonly agreement: PortalAgreementView | null;
  readonly activity: readonly PortalActivityItem[];
  readonly nextSteps: readonly string[];
  readonly lockedExplanations: readonly { title: string; why: string; unlocksWhen: string }[];
  readonly disclaimer: string;
}

export const PORTAL_DISCLAIMER =
  "Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent.";

const RECEIVED = new Set(["received", "partial", "paid"]);

function verifiedPaid(payments: readonly PaymentRecord[]): number {
  let sum = 0;
  for (const p of payments) {
    if (RECEIVED.has(p.state) && Number.isInteger(p.amountCents) && p.amountCents > 0) {
      sum += p.amountCents;
    }
  }
  return sum;
}

function paymentLabel(payment: string): string {
  switch (payment) {
    case "paid":
      return "Paid — thank you";
    case "funded":
      return "Payment confirmed";
    case "payment_pending":
      return "Payment in progress";
    case "claimed_unverified":
      return "Payment noted — confirming";
    case "overdue":
      return "Payment due";
    case "refunded":
      return "Refunded";
    case "disputed":
      return "Needs discussion";
    case "plan_active":
      return "Payment plan active";
    default:
      return "Payment due";
  }
}

function deliveryLabel(deliverable: string): string {
  switch (deliverable) {
    case "released":
      return "Final files available";
    case "unlocked_ready":
      return "Final files ready — unlocks on payment";
    case "preview_shared":
      return "Preview shared";
    default:
      return "Final files locked";
  }
}

function actorLabel(actorType: string): string {
  if (actorType === "client") return "You";
  if (actorType === "freelancer") return "Your studio";
  return "System";
}

const CLIENT_SAFE_EVENTS: Record<string, (title?: string) => string> = {
  MilestoneSubmitted: (t) => `${t ?? "A milestone"} is ready for review`,
  MilestoneViewed: (t) => `${t ?? "A milestone"} was viewed`,
  MilestoneApproved: (t) => `${t ?? "A milestone"} was approved`,
  ApprovalRejected: (t) => `${t ?? "A milestone"} was not approved`,
  ApprovalDisputed: (t) => `A question was raised on ${t ?? "a milestone"}`,
  RevisionRequested: (t) => `Changes requested on ${t ?? "a milestone"}`,
  PaymentRequested: (t) => `Payment requested for ${t ?? "a milestone"}`,
  PaymentReceived: (t) => `Payment received for ${t ?? "a milestone"} — thank you`,
  PaymentOverdue: (t) => `Payment for ${t ?? "a milestone"} is now due`,
  DeliverablePreviewShared: (t) => `A preview is ready for ${t ?? "a milestone"}`,
  DeliverableReleased: (t) => `Final files released for ${t ?? "a milestone"}`,
  AgreementSent: () => "Your agreement is ready to review",
  AgreementAccepted: () => "Agreement accepted — thank you",
  AgreementCreated: () => "Agreement updated",
};

function humanize(type: string): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function milestoneTitleById(
  milestones: readonly MilestoneRecord[],
  id: string | undefined,
): string | undefined {
  if (!id) return undefined;
  return milestones.find((m) => m.id === id)?.title;
}

function stageFor(m: MilestoneRecord): { stage: string; headline: string; detail: string } {
  const name = m.title;
  if (m.paymentState === "paid" && m.deliverableState === "released") {
    return {
      stage: "Complete",
      headline: `${name} is complete`,
      detail: "Paid and final files released. Nothing further needed.",
    };
  }
  if (m.paymentState === "paid") {
    return {
      stage: "Paid",
      headline: `${name} is paid`,
      detail: "Payment confirmed. Final files unlock automatically once released.",
    };
  }
  if (m.workState === "submitted" || m.workState === "viewed") {
    return {
      stage: "Ready for review",
      headline: `${name} is ready for review`,
      detail: "Take a look at the preview. Approve it, or request changes.",
    };
  }
  if (m.workState === "revision_requested") {
    return {
      stage: "Changes in progress",
      headline: `Changes are in progress on ${name}`,
      detail: "Your studio is addressing your feedback. No action needed right now.",
    };
  }
  if (m.workState === "approved" && m.paymentState !== "paid") {
    return {
      stage: "Approved — payment due",
      headline: `${name} is approved — payment completes it`,
      detail: "Approval recorded. Completing payment releases the final files.",
    };
  }
  if (m.unlockState === "locked") {
    return {
      stage: "Locked",
      headline: `${name} is locked for now`,
      detail: "It unlocks automatically once the earlier milestone is complete.",
    };
  }
  if (m.workState === "in_progress") {
    return {
      stage: "In progress",
      headline: `${name} is in progress`,
      detail: "Work is underway. You will be notified when it is ready for review.",
    };
  }
  return {
    stage: "Upcoming",
    headline: `${name} is upcoming`,
    detail: "Scheduled after the current milestone. No action needed yet.",
  };
}

export function toPortalClient(client: Pick<ClientRecord, "name" | "company">): PortalClientInput {
  return client.company ? { name: client.name, company: client.company } : { name: client.name };
}

export function buildPortalView(args: {
  project: ProjectRecord;
  client: PortalClientInput;
  milestones: readonly MilestoneRecord[];
  payments: readonly PaymentRecord[];
  events: readonly ProjectEventRecord[];
  agreements: readonly AgreementRecord[];
  now?: Date | undefined;
}): ClientPortalView {
  const { project, client, milestones, payments, events, agreements } = args;

  const ordered = [...milestones].sort((a, b) => a.orderIndex - b.orderIndex);
  const paid = verifiedPaid(payments);
  const basis = ordered.length > 0 ? ordered.map((m) => m.amountCents) : [project.totalValueCents];
  const receivedLike = payments.map((p) => ({
    ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
    amountCents: p.amountCents,
    state: RECEIVED.has(p.state) ? "received" : p.state,
  }));
  const remaining = projectOutstandingCents(basis, receivedLike);

  const paidIds = new Set(
    ordered
      .filter((m) => {
        const got = payments
          .filter((p) => p.milestoneId === m.id && RECEIVED.has(p.state))
          .reduce((s, p) => s + p.amountCents, 0);
        return got >= m.amountCents;
      })
      .map((m) => m.id),
  );

  const actionable =
    ordered.find(
      (m) =>
        !paidIds.has(m.id) &&
        (m.workState === "submitted" ||
          m.workState === "viewed" ||
          (m.workState === "approved" && m.paymentState !== "paid")),
    ) ??
    ordered.find((m) => !paidIds.has(m.id)) ??
    null;

  const dueNow = actionable && !paidIds.has(actionable.id) ? actionable.amountCents : 0;

  let paymentStatus: ClientPortalView["paymentStatus"] = "unpaid";
  const disputed = events.some((e) => e.type === "PaymentDisputed" || e.type === "DisputeFlagged");
  const overdue = ordered.some((m) => m.paymentState === "overdue" && !paidIds.has(m.id));
  if (disputed) paymentStatus = "disputed";
  else if (remaining <= 0 && (paid > 0 || ordered.length === 0)) paymentStatus = "paid";
  else if (overdue) paymentStatus = "overdue";
  else if (paid > 0) paymentStatus = "partial";

  let focusHeadline: string;
  let focusBody: string;
  if (!actionable) {
    focusHeadline = "All settled — thank you";
    focusBody = "Every milestone is paid and released. Your final files are available below.";
  } else if (actionable.workState === "submitted" || actionable.workState === "viewed") {
    focusHeadline = `${actionable.title} is ready for review`;
    focusBody = "Approve it to move forward, or request changes. Payment completes the milestone.";
  } else if (actionable.workState === "approved" && !paidIds.has(actionable.id)) {
    focusHeadline = `${actionable.title} is approved — payment completes it`;
    focusBody = "Your approval is recorded. Completing payment releases the final files.";
  } else if (actionable.workState === "revision_requested") {
    focusHeadline = `Changes are in progress on ${actionable.title}`;
    focusBody = "No action needed right now — you will be notified when it is ready again.";
  } else if (actionable.unlockState === "locked") {
    focusHeadline = `${actionable.title} unlocks next`;
    focusBody = "It becomes available automatically once the current milestone is complete.";
  } else {
    focusHeadline = `${actionable.title} is in progress`;
    focusBody = "Work is underway. You will be notified when it is ready for review.";
  }

  const currentHead = agreements
    .filter((a) => a.isCurrent)
    .sort((a, b) => b.version - a.version)[0];
  const agreement: PortalAgreementView | null = currentHead
    ? {
        id: currentHead.id,
        version: currentHead.version,
        status: currentHead.status,
        statusLabel:
          currentHead.status === "accepted"
            ? "Accepted"
            : currentHead.status === "pending_acceptance"
              ? "Awaiting your acceptance"
              : currentHead.status === "voided"
                ? "Withdrawn"
                : "Draft",
        totalAmountCents: currentHead.totalAmountCents,
        currency: currentHead.currency,
        hash: currentHead.hash,
        termsText: currentHead.termsText,
        whatItMeans:
          currentHead.status === "accepted"
            ? "You accepted these terms. The milestones and amounts below follow them."
            : "Please read these terms. Accepting confirms what you are buying and when payment is due.",
        ...(currentHead.acceptedAt ? { acceptedAt: currentHead.acceptedAt.toISOString() } : {}),
      }
    : null;

  const milestoneViews: PortalMilestoneView[] = ordered.map((m, i) => {
    const s = stageFor(m);
    const locked = m.unlockState === "locked";
    const predecessor = i > 0 ? (ordered[i - 1]?.title ?? "the earlier milestone") : "";
    const canApprove = m.workState === "submitted" || m.workState === "viewed";
    const canPay = !paidIds.has(m.id) && m.paymentState !== "paid" && m.paymentState !== "refunded";
    return {
      id: m.id,
      position: i + 1,
      title: m.title,
      amountCents: m.amountCents,
      currency: m.currency,
      ...(m.dueDate ? { dueDate: m.dueDate.toISOString() } : {}),
      stage: s.stage,
      headline: s.headline,
      detail: s.detail,
      needsAction: canApprove || (m.workState === "approved" && canPay),
      canApprove,
      canRequestRevision: canApprove,
      canPay,
      paymentLabel: paymentLabel(m.paymentState),
      deliveryLabel: deliveryLabel(m.deliverableState),
      ...(locked
        ? {
            lockReason: `Locked until ${predecessor} is complete. No payment is required for this milestone yet.`,
          }
        : {}),
    };
  });

  const paymentViews: PortalPaymentView[] = payments
    .filter((p) => RECEIVED.has(p.state))
    .map((p) => ({
      milestoneTitle: milestoneTitleById(ordered, p.milestoneId) ?? "Project payment",
      amountCents: p.amountCents,
      stateLabel: "Paid",
      ...(p.receivedAt ? { receivedAt: p.receivedAt.toISOString() } : {}),
    }));

  const activity: PortalActivityItem[] = [...events]
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 12)
    .map((e) => {
      const title = milestoneTitleById(ordered, e.milestoneId);
      const fn = CLIENT_SAFE_EVENTS[e.type];
      return {
        label: fn ? fn(title) : humanize(e.type),
        when: e.occurredAt.toISOString(),
        actorLabel: actorLabel(e.actorType),
      };
    });

  const nextSteps: string[] = [];
  const awaitingAgreement = agreement?.status === "pending_acceptance";
  if (awaitingAgreement) {
    nextSteps.push("Review and accept your agreement below.");
  }
  if (actionable) {
    const readyForReview =
      actionable.workState === "submitted" || actionable.workState === "viewed";
    const approvedUnpaid = actionable.workState === "approved" && !paidIds.has(actionable.id);
    if (readyForReview) {
      nextSteps.push(`Review ${actionable.title} — approve it or request changes.`);
    }
    if (approvedUnpaid) {
      nextSteps.push(`Complete payment for ${actionable.title} to release the final files.`);
    }
  }
  if (nextSteps.length === 0) {
    nextSteps.push(
      actionable
        ? `No action needed — ${actionable.title} is being worked on.`
        : "Nothing needed — everything is settled.",
    );
  }

  const lockedExplanations = ordered
    .filter((m) => m.unlockState === "locked")
    .map((m) => {
      const idx = ordered.findIndex((o) => o.id === m.id);
      const prev =
        idx > 0 ? (ordered[idx - 1]?.title ?? "the earlier milestone") : "the first milestone";
      return {
        title: m.title,
        why: `Locked to keep payments and delivery in order — earlier work must complete first.`,
        unlocksWhen: `Unlocks automatically once ${prev} is complete.`,
      };
    });

  const progressPercent =
    project.totalValueCents > 0
      ? Math.min(100, Math.round((paid / project.totalValueCents) * 100))
      : 0;

  return {
    projectTitle: project.title,
    ...(project.description ? { projectDescription: project.description } : {}),
    currency: project.currency,
    clientName: client.name,
    ...(client.company ? { company: client.company } : {}),
    totalCents: project.totalValueCents,
    paidCents: paid,
    dueNowCents: dueNow,
    remainingCents: remaining,
    progressPercent,
    paymentStatus,
    focusHeadline,
    focusBody,
    ...(actionable ? { focusMilestoneId: actionable.id } : {}),
    milestones: milestoneViews,
    payments: paymentViews,
    agreement,
    activity,
    nextSteps,
    lockedExplanations,
    disclaimer: PORTAL_DISCLAIMER,
  };
}
