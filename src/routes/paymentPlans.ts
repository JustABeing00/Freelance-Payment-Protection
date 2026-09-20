import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isVerifiedPaymentState } from "../domain/payments.js";
import {
  buildSchedule,
  cancelOpenInstallments,
  installmentEventKey,
  installmentView,
  markInstallmentMissed,
  markInstallmentPaid,
  PaymentPlanError,
  planEventKey,
  renderInstallmentReminder,
  summarizePlan,
  transitionPlanState,
  validatePlanProposal,
} from "../domain/paymentPlans.js";
import { assertResourceInWorkspace, requireMembership, requireWriteAccess } from "../lib/authz.js";
import { AppError } from "../lib/errors.js";
import { hashToken, verifyMagicLink } from "../lib/magicLink.js";
import type {
  MilestoneRecord,
  PaymentPlanInstallmentRecord,
  PaymentPlanRecord,
  PaymentRecord,
  ProjectEventRecord,
  Store,
} from "../lib/store.js";
import { parseOrThrow, uuidSchema } from "../lib/validate.js";
import { notifyLifecycle } from "./notifications.js";
import { requireAuth, type RouteDeps } from "./requestAuth.js";

/**
 * Payment-plan support (Session 13) — a humane path for late payers with a
 * genuine cash-flow problem.
 *
 * - Freelancer proposes a restructured schedule for an outstanding milestone
 *   balance (installments must sum EXACTLY to the outstanding obligation).
 * - Client accepts via the magic-link portal (or the freelancer records
 *   acceptance); the milestone moves to `plan_active`.
 * - Each installment is tracked (scheduled / paid / missed), missed rows are
 *   flagged by a scheduler tick that also sends automatic system-voiced
 *   reminders, and verified payments settle installments one by one.
 * - A modified schedule is a NEW plan version that supersedes the old one —
 *   the original obligation row + its events are never edited.
 * - Every plan view shows three numbers side by side: the original
 *   obligation (frozen snapshot), the agreed modification (installment
 *   schedule), and the current outstanding balance (live verified math),
 *   plus a timeline of exactly what changed and when.
 */

const workspaceProjectMilestoneParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  milestoneId: uuidSchema,
});
const workspaceProjectMilestonePlanParam = z.object({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  milestoneId: uuidSchema,
  planId: uuidSchema,
});
const workspaceProjectParam = z.object({ workspaceId: uuidSchema, projectId: uuidSchema });
const portalProjectParam = z.object({ projectId: uuidSchema });
const portalProjectPlanParam = z.object({ projectId: uuidSchema, planId: uuidSchema });

const installmentInputSchema = z.object({
  amountCents: z.number().int().min(1).max(999_999_999_999),
  dueDate: z.string().datetime(),
});

const proposeBodySchema = z.object({
  installments: z.array(installmentInputSchema).min(1).max(12),
  note: z.string().trim().min(1).max(500).optional(),
  supersedesPlanId: uuidSchema.optional(),
});

const markPaidBodySchema = z.object({
  paymentId: uuidSchema,
});

const runDueBodySchema = z.object({
  now: z.string().datetime().optional(),
});

const defaultBodySchema = z.object({
  reason: z.string().trim().min(8, "Give a reason (at least 8 characters)").max(500),
});

const portalTokenQuerySchema = z.object({ token: z.string().min(1, "required") });
const portalAcceptBodySchema = z.object({
  token: z.string().min(1, "required"),
});

const PORTAL_LINK_INVALID =
  "This link is invalid or has expired. Ask your studio for a fresh link.";

function asAppError(err: unknown): never {
  if (err instanceof PaymentPlanError) {
    if (err.code === "INVALID_TRANSITION") throw AppError.unprocessable(err.message);
    throw AppError.unprocessable(err.message);
  }
  throw err;
}

function verifiedPaidFor(payments: readonly PaymentRecord[], milestoneId: string): number {
  let sum = 0;
  for (const p of payments) {
    if (p.milestoneId === milestoneId && isVerifiedPaymentState(p.state)) sum += p.amountCents;
  }
  return sum;
}

function serializeInstallment(
  inst: PaymentPlanInstallmentRecord,
  now: Date,
): Record<string, unknown> {
  const view = installmentView(
    {
      seq: inst.seq,
      amountCents: inst.amountCents,
      dueDate: inst.dueDate,
      status: inst.status,
      ...(inst.paymentId !== undefined ? { paymentId: inst.paymentId } : {}),
      ...(inst.paidAt !== undefined ? { paidAt: inst.paidAt } : {}),
      ...(inst.note !== undefined ? { note: inst.note } : {}),
    },
    now,
  );
  return {
    seq: view.seq,
    amountCents: view.amountCents,
    dueDate: view.dueDate.toISOString(),
    status: view.status,
    overdue: view.overdue,
    ...(view.paymentId !== undefined ? { paymentId: view.paymentId } : {}),
    ...(view.paidAt !== undefined ? { paidAt: view.paidAt.toISOString() } : {}),
    ...(view.note !== undefined ? { note: view.note } : {}),
  };
}

