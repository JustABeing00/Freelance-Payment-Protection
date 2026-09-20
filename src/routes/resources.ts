import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildProjectSummary } from "../domain/projectView.js";
import { assertResourceInWorkspace, requireMembership, requireWriteAccess } from "../lib/authz.js";
import {
  clientListQuerySchema,
  createClientSchema,
  createProjectSchema,
  projectListQuerySchema,
  updateClientSchema,
  updateProjectSchema,
} from "../lib/clientProject.js";
import { AppError } from "../lib/errors.js";
import type {
  ClientRecord,
  ProjectRecord,
  Store,
  UpdateClientInput,
  UpdateProjectInput,
} from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { notifyLifecycle } from "./notifications.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Tenant resources: full client + project domain (Session 04).
 * Server-side ownership enforcement on every handler:
 *  1. requireAuth (who are you)
 *  2. requireMembership on the URL workspace (are you in this workspace)
 *  3. role gate for writes (accountant_readonly is read-only)
 *  4. assertResourceInWorkspace for single-row reads/writes (IDOR guard)
 * Projects additionally verify client.workspaceId === URL workspace.
 *
 * Payments are NOT implemented here: the summary counts only verified
 * `received`/`partial` rows toward amount paid; claims stay unverified.
 */

const workspaceParam = z.object({ workspaceId: uuidSchema });
const workspaceClientParam = z.object({ workspaceId: uuidSchema, clientId: uuidSchema });
const workspaceProjectParam = z.object({ workspaceId: uuidSchema, projectId: uuidSchema });

function serializeClient(row: ClientRecord): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    email: row.email,
    ...(row.company !== undefined ? { company: row.company } : {}),
    ...(row.phone !== undefined ? { phone: row.phone } : {}),
    ...(row.billingEmail !== undefined ? { billingEmail: row.billingEmail } : {}),
    ...(row.billingAddress !== undefined ? { billingAddress: row.billingAddress } : {}),
    ...(row.timezone !== undefined ? { timezone: row.timezone } : {}),
    ...(row.country !== undefined ? { country: row.country } : {}),
    ...(row.notes !== undefined ? { notes: row.notes } : {}),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeProject(row: ProjectRecord): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    clientId: row.clientId,
    title: row.title,
    ...(row.description !== undefined ? { description: row.description } : {}),
    currency: row.currency,
    totalValueCents: row.totalValueCents,
    ...(row.startDate ? { startDate: row.startDate.toISOString() } : {}),
    ...(row.expectedCompletion ? { expectedCompletion: row.expectedCompletion.toISOString() } : {}),
    ...(row.paymentTerms !== undefined ? { paymentTerms: row.paymentTerms } : {}),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function matchesClient(
  row: ClientRecord,
  query: { search?: string | undefined; status?: string | undefined },
): boolean {
  if (query.status && row.status !== query.status) return false;
  if (query.search) {
    const hay = `${row.name} ${row.email} ${row.company ?? ""}`.toLowerCase();
    if (!hay.includes(query.search.toLowerCase())) return false;
  }
  return true;
}

function matchesProject(
  row: ProjectRecord,
  query: {
    search?: string | undefined;
    status?: string | undefined;
    clientId?: string | undefined;
  },
): boolean {
  if (query.status && row.status !== query.status) return false;
  if (query.clientId && row.clientId !== query.clientId) return false;
  if (query.search) {
    const hay = `${row.title} ${row.description ?? ""}`.toLowerCase();
    if (!hay.includes(query.search.toLowerCase())) return false;
  }
  return true;
}

