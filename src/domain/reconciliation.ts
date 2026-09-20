import { isVerifiedPaymentState } from "./payments.js";
import { formatMinorUnits } from "./money.js";

/**
 * Payment reconciliation — trustworthy money state (Session 09).
 *
 * Three sources of truth are compared without ever rewriting history:
 * - internal records (Payment rows + milestone projections + project total)
 * - payment-provider events (verified webhooks / retrieve — the ONLY thing
 *   that may move money to `paid`)
 * - invoices/milestones + project totals (what was agreed vs what arrived)
 *
 * Product principle (enforced everywhere below):
 *   "Client says they paid" is NOT "payment is verified."
 *
 * Verification tiers carried through every report:
 * - `claimed` — a client assertion (`PaymentClaimed` / `claimed_unverified`).
 *   Never counts toward totals. Always needs provider confirmation.
 * - `initiated` — a checkout/payment intent exists (`created/pending/
 *   processing`). No money has moved yet.
 * - `provider_confirmed` — a verified provider event confirms the money
 *   (`paid/received/partial`). This is the ONLY tier that counts as paid.
 * - `settled` — funds received/settled where the provider exposes that state
 *   (e.g. `transfer.paid` / `payout.paid` after capture). Stripe card payments
 *   capture immediately, so a confirmed card payment IS the settlement record
 *   in MVP; the tier exists so providers with separate settlement map cleanly.
 * - `failed` — the attempt moved no money (`failed/cancelled`).
 * - `reversed` — confirmed money later moved away (`refunded/disputed`).
 *
 * All functions are pure (no DB, no network) so reports are recomputable and
 * tests never need a live provider.
 */

export type VerificationTier =
  "claimed" | "initiated" | "provider_confirmed" | "settled" | "failed" | "reversed";

export function verificationTierForPaymentState(state: string): VerificationTier {
  switch (state) {
    case "paid":
    case "received":
    case "partial":
      return "provider_confirmed";
    case "settled":
      return "settled";
    case "failed":
    case "cancelled":
      return "failed";
    case "refunded":
    case "disputed":
      return "reversed";
    case "created":
    case "pending":
    case "processing":
      return "initiated";
    default:
      return "initiated";
  }
}

export function verificationLabel(tier: VerificationTier): string {
  switch (tier) {
    case "claimed":
      return "Claimed — client says paid, not verified";
    case "initiated":
      return "Initiated — awaiting provider confirmation";
    case "provider_confirmed":
      return "Provider-confirmed — verified receipt";
    case "settled":
      return "Settled — funds received";
    case "failed":
      return "Failed — no money moved";
    case "reversed":
      return "Reversed — funds returned or under dispute";
  }
}

/**
 * Provider event types that mean "funds settled" beyond confirmation, for
 * providers that expose settlement separately from authorization/capture.
 * Stripe card payments capture on success, so `payment_intent.succeeded`
 * already implies settlement in MVP — these extra types simply let the
 * history label the settlement leg when a provider sends it.
 */
const SETTLEMENT_EVENT_TYPES: readonly string[] = [
  "transfer.paid",
  "payout.paid",
  "balance.available",
];

export function isSettlementProviderEvent(providerType: string): boolean {
  return SETTLEMENT_EVENT_TYPES.includes(providerType.trim());
}

/** Human settlement note for a payment row (provider-aware, doc-grade). */
export function settlementNote(provider: string, state: string): string {
  if (state === "settled") return "Funds settled (provider settlement record).";
  if (provider === "stripe" && isVerifiedPaymentState(state)) {
    return "Stripe card payments capture immediately: this confirmed receipt is the settlement record (no separate settled webhook in MVP).";
  }
  if (isVerifiedPaymentState(state)) {
    return "Provider-confirmed receipt. Settlement follows the provider's payout schedule.";
  }
  return "No settlement — no verified money for this payment.";
}

export type MismatchSeverity = "error" | "warning" | "info";

export interface ReconciliationMismatch {
  readonly code: string;
  readonly severity: MismatchSeverity;
  readonly message: string;
  readonly milestoneId?: string | undefined;
  readonly paymentId?: string | undefined;
}

