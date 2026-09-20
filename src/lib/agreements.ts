import { z } from "zod";

/**
 * Session 06 validation: agreement / payment-terms boundaries.
 * Unknown keys are stripped so callers cannot smuggle lifecycle fields
 * (`status`, `hash`, `acceptedAt` …) — those are set server-side from the
 * domain transitions only.
 */

export const currencySchema = z
  .string()
  .trim()
  .length(3, "must be a 3-letter ISO code")
  .regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code")
  .transform((v) => v.toUpperCase());

const centsSchema = z.number().int().min(1, "must be positive").max(999_999_999_999);
const nonNegativeCents = z.number().int().min(0, "must be ≥ 0").max(999_999_999_999);

const scheduleEntrySchema = z.object({
  title: z.string().trim().min(1, "required").max(120),
  amountCents: centsSchema,
  dueLabel: z.string().trim().max(120).optional(),
});

export const createAgreementSchema = z.object({
  totalAmountCents: centsSchema,
  currency: currencySchema,
  depositAmountCents: nonNegativeCents,
  milestoneSchedule: z.array(scheduleEntrySchema).min(1).max(50),
  paymentDueDays: z.number().int().min(0).max(90),
  graceDays: z.number().int().min(0).max(30).default(3),
  acceptedPaymentMethods: z
    .array(z.enum(["bank_transfer", "card", "paypal", "stripe", "wise", "cash", "check", "other"]))
    .min(1)
    .max(8),
  latePaymentPolicy: z.object({
    kind: z.enum(["none", "flat_fee", "percentage_per_month", "custom"]),
    description: z.string().trim().min(1, "required").max(1000),
    feeCents: centsSchema.optional(),
    percentBps: z.number().int().min(1).max(10000).optional(),
  }),
  pauseAfterOverdueDays: z.number().int().min(0).max(90),
  workPauseDescription: z.string().trim().min(1, "required").max(1000),
  releaseCondition: z
    .enum(["current_milestone_paid", "all_milestones_paid", "manual_release"])
    .default("current_milestone_paid"),
  finalDeliveryDescription: z.string().trim().min(1, "required").max(1000),
  ownershipMode: z.enum([
    "on_final_payment",
    "on_each_milestone_payment",
    "on_project_completion",
    "custom",
  ]),
  ownershipDescription: z.string().trim().min(1, "required").max(1000),
  maxRevisionsPerMilestone: z.number().int().min(0).max(20),
  extraRevisionPolicy: z.string().trim().min(1, "required").max(1000),
  cancellationNoticeDays: z.number().int().min(0).max(90),
  cancellationKillFeeCents: nonNegativeCents.optional(),
  cancellationPolicy: z.string().trim().min(1, "required").max(2000),
  customClauses: z.string().trim().max(5000).optional(),
});

export const acceptAgreementSchema = z.object({
  acceptedBy: z.string().trim().min(2, "name who accepted is required").max(200),
  acceptanceNote: z.string().trim().max(1000).optional(),
});

export type CreateAgreementBody = z.infer<typeof createAgreementSchema>;
export type AcceptAgreementBody = z.infer<typeof acceptAgreementSchema>;