function serializePlan(plan: PaymentPlanRecord): Record<string, unknown> {
  return {
    id: plan.id,
    workspaceId: plan.workspaceId,
    projectId: plan.projectId,
    milestoneId: plan.milestoneId,
    originalAmountCents: plan.originalAmountCents,
    currency: plan.currency,
    state: plan.state,
    version: plan.version,
    ...(plan.supersedesId !== undefined ? { supersedesId: plan.supersedesId } : {}),
    ...(plan.note !== undefined ? { note: plan.note } : {}),
    offeredAt: plan.offeredAt.toISOString(),
    ...(plan.acceptedAt !== undefined ? { acceptedAt: plan.acceptedAt.toISOString() } : {}),
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  };
}

interface PlanDetailDeps {
  milestone: MilestoneRecord;
  payments: readonly PaymentRecord[];
  events: readonly ProjectEventRecord[];
  now: Date;
}

/** The three-part financial truth: original + modification + outstanding. */
function buildPlanDetail(plan: PaymentPlanRecord, deps: PlanDetailDeps): Record<string, unknown> {
  const verifiedPaidCents = verifiedPaidFor(deps.payments, plan.milestoneId);
  const summary = summarizePlan(
    plan.installments.map((i) => ({
      seq: i.seq,
      amountCents: i.amountCents,
      dueDate: i.dueDate,
      status: i.status,
    })),
  );
  const timeline = deps.events
    .filter((e) => {
      const pid = e.payload.planId;
      const sup = e.payload.supersededBy;
      return pid === plan.id || sup === plan.id;
    })
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    .map((e) => ({
      type: e.type,
      occurredAt: e.occurredAt.toISOString(),
      actorType: e.actorType,
      ...(e.milestoneId !== undefined ? { milestoneId: e.milestoneId } : {}),
      payload: { ...e.payload },
    }));
  return {
    plan: {
      ...serializePlan(plan),
      installments: plan.installments.map((i) => serializeInstallment(i, deps.now)),
      summary: {
        totalCents: summary.totalCents,
        paidCents: summary.paidCents,
        remainingCents: summary.remainingCents,
        missedCount: summary.missedCount,
        ...(summary.nextDue !== undefined
          ? {
              nextDue: {
                seq: summary.nextDue.seq,
                amountCents: summary.nextDue.amountCents,
                dueDate: summary.nextDue.dueDate.toISOString(),
              },
            }
          : { nextDue: null }),
        complete: summary.complete,
      },
    },
    // Frozen at proposal time — never edited afterwards.
    originalObligation: {
      amountCents: plan.originalAmountCents,
      currency: plan.currency,
      snapshotAt: plan.offeredAt.toISOString(),
      milestoneAmountCents: deps.milestone.amountCents,
      note: "The original debt. Corrections arrive as new plan versions, never edits.",
    },
    // The mutually agreed restructuring of that obligation.
    agreedModification: {
      version: plan.version,
      state: plan.state,
      ...(plan.supersedesId !== undefined ? { supersedesId: plan.supersedesId } : {}),
      ...(plan.acceptedAt !== undefined ? { acceptedAt: plan.acceptedAt.toISOString() } : {}),
      installments: plan.installments.map((i) => serializeInstallment(i, deps.now)),
    },
    // Live verified math: plans never reduce what is owed until paid.
    currentOutstanding: {
      milestoneAmountCents: deps.milestone.amountCents,
      verifiedPaidCents,
      outstandingCents: Math.max(0, deps.milestone.amountCents - verifiedPaidCents),
      planRemainingCents: summary.remainingCents,
      currency: deps.milestone.currency,
      note: "Only verified provider receipts reduce the outstanding balance.",
    },
    timeline,
  };
}