export interface ReconcileMilestoneInput {
  readonly id: string;
  readonly title: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly orderIndex: number;
  readonly paymentState: string;
  readonly appliedPaymentIds: readonly string[];
}

export interface ReconcilePaymentInput {
  readonly id: string;
  readonly milestoneId?: string | undefined;
  readonly amountCents: number;
  readonly currency: string;
  readonly state: string;
  readonly provider: string;
  readonly providerPaymentId: string;
  readonly createdAt: Date;
  readonly receivedAt?: Date | undefined;
}

export interface ReconcileEventInput {
  readonly id: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly milestoneId?: string | undefined;
  readonly payload: Record<string, unknown>;
}

export interface ReconcileProjectInput {
  readonly projectId: string;
  readonly projectTotalCents: number;
  readonly projectCurrency: string;
  readonly milestones: readonly ReconcileMilestoneInput[];
  readonly payments: readonly ReconcilePaymentInput[];
  readonly events: readonly ReconcileEventInput[];
}

export interface PerMilestoneReport {
  readonly milestoneId: string;
  readonly title: string;
  readonly amountCents: number;
  readonly verifiedCents: number;
  readonly pendingCents: number;
  readonly status:
    | "paid"
    | "partial"
    | "unpaid"
    | "overpaid"
    | "claimed"
    | "disputed"
    | "refunded"
    | "awaiting_confirmation";
  readonly message: string;
}

export interface ReconciliationReport {
  readonly projectId: string;
  readonly totals: {
    readonly milestoneTotalCents: number;
    readonly projectTotalCents: number;
    readonly verifiedPaidCents: number;
    readonly pendingInitiatedCents: number;
    readonly refundedCents: number;
    readonly disputedCents: number;
    readonly outstandingCents: number;
    readonly currency: string;
  };
  readonly verification: {
    readonly claimedMilestones: number;
    readonly initiatedPayments: number;
    readonly confirmedPayments: number;
    readonly failedPayments: number;
    readonly reversedPayments: number;
  };
  readonly perMilestone: readonly PerMilestoneReport[];
  readonly mismatches: readonly ReconciliationMismatch[];
  /** True when no error-severity mismatch remains. */
  readonly balanced: boolean;
}

export interface PaymentHistoryEntry {
  /** ISO timestamp for display/sort. */
  readonly at: string;
  readonly kind:
    | "initiated"
    | "confirmed"
    | "claimed"
    | "failed"
    | "refunded"
    | "disputed"
    | "needs_review"
    | "reconciled";
  readonly headline: string;
  readonly detail: string;
  readonly tier: VerificationTier;
  readonly milestoneId?: string | undefined;
  readonly paymentId?: string | undefined;
}

function money(cents: number, currency: string): string {
  try {
    return formatMinorUnits(cents, currency);
  } catch {
    return `${currency} ${(cents / 100).toFixed(2)}`;
  }
}

function milestoneTitle(
  id: string | undefined,
  milestones: readonly ReconcileMilestoneInput[],
): string {
  if (!id) return "project total";
  return milestones.find((m) => m.id === id)?.title ?? "removed milestone";
}

function verifiedSumFor(payments: readonly ReconcilePaymentInput[], milestoneId: string): number {
  let sum = 0;
  for (const p of payments) {
    if (p.milestoneId === milestoneId && isVerifiedPaymentState(p.state)) sum += p.amountCents;
  }
  return sum;
}

function pendingSumFor(payments: readonly ReconcilePaymentInput[], milestoneId: string): number {
  let sum = 0;
  for (const p of payments) {
    if (
      p.milestoneId === milestoneId &&
      (p.state === "created" || p.state === "pending" || p.state === "processing")
    ) {
      sum += p.amountCents;
    }
  }
  return sum;
}

/**
 * Compare internal records vs milestones vs project totals. Never throws on
 * bad data — every anomaly becomes a mismatch entry for human review.
 */
