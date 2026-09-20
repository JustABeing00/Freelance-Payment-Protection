/**
 * Deliverable system — controlled delivery (Session 10).
 *
 * Product principle: the client may REVIEW early, but only OWNS/RECEIVES the
 * final asset once contractual conditions are met. The two capabilities are
 * modelled as separate booleans everywhere (never one `status` string that
 * conflates them):
 *
 * - CLIENT CAN REVIEW: watermarked/low-resolution previews, staging URLs,
 *   restricted downloads. These REDUCE premature delivery but — honestly —
 *   cannot prevent screenshots or copying in a browser. See HONEST_LIMITS.
 * - CLIENT OWNS/RECEIVES FINAL ASSET: source files, production credentials,
 *   final archives. Issued only after release, via short-lived signed URLs
 *   with expiry + access checks + release conditions.
 *
 * Pure module: no DB, no network, no clock reads (callers pass `now` where
 * needed). Routes persist what these functions return and append events.
 */

export const DELIVERABLE_STATES = [
  "draft",
  "submitted",
  "preview_available",
  "client_review",
  "approved",
  "payment_pending",
  "paid",
  "released",
] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATES)[number];

export const STAGING_TRANSFER_STATES = [
  "none",
  "staging_live",
  "transfer_pending",
  "transferred",
] as const;
export type StagingTransferState = (typeof STAGING_TRANSFER_STATES)[number];

/**
 * Review-safe artifact kinds: the client may see these BEFORE release.
 * Final kinds: only AFTER release (signed, expiring URLs).
 */
export const REVIEW_ARTIFACT_KINDS = [
  "watermarked_preview",
  "low_resolution_preview",
  "staging_website",
  "restricted_download",
] as const;
export type ReviewArtifactKind = (typeof REVIEW_ARTIFACT_KINDS)[number];

export const FINAL_ARTIFACT_KINDS = [
  "final_source_files",
  "production_credentials",
  "final_archive",
] as const;
export type FinalArtifactKind = (typeof FINAL_ARTIFACT_KINDS)[number];

/** Honest technical boundary — surfaced in API responses and docs. */
export const HONEST_LIMITS =
  "Previews are a speed bump, not DRM: a browser cannot prevent screenshots, " +
  "copying, or retyping. This system reduces premature delivery with " +
  "watermarks, low-resolution previews, staging URLs, and expiring signed " +
  "links — it never claims to make copying impossible.";

/** Signed-URL policy (seconds). Finals are shorter-lived than previews. */
export const PREVIEW_URL_TTL_SECONDS = 3600;
export const FINAL_URL_TTL_SECONDS = 900;

export class DeliverableError extends Error {
  readonly code: "INVALID_TRANSITION" | "VALIDATION" | "RELEASE_BLOCKED" | "STAGING_BLOCKED";
  constructor(
    code: "INVALID_TRANSITION" | "VALIDATION" | "RELEASE_BLOCKED" | "STAGING_BLOCKED",
    message: string,
  ) {
    super(message);
    this.name = "DeliverableError";
    this.code = code;
  }
}

export interface DeliverableState {
  readonly id: string;
  readonly title: string;
  readonly status: DeliverableStatus;
  readonly currentVersionNo: number;
  readonly approvedVersionNo: number | null;
  readonly stagingTransfer: StagingTransferState;
  readonly stagingUrl: string | null;
}

/** Guarded lifecycle. Illegal jumps throw DeliverableError. */
const ALLOWED: Record<DeliverableStatus, readonly DeliverableStatus[]> = {
  draft: ["submitted"],
  submitted: ["preview_available", "client_review"],
  preview_available: ["client_review", "submitted"],
  client_review: ["approved", "submitted"],
  approved: ["payment_pending", "client_review"],
  payment_pending: ["paid", "approved"],
  paid: ["released"],
  released: [],
};

export function transitionDeliverable(
  current: DeliverableStatus,
  next: DeliverableStatus,
): DeliverableStatus {
  const allowed = ALLOWED[current];
  if (!allowed.includes(next)) {
    throw new DeliverableError(
      "INVALID_TRANSITION",
      `Cannot move deliverable from ${current} to ${next}.`,
    );
  }
  return next;
}

/** Convenience transitions with readable names for routes/tests. */
export function submitDeliverable(d: DeliverableState): DeliverableState {
  return { ...d, status: transitionDeliverable(d.status, "submitted") };
}
export function sharePreview(d: DeliverableState): DeliverableState {
  const next =
    d.status === "submitted"
      ? "preview_available"
      : transitionDeliverable(d.status, "client_review");
  return { ...d, status: next };
}
export function markClientReview(d: DeliverableState): DeliverableState {
  return { ...d, status: transitionDeliverable(d.status, "client_review") };
}
export function approveDeliverable(d: DeliverableState, versionNo: number): DeliverableState {
  if (versionNo < 1 || versionNo > d.currentVersionNo) {
    throw new DeliverableError("VALIDATION", "Approval must pin an existing version number.");
  }
  return {
    ...d,
    status: transitionDeliverable(d.status, "approved"),
    approvedVersionNo: versionNo,
  };
}
export function markPaymentPending(d: DeliverableState): DeliverableState {
  return { ...d, status: transitionDeliverable(d.status, "payment_pending") };
}
export function markPaid(d: DeliverableState): DeliverableState {
  return { ...d, status: transitionDeliverable(d.status, "paid") };
}

// ---------------------------------------------------------------------------
// REVIEW vs OWN — the conceptual core
// ---------------------------------------------------------------------------

