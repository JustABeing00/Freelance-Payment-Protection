import { z } from "zod";
import { AppError } from "./errors.js";

/**
 * Validation strategy: zod schemas at every trust boundary
 * (env, HTTP handlers, webhook payloads, domain constructors).
 * Unknown keys are stripped so callers cannot smuggle fields.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, message = "Invalid input"): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw AppError.unprocessable(message, result.error.flatten());
  }
  return result.data;
}

export const uuidSchema = z.string().uuid("must be a UUID (no sequential IDs in URLs)");

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: uuidSchema.optional(),
});

export type Pagination = z.infer<typeof paginationSchema>;
