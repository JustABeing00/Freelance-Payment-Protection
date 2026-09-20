import { projectOutstandingCents } from "./money.js";
import type {
  MilestoneRecord,
  PaymentRecord,
  ProjectEventRecord,
  ProjectRecord,
} from "../lib/store.js";

/**
 * Project command-center projection (Session 04, verified-money since 08).
 * Pure + DB-free: the Event/Payment tables are authority, this function only
 * derives display state. Verified `paid`/`received`/`partial` rows count;
 * `claimed_unverified` never marks paid (invariant).
 */

export interface CurrentMilestoneView {
  id: string;
  title: string;
  amountCents: number;
  workState: string;
  paymentState: string;
  dueDate?: string | undefined;
}

export interface RecentActivityItem {
  id: string;
  type: string;
  label: string;
  actorType: string;
  occurredAt: string;
}

export interface ProjectSummary {
  projectId: string;
  totalValueCents: number;
  amountPaidCents: number;
  outstandingCents: number;
  progressPercent: number;
  projectStatus: string;
  paymentStatus: "unpaid" | "partial" | "paid" | "overdue" | "disputed";
  currentMilestone: CurrentMilestoneView | null;
  nextAction: string;
  milestoneCount: number;
  paidMilestoneCount: number;
  recentActivity: RecentActivityItem[];
}

const RECEIVED_STATES = new Set(["received", "partial", "paid"]);

function amountPaid(payments: readonly PaymentRecord[]): number {
  let sum = 0;
  for (const p of payments) {
    if (RECEIVED_STATES.has(p.state) && Number.isInteger(p.amountCents) && p.amountCents > 0) {
      sum += p.amountCents;
    }
  }
  return sum;
}

function humanizeEventType(type: string): string {
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function isDisputed(events: readonly ProjectEventRecord[]): boolean {
  return events.some((e) => e.type === "PaymentDisputed" || e.type === "DisputeFlagged");
}

function isOverdueMilestone(
  m: MilestoneRecord,
  payments: readonly PaymentRecord[],
  now: Date,
  graceDays = 3,
): boolean {
  if (!m.dueDate) return false;
  if (m.paymentState === "paid") return false;
  const receivedFor = payments
    .filter((p) => p.milestoneId === m.id && RECEIVED_STATES.has(p.state))
    .reduce((s, p) => s + p.amountCents, 0);
  if (receivedFor >= m.amountCents) return false;
  const graceMs = graceDays * 24 * 60 * 60 * 1000;
  return now.getTime() > m.dueDate.getTime() + graceMs;
}

export function buildProjectSummary(args: {
  project: ProjectRecord;
  milestones: readonly MilestoneRecord[];
  payments: readonly PaymentRecord[];
  events: readonly ProjectEventRecord[];
  now?: Date | undefined;
}): ProjectSummary {
  const { project, milestones, payments, events } = args;
  const now = args.now ?? new Date();

  const paid = amountPaid(payments);
  const milestoneAmounts = milestones.map((m) => m.amountCents);
  const basis = milestoneAmounts.length > 0 ? milestoneAmounts : [project.totalValueCents];
  const receivedLike = payments.map((p) => ({
    ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
    amountCents: p.amountCents,
    state: RECEIVED_STATES.has(p.state) ? "received" : p.state,
  }));
  const outstanding = projectOutstandingCents(basis, receivedLike);

  const ordered = [...milestones].sort((a, b) => a.orderIndex - b.orderIndex);
  const paidIds = new Set(
    ordered
      .filter((m) => {
        const got = payments
          .filter((p) => p.milestoneId === m.id && RECEIVED_STATES.has(p.state))
          .reduce((s, p) => s + p.amountCents, 0);
        return got >= m.amountCents;
      })
      .map((m) => m.id),
  );
  const current = ordered.find((m) => !paidIds.has(m.id)) ?? null;

  const disputed = isDisputed(events);
  const overdue = ordered.some((m) => isOverdueMilestone(m, payments, now));
  const paymentStatus: ProjectSummary["paymentStatus"] = disputed
    ? "disputed"
    : outstanding <= 0 && (paid > 0 || ordered.length === 0)
      ? "paid"
      : overdue
        ? "overdue"
        : paid > 0
          ? "partial"
          : "unpaid";

  let nextAction: string;
  if (disputed) {
    nextAction = "Review the flagged dispute before sharing more work.";
  } else if (project.status === "draft") {
    nextAction = "Finalize the agreement, then share Milestone 1 for approval.";
  } else if (overdue && current) {
    nextAction = `Follow up on overdue ${current.title} — send a calm reminder.`;
  } else if (!current) {
    nextAction = "All milestones settled — export the evidence pack for your records.";
  } else if (current.workState === "draft") {
    nextAction = `Prepare and share ${current.title} preview with the client.`;
  } else if (current.workState === "submitted" || current.workState === "viewed") {
    nextAction = `Nudge the client for approval on ${current.title}.`;
  } else if (current.workState === "revision_requested") {
    nextAction = `Address the revision on ${current.title}, then resubmit.`;
  } else if (current.workState === "approved" && current.paymentState !== "paid") {
    nextAction = `Send the payment request for ${current.title}.`;
  } else if (
    current.paymentState === "requested" ||
    current.paymentState === "claimed_unverified"
  ) {
    nextAction = `Confirm receipt for ${current.title} — only verified payments count.`;
  } else {
    nextAction = `Move ${current.title} forward — share the next preview.`;
  }

  const progressPercent =
    project.totalValueCents > 0
      ? Math.min(100, Math.round((paid / project.totalValueCents) * 100))
      : 0;

  const recentActivity: RecentActivityItem[] = [...events]
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 8)
    .map((e) => ({
      id: e.id,
      type: e.type,
      label: humanizeEventType(e.type),
      actorType: e.actorType,
      occurredAt: e.occurredAt.toISOString(),
    }));

  return {
    projectId: project.id,
    totalValueCents: project.totalValueCents,
    amountPaidCents: paid,
    outstandingCents: outstanding,
    progressPercent,
    projectStatus: project.status,
    paymentStatus,
    currentMilestone: current
      ? {
          id: current.id,
          title: current.title,
          amountCents: current.amountCents,
          workState: current.workState,
          paymentState: current.paymentState,
          ...(current.dueDate ? { dueDate: current.dueDate.toISOString() } : {}),
        }
      : null,
    nextAction,
    milestoneCount: ordered.length,
    paidMilestoneCount: paidIds.size,
    recentActivity,
  };
}