/** Client may REVIEW (preview/staging) in these states. Never implies ownership. */
export function canClientReview(status: DeliverableStatus): boolean {
  return (
    status === "preview_available" ||
    status === "client_review" ||
    status === "approved" ||
    status === "payment_pending" ||
    status === "paid" ||
    status === "released"
  );
}

/** Client OWNS/RECEIVES the final asset only when released. Nothing earlier. */
export function canClientReceiveFinal(status: DeliverableStatus): boolean {
  return status === "released";
}

export function reviewVsFinalNotice(): string {
  return HONEST_LIMITS;
}

/** Human-readable lock reason for a denied final download (no oracle leak). */
export function finalLockReason(status: DeliverableStatus): string {
  switch (status) {
    case "released":
      return "Released — final files are available via a short-lived signed link.";
    case "paid":
      return "Payment is verified and the final release is being prepared.";
    case "payment_pending":
    case "approved":
      return "The final files unlock automatically once payment is verified.";
    case "client_review":
    case "preview_available":
      return "This is a review preview — the final files unlock after approval and verified payment.";
    case "submitted":
    case "draft":
    default:
      return "This deliverable is still being prepared — the final files unlock after review, approval, and verified payment.";
  }
}

// ---------------------------------------------------------------------------
// Release gating — finals require approval (version-pinned) + verified paid
// ---------------------------------------------------------------------------

export interface ReleaseCheckInput {
  readonly status: DeliverableStatus;
  readonly approvedVersionNo: number | null;
  readonly currentVersionNo: number;
  readonly verifiedPaid: boolean;
  readonly manualOverrideReason?: string | undefined;
}

export interface ReleaseCheck {
  readonly allowed: boolean;
  readonly reasons: string[];
  readonly overridden: boolean;
}

export function checkRelease(input: ReleaseCheckInput): ReleaseCheck {
  const reasons: string[] = [];
  if (input.status !== "paid") {
    reasons.push("Release requires verified payment first (claims never count).");
  }
  if (input.approvedVersionNo === null || input.approvedVersionNo !== input.currentVersionNo) {
    reasons.push(
      input.approvedVersionNo === null
        ? "Release requires client approval of the current version."
        : "Approval is pinned to a superseded version; the current version needs a fresh approval.",
    );
  }
  if (!input.verifiedPaid) {
    reasons.push("No verified provider receipt covers this deliverable yet.");
  }
  if (reasons.length === 0) {
    return { allowed: true, overridden: false, reasons: ["Release conditions satisfied."] };
  }
  const override = (input.manualOverrideReason ?? "").trim();
  if (override.length >= 8) {
    return {
      allowed: true,
      overridden: true,
      reasons: [...reasons, `Manual override recorded: ${override}`],
    };
  }
  if ((input.manualOverrideReason ?? "").length > 0) {
    reasons.push("Manual override reason is too short; explain why you are releasing early.");
  }
  return { allowed: false, overridden: false, reasons };
}

export function releaseDeliverable(
  d: DeliverableState,
  check: ReleaseCheckInput,
): DeliverableState {
  const decision = checkRelease({ ...check, status: d.status });
  if (!decision.allowed) {
    throw new DeliverableError(
      "RELEASE_BLOCKED",
      `Final release is locked: ${decision.reasons.join(" ")}`,
    );
  }
  return { ...d, status: transitionDeliverable(d.status, "released") };
}

// ---------------------------------------------------------------------------
// Web-project staging model — staging URL vs final transfer are distinct
// ---------------------------------------------------------------------------

export function publishStaging(d: DeliverableState, stagingUrl: string): DeliverableState {
  if (!stagingUrl.startsWith("https://")) {
    throw new DeliverableError("VALIDATION", "Staging URL must be an https:// URL.");
  }
  if (d.status === "draft") {
    throw new DeliverableError(
      "STAGING_BLOCKED",
      "Submit the deliverable before publishing a staging URL.",
    );
  }
  return { ...d, stagingUrl, stagingTransfer: "staging_live" };
}

export function requestStagingTransfer(d: DeliverableState): DeliverableState {
  if (d.stagingTransfer !== "staging_live") {
    throw new DeliverableError(
      "STAGING_BLOCKED",
      "A live staging URL is required before requesting transfer.",
    );
  }
  if (d.status !== "released") {
    throw new DeliverableError(
      "STAGING_BLOCKED",
      "Final transfer (credentials, DNS, ownership handoff) requires release first.",
    );
  }
  return { ...d, stagingTransfer: "transfer_pending" };
}

export function completeStagingTransfer(d: DeliverableState): DeliverableState {
  if (d.stagingTransfer !== "transfer_pending") {
    throw new DeliverableError(
      "STAGING_BLOCKED",
      "Transfer must be requested before it can be completed.",
    );
  }
  return { ...d, stagingTransfer: "transferred" };
}

/** Client-safe staging projection: URL visible for review, transfer state shown. */
export function stagingForClient(d: DeliverableState): {
  stagingUrl: string | null;
  transferState: StagingTransferState;
  transferNote: string;
} {
  const transferNote =
    d.stagingTransfer === "transferred"
      ? "Final handoff is complete — production is yours."
      : d.stagingTransfer === "transfer_pending"
        ? "Final handoff is in progress."
        : d.stagingTransfer === "staging_live"
          ? "Staging preview is live for review — production handoff happens after release."
          : "No staging preview yet.";
  return {
    stagingUrl: d.stagingUrl && canClientReview(d.status) ? d.stagingUrl : null,
    transferState: d.stagingTransfer,
    transferNote,
  };
}
