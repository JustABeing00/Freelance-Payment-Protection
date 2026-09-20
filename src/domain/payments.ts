/**
 * Payment lifecycle — provider-backed money state machine (Session 08).
 *
 * We are NOT building our own escrow and we NEVER store raw card data.
 * Cards are entered on the provider's hosted checkout only; this module
 * tracks the provider's authoritative verdict per payment row.
 *
 * States (task contract):
 *   created → pending → processing → paid
 *                    ↘ failed | cancelled
 *   paid → refunded | disputed
 *   processing → failed | paid
 *   pending → failed | cancelled | paid (short-circuit providers)
 *
 * Rules:
 * - `paid` comes ONLY from a verified provider webhook event (or a verified
 *   retrieve/reconcile call). Browser return to a success page proves nothing
 *   and never transitions state.
 * - Amount + currency must match the stored expectation exactly before `paid`;
 *   mismatches append `PaymentAmountMismatched` and stay put for human review.
 * - Every transition maps to an auditable event type (appended by the route).
 * - Legacy rows may carry `received` (alias of `paid`) or `partial`
 *   (verified part-payment that counts toward totals but is not terminal).
 */

export const PAYMENT_LIFECYCLE_STATES = [
  "created",
  "pending",
  "processing",
  "paid",
  "failed",
  "cancelled",
  "refunded",
  "disputed",
  // Legacy verified aliases kept for rows written before Session 08.
  "received",
  "partial",
] as const;

export type PaymentLifecycleState = (typeof PAYMENT_LIFECYCLE_STATES)[number];

/** Terminal states: no further transitions except dispute/record review. */
const TERMINAL: ReadonlySet<string> = new Set(["failed", "cancelled", "refunded"]);

const ALLOWED: Record<string, readonly string[]> = {
  created: ["pending", "cancelled", "failed"],
  pending: ["processing", "paid", "failed", "cancelled"],
  processing: ["paid", "failed", "cancelled"],
  paid: ["refunded", "disputed"],
  partial: ["paid", "refunded", "disputed"],
  received: ["refunded", "disputed"],
  disputed: ["refunded"],
  failed: [],
  cancelled: [],
  refunded: [],
};

export type PaymentTransitionCode = "INVALID_TRANSITION" | "TERMINAL_STATE" | "AMOUNT_MISMATCH";

export class PaymentTransitionError extends Error {
  readonly code: PaymentTransitionCode;
  constructor(code: PaymentTransitionCode, message: string) {
    super(message);
    this.name = "PaymentTransitionError";
    this.code = code;
  }
}

/** Pure guard: is `next` reachable from `current`? */
export function canTransitionPayment(from: string, to: string): boolean {
  const nexts = ALLOWED[from];
  if (!nexts) return false;
  return nexts.includes(to);
}

/** Pure transition — throws PaymentTransitionError when illegal. */
export function transitionPayment(from: string, to: string): PaymentLifecycleState {
  if (from === to) return from as PaymentLifecycleState;
  if (TERMINAL.has(from)) {
    throw new PaymentTransitionError(
      "TERMINAL_STATE",
      `payment in terminal state ${from} cannot move to ${to}`,
    );
  }
  if (!canTransitionPayment(from, to)) {
    throw new PaymentTransitionError(
      "INVALID_TRANSITION",
      `payment cannot move from ${from} to ${to}`,
    );
  }
  return to as PaymentLifecycleState;
}

/** Auditable event type per lifecycle state. */
export const EVENT_BY_PAYMENT_STATE: Record<string, string> = {
  created: "PaymentCreated",
  pending: "PaymentPending",
  processing: "PaymentProcessing",
  paid: "PaymentReceived",
  failed: "PaymentFailed",
  cancelled: "PaymentCancelled",
  refunded: "PaymentRefunded",
  disputed: "PaymentDisputed",
};

/** Provider webhook → lifecycle target. Unknown types return null (ignore). */
export function providerEventToState(providerType: string): PaymentLifecycleState | null {
  const t = providerType.trim();
  switch (t) {
    case "checkout.session.completed":
    case "payment_intent.succeeded":
    case "charge.succeeded":
      return "paid";
    case "payment_intent.processing":
      return "processing";
    case "payment_intent.payment_failed":
    case "charge.failed":
      return "failed";
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed":
    case "payment_intent.canceled":
      return "cancelled";
    case "charge.refunded":
    case "refund.created":
    case "refund.succeeded":
      return "refunded";
    case "charge.dispute.created":
    case "charge.dispute.updated":
      return "disputed";
    default:
      return null;
  }
}

/** Stripe payment_intent status → lifecycle target (for retrieve/reconcile). */
export function stripeIntentStatusToState(status: string): PaymentLifecycleState | null {
  switch (status) {
    case "requires_payment_method":
    case "requires_confirmation":
    case "requires_action":
    case "requires_capture":
      return "pending";
    case "processing":
      return "processing";
    case "succeeded":
      return "paid";
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

export interface ExpectedMoney {
  readonly amountCents: number;
  readonly currency: string;
}

export interface ReportedMoney {
  readonly amountCents: number;
  readonly currency: string;
}

/**
 * Amount/currency validation: the webhook's reported money must equal the
 * stored expectation exactly (integer cents + ISO currency). Returns null on
 * match, or a human-readable mismatch reason. Callers must NOT mark paid on
 * mismatch — they append `PaymentAmountMismatched` for review instead.
 */
export function validateWebhookMoney(
  expected: ExpectedMoney,
  reported: ReportedMoney,
): string | null {
  if (!Number.isInteger(reported.amountCents) || reported.amountCents <= 0) {
    return `reported amount ${reported.amountCents} is not a positive integer`;
  }
  const expCurrency = expected.currency.trim().toUpperCase();
  const repCurrency = reported.currency.trim().toUpperCase();
  if (repCurrency !== expCurrency) {
    return `currency mismatch: expected ${expCurrency}, reported ${repCurrency || "(missing)"}`;
  }
  if (reported.amountCents !== expected.amountCents) {
    return `amount mismatch: expected ${expected.amountCents}, reported ${reported.amountCents}`;
  }
  return null;
}

/** States that count as verified money toward milestone/project totals. */
export function isVerifiedPaymentState(state: string): boolean {
  return state === "paid" || state === "received" || state === "partial";
}

/** States from which a refund may be issued. */
export function canRefundPayment(state: string): boolean {
  return state === "paid" || state === "received" || state === "partial";
}

/** States from which a cancel may be issued. */
export function canCancelPayment(state: string): boolean {
  return state === "created" || state === "pending" || state === "processing";
}

/** Documented transition table (tests assert its keys). */
export const PAYMENT_ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  created: ["created→pending", "created→cancelled", "created→failed"],
  pending: ["pending→processing", "pending→paid", "pending→failed", "pending→cancelled"],
  processing: ["processing→paid", "processing→failed", "processing→cancelled"],
  paid: ["paid→refunded", "paid→disputed"],
};