export function reconcileProject(input: ReconcileProjectInput): ReconciliationReport {
  const mismatches: ReconciliationMismatch[] = [];
  const { milestones, payments, events } = input;

  let milestoneTotalCents = 0;
  for (const m of milestones) {
    if (Number.isInteger(m.amountCents) && m.amountCents >= 0) milestoneTotalCents += m.amountCents;
  }

  let verifiedPaidCents = 0;
  let pendingInitiatedCents = 0;
  let refundedCents = 0;
  let disputedCents = 0;
  let initiatedPayments = 0;
  let confirmedPayments = 0;
  let failedPayments = 0;
  let reversedPayments = 0;
  const byId = new Map(payments.map((p) => [p.id, p] as const));

  for (const p of payments) {
    const tier = verificationTierForPaymentState(p.state);
    if (tier === "provider_confirmed" || tier === "settled") {
      verifiedPaidCents += p.amountCents;
      confirmedPayments += 1;
    } else if (tier === "initiated") {
      pendingInitiatedCents += p.amountCents;
      initiatedPayments += 1;
    } else if (tier === "failed") {
      failedPayments += 1;
    } else if (tier === "reversed") {
      reversedPayments += 1;
      if (p.state === "refunded") refundedCents += p.amountCents;
      if (p.state === "disputed") disputedCents += p.amountCents;
    }
  }

  // --- project-level integrity -------------------------------------------
  if (milestoneTotalCents !== input.projectTotalCents) {
    mismatches.push({
      code: "milestone_total_mismatch",
      severity: "error",
      message: `Milestone amounts total ${money(milestoneTotalCents, input.projectCurrency)} but the project total is ${money(input.projectTotalCents, input.projectCurrency)} — invoice schedule and project total disagree.`,
    });
  }

  // --- per-payment integrity ----------------------------------------------
  const milestoneIds = new Set(milestones.map((m) => m.id));
  for (const p of payments) {
    if (!p.providerPaymentId || p.providerPaymentId.trim().length === 0) {
      mismatches.push({
        code: "missing_provider_linkage",
        severity: "error",
        message: `Payment ${p.id.slice(0, 8)}… has no provider reference — it can never be verified. Create a new checkout instead of editing this row.`,
        paymentId: p.id,
        ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
      });
    }
    if (p.currency.toUpperCase() !== input.projectCurrency.toUpperCase()) {
      mismatches.push({
        code: "currency_mismatch",
        severity: "error",
        message: `Payment ${p.id.slice(0, 8)}… is ${p.currency.toUpperCase()} but the project is ${input.projectCurrency.toUpperCase()} — amounts are not comparable until this is resolved.`,
        paymentId: p.id,
        ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
      });
    }
    if (p.milestoneId !== undefined && !milestoneIds.has(p.milestoneId)) {
      mismatches.push({
        code: "orphan_payment",
        severity: "error",
        message: `Payment ${p.id.slice(0, 8)}… (${money(p.amountCents, p.currency)}) points at a milestone that no longer exists — verified money with no invoice home.`,
        paymentId: p.id,
        milestoneId: p.milestoneId,
      });
    }
    if (p.state === "failed" || p.state === "cancelled") {
      mismatches.push({
        code: "failed_payment",
        severity: "warning",
        message: `Payment ${p.id.slice(0, 8)}… for ${milestoneTitle(p.milestoneId, milestones)} ${p.state} — no money moved, safe to retry with a fresh checkout.`,
        paymentId: p.id,
        ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
      });
    }
    if (p.state === "disputed") {
      mismatches.push({
        code: "dispute_open",
        severity: "error",
        message: `Dispute open on ${money(p.amountCents, p.currency)} for ${milestoneTitle(p.milestoneId, milestones)} — funds may be reversed. Do not release finals until this clears.`,
        paymentId: p.id,
        ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
      });
    }
    if (p.state === "refunded") {
      mismatches.push({
        code: "refunded_payment",
        severity: "warning",
        message: `Refund of ${money(p.amountCents, p.currency)} for ${milestoneTitle(p.milestoneId, milestones)} confirmed by the provider — money was returned.`,
        paymentId: p.id,
        ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
      });
    }
  }

  // --- per-milestone coverage ----------------------------------------------
  const perMilestone: PerMilestoneReport[] = milestones.map((m) => {
    const verified = verifiedSumFor(payments, m.id);
    const pending = pendingSumFor(payments, m.id);
    const claimed = m.paymentState === "claimed_unverified";
    const disputed =
      m.paymentState === "disputed" ||
      payments.some((p) => p.milestoneId === m.id && p.state === "disputed");
    const refunded = m.paymentState === "refunded";

    if (verified > m.amountCents) {
      mismatches.push({
        code: "overpaid_milestone",
        severity: "error",
        message: `"${m.title}" collected ${money(verified, m.currency)} against an invoice of ${money(m.amountCents, m.currency)} — possible duplicate charge. Review before refunding.`,
        milestoneId: m.id,
      });
    } else if (verified > 0 && verified < m.amountCents) {
      mismatches.push({
        code: "partial_uncovered",
        severity: "info",
        message: `"${m.title}" has ${money(verified, m.currency)} verified of ${money(m.amountCents, m.currency)} — partial payment, ${money(m.amountCents - verified, m.currency)} still due.`,
        milestoneId: m.id,
      });
    }
    if (claimed && verified <= 0) {
      mismatches.push({
        code: "claimed_without_payment",
        severity: "warning",
        message: `"${m.title}": client says they paid — NOT verified. No provider receipt exists; nothing counts toward totals until one arrives.`,
        milestoneId: m.id,
      });
    }
    if (pending > 0 && verified < m.amountCents && !disputed) {
      mismatches.push({
        code: "initiated_without_confirmation",
        severity: "info",
        message: `"${m.title}" has ${money(pending, m.currency)} initiated but unconfirmed — awaiting the provider, not the client.`,
        milestoneId: m.id,
      });
    }

    // Projection drift: verified rows that the milestone never applied.
    const applied = new Set(m.appliedPaymentIds);
    for (const p of payments) {
      if (p.milestoneId === m.id && isVerifiedPaymentState(p.state) && !applied.has(p.id)) {
        mismatches.push({
          code: "unapplied_verified",
          severity: "warning",
          message: `Verified payment ${p.id.slice(0, 8)}… (${money(p.amountCents, p.currency)}) is missing from "${m.title}" applied receipts — projection drift. Re-run reconciliation to re-apply.`,
          milestoneId: m.id,
          paymentId: p.id,
        });
      }
    }
    // Duplicate application of the same receipt.
    if (new Set(m.appliedPaymentIds).size !== m.appliedPaymentIds.length) {
      mismatches.push({
        code: "duplicate_applied_payment",
        severity: "error",
        message: `"${m.title}" lists the same receipt twice — a receipt may only be applied once. History was preserved; dedupe the projection.`,
        milestoneId: m.id,
      });
    }
    for (const pid of m.appliedPaymentIds) {
      if (!byId.has(pid)) {
        mismatches.push({
          code: "unapplied_verified",
          severity: "warning",
          message: `"${m.title}" references receipt ${pid.slice(0, 8)}… which no longer resolves — projection drift. History was preserved.`,
          milestoneId: m.id,
          paymentId: pid,
        });
      }
    }

    let status: PerMilestoneReport["status"];
    let message: string;
    if (disputed) {
      status = "disputed";
      message = "Under dispute — needs review before release.";
    } else if (refunded) {
      status = "refunded";
      message = "Refunded — funds were returned.";
    } else if (verified > m.amountCents) {
      status = "overpaid";
      message = `Overpaid by ${money(verified - m.amountCents, m.currency)} — review.`;
    } else if (verified === m.amountCents && m.amountCents > 0) {
      status = "paid";
      message = "Paid in full (verified receipts).";
    } else if (verified > 0) {
      status = "partial";
      message = `${money(verified, m.currency)} of ${money(m.amountCents, m.currency)} verified.`;
    } else if (claimed) {
      status = "claimed";
      message = "Client says paid — awaiting provider confirmation.";
    } else if (pending > 0) {
      status = "awaiting_confirmation";
      message = "Checkout started — awaiting provider confirmation.";
    } else {
      status = "unpaid";
      message = "Unpaid.";
    }
    return {
      milestoneId: m.id,
      title: m.title,
      amountCents: m.amountCents,
      verifiedCents: verified,
      pendingCents: pending,
      status,
      message,
    };
  });

  if (verifiedPaidCents > milestoneTotalCents && milestoneTotalCents > 0) {
    mismatches.push({
      code: "overpaid_project",
      severity: "error",
      message: `Project collected ${money(verifiedPaidCents, input.projectCurrency)} against invoiced ${money(milestoneTotalCents, input.projectCurrency)} — duplicate or mis-attached payment suspected.`,
    });
  }

  // --- event-derived diagnostics (needs-review queue, out-of-order) --------
  const orderedEvents = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  // Confirmations seen in the timeline (explicit receipts only — a
  // drift-check line is not a confirmation) plus rows that already carry
  // verified history (receivedAt / applied receipts), so legitimate
  // API-driven refunds are not mistaken for out-of-order webhooks.
  const appliedIds = new Set<string>();
  for (const m of milestones) for (const pid of m.appliedPaymentIds) appliedIds.add(pid);
  const confirmedPaymentIds = new Set<string>();
  for (const p of payments) {
    if (p.receivedAt !== undefined || appliedIds.has(p.id)) confirmedPaymentIds.add(p.id);
  }
  const receivedByPayment = new Set<string>(confirmedPaymentIds);
  for (const e of orderedEvents) {
    const pid = typeof e.payload.paymentId === "string" ? e.payload.paymentId : undefined;
    if (e.type === "PaymentReceived" && pid) {
      receivedByPayment.add(pid);
    }
    if (e.type === "PaymentAmountMismatched") {
      const reason = typeof e.payload.reason === "string" ? e.payload.reason : "amount review";
      // The route records "(possible out-of-order delivery …)" at arrival
      // time — that point-in-time verdict persists as audit trail even after
      // the late confirmation converges the state.
      const flaggedOutOfOrder = /out-of-order/i.test(reason);
      const illegal = /illegal transition/i.test(reason);
      const looksOutOfOrder =
        flaggedOutOfOrder ||
        (illegal &&
          /refunded|disputed/i.test(reason) &&
          pid !== undefined &&
          !receivedByPayment.has(pid));
      mismatches.push({
        code: looksOutOfOrder ? "out_of_order" : "needs_review",
        severity: looksOutOfOrder ? "warning" : "error",
        message: looksOutOfOrder
          ? `Provider event for ${pid?.slice(0, 8) ?? "unknown payment"}… arrived before its confirmation (${reason}). Kept local state; reconciliation will converge when the confirmation lands.`
          : `Needs review: ${reason}. Local state kept; no history rewritten.`,
        ...(typeof e.milestoneId === "string" ? { milestoneId: e.milestoneId } : {}),
        ...(pid !== undefined ? { paymentId: pid } : {}),
      });
    }
    if (
      (e.type === "PaymentRefunded" || e.type === "PaymentDisputed") &&
      pid &&
      !receivedByPayment.has(pid)
    ) {
      mismatches.push({
        code: "out_of_order",
        severity: "warning",
        message: `${e.type} for ${pid.slice(0, 8)}… appears before any recorded confirmation — likely out-of-order delivery. Treated as needs-review until the confirmation arrives.`,
        ...(typeof e.milestoneId === "string" ? { milestoneId: e.milestoneId } : {}),
        paymentId: pid,
      });
    }
  }

  const claimedMilestones = milestones.filter(
    (m) => m.paymentState === "claimed_unverified",
  ).length;
  const outstandingCents = Math.max(0, milestoneTotalCents - verifiedPaidCents);
  const balanced = !mismatches.some((m) => m.severity === "error");

  return {
    projectId: input.projectId,
    totals: {
      milestoneTotalCents,
      projectTotalCents: input.projectTotalCents,
      verifiedPaidCents,
      pendingInitiatedCents,
      refundedCents,
      disputedCents,
      outstandingCents,
      currency: input.projectCurrency,
    },
    verification: {
      claimedMilestones,
      initiatedPayments,
      confirmedPayments,
      failedPayments,
      reversedPayments,
    },
    perMilestone,
    mismatches,
    balanced,
  };
}

