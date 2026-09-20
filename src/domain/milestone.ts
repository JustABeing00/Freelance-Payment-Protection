/**
 * Milestone engine — explicit multi-dimension state model (Session 05).
 *
 * A project contains an ordered set of milestones (e.g. Discovery $500 →
 * Design $1,000 → Development $1,500 → Launch $1,000). Each milestone carries
 * its own money + work + decision + artifact + sequencing state. There are NO
 * boolean flags (`isPaid`, `isApproved`, `isUnlocked` …): every dimension is a
 * single explicit enum, and every mutation goes through a guarded transition
 * below. Impossible combinations are unrepresentable-by-construction at the
 * type level and rejected at runtime with `MilestoneTransitionError`.
 *
 * ## Dimensions
 * - `work`: freelancer progress. `draft → in_progress → submitted → viewed →
 *   revision_requested → submitted → approved` (plus `disputed` from any state).
 * - `payment`: verified-money lifecycle with TWO explicit paid phases so the
 *   task's `draft → payment_pending → funded → … → approved → payment_pending
 *   → paid → unlocked` workflow is representable without conflating funding
 *   (work may start) and payout (work is settled):
 *   `unpaid → payment_pending → funded → payment_pending → paid`
 *   (plus `claimed_unverified` for client assertions that NEVER count as paid,
 *   `overdue`, `plan_active`, `refunded`, `disputed`).
 * - `approval`: client decision, version-pinned. `none → pending → approved |
 *   revision_requested | rejected`. Approval is only valid when
 *   `approvedVersionId === currentVersionId` (mirrors `release.ts`).
 * - `deliverable`: artifact gate (mirrors `types.ts` delivery).
 *   `locked → preview_shared → unlocked_ready → released`.
 * - `unlock`: sequential availability DERIVED from siblings, never set
 *   directly: `locked → available → unlocked`. Milestone 0 starts
 *   `available`; milestone N becomes `available` only when its predecessors
 *   satisfy the workflow's `unlockPolicy`. `unlocked` means paid + released.
 *
 * ## Allowed transitions (per dimension; cross-dimension guards apply)
 * ```
 * WORK:        draft → in_progress → submitted → viewed → approved
 *              submitted → revision_requested → submitted (loop)
 *              viewed → revision_requested → submitted
 *              any → disputed (freezes work; needs explicit resolve path later)
 * PAYMENT:     unpaid → payment_pending (request_funding)
 *              payment_pending → funded (confirm_funding, verified only)
 *              payment_pending → claimed_unverified (client claim, never paid)
 *              claimed_unverified → funded (verified receipt supersedes claim)
 *              funded → payment_pending (request_payout after approval)
 *              payment_pending → paid (confirm_payout, verified only, ONCE)
 *              unpaid|payment_pending|funded → overdue (scheduler)
 *              overdue → payment_pending|funded|paid (recovery)
 *              funded|paid → refunded (provider reversal; history preserved)
 *              any → disputed
 * APPROVAL:    none → pending (submit)
 *              pending → approved (version-pinned approve)
 *              pending → revision_requested | rejected
 *              revision_requested → pending (resubmit)
 * DELIVERABLE: locked → preview_shared → unlocked_ready → released
 *              (release requires paid + version-pinned approval unless the
 *              workflow sets requireApprovalForRelease=false)
 * UNLOCK:      locked → available (predecessors satisfy unlockPolicy)
 *              available → unlocked (this milestone paid + released)
 *              (no other unlock transition exists — skipping is rejected)
 * AMOUNT:      any → any ONLY via changeMilestoneAmount(); after `funded` an
 *              audit `{reason ≥ 8 chars, actorId}` is mandatory and the old
 *              value is preserved in amountHistory.
 * SEQUENCE:    only via reorderMilestones(); order must stay contiguous
 *              0..n-1 with no gaps/duplicates; frozen once funded/paid unless
 *              audited.
 * ```
 *
 * ## Configurable workflows
 * `MilestoneWorkflowConfig` adapts the guards without changing the state
 * vocabulary: `requireFundingBeforeWork` (default true),
 * `requireApprovalForPayout` (default true), `sequentialUnlock` (default
 * true) + `unlockPolicy` (`previous_paid` default | `previous_approved` |
 * `open`). Presets: `DEFAULT_WORKFLOW`, `FLEXIBLE_WORKFLOW` (parallel work,
 * funding optional), `STRICT_WORKFLOW` (funding + approval + all-paid release).
 *
 * Compatibility: `toLegacyProjection()` maps onto the canonical 3-dimension
 * `{work, payment, delivery}` vocabulary in `types.ts`/`events.ts` so the
 * event reducer, money math and release gates keep working unchanged.
 */

