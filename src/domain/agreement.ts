import { createHash } from "node:crypto";

/**
 * Agreement / payment-terms layer — pure, DB-free business rules (Session 06).
 *
 * The product is NOT a law firm. It records configurable business terms the
 * freelancer defines, renders them as a readable draft, hashes the canonical
 * payload so historical versions stay reconstructable, and tracks a
 * signature/acceptance lifecycle with an event audit trail. Whether the terms
 * are enforceable depends on jurisdiction and the actual agreement between
 * the parties — that disclaimer ships in every API response and in the
 * rendered terms text itself.
 *
 * ## Lifecycle (status)
 * ```
 * draft → pending_acceptance → accepted
 *   │            │                 │
 *   │            │                 └── superseded (a newer version was accepted)
 *   └────────────┴── voided (withdrawn before acceptance)
 * ```
 * - A version row is IMMUTABLE once written: corrections are a new version,
 *   never an edit. The DB guard (`0004_agreement_terms`) rejects content
 *   updates and DELETEs; the store seam only exposes lifecycle transitions.
 * - `isCurrent` marks the newest non-voided version (what the UI shows).
 * - Acceptance pins `{ hash, version, acceptedBy, acceptedAt }` — the exact
 *   bytes the client saw can be rebuilt from `termsText` + `hash`.
 *
 * ## Required term coverage (task §session)
 * amount, deposit/first milestone, milestone schedule, payment deadline,
 * accepted payment method(s), late-payment policy, work-pause policy,
 * final-delivery condition, ownership/delivery condition, revision limits,
 * cancellation/termination terms.
 */

export const AGREEMENT_DISCLAIMER =
  "This workspace records configurable business terms for your own agreement. " +
  "It is not a law firm and does not provide legal advice. " +
  "Whether these terms are enforceable depends on your jurisdiction and the actual agreement you make with your client. " +
  "Consider independent legal review before relying on them.";

export const AGREEMENT_DISCLAIMER_VERSION = "v1";

export const AGREEMENT_STATUSES = [
  "draft",
  "pending_acceptance",
  "accepted",
  "superseded",
  "voided",
] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

export const PAYMENT_METHODS = [
  "bank_transfer",
  "card",
  "paypal",
  "stripe",
  "wise",
  "cash",
  "check",
  "other",
] as const;
export type AcceptedPaymentMethod = (typeof PAYMENT_METHODS)[number];

export const LATE_FEE_KINDS = ["none", "flat_fee", "percentage_per_month", "custom"] as const;
export type LateFeeKind = (typeof LATE_FEE_KINDS)[number];

export const RELEASE_CONDITIONS = [
  "current_milestone_paid",
  "all_milestones_paid",
  "manual_release",
] as const;
export type AgreementReleaseCondition = (typeof RELEASE_CONDITIONS)[number];

export const OWNERSHIP_MODES = [
  "on_final_payment",
  "on_each_milestone_payment",
  "on_project_completion",
  "custom",
] as const;
export type OwnershipMode = (typeof OWNERSHIP_MODES)[number];

export interface MilestoneScheduleEntry {
  readonly title: string;
  readonly amountCents: number;
  readonly dueLabel?: string | undefined;
}

export interface LatePaymentPolicy {
  readonly kind: LateFeeKind;
  readonly description: string;
  readonly feeCents?: number | undefined;
  readonly percentBps?: number | undefined;
}

export interface AgreementTerms {
  readonly totalAmountCents: number;
  readonly currency: string;
  /** First milestone amount — must equal schedule[0].amountCents. */
  readonly depositAmountCents: number;
  readonly milestoneSchedule: readonly MilestoneScheduleEntry[];
  /** Days after invoice/request until payment is due (0 = on receipt). */
  readonly paymentDueDays: number;
  readonly graceDays: number;
  readonly acceptedPaymentMethods: readonly AcceptedPaymentMethod[];
  readonly latePaymentPolicy: LatePaymentPolicy;
  /** Days overdue before work may pause + human-readable rule. */
  readonly pauseAfterOverdueDays: number;
  readonly workPauseDescription: string;
  readonly releaseCondition: AgreementReleaseCondition;
  readonly finalDeliveryDescription: string;
  readonly ownershipMode: OwnershipMode;
  readonly ownershipDescription: string;
  readonly maxRevisionsPerMilestone: number;
  readonly extraRevisionPolicy: string;
  readonly cancellationNoticeDays: number;
  readonly cancellationKillFeeCents?: number | undefined;
  readonly cancellationPolicy: string;
  readonly customClauses?: string | undefined;
}

