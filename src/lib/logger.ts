import pino from "pino";

/**
 * Central logging strategy:
 * - pino JSON logs (Fastify-native).
 * - redact() prevents secret leakage.
 * - Use child loggers with workspaceId/projectId for correlation.
 */
export const redactPaths = [
  "password",
  "password_hash",
  "authorization",
  "cookie",
  "token",
  "magicLinkToken",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SESSION_SECRET",
  "DATABASE_URL",
  "EMAIL_API_KEY",
  "STORAGE_SECRET_KEY",
  "*.password",
  "*.token",
  "req.headers.authorization",
  "req.headers.cookie",
] as const;

export function createLogger(level = "info"): pino.Logger {
  return pino({
    level,
    redact: { paths: [...redactPaths], censor: "[REDACTED]" },
    base: { service: "freelance-payment-protection" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger = createLogger(process.env.LOG_LEVEL ?? "info");

export function scopedLogger(bindings: Record<string, string>): pino.Logger {
  return logger.child(bindings);
}
