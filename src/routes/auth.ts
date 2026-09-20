import type { FastifyInstance } from "fastify";
import { hashPassword, verifyPassword } from "../lib/auth.js";
import { parseOrThrow } from "../lib/validate.js";
import {
  createUserWithPassword,
  issueSession,
  parseSignup,
  publicUser,
  requireAuth,
  signinSchema,
  updateAccountSchema,
  verifyCredentials,
  clearedSessionCookie,
  type RouteDeps,
} from "./requestAuth.js";

/**
 * Identity routes: signup / signin / signout / me / account settings.
 * - Signup creates user + default workspace (owner membership) so every new
 *   freelancer has a tenant root immediately; multi-workspace comes later via
 *   POST /api/v1/workspaces.
 * - Signin uses one generic "Invalid credentials" error for unknown-email and
 *   wrong-password alike (no account-enumeration oracle).
 * - Auth endpoints carry a stricter per-route rate limit than the global one.
 */

const AUTH_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

export function registerAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store = deps.store;

  app.post(
    "/api/v1/auth/signup",
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const input = parseSignup(request.body);
      const user = await createUserWithPassword(deps, {
        email: input.email,
        displayName: input.displayName,
        password: input.password,
      });
      const workspace = await store.createWorkspace(user.id, { name: input.workspaceName });
      const session = issueSession(deps, user.id);
      void reply.header("Set-Cookie", session.cookie);
      return reply.status(201).send({
        user: publicUser(user),
        workspace: {
          id: workspace.id,
          name: workspace.name,
          createdAt: workspace.createdAt.toISOString(),
        },
        token: session.token,
      });
    },
  );

  app.post(
    "/api/v1/auth/signin",
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const body = parseOrThrow(signinSchema, request.body, "Invalid credentials");
      const user = await verifyCredentials(deps, body.email, body.password);
      const updated = await store.updateUser(user.id, { lastLoginAt: new Date() });
      const session = issueSession(deps, updated.id);
      void reply.header("Set-Cookie", session.cookie);
      return reply.send({ user: publicUser(updated), token: session.token });
    },
  );

  app.post("/api/v1/auth/signout", async (request, reply) => {
    await requireAuth(request, deps);
    void reply.header("Set-Cookie", clearedSessionCookie());
    // Stateless sessions: the server holds no session row, so sign-out is
    // client discard + cookie clear. Revocation list is a follow-up.
    return reply.send({ ok: true });
  });

  app.get("/api/v1/me", async (request) => {
    const { user } = await requireAuth(request, deps);
    return { user: publicUser(user) };
  });

  app.patch("/api/v1/me", async (request) => {
    const { user } = await requireAuth(request, deps);
    const body = parseOrThrow(updateAccountSchema, request.body, "Invalid account update");
    if (body.displayName === undefined && body.newPassword === undefined) {
      const { AppError } = await import("../lib/errors.js");
      throw AppError.badRequest("Nothing to update");
    }
    let passwordHash = user.passwordHash;
    if (body.newPassword !== undefined) {
      const fresh = await store.findUserById(user.id);
      if (!fresh) {
        const { AppError } = await import("../lib/errors.js");
        throw AppError.unauthorized();
      }
      const current = body.currentPassword ?? "";
      const ok = await verifyPassword(current, fresh.passwordHash);
      if (!ok) {
        const { AppError } = await import("../lib/errors.js");
        throw AppError.unauthorized("Current password is incorrect");
      }
      passwordHash = await hashPassword(body.newPassword);
    }
    const updated = await store.updateUser(user.id, {
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.newPassword !== undefined ? { passwordHash } : {}),
    });
    return { user: publicUser(updated) };
  });
}
