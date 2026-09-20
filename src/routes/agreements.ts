import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AGREEMENT_DISCLAIMER,
  AGREEMENT_DISCLAIMER_VERSION,
  AgreementError,
  acceptAgreement as acceptDomain,
  createAgreementDraft,
  hashAgreementTerms,
  sendForAcceptance as sendDomain,
  voidAgreement as voidDomain,
  type AcceptedPaymentMethod,
  type AgreementTerms,
  type LateFeeKind,
} from "../domain/agreement.js";
import { assertResourceInWorkspace, requireMembership, requireWriteAccess } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import { acceptAgreementSchema, createAgreementSchema } from "../lib/agreements.js";
import type { AgreementRecord, Store } from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Agreement / payment-terms routes (Session 06).
 *
 * Every handler enforces the tenant gates (auth → membership → IDOR; writes
 * additionally require owner/member). There is deliberately NO PATCH/PUT:
 * a version row is content-immutable once written — corrections are a new
 * version. The store seam only exposes lifecycle transitions and the DB
 * guard trigger rejects content UPDATEs / DELETEs.
 *
 * Every response carries the non-law-firm disclaimer; the rendered
 * `termsText` embeds it too, so exported evidence is self-describing.
 */

const workspaceProjectParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});
const workspaceProjectAgreementParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  agreementId: uuidSchema,
});

function toTerms(body: z.input<typeof createAgreementSchema>): AgreementTerms {
  return {
    totalAmountCents: body.totalAmountCents,
    currency: body.currency,
    depositAmountCents: body.depositAmountCents,
    milestoneSchedule: body.milestoneSchedule.map((m) => ({
      title: m.title,
      amountCents: m.amountCents,
      ...(m.dueLabel !== undefined ? { dueLabel: m.dueLabel } : {}),
    })),
    paymentDueDays: body.paymentDueDays,
    graceDays: body.graceDays ?? 3,
    acceptedPaymentMethods: [...body.acceptedPaymentMethods],
    latePaymentPolicy: {
      kind: body.latePaymentPolicy.kind,
      description: body.latePaymentPolicy.description,
      ...(body.latePaymentPolicy.feeCents !== undefined
        ? { feeCents: body.latePaymentPolicy.feeCents }
        : {}),
      ...(body.latePaymentPolicy.percentBps !== undefined
        ? { percentBps: body.latePaymentPolicy.percentBps }
        : {}),
    },
    pauseAfterOverdueDays: body.pauseAfterOverdueDays,
    workPauseDescription: body.workPauseDescription,
    releaseCondition: body.releaseCondition ?? "current_milestone_paid",
    finalDeliveryDescription: body.finalDeliveryDescription,
    ownershipMode: body.ownershipMode,
    ownershipDescription: body.ownershipDescription,
    maxRevisionsPerMilestone: body.maxRevisionsPerMilestone,
    extraRevisionPolicy: body.extraRevisionPolicy,
    cancellationNoticeDays: body.cancellationNoticeDays,
    ...(body.cancellationKillFeeCents !== undefined
      ? { cancellationKillFeeCents: body.cancellationKillFeeCents }
      : {}),
    cancellationPolicy: body.cancellationPolicy,
    ...(body.customClauses !== undefined ? { customClauses: body.customClauses } : {}),
  };
}

function serialize(row: AgreementRecord): Record<string, unknown> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    version: row.version,
    status: row.status,
    isCurrent: row.isCurrent,
    totalAmountCents: row.totalAmountCents,
    currency: row.currency,
    depositAmountCents: row.depositAmountCents,
    milestoneSchedule: row.milestoneSchedule.map((m) => ({ ...m })),
    paymentDueDays: row.paymentDueDays,
    graceDays: row.graceDays,
    pauseAfterOverdueDays: row.pauseAfterOverdueDays,
    acceptedPaymentMethods: [...row.acceptedPaymentMethods],
    latePaymentPolicy: { ...row.latePaymentPolicy },
    workPauseDescription: row.workPauseDescription,
    releaseCondition: row.releaseCondition,
    finalDeliveryDescription: row.finalDeliveryDescription,
    ownershipMode: row.ownershipMode,
    ownershipDescription: row.ownershipDescription,
    maxRevisionsPerMilestone: row.maxRevisionsPerMilestone,
    extraRevisionPolicy: row.extraRevisionPolicy,
    cancellationNoticeDays: row.cancellationNoticeDays,
    ...(row.cancellationKillFeeCents !== undefined
      ? { cancellationKillFeeCents: row.cancellationKillFeeCents }
      : {}),
    cancellationPolicy: row.cancellationPolicy,
    ...(row.customClauses !== undefined ? { customClauses: row.customClauses } : {}),
    termsText: row.termsText,
    hash: row.hash,
    disclaimer: AGREEMENT_DISCLAIMER,
    disclaimerVersion: row.disclaimerVersion,
    ...(row.supersedesId !== undefined ? { supersedesId: row.supersedesId } : {}),
    ...(row.sentAt ? { sentAt: row.sentAt.toISOString() } : {}),
    ...(row.acceptedAt ? { acceptedAt: row.acceptedAt.toISOString() } : {}),
    ...(row.acceptedBy !== undefined ? { acceptedBy: row.acceptedBy } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

function asAppError(err: unknown): never {
  if (err instanceof AgreementError) {
    if (err.code === "ALREADY_ACCEPTED") throw AppError.conflict(err.message);
    throw AppError.unprocessable(err.message);
  }
  throw err;
}

function hashRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex");
}

