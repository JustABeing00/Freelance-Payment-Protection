import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  TIMELINE_CATEGORIES,
  TIMELINE_DISCLAIMER,
  describeEvent,
  eventCategory,
  filterTimeline,
  isClientSafeEvent,
  summarizeTimeline,
  toClientSafePayload,
  type TimelineCategory,
} from "../domain/timeline.js";
import { assertResourceInWorkspace } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import type { ProjectEventRecord } from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Evidence timeline (Session 14).
 *
 * The `events` table is append-only (guarded by the `no_update_events`
 * trigger + idempotency uniques): ordinary users can append through
 * domain actions but can never PUT/PATCH/DELETE history. These routes are
 * read-only by design — any write-shaped request to a timeline URL gets an
 * explicit 405 (IMMUTABLE_HISTORY) instead of a silent 404, so clients
 * learn history cannot be rewritten.
 *
 * Freelancer view: full metadata (category/label/headline/detail + raw
 * payload facts) with filtering (type/category/actor/milestone/date/search)
 * and cursor pagination over chronological (oldest-first) order.
 */

const workspaceProjectParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});

const workspaceProjectEventParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  eventId: uuidSchema,
});

const timelineQuery = z.object({
  types: z.string().trim().min(1).max(2000).optional(),
  category: z.string().trim().min(1).max(2000).optional(),
  actorType: z.string().trim().min(1).max(200).optional(),
  milestoneId: uuidSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: uuidSchema.optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function serializeFreelancerEvent(
  row: ProjectEventRecord,
  milestoneTitle: string | undefined,
  chronological: readonly ProjectEventRecord[],
): Record<string, unknown> {
  const described = describeEvent({
    type: row.type,
    ...(milestoneTitle !== undefined ? { milestoneTitle } : {}),
    payload: row.payload,
  });
  const idx = chronological.findIndex((e) => e.id === row.id);
  return {
    id: row.id,
    type: row.type,
    category: described.category,
    label: described.label,
    headline: described.headline,
    detail: described.detail,
    actorType: row.actorType,
    ...(typeof row.payload.actorId === "string" ? { actorId: row.payload.actorId } : {}),
    ...(row.milestoneId !== undefined ? { milestoneId: row.milestoneId } : {}),
    ...(milestoneTitle !== undefined ? { milestoneTitle } : {}),
    occurredAt: row.occurredAt.toISOString(),
    metadata: { ...row.payload },
    immutable: true,
    ...(idx > 0 && chronological[idx - 1] ? { prevEventId: chronological[idx - 1]?.id } : {}),
    ...(idx >= 0 && idx < chronological.length - 1 && chronological[idx + 1]
      ? { nextEventId: chronological[idx + 1]?.id }
      : {}),
  };
}

function serializeClientEvent(
  row: ProjectEventRecord,
  milestoneTitle: string | undefined,
): Record<string, unknown> | null {
  if (!isClientSafeEvent(row.type)) return null;
  const described = describeEvent({
    type: row.type,
    ...(milestoneTitle !== undefined ? { milestoneTitle } : {}),
    payload: toClientSafePayload(row.payload),
  });
  return {
    id: row.id,
    type: row.type,
    category: described.category,
    label: described.label,
    headline: described.headline,
    detail: described.detail,
    actorLabel:
      row.actorType === "client" ? "You" : row.actorType === "freelancer" ? "Studio" : "System",
    ...(row.milestoneId !== undefined ? { milestoneId: row.milestoneId } : {}),
    ...(milestoneTitle !== undefined ? { milestoneTitle } : {}),
    occurredAt: row.occurredAt.toISOString(),
    metadata: toClientSafePayload(row.payload),
  };
}

export function registerTimelineRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store = deps.store;

  async function loadScoped(workspaceId: string, projectId: string, userId: string) {
    const membership = await store.findMembership(userId, workspaceId);
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(workspaceId, membership, project);
    return { membership, project };
  }

  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/timeline", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    await loadScoped(params.workspaceId, params.projectId, user.id);
    const query = parseOrThrow(timelineQuery, request.query, "Invalid timeline query");

    const milestones = await store.listMilestones(params.projectId);
    const titleById = new Map(milestones.map((m) => [m.id, m.title] as const));

    const all = await store.listProjectEvents(params.projectId, 500);
    const categories = splitList(query.category).filter((c) =>
      (TIMELINE_CATEGORIES as readonly string[]).includes(c),
    ) as TimelineCategory[];
    const filtered = filterTimeline(
      all.map((e) => ({
        id: e.id,
        type: e.type,
        actorType: e.actorType,
        ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
        occurredAt: e.occurredAt,
        payload: e.payload,
      })),
      {
        ...(splitList(query.types).length > 0 ? { types: splitList(query.types) } : {}),
        ...(categories.length > 0 ? { categories } : {}),
        ...(splitList(query.actorType).length > 0
          ? { actorTypes: splitList(query.actorType) }
          : {}),
        ...(query.milestoneId !== undefined ? { milestoneId: query.milestoneId } : {}),
        ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
      },
    );
    const byId = new Map(all.map((e) => [e.id, e] as const));
    const chronological = filtered
      .map((f) => byId.get(f.id))
      .filter((e): e is ProjectEventRecord => e !== undefined);

    const order = query.order ?? "asc";
    const ordered = order === "desc" ? [...chronological].reverse() : chronological;
    const limit = query.limit ?? 50;
    let start = 0;
    if (query.cursor) {
      const at = ordered.findIndex((e) => e.id === query.cursor);
      if (at >= 0) start = at + 1;
    }
    const page = ordered.slice(start, start + limit);
    const hasMore = start + page.length < ordered.length;
    const anchor = [...chronological].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );

    return {
      projectId: params.projectId,
      events: page.map((e) =>
        serializeFreelancerEvent(
          e,
          e.milestoneId ? titleById.get(e.milestoneId) : undefined,
          anchor,
        ),
      ),
      pagination: {
        limit,
        order,
        returned: page.length,
        hasMore,
        ...(hasMore && page[page.length - 1] ? { nextCursor: page[page.length - 1]?.id } : {}),
      },
      filters: {
        ...(splitList(query.types).length > 0 ? { types: splitList(query.types) } : {}),
        ...(categories.length > 0 ? { categories } : {}),
        ...(splitList(query.actorType).length > 0
          ? { actorTypes: splitList(query.actorType) }
          : {}),
        ...(query.milestoneId !== undefined ? { milestoneId: query.milestoneId } : {}),
        ...(query.from !== undefined ? { from: query.from } : {}),
        ...(query.to !== undefined ? { to: query.to } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
        order,
      },
      summary: summarizeTimeline(chronological),
      categories: [...TIMELINE_CATEGORIES],
      immutable: true,
      disclaimer: TIMELINE_DISCLAIMER,
    };
  });

  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/timeline/:eventId",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectEventParam, request.params, "Invalid ids");
      await loadScoped(params.workspaceId, params.projectId, user.id);
      const row = await store.findProjectEventById(params.eventId);
      if (row?.projectId !== params.projectId || row.workspaceId !== params.workspaceId) {
        throw AppError.notFound("Event not found");
      }
      const milestones = await store.listMilestones(params.projectId);
      const titleById = new Map(milestones.map((m) => [m.id, m.title] as const));
      const all = await store.listProjectEvents(params.projectId, 500);
      const anchor = [...all].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
      return {
        event: serializeFreelancerEvent(
          row,
          row.milestoneId !== undefined ? titleById.get(row.milestoneId) : undefined,
          anchor,
        ),
        eventCategory: eventCategory(row.type),
        immutable: true,
        disclaimer: TIMELINE_DISCLAIMER,
      };
    },
  );

  // Immutability guards: no write-shaped method ever mutates history.
  // Explicit 405 (not a silent 404) so clients learn history is append-only.
  for (const method of ["post", "put", "patch", "delete"] as const) {
    app[method](
      "/api/v1/workspaces/:workspaceId/projects/:projectId/timeline",
      async (_request, reply) => {
        return reply.status(405).send({
          error: {
            code: "IMMUTABLE_HISTORY",
            message:
              "Project history is immutable — events are append-only and cannot be edited or deleted. Record a new event instead.",
            requestId: _request.id,
          },
        });
      },
    );
    app[method](
      "/api/v1/workspaces/:workspaceId/projects/:projectId/timeline/:eventId",
      async (_request, reply) => {
        return reply.status(405).send({
          error: {
            code: "IMMUTABLE_HISTORY",
            message:
              "Project history is immutable — events are append-only and cannot be edited or deleted. Record a new event instead.",
            requestId: _request.id,
          },
        });
      },
    );
  }
}