export function registerPaymentPlanRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const store: Store = deps.store;

  async function audit(
    workspaceId: string,
    projectId: string,
    type: string,
    milestoneId: string | undefined,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    actorType = "system",
    actorId?: string,
  ): Promise<void> {
    try {
      await store.appendProjectEvent(workspaceId, projectId, {
        ...(milestoneId !== undefined ? { milestoneId } : {}),
        type,
        actorType,
        ...(actorId !== undefined ? { actorId } : {}),
        payload,
        idempotencyKey,
      });
    } catch (err: unknown) {
      if (err instanceof AppError && err.code === "CONFLICT") return;
      throw err;
    }
  }

  async function loadMilestoneScoped(
    workspaceId: string,
    projectId: string,
    milestoneId: string,
    userId: string,
  ) {
    const membership = requireMembership(await store.findMembership(userId, workspaceId));
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(workspaceId, membership, project);
    const milestone = await store.findMilestone(milestoneId);
    if (milestone?.projectId !== projectId) throw AppError.notFound("Milestone not found");
    assertResourceInWorkspace(workspaceId, membership, milestone);
    return { membership, project, milestone };
  }

  async function loadPlanScoped(
    workspaceId: string,
    projectId: string,
    milestoneId: string,
    planId: string,
    userId: string,
  ) {
    const { membership, project, milestone } = await loadMilestoneScoped(
      workspaceId,
      projectId,
      milestoneId,
      userId,
    );
    const plan = await store.findPaymentPlan(planId);
    if (
      plan?.milestoneId !== milestoneId ||
      plan.projectId !== projectId ||
      plan.workspaceId !== workspaceId
    ) {
      throw AppError.notFound("Payment plan not found");
    }
    return { membership, project, milestone, plan };
  }

  async function authorizePortal(
    projectId: string,
    rawToken: unknown,
  ): Promise<{ projectId: string }> {
    if (typeof rawToken !== "string" || rawToken.length === 0) {
      throw AppError.unauthorized(PORTAL_LINK_INVALID);
    }
    try {
      verifyMagicLink({
        token: rawToken,
        expectedProjectId: projectId,
        sessionSecret: deps.sessionSecret,
      });
    } catch {
      throw AppError.unauthorized(PORTAL_LINK_INVALID);
    }
    const link = await store.findPortalLinkByTokenHash(hashToken(rawToken));
    if (link?.projectId !== projectId) throw AppError.unauthorized(PORTAL_LINK_INVALID);
    if (link.revokedAt) throw AppError.unauthorized(PORTAL_LINK_INVALID);
    if (link.expiresAt.getTime() <= Date.now()) throw AppError.unauthorized(PORTAL_LINK_INVALID);
    const project = await store.findProject(projectId);
    if (!project) throw AppError.notFound("Not found");
    if (link.workspaceId !== project.workspaceId) throw AppError.unauthorized(PORTAL_LINK_INVALID);
    return { projectId };
  }

  async function acceptPlan(
    plan: PaymentPlanRecord,
    milestone: MilestoneRecord,
    args: { actorType: string; actorId?: string | undefined },
  ): Promise<PaymentPlanRecord> {
    try {
      transitionPlanState(plan.state, "active");
    } catch (err: unknown) {
      asAppError(err);
    }
    const now = new Date();
    const updated = await store.updatePaymentPlan(plan.id, { state: "active", acceptedAt: now });
    // Supersede sibling offered drafts so exactly one schedule is live.
    const siblings = await store.listPaymentPlansByMilestone(plan.milestoneId);
    for (const sib of siblings) {
      if (sib.id !== plan.id && sib.state === "offered") {
        await store.updatePaymentPlan(sib.id, {
          state: "superseded",
          installments: cancelOpenInstallments(
            sib.installments.map((i) => ({
              seq: i.seq,
              amountCents: i.amountCents,
              dueDate: i.dueDate,
              status: i.status,
            })),
          ),
        });
        await audit(
          sib.workspaceId,
          sib.projectId,
          "PaymentPlanModified",
          sib.milestoneId,
          {
            planId: sib.id,
            version: sib.version,
            supersededBy: plan.id,
            reason: `superseded by accepted plan v${plan.version}`,
          },
          planEventKey(sib.id, `superseded-by-${plan.id}`),
          args.actorType,
          args.actorId,
        );
      }
    }
    await audit(
      plan.workspaceId,
      plan.projectId,
      "PaymentPlanAccepted",
      plan.milestoneId,
      {
        planId: plan.id,
        version: plan.version,
        installments: plan.installments.map((i) => ({
          seq: i.seq,
          amountCents: i.amountCents,
          dueDate: i.dueDate.toISOString(),
        })),
      },
      planEventKey(plan.id, "accepted"),
      args.actorType,
      args.actorId,
    );
    if (milestone.paymentState !== "paid" && milestone.paymentState !== "disputed") {
      await store.updateMilestone(milestone.id, { paymentState: "plan_active" });
    }
    return updated;
  }

  // ---- Freelancer: propose a payment plan for an outstanding balance ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/payment-plans",
    async (request, reply) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      const { membership, milestone } = await loadMilestoneScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        user.id,
      );
      requireWriteAccess(membership);
      const body = parseOrThrow(proposeBodySchema, request.body, "Invalid payment plan");
      if (milestone.paymentState === "paid") {
        throw AppError.unprocessable("This milestone is already paid — no plan is needed");
      }
      if (milestone.paymentState === "disputed") {
        throw AppError.unprocessable(
          "This milestone is disputed — resolve the dispute before proposing a plan",
        );
      }
      const payments = await store.listPayments(params.projectId);
      const outstanding = Math.max(
        0,
        milestone.amountCents - verifiedPaidFor(payments, milestone.id),
      );
      if (outstanding <= 0) {
        throw AppError.unprocessable("There is no outstanding balance to restructure");
      }
      const inputs = body.installments.map((i) => ({
        amountCents: i.amountCents,
        dueDate: new Date(i.dueDate),
      }));
      try {
        validatePlanProposal({ originalAmountCents: outstanding, installments: inputs });
      } catch (err: unknown) {
        asAppError(err);
      }
      const existing = await store.listPaymentPlansByMilestone(milestone.id);
      let supersedes: PaymentPlanRecord | undefined;
      if (body.supersedesPlanId !== undefined) {
        supersedes = existing.find((p) => p.id === body.supersedesPlanId);
        if (!supersedes) throw AppError.notFound("Payment plan not found");
        if (!["offered", "accepted", "active", "defaulted"].includes(supersedes.state)) {
          throw AppError.unprocessable(
            `Plan v${supersedes.version} is ${supersedes.state} and cannot be modified`,
          );
        }
      } else {
        const live = existing.find((p) => p.state === "accepted" || p.state === "active");
        if (live) {
          throw AppError.conflict(
            `Plan v${live.version} is already ${live.state} — pass supersedesPlanId to agree a modified schedule`,
          );
        }
      }
      const version =
        supersedes !== undefined
          ? supersedes.version + 1
          : existing.reduce((m, p) => Math.max(m, p.version), 0) + 1;
      const schedule = buildSchedule(inputs);
      const created = await store.createPaymentPlan(params.workspaceId, {
        projectId: params.projectId,
        milestoneId: milestone.id,
        originalAmountCents: outstanding,
        currency: milestone.currency,
        installments: schedule,
        version,
        ...(supersedes !== undefined ? { supersedesId: supersedes.id } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      });
      await audit(
        params.workspaceId,
        params.projectId,
        "PaymentPlanOffered",
        milestone.id,
        {
          planId: created.id,
          version,
          originalAmountCents: outstanding,
          currency: milestone.currency,
          installments: schedule.map((s) => ({
            seq: s.seq,
            amountCents: s.amountCents,
            dueDate: s.dueDate.toISOString(),
          })),
          ...(supersedes !== undefined ? { supersedesId: supersedes.id } : {}),
        },
        planEventKey(created.id, "offered"),
        "freelancer",
        user.id,
      );
      if (supersedes !== undefined) {
        await store.updatePaymentPlan(supersedes.id, {
          state: "superseded",
          installments: cancelOpenInstallments(
            supersedes.installments.map((i) => ({
              seq: i.seq,
              amountCents: i.amountCents,
              dueDate: i.dueDate,
              status: i.status,
            })),
          ),
        });
        await audit(
          params.workspaceId,
          params.projectId,
          "PaymentPlanModified",
          milestone.id,
          {
            planId: supersedes.id,
            version: supersedes.version,
            supersededBy: created.id,
            reason: "freelancer and client agreed a modified schedule",
          },
          planEventKey(supersedes.id, `superseded-by-${created.id}`),
          "freelancer",
          user.id,
        );
      }
      const events = await store.listProjectEvents(params.projectId, 100);
      await notifyLifecycle(deps, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        milestoneId: milestone.id,
        kind: "plan_proposed",
        dedupe: `plan:${created.id}:offered`,
        detail: `${schedule.length} installment(s) covering the full outstanding balance.`,
        actorId: user.id,
      });
      return reply.status(201).send({
        ...buildPlanDetail(created, { milestone, payments, events, now: new Date() }),
        message: `Payment plan v${version} proposed: ${schedule.length} installment(s) covering the full outstanding balance. The client accepts it in their portal.`,
      });
    },
  );

  // ---- Freelancer: plan history for one milestone ----
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/payment-plans",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(workspaceProjectMilestoneParam, request.params, "Invalid ids");
      const { milestone } = await loadMilestoneScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        user.id,
      );
      const [plans, payments, events] = await Promise.all([
        store.listPaymentPlansByMilestone(milestone.id),
        store.listPayments(params.projectId),
        store.listProjectEvents(params.projectId, 100),
      ]);
      const now = new Date();
      return {
        plans: plans.map((p) => buildPlanDetail(p, { milestone, payments, events, now })),
      };
    },
  );

  // ---- Freelancer: full plan detail (obligation + modification + outstanding) ----
  app.get(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/payment-plans/:planId",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(
        workspaceProjectMilestonePlanParam,
        request.params,
        "Invalid ids",
      );
      const { milestone, plan } = await loadPlanScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        params.planId,
        user.id,
      );
      const [payments, events] = await Promise.all([
        store.listPayments(params.projectId),
        store.listProjectEvents(params.projectId, 100),
      ]);
      return buildPlanDetail(plan, { milestone, payments, events, now: new Date() });
    },
  );

  // ---- Freelancer: record client acceptance (e.g. confirmed outside the portal) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/payment-plans/:planId/accept",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(
        workspaceProjectMilestonePlanParam,
        request.params,
        "Invalid ids",
      );
      const { membership, milestone, plan } = await loadPlanScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        params.planId,
        user.id,
      );
      requireWriteAccess(membership);
      if (plan.state !== "offered") {
        throw AppError.unprocessable(
          `Plan v${plan.version} is ${plan.state} — only offered plans can be accepted`,
        );
      }
      const updated = await acceptPlan(plan, milestone, {
        actorType: "freelancer",
        actorId: user.id,
      });
      const [payments, events] = await Promise.all([
        store.listPayments(params.projectId),
        store.listProjectEvents(params.projectId, 100),
      ]);
      await notifyLifecycle(deps, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        milestoneId: milestone.id,
        kind: "plan_accepted",
        dedupe: `plan:${plan.id}:accepted`,
        detail: `Plan v${plan.version} is now active.`,
        actorId: user.id,
      });
      return {
        ...buildPlanDetail(updated, { milestone, payments, events, now: new Date() }),
        message: `Payment plan v${plan.version} accepted — the milestone is now on a plan.`,
      };
    },
  );

  // ---- Freelancer: settle one installment against a verified payment ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/payment-plans/:planId/installments/:seq/mark-paid",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(
        workspaceProjectMilestonePlanParam.extend({ seq: z.coerce.number().int().min(1) }),
        { ...(request.params as Record<string, unknown>) },
        "Invalid ids",
      );
      const { membership, milestone, plan } = await loadPlanScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        params.planId,
        user.id,
      );
      requireWriteAccess(membership);
      if (plan.state !== "active" && plan.state !== "accepted") {
        throw AppError.unprocessable(
          `Plan v${plan.version} is ${plan.state} — only an accepted/active plan tracks payments`,
        );
      }
      const body = parseOrThrow(markPaidBodySchema, request.body, "Invalid payment reference");
      const payment = await store.findPaymentById(body.paymentId);
      if (payment?.projectId !== params.projectId) throw AppError.notFound("Payment not found");
      if (!isVerifiedPaymentState(payment.state)) {
        throw AppError.unprocessable(
          `Payment ${payment.id} is ${payment.state} — only verified provider receipts settle installments`,
        );
      }
      if (payment.currency.toUpperCase() !== plan.currency.toUpperCase()) {
        throw AppError.unprocessable("Payment currency must match the plan currency");
      }
      const target = plan.installments.find((i) => i.seq === params.seq);
      if (!target) throw AppError.notFound("Installment not found");
      if (payment.amountCents < target.amountCents) {
        throw AppError.unprocessable(
          `Payment covers ${payment.amountCents} cents but installment ${params.seq} needs ${target.amountCents} cents`,
        );
      }
      for (const inst of plan.installments) {
        if (inst.paymentId === payment.id && inst.seq !== params.seq) {
          throw AppError.conflict(`Payment is already applied to installment ${inst.seq}`);
        }
      }
      let next: {
        seq: number;
        amountCents: number;
        dueDate: Date;
        status: "scheduled" | "paid" | "missed" | "canceled";
      }[];
      try {
        next = markInstallmentPaid(
          plan.installments.map((i) => ({
            seq: i.seq,
            amountCents: i.amountCents,
            dueDate: i.dueDate,
            status: i.status,
          })),
          params.seq,
          { paymentId: payment.id },
        );
      } catch (err: unknown) {
        asAppError(err);
      }
      const updated = await store.updatePaymentPlan(plan.id, { installments: next });
      await audit(
        params.workspaceId,
        params.projectId,
        "PaymentPlanInstallmentPaid",
        milestone.id,
        {
          planId: plan.id,
          version: plan.version,
          seq: params.seq,
          paymentId: payment.id,
          amountCents: target.amountCents,
        },
        installmentEventKey(plan.id, params.seq, `paid-${payment.id}`),
        "freelancer",
        user.id,
      );
      const summary = summarizePlan(
        next.map((i) => ({
          seq: i.seq,
          amountCents: i.amountCents,
          dueDate: i.dueDate,
          status: i.status,
        })),
      );
      if (summary.complete && updated.state !== "completed") {
        const done = await store.updatePaymentPlan(plan.id, { state: "completed" });
        await audit(
          params.workspaceId,
          params.projectId,
          "PaymentPlanCompleted",
          milestone.id,
          { planId: plan.id, version: plan.version },
          planEventKey(plan.id, "completed"),
          "system",
          user.id,
        );
        await store.updateMilestone(milestone.id, {
          paymentState: "paid",
          appliedPaymentIds: [...milestone.appliedPaymentIds, payment.id],
        });
        const [payments, events] = await Promise.all([
          store.listPayments(params.projectId),
          store.listProjectEvents(params.projectId, 100),
        ]);
        const freshMilestone = (await store.findMilestone(milestone.id)) ?? milestone;
        await notifyLifecycle(deps, {
          workspaceId: params.workspaceId,
          projectId: params.projectId,
          milestoneId: milestone.id,
          kind: "plan_completed",
          dedupe: `plan:${plan.id}:completed`,
          detail: `Plan v${plan.version} complete — the milestone is paid.`,
          actorId: user.id,
        });
        return {
          ...buildPlanDetail(done, {
            milestone: freshMilestone,
            payments,
            events,
            now: new Date(),
          }),
          message: `Installment ${params.seq} settled — the plan is complete and the milestone is paid.`,
        };
      }
      const [payments, events] = await Promise.all([
        store.listPayments(params.projectId),
        store.listProjectEvents(params.projectId, 100),
      ]);
      return {
        ...buildPlanDetail(updated, { milestone, payments, events, now: new Date() }),
        message: `Installment ${params.seq} settled against a verified receipt.`,
      };
    },
  );

  // ---- Freelancer: scheduler tick — flag missed installments + auto-remind ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/payment-plans/:planId/run-due",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(
        workspaceProjectMilestonePlanParam,
        request.params,
        "Invalid ids",
      );
      const { membership, project, milestone, plan } = await loadPlanScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        params.planId,
        user.id,
      );
      requireWriteAccess(membership);
      if (plan.state !== "active" && plan.state !== "accepted") {
        throw AppError.unprocessable(
          `Plan v${plan.version} is ${plan.state} — only an accepted/active plan runs due checks`,
        );
      }
      const body = parseOrThrow(runDueBodySchema, request.body ?? {}, "Invalid run input");
      const now = body.now !== undefined ? new Date(body.now) : new Date();
      let installments = plan.installments.map((i) => ({
        seq: i.seq,
        amountCents: i.amountCents,
        dueDate: i.dueDate,
        status: i.status,
      }));
      const missed: Record<string, unknown>[] = [];
      for (const inst of installments) {
        if (inst.status === "scheduled" && now.getTime() > inst.dueDate.getTime()) {
          installments = markInstallmentMissed(installments, inst.seq, {
            note: `missed as of ${now.toISOString().slice(0, 10)} — reminder sent`,
          });
          missed.push({ seq: inst.seq, amountCents: inst.amountCents });
          await audit(
            params.workspaceId,
            params.projectId,
            "PaymentPlanInstallmentMissed",
            milestone.id,
            {
              planId: plan.id,
              version: plan.version,
              seq: inst.seq,
              dueDate: inst.dueDate.toISOString(),
            },
            installmentEventKey(plan.id, inst.seq, `missed-${now.toISOString().slice(0, 10)}`),
            "system",
            user.id,
          );
        }
      }
      if (missed.length > 0) {
        await store.updatePaymentPlan(plan.id, { installments });
      }
      // Automatic reminders: one system-voiced notice per unpaid installment.
      const client = await store.findClient(project.clientId);
      const workspace = await store.findWorkspace(params.workspaceId);
      const recipient = client?.billingEmail ?? client?.email ?? "";
      const remindersSent: Record<string, unknown>[] = [];
      const remindersSkipped: Record<string, unknown>[] = [];
      const summary = summarizePlan(installments);
      if (recipient) {
        for (const inst of installments) {
          if (inst.status === "paid" || inst.status === "canceled") continue;
          const day = now.toISOString().slice(0, 10);
          const idempotencyKey = `plan-reminder:${plan.id}:${inst.seq}:${day}`;
          const dupe = await store.findNotificationByIdempotencyKey(idempotencyKey);
          if (dupe) {
            remindersSkipped.push({ seq: inst.seq, duplicate: true });
            continue;
          }
          const copy = renderInstallmentReminder({
            workspaceName: workspace?.name ?? "Workspace",
            clientName: client?.name ?? "there",
            projectTitle: project.title,
            milestoneTitle: milestone.title,
            seq: inst.seq,
            ofCount: installments.length,
            amountCents: inst.amountCents,
            currency: plan.currency,
            dueDate: inst.dueDate,
            remainingCents: summary.remainingCents,
          });
          const row = await store.createNotification(params.workspaceId, {
            projectId: params.projectId,
            milestoneId: milestone.id,
            template: "payment_plan_installment",
            templateVersion: "v1",
            subject: copy.subject,
            bodySnapshot: copy.body,
            recipient,
            ...(client?.name ? { recipientName: client.name } : {}),
            scheduledFor: now,
            trigger: "plan-run-due",
            policyStep: `installment-${inst.seq}`,
            idempotencyKey,
          });
          try {
            const sent = await deps.emailProvider?.send({
              to: recipient,
              subject: copy.subject,
              text: copy.body,
            });
            await store.updateNotification(row.id, {
              state: "sent",
              providerMessageId: sent?.providerMessageId,
              sentAt: now,
              deliveredAt: now,
              attemptCount: row.attemptCount + 1,
            });
            remindersSent.push({ seq: inst.seq, notificationId: row.id });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : "delivery failed";
            await store.updateNotification(row.id, {
              state: "failed",
              attemptCount: row.attemptCount + 1,
              lastError: message.slice(0, 500),
            });
            remindersSkipped.push({ seq: inst.seq, reason: "delivery failed — safe to retry" });
          }
          await audit(
            params.workspaceId,
            params.projectId,
            "PaymentPlanReminderSent",
            milestone.id,
            {
              planId: plan.id,
              version: plan.version,
              seq: inst.seq,
              notificationId: row.id,
              recipient,
            },
            `plan-reminder-sent:${row.id}`,
            "system",
            user.id,
          );
        }
      }
      const fresh = (await store.findPaymentPlan(plan.id)) ?? plan;
      const [payments, events] = await Promise.all([
        store.listPayments(params.projectId),
        store.listProjectEvents(params.projectId, 100),
      ]);
      return {
        ...buildPlanDetail(fresh, { milestone, payments, events, now }),
        missed,
        remindersSent,
        remindersSkipped,
      };
    },
  );

  // ---- Freelancer: mark a plan defaulted (client stopped paying the plan) ----
  app.post(
    "/api/v1/workspaces/:workspaceId/projects/:projectId/milestones/:milestoneId/payment-plans/:planId/default",
    async (request) => {
      const { user } = await requireAuth(request, deps);
      const params = parseOrThrow(
        workspaceProjectMilestonePlanParam,
        request.params,
        "Invalid ids",
      );
      const { membership, milestone, plan } = await loadPlanScoped(
        params.workspaceId,
        params.projectId,
        params.milestoneId,
        params.planId,
        user.id,
      );
      requireWriteAccess(membership);
      try {
        transitionPlanState(plan.state, "defaulted");
      } catch (err: unknown) {
        asAppError(err);
      }
      const body = parseOrThrow(defaultBodySchema, request.body, "Invalid default input");
      const updated = await store.updatePaymentPlan(plan.id, { state: "defaulted" });
      await audit(
        params.workspaceId,
        params.projectId,
        "PaymentPlanDefaulted",
        milestone.id,
        { planId: plan.id, version: plan.version, reason: body.reason.slice(0, 500) },
        planEventKey(plan.id, "defaulted"),
        "freelancer",
        user.id,
      );
      if (milestone.paymentState !== "paid" && milestone.paymentState !== "disputed") {
        await store.updateMilestone(milestone.id, { paymentState: "overdue" });
      }
      const [payments, events] = await Promise.all([
        store.listPayments(params.projectId),
        store.listProjectEvents(params.projectId, 100),
      ]);
      const freshMilestone = (await store.findMilestone(milestone.id)) ?? milestone;
      await notifyLifecycle(deps, {
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        milestoneId: milestone.id,
        kind: "plan_defaulted",
        dedupe: `plan:${plan.id}:defaulted`,
        detail: body.reason.slice(0, 500),
        actorId: user.id,
      });
      return {
        ...buildPlanDetail(updated, {
          milestone: freshMilestone,
          payments,
          events,
          now: new Date(),
        }),
        message: `Plan v${plan.version} marked defaulted — the original obligation stands and the milestone is overdue.`,
      };
    },
  );

  // ---- Project plan history (all milestones, version-ordered) ----
  app.get("/api/v1/workspaces/:workspaceId/projects/:projectId/payment-plans", async (request) => {
    const { user } = await requireAuth(request, deps);
    const params = parseOrThrow(workspaceProjectParam, request.params, "Invalid ids");
    const membership = requireMembership(await store.findMembership(user.id, params.workspaceId));
    const project = await store.findProject(params.projectId);
    if (!project) throw AppError.notFound("Project not found");
    assertResourceInWorkspace(params.workspaceId, membership, project);
    const [plans, milestones, payments, events] = await Promise.all([
      store.listPaymentPlansByProject(params.projectId),
      store.listMilestones(params.projectId),
      store.listPayments(params.projectId),
      store.listProjectEvents(params.projectId, 100),
    ]);
    const now = new Date();
    const scoped = plans.filter((p) => p.workspaceId === params.workspaceId);
    return {
      plans: scoped.map((plan) => {
        const milestone = milestones.find((m) => m.id === plan.milestoneId);
        if (!milestone) return { plan: serializePlan(plan), milestoneId: plan.milestoneId };
        return buildPlanDetail(plan, { milestone, payments, events, now });
      }),
    };
  });

  // ---- Client portal: read the plan(s) in calm, client-safe language ----
  app.get("/api/v1/portal/:projectId/payment-plans", async (request) => {
    const params = parseOrThrow(portalProjectParam, request.params, "Invalid project id");
    const query = parseOrThrow(
      portalTokenQuerySchema,
      request.query,
      "A valid portal link is required",
    );
    await authorizePortal(params.projectId, query.token);
    const [plans, milestones, payments, events] = await Promise.all([
      store.listPaymentPlansByProject(params.projectId),
      store.listMilestones(params.projectId),
      store.listPayments(params.projectId),
      store.listProjectEvents(params.projectId, 100),
    ]);
    const now = new Date();
    return {
      plans: plans.map((plan) => {
        const milestone = milestones.find((m) => m.id === plan.milestoneId);
        if (!milestone) return { plan: serializePlan(plan) };
        return buildPlanDetail(plan, { milestone, payments, events, now });
      }),
      disclaimer:
        "Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent.",
    };
  });

  app.get("/api/v1/portal/:projectId/payment-plans/:planId", async (request) => {
    const params = parseOrThrow(portalProjectPlanParam, request.params, "Invalid ids");
    const query = parseOrThrow(
      portalTokenQuerySchema,
      request.query,
      "A valid portal link is required",
    );
    await authorizePortal(params.projectId, query.token);
    const plan = await store.findPaymentPlan(params.planId);
    if (plan?.projectId !== params.projectId) throw AppError.notFound("Not found");
    const milestone = await store.findMilestone(plan.milestoneId);
    if (!milestone) throw AppError.notFound("Not found");
    const [payments, events] = await Promise.all([
      store.listPayments(params.projectId),
      store.listProjectEvents(params.projectId, 100),
    ]);
    return {
      ...buildPlanDetail(plan, { milestone, payments, events, now: new Date() }),
      disclaimer:
        "Informational workflow record. Not legal advice. Enforcement is jurisdiction-dependent.",
    };
  });

  // ---- Client portal: accept the proposed plan (agreement to the schedule) ----
  app.post("/api/v1/portal/:projectId/payment-plans/:planId/accept", async (request) => {
    const params = parseOrThrow(portalProjectPlanParam, request.params, "Invalid ids");
    const body = parseOrThrow(portalAcceptBodySchema, request.body, "Invalid acceptance");
    await authorizePortal(params.projectId, body.token);
    const plan = await store.findPaymentPlan(params.planId);
    if (plan?.projectId !== params.projectId) throw AppError.notFound("Not found");
    const milestone = await store.findMilestone(plan.milestoneId);
    if (!milestone) throw AppError.notFound("Not found");
    if (plan.state !== "offered") {
      throw AppError.unprocessable(
        `This plan is ${plan.state} — only the offered schedule can be accepted`,
      );
    }
    const updated = await acceptPlan(plan, milestone, { actorType: "client" });
    const [payments, events] = await Promise.all([
      store.listPayments(params.projectId),
      store.listProjectEvents(params.projectId, 100),
    ]);
    const freshMilestone = (await store.findMilestone(milestone.id)) ?? milestone;
    await notifyLifecycle(deps, {
      workspaceId: freshMilestone.workspaceId,
      projectId: params.projectId,
      milestoneId: milestone.id,
      kind: "plan_accepted",
      dedupe: `plan:${plan.id}:accepted`,
      detail: `Plan v${plan.version} is now active.`,
    });
    return {
      ...buildPlanDetail(updated, {
        milestone: freshMilestone,
        payments,
        events,
        now: new Date(),
      }),
      message: `Thank you — the ${updated.installments.length}-installment schedule is agreed. Each payment is confirmed automatically.`,
    };
  });
}
