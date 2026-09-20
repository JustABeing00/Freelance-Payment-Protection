import { z } from "zod";

/**
 * Fail-closed environment configuration.
 *
 * Required vars cause boot to throw with an explicit message instead of
 * running with insecure/undefined defaults. No secrets are logged.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required (Postgres connection string)"),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters (generate with: openssl rand -hex 32)"),
  APP_BASE_URL: z.string().url("APP_BASE_URL must be a valid URL (e.g. http://localhost:3000)"),

  MAGIC_LINK_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  STORAGE_ENDPOINT: z.string().optional(),
  STORAGE_BUCKET: z.string().optional(),
  STORAGE_ACCESS_KEY: z.string().optional(),
  STORAGE_SECRET_KEY: z.string().optional(),

  EMAIL_PROVIDER: z.string().optional(),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

function readDotEnvFile(): Record<string, string> {
  // Minimal .env loader (no dependency): KEY=VALUE lines, ignores comments/blank.
  // Real env vars always win over file values.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("node:path") as typeof import("node:path");
    const file = path.join(process.cwd(), ".env");
    if (!fs.existsSync(file)) return {};
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const fileVars = source === process.env ? readDotEnvFile() : {};
  const merged: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries({ ...fileVars, ...source })) {
    if (typeof v === "string") merged[k] = v;
  }
  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration (fail-closed): ${details}`);
  }
  return parsed.data;
}

/** Cached accessor for app boot. Call resetEnvCache() in tests. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}

export function requireStripeWebhookSecret(env: Env): string {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new Error(
      "STRIPE_WEBHOOK_SECRET is not configured; webhook verification cannot run (fail-closed).",
    );
  }
  return env.STRIPE_WEBHOOK_SECRET;
}
