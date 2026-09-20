/**
 * Project protection / risk-awareness checks (Session 16).
 *
 * Pure + DB-free: the store/route layers gather records; this module turns
 * them into observable workflow conditions a freelancer can act on early.
 *
 * Hard rules (enforced by tests):
 * - Never label the client. No "scammer", "bad client", "dishonest",
 *   "fraudulent", or any character judgement. Every check describes an
 *   observable workflow condition ("Deposit missing", "Milestone overdue").
 * - Every warning is explainable from actual project data: each check
 *   carries an `evidence` object with ids, dates, and amounts.
 * - No opaque scores. There is no risk score, no grade, no prediction —
 *   only a count of conditions needing attention plus the factual list.
 */

export const PROTECTION_DISCLAIMER =
  "Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent.";

const BANNED_CLIENT_LABELS = [
  "scammer",
  "scam",
  "bad client",
  "dishonest",
  "fraudulent",
  "fraud",
  "untrustworthy",
  "shady",
  "cheat",
];

/** Throws when copy drifts into client labelling. */
export function assertProfessionalCopy(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of BANNED_CLIENT_LABELS) {
    if (lower.includes(phrase)) {
      throw new Error(`Protection copy must not label the client (found "${phrase}")`);
    }
  }
}

export type ProtectionStatus = "clear" | "needs_attention";

export interface ProtectionCheck {
  readonly code: string;
  readonly title: string;
  readonly status: ProtectionStatus;
  readonly detail: string;
  readonly nextStep: string;
  readonly evidence: Record<string, unknown>;
}

export interface ProtectionMilestoneInput {
  readonly id: string;
  readonly title: string;
  readonly amountCents: number;
  readonly dueDate?: Date | undefined;
  readonly paymentState: string;
  readonly approvalState: string;
  readonly deliverableState: string;
  readonly orderIndex: number;
}

export interface ProtectionPaymentInput {
  readonly id: string;
  readonly milestoneId?: string | undefined;
  readonly amountCents: number;
  readonly state: string;
}

export interface ProtectionAgreementInput {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly acceptedPaymentMethods: readonly string[];
}

export interface ProtectionDeliverableInput {
  readonly id: string;
  readonly milestoneId: string;
  readonly title: string;
  readonly status: string;
}

export interface ProtectionApprovalInput {
  readonly milestoneId: string;
  readonly deliverableId?: string | undefined;
  readonly decision: string;
}

export interface ProtectionEventInput {
  readonly id: string;
  readonly type: string;
  readonly actorType: string;
  readonly occurredAt: Date;
  readonly milestoneId?: string | undefined;
}

export interface ProtectionPlanInstallmentInput {
  readonly seq: number;
  readonly amountCents: number;
  readonly dueDate: Date;
  readonly status: string;
}

export interface ProtectionPlanInput {
  readonly id: string;
  readonly milestoneId: string;
  readonly state: string;
  readonly installments: readonly ProtectionPlanInstallmentInput[];
}

export interface ProtectionProjectInput {
  readonly id: string;
  readonly title: string;
  readonly currency: string;
  readonly totalValueCents: number;
  readonly paymentTerms?: string | undefined;
}

export interface BuildProtectionInput {
  readonly project: ProtectionProjectInput;
  readonly milestones: readonly ProtectionMilestoneInput[];
  readonly payments: readonly ProtectionPaymentInput[];
  readonly agreements: readonly ProtectionAgreementInput[];
  readonly deliverables: readonly ProtectionDeliverableInput[];
  readonly approvals: readonly ProtectionApprovalInput[];
  readonly events: readonly ProtectionEventInput[];
  readonly paymentPlans: readonly ProtectionPlanInput[];
  readonly now?: Date | undefined;
}

export interface ProtectionReport {
  readonly projectId: string;
  readonly generatedAt: string;
  readonly attentionCount: number;
  readonly clearCount: number;
  readonly status: "healthy" | "needs_attention";
  readonly checks: readonly ProtectionCheck[];
  readonly disclaimer: string;
}

const VERIFIED_STATES = new Set(["paid", "received", "partial"]);
const FAILED_STATES = new Set(["failed", "cancelled"]);

