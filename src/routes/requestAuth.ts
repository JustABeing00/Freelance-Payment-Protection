import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { hashPassword, verifyPassword } from "../lib/auth.js";
import { normalizeEmail } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import {
  buildClearedSessionCookie,
  buildSessionCookie,
  createSessionToken,
  extractSessionToken,
  verifySessionToken,
} from "../lib/session.js";
import type { Store, UserRecord } from "../lib/store.js";
import { parseOrThrow } from "../lib/validate.js";

/**
 * Shared request dependencies + authentication helper.
 * Every protected handler calls requireAuth() first: no handler trusts a
 * client-supplied user id — identity always comes from the verified session.
 */
export interface RouteDeps {
  readonly store: Store;
  readonly sessionSecret: string;
  readonly isProduction: boolean;
  /** Payment provider seam (Stripe when keyed, fake/noop otherwise). */
  readonly paymentProvider?: import("../lib/providers.js").PaymentProvider | undefined;
  /** Verified-webhook secret (Stripe-style t,v1 HMAC). Fail-closed when unset. */
  readonly webhookSecret?: string | undefined;
  /** Object storage seam (signed URLs for previews/finals). */
  readonly storageProvider?: import("../lib/providers.js").StorageProvider | undefined;
  /** Email seam (reminder delivery; fake in tests, noop otherwise). */
  readonly emailProvider?: import("../lib/providers.js").EmailProvider | undefined;
}

export interface AuthContext {
  readonly user: UserRecord;
}

const BERARER_HEADERS = ["authorization", "cookie"] as const;

export async function requireAuth(request: FastifyRequest, deps: RouteDeps): Promise<AuthContext> {
  const headers: Record<string, unknown> = {};
  for (const name of BERARER_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const token = extractSessionToken(headers);
  if (!token) throw AppError.unauthorized();
  let userId: string;
  try {
    userId = verifySessionToken({ token, sessionSecret: deps.sessionSecret }).userId;
  } catch {
    throw AppError.unauthorized();
  }
  const user = await deps.store.findUserById(userId);
  if (!user) throw AppError.unauthorized();
  return { user };
}

export function publicUser(user: UserRecord): {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
  lastLoginAt?: string;
} {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt.toISOString() } : {}),
  };
}

export const signupSchema = z.object({
  email: z.string().email("must be a valid email").max(254),
  displayName: z.string().trim().min(1, "required").max(80),
  password: z.string().min(12, "must be at least 12 characters").max(256),
  workspaceName: z.string().trim().min(1).max(80).optional(),
});

export const signinSchema = z.object({
  email: z.string().email("must be a valid email").max(254),
  password: z.string().min(1, "required").max(256),
});

export const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    currentPassword: z.string().min(1).max(256).optional(),
    newPassword: z.string().min(12, "must be at least 12 characters").max(256).optional(),
  })
  .refine((v) => (v.newPassword === undefined ? true : v.currentPassword !== undefined), {
    message: "currentPassword is required to set a new password",
    path: ["currentPassword"],
  });

export function issueSession(deps: RouteDeps, userId: string): { token: string; cookie: string } {
  const { token } = createSessionToken({ userId, sessionSecret: deps.sessionSecret });
  return { token, cookie: buildSessionCookie(token, deps.isProduction) };
}

/** Normalize + validate a signup body; throws UNPROCESSABLE on bad input. */
export function parseSignup(body: unknown): {
  email: string;
  displayName: string;
  password: string;
  workspaceName: string;
} {
  const parsed = parseOrThrow(signupSchema, body, "Invalid signup");
  return {
    email: normalizeEmail(parsed.email),
    displayName: parsed.displayName,
    password: parsed.password,
    workspaceName:
      parsed.workspaceName && parsed.workspaceName.length > 0
        ? parsed.workspaceName
        : `${parsed.displayName}'s Studio`,
  };
}

export async function createUserWithPassword(
  deps: RouteDeps,
  args: { email: string; displayName: string; password: string },
): Promise<UserRecord> {
  const passwordHash = await hashPassword(args.password);
  return deps.store.createUser({
    email: args.email,
    displayName: args.displayName,
    passwordHash,
  });
}

export async function verifyCredentials(
  deps: RouteDeps,
  email: string,
  password: string,
): Promise<UserRecord> {
  const user = await deps.store.findUserByEmail(normalizeEmail(email));
  // Identical generic error for unknown-email vs wrong-password (no oracle).
  if (!user) throw AppError.unauthorized("Invalid credentials");
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw AppError.unauthorized("Invalid credentials");
  return user;
}

export function clearedSessionCookie(): string {
  return buildClearedSessionCookie();
}