export interface AgreementVersion {
  readonly id: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly version: number;
  readonly status: AgreementStatus;
  readonly isCurrent: boolean;
  readonly terms: AgreementTerms;
  readonly termsText: string;
  readonly hash: string;
  readonly disclaimerVersion: string;
  readonly supersedesId?: string | undefined;
  readonly sentAt?: Date | undefined;
  readonly acceptedAt?: Date | undefined;
  readonly acceptedBy?: string | undefined;
  readonly acceptIpHash?: string | undefined;
  readonly acceptUaHash?: string | undefined;
  readonly voidedAt?: Date | undefined;
  readonly createdAt: Date;
}

export class AgreementError extends Error {
  readonly code: "INVALID_TERMS" | "INVALID_TRANSITION" | "HASH_MISMATCH" | "ALREADY_ACCEPTED";
  constructor(code: AgreementError["code"], message: string) {
    super(message);
    this.name = "AgreementError";
    this.code = code;
  }
}

const MAX_CENTS = 999_999_999_999;

function isPositiveInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function isNonNegativeInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0;
}

/** Stable stringify: object keys sorted recursively so hashes are deterministic. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const rendered = JSON.stringify(value) as string | undefined;
    return rendered ?? "null";
  }
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** sha256 hex of the canonical terms payload — the evidence fingerprint. */
export function hashAgreementTerms(terms: AgreementTerms): string {
  const canonical: Record<string, unknown> = {
    acceptedPaymentMethods: [...terms.acceptedPaymentMethods].sort(),
    cancellationKillFeeCents: terms.cancellationKillFeeCents ?? null,
    cancellationNoticeDays: terms.cancellationNoticeDays,
    cancellationPolicy: terms.cancellationPolicy,
    currency: terms.currency.toUpperCase(),
    customClauses: terms.customClauses ?? null,
    depositAmountCents: terms.depositAmountCents,
    disclaimerVersion: AGREEMENT_DISCLAIMER_VERSION,
    extraRevisionPolicy: terms.extraRevisionPolicy,
    finalDeliveryDescription: terms.finalDeliveryDescription,
    graceDays: terms.graceDays,
    latePaymentPolicy: {
      description: terms.latePaymentPolicy.description,
      feeCents: terms.latePaymentPolicy.feeCents ?? null,
      kind: terms.latePaymentPolicy.kind,
      percentBps: terms.latePaymentPolicy.percentBps ?? null,
    },
    maxRevisionsPerMilestone: terms.maxRevisionsPerMilestone,
    milestoneSchedule: terms.milestoneSchedule.map((m) => ({
      amountCents: m.amountCents,
      dueLabel: m.dueLabel ?? null,
      title: m.title.trim(),
    })),
    ownershipDescription: terms.ownershipDescription,
    ownershipMode: terms.ownershipMode,
    pauseAfterOverdueDays: terms.pauseAfterOverdueDays,
    paymentDueDays: terms.paymentDueDays,
    releaseCondition: terms.releaseCondition,
    totalAmountCents: terms.totalAmountCents,
    workPauseDescription: terms.workPauseDescription,
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

export function validateAgreementTerms(terms: AgreementTerms): void {
  if (!isPositiveInt(terms.totalAmountCents) || terms.totalAmountCents > MAX_CENTS) {
    throw new AgreementError("INVALID_TERMS", "totalAmountCents must be a positive integer");
  }
  if (!/^[A-Za-z]{3}$/.test(terms.currency)) {
    throw new AgreementError("INVALID_TERMS", "currency must be a 3-letter ISO code");
  }
  if (
    !isNonNegativeInt(terms.depositAmountCents) ||
    terms.depositAmountCents > terms.totalAmountCents
  ) {
    throw new AgreementError(
      "INVALID_TERMS",
      "depositAmountCents must be between 0 and the total amount",
    );
  }
  if (terms.milestoneSchedule.length === 0 || terms.milestoneSchedule.length > 50) {
    throw new AgreementError("INVALID_TERMS", "milestoneSchedule must list 1–50 entries");
  }
  for (const entry of terms.milestoneSchedule) {
    if (typeof entry.title !== "string" || entry.title.trim().length === 0) {
      throw new AgreementError("INVALID_TERMS", "each schedule entry needs a title");
    }
    if (entry.title.trim().length > 120) {
      throw new AgreementError("INVALID_TERMS", "schedule titles must be ≤ 120 chars");
    }
    if (/deposit/i.test(entry.title)) {
      throw new AgreementError(
        "INVALID_TERMS",
        'schedule titles must not use the "Deposit" label — use "Milestone 1 — …"',
      );
    }
    if (!isPositiveInt(entry.amountCents) || entry.amountCents > MAX_CENTS) {
      throw new AgreementError("INVALID_TERMS", "each schedule entry needs a positive amount");
    }
    if (entry.dueLabel !== undefined && entry.dueLabel.length > 120) {
      throw new AgreementError("INVALID_TERMS", "schedule due labels must be ≤ 120 chars");
    }
  }
  const scheduled = terms.milestoneSchedule.reduce((sum, m) => sum + m.amountCents, 0);
  if (scheduled !== terms.totalAmountCents) {
    throw new AgreementError(
      "INVALID_TERMS",
      `milestone schedule must sum to the total (${scheduled} ≠ ${terms.totalAmountCents})`,
    );
  }
  const first = terms.milestoneSchedule[0];
  if (first && terms.depositAmountCents !== first.amountCents) {
    throw new AgreementError(
      "INVALID_TERMS",
      "depositAmountCents must equal the first milestone amount (deposit = Milestone 1)",
    );
  }
  if (
    !Number.isInteger(terms.paymentDueDays) ||
    terms.paymentDueDays < 0 ||
    terms.paymentDueDays > 90
  ) {
    throw new AgreementError("INVALID_TERMS", "paymentDueDays must be 0–90");
  }
  if (!Number.isInteger(terms.graceDays) || terms.graceDays < 0 || terms.graceDays > 30) {
    throw new AgreementError("INVALID_TERMS", "graceDays must be 0–30");
  }
  if (terms.acceptedPaymentMethods.length === 0) {
    throw new AgreementError("INVALID_TERMS", "at least one accepted payment method is required");
  }
  for (const method of terms.acceptedPaymentMethods) {
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
      throw new AgreementError("INVALID_TERMS", `unknown payment method: ${method}`);
    }
  }
  const late = terms.latePaymentPolicy;
  if (!(LATE_FEE_KINDS as readonly string[]).includes(late.kind)) {
    throw new AgreementError("INVALID_TERMS", "latePaymentPolicy.kind is unknown");
  }
  if (late.description.trim().length === 0 || late.description.length > 1000) {
    throw new AgreementError(
      "INVALID_TERMS",
      "latePaymentPolicy.description is required (≤ 1000 chars)",
    );
  }
  if (late.kind === "flat_fee") {
    if (!isPositiveInt(late.feeCents)) {
      throw new AgreementError("INVALID_TERMS", "flat_fee late policy needs a positive feeCents");
    }
  }
  if (late.kind === "percentage_per_month") {
    if (!isPositiveInt(late.percentBps) || late.percentBps > 10000) {
      throw new AgreementError(
        "INVALID_TERMS",
        "percentage_per_month late policy needs percentBps 1–10000",
      );
    }
  }
  if (
    !Number.isInteger(terms.pauseAfterOverdueDays) ||
    terms.pauseAfterOverdueDays < 0 ||
    terms.pauseAfterOverdueDays > 90
  ) {
    throw new AgreementError("INVALID_TERMS", "pauseAfterOverdueDays must be 0–90");
  }
  if (terms.workPauseDescription.trim().length === 0 || terms.workPauseDescription.length > 1000) {
    throw new AgreementError("INVALID_TERMS", "workPauseDescription is required (≤ 1000 chars)");
  }
  if (!(RELEASE_CONDITIONS as readonly string[]).includes(terms.releaseCondition)) {
    throw new AgreementError("INVALID_TERMS", "releaseCondition is unknown");
  }
  if (
    terms.finalDeliveryDescription.trim().length === 0 ||
    terms.finalDeliveryDescription.length > 1000
  ) {
    throw new AgreementError(
      "INVALID_TERMS",
      "finalDeliveryDescription is required (≤ 1000 chars)",
    );
  }
  if (!(OWNERSHIP_MODES as readonly string[]).includes(terms.ownershipMode)) {
    throw new AgreementError("INVALID_TERMS", "ownershipMode is unknown");
  }
  if (terms.ownershipDescription.trim().length === 0 || terms.ownershipDescription.length > 1000) {
    throw new AgreementError("INVALID_TERMS", "ownershipDescription is required (≤ 1000 chars)");
  }
  if (
    !Number.isInteger(terms.maxRevisionsPerMilestone) ||
    terms.maxRevisionsPerMilestone < 0 ||
    terms.maxRevisionsPerMilestone > 20
  ) {
    throw new AgreementError("INVALID_TERMS", "maxRevisionsPerMilestone must be 0–20");
  }
  if (terms.extraRevisionPolicy.trim().length === 0 || terms.extraRevisionPolicy.length > 1000) {
    throw new AgreementError("INVALID_TERMS", "extraRevisionPolicy is required (≤ 1000 chars)");
  }
  if (
    !Number.isInteger(terms.cancellationNoticeDays) ||
    terms.cancellationNoticeDays < 0 ||
    terms.cancellationNoticeDays > 90
  ) {
    throw new AgreementError("INVALID_TERMS", "cancellationNoticeDays must be 0–90");
  }
  if (
    terms.cancellationKillFeeCents !== undefined &&
    (!isNonNegativeInt(terms.cancellationKillFeeCents) ||
      terms.cancellationKillFeeCents > terms.totalAmountCents)
  ) {
    throw new AgreementError(
      "INVALID_TERMS",
      "cancellationKillFeeCents must be between 0 and the total amount",
    );
  }
  if (terms.cancellationPolicy.trim().length === 0 || terms.cancellationPolicy.length > 2000) {
    throw new AgreementError("INVALID_TERMS", "cancellationPolicy is required (≤ 2000 chars)");
  }
  if (terms.customClauses !== undefined && terms.customClauses.length > 5000) {
    throw new AgreementError("INVALID_TERMS", "customClauses must be ≤ 5000 chars");
  }
}

function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
}