export const MILESTONE_WORK_STATES = [
  "draft",
  "in_progress",
  "submitted",
  "viewed",
  "revision_requested",
  "approved",
  "disputed",
] as const;
export type MilestoneWork = (typeof MILESTONE_WORK_STATES)[number];

export const MILESTONE_PAYMENT_STATES = [
  "unpaid",
  "payment_pending",
  "claimed_unverified",
  "funded",
  "paid",
  "overdue",
  "plan_active",
  "refunded",
  "disputed",
] as const;
export type MilestonePayment = (typeof MILESTONE_PAYMENT_STATES)[number];

export const MILESTONE_APPROVAL_STATES = [
  "none",
  "pending",
  "approved",
  "revision_requested",
  "rejected",
] as const;
export type MilestoneApproval = (typeof MILESTONE_APPROVAL_STATES)[number];

export const MILESTONE_DELIVERABLE_STATES = [
  "locked",
  "preview_shared",
  "unlocked_ready",
  "released",
] as const;
export type MilestoneDeliverable = (typeof MILESTONE_DELIVERABLE_STATES)[number];

export const MILESTONE_UNLOCK_STATES = ["locked", "available", "unlocked"] as const;
export type MilestoneUnlock = (typeof MILESTONE_UNLOCK_STATES)[number];

export interface MilestoneWorkflowConfig {
  readonly requireFundingBeforeWork: boolean;
  readonly requireApprovalForPayout: boolean;
  readonly sequentialUnlock: boolean;
  readonly unlockPolicy: "previous_paid" | "previous_approved" | "open";
}

export const DEFAULT_WORKFLOW: MilestoneWorkflowConfig = {
  requireFundingBeforeWork: true,
  requireApprovalForPayout: true,
  sequentialUnlock: true,
  unlockPolicy: "previous_paid",
};

export const FLEXIBLE_WORKFLOW: MilestoneWorkflowConfig = {
  requireFundingBeforeWork: false,
  requireApprovalForPayout: false,
  sequentialUnlock: false,
  unlockPolicy: "open",
};

export const STRICT_WORKFLOW: MilestoneWorkflowConfig = {
  requireFundingBeforeWork: true,
  requireApprovalForPayout: true,
  sequentialUnlock: true,
  unlockPolicy: "previous_paid",
};

export interface MilestoneAmountAudit {
  readonly milestoneId: string;
  readonly oldAmountCents: number;
  readonly newAmountCents: number;
  readonly reason: string;
  readonly actorId: string;
  readonly changedAt: Date;
}

