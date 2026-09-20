import type { Cents } from "./types.js";

/**
 * Money integrity (domain-model §5):
 * - integer minor units only, no floats
 * - milestone paid ⟺ sum(received) >= amount
 * - outstanding = milestones total − received (plans don't reduce until paid)
 * - overdue ⟺ now > due+grace AND outstanding > 0
 */

export function assertIntegerCents(amount: number): asserts amount is Cents {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`amount_cents must be a non-negative integer, got: ${amount}`);
  }
}

export interface ReceivedPayment {
  readonly milestoneId?: string;
  readonly amountCents: number;
  /** Only "received"/"partial" count toward satisfaction. */
  readonly state: string;
  readonly reversesId?: string | null;
}

function countsTowardPayment(p: ReceivedPayment): boolean {
  // Verified provider money only. `paid` is the Session-08 canonical verified
  // state; `received`/`partial` are legacy aliases kept for older rows.
  return p.state === "received" || p.state === "partial" || p.state === "paid";
}

export function sumReceivedForMilestone(
  payments: readonly ReceivedPayment[],
  milestoneId: string,
): number {
  let sum = 0;
  for (const p of payments) {
    if (p.milestoneId === milestoneId && countsTowardPayment(p)) {
      if (!Number.isInteger(p.amountCents) || p.amountCents < 0) {
        throw new Error("payment amount_cents must be a non-negative integer");
      }
      sum += p.amountCents;
    }
  }
  return sum;
}

export function isMilestonePaid(
  milestoneAmountCents: number,
  payments: readonly ReceivedPayment[],
  milestoneId: string,
): boolean {
  assertIntegerCents(milestoneAmountCents);
  return sumReceivedForMilestone(payments, milestoneId) >= milestoneAmountCents;
}

export function projectOutstandingCents(
  milestoneAmountsCents: readonly number[],
  payments: readonly ReceivedPayment[],
): number {
  let total = 0;
  for (const a of milestoneAmountsCents) {
    assertIntegerCents(a);
    total += a;
  }
  let received = 0;
  for (const p of payments) {
    if (countsTowardPayment(p)) {
      assertIntegerCents(p.amountCents);
      received += p.amountCents;
    }
  }
  return Math.max(0, total - received);
}

export function isOverdue(args: {
  nowUtc: Date;
  dueDate: Date;
  graceDays: number;
  outstandingCents: number;
}): boolean {
  const { nowUtc, dueDate, graceDays, outstandingCents } = args;
  if (outstandingCents <= 0) return false;
  const graceMs = Math.max(0, graceDays) * 24 * 60 * 60 * 1000;
  return nowUtc.getTime() > dueDate.getTime() + graceMs;
}

/** Display-only formatting. Never use floats for storage/math. */
export function formatMinorUnits(amountCents: number, currency = "USD"): string {
  assertIntegerCents(amountCents);
  const major = amountCents / 100;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(major);
  } catch {
    return `${currency} ${(amountCents / 100).toFixed(2)}`;
  }
}