/**
 * Human-readable payment history: one plain-language line per fact, newest
 * last (so a timeline reads top-to-bottom). Claims are always labelled
 * NOT-verified; only provider-confirmed lines use "confirmed/received".
 */
export function buildPaymentHistory(input: ReconcileProjectInput): PaymentHistoryEntry[] {
  const entries: PaymentHistoryEntry[] = [];
  const { milestones, payments, events } = input;

  const sortedPayments = [...payments].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );
  for (const p of sortedPayments) {
    const title = milestoneTitle(p.milestoneId, milestones);
    const base = {
      ...(p.milestoneId !== undefined ? { milestoneId: p.milestoneId } : {}),
      paymentId: p.id,
    };
    const initiatedAt = p.createdAt.toISOString();
    entries.push({
      at: initiatedAt,
      kind: "initiated",
      headline: `Checkout created for ${title} — ${money(p.amountCents, p.currency)}`,
      detail:
        "Payment started. This proves nothing yet: the milestone counts it only when the provider confirms.",
      tier: "initiated",
      ...base,
    });
    const tier = verificationTierForPaymentState(p.state);
    const at = p.receivedAt ? p.receivedAt.toISOString() : initiatedAt;
    if (tier === "provider_confirmed" || tier === "settled") {
      entries.push({
        at,
        kind: "confirmed",
        headline: `Provider confirmed ${money(p.amountCents, p.currency)} for ${title}`,
        detail: `Verified receipt (${p.provider}). ${settlementNote(p.provider, p.state)}`,
        tier: tier === "settled" ? "settled" : "provider_confirmed",
        ...base,
      });
    } else if (tier === "failed") {
      entries.push({
        at,
        kind: "failed",
        headline: `Payment of ${money(p.amountCents, p.currency)} for ${title} ${p.state}`,
        detail: "No money moved. Safe to retry with a fresh checkout; history preserved.",
        tier: "failed",
        ...base,
      });
    } else if (p.state === "refunded") {
      entries.push({
        at,
        kind: "refunded",
        headline: `Refund of ${money(p.amountCents, p.currency)} for ${title} confirmed`,
        detail: "The provider returned the funds. Delivery history stays as it happened.",
        tier: "reversed",
        ...base,
      });
    } else if (p.state === "disputed") {
      entries.push({
        at,
        kind: "disputed",
        headline: `Dispute opened on ${money(p.amountCents, p.currency)} for ${title}`,
        detail: "Funds may be reversed. Do not release finals until this clears.",
        tier: "reversed",
        ...base,
      });
    }
  }

  const orderedEvents = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  for (const e of orderedEvents) {
    const pid = typeof e.payload.paymentId === "string" ? e.payload.paymentId : undefined;
    const mid = typeof e.milestoneId === "string" ? e.milestoneId : undefined;
    const base = {
      ...(mid !== undefined ? { milestoneId: mid } : {}),
      ...(pid !== undefined ? { paymentId: pid } : {}),
    };
    if (e.type === "PaymentClaimed") {
      entries.push({
        at: e.occurredAt.toISOString(),
        kind: "claimed",
        headline: `Client says they paid ${milestoneTitle(mid, milestones)} — NOT verified`,
        detail:
          "A client assertion only. Nothing counts toward totals until a provider receipt arrives.",
        tier: "claimed",
        ...base,
      });
    } else if (e.type === "PaymentAmountMismatched") {
      const reason = typeof e.payload.reason === "string" ? e.payload.reason : "review needed";
      entries.push({
        at: e.occurredAt.toISOString(),
        kind: "needs_review",
        headline: `Needs review for ${milestoneTitle(mid, milestones)}`,
        detail: `${reason}. Local state kept; an admin can resolve after checking the provider dashboard.`,
        tier: "initiated",
        ...base,
      });
    } else if (e.type === "PaymentReconciled") {
      const remote = e.payload.remote as { status?: unknown; amountCents?: unknown } | undefined;
      const drift = e.payload.drift === true;
      entries.push({
        at: e.occurredAt.toISOString(),
        kind: "reconciled",
        headline: drift
          ? `Reconciliation flagged a drift for ${milestoneTitle(mid, milestones)}`
          : `Reconciliation checked ${milestoneTitle(mid, milestones)} against the provider`,
        detail:
          typeof remote?.status === "string"
            ? `Provider reported status "${remote.status}". ${drift ? "Amounts differ — kept local state for review." : "Local state kept where the provider agreed; illegal jumps recorded, never forced."}`
            : "Server-to-server read-back completed; no history rewritten.",
        tier: "initiated",
        ...base,
      });
    }
  }

  entries.sort((a, b) => a.at.localeCompare(b.at));
  return entries;
}