/**
 * Render the canonical human-readable draft. The hash of the structured terms
 * (not this text) is the evidence fingerprint; this text is what the client
 * reads, and it always ends with the non-law-firm disclaimer.
 */
export function buildAgreementText(args: {
  projectTitle: string;
  clientName: string;
  version: number;
  terms: AgreementTerms;
  hash: string;
}): string {
  const { projectTitle, clientName, version, terms, hash } = args;
  const currency = terms.currency.toUpperCase();
  const schedule = terms.milestoneSchedule
    .map(
      (m, i) =>
        `  ${i + 1}. ${m.title.trim()} — ${formatMoney(m.amountCents, currency)}${m.dueLabel ? ` (${m.dueLabel})` : ""}`,
    )
    .join("\n");
  const lines = [
    `Payment Terms — ${projectTitle} (version ${version})`,
    `Prepared for: ${clientName}`,
    `Total project amount: ${formatMoney(terms.totalAmountCents, currency)}`,
    "",
    `1. Amount. The total project amount is ${formatMoney(terms.totalAmountCents, currency)}.`,
    `2. Deposit / first milestone. Work begins with Milestone 1 funded at ${formatMoney(terms.depositAmountCents, currency)}.`,
    `3. Milestone schedule. The total is split as:`,
    schedule,
    `4. Payment deadline. Payment is due ${terms.paymentDueDays} day(s) after each request, with a ${terms.graceDays} day grace period for reminders before late handling.`,
    `5. Accepted payment methods. ${terms.acceptedPaymentMethods.join(", ")}.`,
    `6. Late-payment policy. ${terms.latePaymentPolicy.description}`,
    `7. Work-pause policy. ${terms.workPauseDescription} (pause may begin ${terms.pauseAfterOverdueDays} day(s) after the due date).`,
    `8. Final-delivery condition. ${terms.finalDeliveryDescription} [gate: ${terms.releaseCondition}]`,
    `9. Ownership / delivery condition. ${terms.ownershipDescription} [mode: ${terms.ownershipMode}]`,
    `10. Revision limits. Up to ${terms.maxRevisionsPerMilestone} revision(s) per milestone. ${terms.extraRevisionPolicy}`,
    `11. Cancellation / termination. ${terms.cancellationPolicy} (notice: ${terms.cancellationNoticeDays} day(s)${terms.cancellationKillFeeCents !== undefined ? `, fee: ${formatMoney(terms.cancellationKillFeeCents, currency)}` : ""}).`,
  ];
  if (terms.customClauses?.trim()) {
    lines.push(`12. Additional terms. ${terms.customClauses.trim()}`);
  }
  lines.push("", `Terms fingerprint (sha256): ${hash}`, `Disclaimer: ${AGREEMENT_DISCLAIMER}`);
  return lines.join("\n");
}