export function registerTenantResourceRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  // ---- Clients ----
  app.post("/api/v1/workspaces/:workspaceId/clients", async (request, reply) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid workspace id");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    requireWriteAccess(membership);
    const body = parseOrThrow(createClientSchema, request.body, "Invalid client");
    const client = await store.createClient(params.workspaceId, {
      name: body.name,
      email: body.email,
      ...(body.company !== undefined ? { company: body.company } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.billingEmail !== undefined ? { billingEmail: body.billingEmail } : {}),
      ...(body.billingAddress !== undefined ? { billingAddress: body.billingAddress } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.country !== undefined ? { country: body.country } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      status: body.status,
    });
    return reply.status(201).send({ client: serializeClient(client) });
  });

  app.get("/api/v1/workspaces/:workspaceId/clients", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid workspace id");
    requireMembership(await store.findMembership(user.id, params.workspaceId));
    const query = parseOrThrow(clientListQuerySchema, request.query, "Invalid query");
    const clients = (await store.listClients(params.workspaceId)).filter((c) =>
      matchesClient(c, query),
    );
    return { clients: clients.map(serializeClient) };
  });

  app.get("/api/v1/workspaces/:workspaceId/clients/:clientId", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceClientParam, request.params, "Invalid client id");
    const membership = await store.findMembership(user.id, params.workspaceId);
    const client = await store.findClient(params.clientId);
    if (!client) throw AppError.notFound("Client not found");
    assertResourceInWorkspace(params.workspaceId, membership, client);
    const projects = (await store.listProjects(params.workspaceId)).filter(
      (p) => p.clientId === client.id,
    );
    return {
      client: serializeClient(client),
      projects: projects.map(serializeProject),
      projectCount: projects.length,
    };
  });

  app.patch("/api/v1/workspaces/:workspaceId/clients/:clientId", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceClientParam, request.params, "Invalid client id");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    requireWriteAccess(membership);
    const existing = await store.findClient(params.clientId);
    if (!existing) throw AppError.notFound("Client not found");
    assertResourceInWorkspace(params.workspaceId, membership, existing);
    const body = parseOrThrow(updateClientSchema, request.body, "Invalid client");
    const patch: UpdateClientInput = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.company !== undefined ? { company: body.company } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.billingEmail !== undefined ? { billingEmail: body.billingEmail } : {}),
      ...(body.billingAddress !== undefined ? { billingAddress: body.billingAddress } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.country !== undefined ? { country: body.country } : {}),
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    };
    const updated = await store.updateClient(params.clientId, patch);
    return { client: serializeClient(updated) };
  });

  // ---- Projects ----
  app.post("/api/v1/workspaces/:workspaceId/projects", async (request, reply) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid workspace id");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    requireWriteAccess(membership);
    const body = parseOrThrow(createProjectSchema, request.body, "Invalid project");
    const project = await store.createProject(params.workspaceId, {
      clientId: body.clientId,
      title: body.title,
      ...(body.description !== undefined ? { description: body.description } : {}),
      currency: body.currency,
      totalValueCents: body.totalValueCents,
      ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
      ...(body.expectedCompletion !== undefined
        ? { expectedCompletion: body.expectedCompletion }
        : {}),
      ...(body.paymentTerms !== undefined ? { paymentTerms: body.paymentTerms } : {}),
      status: body.status,
    });
    await store.appendProjectEvent(params.workspaceId, project.id, {
      type: "ProjectCreated",
      actorType: "freelancer",
      actorId: user.id,
      payload: {
        title: project.title,
        totalValueCents: project.totalValueCents,
        currency: project.currency,
      },
    });
    return reply.status(201).send({ project: serializeProject(project) });
  });

  app.get("/api/v1/workspaces/:workspaceId/projects", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceParam, request.params, "Invalid workspace id");
    requireMembership(await store.findMembership(user.id, params.workspaceId));
    const query = parseOrThrow(projectListQuerySchema, request.query, "Invalid query");
    const projects = (await store.listProjects(params.workspaceId)).filter((p) =>
      matchesProject(p, query),
    );
    return { projects: projects.map(serializeProject) };
  });

  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid project id");
    const membership = await store.findMembership(user.id, params.workspaceId);
    const project = await store.findProject(params.projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(params.workspaceId, membership, project);
    const client = await store.findClient(project.clientId);
    return {
      project: serializeProject(project),
      ...(client ? { client: serializeClient(client) } : {}),
    };
  });

  app.patch("/api/v1/workspaces/:workspaceId/projects/:projectId", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid project id");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    requireWriteAccess(membership);
    const existing = await store.findProject(params.projectId);
    if (!existing) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(params.workspaceId, membership, existing);
    const body = parseOrThrow(updateProjectSchema, request.body, "Invalid project");
    const patch: UpdateProjectInput = {
      ...(body.clientId !== undefined ? { clientId: body.clientId } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.currency !== undefined ? { currency: body.currency } : {}),
      ...(body.totalValueCents !== undefined ? { totalValueCents: body.totalValueCents } : {}),
      ...(body.startDate !== undefined ? { startDate: body.startDate } : {}),
      ...(body.expectedCompletion !== undefined
        ? { expectedCompletion: body.expectedCompletion }
        : {}),
      ...(body.paymentTerms !== undefined ? { paymentTerms: body.paymentTerms } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
    };
    const updated = await store.updateProject(params.projectId, patch);
    return { project: serializeProject(updated) };
  });

  // Work pause: an explicit, event-sourced workflow state (Session 14).
  // Pausing never rewrites history — it appends ProjectPaused/ProjectUnpaused
  // rows and flips the project status between `active` and `paused`.
  const pauseBody = z.object({ reason: z.string().trim().min(3).max(1000).optional() });

  app.post("/api/v1/workspaces/:workspaceId/projects/:projectId/pause", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid project id");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    requireWriteAccess(membership);
    const existing = await store.findProject(params.projectId);
    if (!existing) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(params.workspaceId, membership, existing);
    if (existing.status === "paused") throw AppError.conflict("Project is already paused");
    const body = parseOrThrow(pauseBody, request.body ?? {}, "Invalid pause request");
    const updated = await store.updateProject(params.projectId, { status: "paused" });
    await store.appendProjectEvent(params.workspaceId, params.projectId, {
      type: "ProjectPaused",
      actorType: "freelancer",
      actorId: user.id,
      payload: { ...(body.reason ? { reason: body.reason } : {}) },
    });
    await notifyLifecycle(deps, {
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      kind: "project_paused",
      dedupe: `pause:${updated.updatedAt.toISOString()}`,
      ...(body.reason ? { detail: body.reason.slice(0, 500) } : {}),
      actorId: user.id,
    });
    return { project: serializeProject(updated) };
  });

  app.post("/api/v1/workspaces/:workspaceId/projects/:projectId/unpause", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid project id");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    requireWriteAccess(membership);
    const existing = await store.findProject(params.projectId);
    if (!existing) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(params.workspaceId, membership, existing);
    if (existing.status !== "paused") throw AppError.conflict("Project is not paused");
    const updated = await store.updateProject(params.projectId, { status: "active" });
    await store.appendProjectEvent(params.workspaceId, params.projectId, {
      type: "ProjectUnpaused",
      actorType: "freelancer",
      actorId: user.id,
      payload: {},
    });
    await notifyLifecycle(deps, {
      workspaceId: params.workspaceId,
      projectId: params.projectId,
      kind: "project_unpaused",
      dedupe: `unpause:${updated.updatedAt.toISOString()}`,
      actorId: user.id,
    });
    return { project: serializeProject(updated) };
  });

  // Command-center summary: total / paid / outstanding / current milestone /
  // next action / statuses / recent activity. Paid counts verified receipts
  // only — no payment creation here (payments slice is a later session).
  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/summary", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid project id");
    const membership = await store.findMembership(user.id, params.workspaceId);
    const project = await store.findProject(params.projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(params.workspaceId, membership, project);
    const [milestones, payments, events] = await Promise.all([
      store.listMilestones(project.id),
      store.listPayments(project.id),
      store.listProjectEvents(project.id, 8),
    ]);
    const summary = buildProjectSummary({ project, milestones, payments, events });
    const client = await store.findClient(project.clientId);
    return {
      summary,
      milestones: milestones.map((m) => ({
        id: m.id,
        title: m.title,
        amountCents: m.amountCents,
        workState: m.workState,
        paymentState: m.paymentState,
        orderIndex: m.orderIndex,
        ...(m.dueDate ? { dueDate: m.dueDate.toISOString() } : {}),
      })),
      ...(client ? { client: serializeClient(client) } : {}),
    };
  });
}