export function registerAgreementRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  async function loadProject(workspaceId: string, projectId: string, userId: string) {
    const membership = await store.findMembership(userId, workspaceId);
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(workspaceId, membership, project);
    return { membership, project };
  }

  async function loadAgreement(workspaceId: string, projectId: string, agreementId: string) {
    const row = await store.findAgreement(agreementId);
    if (row?.projectId !== projectId) throw AppError.notFound("Agreement not found");
    if (row.workspaceId !== workspaceId) throw AppError.forbidden();
    return row;
  }

  // Create a new draft version. Version auto-increments; previous versions
  // flip isCurrent=false so history stays reconstructable.
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/agreements",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const { project } = await loadProject(params.workspaceId, params.projectId, user.id);
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const body = parseOrThrow(createAgreementSchema, request.body, "Invalid agreement terms");
      const terms = toTerms(body);
      const existing = await store.listAgreements(params.projectId);
      const version = existing.length === 0 ? 1 : Math.max(...existing.map((a) => a.version)) + 1;
      const client = await store.findClient(project.clientId);
      const previous = existing[existing.length - 1];
      try {
        const draft = createAgreementDraft({
          id: `pending-${version}`,
          workspaceId: params.workspaceId,
          projectId: params.projectId,
          version,
          terms,
          projectTitle: project.title,
          clientName: client?.name ?? "Client",
          ...(previous ? { supersedesId: previous.id } : {}),
        });
        const created = await store.createAgreement(params.workspaceId, params.projectId, {
          version: draft.version,
          totalAmountCents: terms.totalAmountCents,
          currency: terms.currency,
          depositAmountCents: terms.depositAmountCents,
          milestoneSchedule: terms.milestoneSchedule,
          paymentDueDays: terms.paymentDueDays,
          graceDays: terms.graceDays,
          pauseAfterOverdueDays: terms.pauseAfterOverdueDays,
          acceptedPaymentMethods: terms.acceptedPaymentMethods,
          latePaymentPolicy: { ...terms.latePaymentPolicy },
          workPauseDescription: terms.workPauseDescription,
          releaseCondition: terms.releaseCondition,
          finalDeliveryDescription: terms.finalDeliveryDescription,
          ownershipMode: terms.ownershipMode,
          ownershipDescription: terms.ownershipDescription,
          maxRevisionsPerMilestone: terms.maxRevisionsPerMilestone,
          extraRevisionPolicy: terms.extraRevisionPolicy,
          cancellationNoticeDays: terms.cancellationNoticeDays,
          ...(terms.cancellationKillFeeCents !== undefined
            ? { cancellationKillFeeCents: terms.cancellationKillFeeCents }
            : {}),
          cancellationPolicy: terms.cancellationPolicy,
          ...(terms.customClauses !== undefined ? { customClauses: terms.customClauses } : {}),
          termsText: draft.termsText,
          hash: draft.hash,
          disclaimerVersion: AGREEMENT_DISCLAIMER_VERSION,
          ...(draft.supersedesId !== undefined ? { supersedesId: draft.supersedesId } : {}),
        });
        for (const older of existing) {
          if (older.isCurrent) {
            await store.updateAgreementLifecycle(older.id, { isCurrent: false });
          }
        }
        await store.appendProjectEvent(params.workspaceId, params.projectId, {
          type: "AgreementCreated",
          actorType: "freelancer",
          actorId: user.id,
          payload: { agreementId: created.id, version, hash: created.hash },
        });
        const fresh = (await store.findAgreement(created.id)) ?? created;
        return await reply
          .status(201)
          .send({ agreement: serialize(fresh), disclaimer: AGREEMENT_DISCLAIMER });
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        asAppError(err);
      }
      throw AppError.internal();
    },
  );

  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/agreements", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    await loadProject(params.workspaceId, params.projectId, user.id);
    const rows = await store.listAgreements(params.projectId);
    return { agreements: rows.map(serialize), disclaimer: AGREEMENT_DISCLAIMER };
  });

  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/agreements/:agreementId",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectAgreementParam, request.params, "Invalid ids");
      await loadProject(params.workspaceId, params.projectId, user.id);
      const row = await loadAgreement(params.workspaceId, params.projectId, params.agreementId);
      const events = await store.listProjectEvents(params.projectId, 100);
      const auditTrail = events
        .filter((e) => (e.payload.agreementId as string | undefined) === row.id)
        .map((e) => ({
          id: e.id,
          type: e.type,
          actorType: e.actorType,
          occurredAt: e.occurredAt.toISOString(),
          payload: e.payload,
        }));
      return { agreement: serialize(row), auditTrail, disclaimer: AGREEMENT_DISCLAIMER };
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/agreements/:agreementId/send",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectAgreementParam, request.params, "Invalid ids");
      await loadProject(params.workspaceId, params.projectId, user.id);
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const row = await loadAgreement(params.workspaceId, params.projectId, params.agreementId);
      let sentAt: Date;
      try {
        const domain = {
          id: row.id,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          version: row.version,
          status: row.status as "draft",
          isCurrent: row.isCurrent,
          terms: toStoredTerms(row),
          termsText: row.termsText,
          hash: row.hash,
          disclaimerVersion: row.disclaimerVersion,
          createdAt: row.createdAt,
        };
        const next = sendDomain(domain);
        sentAt = next.sentAt ?? new Date();
      } catch (err: unknown) {
        asAppError(err);
      }
      const updated = await store.updateAgreementLifecycle(row.id, {
        status: "pending_acceptance",
        sentAt,
      });
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        type: "AgreementSent",
        actorType: "freelancer",
        actorId: user.id,
        payload: { agreementId: row.id, version: row.version, hash: row.hash },
      });
      return { agreement: serialize(updated), disclaimer: AGREEMENT_DISCLAIMER };
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/agreements/:agreementId/accept",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectAgreementParam, request.params, "Invalid ids");
      await loadProject(params.workspaceId, params.projectId, user.id);
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const row = await loadAgreement(params.workspaceId, params.projectId, params.agreementId);
      const body = parseOrThrow(acceptAgreementSchema, request.body, "Invalid acceptance");
      // Rebuild + verify the fingerprint before recording acceptance so the
      // exact bytes the client saw are what get pinned.
      const storedTerms = toStoredTerms(row);
      if (hashAgreementTerms(storedTerms) !== row.hash) {
        throw AppError.unprocessable("Stored terms do not match the recorded hash");
      }
      const header = request.headers["x-forwarded-for"];
      const ip = Array.isArray(header)
        ? header[0]
        : typeof header === "string"
          ? header
          : request.ip;
      const ua = request.headers["user-agent"];
      const ipHash = hashRef(ip);
      const uaHash = typeof ua === "string" ? hashRef(ua) : undefined;
      let acceptedAt: Date;
      try {
        const domain = {
          id: row.id,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          version: row.version,
          status: row.status as "pending_acceptance",
          isCurrent: row.isCurrent,
          terms: storedTerms,
          termsText: row.termsText,
          hash: row.hash,
          disclaimerVersion: row.disclaimerVersion,
          createdAt: row.createdAt,
        };
        const next = acceptDomain(domain, {
          acceptedBy: body.acceptedBy,
          ...(ipHash !== undefined ? { acceptIpHash: ipHash } : {}),
          ...(uaHash !== undefined ? { acceptUaHash: uaHash } : {}),
        });
        acceptedAt = next.acceptedAt ?? new Date();
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        asAppError(err);
      }
      const updated = await store.updateAgreementLifecycle(row.id, {
        status: "accepted",
        isCurrent: true,
        acceptedAt,
        acceptedBy: body.acceptedBy.trim(),
        ...(ipHash !== undefined ? { acceptIpHash: ipHash } : {}),
        ...(uaHash !== undefined ? { acceptUaHash: uaHash } : {}),
      });
      // Supersede previously accepted versions; history rows stay readable.
      const siblings = await store.listAgreements(params.projectId);
      for (const sib of siblings) {
        if (sib.id !== row.id && sib.status === "accepted") {
          await store.updateAgreementLifecycle(sib.id, { status: "superseded", isCurrent: false });
          await store.appendProjectEvent(params.workspaceId, params.projectId, {
            type: "AgreementSuperseded",
            actorType: "system",
            actorId: user.id,
            payload: {
              agreementId: sib.id,
              version: sib.version,
              supersededBy: row.id,
              hash: sib.hash,
            },
          });
        } else if (sib.id !== row.id && sib.isCurrent && sib.status !== "accepted") {
          await store.updateAgreementLifecycle(sib.id, { isCurrent: false });
        }
      }
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        type: "AgreementAccepted",
        actorType: "client",
        actorId: user.id,
        payload: {
          agreementId: row.id,
          version: row.version,
          hash: row.hash,
          acceptedBy: body.acceptedBy.trim(),
          ...(body.acceptanceNote !== undefined ? { acceptanceNote: body.acceptanceNote } : {}),
        },
      });
      const fresh = (await store.findAgreement(row.id)) ?? updated;
      return { agreement: serialize(fresh), disclaimer: AGREEMENT_DISCLAIMER };
    },
  );

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/agreements/:agreementId/void",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectAgreementParam, request.params, "Invalid ids");
      await loadProject(params.workspaceId, params.projectId, user.id);
      const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
      requireWriteAccess(membership);
      const row = await loadAgreement(params.workspaceId, params.projectId, params.agreementId);
      let voidedAt: Date;
      try {
        const domain = {
          id: row.id,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          version: row.version,
          status: row.status as "draft",
          isCurrent: row.isCurrent,
          terms: toStoredTerms(row),
          termsText: row.termsText,
          hash: row.hash,
          disclaimerVersion: row.disclaimerVersion,
          createdAt: row.createdAt,
        };
        const next = voidDomain(domain);
        voidedAt = next.voidedAt ?? new Date();
      } catch (err: unknown) {
        asAppError(err);
      }
      const updated = await store.updateAgreementLifecycle(row.id, {
        status: "voided",
        isCurrent: false,
        voidedAt,
      });
      // Promote the newest surviving version to current so the UI has a head.
      const siblings = await store.listAgreements(params.projectId);
      const survivors = siblings
        .filter((s) => s.status !== "voided")
        .sort((a, b) => b.version - a.version);
      const head = survivors[0];
      if (head && !head.isCurrent) {
        await store.updateAgreementLifecycle(head.id, { isCurrent: true });
      }
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        type: "AgreementVoided",
        actorType: "freelancer",
        actorId: user.id,
        payload: { agreementId: row.id, version: row.version, hash: row.hash },
      });
      const fresh = (await store.findAgreement(row.id)) ?? updated;
      return { agreement: serialize(fresh), disclaimer: AGREEMENT_DISCLAIMER };
    },
  );
}