/** Build a new draft version object (pure — the route persists it). */
export function createAgreementDraft(args: {
  id: string;
  workspaceId: string;
  projectId: string;
  version: number;
  terms: AgreementTerms;
  projectTitle: string;
  clientName: string;
  supersedesId?: string | undefined;
  createdAt?: Date | undefined;
}): AgreementVersion {
  if (!Number.isInteger(args.version) || args.version < 1) {
    throw new AgreementError("INVALID_TERMS", "version must start at 1 and increment by 1");
  }
  validateAgreementTerms(args.terms);
  const hash = hashAgreementTerms(args.terms);
  const termsText = buildAgreementText({
    projectTitle: args.projectTitle,
    clientName: args.clientName,
    version: args.version,
    terms: args.terms,
    hash,
  });
  return {
    id: args.id,
    workspaceId: args.workspaceId,
    projectId: args.projectId,
    version: args.version,
    status: "draft",
    isCurrent: true,
    terms: args.terms,
    termsText,
    hash,
    disclaimerVersion: AGREEMENT_DISCLAIMER_VERSION,
    ...(args.supersedesId !== undefined ? { supersedesId: args.supersedesId } : {}),
    createdAt: args.createdAt ?? new Date(),
  };
}

/** draft → pending_acceptance (freelancer sends the draft to the client). */
export function sendForAcceptance(agreement: AgreementVersion, sentAt?: Date): AgreementVersion {
  if (agreement.status !== "draft") {
    throw new AgreementError(
      "INVALID_TRANSITION",
      `only drafts can be sent (current status: ${agreement.status})`,
    );
  }
  return { ...agreement, status: "pending_acceptance", sentAt: sentAt ?? new Date() };
}

