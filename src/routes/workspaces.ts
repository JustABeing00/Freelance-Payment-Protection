import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireMembership, requireOwner } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import type { Store } from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Workspace + membership routes.
 * Every handler: requireAuth → requireMembership → role check. Workspace ids
 * in the URL are never trusted on their own — membership is the gate, and
 * unknown/forbidden workspaces collapse to generic 403 (no enumeration).
 */

const workspaceIdParam = z.object({ workspaceId: uuidSchema });

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "required").max(80),
});

const addMemberSchema = z.object({
  email: z.string().email("must be a valid email").max(254),
  role: z.enum(["owner", "member", "accountant_readonly"]),
});

export function registerWorkspaceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  app.post("/api/v1/workspaces", async (request, reply) => {
    const { user } = await requireAuth(request, deps);
    const body = parseOrThrow(createWorkspaceSchema, request.body, "Invalid workspace");
    const workspace = await store.createWorkspace(user.id, { name: body.name });
    return reply.status(201).send({
      workspace: {
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt.toISOString(),
      },
      role: "owner",
    });
  });

  app.get("/api/v1/workspaces", async (request) => {
    const { user } = await requireAuth(request, deps);
    const workspaces = await store.listWorkspacesForUser(user.id);
    const out = [];
    for (const ws of workspaces) {
      const membership = await store.findMembership(user.id, ws.id);
      out.push({
        id: ws.id,
        name: ws.name,
        createdAt: ws.createdAt.toISOString(),
        role: membership?.role ?? "member",
      });
    }
    return { workspaces: out };
  });

  app.get("/api/v1/workspaces/:workspaceId", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceIdParam, request.params, "Invalid workspace id");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    const workspace = await store.findWorkspace(params.workspaceId);
    if (!workspace) throw AppError.forbidden();
    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt.toISOString(),
      },
      role: membership.role,
    };
  });

  app.get("/api/v1/workspaces/:workspaceId/members", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceIdParam, request.params, "Invalid workspace id");
    requireMembership(await store.findMembership(user.id, params.workspaceId));
    const members = await store.listMembers(params.workspaceId);
    const out = [];
    for (const m of members) {
      const memberUser = await store.findUserById(m.userId);
      out.push({
        userId: m.userId,
        email: memberUser?.email ?? "",
        displayName: memberUser?.displayName ?? "",
        role: m.role,
        createdAt: m.createdAt.toISOString(),
      });
    }
    return { members: out };
  });

  app.post("/api/v1/workspaces/:workspaceId/members", async (request, reply) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceIdParam, request.params, "Invalid workspace id");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    // Owner-only: assistants/members cannot self-promote or invite.
    requireOwner(membership);
    const body = parseOrThrow(addMemberSchema, request.body, "Invalid member");
    const invited = await store.findUserByEmail(body.email);
    // Checked only after authorization passes, so email-existence is not an oracle.
    if (!invited) throw AppError.notFound("User not found");
    const created = await store.addMember(params.workspaceId, invited.id, body.role);
    return reply.status(201).send({
      member: {
        userId: created.userId,
        email: invited.email,
        displayName: invited.displayName,
        role: created.role,
      },
    });
  });
}