function toStoredTerms(row: AgreementRecord): AgreementTerms {
  const late = row.latePaymentPolicy;
  return {
    totalAmountCents: row.totalAmountCents,
    currency: row.currency,
    depositAmountCents: row.depositAmountCents,
    milestoneSchedule: row.milestoneSchedule.map((m) => ({
      title: m.title,
      amountCents: m.amountCents,
      ...(m.dueLabel !== undefined ? { dueLabel: m.dueLabel } : {}),
    })),
    paymentDueDays: row.paymentDueDays,
    graceDays: row.graceDays,
    acceptedPaymentMethods: [...row.acceptedPaymentMethods] as AcceptedPaymentMethod[],
    latePaymentPolicy: {
      kind: (typeof late.kind === "string" ? late.kind : "none") as LateFeeKind,
      description: typeof late.description === "string" ? late.description : "",
      ...(typeof late.feeCents === "number" ? { feeCents: late.feeCents } : {}),
      ...(typeof late.percentBps === "number" ? { percentBps: late.percentBps } : {}),
    },
    pauseAfterOverdueDays: row.pauseAfterOverdueDays,
    workPauseDescription: row.workPauseDescription,
    releaseCondition: row.releaseCondition as AgreementTerms["releaseCondition"],
    finalDeliveryDescription: row.finalDeliveryDescription,
    ownershipMode: row.ownershipMode as AgreementTerms["ownershipMode"],
    ownershipDescription: row.ownershipDescription,
    maxRevisionsPerMilestone: row.maxRevisionsPerMilestone,
    extraRevisionPolicy: row.extraRevisionPolicy,
    cancellationNoticeDays: row.cancellationNoticeDays,
    ...(row.cancellationKillFeeCents !== undefined
      ? { cancellationKillFeeCents: row.cancellationKillFeeCents }
      : {}),
    cancellationPolicy: row.cancellationPolicy,
    ...(row.customClauses !== undefined ? { customClauses: row.customClauses } : {}),
  };
}
