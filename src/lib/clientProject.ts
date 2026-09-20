import { z } from "zod";
import { uuidSchema } from "./validate.js";

/**
 * Session 04 validation: full client + project domain.
 * Unknown keys stripped at the boundary; money stays integer cents;
 * dates are ISO strings coerced to Date; end >= start enforced on update
 * paths via superRefine in the route schemas.
 */

export const CLIENT_STATUSES = ["active", "inactive", "archived"] as const;
export const PROJECT_STATUSES = ["draft", "active", "on_hold", "completed", "cancelled"] as const;

const nameSchema = z.string().trim().min(1, "required").max(120);
const optionalText = (max: number): z.ZodOptional<z.ZodString> =>
  z.string().trim().max(max).optional();
const nullableText = (max: number): z.ZodOptional<z.ZodNullable<z.ZodString>> =>
  z.string().trim().max(max).nullable().optional();

const emailSchema = z.string().trim().email("must be a valid email").max(254);
const nullableEmail = z
  .string()
  .trim()
  .email("must be a valid email")
  .max(254)
  .nullable()
  .optional();

const countrySchema = z
  .string()
  .trim()
  .length(2, "use a 2-letter country code")
  .regex(/^[A-Za-z]{2}$/, "use a 2-letter country code")
  .transform((v) => v.toUpperCase())
  .nullable()
  .optional();
const newCountrySchema = z
  .string()
  .trim()
  .length(2, "use a 2-letter country code")
  .regex(/^[A-Za-z]{2}$/, "use a 2-letter country code")
  .transform((v) => v.toUpperCase())
  .optional();

export const currencySchema = z
  .string()
  .trim()
  .length(3, "must be a 3-letter ISO code")
  .regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code")
  .transform((v) => v.toUpperCase());

const centsSchema = z.number().int().min(1, "must be positive").max(999_999_999_999);
const dateSchema = z.coerce.date();
const nullableDate = z.coerce.date().nullable().optional();

export const createClientSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  company: optionalText(120),
  phone: optionalText(40),
  billingEmail: z.string().trim().email("must be a valid email").max(254).optional(),
  billingAddress: optionalText(500),
  timezone: optionalText(64),
  country: newCountrySchema,
  notes: optionalText(2000),
  status: z.enum(CLIENT_STATUSES).default("active"),
});

export const updateClientSchema = z.object({
  name: nameSchema.optional(),
  company: nullableText(120),
  phone: nullableText(40),
  billingEmail: nullableEmail,
  billingAddress: nullableText(500),
  timezone: nullableText(64),
  country: countrySchema,
  notes: nullableText(2000),
  status: z.enum(CLIENT_STATUSES).optional(),
});

function datesInOrder(data: {
  startDate?: Date | null | undefined;
  expectedCompletion?: Date | null | undefined;
}): boolean {
  if (data.startDate instanceof Date && data.expectedCompletion instanceof Date) {
    return data.expectedCompletion.getTime() >= data.startDate.getTime();
  }
  return true;
}

export const createProjectSchema = z
  .object({
    clientId: uuidSchema,
    title: nameSchema,
    description: optionalText(2000),
    currency: currencySchema,
    totalValueCents: centsSchema,
    startDate: dateSchema.optional(),
    expectedCompletion: dateSchema.optional(),
    paymentTerms: optionalText(1000),
    status: z.enum(PROJECT_STATUSES).default("active"),
  })
  .superRefine((data, ctx) => {
    if (!datesInOrder(data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedCompletion"],
        message: "must be on or after the start date",
      });
    }
  });

export const updateProjectSchema = z
  .object({
    clientId: uuidSchema.optional(),
    title: nameSchema.optional(),
    description: nullableText(2000),
    currency: currencySchema.optional(),
    totalValueCents: centsSchema.optional(),
    startDate: nullableDate,
    expectedCompletion: nullableDate,
    paymentTerms: nullableText(1000),
    status: z.enum(PROJECT_STATUSES).optional(),
  })
  .superRefine((data, ctx) => {
    if (!datesInOrder(data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expectedCompletion"],
        message: "must be on or after the start date",
      });
    }
  });

export const clientListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(CLIENT_STATUSES).optional(),
});

export const projectListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  clientId: uuidSchema.optional(),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