export interface MilestoneState {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly amountCents: number;
  readonly currency: string;
  readonly orderIndex: number;
  readonly dueDate?: Date | undefined;
  readonly work: MilestoneWork;
  readonly payment: MilestonePayment;
  readonly approval: MilestoneApproval;
  readonly deliverable: MilestoneDeliverable;
  readonly unlock: MilestoneUnlock;
  /** Verified receipt ids already applied — paying twice is rejected. */
  readonly appliedPaymentIds: readonly string[];
  readonly amountHistory: readonly MilestoneAmountAudit[];
  readonly approvedVersionId: string | null;
  readonly currentVersionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type MilestoneTransitionCode =
  | "INVALID_TRANSITION"
  | "GUARD_VIOLATION"
  | "DUPLICATE_PAYMENT"
  | "AUDIT_REQUIRED"
  | "SEQUENCE_VIOLATION";

export class MilestoneTransitionError extends Error {
  readonly code: MilestoneTransitionCode;
  constructor(code: MilestoneTransitionCode, message: string) {
    super(message);
    this.name = "MilestoneTransitionError";
    this.code = code;
  }
}

function fail(code: MilestoneTransitionCode, message: string): never {
  throw new MilestoneTransitionError(code, message);
}

function assertIntegerCents(value: number, field = "amountCents"): void {
  if (!Number.isInteger(value) || value < 0) {
    fail("GUARD_VIOLATION", `${field} must be a non-negative integer, got: ${value}`);
  }
}

function touch(m: MilestoneState, patch: Partial<MilestoneState>): MilestoneState {
  return { ...m, ...patch, updatedAt: new Date() };
}

export interface CreateMilestoneInput {
  id?: string | undefined;
  projectId: string;
  title: string;
  description?: string | undefined;
  amountCents: number;
  currency: string;
  orderIndex: number;
  dueDate?: Date | undefined;
  currentVersionId?: string | null | undefined;
  now?: Date | undefined;
}

const TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;

export function createMilestone(input: CreateMilestoneInput): MilestoneState {
  const title = input.title.trim();
  if (title.length === 0) fail("GUARD_VIOLATION", "title is required");
  if (title.length > TITLE_MAX) fail("GUARD_VIOLATION", `title must be ≤ ${TITLE_MAX} chars`);
  if (/deposit/i.test(title)) {
    fail(
      "GUARD_VIOLATION",
      'Title must not use the "Deposit" label — frame first payments as "Milestone 1 — …" (product thesis).',
    );
  }
  if (input.description !== undefined && input.description.length > DESCRIPTION_MAX) {
    fail("GUARD_VIOLATION", `description must be ≤ ${DESCRIPTION_MAX} chars`);
  }
  assertIntegerCents(input.amountCents);
  if (input.amountCents <= 0) fail("GUARD_VIOLATION", "amountCents must be positive");
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) fail("GUARD_VIOLATION", "currency must be a 3-letter ISO code");
  if (!Number.isInteger(input.orderIndex) || input.orderIndex < 0) {
    fail("GUARD_VIOLATION", "orderIndex must be a non-negative integer");
  }
  if (input.dueDate !== undefined && Number.isNaN(input.dueDate.getTime())) {
    fail("GUARD_VIOLATION", "dueDate must be a valid date");
  }
  const now = input.now ?? new Date();
  const id = input.id ?? `ms_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  return {
    id,
    projectId: input.projectId,
    title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    amountCents: input.amountCents,
    currency,
    orderIndex: input.orderIndex,
    ...(input.dueDate !== undefined ? { dueDate: new Date(input.dueDate) } : {}),
    work: "draft",
    payment: "unpaid",
    approval: "none",
    deliverable: "locked",
    unlock: input.orderIndex === 0 ? "available" : "locked",
    appliedPaymentIds: [],
    amountHistory: [],
    approvedVersionId: null,
    ...(input.currentVersionId != null
      ? { currentVersionId: input.currentVersionId }
      : { currentVersionId: null }),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Canonical 4-milestone example from the session brief. Amounts are integer
 * cents; currencies must match; due dates (when given) must be non-decreasing
 * in sequence order.
 */
export function createMilestoneSet(args: {
  projectId: string;
  currency?: string | undefined;
  specs?:
    | readonly { title: string; description?: string; amountCents: number; dueDate?: Date }[]
    | undefined;
  now?: Date | undefined;
}): MilestoneState[] {
  const currency = (args.currency ?? "USD").toUpperCase();
  const defaults: readonly {
    title: string;
    description?: string | undefined;
    amountCents: number;
    dueDate?: Date | undefined;
  }[] = [
    { title: "Discovery", amountCents: 50000 },
    { title: "Design", amountCents: 100000 },
    { title: "Development", amountCents: 150000 },
    { title: "Launch", amountCents: 100000 },
  ];
  const specs = args.specs ?? defaults;
  const out = specs.map((s, i) =>
    createMilestone({
      projectId: args.projectId,
      title: s.title,
      ...(s.description !== undefined ? { description: s.description } : {}),
      amountCents: s.amountCents,
      currency,
      orderIndex: i,
      ...(s.dueDate !== undefined ? { dueDate: s.dueDate } : {}),
      ...(args.now !== undefined ? { now: args.now } : {}),
    }),
  );
  validateMilestoneSequence(out);
  return out;
}

// ---- Payment transitions (verified receipts only) ----

export function requestFunding(m: MilestoneState): MilestoneState {
  if (m.payment === "paid" || m.payment === "refunded") {
    fail("INVALID_TRANSITION", `cannot request funding from payment=${m.payment}`);
  }
  if (m.payment === "disputed") fail("INVALID_TRANSITION", "milestone is disputed");
  if (m.payment === "payment_pending" || m.payment === "funded") return m;
  return touch(m, { payment: "payment_pending" });
}

/** Client assertion — recorded but NEVER counts as paid (invariant). */
export function markClaimed(m: MilestoneState): MilestoneState {
  if (m.payment === "paid" || m.payment === "funded" || m.payment === "refunded") {
    fail("INVALID_TRANSITION", `cannot claim from payment=${m.payment}`);
  }
  if (m.payment === "disputed") fail("INVALID_TRANSITION", "milestone is disputed");
  return touch(m, { payment: "claimed_unverified" });
}

/**
 * Verified provider receipt. `paymentId` is the idempotency key: repeating it
 * (or confirming twice for a fully-funded milestone) is rejected so a
 * milestone can never be paid twice for the same receipt.
 */
export function confirmFunding(
  m: MilestoneState,
  paymentId: string,
  receivedCents?: number,
): MilestoneState {
  if (!paymentId || paymentId.trim().length === 0) {
    fail("GUARD_VIOLATION", "paymentId (idempotency key) is required");
  }
  if (m.appliedPaymentIds.includes(paymentId)) {
    fail("DUPLICATE_PAYMENT", `payment ${paymentId} was already applied to this milestone`);
  }
  if (m.payment === "paid") fail("DUPLICATE_PAYMENT", "milestone is already paid in full");
  if (m.payment === "refunded") fail("INVALID_TRANSITION", "milestone was refunded");
  if (m.payment === "disputed") fail("INVALID_TRANSITION", "milestone is disputed");
  const amount = receivedCents ?? m.amountCents;
  assertIntegerCents(amount, "receivedCents");
  if (amount <= 0) fail("GUARD_VIOLATION", "receivedCents must be positive");
  // Partial receipts accumulate; the milestone is `funded` once verified
  // receipts cover the full amount. Track via applied ids; the caller sums
  // amounts from its payment ledger (see money.isMilestonePaid).
  const funded = amount >= m.amountCents;
  return touch(m, {
    payment: funded ? "funded" : "payment_pending",
    appliedPaymentIds: [...m.appliedPaymentIds, paymentId],
  });
}

export function requestPayout(
  m: MilestoneState,
  config: MilestoneWorkflowConfig = DEFAULT_WORKFLOW,
): MilestoneState {
  if (m.payment !== "funded" && m.payment !== "overdue") {
    fail(
      "INVALID_TRANSITION",
      `payout can only be requested from funded/overdue, got payment=${m.payment}`,
    );
  }
  if (config.requireApprovalForPayout && m.approval !== "approved") {
    fail("GUARD_VIOLATION", "payout requires a version-pinned approval first");
  }
  if (m.work !== "approved") {
    fail("GUARD_VIOLATION", `payout requires work=approved, got work=${m.work}`);
  }
  return touch(m, { payment: "payment_pending" });
}

export function confirmPayout(m: MilestoneState, paymentId: string): MilestoneState {
  if (!paymentId || paymentId.trim().length === 0) {
    fail("GUARD_VIOLATION", "paymentId (idempotency key) is required");
  }
  if (m.appliedPaymentIds.includes(paymentId)) {
    fail("DUPLICATE_PAYMENT", `payment ${paymentId} was already applied to this milestone`);
  }
  if (m.payment === "paid") fail("DUPLICATE_PAYMENT", "milestone is already paid");
  if (m.payment !== "payment_pending" && m.payment !== "funded") {
    fail(
      "INVALID_TRANSITION",
      `payout can only be confirmed from payment_pending/funded, got payment=${m.payment}`,
    );
  }
  return touch(m, {
    payment: "paid",
    appliedPaymentIds: [...m.appliedPaymentIds, paymentId],
    unlock: m.deliverable === "released" ? "unlocked" : m.unlock,
  });
}

export function markOverdue(m: MilestoneState): MilestoneState {
  if (m.payment === "paid" || m.payment === "refunded") return m;
  if (m.payment === "disputed") fail("INVALID_TRANSITION", "milestone is disputed");
  return touch(m, { payment: "overdue" });
}

export function refundMilestone(m: MilestoneState): MilestoneState {
  if (m.payment !== "funded" && m.payment !== "paid") {
    fail(
      "INVALID_TRANSITION",
      `only funded/paid milestones can be refunded, got payment=${m.payment}`,
    );
  }
  return touch(m, { payment: "refunded" });
}

// ---- Work / approval transitions ----

export function startWork(
  m: MilestoneState,
  config: MilestoneWorkflowConfig = DEFAULT_WORKFLOW,
): MilestoneState {
  if (m.work !== "draft") {
    fail("INVALID_TRANSITION", `work can only start from draft, got work=${m.work}`);
  }
  if (m.unlock !== "available" && m.unlock !== "unlocked") {
    fail(
      "GUARD_VIOLATION",
      "cannot start work on a locked milestone — finish its predecessors first",
    );
  }
  if (config.requireFundingBeforeWork && m.payment !== "funded") {
    fail("GUARD_VIOLATION", `work requires funded payment first, got payment=${m.payment}`);
  }
  return touch(m, { work: "in_progress" });
}

export function submitWork(m: MilestoneState): MilestoneState {
  if (m.work !== "in_progress" && m.work !== "revision_requested") {
    fail(
      "INVALID_TRANSITION",
      `work can only be submitted from in_progress/revision_requested, got work=${m.work}`,
    );
  }
  return touch(m, { work: "submitted", approval: "pending" });
}

export function markViewed(m: MilestoneState): MilestoneState {
  if (m.work !== "submitted") {
    fail("INVALID_TRANSITION", `only submitted work can be viewed, got work=${m.work}`);
  }
  return touch(m, { work: "viewed" });
}

export function requestRevision(m: MilestoneState, note?: string): MilestoneState {
  if (m.work !== "submitted" && m.work !== "viewed") {
    fail(
      "INVALID_TRANSITION",
      `revision can only be requested on submitted/viewed work, got work=${m.work}`,
    );
  }
  if (note !== undefined && note.trim().length > 0 && note.trim().length < 3) {
    fail("GUARD_VIOLATION", "revision note is too short to be actionable");
  }
  return touch(m, { work: "revision_requested", approval: "revision_requested" });
}

/**
 * Version-pinned approval: approving a superseded version is rejected.
 * There is no "approve from draft" — nonexistent states cannot be approved.
 */
export function approveWork(
  m: MilestoneState,
  args: { approvedVersionId: string | null; currentVersionId: string },
): MilestoneState {
  if (m.work !== "submitted" && m.work !== "viewed") {
    fail(
      "INVALID_TRANSITION",
      `only submitted/viewed work can be approved, got work=${m.work} (approving nonexistent states is rejected)`,
    );
  }
  if (args.approvedVersionId === null || args.approvedVersionId !== args.currentVersionId) {
    fail(
      "GUARD_VIOLATION",
      "approval is version-pinned: the approved version must equal the current deliverable version",
    );
  }
  return touch(m, {
    work: "approved",
    approval: "approved",
    approvedVersionId: args.approvedVersionId,
    currentVersionId: args.currentVersionId,
  });
}

export function rejectWork(m: MilestoneState): MilestoneState {
  if (m.work !== "submitted" && m.work !== "viewed") {
    fail("INVALID_TRANSITION", `only submitted/viewed work can be rejected, got work=${m.work}`);
  }
  return touch(m, { approval: "rejected" });
}

export function disputeMilestone(m: MilestoneState): MilestoneState {
  return touch(m, { work: "disputed", payment: "disputed" });
}

// ---- Deliverable / release transitions ----

export function sharePreview(m: MilestoneState): MilestoneState {
  if (m.deliverable !== "locked") {
    fail("INVALID_TRANSITION", `preview can only be shared from locked, got ${m.deliverable}`);
  }
  return touch(m, { deliverable: "preview_shared" });
}

export function markUnlockReady(m: MilestoneState): MilestoneState {
  if (m.deliverable !== "preview_shared" && m.deliverable !== "locked") {
    fail("INVALID_TRANSITION", `cannot mark unlock-ready from ${m.deliverable}`);
  }
  return touch(m, { deliverable: "unlocked_ready" });
}

/**
 * Final release. Requires verified `paid` + version-pinned approval (unless
 * the workflow relaxes it). On success the milestone unlocks.
 */
export function releaseDeliverable(
  m: MilestoneState,
  config: MilestoneWorkflowConfig = DEFAULT_WORKFLOW,
): MilestoneState {
  if (m.deliverable === "released") fail("DUPLICATE_PAYMENT", "deliverable already released");
  if (m.payment !== "paid") {
    fail("GUARD_VIOLATION", `release requires verified paid, got payment=${m.payment}`);
  }
  if (config.requireApprovalForPayout) {
    if (m.approval !== "approved" || m.work !== "approved") {
      fail("GUARD_VIOLATION", "release requires an approved, version-pinned approval");
    }
    if (
      m.approvedVersionId !== null &&
      m.currentVersionId !== null &&
      m.approvedVersionId !== m.currentVersionId
    ) {
      fail("GUARD_VIOLATION", "approval is pinned to a superseded version");
    }
  }
  return touch(m, { deliverable: "released", unlock: "unlocked" });
}

// ---- Amount changes (audited) ----

const FUNDED_PAYMENTS: readonly MilestonePayment[] = ["funded", "payment_pending", "paid"];

export function changeMilestoneAmount(
  m: MilestoneState,
  newAmountCents: number,
  audit: { reason: string; actorId: string } | null,
): { milestone: MilestoneState; auditRecord: MilestoneAmountAudit | null } {
  assertIntegerCents(newAmountCents, "newAmountCents");
  if (newAmountCents <= 0) fail("GUARD_VIOLATION", "newAmountCents must be positive");
  if (newAmountCents === m.amountCents) return { milestone: m, auditRecord: null };
  const needsAudit = FUNDED_PAYMENTS.includes(m.payment) || m.appliedPaymentIds.length > 0;
  if (needsAudit) {
    if (audit === null || audit.reason.trim().length < 8) {
      fail(
        "AUDIT_REQUIRED",
        "changing the amount after funding/payment requires an audit reason (≥ 8 chars) — history is immutable",
      );
    }
    if (!audit.actorId || audit.actorId.trim().length === 0) {
      fail("AUDIT_REQUIRED", "changing the amount after funding requires an actorId");
    }
    const record: MilestoneAmountAudit = {
      milestoneId: m.id,
      oldAmountCents: m.amountCents,
      newAmountCents,
      reason: audit.reason.trim(),
      actorId: audit.actorId,
      changedAt: new Date(),
    };
    return {
      milestone: touch(m, {
        amountCents: newAmountCents,
        amountHistory: [...m.amountHistory, record],
      }),
      auditRecord: record,
    };
  }
  return { milestone: touch(m, { amountCents: newAmountCents }), auditRecord: null };
}

// ---- Sequence / unlock ----

export function validateMilestoneSequence(milestones: readonly MilestoneState[]): void {
  const seenOrder = new Set<number>();
  const seenId = new Set<string>();
  const currencies = new Set<string>();
  for (const ms of milestones) {
    if (seenId.has(ms.id)) fail("SEQUENCE_VIOLATION", `duplicate milestone id ${ms.id}`);
    seenId.add(ms.id);
    if (!Number.isInteger(ms.orderIndex) || ms.orderIndex < 0) {
      fail("SEQUENCE_VIOLATION", `orderIndex must be a non-negative integer (${ms.title})`);
    }
    if (seenOrder.has(ms.orderIndex)) {
      fail("SEQUENCE_VIOLATION", `duplicate orderIndex ${ms.orderIndex}`);
    }
    seenOrder.add(ms.orderIndex);
    currencies.add(ms.currency);
  }
  for (let i = 0; i < milestones.length; i += 1) {
    if (!seenOrder.has(i)) {
      fail(
        "SEQUENCE_VIOLATION",
        `sequence gap: expected contiguous orderIndex 0..${milestones.length - 1}, missing ${i}`,
      );
    }
  }
  if (currencies.size > 1) {
    fail("SEQUENCE_VIOLATION", "all milestones in a project must share one currency");
  }
  const byOrder = [...milestones].sort((a, b) => a.orderIndex - b.orderIndex);
  for (let i = 1; i < byOrder.length; i += 1) {
    const prev = byOrder[i - 1];
    const cur = byOrder[i];
    if (prev === undefined || cur === undefined) continue;
    if (prev.dueDate && cur.dueDate && cur.dueDate.getTime() < prev.dueDate.getTime()) {
      fail(
        "SEQUENCE_VIOLATION",
        `due dates must be non-decreasing in sequence order (${cur.title} precedes ${prev.title})`,
      );
    }
  }
}

function predecessorSatisfied(
  predecessors: readonly MilestoneState[],
  config: MilestoneWorkflowConfig,
): boolean {
  if (!config.sequentialUnlock || config.unlockPolicy === "open") return true;
  if (predecessors.length === 0) return true;
  if (config.unlockPolicy === "previous_approved") {
    return predecessors.every((p) => p.work === "approved" && p.approval === "approved");
  }
  return predecessors.every((p) => p.payment === "paid");
}

/**
 * Recompute unlock states from sibling order. Never unlocks the future
 * accidentally: a milestone stays `locked` until ALL predecessors satisfy the
 * workflow's unlock policy. Already-`unlocked` milestones stay unlocked.
 */
export function deriveUnlockStates(
  milestones: readonly MilestoneState[],
  config: MilestoneWorkflowConfig = DEFAULT_WORKFLOW,
): MilestoneState[] {
  validateMilestoneSequence(milestones);
  const byOrder = [...milestones].sort((a, b) => a.orderIndex - b.orderIndex);
  return byOrder.map((ms, idx) => {
    if (ms.unlock === "unlocked" || (ms.payment === "paid" && ms.deliverable === "released")) {
      return ms.unlock === "unlocked" ? ms : touch(ms, { unlock: "unlocked" });
    }
    const predecessors = byOrder.slice(0, idx);
    const open = predecessorSatisfied(predecessors, config);
    if (idx === 0) {
      return ms.unlock === "available" ? ms : touch(ms, { unlock: "available" });
    }
    if (open) {
      return ms.unlock === "available" ? ms : touch(ms, { unlock: "available" });
    }
    return ms.unlock === "locked" ? ms : touch(ms, { unlock: "locked" });
  });
}

/**
 * Reorder milestones. Frozen rule: milestones that are funded/paid (or have
 * any applied verified receipt) cannot change position without an audit
 * record — otherwise money could be silently re-attached to a new order.
 */
export function reorderMilestones(
  milestones: readonly MilestoneState[],
  newOrderIds: readonly string[],
  audit: { reason: string; actorId: string } | null = null,
): MilestoneState[] {
  if (newOrderIds.length !== milestones.length) {
    fail("SEQUENCE_VIOLATION", "reorder must include every milestone id exactly once");
  }
  const byId = new Map(milestones.map((m) => [m.id, m]));
  const seen = new Set<string>();
  for (const id of newOrderIds) {
    if (seen.has(id)) fail("SEQUENCE_VIOLATION", `duplicate id in reorder: ${id}`);
    seen.add(id);
    if (!byId.has(id)) fail("SEQUENCE_VIOLATION", `unknown milestone id in reorder: ${id}`);
  }
  const frozen = milestones.filter(
    (m) =>
      m.payment === "funded" ||
      m.payment === "paid" ||
      m.payment === "payment_pending" ||
      m.appliedPaymentIds.length > 0,
  );
  const orderChanged = newOrderIds.some((id, idx) => byId.get(id)?.orderIndex !== idx);
  if (frozen.length > 0 && orderChanged) {
    if (audit === null || audit.reason.trim().length < 8) {
      fail(
        "AUDIT_REQUIRED",
        "reordering after funding/payment requires an audit reason (≥ 8 chars)",
      );
    }
  }
  const reordered = newOrderIds.map((id, idx) => {
    const ms = byId.get(id);
    if (!ms) fail("SEQUENCE_VIOLATION", `unknown milestone id: ${id}`);
    const current = ms;
    return current.orderIndex === idx ? current : touch(current, { orderIndex: idx });
  });
  validateMilestoneSequence(reordered);
  return reordered;
}

// ---- Compatibility with the canonical 3-dimension model ----

export interface LegacyProjection {
  work: string;
  payment: string;
  delivery: string;
}

export function toLegacyProjection(m: MilestoneState): LegacyProjection {
  const payment =
    m.payment === "funded" || m.payment === "paid"
      ? "paid"
      : m.payment === "payment_pending"
        ? "requested"
        : m.payment;
  return { work: m.work, payment, delivery: m.deliverable };
}

export function milestoneTotals(milestones: readonly MilestoneState[]): {
  totalCents: number;
  fundedCents: number;
  paidCents: number;
  currency: string | null;
} {
  let totalCents = 0;
  let fundedCents = 0;
  let paidCents = 0;
  let currency: string | null = null;
  for (const m of milestones) {
    assertIntegerCents(m.amountCents);
    totalCents += m.amountCents;
    currency ??= m.currency;
    if (m.payment === "funded") fundedCents += m.amountCents;
    if (m.payment === "paid") paidCents += m.amountCents;
  }
  return { totalCents, fundedCents, paidCents, currency };
}

/** Documented transition table (rendered in docs + tests assert its keys). */
export const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  work: [
    "draft→in_progress",
    "in_progress→submitted",
    "submitted→viewed",
    "submitted→revision_requested",
    "viewed→revision_requested",
    "revision_requested→submitted",
    "submitted→approved",
    "viewed→approved",
    "any→disputed",
  ],
  payment: [
    "unpaid→payment_pending",
    "payment_pending→funded",
    "payment_pending→claimed_unverified",
    "claimed_unverified→funded",
    "funded→payment_pending",
    "overdue→payment_pending",
    "payment_pending→paid",
    "unpaid|payment_pending|funded→overdue",
    "funded|paid→refunded",
    "any→disputed",
  ],
  approval: [
    "none→pending",
    "pending→approved",
    "pending→revision_requested",
    "pending→rejected",
    "revision_requested→pending",
  ],
  deliverable: [
    "locked→preview_shared",
    "locked→unlocked_ready",
    "preview_shared→unlocked_ready",
    "unlocked_ready→released",
  ],
  unlock: ["locked→available", "available→unlocked"],
};
