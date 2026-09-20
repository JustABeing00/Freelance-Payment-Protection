import type { TrustTier } from "./types.js";

/**
 * Trust ladder (PRD §8): low → standard → high, explicit + change-logged.
 * Downgrade on missed payment. Never force "50% deposit or nothing".
 */
export const TRUST_DEFAULTS: Record<
  TrustTier,
  {
    releaseGate: "current_milestone_paid" | "manual_release";
    pauseAfterOverdueDays: number;
    label: string;
  }
> = {
  low: {
    releaseGate: "current_milestone_paid",
    pauseAfterOverdueDays: 3,
    label: "New client: small Milestone 1, preview-only until paid.",
  },
  standard: {
    releaseGate: "current_milestone_paid",
    pauseAfterOverdueDays: 7,
    label: "Standard: preview → approval → payment → release.",
  },
  high: {
    releaseGate: "manual_release",
    pauseAfterOverdueDays: 30,
    label: "Recurring: Net terms option, relaxed release with grace.",
  },
};

export function defaultTierForNewClient(): TrustTier {
  return "low";
}

export function nextTierAfterOnTimePayments(paidMilestones: number): TrustTier | null {
  if (paidMilestones >= 4) return "high";
  if (paidMilestones >= 1) return "standard";
  return null;
}

export function shouldDowngradeOnMissedPayment(missedPayments: number): boolean {
  return missedPayments >= 1;
}