const NO_ACTIVITY_DAYS = 14;
const LARGE_BALANCE_MIN_CENTS = 50000;
const LARGE_BALANCE_MIN_RATIO = 0.25;
const REPEATED_THRESHOLD = 2;

function verifiedForMilestone(
  payments: readonly ProtectionPaymentInput[],
  milestoneId: string,
): number {
  let sum = 0;
  for (const p of payments) {
    if (p.milestoneId === milestoneId && VERIFIED_STATES.has(p.state)) {
      sum += p.amountCents;
    }
  }
  return sum;
}

function totalVerified(payments: readonly ProtectionPaymentInput[]): number {
  let sum = 0;
  for (const p of payments) {
    if (VERIFIED_STATES.has(p.state)) sum += p.amountCents;
  }
  return sum;
}

function milestoneBasis(
  milestones: readonly ProtectionMilestoneInput[],
  totalValueCents: number,
): number {
  if (milestones.length === 0) return totalValueCents;
  return milestones.reduce((s, m) => s + m.amountCents, 0);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function makeCheck(args: {
  code: string;
  title: string;
  status: ProtectionStatus;
  detail: string;
  nextStep: string;
  evidence: Record<string, unknown>;
}): ProtectionCheck {
  assertProfessionalCopy(`${args.title} ${args.detail} ${args.nextStep}`);
  return {
    code: args.code,
    title: args.title,
    status: args.status,
    detail: args.detail,
    nextStep: args.nextStep,
    evidence: { ...args.evidence },
  };
}

export function buildProtectionChecks(input: BuildProtectionInput): ProtectionReport {
  const now = input.now ?? new Date();
  const { project, milestones, payments, agreements, deliverables, events, paymentPlans } = input;
  const ordered = [...milestones].sort((a, b) => a.orderIndex - b.orderIndex);
  const basis = milestoneBasis(ordered, project.totalValueCents);
  const verified = totalVerified(payments);
  const outstanding = Math.max(0, basis - verified);
  const checks: ProtectionCheck[] = [];

  // 1. Payment method not configured — observable from agreement methods + terms.
  {
    const current = agreements.find((a) => a.status === "accepted") ?? null;
    const methods = current ? [...current.acceptedPaymentMethods] : [];
    const terms = (project.paymentTerms ?? "").trim();
    const configured = methods.length > 0 || terms.length > 0;
    checks.push(
      makeCheck({
        code: "payment_method_not_configured",
        title: "Payment method not configured",
        status: configured ? "clear" : "needs_attention",
        detail: configured
          ? `How the client pays is recorded (${methods.length > 0 ? `agreement v${current?.version} lists ${methods.join(", ")}` : "project payment terms are set"}).`
          : "No payment method is recorded on the accepted agreement and project payment terms are empty, so the client has no stated way to pay.",
        nextStep: configured
          ? "No action needed — the payment path is recorded."
          : "Record how this project is paid (agreement payment methods or project payment terms) before sharing more work.",
        evidence: {
          hasAcceptedAgreement: current !== null,
          ...(current ? { agreementId: current.id, agreementVersion: current.version } : {}),
          acceptedPaymentMethods: methods,
          hasPaymentTerms: terms.length > 0,
        },
      }),
    );
  }

  // 2. Deposit missing — first milestone (order 0) has no verified cover.
  {
    const first = ordered[0] ?? null;
    if (!first) {
      checks.push(
        makeCheck({
          code: "deposit_missing",
          title: "Deposit missing",
          status: "clear",
          detail: "No milestones exist yet, so there is no first-milestone deposit to check.",
          nextStep: "Create Milestone 1 before starting work.",
          evidence: { milestoneCount: 0 },
        }),
      );
    } else {
      const got = verifiedForMilestone(payments, first.id);
      const missing = got < first.amountCents;
      checks.push(
        makeCheck({
          code: "deposit_missing",
          title: "Deposit missing",
          status: missing ? "needs_attention" : "clear",
          detail: missing
            ? `Milestone 1 "${first.title}" shows ${got}/${first.amountCents} cents verified — work would start before the first payment is confirmed.`
            : `Milestone 1 "${first.title}" shows ${got}/${first.amountCents} cents verified.`,
          nextStep: missing
            ? "Collect Milestone 1 before starting work — only verified receipts count."
            : "No action needed — the first milestone is covered by a verified receipt.",
          evidence: {
            milestoneId: first.id,
            milestoneTitle: first.title,
            amountCents: first.amountCents,
            verifiedCents: got,
          },
        }),
      );
    }
  }

  // 3. Milestone overdue — past due date with verified balance remaining.
  {
    const overdue = ordered.filter((m) => {
      if (!m.dueDate) return false;
      if (verifiedForMilestone(payments, m.id) >= m.amountCents) return false;
      return now.getTime() > m.dueDate.getTime();
    });
    checks.push(
      makeCheck({
        code: "milestone_overdue",
        title: "Milestone overdue",
        status: overdue.length > 0 ? "needs_attention" : "clear",
        detail:
          overdue.length > 0
            ? `${overdue.length} milestone(s) past due with verified balance remaining: ${overdue.map((m) => `"${m.title}" (due ${m.dueDate ? isoDay(m.dueDate) : "unknown"})`).join(", ")}.`
            : "No milestone is past its due date with a verified balance remaining.",
        nextStep:
          overdue.length > 0
            ? "Send a calm payment reminder for the overdue milestone."
            : "No action needed — nothing is overdue.",
        evidence: {
          overdueCount: overdue.length,
          overdueMilestones: overdue.map((m) => ({
            milestoneId: m.id,
            title: m.title,
            dueDate: m.dueDate ? m.dueDate.toISOString() : null,
            amountCents: m.amountCents,
            verifiedCents: verifiedForMilestone(payments, m.id),
          })),
        },
      }),
    );
  }

  // 4. Contract unsigned — no accepted agreement version.
  {
    const accepted = agreements.filter((a) => a.status === "accepted");
    checks.push(
      makeCheck({
        code: "contract_unsigned",
        title: "Contract unsigned",
        status: accepted.length > 0 ? "clear" : "needs_attention",
        detail:
          accepted.length > 0
            ? `Agreement v${accepted[accepted.length - 1]?.version} is accepted.`
            : `No agreement version is accepted (${agreements.length} version(s) on file, none accepted).`,
        nextStep:
          accepted.length > 0
            ? "No action needed — an agreement version is accepted."
            : "Send the agreement and wait for acceptance before starting billable work.",
        evidence: {
          agreementCount: agreements.length,
          acceptedCount: accepted.length,
          ...(accepted.length > 0
            ? { acceptedVersion: accepted[accepted.length - 1]?.version }
            : {}),
        },
      }),
    );
  }

  // 5. Deliverable approved but unpaid.
  {
    const rows = ordered.filter(
      (m) => m.approvalState === "approved" && verifiedForMilestone(payments, m.id) < m.amountCents,
    );
    checks.push(
      makeCheck({
        code: "approved_unpaid",
        title: "Deliverable approved but unpaid",
        status: rows.length > 0 ? "needs_attention" : "clear",
        detail:
          rows.length > 0
            ? `${rows.length} approved milestone(s) still show a verified balance due: ${rows.map((m) => `"${m.title}"`).join(", ")}.`
            : "No approved milestone is waiting on a verified payment.",
        nextStep:
          rows.length > 0
            ? "Request payment for the approved work before releasing final files."
            : "No action needed.",
        evidence: {
          count: rows.length,
          milestones: rows.map((m) => ({
            milestoneId: m.id,
            title: m.title,
            amountCents: m.amountCents,
            verifiedCents: verifiedForMilestone(payments, m.id),
          })),
        },
      }),
    );
  }

  // 6. Client requested final files before payment — client viewed files while unpaid.
  {
    const viewedByClient = events.filter(
      (e) => e.type === "DeliverableViewed" && e.actorType === "client",
    );
    const unpaidViewed = viewedByClient.filter((e) => {
      if (!e.milestoneId) return outstanding > 0;
      const m = ordered.find((x) => x.id === e.milestoneId);
      if (!m) return outstanding > 0;
      return verifiedForMilestone(payments, m.id) < m.amountCents;
    });
    checks.push(
      makeCheck({
        code: "final_request_before_payment",
        title: "Client requested final files before payment",
        status: unpaidViewed.length > 0 ? "needs_attention" : "clear",
        detail:
          unpaidViewed.length > 0
            ? `${unpaidViewed.length} file view(s) by the client are recorded while a verified balance remains outstanding — keep finals gated until payment is verified.`
            : "No client file views are recorded while a verified balance remains outstanding.",
        nextStep:
          unpaidViewed.length > 0
            ? "Keep final files gated — share previews until the verified receipt arrives."
            : "No action needed.",
        evidence: {
          viewCount: unpaidViewed.length,
          views: unpaidViewed.slice(0, 5).map((e) => ({
            eventId: e.id,
            ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
            occurredAt: e.occurredAt.toISOString(),
          })),
          outstandingCents: outstanding,
        },
      }),
    );
  }

  // 7. Payment deadline unclear — unpaid milestones without due dates, or no terms.
  {
    const unpaidNoDue = ordered.filter(
      (m) => !m.dueDate && verifiedForMilestone(payments, m.id) < m.amountCents,
    );
    const terms = (project.paymentTerms ?? "").trim();
    const unclear = unpaidNoDue.length > 0;
    checks.push(
      makeCheck({
        code: "payment_deadline_unclear",
        title: "Payment deadline unclear",
        status: unclear ? "needs_attention" : "clear",
        detail: unclear
          ? `${unpaidNoDue.length} unpaid milestone(s) have no due date: ${unpaidNoDue.map((m) => `"${m.title}"`).join(", ")}.`
          : "Every unpaid milestone has a due date.",
        nextStep: unclear
          ? "Add a due date to each unpaid milestone so reminders and overdue checks have a basis."
          : "No action needed.",
        evidence: {
          count: unpaidNoDue.length,
          milestones: unpaidNoDue.map((m) => ({ milestoneId: m.id, title: m.title })),
          hasPaymentTerms: terms.length > 0,
        },
      }),
    );
  }

  // 8. Multiple payment failures.
  {
    const failed = payments.filter((p) => FAILED_STATES.has(p.state));
    checks.push(
      makeCheck({
        code: "multiple_payment_failures",
        title: "Multiple payment failures",
        status: failed.length >= REPEATED_THRESHOLD ? "needs_attention" : "clear",
        detail:
          failed.length >= REPEATED_THRESHOLD
            ? `${failed.length} payment attempts recorded as failed or cancelled — no money moved for those attempts.`
            : `${failed.length} failed/cancelled attempt(s) recorded — below the ${REPEATED_THRESHOLD} that needs attention.`,
        nextStep:
          failed.length >= REPEATED_THRESHOLD
            ? "Confirm the payment path with the client (new checkout link, different method) before retrying."
            : "No action needed.",
        evidence: {
          failedCount: failed.length,
          paymentIds: failed.map((p) => p.id),
        },
      }),
    );
  }

  // 9. Repeated missed installment dates.
  {
    const missed: { planId: string; seq: number; dueDate: string }[] = [];
    for (const plan of paymentPlans) {
      for (const inst of plan.installments) {
        if (inst.status === "missed") {
          missed.push({
            planId: plan.id,
            seq: inst.seq,
            dueDate: inst.dueDate.toISOString(),
          });
        }
      }
    }
    const missedEvents = events.filter((e) => e.type === "PaymentPlanInstallmentMissed").length;
    const count = Math.max(missed.length, missedEvents);
    checks.push(
      makeCheck({
        code: "repeated_missed_installments",
        title: "Repeated missed installment dates",
        status: count >= REPEATED_THRESHOLD ? "needs_attention" : "clear",
        detail:
          count >= REPEATED_THRESHOLD
            ? `${count} missed installment date(s) recorded across payment plans.`
            : `${count} missed installment date(s) recorded — below the ${REPEATED_THRESHOLD} that needs attention.`,
        nextStep:
          count >= REPEATED_THRESHOLD
            ? "Review the payment plan with the client — consider a revised schedule or pausing work per the agreement."
            : "No action needed.",
        evidence: {
          missedCount: count,
          installments: missed.slice(0, 10),
          missedEventCount: missedEvents,
          planCount: paymentPlans.length,
        },
      }),
    );
  }

  // 10. No recent client activity.
  {
    const clientEvents = events.filter((e) => e.actorType === "client");
    const last =
      clientEvents.length > 0
        ? new Date(Math.max(...clientEvents.map((e) => e.occurredAt.getTime())))
        : null;
    const daysSince =
      last === null ? null : Math.floor((now.getTime() - last.getTime()) / 86400000);
    const stale = outstanding > 0 && (last === null || (daysSince ?? 0) > NO_ACTIVITY_DAYS);
    checks.push(
      makeCheck({
        code: "no_recent_client_activity",
        title: "No recent client activity",
        status: stale ? "needs_attention" : "clear",
        detail:
          last === null
            ? `No client activity is recorded yet and ${outstanding} cents remain verified-outstanding.`
            : (daysSince ?? 0) > NO_ACTIVITY_DAYS && outstanding > 0
              ? `Last client activity was ${daysSince} day(s) ago (${isoDay(last)}) with ${outstanding} cents verified-outstanding.`
              : `Last client activity was ${isoDay(last)} (${daysSince} day(s) ago) — within the ${NO_ACTIVITY_DAYS}-day window.`,
        nextStep: stale
          ? "Send a brief check-in — confirm the client can still open the portal and see the next step."
          : "No action needed.",
        evidence: {
          lastClientActivityAt: last ? last.toISOString() : null,
          daysSinceLastClientActivity: daysSince,
          clientEventCount: clientEvents.length,
          outstandingCents: outstanding,
        },
      }),
    );
  }

  // 11. Large unpaid balance.
  {
    const large =
      outstanding >= LARGE_BALANCE_MIN_CENTS && outstanding >= basis * LARGE_BALANCE_MIN_RATIO;
    checks.push(
      makeCheck({
        code: "large_unpaid_balance",
        title: "Large unpaid balance",
        status: large ? "needs_attention" : "clear",
        detail: large
          ? `${outstanding} cents verified-outstanding out of ${basis} cents total — pause and collect before more work ships.`
          : `${outstanding} cents verified-outstanding out of ${basis} cents total — below the attention threshold.`,
        nextStep: large
          ? "Pause new delivery until the outstanding balance is reduced by verified payments."
          : "No action needed.",
        evidence: {
          outstandingCents: outstanding,
          totalCents: basis,
          verifiedCents: verified,
          thresholdCents: LARGE_BALANCE_MIN_CENTS,
        },
      }),
    );
  }

  // 12. Final deliverable currently unlocked.
  {
    const unlocked = deliverables.filter((d) => {
      const releasedLike = d.status === "released" || d.status === "paid";
      if (!releasedLike) return false;
      const m = ordered.find((x) => x.id === d.milestoneId);
      if (!m) return true;
      return verifiedForMilestone(payments, m.id) < m.amountCents;
    });
    // Also catch milestone-level unlock state while unpaid.
    const unlockedMilestones = ordered.filter(
      (m) =>
        (m.deliverableState === "unlocked_ready" || m.deliverableState === "released") &&
        verifiedForMilestone(payments, m.id) < m.amountCents &&
        !unlocked.some((d) => d.milestoneId === m.id),
    );
    const total = unlocked.length + unlockedMilestones.length;
    checks.push(
      makeCheck({
        code: "final_unlocked",
        title: "Final deliverable currently unlocked",
        status: total > 0 ? "needs_attention" : "clear",
        detail:
          total > 0
            ? `${total} final deliverable(s) are accessible while a verified balance remains due — leverage is reduced until payment is verified.`
            : "No final deliverable is accessible while a verified balance remains due.",
        nextStep:
          total > 0
            ? "Re-gate finals if the agreement allows it, and collect the verified payment before the next release."
            : "No action needed — finals stay gated until verified payment.",
        evidence: {
          count: total,
          deliverables: unlocked.map((d) => ({
            deliverableId: d.id,
            title: d.title,
            milestoneId: d.milestoneId,
            status: d.status,
          })),
          milestones: unlockedMilestones.map((m) => ({
            milestoneId: m.id,
            title: m.title,
            deliverableState: m.deliverableState,
          })),
        },
      }),
    );
  }

  const attentionCount = checks.filter((c) => c.status === "needs_attention").length;
  return {
    projectId: project.id,
    generatedAt: now.toISOString(),
    attentionCount,
    clearCount: checks.length - attentionCount,
    status: attentionCount > 0 ? "needs_attention" : "healthy",
    checks,
    disclaimer: PROTECTION_DISCLAIMER,
  };
}
