/**
 * Formal client approval — event/audit model (Session 11).
 *
 * An approval is NOT a boolean. It is an append-only decision event pinned to
 * a specific deliverable version (or milestone version reference):
 *
 * - WHO approved: client identity (`approverRef`, e.g. `portal:<linkId>`) +
 *   actor (`client`) + optional hashed device metadata (`ipHash`/`uaHash`,
 *   sha256 only — raw IPs are never stored).
 * - WHAT was approved: milestone + deliverable (+ version row id when known).
 * - WHICH VERSION: `versionNo` (deliverable) or `versionRef` (milestone
 *   `currentVersionId` string). Old approvals stay historically true for
 *   their version but never authorize a newer version.
 * - WHEN: `createdAt`/`occurredAt` UTC.
 * - DECISION: `approved | revision_requested | rejected | disputed`.
 * - SUBSEQUENT CHANGES: a new version does not rewrite history — the latest
 *   decision for the deliverable becomes STALE until the client decides on
 *   the new version (see `isCurrent` / `effectiveDecision`).
 *
 * Pure module: no DB, no network, no clock reads.
 */

export const APPROVAL_DECISIONS = [
  "approved",
  "revision_requested",
  "rejected",
  "disputed",
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export class ApprovalError extends Error {
  readonly code: "VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
    this.code = "VALIDATION";
  }
}

export interface ApprovalSubject {
  /** Deliverable version number when the subject is a deliverable. */
  readonly versionNo?: number | undefined;
  /** Milestone `currentVersionId` string when the subject is milestone-only. */
  readonly versionRef?: string | undefined;
}

export interface RecordApprovalInput extends ApprovalSubject {
  readonly decision: ApprovalDecision;
  readonly note?: string | undefined;
}

const NOTE_MAX = 2000;

/** Validate a client decision before it is persisted. Throws ApprovalError. */
export function validateApprovalInput(input: RecordApprovalInput): RecordApprovalInput {
  if (!APPROVAL_DECISIONS.includes(input.decision)) {
    throw new ApprovalError(`Unknown approval decision: ${input.decision}`);
  }
  const hasVersionNo =
    input.versionNo !== undefined && Number.isInteger(input.versionNo) && input.versionNo >= 1;
  const hasVersionRef = input.versionRef !== undefined && input.versionRef.trim().length > 0;
  if (!hasVersionNo && !hasVersionRef) {
    throw new ApprovalError(
      "Approval must pin a specific version (versionNo ≥ 1 or a milestone versionRef).",
    );
  }
  if (hasVersionNo && hasVersionRef) {
    throw new ApprovalError("Approval pins exactly one version: versionNo XOR versionRef.");
  }
  const note = (input.note ?? "").trim();
  if (note.length > NOTE_MAX) {
    throw new ApprovalError(`Approval note must be ≤ ${NOTE_MAX} characters.`);
  }
  // Revision / rejection / dispute without a reason is not actionable and is
  // rejected so the freelancer always knows what to change or why it stalled.
  if (
    (input.decision === "revision_requested" ||
      input.decision === "rejected" ||
      input.decision === "disputed") &&
    note.length < 3
  ) {
    throw new ApprovalError(
      "A note of at least 3 characters is required for revision requests, rejections, and disputes.",
    );
  }
  return {
    ...input,
    ...(input.versionNo !== undefined ? { versionNo: input.versionNo } : {}),
    ...(input.versionRef !== undefined ? { versionRef: input.versionRef.trim() } : {}),
    ...(note.length > 0 ? { note } : {}),
  };
}

export interface ApprovalEvent {
  readonly id: string;
  readonly decision: ApprovalDecision;
  /** Deliverable version number (when applicable). */
  readonly versionNo?: number | undefined;
  /** Milestone version reference (when applicable). */
  readonly versionRef?: string | undefined;
  readonly note?: string | undefined;
  readonly createdAt: Date;
}

