import { isMilestonePaid, type ReceivedPayment } from "./money.js";
import type { ReleaseCondition } from "./types.js";

/**
 * Release gates (domain-model §6). Pure function so both the API and the UI
 * explain the SAME reasons to freelancer and client upfront (no surprise locks).
 */

export interface ReleaseInput {
  readonly condition: ReleaseCondition;
  readonly milestoneId: string;
  readonly milestoneAmountCents: number;
  readonly payments: readonly ReceivedPayment[];
  readonly approvedVersionId: string | null;
  readonly currentVersionId: string;
  readonly projectMilestones: readonly {
    readonly id: string;
    readonly amountCents: number;
  }[];
  readonly manualOverride?: { readonly reason: string } | null;
}

export interface ReleaseDecision {
  readonly allowed: boolean;
  readonly overridden: boolean;
  readonly reasons: string[];
}

function approvalValid(input: ReleaseInput): boolean {
  return input.approvedVersionId !== null && input.approvedVersionId === input.currentVersionId;
}

export function canRelease(input: ReleaseInput): ReleaseDecision {
  const reasons: string[] = [];

  // INVARIANT: old-version approval never releases a new version.
  if (!approvalValid(input)) {
    reasons.push(
      input.approvedVersionId === null
        ? "Current deliverable version is not approved yet."
        : "Approval is pinned to a superseded version; the current version needs a fresh approval.",
    );
  }

  const milestonePaid = isMilestonePaid(
    input.milestoneAmountCents,
    input.payments,
    input.milestoneId,
  );

  switch (input.condition) {
    case "current_milestone_paid":
      if (!milestonePaid)
        reasons.push("Current milestone is not fully paid (verified payments only).");
      break;
    case "all_milestones_paid": {
      const unpaid = input.projectMilestones.filter(
        (m) => !isMilestonePaid(m.amountCents, input.payments, m.id),
      );
      if (unpaid.length > 0) {
        reasons.push(
          `${unpaid.length} milestone(s) unpaid; the final release requires the whole project paid.`,
        );
      }
      break;
    }
    case "manual_release":
      reasons.push("This project requires manual release by the freelancer.");
      break;
  }

  if (reasons.length === 0) {
    return { allowed: true, overridden: false, reasons: ["Release conditions satisfied."] };
  }

  // Flagged escape hatch: explicit reason, surfaced in evidence (user-flows Flow 6).
  if (input.manualOverride && input.manualOverride.reason.trim().length >= 8) {
    return {
      allowed: true,
      overridden: true,
      reasons: [...reasons, `Manual override recorded: ${input.manualOverride.reason.trim()}`],
    };
  }
  if (input.manualOverride) {
    reasons.push("Manual override reason is too short; explain why you are releasing early.");
  }

  return { allowed: false, overridden: false, reasons };
}

/** Version-pinned approval check used by tests and the future approval route. */
export function isApprovalValidForVersion(
  approvedVersionId: string | null,
  currentVersionId: string,
): boolean {
  return approvedVersionId !== null && approvedVersionId === currentVersionId;
}