export function registerPortalTimelineRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store = deps.store;

  async function loadPortal(projectId: string, token: unknown) {
    const { verifyMagicLink, hashToken } = await import("../lib/magicLink.js");
    if (typeof token !== "string" || token.length === 0) {
      throw AppError.unauthorized("This link is invalid or has expired");
    }
    try {
      verifyMagicLink({ token, expectedProjectId: projectId, sessionSecret: deps.sessionSecret });
    } catch {
      throw AppError.unauthorized("This link is invalid or has expired");
    }
    const link = await store.findPortalLinkByTokenHash(hashToken(token));
    if (link?.projectId !== projectId) {
      throw AppError.unauthorized("This link is invalid or has expired");
    }
    if (link.revokedAt || link.expiresAt.getTime() <= Date.now()) {
      throw AppError.unauthorized("This link is invalid or has expired");
    }
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    // Defense in depth (matches every other portal authorizer): a link whose
    // workspace drifted from its project's workspace authorizes nothing.
    if (link.workspaceId !== project.workspaceId) {
      throw AppError.unauthorized("This link is invalid or has expired");
    }
    return { project };
  }

  const portalQuery = z.object({
    category: z.string().trim().min(1).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    token: z.string().min(1),
  });

  app.get("/api/v1/portal/:projectId/timeline", async (request) => {
    const params = parseOrThrow(
      z.object({ projectId: uuidSchema }),
      request.params,
      "Invalid project id",
    );
    const query = parseOrThrow(portalQuery, request.query, "Invalid timeline query");
    await loadPortal(params.projectId, query.token);
    const milestones = await store.listMilestones(params.projectId);
    const titleById = new Map(milestones.map((m) => [m.id, m.title] as const));
    const all = await store.listProjectEvents(params.projectId, 500);
    const categories = splitList(query.category).filter((c) =>
      (TIMELINE_CATEGORIES as readonly string[]).includes(c),
    ) as TimelineCategory[];
    const filtered = filterTimeline(
      all.map((e) => ({
        id: e.id,
        type: e.type,
        actorType: e.actorType,
        ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
        occurredAt: e.occurredAt,
        payload: e.payload,
      })),
      { ...(categories.length > 0 ? { categories } : {}) },
    ).filter((e) => isClientSafeEvent(e.type));
    const byId = new Map(all.map((e) => [e.id, e] as const));
    const ordered = filtered
      .map((f) => byId.get(f.id))
      .filter((e): e is ProjectEventRecord => e !== undefined)
      .slice(0, query.limit ?? 50);
    return {
      projectId: params.projectId,
      events: ordered
        .map((e) =>
          serializeClientEvent(e, e.milestoneId ? titleById.get(e.milestoneId) : undefined),
        )
        .filter((e) => e !== null),
      immutable: true,
      disclaimer: TIMELINE_DISCLAIMER,
    };
  });

  app.get("/api/v1/portal/:projectId/timeline/:eventId", async (request) => {
    const params = parseOrThrow(
      z.object({ projectId: uuidSchema, eventId: uuidSchema }),
      request.params,
      "Invalid ids",
    );
    const query = parseOrThrow(
      z.object({ token: z.string().min(1) }),
      request.query,
      "Invalid query",
    );
    await loadPortal(params.projectId, query.token);
    const row = await store.findProjectEventById(params.eventId);
    if (row?.projectId !== params.projectId) throw AppError.notFound("Event not found");
    const milestones = await store.listMilestones(params.projectId);
    const titleById = new Map(milestones.map((m) => [m.id, m.title] as const));
    const view = serializeClientEvent(
      row,
      row.milestoneId !== undefined ? titleById.get(row.milestoneId) : undefined,
    );
    if (!view) throw AppError.notFound("Event not found");
    return { event: view, immutable: true, disclaimer: TIMELINE_DISCLAIMER };
  });
}
