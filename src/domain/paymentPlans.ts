/**
 * Payment-plan engine — pure, DB-free rules (Session 13).
 *
 * A client who is late may have a genuine cash-flow problem. The platform lets
 * a freelancer propose a restructured schedule for an outstanding milestone
 * balance (e.g. $2,400 as 4 × $600 weekly, or $1,000 + $700 + $700), the
 * client accepts it, and the system tracks each installment to completion.
 *
 * ## Safety properties (enforced with the routes layer)
 * - History is never rewritten: `originalAmountCents` is write-once (the
 *   original obligation snapshot). A modified schedule is a NEW plan version
 *   that supersedes the old one; the old row + its events stay intact.
 * - Plans never reduce what is owed: `projectOutstandingCents` /
 *   milestone verified sums only move on VERIFIED provider receipts. An
 *   installment is `paid` only when linked to a verified payment row.
 * - Auditable: propose / accept / modify / installment-paid / missed /
 *   reminder / complete / default each append a `PaymentPlan*` project event
 *   carrying `{ planId, version, ... }`, so the timeline shows exactly what
 *   changed and when.
 * - Idempotent: event keys are stable (`plan:<planId>:<transition>` and
 *   `plan:<planId>:installment:<seq>:<transition>`); repeats are safe no-ops.
 * - Professional voice: automatic reminders are system-voiced workflow
 *   notices, never threats. No legal language is generated.
 */

export const PLAN_STATES = [
  "offered",
  "accepted",
  "active",
  "completed",
  "defaulted",
  "superseded",
] as const;
export type PlanState = (typeof PLAN_STATES)[number];

export const INSTALLMENT_STATUSES = ["scheduled", "paid", "missed", "canceled"] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

export interface PlanInstallmentInput {
  readonly amountCents: number;
  readonly dueDate: Date;
}

export interface PlanInstallment {
  /** 1-based position in the schedule (stable across status changes). */
  readonly seq: number;
  readonly amountCents: number;
  readonly dueDate: Date;
  readonly status: InstallmentStatus;
  /** Verified payment row that settled this installment (if paid). */
  readonly paymentId?: string | undefined;
  readonly paidAt?: Date | undefined;
  /** Free-form audit note (e.g. "missed — reminder sent"). */
  readonly note?: string | undefined;
}

export class PaymentPlanError extends Error {
  readonly code: "INVALID_PLAN" | "INVALID_TRANSITION";
  constructor(code: PaymentPlanError["code"], message: string) {
    super(message);
    this.name = "PaymentPlanError";
    this.code = code;
  }
}

export const MAX_INSTALLMENTS = 12;
const NOTE_MAX = 500;

function assertIntegerCents(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new PaymentPlanError(
      "INVALID_PLAN",
      `${field} must be a non-negative integer, got: ${value}`,
    );
  }
}

/**
 * Validate a proposed schedule against the original obligation.
 * - 1–12 installments, each ≥ 1 cent.
 * - Installment amounts must sum EXACTLY to the original obligation (no
 *   silent forgiveness, no silent surcharge — a modified total is a new plan
 *   version with its own snapshot, never an edit).
 * - Due dates must be valid and non-decreasing in schedule order.
 */
export function validatePlanProposal(args: {
  originalAmountCents: number;
  installments: readonly PlanInstallmentInput[];
}): void {
  assertIntegerCents(args.originalAmountCents, "originalAmountCents");
  if (args.originalAmountCents <= 0) {
    throw new PaymentPlanError("INVALID_PLAN", "originalAmountCents must be positive");
  }
  if (args.installments.length === 0) {
    throw new PaymentPlanError("INVALID_PLAN", "at least one installment is required");
  }
  if (args.installments.length > MAX_INSTALLMENTS) {
    throw new PaymentPlanError(
      "INVALID_PLAN",
      `at most ${MAX_INSTALLMENTS} installments are supported`,
    );
  }
  let sum = 0;
  let prevDue = -Infinity;
  args.installments.forEach((inst, idx) => {
    assertIntegerCents(inst.amountCents, `installments[${idx}].amountCents`);
    if (inst.amountCents <= 0) {
      throw new PaymentPlanError(
        "INVALID_PLAN",
        `installments[${idx}].amountCents must be positive`,
      );
    }
    if (!(inst.dueDate instanceof Date) || Number.isNaN(inst.dueDate.getTime())) {
      throw new PaymentPlanError(
        "INVALID_PLAN",
        `installments[${idx}].dueDate must be a valid date`,
      );
    }
    const t = inst.dueDate.getTime();
    if (t < prevDue) {
      throw new PaymentPlanError(
        "INVALID_PLAN",
        "installment due dates must be in non-decreasing schedule order",
      );
    }
    prevDue = t;
    sum += inst.amountCents;
  });
  if (sum !== args.originalAmountCents) {
    throw new PaymentPlanError(
      "INVALID_PLAN",
      `installments sum to ${sum} cents but the original obligation is ${args.originalAmountCents} cents — the schedule must cover the full outstanding balance exactly`,
    );
  }
}

