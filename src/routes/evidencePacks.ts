import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildEvidencePackSnapshot,
  canonicalizeSnapshot,
  EVIDENCE_PACK_DISCLAIMER,
  EVIDENCE_PACK_DISCLAIMER_VERSION,
  EVIDENCE_PACK_NO_GUARANTEE,
  hashEvidencePack,
  renderEvidencePackHtml,
  type EvidencePackSnapshot,
} from "../domain/evidencePack.js";
import { assertResourceInWorkspace, requireWriteAccess } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import type { EvidencePackRecord } from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Evidence pack (Session 15).
 *
 * A freelancer generates a professional, factual export for an
 * overdue/disputed project: parties, project, agreement version, payment
 * terms, milestone structure, invoices/payment records, deliverables,
 * approvals, revisions, timeline, reminder history, payment-plan history and
 * project messages/events. The output states what happened, when, and who
 * recorded it — never legal conclusions — and never promises dispute success.
 *
 * Each generation is a NEW immutable row (the `no_update_evidence` DB guard
 * rejects edits/deletes); regenerating pins a fresh hash. Detail reads
 * rebuild the snapshot from live records and compare against the
 * generation-time pins so drift is reported factually.
 */

const workspaceProjectParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
});

const workspaceProjectPackParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  packId: uuidSchema,
});

const packDetailQuery = z.object({
  format: z.enum(["json", "html"]).optional(),
});

function serializePack(row: EvidencePackRecord): Record<string, unknown> {
  return {
    id: row.id,
    projectId: row.projectId,
    generatedAt: row.generatedAt.toISOString(),
    generatedBy: row.generatedBy,
    agreementVersionHashes: [...row.agreementVersionHashes],
    eventSeqFrom: row.eventSeqFrom,
    eventSeqTo: row.eventSeqTo,
    artifactRef: row.artifactRef,
    sha256: row.sha256,
    disclaimerVersion: row.disclaimerVersion,
  };
}