/** True when this approval authorizes `current` (same pinned version). */
export function isApprovalCurrent(
  approval: Pick<ApprovalEvent, "versionNo" | "versionRef">,
  current: ApprovalSubject,
): boolean {
  if (approval.versionNo !== undefined && current.versionNo !== undefined) {
    return approval.versionNo === current.versionNo;
  }
  if (approval.versionRef !== undefined && current.versionRef !== undefined) {
    return approval.versionRef === current.versionRef;
  }
  return false;
}

/** Latest decision across the full history (newest `createdAt` wins). */
export function latestDecision(history: readonly ApprovalEvent[]): ApprovalEvent | null {
  if (history.length === 0) return null;
  const first = history[0];
  if (first === undefined) return null;
  let best = first;
  for (const a of history) {
    if (a.createdAt.getTime() >= best.createdAt.getTime()) best = a;
  }
  return best;
}

/** Latest decision for one pinned version — history for old versions is kept. */
export function effectiveDecisionForVersion(
  history: readonly ApprovalEvent[],
  subject: ApprovalSubject,
): ApprovalEvent | null {
  const scoped = history.filter((a) => {
    if (subject.versionNo !== undefined) return a.versionNo === subject.versionNo;
    if (subject.versionRef !== undefined) return a.versionRef === subject.versionRef;
    return false;
  });
  return latestDecision(scoped);
}

export interface ApprovalEffect {
  /** Latest decision overall (null when no history). */
  readonly latest: ApprovalEvent | null;
  /** Whether the latest decision authorizes `current`. */
  readonly isCurrent: boolean;
  /**
   * Whether `current` may be treated as approved: the LATEST decision is
   * `approved` AND it pins `current`. An old-version approval never counts,
   * and a later revision/rejection/dispute revokes the approval until the
   * client approves again.
   */
  readonly isApproved: boolean;
  /** Human-readable explanation for UI + evidence. */
  readonly reason: string;
}

/**
 * Derive the effective approval state for `current` from append-only history.
 * New versions never rewrite history: they simply make `isCurrent` false
 * until the client decides again.
 */
export function deriveApprovalEffect(
  history: readonly ApprovalEvent[],
  current: ApprovalSubject,
): ApprovalEffect {
  const latest = latestDecision(history);
  if (!latest) {
    return {
      latest,
      isCurrent: false,
      isApproved: false,
      reason: "No client decision recorded yet for this deliverable.",
    };
  }
  const pinsCurrent = isApprovalCurrent(latest, current);
  if (!pinsCurrent) {
    const label =
      current.versionNo !== undefined
        ? `version ${current.versionNo}`
        : `version "${current.versionRef ?? "unknown"}"`;
    return {
      latest,
      isCurrent: false,
      isApproved: false,
      reason:
        `The latest client decision (${latest.decision}) pins an older version — ` +
        `${label} needs a fresh decision. History is preserved.`,
    };
  }
  if (latest.decision === "approved") {
    return {
      latest,
      isCurrent: true,
      isApproved: true,
      reason: "Approved by the client for this version.",
    };
  }
  const need =
    latest.decision === "revision_requested"
      ? "Changes were requested — a new version needs a fresh approval."
      : latest.decision === "rejected"
        ? "The client rejected this version — a new decision is required."
        : "This version is disputed — resolve it before release.";
  return { latest, isCurrent: true, isApproved: false, reason: need };
}

/** Canonical event type for each decision (extends the existing vocabulary). */
export function eventTypeForDecision(decision: ApprovalDecision): string {
  switch (decision) {
    case "approved":
      return "MilestoneApproved";
    case "revision_requested":
      return "RevisionRequested";
    case "rejected":
      return "ApprovalRejected";
    case "disputed":
      return "DisputeFlagged";
  }
}

/** Client-safe activity label for each decision. */
export function labelForDecision(decision: ApprovalDecision, title?: string): string {
  const t = title ?? "a milestone";
  switch (decision) {
    case "approved":
      return `${t} was approved`;
    case "revision_requested":
      return `Changes requested on ${t}`;
    case "rejected":
      return `${t} was not approved`;
    case "disputed":
      return `A question was raised on ${t}`;
  }
}