/** pending_acceptance → accepted (client signature/acceptance recorded). */
export function acceptAgreement(
  agreement: AgreementVersion,
  acceptance: {
    acceptedBy: string;
    acceptedAt?: Date | undefined;
    acceptIpHash?: string | undefined;
    acceptUaHash?: string | undefined;
  },
): AgreementVersion {
  if (agreement.status === "accepted") {
    throw new AgreementError("ALREADY_ACCEPTED", "this agreement version is already accepted");
  }
  if (agreement.status !== "pending_acceptance") {
    throw new AgreementError(
      "INVALID_TRANSITION",
      `only sent versions can be accepted (current status: ${agreement.status})`,
    );
  }
  const acceptedBy = acceptance.acceptedBy.trim();
  if (acceptedBy.length < 2 || acceptedBy.length > 200) {
    throw new AgreementError("INVALID_TERMS", "acceptedBy must name who accepted (2–200 chars)");
  }
  return {
    ...agreement,
    status: "accepted",
    acceptedBy,
    acceptedAt: acceptance.acceptedAt ?? new Date(),
    ...(acceptance.acceptIpHash !== undefined ? { acceptIpHash: acceptance.acceptIpHash } : {}),
    ...(acceptance.acceptUaHash !== undefined ? { acceptUaHash: acceptance.acceptUaHash } : {}),
  };
}

/** accepted → superseded (a newer version was accepted; history preserved). */
export function supersedeAgreement(agreement: AgreementVersion): AgreementVersion {
  if (agreement.status !== "accepted") {
    throw new AgreementError(
      "INVALID_TRANSITION",
      `only accepted versions can be superseded (current status: ${agreement.status})`,
    );
  }
  return { ...agreement, status: "superseded", isCurrent: false };
}

/** draft/pending_acceptance → voided (withdrawn before acceptance). */
export function voidAgreement(agreement: AgreementVersion, voidedAt?: Date): AgreementVersion {
  if (agreement.status !== "draft" && agreement.status !== "pending_acceptance") {
    throw new AgreementError(
      "INVALID_TRANSITION",
      `only drafts or sent versions can be voided (current status: ${agreement.status})`,
    );
  }
  return { ...agreement, status: "voided", isCurrent: false, voidedAt: voidedAt ?? new Date() };
}

/** Re-verify that stored content still matches its fingerprint. */
export function verifyAgreementHash(agreement: Pick<AgreementVersion, "terms" | "hash">): boolean {
  return hashAgreementTerms(agreement.terms) === agreement.hash;
}

/**
 * Content-equality guard: after acceptance (or ever, for stored rows) the
 * freelancer must not silently change terms — a change requires a new
 * version. Returns true when two versions carry identical business content.
 */
export function sameAgreementContent(a: AgreementTerms, b: AgreementTerms): boolean {
  return hashAgreementTerms(a) === hashAgreementTerms(b);
}