/** Assign stable 1-based sequence numbers to a validated proposal. */
export function buildSchedule(installments: readonly PlanInstallmentInput[]): PlanInstallment[] {
  validatePlanProposal({
    originalAmountCents: installments.reduce((s, i) => s + i.amountCents, 0),
    installments,
  });
  return installments.map((inst, idx) => ({
    seq: idx + 1,
    amountCents: inst.amountCents,
    dueDate: new Date(inst.dueDate),
    status: "scheduled" as const,
  }));
}

export interface PlanSummary {
  readonly totalCents: number;
  readonly paidCents: number;
  readonly remainingCents: number;
  readonly missedCount: number;
  readonly nextDue?: { seq: number; amountCents: number; dueDate: Date } | undefined;
  readonly complete: boolean;
}

/** Summarize a schedule from its stored installment rows (paid = verified only). */
export function summarizePlan(installments: readonly PlanInstallment[]): PlanSummary {
  let totalCents = 0;
  let paidCents = 0;
  let missedCount = 0;
  let nextDue: PlanSummary["nextDue"];
  for (const inst of installments) {
    assertIntegerCents(inst.amountCents, `installment ${inst.seq}`);
    totalCents += inst.amountCents;
    if (inst.status === "paid") {
      paidCents += inst.amountCents;
    } else {
      if (inst.status === "missed") missedCount += 1;
      if (nextDue === undefined && inst.status !== "canceled") {
        nextDue = { seq: inst.seq, amountCents: inst.amountCents, dueDate: inst.dueDate };
      }
    }
  }
  return {
    totalCents,
    paidCents,
    remainingCents: Math.max(0, totalCents - paidCents),
    missedCount,
    ...(nextDue !== undefined ? { nextDue } : {}),
    complete:
      installments.length > 0 &&
      installments.every((i) => i.status === "paid" || i.status === "canceled"),
  };
}

/**
 * Display view for one installment at `now`: a `scheduled` row past its due
 * date reads as `missed` (derived, never stored silently — the run-due tick
 * persists the transition with an event).
 */
export function installmentView(
  inst: PlanInstallment,
  now: Date,
): PlanInstallment & { overdue: boolean } {
  const overdue =
    (inst.status === "scheduled" || inst.status === "missed") &&
    now.getTime() > inst.dueDate.getTime();
  return { ...inst, overdue };
}

/** Guarded plan-state transitions (throws PaymentPlanError when illegal). */
export function transitionPlanState(from: PlanState, to: PlanState): PlanState {
  const allowed: Record<PlanState, readonly PlanState[]> = {
    offered: ["accepted", "active", "superseded"],
    accepted: ["active", "superseded"],
    active: ["completed", "defaulted", "superseded"],
    completed: [],
    defaulted: ["superseded"],
    superseded: [],
  };
  if (from === to) return from;
  if (!allowed[from].includes(to)) {
    throw new PaymentPlanError(
      "INVALID_TRANSITION",
      `payment plan cannot move from ${from} to ${to}`,
    );
  }
  return to;
}

