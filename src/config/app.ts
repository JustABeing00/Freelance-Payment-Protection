import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { type Env, getEnv } from "./env.js";
import { registerErrorHandler } from "../lib/errors.js";
import { redactPaths } from "../lib/logger.js";
import {
  resolveEmailProvider,
  resolvePaymentProvider,
  resolveStorageProvider,
  type PaymentProvider,
} from "../lib/providers.js";
import { InMemoryStore, PrismaStore, type Store } from "../lib/store.js";
import { registerAgreementRoutes } from "../routes/agreements.js";
import { registerAiAssistRoutes } from "../routes/aiAssist.js";
import { registerApprovalRoutes } from "../routes/approvals.js";
import { registerAuthRoutes } from "../routes/auth.js";
import { registerDeliverableRoutes } from "../routes/deliverables.js";
import { registerEvidencePackRoutes } from "../routes/evidencePacks.js";
import { registerHealthRoutes } from "../routes/health.js";
import { registerMilestoneRoutes } from "../routes/milestones.js";
import { registerNotificationRoutes } from "../routes/notifications.js";
import { registerPageRoutes } from "../routes/pages.js";
import { registerPaymentRoutes } from "../routes/payments.js";
import { registerPaymentPlanRoutes } from "../routes/paymentPlans.js";
import { registerPortalRoutes } from "../routes/portal.js";
import { registerProtectionRoutes } from "../routes/protection.js";
import { registerReminderRoutes } from "../routes/reminders.js";
import { registerTenantResourceRoutes } from "../routes/resources.js";
import { registerSiteRoutes } from "../routes/site.js";
import { registerTimelineRoutes, registerPortalTimelineRoutes } from "../routes/timeline.js";
import { registerWorkspaceRoutes } from "../routes/workspaces.js";
import type { RouteDeps } from "../routes/requestAuth.js";

export interface BuildAppOptions {
  env?: Env;
  loggerLevel?: string;
  /**
   * Persistence seam. Production defaults to PrismaStore (Postgres);
   * tests inject InMemoryStore (or a shared instance) so the suite runs
   * without Docker. Pass `store: "memory"` for a fresh in-memory store.
   */
  store?: Store | "memory" | "prisma";
  /** Payment provider seam (defaults from env: Stripe when keyed). */
  paymentProvider?: PaymentProvider;
  /** Object storage seam (defaults: fake in test, noop otherwise). */
  storageProvider?: import("../lib/providers.js").StorageProvider;
  /** Email seam (defaults: fake in test, noop otherwise). */
  emailProvider?: import("../lib/providers.js").EmailProvider;
  /** Webhook HMAC secret override (defaults to env STRIPE_WEBHOOK_SECRET). */
  webhookSecret?: string;
}

function resolveStore(option: BuildAppOptions["store"]): Store {
  if (option === undefined || option === "prisma") return new PrismaStore();
  if (option === "memory") return new InMemoryStore();
  return option;
}

/**
 * Core application configuration: security headers (CSP, HSTS, no-sniff),
 * global rate limiting, typed error envelope, request logging, plus the
 * identity/tenant API (auth, workspaces, members, clients, projects).
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = options.env ?? getEnv();
  const app = Fastify({
    logger: {
      level: options.loggerLevel ?? env.LOG_LEVEL,
      redact: { paths: [...redactPaths], censor: "[REDACTED]" },
    },
    requestIdHeader: "x-request-id",
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: env.NODE_ENV === "production" ? { maxAge: 31536000, includeSubDomains: true } : false,
  });

  await app.register(rateLimit, {
    global: true,
    max: env.NODE_ENV === "test" ? 1000 : 120,
    timeWindow: "1 minute",
    errorResponseBuilder: (_req, context) => ({
      error: {
        code: "RATE_LIMITED",
        message: `Rate limit exceeded; retry in ${context.after}`,
        requestId: "",
      },
    }),
  });

  registerErrorHandler(app);
  registerHealthRoutes(app);

  // Preserve the exact raw bytes for webhook signature verification while
  // still parsing JSON for every other route. Fastify inject tests that send
  // a string payload keep byte-identical bodies, so HMAC checks stay exact.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody?: string }).rawBody = typeof body === "string" ? body : "";
    try {
      done(null, body === "" ? {} : JSON.parse(body as string));
    } catch (err: unknown) {
      done(err as Error, undefined);
    }
  });

  const store = resolveStore(options.store);
  const paymentProvider =
    options.paymentProvider ??
    resolvePaymentProvider({
      STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
      NODE_ENV: env.NODE_ENV,
    });
  const deps: RouteDeps = {
    store,
    sessionSecret: env.SESSION_SECRET,
    isProduction: env.NODE_ENV === "production",
    paymentProvider,
    storageProvider: options.storageProvider ?? resolveStorageProvider({ NODE_ENV: env.NODE_ENV }),
    emailProvider: options.emailProvider ?? resolveEmailProvider({ NODE_ENV: env.NODE_ENV }),
    ...((options.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET)
      ? { webhookSecret: options.webhookSecret ?? env.STRIPE_WEBHOOK_SECRET }
      : {}),
  };
  registerAuthRoutes(app, deps);
  registerApprovalRoutes(app, deps);
  registerWorkspaceRoutes(app, deps);
  registerTenantResourceRoutes(app, deps);
  registerMilestoneRoutes(app, deps);
  registerAgreementRoutes(app, deps);
  registerAiAssistRoutes(app, deps);
  registerPortalRoutes(app, deps);
  registerPaymentRoutes(app, deps);
  registerPaymentPlanRoutes(app, deps);
  registerDeliverableRoutes(app, deps);
  registerEvidencePackRoutes(app, deps);
  registerReminderRoutes(app, deps);
  registerNotificationRoutes(app, deps);
  registerProtectionRoutes(app, deps);
  registerTimelineRoutes(app, deps);
  registerPortalTimelineRoutes(app, deps);
  registerPageRoutes(app, deps);
  registerSiteRoutes(app, deps);

  return app;
}
