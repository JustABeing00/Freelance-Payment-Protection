import { z } from "zod";
import { uuidSchema } from "./validate.js";

/**
 * Session 05 validation: milestone engine boundaries.
 * Money stays integer cents; currency is ISO-3; the "Deposit" label is
 * rejected (product thesis: frame as "Milestone 1 — …"); unknown keys are
 * stripped so callers cannot smuggle state fields.
 */

const titleSchema = z
  .string()
  .trim()
  .min(1, "required")
  .max(120)
  .refine((v) => !/deposit/i.test(v), {
    message: 'must not use the "Deposit" label — use "Milestone N — …"',
  });

export const currencySchema = z
  .string()
  .trim()
  .length(3, "must be a 3-letter ISO code")
  .regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code")
  .transform((v) => v.toUpperCase());

const centsSchema = z.number().int().min(1, "must be positive").max(999_999_999_999);

export const createMilestoneSchema = z.object({
  title: titleSchema,
  description: z.string().trim().max(2000).optional(),
  amountCents: centsSchema,
  currency: currencySchema.optional(),
  dueDate: z.coerce.date().optional(),
  orderIndex: z.number().int().min(0).max(1000).optional(),
  currentVersionId: z.string().trim().max(120).optional(),
});

export const updateMilestoneSchema = z.object({
  title: titleSchema.optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
  currentVersionId: z.string().trim().max(120).nullable().optional(),
});

export const changeAmountSchema = z.object({
  newAmountCents: centsSchema,
  reason: z.string().trim().min(8, "audit reason must be ≥ 8 chars").max(500).optional(),
});

export const MILESTONE_ACTIONS = [
  "request_funding",
  "mark_claimed",
  "confirm_funding",
  "start_work",
  "submit",
  "mark_viewed",
  "request_revision",
  "approve",
  "reject",
  "request_payout",
  "confirm_payout",
  "mark_overdue",
  "refund",
  "dispute",
  "share_preview",
  "mark_unlock_ready",
  "release",
] as const;

export const transitionSchema = z.object({
  action: z.enum(MILESTONE_ACTIONS),
  paymentId: z.string().trim().min(1).max(120).optional(),
  receivedCents: z.number().int().min(1).max(999_999_999_999).optional(),
  approvedVersionId: z.string().trim().max(120).nullable().optional(),
  currentVersionId: z.string().trim().max(120).optional(),
  note: z.string().trim().max(1000).optional(),
});

export const reorderSchema = z.object({
  order: z.array(uuidSchema).min(1).max(100),
  reason: z.string().trim().min(8).max(500).optional(),
});

export type CreateMilestoneBody = z.infer<typeof createMilestoneSchema>;
export type TransitionBody = z.infer<typeof transitionSchema>;