/** Mark one installment paid against a verified payment (throws when illegal). */
export function markInstallmentPaid(
  installments: readonly PlanInstallment[],
  seq: number,
  args: { paymentId: string; paidAt?: Date | undefined },
): PlanInstallment[] {
  const idx = installments.findIndex((i) => i.seq === seq);
  if (idx === -1) {
    throw new PaymentPlanError("INVALID_PLAN", `no installment with seq ${seq}`);
  }
  const current = installments[idx];
  if (!current) throw new PaymentPlanError("INVALID_PLAN", `no installment with seq ${seq}`);
  if (current.status === "paid") {
    throw new PaymentPlanError("INVALID_TRANSITION", `installment ${seq} is already paid`);
  }
  if (current.status === "canceled") {
    throw new PaymentPlanError("INVALID_TRANSITION", `installment ${seq} was canceled`);
  }
  if (!args.paymentId || args.paymentId.trim().length === 0) {
    throw new PaymentPlanError("INVALID_PLAN", "a verified paymentId is required to mark paid");
  }
  const paidAt = args.paidAt ?? new Date();
  return installments.map((i) =>
    i.seq === seq ? { ...i, status: "paid" as const, paymentId: args.paymentId, paidAt } : { ...i },
  );
}

/** Mark one installment missed (the run-due tick persists + emits + reminds). */
export function markInstallmentMissed(
  installments: readonly PlanInstallment[],
  seq: number,
  args: { note?: string | undefined } = {},
): PlanInstallment[] {
  const idx = installments.findIndex((i) => i.seq === seq);
  if (idx === -1) {
    throw new PaymentPlanError("INVALID_PLAN", `no installment with seq ${seq}`);
  }
  const current = installments[idx];
  if (!current) throw new PaymentPlanError("INVALID_PLAN", `no installment with seq ${seq}`);
  if (current.status === "paid" || current.status === "canceled") {
    throw new PaymentPlanError(
      "INVALID_TRANSITION",
      `installment ${seq} is ${current.status} and cannot be marked missed`,
    );
  }
  if (current.status === "missed") return installments.map((i) => ({ ...i }));
  const note = args.note?.trim().slice(0, NOTE_MAX);
  return installments.map((i) =>
    i.seq === seq ? { ...i, status: "missed" as const, ...(note ? { note } : {}) } : { ...i },
  );
}

/** Cancel remaining open installments when a plan is superseded/defaulted. */
export function cancelOpenInstallments(
  installments: readonly PlanInstallment[],
): PlanInstallment[] {
  return installments.map((i) =>
    i.status === "scheduled" || i.status === "missed"
      ? { ...i, status: "canceled" as const }
      : { ...i },
  );
}

/** Stable idempotency keys for plan events (repeats are safe no-ops). */
export function planEventKey(planId: string, transition: string): string {
  return `plan:${planId}:${transition}`;
}

export function installmentEventKey(planId: string, seq: number, transition: string): string {
  return `plan:${planId}:installment:${seq}:${transition}`;
}

/**
 * Professional system-voiced reminder copy for a missed/upcoming installment.
 * No legal language, no threats — a workflow notice with the schedule facts.
 */
export function renderInstallmentReminder(args: {
  workspaceName: string;
  clientName: string;
  projectTitle: string;
  milestoneTitle: string;
  seq: number;
  ofCount: number;
  amountCents: number;
  currency: string;
  dueDate: Date;
  remainingCents: number;
}): { subject: string; body: string } {
  const amount = (args.amountCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const remaining = (args.remainingCents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const due = args.dueDate.toISOString().slice(0, 10);
  return {
    subject: `Payment plan reminder — installment ${args.seq} of ${args.ofCount} (${amount} ${args.currency.toUpperCase()})`,
    body: [
      `Hello ${args.clientName},`,
      "",
      `Automated reminder from the ${args.workspaceName} workflow: installment ${args.seq} of ${args.ofCount} of your payment plan for ${args.milestoneTitle} (${args.projectTitle}) — ${amount} ${args.currency.toUpperCase()} due ${due} — needs attention.`,
      "",
      `Remaining plan balance: ${remaining} ${args.currency.toUpperCase()}. The workflow confirms verified payments automatically, so you never need to chase a receipt.`,
      "",
      `Thank you,`,
      `${args.workspaceName} workflow`,
    ].join("\n"),
  };
}