export function registerEvidencePackRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store = deps.store;

  async function loadScoped(workspaceId: string, projectId: string, userId: string) {
    const membership = await store.findMembership(userId, workspaceId);
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(workspaceId, membership, project);
    if (!membership) throw AppError.forbidden();
    return { membership, project };
  }

  async function buildSnapshot(args: {
    workspaceId: string;
    projectId: string;
    generatedBy: string;
    generatedAt: Date;
    /**
     * When re-reading a stored pack, exclude that pack's own generation
     * event: it was appended after the generation-time snapshot was hashed,
     * so keeping it would make every fresh pack look drifted. Later packs'
     * generation events stay in the trail as ordinary history.
     */
    excludePackEventId?: string | undefined;
  }): Promise<EvidencePackSnapshot> {
    const [
      workspace,
      project,
      client,
      agreements,
      milestones,
      payments,
      deliverables,
      approvals,
      reminders,
      plans,
      events,
    ] = await Promise.all([
      store.findWorkspace(args.workspaceId),
      store.findProject(args.projectId),
      store.findProject(args.projectId).then((p) => (p ? store.findClient(p.clientId) : undefined)),
      store.listAgreements(args.projectId),
      store.listMilestones(args.projectId),
      store.listPayments(args.projectId),
      store.listDeliverablesByProject(args.projectId),
      store.listApprovalsByProject(args.projectId),
      store.listNotificationsByProject(args.projectId),
      store.listPaymentPlansByProject(args.projectId),
      store.listProjectEvents(args.projectId, 500),
    ]);
    if (!project) throw AppError.notFound("Project not found");
    if (!client) throw AppError.notFound("Client not found");
    const titleByMilestone = new Map(milestones.map((m) => [m.id, m.title] as const));
    const scopedEvents =
      args.excludePackEventId === undefined
        ? events
        : events.filter(
            (e) =>
              !(
                e.type === "EvidencePackGenerated" &&
                typeof e.payload.packId === "string" &&
                e.payload.packId === args.excludePackEventId
              ),
          );
    const deliverableInputs = await Promise.all(
      deliverables.map(async (d) => {
        const versions = await store.listDeliverableVersions(d.id);
        return {
          id: d.id,
          milestoneId: d.milestoneId,
          milestoneTitle: titleByMilestone.get(d.milestoneId) ?? "a milestone",
          title: d.title,
          status: d.status,
          currentVersionNo: d.currentVersionNo,
          ...(d.approvedVersionNo !== undefined ? { approvedVersionNo: d.approvedVersionNo } : {}),
          versions: versions.map((v) => ({
            versionNo: v.versionNo,
            createdAt: v.createdAt,
            fileCount: v.files.length,
            linkCount: v.links.length,
          })),
        };
      }),
    );
    return buildEvidencePackSnapshot({
      generatedBy: args.generatedBy,
      generatedAt: args.generatedAt,
      parties: {
        workspaceName: workspace?.name ?? "Freelancer workspace",
        clientName: client.name,
        ...(client.company ? { clientCompany: client.company } : {}),
        clientEmail: client.email,
      },
      project: {
        id: project.id,
        title: project.title,
        ...(project.description ? { description: project.description } : {}),
        currency: project.currency,
        totalValueCents: project.totalValueCents,
        status: project.status,
        ...(project.paymentTerms ? { paymentTerms: project.paymentTerms } : {}),
        ...(project.startDate ? { startDate: project.startDate } : {}),
        ...(project.expectedCompletion ? { expectedCompletion: project.expectedCompletion } : {}),
        createdAt: project.createdAt,
      },
      agreements: agreements.map((a) => ({
        version: a.version,
        status: a.status,
        hash: a.hash,
        totalAmountCents: a.totalAmountCents,
        currency: a.currency,
        depositAmountCents: a.depositAmountCents,
        paymentDueDays: a.paymentDueDays,
        graceDays: a.graceDays,
        acceptedPaymentMethods: [...a.acceptedPaymentMethods],
        ...(a.sentAt ? { sentAt: a.sentAt } : {}),
        ...(a.acceptedAt ? { acceptedAt: a.acceptedAt } : {}),
        ...(a.acceptedBy ? { acceptedBy: a.acceptedBy } : {}),
      })),
      milestones: milestones.map((m) => ({
        id: m.id,
        title: m.title,
        amountCents: m.amountCents,
        currency: m.currency,
        ...(m.dueDate ? { dueDate: m.dueDate } : {}),
        workState: m.workState,
        paymentState: m.paymentState,
        approvalState: m.approvalState,
        orderIndex: m.orderIndex,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        ...(p.milestoneId ? { milestoneId: p.milestoneId } : {}),
        amountCents: p.amountCents,
        currency: p.currency,
        state: p.state,
        provider: p.provider,
        createdAt: p.createdAt,
        ...(p.receivedAt ? { receivedAt: p.receivedAt } : {}),
      })),
      deliverables: deliverableInputs,
      approvals: approvals.map((a) => ({
        milestoneId: a.milestoneId,
        milestoneTitle: titleByMilestone.get(a.milestoneId) ?? "a milestone",
        decision: a.decision,
        ...(a.versionNo !== undefined ? { versionNo: a.versionNo } : {}),
        ...(a.versionRef ? { versionRef: a.versionRef } : {}),
        ...(a.note ? { note: a.note } : {}),
        actorType: a.actorType,
        createdAt: a.createdAt,
      })),
      reminders: reminders.map((r) => ({
        id: r.id,
        ...(r.milestoneId ? { milestoneId: r.milestoneId } : {}),
        template: r.template,
        state: r.state,
        recipient: r.recipient,
        scheduledFor: r.scheduledFor,
        ...(r.sentAt ? { sentAt: r.sentAt } : {}),
      })),
      paymentPlans: plans.map((p) => ({
        id: p.id,
        milestoneId: p.milestoneId,
        milestoneTitle: titleByMilestone.get(p.milestoneId) ?? "a milestone",
        version: p.version,
        state: p.state,
        originalAmountCents: p.originalAmountCents,
        currency: p.currency,
        offeredAt: p.offeredAt,
        ...(p.acceptedAt ? { acceptedAt: p.acceptedAt } : {}),
        installments: p.installments.map((i) => ({
          seq: i.seq,
          amountCents: i.amountCents,
          dueDate: i.dueDate,
          status: i.status,
        })),
      })),
      events: scopedEvents.map((e) => {
        const milestoneTitle =
          e.milestoneId !== undefined ? titleByMilestone.get(e.milestoneId) : undefined;
        return {
          id: e.id,
          type: e.type,
          actorType: e.actorType,
          ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
          ...(milestoneTitle !== undefined ? { milestoneTitle } : {}),
          occurredAt: e.occurredAt,
          payload: e.payload,
        };
      }),
    });
  }

  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/evidence-packs",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
      const { membership } = await loadScoped(params.workspaceId, params.projectId, user.id);
      requireWriteAccess(membership);

      const generatedAt = new Date();
      const snapshot = await buildSnapshot({
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        generatedBy: user.id,
        generatedAt,
      });
      const canonical = canonicalizeSnapshot(snapshot);
      const sha256 = hashEvidencePack(canonical);
      const artifactRef = `evidence-pack/${params.projectId}/${generatedAt.toISOString()}.json`;
      const row = await store.createEvidencePack(params.workspaceId, {
        projectId: params.projectId,
        generatedBy: user.id,
        generatedAt,
        agreementVersionHashes: [...snapshot.integrity.agreementVersionHashes],
        eventSeqFrom: 1,
        eventSeqTo: snapshot.integrity.eventCount,
        artifactRef,
        sha256,
        disclaimerVersion: EVIDENCE_PACK_DISCLAIMER_VERSION,
      });
      await store.appendProjectEvent(params.workspaceId, params.projectId, {
        type: "EvidencePackGenerated",
        actorType: "freelancer",
        actorId: user.id,
        occurredAt: generatedAt,
        payload: {
          packId: row.id,
          sha256,
          eventCount: snapshot.integrity.eventCount,
          agreementVersionHashes: [...snapshot.integrity.agreementVersionHashes],
        },
        idempotencyKey: `evidence-pack:${row.id}`,
      });

      return reply.status(201).send({
        pack: serializePack(row),
        snapshot,
        snapshotSha256: sha256,
        disclaimer: EVIDENCE_PACK_DISCLAIMER,
        noGuarantee: EVIDENCE_PACK_NO_GUARANTEE,
      });
    },
  );

  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/evidence-packs", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    await loadScoped(params.workspaceId, params.projectId, user.id);
    const rows = await store.listEvidencePacksByProject(params.projectId);
    return {
      projectId: params.projectId,
      packs: rows.map(serializePack),
      disclaimer: EVIDENCE_PACK_DISCLAIMER,
      noGuarantee: EVIDENCE_PACK_NO_GUARANTEE,
    };
  });

  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/evidence-packs/:packId",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectPackParam, request.params, "Invalid ids");
      await loadScoped(params.workspaceId, params.projectId, user.id);
      const query = parseOrThrow(packDetailQuery, request.query, "Invalid query");
      const row = await store.findEvidencePack(params.packId);
      if (row?.projectId !== params.projectId || row.workspaceId !== params.workspaceId) {
        throw AppError.notFound("Evidence pack not found");
      }
      const snapshot = await buildSnapshot({
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        generatedBy: row.generatedBy,
        generatedAt: row.generatedAt,
        excludePackEventId: row.id,
      });
      const currentHashes = [...snapshot.integrity.agreementVersionHashes];
      const reasons: string[] = [];
      if (JSON.stringify(currentHashes) !== JSON.stringify([...row.agreementVersionHashes])) {
        reasons.push("Agreement versions changed since this pack was generated.");
      }
      if (snapshot.integrity.eventCount !== row.eventSeqTo) {
        const delta = snapshot.integrity.eventCount - row.eventSeqTo;
        reasons.push(
          delta > 0
            ? `${delta} new project event(s) were recorded after this pack was generated.`
            : "The project event trail differs from generation time; regenerate for a fresh export.",
        );
      }
      const recomputed = hashEvidencePack(canonicalizeSnapshot(snapshot));
      const matchesGeneration = recomputed === row.sha256 && reasons.length === 0;
      if (recomputed !== row.sha256 && reasons.length === 0) {
        reasons.push("Project records changed since this pack was generated.");
      }
      if (query.format === "html") {
        const html = renderEvidencePackHtml(snapshot, {
          packId: row.id,
          sha256: row.sha256,
          artifactRef: row.artifactRef,
        });
        return reply.header("content-type", "text/html; charset=utf-8").send(html);
      }
      return {
        pack: serializePack(row),
        snapshot,
        consistency: {
          matchesGeneration,
          reasons,
          generatedSha256: row.sha256,
          currentSha256: recomputed,
        },
        disclaimer: EVIDENCE_PACK_DISCLAIMER,
        noGuarantee: EVIDENCE_PACK_NO_GUARANTEE,
      };
    },
  );
}
